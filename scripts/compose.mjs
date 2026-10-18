#!/usr/bin/env node
// Compose a static canvas: replace tokens, inject the theme, resolve the shot,
// and write the HTML through the project API (so OpenDesign indexes it) or to
// disk. No client-side JS is required — the desktop renderer does not execute
// inline scripts on project pages.
//
//   node .app-store-assets/scripts/compose.mjs \
//     --template screenshot \
//     --out store/en-US/iphone-1320x2868/01.html \
//     --data-file .tmp/shot-01.json
//
// `data.shot` (or --shot) is interpreted relative to the current directory
// (the project root), then rewritten relative to the output HTML.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, fail, resolveDaemonUrl, writeProjectFile } from './lib/daemon.mjs';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeCssValue(value) {
  const text = String(value ?? '').trim();
  return /^[#a-zA-Z0-9(),.%\s-]+$/.test(text) ? text : null;
}

const THEME_VARS = {
  bg: '--bg',
  ink: '--ink',
  accent: '--accent',
  muted: '--muted',
  panel: '--panel',
  cream: '--cream',
  mark: '--mark',
  markInk: '--mark-ink',
};

function themeDeclarations(theme) {
  if (!theme || typeof theme !== 'object') return '';
  const lines = [];
  for (const [key, value] of Object.entries(theme)) {
    const cssVar = THEME_VARS[key] || (String(key).startsWith('--') ? String(key) : null);
    if (!cssVar) continue;
    const safe = safeCssValue(value);
    if (!safe) continue;
    lines.push(`${cssVar}: ${safe};`);
  }
  return lines.join('\n    ');
}

function fitSize(text, steps, fallback) {
  const length = [...String(text || '')].length;
  for (const [max, size] of steps) if (length <= max) return size;
  return fallback;
}

const HEADLINE_STEPS = [[22, 64], [34, 58], [46, 52], [60, 46]];
const HOOK_STEPS = [[16, 104], [28, 92], [40, 80]];
const CARD_TITLE_STEPS = [[24, 92], [40, 82], [56, 72]];
const DETAIL_TITLE_STEPS = [[24, 78], [40, 70], [56, 62]];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function relativeShot(outFile, shot) {
  if (!shot) return '';
  if (/^(?:https?:|data:|file:)/i.test(shot) || path.isAbsolute(shot)) return shot;
  const absolute = path.resolve(process.cwd(), shot);
  return toPosix(path.relative(path.dirname(outFile), absolute)) || path.basename(absolute);
}

async function resolveTemplate(input) {
  const value = String(input || '');
  if (!value) fail('--template is required.');
  if (value.includes('/') || value.endsWith('.html')) return path.resolve(value);
  for (const base of ['.app-store-assets/assets/canvases', 'assets/canvases']) {
    const candidate = path.resolve(base, `${value}.html`);
    try { await fs.access(candidate); return candidate; } catch { /* next */ }
  }
  fail(`template "${value}" not found in .app-store-assets/assets/canvases or assets/canvases.`);
}

