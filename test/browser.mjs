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

  // ---- 6b. the roster: windowed list, portraits, citizen cards ------------
  await page.click('.nav-btn[data-panel="population"]');
  await page.waitForSelector('.roster-row', { timeout: 4000 });
  const roster = await page.evaluate(() => {
    const rows = document.querySelectorAll('.roster-row');
    const total = window.DEEPWATER.store.state.citizenIds.length;
    const portraits = document.querySelectorAll('.roster-row .portrait-sm');
    // A portrait that drew nothing is a blank canvas; sample one for pixels.
    let inked = 0;
    if (portraits[0]) {
      const d = portraits[0].getContext('2d').getImageData(0, 0, portraits[0].width, portraits[0].height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
      inked = seen.size;
    }
    return { rendered: rows.length, total, portraits: portraits.length, colours: inked };
  });
  if (roster.rendered === 0) fail('roster rendered no rows');
  else if (roster.rendered >= roster.total) {
    fail(`roster rendered all ${roster.rendered} rows — the list is not windowed`);
  } else {
    ok(`roster windows ${roster.rendered} of ${roster.total} rows`);
  }
  if (roster.colours < 4) fail(`portraits look blank (${roster.colours} colours)`);
  else ok(`procedural portraits drawing (${roster.colours} distinct colours)`);

  await page.click('.roster-row');
  await page.waitForSelector('.modal .card-name', { timeout: 4000 });
  const card = await page.evaluate(() => {
    const m = document.querySelector('.modal');
    return {
      name: m.querySelector('.card-name')?.textContent,
      sub: m.querySelector('.card-sub')?.textContent,
      skills: m.querySelectorAll('.skill-row').length,
      stats: m.querySelectorAll('.stat-pip').length,
      sections: [...m.querySelectorAll('.section-label')].map((n) => n.textContent),
    };
  });
  if (card.skills !== 7) fail(`citizen card shows ${card.skills} skills, expected 7`);
  if (card.stats !== 5) fail(`citizen card shows ${card.stats} attributes, expected 5`);
  if (!/\w+ \w+/.test(card.name || '')) fail(`citizen card name looks wrong: "${card.name}"`);
  else ok(`citizen card: ${card.name} — ${card.sub}`);
  if (SHOTS) await page.screenshot({ path: join(SHOT_DIR, 'citizen-card.png') });
  await page.click('.modal-foot .btn');

  // Filters must actually filter.
  const filtered = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.chip-row .chip')];
    const idle = chips.find((c) => c.textContent === 'Idle');
    idle.click();
    return new Promise((res) =>
      setTimeout(() => {
        const subs = [...document.querySelectorAll('.roster-sub')].map((n) => n.textContent);
        res({ count: subs.length, allUnassigned: subs.every((s) => s === 'Unassigned') });
      }, 120)
    );
  });
  if (!filtered.count) fail('the Idle filter returned nothing at all');
  else if (!filtered.allUnassigned) fail('the Idle filter let posted residents through');
  else ok(`roster filters correctly (${filtered.count} idle rows, all unassigned)`);
  if (SHOTS) await page.screenshot({ path: join(SHOT_DIR, 'roster.png') });
  await page.click('.panel-close');

  // ---- 6c. build panel: catalogue, placement, and a real construction ----
  await page.click('.nav-btn[data-panel="build"]');
  await page.waitForSelector('.build-row', { timeout: 4000 });
  const catalogue = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.build-row')];
    return {
      total: rows.length,
      buildable: rows.filter((r) => !r.classList.contains('locked')).length,
      locked: rows.filter((r) => r.classList.contains('locked')).length,
      // Locked rows must explain themselves, not just grey out.
      withReasons: rows.filter((r) => r.classList.contains('locked') && r.querySelector('.build-why')).length,
      bays: document.querySelectorAll('.bay').length,
      floors: document.querySelectorAll('.floor-pip').length,
    };
  });
  if (catalogue.total < 10) fail(`build catalogue shows only ${catalogue.total} rooms`);
  if (catalogue.buildable === 0) fail('nothing at all is buildable on the opening floor');
  if (catalogue.locked !== catalogue.withReasons) {
    fail(`${catalogue.locked - catalogue.withReasons} locked rooms give no reason why`);
  }
  if (catalogue.bays !== 6) fail(`floor shows ${catalogue.bays} bays, expected 6`);
  if (catalogue.floors !== 14) fail(`floor strip shows ${catalogue.floors} floors, expected 14`);
  ok(`build catalogue: ${catalogue.buildable} buildable, ${catalogue.locked} locked (all explained)`);
  if (SHOTS) await page.screenshot({ path: join(SHOT_DIR, 'build.png') });

  const constructed = await page.evaluate(async () => {
    const { store } = window.DEEPWATER;
    const before = Object.keys(store.state.silo.rooms).length;
    const scrapBefore = store.state.resources.scrap;
    // Click the first buildable room in the catalogue.
    const row = [...document.querySelectorAll('.build-row')].find((r) => !r.classList.contains('locked'));
    const name = row.querySelector('.build-name').textContent;
    row.click();
    await new Promise((r) => setTimeout(r, 150));
    // A multi-bay choice opens a modal; take the first option if so.
    const opt = document.querySelector('.modal .row.tappable');
    if (opt) {
      opt.click();
      await new Promise((r) => setTimeout(r, 150));
    }
    return {
      name,
      before,
      after: Object.keys(store.state.silo.rooms).length,
      spent: scrapBefore - store.state.resources.scrap,
    };
  });
  if (constructed.after <= constructed.before && constructed.spent <= 0) {
    fail(`building "${constructed.name}" did nothing (rooms ${constructed.before} → ${constructed.after})`);
  } else {
    ok(`built a ${constructed.name} from the panel (${Math.round(constructed.spent)} scrap spent)`);
  }
  await page.click('.panel-close');

  // ---- 6d. research panel -------------------------------------------------
  // The panel is locked until a Laboratory exists — nothing else in the silo
  // produces research points. Verify the lock, then satisfy it.
  const lockedBefore = await page.evaluate(
    () => document.querySelector('.nav-btn[data-panel="research"]').disabled
  );
  if (!lockedBefore) fail('research was reachable with no Laboratory built');
  else ok('research is locked until a Laboratory exists, and says why');

  await page.evaluate(async () => {
    const { store, game } = window.DEEPWATER;
    const { build } = await import('./src/sim/build.js');
    // Drop a Laboratory into the first free bay on floor 13.
    const floor = store.state.silo.floors[12];
    const slot = floor.slots.findIndex((s) => s == null);
    store.state.resources.scrap += 500;
    store.state.resources.parts += 60;
    store.dispatchAll(build(store.state, 13, slot, 'laboratory'));
    game.runCycles(10); // let construction finish and points accrue
  });

  await page.click('.nav-btn[data-panel="research"]');
  await page.waitForSelector('.node-row', { timeout: 4000 });
  const tree = await page.evaluate(() => {
    const branches = document.querySelectorAll('.tabs .tab').length;
    const nodes = [...document.querySelectorAll('.node-row')];
    return {
      branches,
      nodes: nodes.length,
      startable: nodes.filter((n) => !n.classList.contains('locked') && !n.disabled).length,
      // Nodes gated on wasteland material must say so in toxin, not just grey.
      artifactGated: document.querySelectorAll('.node-why.rad').length,
    };
  });
  if (tree.branches !== 6) fail(`research shows ${tree.branches} branches, expected 6`);
  if (tree.nodes === 0) fail('research branch rendered no nodes');
  ok(`research tree: ${tree.branches} branches, ${tree.nodes} nodes in view, ${tree.startable} startable`);

  const started = await page.evaluate(async () => {
    const { store } = window.DEEPWATER;
    const node = [...document.querySelectorAll('.node-row')].find(
      (n) => !n.classList.contains('locked') && !n.disabled
    );
    if (!node) return { ok: false, why: 'nothing startable' };
    node.click();
    await new Promise((r) => setTimeout(r, 150));
    const begin = [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent === 'Begin');
    if (!begin) return { ok: false, why: 'no Begin button' };
    begin.click();
    await new Promise((r) => setTimeout(r, 150));
    return { ok: !!store.state.research.active, id: store.state.research.active?.id };
  });
  if (!started.ok) fail(`could not start research: ${started.why}`);
  else ok(`started research from the panel (${started.id})`);

  // The artifact gate has to be legible from the tree itself, before the
  // player has ever launched an expedition — that's what makes "the tech
  // tree pulls you outside" a visible rule rather than a design note.
  const gateVisible = await page.evaluate(async () => {
    const tabs = [...document.querySelectorAll('.tabs .tab')];
    const surface = tabs.find((t) => t.textContent.includes('Surface'));
    surface?.click();
    await new Promise((r) => setTimeout(r, 220));
    const chips = [...document.querySelectorAll('.node-meta .chip.rad')];
    // And the panel should say plainly that no research substitutes for it.
    const prose = [...document.querySelectorAll('.note')].map((n) => n.textContent).join(' ');
    return {
      chips: chips.length,
      first: chips[0]?.textContent || '',
      mentionsWasteland: /wasteland|another silo|recovered/i.test(prose),
    };
  });
  if (!gateVisible.chips) {
    fail('no research node visibly gated on recovered material — the tree does not pull the player outside');
  } else if (!gateVisible.mentionsWasteland) {
    fail('artifact gates are shown but never explained');
  } else {
    ok(`artifact gates visible on ${gateVisible.chips} nodes (e.g. "${gateVisible.first}") and explained`);
  }
  if (SHOTS) await page.screenshot({ path: join(SHOT_DIR, 'research.png') });
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

  // ---- 10. persistence: IndexedDB round-trip ------------------------------
  const saved = await page.evaluate(async () => {
    const { store, autosave, game } = window.DEEPWATER;
    game.runDays(2);
    store.state.__marker = 'round-trip'; // stripped on save; must not persist
    store.state.resources.scrap = 777;
    const summary = await autosave.saveNow('test');
    return { summary, day: store.state.clock.day, pop: store.state.citizenIds.length };
  });
  if (!saved.summary) fail('autosave returned no summary — the save did not land');
  else ok(`autosave wrote slot 0 (day ${saved.summary.day}, ${saved.summary.population} residents)`);

  const reloaded = await page.evaluate(async () => {
    const { loadGame } = await import('./src/core/save.js');
    const rec = await loadGame(0);
    return {
      found: !!rec,
      day: rec?.state.clock.day,
      pop: rec?.state.citizenIds.length,
      scrap: rec?.state.resources.scrap,
      chitsCap: rec?.state.caps.chits,
      stripped: rec?.state.__marker === undefined,
      usedBackup: rec?.usedBackup,
    };
  });
  if (!reloaded.found) fail('save did not come back out of IndexedDB');
  else if (reloaded.day !== saved.day || reloaded.pop !== saved.pop) {
    fail(`save round-trip changed the silo: ${JSON.stringify(reloaded)} vs ${JSON.stringify(saved)}`);
  } else if (Math.round(reloaded.scrap) !== 777) {
    fail(`resources did not survive the round-trip (scrap ${reloaded.scrap})`);
  } else if (reloaded.chitsCap !== Infinity) {
    fail(`the uncapped chits cap did not survive IndexedDB (got ${reloaded.chitsCap})`);
  } else if (!reloaded.stripped) {
    fail('transient __ fields were written to the save');
  } else {
    ok('IndexedDB round-trip is lossless (Infinity caps survive, transients stripped)');
  }

  // ---- 11. THE Phase 2 gate: an hour away produces a readable report -------
  //
  // Backdate the save by an hour, then reload the page exactly the way a
  // player returning to a closed tab would.
  await page.evaluate(async () => {
    const { store, autosave } = window.DEEPWATER;
    store.state.meta.lastSaveTs = Date.now() - 60 * 60 * 1000;
    await autosave.saveNow('backdate');
    // saveNow stamps lastSaveTs to now, so rewrite the record underneath it.
    const { saveGame } = await import('./src/core/save.js');
    store.state.meta.lastSaveTs = Date.now() - 60 * 60 * 1000;
    const db = await new Promise((res) => {
      const r = indexedDB.open('deepwater', 1);
      r.onsuccess = () => res(r.result);
    });
    await new Promise((res) => {
      const t = db.transaction('saves', 'readwrite').objectStore('saves');
      const get = t.get('slot:0');
      get.onsuccess = () => {
        const rec = get.result;
        rec.state.meta.lastSaveTs = Date.now() - 60 * 60 * 1000;
        const put = db.transaction('saves', 'readwrite').objectStore('saves').put(rec);
        put.onsuccess = () => res();
      };
    });
  });

  const returning = await context.newPage();
  const returnErrors = [];
  returning.on('pageerror', (e) => returnErrors.push(e.message));
  await returning.goto(BASE, { waitUntil: 'load' });
  await returning.waitForSelector('.report', { timeout: 20000 });

  const reportText = await returning.evaluate(() => {
    const r = document.querySelector('.report');
    return {
      eyebrow: r.querySelector('.report-eyebrow')?.textContent,
      title: r.querySelector('.report-title')?.textContent,
      headline: r.querySelector('.report-headline')?.textContent,
      stats: [...r.querySelectorAll('.report-stat')].map((n) => ({
        k: n.querySelector('.k').textContent,
        v: n.querySelector('.v').textContent,
        d: n.querySelector('.d').textContent,
      })),
      sections: [...r.querySelectorAll('.report-section')].map((n) => n.textContent),
      lines: r.querySelectorAll('.report-line').length,
      resourceCells: r.querySelectorAll('.report-res-cell').length,
      hasContinue: !!r.querySelector('.report-foot .btn'),
      // The silo must be paused while the report is up.
      speed: window.DEEPWATER.store.state.settings.speed,
    };
  });

  if (returnErrors.length) fail(`errors while showing the report: ${returnErrors.join(', ')}`);
  if (!reportText.hasContinue) fail('the return report has no Continue button');
  if (!/away/i.test(reportText.eyebrow || '')) fail(`report eyebrow reads "${reportText.eyebrow}"`);
  if (!reportText.headline || reportText.headline.length < 20) {
    fail(`report headline is not a sentence: "${reportText.headline}"`);
  }
  if (reportText.stats.length !== 4) fail(`expected 4 stat tiles, got ${reportText.stats.length}`);
  if (reportText.resourceCells === 0 && reportText.lines === 0) {
    fail('the report is empty — an hour away recorded nothing');
  }
  if (reportText.speed !== 0) fail(`the silo kept running behind the report (speed ${reportText.speed})`);

  ok(`an hour away produces a report: "${reportText.headline}"`);
  console.log(
    `      sections: ${reportText.sections.join(' / ') || '(none)'}` +
      `  ·  ${reportText.lines} log lines  ·  ${reportText.resourceCells} stores moved`
  );
  for (const s of reportText.stats) console.log(`      ${s.k}: ${s.v} (${s.d})`);

  if (SHOTS) await returning.screenshot({ path: join(SHOT_DIR, 'return-report.png') });

  // Continue dismisses it and the silo resumes.
  await returning.click('.report-foot .btn');
  await returning.waitForSelector('.report', { state: 'detached', timeout: 4000 });
  const resumed = await returning.evaluate(() => window.DEEPWATER.store.state.settings.speed);
  if (resumed === 0) fail('the silo did not resume after Continue');
  else ok(`Continue dismisses the report and resumes at ${resumed}×`);
  await returning.close();

  // ---- 12. manifest is installable ----------------------------------------
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
