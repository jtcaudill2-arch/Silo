#!/usr/bin/env node
/**
 * playthrough.mjs — play the game by doing what it says, and print what it said.
 *
 * `shots.mjs` photographs the game; this one plays it. Every round it takes the
 * standing order, carries it out, lets four days pass, and records the order it
 * is given next — so what comes out is the sequence of sentences a player
 * actually meets, in order, with the day, the population and what was done
 * about each one.
 *
 * That is a different question from the one the suite asks. `obedient.mjs`
 * proves an obedient player survives, by calling the sim directly; this goes
 * through the real browser, the real DOM and the real buttons, and its output
 * is meant to be *read* rather than asserted on. Three defects came out of the
 * first run and none of them were things a test would have thought to ask:
 *
 *   - "Research Rack Density" arrived seven times in 120 days and was never
 *     carried out, because the order named a node and its button said "Open".
 *   - Its reason was the alloy paragraph, in a silo whose floors were sound —
 *     `gate === alloyGate` with both of them null.
 *   - After 120 days of doing exactly what it said: 78 people, no research.
 *
 * Building goes through the sim rather than the placement gesture, which
 * `mobile.mjs` already covers end to end; everything else is a real tap.
 *
 * Usage: node tools/playthrough.mjs [rounds]      (default 30, four days each)
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { browserPath } from './chromium.mjs';

import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHOTS = join(ROOT, '.shots');
const PORT = 8207;
const ROUNDS = Number(process.argv[2] || 30);
await mkdir(SHOTS, { recursive: true });

const server = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start')), 8000);
  server.stdout.on('data', (d) => { if (String(d).includes('http://')) { clearTimeout(t); res(); } });
  server.on('error', rej);
});

const browser = await chromium.launch({
  executablePath: browserPath(), headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const shot = async (n) => { await page.screenshot({ path: join(SHOTS, n + '.png') }); process.stdout.write(`  shot ${n}\n`); };

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForSelector('#title-primary:not([disabled])', { timeout: 20000 });
await page.click('#title-primary');
await page.waitForSelector('#title', { state: 'detached', timeout: 10000 });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 15000 });
await page.waitForSelector('.report.briefing', { timeout: 8000 });
const dots = await page.$$eval('.briefing-dots i', (n) => n.length);
for (let i = 1; i < dots; i++) await page.click('.report-foot .btn.primary');
await page.click('.report-foot .btn.primary');
await page.waitForSelector('.report.briefing', { state: 'detached', timeout: 5000 });
await shot('10-first-morning');

// The coach asks for a floor tap. Give it one, then take whatever exit it offers.
await page.click('#silo-canvas', { position: { x: 195, y: 300 } }).catch(() => {});
await page.waitForTimeout(200);
await page.keyboard.press('Escape').catch(() => {});
for (let i = 0; i < 10; i++) {
  const skip = await page.$('.coach [role="button"], .coach button');
  if (!skip) break;
  await skip.click({ timeout: 1200 }).catch(() => {});
  await page.waitForTimeout(120);
}
await shot('11-coach-cleared');

const readOrder = () => page.evaluate(() => {
  const s = window.DEEPWATER.store.state;
  const d = document.getElementById('directive');
  const o = d && !d.hidden ? {
    eyebrow: d.querySelector('.directive-eyebrow')?.textContent?.trim(),
    text: document.getElementById('directive-text')?.textContent?.trim(),
    why: document.getElementById('directive-why')?.textContent?.trim(),
    button: d.querySelector('.directive-act [role="button"]')?.textContent?.trim() || null,
  } : null;
  return { ...o, day: s.clock.day, pop: s.citizenIds.length,
    research: s.research.completed.length, rooms: Object.keys(s.silo.rooms).length,
    brownout: s.flags.brownout };
});

// Obey it: build through the sim (test/mobile.mjs already covers the placement
// gesture), press the button otherwise, then let four days pass.
const obey = () => page.evaluate(async () => {
  const { topDirective } = await import('./src/sim/directives.js');
  const { build, allPlacements } = await import('./src/sim/build.js');
  const store = window.DEEPWATER.store;
  const d = topDirective(store.state);
  if (!d) return 'nothing';
  if (d.wait) return 'held: ' + d.text;
  if (d.room) {
    const spot = allPlacements(store.state, d.room)[0];
    if (!spot) return 'no bay for ' + d.room;
    store.dispatchAll(build(store.state, spot.floor, spot.slot, d.room));
    return 'built ' + d.room;
  }
  const btn = document.querySelector('#directive .directive-act [role="button"]');
  if (btn) { btn.click(); return 'pressed ' + btn.textContent.trim(); }
  return 'no action for ' + d.id;
});

const seen = [];
const push = (o, did) => {
  if (!o?.text) return;
  if (seen.length && seen[seen.length - 1].text === o.text) return;
  seen.push({ ...o, did });
};
push(await readOrder(), 'start');

for (let r = 0; r < ROUNDS; r++) {
  const did = await obey().catch((e) => 'error: ' + e.message);
  await page.evaluate(() => window.DEEPWATER.game?.runDays?.(4));
  await page.waitForTimeout(90);
  push(await readOrder(), did);
  if (r === 4) await shot('12-day20');
  if (r === 14) await shot('13-day60');
}
await shot('14-end');

const navs = await page.$$eval('.nav-btn', (ns) => ns.filter((n) => n.offsetParent !== null).map((n) => n.textContent.trim()));
process.stdout.write(`\n  navbar: ${navs.join(' · ')}\n`);
for (const label of navs) {
  const el = await page.$(`.nav-btn:has-text("${label}")`);
  if (!el) continue;
  await el.click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(200);
  await shot('panel-' + label.toLowerCase().replace(/[^a-z]+/g, ''));
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(80);
}

process.stdout.write('\n  ORDERS, in the sequence a player meets them:\n');
for (const o of seen) {
  process.stdout.write(`   d${String(o.day).padStart(3)} pop${String(o.pop).padStart(3)} rm${String(o.rooms).padStart(2)} r${o.research}` +
    `${o.brownout ? ' BROWN' : '     '} [${o.eyebrow}] ${o.text}${o.button ? ` <${o.button}>` : ' (hold)'}   ← ${o.did}\n`);
  if (o.why) process.stdout.write(`        ${o.why.slice(0, 160)}\n`);
}
process.stdout.write(`\n  console errors: ${errors.length ? errors.slice(0, 5).join(' | ') : 'none'}\n`);
process.stdout.write(`  ended: ${JSON.stringify(await readOrder())}\n`);

await browser.close();
server.kill();
