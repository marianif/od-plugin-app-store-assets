#!/usr/bin/env node
// App Store Connect Asset Library uploader.
//
//   node .app-store-assets/scripts/asc-upload.mjs help
//   node .app-store-assets/scripts/asc-upload.mjs library --app 1234567890
//   node .app-store-assets/scripts/asc-upload.mjs localizations --app 1234567890 --version 1.4
//   node .app-store-assets/scripts/asc-upload.mjs groups --app 1234567890 --placement APP_SCREENSHOT
//   node .app-store-assets/scripts/asc-upload.mjs upload --plan asset-plan.json --app 1234567890
//   node .app-store-assets/scripts/asc-upload.mjs upload --plan asset-plan.json --app 1234567890 --execute
//
// Dry-run is the default. --execute is the only path that mutates App Store
// Connect, and SKILL.md requires an explicit user confirmation before it.
//
// v1 stops after placements + ordering. It never submits the parent surface
// for review, and it does not create in-app event records (see ROADMAP.md).

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, fail } from './lib/daemon.mjs';
import { loadSnapshot, getSpec } from './lib/specs.mjs';
import { validatePlan } from './lib/plan.mjs';
import * as asc from './lib/asc.mjs';

function help() {
  console.log(`asc-upload.mjs — App Store Connect Asset Library uploader

Commands:
  refdata                         fetch live specs (thin wrapper: scripts/refdata.mjs)
  apps       [--bundle <bundleId>] find the App Store Connect app id
  library    --app <id>           show the app's asset library id
  localizations --app <id> [--version <v>] [--platform IOS]
                                  list versions and localization ids
  groups     --app <id> [--placement <TYPE>]
                                  list placement groups/specs from live ref data
  upload     --plan <file> --app <id> [--execute] [--version <v>] [--event <id>] [--group <id>]
                                  upload + place assets (dry-run by default)
  status     --image <id>         poll an uploaded image

Credentials:
  ASC_ISSUER_ID, ASC_KEY_ID, ASC_PRIVATE_KEY_PATH (or ASC_PRIVATE_KEY)
  or ~/.config/app-store-assets/config.json

Safety:
  - dry-run is the default; --execute is required to mutate App Store Connect
  - app preview videos, event creation and review submission are out of v1
`);
}

function appIdFor(flags, config) {
  const appId = typeof flags.app === 'string' ? flags.app : config?.appId;
  if (!appId) fail('app id required: pass --app <id> or set appId in the ASC config.');
  return appId;
}

async function requireConfig() {
  const config = await asc.loadAscConfig();
  try { asc.assertAscConfig(config); } catch (err) { fail(err.message); }
  return config;
}

async function cmdLibrary(flags) {
  const config = await requireConfig();
  const appId = appIdFor(flags, config);
  const libraryId = await asc.getAssetLibrary(config, appId);
  console.log(JSON.stringify({ appId, libraryId }, null, 2));
}

async function cmdLocalizations(flags) {
  const config = await requireConfig();
  const appId = appIdFor(flags, config);
  const platform = String(flags.platform || 'IOS');
  const versions = await asc.listVersions(config, appId, platform);
  const wanted = typeof flags.version === 'string' ? flags.version : null;
  const chosen = wanted
    ? versions.find((v) => asc.attrsOf(v).versionString === wanted)
    : versions.find((v) => asc.attrsOf(v).appStoreState === 'PREPARE_FOR_SUBMISSION') || versions[0];
  if (!chosen) fail(`no ${platform} version found for app ${appId}.`);
  const localizations = await asc.listVersionLocalizations(config, chosen.id);
  console.log(JSON.stringify({
    appId,
    version: {
      id: chosen.id,
      versionString: asc.attrsOf(chosen).versionString,
      state: asc.attrsOf(chosen).appStoreState,
    },
    localizations: localizations.map((l) => ({
      id: l.id,
      locale: asc.attrsOf(l).locale,
      name: asc.attrsOf(l).name || null,
    })),
    allVersions: versions.map((v) => ({
      id: v.id,
      versionString: asc.attrsOf(v).versionString,
      state: asc.attrsOf(v).appStoreState,
    })),
  }, null, 2));
}

async function cmdApps(flags) {
  const config = await requireConfig();
  const bundleId = typeof flags.bundle === 'string' ? flags.bundle : null;
  const { json } = await asc.ascFetch(config, `/apps${asc.qs({
    limit: 200,
    'fields[apps]': 'name,bundleId,sku,primaryLocale',
  })}`);
  const apps = (json?.data || []).map((app) => ({
    id: app.id,
    name: asc.attrsOf(app).name,
    bundleId: asc.attrsOf(app).bundleId,
    primaryLocale: asc.attrsOf(app).primaryLocale,
  }));
  const filtered = bundleId ? apps.filter((app) => app.bundleId === bundleId) : apps;
  console.log(JSON.stringify({ count: filtered.length, apps: filtered }, null, 2));
}

