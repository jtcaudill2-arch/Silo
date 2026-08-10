#!/usr/bin/env node
/**
 * catchup.mjs — the Phase 2 gate.
 *
 * The spec is blunt about this one: do not proceed until closing the tab for
 * an hour produces a correct, readable report. So this checks four things:
 *
 *  1. DETERMINISM — a sub-5-minute absence replayed offline produces state
 *     byte-identical to having watched it. If that isn't true, the whole
 *     "same result whether you watched or not" contract is a lie.
 *  2. FIDELITY — an hour away, replayed coarsely, lands close to what an hour
 *     of live play produces. Not identical (production is averaged), but the
 *     same story.
 *  3. THE REPORT — an hour away produces a report with named deaths, causes,
 *     resource deltas, and a headline that reads like a sentence.
 *  4. THE CAP — three days away simulates twelve hours and says so.
 *
 * Run: node test/catchup.mjs
 */

import { createStore, Store } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame, rehydrate } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import { runCatchup, classify, describeAbsence } from '../src/core/catchup.js';
import { exportSave, importSave, migrate, summarise } from '../src/core/save.js';
import { SCHEMA_VERSION } from '../src/core/migrations.js';
import { BAL, TIME } from '../src/config/balance.js';

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

const SEED = 0xd33fa7e5;
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

registerCoreReducers();

/** A fresh, staffed, sufficient silo — one that survives long enough to test. */
function freshSilo(seed = SEED) {
  const store = new Store(createNewGame({ seed, scenario: 'sufficient', now: T0 }));
  store.silent = true;
  const game = new Game(store);
  store.dispatchAll(autoAssign(store.state));
  return { store, game };
}

/** Deep structural comparison, reporting the first few differing paths. */
function diff(a, b, path = '', out = [], seen = new Set()) {
  if (out.length > 8) return out;
  if (a === b) return out;
  if (typeof a !== typeof b) {
    out.push(`${path}: ${typeof a} vs ${typeof b}`);
    return out;
  }
  if (typeof a === 'number') {
    if (Math.abs(a - b) > 1e-9) out.push(`${path}: ${a} vs ${b}`);
    return out;
  }
  if (a === null || b === null || typeof a !== 'object') {
    if (a !== b) out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return out;
  }
  const key = path;
  if (seen.has(key)) return out;
  seen.add(key);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k.startsWith('__')) continue;
    diff(a[k], b[k], path ? `${path}.${k}` : k, out, seen);
  }
  return out;
}

/**
 * Everything the simulation must reproduce exactly. Excludes wall-clock
 * bookkeeping and `lastReport`, which is presentation state describing the
 * absence itself — a silo that was watched has no report to write.
 */
function comparable(state) {
  const { meta, lastReport, ...rest } = state;
  return {
    ...rest,
    meta: { seed: meta.seed, schemaVersion: meta.schemaVersion, gameOver: meta.gameOver },
  };
}

// ---------------------------------------------------------------------------
// 1. DETERMINISM — the fine path must reproduce live play exactly
// ---------------------------------------------------------------------------
{
  // Must be a whole number of cycles, or this compares different amounts of
  // simulation: catch-up floors the elapsed time to complete cycles while
  // runCycles() rounds a fractional count up, so a stray half-cycle shows up
  // as "the fine path is non-deterministic" when it is nothing of the kind.
  // Derived rather than written as minutes for that reason — it was 4 minutes,
  // exact at a 60-second cycle and 2⅔ cycles once a cycle became 90.
  const CYCLE_MS = BAL.time.TICK_MS * TIME.ticksPerCycle;
  const AWAY_CYCLES = 3;
  const AWAY_MS = AWAY_CYCLES * CYCLE_MS;
  if (AWAY_MS > BAL.catchup.fullFidelityMs) {
    fail(`${AWAY_CYCLES} cycles is ${AWAY_MS}ms, past the ${BAL.catchup.fullFidelityMs}ms fine threshold`);
  }
  if (classify(AWAY_MS) !== 'fine') fail(`${AWAY_MS}ms should classify as "fine", got "${classify(AWAY_MS)}"`);

  // (a) watched it happen
  const live = freshSilo();
  live.game.runCycles(AWAY_CYCLES);

  // (b) walked away for the same length of time
  const away = freshSilo();
  away.store.state.meta.lastSaveTs = T0;
  const report = runCatchup(away.store, away.game, { now: T0 + AWAY_MS });

  const d = diff(comparable(live.store.state), comparable(away.store.state));
  if (d.length) {
    fail(`fine catch-up diverged from live play:\n      ${d.join('\n      ')}`);
  } else {
    ok(`4 minutes away replays byte-identical to 4 minutes watched (${live.store.state.clock.cycle} cycles)`);
  }
  if (!report) fail('a 4-minute absence should still produce a report');
  else if (report.mode !== 'fine') fail(`expected mode "fine", got "${report.mode}"`);
}

