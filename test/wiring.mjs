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
import autopilot from './autopilot.mjs';
import { directives } from '../src/sim/directives.js';
import { readEnvironment, simulateDay as populationDay } from '../src/sim/population.js';
import { gearStorageCap, craftableItems } from '../src/sim/military.js';
import { computeCaps, staffSlots } from '../src/sim/economy.js';
import { getRoom, ROOM_LIST } from '../src/data/rooms.js';
import { RESEARCH, RESEARCH_LIST } from '../src/data/research.js';
import { ITEM_LIST, getItem, itemsOfKind, bestCraftable, LOOT } from '../src/data/items.js';
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
import { getEnemy, ENEMIES } from '../src/data/encounters.js';
import { canLaunchRun, nextStage, garrisonForce, accumulate, resolveRun as resolveConquestRun, sack as sackSilo } from '../src/sim/conquest.js';
import { resolve as resolveCombat, unitPower, rollEnemyForce, applyResolution } from '../src/sim/combat.js';
import { conquestState, simulateTick as diploTick, availableActions } from '../src/sim/diplomacy.js';
import { playerPower, simulateDay as worldDay } from '../src/sim/world.js';
import { formSquad, unassignedGear, equipBest, canCraft, readiness, simulateCycle as militaryCycle } from '../src/sim/military.js';
import { placeRoom } from '../src/core/newgame.js';
import * as raid from '../src/sim/raid.js';
import { NODES as DOCTRINE_NODES, NODE_LIST as DOCTRINE_LIST } from '../src/data/doctrine.js';
import { commendationsFor, doctrineMod, whyNot, spent as doctrineSpent } from '../src/sim/doctrine.js';
import { ammoFactor } from '../src/sim/combat.js';
import { squadCap } from '../src/sim/military.js';
import { drawCitizens, citizensInView, deathMarks, deathMarkAt } from '../src/render/citizens.js';
import { drawCitizen as drawCitizenArt, W as CW, H as CH } from '../tools/art/citizens.mjs';
import { citizenRole } from '../src/render/sprites.js';
import { FLOOR_H, SLOT_W } from '../src/render/canvas.js';
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
  // And a rack of gear from before per-item stats, loot, or durability that
  // moved: three records in the shapes a save can really be carrying.
  s.military.gear.old1 = { id: 'old1', item: 'service_rifle', assignedTo: null };
  s.military.gear.old2 = { id: 'old2', item: 'suit_2', durability: 100, assignedTo: null };
  s.military.gear.old3 = { id: 'old3', item: 'mag_rifle', durability: 71, integrity: 100, assignedTo: null };
  // And no doctrine block at all, on a silo that has plainly been to the deep.
  delete s.doctrine;
  s.expeditions.history = [{ id: 1, band: 'near' }, { id: 2, band: 'deep' }, { id: 3, band: 'mid' }];

  let state = s;
  for (let v = 10; v < SCHEMA_VERSION; v++) if (MIGRATIONS[v]) state = MIGRATIONS[v](state) || state;

  const problems = [];
  {
    // The gear step. `loot` is new and every existing piece was made at a
    // bench; `durability` and `integrity` are backfilled because the code that
    // now reads them does arithmetic with them — an undefined durability makes
    // `unitPower`'s wear term NaN, which propagates into the combat ratio and
    // out into an outcome lookup that finds nothing, and an undefined
    // integrity is silently excluded from the Armory's repair queue for ever
    // (`undefined < 100` is false).
    const g = state.military.gear;
    if (g.old1.loot !== false || g.old2.loot !== false) problems.push('gear missing `loot: false`');
    if (g.old1.durability !== BAL.gear.durabilityMax) problems.push(`old1 durability ${g.old1.durability}`);
    if (g.old1.integrity !== BAL.gear.suit.integrityMax) problems.push(`old1 integrity ${g.old1.integrity}`);
    if (g.old2.integrity !== BAL.gear.suit.integrityMax) problems.push(`old2 integrity ${g.old2.integrity}`);
    // And it must not overwrite a value the save already had.
    if (g.old3.durability !== 71) problems.push(`a rifle at 71 durability was reset to ${g.old3.durability}`);
    // The stats themselves are code, not save data, so a migrated piece must
    // arrive carrying them without the save having said anything. What the
    // *value* should be is §40's question, not this one.
    if (!Number.isFinite(getItem(g.old3.item)?.stats?.power)) {
      problems.push('a migrated Mag Rifle came back with no power stat at all');
    }
  }
  {
    // The doctrine step, and specifically the frontier.
    //
    // Commendations only pay for a run at or beyond the deepest tier the silo
    // has come back from, and a save from before this feature says nothing
    // about that. Defaulting it to 0 would hand a day-600 veteran silo full
    // doctrine for pottering around the near ruins — exactly the farm the rule
    // exists to close. It is recovered from expedition history instead, which
    // is capped at 30 entries and so is only a lower bound: being wrong low
    // costs one band the silo had already outgrown and self-corrects on the
    // next real run, where being wrong at 0 has no such ceiling.
    const d = state.doctrine;
    if (!d) problems.push('no doctrine block after migrating');
    else {
      if (d.points !== 0 || d.earned !== 0 || d.taken.length) problems.push('migrated silo did not start the tree empty');
      if (d.frontier !== 3) {
        problems.push(`a silo with a deep run in its history migrated to frontier ${d.frontier}, not 3`);
      }
    }
  }
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
  else ok(`a v10 save migrates to v${SCHEMA_VERSION}: 144 floors, all sound, all shored, every room ` +
    'commissioned, every piece of gear stamped built-not-found and given a condition it can be worn down from');

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

// ---- 22. the raid tells the player the odds, and they are the real odds -----
//
// The directive counted heads — "4 people are standing to meet them" — which
// reads as sufficiency, and against a Warband four defenders win 3 of 40. A
// forecast that did not track the resolver would be worse than none, so the
// two ends of the measured table are pinned here.
{
  const manned = (seed, n, weapon) => {
    const store = newStore(seed);
    const s = store.state;
    s.clock.day = 200;
    s.resources.ammo = 5000;
    store.dispatchAll(formSquad(s, 'Watch'));
    const sqId = s.military.squadIds[0];
    const adults = s.citizenIds.map((i) => s.citizens[i]).filter((c) => c.age >= 20 && c.status !== 'dead');
    let g = 0;
    for (let i = 0; i < n; i++) {
      const c = adults[i];
      if (!c) continue;
      store.dispatch({ type: 'SQUAD_MEMBER', squadId: sqId, citizenId: c.id });
      if (weapon) {
        const id = 'g' + ++g;
        s.military.gear[id] = { id, item: weapon, kind: 'weapon', durability: BAL.gear.durabilityMax, assignedTo: c.id };
        s.citizens[c.id].gear = { ...(s.citizens[c.id].gear || {}), weapon: id };
      }
    }
    return s;
  };

  // Each factor on its own, because varying both at once proves neither.
  //
  // The first version of this compared four unarmed against a Warband with
  // eight armed against Scrappers and asserted the ratios were far apart.
  // They were — under every mutation too. Replacing the enemy with a constant
  // 50 still passed, because the kit differed; replacing `unitPower` with a
  // flat 5 a head also passed, because the band differed. Two variables, one
  // comparison, nothing pinned. This is the same confound §14 was rebuilt for.

  // Band decides, with the defenders held fixed.
  const vsScrappers = raid.forecast(manned(5, 4, 'service_rifle'), 0.2);
  const vsWarband = raid.forecast(manned(5, 4, 'service_rifle'), 0.95);
  if (!(vsScrappers.ratio > vsWarband.ratio * 3)) {
    fail(
      `the same four defenders rate ${vsScrappers.ratio.toFixed(2)} against Scrappers and ` +
      `${vsWarband.ratio.toFixed(2)} against a Warband — who is at the door decides nothing`
    );
  } else {
    ok(`the forecast reads the band: ${vsScrappers.ratio.toFixed(2)} against Scrappers, ${vsWarband.ratio.toFixed(2)} against a Warband`);
  }

  // Kit decides, with the band held fixed.
  const bare = raid.forecast(manned(5, 4, null), 0.4);
  const armed = raid.forecast(manned(5, 4, 'service_rifle'), 0.4);
  if (!(armed.ratio > bare.ratio * 1.5)) {
    fail(
      `four people rate ${bare.ratio.toFixed(2)} unarmed and ${armed.ratio.toFixed(2)} with rifles ` +
      'against the same band — what they are carrying decides nothing'
    );
  } else {
    ok(`and reads the kit: ${bare.ratio.toFixed(2)} unarmed against ${armed.ratio.toFixed(2)} with rifles`);
  }

  // And the verdicts must actually differ across that range.
  if (vsWarband.verdict === vsScrappers.verdict) {
    fail(`a rout and a formality get the same verdict: "${vsWarband.verdict}"`);
  } else {
    ok('and puts them in different words');
  }

  // And it must not touch the state it is reading.
  //
  // Two earlier versions of this assertion were untestable. The first fired
  // the forecast at a bare silo, where `defenders` returns nothing and the
  // function exits before it touches a citizen. The second crewed the silo
  // but compared *raid outcomes* — a lossy channel, since combat buckets its
  // result and a two-point morale drop across six people does not flip a
  // band. So a mutation that had the forecast decrement everyone's morale
  // survived both.
  //
  // The property worth pinning is simply that it writes nothing, and that is
  // exact: snapshot, forecast, compare.
  {
    const s2 = manned(909, 6, 'service_rifle');
    s2.world.pendingRaid = { siloId: 5, strength: 0.6, day: s2.clock.day - BAL.raid.graceDays };
    const before = JSON.stringify(s2);
    for (const strength of [0.2, 0.6, 0.95]) raid.forecast(s2, strength);
    if (JSON.stringify(s2) !== before) {
      fail('the raid forecast wrote to the state it was reading — a preview must not change what it previews');
    } else {
      ok('the forecast is read-only: three previews leave the silo byte-identical');
    }
  }
}

// ---- 23. a holding pays for the garrison standing on it ---------------------
//
// It did not. The yield was two literals in sim/world.js — 18 and 10 — scaled
// three times over, so Selby at economy 97 sent home 6.7 a day at its starting
// order and 4.05 averaged across every satellite-day of two campaigns. Its
// garrison is six soldiers at 0.4 food and 0.5 chits each: 5.4 a day, before
// the six foregone jobs and the Order. The "permanent share of everything they
// make" that conquest is sold on was a tax on winning.
//
// Measured through the real world tick rather than by re-deriving the formula,
// because re-deriving it here would pass against a world.js that had stopped
// using it.
{
  const store = newStore(2024);
  const s = store.state;
  const TARGET = 6;
  store.dispatch({ type: 'SATELLITE_ADD', siloId: TARGET, order: BAL.conquest.conqueredStartOrder });
  // A garrison squad standing on it, which is what the yield has to beat.
  // Six, which is what the campaign measurement used and what a player
  // actually stations on a holding — not `squadMin`. Sizing this at the
  // minimum was how the first version of this check passed against the old
  // 18/10 literals: 4.6 a day beats a four-soldier upkeep of 3.6 and loses to
  // a six-soldier one of 5.4, so the bar has to be the garrison people really
  // leave there.
  const GARRISON = 6;
  store.dispatchAll(formSquad(s, 'Occupation'));
  const sqId = s.military.squadIds[0];
  const adults = s.citizenIds.map((i) => s.citizens[i]).filter((c) => c.age >= 20 && c.status !== 'dead');
  for (let i = 0; i < GARRISON; i++) {
    if (adults[i]) store.dispatch({ type: 'SQUAD_MEMBER', squadId: sqId, citizenId: adults[i].id });
  }

  const yielded = {};
  for (const a of worldDay(s)) {
    if (a.type === 'RESOURCE_DELTA') for (const [k, v] of Object.entries(a.deltas || {})) {
      yielded[k] = (yielded[k] || 0) + v;
    }
  }
  const total = Object.values(yielded).reduce((a, b) => a + b, 0);
  const crewed = s.military.squads[sqId].members.length;
  const upkeep = crewed *
    (BAL.military.barracksFoodPerSoldierPerDay + BAL.military.stipendChitsPerSoldierPerDay);

  // A margin, not a hair. "Barely positive" is not "a permanent share of
  // everything they make", and it is not worth six people standing still,
  // six jobs left empty and a point of Order a day.
  if (!(total > upkeep * 2)) {
    fail(
      `a holding sent home ${total.toFixed(1)} a day against a garrison of ${crewed} that eats ` +
      `${upkeep.toFixed(1)} — that does not pay for the people standing on it, let alone the jobs they left`
    );
  } else {
    ok(`a holding pays for its garrison: ${total.toFixed(1)} a day home against ${upkeep.toFixed(1)} for ${crewed} soldiers`);
  }

  // Dominion has to be reachable by a player who pursues it. The reference
  // player peaks at 2 concurrent holdings, so the bar must be near that
  // rather than at a number the world has collapsed past by the time the
  // research lands.
  if (BAL.endings.dominionSilosRequired > 4) {
    fail(
      `Dominion needs ${BAL.endings.dominionSilosRequired} holdings at once, each pinning a garrison squad — ` +
      'measured, takeable silos fall to 2-5 by day 700 and the reference player peaks at 2'
    );
  } else {
    ok(`Dominion asks for ${BAL.endings.dominionSilosRequired} holdings at once, against a reference peak of 2`);
  }
}

// ---- 24. the grudge has an exit, and a neighbour's war is not yours ---------
//
// Every escalation in the raid loop was world-driven and every de-escalation
// needed a panel the world had closed. A *repelled* raid still cost 8
// reputation, and nothing but player diplomacy ever raises it — so four clean
// repulses walked The Anvil from -15 to -47, each one making the next raid
// likelier via the grudge path, which bypasses the opportunity conjunction so
// arming up stops helping. There was no play, not even a perfect one, that
// walked a grudge back.
{
  const store = newStore(606);
  const s = store.state;
  const before = s.world.silos[5].reputation;
  s.world.pendingRaid = { siloId: 5, strength: 0.2, day: s.clock.day - BAL.raid.graceDays };
  store.dispatchAll(formSquad(s, 'Watch'));
  const sqId = s.military.squadIds[0];
  const adults = s.citizenIds.map((i) => s.citizens[i]).filter((c) => c.age >= 20 && c.status !== 'dead');
  let g = 0;
  for (let i = 0; i < 8; i++) {
    const c = adults[i];
    if (!c) continue;
    store.dispatch({ type: 'SQUAD_MEMBER', squadId: sqId, citizenId: c.id });
    const id = 'g' + ++g;
    s.military.gear[id] = { id, item: 'mag_rifle', kind: 'weapon', durability: BAL.gear.durabilityMax, assignedTo: c.id };
    s.citizens[c.id].gear = { ...(s.citizens[c.id].gear || {}), weapon: id };
  }
  s.resources.ammo = 5000;
  store.dispatchAll(raid.simulateDay(s));

  if (!s.stats.raidsRepelled) {
    fail('the fixture did not repel the raid, so it cannot show what repelling one is worth');
  } else if (!(s.world.silos[5].reputation > before)) {
    fail(
      `turning a raid back moved reputation from ${before} to ${Math.round(s.world.silos[5].reputation)} — ` +
      'winning still makes the next raid likelier, so there is no way out of a grudge'
    );
  } else {
    ok(`beating a raid at the door is the way out of a grudge: ${before} -> ${Math.round(s.world.silos[5].reputation)}`);
  }
}
{
  // A war between two *other* silos used to collapse your options for them to
  // "Sue for peace" alone — refused, because you are not at war.
  const store = newStore(707);
  const s = store.state;
  const silo = s.world.silos[16];
  silo.contact = 'radio';
  const peaceful = availableActions(s, silo).length;
  store.dispatch({ type: 'WORLD_WAR', a: 16, b: 5, at: s.clock.day });
  const duringOthersWar = availableActions(s, silo).length;

  if (!(duringOthersWar === peaceful)) {
    fail(
      `a war between two other silos cut your options for one of them from ${peaceful} to ${duringOthersWar} — ` +
      'their private war closed your radio'
    );
  } else {
    ok(`a neighbour's war with somebody else leaves your options alone (${peaceful} either way)`);
  }
}

// ---- 25. a holding sliding toward revolt says so before it goes ------------
//
// `conqueredStartOrder` is derived so the slide takes `holdGarrisonDays`
// rather than being a cliff — and nothing in src/ui or src/render drew a
// satellite's order, so the player's first word was the revolt itself.
{
  const store = newStore(808);
  const s = store.state;
  store.dispatch({ type: 'SATELLITE_ADD', siloId: 16, order: BAL.conquest.conqueredStartOrder });

  const quiet = directives(s).find((d) => d.id === 'satellite_order');
  if (quiet) fail('a freshly-taken holding at full starting order already nagged about revolting');

  s.world.satellites[0].order = BAL.directives.satelliteWarnOrder - 5;
  const warned = directives(s).find((d) => d.id === 'satellite_order');
  if (!warned) {
    fail('a holding sliding toward revolt produced no standing order — the countdown is still invisible');
  } else if (!/\d/.test(warned.why)) {
    fail(`the satellite warning does not say how long is left: "${warned.why}"`);
  } else {
    ok(`a sliding holding raises an order before it revolts: "${warned.text}"`);
  }
}

