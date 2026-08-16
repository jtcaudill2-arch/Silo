#!/usr/bin/env node
/**
 * levels.mjs — the levels that were built for something.
 *
 * Roughly one floor in eight of the 144 is standing there seized rather than
 * empty. The claim those levels make to the player is specific and checkable:
 * finding one hands you a room you would otherwise have to buy, at the price of
 * putting it back into service. If restoring costs as much as building, the
 * whole idea is a log entry with no consequence behind it.
 *
 * So this checks the claim, not the wiring:
 *   - every named level names a real room that fits on a floor
 *   - opening one actually leaves the room standing, at the stated condition
 *   - repairing it is materially cheaper than building the same room new
 *   - which level is where is a fact about the silo, not about the seed
 *
 * Run: node test/levels.mjs
 */

import { createStore } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { streamFor } from '../src/core/rng.js';
import { digOutcome } from '../src/sim/dig.js';
import { NAMED_LEVELS } from '../src/data/levels.js';
import { getRoom } from '../src/data/rooms.js';
import { repairCost, build } from '../src/sim/build.js';
import { tierForFloor } from '../src/sim/research.js';
import { RESEARCH_LIST } from '../src/data/research.js';
import { BAL } from '../src/config/balance.js';

/**
 * What the game really charges to put `def` up at `width` slots, found by
 * doing it: build into a scratch silo with the stores filled and sum every
 * resource the transaction takes. `build()` always places at width 1 and
 * charges the full `buildCost`, and widening means building again next door,
 * so the answer is per slot — but this asks rather than assumes.
 */
function measuredBuildCost(def, width, floorN = BAL.silo.totalFloors) {
  const store = createStore(createNewGame({ seed: 5150, now: 1 }));
  store.silent = true;
  const s = store.state;
  s.research.completed = RESEARCH_LIST.map((n) => n.id); // tier gates too, or canBuild refuses
  for (const f of s.silo.floors) f.excavated = true;
  for (const k of Object.keys(s.resources)) s.resources[k] = 1e6;
  for (const k of Object.keys(s.caps || {})) s.caps[k] = 1e6;
  const spent = {};
  for (let slot = 0; slot < width; slot++) {
    for (const a of build(s, floorN, slot, def.id)) {
      if (a.type === 'RESOURCE_DELTA') {
        for (const [k, v] of Object.entries(a.deltas || {})) if (v < 0) spent[k] = (spent[k] || 0) - v;
      }
      store.dispatch(a);
    }
  }
  return spent;
}

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

registerCoreReducers();

const floors = Object.keys(NAMED_LEVELS).map(Number).sort((a, b) => a - b);
console.log('');
console.log('  DEEPWATER — levels that were built for something');
console.log('  ' + '─'.repeat(58));
console.log(`  ${floors.length} named of ${BAL.silo.totalFloors} levels — one every ` +
  `${(BAL.silo.totalFloors / floors.length).toFixed(1)}`);
console.log('');

// ---- 1. every one is buildable in principle --------------------------------
for (const f of floors) {
  const spec = NAMED_LEVELS[f];
  const def = getRoom(spec.room);
  if (!def) {
    fail(`floor ${f} (${spec.name}) names room "${spec.room}", which does not exist`);
    continue;
  }
  if (spec.width > BAL.silo.slotsPerFloor) {
    fail(`floor ${f} (${spec.name}) is ${spec.width} wide, wider than a floor`);
  }
  if (spec.width > BAL.silo.merge.maxWidth) {
    fail(`floor ${f} (${spec.name}) is ${spec.width} wide, past the ${BAL.silo.merge.maxWidth}-slot maximum`);
  }
  // A found room has to be a shape the silo could have built. Narrower than the
  // room's natural width is not a bargain, it is a room that cannot exist —
  // floor 108 shipped a two-wide Deep Mine, which is one slot short of the
  // smallest one anybody can build.
  if (spec.width < def.width) {
    fail(`floor ${f} (${spec.name}) is ${spec.width} wide, narrower than a ${def.name} can be built (${def.width})`);
  }
  if (spec.width > def.width && !def.canMerge) {
    fail(`floor ${f} (${spec.name}) is ${spec.width} wide, but a ${def.name} cannot be merged past ${def.width}`);
  }
  if (f > BAL.silo.reachableFloors) {
    fail(`floor ${f} (${spec.name}) is below the deepest reachable floor and can never be found`);
  }
  if (spec.condition <= 0 || spec.condition >= BAL.silo.condition.start) {
    fail(`floor ${f} (${spec.name}) is at ${spec.condition}% — a found room has to be worth repairing`);
  }
  if (spec.level > BAL.silo.upgrade.maxLevel) {
    fail(`floor ${f} (${spec.name}) is level ${spec.level}, past the maximum`);
  }
}
if (!failures.length) ok(`all ${floors.length} named levels name a real room that fits`);

