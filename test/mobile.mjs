#!/usr/bin/env node
/**
 * mobile.mjs — play the game the way a phone does.
 *
 * The existing browser test proves the game works. This one proves it works
 * *where it will actually be played*: from a built tree, served under a
 * subpath, driven by a finger instead of a mouse. Those three differences are
 * where a working PWA usually breaks.
 *
 *   - Subpath. A GitHub Pages project site lives at /Repo/, not /. One
 *     root-absolute path and the game 404s on a live host but not locally.
 *   - Service worker scope. Registered from a subpath it may only claim that
 *     subpath — if the scope is wrong, offline silently stops working.
 *   - Touch. Pointer handlers are not free on mobile: without touch-action
 *     the browser eats the gesture and scrolls the page instead of dragging
 *     the depth gauge, and an overscroll at the top reloads the game.
 *
 * Usage: node test/mobile.mjs [--headed] [--shots]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 8141;
const MOUNT = '/Silo/'; // the repo name, as Pages would serve it
const BASE = `http://localhost:${PORT}${MOUNT}`;
const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = join(ROOT, '.shots');

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

const run = (args) =>
  new Promise((res, rej) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? res(out) : rej(new Error(out))));
  });

// ---- build the tree a host would receive -----------------------------------
await run([join(ROOT, 'tools/build-site.mjs')]);
ok('dist/ builds and its precache list checks out');

const server = spawn(
  process.execPath,
  [join(ROOT, 'tools/serve.mjs'), '--root', 'dist', '--base', MOUNT],
  { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] }
);
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
  // A mid-range phone, held upright. isMobile turns on the mobile viewport
  // and the touch event model rather than just narrowing the window.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) CriOS/120 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const missing = [];
  page.on('response', (r) => r.status() === 404 && missing.push(new URL(r.url()).pathname));

  const cdp = await context.newCDPSession(page);
  const swipe = async (x0, y0, x1, y1, steps = 12) => {
    const pt = (x, y) => [{ x, y, radiusX: 12, radiusY: 12, force: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: pt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t),
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  // ---- 1. boots from a subpath ---------------------------------------------
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 15000 });
  ok(`boots served from ${MOUNT}`);

  if (missing.length) fail(`404s under the subpath: ${[...new Set(missing)].join(', ')}`);
  else ok('no 404s — every path resolved relative to the subpath');
  if (errors.length) fail(`console errors on boot:\n      ${errors.join('\n      ')}`);
  else ok('no console errors on boot');

  // ---- 2. the manifest is installable from here ----------------------------
  const mani = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]')?.href;
    const res = await fetch(href);
    const json = await res.json();
    return {
      href,
      ok: res.ok,
      start: new URL(json.start_url, href).pathname,
      scope: new URL(json.scope, href).pathname,
      icons: json.icons.map((i) => new URL(i.src, href).pathname),
    };
  });
  if (!mani.ok) fail('manifest did not load under the subpath');
  else if (!mani.scope.startsWith(MOUNT)) fail(`manifest scope escaped the subpath: ${mani.scope}`);
  else if (!mani.start.startsWith(MOUNT)) fail(`manifest start_url escaped: ${mani.start}`);
  else ok(`manifest resolves in-scope (start ${mani.start})`);

  const iconStatus = await page.evaluate(
    (paths) => Promise.all(paths.map((p) => fetch(p).then((r) => r.status))),
    mani.icons
  );
  if (iconStatus.some((s) => s !== 200)) fail(`manifest icons not served: ${iconStatus.join(',')}`);
  else ok(`all ${iconStatus.length} install icons served`);

  // ---- 3. nothing overflows the phone --------------------------------------
  const layout = await page.evaluate(() => {
    const w = window.innerWidth;
    // Content inside a deliberate scroller is *supposed* to extend past the
    // edge — that's what makes it scrollable. Only flag things that overflow
    // the phone with no way to reach them.
    const inScroller = (n) => {
      for (let p = n.parentElement; p && p !== document.body; p = p.parentElement) {
        const ov = getComputedStyle(p).overflowX;
        if (ov === 'auto' || ov === 'scroll') return true;
      }
      return false;
    };
    const wide = [...document.querySelectorAll('#app *')]
      .filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && (r.right > w + 1 || r.left < -1) && !inScroller(n);
      })
      .slice(0, 6)
      .map((n) => `${n.tagName.toLowerCase()}.${n.className}`.slice(0, 60));
    const strip = document.getElementById('resource-strip');
    return {
      stripOverflow: strip.scrollWidth - strip.clientWidth,
      docScrolls: document.documentElement.scrollWidth > w,
      wide,
      overscrollHtml: getComputedStyle(document.documentElement).overscrollBehaviorY,
      overscrollBody: getComputedStyle(document.body).overscrollBehaviorY,
      docScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    };
  });
  if (layout.docScrolls) fail('the page scrolls sideways on a 390px phone');
  else ok('no horizontal overflow at 390px');
  if (layout.wide.length) fail(`elements outside the viewport: ${layout.wide.join(', ')}`);

  // A document that scrolls, plus default overscroll, is pull-to-refresh —
  // which on a canvas game means a stray downward swipe reloads the silo.
  if (layout.docScrollable && layout.overscrollHtml !== 'none' && layout.overscrollBody !== 'none') {
    fail('pull-to-refresh is live — a downward swipe would reload the game');
  } else ok('pull-to-refresh disabled');

  // On a 390px phone the resource strip is wider than the screen, so counters
  // past the edge are only reachable by swiping it. Headless Chromium won't
  // run compositor-driven scrolling even from a synthesized touch gesture
  // (a panel body with 9000px of overflow ignores it too), so assert the
  // properties a finger actually depends on instead of faking the finger:
  // it must be a real scroller, and it must not have touch-action removed.
  if (layout.stripOverflow > 0) {
    const strip = await page.evaluate(() => {
      const n = document.getElementById('resource-strip');
      const cs = getComputedStyle(n);
      n.scrollLeft = 9999;
      const reached = n.scrollLeft;
      n.scrollLeft = 0;
      return { overflowX: cs.overflowX, touchAction: cs.touchAction, reached };
    });
    if (!['auto', 'scroll'].includes(strip.overflowX)) {
      fail(`resource strip overflows ${layout.stripOverflow}px but overflow-x is ${strip.overflowX}`);
    } else if (strip.touchAction === 'none') {
      fail('resource strip has touch-action:none — a finger could not scroll it');
    } else if (strip.reached <= 0) {
      fail(`resource strip overflows ${layout.stripOverflow}px but will not scroll`);
    } else {
      ok(`resource strip scrolls ${strip.reached}px to reach the last counters`);
    }
  } else ok('resource strip fits the screen without scrolling');

  // ---- 3b. hiding something actually hides it ------------------------------
  // `[hidden]` is a user-agent rule and loses to any author `display`, so a
  // control set to display:flex stays on screen after node.hidden = true.
  // That silently defeated progressive disclosure once; keep it dead.
  const ghosts = await page.evaluate(() =>
    [...document.querySelectorAll('#app [hidden]')]
      .filter((n) => n.offsetParent !== null || n.getClientRects().length > 0)
      .map((n) => `${n.tagName.toLowerCase()}.${n.className}`.slice(0, 40))
  );
  if (ghosts.length) fail(`[hidden] elements still rendering: ${ghosts.slice(0, 5).join(', ')}`);
  else ok('nothing marked hidden is still on screen');

  // ---- 4. the handover, by finger ------------------------------------------
  await page.waitForSelector('.report.briefing', { timeout: 8000 });
  const dots = await page.locator('.briefing-dots i').count();
  for (let i = 1; i < dots; i++) await page.tap('.report-foot .btn.primary');
  await page.tap('.report-foot .btn.primary');
  await page.waitForSelector('.report.briefing', { state: 'detached', timeout: 4000 });
  ok(`paged through the ${dots}-part handover by tapping`);

  // What the player meets on the first morning, counted as rendered rather
  // than as intent — the difference is the whole bug above.
  const disclosure = await page.evaluate(() => {
    const shown = (n) => n.offsetParent !== null;
    return {
      res: [...document.querySelectorAll('.res')].filter(shown).length,
      nav: [...document.querySelectorAll('.nav-btn')].filter(shown).length,
    };
  });
  if (disclosure.res > 7) fail(`${disclosure.res} resource counters rendered on the first morning`);
  else if (disclosure.nav > 5) fail(`${disclosure.nav} panels rendered on the first morning`);
  else ok(`first morning renders ${disclosure.res} counters and ${disclosure.nav} panels`);

  // ---- 5. every control is thumb-sized -------------------------------------
  const small = await page.evaluate(() => {
    const out = [];
    for (const n of document.querySelectorAll('#app button:not([hidden])')) {
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 30 || r.width < 30) {
        out.push(`${n.id || n.className}: ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
    }
    return out;
  });
  if (small.length) fail(`tap targets under 30px: ${small.slice(0, 6).join(', ')}`);
  else ok('every visible control is at least 30×30');

  // ---- 6. the bottom bar clears the home indicator -------------------------
  const nav = await page.evaluate(() => {
    const n = document.getElementById('navbar').getBoundingClientRect();
    return { bottom: Math.round(n.bottom), h: Math.round(n.height), vh: window.innerHeight };
  });
  if (nav.bottom > nav.vh + 1) fail(`navbar hangs ${nav.bottom - nav.vh}px below the viewport`);
  else ok(`navbar sits inside the viewport (${nav.h}px tall, bottom at ${nav.bottom}/${nav.vh})`);

  // ---- 7. tapping a panel open and shut ------------------------------------
  await page.tap('.nav-btn[data-panel="resources"]');
  await page.waitForSelector('#panel-host:not([hidden]) .panel-title', { timeout: 4000 });
  const title = await page.$eval('.panel-title', (n) => n.textContent);
  ok(`tapping the nav opens ${title}`);
  await page.tap('.panel-close');
  // The host stays in the DOM and toggles [hidden], so wait on the attribute
  // rather than on visibility — a hidden node never becomes "visible".
  await page.waitForFunction(() => document.getElementById('panel-host').hidden, {
    timeout: 4000,
  });
  ok('tapping the close button shuts it again');

  // ---- 8. dragging the depth gauge with a finger ---------------------------
  const gauge = await page.evaluate(() => {
    const r = document.getElementById('depth-gauge').getBoundingClientRect();
    return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom };
  });
  const before = await page.evaluate(() => Math.round(window.DEEPWATER.renderer.targetY));
  await swipe(gauge.x, gauge.top + 40, gauge.x, gauge.bottom - 40);
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => ({
    camera: Math.round(window.DEEPWATER.renderer.targetY),
    scrolled: window.scrollY,
  }));
  if (after.scrolled !== 0) fail('the drag scrolled the page instead of the gauge');
  else if (after.camera === before) {
    fail(`the finger drag did not move the depth gauge (camera stuck at ${before})`);
  } else ok(`finger drag moves the depth gauge (camera ${before} → ${after.camera})`);

  // ---- 9. tapping the cross-section ----------------------------------------
  const canvas = await page.evaluate(() => {
    const r = document.getElementById('silo-canvas').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + Math.min(60, r.height / 3) };
  });
  await page.touchscreen.tap(canvas.x, canvas.y);
  await page.waitForTimeout(300);
  ok('the cross-section takes taps without throwing');

  if (SHOTS) {
    await mkdir(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SHOT_DIR, 'phone.png') });
  }

  // ---- 10. installed-and-offline, from the subpath -------------------------
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    const cache = await caches.open(keys[0]);
    return { scope: new URL(reg.scope).pathname, cached: (await cache.keys()).length };
  });
  if (!sw) fail('no service worker registered — the game will not work offline');
  else if (sw.scope !== MOUNT) fail(`service worker scope is ${sw.scope}, expected ${MOUNT}`);
  else if (sw.cached < 40) fail(`only ${sw.cached} entries precached from the subpath`);
  else ok(`service worker owns ${sw.scope} with ${sw.cached} entries cached`);

  await context.setOffline(true);
  const offline = await context.newPage();
  const offlineErrors = [];
  offline.on('pageerror', (e) => offlineErrors.push(e.message));
  await offline.goto(BASE, { waitUntil: 'load' });
  await offline.waitForSelector('#app:not([hidden])', { timeout: 15000 });
  await offline.waitForFunction(() => !!window.DEEPWATER, { timeout: 15000 });
  const snap = await offline.evaluate(() => {
    const s = window.DEEPWATER.store.state;
    window.DEEPWATER.game.runCycles(5);
    return { pop: s.citizenIds.length, cycle: window.DEEPWATER.store.state.clock.cycle };
  });
  if (snap.pop < 1) fail('offline boot from the subpath produced an empty silo');
  else ok(`plays offline from ${MOUNT} (${snap.pop} residents, ${snap.cycle} cycles run)`);
  if (offlineErrors.length) fail(`errors offline: ${offlineErrors.join(', ')}`);
  await context.setOffline(false);
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  console.error(`\n✗ mobile: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ mobile: the game is playable in a phone browser from a subpath');