// ---- 26. two squads home on one day both get decontaminated ----------------
//
// `pendingDecon` is a single slot and `EXPEDITION_RESOLVE` assigned to it, so
// the second squad home overwrote the first — and `DECON` is the only thing
// besides a crewed Clinic that removes a dose, so those people carried their
// radiation for the rest of the campaign with no prompt. Always possible;
// conquest made it ordinary, because the breach needs two crewed squads and
// every conquest run is the same six-day band.
{
  const store = newStore(1212);
  const s = store.state;
  const ids = s.citizenIds.slice(0, 8);
  const first = ids.slice(0, 4);
  const second = ids.slice(4, 8);

  s.expeditions.active = [
    { id: 1, squadId: 1, band: 'approach', roster: first, purpose: 'salvage', returnDay: 0, resolved: false },
    { id: 2, squadId: 2, band: 'approach', roster: second, purpose: 'salvage', returnDay: 0, resolved: false },
  ];
  store.dispatch({ type: 'EXPEDITION_RESOLVE', id: 1, survivors: first, casualties: [], radiation: 40, journal: [] });
  store.dispatch({ type: 'EXPEDITION_RESOLVE', id: 2, survivors: second, casualties: [], radiation: 90, journal: [] });

  const waiting = s.pendingDecon?.members || [];
  const missing = first.filter((id) => !waiting.includes(id));
  if (missing.length) {
    fail(
      `${missing.length} of the first squad home are not queued for decon — the second squad's return ` +
      'overwrote them, and nothing else will ever offer them a wash'
    );
  } else if (waiting.length !== 8) {
    fail(`decon is waiting on ${waiting.length} people, not the 8 who came back`);
  } else {
    ok(`two squads home on one day both queue for decon: ${waiting.length} waiting, worst dose ${Math.round(s.pendingDecon.radiation)}`);
  }
}

// ---- 27. the things that could be deleted without a suite noticing ---------
//
// A mutation sweep over this branch found twelve changes that reverted in
// silence. The four with real consequences are pinned here. The rest are
// covered by the sections above, or were judged not worth a fixture that
// could only pass — see the note in military.js about one budget and one
// predicate.
{
  // A non-aggression pact stops a raid. §10 sets `treaties = []`, so its
  // fixture could never see this guard at all: deleting it left the suite
  // green while every pact in the game stopped meaning anything.
  const raidsWith = (treaties) => {
    const store = newStore(9001);
    const s = store.state;
    const silo = s.world.silos[5];
    silo.contact = 'radio';
    silo.reputation = BAL.diplomacy.raidGrudgeReputation - 50;
    silo.treaties = treaties;
    let n = 0;
    for (let d = 0; d < 400; d++) {
      s.clock.day = d;
      for (const a of diploTick(s)) {
        if (a.type === 'WORLD_EVENT_QUEUE' && a.event?.kind === 'raid' && a.event.siloId === 5) n++;
      }
    }
    return n;
  };
  const without = raidsWith([]);
  const withNap = raidsWith([{ kind: 'nap', with: 12, since: 0 }]);
  if (!without) fail('the pact fixture never produced a raid, so it cannot show a pact stopping one');
  else if (withNap) fail(`a non-aggression pact did not stop the raids: ${withNap} over 400 days`);
  else ok(`a non-aggression pact stops the raids it promises to: ${without} without one, 0 with`);
}
{
  // The hold's ammunition runs out. `holdAmmoDecayPerFight` and the
  // `ammoFactorOverride` that carries it were untested anywhere, §11
  // included — "no resupply inside somebody else's silo" is the stage's
  // stated difficulty and nothing checked it happened.
  const run = () => {
    const store = newStore(4242);
    const s = store.state;
    s.clock.day = 300;
    s.resources.ammo = 9000;
    const ids = s.citizenIds.filter((i) => s.citizens[i].age >= 20).slice(0, BAL.military.squadMax);
    let g = 0;
    for (const cid of ids) {
      for (const [kind, item] of [['suit', 'suit_4'], ['weapon', 'mag_rifle'], ['armor', 'composite_rig']]) {
        const id = 'g' + ++g;
        s.military.gear[id] = { id, item, kind, durability: BAL.gear.durabilityMax, assignedTo: cid };
        s.citizens[cid].gear = { ...(s.citizens[cid].gear || {}), [kind]: id };
      }
    }
    s.world.silos[6].conquest = { stage: 'hold', scoutRuns: 2, undermined: true, defenseMult: 0.75 };
    return resolveConquestRun(s, { id: 61, band: 'approach', target: 6, purpose: 'hold', roster: ids, leaderId: ids[0] });
  };
  // The override has to actually reach the fight, which asserting the
  // constant does not show: reading `BAL.conquest.holdAmmoDecayPerFight` here
  // passes just as well against a combat.js that has stopped consulting
  // `ammoFactorOverride` at all. So the same squad fights the same garrison
  // on the same seed at full pouches and at a fifth of them, and the two must
  // not come out the same.
  const out = run();
  const floors = (out.journal.join('\n').match(/^— Floor /gm) || []).length;
  if (floors < 3) {
    fail(`the hold fixture only reached ${floors} floors — too few to show the ammunition running down`);
  }

  const store = newStore(4242);
  const s = store.state;
  s.clock.day = 300;
  s.resources.ammo = 9000;
  const squad = s.citizenIds.filter((i) => s.citizens[i].age >= 20).slice(0, BAL.military.squadMax);
  const enemy = garrisonForce(s.world.silos[6], BAL.conquest.holdGarrisonScale, 0.75, 0);
  const at = (ammo) => resolveCombat(s, squad, enemy, { battleId: 'ammo-probe', ammoFactorOverride: ammo }).ratio;
  const full = at(1);
  const dry = at(0.2);

  if (!(full > dry * 1.5)) {
    fail(
      `the same squad fights the same garrison at ${full.toFixed(2)} on full pouches and ${dry.toFixed(2)} ` +
      'on a fifth of them — ammoFactorOverride is not reaching the fight, so the hold resupplies itself'
    );
  } else if (!(BAL.conquest.holdAmmoDecayPerFight > 0)) {
    fail('holdAmmoDecayPerFight is zero — the pouches never run down however well the override works');
  } else {
    ok(
      `the hold runs out of ammunition: ${floors} floors on one load-out, and the override bites ` +
      `(${full.toFixed(2)} full against ${dry.toFixed(2)} dry)`
    );
  }
}
{
  // The v16 backfill. wiring §7 walks the chain but asserts only floors,
  // found rooms and shoring; catchup §5 checks crises, ending and floors. So
  // making the whole of migration 16 a no-op — dropping `world.pendingRaid`,
  // every silo's `conquest` block and the three raid stats — was invisible,
  // and a v15 save would load into a build whose raid and conquest code reads
  // all three.
  let state = { v: 15, world: { silos: { 5: { id: 5 } }, satellites: [] }, stats: {} };
  for (let v = 15; v < SCHEMA_VERSION; v++) if (MIGRATIONS[v]) state = MIGRATIONS[v](state) || state;
  const missing = [];
  if (!('pendingRaid' in state.world)) missing.push('world.pendingRaid');
  if (!state.world.silos[5].conquest) missing.push('silo.conquest');
  for (const k of ['raidsRepelled', 'raidsLost', 'silosTaken']) {
    if (!(k in state.stats)) missing.push(`stats.${k}`);
  }
  if (missing.length) {
    fail(`migrating a v15 save left ${missing.join(', ')} undefined — the raid and conquest code reads all of them`);
  } else {
    ok('a v15 save is backfilled with everything the raid and conquest code reads');
  }
}
{
  // Two raids maturing on the same day take the stronger, not the later.
  const store = newStore(77);
  const s = store.state;
  store.dispatch({ type: 'PENDING_RAID', siloId: 5, strength: 0.9 });
  store.dispatch({ type: 'PENDING_RAID', siloId: 16, strength: 0.2 });
  if (s.world.pendingRaid?.strength !== 0.9) {
    fail(`a weaker second raid replaced a stronger pending one (strength ${s.world.pendingRaid?.strength})`);
  } else {
    ok('two raids on one day merge to the stronger, rather than the later overwriting it');
  }
}

// ---- 28. the silo has people in it, and you can see who is working --------
//
// The cross-section drew `citizenFloorsRendered` (3) floors of people centred
// on the geometric middle of the viewport, while the viewport shows twenty-one
// floors. Measured on a day-220 save: focusing floor 2 clamps `camY` to -20,
// which puts the centre at world y 399 — floor 10 — so the game drew people on
// floors 9-11 while every staffed room was on floors 1-7. The silo rendered
// empty, and not because the sprites were faint.
//
// The camera is faked rather than constructed, because `canvas.js` owns a real
// one and this is a check about which floors get drawn, not about the DOM.
{
  const store = newStore(0x1234);
  const s = store.state;
  const game = new Game(store);
  store.dispatchAll(autoAssign(s));
  // Short, like the rest of this file. A hundred and twenty unmanaged days
  // starves the silo to nobody, and an empty roster proves nothing about where
  // people are drawn — the first attempt at this fixture ran 120 and reported
  // "no staffed rooms" because everyone was dead.
  game.runDays(5);
  // Crew whatever was built during those days, or the rooms stand empty and
  // this section proves nothing about where people are drawn.
  store.dispatchAll(autoAssign(s));

  // The floors people are actually on, derived the way drawCitizens derives
  // them, so the expectation cannot drift from the thing under test.
  const staffed = new Set();
  for (const id of s.citizenIds) {
    const c = s.citizens[id];
    if (!c || c.status === 'dead' || c.status === 'expedition' || !c.job) continue;
    const room = s.silo.rooms[c.job.roomId];
    if (room) staffed.add(room.floor);
  }

  // A viewport the shape of a phone: 21 floors tall, parked at the top.
  const drawnAt = new Set();
  const ctx = {
    set fillStyle(_v) {}, get fillStyle() { return ''; },
    fillRect(x, y) { drawnAt.add(Math.floor(y / FLOOR_H) + 1); },
  };
  const cam = {
    camY: -20, time: 1000, drawn: 0, spriteBudget: 400,
    viewWorldH: () => 838,
    visibleFloorRange: () => ({ from: 1, to: 22 }),
  };
  drawCitizens(ctx, s, cam);

  const missed = [...staffed].filter((f) => f <= 22 && !drawnAt.has(f));
  if (!staffed.size) {
    fail('the fixture had no staffed rooms, so it cannot show whether their floors are drawn');
  } else if (missed.length) {
    fail(
      `floors ${missed.join(', ')} have staff and no people were drawn on them — ` +
      `the cross-section is only drawing floors ${[...drawnAt].sort((a, b) => a - b).join(', ')}`
    );
  } else {
    ok(`every staffed floor on screen has people on it (${[...staffed].sort((a, b) => a - b).join(', ')})`);
  }

  // And nobody stands in the dark. Idle citizens used to drift across the full
  // `slotsPerFloor` width whether or not anything was built there, so a
  // half-built floor put people outside its last room with no floor under them.
  const builtSpan = (floorN) => {
    let lo = Infinity, hi = -Infinity;
    for (const room of Object.values(s.silo.rooms)) {
      if (room.floor !== floorN) continue;
      lo = Math.min(lo, room.slot * SLOT_W);
      hi = Math.max(hi, (room.slot + room.width) * SLOT_W);
    }
    return hi > lo ? { lo, hi } : null;
  };
  const strays = [];
  const ctx2 = {
    set fillStyle(_v) {}, get fillStyle() { return ''; },
    fillRect(x, y) {
      const floorN = Math.floor(y / FLOOR_H) + 1;
      const span = builtSpan(floorN);
      if (span && (x < span.lo - SLOT_W || x > span.hi + SLOT_W)) strays.push({ floorN, x });
    },
  };
  cam.drawn = 0;
  drawCitizens(ctx2, s, cam);
  if (strays.length) {
    fail(
      `${strays.length} people were drawn outside the built part of their floor ` +
      `(e.g. floor ${strays[0].floorN} at x ${Math.round(strays[0].x)}) — standing in unexcavated rock`
    );
  } else {
    ok('nobody is drawn outside the built part of their floor');
  }
}

// ---- 29. the shirt says whether somebody is working -------------------------
//
// The whole point of the colour: a glance across a floor separates the crew
// from everyone else. `citizenRole` keyed off the job somebody *held* rather
// than whether they were standing in it, so a farmer looked identical asleep
// and at the bench, and the biggest group of non-workers in the game — 53 of
// the 93 people inside a day-220 silo were children — wore the working blue.
{
  const store = newStore(4242);
  const s = store.state;
  const adult = s.citizenIds.map((i) => s.citizens[i]).find((c) => c.age >= 25 && c.age < 60);
  if (!adult) fail('no working-age adult in the fixture');
  else {
    adult._jobSkill = 'farming';

    adult.status = 'working';
    const onShift = citizenRole(adult);
    adult.status = 'idle';
    const offShift = citizenRole(adult);

    if (onShift === offShift) {
      fail(`the same person reads as "${onShift}" both at a post and off shift — the shirt says nothing`);
    } else if (onShift !== 'farmer') {
      fail(`somebody working a farming post drew as "${onShift}", not their unit`);
    } else if (offShift !== 'resident') {
      fail(`somebody off shift drew as "${offShift}", not the off-shift coveralls`);
    } else {
      ok(`the shirt follows the shift: "${onShift}" at a post, "${offShift}" off it`);
    }

    // Off shift is one colour for everybody, whatever job they hold — that is
    // what makes "coloured means working" a rule rather than a tendency.
    adult._jobSkill = 'mechanics';
    if (citizenRole(adult) !== 'resident') {
      fail('a mechanic off shift drew as something other than the shared off-shift role');
    }

    // Condition still outranks the shift: somebody sick enough to be a warning
    // must not be hidden by a job, and somebody outside is outside.
    adult.status = 'working';
    adult.radiation = BAL.citizens.radiation.sicknessThreshold + 1;
    if (citizenRole(adult) !== 'irradiated') fail('a working citizen hid their radiation sickness');
    adult.radiation = 0;
    adult.status = 'expedition';
    if (citizenRole(adult) !== 'hazmat') fail('a citizen on an expedition did not draw in a suit');
    else ok('and condition still outranks it: sickness and the surface both win');
  }
}

// ---- 30. every figure the renderer asks for exists in the atlas -------------
//
// `citizenRole` returning a name the art does not bake is a 404 and a citizen
// who renders as nothing. This is the same guard §17 gives rooms, for people —
// and it is checked against the art source rather than a copy of the list, so
// adding a role to one side and not the other is a red suite.
{
  const src = readSource('../tools/art/citizens.mjs');
  const m = src.match(/export const ROLES = \[([\s\S]*?)\];/);
  if (!m) {
    fail('could not find ROLES in tools/art/citizens.mjs — this check has gone stale');
  } else {
    const drawn = new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    // Every branch citizenRole can take, driven through it rather than copied.
    const asked = new Set();
    const probe = (patch) => {
      const c = {
        id: 1, age: 30, status: 'idle', radiation: 0, squadId: null,
        skills: {}, traits: [], ...patch,
      };
      asked.add(citizenRole(c));
    };
    probe({ radiation: BAL.citizens.radiation.sicknessThreshold + 1 });
    probe({ status: 'expedition' });
    probe({ age: 5 });
    probe({ age: 90 });
    probe({ status: 'working', squadId: 3 });
    for (const skill of ['farming', 'mechanics', 'engineering', 'medicine', 'admin', 'combat']) {
      probe({ status: 'working', _jobSkill: skill });
    }
    probe({ status: 'working' });
    probe({});

    const missing = [...asked].filter((r) => !drawn.has(r));
    if (missing.length) {
      fail(`citizenRole() can return ${missing.join(', ')}, which the art tool does not draw — those citizens render as nothing`);
    } else {
      ok(`every one of the ${asked.size} figures the renderer asks for is drawn by the art tool`);
    }
  }
}

// ---- 31. everyone off shift wears the same colour --------------------------
//
// The rule the cross-section is read by: coloured means at a post, grey means
// not. `citizenRole` only reaches 'child' and 'elder' after the shift check,
// so they are off-shift roles by construction — and they were painted in the
// working denim. That was the largest share of the error, not a corner of it:
// measured on a day-220 silo, 53 of the 93 people inside were children, so
// most of the "not working" population wore the colour that means working.
//
// Checked against the pixels the art tool actually bakes, because this is a
// claim about colour and nothing else can confirm it.
{
  const px = (role) => {
    const cap = { w: CW, h: CH, px: new Array(CW * CH).fill(null),
      set(x, y, c) { if (c && x >= 0 && y >= 0 && x < CW && y < CH) this.px[y * CW + x] = c; } };
    drawCitizenArt(cap, { action: 'idle', frame: 0, role, seed: 'same' });
    const seen = new Map();
    for (const c of cap.px) if (c) { const k = c.join(','); seen.set(k, (seen.get(k) || 0) + 1); }
    return seen;
  };
  // Every coloured pixel on the figure, not just the commonest one.
  //
  // The first version of this took the single most-common non-ink colour as
  // "the suit". That reads the *lit* tone, and a suit is three tones — so a
  // mutation that put `c.suit` back to denim and left `suitLit`/`suitDark`
  // alone changed nothing it looked at and passed. A partial revert is
  // exactly the shape this is meant to catch.
  //
  // Dark pixels are skipped because boots and the keyline are near-black and
  // slightly blue whatever the coveralls are. Skin cannot be filtered by hue:
  // `skinShade` is (196,161,129) and the mechanic's coverall is (160,112,42),
  // which are the same warm family, so a filter wide enough to drop the face
  // drops the one working colour closest to it. The face contributes one or
  // two pixels at this size, so the comparison below is a ratio rather than a
  // threshold of zero — a suit is three tones over about thirty pixels, and
  // reverting even one of them clears it by a wide margin.
  const saturatedPixels = (role) => {
    let n = 0;
    for (const [k, count] of px(role)) {
      const [r, g, b] = k.split(',').map(Number);
      if (r > 200) continue;                       // skin
      if (Math.max(r, g, b) < 60) continue;        // boots, hair, keyline
      if (Math.max(r, g, b) - Math.min(r, g, b) >= 18) n += count;
    }
    return n;
  };

  const offShift = ['resident', 'child', 'elder'];
  const FACE = 3; // what a head contributes, and the most cloth may not exceed
  const worst = Math.max(...offShift.map(saturatedPixels));
  const wrong = offShift.filter((r) => saturatedPixels(r) > FACE);
  const crew = saturatedPixels('base');

  if (wrong.length) {
    fail(
      `${wrong.map((r) => `${r} (${saturatedPixels(r)}px)`).join(', ')} carry coloured cloth — ` +
      'they can only be reached off shift, so they read as crew when they are not'
    );
  } else if (!(crew >= worst * 4)) {
    fail(
      `a working figure carries ${crew} coloured pixels against ${worst} on an off-shift one — ` +
      'that is not a difference anybody can see across a floor'
    );
  } else {
    ok(`the crew wear colour and nobody else does: ${crew} coloured pixels working against ${worst} off shift`);
  }
}

