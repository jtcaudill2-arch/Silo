#!/usr/bin/env node
/**
 * obedient.mjs — does following the game's own advice keep you alive?
 *
 * The autopilot in test/autopilot.mjs is a competent player using its own
 * judgement: it reads flows, keeps reserves, sequences a build order it was
 * taught. That proves the silo is *survivable*. It does not prove the game is
 * *teachable*, because the autopilot never reads a word the game says.
 *
 * This player has no judgement at all. Every day it asks for the standing
 * order, does exactly that, and does nothing else. No reserve, no plan, no
 * lookahead — if the silo does not tell it, it does not know.
 *
 * That makes this a test of the advice rather than of the simulation. If an
 * obedient player dies, the directive system is either wrong about priority
 * or silent about something that matters, and a real player reading the same
 * line would walk into the same wall. It is the closest thing to a usability
 * test that can run in a terminal.
 *
 * It also runs the same silo at several rates of obedience, because how *often*
 * a player does what they are told is now a real variable: the standing order
 * has a one-tap action button, so a player checking in every shift presses it
 * eight times a day rather than three. See "obeying harder" at the bottom for
 * what that used to do and what must not come back.
 *
 * Run: node test/obedient.mjs [--days=200] [--rates=3,5,8,12]
 */

import { createStore } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import { topDirective } from '../src/sim/directives.js';
import {
  canBuild, build, canExcavate, startExcavation, canRepair, repair, canShore, shoreFloor,
} from '../src/sim/build.js';
import { canStart } from '../src/sim/research.js';
import { RESEARCH_LIST } from '../src/data/research.js';
import { getRoom } from '../src/data/rooms.js';
import { formSquad } from '../src/sim/military.js';
import { BAL } from '../src/config/balance.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const DAYS = Number(args.days ?? 200);

/**
 * How many times a day the player checks in and does what it says.
 *
 * Three is the reference: a player who looks in morning, noon and night. The
 * rest are the same player pressing the order's action button more often, up
 * to roughly once a shift. None of them is allowed to come out behind the
 * reference — see the monotonicity check.
 */
const SEED = Number(args.seed ?? BAL.meta.defaultSeed);
const RATES = String(args.rates ?? '3,5,8,12').split(',').map(Number);
const REFERENCE = RATES[0];

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

registerCoreReducers();

/**
 * First bay anywhere that will take this room type, or the reasons it can't
 * go anywhere. Reporting the real refusal matters: "nowhere to put it" and
 * "cannot afford it" call for completely different fixes, and guessing sent
 * me looking at the floor plan when the problem was the treasury.
 */
function findSpot(state, type) {
  const reasons = new Set();
  for (const floor of state.silo.floors) {
    if (!floor.excavated) continue;
    for (let slot = 0; slot < BAL.silo.slotsPerFloor; slot++) {
      const check = canBuild(state, floor.n, slot, type);
      if (check.ok) return { floor: floor.n, slot };
      reasons.add(check.reason);
    }
  }
  // "That bay is occupied" is noise when some other reason is the real one.
  const real = [...reasons].filter((r) => !/occupied/i.test(r));
  return { blocked: (real.length ? real : [...reasons]).join('; ') };
}

/**
 * Carry out one standing order, literally. Returns what happened, so the
 * report can show where an obedient player gets stuck rather than only that
 * they did.
 */
