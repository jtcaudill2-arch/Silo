#!/usr/bin/env node
/**
 * gen-atlas.mjs — generate the sprite atlas.
 *
 * The atlas is generated from code rather than hand-drawn in an editor, for
 * three reasons: it stays on-palette by construction (the palette is imported,
 * not eyeballed), it is diffable and regenerable, and it keeps the repository
 * free of a binary blob nobody can review.
 *
 * Output: assets/atlas.png plus assets/atlas.json (the frame table).
 * Run: node tools/gen-atlas.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, 'assets');

const SIZE = 1024; // 2048 is the spec's ceiling; we don't need it, and this halves the download
const TILE = 32;

// ---- palette, from the spec. Nothing off-palette may appear below. ---------
const P = {
  deep: [0x23, 0x27, 0x29],
  deeper: [0x1a, 0x1d, 0x1f],
  concrete: [0x3a, 0x40, 0x42],
  lit: [0x5a, 0x61, 0x63],
  sodium: [0xe8, 0xa3, 0x3d],
  verdigris: [0x4e, 0x8c, 0x7a],
  rust: [0xa3, 0x4b, 0x2a],
  toxin: [0x8f, 0xb3, 0x3a],
  bone: [0xd9, 0xd2, 0xc4],
  none: null, // transparent
};

const px = new Uint8Array(SIZE * SIZE * 4); // RGBA, starts fully transparent
const frames = {};
let cursorX = 0;
let cursorY = 0;
let rowHeight = 0;

function alloc(w, h) {
  if (cursorX + w > SIZE) {
    cursorX = 0;
    cursorY += rowHeight + 1;
    rowHeight = 0;
  }
  const at = { x: cursorX, y: cursorY, w, h };
  cursorX += w + 1;
  rowHeight = Math.max(rowHeight, h);
  return at;
}

function set(x, y, c, a = 255) {
  if (!c || x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
  px[i + 3] = a;
}

function rect(at, x, y, w, h, c, a = 255) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(at.x + x + i, at.y + y + j, c, a);
}

/** Deterministic per-sprite noise, so regenerating gives byte-identical output. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rnd(seed, n) {
  const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------- fixtures ---

/**
 * Room fixtures, 32x32, drawn as a silhouette of machinery against
 * transparency so the renderer can tint the interior behind them.
 */
