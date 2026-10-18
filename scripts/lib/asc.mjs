// Minimal App Store Connect API client (zero dependencies).
//
// Auth: ES256 JWT signed with the .p8 key, valid for <=20 minutes.
// Assets: App Asset Library (ASC API 4.5.1+). The old appScreenshotSets /
// appPreviews / appEventScreenshots resources are deprecated.
//
// Credentials resolution:
//   1. env: ASC_ISSUER_ID, ASC_KEY_ID, ASC_PRIVATE_KEY_PATH (or ASC_PRIVATE_KEY)
//   2. ~/.config/app-store-assets/config.json
// Never print the key or the signed token.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const ASC_BASE = 'https://api.appstoreconnect.apple.com/v1';

export async function loadAscConfig() {
  const env = {
    issuerId: process.env.ASC_ISSUER_ID || '',
    keyId: process.env.ASC_KEY_ID || '',
    privateKeyPath: process.env.ASC_PRIVATE_KEY_PATH || '',
    privateKey: process.env.ASC_PRIVATE_KEY || '',
    appId: process.env.ASC_APP_ID || '',
  };
  if (env.issuerId && env.keyId && (env.privateKey || env.privateKeyPath)) return env;

  const configPath = process.env.ASC_CONFIG_PATH
    || path.join(os.homedir(), '.config', 'app-store-assets', 'config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      issuerId: parsed.issuerId || '',
      keyId: parsed.keyId || '',
      privateKeyPath: parsed.privateKeyPath || '',
      privateKey: parsed.privateKey || '',
      appId: parsed.appId || '',
      configPath,
    };
  } catch {
    return { ...env, configPath, missing: true };
  }
}