function tokensFor(kind, data, outPath) {
  const shot = relativeShot(outPath, data.shot || '');
  const shotBlock = shot
    ? `<img src="${esc(shot)}" alt="">`
    : '<span class="ph">screenshot goes here</span>';

  if (kind === 'screenshot') {
    const layout = data.layout === 'bottom' ? 'layout-bottom' : data.layout === 'quiet' ? 'quiet' : '';
    return {
      HEADLINE_SIZE: String(fitSize(data.headline, HEADLINE_STEPS, 42)),
      THEME: themeDeclarations(data.theme),
      LAYOUT_CLASS: layout,
      BRAND: esc(data.brand || ''),
      HEADLINE: esc(data.headline || ''),
      SUBLINE_BLOCK: data.subline ? `<p class="subline">${esc(data.subline)}</p>` : '',
      SHOT_BLOCK: shotBlock,
    };
  }

  if (kind === 'header') {
    const markImage = data.markImage ? `<img src="${esc(relativeShot(outPath, data.markImage))}" alt="">` : '';
    return {
      THEME: themeDeclarations(data.theme),
      MARK_BLOCK: markImage || esc(data.mark || ''),
      NAME: esc(data.name || ''),
      TAGLINE_BLOCK: data.tagline ? `<div class="tagline">${esc(data.tagline)}</div>` : '',
      HAIRLINE_BLOCK: data.tagline ? '<div class="hairline"></div>' : '',
    };
  }

  if (kind === 'search') {
    return {
      HOOK_SIZE: String(fitSize(data.hook, HOOK_STEPS, 68)),
      THEME: themeDeclarations(data.theme),
      KICKER: esc(data.kicker || ''),
      HOOK: esc(data.hook || ''),
      SUBHOOK_BLOCK: data.subhook ? `<div class="subhook">${esc(data.subhook)}</div>` : '',
      SHOT_BLOCK: shotBlock,
    };
  }

  if (kind === 'event-card') {
    return {
      TITLE_SIZE: String(fitSize(data.title, CARD_TITLE_STEPS, 60)),
      THEME: themeDeclarations(data.theme),
      KICKER: esc(data.kicker || ''),
      TITLE: esc(data.title || ''),
      SUB_BLOCK: data.sub ? `<div class="sub">${esc(data.sub)}</div>` : '',
      SHOT_BLOCK: shotBlock,
    };
  }

  if (kind === 'event-detail') {
    return {
      TITLE_SIZE: String(fitSize(data.title, DETAIL_TITLE_STEPS, 54)),
      THEME: themeDeclarations(data.theme),
      KICKER: esc(data.kicker || ''),
      TITLE: esc(data.title || ''),
      SUB_BLOCK: data.sub ? `<div class="sub">${esc(data.sub)}</div>` : '',
      SHOT_BLOCK: shotBlock,
    };
  }

  if (kind === 'widgets') {
    const widgets = data.widgets || {};
    const widgetImg = (value, cls) => (value
      ? `<img class="${cls}" src="${esc(relativeShot(outPath, value))}" alt="">`
      : '');
    const rows = [
      widgetImg(widgets.medium, 'w'),
      (widgets.small || widgets.voice)
        ? `<div class="wrow">${widgetImg(widgets.small, 'half')}${widgetImg(widgets.voice, 'half')}</div>`
        : '',
      widgetImg(widgets.recent, 'w'),
    ].filter(Boolean);
    return {
      HEADLINE_SIZE: String(fitSize(data.headline, HEADLINE_STEPS, 42)),
      THEME: themeDeclarations(data.theme),
      BRAND: esc(data.brand || ''),
      HEADLINE: esc(data.headline || ''),
      SUBLINE_BLOCK: data.subline ? `<p class="subline">${esc(data.subline)}</p>` : '',
      WIDGETS_BLOCK: rows.join('\n    '),
    };
  }

  if (kind === 'watch') {
    const facesLayout = data.layout === 'faces';
    const duoLayout = data.layout === 'duo';
    const screen = data.screen ? relativeShot(outPath, data.screen) : '';
    const watchCase = (src, extraClass = '') => (src
      ? `<div class="watch ${extraClass}">
      <div class="screen"><img src="${esc(src)}" alt=""></div>
      <div class="crown"></div>
      <div class="sidebtn"></div>
    </div>`
      : '');
    let watchBlock = '';
    if (!facesLayout) {
      if (duoLayout) {
        const screens = Array.isArray(data.screens) ? data.screens : [];
        watchBlock = `<div class="watch-row">
      ${screens.slice(0, 2).map((value, index) => watchCase(relativeShot(outPath, value), index === 0 ? 'w1' : 'w2')).join('\n      ')}
    </div>`;
      } else {
        watchBlock = watchCase(screen);
      }
    }
    const faces = data.faces || {};
    const facesBlock = facesLayout
      ? ['circular', 'rectangular', 'corner']
        .map((key) => (faces[key] ? `<img src="${esc(relativeShot(outPath, faces[key]))}" alt="">` : ''))
        .filter(Boolean)
        .join('\n      ')
      : '';
    return {
      HEADLINE_SIZE: String(fitSize(data.headline, HEADLINE_STEPS, 42)),
      THEME: themeDeclarations(data.theme),
      LAYOUT_CLASS: facesLayout ? 'layout-faces' : duoLayout ? 'layout-duo' : 'layout-app',
      BRAND: esc(data.brand || ''),
      HEADLINE: esc(data.headline || ''),
      SUBLINE_BLOCK: data.subline ? `<p class="subline">${esc(data.subline)}</p>` : '',
      WATCH_BLOCK: watchBlock,
      FACES_BLOCK: facesBlock,
    };
  }

  return { THEME: themeDeclarations(data.theme) };
}