function obey(state, d) {
  if (!d) return 'nothing to do';

  if (d.room) {
    const spot = findSpot(state, d.room);
    if (spot.blocked) return `refused (${d.room}): ${spot.blocked}`;
    return { actions: build(state, spot.floor, spot.slot, d.room), note: `built ${d.room}` };
  }

  // An order that says to wait is an order, and obeying it means doing
  // nothing today. Flagged on the directive rather than matched by id so a
  // new hold-style order doesn't read as advice the player cannot follow.
  if (d.wait) return 'nothing to do';

  switch (d.id) {
    // One action for both, which is the point of building found rooms out of
    // the repair machinery: a level that came with a room in it hands over an
    // ordinary room that happens to arrive at fifteen per cent, and putting it
    // into service is paying its repair bill. Partial payment is allowed, so a
    // silo that cannot afford the whole thing today finishes it over several.
    case 'repair':
    case 'restore': {
      const check = canRepair(state, d.roomId);
      if (!check.ok) return `refused: ${check.reason}`;
      return { actions: repair(state, d.roomId), note: d.id === 'restore' ? 'restored' : 'repaired' };
    }
    case 'shore': {
      const check = canShore(state, d.floor);
      if (!check.ok) return `refused: ${check.reason}`;
      return { actions: shoreFloor(state, d.floor), note: `shored floor ${d.floor}` };
    }
    case 'staff':
      return { actions: autoAssign(state), note: 'crewed empty posts' };
    case 'dig_research': {
      const check = canStart(state, d.research);
      if (!check.ok) return `refused: ${check.reason}`;
      return {
        actions: [{ type: 'RESEARCH_SET_ACTIVE', active: { id: d.research, progress: 0, cycles: 0 } }],
        note: `started ${d.research}`,
      };
    }
    case 'research': {
      // The order now names a project. Follow the one it named; fall back to
      // the first startable only if it did not say (which it should always do
      // — a research order that does not name a node is not an order).
      const named = d.research && canStart(state, d.research).ok ? { id: d.research } : null;
      const node = named || RESEARCH_LIST.find((n) => canStart(state, n.id).ok);
      if (!node) return 'refused: nothing startable';
      return {
        actions: [{ type: 'RESEARCH_SET_ACTIVE', active: { id: node.id, progress: 0, cycles: 0 } }],
        note: `started ${node.id}`,
      };
    }
    case 'excavate': {
      const dig = canExcavate(state);
      if (!dig.ok) return `refused: ${dig.reason}`;
      return { actions: startExcavation(state), note: 'started digging' };
    }
    case 'squad':
      return { actions: formSquad(state), note: 'formed a squad' };
    default:
      return `no idea how to obey "${d.id}"`;
  }
}

/**
 * How far the silo is from being able to pay for a room, as one number.
 *
 * The worst of its shortfalls, because a room is bought when the last of its
 * costs is met. Used to watch a held target get *closer* over the days a hold
 * is standing, which is the difference between saving up and a treadmill.
 */
function distanceTo(state, type) {
  let worst = 0;
  for (const [k, v] of Object.entries(getRoom(type)?.buildCost || {})) {
    if (k === 'labor') continue;
    worst = Math.max(worst, v - (state.resources[k] ?? 0));
  }
  return Math.max(0, worst);
}

// -------------------------------------------------------------------- run ---

/**
 * Play one silo, obeying `perDay` times a day, and report what it came to.
 *
 * `raids` is the number of times a target the silo was already saving up for
 * got *further away* while the hold was still standing and the target had not
 * been bought. That is the treadmill, measured directly: the order said save,
 * and then the next order spent the savings on something else.
 */
function playObediently(perDay, days) {
  const store = createStore(createNewGame({ seed: SEED, now: 1_700_000_000_000 }));
  store.silent = true;
  const game = new Game(store);
  const s = store.state;
  store.dispatchAll(autoAssign(s));

  const seen = new Map(); // directive id -> how many days it was the top order
  const stuck = new Map(); // refusal reason -> count
  const trail = [];
  let last = null;
  let raids = 0;
  let worstRaid = null;
  let held = null; // { target, distance }

  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      const order = topDirective(s);
      if (!order) break;
      if (i === 0) {
        seen.set(order.id, (seen.get(order.id) || 0) + 1);
        if (order.id !== last) {
          trail.push({
            day: s.clock.day,
            id: order.id,
            text: order.text,
            scrap: Math.round(s.resources.scrap),
          });
          last = order.id;
        }
      }

      // Watch a savings plan the way the player would: is the thing it named
      // getting closer? A hold that keeps naming the same target while the
      // number goes up is the silo spending its own reserve.
      if (order.target) {
        const distance = distanceTo(s, order.target);
        if (held && held.target === order.target && distance > held.distance + 0.5) {
          raids++;
          const slip = distance - held.distance;
          if (!worstRaid || slip > worstRaid.slip) {
            worstRaid = { day: s.clock.day, target: order.target, slip, distance };
          }
        }
        held = { target: order.target, distance };
      } else if (held && order.room === held.target) {
        held = null; // bought it — the plan finished
      }

      const result = obey(s, order);
      if (typeof result === 'string') {
        if (result !== 'nothing to do') stuck.set(result, (stuck.get(result) || 0) + 1);
        break; // blocked or nothing to do; no point repeating it this day
      }
      store.dispatchAll(result.actions);
    }
    game.runDays(1);
    if (s.citizenIds.length === 0) break;
  }

  return {
    perDay,
    state: s,
    seen,
    stuck,
    trail,
    raids,
    worstRaid,
    day: s.clock.day,
    residents: s.citizenIds.length,
    rooms: Object.keys(s.silo.rooms).length,
    floors: s.silo.floors.filter((f) => f.excavated).length,
    research: s.research.completed.length,
  };
}

