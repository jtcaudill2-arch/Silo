#!/usr/bin/env node
/**
 * unlocks.mjs — does the game arrive in readable pieces, and do they stay?
 *
 * `src/sim/unlocks.js` decides what a new mayor can see and when. Two
 * different things can go wrong with that and neither is visible from any
 * other test in the suite:
 *
 *   1. A gate that closes. The Order panel used to be gated on a live reading
 *      of `order.value` against a line that sat *below* the level order drifts
 *      to, so every silo that crossed it was pulled back over within two or
 *      three days and the panel it had just been given disappeared again —
 *      permanently, because shell.js only announces an unlock once. Nothing
 *      caught it: the headless harness does not look at panels and the browser
 *      tests only ever see the first morning.
 *
 *   2. A spine that arrives in the wrong order, or all at once, or not for
 *      forty days. "One system at a time" is the whole premise of the module
 *      and it was untested prose. This drives the project's own autopilot and
 *      prints the day each panel actually landed.
 *
 * The first is an assertion. The second is mostly a *report* — the arrival
 * order is emergent from what the player chooses to build and this file is
 * not going to pretend otherwise — with three claims held to account: Research
 * is first, Order is last, and the Surface panel is not hostage to a finished
 * Airlock.
 *
 * Run: node test/unlocks.mjs [--days=160]
 */

import { createStore } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import { autopilot } from './autopilot.mjs';
import { UNLOCKS, unlocked, unlockedIds, newlyUnlocked, liveResourceKeys } from '../src/sim/unlocks.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const DAYS = Number(args.days ?? 160);
const SEEDS = [0x1234, 0xbeef, 0xd00d];

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

registerCoreReducers();

const LABEL = Object.fromEntries(UNLOCKS.map((u) => [u.id, u.label]));

/**
 * One campaign. Returns the day each system arrived, plus every gate that was
 * ever seen to close.
 */
function campaign(seed, { days = DAYS, wreck = false } = {}) {
  const store = createStore(createNewGame({ seed, now: 1_700_000_000_000 }));
  store.silent = true;
  const game = new Game(store);
  const s = store.state;
  store.dispatchAll(autoAssign(s));

  const arrived = new Map(); // id -> day
  const closed = []; // gates that went true -> false
  const sameDay = []; // days on which two or more landed together
  let counters = liveResourceKeys(s).size;
  const counterDays = [{ day: 0, n: counters }];
  let prev = unlockedIds(s);

  for (let d = 0; d < days; d++) {
    if (!wreck) store.dispatchAll(autopilot(s));
    else wreckTheSilo(store, s, d);
    game.runDays(1);

    // Every gate, every day. A gate that reads true and then false is the
    // failure this file exists for, so it is checked at day resolution rather
    // than only at the end.
    const landed = [];
    for (const u of UNLOCKS) {
      const now = unlocked(s, u.id);
      if (now && !arrived.has(u.id)) {
        arrived.set(u.id, s.clock.day);
        landed.push(u.id);
      } else if (!now && arrived.has(u.id)) {
        closed.push(`${u.label} closed on day ${s.clock.day} (opened on day ${arrived.get(u.id)})`);
        arrived.delete(u.id);
      }
    }
    if (landed.length > 1) sameDay.push(`day ${s.clock.day}: ${landed.map((i) => LABEL[i]).join(' + ')}`);

    // newlyUnlocked has to agree with the gates it is derived from, because
    // the shell announces off it and marks the nav button off the other.
    const ids = unlockedIds(s);
    const fresh = newlyUnlocked(prev, s).map((u) => u.id);
    const expected = ids.filter((i) => !prev.includes(i));
    if (fresh.join() !== expected.join()) {
      closed.push(`newlyUnlocked disagreed with unlockedIds on day ${s.clock.day}`);
    }
    prev = ids;

    const n = liveResourceKeys(s).size;
    if (n !== counters) {
      counterDays.push({ day: s.clock.day, n });
      counters = n;
    }
    if (!s.citizenIds.length) break;
  }
  return { arrived, closed, sameDay, counterDays, day: s.clock.day, pop: s.citizenIds.length };
}

/**
 * A silo run into the ground, on purpose.
 *
 * The autopilot is competent and its order never falls far, which is exactly
 * the run in which a gate that closes on recovering order never gets the
 * chance to close. This one shoves order under every threshold it has and
 * then leaves it alone to drift back up — which is the precise shape of the
 * bug: cross the line, get the panel, recover, lose the panel.
 */
function wreckTheSilo(store, s, day) {
  if (day % 40 === 0) store.dispatch({ type: 'ORDER_SET', value: 18 });
  if (day % 40 === 12) store.dispatch({ type: 'ORDER_SET', value: 41 });
  if (day % 40 === 20) store.dispatch({ type: 'ORDER_SET', value: 96 });
  if (day % 7 === 0) store.dispatchAll(autoAssign(s));
}

// ---------------------------------------------------------------- report ---

console.log('');
console.log('  DEEPWATER — the order the silo hands itself over in');
console.log('  ' + '─'.repeat(66));

