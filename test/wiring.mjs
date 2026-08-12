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
 * So this file is deliberately written the other way round: it asserts on
 * outcomes a player would see rather than on a function's return value, and
 * where a system is reachable from the day loop it goes through `Game` (§1).
 * The rest drive the real entry points — the excavation reducer, a resolved
 * expedition, `autoAssign`, the migration chain — because that is where those
 * features are invoked from. Every section here is one that a reviewer's
 * mutation walked through untouched:
 *
 *   - strain reaches the player through the day loop      (game.js wiring)
 *   - a found room is dark, restorable, and then ordinary (the Phase C loop)
 *   - unfired ammunition comes back, and only if anyone does
 *   - the crewing transfer lights a dark room, and obeys its two safety rules
 *   - the origin route down is a route and not a formality
 *   - a seized room provides nothing, anywhere
 *   - salvage, which nothing in this project had ever executed
 *   - a pending raid resolves, and cannot outlive its own resolution
 *   - a conquest advances all four stages through the player's own path
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
import { directives } from '../src/sim/directives.js';
import { readEnvironment } from '../src/sim/population.js';
import { gearStorageCap } from '../src/sim/military.js';
import { computeCaps, staffSlots } from '../src/sim/economy.js';
import { getRoom, ROOM_LIST } from '../src/data/rooms.js';
import { RESEARCH_LIST } from '../src/data/research.js';
import { build as buildRoom } from '../src/sim/build.js';
import { digOutcome } from '../src/sim/dig.js';
import { streamFor } from '../src/core/rng.js';
import { canRepair, repair, strainedFloors, canDemolish, canUpgrade } from '../src/sim/build.js';
import { resolveExpedition, supplyCost, BANDS } from '../src/sim/expedition.js';
import { inService } from '../src/sim/economy.js';
import { tierUnlocked } from '../src/sim/research.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/core/migrations.js';
import { NAMED_LEVELS } from '../src/data/levels.js';
import { launchConquest, canLaunch, airlockCapacity } from '../src/sim/expedition.js';
import { canLaunchRun, nextStage, garrisonForce, accumulate, resolveRun as resolveConquestRun } from '../src/sim/conquest.js';
import { resolve as resolveCombat, unitPower } from '../src/sim/combat.js';
import { conquestState, simulateTick as diploTick } from '../src/sim/diplomacy.js';
import { playerPower, simulateDay as worldDay } from '../src/sim/world.js';
import { formSquad } from '../src/sim/military.js';
import { placeRoom } from '../src/core/newgame.js';
import * as raid from '../src/sim/raid.js';
import { BAL, TIME } from '../src/config/balance.js';

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

registerCoreReducers();