const FIXTURES = {
  generator_hall: (at, s) => {
    rect(at, 2, 14, 28, 16, P.concrete);
    for (let i = 0; i < 3; i++) {
      const x = 4 + i * 9;
      rect(at, x, 8, 7, 22, P.lit);
      rect(at, x + 1, 10, 5, 4, P.sodium); // inspection window, lit
      rect(at, x + 2, 16, 3, 10, P.deeper);
    }
    rect(at, 0, 30, 32, 2, P.deeper);
    for (let i = 0; i < 6; i++) rect(at, 2 + i * 5, 5, 2, 3, P.concrete); // exhaust
  },
  reactor: (at, s) => {
    rect(at, 1, 10, 30, 20, P.concrete);
    rect(at, 6, 4, 20, 26, P.lit);
    rect(at, 10, 8, 12, 16, P.deeper);
    rect(at, 12, 10, 8, 12, P.toxin); // the one place the green belongs
    rect(at, 11, 9, 10, 1, P.sodium);
    rect(at, 0, 30, 32, 2, P.deeper);
  },
  water_reclaimer: (at, s) => {
    rect(at, 2, 12, 28, 18, P.concrete);
    for (let i = 0; i < 2; i++) {
      rect(at, 4 + i * 13, 6, 11, 24, P.lit);
      rect(at, 6 + i * 13, 9, 7, 18, P.verdigris);
      rect(at, 6 + i * 13, 9, 7, 3, P.deeper); // waterline
    }
    for (let i = 0; i < 4; i++) rect(at, 3 + i * 8, 3, 2, 4, P.concrete);
    rect(at, 0, 30, 32, 2, P.deeper);
  },
  hydroponics: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    for (let row = 0; row < 3; row++) {
      const y = 8 + row * 8;
      rect(at, 2, y, 28, 2, P.concrete); // rack shelf
      rect(at, 2, y - 1, 28, 1, P.sodium, 140); // grow lamp
      for (let i = 0; i < 9; i++) {
        const h = 2 + Math.floor(rnd(s, row * 9 + i) * 4);
        rect(at, 3 + i * 3, y - h, 2, h, P.verdigris);
      }
    }
  },
  protein_vats: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    for (let i = 0; i < 3; i++) {
      rect(at, 2 + i * 10, 8, 8, 22, P.lit);
      rect(at, 3 + i * 10, 11, 6, 17, P.verdigris, 190);
      rect(at, 3 + i * 10, 11, 6, 2, P.bone, 120);
    }
  },
  air_filtration: (at, s) => {
    rect(at, 1, 6, 30, 24, P.concrete);
    for (let i = 0; i < 4; i++) {
      rect(at, 3 + i * 7, 9, 5, 18, P.lit);
      for (let j = 0; j < 6; j++) rect(at, 3 + i * 7, 10 + j * 3, 5, 1, P.deeper);
    }
    rect(at, 0, 3, 32, 3, P.lit);
    rect(at, 0, 30, 32, 2, P.deeper);
  },
  residences: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    for (let i = 0; i < 4; i++) {
      const x = 1 + i * 8;
      rect(at, x, 12, 7, 18, P.concrete);
      rect(at, x + 1, 14, 5, 5, P.sodium, 90); // a lit doorway
      rect(at, x + 1, 21, 5, 7, P.deeper);
      rect(at, x + 1, 22, 5, 2, P.bone, 60); // a bunk
    }
    rect(at, 0, 10, 32, 2, P.lit);
  },
  cafeteria: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    for (let i = 0; i < 3; i++) {
      rect(at, 2 + i * 10, 20, 8, 2, P.lit); // table
      rect(at, 3 + i * 10, 22, 1, 6, P.concrete);
      rect(at, 8 + i * 10, 22, 1, 6, P.concrete);
    }
    rect(at, 2, 8, 28, 6, P.concrete); // servery
    rect(at, 4, 10, 24, 2, P.sodium, 150);
  },
  clinic: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    for (let i = 0; i < 2; i++) {
      rect(at, 3 + i * 15, 18, 12, 3, P.bone, 170); // bed
      rect(at, 3 + i * 15, 21, 12, 5, P.concrete);
    }
    rect(at, 12, 5, 8, 8, P.bone, 60);
    rect(at, 15, 6, 2, 6, P.verdigris);
    rect(at, 13, 8, 6, 2, P.verdigris);
  },
  workshop: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 1, 20, 30, 4, P.lit); // bench
    for (let i = 0; i < 8; i++) {
      const h = 3 + Math.floor(rnd(s, i) * 8);
      rect(at, 2 + i * 4, 20 - h, 3, h, P.concrete);
    }
    rect(at, 2, 6, 28, 1, P.sodium, 130);
    for (let i = 0; i < 5; i++) rect(at, 4 + i * 6, 7, 1, 3, P.sodium, 80);
  },
  recycling: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 2, 16, 28, 14, P.concrete);
    for (let i = 0; i < 14; i++) {
      const x = 3 + Math.floor(rnd(s, i) * 26);
      const y = 8 + Math.floor(rnd(s, i + 40) * 8);
      rect(at, x, y, 2 + Math.floor(rnd(s, i + 80) * 3), 2, i % 3 ? P.lit : P.rust);
    }
    rect(at, 2, 15, 28, 1, P.lit);
  },
  foundry: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 4, 10, 24, 20, P.concrete);
    rect(at, 9, 14, 14, 14, P.deeper);
    rect(at, 11, 18, 10, 9, P.rust);
    rect(at, 12, 20, 8, 6, P.sodium);
    for (let i = 0; i < 3; i++) rect(at, 6 + i * 8, 4, 3, 6, P.lit);
  },
  munitions: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 1, 22, 30, 8, P.concrete);
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 10; i++) rect(at, 2 + i * 3, 8 + r * 5, 2, 4, P.lit);
    }
  },
  armory: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 1, 6, 30, 24, P.concrete);
    for (let i = 0; i < 6; i++) {
      rect(at, 3 + i * 5, 9, 1, 14, P.lit);
      rect(at, 2 + i * 5, 9, 3, 2, P.rust);
    }
    rect(at, 1, 24, 30, 3, P.lit);
  },
  barracks: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    for (let i = 0; i < 4; i++) {
      rect(at, 1 + i * 8, 14, 6, 3, P.lit);
      rect(at, 1 + i * 8, 22, 6, 3, P.lit);
      rect(at, 1 + i * 8, 14, 1, 14, P.concrete);
    }
  },
  training_yard: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    for (let i = 0; i < 3; i++) {
      rect(at, 5 + i * 9, 12, 4, 16, P.concrete); // target frames
      rect(at, 6 + i * 9, 15, 2, 2, P.rust);
    }
    rect(at, 0, 28, 32, 1, P.lit);
  },
  sheriffs_office: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 4, 18, 24, 5, P.lit); // desk
    rect(at, 6, 23, 2, 6, P.concrete);
    rect(at, 24, 23, 2, 6, P.concrete);
    rect(at, 12, 6, 8, 9, P.concrete);
    rect(at, 14, 8, 4, 5, P.sodium, 160);
  },
  holding_cells: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 1, 6, 30, 24, P.deeper);
    for (let i = 0; i < 11; i++) rect(at, 2 + i * 3, 6, 1, 24, P.lit);
    rect(at, 1, 6, 30, 1, P.concrete);
    rect(at, 1, 29, 30, 1, P.concrete);
  },
  laboratory: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 1, 20, 30, 4, P.lit);
    for (let i = 0; i < 7; i++) {
      const h = 3 + Math.floor(rnd(s, i) * 5);
      rect(at, 3 + i * 4, 20 - h, 2, h, P.verdigris, 200);
      rect(at, 3 + i * 4, 20 - h, 2, 1, P.bone, 150);
    }
    rect(at, 2, 6, 28, 2, P.concrete);
  },
  archive: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    for (let r = 0; r < 4; r++) {
      rect(at, 2, 8 + r * 6, 28, 1, P.lit);
      for (let i = 0; i < 13; i++) {
        rect(at, 3 + i * 2, 9 + r * 6, 1, 4, i % 3 ? P.concrete : P.bone, 180);
      }
    }
  },
  schoolhouse: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 3, 6, 26, 9, P.deeper);
    rect(at, 4, 7, 24, 7, P.concrete);
    for (let i = 0; i < 6; i++) rect(at, 6 + i * 3, 9, 2, 1, P.bone, 140);
    for (let i = 0; i < 4; i++) rect(at, 3 + i * 7, 22, 5, 2, P.lit);
  },
  radio_room: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 4, 14, 24, 16, P.concrete);
    rect(at, 7, 17, 18, 8, P.deeper);
    for (let i = 0; i < 5; i++) rect(at, 9 + i * 3, 19, 2, 4, P.sodium, 120 + i * 25);
    rect(at, 15, 2, 2, 12, P.lit); // mast
    rect(at, 11, 4, 10, 1, P.lit);
    rect(at, 13, 7, 6, 1, P.lit);
  },
  airlock: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 1, 4, 30, 26, P.concrete);
    rect(at, 6, 8, 20, 22, P.deeper);
    rect(at, 8, 10, 16, 18, P.lit);
    rect(at, 14, 16, 4, 4, P.sodium); // the wheel
    rect(at, 12, 18, 8, 1, P.concrete);
    rect(at, 15, 14, 1, 8, P.concrete);
    for (let i = 0; i < 4; i++) rect(at, 3, 8 + i * 6, 2, 3, P.rust);
  },
  suit_bay: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    for (let i = 0; i < 4; i++) {
      const x = 2 + i * 8;
      rect(at, x, 10, 6, 20, P.concrete);
      rect(at, x + 1, 12, 4, 7, P.lit); // torso
      rect(at, x + 2, 13, 2, 3, P.sodium, 150); // visor
      rect(at, x + 1, 20, 4, 8, P.lit);
    }
  },
  storage_depot: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 5; i++) {
        rect(at, 2 + i * 6, 8 + r * 8, 5, 6, i % 2 ? P.concrete : P.lit);
        rect(at, 2 + i * 6, 8 + r * 8, 5, 1, P.deeper);
      }
    }
  },
  deep_mine: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 0, 0, 32, 30, P.deeper);
    // A ragged bore rather than a built room.
    for (let y = 0; y < 30; y++) {
      const w = 10 + Math.floor(rnd(s, y) * 10);
      rect(at, 16 - Math.floor(w / 2), y, w, 1, P.concrete);
    }
    rect(at, 13, 6, 6, 10, P.rust);
    rect(at, 14, 16, 4, 12, P.lit);
    for (let i = 0; i < 5; i++) rect(at, 4 + i * 6, 26, 2, 2, P.sodium, 110);
  },
  maintenance_bay: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 2, 18, 28, 3, P.lit);
    for (let i = 0; i < 6; i++) rect(at, 3 + i * 5, 8, 3, 10, P.concrete);
    for (let i = 0; i < 6; i++) rect(at, 4 + i * 5, 21, 1, 7, P.concrete);
    rect(at, 2, 6, 28, 1, P.sodium, 120);
  },
  chem_lab: (at, s) => {
    rect(at, 0, 30, 32, 2, P.deeper);
    rect(at, 1, 21, 30, 3, P.lit);
    for (let i = 0; i < 6; i++) {
      rect(at, 3 + i * 5, 12, 3, 9, P.concrete);
      rect(at, 3 + i * 5, 15, 3, 5, i % 2 ? P.verdigris : P.sodium, 190);
    }
  },
};