// ---- 32. the guards are on duty, and they look like it ---------------------
//
// Two failures, and the first was mine from the commit before this one.
//
// Making the shift check `status === 'working'` dropped every soldier through
// to the off-shift grey, because a garrison squad's members carry
// `status: 'training'` — they are standing watch and drilling, which *is*
// their post. The silo's guards were drawn as civilians who had knocked off.
// `economy.js` already counts both statuses as being at work; the renderer
// now draws the same line.
{
  const store = newStore(4242);
  const s = store.state;
  const game = new Game(store);
  store.dispatchAll(autoAssign(s));
  game.runDays(3);
  store.dispatchAll(formSquad(s, 'Watch'));
  const sqId = s.military.squadIds[0];
  const adults = s.citizenIds.map((i) => s.citizens[i]).filter((c) => c.age >= 20 && c.status !== 'dead');
  for (let i = 0; i < BAL.military.squadMin; i++) {
    if (adults[i]) store.dispatch({ type: 'SQUAD_MEMBER', squadId: sqId, citizenId: adults[i].id });
  }
  game.runDays(2);

  const squad = s.military.squads[sqId];
  const roles = squad.members.map((cid) => citizenRole(s.citizens[cid]));
  const civilian = roles.filter((r) => r !== 'militia');

  if (!squad.members.length) {
    fail('the fixture crewed no squad, so it cannot show how a guard is drawn');
  } else if (squad.deployed) {
    fail('the fixture squad went outside — this section is about the ones standing watch');
  } else if (civilian.length) {
    fail(
      `${civilian.length} of ${roles.length} in a garrison squad drew as ${[...new Set(civilian)].join('/')} ` +
      'rather than militia — the silo\'s guards are being drawn as off-duty civilians'
    );
  } else {
    ok(`a garrison squad is drawn as soldiers, standing watch counting as duty (${roles.length} of ${roles.length})`);
  }

  // Off duty is still off duty, soldier or not: somebody asleep in the dorm is
  // not standing anywhere, and the rule the cross-section is read by does not
  // get an exception for rank.
  const resting = s.citizens[squad.members[0]];
  const wasStatus = resting.status;
  resting.status = 'idle';
  if (citizenRole(resting) === 'militia') {
    fail('a soldier off duty still wore the militia colour, so "coloured means working" is not a rule');
  } else {
    ok('and a soldier off duty is grey like everybody else');
  }
  resting.status = wasStatus;
}