/** What the game really charges for `type` at `width` slots, by doing it. */
function measuredBuild(type, width) {
  const store = newStore(5150);
  const s = store.state;
  s.research.completed = RESEARCH_LIST.map((n) => n.id);
  for (const f of s.silo.floors) f.excavated = true;
  for (const k of Object.keys(s.resources)) s.resources[k] = 1e6;
  for (const k of Object.keys(s.caps || {})) s.caps[k] = 1e6;
  const spent = {};
  for (let slot = 0; slot < width; slot++) {
    for (const a of buildRoom(s, BAL.silo.totalFloors, slot, type)) {
      if (a.type === 'RESOURCE_DELTA') {
        for (const [k, v] of Object.entries(a.deltas || {})) if (v < 0) spent[k] = (spent[k] || 0) - v;
      }
      store.dispatch(a);
    }
  }
  return spent;
}

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
  // The strain sentence specifically. Matching /floor 136/ matched an ordinary
  // room-condition alert from a different system, so deleting the warning
  // entirely left this green.
  const said = (store.state.log || []).some(
    (e) => new RegExp(`shoring on floor ${floorN} is working|floor ${floorN} is coming apart`).test(e.text || '')
  );
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
//
// This section used to assert against a lambda defined four lines above it and
// then regex the source of expedition.js. A reviewer put the refund back the
// way it was, left the sentence the regex wanted as a *comment*, and the check
// stayed green; deleting the payout entirely (`if (false && unfired > 0)`) also
// stayed green. So it resolves real expeditions now and reads the ammunition
// out of the actions, which is the only thing that cannot be faked.
{
  const band = BANDS[1];
  const days = band.travelDays;

  // Find one expedition that comes home and one where nobody does, by asking.
  const run = (seed, size, weak) => {
    const store = newStore(seed);
    const s = store.state;
    const roster = s.citizenIds.slice(0, size);
    if (weak) {
      for (const id of roster) {
        s.citizens[id].health = 12;
        s.citizens[id].skills.combat = 0;
        s.citizens[id].gear = { weapon: null, armor: null, suit: null };
      }
    }
    const exp = {
      id: 1, squadId: 0, band: band.key, target: null, purpose: 'salvage',
      launchDay: 1, returnDay: 1 + days, roster, leaderId: roster[0], resolved: false,
    };
    const res = resolveExpedition(s, exp);
    const ammo = res.actions
      .filter((a) => a.type === 'RESOURCE_DELTA' && a.deltas?.ammo > 0)
      .reduce((n, a) => n + a.deltas.ammo, 0);
    return { ammo, survivors: res.survivors.length, size, carried: supplyCost(band, size).ammo };
  };

  let lived = null;
  let wiped = null;
  for (let seed = 1; seed <= 400 && (!lived || !wiped); seed++) {
    const r = run(seed, 4, true);
    if (!wiped && r.survivors === 0) wiped = { ...r, seed };
    if (!lived && r.survivors > 0 && r.ammo > 0) lived = { ...r, seed };
  }

  if (!wiped) {
    fail('could not produce a wiped-out expedition in 400 seeds — this section is not testing anything');
  } else if (wiped.ammo !== 0) {
    fail(
      `a squad annihilated on the way out still posted ${wiped.ammo} of ${wiped.carried} rounds home ` +
        `(seed ${wiped.seed})`
    );
  } else if (!lived) {
    fail('no surviving expedition ever refunded a round — the payout is not reaching the silo');
  } else if (lived.ammo > lived.carried) {
    fail(`a returning squad refunded ${lived.ammo} rounds of the ${lived.carried} it carried`);
  } else {
    ok(
      `resolved live expeditions: a wipe returns 0 of ${wiped.carried} rounds, a survivor returns ` +
        `${lived.ammo} of ${lived.carried}`
    );
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

// ---- 4b. the transfer's two safety rules ------------------------------------
//
// Both were measured into existence and neither was asserted: a reviewer
// removed the dark-room-only rule and the never-strip-the-source rule and the
// whole suite stayed green. The first is what stops crews churning every call
// (it moved the Surface panel from day 50 to 67); the second is what stops a
// transfer creating the dark room it is trying to fill.
{
  const mk = (seed) => {
    const store = newStore(seed);
    const s = store.state;
    const place = (type, floor, staff) => {
      const id = String(s.silo.nextRoomId++);
      s.silo.rooms[id] = {
        id, type, floor, slot: 0, width: 2, level: 1, condition: 100,
        staff, powered: true, found: false, buildingUntilCycle: 0, upgradingUntilCycle: 0,
      };
      for (const cid of staff) s.citizens[cid].job = { roomId: id };
      return id;
    };
    return { store, s, place };
  };

  // (a) never move into a room that already has somebody.
  {
    const { s, place } = mk(77);
    const eng = s.citizenIds.filter((id) => (s.citizens[id].skills.engineering || 0) > 0).slice(0, 3);
    for (const id of s.citizenIds) if (!eng.includes(id)) s.citizens[id].job = { roomId: 'parked' };
    const partly = place('foundry', 3, [eng[0]]);       // rank 9, one of its posts filled
    place('deep_mine', 4, [eng[1], eng[2]]);            // rank 22, two to spare
    const moved = autoAssign(s).some((a) => a.type === 'CITIZEN_ASSIGN' && a.roomId === partly);
    if (moved) fail('a transfer fired into a room that was already running — that is the churn rule gone');
    else ok('no transfer into a room that already has crew');
  }

  // (b) never take the last person out of the source.
  {
    const { s, place } = mk(77);
    const eng = s.citizenIds.filter((id) => (s.citizens[id].skills.engineering || 0) > 0).slice(0, 1);
    for (const id of s.citizenIds) if (!eng.includes(id)) s.citizens[id].job = { roomId: 'parked' };
    place('foundry', 3, []);                            // dark, ranks higher
    const mine = place('deep_mine', 4, [eng[0]]);       // exactly one engineer
    const acts = autoAssign(s);
    if (acts.some((a) => a.type === 'CITIZEN_ASSIGN' && a.citizenId === eng[0])) {
      fail('the transfer stripped a room down to nobody to fill another — it just moved the dark room');
    } else if (s.silo.rooms[mine].staff.length !== 1) {
      fail('the source room lost its last worker');
    } else ok('a source room with one worker is left alone');
  }
}

// ---- 4c. the origin route is a route, not a formality -----------------------
{
  const withNodes = (...ids) => ({ research: { completed: ids }, silo: {} });
  const recordOnly = tierUnlocked(withNodes('origin_record'), 'foundations');
  const both = tierUnlocked(withNodes('origin_record', 'origin_systems'), 'foundations');
  const ladder = tierUnlocked(withNodes('deep_excavation_4'), 'foundations');
  if (recordOnly) {
    fail('The Origin Record alone opens the Foundations, which makes Origin Systems — 2,600 points behind it — a no-op');
  } else if (!both || !ladder) {
    fail(`the Foundations are unreachable: origin route ${both}, excavation route ${ladder}`);
  } else ok('two roads to the Foundations, and neither one is redundant');
}

// ---- 5. a seized room provides nothing, anywhere --------------------------
//
// This is the bug class that kept coming back. Every system that sums what the
// silo has was written before found rooms existed, and each one had to be
// taught separately: `has`, `count`, `running`, `openSlots`, the caps, the
// housing, the gear store, the demolish guard, the upgrade button. Patching
// them one at a time is how the headline defect survived its own fix — the
// power order was gated by a *second* census a hundred lines below the one that
// got the filter. So this sweeps the lot in one place, and any new consumer
// that forgets will fail here rather than in a campaign.
{
  const openFloor = (store, n) => {
    const s = store.state;
    for (const f of s.silo.floors) f.excavated = true;
    store.dispatch({
      type: 'EXCAVATION_COMPLETE', floor: n,
      outcome: digOutcome(s, n, streamFor(1, 'dig', n)),
    });
    return Object.values(s.silo.rooms).find((r) => r.found);
  };

  // (a) the power order: a seized Generator Hall must not silence it.
  {
    const store = newStore(31);
    const s = store.state;
    for (const f of s.silo.floors) f.excavated = true;
    let pool = s.citizenIds.slice();
    for (const r of Object.values(s.silo.rooms)) {
      const def = getRoom(r.type);
      if (def?.produces?.power && def.staff) {
        const n = staffSlots(def, r);
        r.staff = pool.splice(0, n);
        for (const c of r.staff) s.citizens[c].job = { roomId: r.id };
      }
    }
    const tight = () => { s.power = { generation: 60, demand: 59 }; };
    tight();
    const before = directives(s).some((d) => d.id === 'power');
    openFloor(store, 103); // Second Plant — a seized generator_hall
    tight();
    const after = directives(s).some((d) => d.id === 'power');
    if (!before) fail('fixture problem: the power order was not offered even before the seized hall');
    else if (!after) {
      fail('opening floor 103 silenced "Build a Generator Hall" — a seized hall is being counted as plant');
    } else ok('a seized Generator Hall does not silence the power order');
  }

  // (b) housing, gear storage and the caps.
  {
    const store = newStore(31);
    const s = store.state;
    const housed = () => readEnvironment(s).housingFree;
    const before = { housing: housed(), gear: gearStorageCap(s), caps: computeCaps(s).scrap };
    openFloor(store, 68); // The Long Gallery — a 3-wide level-2 Residences
    if (housed() !== before.housing) {
      fail(`opening floor 68 changed housing by ${housed() - before.housing} bunks for no scrap`);
    } else {
      const s2 = newStore(31);
      openFloor(s2, 96); // The Armoury
      if (gearStorageCap(s2.state) !== before.gear) fail('a seized Armoury raised gear storage');
      else ok('a seized Residences houses nobody and a seized Armoury stores nothing');
    }
  }

  // (c) it cannot stand in for a working room, and cannot be upgraded.
  {
    const store = newStore(31);
    const seized = openFloor(store, 103);
    const s = store.state;
    const working = Object.values(s.silo.rooms).find((r) => r.type === 'generator_hall' && !r.found);
    const dem = canDemolish(s, working.id);
    const up = canUpgrade(s, seized.id);
    if (dem.ok) fail('a seized Generator Hall let the silo strip out its only working one');
    else if (up.ok) fail('a seized room can be upgraded before it has ever been commissioned');
    else ok('a seized room is not a spare, and cannot be upgraded before it is restored');
  }
}

// ---- 6. salvage, which nothing in this project had ever executed ------------
{
  const store = newStore(31);
  const s = store.state;
  for (const f of s.silo.floors) f.excavated = true;
  store.dispatch({
    type: 'EXCAVATION_COMPLETE', floor: 74,
    outcome: digOutcome(s, 74, streamFor(1, 'dig', 74)),
  });
  const seized = Object.values(s.silo.rooms).find((r) => r.found);
  const free = canDemolish(s, seized.id).refund || {};

  const built = Object.values(s.silo.rooms).find((r) => r.type === 'workshop' && !r.found);
  const healthy = built ? canDemolish(s, built.id).refund || {} : null;

  if (!Object.keys(free).length && !healthy) {
    fail('could not measure a refund at all — this section proves nothing');
  } else {
    // A room nobody paid for, at 17 condition, must not pay like a new one.
    const paidFor = measuredBuild('recycling', seized.width).scrap || 1;
    const ratio = (free.scrap || 0) / paidFor;
    if (ratio > 0.15) {
      fail(`stripping a seized Recycling Plant returns ${Math.round(ratio * 100)}% of its build cost, unpaid`);
    } else if (healthy && !(healthy.scrap > 0)) {
      fail('demolishing a healthy room refunds nothing — salvage has been nerfed into uselessness');
    } else {
      ok(`salvage tracks condition: a seized plant returns ${Math.round(ratio * 100)}% of build, a healthy one pays out`);
    }
  }
}

// ---- 8. a raid resolves, and cannot outlive its own resolution --------------
//
// The defect this replaces: `PENDING_RAID` wrote `world.pendingRaid`, nothing
// read it, `RAID_RESOLVED` was dispatched from nowhere, and shell.js told the
// player "Squads defend the silo; without one, the raid takes what it wants"
// about a mechanic that did not exist. So the assertions here are about the
// *pending raid going away* and about the two branches differing — a test
// that only checked `raid.simulateDay` returns actions would have passed
// against the broken build, because the broken build's problem was that
// nothing called it.
{
  // Undefended: no squad at all.
  const store = newStore(4242);
  const s = store.state;
  const game = new Game(store);
  store.dispatchAll(autoAssign(s));
  game.runDays(2);
  const before = { scrap: s.resources.scrap, pop: s.citizenIds.length };
  store.dispatch({ type: 'PENDING_RAID', siloId: 5, strength: 0.9 });
  if (!s.world.pendingRaid) fail('PENDING_RAID did not record a pending raid');

  game.runDays(1 + BAL.raid.graceDays);
  if (s.world.pendingRaid) {
    fail('a raid was still pending after its grace day — nothing is reading world.pendingRaid');
  } else {
    ok('a pending raid is resolved by the day loop, not left standing for ever');
  }
  // A floor, not just a direction.
  //
  // `scrap < before.scrap` passed against `theft(state, 0)` — a raid that
  // carried off literally nothing — because two units of ordinary production
  // drift over the grace day satisfy it. And the floor is deliberately a hard
  // fraction rather than `BAL.raid.undefendedTheft`: a bar derived from the
  // constant collapses to zero when the constant does, which is how zeroing
  // the theft passed too. A raid that walks off with under a tenth of the
  // scrap is not the thing shell.js warns the player about.
  const RAID_TAKES_AT_LEAST = 0.1;
  const took = before.scrap - s.resources.scrap;
  if (!(took >= before.scrap * RAID_TAKES_AT_LEAST)) {
    fail(
      `an undefended raid took ${Math.round(took)} of ${Math.round(before.scrap)} scrap — under a tenth, so ` +
      'the airlock stood open and nothing meaningful left with them'
    );
  } else {
    ok(`an undefended raid costs real stores: scrap ${Math.round(before.scrap)} -> ${Math.round(s.resources.scrap)}`);
  }
  if (!s.stats.raidsLost) fail('an undefended raid was not counted as lost');

  // Every death the raid caused has to name somebody and say why. That is the
  // project's rule for every death, and a new death path is exactly where it
  // gets forgotten.
  const dead = before.pop - s.citizenIds.length;
  if (dead > 0) {
    const named = s.log.filter((e) => /came through the airlock/.test(e.text || '')).length;
    if (named < dead) fail(`${dead} died in the raid but only ${named} were named in the log`);
    else ok(`${dead} civilian deaths, each named in the log with its cause`);
    if (!s.stats.causes || !s.stats.causes['a raid']) {
      fail('raid deaths did not reach stats.causes');
    }
  }
}
{
  // Defended: the same raid, met by a squad, must come out differently.
  const store = newStore(4242);
  const s = store.state;
  const game = new Game(store);
  store.dispatchAll(autoAssign(s));
  game.runDays(2);
  store.dispatchAll(formSquad(s, 'Watch'));
  const sqId = s.military.squadIds[0];
  const adults = s.citizenIds.map((i) => s.citizens[i]).filter((c) => c.age >= 20 && c.status !== 'dead');
  for (let i = 0; i < BAL.military.squadMin + 2; i++) {
    if (adults[i]) store.dispatch({ type: 'SQUAD_MEMBER', squadId: sqId, citizenId: adults[i].id });
  }
  if (raid.defenders(s).length < BAL.military.squadMin) fail('a garrisoned squad did not count as defenders');

  const before = s.resources.scrap;
  store.dispatch({ type: 'PENDING_RAID', siloId: 6, strength: 0.2 });
  game.runDays(1 + BAL.raid.graceDays);
  if (s.world.pendingRaid) fail('a defended raid was never resolved');
  else if (!s.stats.raidsRepelled) fail('a squad met the weakest raiders and did not turn them back');
  else ok('a squad standing by turns back the weakest raiders, and it is recorded');

  const lost = before - s.resources.scrap;
  if (!(lost < before * BAL.raid.undefendedTheft)) {
    fail(`meeting the raid cost as much as ignoring it (${Math.round(lost)} of ${Math.round(before)})`);
  } else {
    ok(`meeting it costs less than ignoring it: ${Math.round(lost)} scrap against ${Math.round(before * BAL.raid.undefendedTheft)}`);
  }

  // A squad that is outside is outside. This is the cost the whole feature
  // exists to price, so it is asserted rather than assumed.
  for (const cid of s.military.squads[sqId].members) s.citizens[cid].status = 'expedition';
  if (raid.defenders(s).length !== 0) {
    fail('a squad on an expedition still counted as defending the silo');
  } else {
    ok('a squad that is outside does not defend the airlock');
  }
}

// ---- 9. a conquest advances through the player's own path -------------------
//
// `CONQUEST_PATCH` used to be dispatched from nowhere in src/ — the only
// thing that ever moved a conquest was test/conquest.mjs dispatching the
// reducer by hand, which is why the ladder could be green and impassable at
// the same time. So this drives it the way the radio panel does: gate, launch
// an expedition, run the clock, read the stage back. Nothing here dispatches
// CONQUEST_PATCH itself; if the wiring breaks, the stage stops moving.
{
  const store = newStore(0x1234);
  const s = store.state;
  const game = new Game(store);
  const TARGET = 6;
  const band = BAL.conquest.band;
  const days = BANDS.find((b) => b.key === band).travelDays;

  for (const f of s.silo.floors) f.excavated = true;
  placeRoom(s, { type: 'generator_hall', floor: 7, slot: 0, width: 3, level: 3 });
  placeRoom(s, { type: 'generator_hall', floor: 7, slot: 3, width: 3, level: 3 });
  placeRoom(s, { type: 'airlock', floor: 8, slot: 0, width: 3, level: 3 });
  store.dispatch({ type: 'RESEARCH_COMPLETE', id: 'breaching_charges' });
  store.dispatchAll(autoAssign(s));
  game.runDays(3);
  if (airlockCapacity(s) <= 0) fail('the conquest fixture never got a working airlock');
  for (const k of ['food', 'water', 'ammo', 'meds']) s.resources[k] = 9000;

  for (let n = 0; n < BAL.conquest.breachSquadsRequired; n++) store.dispatchAll(formSquad(s, `Column ${n + 1}`));
  const adults = s.citizenIds.map((i) => s.citizens[i]).filter((c) => c.age >= 20 && c.status !== 'dead');
  let k = 0;
  for (const sqId of s.military.squadIds) {
    for (let i = 0; i < BAL.military.squadMax; i++) {
      if (adults[k]) store.dispatch({ type: 'SQUAD_MEMBER', squadId: sqId, citizenId: adults[k++].id });
    }
  }
  let gid = 0;
  for (const sqId of s.military.squadIds) {
    for (const cid of s.military.squads[sqId].members) {
      for (const [kind, item] of [['suit', 'suit_4'], ['weapon', 'mag_rifle'], ['armor', 'composite_rig']]) {
        const id = 'g' + ++gid;
        s.military.gear[id] = { id, item, kind, durability: BAL.gear.durabilityMax, assignedTo: cid };
        s.citizens[cid].gear = { ...(s.citizens[cid].gear || {}), [kind]: id };
      }
    }
  }

  const seen = [];
  for (let round = 0; round < 20; round++) {
    if (s.world.silos[TARGET].contact === 'satellite') break;
    const gate = canLaunchRun(s, TARGET);
    if (!gate.ok) { fail(`conquest stalled at ${nextStage(s, TARGET)}: ${gate.reason}`); break; }
    const free = s.military.squadIds.find(
      (id) => !s.military.squads[id].deployed &&
        s.military.squads[id].members.filter((c) => s.citizens[c]?.status !== 'dead').length >= BAL.military.squadMin
    );
    if (!free) { fail('no squad was ever available for the next conquest stage'); break; }
    if (!canLaunch(s, free, band).ok) { fail(`could not launch: ${canLaunch(s, free, band).reason}`); break; }
    const acts = launchConquest(s, free, TARGET);
    if (!acts.length) { fail(`launchConquest produced nothing at stage ${gate.stage}`); break; }
    seen.push(gate.stage);
    store.dispatchAll(acts);
    game.runDays(days + 1);
  }

  for (const stage of ['scout', 'undermine', 'breach', 'hold']) {
    if (!seen.includes(stage)) fail(`the ${stage} stage was never reached by playing`);
  }
  if (seen.includes('hold')) ok(`all four stages ran from the player's own path (${seen.join(' → ')})`);

  if (s.world.silos[TARGET].contact !== 'satellite') {
    fail('a fully-prepared assault on the weakest silo never took it');
  } else {
    ok(`${s.world.silos[TARGET].name} was taken, and is a satellite`);
  }
  if (!s.world.satellites.some((x) => x.siloId === TARGET)) fail('a conquered silo was not added to the satellite list');
  if (!s.stats.silosTaken) fail('taking a silo was not recorded in stats');

  // The whole point of the garrison scaling: the target has to matter.
  //
  // Asserting `strong > weak * 3` on the two power figures would be a
  // tautology — both scale linearly off the same constant, so that ratio is
  // 95/20 whatever the constant is, and it stayed green against the original
  // 1.15 that made every silo in the game fall to four people with no
  // casualties. What broke was the *outcome*, so that is what is measured:
  // the same squad, the same seeds, against the softest and the hardest
  // garrison in the world table.
  const outcomes = (military) => {
    let wins = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const f = newStore(seed).state;
      f.clock.day = 200;
      f.resources.ammo = 9000;
      const ids = f.citizenIds.filter((i) => f.citizens[i].age >= 20).slice(0, BAL.military.squadMax);
      let g = 0;
      for (const cid of ids) {
        for (const [kind, item] of [['suit', 'suit_4'], ['weapon', 'mag_rifle'], ['armor', 'composite_rig']]) {
          const id = 'g' + ++g;
          f.military.gear[id] = { id, item, kind, durability: BAL.gear.durabilityMax, assignedTo: cid };
          f.citizens[cid].gear = { ...(f.citizens[cid].gear || {}), [kind]: id };
        }
      }
      // The party's force is passed, because that is what the game passes —
      // a garrison answers what is at its door. Omitting it would measure a
      // code path no player ever meets.
      const force = ids.reduce((a, id) => a + unitPower(f, f.citizens[id]), 0);
      const enemy = garrisonForce({ id: 9, name: 'T', power: { military } }, BAL.conquest.breachGarrisonScale, 0.75, force);
      if (resolveCombat(f, ids, enemy, { battleId: 'wiring-cal:' + seed }).outcome.win) wins++;
    }
    return wins;
  };
  const softWins = outcomes(20);
  const hardWins = outcomes(95);
  if (!(softWins - hardWins >= 10)) {
    fail(
      `the target's military rating barely changes the breach: ${softWins}/30 wins against a rating of 20, ` +
      `${hardWins}/30 against 95. A conquest that plays the same against every silo makes the world table decoration.`
    );
  } else {
    ok(`the world table's military column decides the fight: ${softWins}/30 breaches won against 20, ${hardWins}/30 against 95`);
  }
}

// ---- 9b. the hard targets are hard, not shut ---------------------------------
//
// A mutation exposed this gap: reverting the approach check from the party's
// *average* quality back to its summed force left §9 green, because §9 takes
// Selby (military 20) and the summed version only closes the top of the
// table. That is the worse failure of the two — a stage that is impossible
// looks exactly like a stage that is merely difficult, and the player cannot
// tell which they are looking at. So the hardest silo in the world table is
// asserted to be *reachable*: not likely, not cheap, but not zero.
{
  const store = newStore(77);
  const s = store.state;
  s.clock.day = 200;
  const hardest = Object.values(s.world.silos)
    .filter((x) => x.id !== 12)
    .sort((a, b) => (b.power?.military ?? 0) - (a.power?.military ?? 0))[0];

  const ids = s.citizenIds.filter((i) => s.citizens[i].age >= 20).slice(0, BAL.military.squadMin);
  let g = 0;
  for (const cid of ids) {
    for (const [kind, item] of [['suit', 'suit_4'], ['weapon', 'mag_rifle'], ['armor', 'composite_rig']]) {
      const id = 'g' + ++g;
      s.military.gear[id] = { id, item, kind, durability: BAL.gear.durabilityMax, assignedTo: cid };
      s.citizens[cid].gear = { ...(s.citizens[cid].gear || {}), [kind]: id };
    }
  }

  let scouted = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const exp = { id: 9000 + seed, target: hardest.id, purpose: 'scout', roster: ids, leaderId: ids[0] };
    const out = resolveConquestRun(s, exp);
    if (out.actions.some((a) => a.type === 'CONQUEST_PATCH')) scouted++;
  }
  if (scouted === 0) {
    fail(
      `a best-equipped party could not scout ${hardest.name} (military ${hardest.power.military}) on any of 40 seeds — ` +
      'the stage is closed, not hard'
    );
  } else if (scouted === 40) {
    fail(`scouting ${hardest.name} (military ${hardest.power.military}) never failed in 40 seeds — the check does nothing`);
  } else {
    ok(`the hardest silo is hard, not shut: ${scouted}/40 approach runs on ${hardest.name} got in unseen`);
  }
}