async function cmdGroups(flags) {
  const config = await requireConfig();
  const appId = appIdFor(flags, config);
  const placementType = String(flags.placement || 'APP_SCREENSHOT');
  const payload = await asc.getRefData(config);
  console.log(JSON.stringify({
    appId,
    placementType,
    groups: asc.refdataGroups(payload, placementType),
  }, null, 2));
}

async function resolveLiveSnapshot(explicit) {
  if (explicit) return loadSnapshot(explicit);
  const live = path.resolve('.app-store-assets/references/refdata-live.json');
  try {
    await fs.access(live);
    return loadSnapshot(live);
  } catch {
    return loadSnapshot();
  }
}

function targetFor(kind, versionLocalizations, eventLocalizations, locale, flags) {
  const isEvent = String(kind || '').startsWith('event');
  if (isEvent) {
    if (!eventLocalizations) {
      fail('event assets require --event <eventId> (or create the event in App Store Connect first).');
    }
    const entry = eventLocalizations.find((l) => asc.attrsOf(l).locale === locale) || eventLocalizations[0];
    if (!entry) fail('the selected in-app event has no localization.');
    return { targetType: 'appEventLocalization', targetId: entry.id };
  }
  const entry = versionLocalizations.find((l) => asc.attrsOf(l).locale === locale);
  if (!entry) {
    const locales = versionLocalizations.map((l) => asc.attrsOf(l).locale).join(', ');
    fail(`locale ${locale} not found on the chosen version. Available: ${locales || 'none'}`);
  }
  return { targetType: 'appStoreVersionLocalization', targetId: entry.id };
}