// ---------------------------------------------------------------------------
// 2. FIDELITY — an hour coarse should tell the same story as an hour live
// ---------------------------------------------------------------------------
{
  const AWAY_MS = HOUR;
  if (classify(AWAY_MS) !== 'coarse') fail(`an hour should classify as "coarse", got "${classify(AWAY_MS)}"`);

  const live = freshSilo();
  live.game.runCycles(AWAY_MS / (BAL.time.TICK_MS * TIME.ticksPerCycle));

  const away = freshSilo();
  away.store.state.meta.lastSaveTs = T0;
  runCatchup(away.store, away.game, { now: T0 + AWAY_MS });

  const L = live.store.state;
  const A = away.store.state;

  if (L.clock.day !== A.clock.day) {
    fail(`clock diverged: live day ${L.clock.day}, coarse day ${A.clock.day}`);
  } else {
    ok(`coarse replay lands on the same day (day ${A.clock.day}, ${A.clock.cycle} cycles)`);
  }

  const popDrift = Math.abs(L.citizenIds.length - A.citizenIds.length);
  if (popDrift > 4) {
    fail(`population diverged by ${popDrift} (live ${L.citizenIds.length}, coarse ${A.citizenIds.length})`);
  } else {
    ok(`population within ${popDrift} of live play (live ${L.citizenIds.length}, coarse ${A.citizenIds.length})`);
  }

  for (const key of ['food', 'water', 'fuel', 'scrap']) {
    const lv = L.resources[key];
    const av = A.resources[key];
    const scale = Math.max(50, Math.abs(lv));
    const drift = Math.abs(lv - av) / scale;
    if (drift > 0.2) {
      fail(`${key} diverged ${(drift * 100).toFixed(0)}% (live ${lv.toFixed(0)}, coarse ${av.toFixed(0)})`);
    }
  }
  ok('stockpiles stay within 20% of the live run');

  // Signs must agree: if the silo was gaining food live, it must not be
  // losing it coarsely. Directional lies are worse than magnitude drift.
  for (const key of ['food', 'water']) {
    const liveDir = Math.sign(L.resources[key] - BAL.resources.start[key]);
    const awayDir = Math.sign(A.resources[key] - BAL.resources.start[key]);
    if (liveDir !== 0 && awayDir !== 0 && liveDir !== awayDir) {
      fail(`${key} moved in opposite directions (live ${liveDir}, coarse ${awayDir})`);
    }
  }
  ok('stockpiles move in the same direction as live play');
}

// ---------------------------------------------------------------------------
// 3. THE REPORT — an hour away, on a silo that is actually in trouble
// ---------------------------------------------------------------------------
{
  // What is under test is that the return report *surfaces* deaths, with a
  // name and a cause, after an absence. It used to get those deaths for free
  // by leaning on the opening being lethal — "the real six-room opening: it
  // starves". The opening was then deliberately made survivable, so this was
  // asserting on a balance accident it did not control, and it broke the day
  // the accident was fixed. Empty the larder explicitly instead: now the
  // deaths are the fixture rather than a side effect of the current balance.
  const store = new Store(createNewGame({ seed: SEED, now: T0 }));
  store.silent = true;
  const game = new Game(store);
  store.dispatchAll(autoAssign(store.state));

  // Emptying the stores alone achieves nothing — hydroponics makes eleven food
  // a cycle against a draw of five, so the larder refills before the next
  // shift. The bays have to stop producing: at zero condition roomCapability
  // returns 0, which is the same silo a player would come back to after a
  // catastrophic failure, and the stores then actually drain.
  for (const room of Object.values(store.state.silo.rooms)) {
    if (room.type === 'hydroponics' || room.type === 'water_reclaimer') room.condition = 0;
  }
  store.state.resources.food = 0;
  store.state.resources.water = 0;

  // Two hours in, this silo has been without food or water throughout.
  store.state.meta.lastSaveTs = T0;
  const r = runCatchup(store, game, { now: T0 + 2 * HOUR });

  if (!r) {
    fail('a two-hour absence produced no report at all');
  } else {
    const checks = [
      [typeof r.headline === 'string' && r.headline.length > 20, 'headline is a readable sentence'],
      [r.daysElapsed === r.toDay - r.fromDay && r.daysElapsed > 0, 'day range is coherent'],
      [Number.isFinite(r.population.from) && Number.isFinite(r.population.to), 'population figures are finite'],
      [Object.keys(r.resourceDelta).length > 0, 'resource deltas are recorded'],
      [Array.isArray(r.entries) && r.entries.length > 0, 'the log entries came through'],
      [r.mode === 'coarse', `mode is coarse (got "${r.mode}")`],
      [!r.capped, 'two hours is not capped'],
    ];
    for (const [pass, label] of checks) {
      if (!pass) fail(`report: ${label} — failed`);
    }

    if (!r.deaths.length) {
      fail('a starving silo reported no deaths in two hours');
    } else {
      const unnamed = r.deaths.filter((d) => !d.name || !d.cause || d.cause === 'unknown');
      if (unnamed.length) {
        fail(`${unnamed.length} deaths in the report have no name or no cause`);
      } else {
        ok(`report names all ${r.deaths.length} deaths with causes`);
      }
      const bad = r.deaths.filter((d) => !/\w+ \w+/.test(d.text) || !d.text.includes(d.cause));
      if (bad.length) fail(`death text does not read as a sentence: "${bad[0].text}"`);
    }

    ok(`report reads: "${r.headline}"`);
    console.log(`      ${describeAbsence(r.elapsedMs)} away · days ${r.fromDay}→${r.toDay} · ` +
      `pop ${r.population.from}→${r.population.to} · ` +
      `${Object.keys(r.resourceDelta).length} stores moved · ${r.computeMs}ms to compute`);
    const sample = r.deaths.slice(0, 2).concat(r.alerts.slice(0, 1));
    for (const s of sample) console.log(`      · ${s.text}`);
  }
}