// ---- 10. a raid can actually be triggered by the world ----------------------
//
// The resolver is only half the feature. For the whole of this project's
// history the dynamic trigger required `reputation < -40`, and measured, no
// playstyle reached it: a 400-day campaign left the worst reputation in the
// world at -15, and 300 days of deliberately antagonising The Anvil reached
// -23. So a raid could resolve and still never happen — the only one a player
// ever saw was a scripted event on day 26.
//
// Counting raids in a campaign cannot assert this: the rate is deliberately
// low enough to leave the descent affordable, so a short window is luck. So
// the conditions are built here and the tick is run directly.
{
  const store = newStore(31337);
  const s = store.state;
  s.clock.day = 200;
  s.world.lastDiploDay = 0;

  // An aggressive silo, in contact, with no pact.
  const attacker = Object.values(s.world.silos).find((x) => x.disposition?.aggression > BAL.diplomacy.raidAggression);
  if (!attacker) fail('no silo in the world table is aggressive enough to ever raid');
  else {
    attacker.contact = 'radio';
    attacker.status = 'stable';
    attacker.treaties = [];
    attacker.reputation = 0;

    // A fat, softly-held silo: the opportunity path, which is the only one a
    // peaceful player will ever meet.
    //
    // With one squad, deliberately. A silo with *no* soldiers reads
    // `playerPower.military` 0 and passes any threshold, so a fixture without
    // one cannot tell 20 from 40 — and 20 was the value that made this whole
    // path dead, because a single squad of four with pipe guns scores 24 and
    // every real campaign has one by the time it is worth robbing. A fixture
    // that is softer than any silo a player will ever run proves nothing
    // about the thresholds it is meant to be pinning.
    store.dispatchAll(formSquad(s, 'Watch'));
    const sqId = s.military.squadIds[0];
    for (const c of s.citizenIds.map((i) => s.citizens[i]).filter((c) => c.age >= 20).slice(0, BAL.military.squadMin)) {
      store.dispatch({ type: 'SQUAD_MEMBER', squadId: sqId, citizenId: c.id });
    }
    // And the weapons node. `playerPower.military` is soldiers x 4 plus
    // weaponTier x 8, so a squad alone reads 16 and a squad plus Firearms I
    // reads 24 — and 24 is the number that mattered: it is what every
    // autopilot campaign sits at, and it is what a threshold of 20 was
    // silently excluding. Without this line the fixture reads 16, passes
    // either threshold, and cannot tell the broken value from the fixed one.
    store.dispatch({ type: 'RESEARCH_COMPLETE', id: 'firearms_1' });

    const rich = () => {
      const p = playerPower(s);
      return p.economy >= BAL.diplomacy.raidTemptEconomy && p.military <= BAL.diplomacy.raidTemptMilitary;
    };
    for (const f of s.silo.floors) f.excavated = true;
    let slot = 0, floor = 20;
    while (!rich() && floor < 60) {
      placeRoom(s, { type: 'storage_depot', floor, slot, width: 1, level: 1 });
      if (++slot >= BAL.silo.slotsPerFloor) { slot = 0; floor++; }
    }
    if (!rich()) {
      fail('could not build a silo that reads as worth raiding — check playerPower against raidTempt*');
    } else {
      let queued = 0;
      for (let day = 200; day < 900; day++) {
        s.clock.day = day;
        for (const a of diploTick(s)) {
          if (a.type === 'WORLD_EVENT_QUEUE' && a.event?.kind === 'raid') queued++;
          if (a.type === 'DIPLO_TICK') s.world.lastDiploDay = a.day;
        }
      }
      if (!queued) {
        fail(
          `a wealthy, undefended silo next to ${attacker.name} was never raided in 700 days — ` +
          'the dynamic raid trigger is unreachable, which is the state this feature shipped in'
        );
      } else {
        ok(`the world raids a rich, lightly-held silo: ${queued} raids queued over 700 days next to ${attacker.name}`);
      }

      // The other path, pinned separately. A well-defended silo is not an
      // opportunity, so this is the clause that has to carry an aggressive
      // player who has made an enemy — and it is the clause whose threshold
      // measured unreachable at -40.
      //
      // What this pins is the mechanism, not the number: the fixture sets
      // reputation relative to `raidGrudgeReputation`, so it follows the
      // constant wherever it goes. Pinning the *value* would mean asserting
      // that ordinary play reaches it, which needs a campaign, and a
      // stochastic assertion on a rate this deliberately low is either flaky
      // or pins the balance to whatever made the test pass — see the note in
      // test/campaign.mjs where exactly that assertion was removed. The
      // evidence for -20 is the measurement recorded on the constant itself.
      s.research.completed = [...s.research.completed, 'firearms_3'];
      for (const c of s.citizenIds.map((i) => s.citizens[i])
        .filter((c) => c.age >= 20 && c.squadId == null).slice(0, BAL.military.squadMax - BAL.military.squadMin)) {
        store.dispatch({ type: 'SQUAD_MEMBER', squadId: sqId, citizenId: c.id });
      }
      if (playerPower(s).military <= BAL.diplomacy.raidTemptMilitary) {
        fail('the grudge fixture is still soft enough to be an opportunity — it cannot isolate the grudge path');
      } else {
        attacker.reputation = BAL.diplomacy.raidGrudgeReputation - 1;
        s.world.lastDiploDay = 0;
        let grudged = 0;
        for (let day = 200; day < 900; day++) {
          s.clock.day = day;
          for (const a of diploTick(s)) {
            if (a.type === 'WORLD_EVENT_QUEUE' && a.event?.kind === 'raid') grudged++;
            if (a.type === 'DIPLO_TICK') s.world.lastDiploDay = a.day;
          }
        }
        if (!grudged) {
          fail(`a defended silo that ${attacker.name} hates was never raided in 700 days — the grudge path is dead`);
        } else {
          ok(`and comes for a defended silo it has a grudge against: ${grudged} over 700 days`);
        }
      }
    }
  }
}

