#!/usr/bin/env node
/**
 * campaign.mjs — play the whole thing, twice, and look for faults.
 *
 * Every other suite here asks a specific question. This one asks the
 * unspecific one: if you actually play this game from the handover to the
 * ending, does anything come apart?
 *
 * That is a different kind of test and it catches a different kind of bug.
 * The suites that assert on a named outcome cannot see a citizen who is in a
 * squad and also dead, a resource that went NaN on day 380, an expedition
 * that is still "active" four hundred days after its return day, or a raid
 * that stayed pending for the rest of the campaign — because nothing thought
 * to ask. So this drives real campaigns through `Game` with the project's own
 * autopilot and re-checks the whole of state, every day, against a list of
 * things that should never be true.
 *
 * The invariants are deliberately about *coherence*, not about balance. A
 * silo that starves to death passes this suite; a silo carrying a citizen who
 * belongs to a squad that no longer exists does not, however well it is doing.
 *
 * Two campaigns on different seeds, because one is an anecdote. They are
 * different seeds rather than the same one twice for the reason test/deep.mjs
 * had to be corrected for: running the same seed twice and comparing the
 * results is `x === x`, which stays green against anything.
 *
 * Run: node test/campaign.mjs [--days=900] [--seeds=0x1234,0xbeef]
 */

import { createStore } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import autopilot from './autopilot.mjs';
import { BAL, TIME } from '../src/config/balance.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const DAYS = Number(args.days ?? 900);
const SEEDS = String(args.seeds ?? '0x1234,0xbeef').split(',').map((x) => Number(x));

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

registerCoreReducers();

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Everything that should never be true of a silo, at any point, ever.
 *
 * Returns a list of strings. Each one names the day and enough of the state
 * to find it again — a fault report that says "invariant 7 failed" costs more
 * time than it saves.
 */