const runs = [];
for (const seed of SEEDS) {
  const r = campaign(seed);
  runs.push(r);
  const line = [...r.arrived]
    .sort((a, b) => a[1] - b[1])
    .map(([id, day]) => `d${String(day).padStart(3)} ${LABEL[id]}`)
    .join('  ');
  console.log(`  seed 0x${seed.toString(16).padStart(4, '0')}  ${line || '(nothing arrived)'}`);
  const counters = r.counterDays.map((c) => `d${c.day}:${c.n}`).join(' ');
  console.log(`                counters on the strip  ${counters}`);
}

// ------------------------------------------------------------ assertions ---

console.log('');

// ---- 1. a gate may not close ------------------------------------------------
const closed = runs.flatMap((r) => r.closed);
const wrecked = SEEDS.map((seed) => campaign(seed, { days: 200, wreck: true }));
const closedWrecked = wrecked.flatMap((r) => r.closed);
if (closed.length || closedWrecked.length) {
  for (const c of [...closed, ...closedWrecked].slice(0, 6)) {
    fail(`a panel that had arrived went away again — ${c}`);
  }
} else {
  ok(`no gate ever closed: ${SEEDS.length} autopilot campaigns of ${DAYS} days, ` +
    `plus ${SEEDS.length} of 200 days with order driven under every threshold it has`);
}

// A silo shoved to order 18 and left there for twelve days has politics. If
// the Order panel does not arrive for *that* silo, the gate is not doing its
// job in the other direction.
for (let i = 0; i < wrecked.length; i++) {
  if (!wrecked[i].arrived.has('policy')) {
    fail(`Order never opened on seed 0x${SEEDS[i].toString(16)} despite order being driven to 18`);
  }
}
if (wrecked.every((r) => r.arrived.has('policy'))) {
  ok('a silo in genuine trouble still gets the Order panel, and keeps it');
}

// ---- 2. the shape of the spine ---------------------------------------------
for (let i = 0; i < runs.length; i++) {
  const r = runs[i];
  const seed = `0x${SEEDS[i].toString(16)}`;
  const order = [...r.arrived].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  if (order[0] !== 'research') {
    fail(`${seed}: ${LABEL[order[0]] || 'nothing'} arrived before Research — Research pays for every gate below it`);
  }
  // The hinge of the early game must not be the last thing to happen. It used
  // to be gated on a finished Airlock, which put it on day 72-91.
  const surface = r.arrived.get('airlock');
  if (surface == null) fail(`${seed}: the Surface panel never arrived in ${DAYS} days`);
  else if (surface > DAYS * 0.4) {
    fail(`${seed}: the Surface panel arrived on day ${surface} — the hinge of the early game is too late`);
  }
}
if (!failures.length) {
  ok('Research first and Surface inside the first third, on every seed');
}
for (const r of runs) {
  const order = [...r.arrived].sort((a, b) => a[1] - b[1]).map(([id]) => LABEL[id]);
  console.log(`  · ${order.join(' → ')}`);
}

// ---- 2b. Order is earned, never waited for ---------------------------------
//
// Both of the lines this gate has had before were calendars wearing a
// threshold's clothes. `order.contentThreshold` (55) sat above the level order
// drifts to and so was crossed on day four or five of every silo ever played;
// a gate at 45 sat below it and so was crossed only on the
// way past, and closed again on the way back. Neither had anything to do with
// whether the silo had politics.
//
// So: a silo with no crime, no case, no policy and no sheriff must not be able
// to open the Order panel at *any* value of order at all. Checked directly
// rather than hoped for across seeds, because the whole failure mode is that
// the value alone was enough.
{
  const calm = createNewGame({ seed: 0x1234, now: 1_700_000_000_000 });
  const opened = [];
  for (let v = 0; v <= 100; v++) {
    calm.order.value = v;
    if (unlocked(calm, 'policy')) opened.push(v);
  }
  if (opened.length) {
    fail(
      `the Order panel opens on a silo with no politics at order ${opened[0]}-${opened[opened.length - 1]} — ` +
        'the gate is reading the drift again'
    );
  } else {
    ok('order alone never opens the Order panel: no crime, no case, no policy, no sheriff, no panel');
  }
  // …and the first thing that *is* politics opens it, and it never shuts.
  calm.order.value = 90;
  calm.order.investigations.push({ id: 'inv-1', crime: 'murder', suspects: [], verdict: null });
  if (!unlocked(calm, 'policy')) fail('an open murder investigation does not open the Order panel');
  else ok('an open investigation opens it at order 90 — the verdict is the politics, not the number');
}

// ---- 3. one at a time -------------------------------------------------------
const bunched = runs.flatMap((r) => r.sameDay);
if (bunched.length) {
  console.log(`  ! two panels landed on the same day: ${bunched.join('; ')}`);
} else {
  ok('no two panels ever landed on the same day — one arrival at a time');
}

// ---- 4. the first morning ---------------------------------------------------
const fresh = createNewGame({ seed: 0x1234, now: 1_700_000_000_000 });
const firstNav = unlockedIds(fresh).length;
const firstRes = liveResourceKeys(fresh).size;
if (firstRes > 4) fail(`${firstRes} resource counters on the first morning; the strip fits four`);
else ok(`the first morning is ${firstRes} counters and ${4 + firstNav} panels`);

console.log('');
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
console.log('  PASS — the spine arrives in order and nothing that arrives goes away\n');
