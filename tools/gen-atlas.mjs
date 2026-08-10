#!/usr/bin/env node
/**
 * gen-atlas.mjs — build the sprite atlas.
 *
 * The atlas is generated from code rather than drawn in an editor, for three
 * reasons that all still hold: it stays on-palette by construction because the
 * palette is imported rather than eyeballed, it is diffable and regenerable,
 * and the repository keeps no binary blob nobody can review.
 *
 * The art itself lives in tools/art/: lib.mjs is the drawing library, and
 * rooms/citizens/scenery are the compositions. This file is only the packer
 * and the PNG encoder — if a sprite looks wrong, it is wrong in tools/art/.
 *
 * Output: assets/atlas.png plus assets/atlas.json (the frame table).
 * Run:    node tools/gen-atlas.mjs
 * Look:   node tools/contact-sheet.mjs --filter=room_ --zoom=5
 */

import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atlas, hash, PAL } from './art/lib.mjs';
import {
  ROOM_FIXTURES, ROOM_CUTAWAYS, FIXTURE_SIZE, CUTAWAY_SIZE,
} from './art/rooms.mjs';
import {
  drawCitizen, drawPortrait, ACTIONS, ROLES, CONSUMER_ACTIONS, CONSUMER_ROLES,
  W as CIT_W, H as CIT_H, PORTRAIT as PORTRAIT_SIZE,
} from './art/citizens.mjs';
import {
  drawSkyline, drawWallTile, drawRockTile, drawShaftTile,
  THREATS, THREAT_SIZES, PROPS, PROP_SIZE, TILE, SKYLINE_W, SKYLINE_H,
} from './art/scenery.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, 'assets');

/**
 * 2048 is the spec's ceiling. The cutaways alone are 28 × 128×88, so 1024
 * overflows once the citizen roles are added. The encoder trims to the used
 * height, so an oversized sheet costs nothing in the shipped file.
 */
const SIZE = 2048;

const sheet = atlas(SIZE);

// ------------------------------------------------------------------ rooms ---

// Cross-section fixtures: machinery in silhouette against transparency, drawn
// one per bay at ~60×33 on screen. Authored at 64×36 so the renderer is very
// nearly 1:1 instead of stretching a 32×32 to double width, which is what made
// every room look smeared.
for (const [id, draw] of Object.entries(ROOM_FIXTURES)) {
  draw(sheet.sprite(`room_${id}`, FIXTURE_SIZE.w, FIXTURE_SIZE.h), hash(`fixture:${id}`));
}

// Detail cutaways for the room panel: a full opaque interior with walls,
// floor, ceiling light and contents. This is where the reference style lives.
for (const [id, draw] of Object.entries(ROOM_CUTAWAYS)) {
  draw(sheet.sprite(`cutaway_${id}`, CUTAWAY_SIZE.w, CUTAWAY_SIZE.h), hash(`cutaway:${id}`));
}

// --------------------------------------------------------------- citizens ---

// Every role in every action. The renderer only asks for a subset today, but
// the panels ask for more and the cost of a 12×16 sprite is negligible.
for (const role of ROLES) {
  for (const [action, count] of Object.entries(ACTIONS)) {
    for (let i = 0; i < count; i++) {
      drawCitizen(sheet.sprite(`citizen_${role}_${action}${i}`, CIT_W, CIT_H), {
        frame: i, action, role, seed: hash(`${role}:${action}:${i}`), facing: 1,
      });
    }
  }
  drawPortrait(sheet.sprite(`portrait_${role}`, PORTRAIT_SIZE, PORTRAIT_SIZE), {
    role, seed: hash(`portrait:${role}`), age: 30, gender: 'f',
  });
}

/**
 * Back-compatible aliases.
 *
 * The renderer asks for `citizen_<palette>_walk0..3` and `_work0..1`, where
 * palette is one of worker/idle/hurt/irradiated/child — names that describe a
 * condition, not a job. Rather than rewrite every call site and risk the
 * renderer silently falling back to its 2px placeholder bar, the atlas simply
 * publishes those names as extra entries pointing at the same packed pixels.
 * An alias costs one line in the JSON and no image data at all.
 */
for (const [consumerRole, artRole] of Object.entries(CONSUMER_ROLES)) {
  for (const [action, count] of Object.entries(CONSUMER_ACTIONS)) {
    for (let i = 0; i < count; i++) {
      const src = `citizen_${artRole}_${action}${i % ACTIONS[action]}`;
      const alias = `citizen_${consumerRole}_${action}${i}`;
      if (sheet.frames[src] && !sheet.frames[alias]) sheet.frames[alias] = sheet.frames[src];
    }
  }
}

// --------------------------------------------------------------- scenery ---

drawSkyline(sheet.sprite('skyline', SKYLINE_W, SKYLINE_H), hash('skyline'));
drawWallTile(sheet.sprite('tile_wall', TILE, TILE), hash('tile:wall'));
drawRockTile(sheet.sprite('tile_rock', TILE, TILE), hash('tile:rock'));
drawShaftTile(sheet.sprite('tile_shaft', TILE, TILE), hash('tile:shaft'));

for (const [name, draw] of Object.entries(THREATS)) {
  const s = THREAT_SIZES[name] || 16;
  draw(sheet.sprite(`threat_${name}`, s, s), hash(`threat:${name}`));
}
for (const [name, draw] of Object.entries(PROPS)) {
  draw(sheet.sprite(`prop_${name}`, PROP_SIZE, PROP_SIZE), hash(`prop:${name}`));
}

// ------------------------------------------------------------ bitmap font ---

/**
 * Floor numbers, drawn on the depth gauge. 3×5, because at the size the gauge
 * renders them anything larger is illegible and anything smaller is a smudge.
 */
const DIGITS = [
  0b111_101_101_101_111, 0b010_110_010_010_111, 0b111_001_111_100_111,
  0b111_001_111_001_111, 0b101_101_111_001_001, 0b111_100_111_001_111,
  0b111_100_111_101_111, 0b111_001_001_001_001, 0b111_101_111_101_111,
  0b111_101_111_001_111,
];
DIGITS.forEach((bits, n) => {
  const p = sheet.sprite(`digit_${n}`, 3, 5);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (bits & (1 << (14 - (y * 3 + x)))) p.set(x, y, PAL.bone);
    }
  }
});

// ----------------------------------------------------------------- encode ---

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
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

// Trim to the used height so the file isn't mostly empty rows.
const usedHeight = sheet.usedHeight;
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(usedHeight, 4);
ihdr[8] = 8;
ihdr[9] = 6; // RGBA

const raw = Buffer.alloc(usedHeight * (SIZE * 4 + 1));
for (let y = 0; y < usedHeight; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(sheet.px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'atlas.png'), png);
await writeFile(
  join(OUT, 'atlas.json'),
  JSON.stringify({ width: SIZE, height: usedHeight, tile: TILE, frames: sheet.frames }, null, 1)
);

const kinds = {};
for (const n of Object.keys(sheet.frames)) {
  const k = n.split('_')[0];
  kinds[k] = (kinds[k] || 0) + 1;
}
console.log(
  `gen-atlas: ${Object.keys(sheet.frames).length} frames ` +
    `(${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')}), ` +
    `${SIZE}x${usedHeight}, ${(png.length / 1024).toFixed(1)} KB`
);