async function cmdUpload(flags) {
  const planPath = path.resolve(String(flags.plan || 'asset-plan.json'));
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  const snapshot = await resolveLiveSnapshot(typeof flags.refdata === 'string' ? flags.refdata : undefined);
  const { findings, summary } = await validatePlan({ plan, snapshot: snapshot.data, cwd: process.cwd() });

  if (summary.p0 > 0) {
    for (const f of findings.filter((x) => x.severity === 'P0')) {
      console.error(`P0 ${f.assetId ? `[${f.assetId}] ` : ''}${f.message}`);
    }
    fail(`plan has ${summary.p0} blocker(s); fix them before uploading. Run scripts/validate.mjs for the full report.`);
  }

  const config = await asc.loadAscConfig();
  const hasCredentials = Boolean(config.issuerId && config.keyId && (config.privateKey || config.privateKeyPath));
  const appId = typeof flags.app === 'string' ? flags.app : config.appId;
  if (!appId) fail('app id required: pass --app <id> or set appId in the ASC config.');
  const execute = flags.execute === true;

  const actions = [];
  for (const asset of plan.assets) {
    const spec = getSpec(snapshot.data, asset.spec);
    const placementType = asset.placementType || spec.placementType;
    const group = asset.placementGroup || spec.placementGroup || (typeof flags.group === 'string' ? flags.group : null);
    const category = spec.category || 'CREATIVE_ASSETS';
    actions.push({
      id: asset.id,
      file: asset.file,
      kind: asset.kind,
      spec: asset.spec,
      pixels: `${spec.width}x${spec.height}`,
      placementType,
      placementGroup: group,
      category,
      order: asset.order ?? null,
      locale: plan.locale || 'en-US',
    });
  }

  if (!execute) {
    const report = {
      ok: true,
      dryRun: true,
      appId,
      locale: plan.locale || 'en-US',
      credentials: hasCredentials ? 'present' : 'missing (local pre-flight only)',
      refdata: path.relative(process.cwd(), snapshot.path),
      validation: summary,
      actions,
      note: 'Re-run with --execute after an explicit confirmation to upload and create placements.',
    };

    // With credentials, rehearse against live App Store Connect state: resolve
    // the version/localizations, check each file fits a live spec for its
    // placement type + group, and count the placements that would be replaced.
    if (hasCredentials) {
      try {
        const live = { libraryId: await asc.getAssetLibrary(config, appId) };
        const refData = await asc.getRefData(config);
        const platform = String(flags.platform || 'IOS');
        const needsVersion = plan.assets.some((a) => !String(a.kind || '').startsWith('event'));
        if (needsVersion) {
          const versions = await asc.listVersions(config, appId, platform);
          const wanted = typeof flags.version === 'string' ? flags.version : null;
          const version = wanted
            ? versions.find((v) => asc.attrsOf(v).versionString === wanted)
            : versions.find((v) => asc.attrsOf(v).appStoreState === 'PREPARE_FOR_SUBMISSION');
          if (version) {
            live.version = { id: version.id, versionString: asc.attrsOf(version).versionString, state: asc.attrsOf(version).appStoreState };
            live.localizations = (await asc.listVersionLocalizations(config, version.id)).map((l) => ({ id: l.id, locale: asc.attrsOf(l).locale }));
            live.targetLocalization = (live.localizations || []).find((l) => l.locale === (plan.locale || 'en-US')) || null;
          } else {
            live.versionError = wanted ? `version ${wanted} not found` : `no editable ${platform} version found`;
          }
        }
        if (live.targetLocalization) {
          live.checks = [];
          for (const asset of plan.assets) {
            const spec = getSpec(snapshot.data, asset.spec);
            const placementType = asset.placementType || spec.placementType;
            const group = asset.placementGroup || spec.placementGroup || (typeof flags.group === 'string' ? flags.group : null);
            const allowed = placementType && group ? asc.specIdsForGroup(refData, placementType, group) : null;
            let fits = null;
            for (const specId of allowed || []) {
              const cover = asc.specCovers(refData, specId, spec.width, spec.height);
              if (cover && cover.ok) { fits = { specId, shortName: cover.shortName }; break; }
            }
            let existing = null;
            try {
              const placements = await asc.listPlacements(config, 'appStoreVersionLocalization', live.targetLocalization.id, { placementType, placementGroup: group });
              existing = placements.map((p) => p.id);
            } catch { /* ignore */ }
            live.checks.push({
              id: asset.id,
              placementType,
              placementGroup: group,
              fitsLiveSpec: fits ? true : (allowed && allowed.length ? false : null),
              matchedSpec: fits ? fits.shortName : null,
              liveSpecIds: (allowed || []).length,
              wouldReplacePlacements: existing ? existing.length : null,
            });
          }
        }
        report.live = live;
      } catch (err) {
        report.liveError = err?.message || String(err);
      }
    }

    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (!hasCredentials) {
    fail('--execute requires App Store Connect credentials. See README.md → ASC credentials.');
  }

  const libraryId = await asc.getAssetLibrary(config, appId);
  const refData = await asc.getRefData(config);

  let versionLocalizations = null;
  let version = null;
  const needsVersion = plan.assets.some((a) => !String(a.kind || '').startsWith('event'));
  if (needsVersion) {
    const versions = await asc.listVersions(config, appId, String(flags.platform || 'IOS'));
    const wanted = typeof flags.version === 'string' ? flags.version : null;
    version = wanted
      ? versions.find((v) => asc.attrsOf(v).versionString === wanted)
      : versions.find((v) => asc.attrsOf(v).appStoreState === 'PREPARE_FOR_SUBMISSION');
    if (!version) {
      fail(
        wanted
          ? `version ${wanted} not found.`
          : 'no editable version (state PREPARE_FOR_SUBMISSION) found. Pass --version <v> for a specific version.',
      );
    }
    versionLocalizations = await asc.listVersionLocalizations(config, version.id);
  }

  let eventLocalizations = null;
  if (typeof flags.event === 'string') {
    eventLocalizations = await asc.listEventLocalizations(config, flags.event);
  }

  const report = {
    ok: false,
    appId,
    libraryId,
    locale: plan.locale || 'en-US',
    version: version ? { id: version.id, versionString: asc.attrsOf(version).versionString } : null,
    assets: [],
    ordering: [],
    warning: 'Assets are uploaded and placed. Submit the parent surface in App Store Connect; this script never submits for review.',
  };

  try {
    for (const asset of plan.assets) {
      const spec = getSpec(snapshot.data, asset.spec);
      const placementType = asset.placementType || spec.placementType;
      const group = asset.placementGroup || spec.placementGroup || (typeof flags.group === 'string' ? flags.group : null);
      if (!placementType) fail(`asset ${asset.id}: no placement type (event detail ids must come from live ref data).`);
      if (!group) {
        fail(
          `asset ${asset.id}: no placement group. Run scripts/refdata.mjs --placement ${placementType} and pass ` +
          'the correct group with --group <id> or per-asset "placementGroup".',
        );
      }
      const target = targetFor(asset.kind, versionLocalizations, eventLocalizations, plan.locale || 'en-US', flags);
      const filePath = path.resolve(process.cwd(), asset.file);
      const buffer = await fs.readFile(filePath);
      const category = spec.category || 'CREATIVE_ASSETS';

      const reservation = await asc.reserveImage(config, {
        libraryId,
        fileName: path.basename(asset.file),
        fileSize: buffer.length,
        category,
        referenceName: `${plan.app || 'App'} — ${asset.id || path.basename(asset.file)} — ${plan.locale || 'en-US'}`,
      });
      await asc.uploadParts(reservation, buffer);
      await asc.commitImage(config, reservation.id);
      const processed = await asc.waitForImage(config, reservation.id);
      const actualSpecId = asc.attrsOf(processed).specId;
      const allowed = asc.specIdsForGroup(refData, placementType, group);
      if (Array.isArray(allowed) && allowed.length && actualSpecId && !allowed.includes(actualSpecId)) {
        throw new Error(
          `asset ${asset.id}: App Store Connect matched spec ${actualSpecId}, which is not in the allowed set for ` +
          `${placementType} / ${group}. Re-render at the exact dimensions reported by refdata.`,
        );
      }

      const existing = await asc.listPlacements(config, target.targetType, target.targetId, {
        placementType,
        placementGroup: group,
      });
      for (const placement of existing) {
        await asc.deletePlacement(config, placement.id);
      }
      const placement = await asc.createPlacement(config, {
        placementType,
        placementGroup: group,
        assetType: 'image',
        assetId: reservation.id,
        targetType: target.targetType,
        targetId: target.targetId,
      });

      report.assets.push({
        id: asset.id,
        file: asset.file,
        imageId: reservation.id,
        specId: actualSpecId,
        state: asc.attrsOf(processed).state,
        placement: { id: placement?.id, type: placementType, group, target: target.targetType },
      });
    }

    // Order screenshots per (target, group). Events are not orderable.
    const groupsToOrder = new Map();
    for (const asset of plan.assets) {
      if (asset.kind !== 'screenshot') continue;
      const spec = getSpec(snapshot.data, asset.spec);
      const group = asset.placementGroup || spec.placementGroup || (typeof flags.group === 'string' ? flags.group : null);
      const target = targetFor(asset.kind, versionLocalizations, eventLocalizations, plan.locale || 'en-US', flags);
      if (target.targetType === 'appEventLocalization') continue;
      const key = `${target.targetId}::${group}`;
      if (!groupsToOrder.has(key)) groupsToOrder.set(key, { target, group, items: [] });
      const uploaded = report.assets.find((a) => a.id === asset.id);
      groupsToOrder.get(key).items.push({ order: asset.order ?? 0, placementId: uploaded?.placement?.id });
    }
    for (const { target, group, items } of groupsToOrder.values()) {
      const ordered = items
        .filter((i) => i.placementId)
        .sort((a, b) => a.order - b.order)
        .map((i) => i.placementId);
      if (ordered.length > 1) {
        await asc.orderPlacements(config, {
          placementGroup: group,
          placementIds: ordered,
          targetType: target.targetType,
          targetId: target.targetId,
        });
        report.ordering.push({ group, placements: ordered });
      }
    }

    report.ok = true;
  } catch (err) {
    report.error = err?.message || String(err);
    const reportPath = path.resolve('upload-report.json');
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fail(`${report.error}\nPartial report written to ${reportPath}`);
  }

  const reportPath = path.resolve('upload-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
}

async function cmdStatus(flags) {
  const config = await requireConfig();
  if (!flags.image) fail('--image <id> is required.');
  const image = await asc.getImage(config, String(flags.image));
  console.log(JSON.stringify({
    id: image?.id,
    state: asc.attrsOf(image).state,
    specId: asc.attrsOf(image).specId,
    referenceName: asc.attrsOf(image).referenceName,
    details: asc.attrsOf(image).stateDetails,
  }, null, 2));
}

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  const sub = positionals[0] || 'help';
  switch (sub) {
    case 'help':
    case '--help':
      help();
      break;
    case 'refdata': {
      const { spawnSync } = await import('node:child_process');
      const { fileURLToPath } = await import('node:url');
      const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'refdata.mjs');
      const res = spawnSync(process.execPath, [script], { stdio: 'inherit' });
      process.exit(res.status ?? 1);
      break;
    }
    case 'apps': await cmdApps(flags); break;
    case 'library': await cmdLibrary(flags); break;
    case 'localizations': await cmdLocalizations(flags); break;
    case 'groups': await cmdGroups(flags); break;
    case 'upload': await cmdUpload(flags); break;
    case 'status': await cmdStatus(flags); break;
    default:
      help();
      process.exitCode = 2;
  }
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