// ---- 2. they are spread through the silo -----------------------------------
{
  const perTier = new Map();
  for (const f of floors) {
    const key = tierForFloor(f).name;
    perTier.set(key, (perTier.get(key) || 0) + 1);
  }
  // The top band is exempt, and the exemption is the design: the Uppers were
  // lived in and stripped, and putting a reward there competes with the
  // surface chain for the first twenty floors of the game. Everything below
  // has to carry at least one, or that band is all shell.
  const [upper, ...below] = BAL.silo.tiers;
  if (perTier.has(upper.name)) {
    fail(`the ${upper.name} has ${perTier.get(upper.name)} named level(s) — that band is meant to be stripped`);
  }
  const empty = below.filter((t) => !perTier.has(t.name));
  if (empty.length) {
    fail(`no named level anywhere in the ${empty.map((t) => t.name).join(', ')} — that band is all shell`);
  } else {
    ok(`the ${upper.name} is bare by design; every band below carries one: ` +
      below.map((t) => `${t.name} ${perTier.get(t.name)}`).join(', '));
  }
}

// ---- 3. opening one leaves the room standing -------------------------------
{
  const store = createStore(createNewGame({ seed: 4242, now: 1 }));
  store.silent = true;
  let checked = 0;
  for (const f of floors) {
    const spec = NAMED_LEVELS[f];
    const outcome = digOutcome(store.state, f, streamFor(1, 'dig', f));
    if (outcome.id !== 'found') {
      fail(`floor ${f} (${spec.name}) rolled "${outcome.id}" instead of its own level`);
      continue;
    }
    store.dispatch({ type: 'EXCAVATION_COMPLETE', floor: f, outcome });
    const floor = store.state.silo.floors[f - 1];
    const id = floor.slots[0];
    const room = store.state.silo.rooms[id];
    if (!room) {
      fail(`floor ${f} (${spec.name}) opened with no room in it`);
    } else if (room.type !== spec.room) {
      fail(`floor ${f} holds a ${room.type}, expected ${spec.room}`);
    } else if (room.condition !== spec.condition) {
      fail(`floor ${f} room is at ${room.condition}%, expected ${spec.condition}%`);
    } else if (floor.slots.filter((s) => s === id).length !== spec.width) {
      fail(`floor ${f} room occupies ${floor.slots.filter((s) => s === id).length} slots, expected ${spec.width}`);
    } else {
      checked++;
    }
  }
  if (checked === floors.length) ok(`all ${checked} open with the room standing, seized, at the stated condition`);
}

