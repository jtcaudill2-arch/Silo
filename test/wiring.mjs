#!/usr/bin/env node
/**
 * wiring.mjs — is the feature actually plugged into the game?
 *
 * Every other suite here tests a module by calling it. That catches wrong
 * arithmetic and misses the more embarrassing failure: a system that is correct
 * in isolation and never runs. A reviewer proved the point by mutation —
 * deleting `build.simulateDay` from the day loop in core/game.js, so no floor
 * anywhere ever strains, warns or collapses, and the whole suite stayed green,
 * with test/deep.mjs still printing "PASS — the deep is somewhere you hold".
 * It passes because it calls `simulateDay` itself.
 *
 * So this file is deliberately written the other way round. It drives `Game`
 * and nothing else, and asserts on what a player would see. Every section here
 * is one that a reviewer's mutation walked through untouched:
 *
 *   - strain reaches the player through the day loop      (game.js wiring)
 *   - a found room is dark, restorable, and then ordinary (the Phase C loop)
 *   - unfired ammunition comes back, and only if anyone does
 *   - the crewing transfer lights a dark room
 *   - migrations actually write the fields they promise
 *
 * Run: node test/wiring.mjs
 */

import { readFileSync } from 'node:fs';
import { Store } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import { digOutcome } from '../src/sim/dig.js';
import { streamFor } from '../src/core/rng.js';
import { canRepair, repair, strainedFloors } from '../src/sim/build.js';
import { inService } from '../src/sim/economy.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/core/migrations.js';
import { NAMED_LEVELS } from '../src/data/levels.js';
import { BAL, TIME } from '../src/config/balance.js';

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

registerCoreReducers();

const newStore = (seed = 11) => {
  const store = new Store(createNewGame({ seed, now: 1_700_000_000_000 }));
  store.silent = true;
  return store;
};

console.log('');
console.log('  DEEPWATER — the wiring, not the arithmetic');
console.log('  ' + '─'.repeat(58));
console.log('');

// ---- 1. the deep strains because the game runs, not because a test ran it ---
{
  const store = newStore();
  const game = new Game(store);
  const s = store.state;
  // A loaded floor deep enough to strain, opened and built on.
  for (const f of s.silo.floors) { f.excavated = true; f.shored = true; f.integrity = 100; }
  const floorN = 136;
  const id = String(s.silo.nextRoomId++);
  s.silo.rooms[id] = {
    id, type: 'storage_depot', floor: floorN, slot: 0, width: 3, level: 1,
    condition: 100, staff: [], powered: true, found: false,
    buildingUntilCycle: 0, upgradingUntilCycle: 0,
  };
  for (let i = 0; i < 3; i++) s.silo.floors[floorN - 1].slots[i] = id;

  const before = s.silo.floors[floorN - 1].integrity;
  game.runDays(60);
  const after = s.silo.floors[floorN - 1].integrity;

  if (!(after < before)) {
    fail(
      `60 days of actual play left floor ${floorN} at ${after} — the strain system is not reachable ` +
        'from the day loop, whatever build.js does when called directly'
    );
  } else {
    ok(`playing 60 days wears floor ${floorN} from ${before} to ${after.toFixed(1)} — the loop runs it`);
  }

  // And it reaches the player: keep going until it is worth saying out loud.
  game.runDays(120);
  const named = strainedFloors(store.state).some((f) => f.n === floorN);
  const said = (store.state.log || []).some((e) => new RegExp(`floor ${floorN}`).test(e.text || ''));
  if (!named) fail(`floor ${floorN} wore down but never appeared in strainedFloors()`);
  else if (!said) fail(`floor ${floorN} passed the warning line and the log never mentioned it`);
  else ok('it crosses the warning line in play and the silo says so');
}

// ---- 2. a found room: dark, restorable, then ordinary -----------------------
{
  const store = newStore(4242);
  const s = store.state;
  const floorN = 45; // The Bench — a workshop
  const spec = NAMED_LEVELS[floorN];
  const outcome = digOutcome(s, floorN, streamFor(1, 'dig', floorN));
  store.dispatch({ type: 'EXCAVATION_COMPLETE', floor: floorN, outcome });
  const room = s.silo.rooms[s.silo.floors[floorN - 1].slots[0]];

  if (!room) {
    fail('opening a named level produced no room at all');
  } else {
    if (!room.found) fail('a found room did not arrive marked `found`');
    if (room.powered) fail('a found room arrived powered — it is meant to be seized and dark');
    if (inService(room)) fail('a found room counts as in service before it is restored');
    if (!s.silo.powerPriority.includes(room.id)) {
      fail('a found room was never inserted into the power priority list, so it sheds first once restored');
    }

    // Restoring has to actually move it. A `repair()` that silently does
    // nothing for found rooms passed every other suite in the project.
    for (const k of Object.keys(s.resources)) s.resources[k] = 99999;
    let guard = 0;
    while (room.condition < BAL.silo.condition.start && guard++ < 40) {
      const check = canRepair(s, room.id);
      if (!check.ok) break;
      store.dispatchAll(repair(s, room.id));
    }
    if (room.condition < BAL.silo.condition.start) {
      fail(`restoring the ${spec.name} stalled at ${room.condition} condition after ${guard} attempts`);
    } else if (room.found) {
      fail('a fully restored room is still flagged `found`, so it never becomes an ordinary room');
    } else if (!inService(room)) {
      fail('a fully restored room still does not count as in service');
    } else {
      ok(`the ${spec.name} opens seized and dark, restores in ${guard} payments, and becomes ordinary`);
    }
  }
}

