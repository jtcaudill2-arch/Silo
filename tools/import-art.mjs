#!/usr/bin/env node
/**
 * import-art.mjs — turn commissioned source images into game assets.
 *
 * The generated art arrives as 2K JPEGs and tall PNGs on non-square canvases.
 * The game needs small, tightly-cropped, nearest-neighbour-downscaled sprites
 * with honest alpha. This does that conversion, and it is a tool rather than a
 * one-off because there will be a second batch.
 *
 * What it handles, all of which the delivery manifest flagged:
 *   - magenta plates that are "visibly mottled" rather than flat #FF00FF, so
 *     keying is a distance test in RGB with a tolerance, not an equality test
 *   - source images cropped to arbitrary bounds, so every sprite is trimmed to
 *     its own content before scaling and the result is centred on its canvas
 *   - strips whose frame count is known from the manifest but whose frame
 *     boundaries are not, so slicing is by count across the content bounds
 *   - PNGs that already carry alpha, which skip keying entirely
 *
 * No image-processing dependency. Chromium is already present for the browser
 * test, and a canvas in a page decodes JPEG and PNG, resamples with
 * `imageSmoothingEnabled = false`, and re-encodes to PNG — which is the whole
 * job. Running the pipeline in the same engine that will draw the result also
 * means the colours cannot disagree.
 *
 * Usage:
 *   node tools/import-art.mjs             # convert everything in art-src/
 *   node tools/import-art.mjs --report    # say what's present and missing
 *
 * Input:  art-src/<asset_id>.(png|jpg)
 * Output: assets/art/<asset_id>.png  +  assets/art/index.json
 */

import { chromium } from 'playwright';
import { browserPath } from './chromium.mjs';
import { readdir, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'art-src');
const OUT = join(ROOT, 'assets', 'art');
const EXEC = browserPath();

const args = new Set(process.argv.slice(2));

/**
 * Target canvas per asset family. Sized for where the art is actually shown,
 * not for the source resolution — see data/artwork.js for why the silo
 * cross-section is not on this list.
 */
const TARGETS = [
  { match: /^room_/, w: 384, h: 264, key: false, note: 'room detail panel' },
  { match: /^citizen_(?!walk|idle|working|sleeping|injured)/, w: 96, h: 96, key: false, note: 'citizen card' },
  { match: /^threat_/, w: 96, h: 96, key: false, note: 'encounter report' },
  { match: /^env_wasteland_skyline/, w: 512, h: 256, key: false, note: 'surface backdrop' },
  { match: /^env_/, w: 64, h: 64, key: false, note: 'texture tile' },
  // Strips: per-frame target, sliced by the manifest's frame count.
  { match: /^citizen_walk/, w: 64, h: 64, key: true, frames: 6, note: 'walk cycle' },
  { match: /^citizen_idle/, w: 64, h: 64, key: true, frames: 4, note: 'idle' },
  { match: /^citizen_working/, w: 64, h: 64, key: true, frames: 4, note: 'working' },
  { match: /^citizen_sleeping/, w: 64, h: 64, key: true, frames: 2, note: 'sleeping' },
  { match: /^citizen_injured/, w: 64, h: 64, key: true, frames: 4, note: 'injured' },
];

function targetFor(id) {
  return TARGETS.find((t) => t.match.test(id)) || null;
}

// ---------------------------------------------------------------- report ---

async function report() {
  const { ROOM_ART, CITIZEN_ART, THREAT_ART, SCENERY, CITIZEN_STRIPS, missingRoomArt } =
    await import('../src/data/artwork.js');

  const wanted = new Set();
  for (const v of Object.values(ROOM_ART)) if (v) wanted.add('room_' + v);
  for (const v of Object.values(CITIZEN_ART)) wanted.add(v);
  for (const v of Object.values(THREAT_ART)) wanted.add(v);
  for (const v of Object.values(SCENERY)) wanted.add(v);
  for (const v of Object.values(CITIZEN_STRIPS)) wanted.add(v.id);

  const present = new Set();
  if (existsSync(SRC)) {
    for (const f of await readdir(SRC)) {
      if (/\.(png|jpe?g)$/i.test(f)) present.add(basename(f, extname(f)));
    }
  }

  console.log('');
  console.log('  Deepwater — art coverage');
  console.log('  ' + '─'.repeat(60));
  console.log(`  source dir: art-src/  (${present.size} file${present.size === 1 ? '' : 's'})`);
  console.log('');

  const missingFiles = [...wanted].filter((id) => !present.has(id)).sort();
  const extra = [...present].filter((id) => !wanted.has(id)).sort();

  if (missingFiles.length) {
    console.log(`  ${missingFiles.length} expected file${missingFiles.length === 1 ? '' : 's'} not in art-src/:`);
    for (const id of missingFiles) console.log(`    ${id}`);
  } else {
    console.log('  every mapped asset has a source file.');
  }
  if (extra.length) {
    console.log('');
    console.log(`  ${extra.length} file(s) present but not mapped in data/artwork.js:`);
    for (const id of extra) console.log(`    ${id}`);
  }

  const gaps = missingRoomArt();
  console.log('');
  console.log(`  ${gaps.length} of 28 rooms have no art in this batch and keep the procedural tile:`);
  console.log('    ' + gaps.join(', '));
  console.log('');
}

