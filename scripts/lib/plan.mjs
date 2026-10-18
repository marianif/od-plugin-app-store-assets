// Shared plan validation used by validate.mjs and asc-upload.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectImage, assertSpecMatch } from './image.mjs';
import { getSpec } from './specs.mjs';

const KIND_SPEC_PREFIX = {
  screenshot: ['iphone-', 'ipad-', 'mac-', 'tv-', 'vision-', 'watch-'],
  header: ['header-', 'creative-'],
  search: ['search-', 'creative-'],
  'event-card': ['event-card-'],
  'event-detail': ['event-detail-'],
};

const COPY_RULES = [
  { code: 'price-claim', severity: 'P0', re: /(?:[$€£¥]\s?\d)|(?:\b\d+(?:[.,]\d+)?\s?(?:[$€£¥]|usd|eur|gbp))/i, message: 'Price or currency amount in copy; App Store assets must not include pricing.' },
  { code: 'url', severity: 'P0', re: /https?:\/\/|\bwww\./i, message: 'URL in copy; assets must not include website addresses.' },
  { code: 'copyright-symbol', severity: 'P0', re: /[©®™]/, message: 'Copyright/trademark symbol in copy.' },
  { code: 'apple-recognition', severity: 'P0', re: /editor'?s choice|app of the day|game of the day|apple design award|featured by apple/i, message: 'Apple recognition claim; these are applied by Apple, not by the developer.' },
  { code: 'other-platform', severity: 'P0', re: /\bandroid\b|google play|play store|\bsamsung\b|\bwindows\b|meta quest/i, message: 'Reference to another platform or marketplace.' },
  { code: 'unverifiable-claim', severity: 'P0', re: /\b#1\b|\bbest (?:app|game)\b|\baward[- ]winning\b/i, message: 'Unverifiable superlative/award claim.' },
  { code: 'discount-claim', severity: 'P1', re: /\bfree\b|\bsale\b|\bdiscount\b|\b\d+%\s*off\b|\bsave\b/i, message: 'Possible price/discount claim; review manually.' },
  { code: 'hype', severity: 'P2', re: /!|\b(?:amazing|revolutionary|game[- ]changing)\b/i, message: 'Hype punctuation/wording; keep the tone factual.' },
  { code: 'stale-copy', severity: 'P2', re: /\b(?:new|now|finally)\b/i, message: 'Time-bound copy ages quickly; prefer evergreen wording.' },
];

function copyText(copy) {
  if (!copy || typeof copy !== 'object') return '';
  return Object.values(copy).filter((v) => typeof v === 'string').join('\n');
}

export function lintCopy(copy) {
  const text = copyText(copy);
  const out = [];
  if (!text.trim()) return out;
  for (const rule of COPY_RULES) {
    if (rule.re.test(text)) out.push({ severity: rule.severity, code: rule.code, message: rule.message });
  }
  const headline = typeof copy?.headline === 'string' ? copy.headline.trim() : '';
  const hook = typeof copy?.hook === 'string' ? copy.hook.trim() : '';
  const longest = headline || hook;
  if (longest) {
    const words = longest.split(/\s+/).filter(Boolean).length;
    if (words > 12) out.push({ severity: 'P1', code: 'copy-too-long', message: `Headline/hook is ${words} words; aim for 2–6.` });
    else if (words > 9) out.push({ severity: 'P2', code: 'copy-long', message: `Headline/hook is ${words} words; consider trimming.` });
    if (longest.length > 60) out.push({ severity: 'P2', code: 'copy-chars', message: `Headline/hook is ${longest.length} characters; test at 10% width.` });
  }
  return out;
}

export async function validatePlan({ plan, snapshot, cwd = process.cwd() }) {
  const findings = [];
  const add = (severity, assetId, code, message) => findings.push({ severity, assetId, code, message });

  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.assets)) {
    add('P0', null, 'plan-shape', 'asset-plan.json must contain an "assets" array.');
    return { findings, summary: { assets: 0, passed: 0 } };
  }
  if (plan.version !== 1) add('P1', null, 'plan-version', 'Expected plan version 1.');
  if (!plan.locale) add('P1', null, 'plan-locale', 'Missing locale; default the plan to en-US.');

  const counts = new Map();
  const orderBuckets = new Map();

  for (const [index, asset] of plan.assets.entries()) {
    const id = asset?.id || `asset-${index + 1}`;
    if (!asset?.spec) { add('P0', id, 'missing-spec', 'Asset has no spec key.'); continue; }
    let spec;
    try {
      spec = getSpec(snapshot, asset.spec);
    } catch (err) {
      add('P0', id, 'unknown-spec', err.message);
      continue;
    }

    if (asset.kind) {
      const prefixes = KIND_SPEC_PREFIX[asset.kind];
      if (prefixes && !prefixes.some((prefix) => asset.spec.startsWith(prefix))) {
        add('P1', id, 'kind-spec-mismatch', `kind "${asset.kind}" does not match spec "${asset.spec}".`);
      }
    }
    if (asset.placementType && spec.placementType && asset.placementType !== spec.placementType) {
      add('P0', id, 'placement-type-mismatch', `placementType "${asset.placementType}" != spec placementType "${spec.placementType}".`);
    }

    if (!asset.file) {
      add('P0', id, 'missing-file', 'Asset has no file path.');
    } else {
      const file = path.isAbsolute(asset.file) ? asset.file : path.resolve(cwd, asset.file);
      try {
        const info = await inspectImage(file);
        const problems = assertSpecMatch(info, { ...spec, maxBytes: snapshot?.limits?.maxImageBytes });
        for (const problem of problems) add('P0', id, 'file-invalid', problem);
        asset.__info = info;
      } catch (err) {
        add('P0', id, 'file-missing', `cannot read ${asset.file}: ${err.message}`);
      }
    }

    if (asset.html) {
      const htmlPath = path.isAbsolute(asset.html) ? asset.html : path.resolve(cwd, asset.html);
      try { await fs.access(htmlPath); } catch { add('P2', id, 'html-missing', `canvas source not found: ${asset.html}`); }
    }

    if (asset.copy) {
      for (const finding of lintCopy(asset.copy)) add(finding.severity, id, finding.code, finding.message);
    }

    const bucketKey = `${asset.kind || 'other'}::${asset.placementGroup || spec.placementGroup || asset.spec}`;
    counts.set(bucketKey, (counts.get(bucketKey) || 0) + 1);

    if (asset.kind === 'screenshot') {
      if (!Number.isInteger(asset.order) || asset.order < 1) {
        add('P1', id, 'order-missing', 'Screenshot needs a positive integer order.');
      } else {
        const orderKey = asset.placementGroup || spec.placementGroup || asset.spec;
        if (!orderBuckets.has(orderKey)) orderBuckets.set(orderKey, new Map());
        const bucket = orderBuckets.get(orderKey);
        if (bucket.has(asset.order)) {
          add('P0', id, 'order-duplicate', `Duplicate screenshot order ${asset.order} in ${orderKey}; also used by ${bucket.get(asset.order)}.`);
        } else {
          bucket.set(asset.order, id);
        }
      }
    }
  }

  const limits = snapshot?.limits || {};
  for (const [bucketKey, count] of counts) {
    const [kind, group] = bucketKey.split('::');
    if (kind === 'screenshot' && count > (limits.screenshotsPerGroup || 10)) {
      add('P0', null, 'too-many-screenshots', `${count} screenshots in ${group}; max is 10.`);
    }
    if (kind === 'header' && count > 1) add('P0', null, 'too-many-headers', `More than one header per group (${group}).`);
    if (kind === 'search' && count > 1) add('P0', null, 'too-many-search', `More than one search asset per localization (${group}).`);
    if (kind === 'event-card' && count > 1) add('P0', null, 'too-many-event-cards', `More than one event card (${group}).`);
    if (kind === 'event-detail' && count > 1) add('P0', null, 'too-many-event-details', `More than one event detail asset (${group}).`);
  }

  const p0 = findings.filter((f) => f.severity === 'P0').length;
  return {
    findings,
    summary: {
      assets: plan.assets.length,
      p0,
      p1: findings.filter((f) => f.severity === 'P1').length,
      p2: findings.filter((f) => f.severity === 'P2').length,
      passed: plan.assets.length - new Set(findings.filter((f) => f.severity === 'P0').map((f) => f.assetId)).size,
    },
  };
}

