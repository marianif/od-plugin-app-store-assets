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

import crypto from 'node:crypto';
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
  upload     --plan <file> --app <id> [--execute] [--version <v>] [--event <id>] [--group <id>]\n                                  [--only id1,id2] [--skip-events] [--prune]
                                  [--allow-event-locale-fallback]
                                  upload + place assets (dry-run by default)
  images     --app <id> [--state <state>]
                                  list asset-library images (find orphans)
  delete-image --id <imageId>     delete one library image (no placements)
  status     --image <id>         poll an uploaded image

Credentials:
  ASC_ISSUER_ID, ASC_KEY_ID, ASC_PRIVATE_KEY_PATH (or ASC_PRIVATE_KEY)
  or ~/.config/app-store-assets/config.json

Safety:
  - dry-run is the default; --execute is required to mutate App Store Connect
  - a re-rendered file is a new revision: the reference name carries a content
    digest, the old placement is replaced and the superseded image is retired
  - --prune removes placements/images whose asset id is no longer in the plan
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
      throw new Error('event assets require --event <eventId> (or create the event in App Store Connect first).');
    }
    const locales = eventLocalizations.map((l) => asc.attrsOf(l).locale);
    let entry = eventLocalizations.find((l) => asc.attrsOf(l).locale === locale) || null;
    if (!entry && flags['allow-event-locale-fallback'] === true) entry = eventLocalizations[0] || null;
    if (!entry) {
      throw new Error(
        `the selected in-app event has no ${locale} localization; available: ${locales.join(', ') || 'none'}. ` +
        'Pass --allow-event-locale-fallback to place on the first localization instead.',
      );
    }
    return { targetType: 'appEventLocalization', targetId: entry.id };
  }
  const entry = versionLocalizations.find((l) => asc.attrsOf(l).locale === locale);
  if (!entry) {
    const locales = versionLocalizations.map((l) => asc.attrsOf(l).locale).join(', ');
    throw new Error(`locale ${locale} not found on the chosen version. Available: ${locales || 'none'}`);
  }
  return { targetType: 'appStoreVersionLocalization', targetId: entry.id };
}

async function cmdImages(flags) {
  const config = await requireConfig();
  const appId = appIdFor(flags, config);
  const libraryId = await asc.getAssetLibrary(config, appId);
  const images = await asc.listLibraryImages(config, libraryId, {
    state: typeof flags.state === 'string' ? flags.state : undefined,
  });
  console.log(JSON.stringify({
    appId,
    libraryId,
    count: images.length,
    images: images.map((image) => ({
      id: image.id,
      referenceName: asc.attrsOf(image).referenceName,
      state: asc.attrsOf(image).state,
      specId: asc.attrsOf(image).specId,
    })),
  }, null, 2));
}