// ---- 11. the hold's five fights actually accumulate -------------------------
//
// An audit found the stage discarding about 85% of the damage it inflicts.
// `applyResolution` builds an *absolute* health from the citizen it can see,
// nothing dispatches between the five fights, and the reducer assigns — so
// five patches each read the same pre-assault health and only the last
// survived. Wounds of 22, 8, 22, 17 and 13 landed as a single write of 87
// against a start of 100. The stage whose whole premise is "five fights on
// one load-out" was being fought by people who healed between floors.
{
  const store = newStore(909);
  const s = store.state;
  s.clock.day = 300;
  s.resources.ammo = 9000;
  const ids = s.citizenIds.filter((i) => s.citizens[i].age >= 20).slice(0, BAL.military.squadMax);
  let g = 0;
  for (const cid of ids) {
    for (const [kind, item] of [['suit', 'suit_3'], ['weapon', 'service_rifle'], ['armor', 'padded_vest']]) {
      const id = 'g' + ++g;
      s.military.gear[id] = { id, item, kind, durability: BAL.gear.durabilityMax, integrity: 60, assignedTo: cid };
      s.citizens[cid].gear = { ...(s.citizens[cid].gear || {}), [kind]: id };
    }
  }
  // A target the squad can actually beat several floors of. Against the
  // hardest silo it loses on floor one, emits a single patch, and the test
  // cannot tell the fixed code from the broken code — which is exactly what
  // it did on the first attempt, staying green under mutation.
  const TARGET = 6;
  s.world.silos[TARGET].conquest = { stage: 'hold', scoutRuns: 2, undermined: true, defenseMult: 0.75 };
  const preHealth = Object.fromEntries(ids.map((i) => [i, s.citizens[i].health]));
  const out = resolveConquestRun(s, { id: 77, band: 'approach', target: TARGET, purpose: 'hold', roster: ids, leaderId: ids[0] });

  const floorsFought = out.journal.filter((l) => /^— Floor /.test(l)).length;
  if (floorsFought < 2) {
    fail(`the hold fixture only fought ${floorsFought} floor(s) — it cannot test whether wounds accumulate across them`);
  }
  const patches = out.actions.filter((a) => a.type === 'CITIZENS_PATCH');
  if (patches.length !== 1) {
    fail(`the hold emitted ${patches.length} health patches, not 1; each reads pre-assault state, so all but the last are discarded`);
  } else {
    ok('the hold emits one cumulative wound patch, not one per floor that overwrites the last');
  }

  // The patch has to be a real wound, end to end.
  const drops = patches.flatMap((p) => p.patches).map((q) => preHealth[q.id] - q.health);
  const worst = drops.length ? Math.round(Math.max(...drops)) : 0;
  if (!(worst > 0)) {
    fail(`${floorsFought} floors of fighting left the squad at full health — no wound reached the patch`);
  } else {
    ok(`and it is a real wound: worst ${worst} health over ${floorsFought} floors`);
  }

  // Now the arithmetic, exactly, because the total above cannot prove it.
  //
  // This is the correction to a first attempt at this assertion. It bounded
  // the accumulated drop by `survivorHealthLoss[1]` (34) on the reasoning
  // that no single floor could exceed it — but combat.js:217 computes
  // `rng.int(8,34) * (win ? 0.7 : 1.2) * traitMod(injuryTaken)`, so one bad
  // floor against a frail soldier reaches 61. Measured: the last-floor-wins
  // mutation produced a drop of 45 and sailed past a ceiling of 34. A bound
  // of 61 against a clean reading of 66 is four points of margin, which is
  // not a test either.
  //
  // So the accumulation is pinned directly, on wounds we choose. Three floors
  // read the same pre-assault health of 100 — which is precisely the
  // situation `accumulate` exists for, since nothing dispatches between the
  // fights — and report 80, 85 and 90. That is 20 + 15 + 10 of damage, and
  // the citizen must finish on 55. Last-floor-wins finishes on 90.
  {
    const fake = { citizens: { z: { id: 'z', health: 100, radiation: 0 } } };
    const hurt = new Map();
    for (const h of [80, 85, 90]) accumulate(hurt, [{ id: 'z', health: h }], fake);
    const got = hurt.get('z')?.health;
    if (got !== 55) {
      fail(
        `three floors wounding 20, 15 and 10 off the same pre-assault reading of 100 left the citizen on ` +
        `${got}, not 55 — the floors overwrite instead of accumulating`
      );
    } else {
      ok('and the floors accumulate exactly: 20 + 15 + 10 off 100 leaves 55, not 90');
    }
  }

  // One victory bonus for the assault, not one per floor. Five floors used to
  // pay `order.victoryBonus` five times — +20 Order in a single action stream.
  const vic = out.actions.filter((a) => a.type === 'ORDER_DELTA' && a.amount === BAL.order.victoryBonus);
  if (vic.length > 1) fail(`one assault paid ${vic.length} victory bonuses (${vic.length * BAL.order.victoryBonus} Order)`);
  else ok(`an assault pays at most one victory bonus (${vic.length})`);
}