function applyTokens(template, tokens) {
  let html = template;
  for (const [key, value] of Object.entries(tokens)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  const leftover = html.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (leftover) fail(`unresolved template tokens: ${[...new Set(leftover)].join(', ')}`);
  return html;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(`compose.mjs — build a static App Store canvas

  --template <name|path>   screenshot | header | search | event-card | event-detail, or a path
  --out <path>             project-relative output HTML
  --data <json>            inline JSON
  --data-file <path>       JSON file
  --shot <path>            project-relative capture (overrides data.shot)
  --project <id>           defaults to OD_PROJECT_ID; used to write through the project API
  --local                  write to disk instead of the project API
  --daemon-url <url>       defaults to OD_DAEMON_URL / discovery
`);
    return;
  }
  if (!flags.out) fail('--out is required.');

  const templatePath = await resolveTemplate(flags.template);
  const kind = path.basename(templatePath, '.html');
  if (!['screenshot', 'header', 'search', 'event-card', 'event-detail', 'widgets', 'watch'].includes(kind)) {
    fail(`unknown canvas "${kind}". Expected screenshot, header, search, event-card, event-detail, widgets or watch.`);
  }

  let data = {};
  if (flags['data-file']) data = JSON.parse(await fs.readFile(path.resolve(String(flags['data-file'])), 'utf8'));
  else if (flags.data) data = JSON.parse(String(flags.data));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) fail('data must be a JSON object.');
  if (typeof flags.shot === 'string') data.shot = flags.shot;

  const outPath = path.resolve(String(flags.out));
  const outRel = toPosix(path.relative(process.cwd(), outPath));
  if (outRel.startsWith('..')) fail('--out must stay inside the project directory.');

  const template = await fs.readFile(templatePath, 'utf8');
  const html = applyTokens(template, tokensFor(kind, data, outPath));

  let via = 'file';
  let warning = null;
  if (!flags.local) {
    const projectId = typeof flags.project === 'string' ? flags.project : process.env.OD_PROJECT_ID;
    if (projectId) {
      try {
        const base = await resolveDaemonUrl(typeof flags['daemon-url'] === 'string' ? flags['daemon-url'] : undefined);
        await writeProjectFile({ base, projectId, name: outRel, content: html, encoding: 'utf8' });
        via = 'daemon';
      } catch (err) {
        warning = `daemon write failed (${err.message}); wrote locally instead. The renderer may not index this file.`;
      }
    } else {
      warning = 'OD_PROJECT_ID is not set; wrote locally. Run inside a project or pass --project for renderable HTML.';
    }
  }

  if (via === 'file') {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, html, 'utf8');
  }

  console.log(JSON.stringify({
    ok: true,
    out: outRel,
    template: toPosix(path.relative(process.cwd(), templatePath)),
    via,
    ...(warning ? { warning } : {}),
    shot: data.shot ? relativeShot(outPath, data.shot) : null,
  }, null, 2));
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
