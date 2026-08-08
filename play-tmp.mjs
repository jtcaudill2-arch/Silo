/**
 * A hand-played session in the real PWA. Every construction order goes
 * through the build panel the way a player's would — pick a floor, pick a
 * room, pick a bay. Time is advanced directly (nobody waits 40 real hours),
 * but no state is written except through the UI.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const SHOTS = '/tmp/claude-0/-home-user-Silo/7846661e-afa9-5072-b7a4-9789471ea17c/scratchpad/play';
const server = spawn('node', ['tools/serve.mjs'], { stdio: 'ignore', env: { ...process.env, PORT: '8790' } });
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 412, height: 892 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const shot = async (n) => { await page.screenshot({ path: join(SHOTS, n + '.png') }); };
const state = () => page.evaluate(() => window.DEEPWATER.store.state);
const days = (n) => page.evaluate((n) => window.DEEPWATER.game.runDays(n), n);
const line = (s) => `d${String(s.clock.day).padStart(3)}  pop ${String(s.citizenIds.length).padStart(3)}  ` +
  `rooms ${String(Object.keys(s.silo.rooms).length).padStart(2)}  food ${String(Math.round(s.resources.food)).padStart(4)}  ` +
  `water ${String(Math.round(s.resources.water)).padStart(4)}  scrap ${String(Math.round(s.resources.scrap)).padStart(4)}  ` +
  `order ${String(Math.round(s.order.value)).padStart(2)}  research ${s.research.completed.length}`;

/** Crises take the screen and stop the clock. Read them and carry on. */
async function clearModals() {
  for (let i = 0; i < 4; i++) {
    const crisis = await page.$('.crisis-text');
    if (crisis) {
      const head = await page.$eval('.crisis-headline', (n) => n.textContent.trim());
      console.log(`  ! CRISIS — ${head}`);
      await page.click('.modal-foot .btn').catch(() => {});
      await page.waitForTimeout(200);
      continue;
    }
    if (await page.$('.report.ending')) return 'ended';
    break;
  }
  return null;
}

/** Build a room through the panel. Returns true if it went up. */
async function build(name) {
  if (await clearModals() === 'ended') return false;
  if (!(await page.$('#panel-host:not([hidden])'))) {
    await page.click('.nav-btn[data-panel="build"]').catch(() => {});
  } else {
    await page.click('.panel-close').catch(() => {});
    await page.click('.nav-btn[data-panel="build"]').catch(() => {});
  }
  await page.waitForSelector('.build-name', { timeout: 5000 });
  // Walk the excavated floors until one offers this room with a free bay.
  // Re-query every time: the panel refreshes on a timer and any handle held
  // across that boundary is detached.
  const count = await page.locator('.floor-pip').count();
  for (let i = 0; i < count; i++) {
    await page.locator('.floor-pip').nth(i).click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(150);
    const row = page.locator(`.build-row:not(.locked):has(.build-name:text-is("${name}"))`).first();
    if (!(await row.count())) continue;
    await row.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    // Placement chooser, if it asked which bay.
    const place = page.locator('.modal button').first();
    if (await place.count()) { await place.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(250); }
    await page.click('.panel-close').catch(() => {});
    return true;
  }
  await page.click('.panel-close').catch(() => {});
  return false;
}

/** Post people to their jobs. A room with nobody in it produces nothing. */
async function staff() {
  if (await clearModals() === 'ended') return 0;
  await page.click('.panel-close').catch(() => {});
  await page.click('.nav-btn[data-panel="population"]').catch(() => {});
  await page.waitForTimeout(250);
  const btn = page.locator('button:text-is("Auto-assign")').first();
  let n = 0;
  if (await btn.count()) {
    await btn.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(200);
    n = await page.evaluate(() => {
      const t = document.querySelector('.toast');
      const m = t && t.textContent.match(/(\d+)/);
      return m ? Number(m[1]) : 0;
    });
  }
  await page.click('.panel-close').catch(() => {});
  return n;
}

async function research(id) {
  await page.click('.nav-btn[data-panel="research"]').catch(() => {});
  await page.waitForTimeout(300);
  const started = await page.evaluate((id) => {
    const btns = [...document.querySelectorAll('.panel-host button')];
    const b = btns.find((x) => (x.textContent || '').toLowerCase().includes(id));
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  }, id);
  await page.click('.panel-close').catch(() => {});
  return started;
}

await page.goto('http://localhost:8790/', { waitUntil: 'load' });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 20000 });
await page.waitForSelector('.report.briefing', { timeout: 8000 });
console.log('\n── The handover ' + '─'.repeat(50));
await shot('01-handover');
const p1 = await page.$eval('.briefing-para', (n) => n.textContent.trim());
console.log('  ' + p1.slice(0, 150) + '…');
for (let i = 0; i < 7; i++) await page.click('.report-foot .btn.primary');
await page.waitForSelector('.report.briefing', { state: 'detached' });

console.log('\n── Playing ' + '─'.repeat(55));
let s = await state();
console.log('  ' + line(s));
await shot('02-day1');

