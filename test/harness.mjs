#!/usr/bin/env node
/**
 * harness.mjs — headless fast-forward test (spec §18).
 *
 * Fast-forwards a fresh silo with no rendering and asserts the things that
 * quietly break a simulation of this shape:
 *
 *   - no NaN or Infinity anywhere in state
 *   - population neither explodes nor zeroes out
 *   - the economy doesn't diverge (nothing pinned at cap forever, nothing
 *     stuck at zero forever that shouldn't be)
 *   - every death produced a log entry with a name and a cause
 *   - no action was dispatched that has no reducer
 *
 * Run after every phase:  node test/harness.mjs
 * Flags: --days=N  --seed=N  --verbose  --quiet
 */

import { createStore } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import { autopilot } from './autopilot.mjs';
import { canExcavate, startExcavation, canUpgrade, upgrade } from '../src/sim/build.js';
import { BAL, TIME } from '../src/config/balance.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const DAYS = Number(args.days ?? 100);
const SEED = Number(args.seed ?? BAL.meta.defaultSeed);
const VERBOSE = !!args.verbose;
const QUIET = !!args.quiet;

// ---------------------------------------------------------------- checks ---

const failures = [];
const warnings = [];

function fail(msg) {
  failures.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

/**
 * Walk state looking for NaN / Infinity. Caps are exempt: chits are
 * deliberately uncapped (spec §5), so Infinity there is correct, not a bug.
 */
const INFINITY_OK = /^caps\./;

function scanNumbers(obj, path = '', seen = new Set(), out = []) {
  if (obj === null || typeof obj !== 'object') return out;
  if (seen.has(obj)) return out;
  seen.add(obj);
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === 'number') {
      if (Number.isNaN(v)) out.push(`${p} = NaN`);
      else if (!Number.isFinite(v) && !INFINITY_OK.test(p)) out.push(`${p} = ${v}`);
    } else if (typeof v === 'object') {
      scanNumbers(v, p, seen, out);
    }
    if (out.length > 40) return out;
  }
  return out;
}

// ------------------------------------------------------------------ run ---

registerCoreReducers();

/**
 * Fast-forward one silo. `scenario: 'sufficient'` starts from a silo that has
 * already solved its opening problems — that's the configuration that can
 * actually run 100 days, so it's the one divergence is measured against. The
 * default six-room start is a deliberately unsustainable opening position and
 * is only run as a short smoke test.
 */