async function cmdDeleteImage(flags) {
  const config = await requireConfig();
  if (typeof flags.id !== 'string') fail('--id <imageId> is required.');
  await asc.deleteImage(config, flags.id);
  console.log(JSON.stringify({ ok: true, deleted: flags.id }, null, 2));
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
  const locale = plan.locale || 'en-US';
  const only = typeof flags.only === 'string'
    ? new Set(String(flags.only).split(',').map((v) => v.trim()).filter(Boolean))
    : null;
  const skipEvents = flags['skip-events'] === true;
  const selected = plan.assets.filter((asset) => !only || only.has(asset.id));

  // The reference name carries a short content digest, so a re-rendered file is a
  // new asset rather than a silent no-op on the previous upload. The prefix (app,
  // plan id, locale) identifies the slot for replacement and cleanup.
  const appLabel = plan.app || 'App';
  const slotFor = (asset) => `${appLabel} — ${asset.id || path.basename(asset.file)} — ${locale}`;
  const digestOf = async (file) => {
    const bytes = await fs.readFile(path.resolve(process.cwd(), file));
    return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  };

  const actions = [];
  for (const asset of selected) {
    const spec = getSpec(snapshot.data, asset.spec);
    const placementType = asset.placementType || spec.placementType;
    const group = asset.placementGroup || spec.placementGroup || (typeof flags.group === 'string' ? flags.group : null);
    let digest = null;
    try { digest = await digestOf(asset.file); } catch { digest = null; }
    const slot = slotFor(asset);
    actions.push({
      id: asset.id,
      file: asset.file,
      kind: asset.kind,
      spec: asset.spec,
      pixels: `${spec.width}x${spec.height}`,
      placementType,
      placementGroup: group,
      category: spec.category || 'CREATIVE_ASSETS',
      order: asset.order ?? null,
      digest,
      referencePrefix: slot,
      referenceName: digest ? `${slot} — ${digest}` : slot,
    });
  }
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const isSlotOf = (referenceName, slot) => referenceName === slot || String(referenceName || '').startsWith(`${slot} — `);

  if (!execute) {
    const report = {
      ok: true,
      dryRun: true,
      appId,
      locale,
      credentials: hasCredentials ? 'present' : 'missing (local pre-flight only)',
      refdata: path.relative(process.cwd(), snapshot.path),
      validation: summary,
      actions,
      note: 'Re-run with --execute after an explicit confirmation to upload and create placements.',
    };
    if (hasCredentials) {
      try {
        const live = { libraryId: await asc.getAssetLibrary(config, appId) };
        const refData = await asc.getRefData(config);
        const platform = String(flags.platform || 'IOS');
        const needsVersion = selected.some((a) => !String(a.kind || '').startsWith('event'));
        if (needsVersion) {
          const versions = await asc.listVersions(config, appId, platform);
          const wanted = typeof flags.version === 'string' ? flags.version : null;
          const version = wanted
            ? versions.find((v) => asc.attrsOf(v).versionString === wanted)
            : versions.find((v) => asc.attrsOf(v).appStoreState === 'PREPARE_FOR_SUBMISSION');
          if (version) {
            live.version = { id: version.id, versionString: asc.attrsOf(version).versionString, state: asc.attrsOf(version).appStoreState };
            live.localizations = (await asc.listVersionLocalizations(config, version.id)).map((l) => ({ id: l.id, locale: asc.attrsOf(l).locale }));
            live.targetLocalization = (live.localizations || []).find((l) => l.locale === locale) || null;
          } else {
            live.versionError = wanted ? `version ${wanted} not found` : `no editable ${platform} version found`;
          }
        }
        if (live.targetLocalization) {
          live.checks = [];
          for (const action of actions) {
            if (String(action.kind || '').startsWith('event')) {
              live.checks.push({ id: action.id, placementType: action.placementType, placementGroup: action.placementGroup, skipped: 'in-app event target' });
              continue;
            }
            const allowed = action.placementType && action.placementGroup
              ? asc.specIdsForGroup(refData, action.placementType, action.placementGroup)
              : null;
            const spec = getSpec(snapshot.data, action.spec);
            let fits = null;
            for (const specId of allowed || []) {
              const cover = asc.specCovers(refData, specId, spec.width, spec.height);
              if (cover && cover.ok) { fits = { specId, shortName: cover.shortName }; break; }
            }
            const existing = await asc.listPlacementsDetailed(config, 'appStoreVersionLocalization', live.targetLocalization.id, {
              placementType: action.placementType,
              placementGroup: action.placementGroup,
            }).catch(() => []);
            live.checks.push({
              id: action.id,
              placementType: action.placementType,
              placementGroup: action.placementGroup,
              fitsLiveSpec: fits ? true : (allowed && allowed.length ? false : null),
              matchedSpec: fits ? fits.shortName : null,
              alreadyPlaced: existing.some((p) => p.referenceName === action.referenceName),
              wouldReplacePlacements: existing.filter((p) => isSlotOf(p.referenceName, action.referencePrefix) && p.referenceName !== action.referenceName).length,
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

  if (!hasCredentials) fail('--execute requires App Store Connect credentials. See README.md → ASC credentials.');

  const libraryId = await asc.getAssetLibrary(config, appId);
  const refData = await asc.getRefData(config);
  const platform = String(flags.platform || 'IOS');
  const report = {
    ok: false,
    appId,
    libraryId,
    locale,
    assets: [],
    skipped: [],
    ordering: [],
    warning: 'Assets are uploaded and placed. Submit the parent surface in App Store Connect; this script never submits for review.',
  };

  // Version + localization (only when the plan has non-event assets).
  let versionLocalizations = null;
  if (selected.some((a) => !String(a.kind || '').startsWith('event'))) {
    const versions = await asc.listVersions(config, appId, platform);
    const wanted = typeof flags.version === 'string' ? flags.version : null;
    const version = wanted
      ? versions.find((v) => asc.attrsOf(v).versionString === wanted)
      : versions.find((v) => asc.attrsOf(v).appStoreState === 'PREPARE_FOR_SUBMISSION');
    if (!version) fail(wanted ? `version ${wanted} not found.` : `no editable ${platform} version found; pass --version <v>.`);
    report.version = { id: version.id, versionString: asc.attrsOf(version).versionString };
    versionLocalizations = await asc.listVersionLocalizations(config, version.id);
  }
  let eventLocalizations = typeof flags.event === 'string'
    ? await asc.listEventLocalizations(config, flags.event)
    : null;

  // Adopt images that are already in the library (idempotent re-runs).
  const libraryImages = await asc.listLibraryImages(config, libraryId).catch(() => []);
  const imageByRef = new Map(libraryImages.map((image) => [asc.attrsOf(image).referenceName, image]));

  const placementCache = new Map();
  const placementsFor = async (targetType, targetId, placementType, group) => {
    const key = `${targetId}::${placementType}::${group}`;
    if (!placementCache.has(key)) {
      placementCache.set(key, await asc.listPlacementsDetailed(config, targetType, targetId, { placementType, placementGroup: group }).catch(() => []));
    }
    return placementCache.get(key);
  };

  try {
    for (const asset of selected) {
      const isEvent = String(asset.kind || '').startsWith('event');
      if (isEvent && (skipEvents || !flags.event)) {
        report.skipped.push({ id: asset.id, reason: 'in-app event media needs an event; create it in App Store Connect and re-run with --event <id>' });
        continue;
      }
      const spec = getSpec(snapshot.data, asset.spec);
      const placementType = asset.placementType || spec.placementType;
      const group = asset.placementGroup || spec.placementGroup || (typeof flags.group === 'string' ? flags.group : null);
      if (!placementType) fail(`asset ${asset.id}: no placement type for this spec.`);
      if (!group) fail(`asset ${asset.id}: no placement group. Run scripts/refdata.mjs --placement ${placementType} and pass --group.`);

      const target = isEvent
        ? targetFor(asset.kind, versionLocalizations, eventLocalizations, locale, flags)
        : targetFor(asset.kind, versionLocalizations, null, locale, flags);
      const action = actionById.get(asset.id) || null;
      const referenceName = action ? action.referenceName : slotFor(asset);
      const referencePrefix = action ? action.referencePrefix : slotFor(asset);
      const filePath = path.resolve(process.cwd(), asset.file);
      const buffer = await fs.readFile(filePath);
      const category = spec.category || 'CREATIVE_ASSETS';

      // Pre-flight: does the file match a live spec for this type + group?
      const allowed = asc.specIdsForGroup(refData, placementType, group);
      let matchedSpecId = null;
      for (const specId of allowed || []) {
        const cover = asc.specCovers(refData, specId, spec.width, spec.height);
        if (cover && cover.ok) { matchedSpecId = specId; break; }
      }
      if (Array.isArray(allowed) && allowed.length && !matchedSpecId) {
        throw new Error(`asset ${asset.id}: ${spec.width}x${spec.height} is not accepted for ${placementType} / ${group}.`);
      }

      // 1. Image: adopt an exact content match or upload a new revision.
      let image = imageByRef.get(referenceName);
      let imageAction = 'existing';
      if (image && asc.attrsOf(image).state === 'FAILED') {
        await asc.deleteImage(config, image.id);
        image = null;
      }
      if (!image) {
        const reservation = await asc.reserveImage(config, {
          libraryId,
          fileName: path.basename(asset.file),
          fileSize: buffer.length,
          category,
          referenceName,
        });
        await asc.uploadParts(reservation, buffer);
        await asc.commitImage(config, reservation.id);
        image = await asc.waitForImage(config, reservation.id);
        imageByRef.set(referenceName, image);
        imageAction = 'uploaded';
      }
      const actualSpecId = asc.attrsOf(image).specId;
      if (matchedSpecId && actualSpecId && actualSpecId !== matchedSpecId) {
        throw new Error(`asset ${asset.id}: Apple matched spec ${actualSpecId}, expected ${matchedSpecId}.`);
      }

      // 2. Placement: create only if this asset is not already placed.
      let placements = await placementsFor(target.targetType, target.targetId, placementType, group);
      let placement = placements.find((p) => p.referenceName === referenceName) || null;
      if (!placement) {
        // Replace every earlier revision of this same slot (older digest, or a
        // reference from a previous run that had no digest).
        for (const stale of placements.filter((p) => isSlotOf(p.referenceName, referencePrefix))) {
          await asc.deletePlacement(config, stale.id);
        }
        const created = await asc.createPlacement(config, {
          placementType,
          placementGroup: group,
          assetType: 'image',
          assetId: image.id,
          targetType: target.targetType,
          targetId: target.targetId,
        });
        placementCache.delete(`${target.targetId}::${placementType}::${group}`);
        placements = await placementsFor(target.targetType, target.targetId, placementType, group);
        placement = placements.find((p) => p.referenceName === referenceName) || { id: created?.id || null };
      }

      // Retire superseded library images for this slot once the new placement exists.
      const superseded = [...imageByRef.entries()].filter(([ref]) => ref !== referenceName && isSlotOf(ref, referencePrefix));
      for (const [ref, old] of superseded) {
        try {
          const uses = await asc.listImagePlacements(config, old.id);
          if (!uses.length) {
            await asc.deleteImage(config, old.id);
            imageByRef.delete(ref);
            report.retiredImages = [...(report.retiredImages || []), { imageId: old.id, referenceName: ref }];
          }
        } catch { /* best effort */ }
      }

      report.assets.push({
        id: asset.id,
        file: asset.file,
        digest: action?.digest || null,
        imageAction,
        imageId: image.id,
        specId: actualSpecId,
        state: asc.attrsOf(image).state,
        placement: { id: placement?.id || null, type: placementType, group, target: target.targetType },
      });
    }

    // 2b. Optional prune: drop placements and unused images that belong to our
    // slot namespace but are no longer in the plan (renamed or removed assets).
    if (flags.prune === true) {
      if (only) throw new Error('--prune cannot be combined with --only (a partial plan would prune everything else).');
      const planPrefix = `${appLabel} — `;
      const planIds = new Set(actions.map((a) => a.id));
      const managed = new Map();
      for (const action of actions) {
        if (String(action.kind || '').startsWith('event')) continue;
        const target = targetFor(action.kind, versionLocalizations, null, locale, flags);
        managed.set(`${target.targetId}::${action.placementType}::${action.placementGroup}`, {
          target, placementType: action.placementType, group: action.placementGroup,
        });
      }
      for (const { target, placementType, group } of managed.values()) {
        const placements = await placementsFor(target.targetType, target.targetId, placementType, group);
        for (const p of placements) {
          const ref = p.referenceName || '';
          if (!ref.startsWith(planPrefix)) continue;
          const assetId = ref.slice(planPrefix.length).split(' — ')[0];
          if (planIds.has(assetId)) continue;
          await asc.deletePlacement(config, p.id);
          placementCache.delete(`${target.targetId}::${placementType}::${group}`);
          report.pruned = [...(report.pruned || []), { placementId: p.id, referenceName: ref, reason: 'asset not in plan' }];
        }
      }
      const images = await asc.listLibraryImages(config, libraryId).catch(() => []);
      for (const img of images) {
        const ref = asc.attrsOf(img).referenceName || '';
        if (!ref.startsWith(planPrefix)) continue;
        const assetId = ref.slice(planPrefix.length).split(' — ')[0];
        if (planIds.has(assetId)) continue;
        try {
          const uses = await asc.listImagePlacements(config, img.id);
          if (!uses.length) {
            await asc.deleteImage(config, img.id);
            report.pruned = [...(report.pruned || []), { imageId: img.id, referenceName: ref, reason: 'asset not in plan' }];
          }
        } catch { /* best effort */ }
      }
    }

    // 3. Order each screenshot group by the plan's order.
    const groupsToOrder = new Map();
    for (const asset of selected) {
      if (asset.kind !== 'screenshot' || String(asset.kind).startsWith('event')) continue;
      const spec = getSpec(snapshot.data, asset.spec);
      const group = asset.placementGroup || spec.placementGroup || (typeof flags.group === 'string' ? flags.group : null);
      const target = targetFor(asset.kind, versionLocalizations, null, locale, flags);
      if (target.targetType === 'appEventLocalization') continue;
      const key = `${target.targetId}::${group}`;
      if (!groupsToOrder.has(key)) groupsToOrder.set(key, { target, group, items: [] });
      const action = actionById.get(asset.id);
      if (!action) continue;
      groupsToOrder.get(key).items.push({ order: Number(asset.order || 0), ref: action.referenceName });
    }
    for (const { target, group, items } of groupsToOrder.values()) {
      const placements = await placementsFor(target.targetType, target.targetId, 'APP_SCREENSHOT', group);
      const byRef = new Map(placements.map((p) => [p.referenceName, p.id]));
      const ordered = items
        .sort((a, b) => a.order - b.order)
        .map((i) => byRef.get(i.ref))
        .filter(Boolean);
      if (ordered.length > 1) {
        await asc.orderPlacements(config, {
          placementGroup: group,
          placementIds: ordered,
          targetType: target.targetType,
          targetId: target.targetId,
        });
        report.ordering.push({ group, placements: ordered.length });
      }
    }

    report.ok = true;
  } catch (err) {
    report.error = err?.message || String(err);
    await fs.writeFile(path.resolve('upload-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fail(`${report.error}\nPartial report written to upload-report.json`);
  }

  await fs.writeFile(path.resolve('upload-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
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
    case 'images': await cmdImages(flags); break;
    case 'delete-image': await cmdDeleteImage(flags); break;
    case 'upload': await cmdUpload(flags); break;
    case 'status': await cmdStatus(flags); break;
    default:
      help();
      process.exitCode = 2;
  }
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