// ------------------------------------------------------------- citizens ---

/**
 * A 4-frame walk cycle at 8x10, plus a 2-frame work loop. Kept tiny: at the
 * scale the silo is drawn, a citizen is a few pixels tall and the read comes
 * from motion, not detail.
 */
function citizenFrames(name, body, accent) {
  for (let f = 0; f < 4; f++) {
    const at = alloc(8, 10);
    frames[`citizen_${name}_walk${f}`] = at;
    // head
    rect(at, 3, 0, 2, 2, body);
    // torso
    rect(at, 2, 2, 4, 4, body);
    rect(at, 2, 2, 4, 1, accent);
    // legs: the cycle is a two-position shuffle with a mid-stride pair
    const stride = [0, 1, 0, -1][f];
    rect(at, 2 + Math.max(0, stride), 6, 1, 4, body);
    rect(at, 5 + Math.min(0, stride), 6, 1, 4, body);
    // arms
    rect(at, 1, 3, 1, 3, body);
    rect(at, 6, 3, 1, 3, body);
  }
  for (let f = 0; f < 2; f++) {
    const at = alloc(8, 10);
    frames[`citizen_${name}_work${f}`] = at;
    rect(at, 3, f, 2, 2, body);
    rect(at, 2, 2 + f, 4, 4, body);
    rect(at, 2, 2 + f, 4, 1, accent);
    rect(at, 2, 6, 1, 4, body);
    rect(at, 5, 6, 1, 4, body);
    rect(at, 1, 3 + f * 2, 2, 2, body); // the working arm moves
    rect(at, 6, 3, 1, 3, body);
  }
}

