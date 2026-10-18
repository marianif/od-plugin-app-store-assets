// Spec resolution for composing and validating assets.
//
// The checked-in snapshot is an offline fallback captured 2026-10-18. The
// upload path must refresh the live catalog with `asc-upload.mjs refdata` and
// pass `--refdata live.json`; group ids and spec ids come from Apple at runtime.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT_DIR = path.resolve(HERE, '..');
export const DEFAULT_SNAPSHOT = path.resolve(SCRIPT_DIR, '..', 'references', 'refdata-snapshot.json');
export const WORKDIR_SNAPSHOT = path.resolve(process.cwd(), '.app-store-assets', 'references', 'refdata-snapshot.json');

export async function loadSnapshot(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.OD_APP_STORE_REFDATA,
    WORKDIR_SNAPSHOT,
    DEFAULT_SNAPSHOT,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      return { path: candidate, data: JSON.parse(raw) };
    } catch {
      // next
    }
  }
  throw new Error(
    'no refdata snapshot found. Expected .app-store-assets/references/refdata-snapshot.json or a --refdata <file>.',
  );
}

export function getSpec(snapshot, key) {
  const spec = snapshot?.specs?.[key];
  if (!spec) {
    const keys = Object.keys(snapshot?.specs || {});
    const shown = keys.slice(0, 12).join(', ');
    const more = keys.length > 12 ? `, … (${keys.length} total)` : '';
    throw new Error(`unknown spec "${key}". Available: ${shown}${more}`);
  }
  return spec;
}

export function listSpecs(snapshot, { v1Only = false } = {}) {
  return Object.entries(snapshot?.specs || {})
    .filter(([, spec]) => (v1Only ? spec.v1 === true : true))
    .map(([key, spec]) => ({ key, ...spec }));
}

export function specForKind(snapshot, kind) {
  const kindMap = {
    screenshot: ['iphone-1320x2868', 'iphone-1290x2796', 'iphone-1206x2622', 'iphone-1179x2556', 'ipad-2064x2752'],
    header: ['header-3840x1646'],
    search: ['search-3840x2560'],
    'event-card': ['event-card-3840x2160'],
    'event-detail': ['event-detail-2160x3840'],
  };
  return (kindMap[kind] || []).filter((key) => Boolean(snapshot?.specs?.[key]));
}

export function cssSize(spec) {
  return {
    cssWidth: spec.cssWidth ?? spec.width / 2,
    cssHeight: spec.cssHeight ?? spec.height / 2,
  };
}