// ---- 12. a conquest run costs what going outside costs -----------------------
//
// `EXPEDITION_RESOLVE` reads `a.suitIntegrity ?? 100` and `a.radiation || 0`.
// An action that omits them does not leave suits and doses alone — it writes
// every suit back to full and everybody's dose to nothing. Measured before
// the fix, on the same band and the same days: a salvage run came home with
// suits at 1.9 and 202 rad to decontaminate; a conquest run came home with
// suits at 100 and no dose. That made a conquest sortie a free suit
// refurbisher that strictly dominated the salvage run it borrows its band
// from, and the stages stay put on failure, so it could be cycled for ever.
{
  const store = newStore(515);
  const s = store.state;
  s.clock.day = 200;
  const ids = s.citizenIds.filter((i) => s.citizens[i].age >= 20).slice(0, BAL.military.squadMin);
  let g = 0;
  for (const cid of ids) {
    const id = 'g' + ++g;
    s.military.gear[id] = { id, item: 'suit_2', kind: 'suit', durability: BAL.gear.durabilityMax, integrity: 40, assignedTo: cid };
    s.citizens[cid].gear = { suit: id };
  }
  const out = resolveConquestRun(s, { id: 91, band: 'approach', target: 6, purpose: 'scout', roster: ids, leaderId: ids[0] });
  const res = out.actions.find((a) => a.type === 'EXPEDITION_RESOLVE');
  if (!(res.suitIntegrity < 40)) {
    fail(`a conquest run returned suits at ${res.suitIntegrity} from a start of 40 — twelve days outside cost them nothing`);
  } else if (!(res.radiation > 0)) {
    fail('a conquest run returned a dose of zero after twelve days on the surface');
  } else {
    ok(`a conquest run wears suits and carries a dose home: 40 → ${res.suitIntegrity.toFixed(1)}, ${res.radiation} rad`);
  }
}

