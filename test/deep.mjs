#!/usr/bin/env node
/**
 * deep.mjs — the deep as somewhere you hold.
 *
 * Before this the bottom of the silo was dangerous for one day, the day the
 * seal came off, and free for ever afterwards. A hundred and forty-four levels
 * were a list of things the player had done. The claim now is narrower and
 * checkable: a floor you have loaded with machinery is a floor you are holding,
 * and if you stop holding it you lose what is on it.
 *
 * So this checks the bargain, not the plumbing:
 *   - an empty deep floor costs nothing to keep, for ever
 *   - a loaded one runs down, faster the deeper it is
 *   - the player is told, with enough time left to act on it
 *   - shoring is a real lever and not a toll: it must buy back more time than
 *     it costs to earn
 *   - a floor that goes takes what is on it, and the loss is recoverable
 *   - the Uppers never strain, whatever is built there
 *
 * Run: node test/deep.mjs
 */

import { createStore } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { streamFor } from '../src/core/rng.js';
import { simulateDay, canShore, shoreFloor, shoreCost, strainedFloors } from '../src/sim/build.js';
import { topDirective, directives } from '../src/sim/directives.js';
import { BAL } from '../src/config/balance.js';

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

registerCoreReducers();

const LINE = BAL.silo.excavation.shoringRequiredBelowFloor;
const S = BAL.silo.strain;

/** A silo with the whole shaft open and `slots` of machinery on `floorN`. */
function siloWith(floorN, slots, { shored = true, seed = 7 } = {}) {
  const store = createStore(createNewGame({ seed, now: 1 }));
  store.silent = true;
  const s = store.state;
  for (const f of s.silo.floors) {
    f.excavated = true;
    f.shored = true;
    f.integrity = BAL.silo.condition.start;
  }
  if (floorN != null) {
    const floor = s.silo.floors[floorN - 1];
    floor.shored = shored;
    let placed = 0;
    while (placed < slots) {
      const width = Math.min(BAL.silo.merge.maxWidth, slots - placed);
      const id = String(s.silo.nextRoomId++);
      s.silo.rooms[id] = {
        id, type: 'storage_depot', floor: floorN, slot: placed, width,
        level: 1, condition: 100, staff: [], powered: true, found: false,
        buildingUntilCycle: 0, upgradingUntilCycle: 0,
      };
      for (let i = 0; i < width; i++) floor.slots[placed + i] = id;
      placed += width;
    }
  }
  return store;
}

/** Run days until `stop` says so, or `cap` days pass. Returns the day count. */
function runUntil(store, stop, cap = 4000) {
  for (let d = 1; d <= cap; d++) {
    store.state.clock.day = d;
    store.dispatchAll(simulateDay(store.state, streamFor(store.state.meta.seed, 'structure', d)));
    if (stop(store.state, d)) return d;
  }
  return null;
}

const integrityOf = (store, n) => store.state.silo.floors[n - 1].integrity;

console.log('');
console.log('  DEEPWATER — holding the deep');
console.log('  ' + '─'.repeat(58));
console.log(`  shoring line at floor ${LINE} of ${BAL.silo.totalFloors}`);
console.log('');

// ---- 1. an empty floor holds itself ----------------------------------------
{
  const store = siloWith(null, 0);
  runUntil(store, () => false, 600);
  const worn = store.state.silo.floors.filter(
    (f) => f.integrity < BAL.silo.condition.start
  );
  if (worn.length) {
    fail(`${worn.length} empty floors lost integrity in 600 days — digging would be a standing tax`);
  } else {
    ok('600 days: every empty floor of the shaft is still sound — depth alone costs nothing');
  }
}

