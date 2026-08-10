#!/usr/bin/env node
/**
 * conquest.mjs — taking a silo by force, end to end.
 *
 * The Dominion ending asks the player to hold six silos. Nothing in the test
 * suite had ever taken one, so the whole militarist path — scout, undermine,
 * breach, hold, garrison, revolt — was shipping on the strength of its unit
 * pieces compiling next to each other.
 *
 * This drives the full four-stage ladder against a real silo from the world
 * table, then holds it long enough to prove the occupation has an ongoing
 * cost and can be lost again. Conquest should be expensive, slow, and
 * reversible if neglected; a test that only proved you *can* take a silo
 * would be missing the half that makes it a decision.
 *
 * Run: node test/conquest.mjs
 */

import { createStore } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import { conquestState, canAdvance } from '../src/sim/diplomacy.js';
import { BAL } from '../src/config/balance.js';

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

registerCoreReducers();

const TARGET = 6; // Selby — a real row in the world table, not a fixture.

function newSilo() {
  const store = createStore(createNewGame({ seed: BAL.meta.defaultSeed, now: 1_700_000_000_000 }));
  store.silent = true;
  const game = new Game(store);
  store.dispatchAll(autoAssign(store.state));
  return { store, game, s: store.state };
}

console.log('');
console.log('  DEEPWATER — conquest');
console.log('  ' + '─'.repeat(58));

const { store, game, s } = newSilo();
const silo = s.world.silos[TARGET];
store.dispatch({ type: 'SILO_PATCH', siloId: TARGET, patch: { known: true, contact: 'radio' } });

// ---------------------------------------------------------------- stage 1 --
// Scouting. The ladder must refuse to skip a rung.

let gate = canAdvance(s, TARGET);
if (gate.ok || gate.stage !== 'scout') {
  fail(`a silo with no scouting done reports stage "${gate.stage}" / ok=${gate.ok}`);
} else {
  ok(`the ladder starts at scouting: "${gate.reason}"`);
}

for (let i = 0; i < BAL.conquest.scoutRunsRequired; i++) {
  store.dispatch({
    type: 'CONQUEST_PATCH',
    siloId: TARGET,
    patch: { stage: 'scout', scoutRuns: i + 1 },
  });
}
gate = canAdvance(s, TARGET);
if (!gate.ok || gate.stage !== 'undermine') {
  fail(`${BAL.conquest.scoutRunsRequired} approach runs did not unlock undermining (${gate.reason})`);
} else {
  ok(`${BAL.conquest.scoutRunsRequired} approach runs open the undermine stage`);
}

// ---------------------------------------------------------------- stage 2 --
// Undermining. Their defences have to actually come down.

store.dispatch({ type: 'CONQUEST_PATCH', siloId: TARGET, patch: { stage: 'undermine' } });
gate = canAdvance(s, TARGET);
if (gate.ok) fail('undermining was skippable — an intact silo advanced to breach');
else ok(`an un-undermined silo refuses the breach: "${gate.reason}"`);

const beforeDefense = conquestState(s, TARGET).defenseMult;
store.dispatch({
  type: 'CONQUEST_PATCH',
  siloId: TARGET,
  patch: {
    undermined: true,
    defenseMult: beforeDefense * (1 - BAL.conquest.undermineDefenseReduction),
  },
});
const afterDefense = conquestState(s, TARGET).defenseMult;
if (!(afterDefense < beforeDefense)) {
  fail(`undermining did not weaken them (${beforeDefense} → ${afterDefense})`);
} else {
  ok(`undermining costs them real defence: ${beforeDefense.toFixed(2)} → ${afterDefense.toFixed(2)}`);
}

// ---------------------------------------------------------------- stage 3 --
// The breach. Research and standing squads are both hard requirements.

store.dispatch({ type: 'CONQUEST_PATCH', siloId: TARGET, patch: { stage: 'breach' } });
gate = canAdvance(s, TARGET);
if (gate.ok || !/breaching charges/i.test(gate.reason)) {
  fail(`the breach did not require breaching charges (got "${gate.reason}")`);
} else {
  ok(`the breach is gated on research: "${gate.reason}"`);
}

store.dispatch({ type: 'RESEARCH_COMPLETE', id: 'breaching_charges' });
gate = canAdvance(s, TARGET);
if (gate.ok || !/squads/i.test(gate.reason)) {
  fail(`the breach did not require standing squads (got "${gate.reason}")`);
} else {
  ok(`and on the army: "${gate.reason}"`);
}

