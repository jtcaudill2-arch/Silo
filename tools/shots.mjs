#!/usr/bin/env node
/**
 * shots.mjs — photograph the running game.
 *
 * Companion to contact-sheet.mjs. That one shows the sprites; this one shows
 * what a player actually meets: the silo in cross-section, a room opened, a
 * resident's card, the surface. Art can be individually correct and still fail
 * in composition — a room fixture that reads beautifully at 5x on a
 * checkerboard can be mud when it is drawn 40 pixels tall next to five others.
 *
 * Drives a real browser against the real dev server, so what it captures is
 * what ships.
 *
 * Usage:
 *   node tools/shots.mjs                # write .shots/*.png
 *   node tools/shots.mjs --sheet        # ...and a single labelled contact sheet
 */

import { chromium } from 'playwright';
import { browserPath } from './chromium.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, '.shots');
const EXEC = browserPath();
const PORT = 8794;
const SHEET = process.argv.includes('--sheet');

await mkdir(OUT, { recursive: true });

const server = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start')), 8000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('http://')) { clearTimeout(t); res(); }
  });
  server.on('error', rej);
});

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({
  viewport: { width: 412, height: 892 },
  deviceScaleFactor: 2,
});

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const shots = [];
const shot = async (name, note) => {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push({ name, note, file });
  console.log(`  ${name.padEnd(22)} ${note}`);
};

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 25000 });

// The handover opens first on a new silo.
await page.waitForSelector('.report.briefing', { timeout: 8000 }).catch(() => {});
if (await page.$('.report.briefing')) {
  await shot('01-handover', 'the previous mayor’s note');
  for (let i = 0; i < 10 && (await page.$('.report.briefing')); i++) {
    await page.click('.report-foot .btn.primary').catch(() => {});
  }
  await page.waitForSelector('.report.briefing', { state: 'detached' }).catch(() => {});
}

// ...and the guided session opens behind it, which is a card over the chrome
// and the whole screen dimmed 56%. Every shot below it was being taken through
// step one of the tutorial, so nothing here showed what the game looks like.
// The guide has no reason to be in a photograph of the game; skip it.
await page.waitForSelector('.tut-skip', { timeout: 4000 }).catch(() => {});
if (await page.$('.tut-skip')) {
  await page.click('.tut-skip').catch(() => {});
  await page.waitForSelector('.tut-card', { state: 'detached', timeout: 4000 }).catch(() => {});
}

await page.waitForTimeout(700);
await shot('02-silo', 'the cross-section on day one');

// Give it a silo worth photographing: stock, rooms, crew, a squad.
await page.evaluate(async () => {
  const { store, game, shell } = window.DEEPWATER;
  const { build } = await import('./src/sim/build.js');
  const { autoAssign } = await import('./src/sim/jobs.js');
  store.dispatch({ type: 'RESOURCE_DELTA', deltas: { scrap: 9000, parts: 1200, alloy: 400, chits: 900 } });
  for (const id of ['antibiotics', 'radio_range_1', 'env_suit_1', 'deep_excavation_1', 'alloy_refining']) {
    store.dispatch({ type: 'RESEARCH_COMPLETE', id });
  }
  const want = ['recycling', 'workshop', 'laboratory', 'hydroponics', 'clinic', 'chem_lab',
    'radio_room', 'airlock', 'suit_bay', 'armory', 'foundry', 'cafeteria', 'residences',
    'air_filtration', 'water_reclaimer', 'storage_depot', 'maintenance_bay', 'schoolhouse'];
  for (const type of want) {
    outer: for (const f of store.state.silo.floors) {
      if (!f.excavated) continue;
      for (let s = 0; s < 6; s++) {
        const acts = build(store.state, f.n, s, type);
        if (acts.length) { store.dispatchAll(acts); break outer; }
      }
    }
  }
  game.runDays(4);
  store.dispatchAll(autoAssign(store.state));
  store.dispatch({ type: 'SQUAD_CREATE', name: 'Bell' });
  game.runDays(2);
  shell.renderChrome();
});
await page.waitForTimeout(900);
await shot('03-silo-built', 'a silo with eighteen rooms running');