function run(label, { days, seed, scenario, expectSurvival, play }) {
  const store = createStore(createNewGame({ seed, scenario, now: 1_700_000_000_000 }));
  store.silent = true; // no UI attached
  const game = new Game(store);

  // Staff the silo the way a player would in the first thirty seconds.
  store.dispatchAll(autoAssign(store.state));

  const t0 = Date.now();
  const samples = [];
  let peakPop = store.state.citizenIds.length;
  let minPop = peakPop;

  for (let d = 0; d < days; d++) {
    game.runDays(1);
    if (play) {
      // A player makes several decisions a day, not one; run the pass a few
      // times so a build order and a research start can land together.
      for (let i = 0; i < 3; i++) store.dispatchAll(play(store.state));
    }
    const s = store.state;
    const pop = s.citizenIds.length;
    peakPop = Math.max(peakPop, pop);
    minPop = Math.min(minPop, pop);

    samples.push({
      day: s.clock.day,
      pop,
      food: round(s.resources.food),
      water: round(s.resources.water),
      power: round(s.resources.power),
      scrap: round(s.resources.scrap),
      fuel: round(s.resources.fuel),
      air: round(s.air.quality),
      order: round(s.order.value),
      morale: round(avg(s.citizenIds.map((id) => s.citizens[id].morale))),
      health: round(avg(s.citizenIds.map((id) => s.citizens[id].health))),
      deaths: s.stats.deaths,
      births: s.stats.births,
    });

    if (VERBOSE) {
      const r = samples[samples.length - 1];
      console.log(
        `  d${String(r.day).padStart(3)}  pop ${String(r.pop).padStart(3)}  food ${pad(r.food)}  ` +
          `water ${pad(r.water)}  pwr ${pad(r.power)}  air ${pad(r.air)}  ord ${pad(r.order)}  ` +
          `mor ${pad(r.morale)}  hp ${pad(r.health)}  †${r.deaths} +${r.births}`
      );
    }
    if (pop === 0) break;
  }

  const elapsed = Date.now() - t0;
  const s = store.state;
  const tag = `[${label}]`;

  // ---- invariants that must hold in every scenario ----------------------
  const nans = scanNumbers(s);
  if (nans.length) fail(`${tag} non-finite numbers in state:\n    ${nans.slice(0, 12).join('\n    ')}`);

  if (store.unknownActionTypes.size) {
    fail(`${tag} actions dispatched with no reducer: ${[...store.unknownActionTypes].join(', ')}`);
  }

  if (peakPop > BAL.citizens.startPopulation * 4) {
    fail(`${tag} population exploded: peaked at ${peakPop}`);
  }

  // Every death must be in the log, by name and cause (spec §18).
  const dead = Object.values(s.citizens).filter((c) => c.status === 'dead');
  for (const c of dead) {
    if (!c.causeOfDeath) fail(`${tag} citizen ${c.id} is dead with no cause`);
  }
  if (s.log.length < BAL.meta.logMaxEntries) {
    const logged = new Set(s.log.filter((e) => e.data?.cause).map((e) => e.data.citizenId));
    const missing = dead.filter((c) => !logged.has(c.id));
    if (missing.length) {
      fail(
        `${tag} ${missing.length} citizens died with no log entry ` +
          `(e.g. ${missing[0].firstName} ${missing[0].lastName})`
      );
    }
  }

  // Caps must hold, nothing may go negative.
  for (const [k, v] of Object.entries(s.resources)) {
    const cap = s.caps[k] ?? Infinity;
    if (v > cap + 0.001) fail(`${tag} ${k} exceeded its cap: ${v} > ${cap}`);
    if (v < -1e-9) fail(`${tag} ${k} went negative: ${v}`);
  }

  // Room / floor / staff bookkeeping.
  for (const room of Object.values(s.silo.rooms)) {
    const floor = s.silo.floors[room.floor - 1];
    for (let i = 0; i < room.width; i++) {
      if (floor.slots[room.slot + i] !== room.id) {
        fail(`${tag} room ${room.id} (${room.type}) does not own slot ${room.slot + i} on floor ${room.floor}`);
      }
    }
    for (const cid of room.staff) {
      const c = s.citizens[cid];
      if (!c) fail(`${tag} room ${room.id} staffed by unknown citizen ${cid}`);
      else if (c.status === 'dead') fail(`${tag} room ${room.id} still staffed by dead citizen ${cid}`);
    }
  }
  for (const id of s.citizenIds) {
    const c = s.citizens[id];
    if (!c.job) continue;
    const room = s.silo.rooms[c.job.roomId];
    if (!room) fail(`${tag} citizen ${id} assigned to missing room ${c.job.roomId}`);
    else if (!room.staff.includes(id)) fail(`${tag} citizen ${id} in room ${room.id} which does not list them`);
  }

  // ---- scenario-specific expectations -----------------------------------
  if (expectSurvival) {
    if (minPop === 0) fail(`${tag} population hit zero — a sufficient silo must not die`);
    else if (minPop < BAL.citizens.startPopulation * 0.6) {
      fail(`${tag} population collapsed to ${minPop} from ${BAL.citizens.startPopulation}`);
    }
    const tail = samples.slice(-20);
    for (const key of ['food', 'water', 'fuel']) {
      if (tail.length === 20 && tail.every((r) => r[key] <= 0)) {
        fail(`${tag} ${key} pinned at zero for the last 20 days`);
      }
    }
    if (s.air.quality <= BAL.air.healthDecayBelow) {
      fail(`${tag} air quality fell to ${round(s.air.quality)} in a silo with spare filtration`);
    }
  }

  report(label, samples, s, store, { elapsed, days, seed, peakPop, minPop });
  return { store, samples, state: s, game };
}

function report(label, samples, s, store, info) {
  if (QUIET || !samples.length) return;
  const first = samples[0];
  const lastS = samples[samples.length - 1];
  console.log('');
  console.log(`  DEEPWATER — ${label}`);
  console.log('  ' + '─'.repeat(58));
  console.log(
    `  seed ${info.seed}   ${samples.length} game days   ${(info.elapsed / 1000).toFixed(2)}s wall   ` +
      `${(samples.length * TIME.cyclesPerDay).toLocaleString()} cycles   ` +
      `${store.actionCount.toLocaleString()} actions`
  );
  console.log('');
  console.log(`                 day 1     →  day ${lastS.day}`);
  row('population', first.pop, lastS.pop);
  row('food', first.food, lastS.food);
  row('water', first.water, lastS.water);
  row('power', first.power, lastS.power);
  row('fuel', first.fuel, lastS.fuel);
  row('scrap', first.scrap, lastS.scrap);
  row('air quality', first.air, lastS.air);
  row('order', first.order, lastS.order);
  row('avg morale', first.morale, lastS.morale);
  row('avg health', first.health, lastS.health);
  console.log('');
  console.log(
    `  births ${s.stats.births}   deaths ${s.stats.deaths}   ` +
      `peak pop ${info.peakPop}   min pop ${info.minPop}`
  );
  const causes = Object.entries(s.stats.causes).sort((a, b) => b[1] - a[1]);
  if (causes.length) console.log('  causes: ' + causes.map(([k, v]) => `${k} ×${v}`).join(', '));
  const deaths = s.log.filter((e) => e.kind === 'death').slice(-3);
  for (const e of deaths) console.log(`    d${e.day}  ${e.text}`);
}

