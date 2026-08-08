#!/usr/bin/env node
/**
 * order.mjs — the Phase 7 gate.
 *
 * The political layer is supposed to be uncomfortable rather than a second
 * happiness bar, so this checks the specific things that make it so:
 *
 *   - Every policy is a genuine trade. None of them are free.
 *   - The murder investigation can convict the wrong person, and the player
 *     is never told which. If the evidence always pointed at the culprit it
 *     would be a formality, not a decision.
 *   - An uprising resolves through the same combat function as the wasteland
 *     against your own named citizens, and winning it costs you people.
 *
 * Run: node test/order.mjs
 */

import { Store } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import {
  simulateDay as orderDay, policyCapacity, canTogglePolicy, deliverVerdict, accumulateEvidence,
} from '../src/sim/order.js';
import { POLICY_LIST, policyEffects } from '../src/data/policies.js';
import { fullName } from '../src/sim/population.js';
import { canRepair, repair } from '../src/sim/build.js';
import { BAL } from '../src/config/balance.js';

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

const SEED = 0x0d3ad;
registerCoreReducers();

function silo(seed = SEED, scenario = 'sufficient') {
  const store = new Store(createNewGame({ seed, scenario, now: 1_700_000_000_000 }));
  store.silent = true;
  const game = new Game(store);
  store.dispatchAll(autoAssign(store.state));
  return { store, game };
}

// ---------------------------------------------------------------------------
// 1. Every policy costs something
// ---------------------------------------------------------------------------
{
  const free = POLICY_LIST.filter((p) => {
    const e = p.effects;
    const bad =
      (e.orderPerDay ?? 0) < 0 || (e.moralePerDay ?? 0) < 0 || (e.healthPerDay ?? 0) < 0 ||
      (e.workforce ?? 0) < 0 || (e.nightOutput ?? 0) < 0 || (e.relationshipDecay ?? 0) > 0 ||
      (e.chitsPerCitizenPerDay ?? 0) < 0 || (e.accidentChancePerDay ?? 0) > 0 ||
      (e.reputationPerExile ?? 0) < 0;
    return !bad;
  });
  if (free.length) fail(`policies with no downside at all: ${free.map((p) => p.name).join(', ')}`);
  else ok(`all ${POLICY_LIST.length} policies carry a real cost`);

  const noBenefit = POLICY_LIST.filter((p) => !p.benefit || p.benefit.length < 8);
  if (noBenefit.length) fail(`policies with no stated benefit: ${noBenefit.map((p) => p.name).join(', ')}`);

  // The cap is real, and it moves with the administration.
  const { store } = silo();
  const s = store.state;
  const cap = policyCapacity(s);
  if (cap < BAL.order.maxPoliciesBase) fail(`policy capacity is ${cap}, below the base of ${BAL.order.maxPoliciesBase}`);
  for (let i = 0; i < cap; i++) {
    const next = POLICY_LIST.find((p) => !s.order.policies.includes(p.id) && canTogglePolicy(s, p.id).ok);
    if (next) store.dispatch({ type: 'POLICY_TOGGLE', id: next.id });
  }
  const overflow = POLICY_LIST.find((p) => !s.order.policies.includes(p.id));
  const blocked = canTogglePolicy(s, overflow.id);
  if (blocked.ok) fail(`the policy cap of ${cap} is not enforced`);
  else ok(`policy cap enforced at ${cap}: "${blocked.reason}"`);

  // Rationing must actually cut food consumption.
  store.dispatch({ type: 'POLICY_TOGGLE', id: s.order.policies[0] });
  store.dispatch({ type: 'POLICY_TOGGLE', id: 'rationing' });
  const e = policyEffects(s);
  if (!(e.foodConsumption < 1)) fail(`Rationing does not reduce food consumption (multiplier ${e.foodConsumption})`);
  else ok(`Rationing cuts food consumption to ${Math.round(e.foodConsumption * 100)}%`);
}