// ---- 13. one run at a time, and a silo is taken once -------------------------
//
// Two squads sent at the same silo both froze the same `purpose` and both read
// the same pre-dispatch state. Two clean scouts both wrote `scoutRuns: 1` and
// the ladder could not be finished; two won holds both dispatched
// `SATELLITE_ADD`, and because the Dominion ending counts
// `world.satellites.length`, three silos taken twice read as six and fired an
// ending nobody had earned. Reachable by ordinary clicking.
{
  const store = newStore(0x1234);
  const s = store.state;
  const TARGET = 6;
  for (const f of s.silo.floors) f.excavated = true;
  placeRoom(s, { type: 'generator_hall', floor: 7, slot: 0, width: 3, level: 3 });
  placeRoom(s, { type: 'airlock', floor: 8, slot: 0, width: 3, level: 3 });
  store.dispatch({ type: 'RESEARCH_COMPLETE', id: 'breaching_charges' });
  store.dispatchAll(autoAssign(s));
  new Game(store).runDays(3);
  for (const k of ['food', 'water', 'ammo', 'meds']) s.resources[k] = 9000;
  for (let n = 0; n < 2; n++) store.dispatchAll(formSquad(s, `Column ${n + 1}`));
  const adults = s.citizenIds.map((i) => s.citizens[i]).filter((c) => c.age >= 20 && c.status !== 'dead');
  let k = 0;
  for (const sqId of s.military.squadIds) {
    for (let i = 0; i < BAL.military.squadMin; i++) if (adults[k]) store.dispatch({ type: 'SQUAD_MEMBER', squadId: sqId, citizenId: adults[k++].id });
  }
  let g = 0;
  for (const sqId of s.military.squadIds) {
    for (const cid of s.military.squads[sqId].members) {
      for (const [kind, item] of [['suit', 'suit_4'], ['weapon', 'mag_rifle'], ['armor', 'composite_rig']]) {
        const id = 'g' + ++g;
        s.military.gear[id] = { id, item, kind, durability: BAL.gear.durabilityMax, assignedTo: cid };
        s.citizens[cid].gear = { ...(s.citizens[cid].gear || {}), [kind]: id };
      }
    }
  }
  const [a, b] = s.military.squadIds;
  store.dispatchAll(launchConquest(s, a, TARGET));
  const second = launchConquest(s, b, TARGET);
  const inFlight = s.expeditions.active.filter((e) => e.target === TARGET && e.purpose !== 'salvage').length;
  if (second.length || inFlight > 1) {
    fail(`two squads are in flight against the same silo (${inFlight}) — their results overwrite each other`);
  } else {
    ok('a second squad cannot be sent at a silo that already has a run in flight');
  }

  // And the reducer refuses a duplicate even if something else finds a way.
  store.dispatch({ type: 'SATELLITE_ADD', siloId: TARGET });
  store.dispatch({ type: 'SATELLITE_ADD', siloId: TARGET });
  const dupes = s.world.satellites.filter((x) => x.siloId === TARGET).length;
  if (dupes !== 1) fail(`world.satellites carries ${dupes} entries for silo ${TARGET}`);
  else ok('a silo can only be added to the satellite list once, however it gets there');

  // A revolt puts the ladder back to the bottom, so it can be retaken. Left
  // on 'held' the panel read "Already taken." while the button still sent
  // squads on a stage with no branch — twelve days and a supply load, for ever.
  // Put the silo in the state a won hold leaves it in — that is the state the
  // bug needs. Dispatching SATELLITE_ADD alone leaves `conquest.stage` on
  // 'scout', so the revolt has nothing to reset and the test passes whether
  // or not the reset exists.
  store.dispatch({ type: 'CONQUEST_PATCH', siloId: TARGET, patch: { stage: 'held' } });
  store.dispatch({ type: 'SATELLITE_REVOLT', siloId: TARGET });
  const after = conquestState(s, TARGET);
  const gate = canLaunchRun(s, TARGET);
  if (after.stage === 'held' || (!gate.ok && /already/i.test(gate.reason || ''))) {
    fail(`a revolted silo cannot be retaken (stage=${after.stage}, gate="${gate.reason}")`);
  } else {
    ok(`a silo that throws you out can be taken again (stage back to ${after.stage ?? 'scout'})`);
  }
}

// ---- 14. taking a silo is worth something --------------------------------
//
// `resolveRun` shipped with no loot pipeline at all: five sorties and a month
// of fighting returned the satellite stream and nothing else. A design review
// measured it against salvage on the same band with the same squad over 330
// days — +950 stores and *zero* artifacts, against +4,257 and 25 — and since
// eleven of the forty-eight research nodes and all three endings are
// artifact-gated, that is not a weaker option but a strictly dominated one.
//
// Conquest is not meant to out-earn salvage. It is meant to pay for different
// things: one large sack off the target's own `power.economy`, a shot at what
// its `power.science` says is in the archive, and then a permanent share. So
// what is asserted is that it pays *at all*, and that the world table's
// columns are what decide how much.
{
  const rich = { id: 91, name: 'Rich', power: { military: 20, economy: 95, science: 20 } };
  const poor = { id: 92, name: 'Poor', power: { military: 20, economy: 20, science: 20 } };
  const clever = { id: 93, name: 'Clever', power: { military: 20, economy: 50, science: 98 } };
  const dull = { id: 94, name: 'Dull', power: { military: 20, economy: 50, science: 5 } };

  const run = (target, seed) => {
    const store = newStore(seed);
    const s = store.state;
    s.clock.day = 300;
    s.resources.ammo = 9000;
    s.world.silos[target.id] = { ...target, contact: 'radio', status: 'stable', treaties: [], reputation: 0 };
    s.world.silos[target.id].conquest = { stage: 'hold', scoutRuns: 2, undermined: true, defenseMult: 0.75 };
    const ids = s.citizenIds.filter((i) => s.citizens[i].age >= 20).slice(0, BAL.military.squadMax);
    let g = 0;
    for (const cid of ids) {
      for (const [kind, item] of [['suit', 'suit_4'], ['weapon', 'mag_rifle'], ['armor', 'composite_rig']]) {
        const id = 'g' + ++g;
        s.military.gear[id] = { id, item, kind, durability: BAL.gear.durabilityMax, assignedTo: cid };
        s.citizens[cid].gear = { ...(s.citizens[cid].gear || {}), [kind]: id };
      }
    }
    return resolveConquestRun(s, { id: 5, band: 'approach', target: target.id, purpose: 'hold', roster: ids, leaderId: ids[0] });
  };
  const stores = (o) => Object.values(o.loot || {}).reduce((a, b) => a + b, 0);
  const arts = (seedRange, target) => {
    let n = 0;
    for (let seed = 1; seed <= seedRange; seed++) n += Object.keys(run(target, seed).artifacts || {}).length;
    return n;
  };

  // Ratios alone are tautologies here, and this section learned that the hard
  // way twice. `gotRich > gotPoor * 2` compares two numbers that both scale
  // off `sack.perEconomy`, so rich/poor is 95/20 for *every* value of it: with
  // `perEconomy` cut from 11 to 0.2 the whole sack fell to 12 stores across
  // seven resources and the ratio test still printed a tick. Same for the
  // artifact margin under `artifactChancePerScience` at 0.0002.
  //
  // So each ratio now sits behind an absolute floor that is not derived from
  // the constant it is meant to police. The magnitudes come from the design
  // review that measured a mature silo producing 242-293 stores a day: a sack
  // worth less than a single day of what the silo makes anyway is not the
  // "one large sack" this feature is sold on, whatever it is worth relative
  // to a poorer target. Measured today: 679 rich, 143 poor, 20 artifacts
  // against 0 over 12 seeds.
  const SACK_WORTH_THE_ASSAULT = 300;
  const ARCHIVE_WORTH_THE_TRIP = 6;

  const gotRich = stores(run(rich, 7));
  const gotPoor = stores(run(poor, 7));
  if (!gotRich) fail('taking a silo returned no stores at all — conquest still pays nothing');
  else if (!(gotRich >= SACK_WORTH_THE_ASSAULT)) {
    fail(
      `sacking the richest silo in the table returned ${gotRich} stores — under a day of the silo's own ` +
      `production, so five sorties and a month of walking bought nothing`
    );
  } else if (!(gotRich > gotPoor * 2)) fail(`a rich silo paid ${gotRich} and a poor one ${gotPoor} — economy decides nothing`);
  else ok(`sacking a silo pays off its economy: ${gotRich} stores from a rich one, ${gotPoor} from a poor one`);

  const cleverArts = arts(12, clever);
  const dullArts = arts(12, dull);
  // A margin, not `>`. With science neutered to a constant the two targets
  // still differ by a coin flip — the streams are keyed on the silo id — so a
  // bare `>` passed under mutation. Measured, 98 against 5 is 25 to 1.
  if (!cleverArts) fail('a high-science silo yielded no artifacts over 12 seeds — the archive is empty');
  else if (!(cleverArts >= ARCHIVE_WORTH_THE_TRIP)) {
    fail(
      `the best archive in the table yielded ${cleverArts} artifacts over 12 seeds — a rounding error against ` +
      'the 25 salvage returns in the same span, so the archive is not a reason to take a silo'
    );
  } else if (!(cleverArts >= dullArts * 3)) fail(`science barely decides anything: ${cleverArts} artifacts vs ${dullArts}`);
  else ok(`and its archive off its science: ${cleverArts} artifacts against ${dullArts} over 12 seeds`);
}