function row(label, a, b) {
  const arrow = b > a ? '↑' : b < a ? '↓' : ' ';
  console.log(`  ${label.padEnd(14)} ${pad(a)}   ${arrow}  ${pad(b)}`);
}
function pad(v) {
  return String(v).padStart(7);
}
function round(v) {
  return Math.round((v ?? 0) * 10) / 10;
}
function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ----------------------------------------------------------------- main ---

run('stability — sufficient silo', {
  days: DAYS,
  seed: SEED,
  scenario: 'sufficient',
  expectSurvival: true,
});

run('opening — six-room start, no intervention', {
  days: Math.min(DAYS, 18),
  seed: SEED,
  scenario: 'default',
  expectSurvival: false,
});

// The claim that matters for Phase 4: the real opening position is solvable.
// A passive run can only prove it's lethal.
const played = run('opening — six-room start, played', {
  days: DAYS,
  seed: SEED,
  scenario: 'default',
  expectSurvival: true,
  play: autopilot,
});

{
  const store = played.store;
  const s = store.state;
  const built = Object.keys(s.silo.rooms).length;
  const done = s.research.completed.length;
  const merged = Object.values(s.silo.rooms).filter((r) => r.width > 1).length;

  if (built <= 6) fail(`[played] the autopilot built nothing (${built} rooms)`);
  if (!done) fail(`[played] no research completed in ${DAYS} days`);
  if (!merged) fail('[played] nothing ever merged — the merge path is untested');

  // Excavation and upgrade are driven directly rather than inferred from the
  // autopilot's choices: whether a heuristic player happens to want another
  // floor is not a fact about the game, but whether digging one works is.
  store.dispatch({ type: 'RESOURCE_DELTA', deltas: { scrap: 600, parts: 80, alloy: 60, chits: 400 } });
  const beforeDug = s.silo.floors.filter((f) => f.excavated).length;
  // The gate research may not have landed yet at short --days; grant it, since
  // what's under test is whether digging works, not how fast a heuristic
  // player gets there.
  if (!s.research.completed.includes('deep_excavation_1')) {
    store.dispatch({ type: 'RESEARCH_COMPLETE', id: 'deep_excavation_1' });
  }
  const dig = canExcavate(s);
  if (!dig.ok) {
    fail(`[played] cannot excavate after ${DAYS} days of build-out: ${dig.reason}`);
  } else {
    store.dispatchAll(startExcavation(s));
    if (!s.silo.excavating) fail('[played] excavation was ordered but never started');
    played.game.runDays(3);
    const afterDug = s.silo.floors.filter((f) => f.excavated).length;
    if (afterDug !== beforeDug + 1) {
      fail(`[played] excavation did not complete (${beforeDug} → ${afterDug} floors)`);
    } else if (s.silo.excavating) {
      fail('[played] excavation completed but the dig was never cleared');
    }
  }

  // Same for upgrades: drive one and check it actually raises the level.
  const target = Object.values(s.silo.rooms).find(
    (r) => r.level < BAL.silo.upgrade.maxLevel && canUpgrade(s, r.id).ok
  );
  if (!target) {
    fail('[played] nothing in the silo could be upgraded — the upgrade path is untested');
  } else {
    const before = target.level;
    store.dispatchAll(upgrade(s, target.id));
    played.game.runDays(2);
    if (s.silo.rooms[target.id].level !== before + 1) {
      fail(`[played] upgrade did not apply (level ${before} → ${s.silo.rooms[target.id].level})`);
    }
  }

  if (!QUIET) {
    console.log('');
    console.log(
      `  built ${built} rooms (${merged} merged wide), ` +
        `dug ${s.silo.floors.filter((f) => f.excavated).length} floors, ` +
        `${s.research.completed.length} research nodes, ${Math.floor(s.research.points)} RP banked`
    );
    console.log('  researched: ' + s.research.completed.join(', '));
  }
}

console.log('');
for (const w of warnings) console.log(`  ! ${w}`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
if (!QUIET) console.log('  PASS\n');
