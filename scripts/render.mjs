#!/usr/bin/env node
// Render a composed canvas to PNG at Apple's exact pixel size.
//
//   node .app-store-assets/scripts/render.mjs \
//     --html store/en-US/iphone-1320x2868/01.html \
//     --out store/en-US/iphone-1320x2868/01.png \
//     --spec iphone-1320x2868
//
// The desktop renderer takes CSS points and exports at deviceScaleFactor 2,
// so --spec resolves cssWidth/cssHeight (e.g. 660×1434 → 1320×2868).
// A headless daemon returns 501; run the OpenDesign desktop app.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, resolveDaemonUrl, resolveProjectId, exportImage, fail } from './lib/daemon.mjs';
import { loadSnapshot, getSpec, cssSize } from './lib/specs.mjs';
import { inspectImage } from './lib/image.mjs';

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(`render.mjs — export a project canvas to PNG

  --html <project-relative path>   e.g. store/en-US/iphone-1320x2868/01.html
  --out <path>                     local output, e.g. store/en-US/iphone-1320x2868/01.png
  --spec <key>                     refdata snapshot key (recommended)
  --width <css px> --height <css px>  explicit override (not output pixels)
  --project <id>                   defaults to OD_PROJECT_ID
  --daemon-url <url>               defaults to OD_DAEMON_URL / sidecar discovery
  --refdata <file>                 snapshot path
  --image-format png|jpeg          default png
`);
    return;
  }
  if (!flags.html) fail('--html is required.');
  if (!flags.out) fail('--out is required.');
  if (path.isAbsolute(String(flags.html))) {
    fail('--html must be project-relative (the daemon resolves files from the project root).');
  }

  const projectId = await resolveProjectId(typeof flags.project === 'string' ? flags.project : undefined);
  const daemonUrl = await resolveDaemonUrl(typeof flags['daemon-url'] === 'string' ? flags['daemon-url'] : undefined);
  const imageFormat = String(flags['image-format'] || 'png');
  if (!['png', 'jpeg'].includes(imageFormat)) fail('--image-format must be png or jpeg.');

  let spec = null;
  if (flags.spec) {
    const snapshot = await loadSnapshot(typeof flags.refdata === 'string' ? flags.refdata : undefined);
    spec = getSpec(snapshot.data, String(flags.spec));
  }
  const width = Number(flags.width || (spec ? cssSize(spec).cssWidth : NaN));
  const height = Number(flags.height || (spec ? cssSize(spec).cssHeight : NaN));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    fail('provide --spec or both --width and --height (CSS points).');
  }

  const { bytes } = await exportImage({
    base: daemonUrl,
    projectId,
    fileName: String(flags.html),
    cssWidth: width,
    cssHeight: height,
    imageFormat,
  });

  const outPath = path.resolve(String(flags.out));
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, bytes);

  const info = await inspectImage(outPath);
  const result = {
    ok: true,
    out: path.relative(process.cwd(), outPath),
    requestedCss: { width, height },
    output: { width: info.width, height: info.height, hasAlpha: info.hasAlpha, format: info.format, bytes: info.bytes },
  };

  if (spec) {
    const expected = { width: spec.width, height: spec.height };
    if (info.width !== expected.width || info.height !== expected.height) {
      fail(
        `renderer produced ${info.width}×${info.height}, expected ${expected.width}×${expected.height}. ` +
        `Check the canvas export size and the desktop renderer scale.`,
      );
    }
    if (spec.alphaAllowed === false && info.hasAlpha) {
      fail('rendered PNG has an alpha channel; App Store assets must be opaque. Use opaque backgrounds and retry.');
    }
    result.spec = String(flags.spec);
    result.expected = expected;
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
