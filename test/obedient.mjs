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
 * Run: node test/obedient.mjs [--days=200]
 */

import { createStore } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import { topDirective } from '../src/sim/directives.js';
import { canBuild, build, canExcavate, startExcavation, canRepair, repair } from '../src/sim/build.js';
import { canStart } from '../src/sim/research.js';
import { RESEARCH_LIST } from '../src/data/research.js';
import { formSquad } from '../src/sim/military.js';
import { BAL } from '../src/config/balance.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const DAYS = Number(args.days ?? 200);

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
    case 'repair': {
      const check = canRepair(state, d.roomId);
      if (!check.ok) return `refused: ${check.reason}`;
      return { actions: repair(state, d.roomId), note: 'repaired' };
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
      // The order says "choose a project" and does not say which. An obedient
      // player takes the first thing offered.
      const node = RESEARCH_LIST.find((n) => canStart(state, n.id).ok);
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
    case 'steady':
      return 'nothing to do';
    default:
      return `no idea how to obey "${d.id}"`;
  }
}

// -------------------------------------------------------------------- run ---

const store = createStore(createNewGame({ seed: BAL.meta.defaultSeed, now: 1_700_000_000_000 }));
store.silent = true;
const game = new Game(store);
const s = store.state;
store.dispatchAll(autoAssign(s));

const seen = new Map(); // directive id -> how many days it was the top order
const stuck = new Map(); // refusal reason -> count
const trail = [];
let last = null;

// A player checking in does several things and re-reads the order between
// each — one action a day is not obedience, it is absence.
const ACTIONS_PER_DAY = 3;

for (let d = 0; d < DAYS; d++) {
  for (let i = 0; i < ACTIONS_PER_DAY; i++) {
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

// ----------------------------------------------------------------- report ---

console.log('');
console.log('  DEEPWATER — a player who only does what they are told');
console.log('  ' + '─'.repeat(62));
console.log(`  ${DAYS} days, obeying the standing order and nothing else.`);
console.log('');
console.log('  the orders it was given, in sequence');
for (const t of trail.slice(0, 18)) {
  console.log(`    d${String(t.day).padStart(3)}  ${String(t.scrap).padStart(4)} scrap   ${t.text}`);
}
if (trail.length > 18) console.log(`    … and ${trail.length - 18} more changes`);

console.log('');
console.log(`  day ${s.clock.day}: ${s.citizenIds.length} residents, ` +
  `${Object.keys(s.silo.rooms).length} rooms, ` +
  `${s.silo.floors.filter((f) => f.excavated).length} floors, ` +
  `${s.research.completed.length} research, order ${Math.round(s.order.value)}`);
const causes = Object.entries(s.stats.causes || {}).sort((a, b) => b[1] - a[1]);
if (causes.length) console.log('  causes of death: ' + causes.map(([k, v]) => `${k} ×${v}`).join(', '));

if (stuck.size) {
  console.log('');
  console.log('  orders it could not carry out');
  for (const [reason, n] of [...stuck].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`    ×${String(n).padStart(3)}  ${reason}`);
  }
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
for (const [reason, n] of stuck) {
  if (n > DAYS * 0.15) {
    fail(`"${reason}" was the standing order on ${n} of ${DAYS} days and never became possible`);
  }
}

// The advice has to move the silo forward, not just keep it breathing.
if (Object.keys(s.silo.rooms).length <= 6) {
  fail(`the silo never grew past its starting six rooms (${Object.keys(s.silo.rooms).length})`);
} else {
  ok(`grew to ${Object.keys(s.silo.rooms).length} rooms without the player deciding anything`);
}
if (!s.research.completed.length) {
  fail('following the orders never produced a single research node');
} else {
  ok(`${s.research.completed.length} research nodes, chosen by taking whatever was offered first`);
}

console.log('');
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
console.log('  PASS — the game can be played by doing what it says\n');
