#!/usr/bin/env node
/**
 * gen-icons.mjs — generate the PWA icons.
 *
 * The icon is the Depth Gauge: a column of floor bars, lit at the top where
 * the silo is dug and dark below where it isn't. Same idea as the in-game
 * rail, so the launcher icon and the app read as the same object.
 *
 * Written as raw PNG (zlib + CRC) so there's no image dependency to install.
 */

import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, 'assets');

const P = {
  deep: [0x23, 0x27, 0x29],
  deeper: [0x1a, 0x1d, 0x1f],
  concrete: [0x3a, 0x40, 0x42],
  sodium: [0xe8, 0xa3, 0x3d],
  bone: [0xd9, 0xd2, 0xc4],
};

function render(size, { maskable = false } = {}) {
  const px = new Uint8Array(size * size * 3);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
  };
  const rect = (x, y, w, h, c) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c);
  };

  rect(0, 0, size, size, P.deeper);

  // Maskable icons need their content inside the safe zone (the inner 80%).
  const inset = maskable ? Math.round(size * 0.18) : Math.round(size * 0.1);
  const innerW = size - inset * 2;
  const innerH = size - inset * 2;

  rect(inset, inset, innerW, innerH, P.deep);

  // 24 floor bars. The top 14 are dug — the same 14 the game starts with.
  const bars = 24;
  const dug = 14;
  const gap = Math.max(1, Math.round(innerH / bars / 5));
  const barH = Math.max(1, Math.floor(innerH / bars) - gap);
  const barX = inset + Math.round(innerW * 0.16);
  const barW = Math.round(innerW * 0.68);

  for (let b = 0; b < bars; b++) {
    const y = inset + Math.round((b * innerH) / bars);
    if (b < dug) {
      // Lit floors, with the built portion brighter and varying by row so
      // the icon reads as a building rather than a barcode.
      const fill = [0.55, 0.85, 0.35, 1.0, 0.7, 0.45, 0.9, 0.6, 0.8, 0.4, 0.75, 0.5, 0.95, 0.3][b];
      rect(barX, y, barW, barH, P.concrete);
      rect(barX, y, Math.round(barW * fill), barH, P.sodium);
    } else {
      rect(barX, y, barW, barH, [0x2c, 0x31, 0x33]);
    }
  }

  // The sodium viewport bracket, the thing that makes it recognisably ours.
  const bt = inset + Math.round((3 * innerH) / bars) - 1;
  const bb = inset + Math.round((8 * innerH) / bars) + 1;
  const bx0 = barX - Math.max(2, Math.round(size * 0.035));
  const bx1 = barX + barW + Math.max(2, Math.round(size * 0.035));
  const t = Math.max(1, Math.round(size / 64));
  rect(bx0, bt, bx1 - bx0, t, P.bone);
  rect(bx0, bb, bx1 - bx0, t, P.bone);
  rect(bx0, bt, t, bb - bt, P.bone);
  rect(bx1 - t, bt, t, bb - bt + t, P.bone);

  return px;
}

// ---- minimal PNG encoder ---------------------------------------------------

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // Each scanline is prefixed with a filter byte (0 = none).
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, y * size * 3, size * 3).copy(raw, y * (size * 3 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(OUT, { recursive: true });
const jobs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
];
for (const [name, size, opts] of jobs) {
  await writeFile(join(OUT, name), encodePNG(size, render(size, opts)));
  console.log(`gen-icons: ${name} (${size}×${size})`);
}