const runs = RATES.map((n) => playObediently(n, DAYS));
const base = runs[0];
const s = base.state;

// ----------------------------------------------------------------- report ---

console.log('');
console.log('  DEEPWATER — a player who only does what they are told');
console.log('  ' + '─'.repeat(62));
console.log(`  ${DAYS} days, obeying the standing order and nothing else, ${REFERENCE}× a day.`);
console.log('');
console.log('  the orders it was given, in sequence');
for (const t of base.trail.slice(0, 18)) {
  console.log(`    d${String(t.day).padStart(3)}  ${String(t.scrap).padStart(4)} scrap   ${t.text}`);
}
if (base.trail.length > 18) console.log(`    … and ${base.trail.length - 18} more changes`);

console.log('');
console.log(`  day ${s.clock.day}: ${s.citizenIds.length} residents, ` +
  `${Object.keys(s.silo.rooms).length} rooms, ` +
  `${s.silo.floors.filter((f) => f.excavated).length} floors, ` +
  `${s.research.completed.length} research, order ${Math.round(s.order.value)}`);
const causes = Object.entries(s.stats.causes || {}).sort((a, b) => b[1] - a[1]);
if (causes.length) console.log('  causes of death: ' + causes.map(([k, v]) => `${k} ×${v}`).join(', '));

if (base.stuck.size) {
  console.log('');
  console.log('  orders it could not carry out');
  for (const [reason, n] of [...base.stuck].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`    ×${String(n).padStart(3)}  ${reason}`);
  }
}

console.log('');
console.log('  obeying harder');
console.log('    per day   residents   rooms   floors   research   savings raided');
for (const r of runs) {
  console.log(
    `      ${String(r.perDay).padStart(2)}×      ` +
      `${String(r.residents).padStart(6)}   ${String(r.rooms).padStart(5)}   ` +
      `${String(r.floors).padStart(6)}   ${String(r.research).padStart(8)}   ${String(r.raids).padStart(14)}`
  );
}

// ----------------------------------------------------------------- checks ---

console.log('');
if (s.citizenIds.length === 0) {
  fail(
    `the silo died on day ${s.clock.day} under a player doing exactly what it said. ` +
      'Either the advice is wrong about priority or it is silent about something that matters.'
  );
} else {
  ok(`survived ${DAYS} days on the standing orders alone — ${s.citizenIds.length} residents`);
}

// An order the player is repeatedly unable to carry out is worse than no
// order: it is the game asking for something it will not let you do.
for (const [reason, n] of base.stuck) {
  if (n > DAYS * 0.15) {
    fail(`"${reason}" was the standing order on ${n} of ${DAYS} days and never became possible`);
  }
}

