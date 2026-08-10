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
import { canLaunchRun, nextStage, garrisonForce, resolveRun as resolveConquestRun } from '../src/sim/conquest.js';
import { resolve as resolveCombat } from '../src/sim/combat.js';
import { conquestState } from '../src/sim/diplomacy.js';
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
  if (!(s.resources.scrap < before.scrap)) {
    fail(`an undefended raid took nothing (scrap ${before.scrap} -> ${s.resources.scrap})`);
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
      const enemy = garrisonForce({ id: 9, name: 'T', power: { military } }, BAL.conquest.breachGarrisonScale, 0.75);
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