// ---------------------------------------------------------------------------
// 4. THE CAP — long absences simulate twelve hours and stop
// ---------------------------------------------------------------------------
{
  const AWAY_MS = 3 * 24 * HOUR;
  if (classify(AWAY_MS) !== 'capped') fail(`three days should classify as "capped"`);

  const { store, game } = freshSilo();
  store.state.meta.lastSaveTs = T0;
  const r = runCatchup(store, game, { now: T0 + AWAY_MS });

  if (!r.capped) fail('a three-day absence was not marked as capped');
  if (r.simulatedMs !== BAL.catchup.capMs) {
    fail(`simulated ${r.simulatedMs}ms, expected the ${BAL.catchup.capMs}ms cap`);
  }
  const expectedDays = Math.floor(BAL.catchup.capMs / (BAL.time.TICK_MS * TIME.ticksPerDay));
  if (Math.abs(r.daysElapsed - expectedDays) > 1) {
    fail(`capped run advanced ${r.daysElapsed} days, expected about ${expectedDays}`);
  } else {
    ok(`three days away simulates exactly ${r.daysElapsed} game days and says so`);
  }
  if (!/twelve hours/i.test(r.headline)) fail(`capped headline should say so: "${r.headline}"`);
  else ok(`capped headline: "${r.headline}"`);
}

// ---------------------------------------------------------------------------
// 5. SAVE ROUND-TRIP — export/import and migration
// ---------------------------------------------------------------------------
{
  const { store, game } = freshSilo();
  game.runDays(6);
  const original = store.state;

  const text = exportSave(original);
  const restored = importSave(text);

  // Infinity is a legitimate cap (chits) and must survive the JSON round-trip.
  if (restored.caps.chits !== Infinity) {
    fail(`the uncapped chits cap did not survive export/import (got ${restored.caps.chits})`);
  } else {
    ok('Infinity survives the JSON export/import round-trip');
  }

  const d = diff(comparable({ ...original, flows: {} }), comparable(restored));
  if (d.length) fail(`export/import lost state:\n      ${d.join('\n      ')}`);
  else ok(`export/import is lossless (${(text.length / 1024).toFixed(0)} KB for ${original.citizenIds.length} residents)`);

  // Spec §3.5 budgets 500 KB serialised at 200 population.
  const kb = text.length / 1024;
  const perCapita = kb / original.citizenIds.length;
  const at200 = perCapita * 200;
  if (at200 > 500) fail(`save would be ${at200.toFixed(0)} KB at 200 population, over the 500 KB budget`);
  else ok(`save size projects to ${at200.toFixed(0)} KB at 200 population (budget 500 KB)`);

  // An old save must migrate forward rather than being rejected.
  const old = JSON.parse(exportSave(original)).state;
  delete old.lastReport;
  delete old.settings.volume;
  delete old.flags.crises;
  delete old.meta.ending;
  const migrated = migrate(old, 10);
  if (migrated.meta.schemaVersion !== SCHEMA_VERSION) {
    fail(`migration left schema at ${migrated.meta.schemaVersion}, expected ${SCHEMA_VERSION}`);
  } else if (migrated.settings.volume === undefined || migrated.lastReport === undefined) {
    fail('migration did not backfill the fields it claims to');
  } else if (migrated.flags.crises === undefined || migrated.meta.ending === undefined) {
    // Without the crisis map, every crisis whose hour had passed fires at
    // once the moment an old save is opened.
    fail('migration did not backfill the Phase 9 crisis and ending fields');
  } else {
    ok(`a version-10 save migrates forward to ${SCHEMA_VERSION}`);
  }

  const summary = summarise(original);
  if (!summary.population || summary.day === undefined) fail('slot summary is missing fields');
  else ok(`slot summary: ${summary.siloName}, day ${summary.day}, ${summary.population} residents`);
}

console.log('');
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
console.log('  PASS — catch-up and persistence\n');