// The advice has to move the silo forward, not just keep it breathing.
// Counted from a fresh silo rather than written down. It was `<= 6` against a
// hard-coded "starting six rooms" for as long as the opening had six; the
// opening has five now, so that threshold had quietly become "grew by two".
const STARTING_ROOMS = Object.keys(createNewGame({ seed: BAL.meta.defaultSeed }).silo.rooms).length;
if (Object.keys(s.silo.rooms).length <= STARTING_ROOMS + 1) {
  fail(`the silo never meaningfully grew past its ${STARTING_ROOMS} starting rooms (${Object.keys(s.silo.rooms).length})`);
} else {
  ok(`grew to ${Object.keys(s.silo.rooms).length} rooms without the player deciding anything`);
}
if (!s.research.completed.length) {
  fail('following the orders never produced a single research node');
} else {
  ok(`${s.research.completed.length} research nodes, chosen by taking whatever was offered first`);
}

// ---- obeying more must not be worse -----------------------------------------
//
// The standing order has a one-tap action button, so the rate a player obeys at
// is the rate they press it, and the cold open tells them to do what it says in
// the order it says it. That has to be safe advice at any rate.
//
// It was not. Measured before this check existed: at three actions a day the
// silo reached day 40 with 13 rooms, two research nodes and the Generator Hall
// the order kept naming bought on day 37; at eight it reached day 40 with 21
// rooms, *one* research node and the Hall still unbought, and by day 124 it was
// dead. The order alternated between "Save up for a Generator Hall" and "Build
// another Recycling plant", so every extra press spent the savings the previous
// press had been told to accumulate — fifteen days of perfect obedience moved
// the Hall from 172 scrap short to 163 short.
//
// So: nobody obeying more often than the reference may come out behind it. The
// slack on rooms and floors is for trajectory noise — two silos that diverge on
// day 3 do not land on the same floor plan on day 200 — while research and
// survival are checked strictly, because those are what the treadmill destroyed.
//
// Research allows a single node, and only out of a healthy total. A node is a
// step function against the 200-day wall — one that lands on day 199 in one run
// and day 201 in the other is a boundary effect, not a treadmill — but the
// shortfall the treadmill produced was 2 nodes against 1, a *halving*, and a
// flat one-node tolerance would wave that through. Below five nodes there is no
// slack at all, so the original failure is still caught by this line and not
// only by the death check underneath it. The savings-raid counter below is the
// precise instrument; this is the coarse one.
const SLACK = 2;
const RESEARCH_MIN_FOR_SLACK = 5;
for (const r of runs.slice(1)) {
  const worse = [];
  if (base.residents > 0 && r.residents === 0) worse.push(`everyone died on day ${r.day}`);
  const researchSlack = base.research >= RESEARCH_MIN_FOR_SLACK ? 1 : 0;
  if (r.research < base.research - researchSlack) {
    worse.push(`${r.research} research against ${base.research}`);
  }
  if (r.rooms < base.rooms - SLACK) worse.push(`${r.rooms} rooms against ${base.rooms}`);
  if (r.floors < base.floors - SLACK) worse.push(`${r.floors} floors against ${base.floors}`);
  if (worse.length) {
    fail(
      `acting ${r.perDay}× a day did worse than acting ${REFERENCE}× a day: ${worse.join(', ')}. ` +
        'Obeying the standing order more often has to be at worst neutral.'
    );
  }
}
if (!failures.length || !failures.some((f) => /did worse/.test(f))) {
  ok(
    `obeying ${RATES.slice(1).join('×, ')}× a day is no worse than ${REFERENCE}× ` +
      `(research ${runs.map((r) => r.research).join('/')}, rooms ${runs.map((r) => r.rooms).join('/')})`
  );
}

// And the mechanism, not only the outcome: a savings plan has to converge. Once
// the order says to save up for something, that thing may not get *further*
// away while the order still says to save up for it.
const raided = runs.filter((r) => r.raids > 0);
if (raided.length) {
  const w = raided[0].worstRaid;
  fail(
    `the standing order spent its own savings: a held target went ${w.slip.toFixed(0)} further away ` +
      `on day ${w.day} (${w.target}), across ${raided.map((r) => `${r.perDay}× ${r.raids}`).join(', ')}. ` +
      'A hold that alternates with orders that spend is a treadmill, not advice.'
  );
} else {
  ok('every "save up" order got closer to its target every shift it stood');
}

console.log('');
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
console.log('  PASS — the game can be played by doing what it says\n');
