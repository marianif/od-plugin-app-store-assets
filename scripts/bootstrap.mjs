#!/usr/bin/env node
// Bootstrap the plugin's runtime files into the active project.
//
// Self-contained on purpose: inside an OpenDesign run this file is downloaded
// alone, so it must not import from ./lib.
//
// Inside a project:
//   curl -fsSL "$OD_DAEMON_URL/api/plugins/app-store-assets/asset/scripts/bootstrap.mjs" \
//     -o .app-store-assets/bootstrap.mjs
//   node .app-store-assets/bootstrap.mjs
//
// From the plugin repo:
//   node scripts/bootstrap.mjs --out .app-store-assets

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'app-store-assets';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const RUNTIME_FILES = [
  'scripts/lib/daemon.mjs',
  'scripts/lib/image.mjs',
  'scripts/lib/specs.mjs',
  'scripts/lib/plan.mjs',
  'scripts/lib/asc.mjs',
  'scripts/compose.mjs',
  'scripts/render.mjs',
  'scripts/validate.mjs',
  'scripts/refdata.mjs',
  'scripts/asc-upload.mjs',
  'assets/canvases/screenshot.html',
  'assets/canvases/header.html',
  'assets/canvases/search.html',
  'assets/canvases/event-card.html',
  'assets/canvases/event-detail.html',
  'assets/canvases/widgets.html',
  'assets/canvases/watch.html',
  'assets/tokens.example.css',
  'references/apple-asset-rules.md',
  'references/asc-asset-library.md',
  'references/copy-guidelines.md',
  'references/refdata-snapshot.json',
];

function parseArgv(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[arg.slice(2)] = next; i += 1; }
    else flags[arg.slice(2)] = true;
  }
  return flags;
}

function fail(message, code = 1) {
  console.error(`\n✗ ${message}\n`);
  process.exit(code);
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function trimUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

async function resolveDaemonUrl(explicit) {
  if (explicit) return trimUrl(explicit);
  if (process.env.OD_DAEMON_URL) return trimUrl(process.env.OD_DAEMON_URL);
  const nodeBin = process.env.OD_NODE_BIN;
  const odBin = process.env.OD_BIN;
  if (nodeBin && odBin) {
    try {
      const out = execFileSync(nodeBin, [odBin, 'daemon', 'status', '--json'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const port = Number(JSON.parse(out)?.port);
      if (Number.isFinite(port) && port > 0) return `http://127.0.0.1:${port}`;
    } catch {
      // fall through
    }
  }
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.config', 'opencode', 'open-design.json'), 'utf8');
    const candidate = trimUrl(JSON.parse(raw)?.daemonUrl || '');
    if (candidate) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const res = await fetch(`${candidate}/api/version`, { signal: controller.signal }).finally(() => clearTimeout(timer));
        if (res.ok) return candidate;
      } catch {
        // stale config
      }
    }
  } catch {
    // fall through
  }
  return 'http://127.0.0.1:7456';
}

async function main() {
  const flags = parseArgv(process.argv.slice(2));
  const outDir = path.resolve(String(flags.out || '.app-store-assets'));
  const explicitSource = typeof flags.source === 'string' ? path.resolve(flags.source) : null;

  // A local checkout is any folder that has the manifest next to assets/.
  const candidates = [explicitSource, path.resolve(HERE, '..'), process.cwd()].filter(Boolean);
  let localCheckout = null;
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, 'open-design.json')) && await exists(path.join(candidate, 'assets', 'canvases', 'screenshot.html'))) {
      localCheckout = candidate;
      break;
    }
  }

  const daemonUrl = await resolveDaemonUrl(typeof flags['daemon-url'] === 'string' ? flags['daemon-url'] : undefined);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) fail(`Node 20+ required (found ${process.versions.node}).`);

  await fs.mkdir(outDir, { recursive: true });
  const written = [];

  if (localCheckout) {
    for (const rel of RUNTIME_FILES) {
      const src = path.join(localCheckout, rel);
      const dest = path.join(outDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      written.push(rel);
    }
  } else {
    const base = `${daemonUrl}/api/plugins/${encodeURIComponent(PLUGIN_ID)}/asset`;
    for (const rel of RUNTIME_FILES) {
      const res = await fetch(`${base}/${rel}`);
      if (!res.ok) {
        fail(
          `could not fetch ${rel} from ${base} (HTTP ${res.status}).\n` +
          'Is the plugin installed and the OpenDesign app running?\n' +
          'For a local checkout run: node scripts/bootstrap.mjs --source <plugin folder>',
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const dest = path.join(outDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buf);
      written.push(rel);
    }
  }

  const manifest = {
    plugin: PLUGIN_ID,
    version: '0.1.0',
    bootstrappedAt: new Date().toISOString(),
    daemonUrl,
    source: localCheckout ? 'local' : 'daemon',
    files: written,
  };
  await fs.writeFile(path.join(outDir, 'bootstrap.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir,
    files: written.length,
    source: manifest.source,
    next: [
      `node ${path.relative(process.cwd(), path.join(outDir, 'scripts/compose.mjs'))} --help`,
      `node ${path.relative(process.cwd(), path.join(outDir, 'scripts/validate.mjs'))} --plan asset-plan.json`,
    ],
  }, null, 2));
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