// ---- 4. THE CLAIM: restoring beats building --------------------------------
{
  const store = createStore(createNewGame({ seed: 99, now: 1 }));
  store.silent = true;
  const rows = [];
  let worst = 0;
  for (const f of floors) {
    const spec = NAMED_LEVELS[f];
    const def = getRoom(spec.room);
    // With its floor, so "building one instead" means building one HERE. It
    // used to measure every build on floor 144 whatever level the found room
    // stood on, which was harmless while price did not depend on the floor and
    // is the kind of stand-in that stops being harmless quietly. It also turned
    // up something the old form could not see — see `buildFloor` below.
    const room = {
      type: spec.room, width: spec.width, level: spec.level, condition: spec.condition, floor: f,
    };
    const missing = BAL.silo.condition.start - spec.condition;
    const fix = repairCost(room, missing);
    // Against what the game *actually charges*, measured by building the room
    // in a live silo and totting up the resource deltas — not by calling a
    // helper. This compared `repairCost` against `buildCostFor`, and
    // `repairCost` is defined as a fraction of `buildCostFor`, so the ratio was
    // algebraically `share` and the section could not fail: a reviewer tripled
    // the helper's output and every line still printed green. Measuring the
    // real transaction is the only version of this check that is worth having.
    // Built on the level's own floor where that is legal, which is the real
    // alternative to restoring it. Where it is not, the build is measured on
    // the shallowest floor that would take one.
    //
    // Exactly one row needs that fallback and it is worth knowing about: the
    // Archive stands on floor 38 and carries `tierGate: 'lowers'`, so a player
    // cannot build one above floor 49 no matter what they spend. Finding it is
    // the only way to have an Archive in the Mids, which is a large part of
    // what that level is worth and was invisible while every build in this
    // section was measured on floor 144.
    let buildFloor = f;
    let build = measuredBuildCost(def, spec.width, buildFloor);
    if (!Object.keys(build).length && def.tierGate) {
      buildFloor = BAL.silo.tiers.find((t) => t.key === def.tierGate)?.from ?? f;
      build = measuredBuildCost(def, spec.width, buildFloor);
    }
    // Worst resource, not just scrap. A cheap-in-scrap repair that demands
    // alloy the silo cannot yet smelt is not a bargain.
    if (!Object.keys(build).length) {
      fail(`could not measure the build cost of a ${def.name} — the fixture cannot put one up, so this row proves nothing`);
      continue;
    }
    let ratio = 0;
    let drove = 'scrap';
    for (const k of new Set([...Object.keys(fix), ...Object.keys(build)])) {
      const r = (fix[k] || 0) / Math.max(1, build[k] || 0);
      if (r > ratio) { ratio = r; drove = k; }
    }
    worst = Math.max(worst, ratio);
    // Two-sided, on scrap, where the numbers are big enough that rounding does
    // not blur it. A one-sided "is it under 80%" check cannot see the pricing
    // helper being reverted, because that makes repairs *cheaper* and reads as
    // greener — a reviewer put the bug back and this section got greener.
    const missingShare = missing / BAL.silo.condition.start;
    const expected = missingShare * BAL.silo.repair.fractionOfBuildCost;
    const scrapRatio = (fix.scrap || 0) / Math.max(1, build.scrap || 0);
    if (Math.abs(scrapRatio - expected) > 0.02) {
      fail(
        `${spec.name}: restoring costs ${(scrapRatio * 100).toFixed(1)}% of a measured build, but ` +
          `${(missingShare * 100).toFixed(0)}% missing at fractionOfBuildCost ` +
          `${BAL.silo.repair.fractionOfBuildCost} should be ${(expected * 100).toFixed(1)}%`
      );
    }
    rows.push({ f, name: spec.name, drove, fix: fix[drove] || 0, build: build[drove] || 0, ratio });
  }
  rows.sort((a, b) => b.ratio - a.ratio);
  console.log('  restoring against building, worst five — worst resource of each');
  for (const r of rows.slice(0, 5)) {
    console.log(
      `    fl${String(r.f).padStart(3)}  ${r.name.padEnd(20)} ` +
        `repair ${String(r.fix).padStart(4)}  build ${String(r.build).padStart(4)}  ` +
        `${String(Math.round(r.ratio * 100)).padStart(3)}%  ${r.drove}`
    );
  }
  console.log('');
  if (worst >= 1) {
    fail(`a found room costs ${Math.round(worst * 100)}% of building it new — finding it saves nothing`);
  } else if (worst > 0.8) {
    fail(`the worst found room still costs ${Math.round(worst * 100)}% of a new one — too thin to notice`);
  } else {
    ok(`every found room restores for under ${Math.round(worst * 100)}% of building it new`);
  }
}

// ---- 5. the ending is not a lottery ----------------------------------------
//
// Every ending is behind The Origin Record, and that node wants artifacts that
// drop from two specific expedition bands. Left at that, whether a campaign
// can be finished at all is three rolls on a loot table: measured, one seed
// won on day 713 and another dug all 144 floors, finished 45 of 48 nodes, and
// could not finish, because the compact seal never dropped in 900 days.
//
// So the shaft has to be a second road to the same door. Whatever the endgame
// research needs, digging to the bottom has to be able to supply it.
{
  const need = {};
  for (const node of RESEARCH_LIST) {
    if (!node.endgame && node.id !== 'origin_record') continue;
    for (const [k, v] of Object.entries(node.artifacts || {})) {
      need[k] = Math.max(need[k] || 0, v);
    }
  }
  const fromDigging = {};
  for (const f of floors) {
    const a = NAMED_LEVELS[f].artifact;
    if (a) fromDigging[a] = (fromDigging[a] || 0) + 1;
  }
  const short = Object.entries(need).filter(([k, v]) => (fromDigging[k] || 0) < v);
  if (!Object.keys(need).length) {
    fail('no endgame node names an artifact — this check is testing nothing, so the tree moved');
  } else if (short.length) {
    fail(
      'digging the whole shaft cannot finish the game: still short ' +
        short.map(([k, v]) => `${k} ${fromDigging[k] || 0}/${v}`).join(', ')
    );
  } else {
    ok(
      'digging the shaft alone supplies the whole ending chain: ' +
        Object.entries(need).map(([k, v]) => `${k} ${fromDigging[k]}/${v}`).join(', ')
    );
  }
}

// ---- 6. the silo, not the seed ---------------------------------------------
{
  const store = createStore(createNewGame({ seed: 1, now: 1 }));
  store.silent = true;
  const f = floors[Math.floor(floors.length / 2)];
  const names = new Set();
  for (const seed of [1, 2, 3, 99, 31337]) {
    names.add(digOutcome(store.state, f, streamFor(seed, 'dig', f)).levelName);
  }
  if (names.size !== 1) fail(`floor ${f} is a different level on different seeds: ${[...names].join(', ')}`);
  else ok(`floor ${f} is ${[...names][0]} on every seed — the silo, not the roll`);
}

console.log('');
if (failures.length) {
  console.error(`✗ levels: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('  PASS — the named levels are worth opening');
