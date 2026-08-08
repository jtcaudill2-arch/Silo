#!/usr/bin/env node
/**
 * world.mjs — the Phase 6 gate.
 *
 * Two claims to prove. First, that the world runs itself: silos drift,
 * collapse, and go to war with each other over a long campaign without the
 * player touching anything, and the player hears about it. Second — the one
 * that actually makes diplomacy a layer rather than a menu — that silos
 * remember, that memory decays but never clears, and that it measurably
 * changes whether they say yes.
 *
 * Run: node test/world.mjs
 */

import { Store } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import { evaluate, perform, memoryScore, hasTreaty, bundleValue } from '../src/sim/diplomacy.js';
import { simulateDay as worldDay, playerPower, inRange } from '../src/sim/world.js';
import { BAL } from '../src/config/balance.js';

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

const SEED = 0x51102024;
registerCoreReducers();

function silo12(seed = SEED, scenario = 'sufficient') {
  const store = new Store(createNewGame({ seed, scenario, now: 1_700_000_000_000 }));
  store.silent = true;
  const game = new Game(store);
  store.dispatchAll(autoAssign(store.state));
  return { store, game };
}

// ---------------------------------------------------------------------------
// 1. The world runs itself
// ---------------------------------------------------------------------------
{
  const { store, game } = silo12();
  const s = store.state;
  // Give them the radio so there's traffic to hear.
  store.dispatch({ type: 'RADIO_TIER', tier: 3 });
  for (const silo of Object.values(s.world.silos)) silo.known = true;

  const before = snapshotWorld(s);
  game.runDays(300);
  const after = snapshotWorld(s);

  const drifted = Object.keys(before).filter((id) => {
    const a = before[id];
    const b = after[id];
    return Math.abs(a.population - b.population) > 1 || Math.abs(a.stability - b.stability) > 1;
  });
  if (drifted.length < 5) {
    fail(`only ${drifted.length} silos changed at all over 300 days — the world is inert`);
  } else {
    ok(`${drifted.length} of 19 silos drifted measurably over 300 game days`);
  }

  const wars = Object.values(s.world.silos).filter((x) => (x.treaties || []).some((t) => t.kind === 'war'));
  if (!wars.length) {
    fail('no silo ever went to war with another over 300 days');
  } else {
    ok(`${wars.length} silos ended up in wars the player had nothing to do with`);
  }

  const chatter = s.world.transmissions.filter((t) => t.kind === 'chatter');
  if (chatter.length < 5) fail(`only ${chatter.length} radio transmissions in 300 days`);
  else {
    ok(`${s.world.transmissions.length} transmissions logged`);
    for (const t of s.world.transmissions.slice(0, 3)) console.log(`      D${t.day}  ${t.text}`);
  }

  const collapsed = Object.values(s.world.silos).filter((x) => x.status === 'collapsed');
  ok(`${collapsed.length} silos are collapsed (3 begin that way)`);

  // The world must not run away: nothing may leave 0-100.
  for (const silo of Object.values(s.world.silos)) {
    for (const [k, v] of Object.entries(silo.power)) {
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        fail(`${silo.name}.${k} left its range: ${v}`);
      }
    }
    if (Math.abs(silo.reputation) > 100) fail(`${silo.name} reputation out of range: ${silo.reputation}`);
  }
  if (store.unknownActionTypes.size) {
    fail(`actions with no reducer: ${[...store.unknownActionTypes].join(', ')}`);
  }
}