// ---- 2. a loaded one runs down, and faster the deeper it is -----------------
{
  const rows = [];
  for (const n of [40, 60, 90, 110, 136]) {
    const store = siloWith(n, 6);
    const died = runUntil(store, (s) => s.silo.floors[n - 1].integrity <= 0);
    const warned = siloWith(n, 6);
    const warnDay = runUntil(warned, (s) => s.silo.floors[n - 1].integrity < S.warnBelow);
    rows.push({ n, died, warnDay });
  }
  console.log('  a six-bay floor, shored, left alone');
  for (const r of rows) {
    console.log(
      `    floor ${String(r.n).padStart(3)}   warned day ${String(r.warnDay).padStart(4)}   ` +
        `gave way day ${String(r.died).padStart(4)}`
    );
  }
  console.log('');
  if (rows.some((r) => r.died == null)) {
    fail('a fully loaded deep floor never gave way — the deep is still free to hold');
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].died >= rows[i - 1].died) {
      fail(`floor ${rows[i].n} lasted as long as floor ${rows[i - 1].n} — depth is not the dial`);
    }
  }
  if (!failures.length) ok('every loaded deep floor runs down, and each band runs down faster than the one above');

  // The warning has to be worth having.
  for (const r of rows) {
    const notice = r.died - r.warnDay;
    if (notice < 30) {
      fail(`floor ${r.n} gave the player ${notice} days between the warning and the collapse — not enough to act`);
    }
  }
  const least = Math.min(...rows.map((r) => r.died - r.warnDay));
  if (least >= 30) ok(`the warning always lands at least ${least} days before the floor goes`);
}

// ---- 3. holding less costs less --------------------------------------------
{
  const heavy = siloWith(136, 6);
  const light = siloWith(136, 2);
  const heavyDied = runUntil(heavy, (s) => s.silo.floors[135].integrity <= 0);
  const lightDied = runUntil(light, (s) => s.silo.floors[135].integrity <= 0);
  if (!(lightDied > heavyDied * 2)) {
    fail(`two bays on floor 136 lasted ${lightDied} days against ${heavyDied} for six — the load barely matters`);
  } else {
    ok(`load is the dial too: two bays on floor 136 last ${lightDied} days, six last ${heavyDied}`);
  }
}

// ---- 4. shoring is a lever, not a toll -------------------------------------
{
  // A fresh floor's whole life, for comparison.
  const fresh = runUntil(siloWith(136, 6), (s) => s.silo.floors[135].integrity <= 0);

  const store = siloWith(136, 6);
  const worn = runUntil(store, (s) => s.silo.floors[135].integrity < S.warnBelow);
  const leftIfIgnored = fresh - worn;
  const cost = shoreCost(store.state, 136);
  const check = canShore(store.state, 136);
  if (!check.ok) {
    fail(`a worn floor 136 could not be shored: ${check.reason}`);
  } else {
    store.dispatchAll(shoreFloor(store.state, 136));
    const back = integrityOf(store, 136);
    if (back < BAL.silo.condition.start) {
      fail(`shoring floor 136 left it at ${back}, not sound`);
    } else {
      // The claim is that shoring resets the clock rather than nudging it: a
      // floor with sixty days left becomes a floor with a full life again.
      const after = runUntil(store, (s) => s.silo.floors[135].integrity <= 0);
      if (after == null || after <= leftIfIgnored) {
        fail(`shoring bought ${after} days against the ${leftIfIgnored} the floor already had — not a lever`);
      } else if (after < fresh - 1) {
        fail(`a shored floor lasts ${after} days against ${fresh} for a fresh one — the reset is partial`);
      } else {
        ok(
          `shoring floor 136 costs ${cost.alloy} alloy and ${cost.scrap} scrap, and turns ` +
            `${leftIfIgnored} days left into a full ${after}`
        );
      }
    }
  }
}

