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

  // …and they have to be *legible*, not merely present. Counting what renders
  // was the last fix here and it was only half the question: the four counters
  // the silo shows on the first morning need 248px and the strip is 230px
  // wide, so SCRAP — the unit every standing order is priced in — was cut off
  // down its right edge before the player had done anything at all. §3 above
  // cannot see this: it exempts scrollers, and the strip is a legitimate
  // scroller later on. The first morning is the frame that must not scroll.
  const firstStrip = await page.evaluate(() => {
    const strip = document.getElementById('resource-strip');
    const box = strip.getBoundingClientRect();
    const shown = [...strip.querySelectorAll('.res')].filter((n) => n.offsetParent !== null);
    return {
      clientW: strip.clientWidth,
      scrollW: strip.scrollWidth,
      clipped: shown
        .filter((n) => n.getBoundingClientRect().right > box.right + 1)
        .map((n) => n.dataset.res),
      // A stock that starts empty and fills on the first cycle is not a
      // crisis, and the first thing a new mayor should not see is a red zero
      // they did nothing to cause.
      falseAlarms: shown
        .filter((n) => n.classList.contains('critical'))
        .filter(() => {
          const f = window.DEEPWATER.store.state.flows || {};
          return !Object.keys(f).length;
        })
        .map((n) => n.dataset.res),
    };
  });
  if (firstStrip.clipped.length) {
    fail(
      `the resource strip clips ${firstStrip.clipped.join(', ')} on the first morning ` +
        `(${firstStrip.scrollW}px of counters in a ${firstStrip.clientW}px window). ` +
        'Everything the silo chooses to show before the player has acted has to fit. ' +
        'styles.css: .res { min-width: 56px; padding: 0 6px } and .clock { min-width: 66px } ' +
        'measures 238/238 with all four counters whole.'
    );
  } else {
    ok(`the first morning's counters all fit the strip (${firstStrip.scrollW}/${firstStrip.clientW}px)`);
  }
  if (firstStrip.falseAlarms.length) {
    fail(
      `${firstStrip.falseAlarms.join(', ')} styled critical on the first frame, before the ` +
        'economy has run a cycle — a red zero nobody caused. shell.js renderStrip(): the ' +
        '`critical` test needs a `!!flow &&` in front of it, so an empty stock is only a ' +
        'crisis once there is a flow to judge it against.'
    );
  } else ok('nothing is crying wolf on the first frame');

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

  // ---- 6b. every panel is still reachable once they have all arrived -------
  //
  // The navbar is the one scroller in the game that must never scroll. It is
  // the only way to reach a panel, it carries no affordance saying there is
  // more of it — no fade, no chevron, nothing past the last visible button —
  // and its buttons are the same size and colour as the ones that fit, so a
  // navbar that overflows does not look like a navbar that overflows. It looks
  // like a game with six panels in it.
  //
  // This was worth catching and was not caught, because §3 above exempts
  // anything inside a deliberate scroller and this test only ever measured the
  // first morning's four buttons. Nine panels is the real end state: unlock
  // every gate and count what is left on screen.
  const fullNav = await page.evaluate(() => {
    const D = window.DEEPWATER;
    const s = D.store.state;
    // Earn every gate the honest way, so this measures what a real campaign
    // ends up with rather than a debug flag.
    s.world.radioTier = 1;
    for (const id of ['radio_range_1', 'env_suit_1']) {
      if (!s.research.completed.includes(id)) s.research.completed.push(id);
    }
    s.order.crimes.push({ id: 'theft', day: 1, text: 'stores do not balance' });
    s.order.crimes.push({ id: 'hoarding', day: 2, text: 'a false panel and three months of rations' });
    const place = (type, floor, slot) => {
      const f = s.silo.floors[floor - 1];
      if (!f || f.slots[slot] != null) return;
      const id = String(s.silo.nextRoomId++);
      s.silo.rooms[id] = {
        id, type, floor, slot, width: 1, level: 1, condition: 100,
        staff: [], powered: true, buildingUntilCycle: 0, upgradingUntilCycle: 0,
      };
      f.slots[slot] = id;
      s.silo.powerPriority.push(id);
    };
    place('laboratory', 1, 0);
    place('airlock', 1, 1);
    place('armory', 1, 2);
    D.shell.syncNav();

    const bar = document.getElementById('navbar');
    const shown = [...bar.querySelectorAll('.nav-btn')].filter((n) => n.offsetParent !== null);
    const barRect = bar.getBoundingClientRect();
    return {
      clientW: bar.clientWidth,
      scrollW: bar.scrollWidth,
      count: shown.length,
      offscreen: shown
        .filter((n) => {
          const r = n.getBoundingClientRect();
          return r.right > barRect.right + 1 || r.left < barRect.left - 1;
        })
        .map((n) => n.querySelector('.nav-label')?.textContent || n.dataset.panel),
      widths: shown.map((n) => Math.round(n.getBoundingClientRect().width)),
    };
  });
  if (fullNav.offscreen.length) {
    fail(
      `with all ${fullNav.count} panels unlocked the navbar needs ${fullNav.scrollW}px in ` +
        `${fullNav.clientW}px and ${fullNav.offscreen.length} of them are off the edge of the ` +
        `phone: ${fullNav.offscreen.join(', ')}. A panel you cannot see is a panel you do not ` +
        'have. styles.css: .nav-btn { flex: 1 1 0; min-width: 0; padding: 4px 2px } with ' +
        '.nav-btn .nav-label { max-width: 100%; overflow: hidden; white-space: nowrap } gives ' +
        'nine 43px buttons in 390px, every label whole and every target over 30px.'
    );
  } else {
    ok(`all ${fullNav.count} panels fit the navbar at 390px (${fullNav.scrollW}/${fullNav.clientW}px)`);
  }
  // …and they must still be thumb-sized once they all fit.
  const tiny = fullNav.widths.filter((w) => w < 30);
  if (tiny.length) fail(`${tiny.length} nav buttons are under 30px wide with every panel unlocked`);

  // Position was the only thing asserted here, and position is not the whole
  // question. A grid mistake once gave the navbar the 1fr track and the stage
  // the auto one, producing a 456px navbar with the silo crushed into the top
  // third — and this test passed the whole time, because a navbar can be
  // absurd and still be entirely inside the viewport. Assert the proportions
  // as well: chrome stays chrome, and the cross-section stays the thing you
  // are looking at.
  const share = await page.evaluate(() => {
    const vh = window.innerHeight;
    const px = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v));
    const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const stage = rect('.stage') || rect('#silo-canvas');
    return {
      vh,
      navH: rect('#navbar').height,
      navVar: px('--navbar-h'),
      topH: rect('#topbar')?.height ?? 0,
      topVar: px('--topbar-h'),
      stageH: stage ? stage.height : 0,
    };
  });
  const slack = 1.5; // safe-area padding and a wrapped label are legitimate
  if (share.navH > share.navVar * slack) {
    fail(`navbar is ${Math.round(share.navH)}px against a --navbar-h of ${share.navVar}px`);
  } else if (share.topH > share.topVar * slack) {
    fail(`topbar is ${Math.round(share.topH)}px against a --topbar-h of ${share.topVar}px`);
  } else if (share.stageH < share.vh * 0.45) {
    fail(
      `the cross-section gets ${Math.round((share.stageH / share.vh) * 100)}% of the screen — ` +
        'chrome has taken the space the game is played in'
    );
  } else {
    ok(
      `chrome stays chrome: nav ${Math.round(share.navH)}px, top ${Math.round(share.topH)}px, ` +
        `cross-section ${Math.round((share.stageH / share.vh) * 100)}% of the screen`
    );
  }

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

  // ---- 8b. it has to slide, not step ---------------------------------------
  // "Moves" is not the same question as "moves smoothly", and the test only
  // ever asked the first one. The camera was snapped to a whole *world* unit
  // before the transform scaled it, so the smallest movement the screen could
  // make was two or three device pixels and a slow drag advanced in visible
  // jumps — every drawn position an integer. Sample what is actually drawn.
  const glide = await page.evaluate(async () => {
    const r = window.DEEPWATER.renderer;
    const seen = [];
    const orig = r.render.bind(r);
    r.render = (dt) => {
      orig(dt);
      seen.push(r._drawnCamY ?? Math.round(r.camY));
    };
    // Move the camera by fractions of a world unit and see if it follows.
    const base = r.targetY;
    for (let i = 1; i <= 12; i++) {
      r.targetY = base + i * 0.3;
      r.camY = r.targetY;
      await new Promise((res) => requestAnimationFrame(res));
    }
    r.render = orig;
    return { seen, integers: seen.every((v) => Number.isInteger(v)) };
  });
  const distinct = new Set(glide.seen.map((v) => v.toFixed(3))).size;
  if (glide.integers) {
    fail('the drawn camera only ever lands on whole world units — a slow drag steps instead of sliding');
  } else if (distinct < 6) {
    fail(`twelve sub-unit camera moves produced only ${distinct} distinct drawn positions`);
  } else {
    ok(`the camera slides between world units (${distinct} distinct positions from 12 nudges)`);
  }

  // A flick should coast. Stopping dead the instant the finger leaves reads as
  // the gesture having been dropped rather than finished.
  const canvasBox = await page.evaluate(() => {
    const r = document.getElementById('silo-canvas').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.7) };
  });
  // Park mid-silo first. The gauge drag above left the camera pinned at the
  // bottom of its travel, and a flick into a clamp correctly coasts nowhere —
  // which would have this assert the opposite of what it means to.
  await page.evaluate(() => {
    const r = window.DEEPWATER.renderer;
    r.fling = 0;
    r.focusFloor(40, true);
  });
  await page.waitForTimeout(60);
  for (let i = 0; i <= 5; i++) {
    const y = canvasBox.y - i * 40;
    const type = i === 0 ? 'touchStart' : 'touchMove';
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: [{ x: canvasBox.x, y, radiusX: 12, radiusY: 12, force: 1 }],
    });
    await page.waitForTimeout(8);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const atRelease = await page.evaluate(() => window.DEEPWATER.renderer.camY);
  await page.waitForTimeout(500);
  const afterCoast = await page.evaluate(() => window.DEEPWATER.renderer.camY);
  const coasted = Math.abs(afterCoast - atRelease);
  if (coasted < 1) fail('a flick did not coast — the cross-section stops dead when the finger lifts');
  else ok(`a flick coasts after the finger lifts (${coasted.toFixed(0)} world units)`);

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