// --------------------------------------------------------------- convert ---

/**
 * The conversion, run inside the page. Kept as one function so the whole
 * pixel path — decode, key, trim, resample, encode — happens in one context.
 */
const CONVERT = `async (opts) => {
  const { dataUrl, w, h, key, frames } = opts;
  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const src = document.createElement('canvas');
  src.width = img.naturalWidth;
  src.height = img.naturalHeight;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const data = sctx.getImageData(0, 0, src.width, src.height);
  const px = data.data;

  // Key the plate. The delivered strips are "visibly mottled" magenta rather
  // than flat #FF00FF, so this is a distance test with a generous tolerance,
  // and it only fires on pixels that are genuinely magenta-dominant — a red
  // armband or a pink cheek has a green channel and survives.
  if (key) {
    const TOL = 90;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const magenta = r > 150 && b > 120 && g < 110 && (r - g) > TOL && (b - g) > 40;
      if (magenta) px[i + 3] = 0;
    }
    sctx.putImageData(data, 0, 0);
  }

  // Trim to content, so a sprite is centred on its own bounds rather than on
  // whatever margin the generator happened to leave.
  const bounds = (x0, x1) => {
    let minX = x1, minY = src.height, maxX = x0 - 1, maxY = -1;
    for (let y = 0; y < src.height; y++) {
      for (let x = x0; x < x1; x++) {
        if (px[(y * src.width + x) * 4 + 3] > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  };

  const cells = [];
  const n = frames || 1;
  const cellW = src.width / n;
  for (let i = 0; i < n; i++) {
    const b = bounds(Math.floor(i * cellW), Math.floor((i + 1) * cellW)) ||
      { x: Math.floor(i * cellW), y: 0, w: Math.floor(cellW), h: src.height };
    cells.push(b);
  }

  // Scale every frame of a strip by the same factor, or a walk cycle bobs.
  const tallest = Math.max(...cells.map((c) => c.h));
  const widest = Math.max(...cells.map((c) => c.w));
  const scale = Math.min(w / widest, h / tallest);

  const out = [];
  for (const b of cells) {
    const dst = document.createElement('canvas');
    dst.width = w;
    dst.height = h;
    const dctx = dst.getContext('2d');
    dctx.imageSmoothingEnabled = false;
    const dw = Math.max(1, Math.round(b.w * scale));
    const dh = Math.max(1, Math.round(b.h * scale));
    // Bottom-centred: figures share a floor line, rooms sit on their own.
    dctx.drawImage(src, b.x, b.y, b.w, b.h, Math.round((w - dw) / 2), h - dh, dw, dh);
    out.push(dst.toDataURL('image/png'));
  }
  return { frames: out, source: { w: src.width, h: src.height }, scale };
}`;

async function convert() {
  if (!existsSync(SRC)) {
    console.error(`\n  No art-src/ directory. Put the source images there first.\n`);
    console.error(`  This session cannot download them: the environment's network policy`);
    console.error(`  denies static.seeles.ai. Fetch them where you can reach it, then run`);
    console.error(`  this with the files in place.\n`);
    process.exit(1);
  }
  const files = (await readdir(SRC)).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (!files.length) {
    console.error('\n  art-src/ has no .png or .jpg files.\n');
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXEC,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const index = {};
  let converted = 0;
  let skipped = 0;

  for (const file of files.sort()) {
    const id = basename(file, extname(file));
    const target = targetFor(id);
    if (!target) {
      console.log(`  skip  ${id.padEnd(38)} no target size — add one to TARGETS`);
      skipped++;
      continue;
    }

    const buf = await readFile(join(SRC, file));
    const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

    const result = await page.evaluate(
      new Function('opts', `return (${CONVERT})(opts)`),
      { dataUrl, w: target.w, h: target.h, key: target.key, frames: target.frames || 1 }
    );

    const names = [];
    for (let i = 0; i < result.frames.length; i++) {
      const name = result.frames.length === 1 ? `${id}.png` : `${id}_${i}.png`;
      const b64 = result.frames[i].split(',')[1];
      await writeFile(join(OUT, name), Buffer.from(b64, 'base64'));
      names.push(name);
    }
    index[id] = { w: target.w, h: target.h, frames: names, note: target.note };
    console.log(
      `  ok    ${id.padEnd(38)} ${result.source.w}×${result.source.h} → ` +
        `${target.w}×${target.h}${names.length > 1 ? ` ×${names.length}` : ''}  (${target.note})`
    );
    converted++;
  }

  await writeFile(join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  await browser.close();

  console.log('');
  console.log(`  ${converted} converted, ${skipped} skipped → assets/art/`);
  console.log('  Run `node tools/gen-precache.mjs` so they are available offline.');
  console.log('');
}

if (args.has('--report')) await report();
else await convert();
