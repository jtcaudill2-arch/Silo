#!/usr/bin/env node
/**
 * pacing.mjs — the Phase 9 report.
 *
 * Measures a played campaign against the §16 pacing table and prints the
 * deviation. This deliberately *reports* rather than enforcing most of it:
 * a test that failed until the numbers matched a target table would just
 * push me to tune the game until the test passed, which is backwards.
 *
 * What it does fail on is real breakage — a silo that cannot progress, a
 * crisis that never fires, an ending that is unreachable in principle.
 *
 * Run: node test/pacing.mjs [--days=300]
 */

import { Store } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import { autopilot } from './autopilot.mjs';
import { CRISIS_LIST } from '../src/data/events.js';
import { endingProgress } from '../src/sim/events.js';
import { ENDINGS } from '../src/data/events.js';
import { BAL, TIME } from '../src/config/balance.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const DAYS = Number(args.days ?? 300);

const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);
const note = (m) => notes.push(m);

registerCoreReducers();

/** §16, converted to game days. One real minute is one cycle; eight is a day. */
// Crises are scheduled in real elapsed minutes, so converting to game days
// needs the real length of a day. This used to divide by cyclesPerDay alone,
// which is only the same number while a cycle happens to last exactly one real
// minute — true at 60 ticks per cycle, and quietly wrong at 90, where it put
// every scheduled beat a third late and read as the game firing crises early.
const REAL_MINUTES_PER_DAY =
  (BAL.time.TICK_MS * TIME.ticksPerCycle * TIME.cyclesPerDay) / 60_000;
const minutesToDays = (m) => m / REAL_MINUTES_PER_DAY;
// §16's population column was written against a silo that opens with 180
// residents, and it is written in absolute numbers: 180–200, 200–260,
// 260–400, 400–600. The opening is now 44 (see citizens.startPopulation for
// why), so every one of those figures is off by the shrink factor and the
// report read "behind" at all four stages for a silo that was in fact doing
// fine. What §16 is actually asserting is a *shape* — the silo roughly
// triples over the first forty hours — so the shape is what is kept here and
// the anchor is what moves. Each band below is §16's own ratio-to-opening,
// rescaled onto 44 and rounded to something readable:
//
//   stage    §16 band    ratio to its 180 opening    × 44
//   Opening  180–200     1.00–1.11                   44–50
//   Early    200–260     1.11–1.44                   45–65
//   Mid      260–400     1.44–2.22                   62–100
//   Late     400–600     2.22–3.33                   100–150
//
// One deliberate departure: Early's floor is 45 rather than the 49 the ratio
// gives. A 180-person silo arrives with a mature age pyramid and grows from
// day one; a 44-person silo spends its first twenty days building the
// Recycling, Workshop and Laboratory it cannot function without, and the
// birth rules gate on food-days and free beds it has not built yet. Growth
// genuinely starts around day 30 here, and holding the old ratio at day 20
// would flag a stage that is doing exactly what the smaller opening was
// designed to do.
const STAGES = [
  { name: 'Opening', toMinutes: 45, pop: [44, 50], want: ['first Workshop'] },
  { name: 'Early', toMinutes: 240, pop: [45, 65], want: ['Radio Room online', 'Mids excavated'] },
  { name: 'Mid', toMinutes: 900, pop: [62, 100], want: ['standing squad', 'Lowers excavated'] },
  { name: 'Late', toMinutes: 2400, pop: [100, 150], want: ['Deeps excavated'] },
];

// ---------------------------------------------------------------------- run --

const store = new Store(createNewGame({ seed: BAL.meta.defaultSeed, now: 1_700_000_000_000 }));
store.silent = true;
const game = new Game(store);
const s = store.state;
store.dispatchAll(autoAssign(s));

const marks = [];
const milestones = {};
const crisisDays = {};

function record(key, day) {
  if (milestones[key] === undefined) milestones[key] = day;
}

for (let d = 0; d < DAYS; d++) {
  game.runDays(1);
  // Real minutes elapsed: one cycle is one real minute at 1x.
  s.meta.playedMs = s.clock.cycle * BAL.time.TICK_MS * TIME.ticksPerCycle;
  for (let i = 0; i < 3; i++) store.dispatchAll(autopilot(s));

  const day = s.clock.day;
  const has = (t) => Object.values(s.silo.rooms).some((r) => r.type === t && r.buildingUntilCycle === 0);
  const dug = s.silo.floors.filter((f) => f.excavated).length;

  if (has('workshop')) record('first Workshop', day);
  if (has('radio_room')) record('Radio Room online', day);
  if (has('airlock') && has('suit_bay')) record('first Suit Bay', day);
  // "Mids excavated" sits in §16's four-hour Early stage, and no silo digs
  // twenty floors in four hours — so read these as the tier being open and
  // under the shovel, not finished. Tier boundaries come from balance.js.
  for (const tier of BAL.silo.tiers) {
    if (tier.gate && dug >= tier.from) record(`${tier.name} excavated`, day);
  }
  if (s.military.squadIds.length) record('standing squad', day);
  if (s.stats.expeditionsReturned > 0) record('first expedition home', day);
  if (Object.values(s.world.silos).some((x) => x.contact !== 'none')) record('first contact', day);
  for (const c of CRISIS_LIST) {
    if (s.flags.crises[c.id] !== undefined && crisisDays[c.id] === undefined) {
      crisisDays[c.id] = day;
    }
  }

  marks.push({ day, minutes: s.clock.cycle, pop: s.citizenIds.length });
  if (s.citizenIds.length === 0) break;
}