// ---- 15. preparation decides, and so does the target ------------------------
//
// `garrisonForce` scaled with the target and nothing else, so the hardest
// silo in the game was a fixed ceiling — 95 x 6 x 0.75 = 428 — while a
// party's force has no ceiling at all. Measured breach wins out of 25 against
// military 95: four green troopers 0, eight green 8, four veterans 17, eight
// veterans 25. Past about 430 of force the world table's military column
// decided nothing, and it is the column the whole diplomacy screen is built
// on. What flattened it was training, not headcount — four veterans out-fight
// eight recruits, which is right, and then out-fought the game.
//
// A garrison now answers the force at its door, sub-linearly, so bringing
// more is still worth doing. What is asserted is that *both* dimensions
// still decide something: the hardest silo must not fall to a maximum party
// every time, and it must not be immune to one either.
{
  const attempt = (n, trained, military, seed) => {
    const store = newStore(seed);
    const s = store.state;
    s.clock.day = 300;
    s.resources.ammo = 9000;
    const ids = s.citizenIds.filter((i) => s.citizens[i].age >= 20).slice(0, n);
    let g = 0;
    for (const cid of ids) {
      const c = s.citizens[cid];
      if (trained) c.skills.combat = 45;
      for (const [kind, item] of [['suit', 'suit_4'], ['weapon', 'mag_rifle'], ['armor', 'composite_rig']]) {
        const id = 'g' + ++g;
        s.military.gear[id] = { id, item, kind, durability: BAL.gear.durabilityMax, assignedTo: cid };
        c.gear = { ...(c.gear || {}), [kind]: id };
      }
    }
    s.world.silos[6] = {
      ...s.world.silos[6],
      power: { military, economy: 60, science: 40 },
      contact: 'radio', status: 'stable',
      conquest: { stage: 'breach', scoutRuns: 2, undermined: true, defenseMult: 0.75 },
    };
    const out = resolveConquestRun(s, { id: 1, band: 'approach', target: 6, purpose: 'breach', roster: ids, leaderId: ids[0] });
    return out.actions.some((a) => a.type === 'CONQUEST_PATCH' && a.patch?.stage === 'hold');
  };
  const rate = (n, trained, military) => {
    let w = 0;
    for (let seed = 1; seed <= 25; seed++) if (attempt(n, trained, military, seed)) w++;
    return w;
  };

  const best = rate(BAL.military.squadMax, true, 95);
  const green = rate(BAL.military.squadMax, false, 95);
  const bestSoft = rate(BAL.military.squadMax, true, 20);

  if (best >= 25) {
    fail(`a maximum party breached the hardest silo ${best}/25 times — preparation has erased the target's military rating`);
  } else if (best < 8) {
    fail(`a maximum party breached the hardest silo only ${best}/25 times — it is shut, not hard`);
  } else if (!(bestSoft > best)) {
    fail(`the softest and hardest silos play the same to a maximum party (${bestSoft} vs ${best})`);
  } else if (!(best > green + 5)) {
    fail(`training the same party changes little against the hardest silo (${green} green, ${best} trained)`);
  } else {
    ok(`the hardest silo answers preparation without being erased by it: ${green}/25 green, ${best}/25 veteran, ${bestSoft}/25 against the softest`);
  }
}

// ---- 16. holding silos costs something ---------------------------------------
//
// The radio panel has always said "Two is comfortable. Five will break you."
// It was the opposite: each garrisoned satellite was +2.5 Order for the squad
// and -1 for the occupation, a net +1.5 a day, and a design review measured
// six satellites running at Order 77 where none at all ran at 45. Dominion
// made a silo *more* stable.
//
// The cause was one squad counted twice. `world.tickSatellites` counts idle
// garrison squads as holding satellites; `military.simulateDay` paid every
// garrison squad the home-presence bonus regardless. A squad cannot both
// reassure people in the corridors and occupy somebody else's silo.
{
  const orderAfter = (satellites) => {
    const store = newStore(0x1234);
    const s = store.state;
    const game = new Game(store);
    store.dispatchAll(autoAssign(s));
    game.runDays(20);
    const adults = s.citizenIds.map((i) => s.citizens[i]).filter((c) => c.age >= 20 && c.status !== 'dead');
    let k = 0;
    for (let i = 0; i < satellites; i++) {
      store.dispatchAll(formSquad(s, `Column ${i + 1}`));
      const id = s.military.squadIds[i];
      for (let m = 0; m < BAL.military.squadMin; m++) {
        if (adults[k]) store.dispatch({ type: 'SQUAD_MEMBER', squadId: id, citizenId: adults[k++].id });
      }
    }
    for (const x of Object.values(s.world.silos).filter((x) => x.id !== 12).slice(0, satellites)) {
      store.dispatch({ type: 'SATELLITE_ADD', siloId: x.id });
    }
    const before = s.order.value;
    game.runDays(60);
    return { drift: s.order.value - before, end: s.order.value };
  };

  const none = orderAfter(0);
  const few = orderAfter(2);
  const many = orderAfter(6);

  if (few.drift >= none.drift) {
    fail(`holding two silos left Order better off than holding none (${few.drift.toFixed(1)} vs ${none.drift.toFixed(1)}) — occupation is free`);
  } else if (many.drift >= few.drift) {
    fail(`holding six silos cost no more Order than holding two (${many.drift.toFixed(1)} vs ${few.drift.toFixed(1)})`);
  } else if (!(many.end < BAL.order.uprisingThreshold)) {
    fail(`six occupations left Order at ${many.end.toFixed(1)}, above the uprising line — "five will break you" is still not true`);
  } else {
    ok(
      `occupation costs Order and scales: none ${none.drift.toFixed(1)}, two ${few.drift.toFixed(1)}, ` +
      `six ${many.drift.toFixed(1)} over 60 days, ending at ${many.end.toFixed(1)} against an uprising line of ${BAL.order.uprisingThreshold}`
    );
  }
}