function faults(s) {
  const out = [];
  const day = s.clock.day;
  const at = (m) => out.push(`day ${day}: ${m}`);

  // ---- numbers stay numbers ----------------------------------------------
  for (const [k, v] of Object.entries(s.resources)) {
    if (!finite(v)) at(`resource ${k} is ${v}`);
    else if (v < 0) at(`resource ${k} went negative (${v.toFixed(2)})`);
  }
  if (!finite(s.order.value)) at(`order.value is ${s.order.value}`);
  if (!finite(s.air.load) || !finite(s.air.capacity)) at('air load/capacity is not finite');

  // ---- the roster agrees with itself -------------------------------------
  const ids = new Set(s.citizenIds);
  if (ids.size !== s.citizenIds.length) at('citizenIds contains a duplicate');
  for (const id of s.citizenIds) {
    const c = s.citizens[id];
    if (!c) { at(`citizenIds lists ${id}, which is not in citizens`); continue; }
    if (c.status === 'dead') at(`${id} is dead and still on the roster`);
    if (!finite(c.health) || c.health < 0) at(`${id} health is ${c.health}`);
    if (!finite(c.morale)) at(`${id} morale is ${c.morale}`);
    if (c.squadId != null && !s.military.squads[c.squadId]) {
      at(`${id} belongs to squad ${c.squadId}, which does not exist`);
    }
    if (c.job) {
      const room = s.silo.rooms[c.job.roomId];
      if (!room) at(`${id} is posted to room ${c.job.roomId}, which does not exist`);
      else if (!room.staff.includes(c.id)) at(`${id} thinks it works in ${room.id}; the room disagrees`);
    }
  }

  // ---- rooms agree with the roster ---------------------------------------
  for (const room of Object.values(s.silo.rooms)) {
    for (const cid of room.staff) {
      const c = s.citizens[cid];
      if (!c) at(`room ${room.id} is staffed by ${cid}, who does not exist`);
      else if (c.status === 'dead') at(`room ${room.id} is staffed by ${cid}, who is dead`);
    }
    if (!finite(room.condition) || room.condition < 0) at(`room ${room.id} condition is ${room.condition}`);
  }

  // ---- squads agree with the roster --------------------------------------
  for (const sqId of s.military.squadIds) {
    const sq = s.military.squads[sqId];
    if (!sq) { at(`squadIds lists ${sqId}, which is not in squads`); continue; }
    for (const cid of sq.members) {
      const c = s.citizens[cid];
      if (!c) at(`squad ${sqId} has member ${cid}, who does not exist`);
      else if (c.status === 'dead') at(`squad ${sqId} still has ${cid}, who is dead`);
    }
  }

  // ---- nothing is stuck ---------------------------------------------------
  //
  // The bug class this whole file exists for: state that is written, waited
  // on, and never cleared. `world.pendingRaid` was exactly that for the
  // project's whole history — written by PENDING_RAID, read by nothing —
  // which is what the raid resolver was built to fix.
  const raid = s.world.pendingRaid;
  if (raid && day > raid.day + BAL.raid.graceDays + 1) {
    at(`a raid from day ${raid.day} is still pending`);
  }
  for (const e of s.expeditions.active) {
    if (day > e.returnDay + 2) at(`expedition ${e.id} is ${day - e.returnDay} days past its return day`);
    for (const cid of e.roster) {
      if (!s.citizens[cid]) at(`expedition ${e.id} has ${cid} on its roster, who does not exist`);
    }
  }
  for (const f of s.silo.floors) {
    if (!finite(f.integrity)) at(`floor ${f.n} integrity is ${f.integrity}`);
  }

  // ---- the world stays coherent -------------------------------------------
  for (const sat of s.world.satellites) {
    const silo = s.world.silos[sat.siloId];
    if (!silo) at(`satellite ${sat.siloId} is not a silo`);
    else if (silo.contact !== 'satellite') at(`silo ${sat.siloId} is a satellite but contact is "${silo.contact}"`);
  }

  // ---- the log is readable ------------------------------------------------
  // A death with no name, or any line with an "undefined" in it, is a bug the
  // player reads. Only the tail is checked each day; the whole log would be
  // O(days^2) and the tail sweeps everything eventually.
  for (const e of s.log.slice(-12)) {
    if (typeof e.text !== 'string' || !e.text) at('a log entry has no text');
    else if (/undefined|NaN|\[object/.test(e.text)) at(`log entry reads "${e.text}"`);
  }
  return out;
}

console.log('');
console.log('  DEEPWATER — two campaigns, end to end');
console.log('  ' + '─'.repeat(58));
console.log('');

const runs = [];
for (const seed of SEEDS) {
  const store = createStore(createNewGame({ seed, now: 1_700_000_000_000 }));
  store.silent = true;
  const game = new Game(store);
  const s = store.state;
  store.dispatchAll(autoAssign(s));

  const found = [];
  const seenFault = new Set();
  let raidsSeen = 0;
  let lastDay = 0;

  for (let d = 0; d < DAYS; d++) {
    if (s.meta.gameOver) break;
    game.runDays(1);
    // Scripted crises are scheduled in real elapsed minutes and read
    // `meta.playedMs`, which only the live loop advances. Without this line a
    // harness runs 900 game days and never fires one of them — no blight, no
    // raider probe, no refugee wave, no ultimatum — and then reports that
    // nothing went wrong. It was missing from the first version of this file
    // and the first thing this suite proved was that raids never happen,
    // which was a fault in the audit rather than in the game.
    s.meta.playedMs = s.clock.cycle * BAL.time.TICK_MS * TIME.ticksPerCycle;
    // The autopilot is the reference player: it builds, digs, researches and
    // re-crews. Three passes a day is test/obedient.mjs's reference rate.
    for (let i = 0; i < 3; i++) store.dispatchAll(autopilot(s));
    if (s.world.pendingRaid) raidsSeen++;
    lastDay = s.clock.day;

    for (const f of faults(s)) {
      // One report per distinct fault. A broken invariant usually stays
      // broken, and 900 copies of the same line buries the second fault.
      const key = f.replace(/^day \d+: /, '');
      if (seenFault.has(key)) continue;
      seenFault.add(key);
      found.push(f);
    }
  }

  const dug = s.silo.floors.filter((f) => f.excavated).length;
  runs.push({ seed, s, found, lastDay, dug, raidsSeen });

  console.log(
    `  seed 0x${seed.toString(16)}  day ${String(lastDay).padStart(3)}  ` +
    `pop ${String(s.citizenIds.length).padStart(4)}  ` +
    `floors ${String(dug).padStart(3)}  ` +
    `research ${String(s.research.completed.length).padStart(2)}/48  ` +
    `deaths ${String(s.stats.deaths).padStart(3)}  ` +
    `${s.meta.gameOver ? `ended: ${s.meta.ending || 'lost'}` : 'still running'}`
  );
  console.log(
    `                  raids ${s.stats.raidsRepelled || 0} repelled / ${s.stats.raidsLost || 0} lost` +
    `   silos taken ${s.stats.silosTaken || 0}` +
    `   expeditions ${s.stats.expeditionsReturned || 0}`
  );
  if (found.length) {
    console.log(`                  ${found.length} distinct fault(s):`);
    for (const f of found.slice(0, 12)) console.log(`                    · ${f}`);
    for (const f of found) fail(`0x${seed.toString(16)} — ${f}`);
  }
}

console.log('');

if (!failures.length) {
  ok(`${runs.length} campaigns of up to ${DAYS} days: no incoherent state at any point`);
}

// The audit has to have exercised the scripted content, or "no faults found"
// is just a report that nothing happened. This is the assertion that would
// have caught the missing `playedMs` line above.
for (const r of runs) {
  const fired = Object.keys(r.s.flags.crises || {}).length;
  if (fired < 3) {
    fail(`0x${r.seed.toString(16)} fired only ${fired} scripted crises in ${r.lastDay} days — the campaign is not being exercised`);
  }
}
if (runs.every((r) => Object.keys(r.s.flags.crises || {}).length >= 3)) {
  ok(`scripted crises fired in both campaigns (${runs.map((r) => Object.keys(r.s.flags.crises).length).join(', ')} each)`);
}

// Raids have to actually happen. This is the assertion that would have caught
// the state the feature shipped in: `world.pendingRaid` written by two
// producers, resolved by nothing, and — once it *was* resolved — reachable
// only through one scripted event on day 26, because the dynamic trigger
// needed a reputation no playstyle could reach.
//
// The reference player takes them rather than repelling them, and that is not
// a fault: `autopilot` is a one-squad player by construction (it manages
// `squadIds[0]` and nothing else), and one squad cannot hold the door and
// walk the surface at the same time. That is the tension the feature exists
// to create, and it is the same reason the counterplay is asserted in
// test/wiring.mjs §8, against a silo that actually keeps people in.
for (const r of runs) {
  const raids = (r.s.stats.raidsRepelled || 0) + (r.s.stats.raidsLost || 0);
  if (raids < 2) {
    fail(`0x${r.seed.toString(16)} saw ${raids} raid(s) in ${r.lastDay} days — the raid system is not reachable in play`);
  }
}
if (runs.every((r) => (r.s.stats.raidsRepelled || 0) + (r.s.stats.raidsLost || 0) >= 2)) {
  ok(`raids reach a real campaign (${runs.map((r) => (r.s.stats.raidsRepelled || 0) + (r.s.stats.raidsLost || 0)).join(' and ')} over ${DAYS} days)`);
}

// A campaign that dies on day 30 has not exercised anything. This is not a
// balance assertion — it is a floor under the other one, so "no faults found"
// cannot be bought by not playing.
for (const r of runs) {
  if (r.lastDay < 150) {
    fail(`0x${r.seed.toString(16)} only reached day ${r.lastDay} — too short to have audited anything`);
  }
}
if (runs.every((r) => r.lastDay >= 150)) {
  ok(`both campaigns ran long enough to mean something (${runs.map((r) => `day ${r.lastDay}`).join(', ')})`);
}

// The two runs have to actually differ. Same-seed-twice is `x === x`.
if (runs.length > 1) {
  const shape = (r) => `${r.lastDay}:${r.s.citizenIds.length}:${r.dug}:${r.s.stats.deaths}`;
  if (shape(runs[0]) === shape(runs[1])) {
    fail('both campaigns produced identical figures — the seeds are not diverging');
  } else {
    ok('the two campaigns diverge, so this is two samples and not one twice');
  }
}

console.log('');
if (failures.length) {
  console.error(`✗ campaign: ${failures.length} failure(s)`);
  for (const f of failures.slice(0, 30)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('  PASS — the game holds together for a whole campaign');