// ------------------------------------------------------------ bitmap font ---

/**
 * A 4x6 numeric font baked into the atlas, for floor numbers drawn on the
 * canvas. Rendering UI text to canvas is a trap (spec §3.1) — this is for
 * in-world signage only.
 */
const DIGITS = [
  ['111', '101', '101', '101', '111'],
  ['010', '110', '010', '010', '111'],
  ['111', '001', '111', '100', '111'],
  ['111', '001', '111', '001', '111'],
  ['101', '101', '111', '001', '001'],
  ['111', '100', '111', '001', '111'],
  ['111', '100', '111', '101', '111'],
  ['111', '001', '001', '001', '001'],
  ['111', '101', '111', '101', '111'],
  ['111', '101', '111', '001', '111'],
];

function bakeFont() {
  DIGITS.forEach((rows, d) => {
    const at = alloc(3, 5);
    frames[`digit_${d}`] = at;
    rows.forEach((row, y) => {
      [...row].forEach((c, x) => {
        if (c === '1') set(at.x + x, at.y + y, P.bone);
      });
    });
  });
}

// -------------------------------------------------------------------- run ---

// Fixtures.
for (const [id, draw] of Object.entries(FIXTURES)) {
  const at = alloc(TILE, TILE);
  frames[`room_${id}`] = at;
  draw(at, hash(id));
}

// Citizens: four palettes standing in for role and condition.
citizenFrames('worker', P.bone, P.sodium);
citizenFrames('idle', P.lit, P.lit);
citizenFrames('hurt', P.rust, P.rust);
citizenFrames('irradiated', P.toxin, P.toxin);
citizenFrames('child', P.bone, P.verdigris);

bakeFont();

// ---- encode ----------------------------------------------------------------

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
const usedHeight = Math.min(SIZE, cursorY + rowHeight + 1);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(usedHeight, 4);
ihdr[8] = 8;
ihdr[9] = 6; // RGBA

const raw = Buffer.alloc(usedHeight * (SIZE * 4 + 1));
for (let y = 0; y < usedHeight; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
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
  JSON.stringify({ width: SIZE, height: usedHeight, tile: TILE, frames }, null, 1)
);

console.log(
  `gen-atlas: ${Object.keys(frames).length} frames, ` +
    `${SIZE}x${usedHeight}, ${(png.length / 1024).toFixed(1)} KB`
);