// ---------------------------------------------------------------------------
// 2. THE INVESTIGATION GATE — evidence is not proof
// ---------------------------------------------------------------------------
{
  const { store, game } = silo();
  const s = store.state;

  // Run a long campaign at low Order so murders actually happen.
  store.dispatch({ type: 'ORDER_SET', value: 30 });
  let investigations = [];
  for (let d = 0; d < 600 && investigations.length < 25; d++) {
    game.runDays(1);
    store.dispatch({ type: 'ORDER_SET', value: 30 }); // hold it down
    investigations = s.order.investigations.concat(investigations.filter((i) => !s.order.investigations.includes(i)));
    // Keep the population alive; this test is about crime, not famine.
    store.dispatch({ type: 'RESOURCE_SET', values: { food: 900, water: 900, fuel: 500, scrap: 600, filters: 200 } });
  }

  const cases = s.order.investigations.filter((i) => i.evidence && Object.keys(i.evidence).length);
  if (!cases.length) {
    fail('no murder investigations opened in 600 days at Order 30');
  } else {
    ok(`${cases.length} investigations opened over the campaign`);

    // How often does the strongest evidence point at the actual culprit?
    // Measured over many synthetic cases run through the real evidence
    // routine — three murders in a campaign is not a sample size.
    const TRIALS = 600;
    let right = 0;
    for (let t = 0; t < TRIALS; t++) {
      s.clock.day = 1000 + t * 7;
      let inv = {
        id: `trial-${t}`,
        suspects: [1, 2, 3],
        culpritId: 1,
        evidence: {},
      };
      for (let d = 0; d < BAL.order.crime.investigationDays; d++) {
        s.clock.day += 1;
        inv = { ...inv, evidence: accumulateEvidence(s, inv, 1) };
      }
      const top = Object.entries(inv.evidence).sort((a, b) => b[1] - a[1])[0];
      if (top && String(top[0]) === String(inv.culpritId)) right++;
    }
    const rate = right / TRIALS;
    if (rate >= 0.95) {
      fail(`the strongest evidence names the culprit ${Math.round(rate * 100)}% of the time — the verdict is a formality`);
    } else if (rate <= 0.45) {
      fail(`the strongest evidence names the culprit only ${Math.round(rate * 100)}% of the time — it is a coin flip`);
    } else {
      ok(
        `evidence names the culprit ${Math.round(rate * 100)}% of the time over ${TRIALS} cases — ` +
          'right more often than wrong, and never certain'
      );
    }

    // Convicting must be possible, and being wrong must cost Order.
    const inv = cases[0];
    const wrongId = inv.suspects.find(
      (id) => String(id) !== String(inv.culpritId) && s.citizens[id]?.status !== 'dead'
    );
    if (wrongId != null) {
      const before = s.order.value;
      store.dispatchAll(deliverVerdict(s, inv.id, wrongId, 'execute'));
      const after = s.order.value;
      if (after >= before) fail('executing the wrong person did not cost Order');
      else ok(`a wrong execution cost ${(before - after).toFixed(1)} Order and a life`);
      if (s.citizens[wrongId].status !== 'dead') fail('the executed suspect is still alive');
      if (s.citizens[wrongId].causeOfDeath !== 'executed') {
        fail(`executed citizen's cause of death is "${s.citizens[wrongId].causeOfDeath}"`);
      }
      // And the log must not reveal whether it was the right call.
      const verdictLog = s.log.filter((l) => l.text.includes(fullName(s.citizens[wrongId])));
      if (verdictLog.some((l) => /innocent|guilty|wrong|actually/i.test(l.text))) {
        fail('the log gives away whether the verdict was correct');
      } else {
        ok('the log never says whether you got it right');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. THE UPRISING — winning is a loss
// ---------------------------------------------------------------------------
{
  const { store, game } = silo();
  const s = store.state;

  // Drive the silo into the ground: no food, no order, wretched morale.
  store.dispatch({ type: 'ORDER_SET', value: 5 });
  store.dispatch({ type: 'ORDER_STREAK', days: 10 });
  store.dispatch({ type: 'MORALE_ALL', amount: -60 });

  const popBefore = s.citizenIds.length;
  let fired = false;
  for (let d = 0; d < 30 && !fired; d++) {
    // Advance the clock: the uprising roll is seeded on the day, so calling
    // the same day repeatedly just re-rolls the identical result.
    s.clock.day += 1;
    store.dispatchAll(orderDay(s));
    store.dispatch({ type: 'ORDER_STREAK', days: 10 });
    fired = s.log.some((l) => /rising|uprising/i.test(l.text));
  }

  if (!fired) {
    fail('no uprising in 30 days at Order 5 with the whole silo at rock bottom');
  } else {
    const dead = s.stats.causes['killed in uprising'] || 0;
    if (!dead) fail('an uprising happened and nobody died');
    else ok(`the uprising killed ${dead} of your own people`);

    const named = s.log.filter((l) => l.kind === 'death' && l.data?.cause === 'killed in uprising');
    if (!named.length) fail('uprising deaths were not named in the log');
    else {
      ok(`uprising deaths are named — e.g. "${named[0].text}"`);
    }

    const aftermath = s.log.find((l) => /shot them|no longer the mayor/i.test(l.text));
    if (!aftermath) fail('the uprising resolved with no aftermath text');
    else console.log(`      ${aftermath.text}`);

    if (s.citizenIds.length >= popBefore) fail('the uprising cost the silo nothing');
  }
}

// ---------------------------------------------------------------------------
// 4. Repair exists and works — the lever sabotage requires
// ---------------------------------------------------------------------------
{
  const { store } = silo();
  const s = store.state;
  const gen = Object.values(s.silo.rooms).find((r) => r.type === 'generator_hall');
  store.dispatch({ type: 'ROOM_PATCH', id: gen.id, patch: { condition: 28 } });
  store.dispatch({ type: 'RESOURCE_SET', values: { scrap: 900, parts: 200 } });

  const check = canRepair(s, gen.id);
  if (!check.ok) fail(`a sabotaged generator cannot be repaired even with full stores: ${check.reason}`);
  else {
    store.dispatchAll(repair(s, gen.id));
    if (s.silo.rooms[gen.id].condition < 99) {
      fail(`repair left the generator at ${s.silo.rooms[gen.id].condition}`);
    } else {
      ok(`a generator sabotaged to 28 repairs to full for ${JSON.stringify(check.cost)}`);
    }
  }

  // Partial repair must be possible when the stores are thin — otherwise a
  // poor silo watches a critical room die with no lever at all.
  store.dispatch({ type: 'ROOM_PATCH', id: gen.id, patch: { condition: 20 } });
  store.dispatch({ type: 'RESOURCE_SET', values: { scrap: 60, parts: 6 } });
  const partial = canRepair(s, gen.id);
  if (!partial.ok) {
    fail('a nearly-broke silo cannot patch a critical room at all');
  } else if (!partial.partial) {
    fail('the partial-repair path never engages');
  } else {
    const before = s.silo.rooms[gen.id].condition;
    store.dispatchAll(repair(s, gen.id));
    const after = s.silo.rooms[gen.id].condition;
    if (after <= before) fail('a partial repair restored nothing');
    else ok(`a broke silo can still patch: condition ${before} → ${Math.round(after)} for what it had`);
  }
}

console.log('');
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
console.log('  PASS — order and politics\n');