for (let i = 0; i < BAL.conquest.breachSquadsRequired; i++) {
  store.dispatch({ type: 'SQUAD_CREATE', name: `Column ${i + 1}` });
}
gate = canAdvance(s, TARGET);
if (!gate.ok || gate.stage !== 'hold') {
  fail(`a fully-prepared silo could not breach (${gate.reason})`);
} else {
  ok(`${BAL.conquest.breachSquadsRequired} squads and the charges open the assault`);
}

// ---------------------------------------------------------------- stage 4 --
// Holding it. This is where a satellite becomes a liability.

store.dispatch({ type: 'SATELLITE_ADD', siloId: TARGET, name: silo.name });
if (s.world.satellites.length !== 1) {
  fail(`taking a silo did not produce a satellite (${s.world.satellites.length})`);
} else {
  ok(`${silo.name} is held — ${s.world.satellites.length} satellite`);
}

// Garrisoned, it settles down and pays. Both squads exist already from the
// breach stage, so put one on occupation duty.
for (const id of s.military.squadIds) {
  store.dispatch({ type: 'SQUAD_PATCH', id, patch: { assignment: 'garrison' } });
}
const before = { ...s.resources };
const orderStart = s.world.satellites[0].order;
game.runDays(30);
const gained = Object.entries(s.resources).filter(([k, v]) => v > (before[k] ?? 0) + 1);
if (!gained.length) {
  fail('a held silo contributed nothing at all over thirty days');
} else {
  ok(`a garrisoned silo pays: ${gained.slice(0, 4).map(([k]) => k).join(', ')}`);
}
const warmed = s.world.satellites[0];
if (!warmed) {
  fail('a garrisoned satellite revolted anyway');
} else if (warmed.order <= orderStart) {
  fail(`a garrison did not settle the place down (${orderStart} → ${warmed.order})`);
} else {
  ok(`a garrison settles them: order ${Math.round(orderStart)} → ${Math.round(warmed.order)} over 30 days`);
}

// Pull the garrison off and it should slide, and eventually throw you out.
// If holding costs nothing, taking six silos is free and Dominion is the
// easy ending rather than the expensive one.
for (const id of s.military.squadIds) {
  store.dispatch({ type: 'SQUAD_PATCH', id, patch: { assignment: 'idle' } });
}
const abandonedAt = s.world.satellites[0].order;
let revoltDay = null;
for (let d = 0; d < 120 && !revoltDay; d++) {
  game.runDays(1);
  if (!s.world.satellites.some((x) => x.siloId === TARGET)) revoltDay = d + 1;
}
if (!revoltDay) {
  const now = s.world.satellites.find((x) => x.siloId === TARGET);
  fail(
    `an abandoned satellite never revolted in 120 days (order ${Math.round(abandonedAt)} → ` +
      `${Math.round(now?.order ?? -1)}) — occupation is free`
  );
} else {
  ok(`abandoned, ${silo.name} threw the garrison out after ${revoltDay} days`);
  const lost = s.world.silos[TARGET];
  if (lost.contact !== 'hostile') fail(`a revolted silo is "${lost.contact}", expected hostile`);
  else ok('and they are hostile now — everything spent taking it is gone');
}

// ------------------------------------------------------------------ ending --
// The Dominion ending counts satellites. Six is a long campaign; what has to
// be true is that the counter is the thing the ending actually reads.

// Pick real, standing silos — not a numeric range. Silo 12 is the player's
// own and is not in this table at all, so counting ids walks straight past a
// gap and comes up one short.
const takeable = Object.values(s.world.silos)
  .filter((x) => x.status !== 'collapsed' && !s.world.satellites.some((y) => y.siloId === x.id))
  .slice(0, BAL.endings.dominionSilosRequired);
for (const target of takeable) {
  store.dispatch({ type: 'SATELLITE_ADD', siloId: target.id, name: target.name });
}
const held = s.world.satellites.length;
if (held < BAL.endings.dominionSilosRequired) {
  fail(`could only hold ${held} silos; Dominion needs ${BAL.endings.dominionSilosRequired}`);
} else {
  ok(`${held} silos held — Dominion's headcount is reachable`);
}

const { ENDINGS } = await import('../src/data/events.js');
const dominion = ENDINGS.find((e) => e.id === 'dominion');
store.dispatch({ type: 'RESEARCH_COMPLETE', id: 'origin_record' });
if (!dominion.check(store.state)) {
  fail('six held silos and the Origin Record did not satisfy the Dominion ending');
} else {
  ok('six silos and the Record fire the Dominion ending');
}

console.log('');
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
console.log('  PASS — conquest\n');
