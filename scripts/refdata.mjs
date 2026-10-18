#!/usr/bin/env node
// Fetch the live App Asset Library reference data and normalize it into the
// same shape the validator uses. Requires App Store Connect credentials.
//
//   node .app-store-assets/scripts/refdata.mjs
//   node .app-store-assets/scripts/refdata.mjs --placement APP_SCREENSHOT
//
// Outputs:
//   .app-store-assets/references/refdata-live.json  (normalized)
//   .app-store-assets/references/refdata-raw.json   (raw API response)
//
// Apple changes specs and placement groups as devices ship. Refresh this before
// every upload; never trust the checked-in snapshot for upload ids.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, fail } from './lib/daemon.mjs';
import { loadAscConfig, assertAscConfig, getRefData, refdataSummary, refdataGroups, attrsOf } from './lib/asc.mjs';
import { loadSnapshot } from './lib/specs.mjs';

function num(value, fallback = null) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function liveSpecMatches(liveSpec, width, height, placementType) {
  const dims = liveSpec.dimensions || {};
  const covers = Number(dims.minWidth) <= width && width <= Number(dims.maxWidth)
    && Number(dims.minHeight) <= height && height <= Number(dims.maxHeight);
  const compatible = Array.isArray(liveSpec.compatiblePlacementTypes) ? liveSpec.compatiblePlacementTypes : [];
  const typeOk = !placementType || compatible.includes(placementType);
  return covers && typeOk;
}

// Apple ships its own spec ids; our plans use stable canonical keys. Alias each
// canonical key onto the live spec that covers the same pixels + placement type,
// so the uploader can verify against live data without the plan changing.
function mergeCanonicalKeys(normalized, imageSpecs) {
  return loadSnapshot()
    .then(({ data }) => {
      let merged = 0;
      for (const [key, spec] of Object.entries(data.specs || {})) {
        if (!spec || typeof spec.width !== 'number') continue;
        const live = imageSpecs.find((entry) => liveSpecMatches(attrsOf(entry), spec.width, spec.height, spec.placementType));
        if (!live) continue;
        const a = attrsOf(live);
        const dims = a.dimensions || {};
        normalized.specs[key] = {
          ...spec,
          specId: a.specId,
          liveShortName: a.shortName,
          minWidth: dims.minWidth, maxWidth: dims.maxWidth,
          minHeight: dims.minHeight, maxHeight: dims.maxHeight,
        };
        merged += 1;
      }
      return merged;
    })
    .catch(() => 0);
}

function normalize(payload) {
  const summary = refdataSummary(payload);
  const specs = {};
  for (const entry of summary.imageSpecs) {
    const a = attrsOf(entry);
    const dims = a.dimensions || {};
    const width = num(dims.minWidth ?? dims.maxWidth ?? a.width);
    const height = num(dims.minHeight ?? dims.maxHeight ?? a.height);
    if (!width || !height) continue;
    const shortName = a.shortName || a.specId || a.id || `${width}x${height}`;
    specs[`live-${shortName}`] = {
      label: shortName,
      width,
      height,
      cssWidth: width / 2,
      cssHeight: height / 2,
      placementType: Array.isArray(a.compatiblePlacementTypes) ? a.compatiblePlacementTypes[0] || null : null,
      category: null,
      placementGroup: null,
      formats: Array.isArray(a.fileExtensions) ? a.fileExtensions : ['.png', '.jpg', '.jpeg'],
      alphaAllowed: a.alphaAllowed !== false,
      maxBytes: num(a.maxFileSize),
      specId: a.specId || a.id || null,
      universalAsset: a.universalAsset === true,
      v1: false,
    };
  }

  const groups = summary.groups.map((entry) => {
    const a = attrsOf(entry);
    return {
      id: a.placementProfileGroupId || a.placementGroup || a.groupId || a.id,
      platform: a.platform || a.placementPlatform || null,
      displayClass: a.displayClass || null,
      raw: a,
    };
  }).filter((g) => g.id);

  const placementTypes = {};
  for (const entry of summary.placementTypes) {
    const a = attrsOf(entry);
    const id = a.placementTypeId || a.placementType || a.id;
    if (!id) continue;
    placementTypes[id] = {
      acceptsAssetCategories: a.acceptsAssetCategories || a.assetCategories || [],
      specMappings: (a.specMappings || a.specsByGroup || []).map((m) => ({
        placementGroupId: m.placementGroupId || m.placementGroup || m.group || m.placementProfileGroup,
        specs: m.specs || m.specIds || [],
      })),
      orderable: a.orderable,
    };
  }

  return {
    capturedAt: new Date().toISOString(),
    source: 'live App Store Connect appAssetLibraryRefData',
    renderer: { scale: 2, rule: 'export width/height are CSS points; PNG output = css * 2', alpha: 'must be false' },
    limits: {
      screenshotsPerGroup: 10,
      appPreviewsPerGroup: 3,
      headerPerGroup: 1,
      searchPerLocalization: 1,
      eventAssetsPerPlacementType: 1,
      maxImageBytes: 524288000,
    },
    specs,
    groups,
    placementTypes,
    features: summary.features,
    displayClasses: summary.displayClasses,
  };
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(`refdata.mjs — fetch live App Asset Library specs

  --out <file>        normalized snapshot (default .app-store-assets/references/refdata-live.json)
  --raw <file>        raw API payload (default .app-store-assets/references/refdata-raw.json)
  --placement <type>  print placement groups/specs for this type (e.g. APP_SCREENSHOT)
  --json              print the normalized summary as JSON

Requires ASC credentials. See README.md → ASC credentials.
`);
    return;
  }

  const config = await loadAscConfig();
  try {
    assertAscConfig(config);
  } catch (err) {
    fail(`${err.message}\n\nThis is expected until the ASC API key is added (flagged in ROADMAP.md).`);
    return;
  }

  const payload = await getRefData(config);
  const out = path.resolve(String(flags.out || '.app-store-assets/references/refdata-live.json'));
  const rawOut = path.resolve(String(flags.raw || '.app-store-assets/references/refdata-raw.json'));
  const normalized = normalize(payload);
  const merged = await mergeCanonicalKeys(normalized, refdataSummary(payload).imageSpecs);

  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.mkdir(path.dirname(rawOut), { recursive: true });
  await fs.writeFile(rawOut, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  if (flags.placement) {
    const type = String(flags.placement);
    const mappings = refdataGroups(payload, type);
    console.log(JSON.stringify({
      placementType: type,
      groups: mappings.map((m) => ({
        group: m.group,
        specs: m.specs,
      })),
    }, null, 2));
    return;
  }

  const summary = {
    ok: true,
    out: path.relative(process.cwd(), out),
    raw: path.relative(process.cwd(), rawOut),
    imageSpecs: Object.keys(normalized.specs).length,
    canonicalKeysMerged: merged,
    groups: normalized.groups.length,
    placementTypes: Object.keys(normalized.placementTypes).length,
  };
  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\n✓ live ref data saved`);
    console.log(`  specs: ${summary.imageSpecs} (${summary.canonicalKeysMerged} canonical keys merged) · groups: ${summary.groups} · placement types: ${summary.placementTypes}`);
    console.log(`  ${summary.out}`);
    console.log(`  ${summary.raw}\n`);
    console.log('Next: pass the normalized file to the validator and uploader with --refdata ' + summary.out);
  }
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
