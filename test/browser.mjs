#!/usr/bin/env node
/**
 * browser.mjs — end-to-end smoke test in a real browser.
 *
 * Checks the things the headless sim harness structurally cannot:
 *   - the page boots with no console errors and no unhandled rejections
 *   - the canvas actually draws something (not a black rectangle)
 *   - the service worker installs and precaches
 *   - the game still loads and plays with the network hard-disabled,
 *     which is the Phase 0 acceptance criterion
 *   - panels open, and the resource strip is live
 *
 * Usage: node test/browser.mjs [--headed] [--shots]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 8137;
const BASE = `http://localhost:${PORT}/`;
const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = join(ROOT, '.shots');

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

// ---- dev server ------------------------------------------------------------
const server = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start')), 8000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('http://')) {
      clearTimeout(t);
      res();
    }
  });
  server.on('error', rej);
});

const browser = await chromium.launch({
  executablePath: EXEC,
  headless: !process.argv.includes('--headed'),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const context = await browser.newContext({ viewport: { width: 412, height: 892 } });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  // ---- 1. boot -------------------------------------------------------------
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 15000 });
  ok('boots and removes the boot screen');

  if (errors.length) fail(`console errors on boot:\n      ${errors.join('\n      ')}`);
  else ok('no console errors on boot');

  // ---- 2. state is live ----------------------------------------------------
  const snap = await page.evaluate(() => {
    const s = window.DEEPWATER.store.state;
    return {
      pop: s.citizenIds.length,
      rooms: Object.keys(s.silo.rooms).length,
      working: s.citizenIds.filter((i) => s.citizens[i].status === 'working').length,
      food: s.resources.food,
      seed: s.meta.seed,
    };
  });
  if (snap.pop !== 180) fail(`expected 180 residents, got ${snap.pop}`);
  if (snap.rooms !== 6) fail(`expected 6 starting rooms, got ${snap.rooms}`);
  if (snap.working < 10) fail(`expected the silo to be staffed, only ${snap.working} working`);
  ok(`state live: ${snap.pop} residents, ${snap.rooms} rooms, ${snap.working} posted`);

  // ---- 3. the canvas actually drew ----------------------------------------
  const drew = await page.evaluate(() => {
    const c = document.getElementById('silo-canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) {
      seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
      if (seen.size > 6) break;
    }
    return seen.size;
  });
  if (drew < 4) fail(`silo canvas looks blank (${drew} distinct colours sampled)`);
  else ok(`silo canvas is drawing (${drew}+ distinct colours)`);

  const gaugeDrew = await page.evaluate(() => {
    const c = document.getElementById('gauge-canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 13) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return seen.size;
  });
  if (gaugeDrew < 3) fail(`depth gauge looks blank (${gaugeDrew} colours)`);
  else ok(`depth gauge is drawing (${gaugeDrew} distinct colours)`);

  // ---- 4. time advances ----------------------------------------------------
  const t0 = await page.evaluate(() => window.DEEPWATER.store.state.clock.tick);
  await page.evaluate(() => window.DEEPWATER.game.runCycles(3));
  const t1 = await page.evaluate(() => window.DEEPWATER.store.state.clock.tick);
  if (t1 <= t0) fail(`clock did not advance (${t0} -> ${t1})`);
  else ok(`clock advances (tick ${t0} -> ${t1})`);

  // ---- 5. resource strip is live ------------------------------------------
  const strip = await page.evaluate(() => {
    const n = document.querySelector('.res[data-res="food"] .res-val');
    const d = document.querySelector('.res[data-res="food"] .res-delta');
    return { val: n?.textContent, delta: d?.textContent };
  });
  if (!strip.val || strip.val === '0') fail(`food counter reads "${strip.val}"`);
  else ok(`resource strip live: food ${strip.val} (${strip.delta}/cycle)`);

  // ---- 6. panels open ------------------------------------------------------
  await page.click('.nav-btn[data-panel="resources"]');
  await page.waitForSelector('#panel-host:not([hidden]) .panel-title', { timeout: 4000 });
  await page.click('.tabs .tab:nth-child(2)'); // power priority
  await page.waitForSelector('.priority-row', { timeout: 4000 });
  const rows = await page.locator('.priority-row').count();
  if (rows !== 6) fail(`power priority shows ${rows} rooms, expected 6`);
  else ok(`power priority list renders all ${rows} rooms`);
  if (SHOTS) {
    await mkdir(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SHOT_DIR, 'power-priority.png') });
  }

  await page.click('.panel-close');
  await page.click('.nav-btn[data-panel="log"]');
  await page.waitForSelector('.log-entry', { timeout: 4000 });
  ok('log panel renders entries');
  await page.click('.panel-close');

  // ---- 7. tapping a room opens the room panel -----------------------------
  const roomPoint = await page.evaluate(() => {
    const { renderer, store } = window.DEEPWATER;
    const room = Object.values(store.state.silo.rooms)[0];
    renderer.focusFloor(room.floor, true);
    renderer.render(16);
    const rect = renderer.canvas.getBoundingClientRect();
    // Convert the room's world position back to client coords.
    const SLOT_W = 64, FLOOR_H = 40, WORLD_W = 384;
    const wx = (room.slot + room.width / 2) * SLOT_W;
    const wy = (room.floor - 1) * FLOOR_H + FLOOR_H / 2;
    return {
      x: rect.left + rect.width / 2 + (wx - WORLD_W / 2) * renderer.scale,
      y: rect.top + (wy - renderer.camY) * renderer.scale,
      type: room.type,
    };
  });
  await page.mouse.click(roomPoint.x, roomPoint.y);
  await page.waitForSelector('.modal', { timeout: 4000 });
  const modalTitle = await page.locator('.modal .panel-title').textContent();
  ok(`tapping a room opens its panel ("${modalTitle}")`);
  if (SHOTS) await page.screenshot({ path: join(SHOT_DIR, 'room-panel.png') });
  await page.click('.modal-foot .btn');

  if (SHOTS) {
    await page.screenshot({ path: join(SHOT_DIR, 'silo-view.png') });
    console.log(`  screenshots → ${SHOT_DIR}`);
  }

  // ---- 8. service worker installs -----------------------------------------
  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return 'none';
    await navigator.serviceWorker.ready;
    return reg.active ? 'active' : reg.installing ? 'installing' : 'waiting';
  });
  if (swState !== 'active') fail(`service worker is "${swState}", expected active`);
  else ok('service worker installed and active');

  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    if (!keys.length) return 0;
    const c = await caches.open(keys[0]);
    return (await c.keys()).length;
  });
  if (cached < 20) fail(`only ${cached} entries precached — offline boot will fail`);
  else ok(`${cached} entries precached`);

  // ---- 9. THE Phase 0 criterion: loads and plays fully offline -------------
  await context.setOffline(true);
  const offlinePage = await context.newPage();
  const offlineErrors = [];
  offlinePage.on('pageerror', (e) => offlineErrors.push(e.message));
  await offlinePage.goto(BASE, { waitUntil: 'load' });
  await offlinePage.waitForSelector('#app:not([hidden])', { timeout: 15000 });
  await offlinePage.waitForFunction(() => !!window.DEEPWATER, { timeout: 15000 });

  const offlineSnap = await offlinePage.evaluate(() => {
    const { store, game } = window.DEEPWATER;
    game.runCycles(5);
    const s = store.state;
    return { pop: s.citizenIds.length, cycle: s.clock.cycle, rooms: Object.keys(s.silo.rooms).length };
  });
  if (offlineSnap.pop !== 180 || offlineSnap.cycle < 5) {
    fail(`offline boot degraded: ${JSON.stringify(offlineSnap)}`);
  } else {
    ok(`loads and plays with the network disabled (${offlineSnap.cycle} cycles run offline)`);
  }
  if (offlineErrors.length) fail(`errors on offline boot: ${offlineErrors.join(', ')}`);
  if (SHOTS) await offlinePage.screenshot({ path: join(SHOT_DIR, 'offline.png') });
  await context.setOffline(false);

  // ---- 10. manifest is installable ----------------------------------------
  const manifest = await page.evaluate(async () => {
    const res = await fetch('./manifest.webmanifest');
    return res.json();
  });
  const need = ['name', 'short_name', 'start_url', 'display', 'icons'];
  const missing = need.filter((k) => !manifest[k]);
  if (missing.length) fail(`manifest missing: ${missing.join(', ')}`);
  else if (!manifest.icons.some((i) => i.sizes === '512x512')) fail('manifest has no 512px icon');
  else ok('manifest is complete and installable');

  if (errors.length) {
    console.log('\n  console errors seen:');
    for (const e of [...new Set(errors)].slice(0, 10)) console.log('    ' + e);
  }
} finally {
  await browser.close();
  server.kill();
}

console.log('');
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
console.log('  PASS — browser smoke test\n');