export function renderReport({ plan, findings, summary }) {
  const lines = [];
  lines.push('# App Store asset validation report');
  lines.push('');
  lines.push(`- App: **${plan?.app || 'unknown'}**`);
  lines.push(`- Locale: **${plan?.locale || 'en-US'}**`);
  lines.push(`- Assets: **${summary.assets}**`);
  lines.push(`- Blockers (P0): **${summary.p0}** · Warnings (P1): **${summary.p1}** · Notes (P2): **${summary.p2}**`);
  lines.push('');
  lines.push(summary.p0 === 0 ? '**Result: PASS** — no mechanical blockers. Human review still required for Apple policy.' : '**Result: FAIL** — fix the P0 items before uploading.');
  lines.push('');
  lines.push('## Assets');
  lines.push('');
  lines.push('| # | id | kind | spec | file | pixels | alpha | result |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  plan?.assets?.forEach((asset, index) => {
    const info = asset.__info;
    const assetFindings = findings.filter((f) => f.assetId === (asset.id || `asset-${index + 1}`));
    const blockers = assetFindings.filter((f) => f.severity === 'P0').length;
    lines.push(
      `| ${index + 1} | ${asset.id || ''} | ${asset.kind || ''} | ${asset.spec || ''} | ${asset.file || ''} | ` +
      `${info ? `${info.width}×${info.height}` : '—'} | ${info ? (info.hasAlpha ? 'yes' : 'no') : '—'} | ` +
      `${blockers ? 'FAIL' : 'ok'} |`,
    );
  });
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (!findings.length) {
    lines.push('No findings. Every asset matches its spec and the copy lint is clean.');
  } else {
    const order = { P0: 0, P1: 1, P2: 2 };
    const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
    for (const finding of sorted) {
      lines.push(`- **${finding.severity}** ${finding.assetId ? `\`${finding.assetId}\`` : ''} — ${finding.message}`);
    }
  }
  lines.push('');
  lines.push('## Apple rules the validator cannot judge');
  lines.push('');
  lines.push('- 4+ suitability, inclusive/global imagery, no gore or weapons pointed at the viewer.');
  lines.push('- One clear idea per asset; screenshots must show the real app in use.');
  lines.push('- Unverifiable claims that are not on the regex list (fact-check every number/award).');
  lines.push('- Localization quality and whether the copy reads naturally in the target language.');
  lines.push('');
  lines.push('_Generated by the App Store Assets plugin. Specs resolved 2026-10-18; refresh the live ref data before uploading._');
  return `${lines.join('\n')}\n`;
}