// ---- 33. no two jobs on screen are the same colour --------------------------
//
// The point of colouring the crew is telling them apart, and militia failed
// it: as dark denim a soldier sat 23 from `base` and 18 from `resident` on the
// mean of their torso, which is to say a fighter was harder to distinguish
// from somebody off shift than an ordinary worker was.
//
// Measured on the cloth rather than the whole figure. Sampling the torso block
// alone is not enough either — the militia's plates and the mechanic's belt
// cover most of it, so a mean over that region compares *cues* and reported
// those two as 22 apart while the eye reads maroon against gold. The suit
// tones are read from the source instead, which is the thing being chosen.
{
  const src = readSource('../tools/art/citizens.mjs');
  // `case 'role':` ... `c.suit = tone('name', ...)` — the family each role
  // dresses in, which is the decision this section is about.
  const family = {};
  for (const m of src.matchAll(/case '(\w+)':[\s\S]{0,900}?c\.suit = tone\('(\w+)'/g)) {
    family[m[1]] = m[2];
  }
  family.base = (src.match(/\n    suit: tone\('(\w+)'/) || [])[1];

  const crew = ['base', 'farmer', 'mechanic', 'medic', 'deputy', 'militia'];
  const known = crew.filter((r) => family[r]);
  if (known.length < 4) {
    fail(`could not read the suit family for ${crew.filter((r) => !family[r]).join(', ')} — this check has gone stale`);
  } else {
    // medic is the exception and says so in its own comment: the coat is bone
    // and the jumpsuit under it stays denim, because the coat is what is seen.
    const wearing = known.filter((r) => r !== 'medic').map((r) => `${r}:${family[r]}`);
    const families = wearing.map((w) => w.split(':')[1]);
    const dupes = families.filter((f, i) => families.indexOf(f) !== i);
    if (dupes.length) {
      fail(`${wearing.join(', ')} — ${[...new Set(dupes)].join(', ')} is worn by more than one job on screen`);
    } else {
      ok(`every job on screen wears its own colour: ${wearing.join(', ')}`);
    }
    // And none of them wears the off-shift grey, which would make that job
    // invisible against the population it is supposed to stand out from.
    const greyed = known.filter((r) => family[r] === 'steel');
    if (greyed.length) fail(`${greyed.join(', ')} wear the off-shift grey, so they read as nobody working`);
  }
}

// ---- 34. every animation the atlas bakes is one the game can reach ---------
//
// Before this section, three of five were not. Measured over a 200-day
// campaign the renderer only ever asked for `work` and `walk`: `idle` was
// unreachable because anybody without a post counted as "moving", and `sleep`
// was gated on a status nothing in src/ ever wrote. That is 110 frames of
// baked art the game could not display, and nothing failed — which is exactly
// the shape of every other bug on this branch.
{
  const store = newStore(0x1234);
  const s = store.state;
  const game = new Game(store);
  store.dispatchAll(autoAssign(s));
  game.runDays(5);
  store.dispatchAll(autoAssign(s));
  store.dispatchAll(formSquad(s, 'Watch'));
  {
    const sqId = s.military.squadIds[0];
    const adults = s.citizenIds.map((i) => s.citizens[i]).filter((c) => c.age >= 20 && c.status !== 'dead');
    for (let i = 0; i < BAL.military.squadMin; i++) {
      if (adults[i]) store.dispatch({ type: 'SQUAD_MEMBER', squadId: sqId, citizenId: adults[i].id });
    }
  }

  const cam = {
    camY: -20, time: 0, drawn: 0, spriteBudget: 400,
    viewWorldH: () => 838, visibleFloorRange: () => ({ from: 1, to: 22 }),
  };
  const seen = new Set();
  const sweep = () => {
    for (let k = 0; k < 30; k++) {
      cam.time = k * 700;
      for (const p of citizensInView(s, cam)) seen.add(p.action);
    }
  };

  s.clock.shift = 4; sweep();                       // a day shift
  s.clock.shift = BAL.render.nightShifts[0]; sweep(); // and the small hours
  s.clock.shift = 4;
  s.world.pendingRaid = { siloId: 5, strength: 0.6, day: s.clock.day };
  sweep();                                          // with raiders at the door
  s.world.pendingRaid = null;
  // Somebody badly hurt, and somebody freshly dead.
  const hurt = s.citizens[s.citizenIds[1]];
  hurt.health = Math.max(1, BAL.render.injuredBelowHealth - 10);
  store.dispatch({ type: 'CITIZEN_DIE', id: s.citizenIds[3], cause: 'a raid', text: 'a test death' });
  sweep();

  const baked = ['walk', 'idle', 'work', 'sleep', 'injured', 'talk', 'fight'];
  const unreachable = baked.filter((a) => !seen.has(a));
  if (unreachable.length) {
    fail(
      `the atlas bakes ${unreachable.join(', ')} and no state of the game asks for ${unreachable.length === 1 ? 'it' : 'them'} — ` +
      `${unreachable.length * 11 * 4} frames of art nobody can see`
    );
  } else {
    ok(`all ${baked.length} animations are reachable in play: ${[...seen].sort().join(', ')}`);
  }
}

// ---- 35. a death leaves a mark, and the mark waits to be acknowledged ------
//
// Deaths were a log line. By the time anything could draw the person they were
// off `citizenIds` and their job — the only record of where they had been —
// had been nulled by the same reducer, four lines down. CITIZEN_DIE now
// records the tick and the floor before it clears the post.
//
// A collapse animation was built first and taken out again: it played for a
// few seconds and then the moment was gone whether or not anybody was looking
// at that floor. A skull waits. It is the only thing in the game that asks the
// player to acknowledge it, and until they do it stays where it happened.
{
  const store = newStore(909);
  const s = store.state;
  const game = new Game(store);
  store.dispatchAll(autoAssign(s));
  game.runDays(3);

  if (deathMarks(s).length) fail('a silo where nobody has died was already marked');

  const victim = s.citizens[s.citizenIds.find((i) => s.citizens[i].job)];
  const wasFloor = s.silo.rooms[victim.job.roomId].floor;
  store.dispatch({ type: 'CITIZEN_DIE', id: victim.id, cause: 'a test', text: 'a test death' });

  const marks = deathMarks(s);
  if (!marks.length) {
    fail('somebody died and the cross-section showed nothing — a death is still only a log line');
  } else if (marks[0].c.id !== victim.id) {
    fail('the mark drawn was not the person who died');
  } else if (marks[0].floor !== wasFloor) {
    fail(`the mark is on floor ${marks[0].floor}; they died on ${wasFloor}`);
  } else {
    ok(`a death leaves a mark where it happened (floor ${wasFloor})`);
  }

  // It does not time out. This is the whole difference from the animation it
  // replaced: a player who was looking at another floor still sees it.
  s.clock.tick += 10000;
  if (!deathMarks(s).length) fail('the mark expired on its own — a death the player never saw went unmarked');
  else ok('and it does not expire while the player has not seen it');

  // A tap clears it, and clears the right one.
  const other = s.citizens[s.citizenIds.find((i) => s.citizens[i].job)];
  store.dispatch({ type: 'CITIZEN_DIE', id: other.id, cause: 'a second test', text: 'another' });
  if (deathMarks(s).length !== 2) fail(`two deaths left ${deathMarks(s).length} marks`);

  const target = deathMarks(s)[0];
  const hit = deathMarkAt(s, target.x, target.y - 8);
  if (!hit) {
    fail('tapping a mark dead centre found nothing — it cannot be dismissed');
  } else {
    store.dispatch({ type: 'DEATH_ACKNOWLEDGE', id: hit.c.id });
    const left = deathMarks(s);
    if (left.some((m) => m.c.id === hit.c.id)) fail('the acknowledged mark is still on the cross-section');
    else if (left.length !== 1) fail(`acknowledging one mark left ${left.length}, not 1 — it cleared the wrong ones`);
    else ok('a tap clears the mark it landed on, and only that one');
  }

  // A campaign kills steadily, so the marks are capped — newest first, older
  // ones hidden rather than dismissed. Without this a day-220 silo stood with
  // fifteen skulls in it and the living were unreadable behind them.
  {
    const many = newStore(1234);
    const m = many.state;
    new Game(many).runDays(3);
    many.dispatchAll(autoAssign(m));
    const victims = m.citizenIds.slice(0, BAL.render.maxDeathMarks + 4);
    for (const id of victims) {
      m.clock.tick++;
      many.dispatch({ type: 'CITIZEN_DIE', id, cause: 'a test', text: 'x' });
    }
    const shown = deathMarks(m);
    if (shown.length !== BAL.render.maxDeathMarks) {
      fail(`${victims.length} deaths put ${shown.length} marks on screen, not ${BAL.render.maxDeathMarks}`);
    } else if (!shown.every((x) => victims.slice(-BAL.render.maxDeathMarks).includes(x.c.id))) {
      fail('the marks shown are not the most recent deaths');
    } else {
      ok(`${victims.length} deaths show ${shown.length} marks, newest first`);
    }
    // Hidden, not forgotten: clearing one brings the next up.
    many.dispatch({ type: 'DEATH_ACKNOWLEDGE', id: shown[0].c.id });
    if (deathMarks(m).length !== BAL.render.maxDeathMarks) {
      fail('clearing a mark did not bring an older one up — the hidden deaths were lost');
    } else {
      ok('and clearing one brings an older one up, so none are lost');
    }
  }

  // And a tap nowhere near one does nothing, or every tap on the silo would
  // silently dismiss a death somewhere off screen.
  const far = deathMarkAt(s, target.x + 400, target.y + 400);
  if (far) fail('a tap 400 units away still hit a death mark');
  else ok('and a tap away from a mark leaves it alone');
}

// ---- 36. children are drawn as children ------------------------------------
//
// The threshold is the sim's own working age rather than a number picked for
// the renderer, so the figure and the job market cannot disagree about who is
// a child.
{
  const store = newStore(31);
  const s = store.state;
  const c = s.citizens[s.citizenIds[0]];
  c.status = 'idle';
  c.radiation = 0;
  c.squadId = null;

  c.age = BAL.citizens.workingAgeMin - 1;
  const young = citizenRole(c);
  c.age = BAL.citizens.workingAgeMin + 1;
  const grown = citizenRole(c);

  if (young !== 'child') fail(`somebody a year under working age drew as "${young}"`);
  else if (grown === 'child') fail('somebody over working age still drew as a child');
  else ok(`children are drawn as children below the sim's own working age of ${BAL.citizens.workingAgeMin}`);

  // And a real campaign has them: this is the largest group in the silo, and
  // if the threshold or the status ordering broke, it would be silent.
  const store2 = newStore(0x1234);
  const s2 = store2.state;
  new Game(store2).runDays(5);
  store2.dispatchAll(autoAssign(s2));
  const kids = s2.citizenIds.filter((i) => citizenRole(s2.citizens[i]) === 'child').length;
  if (!kids) fail('no citizen in a real silo was drawn as a child');
  else ok(`and a real silo is full of them: ${kids} of ${s2.citizenIds.length}`);
}

// ---- 37. equipment outlives its owner --------------------------------------
//
// CITIZEN_DIE never touched `c.gear`, so every piece a dead citizen held kept
// `assignedTo` pointing at a corpse. `unassignedGear` — which is what
// `equipBest` and the armoury draw from — filters on exactly that field, so
// the kit was not destroyed, it was stranded: still in `state.military.gear`,
// still counted against storage, issuable to nobody, for ever. A silo that
// lost four soldiers lost four rifles it could still see in its inventory.
{
  const store = newStore(77);
  const s = store.state;
  new Game(store).runDays(3);
  store.dispatchAll(autoAssign(s));

  const victim = s.citizens[s.citizenIds[0]];
  s.military.gear.g1 = { id: 'g1', item: 'service_rifle', kind: 'weapon', durability: 100, assignedTo: victim.id };
  victim.gear = { weapon: 'g1', armor: null, suit: null };

  if (unassignedGear(s, 'weapon').length) fail('the fixture started with a free rifle, so it proves nothing');
  store.dispatch({ type: 'CITIZEN_DIE', id: victim.id, cause: 'a test', text: 'a test death' });

  const free = unassignedGear(s, 'weapon');
  if (!free.some((g) => g.id === 'g1')) {
    fail("a dead citizen's rifle did not come back to the rack — it is still assigned to a corpse and issuable to nobody");
  } else if (s.military.gear.g1.assignedTo !== null) {
    fail(`the rifle is on the rack but still assigned to ${s.military.gear.g1.assignedTo}`);
  } else {
    ok('a dead citizen\'s kit goes back on the rack, where somebody alive can draw it');
  }

  // And somebody alive actually draws it, which is the point rather than a
  // bookkeeping detail.
  const heir = s.citizens[s.citizenIds.find((i) => !s.citizens[i].gear?.weapon)];
  const acts = equipBest(s, heir.id);
  if (!acts.some((a) => a.type === 'GEAR_ASSIGN' && a.gearId === 'g1')) {
    fail('the rifle was free and equipBest did not offer it to anybody');
  } else {
    ok('and the next person to be equipped is offered it');
  }
}
{
  // Nobody alive, nobody to pick it up. The rule the player is given is that
  // gear survives a death; the corollary that makes it a decision rather than
  // a freebie is that a party wiped out four days into the waste does not post
  // its suits home.
  //
  // Driven through the real resolver on a real wipe. What guarantees it is
  // `outcome.gearLost` on the defeat and rout bands, not anything written for
  // the purpose: a winning outcome caps casualties at 0.35 of the party and
  // `round(1 * 0.35)` is zero, so a win cannot kill the last person standing
  // and a total wipe therefore always ends on an outcome that destroys kit.
  // A helper to strand it separately was written, measured as unreachable
  // across 400 seeds, and removed.
  let checked = 0;
  let leaked = null;
  for (let seed = 1; seed <= 6 && !leaked; seed++) {
    const store = newStore(seed);
    const s = store.state;
    s.clock.day = 200;
    s.resources.ammo = 0;
    const roster = s.citizenIds.slice(0, BAL.military.squadMin);
    const suits = [];
    let g = 0;
    for (const cid of roster) {
      const id = 's' + ++g;
      suits.push(id);
      s.military.gear[id] = { id, item: 'suit_1', kind: 'suit', durability: 100, assignedTo: cid };
      s.citizens[cid].gear = { weapon: null, armor: null, suit: id };
      s.citizens[cid].health = 12;
    }
    const out = resolveExpedition(s, {
      id: 900 + seed, squadId: 1, band: 'scar', purpose: 'salvage', target: null,
      launchDay: 200, returnDay: 200, roster, leaderId: roster[0], resolved: false,
    });
    const died = out.actions.filter((a) => a.type === 'CITIZEN_DIE').length;
    if (died < roster.length) continue;   // not a wipe; try another seed
    checked++;
    const destroyed = new Set(out.actions.filter((a) => a.type === 'GEAR_DESTROY').map((a) => a.id));
    const survivedTheWipe = suits.filter((id) => !destroyed.has(id));
    if (survivedTheWipe.length) leaked = { seed, n: survivedTheWipe.length };
    // And it says it once.
    const all = out.actions.filter((a) => a.type === 'GEAR_DESTROY').map((a) => a.id);
    if (all.length !== new Set(all).size) leaked = { seed, dupes: all.length - new Set(all).size };
  }
  if (!checked) {
    fail('no seed produced a total wipe, so this section proved nothing');
  } else if (leaked?.n) {
    fail(`${leaked.n} suits came home from a party that did not — a squad annihilated in the Scar posted its kit back by telegram`);
  } else if (leaked?.dupes) {
    fail(`the wipe scheduled ${leaked.dupes} duplicate GEAR_DESTROY actions`);
  } else {
    ok(`a party that never came home leaves its kit out there (${checked} real wipes, no duplicates)`);
  }
}

// ---- 38. grief passes ------------------------------------------------------
//
// `bereaved` is declared `temporary: true` in data/traits.js, its description
// ends "It will pass, or it will not", and until now it never passed: nothing
// in the codebase read that field and nothing ever dispatched the removal the
// CITIZEN_TRAIT reducer had supported all along. Measured over two 900-day
// campaigns before the fix, the standing bereaved fraction sat at 24-30% from
// day 300 onward — a quarter of the silo permanently at 0.85 work output and
// 1.4 morale swing, from losses taken hundreds of days earlier.
//
// Two questions, kept apart on purpose.
{
  // (a) The rate, measured where it is rolled.
  //
  // Sampling the same citizens for many days without ever applying the
  // removals turns this into one clean binomial: nobody sheds the trait, so
  // every day is another independent draw at the configured chance. A
  // campaign cannot answer this — `bereaved` is re-granted whenever another
  // partner dies, so what a campaign shows is an equilibrium between grief
  // arriving and grief lifting, and that moves with the death rate.
  const store = newStore(4242);
  const s = store.state;
  store.dispatchAll(autoAssign(s));
  new Game(store).runDays(3);

  const marked = s.citizenIds.slice();
  for (const id of marked) {
    const c = s.citizens[id];
    if (!c.traits.includes('bereaved')) c.traits.push('bereaved');
  }

  const DAYS = 200;
  const startDay = s.clock.day;
  let removals = 0;
  for (let d = 0; d < DAYS; d++) {
    s.clock.day = startDay + d;
    for (const a of populationDay(s, {})) {
      if (a.type !== 'CITIZEN_TRAIT' || a.trait !== 'bereaved') continue;
      if (a.remove) removals++;
    }
  }
  const draws = marked.length * DAYS;
  const rate = removals / draws;
  const want = BAL.citizens.griefPassChance;
  // ±3.5 sd on `draws` samples.
  //
  // Both sides read `griefPassChance`, so retuning it in balance.js moves the
  // band with it and this stays green — which is the point: it is a tunable,
  // and every tunable in this game lives there so it can be tuned. What the
  // band catches is the plumbing coming adrift from the number. Hardcoding the
  // roll to half the configured chance lands 15 sd out and fails; deleting the
  // roll fails at zero.
  const sd = Math.sqrt(want * (1 - want) / draws);
  if (!removals) {
    fail(`${draws} citizen-days of grief and it never once lifted — the roll is not in the daily loop`);
  } else if (Math.abs(rate - want) > 3.5 * sd) {
    fail(`grief lifts at ${(100 * rate).toFixed(3)}%/day, not the configured ` +
      `${(100 * want).toFixed(3)}% (${removals} of ${draws}, ±${(350 * sd).toFixed(3)}pp allowed)`);
  } else {
    ok(`grief lifts at the rate it is configured to (${removals} of ${draws} citizen-days, ` +
      `${(100 * rate).toFixed(3)}% vs ${(100 * want).toFixed(3)}%)`);
  }

  // And it is slow — read off the removals just counted, not off the config.
  //
  // This was `log(0.5) / log(1 - griefPassChance)` bounded to [20, 200] days,
  // which executes no product code whatsoever: it is arithmetic on a config
  // value asserting that the config value is in a range. It stayed green with
  // the chance retuned to two and a half times shipped. Using the observed
  // rate makes it a second reading of the measurement above rather than a
  // fact about balance.js, so it moves when the plumbing moves.
  const observedHalfLife = Math.log(0.5) / Math.log(1 - rate);
  if (observedHalfLife < 20 || observedHalfLife > 200) {
    fail(`at the rate this loop actually removes it, half the mourners are over it in ` +
      `${observedHalfLife.toFixed(0)} days, which is not a bereavement`);
  } else {
    ok(`and slowly: at the observed rate, half of them still carry it after ${observedHalfLife.toFixed(0)} days`);
  }
}
{
  // (b) The wiring, measured where the player would see it.
  //
  // (a) proves the roll happens and never applies a single one of its own
  // actions, so it would survive a store that dropped CITIZEN_TRAIT removals
  // on the floor. This drives the real day loop and looks at the citizens.
  const store = newStore(0x1234);
  const s = store.state;
  store.dispatchAll(autoAssign(s));
  const game = new Game(store);
  // The autopilot is the reference player, and without one the silo starves
  // long before grief has had time to lift: a bare `runDays(150)` kills every
  // citizen in the fixture and the section then proves nothing, loudly.
  const play = (n) => {
    for (let d = 0; d < n; d++) {
      game.runDays(1);
      s.meta.playedMs = s.clock.cycle * BAL.time.TICK_MS * TIME.ticksPerCycle;
      for (let i = 0; i < 3; i++) store.dispatchAll(autopilot(s));
    }
  };
  play(30);

  const marked = new Set();
  for (const id of s.citizenIds) {
    const c = s.citizens[id];
    if (!c.traits.includes('bereaved')) c.traits.push('bereaved');
    marked.add(id);
  }
  play(120);

  const alive = [...marked].filter((id) => s.citizens[id]?.status !== 'dead');
  const shed = alive.filter((id) => !s.citizens[id].traits.includes('bereaved')).length;
  if (!alive.length) {
    fail('the fixture silo died, so this section proved nothing');
  } else if (!shed) {
    fail(`${alive.length} mourners went through 120 days of the real day loop and every one ` +
      'of them is still bereaved — the action is raised and never applied');
  } else {
    ok(`and it reaches the citizen: ${shed} of ${alive.length} shed it over 120 days of real play`);
  }
}

// ---- 39. everything with a price can be built ------------------------------
//
// The Breacher Plate had a name, a description, a cost of 52 alloy and 30
// parts, and an `unlock` of `firearms_4` — and completing all 48 research
// nodes did not make it craftable. `craftableItems` gates on two things, the
// item's own `unlock` id and the tier its branch grants, and the two had come
// apart: the node called "Plate Armour", whose description is word for word
// the Plate Harness's, granted `armorTier: 1`, which is the Padded Vest, which
// needs no research at all. So researching Plate Armour gave the player
// nothing, and every armour above it arrived one node late until the top of
// the ladder fell off the end entirely.
//
// This asserts the general property rather than the three numbers: an item
// that names an unlock must be buildable once that unlock and everything it
// requires are done. Nothing in the game may cost resources it can never be
// bought with.
{
  const store = newStore(9);
  const s = store.state;

  const closure = (id, seen = new Set()) => {
    if (!id || seen.has(id)) return seen;
    seen.add(id);
    for (const req of RESEARCH[id]?.requires || []) closure(req, seen);
    return seen;
  };

  const unreachable = [];
  const late = [];
  for (const item of ITEM_LIST) {
    if (!item.craft) continue;              // loot-only kit is not built
    s.research.completed = [...closure(item.unlock)];
    if (!craftableItems(s).some((i) => i.id === item.id)) {
      (item.unlock ? late : unreachable).push(`${item.id} (T${item.tier}, ${item.unlock || 'no unlock'})`);
    }
  }
  s.research.completed = RESEARCH_LIST.map((n) => n.id);
  const withWholeTree = craftableItems(s);
  const dead = ITEM_LIST.filter((i) => i.craft && !withWholeTree.some((c) => c.id === i.id));

  // The other direction, which this section was missing entirely.
  //
  // Deleting the unlock check in `craftableItems`, or replacing its tier gate
  // with `return true`, or deleting `canCraft`'s unlock gate, each left the
  // whole suite green: a build in which every item is craftable on day one
  // passed. "Buildable once the unlock is done" is only half a gate, and the
  // half that was missing is the one a player would notice on their first day.
  s.research.completed = [];
  const tooEarly = craftableItems(s).filter((i) => i.craft && i.unlock);

  // `canCraft` needs a fixture where research is the ONLY thing that can
  // refuse. Without one, deleting its unlock gate is invisible: the next gate
  // down answers "Needs an Armory" and the item still is not craftable, so a
  // test that only checks `ok` passes against a build with no tech gate at
  // all. That mutation survived the first version of this section.
  const bench = newStore(90);
  const bs = bench.state;
  let bid = 0;
  for (const type of ['armory', 'suit_bay']) {
    const id = `bench${++bid}`;
    bs.silo.rooms[id] = {
      id, type, floor: 1, slot: bid, width: 1, level: 1,
      powered: true, buildingUntilCycle: 0, condition: 100, staff: [], found: true,
    };
  }
  for (const k of Object.keys(bs.resources)) bs.resources[k] = 1e6;
  bs.research.completed = [];
  const slipped = ITEM_LIST.filter((i) => i.craft && i.unlock)
    .filter((i) => !/Needs research/.test(canCraft(bs, i.id).reason || ''));

  // One mutation is deliberately not covered, and it is worth naming rather
  // than leaving as a silent hole: replacing `craftableItems`' tier gate with
  // `return true` survives this suite. It survives because it is genuinely
  // redundant against the shipped data — since the armour grants were
  // corrected, every gated item's `unlock` node grants exactly its tier, so
  // the unlock check alone already refuses everything the tier check would.
  // There is no reachable state where one passes and the other fails. The
  // first half of this section asserts that alignment directly, so if an item
  // is ever added whose unlock does not grant its tier, that assertion fails
  // and this note stops being true at the same moment.

  if (tooEarly.length) {
    fail(`${tooEarly.map((i) => `${i.id} (needs ${i.unlock})`).join(', ')} is craftable with no research ` +
      'completed at all — the tech gate is not gating anything');
  } else if (slipped.length) {
    fail(`${slipped.map((i) => `${i.id} (${canCraft(bs, i.id).reason || 'allowed'})`).join(', ')} — ` +
      'canCraft did not refuse these on research grounds at a fully equipped bench with unlimited stores');
  } else if (dead.length) {
    fail(`${dead.map((i) => i.id).join(', ')} cannot be built with every research node in the game ` +
      'completed — it is priced content no player can reach');
  } else if (late.length) {
    fail(`${late.join(', ')} names an unlock that does not actually unlock it`);
  } else if (unreachable.length) {
    fail(`${unreachable.join(', ')} has no unlock and still cannot be built`);
  } else {
    ok(`all ${ITEM_LIST.filter((i) => i.craft).length} priced items are buildable, each by the node it ` +
      `names — and none of the ${ITEM_LIST.filter((i) => i.craft && i.unlock).length} gated ones before it`);
  }
}

// ---- 40. the crafted ladder did not move ------------------------------------
//
// Weapon power and armour DR moved off `BAL.combat.gearTierMult` and
// `BAL.combat.armorPerTier` onto the items. Every other tuned number in this
// game — `garrisonPowerPerMilitary`, `raid.sizeScale`, `holdGarrisonScale`,
// `garrisonResponse`, and the win-rate tables in balance.js's own comments —
// was measured against those two constants. If the crafted four came out of
// the refactor even slightly different, all of that silently stops describing
// the game.
//
// So this pins the arithmetic rather than the plumbing: the four weapons must
// carry exactly [1.0, 1.4, 1.9, 2.5] and the four armours exactly tier x 0.12,
// and `unitPower` must produce the number those imply, to the bit.
//
// Measured against a pristine HEAD snapshot before this landed: 42 fight cells
// x 600 trials a side, identical win counts and identical mean ratios in all
// 42; and `unitPower` identical across all 25 crafted weapon x armour
// combinations at three durabilities.
{
  const WANT_POWER = { pipe_gun: 1.0, service_rifle: 1.4, breaching_carbine: 1.9, mag_rifle: 2.5 };
  const drift = [];
  for (const [id, want] of Object.entries(WANT_POWER)) {
    const got = getItem(id).stats.power;
    if (got !== want) drift.push(`${id} power ${got}, was ${want}`);
  }
  for (const item of ITEM_LIST) {
    if (item.kind !== 'armor' || !item.craft) continue;
    const want = item.tier * 0.12;
    if (item.stats.dr !== want) drift.push(`${item.id} dr ${item.stats.dr}, was ${want}`);
  }
  if (drift.length) {
    fail(`the crafted ladder moved in the refactor: ${drift.join('; ')} — every balance number ` +
      'in this game was tuned against the old values and none of them describe it any more');
  } else {
    ok('the crafted ladder is bit-identical to the constants it replaced (4 weapons, 4 armours)');
  }

  // And the arithmetic actually reaches `unitPower`, which is the half a table
  // of literals cannot show. Two citizens identical but for the rifle: the
  // ratio of their power must be the ratio of the two `power` stats exactly.
  // This is *not* a test that reads its own constant — the expected ratio comes
  // from the item table and the measured one from the resolver, so a resolver
  // that ignored `stats.power` and kept a tier lookup would fail here.
  const store = newStore(31);
  const s = store.state;
  const [a, b] = s.citizenIds.slice(0, 2);
  for (const id of [a, b]) {
    const c = s.citizens[id];
    c.health = 100; c.vitality = 100; c.traits = [];
    c.stats = { ...c.stats, str: 6, agi: 6 };
    c.skills = { ...c.skills, combat: 20 };
    c.gear = { weapon: null, armor: null, suit: null };
  }
  s.military.gear.p1 = { id: 'p1', item: 'pipe_gun', durability: 100, integrity: 100, assignedTo: a, loot: false };
  s.military.gear.p2 = { id: 'p2', item: 'mag_rifle', durability: 100, integrity: 100, assignedTo: b, loot: false };
  s.citizens[a].gear.weapon = 'p1';
  s.citizens[b].gear.weapon = 'p2';
  const ratio = unitPower(s, s.citizens[b]) / unitPower(s, s.citizens[a]);
  const want = getItem('mag_rifle').stats.power / getItem('pipe_gun').stats.power;
  if (Math.abs(ratio - want) > 1e-12) {
    fail(`a Mag Rifle is worth ${ratio.toFixed(4)}x a Pipe Gun in the resolver and ${want.toFixed(4)}x ` +
      'on the item — `unitPower` is not reading `stats.power`');
  } else {
    ok(`\`unitPower\` reads the item's own power (Mag Rifle is ${ratio.toFixed(2)}x a Pipe Gun, exactly as tabled)`);
  }

  // The tier-5 cliff this refactor exists to remove. `gearTierMult` was a
  // four-entry array read by `tier - 1` with a `?? 0.8` fallback, so a tier-5
  // weapon indexed off the end and came back at 0.8 — weaker than a Pipe Gun,
  // and the best weapon in the game reading as the worst.
  s.military.gear.p2.item = 'rail_carbine';
  const five = unitPower(s, s.citizens[b]) / unitPower(s, s.citizens[a]);
  if (!(five > ratio)) {
    fail(`a tier-5 Rail-Carbine is worth ${five.toFixed(2)}x a Pipe Gun and a tier-4 Mag Rifle ` +
      `${ratio.toFixed(2)}x — the top of the ladder falls off the end of it`);
  } else {
    ok(`and a tier-5 weapon is stronger than a tier-4 one (${five.toFixed(2)}x vs ${ratio.toFixed(2)}x), not weaker`);
  }
}

// ---- 41. found kit cannot be built, and does not break the bench ------------
//
// A loot item has no `craft` block, and three call sites iterated it
// unconditionally. Measured with one loot item injected and no guards:
// `craftableItems` returned `slag_autogun`, and both `canCraft` and the
// Armory's own row builder — `Object.entries(item.craft)` at
// ui/panels/military.js:279 — threw `TypeError: Cannot convert undefined or
// null to object`. That is the whole Military tab failing to render, for a
// player whose only crime was winning a fight.
{
  const store = newStore(52);
  const s = store.state;
  s.research.completed = RESEARCH_LIST.map((n) => n.id);
  // An Armory, so `canCraft` gets past its room gate to the resource loop —
  // which is the line that actually throws.
  s.silo.rooms.wtest_armory = {
    id: 'wtest_armory', type: 'armory', floor: 3, slot: 0, width: 2, level: 1,
    condition: 100, powered: true, buildingUntilCycle: 0, staff: [], found: false,
  };

  const loot = ITEM_LIST.filter((i) => i.loot);
  if (loot.length < 6) fail(`only ${loot.length} loot items exist; the ladder needs 6`);

  const offered = craftableItems(s).filter((i) => i.loot).map((i) => i.id);
  if (offered.length) {
    fail(`the benches offered to build ${offered.join(', ')} with the whole tree finished — ` +
      'they have no recipe, so this is a crash waiting on a click');
  } else {
    ok(`no looted kit is offered at the benches, with all ${RESEARCH_LIST.length} research nodes done`);
  }

  // Every loot item, through the two functions and the panel's own expression.
  const threw = [];
  const built = [];
  for (const item of loot) {
    let check;
    try {
      check = canCraft(s, item.id);
    } catch (e) {
      threw.push(`canCraft(${item.id}) ${e.constructor.name}`);
      continue;
    }
    if (check.ok) built.push(item.id);
    try {
      // Verbatim the panel's row: `itemsOfKind(kind)` -> `Object.entries(item.craft)`.
      for (const row of itemsOfKind(item.kind)) Object.entries(row.craft).map(([k, v]) => `${v} ${k}`);
    } catch (e) {
      threw.push(`the Armory row for a ${item.kind} ${e.constructor.name}: ${e.message}`);
    }
    if (bestCraftable(item.kind, item.tier)?.loot) {
      threw.push(`bestCraftable('${item.kind}', ${item.tier}) picked a looted piece`);
    }
  }
  if (threw.length) {
    fail(`opening the Armory with looted kit in the game: ${[...new Set(threw)].join('; ')}`);
  } else if (built.length) {
    fail(`${built.join(', ')} reported itself buildable — nothing found can also be made`);
  } else {
    ok(`all ${loot.length} looted pieces refuse politely and the Armory renders (canCraft, itemsOfKind, bestCraftable)`);
  }

  // And it says why, in words, rather than falling through to "No such item."
  // Guarded, because without the guard this call is the throw itself, and a
  // section that dies here reports nothing about the sections after it.
  let reason = '';
  try {
    reason = canCraft(s, 'rail_carbine').reason;
  } catch (e) {
    reason = `${e.constructor.name}: ${e.message}`;
  }
  if (!/found/i.test(reason)) {
    fail(`the Armory's reason for a Rail-Carbine is "${reason}", which does not tell the player it is loot`);
  } else {
    ok(`and it says so: "${reason}"`);
  }
}

// ---- 42. the wasteland pays in kit, and the game can tell it apart ----------
//
// Three channels, none of which existed: a `gear` block on LOOT 3 and 4, a
// `drops` block on the two organised raider bands, and `gearChancePerMilitary`
// on the conquest sack. All three mint through the existing `GEAR_CRAFT`
// rather than a new action type, so test/harness.mjs's "no action without a
// reducer" assertion still covers them.
//
// Measured over eight 900-day campaigns after wiring: the channels fire, and
// the piece that comes back is a piece the silo could not have built.
{
  // (a) The LOOT tables, through the real `resolveExpedition`.
  //
  // Driven on the Scar with a squad that wins, over enough seeds that the
  // 0.04-0.07 chances land. The assertion is on the *piece in the rack*, not
  // on a chance in a table: a `gear` key that nothing reads would leave this
  // at zero, which is exactly how `durabilityLossPerCombat` stayed dead for
  // the project's whole history.
  const got = new Map();
  let draws = 0;
  let journalled = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const store = newStore(seed);
    const s = store.state;
    s.clock.day = 500;
    s.resources.ammo = 100000;
    const roster = s.citizenIds.slice(0, 6);
    let g = 0;
    for (const id of roster) {
      const c = s.citizens[id];
      c.health = 100; c.vitality = 100; c.morale = 80; c.traits = [];
      c.stats = { ...c.stats, str: 9, agi: 9 };
      c.skills = { ...c.skills, combat: 90 };
      c.gear = { weapon: null, armor: null, suit: null };
      for (const [slot, item] of [['weapon', 'mag_rifle'], ['armor', 'breacher_plate'], ['suit', 'suit_4']]) {
        const gid = 'wt' + ++g;
        s.military.gear[gid] = { id: gid, item, durability: 100, integrity: 100, assignedTo: id, loot: false };
        c.gear[slot] = gid;
      }
    }
    const out = resolveExpedition(s, {
      id: 7000 + seed, squadId: 1, band: 'scar', purpose: 'salvage', target: null,
      launchDay: 500, returnDay: 500, roster, leaderId: roster[0], resolved: false,
    });
    for (const line of out.journal) if (/^Recovered: /.test(line)) draws++;
    for (const a of out.actions) {
      if (a.type !== 'GEAR_CRAFT') continue;
      if (!a.loot) { fail(`the wasteland minted a ${a.item} without marking it loot`); continue; }
      got.set(a.item, (got.get(a.item) || 0) + 1);
      if (out.journal.some((l) => l.includes(getItem(a.item).name))) journalled++;
    }
  }
  const table = Object.keys(LOOT[4].gear);
  const missing = table.filter((id) => !got.has(id));
  const total = [...got.values()].reduce((a, b) => a + b, 0);
  if (!total) {
    fail(`60 Scar runs and ${draws} loot draws produced no gear at all — LOOT[4].gear is read by nothing`);
  } else if (missing.length) {
    fail(`${missing.join(', ')} never dropped in 60 Scar runs (${draws} draws) — it is in the table and unreachable`);
  } else if (journalled !== total) {
    fail(`${total - journalled} of ${total} drops were never named in the journal — the player is handed ` +
      'kit they are not told about');
  } else {
    ok(`the Scar pays in kit: ${total} pieces over 60 runs (${draws} draws), all ${table.length} items reachable, ` +
      'every one of them named in the journal');
  }
  // Nothing craftable may come down this channel. The whole point of the tier
  // is that it cannot be built, and a table typo naming `mag_rifle` would be
  // a free bench.
  const buildable = [...got.keys()].filter((id) => !getItem(id).loot);
  if (buildable.length) fail(`${buildable.join(', ')} dropped as loot and is also craftable`);
}
{
  // (b) The enemy channel at the airlock — which is where it is actually paid.
  //
  // A Warband met in the open is a funeral at every tier in the game; met at
  // your own door on home terrain it is a real fight you can win. So this is
  // the channel that pays a player for keeping a squad home, which the game
  // previously priced only in losses that did not happen. Driven through
  // `raid.simulateDay`, the real entry point, on the real day loop's data.
  let wins = 0;
  let drops = 0;
  let named = 0;
  for (let day = 1; day <= 120; day++) {
    const store = newStore(0x7000 + day);
    const s = store.state;
    s.clock.day = 400;
    s.resources.ammo = 100000;
    const ids = s.citizenIds.slice(0, 10);
    let g = 0;
    for (const id of ids) {
      const c = s.citizens[id];
      c.health = 100; c.vitality = 100; c.morale = 90; c.traits = [];
      c.stats = { ...c.stats, str: 9, agi: 9 };
      c.skills = { ...c.skills, combat: 95 };
      c.gear = { weapon: null, armor: null, suit: null };
      for (const [slot, item] of [['weapon', 'mag_rifle'], ['armor', 'breacher_plate']]) {
        const gid = 'rt' + ++g;
        s.military.gear[gid] = { id: gid, item, durability: 100, integrity: 100, assignedTo: id, loot: false };
        c.gear[slot] = gid;
      }
    }
    s.military.squads['1'] = {
      id: '1', name: 'Probe', members: ids, leaderId: ids[0], assignment: 'garrison', deployed: false,
    };
    s.military.squadIds = ['1'];
    s.world.pendingRaid = {
      siloId: Object.keys(s.world.silos)[0],
      day: 400 - BAL.raid.graceDays,
      strength: 1, // hardest band
    };
    const acts = raid.simulateDay(s);
    if (!acts.some((a) => a.type === 'STAT_BUMP' && a.stats?.raidsRepelled)) continue;
    wins++;
    const minted = acts.filter((a) => a.type === 'GEAR_CRAFT');
    drops += minted.length;
    const lines = acts.filter((a) => a.type === 'LOG_MANY').flatMap((a) => a.entries).map((e) => e.text).join(' ');
    for (const m of minted) {
      if (!m.loot) fail(`a raid minted a ${m.item} without marking it loot`);
      if (lines.includes(getItem(m.item).name)) named++;
    }
  }
  if (!wins) {
    fail('no raid was repelled in 120 attempts, so the drop channel proved nothing');
  } else if (!drops) {
    fail(`${wins} raids repelled at the airlock and not one piece of gear came off them — ` +
      'the `drops` block on the raider bands is read by nothing in raid.js');
  } else if (named !== drops) {
    fail(`${drops - named} of ${drops} pieces taken at the airlock were never written to the log`);
  } else {
    ok(`standing at the door pays: ${drops} pieces off ${wins} repelled raids, every one named in the log`);
  }
}
{
  // (c) The conquest channel, through the real `resolveRun` breach stage.
  //
  // `power.military` has decided only how hard the fight is since the world
  // table existed, and paid nothing for having been hard. This is the first
  // thing that reads it as a reward. The assertion is comparative — a hard
  // silo must pay more than a soft one — because an absolute count is a
  // restatement of the constant it is drawn from and could not detect a wrong
  // one.
  const runSack = (military, seedBase) => {
    let pieces = 0;
    let sacked = 0;
    for (let seed = 0; seed < 90; seed++) {
      const store = newStore(seedBase + seed);
      const s = store.state;
      s.clock.day = 600;
      s.resources.ammo = 100000;
      // Not the first row in the table — it is collapsed in some worlds, and
      // `resolveRun` correctly refuses to breach a hole in the ground.
      const silo = Object.values(s.world.silos).find((x) => x.status !== 'collapsed' && x.contact !== 'satellite');
      if (!silo) continue;
      silo.power = { ...silo.power, military, economy: 50, science: 30 };
      silo.conquest = { stage: 'breach', scoutRuns: 9, undermined: true, defenseMult: 0.5 };
      const roster = s.citizenIds.slice(0, 8);
      let g = 0;
      for (const id of roster) {
        const c = s.citizens[id];
        c.health = 100; c.vitality = 100; c.morale = 90; c.traits = [];
        c.stats = { ...c.stats, str: 9, agi: 9 };
        c.skills = { ...c.skills, combat: 95 };
        c.gear = { weapon: null, armor: null, suit: null };
        for (const [slot, item] of [['weapon', 'mag_rifle'], ['armor', 'breacher_plate'], ['suit', 'suit_4']]) {
          const gid = 'ct' + ++g;
          s.military.gear[gid] = { id: gid, item, durability: 100, integrity: 100, assignedTo: id, loot: false };
          c.gear[slot] = gid;
        }
      }
      const out = resolveConquestRun(s, {
        id: 8000 + seed, squadId: 1, band: BAL.conquest.band, purpose: 'breach', target: silo.id,
        launchDay: 600, returnDay: 600, roster, leaderId: roster[0], resolved: false,
      });
      if (!out.actions.some((a) => a.type === 'CONQUEST_PATCH')) continue; // breach failed
      sacked++;
      for (const a of out.actions) {
        if (a.type !== 'GEAR_CRAFT') continue;
        pieces++;
        if (!a.loot) fail(`a sack minted a ${a.item} without marking it loot`);
        // Two tables now: what any garrison keeps, and what only a hard one
        // does. Both are legitimate output of a sack; anything else is not.
        const sackTables = [...BAL.conquest.sack.gearTable, ...BAL.conquest.sack.sackEliteTable];
        if (!sackTables.includes(a.item)) fail(`a sack produced ${a.item}, which is on neither of its tables`);
        if (!out.journal.some((l) => l.includes(getItem(a.item).name))) {
          fail(`a ${a.item} came out of a silo and the report never mentioned it`);
        }
      }
    }
    return { pieces, sacked };
  };
  const soft = runSack(20, 0x2200);
  const hard = runSack(95, 0x2200);
  if (!soft.sacked || !hard.sacked) {
    fail('no breach succeeded, so the conquest drop channel proved nothing');
  } else if (!hard.pieces) {
    fail(`${hard.sacked} silos at military 95 were sacked and produced no gear — ` +
      '`gearChancePerMilitary` is read by nothing in `sack()`');
  } else if (!(hard.pieces / hard.sacked > soft.pieces / soft.sacked * 2)) {
    fail(`sacking a military-95 silo yields ${(hard.pieces / hard.sacked).toFixed(2)} pieces and a ` +
      `military-20 one ${(soft.pieces / soft.sacked).toFixed(2)} — taking a hard silo is not worth ` +
      'more than taking a soft one, so the rating still decides nothing but the difficulty');
  } else {
    ok(`a hard silo is worth taking: ${(hard.pieces / hard.sacked).toFixed(2)} pieces a sack at military 95 ` +
      `vs ${(soft.pieces / soft.sacked).toFixed(2)} at military 20`);
  }
}

// ---- 43. gear wears out, and the Armory finally has something to do ---------
//
// `BAL.gear.durabilityLossPerCombat` has existed since gear did and was read
// by nothing. `GEAR_WEAR` had a reducer and was dispatched from nowhere in
// src/. So `unitPower`'s wear term — `0.6 + 0.4 * (durability / max)` — was
// pinned at exactly 1.0 for the project's whole history, and the Armory's
// repair loop, which filters `durability < durabilityMax`, had never repaired
// a single item in any campaign anybody has ever played.
//
// The suit half is worse and separate: a suit's condition is `integrity`, its
// durability sits at 100 for ever, and the repair filter never looked at
// integrity — so suits fell to 0 (measured: campaign-end averages of 25-37,
// some at 0) and stayed there, and a suit at 0 is a breach, which is the full
// unshielded dose on everyone in the party.
{
  const store = newStore(606);
  const s = store.state;
  s.clock.day = 300;
  s.resources.ammo = 100000;
  const roster = s.citizenIds.slice(0, 8);
  let g = 0;
  const ids = [];
  for (const id of roster) {
    const c = s.citizens[id];
    c.health = 100; c.vitality = 100; c.morale = 90; c.traits = [];
    c.stats = { ...c.stats, str: 9, agi: 9 };
    c.skills = { ...c.skills, combat: 95 };
    c.gear = { weapon: null, armor: null, suit: null };
    for (const [slot, item] of [['weapon', 'mag_rifle'], ['armor', 'breacher_plate']]) {
      const gid = 'wr' + ++g;
      ids.push(gid);
      s.military.gear[gid] = { id: gid, item, durability: 100, integrity: 100, assignedTo: id, loot: false };
      c.gear[slot] = gid;
    }
  }
  const enemy = rollEnemyForce(streamFor(1, 'wear', 'e'), getEnemy('scrappers'), { sizeScale: 0.2 });
  const res = resolveCombat(s, roster, enemy, { battleId: 'wear-probe' });
  store.dispatchAll(applyResolution(s, res, { context: 'raid' }));

  const worn = ids.filter((id) => s.military.gear[id] && s.military.gear[id].durability < 100);
  const survivors = res.injuries.length;
  if (!survivors) {
    fail('nobody survived the probe fight, so this section proved nothing');
  } else if (!worn.length) {
    fail(`${survivors} people came through a fight and not one weapon or plate lost a point of ` +
      'durability — GEAR_WEAR is dispatched from nowhere and the Armory has nothing to repair');
  } else if (worn.length !== survivors * 2) {
    fail(`${survivors} survivors carried ${survivors * 2} pieces through a fight and only ${worn.length} wore`);
  } else {
    ok(`a fight wears out what was carried through it (${worn.length} pieces off ${survivors} survivors)`);
  }

  // And a worn weapon is worth less, which is what the term was for. The
  // expected figure comes from the resolver's own formula rather than from a
  // constant this file also reads, so a mutation to the wear curve fails here.
  const c0 = s.citizens[roster[0]];
  if (c0 && s.military.gear[c0.gear.weapon]) {
    const gear = s.military.gear[c0.gear.weapon];
    const after = unitPower(s, c0);
    gear.durability = BAL.gear.durabilityMax;
    const fresh = unitPower(s, c0);
    if (!(after < fresh)) {
      fail(`a weapon at ${gear.durability} durability fights exactly as well as one at full — ` +
        'the wear term is not reading durability');
    } else {
      ok(`and worn kit fights worse: ${(100 * (1 - after / fresh)).toFixed(1)}% off unit power`);
    }
  }
}
{
  // The Armory, which had never repaired anything, and specifically the suit.
  const store = newStore(607);
  const s = store.state;
  // A staffed, powered Armory.
  const room = Object.values(s.silo.rooms).find((r) => r.type === 'armory') || (() => {
    s.silo.rooms.arm = {
      id: 'arm', type: 'armory', floor: 3, slot: 0, width: 2, level: 1,
      condition: 100, powered: true, buildingUntilCycle: 0, staff: [], found: false,
    };
    return s.silo.rooms.arm;
  })();
  room.powered = true;
  room.buildingUntilCycle = 0;
  room.staff = [s.citizenIds[0]];
  s.resources.scrap = 100000;

  s.military.gear.suit9 = { id: 'suit9', item: 'suit_4', durability: 100, integrity: 4, assignedTo: null, loot: false };
  s.military.gear.gun9 = { id: 'gun9', item: 'mag_rifle', durability: 88, integrity: 100, assignedTo: null, loot: false };

  const acts = militaryCycle(s);
  const repair = acts.find((a) => a.type === 'GEAR_REPAIR');
  if (!repair) {
    fail('a staffed Armory with a rifle at 88 and a suit at 4 scheduled no repairs at all');
  } else {
    store.dispatchAll(acts);
    const suit = s.military.gear.suit9;
    const gun = s.military.gear.gun9;
    if (!(suit.integrity > 4)) {
      fail(`a suit at integrity 4 sat in a staffed Armory and came out at ${suit.integrity} — the repair ` +
        'queue reads durability only, and a suit\'s durability never moves, so suits rot to 0 and stay there');
    } else if (!(gun.durability > 88)) {
      fail(`a rifle at durability 88 came out of the Armory at ${gun.durability}`);
    } else if (!repair.repairs.some((r) => r.id === 'suit9')) {
      fail('the suit was repaired but is not in the repair list, which means something else wrote it');
    } else {
      ok(`the Armory repairs both axes: suit integrity 4 -> ${suit.integrity.toFixed(1)}, ` +
        `rifle durability 88 -> ${gun.durability.toFixed(1)}`);
    }
  }
}

// ---- 44. readiness is a fraction, and stays one ----------------------------
//
// `readiness` is documented "0-1", drawn as a meter, and printed as a
// percentage by test/expedition.mjs. Its equipment term was `tier / 4`, which
// was correct while 4 was the top of the ladder. A tier-5 looted piece scores
// 1.25, the weighted sum runs to 1.125, and the meter overflows its own track.
{
  const store = newStore(808);
  const s = store.state;
  s.resources.ammo = 100000;
  const ids = s.citizenIds.slice(0, 4);
  let g = 0;
  for (const id of ids) {
    const c = s.citizens[id];
    c.health = 100; c.morale = 100; c.traits = [];
    c.skills = { ...c.skills, combat: 100 };
    c.gear = { weapon: null, armor: null, suit: null };
    for (const [slot, item] of [['weapon', 'rail_carbine'], ['armor', 'compact_cuirass']]) {
      const gid = 'rd' + ++g;
      s.military.gear[gid] = { id: gid, item, durability: 100, integrity: 100, assignedTo: id, loot: false };
      c.gear[slot] = gid;
    }
  }
  s.military.squads['1'] = {
    id: '1', name: 'Best', members: ids, leaderId: ids[0], assignment: 'garrison', deployed: false,
  };
  s.military.squadIds = ['1'];

  const best = readiness(s, '1');
  if (!(best <= 1)) {
    fail(`a squad in the best kit in the game reads readiness ${best.toFixed(3)} — the equipment term ` +
      'divides tier by 4 and a tier-5 item is worth 1.25 of a full slot');
  } else if (!(best > 0.9)) {
    fail(`a squad at combat 100, morale 100, health 100 and full stores in tier-5 kit reads only ` +
      `${best.toFixed(3)} — the clamp is eating the top of the scale`);
  } else {
    ok(`the best-equipped squad in the game reads readiness ${best.toFixed(3)}, which is still a fraction`);
  }
}

// ---- 45. every stat on an item decides something ---------------------------
//
// Eight stats, each with exactly one read site. A stat that nothing reads is
// how `durabilityLossPerCombat` spent this project's entire history declared,
// documented and dead, so each one here is driven to an outcome a player would
// see rather than checked for existence.
//
// `power` is §40's. These are the other seven.
{
  // --- dr, through the resolver ------------------------------------------
  // Two citizens identical but for the plate. The expected ratio comes from
  // the item table and the measured one from `unitPower`, so a resolver that
  // kept `1 + tier * armorPerTier` would land wrong: the Slag Plate and the
  // Breacher Plate are both tier 4 and would come out identical.
  const store = newStore(41);
  const s = store.state;
  const [a, b] = s.citizenIds.slice(0, 2);
  for (const id of [a, b]) {
    const c = s.citizens[id];
    c.health = 100; c.vitality = 100; c.traits = [];
    c.stats = { ...c.stats, str: 6, agi: 6 };
    c.skills = { ...c.skills, combat: 20 };
    c.gear = { weapon: null, armor: null, suit: null };
  }
  s.military.gear.a1 = { id: 'a1', item: 'slag_plate', durability: 100, integrity: 100, assignedTo: a, loot: true };
  s.military.gear.a2 = { id: 'a2', item: 'breacher_plate', durability: 100, integrity: 100, assignedTo: b, loot: false };
  s.citizens[a].gear.armor = 'a1';
  s.citizens[b].gear.armor = 'a2';
  const measured = unitPower(s, s.citizens[b]) / unitPower(s, s.citizens[a]);
  const wanted = (1 + getItem('breacher_plate').stats.dr) / (1 + getItem('slag_plate').stats.dr);
  if (Math.abs(measured - wanted) > 1e-12) {
    fail(`a Breacher Plate is worth ${measured.toFixed(5)}x a Slag Plate in the resolver and ` +
      `${wanted.toFixed(5)}x on the items — \`unitPower\` is not reading \`stats.dr\`, and those two ` +
      'are the same tier, so a tier lookup cannot tell them apart at all');
  } else {
    ok(`\`unitPower\` reads the item's own dr (two tier-4 plates differ by ${((measured - 1) * 100).toFixed(1)}%)`);
  }

  // The check above derives what it wants from the same item table it is
  // testing, so it proves the resolver reads the field and CANNOT detect a
  // wrong value in it — set both plates to the same `dr` and it passes at a
  // ratio of 1.0. Mutation-tested; that is exactly what happened.
  //
  // So the values get their own assertion, and it is the design claim rather
  // than a copy of the numbers: within the crafted ladder a higher tier
  // dominates a lower one, but the *looted* pieces must each be beaten by
  // something else on at least one axis, or there is no decision in them and
  // the whole loot tier is a straight upgrade with extra words.
  const dom = [];
  const plate = getItem('slag_plate').stats;
  const breacher = getItem('breacher_plate').stats;
  const cuirass = getItem('compact_cuirass').stats;
  if (!(plate.dr < breacher.dr)) dom.push('the Slag Plate turns as many rounds as a Breacher Plate');
  if (!(plate.soak > breacher.soak)) dom.push('and spreads no more of the ones it does not');
  if (!(cuirass.dr > breacher.dr)) dom.push('the Compact Cuirass is not the best plate in the game');
  if (!(cuirass.soak < plate.soak)) dom.push('and it is not beaten by the Slag Plate on wounds either');
  const gun = getItem('slag_autogun').stats;
  const mag = getItem('mag_rifle').stats;
  if (!(gun.power > mag.power)) dom.push('the Slag Autogun does not out-hit the Mag Rifle');
  if (!(gun.ammo > mag.ammo)) dom.push('and does not pay for it in ammunition');
  if (!(gun.pierce < mag.pierce)) dom.push('and does not pay for it in pierce either');
  if (!(getItem('garrison_rifle').stats.ammo < mag.ammo)) dom.push('the Garrison Rifle is not the cheapest tier-4 to feed');
  if (!(getItem('garrison_rifle').stats.power < mag.power)) dom.push('and is not the weakest');
  if (dom.length) {
    fail(`the looted kit is dominated rather than a choice: ${dom.join('; ')} — a loot tier that is ` +
      'strictly better than the crafted one is not a decision, it is a reward for waiting');
  } else {
    ok('every looted piece is beaten by something else on at least one axis (dr/soak, power/ammo/pierce)');
  }
}
{
  // --- soak, where the player sees it: how hurt people come home ---------
  //
  // Pinned on a fight nobody can lose, so the outcome band, the casualty draw
  // and every rng draw are identical between the two runs and the only thing
  // left is the plate. The Padded Vest soaks nothing and the Slag Plate soaks
  // 0.45, so the wounds must come back in that ratio.
  const wounds = (armour) => {
    const store = newStore(43);
    const s = store.state;
    s.clock.day = 200;
    s.resources.ammo = 100000;
    const roster = s.citizenIds.slice(0, 6);
    let g = 0;
    for (const id of roster) {
      const c = s.citizens[id];
      c.health = 100; c.vitality = 100; c.morale = 90; c.traits = [];
      c.stats = { ...c.stats, str: 9, agi: 9 };
      c.skills = { ...c.skills, combat: 95 };
      c.gear = { weapon: null, armor: null, suit: null };
      for (const [slot, item] of [['weapon', 'mag_rifle'], ['armor', armour]]) {
        const gid = 'sk' + ++g;
        s.military.gear[gid] = { id: gid, item, durability: 100, integrity: 100, assignedTo: id, loot: false };
        c.gear[slot] = gid;
      }
    }
    const enemy = rollEnemyForce(streamFor(1, 'soak', 'e'), getEnemy('scrappers'), { sizeScale: 0.2 });
    const res = resolveCombat(s, roster, enemy, { battleId: 'soak-probe' });
    return {
      total: res.injuries.reduce((x, i) => x - i.health, 0),
      cas: res.casualties.length,
      win: res.outcome.key,
    };
  };
  const bare = wounds('padded_vest');
  const plated = wounds('slag_plate');
  const ratio = 1 - getItem('slag_plate').stats.soak;
  // Both sides of the comparison below read `slag_plate.stats.soak`, so a soak
  // of 0 would satisfy it trivially at a ratio of 1.0 — mutation-tested, and
  // it did. The probe therefore refuses to run on a plate that soaks nothing.
  // What the value *should* be is the non-domination assertion's question.
  if (!(getItem('slag_plate').stats.soak > 0.2)) {
    fail(`the Slag Plate soaks ${getItem('slag_plate').stats.soak}, so this probe cannot see anything — ` +
      'the piece whose whole identity is bringing people home in one piece absorbs nothing');
  } else if (bare.win !== plated.win || bare.cas !== plated.cas) {
    fail(`the soak probe did not hold the fight still (${bare.win}/${plated.win}) — it proves nothing`);
  } else if (!bare.total) {
    fail('nobody was hurt in the soak probe, so it proves nothing');
  } else if (Math.abs(plated.total / bare.total - ratio) > 0.03) {
    fail(`the same fight cost ${bare.total} health in Padded Vests and ${plated.total} in Slag Plates — ` +
      `a ratio of ${(plated.total / bare.total).toFixed(3)} against the ${ratio.toFixed(2)} the plate's ` +
      '`soak` promises. Armour is not deciding how hurt people come home');
  } else {
    ok(`\`soak\` decides what a fight costs: ${bare.total} health in Padded Vests, ${plated.total} in ` +
      `Slag Plates, same fight, same outcome (${(plated.total / bare.total).toFixed(2)}x)`);
  }
}
{
  // --- pierce, which is not the tier ------------------------------------
  //
  // The whole reason `pierce` is a stat rather than a rank: the Slag Autogun
  // is a tier-4 weapon that punches like a tier-3 one, so it out-hits a Mag
  // Rifle everywhere except in front of the one thing that has to be punched
  // through. Both weapons are tier 4, so a resolver reading `item.tier` cannot
  // separate them and this section fails.
  const blocked = (weapon, minWeaponTier) => {
    const store = newStore(45);
    const s = store.state;
    s.clock.day = 300;
    s.resources.ammo = 100000;
    const roster = s.citizenIds.slice(0, 6);
    let g = 0;
    for (const id of roster) {
      const c = s.citizens[id];
      c.health = 100; c.vitality = 100; c.morale = 80; c.traits = [];
      c.gear = { weapon: null, armor: null, suit: null };
      const gid = 'pc' + ++g;
      s.military.gear[gid] = { id: gid, item: weapon, durability: 100, integrity: 100, assignedTo: id, loot: false };
      c.gear.weapon = gid;
    }
    const enemy = {
      id: 'wall', name: 'Something Armoured', count: 1, level: 1, modifier: null,
      power: 40, human: false, displayName: 'Something Armoured',
      def: { id: 'wall', name: 'Something Armoured', human: false, minWeaponTier },
    };
    const res = resolveCombat(s, roster, enemy, { battleId: 'pierce-probe' });
    return res.log.some((l) => /will go through it/.test(l));
  };
  const problems = [];
  if (blocked('mag_rifle', 4)) problems.push('a Mag Rifle (pierce 4) was stopped by a tier-4 gate');
  if (!blocked('slag_autogun', 4)) problems.push('a Slag Autogun (pierce 3) went through a tier-4 gate');
  if (blocked('slag_autogun', 3)) problems.push('a Slag Autogun (pierce 3) was stopped by a tier-3 gate');
  if (!blocked('service_rifle', 3)) problems.push('a Service Rifle (pierce 2) went through a tier-3 gate');
  // And the gate has to exist in the game, not just in this fixture.
  //
  // The probe above builds its own enemy, which is fine for isolating the
  // resolver and useless as evidence that the stat matters: with the Hulk's 3
  // as the only gate in any table, `pierce` and `tier` admitted an identical
  // set of weapons, so a stat with its own read site decided nothing a tier
  // index would not have. The Broodmother carries the tier-4 gate now, which
  // is what the Slag Autogun's whole trade is against.
  const gates = [...new Set(Object.values(ENEMIES).map((e) => e.minWeaponTier).filter(Boolean))];
  const weapons = ITEM_LIST.filter((i) => i.kind === 'weapon');
  const discriminating = gates.filter((g) => {
    const p = weapons.filter((i) => i.stats.pierce >= g).map((i) => i.id).sort().join();
    const t = weapons.filter((i) => i.tier >= g).map((i) => i.id).sort().join();
    return p !== t;
  });
  if (!discriminating.length) {
    problems.push(`no enemy in the game has a gate that pierce and tier answer differently ` +
      `(gates present: ${gates.join(', ') || 'none'}) — the stat is decoration`);
  }

  if (problems.length) {
    fail(`the armour gate is reading weapon tier, not \`pierce\`: ${problems.join('; ')} — the Mag ` +
      'Rifle and the Slag Autogun are both tier 4 and must not be interchangeable in front of a Hulk');
  } else {
    ok(`\`pierce\` and not tier decides what gets through, and a real enemy asks: ` +
      `gate ${discriminating.join(', ')} admits a Mag Rifle and refuses a Slag Autogun, both tier 4`);
  }
}
{
  // --- ammo appetite, at the airlock ------------------------------------
  //
  // Charged per weapon rather than per head, which is the cost side of the
  // stat: the hardest-hitting weapon in the game is also the one that can
  // leave a squad standing at the door. Measured through `canLaunch`, which is
  // the gate that actually opens.
  const cost = (weapon) => {
    const store = newStore(47);
    const s = store.state;
    for (const r of Object.values(s.silo.rooms)) { r.powered = true; r.buildingUntilCycle = 0; }
    s.silo.rooms.al = {
      id: 'al', type: 'airlock', floor: 1, slot: 0, width: 2, level: 3,
      condition: 100, powered: true, buildingUntilCycle: 0, staff: [], found: false,
    };
    for (const k of Object.keys(s.resources)) s.resources[k] = 100000;
    const ids = s.citizenIds.slice(0, 6);
    let g = 0;
    for (const id of ids) {
      const c = s.citizens[id];
      c.health = 100; c.status = 'idle';
      c.gear = { weapon: null, armor: null, suit: null };
      for (const [slot, item] of [['weapon', weapon], ['suit', 'suit_4']]) {
        const gid = 'am' + ++g;
        s.military.gear[gid] = { id: gid, item, durability: 100, integrity: 100, assignedTo: id, loot: false };
        c.gear[slot] = gid;
      }
    }
    s.military.squads['1'] = {
      id: '1', name: 'Probe', members: ids, leaderId: ids[0], assignment: 'garrison', deployed: false,
    };
    s.military.squadIds = ['1'];
    const check = canLaunch(s, '1', 'deep');
    return check.ok ? check.cost : null;
  };
  const lean = cost('pipe_gun');
  const hungry = cost('slag_autogun');
  const base = cost('service_rifle');
  if (!lean || !hungry || !base) {
    fail('the appetite probe could not launch, so it proves nothing');
  } else if (lean.food !== hungry.food || lean.water !== hungry.water) {
    fail('the appetite stat moved food and water, which are charged per body and must not move');
  } else if (!(hungry.ammo > base.ammo && base.ammo > lean.ammo)) {
    fail(`the airlock asks for ${lean.ammo} rounds for Pipe Guns, ${base.ammo} for Service Rifles and ` +
      `${hungry.ammo} for Slag Autoguns — the supply bill is not reading \`stats.ammo\``);
  } else {
    const want = getItem('slag_autogun').stats.ammo / getItem('pipe_gun').stats.ammo;
    const got = hungry.ammo / lean.ammo;
    if (Math.abs(got - want) > 0.05) {
      fail(`autoguns cost ${got.toFixed(2)}x pipe guns to supply and the items say ${want.toFixed(2)}x`);
    } else {
      ok(`\`ammo\` is charged per weapon: a deep run wants ${lean.ammo} rounds on Pipe Guns and ` +
        `${hungry.ammo} on Slag Autoguns (${got.toFixed(2)}x, same six people)`);
    }
  }
}
{
  // --- band, shielding and wear, on the suits ---------------------------
  //
  // `band` is the launch gate. It is a separate number from the tier because
  // the Registry Skin is a tier-5 suit and there is no band 5 — under the old
  // `degradePerHourOutside[tier - 1]` it also indexed off the end of a
  // four-entry array and fell back to 0.55, the worst value in it, so the best
  // suit in the game read as the worst.
  const run = (suit, band, seed) => {
    const store = newStore(seed);
    const s = store.state;
    s.clock.day = 600;
    for (const k of Object.keys(s.resources)) s.resources[k] = 100000;
    s.silo.rooms.al2 = {
      id: 'al2', type: 'airlock', floor: 1, slot: 0, width: 2, level: 3,
      condition: 100, powered: true, buildingUntilCycle: 0, staff: [], found: false,
    };
    const ids = s.citizenIds.slice(0, 6);
    let g = 0;
    for (const id of ids) {
      const c = s.citizens[id];
      c.health = 100; c.vitality = 100; c.morale = 80; c.status = 'idle'; c.traits = [];
      c.stats = { ...c.stats, str: 9, agi: 9 };
      c.skills = { ...c.skills, combat: 95 };
      c.gear = { weapon: null, armor: null, suit: null };
      for (const [slot, item] of [['weapon', 'mag_rifle'], ['armor', 'breacher_plate'], ['suit', suit]]) {
        const gid = 'su' + ++g;
        s.military.gear[gid] = { id: gid, item, durability: 100, integrity: 100, assignedTo: id, loot: false };
        c.gear[slot] = gid;
      }
    }
    s.military.squads['1'] = {
      id: '1', name: 'Probe', members: ids, leaderId: ids[0], assignment: 'garrison', deployed: false,
    };
    s.military.squadIds = ['1'];
    const gate = canLaunch(s, '1', band);
    const out = resolveExpedition(s, {
      id: 9100 + seed, squadId: '1', band, purpose: 'salvage', target: null,
      launchDay: 600, returnDay: 600, roster: ids, leaderId: ids[0], resolved: false,
    });
    const resolve = out.actions.find((x) => x.type === 'EXPEDITION_RESOLVE');
    return { gate, integrity: resolve.suitIntegrity, dose: resolve.radiation };
  };

  // (a) the launch gate.
  //
  // Stated plainly because it matters to anyone reading this later: on the
  // shipped band table these three assertions CANNOT tell `stats.band` from
  // `item.tier`. Every suit's band equals its tier except the Registry Skin's,
  // which is tier 5 and band 4 — and since the highest band in the game asks
  // for suitTier 4, `5 >= 4` and `4 >= 4` both admit it. Mutation-tested:
  // swapping the gate back to `item.tier` leaves all three green.
  //
  // What they do pin is the gate's behaviour, which is worth pinning on its
  // own. The two assertions below them are the ones that are about the field.
  const gates = {
    t3: run('suit_3', 'scar', 49).gate,
    t4: run('suit_4', 'scar', 49).gate,
    skin: run('registry_skin', 'scar', 49).gate,
  };
  if (gates.t3.ok) {
    fail('a squad in tier-3 suits was allowed onto the Scar — the launch gate is not reading `stats.band`');
  } else if (!gates.t4.ok || !gates.skin.ok) {
    fail(`the Scar refused ${!gates.t4.ok ? 'a tier-4 suit' : 'a Registry Skin'}: ` +
      `"${(gates.t4.ok ? gates.skin : gates.t4).reason}" — a tier-5 suit must open the band it is built for`);
  } else {
    ok('`band` gates the airlock: tier-3 suits are refused the Scar, tier-4 and the tier-5 Skin are not');
  }

  // Why the field exists at all, which is the part a tier can never say.
  //
  // A suit's rank and the ground it is rated for are different questions, and
  // the Registry Skin is the proof: it is the best suit in the game and there
  // is no band above the Scar for it to open. Under `item.tier` it claims
  // band 5, which does not exist — the same class of mistake as
  // `gearTierMult[4]`, an index off the end of a table that happens not to
  // crash. If somebody ever makes every suit's band equal its tier, the field
  // is pure duplication and should be deleted rather than left to rot.
  const topBand = Math.max(...BANDS.map((x) => x.suitTier));
  const overclaimed = ITEM_LIST.filter((i) => i.kind === 'suit' && i.stats.band > topBand);
  const differs = ITEM_LIST.filter((i) => i.kind === 'suit' && i.stats.band !== i.tier);
  if (overclaimed.length) {
    fail(`${overclaimed.map((i) => `${i.id} (band ${i.stats.band})`).join(', ')} is rated for ground ` +
      `that does not exist — the deepest band in the game asks for suit tier ${topBand}`);
  } else if (!differs.length) {
    fail('every suit\'s `band` is just its `tier`, so the field decides nothing and is duplication');
  } else {
    ok(`and \`band\` is not \`tier\`: ${differs.map((i) => `${i.id} is tier ${i.tier}, band ${i.stats.band}`).join('; ')}`);
  }

  // (b) `wear` and `shielding`, measured on the approach band.
  //
  // NOT on the Scar, and the reason is a finding rather than a convenience.
  // Ten days out floors integrity at 0 for almost everything — measured over
  // 12 seeds a side, tier-1 suits came home at 0 in 11 runs, tier-2 in 10,
  // tier-3 in 7, and even tier-4 in 3. That is the exact mirror of the
  // radiation defect this design already routes around: dose saturates at the
  // 100 ceiling and integrity saturates at the 0 floor, and a stat cannot
  // decide anything in a range where every value gives the same answer. The
  // approach band is six days and nothing floors there, so it is where the
  // stat is actually legible.
  const mean = (suit) => {
    const runs = [];
    for (let seed = 60; seed < 70; seed++) runs.push(run(suit, 'approach', seed));
    return {
      integrity: runs.reduce((a, r) => a + r.integrity, 0) / runs.length,
      dose: runs.reduce((a, r) => a + r.dose, 0) / runs.length,
      floored: runs.filter((r) => r.integrity <= 0).length,
    };
  };
  const t3 = mean('suit_3');
  const t4 = mean('suit_4');
  const skin = mean('registry_skin');

  if (t3.floored || t4.floored || skin.floored) {
    fail('the wear probe floored at 0, so it cannot separate the suits and proves nothing');
  } else if (!(skin.integrity > t4.integrity && t4.integrity > t3.integrity)) {
    fail(`six days out ends with suits at ${t3.integrity.toFixed(1)} (T3), ${t4.integrity.toFixed(1)} (T4) ` +
      `and ${skin.integrity.toFixed(1)} (Skin) — a better suit is not surviving the walk any better, ` +
      'so `stats.wear` is not being read');
  } else if (Math.abs(skin.dose - t4.dose) > 0.5) {
    fail(`the Registry Skin came home with ${skin.dose.toFixed(0)} rad against a tier-4 suit's ` +
      `${t4.dose.toFixed(0)}. Its advantage is meant to be \`wear\`, not \`shielding\` — dose clamps at ` +
      '100 on every band a tier-4 suit can reach, so a shielding advantage there is a stat nobody can see');
  } else if (!(t3.dose > t4.dose)) {
    fail(`a tier-3 suit takes ${t3.dose.toFixed(0)} rad and a tier-4 one ${t4.dose.toFixed(0)} — ` +
      '`stats.shielding` is not reaching the dose');
  } else {
    ok(`\`wear\` is where the tier-5 suit earns its place: six days out ends at ${t3.integrity.toFixed(0)}` +
      ` / ${t4.integrity.toFixed(0)} / ${skin.integrity.toFixed(0)} integrity, the Skin and the tier-4 ` +
      `suit at the same ${skin.dose.toFixed(0)} rad (mean of 10 runs each)`);
  }
}

// ---- 46. every doctrine node does something ---------------------------------
//
// This is the section the whole feature rests on.
//
// The characteristic bug in this codebase is a declared effect that nothing
// reads. `durabilityLossPerCombat` and `GEAR_WEAR` were dead for the entire
// project. `traits.temporary` was read nowhere, so grief never lifted and a
// quarter of the silo carried it permanently. `armorTier` was off by one, so a
// priced tier-4 plate could not be built with all 48 research nodes complete.
// Every one of those shipped green, because nothing asked whether the number
// was connected to anything.
//
// A talent tree is the worst place in the game to do that again: the player
// spends a scarce currency, permanently, on a node whose only evidence is its
// own description. So this does not test thirteen hand-picked behaviours — it
// **iterates the node table** and demands a probe for every entry. Add a
// fourteenth node and this section fails until somebody proves it works.
//
// Each probe returns a number, measured with the node off and then on. The
// direction is asserted too, because "it changed" is satisfied by a sign error.
{
  const withNodes = (store, ids) => {
    store.state.doctrine = { points: 0, earned: 0, taken: ids, frontier: 0 };
    return store.state;
  };

  /** A silo with one crewed squad, kitted, for the probes that need a fight. */
  const squadFixture = (seed, ids) => {
    const store = newStore(seed);
    const s = withNodes(store, ids);
    new Game(store).runDays(2);
    store.dispatchAll(autoAssign(s));
    const roster = s.citizenIds.slice(0, 6);
    s.military.squads[1] = { id: 1, name: 'Probe', members: roster, leaderId: roster[0], deployed: false, assignment: 'garrison' };
    s.military.squadIds = [1];
    for (const id of roster) {
      const c = s.citizens[id];
      c.squadId = 1;
      c.status = 'training';
      c.skills.combat = 20;
      c.health = 100;
    }
    return { store, s, roster };
  };

  // Probe per node id. Each returns a number that the node claims to move.
  const PROBES = {
    debrief: (ids) => {
      const s = withNodes(newStore(3), ids);
      return commendationsFor(s, { band: 'near', casualties: [] });
    },
    cadre: (ids) => {
      const { store, s } = squadFixture(51, ids);
      // Feed it people until the reducer refuses.
      for (const id of s.citizenIds) {
        store.dispatch({ type: 'SQUAD_MEMBER', squadId: 1, citizenId: id });
      }
      return s.military.squads[1].members.length;
    },
    spearhead: (ids) => {
      const { s, roster } = squadFixture(52, ids);
      return unitPower(s, s.citizens[roster[0]], { partySize: 4 });
    },
    succession: (ids) => {
      const { store, s, roster } = squadFixture(53, ids);
      s.citizens[roster[0]].skills.combat = 60;
      s.citizens[roster[1]].skills.combat = 20;
      store.dispatch({ type: 'CITIZEN_DIE', id: roster[0], cause: 'a probe', text: 'a probe' });
      return s.citizens[roster[1]].skills.combat;
    },
    hard_school: (ids) => {
      const { s, roster } = squadFixture(54, ids);
      const c = s.citizens[roster[0]];
      const before = c.skills.combat;
      for (let d = 0; d < 30; d++) {
        s.clock.day += 1;
        for (const a of populationDay(s, {})) {
          if (a.type !== 'CITIZENS_PATCH') continue;
          for (const p of a.patches) {
            if (p.id === c.id && p.skills) c.skills = p.skills;
          }
        }
      }
      return c.skills.combat - before;
    },
    discipline: (ids) => {
      // Wounds are rolled, so this is a sum over fixed seeds rather than one
      // fight: a single roll can land the same either way.
      let total = 0;
      for (let seed = 0; seed < 8; seed++) {
        const { s, roster } = squadFixture(200 + seed, ids);
        const before = roster.reduce((a, id) => a + s.citizens[id].health, 0);
        const out = resolveExpedition(s, {
          id: 1, squadId: 1, band: 'deep', purpose: 'salvage', target: null,
          launchDay: 10, returnDay: 10, roster, leaderId: roster[0], resolved: false,
        });
        for (const a of out.actions) {
          if (a.type === 'CITIZENS_PATCH') {
            for (const p of a.patches || []) {
              if (p.health != null && s.citizens[p.id]) s.citizens[p.id].health = p.health;
            }
          } else if (a.type === 'CITIZEN_INJURE' && s.citizens[a.id]) {
            s.citizens[a.id].health += a.health || 0;
          }
        }
        total += before - roster.reduce((a, id) => a + s.citizens[id].health, 0);
      }
      return total;
    },
    pockets: (ids) => sumFromRuns(ids, 'loot'),
    prospectors: (ids) => sumFromRuns(ids, 'artifacts'),
    wardens: (ids) => {
      const { s, roster } = squadFixture(55, ids);
      return unitPower(s, s.citizens[roster[0]], { mutant: true });
    },
    muster: (ids) => {
      const { s, roster } = squadFixture(56, ids);
      // Somebody who has been outside and is not in a squad.
      const outsider = s.citizens[s.citizenIds.find((id) => !roster.includes(id))];
      outsider.traits = [...outsider.traits, 'veteran'];
      outsider.status = 'idle';
      outsider.age = 30;
      return raid.defenders(s).length;
    },
    cache: (ids) => {
      const s = withNodes(newStore(57), ids);
      s.resources.ammo = 0;
      return ammoFactor(s, 6);
    },
    clean_room: (ids) => {
      const { store, s, roster } = squadFixture(58, ids);
      for (const id of roster) s.citizens[id].radiation = 40;
      s.resources.filters = 100;
      store.dispatch({ type: 'DECON', members: roster, radiation: 40 });
      // Lower is better here, so return what is left removed-side-up.
      return 40 - s.citizens[roster[0]].radiation;
    },
    sealed: (ids) => {
      const { store, s } = squadFixture(59, ids);
      s.world.pendingRaid = { siloId: Object.keys(s.world.silos)[0], day: 1, strength: 30 };
      s.clock.day = 1 + BAL.raid.graceDays;
      for (const k of BAL.raid.theftKeys) s.resources[k] = 1000;
      let stolen = 0;
      for (const a of raid.simulateDay(s)) {
        if (a.type !== 'RESOURCE_DELTA') continue;
        for (const v of Object.values(a.deltas || {})) if (v < 0) stolen -= v;
      }
      return stolen;
    },
  };

  /** Total loot tonnage or artifact count over fixed seeds. */
  function sumFromRuns(ids, which) {
    let total = 0;
    for (let seed = 0; seed < 8; seed++) {
      const { s, roster } = squadFixture(300 + seed, ids);
      const out = resolveExpedition(s, {
        id: 1, squadId: 1, band: 'deep', purpose: 'salvage', target: null,
        launchDay: 10, returnDay: 10, roster, leaderId: roster[0], resolved: false,
      });
      const res = out.actions.find((a) => a.type === 'EXPEDITION_RESOLVE');
      const bag = (which === 'loot' ? res?.loot : res?.artifacts) || {};
      for (const v of Object.values(bag)) total += v;
    }
    return total;
  }

  // Which way each node should move its probe.
  const UP = new Set(['debrief', 'cadre', 'spearhead', 'succession', 'hard_school',
    'pockets', 'prospectors', 'wardens', 'muster', 'cache', 'clean_room']);

  const missing = DOCTRINE_LIST.filter((n) => !PROBES[n.id]).map((n) => n.id);
  if (missing.length) {
    fail(`${missing.join(', ')} has no probe here, so nothing proves the node does anything — ` +
      'add one before shipping a talent the player pays for');
  }

  const dead = [];
  const backwards = [];
  const lines = [];
  for (const node of DOCTRINE_LIST) {
    const probe = PROBES[node.id];
    if (!probe) continue;
    // The node under test plus whatever it needs to be legal. The ledger is
    // set directly rather than bought, because this section is about the
    // effect, not the shop — §49 covers the buying.
    const off = probe([]);
    const on = probe([node.id]);
    lines.push(`${node.id} ${Number(off).toFixed(2)}→${Number(on).toFixed(2)}`);
    if (on === off) { dead.push(`${node.id} (${node.proves} stayed at ${off})`); continue; }
    const wentUp = on > off;
    if (wentUp !== UP.has(node.id)) {
      backwards.push(`${node.id} (${off} → ${on}, expected to go ${UP.has(node.id) ? 'up' : 'down'})`);
    }
  }

  if (dead.length) {
    fail(`${dead.join('; ')} — the player buys this and nothing happens`);
  } else if (backwards.length) {
    fail(`${backwards.join('; ')} — the effect is wired backwards`);
  } else {
    ok(`all ${DOCTRINE_LIST.length} doctrine nodes move the number they claim to`);
    ok(`  ${lines.join('  ')}`);
  }
}

// ---- 47. the player can actually reach what they paid for ------------------
//
// §46 proves every doctrine node moves a number. It proved that for Cadre by
// dispatching `SQUAD_MEMBER` directly — and `SQUAD_MEMBER` is dispatched from
// exactly one place in the whole game, the `+` button on a squad card, which
// was gated on the bare `BAL.military.squadMax`. So the reducer honoured Cadre
// and the only path a player has did not. Twelve commendations, spent
// permanently, closing the other half of a pair, for nothing — and if a squad
// somehow reached ten the card printed "10/8".
//
// Testing the reducer is not testing the game. This section covers the two
// halves of that lesson: the cap has one definition, and the UI uses it.
{
  // One definition. A second copy of a rule is how the first one goes stale,
  // and this is a source check because that is the level the bug lived at:
  // both expressions were individually correct and they disagreed.
  const sim = readSource('../src/sim/military.js');
  const offenders = [];
  for (const rel of ['../src/ui/panels/military.js', '../src/core/reducers.js']) {
    if (readSource(rel).includes('BAL.military.squadMax')) offenders.push(rel.replace('../', ''));
  }
  if (!sim.includes('export function squadCap')) {
    fail('sim/military.js no longer exports squadCap, so there is no single definition of the cap');
  } else if (offenders.length) {
    fail(`${offenders.join(', ')} reads BAL.military.squadMax directly instead of squadCap(state) — ` +
      'that is exactly how Cadre came to be unreachable');
  } else {
    ok('the squad cap has one definition, and the reducer and the panel both use it');
  }

  // And behaviourally: the gate the `+` button consults must move with the
  // node, not just the gate inside the reducer.
  const store = newStore(71);
  const s = store.state;
  new Game(store).runDays(2);
  store.dispatchAll(autoAssign(s));
  const bare = squadCap(s);
  s.doctrine = { points: 0, earned: 0, taken: ['debrief', 'cadre'], frontier: 0 };
  const withCadre = squadCap(s);

  if (withCadre !== bare + DOCTRINE_NODES.cadre.effect.squadMaxBonus) {
    fail(`the cap the panel reads went ${bare} -> ${withCadre}, which is not what Cadre grants`);
  } else {
    // Fill a squad through the reducer and check the panel's own gate agrees
    // that it is full at the new number rather than the old one.
    s.military.squads[1] = { id: 1, name: 'Probe', members: [], leaderId: null, deployed: false, assignment: 'garrison' };
    s.military.squadIds = [1];
    for (const id of s.citizenIds) store.dispatch({ type: 'SQUAD_MEMBER', squadId: 1, citizenId: id });
    const filled = s.military.squads[1].members.length;
    if (filled !== withCadre) {
      fail(`a squad filled to ${filled} against a displayed cap of ${withCadre} — the card would print ${filled}/${withCadre}`);
    } else {
      ok(`and Cadre reaches the player: the card's own gate goes ${bare} to ${withCadre}, and a squad fills to ${filled}`);
    }
  }
}

// ---- 48. the auto-equipper issues the better weapon ------------------------
//
// `equipBest` is the ONLY thing in the whole game that dispatches
// `GEAR_ASSIGN` — there is no manual loadout screen — so whatever it prefers
// is what every soldier carries, permanently and without appeal. It ranked on
// `tier` and broke ties on `durability`, which was correct while a tier *was*
// its stats. The loot items ended that: two pieces now share a tier and
// differ, and the ranking could not see the difference.
//
// Measured before the fix: a freshly looted Slag Autogun outranked a lightly
// worn Magnetic Rifle, so the best soldier in the silo was handed the weapon
// that costs 82% more ammunition for 4% more power and a lost pierce tier.
{
  const store = newStore(83);
  const s = store.state;
  new Game(store).runDays(2);
  store.dispatchAll(autoAssign(s));
  const c = s.citizens[s.citizenIds[0]];
  c.gear = { weapon: null, armor: null, suit: null };

  // The exact trap: the worse weapon in perfect condition against the better
  // one that has seen a couple of fights.
  // Two tier-4 weapons where the tier ranking and the power ranking disagree:
  // the Garrison Rifle is pristine and weaker, the Magnetic Rifle is slightly
  // worn and stronger. On tier they tie, so durability decides and the worse
  // gun wins; on effective power the better gun wins by 0.05. Any fixture
  // where the two rankings agree proves nothing about which one is in use.
  s.military.gear.trap = { id: 'trap', item: 'garrison_rifle', kind: 'weapon', durability: 100, integrity: 100, assignedTo: null, loot: true };
  s.military.gear.good = { id: 'good', item: 'mag_rifle', kind: 'weapon', durability: 95, integrity: 100, assignedTo: null, loot: false };

  store.dispatchAll(equipBest(s, c.id));
  const got = s.military.gear[c.gear.weapon];
  const gotPower = getItem(got.item).stats.power * (0.6 + 0.4 * got.durability / BAL.gear.durabilityMax);
  const otherId = got.id === 'trap' ? 'good' : 'trap';
  const other = s.military.gear[otherId];
  const otherPower = getItem(other.item).stats.power * (0.6 + 0.4 * other.durability / BAL.gear.durabilityMax);

  if (gotPower < otherPower) {
    fail(`the armoury issued a ${getItem(got.item).name} at ${gotPower.toFixed(2)} effective power over a ` +
      `${getItem(other.item).name} at ${otherPower.toFixed(2)} — it is still ranking on the tier chip`);
  } else {
    ok(`the armoury issues on power, not the tier chip (${getItem(got.item).name} ${gotPower.toFixed(2)} over ` +
      `${getItem(other.item).name} ${otherPower.toFixed(2)})`);
  }

  // And nothing in the game may be strictly worse than something else on every
  // axis at once. A dominated item is a row the player can only ever be wrong
  // to pick, which is not a choice — it is a mistake with a description.
  const dominated = [];
  const weapons = ITEM_LIST.filter((i) => i.kind === 'weapon');
  for (const a of weapons) {
    const by = weapons.filter((b) => b.id !== a.id &&
      b.stats.power >= a.stats.power && b.stats.ammo <= a.stats.ammo && b.stats.pierce >= a.stats.pierce &&
      (b.stats.power > a.stats.power || b.stats.ammo < a.stats.ammo || b.stats.pierce > a.stats.pierce));
    // The crafted ladder is a ladder on purpose: a later rung should beat an
    // earlier one outright. Only the looted kit has to earn its place, because
    // that is the kit the player chooses between rather than climbs.
    if (a.loot && by.length) dominated.push(`${a.id} (by ${by.map((b) => b.id).join(', ')})`);
  }
  if (dominated.length) {
    fail(`${dominated.join('; ')} is beaten on every axis at once — a looted piece nobody should ever carry`);
  } else {
    ok('and no looted weapon is beaten on power, ammunition and pierce all at once');
  }
}

// ---- 49. the shop refuses what it says it refuses ---------------------------
//
// Every one of `DOCTRINE_TAKE`'s guards could be deleted with the whole suite
// still green. The reducer's own docstring justifies re-checking `canTake` as
// what stands between the player and "a silo with negative Commendations and
// both halves of a pair that is supposed to be a choice" — and nothing
// anywhere asserted that. §46 even pointed at another section for this
// coverage, which did not exist.
//
// The guards were correct. That is not the same as being covered: a rule
// nothing tests is a rule that survives exactly as long as nobody edits it.
{
  const fresh = (points, taken = []) => {
    const store = newStore(97);
    store.state.doctrine = { points, earned: points, taken: [...taken], frontier: 0 };
    return store;
  };
  const problems = [];

  // Same node twice — the double-tap the docstring names.
  {
    const store = fresh(100);
    store.dispatch({ type: 'DOCTRINE_TAKE', id: 'debrief' });
    const after1 = store.state.doctrine.points;
    store.dispatch({ type: 'DOCTRINE_TAKE', id: 'debrief' });
    if (store.state.doctrine.taken.filter((x) => x === 'debrief').length !== 1) {
      problems.push('a node was adopted twice');
    }
    if (store.state.doctrine.points !== after1) problems.push('the second tap charged for it again');
  }

  // Both halves of a pair.
  {
    const store = fresh(100, ['debrief']);
    store.dispatch({ type: 'DOCTRINE_TAKE', id: 'cadre' });
    store.dispatch({ type: 'DOCTRINE_TAKE', id: 'spearhead' });
    const t = store.state.doctrine.taken;
    if (t.includes('cadre') && t.includes('spearhead')) {
      problems.push('both halves of a mutually exclusive pair were adopted');
    }
  }

  // A capstone with nothing under it.
  {
    const store = fresh(100, ['debrief']);
    store.dispatch({ type: 'DOCTRINE_TAKE', id: 'succession' });
    if (store.state.doctrine.taken.includes('succession')) {
      problems.push('a rank-2 node was adopted with no rank-1 node beneath it');
    }
  }

  // More than you have.
  {
    const store = fresh(3);
    store.dispatch({ type: 'DOCTRINE_TAKE', id: 'debrief' });   // costs 4
    if (store.state.doctrine.taken.length) problems.push('a node was adopted without the points for it');
    if (store.state.doctrine.points < 0) problems.push('commendations went negative');
  }

  // And nothing the panel can send is fatal.
  {
    const store = fresh(100);
    for (const id of [null, undefined, 42, 'not_a_node', '']) {
      store.dispatch({ type: 'DOCTRINE_TAKE', id });
    }
    if (store.state.doctrine.taken.length) problems.push('a junk id bought something');
  }

  if (problems.length) fail(problems.join('; '));
  else ok('the doctrine shop refuses a repeat, both halves of a pair, an ungrounded capstone, an overspend and a junk id');
}

// ---- 50. the frontier is somewhere you came back from -----------------------
//
// `frontierAfter` ran unconditionally on every resolved expedition, including
// one where the whole party died. So a squad annihilated on the Scar set the
// frontier to 4, and since commendations only pay at or beyond it, every band
// below the Scar stopped paying for the rest of the campaign — measured: a
// later clean run to the deep, the mid waste or the near ruins was worth 0.
// One over-reach that killed a squad quietly switched off the talent tree,
// with nothing in the panel saying so.
{
  const mk = (survivors, casualties) => {
    const store = newStore(98);
    const s = store.state;
    const roster = s.citizenIds.slice(0, 4);
    s.military.squads[1] = { id: 1, name: 'A', members: roster, leaderId: roster[0], deployed: true, assignment: 'expedition' };
    s.military.squadIds = [1];
    s.expeditions.active = [{
      id: 1, squadId: 1, band: 'scar', purpose: 'salvage', launchDay: 1, returnDay: 2,
      roster, leaderId: roster[0], resolved: false,
    }];
    store.dispatch({
      type: 'EXPEDITION_RESOLVE', id: 1, journal: [], loot: {}, artifacts: {},
      survivors: survivors ? roster.slice(0, 2) : [],
      casualties: casualties ? roster.slice(casualties === 'all' ? 0 : 2) : [],
    });
    return s;
  };

  const wiped = mk(false, 'all');
  const bloodied = mk(true, 'some');

  if (wiped.doctrine.frontier !== 0) {
    fail(`a party that never came home moved the frontier to ${wiped.doctrine.frontier} — ` +
      'every band below the Scar now pays nothing, for ever');
  } else if (commendationsFor(wiped, { band: 'near', casualties: [] }) <= 0) {
    fail('after a total wipe the near ruins stopped paying, so the tree is closed');
  } else if (bloodied.doctrine.frontier !== 4) {
    fail(`a party that came home from the Scar having buried two people left the frontier at ` +
      `${bloodied.doctrine.frontier} — having been somewhere is not the same as having gone well`);
  } else {
    ok('the frontier moves when somebody comes back, and not when nobody does');
  }
}

// ---- 51. the player can issue gear ------------------------------------------
//
// `equipBest` was the only thing in the entire game that dispatched
// `GEAR_ASSIGN`. Every loadout in every campaign was therefore decided by one
// sort order, with no way to override it, and the only trace of the result
// anywhere on screen was three tier digits on a squad card — "343". Eighteen
// items, eight designed stats, six of them looted off ground the player had to
// fight across, and the answer to "who is carrying the Rail-Carbine" was
// nobody knows and you may not choose.
//
// A source check, because the failure was structural rather than arithmetic:
// nothing about the reducer was wrong, there was simply no second caller.
{
  const panel = readSource('../src/ui/panels/military.js');
  const sim = readSource('../src/sim/military.js');
  const problems = [];
  if (!panel.includes('GEAR_ASSIGN')) {
    problems.push('no UI dispatches GEAR_ASSIGN, so the only loadout in the game is the one equipBest picked');
  }
  if (!panel.includes('openLoadout')) problems.push('there is no loadout screen');
  // And the rack list must show the numbers, or it is the Armory problem again
  // one screen along: a list of names with no way to tell them apart.
  if (!panel.includes('statChips')) problems.push('the picker does not show the stats it is choosing between');
  if (!/equipBest/.test(sim)) problems.push('equipBest went away entirely');

  if (problems.length) {
    fail(problems.join('; '));
  } else {
    ok('the player can open a soldier, see every piece in the rack with its numbers, and issue one');
  }

  // Behaviourally: issuing a specific piece takes it off whoever had it and
  // sticks, rather than being undone by the next auto-equip pass.
  const store = newStore(64);
  const s = store.state;
  new Game(store).runDays(2);
  store.dispatchAll(autoAssign(s));
  const [a, b] = s.citizenIds.slice(0, 2).map((id) => s.citizens[id]);
  for (const c of [a, b]) c.gear = { weapon: null, armor: null, suit: null };
  s.military.gear.rare = { id: 'rare', item: 'rail_carbine', kind: 'weapon', durability: 100, integrity: 100, assignedTo: null, loot: true };

  store.dispatch({ type: 'GEAR_ASSIGN', gearId: 'rare', citizenId: a.id, slot: 'weapon' });
  if (a.gear.weapon !== 'rare') {
    fail('issuing a weapon to a soldier did not give it to them');
  } else {
    // Now hand the same piece to somebody else, which is the whole point of a
    // rack: one Rail-Carbine, eight soldiers, and the player decides.
    store.dispatch({ type: 'GEAR_ASSIGN', gearId: 'rare', citizenId: b.id, slot: 'weapon' });
    if (b.gear.weapon !== 'rare') fail('re-issuing a weapon did not move it');
    else if (a.gear.weapon === 'rare') fail('the same Rail-Carbine is now carried by two people');
    else ok('and re-issuing a piece moves it, rather than cloning it');
  }
}

// ---- 52. the currency never stops meaning something -------------------------
//
// The tree has seven slots at a fixed total of 142, so a silo that plays well
// runs out of anything to buy with a third of the campaign left — measured,
// the best seeds earn 285 and can spend 142, and the Scar, which pays four a
// run, opens *after* most seeds have already filled the tree. The game's
// richest ground was paying in a currency that had stopped meaning anything,
// for exactly the behaviour the system exists to teach.
//
// Commending is the sink, and it answers a second thing: nothing else in the
// game makes anyone better at fighting, so a militia's mean combat skill falls
// across a campaign as recruits replace veterans.
{
  const store = newStore(88);
  const s = store.state;
  new Game(store).runDays(2);
  store.dispatchAll(autoAssign(s));
  const roster = s.citizenIds.slice(0, 4);
  s.military.squads[1] = { id: 1, name: 'A', members: roster, leaderId: roster[0], deployed: false, assignment: 'garrison' };
  s.military.squadIds = [1];
  for (const id of roster) { s.citizens[id].squadId = 1; s.citizens[id].status = 'training'; }
  const soldier = s.citizens[roster[0]];
  soldier.skills.combat = 20;
  const civilian = s.citizens[s.citizenIds.find((id) => !roster.includes(id))];
  civilian.skills.combat = 20;

  s.doctrine = { points: 100, earned: 100, taken: [], frontier: 0 };
  const cost = BAL.combat.commendCost;

  store.dispatch({ type: 'DOCTRINE_COMMEND', id: soldier.id });
  const gained = soldier.skills.combat - 20;
  const paid = 100 - s.doctrine.points;

  const problems = [];
  if (gained !== BAL.combat.commendSkill) problems.push(`commending gave ${gained} combat, not ${BAL.combat.commendSkill}`);
  if (paid !== cost) problems.push(`commending charged ${paid}, not ${cost}`);

  // Only soldiers. Commending is for the runs somebody came back from.
  store.dispatch({ type: 'DOCTRINE_COMMEND', id: civilian.id });
  if (civilian.skills.combat !== 20) problems.push('a citizen who is not in a squad was commended');

  // It cannot be bought without the points, and cannot run the ledger negative.
  s.doctrine.points = cost - 1;
  const before = soldier.skills.combat;
  store.dispatch({ type: 'DOCTRINE_COMMEND', id: soldier.id });
  if (soldier.skills.combat !== before) problems.push('a soldier was commended without the points for it');
  if (s.doctrine.points < 0) problems.push('commendations went negative');

  // And it stops at the skill ceiling rather than running past it.
  s.doctrine.points = 1000;
  for (let i = 0; i < 200; i++) store.dispatch({ type: 'DOCTRINE_COMMEND', id: soldier.id });
  if (soldier.skills.combat > BAL.citizens.skillMax) {
    problems.push(`commending ran a soldier to ${soldier.skills.combat}, past the ${BAL.citizens.skillMax} ceiling`);
  }
  if (s.doctrine.points <= 0) problems.push('commending kept charging after the ceiling');

  if (problems.length) fail(problems.join('; '));
  else {
    ok(`commendations always have somewhere to go: ${cost} buys +${BAL.combat.commendSkill} combat on a ` +
      `soldier, stops at ${BAL.citizens.skillMax}, and refuses a civilian or an empty ledger`);
  }
}

// ---- 53. the hardest silos keep the best kit --------------------------------
//
// Tier-5 existed behind exactly one door: `env_suit_4`, which opens on day
// 572-684 of a campaign that ends around 719. A hundred and twenty days, one
// route, and a Compact Cuirass landing on day 721 of a 725-day run. This is
// the second route, and it is the literal reading of "the harder the
// challenge, the better the gear" — what a silo has on its racks scales with
// the garrison that was defending them.
//
// It is also the branch most at risk of being unreachable: the first version
// set the floor at military 60, and across six campaigns the reference player
// takes nineteen silos of which the hardest is rated 58, so it never executed
// once. This section asserts the gradient rather than the constant, so a floor
// raised out of reach fails here rather than passing silently.
{
  const S = BAL.conquest.sack;
  const elite = new Set(S.sackEliteTable);
  const problems = [];

  // Every id in the table has to be a real item, and a tier-5 one — the whole
  // point is that it sits above anything the benches can make.
  for (const gid of S.sackEliteTable) {
    const item = getItem(gid);
    if (!item) problems.push(`${gid} is not an item`);
    else if (item.craft) problems.push(`${gid} can be built at a bench, so taking a silo for it is pointless`);
    else if (item.tier < 5) problems.push(`${gid} is tier ${item.tier}, not above the crafted ladder`);
  }

  // The floor has to be somewhere a player actually goes. The world's own
  // silo table is the evidence: if nothing in it is at or above the floor,
  // this branch is unreachable by construction.
  const store = newStore(76);
  const ratings = Object.values(store.state.world.silos)
    .map((x) => Math.round(x.power?.military ?? 0))
    .sort((a, b) => b - a);
  const reachable = ratings.filter((m) => m >= S.sackEliteMinimum).length;
  if (!reachable) {
    problems.push(`no silo in the world is rated ${S.sackEliteMinimum} or above (hardest is ${ratings[0]}), ` +
      'so the elite sack never fires');
  }

  // And it has to pay more for a harder target than an easier one. Measured
  // by sacking the same silo at two ratings across many seeds rather than
  // reading the formula, so a branch that ignores `military` fails.
  const yieldAt = (military) => {
    let n = 0;
    for (let seed = 0; seed < 300; seed++) {
      const st = newStore(1000 + seed).state;
      const target = Object.values(st.world.silos)[0];
      target.power = { ...(target.power || {}), military };
      const out = sackSilo(target, streamFor(seed, 'sack-probe', military), 1);
      for (const a of out.gear || []) {
        const item = getItem(a.item);
        if (item && elite.has(item.id)) n++;
      }
    }
    return n;
  };
  const soft = yieldAt(S.sackEliteMinimum - 20);
  const hard = yieldAt(95);

  if (soft !== 0) {
    problems.push(`a silo rated ${S.sackEliteMinimum - 20}, below the floor, still paid ${soft} tier-5 pieces`);
  } else if (hard === 0) {
    problems.push('a silo rated 95 paid no tier-5 kit at all across 300 sacks');
  }

  if (problems.length) fail(problems.join('; '));
  else {
    ok(`the hardest silos keep what nobody here can build: ${hard} tier-5 pieces over 300 sacks at ` +
      `military 95, none at ${S.sackEliteMinimum - 20}, and ${reachable} silos in the world are worth taking for it`);
  }
}

// ---- 54. the Armory is load-bearing ----------------------------------------
//
// A judge reported gear wear as inert — "a system that neither shows nor does
// anything" — on the evidence that mean durability never falls below 92 across
// a campaign. Both halves of that turned out to be wrong, and the measurement
// is worth keeping because the second half is counter-intuitive.
//
// It is not that nothing wears. Counted over three 700-day campaigns, wear
// dispatches 94-127 times for 3,780-5,190 durability points, and the repair
// loop returns 5,240-8,615 — a ratio of 1.4 to 1.7. Durability sits near 100
// *because a room is absorbing five thousand points of damage a campaign*,
// which is the Armory doing exactly the job it exists for. (The other half:
// wear charges every survivor, not only the wounded — measured at 100% of
// survivor-slots across 60 fights.)
//
// So the thing worth asserting is not a number that stays high. It is that
// taking the room away stops the recovery.
{
  const mk = (withArmory) => {
    const store = newStore(101);
    const s = store.state;
    new Game(store).runDays(2);
    store.dispatchAll(autoAssign(s));
    if (withArmory) {
      s.silo.rooms.arm1 = {
        id: 'arm1', type: 'armory', floor: 1, slot: 4, width: 1, level: 1,
        powered: true, buildingUntilCycle: 0, condition: 100,
        staff: s.citizenIds.slice(0, 2), found: true,
      };
    }
    for (const r of Object.values(s.silo.rooms)) {
      if (r.type === 'armory' && !withArmory) delete s.silo.rooms[r.id];
    }
    s.resources.scrap = 100000;
    s.military.gear.worn = {
      id: 'worn', item: 'mag_rifle', kind: 'weapon', durability: 40, integrity: 100,
      assignedTo: null, loot: false,
    };
    for (let cycle = 0; cycle < 24; cycle++) store.dispatchAll(militaryCycle(s));
    return s.military.gear.worn.durability;
  };

  const repaired = mk(true);
  const neglected = mk(false);

  if (repaired <= 40) {
    fail(`a rifle at 40 durability sat through 24 cycles in a staffed Armory and came out at ${repaired} — ` +
      'the repair loop is not running');
  } else if (neglected > 40) {
    fail(`a rifle at 40 durability repaired itself to ${neglected} with no Armory in the silo at all`);
  } else {
    ok(`the Armory is load-bearing: a worn rifle goes 40 → ${repaired.toFixed(0)} with one, and stays at ` +
      `${neglected.toFixed(0)} without`);
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