function snapshotWorld(s) {
  const out = {};
  for (const silo of Object.values(s.world.silos)) {
    out[silo.id] = { ...silo.power, status: silo.status };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. THE MEMORY GATE — they remember, and it costs you
// ---------------------------------------------------------------------------
{
  const { store, game } = silo12();
  const s = store.state;
  store.dispatch({ type: 'RADIO_TIER', tier: 3 });

  // Ninefold: honesty 1.0, keeps its word absolutely. The right silo to
  // betray if you want to find out whether betrayal costs anything.
  const ninefold = s.world.silos[11];
  ninefold.known = true;
  store.dispatchAll(perform(s, 11, 'hail'));
  if (ninefold.contact === 'none') fail('hailing Ninefold did not open contact');
  else ok(`hailed Ninefold — contact is now "${ninefold.contact}"`);

  const offer = { action: 'nap', give: {}, want: {} };
  const clean = evaluate(s, ninefold, offer);

  // Now break something. A standing trade agreement you cannot fund.
  store.dispatchAll(
    perform(s, 11, 'trade_agreement', { give: { food: 200, fuel: 40 }, want: { parts: 20 } })
  );
  if (!hasTreaty(ninefold, 'trade_agreement')) {
    fail('Ninefold refused a trade agreement it should have taken');
  }
  store.dispatch({ type: 'RESOURCE_SET', values: { food: 0, fuel: 0 } });
  // Run until the agreement comes due and they discover you cannot pay.
  game.runDays(20);

  const afterBreak = evaluate(s, ninefold, offer);
  const score = memoryScore(ninefold);

  if (score >= 0) {
    fail(`breaking a standing agreement left memory at ${score.toFixed(1)} — no grudge recorded`);
  } else if (afterBreak.score >= clean.score) {
    fail(
      `breaking a deal did not lower Ninefold's willingness ` +
        `(${clean.score.toFixed(1)} → ${afterBreak.score.toFixed(1)})`
    );
  } else {
    ok(
      `breaking a deal cost real standing: accept score ${clean.score.toFixed(1)} → ` +
        `${afterBreak.score.toFixed(1)}, memory ${score.toFixed(1)}`
    );
    const grudge = (ninefold.memory || []).find((m) => m.kind === 'broken');
    if (grudge) console.log(`      they wrote down: "${grudge.text}"`);
  }

  // And it must decay without ever clearing.
  const atBreak = memoryScore(ninefold);
  game.runDays(400);
  const later = memoryScore(ninefold);
  if (later === atBreak) {
    fail('memory never decayed at all over 400 days');
  } else if (later >= 0) {
    fail(`the grudge cleared entirely after 400 days (${atBreak.toFixed(1)} → ${later.toFixed(1)})`);
  } else {
    ok(
      `the grudge faded but did not clear: ${atBreak.toFixed(1)} → ${later.toFixed(1)} ` +
        `after 400 days. It is on the list for good.`
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Archetypes actually behave differently
// ---------------------------------------------------------------------------
{
  const { store } = silo12();
  const s = store.state;
  store.dispatch({ type: 'RADIO_TIER', tier: 3 });
  for (const silo of Object.values(s.world.silos)) {
    silo.known = true;
    silo.contact = 'trade';
  }

  const offer = { action: 'alliance', give: {}, want: {} };
  const scored = Object.values(s.world.silos)
    .filter((x) => x.status !== 'collapsed' && x.archetype)
    .map((x) => ({ name: x.name, arch: x.archetype, v: evaluate(s, x, offer) }))
    .sort((a, b) => b.v.score - b.v.threshold - (a.v.score - a.v.threshold));

  const easiest = scored[0];
  const hardest = scored[scored.length - 1];
  if (easiest.arch === hardest.arch) {
    fail('every archetype evaluates an alliance identically');
  } else {
    ok(
      `archetypes differ: ${easiest.name} (${easiest.arch}) is the softest touch, ` +
        `${hardest.name} (${hardest.arch}) the hardest`
    );
  }

  // The Anvil (warlord, aggression 0.95) must be harder than Selby (agrarian).
  const anvil = evaluate(s, s.world.silos[5], offer);
  const selby = evaluate(s, s.world.silos[6], offer);
  if (anvil.score - anvil.threshold >= selby.score - selby.threshold) {
    fail('The Anvil is no harder to ally with than Selby, which cannot be right');
  } else {
    ok('The Anvil is measurably harder to ally with than Selby');
  }

  // Demanding tribute from somebody stronger must fail; the fear term is
  // what makes the militarist path mean anything.
  const mine = playerPower(s);
  const strong = Object.values(s.world.silos).find((x) => x.power.military > mine.military + 30);
  if (strong) {
    const t = evaluate(s, strong, { action: 'tribute', give: {}, want: {} });
    if (t.accepted) fail(`${strong.name} paid tribute despite outgunning you`);
    else ok(`${strong.name} refuses tribute — they outgun you and they know it`);
  }
}

// ---------------------------------------------------------------------------
// 4. Radio range gates who you can reach
// ---------------------------------------------------------------------------
{
  const { store } = silo12();
  const s = store.state;
  const counts = [];
  for (const tier of [0, 1, 2, 3]) {
    store.dispatch({ type: 'RADIO_TIER', tier });
    s.world.radioTier = tier; // RADIO_TIER only raises; force it down for the test
    counts.push(Object.values(s.world.silos).filter((x) => inRange(s, x)).length);
  }
  if (counts[0] !== 0) fail('silos were reachable with no radio at all');
  if (!(counts[1] < counts[2] && counts[2] < counts[3])) {
    fail(`radio range does not widen with tier: ${counts.join(' → ')}`);
  } else {
    ok(`radio range widens with tier: ${counts.join(' → ')} silos reachable`);
  }
}

// ---------------------------------------------------------------------------
// 5. Refusing a call to arms is public
// ---------------------------------------------------------------------------
{
  const { store } = silo12();
  const s = store.state;
  for (const silo of Object.values(s.world.silos)) {
    silo.known = true;
    silo.reputation = 20;
  }
  const before = Object.values(s.world.silos).map((x) => x.reputation);
  store.dispatch({
    type: 'BROADCAST_REPUTATION',
    amount: BAL.diplomacy.allyCallToArmsBroadcastRep,
    except: [11],
    reason: 'Silo 12 refusing a call to arms',
  });
  const after = Object.values(s.world.silos).map((x) => x.reputation);
  const dropped = before.filter((v, i) => after[i] < v).length;
  if (dropped < 15) fail(`only ${dropped} silos heard about the refusal`);
  else ok(`${dropped} silos independently thought less of you for it`);
  if (s.world.silos[11].reputation !== 20) fail('the excepted silo was affected by the broadcast');
}

console.log('');
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
console.log('  PASS — world and diplomacy\n');
