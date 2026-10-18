// Zero-dependency image inspector for the formats App Store Connect accepts:
// PNG and JPEG. Returns exact pixels, alpha presence, color type and byte size.
//
// PNG alpha detection:
//   - color type 4 (grayscale+alpha) or 6 (RGBA) => alpha
//   - a tRNS chunk => transparent color key
// JPEG never carries alpha.

import fs from 'node:fs/promises';
import path from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function inspectImage(file) {
  const buf = await fs.readFile(file);
  const ext = path.extname(file).toLowerCase();
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return inspectPng(buf, file);
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return inspectJpeg(buf, file);
  return {
    file,
    format: ext.replace(/^\./, '') || 'unknown',
    width: null,
    height: null,
    hasAlpha: null,
    bytes: buf.length,
    valid: false,
    error: 'unsupported or unrecognized image format (expected PNG or JPEG)',
  };
}

function inspectPng(buf, file) {
  if (buf.length < 33) {
    return { file, format: 'png', width: null, height: null, hasAlpha: null, bytes: buf.length, valid: false, error: 'truncated PNG' };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  let hasAlpha = colorType === 4 || colorType === 6;
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'tRNS') { hasAlpha = true; break; }
    if (type === 'IDAT' || type === 'IEND') break;
    offset += 12 + length;
  }
  return {
    file,
    format: 'png',
    width,
    height,
    hasAlpha,
    bitDepth,
    colorType,
    colorTypeLabel: pngColorType(colorType),
    bytes: buf.length,
    valid: width > 0 && height > 0,
  };
}

function pngColorType(type) {
  return {
    0: 'grayscale',
    2: 'RGB',
    3: 'indexed',
    4: 'grayscale+alpha',
    6: 'RGBA',
  }[type] || `unknown(${type})`;
}

function inspectJpeg(buf, file) {
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xda) break; // start of scan; no more metadata
    const length = buf.readUInt16BE(offset + 2);
    const isSof = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && offset + 9 <= buf.length) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { file, format: 'jpeg', width, height, hasAlpha: false, bytes: buf.length, valid: width > 0 && height > 0 };
    }
    offset += 2 + length;
  }
  return { file, format: 'jpeg', width: null, height: null, hasAlpha: false, bytes: buf.length, valid: false, error: 'could not find a JPEG SOF segment' };
}

export function assertSpecMatch(info, spec) {
  const problems = [];
  if (!info.valid) problems.push(info.error || 'invalid image');
  if (info.width !== spec.width || info.height !== spec.height) {
    problems.push(`expected ${spec.width}x${spec.height}, got ${info.width}x${info.height}`);
  }
  if (spec.alphaAllowed === false && info.hasAlpha) problems.push('image has an alpha channel (not allowed)');
  const allowedFormats = spec.formats || ['.png', '.jpg', '.jpeg'];
  const ext = path.extname(info.file).toLowerCase();
  if (!allowedFormats.includes(ext)) problems.push(`format ${ext} not in ${allowedFormats.join(', ')}`);
  if (spec.maxBytes && info.bytes > spec.maxBytes) problems.push(`file is ${info.bytes} bytes, over ${spec.maxBytes}`);
  return problems;
}
