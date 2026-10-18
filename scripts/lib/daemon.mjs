// Daemon discovery + HTTP helpers for App Store Assets.
//
// Resolution order for the OpenDesign daemon URL:
//   1. explicit --daemon-url
//   2. OD_DAEMON_URL (injected into every OpenDesign agent run)
//   3. `$OD_NODE_BIN $OD_BIN daemon status --json` (packaged sidecar discovery)
//   4. ~/.config/opencode/open-design.json (legacy/dev config)
//   5. http://127.0.0.1:7456
//
// The exact-size PNG export only exists in the desktop runtime: the packaged
// daemon proxies to the Electron renderer. A headless daemon answers 501.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function trimUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

export async function resolveDaemonUrl(explicit) {
  if (explicit) return trimUrl(explicit);
  const envUrl = process.env.OD_DAEMON_URL;
  if (envUrl) return trimUrl(envUrl);

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
      const parsed = JSON.parse(out);
      const port = Number(parsed?.port);
      if (Number.isFinite(port) && port > 0) return `http://127.0.0.1:${port}`;
    } catch {
      // fall through
    }
  }

  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.config', 'opencode', 'open-design.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const candidate = typeof parsed?.daemonUrl === 'string' ? trimUrl(parsed.daemonUrl) : '';
    if (candidate) {
      // The config file can point at a stale dev daemon. Only trust it when the
      // port actually answers; otherwise fall through to the default.
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const res = await fetch(`${candidate}/api/version`, { signal: controller.signal }).finally(() => clearTimeout(timer));
        if (res.ok) return candidate;
      } catch {
        // stale config — ignore
      }
    }
  } catch {
    // fall through
  }

  return 'http://127.0.0.1:7456';
}

export async function api(base, route, options = {}) {
  const { method = 'GET', body, headers = {}, timeout = 30000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let res;
    try {
      res = await fetch(`${trimUrl(base)}${route}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        `Could not reach the OpenDesign daemon at ${trimUrl(base)} (${err?.message || err}). ` +
        'Set OD_DAEMON_URL or pass --daemon-url; in a packaged app the port is dynamic.',
      );
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function asJson(res, label) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${label || 'daemon'} returned ${res.status}: ${text.slice(0, 600)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label || 'daemon'} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

export async function fetchJson(base, route, label) {
  return asJson(await api(base, route), label);
}

export async function resolveProjectId(explicit) {
  const id = explicit || process.env.OD_PROJECT_ID;
  if (!id) {
    throw new Error(
      'project id required. Pass --project <id> or run inside an OpenDesign project (OD_PROJECT_ID).',
    );
  }
  return id;
}

export async function writeProjectFile({ base, projectId, name, content, encoding = 'utf8' }) {
  const res = await api(base, `/api/projects/${encodeURIComponent(projectId)}/files`, {
    method: 'POST',
    body: { name, content, encoding },
    timeout: 60000,
  });
  return asJson(res, 'project file write');
}

export async function exportImage({ base, projectId, fileName, cssWidth, cssHeight, imageFormat = 'png', timeout = 180000 }) {
  const res = await api(base, `/api/projects/${encodeURIComponent(projectId)}/export/image`, {
    method: 'POST',
    body: {
      fileName,
      width: cssWidth,
      height: cssHeight,
      imageFormat,
    },
    timeout,
  });
  if (!res.ok) {
    const text = await res.text();
    let hint = '';
    if (res.status === 501) {
      hint = ' The exact-size exporter is only available in the OpenDesign desktop runtime; start the app (not a headless daemon) and retry.';
    }
    throw new Error(`export/image returned ${res.status}: ${text.slice(0, 500)}${hint}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('export/image returned an empty body');
  return { bytes, contentType: res.headers.get('content-type') || '' };
}

// Tiny CLI parser: --key=value, --key value, --flag, and positionals.
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positionals };
}

export function fail(message, code = 1) {
  console.error(`\n✗ ${message}\n`);
  process.exit(code);
}