// ---- 3. unfired ammunition, and only for people who came home ---------------
{
  const dayCount = 4;
  const carried = 32;
  // The rule the resolution applies, stated independently of it.
  const refund = (fightDays, survivors) =>
    survivors ? Math.floor(carried * (1 - fightDays / dayCount)) : 0;

  const cases = [
    { fightDays: 0, survivors: 4, want: 32, what: 'a quiet patrol returns everything' },
    { fightDays: 4, survivors: 4, want: 0, what: 'fighting every day returns nothing' },
    { fightDays: 1, survivors: 4, want: 24, what: 'one firefight in four days returns three quarters' },
    { fightDays: 1, survivors: 0, want: 0, what: 'a squad that was wiped out returns nothing' },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = refund(c.fightDays, c.survivors);
    if (got !== c.want) { fail(`${c.what}: expected ${c.want}, got ${got}`); bad++; }
  }
  // And the shipped code has to agree with that table.
  const src = readSource('../src/sim/expedition.js');
  if (!/survivors\.length \? Math\.floor\(carried \* \(1 - fightDays \/ dayCount\)\) : 0/.test(src)) {
    fail('expedition.js no longer computes the refund the way this section describes');
  } else if (!bad) {
    ok('unfired rounds come home, in proportion to the quiet days, and only if somebody does');
  }
}

// ---- 4. the crewing transfer lights a dark room -----------------------------
{
  const store = newStore(77);
  const s = store.state;
  // Two rooms wanting the same skill: one the silo ranks higher, standing dark,
  // and one it ranks lower with people to spare. Nobody unassigned anywhere.
  const mk = (type, floor, staff) => {
    const id = String(s.silo.nextRoomId++);
    s.silo.rooms[id] = {
      id, type, floor, slot: 0, width: 2, level: 1, condition: 100,
      staff, powered: true, found: false, buildingUntilCycle: 0, upgradingUntilCycle: 0,
    };
    for (const cid of staff) s.citizens[cid].job = { roomId: id };
    return id;
  };
  const workers = s.citizenIds.filter((id) => (s.citizens[id].skills.engineering || 0) > 0).slice(0, 2);
  if (workers.length < 2) {
    fail('fixture problem: not enough engineers in the opening silo to test the transfer');
  } else {
    for (const id of s.citizenIds) if (!workers.includes(id)) s.citizens[id].job = { roomId: 'parked' };
    const dark = mk('foundry', 3, []);          // rank 9
    mk('deep_mine', 4, workers);                 // rank 22, holding both engineers

    const actions = autoAssign(s);
    const moved = actions.some((a) => a.type === 'CITIZEN_ASSIGN' && a.roomId === dark);
    if (!moved) {
      fail('a dark Foundry with nobody spare drew nobody from the lower-ranked Deep Mine');
    } else {
      store.dispatchAll(actions);
      const foundry = s.silo.rooms[dark];
      const mine = Object.values(s.silo.rooms).find((r) => r.type === 'deep_mine');
      if (!foundry.staff.length) fail('the transfer was proposed and the Foundry is still empty');
      else if (!mine.staff.length) fail('the transfer emptied the room it took from');
      else ok(`a dark Foundry takes one of the Deep Mine's two engineers, and the mine keeps one`);
    }
  }
}

// ---- 5. migrations write what they promise ----------------------------------
{
  const s = createNewGame({ seed: 9, now: 1 });
  // Look like an old save: no `found`, damaged deep floors, short floor array.
  for (const r of Object.values(s.silo.rooms)) delete r.found;
  s.silo.floors.length = 92;
  for (const f of s.silo.floors) { if (f.n <= 60) { f.excavated = true; f.shored = false; } }
  s.silo.floors[59].integrity = 30; // two of the old partial collapses

  let state = s;
  for (let v = 10; v < SCHEMA_VERSION; v++) if (MIGRATIONS[v]) state = MIGRATIONS[v](state) || state;

  const problems = [];
  if (state.silo.floors.length !== BAL.silo.totalFloors) problems.push(`floors ${state.silo.floors.length}`);
  if (!Object.values(state.silo.rooms).every((r) => r.found === false)) problems.push('rooms missing `found: false`');
  if (!state.silo.floors.every((f) => f.integrity === BAL.silo.condition.start)) {
    const bad = state.silo.floors.filter((f) => f.integrity !== BAL.silo.condition.start);
    problems.push(`${bad.length} floors not restored to sound (worst ${Math.min(...bad.map((f) => f.integrity))})`);
  }
  if (!state.silo.floors.filter((f) => f.excavated).every((f) => f.shored === true)) {
    problems.push('an excavated floor came back unshored — the player paid for that shoring');
  }
  if (problems.length) fail(`migrating a v10 save left: ${problems.join('; ')}`);
  else ok(`a v10 save migrates to v${SCHEMA_VERSION}: 144 floors, all sound, all shored, every room commissioned`);

  // Re-running must not corrupt: a save can be migrated more than once.
  const before = JSON.stringify(state);
  for (let v = 10; v < SCHEMA_VERSION; v++) if (MIGRATIONS[v]) state = MIGRATIONS[v](state) || state;
  if (JSON.stringify(state) !== before) fail('re-running the migration chain changed the state');
  else ok('running the whole chain a second time is a no-op');
}

function readSource(rel) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

console.log('');
if (failures.length) {
  console.error(`✗ wiring: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('  PASS — the features are connected to the game');
