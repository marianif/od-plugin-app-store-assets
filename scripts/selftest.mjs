#!/usr/bin/env node
// Self-test for the plugin's own gates. Runs with plain `node` (Node 20+), no deps.
//
//   node scripts/selftest.mjs
//
// It synthesizes real PNG fixtures (1×1 RGB and 1×1 RGBA), then asserts that the
// image inspector and the spec matcher behave:
//   1. a valid PNG passes a matching spec
//   2. bytes that disagree with the extension are rejected (PNG named .jpg)
//   3. an alpha channel is rejected when the spec forbids it
//   4. wrong dimensions are rejected
//   5. a spec that does not accept the content format is rejected

import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectImage, assertSpecMatch } from './lib/image.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function makePng(width, height, { alpha }) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                 // bit depth
  ihdr[9] = alpha ? 6 : 2;     // color type: RGBA | RGB
  const stride = 1 + width * (alpha ? 4 : 3);
  const raw = Buffer.alloc(height * stride); // filter byte 0 per row, black pixels
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG_SPEC = { width: 1, height: 1, formats: ['.png'], alphaAllowed: false };

const checks = [
  ['valid PNG passes its spec', async (dir) => {
    const file = path.join(dir, 'tiny.png');
    const info = await inspectImage(file);
    const problems = assertSpecMatch(info, PNG_SPEC);
    if (info.format !== 'png' || info.width !== 1 || info.height !== 1 || info.hasAlpha) {
      throw new Error(`unexpected inspection: ${JSON.stringify(info)}`);
    }
    if (problems.length) throw new Error(`expected no problems, got: ${problems.join('; ')}`);
  }],

  ['PNG bytes named .jpg are rejected', async (dir) => {
    const file = path.join(dir, 'mislabeled.jpg');
    const info = await inspectImage(file);
    const problems = assertSpecMatch(info, { width: 1, height: 1, formats: ['.jpg', '.jpeg'], alphaAllowed: false });
    if (!problems.some((p) => /content is PNG but the extension is \.jpg/i.test(p))) {
      throw new Error(`expected a content/extension mismatch, got: ${problems.join('; ') || 'none'}`);
    }
  }],

  ['alpha channel is rejected when the spec forbids it', async (dir) => {
    const file = path.join(dir, 'alpha.png');
    const info = await inspectImage(file);
    if (!info.hasAlpha) throw new Error('fixture should carry an alpha channel');
    const problems = assertSpecMatch(info, PNG_SPEC);
    if (!problems.some((p) => /alpha channel/i.test(p))) {
      throw new Error(`expected an alpha finding, got: ${problems.join('; ') || 'none'}`);
    }
  }],

  ['wrong dimensions are rejected', async (dir) => {
    const file = path.join(dir, 'tiny.png');
    const info = await inspectImage(file);
    const problems = assertSpecMatch(info, { width: 2, height: 2, formats: ['.png'], alphaAllowed: false });
    if (!problems.some((p) => /expected 2x2, got 1x1/.test(p))) {
      throw new Error(`expected a dimension finding, got: ${problems.join('; ') || 'none'}`);
    }
  }],

  ['content format the spec does not accept is rejected', async (dir) => {
    const file = path.join(dir, 'tiny.png');
    const info = await inspectImage(file);
    const problems = assertSpecMatch(info, { width: 1, height: 1, formats: ['.mov'], alphaAllowed: false });
    if (!problems.some((p) => /format \.mov not in|content format/i.test(p))) {
      throw new Error(`expected a format finding, got: ${problems.join('; ') || 'none'}`);
    }
  }],
];

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'od-app-store-selftest-'));
  try {
    await fs.writeFile(path.join(dir, 'tiny.png'), makePng(1, 1, { alpha: false }));
    await fs.writeFile(path.join(dir, 'mislabeled.jpg'), makePng(1, 1, { alpha: false }));
    await fs.writeFile(path.join(dir, 'alpha.png'), makePng(1, 1, { alpha: true }));

    let failed = 0;
    for (const [name, run] of checks) {
      try {
        await run(dir);
        console.log(`✓ ${name}`);
      } catch (err) {
        failed += 1;
        console.error(`✗ ${name}: ${err?.message || err}`);
      }
    }
    console.log(failed ? `\n${failed} of ${checks.length} checks failed` : `\nall ${checks.length} checks passed`);
    process.exit(failed ? 1 : 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(`selftest crashed: ${err?.stack || err}`);
  process.exit(1);
});