// ---- 5. a floor that goes takes what is on it, and can be had back ----------
{
  const store = siloWith(110, 6);
  const day = runUntil(store, (s) => s.silo.floors[109].integrity <= 0);
  const s = store.state;
  const floor = s.silo.floors[109];
  const on = Object.values(s.silo.rooms).filter((r) => r.floor === 110);
  if (floor.shored) fail('the floor came down and the shoring is somehow still standing');
  if (on.some((r) => !r.breached)) {
    fail(`floor 110 came down on day ${day} and ${on.filter((r) => !r.breached).length} rooms are unmarked`);
  }
  const said = (s.log || []).some((e) => /floor 110/.test(e.text || '') && /come down|failed/.test(e.text || ''));
  if (!said) fail('the floor came down and the log does not say so');

  // Recoverable: shoring it again is possible and is what makes it worth anything.
  const back = canShore(s, 110);
  if (!back.ok && !/Not enough/.test(back.reason)) {
    fail(`a collapsed floor cannot be shored again: ${back.reason}`);
  }
  if (!failures.length || said) {
    ok(`floor 110 gave way on day ${day}: shoring gone, all ${on.length} rooms breached, and it can be shored again`);
  }
}

// ---- 6. an unshored floor is a countdown -----------------------------------
{
  const held = siloWith(110, 6, { shored: true });
  const lost = siloWith(110, 6, { shored: false });
  const a = runUntil(held, (st) => st.silo.floors[109].integrity <= 0);
  const b = runUntil(lost, (st) => st.silo.floors[109].integrity <= 0);
  if (!(b * 2 < a)) {
    fail(`an unshored floor lasted ${b} days against ${a} shored — shoring is not doing enough`);
  } else {
    ok(`a floor whose shoring has gone runs down in ${b} days against ${a} — the collapse is a countdown`);
  }
}

// ---- 7. the silo says which floor, and says it in time ----------------------
{
  const store = siloWith(136, 6);
  runUntil(store, (s) => s.silo.floors[135].integrity < S.warnBelow);
  const listed = strainedFloors(store.state);
  if (!listed.length || listed[0].n !== 136) {
    fail(`strainedFloors did not name floor 136: ${JSON.stringify(listed)}`);
  }
  // Drive it to the edge and check the order is on the board and names the place.
  runUntil(store, (s) => s.silo.floors[135].integrity < 10);
  const all = directives(store.state);
  const shore = all.find((d) => d.id === 'shore');
  if (!shore) {
    fail('a floor about to come down produced no standing order');
  } else if (shore.floor !== 136) {
    fail(`the shoring order points at floor ${shore.floor}, not the one that is failing`);
  } else {
    const rank = all.indexOf(shore);
    ok(`the order names the floor — "${shore.text}", rank ${rank + 1} of ${all.length} at ${Math.round(integrityOf(store, 136))} integrity`);
  }
}

// ---- 8. the lit part of the silo stays safe --------------------------------
{
  const store = siloWith(LINE - 1, 6);
  runUntil(store, () => false, 900);
  const above = store.state.silo.floors
    .filter((f) => f.n < LINE)
    .filter((f) => f.integrity < BAL.silo.condition.start);
  if (above.length) {
    fail(`${above.length} floors above the shoring line lost integrity — the lit part of the silo is not meant to strain`);
  } else {
    ok(`900 days: nothing above floor ${LINE} strains, however much is built on it`);
  }
  const check = canShore(store.state, LINE - 1);
  if (check.ok) fail(`floor ${LINE - 1} accepted shoring it does not need`);
}

// ---- 9. same silo, same day ------------------------------------------------
{
  const days = [1, 2, 3].map(() => {
    const store = siloWith(120, 6, { seed: 99 });
    return runUntil(store, (s) => s.silo.floors[119].integrity <= 0);
  });
  if (new Set(days).size !== 1) fail(`floor 120 gave way on days ${days.join(', ')} — not deterministic`);
  else ok(`floor 120 gives way on day ${days[0]} every time — the shaft, not the roll`);
}

console.log('');
if (failures.length) {
  console.error(`✗ deep: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('  PASS — the deep is somewhere you hold');