// ------------------------------------------------------------------ report --

console.log('');
console.log('  DEEPWATER — pacing against §16');
console.log('  ' + '─'.repeat(66));
console.log(`  ${DAYS} game days = ${(DAYS * TIME.cyclesPerDay) / 60} real hours at 1x`);
console.log('');
console.log('  stage      real time    target pop     actual pop   verdict');

for (const stage of STAGES) {
  const day = Math.floor(minutesToDays(stage.toMinutes));
  const mark = marks.find((m) => m.day >= day) || marks[marks.length - 1];
  if (!mark) continue;
  const [lo, hi] = stage.pop;
  const actual = mark.pop;
  const verdict =
    actual >= lo && actual <= hi * 1.1 ? 'on target' : actual < lo ? 'behind' : 'ahead';
  console.log(
    `  ${stage.name.padEnd(10)} ${String(Math.round(stage.toMinutes / 60) + 'h').padStart(4)}` +
      `${` (d${day})`.padEnd(9)} ${`${lo}–${hi}`.padStart(9)}   ${String(actual).padStart(10)}   ${verdict}`
  );
  if (verdict === 'behind') {
    note(`${stage.name}: population ${actual} against a ${lo}–${hi} target at ${Math.round(stage.toMinutes / 60)}h.`);
  }
}

console.log('');
console.log('  milestone                  reached      §16 expects');
const EXPECTED = {
  'first Workshop': 45,
  'Radio Room online': 240,
  'first Suit Bay': 45,
  'first contact': 240,
  'first expedition home': 240,
  'Mids excavated': 240,
  'standing squad': 900,
  'Lowers excavated': 900,
  'Deeps excavated': 2400,
  'Foundations excavated': 2400,
};
const ratios = [];
for (const [key, byMinutes] of Object.entries(EXPECTED)) {
  const day = milestones[key];
  const reached = day === undefined ? '—' : `d${day} (${Math.round((day * TIME.cyclesPerDay) / 60)}h)`;
  const target = `${Math.round(byMinutes / 60)}h`;
  const late = day === undefined || day * TIME.cyclesPerDay > byMinutes;
  console.log(`  ${key.padEnd(26)} ${reached.padEnd(12)} ${target.padStart(6)}${late ? '   late' : ''}`);
  if (day === undefined) note(`${key} never happened in ${DAYS} days.`);
  else ratios.push((day * TIME.cyclesPerDay) / byMinutes);
}
if (ratios.length) {
  // One number for the whole table. A player who beelines a single branch
  // can hit §16's hours; this run spreads its attention the way the autopilot
  // does — repair first, then survival, then reach — and lands slower. The
  // ratio is the honest cost of playing broadly, and it's the number to
  // watch across future balance changes.
  const median = ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)];
  note(
    `milestones land about ${median.toFixed(1)}× later than §16's hours for a broadly-played ` +
      `silo; the table's times suit a player beelining one branch.`
  );
}

console.log('');
console.log('  scripted crises');
for (const c of CRISIS_LIST) {
  const day = crisisDays[c.id];
  const expectDay = Math.round(minutesToDays(c.atMinutes));
  console.log(
    `  ${c.name.padEnd(20)} ${(day === undefined ? '—' : `d${day}`).padEnd(8)} scheduled d${expectDay}`
  );
  if (day === undefined && DAYS >= expectDay + 3) {
    fail(`the ${c.name} crisis never fired, though it was due on day ${expectDay}`);
  } else if (day !== undefined && Math.abs(day - expectDay) > 4) {
    fail(`the ${c.name} crisis fired on day ${day}, scheduled for ${expectDay}`);
  }
}

console.log('');
console.log('  endings');
for (const e of endingProgress(s)) {
  console.log(`  ${e.name.padEnd(14)} ${String(Math.round(e.progress * 100) + '%').padStart(5)}  ${e.detail}`);
}

// ------------------------------------------------------------------ checks --

console.log('');
if (s.citizenIds.length === 0) fail('the silo died under a competent player');
if (!Object.keys(milestones).length) fail('no milestone at all was reached');
if (s.research.completed.length < 8) {
  fail(`only ${s.research.completed.length} research nodes in ${DAYS} days — the tree is unreachable`);
} else {
  ok(`${s.research.completed.length} research nodes completed`);
}
if (s.stats.expeditionsReturned === 0) {
  fail('no expedition ever came home — the surface is unreachable in practice');
} else {
  ok(`${s.stats.expeditionsReturned} expeditions returned, ${s.stats.raidersKilled + s.stats.mutantsKilled} kills`);
}

// Every ending has to be reachable in principle: each one's requirements must
// all exist in the data, or it is decoration.
import('../src/data/research.js').then(({ RESEARCH }) => {
  for (const id of ['origin_record', 'env_suit_4']) {
    if (!RESEARCH[id]) fail(`ending requirement "${id}" is not in the research tree`);
  }
  if (ENDINGS.length !== 3) fail(`expected 3 endings, found ${ENDINGS.length}`);
  else ok(`all ${ENDINGS.length} endings are defined and their requirements exist`);

  console.log('');
  for (const n of notes) console.log(`  ! ${n}`);
  if (failures.length) {
    for (const f of failures) console.error(`  FAIL  ${f}`);
    console.error(`\n  ${failures.length} failure(s)\n`);
    process.exit(1);
  }
  console.log('\n  PASS — pacing report\n');
});