// The briefing said Recycling, Workshop, Laboratory — but it also said to
// react to whatever is threatening you, and 180 people eat 180 food a day
// against a 520 larder. Feed them first, then bootstrap.
for (const room of ['Hydroponics Bay', 'Recycling', 'Workshop', 'Hydroponics Bay', 'Laboratory']) {
  const built = await build(room);
  const posted = await staff();
  console.log(`  built ${room}: ${built ? 'yes' : 'NO — refused'}${posted ? `, posted ${posted}` : ''}`);
  await days(4);
}
s = await state();
console.log('  ' + line(s));
await shot('03-bootstrap');

await research('antibiotics');
await days(20);

// React to what the silo needs, using the same reading a player would.
for (let round = 0; round < 18; round++) {
  s = await state();
  const env = await page.evaluate(() => {
    const { store } = window.DEEPWATER;
    const st = store.state;
    return {
      air: st.air.capacity - st.air.load,
      house: Math.round(st.air.capacity - st.citizenIds.length),
      food: st.flows?.food ? st.flows.food.in - st.flows.food.out : 0,
      water: st.flows?.water ? st.flows.water.in - st.flows.water.out : 0,
      power: (st.power?.generation || 0) - (st.power?.demand || 0),
    };
  });
  // Read the alert rail first — the silo now says when something is running
  // out, in days. That is the signal a player actually plays off.
  const rail = await page.$$eval('.alert-rail *', (ns) =>
    ns.map((n) => (n.textContent || '').trim()).filter(Boolean)).catch(() => []);
  const warn = rail.find((t) => /d left/.test(t));
  const worn = rail.find((t) => /%/.test(t));
  let want = null;
  if (round === 0) want = 'Maintenance Bay';
  else
  if (warn && /Water/i.test(warn)) want = 'Water Reclaimer';
  else if (warn && /Food/i.test(warn)) want = 'Hydroponics Bay';
  else if (warn && /Fuel/i.test(warn)) want = 'Recycling';
  else if (env.food < 6) want = 'Hydroponics Bay';
  else if (env.water < 6) want = 'Water Reclaimer';
  else if (env.power < 12) want = 'Generator Hall';
  else if (env.air < 25) want = 'Air Filtration';
  else if (env.house < 12) want = 'Residences';
  else if (round % 4 === 0) want = 'Recycling';
  else if (round % 4 === 1) want = 'Clinic';
  else if (round % 4 === 2) want = 'Chem Lab';
  else want = 'Laboratory';
  const built = await build(want);
  await staff();
  const now = await state();
  if (now.citizenIds.length === 0) {
    console.log('\n  The silo died. Working backwards through the log:');
    const causes = now.stats.causes;
    console.log('  causes: ' + JSON.stringify(causes));
    for (const e of now.log.filter((x) => x.kind !== 'death').slice(-14)) {
      console.log(`   d${e.day} [${e.kind}] ${e.text}`);
    }
    const firstDeath = now.log.find((x) => x.kind === 'death');
    if (firstDeath) console.log(`  first death: d${firstDeath.day} — ${firstDeath.text}`);
    break;
  }
  if (round % 3 === 0 || warn || worn) {
    s = await state();
    console.log(`  ${line(s)}   → ${want}${built ? '' : ' (refused)'}${warn ? `   [${warn}]` : ''}${worn ? `   [${worn}]` : ''}`);
  }
  await days(10);
}

s = await state();
console.log('  ' + line(s));
await shot('04-established');

console.log('\n── What the silo looks like ' + '─'.repeat(38));
if (await clearModals() === 'ended' || (await state()).citizenIds.length === 0) {
  const t = await page.$eval('.ending .report-title', (n) => n.textContent.trim()).catch(() => 'unknown');
  console.log(`\n  The silo did not make it. Ending screen: "${t}"`);
  await shot('99-ending');
  await browser.close(); server.kill(); process.exit(0);
}
await page.click('.nav-btn[data-panel="population"]');
await page.waitForSelector('.roster-row', { timeout: 5000 });
await shot('05-roster');
const rows = await page.$$eval('.roster-row', (ns) => ns.slice(0, 3).map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
for (const r of rows) console.log('  · ' + r);
await page.click('.roster-row');
await page.waitForTimeout(400);
await shot('06-citizen');
await page.keyboard.press('Escape');
await page.click('.panel-close').catch(() => {});

await clearModals();
await page.click('.nav-btn[data-panel="log"]');
await page.waitForSelector('.log-entry', { timeout: 5000 });
await shot('07-log');
const entries = await page.$$eval('.log-entry .log-text', (ns) => ns.slice(-7).map((n) => n.textContent.trim()));
console.log('\n── The log ' + '─'.repeat(55));
for (const e of entries) console.log('  · ' + e);
await page.click('.panel-close').catch(() => {});

console.log('\n── Away for an hour ' + '─'.repeat(46));
await page.evaluate(() => {
  const s = window.DEEPWATER.store.state;
  s.meta.lastSaveTs = Date.now() - 3600_000;
  return window.DEEPWATER.autosave.save();
});
await page.waitForTimeout(500);
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 20000 });
await page.waitForSelector('.report', { timeout: 10000 });
await shot('08-return-report');
console.log('  ' + (await page.$eval('.report-headline', (n) => n.textContent.trim())));
const secs = await page.$$eval('.report-section', (ns) => ns.map((n) => n.textContent.trim()));
console.log('  sections: ' + secs.join(' · '));

console.log('\n── Console errors: ' + (errors.length ? errors.slice(0, 4).join(' | ') : 'none') + '\n');
await browser.close();
server.kill();
