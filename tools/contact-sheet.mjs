#!/usr/bin/env node
/**
 * contact-sheet.mjs — render the atlas as a labelled, upscaled grid.
 *
 * Art that nobody looks at is art nobody can judge. The atlas is a 1024px
 * sheet of 12- and 32-pixel sprites packed shoulder to shoulder; opening it
 * directly tells you almost nothing, and the game draws each sprite for a few
 * milliseconds at a size where a mistake and a choice look identical.
 *
 * This lays every frame out on a dark grid at an integer zoom with its name
 * under it, which is the only way to see that two rooms are indistinguishable,
 * that a walk cycle pops between frames, or that something is drawn one pixel
 * off its baseline.
 *
 * Uses the Chromium that Playwright already provides — same reasoning as
 * tools/import-art.mjs: a canvas decodes and re-encodes PNG, and running the
 * pixel path in the engine that will draw the result means the colours cannot
 * disagree.
 *
 * Usage:
 *   node tools/contact-sheet.mjs                 # everything, 4x
 *   node tools/contact-sheet.mjs --zoom=8        # bigger
 *   node tools/contact-sheet.mjs --filter=room_  # only frames matching
 *   node tools/contact-sheet.mjs --out=.shots/rooms.png
 */

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const ZOOM = Number(args.zoom ?? 4);
const FILTER = args.filter ? String(args.filter) : null;
const OUT = join(ROOT, String(args.out ?? '.shots/atlas-contact-sheet.png'));

const atlasPng = await readFile(join(ROOT, 'assets/atlas.png'));
const atlasJson = JSON.parse(await readFile(join(ROOT, 'assets/atlas.json'), 'utf8'));
const frames = atlasJson.frames || atlasJson;

const names = Object.keys(frames)
  .filter((n) => !FILTER || n.includes(FILTER))
  .sort();

if (!names.length) {
  console.error(`no frames matched ${FILTER ? `"${FILTER}"` : ''}`);
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.goto('about:blank');

const dataUrl = `data:image/png;base64,${atlasPng.toString('base64')}`;

const out = await page.evaluate(
  async ({ src, frames, names, zoom }) => {
    const img = new Image();
    img.src = src;
    await img.decode();

    // Cell is the widest and tallest frame, so nothing overlaps its label.
    const maxW = Math.max(...names.map((n) => frames[n].w));
    const maxH = Math.max(...names.map((n) => frames[n].h));
    const LABEL = 14;
    const PAD = 8;
    const cellW = maxW * zoom + PAD * 2;
    const cellH = maxH * zoom + PAD + LABEL;

    // Keep the sheet roughly 3:2 so it is readable when displayed inline.
    const cols = Math.max(1, Math.min(names.length, Math.ceil(Math.sqrt(names.length * 1.6))));
    const rows = Math.ceil(names.length / cols);

    const c = document.createElement('canvas');
    c.width = cols * cellW;
    c.height = rows * cellH + 26;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;

    x.fillStyle = '#15181a';
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#e8a33d';
    x.font = '600 15px monospace';
    x.fillText(`${names.length} frames @ ${zoom}x`, 8, 18);

    names.forEach((name, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = col * cellW;
      const cy = row * cellH + 26;
      const f = frames[name];

      // Checkerboard so transparency is visible rather than guessed at.
      for (let j = 0; j < Math.ceil((maxH * zoom) / 8); j++) {
        for (let k = 0; k < Math.ceil((maxW * zoom) / 8); k++) {
          x.fillStyle = (j + k) % 2 ? '#22262a' : '#1b1f22';
          x.fillRect(cx + PAD + k * 8, cy + PAD + j * 8, 8, 8);
        }
      }

      x.drawImage(
        img, f.x, f.y, f.w, f.h,
        cx + PAD, cy + PAD, f.w * zoom, f.h * zoom
      );

      x.fillStyle = '#5a6163';
      x.strokeStyle = '#3a4042';
      x.strokeRect(cx + PAD - 0.5, cy + PAD - 0.5, f.w * zoom + 1, f.h * zoom + 1);

      x.fillStyle = '#d9d2c4';
      x.font = '10px monospace';
      const label = name.length > Math.floor(cellW / 6) ? name.slice(0, Math.floor(cellW / 6) - 1) + '…' : name;
      x.fillText(label, cx + PAD, cy + PAD + maxH * zoom + 11);
      x.fillStyle = '#5a6163';
      x.fillText(`${f.w}x${f.h}`, cx + cellW - PAD - 34, cy + PAD + maxH * zoom + 11);
    });

    return c.toDataURL('image/png');
  },
  { src: dataUrl, frames, names, zoom: ZOOM }
);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, Buffer.from(out.split(',')[1], 'base64'));
await browser.close();

console.log(`  ${names.length} frames -> ${OUT.replace(ROOT + '/', '')}  (${ZOOM}x)`);