// Each panel that is open at this point.
for (const [panel, note] of [
  ['build', 'construction'],
  ['population', 'the roster'],
  ['research', 'the tech tree'],
  ['military', 'squads and gear'],
  ['airlock', 'the surface'],
  ['radio', 'the other nineteen'],
  ['log', 'the log'],
]) {
  const btn = await page.$(`.nav-btn[data-panel="${panel}"]`);
  if (!btn || (await btn.isDisabled()) || (await btn.isHidden())) continue;
  await btn.click().catch(() => {});
  await page.waitForTimeout(500);
  await shot(`04-panel-${panel}`, note);
  await page.click('.panel-close').catch(() => {});
  await page.waitForTimeout(200);
}

// A room, opened.
await page.evaluate(async () => {
  const { store, shell } = window.DEEPWATER;
  const { openRoom } = await import('./src/ui/roomView.js');
  const room = Object.values(store.state.silo.rooms).find((r) => r.type === 'water_reclaimer')
    || Object.values(store.state.silo.rooms)[0];
  openRoom(store, room.id, shell);
});
await page.waitForTimeout(600);
await shot('05-room', 'a room in detail');
await page.keyboard.press('Escape');

// A resident.
await page.click('.nav-btn[data-panel="population"]').catch(() => {});
await page.waitForSelector('.roster-row', { timeout: 5000 }).catch(() => {});
await page.click('.roster-row').catch(() => {});
await page.waitForTimeout(600);
await shot('06-citizen', 'a resident');

await browser.close();
server.kill();

console.log('');
console.log(errors.length ? `  ${errors.length} console error(s):` : '  no console errors');
for (const e of [...new Set(errors)].slice(0, 6)) console.log('    ' + e);

// Optional: one sheet, so every screen can be judged side by side in one look.
if (SHEET) {
  const b2 = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const p2 = await b2.newPage();
  await p2.goto('about:blank');
  const imgs = [];
  for (const s of shots) {
    imgs.push({ name: s.name, note: s.note, url: `data:image/png;base64,${(await readFile(s.file)).toString('base64')}` });
  }
  const sheet = await p2.evaluate(async (list) => {
    const loaded = [];
    for (const it of list) {
      const im = new Image(); im.src = it.url; await im.decode();
      loaded.push({ ...it, im });
    }
    const TH = 420;
    const scaled = loaded.map((l) => ({ ...l, w: Math.round((l.im.width / l.im.height) * TH), h: TH }));
    const PAD = 10, LABEL = 20;
    const cols = Math.min(4, scaled.length);
    const rows = Math.ceil(scaled.length / cols);
    const colW = Math.max(...scaled.map((s) => s.w)) + PAD * 2;
    const c = document.createElement('canvas');
    c.width = cols * colW;
    c.height = rows * (TH + PAD + LABEL) + 8;
    const x = c.getContext('2d');
    x.fillStyle = '#15181a'; x.fillRect(0, 0, c.width, c.height);
    scaled.forEach((s, i) => {
      const cx = (i % cols) * colW + PAD;
      const cy = Math.floor(i / cols) * (TH + PAD + LABEL) + PAD;
      x.drawImage(s.im, cx, cy, s.w, s.h);
      x.strokeStyle = '#3a4042'; x.strokeRect(cx - 0.5, cy - 0.5, s.w + 1, s.h + 1);
      x.fillStyle = '#e8a33d'; x.font = '600 12px monospace';
      x.fillText(s.name, cx, cy + TH + 13);
      x.fillStyle = '#5a6163';
      x.fillText(s.note, cx + 96, cy + TH + 13);
    });
    return c.toDataURL('image/png');
  }, imgs);
  await writeFile(join(OUT, 'sheet.png'), Buffer.from(sheet.split(',')[1], 'base64'));
  await b2.close();
  console.log('\n  contact sheet -> .shots/sheet.png');
}