// ---- 17. every room the game has, the art tool knows about ------------------
//
// `heat_exchange` was added to the game and never to `tools/art/rooms.mjs`,
// so the atlas carried 28 frames for 29 room types and the Heat Exchange fell
// through to the procedural tile everywhere it appeared. Nothing failed —
// that fallback is deliberate and works — which is exactly why it went
// unnoticed for as long as it did.
//
// Checked against the source rather than against a copy of the list, so
// adding a room to data/rooms.js and forgetting the art is a red suite rather
// than a quiet downgrade.
{
  const art = readSource('../tools/art/rooms.mjs');
  const ids = art.match(/export const ROOM_IDS = \[([\s\S]*?)\];/);
  if (!ids) {
    fail('could not find ROOM_IDS in tools/art/rooms.mjs — this check has gone stale');
  } else {
    const drawn = new Set([...ids[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    const missing = ROOM_LIST.map((r) => r.id).filter((id) => !drawn.has(id));
    const extra = [...drawn].filter((id) => !ROOM_LIST.some((r) => r.id === id));
    if (missing.length) {
      fail(`the art tool has no drawing for ${missing.join(', ')} — those rooms fall back to the procedural tile`);
    } else if (extra.length) {
      fail(`the art tool draws ${extra.join(', ')}, which are not room types any more`);
    } else {
      ok(`all ${ROOM_LIST.length} room types have art in the atlas`);
    }
  }
}

// ---- 7. migrations write what they promise ----------------------------------
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

// ---- 18. a silo you have taken is not a silo that raids you -----------------
//
// The raid pass skipped collapsed silos and treaty partners and nothing else,
// so a conquered silo kept its aggression and its grudge and went on putting
// parties on your airlock. Measured before the fix: The Anvil, garrisoned and
// contented at satellite order 92.6, robbed its owner on day 51.
//
// It looked covered. `SATELLITE_ADD` writes `status: 'satellite'` — but
// `world.js` recomputes `status` from stability for every silo that is not
// collapsed and overwrites it on the next world day, so that write is dead.
// `contact` is the field that survives. Both halves are asserted here,
// because a test that only checked the skip would stay green if the skip
// moved back onto the field that gets overwritten.
{
  const raidsAgainst = (mutate) => {
    const store = newStore(31337);
    const s = store.state;
    const silo = s.world.silos[5];
    silo.contact = 'radio';
    silo.reputation = BAL.diplomacy.raidGrudgeReputation - 50;
    silo.treaties = [];
    mutate(s, silo);
    let queued = 0;
    for (let d = 0; d < 400; d++) {
      s.clock.day = d;
      for (const a of diploTick(s)) {
        if (a.type === 'WORLD_EVENT_QUEUE' && a.event?.kind === 'raid' && a.event.siloId === 5) queued++;
      }
    }
    return queued;
  };

  const hostile = raidsAgainst(() => {});
  const taken = raidsAgainst((s, silo) => {
    silo.contact = 'satellite';
    s.world.satellites = [{ siloId: 5, order: 90 }];
  });

  if (!hostile) {
    fail('the fixture never produced a raid at all, so it cannot show that conquest stops one');
  } else if (taken) {
    fail(`a silo you have conquered sent ${taken} raiding parties at you over 400 days`);
  } else {
    ok(`a conquered silo stops raiding you: ${hostile} raids over 400 days as a neighbour, 0 as a holding`);
  }

  // And the dead write is still dead, which is why the skip must not use it.
  {
    const store = newStore(31337);
    const s = store.state;
    store.dispatch({ type: 'SATELLITE_ADD', siloId: 5, order: BAL.conquest.conqueredStartOrder });
    const afterAdd = s.world.silos[5].status;
    store.dispatchAll(worldDay(s));
    if (afterAdd === 'satellite' && s.world.silos[5].status === 'satellite') {
      ok('silo.status survives a world day as "satellite" — the raid skip could safely read it');
    } else {
      ok(`silo.status is overwritten by the world tick ("${afterAdd}" -> "${s.world.silos[5].status}"), so contact is the field to read`);
    }
  }
}

// ---- 19. a holding that collapses stops being a holding ---------------------
//
// Nothing removed a satellite from `world.satellites` when its silo collapsed,
// so `tickSatellites` went on paying yield off a dead silo's economy, went on
// ticking its order, and it went on counting toward `dominionSilosRequired` —
// the ending could be held open by silos that had stopped transmitting.
{
  const store = newStore(4711);
  const s = store.state;
  store.dispatch({ type: 'SATELLITE_ADD', siloId: 16, order: BAL.conquest.conqueredStartOrder });
  if (s.world.satellites.length !== 1) fail('SATELLITE_ADD did not record a holding');

  // Drive it under the collapse line. Stability chases a target rather than
  // holding whatever it is set to, so zeroing it alone just lets it drift
  // back up — the target has to be zero as well, which is a silo with no
  // economy, no people and nothing but soldiers.
  Object.assign(s.world.silos[16].power, { stability: 0, economy: 0, population: 0, military: 100 });
  store.dispatchAll(worldDay(s));

  if (s.world.satellites.some((x) => x.siloId === 16)) {
    fail('a satellite whose silo collapsed is still in world.satellites, still paying yield and still counting toward Dominion');
  } else if (s.world.silos[16].status !== 'collapsed') {
    fail(`the fixture did not actually collapse the silo (status "${s.world.silos[16].status}")`);
  } else {
    ok('a satellite whose silo collapses is dropped from the holdings, and says so in the log');
  }

  const said = s.log.some((e) => /gone quiet with your garrison/.test(e.text || ''));
  if (!said) fail('losing a holding to a collapse was not reported to the player');

  // A collapse is not a revolt: the silo is not left "hostile and struggling",
  // because the collapse patch already said what it is.
  if (s.world.silos[16].contact === 'hostile') {
    fail('a collapsed silo was left marked hostile — SATELLITE_REVOLT overwrote the collapse');
  }
}

// ---- 20. the launch gate counts people, not squad records -------------------
//
// `canLaunchRun` is what actually stops a squad going out — `canAdvance` only
// answers whether a stage is finished — and it counted
// `squadIds.filter(id => !deployed)`. `SQUAD_CREATE` makes a squad with
// `members: []`, so the hardest requirement in the game was cleared by
// pressing New Squad twice and crewing neither.
//
// test/conquest.mjs covers the `canAdvance` half of this. This is the other
// half, and it is asserted separately because the two functions had already
// drifted apart once.
{
  const store = newStore(0x1234);
  const s = store.state;
  const TARGET = 6;
  store.dispatch({ type: 'RESEARCH_COMPLETE', id: 'breaching_charges' });
  store.dispatch({ type: 'CONQUEST_PATCH', siloId: TARGET, patch: { stage: 'breach', scoutRuns: 2, undermined: true } });

  for (let i = 0; i < BAL.conquest.breachSquadsRequired; i++) {
    store.dispatch({ type: 'SQUAD_CREATE', name: `Paper ${i + 1}` });
  }
  const paper = canLaunchRun(s, TARGET);
  if (paper.ok) {
    fail(`canLaunchRun let a squad set out on the breach with ${BAL.conquest.breachSquadsRequired} empty squads`);
  } else {
    ok(`the launch gate counts people: "${paper.reason}"`);
  }

  const crew = s.citizenIds.map((i) => s.citizens[i]).filter((c) => c.age >= 20 && c.status !== 'dead');
  let next = 0;
  for (const sqId of s.military.squadIds) {
    for (let i = 0; i < BAL.military.squadMin; i++) {
      const c = crew[next++];
      if (c) store.dispatch({ type: 'SQUAD_MEMBER', squadId: sqId, citizenId: c.id });
    }
  }
  const crewed = canLaunchRun(s, TARGET);
  if (!crewed.ok) fail(`crewing the squads did not open the breach (${crewed.reason})`);
  else ok('and opens once they are crewed');
}

// ---- 21. the salvage path accumulates its wounds too ------------------------
//
// The hold stage was fixed for this and the path that runs a hundred times as
// often was not. `applyResolution` builds an absolute health from the citizen
// it can see, nothing dispatches between a run's encounters, and the reducer
// assigns — so two fights in one expedition both read the same pre-run health
// and the later patch overwrote the earlier. Measured on the deep band: 48
// points of wounds landing as 35, and 47 as 24. Radiation was worse, because
// the second patch's dose is computed off the original reading, so the first
// fight's dose was dropped rather than reduced.
//
// One patch per run is the shape that proves it; §11 pins the arithmetic.
{
  let checked = 0;
  let worst = null;
  for (let seed = 1; seed <= 40 && !worst; seed++) {
    const store = newStore(seed);
    const s = store.state;
    s.clock.day = 300;
    const ids = s.citizenIds.filter((i) => s.citizens[i].age >= 20).slice(0, BAL.military.squadMax);
    let g = 0;
    for (const cid of ids) {
      for (const [kind, item] of [['suit', 'suit_4'], ['weapon', 'mag_rifle'], ['armor', 'composite_rig']]) {
        const id = 'g' + ++g;
        s.military.gear[id] = { id, item, kind, durability: BAL.gear.durabilityMax, assignedTo: cid };
        s.citizens[cid].gear = { ...(s.citizens[cid].gear || {}), [kind]: id };
      }
    }
    const out = resolveExpedition(s, {
      id: 900 + seed, squadId: 1, band: 'deep', purpose: 'salvage', target: null,
      launchDay: 300, returnDay: 300, roster: ids, leaderId: ids[0], resolved: false,
    });
    const fights = out.journal.filter((l) => /Contact|ambush|attack/i.test(l)).length;
    const patches = out.actions.filter((a) => a.type === 'CITIZENS_PATCH');
    if (patches.length > 1) worst = { seed, n: patches.length, fights };
    if (patches.length) checked++;
  }
  if (worst) {
    fail(
      `expedition on seed ${worst.seed} emitted ${worst.n} health patches; each reads pre-run state, so all but ` +
      'the last are discarded and most of the run\'s damage never lands'
    );
  } else if (!checked) {
    fail('no expedition over 40 seeds wounded anybody, so this check proved nothing');
  } else {
    ok(`a salvage run emits one cumulative wound patch, never one per fight (${checked} of 40 seeds wounded somebody)`);
  }
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