export function assertAscConfig(config) {
  const missing = [];
  if (!config.issuerId) missing.push('issuerId (ASC_ISSUER_ID)');
  if (!config.keyId) missing.push('keyId (ASC_KEY_ID)');
  if (!config.privateKey && !config.privateKeyPath) missing.push('privateKeyPath (ASC_PRIVATE_KEY_PATH)');
  if (missing.length) {
    throw new Error(
      `App Store Connect credentials missing: ${missing.join(', ')}.\n` +
      'Set env vars or create ~/.config/app-store-assets/config.json. See README.md → ASC credentials.',
    );
  }
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export async function signToken(config) {
  assertAscConfig(config);
  const pem = config.privateKey
    ? config.privateKey.replace(/\\n/g, '\n')
    : await fs.readFile(config.privateKeyPath, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: config.keyId, typ: 'JWT' };
  const payload = {
    iss: config.issuerId,
    iat: now,
    exp: now + 15 * 60,
    aud: 'appstoreconnect-v1',
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = crypto.createPrivateKey(pem);
  const signer = crypto.createSign('SHA256');
  signer.update(signingInput);
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

let cachedToken = { value: '', at: 0, keyId: '' };

export async function getToken(config) {
  const fresh = Date.now() - cachedToken.at < 10 * 60 * 1000
    && cachedToken.keyId === config.keyId
    && cachedToken.value;
  if (fresh) return cachedToken.value;
  const value = await signToken(config);
  cachedToken = { value, at: Date.now(), keyId: config.keyId };
  return value;
}

export async function ascFetch(config, route, { method = 'GET', body, timeout = 60000 } = {}) {
  const token = await getToken(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${ASC_BASE}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    if (!res.ok) {
      const detail = json?.errors?.map((e) => `${e.status} ${e.code}: ${e.detail}`).join('\n') || text.slice(0, 800);
      const err = new Error(`ASC ${method} ${route} → ${res.status}\n${detail}`);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return { json, headers: res.headers, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

export function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((v) => search.append(key, String(v)));
    else search.append(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}

// ---- reference data -------------------------------------------------------

export async function getRefData(config) {
  const { json } = await ascFetch(config, '/appAssetLibraryRefData');
  return json;
}

function attrs(node) {
  if (!node) return {};
  return node.attributes || node;
}

function collection(payload, name) {
  if (!payload) return [];
  const data = payload.data ?? payload;
  if (Array.isArray(data)) {
    const first = attrs(data[0]);
    return first?.[name] ?? [];
  }
  const a = attrs(data);
  return a?.[name] ?? a?.attributes?.[name] ?? [];
}

export function refdataSummary(payload) {
  const features = collection(payload, 'features');
  const groups = collection(payload, 'placementProfileGroups');
  const imageSpecs = collection(payload, 'imageSpecs');
  const videoSpecs = collection(payload, 'videoSpecs');
  const placementTypes = collection(payload, 'placementTypes');
  const displayClasses = collection(payload, 'displayClasses');
  return { features, groups, imageSpecs, videoSpecs, placementTypes, displayClasses };
}

export function refdataGroups(payload, placementType) {
  const summary = refdataSummary(payload);
  const type = summary.placementTypes.find((entry) => {
    const a = attrs(entry);
    return a.placementTypeId === placementType || a.placementType === placementType || a.id === placementType || a.type === placementType;
  });
  if (!type) return [];
  const a = attrs(type);
  const mappings = a.specMappings || a.specsByGroup || [];
  const out = [];
  for (const mapping of mappings) {
    const m = attrs(mapping);
    const group = m.placementGroupId || m.placementGroup || m.group || m.placementProfileGroup || m.groupId;
    if (group) out.push({ group, specs: m.specs || m.specIds || m.specificationIds || [] });
  }
  return out;
}

export function specIdsForGroup(payload, placementType, placementGroup) {
  const summary = refdataSummary(payload);
  const type = summary.placementTypes.find((entry) => {
    const a = attrs(entry);
    return a.placementTypeId === placementType || a.placementType === placementType || a.id === placementType || a.type === placementType;
  });
  if (!type) return null;
  const a = attrs(type);
  const mappings = a.specMappings || a.specsByGroup || [];
  for (const mapping of mappings) {
    const m = attrs(mapping);
    const group = m.placementGroupId || m.placementGroup || m.group || m.placementProfileGroup || m.groupId;
    if (group === placementGroup) return m.specs || m.specIds || m.specificationIds || [];
  }
  return null;
}

export function imageSpecById(payload, specId) {
  const summary = refdataSummary(payload);
  const found = summary.imageSpecs.find((entry) => {
    const a = attrs(entry);
    return a.specId === specId || a.id === specId;
  });
  return found ? attrs(found) : null;
}

export function specCovers(payload, specId, width, height) {
  const spec = imageSpecById(payload, specId);
  if (!spec) return null;
  const dims = spec.dimensions || {};
  const ok = Number(dims.minWidth) <= width && width <= Number(dims.maxWidth)
    && Number(dims.minHeight) <= height && height <= Number(dims.maxHeight);
  return { ok, shortName: spec.shortName, minWidth: dims.minWidth, maxWidth: dims.maxWidth, minHeight: dims.minHeight, maxHeight: dims.maxHeight };
}

export function imageSpecByShortName(payload, shortName) {
  const summary = refdataSummary(payload);
  return summary.imageSpecs.find((entry) => {
    const a = attrs(entry);
    return a.shortName === shortName;
  });
}

// ---- app, version, localizations -----------------------------------------

export async function getAssetLibrary(config, appId) {
  try {
    const { json } = await ascFetch(config, `/apps/${encodeURIComponent(appId)}/assetLibrary`);
    const id = json?.data?.id;
    if (id) return id;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  // Some apps expose their own id as the library id until the first asset
  // exists. Apple's guide reads the relationship; this fallback keeps the
  // first upload from failing on an empty library.
  return appId;
}

export async function listVersions(config, appId, platform = 'IOS') {
  const { json } = await ascFetch(
    config,
    `/apps/${encodeURIComponent(appId)}/appStoreVersions${qs({
      'filter[platform]': platform,
      limit: 200,
      'fields[appStoreVersions]': 'versionString,platform,appStoreState,createdDate',
    })}`,
  );
  return json?.data || [];
}

export async function listVersionLocalizations(config, versionId) {
  const { json } = await ascFetch(
    config,
    `/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations${qs({ limit: 200 })}`,
  );
  return json?.data || [];
}

export async function listAppEvents(config, appId) {
  const { json } = await ascFetch(
    config,
    `/apps/${encodeURIComponent(appId)}/appEvents${qs({ limit: 200 })}`,
  );
  return json?.data || [];
}

export async function listEventLocalizations(config, eventId) {
  const { json } = await ascFetch(
    config,
    `/appEvents/${encodeURIComponent(eventId)}/localizations${qs({ limit: 100 })}`,
  );
  return json?.data || [];
}

// ---- assets ---------------------------------------------------------------

export async function reserveImage(config, { libraryId, fileName, fileSize, category, referenceName }) {
  const body = {
    data: {
      type: 'appAssetLibraryImages',
      attributes: {
        fileName,
        fileSize,
        category,
        ...(referenceName ? { referenceName } : {}),
      },
      relationships: {
        assetLibrary: { data: { type: 'appAssetLibraries', id: libraryId } },
      },
    },
  };
  const { json } = await ascFetch(config, '/appAssetLibraryImages', { method: 'POST', body });
  return json?.data;
}

export async function uploadParts(asset, buffer) {
  const operations = asset?.attributes?.uploadOperations || asset?.uploadOperations || [];
  if (!operations.length) throw new Error('reservation returned no uploadOperations');
  for (const [index, op] of operations.entries()) {
    const start = Number(op.offset || 0);
    const end = start + Number(op.length || 0);
    const chunk = buffer.subarray(start, end);
    const headers = {};
    for (const header of op.requestHeaders || []) headers[header.name] = header.value;
    const res = await fetch(op.url, { method: op.method || 'PUT', headers, body: chunk });
    if (!res.ok) {
      throw new Error(`upload part ${index + 1}/${operations.length} failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  }
}

export async function commitImage(config, imageId) {
  const body = {
    data: { type: 'appAssetLibraryImages', id: imageId, attributes: { uploaded: true } },
  };
  await ascFetch(config, `/appAssetLibraryImages/${encodeURIComponent(imageId)}`, { method: 'PATCH', body });
}

export async function getImage(config, imageId) {
  const { json } = await ascFetch(config, `/appAssetLibraryImages/${encodeURIComponent(imageId)}`);
  return json?.data;
}

export async function waitForImage(config, imageId, { timeoutMs = 10 * 60 * 1000, intervalMs = 5000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const image = await getImage(config, imageId);
    last = image;
    const state = attrs(image).state;
    if (state === 'PREPARE_FOR_SUBMISSION' || state === 'APPROVED' || state === 'READY_FOR_REVIEW') return image;
    if (state === 'FAILED' || state === 'REJECTED') {
      const details = attrs(image).stateDetails;
      throw new Error(`asset ${imageId} ended in ${state}: ${JSON.stringify(details)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for asset ${imageId}; last state ${attrs(last).state}`);
}

export async function listLibraryImages(config, libraryId, { state } = {}) {
  const { json } = await ascFetch(
    config,
    `/appAssetLibraries/${encodeURIComponent(libraryId)}/images${qs({
      limit: 200,
      'fields[appAssetLibraryImages]': 'referenceName,state,fileName,specId',
      'filter[state]': state,
    })}`,
  );
  return json?.data || [];
}

export async function deleteImage(config, imageId) {
  await ascFetch(config, `/appAssetLibraryImages/${encodeURIComponent(imageId)}`, { method: 'DELETE' });
}

// ---- placements -----------------------------------------------------------

const PLACEMENT_TARGET_ROUTE = {
  appStoreVersionLocalization: 'appStoreVersionLocalizations',
  appCustomProductPageLocalization: 'appCustomProductPageLocalizations',
  appEventLocalization: 'appEventLocalizations',
  appStoreVersionExperimentTreatmentLocalization: 'appStoreVersionExperimentTreatmentLocalizations',
};

export async function listPlacements(config, targetType, targetId, { placementType, placementGroup } = {}) {
  const route = PLACEMENT_TARGET_ROUTE[targetType];
  if (!route) throw new Error(`unsupported placement target type: ${targetType}`);
  const { json } = await ascFetch(
    config,
    `/${route}/${encodeURIComponent(targetId)}/placements${qs({
      'filter[placementType]': placementType,
      'filter[placementGroup]': placementGroup,
      limit: 200,
      sort: 'placementGroupPosition',
    })}`,
  );
  return json?.data || [];
}

export async function listPlacementsDetailed(config, targetType, targetId, { placementType, placementGroup } = {}) {
  const route = PLACEMENT_TARGET_ROUTE[targetType];
  if (!route) throw new Error(`unsupported placement target type: ${targetType}`);
  const { json } = await ascFetch(config, `/${route}/${encodeURIComponent(targetId)}/placements${qs({
    'filter[placementType]': placementType,
    'filter[placementGroup]': placementGroup,
    limit: 200,
    sort: 'placementGroupPosition',
    include: 'image',
    'fields[appAssetLibraryImages]': 'referenceName,state,specId',
  })}`);
  const byId = new Map((json?.included || []).map((node) => [node.id, attrs(node)]));
  return (json?.data || []).map((placement) => {
    const a = attrs(placement);
    const imageId = placement.relationships?.image?.data?.id || null;
    const image = imageId ? byId.get(imageId) || {} : {};
    return {
      id: placement.id,
      placementType: a.placementType,
      placementGroup: a.placementGroup,
      state: a.state,
      imageId,
      referenceName: image.referenceName || null,
      imageState: image.state || null,
      specId: image.specId || null,
    };
  });
}

export async function deletePlacement(config, placementId) {
  await ascFetch(config, `/appAssetLibraryPlacements/${encodeURIComponent(placementId)}`, { method: 'DELETE' });
}

// The relationship NAME is singular (appStoreVersionLocalization) but the
// JSON:API resource TYPE is plural (appStoreVersionLocalizations). Sending the
// singular form fails with 409 ENTITY_ERROR.RELATIONSHIP.INVALID.
const PLACEMENT_TARGET_TYPE = {
  appStoreVersionLocalization: 'appStoreVersionLocalizations',
  appCustomProductPageLocalization: 'appCustomProductPageLocalizations',
  appEventLocalization: 'appEventLocalizations',
  appStoreVersionExperimentTreatmentLocalization: 'appStoreVersionExperimentTreatmentLocalizations',
};

export async function createPlacement(config, {
  placementType, placementGroup, assetType = 'image', assetId, targetType, targetId,
}) {
  const targetResourceType = PLACEMENT_TARGET_TYPE[targetType];
  if (!targetResourceType) throw new Error(`unsupported placement target: ${targetType}`);
  const body = {
    data: {
      type: 'appAssetLibraryPlacements',
      attributes: {
        placementType,
        ...(placementGroup ? { placementGroup } : {}),
      },
      relationships: {
        [assetType]: { data: { type: assetType === 'image' ? 'appAssetLibraryImages' : 'appAssetLibraryVideos', id: assetId } },
        [targetType]: { data: { type: targetResourceType, id: targetId } },
      },
    },
  };
  const { json } = await ascFetch(config, '/appAssetLibraryPlacements', { method: 'POST', body });
  return json?.data;
}

export async function orderPlacements(config, { placementGroup, placementIds, targetType, targetId }) {
  const targetResourceType = PLACEMENT_TARGET_TYPE[targetType];
  if (!targetResourceType) throw new Error(`unsupported ordering target: ${targetType}`);
  const body = {
    data: {
      type: 'appAssetLibraryPlacementOrderingRequests',
      attributes: { placementGroup },
      relationships: {
        orderedPlacements: {
          data: placementIds.map((id) => ({ type: 'appAssetLibraryPlacements', id })),
        },
        [targetType]: { data: { type: targetResourceType, id: targetId } },
      },
    },
  };
  const { json } = await ascFetch(config, '/appAssetLibraryPlacementOrderingRequests', { method: 'POST', body });
  return json?.data;
}

export function attrsOf(node) {
  return attrs(node);
}
