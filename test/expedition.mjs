#!/usr/bin/env node
/**
 * expedition.mjs — the Phase 5 gate.
 *
 * The claim that has to hold (spec §3.4): an expedition resolves identically
 * whether the player watched it, fast-forwarded past it, or was asleep. If
 * that isn't true, catch-up is a lie and the game is save-scummable.
 *
 * Also checks the things a combat log has to do to earn auto-resolve its
 * keep: name people, explain what happened, and never report a death without
 * both.
 *
 * Run: node test/expedition.mjs
 */

import { createStore, Store } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import { build, upgrade, canUpgrade, allPlacements } from '../src/sim/build.js';
import { inService } from '../src/sim/economy.js';
import { craft, formSquad, equipBest, readiness } from '../src/sim/military.js';
import { launch, canLaunch, resolveExpedition, riskPreview, airlockCapacity } from '../src/sim/expedition.js';
import { resolve as resolveCombat, rollEnemyForce, unitPower } from '../src/sim/combat.js';
import { getEnemy, RAIDERS, MUTANTS } from '../src/data/encounters.js';
import { streamFor } from '../src/core/rng.js';
import { fullName } from '../src/sim/population.js';
import { BAL } from '../src/config/balance.js';

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

const SEED = 0xc0ffee;
const T0 = 1_700_000_000_000;

registerCoreReducers();

/**
 * A silo that can actually mount an expedition: airlock, suit bay, armory,
 * the research to use them, and a squad of eight kitted out.
 */
function expeditionarySilo(seed = SEED) {
  const store = new Store(createNewGame({ seed, scenario: 'sufficient', now: T0 }));
  store.silent = true;
  const game = new Game(store);
  const s = store.state;

  for (const id of ['env_suit_1', 'env_suit_2', 'alloy_refining', 'firearms_1', 'firearms_2', 'ballistic_armor_1', 'decon_protocols']) {
    store.dispatch({ type: 'RESEARCH_COMPLETE', id });
  }
  store.dispatch({ type: 'RESOURCE_SET', values: { scrap: 900, alloy: 300, parts: 300, ammo: 600, meds: 200, filters: 250 } });

  // Staff before running any cycles: unstaffed generators produce no power,
  // and an unpowered airlock is not an airlock.
  store.dispatchAll(autoAssign(s));
  // A silo that is ready to open its airlock has been digging for a while.
  // The opening now starts at six excavated floors and grows by excavation, so
  // the fixture has to stand somewhere that reflects the stage it is testing
  // rather than inheriting the first morning's silo.
  for (const f of s.silo.floors.slice(0, 12)) f.excavated = true;

  // Ask the game where these can go rather than naming a floor. This said
  // floor 14 three times, which was the bottom of the silo when fourteen
  // floors came pre-excavated; the opening now starts at six and digs, so a
  // hardcoded floor is a floor that does not exist yet.
  // USE THE DOOR THE SILO ALREADY HAS. This built an Airlock, a Suit Bay and
  // an Armory unconditionally, on the reasonable assumption that a silo does
  // not start with them — and since the pivot the control scenario stands on
  // floors 1 to 9, and floor 6 is the Gate Level: it arrives with an Airlock
  // and a Suit Bay already in it. So the fixture put up a SECOND airlock and
  // then upgraded whichever one `find` happened to return first, which was the
  // one on floor 6. The squad met "The Airlock can decontaminate 4 at a time.
  // Bell is 8 strong" for the rest of the run.
  const standing = (type) => Object.values(s.silo.rooms).find((r) => r.type === type && inService(r));
  for (const type of ['airlock', 'suit_bay', 'armory']) {
    if (standing(type)) continue;
    const spot = allPlacements(s, type)[0];
    if (!spot) throw new Error(`expedition fixture: nowhere to build a ${type}`);
    store.dispatchAll(build(s, spot.floor, spot.slot, type));
  }
  game.runCycles(20); // finish construction
  store.dispatchAll(autoAssign(s)); // crew the new rooms
  // A level-1 Airlock decontaminates four at a time; an eight-strong squad
  // needs it upgraded. That gate is the design, not an obstacle to route past
  // — so the fixture pays it, on the door the silo actually leaves through,
  // and keeps paying until the door is wide enough rather than assuming one
  // rank does it.
  for (let rank = 0; rank < BAL.silo.upgrade.maxLevel; rank++) {
    const door = standing('airlock');
    if (!door || airlockCapacity(s) >= 8) break;
    const check = canUpgrade(s, door.id);
    if (!check.ok) break;
    store.dispatchAll(upgrade(s, door.id));
    game.runCycles(BAL.silo.upgrade.downtimeCycles + 2);
    store.dispatchAll(autoAssign(s));
  }
  game.runCycles(2); // let the power state settle

  // Kit: eight of each, so a full squad can go out properly equipped.
  for (let i = 0; i < 8; i++) {
    store.dispatchAll(craft(s, 'suit_2'));
    store.dispatchAll(craft(s, 'service_rifle'));
    store.dispatchAll(craft(s, 'plate_harness'));
  }

  store.dispatchAll(formSquad(s, 'Bell'));
  const squadId = s.military.squadIds[0];
  // The eight best fighters who aren't children.
  const pool = s.citizenIds
    .map((id) => s.citizens[id])
    .filter((c) => c.age >= 18 && c.age < 50)
    .sort((a, b) => (b.skills.combat || 0) - (a.skills.combat || 0))
    .slice(0, 8);
  for (const c of pool) {
    store.dispatch({ type: 'SQUAD_MEMBER', squadId, citizenId: c.id });
    store.dispatchAll(equipBest(s, c.id));
  }
  return { store, game, squadId };
}

// ---------------------------------------------------------------------------
// 1. Launch preconditions are enforced, and explained
// ---------------------------------------------------------------------------
{
  const { store, squadId } = expeditionarySilo();
  const s = store.state;

  if (airlockCapacity(s) <= 0) fail('the airlock reports no decontamination capacity');

  const nearOk = canLaunch(s, squadId, 'near');
  if (!nearOk.ok) fail(`a kitted squad cannot launch a near run: ${nearOk.reason}`);
  else ok(`a kitted squad can launch: ${nearOk.members.length} out, supplies ${JSON.stringify(nearOk.cost)}`);

  // Tier-2 suits must not be allowed into the deep waste.
  const deepBlocked = canLaunch(s, squadId, 'deep');
  if (deepBlocked.ok) fail('tier-2 suits were allowed into the deep waste');
  else if (!/tier-3/.test(deepBlocked.reason)) fail(`suit gate reason is unclear: "${deepBlocked.reason}"`);
  else ok(`suit tier gates the range: "${deepBlocked.reason}"`);

  // Starving the supplies must block it, with a reason naming the shortage.
  store.dispatch({ type: 'RESOURCE_SET', values: { food: 0 } });
  const noFood = canLaunch(s, squadId, 'near');
  if (noFood.ok) fail('an unsupplied squad was allowed out');
  else if (!/food/.test(noFood.reason)) fail(`supply gate reason is unclear: "${noFood.reason}"`);
  else ok('an unsupplied squad is stopped, and told what it is short of');
}

// ---------------------------------------------------------------------------
// 2. THE DETERMINISM GATE
// ---------------------------------------------------------------------------
{
  // Two identical silos. One watches the expedition play out day by day; the
  // other jumps straight to the return day and resolves it in one step.
  const watched = expeditionarySilo();
  const skipped = expeditionarySilo();

  store2Launch(watched, 'mid');
  store2Launch(skipped, 'mid');

  const band = BAL.expedition.bands.find((b) => b.key === 'mid');

  // (a) run it day by day, the way a player at the screen would
  watched.game.runDays(band.travelDays + 1);

  // (b) jump the clock and resolve once, the way catch-up does
  const exp = skipped.store.state.expeditions.active[0];
  if (!exp) {
    fail('the launch produced no expedition — check canLaunch');
    console.log('      canLaunch says: ' +
      JSON.stringify(canLaunch(skipped.store.state, skipped.squadId, 'mid')));
  }
  if (exp) {
  skipped.store.state.clock.day = exp.returnDay;
  const res = resolveExpedition(skipped.store.state, exp);
  skipped.store.dispatchAll(res.actions);

  }
  const a = watched.store.state.expeditions.history[0];
  const b = skipped.store.state.expeditions.history[0];

  if (!a || !b) {
    fail('an expedition never resolved at all');
  } else {
    const sameSurvivors =
      JSON.stringify([...a.survivors].sort()) === JSON.stringify([...b.survivors].sort());
    const sameCasualties =
      JSON.stringify([...a.casualties].sort()) === JSON.stringify([...b.casualties].sort());
    const sameJournal = JSON.stringify(a.journal) === JSON.stringify(b.journal);

    if (!sameSurvivors || !sameCasualties) {
      fail(
        `expedition outcome differs between watching and skipping:\n` +
          `      watched: ${a.survivors.length} back, ${a.casualties.length} lost\n` +
          `      skipped: ${b.survivors.length} back, ${b.casualties.length} lost`
      );
    } else if (!sameJournal) {
      fail('the expedition journal differs between watching and skipping');
    } else {
      ok(
        `an expedition resolves identically watched or skipped ` +
          `(${a.survivors.length} back, ${a.casualties.length} lost, ${a.journal.length} journal lines)`
      );
    }

    // And what they brought home must match — this is the save-scum surface.
    // Compare the expedition's own haul, not the silo total: the watched run
    // also ran several days of ordinary economy alongside.
    const haulA = JSON.stringify(watched.loot ?? {});
    const haulB = JSON.stringify(skipped.loot ?? {});
    if (haulA !== haulB) {
      fail(`recovered loot differs between watched and skipped runs:\n      ${haulA}\n      ${haulB}`);
    } else {
      const summary = Object.entries(watched.loot ?? {}).map(([k, v]) => `${v} ${k}`).join(', ');
      ok(`recovered loot is identical either way (${summary || 'nothing'}) — it cannot be re-rolled`);
    }
  }
}

function store2Launch(run, band) {
  const { store } = run;
  const s = store.state;
  store.dispatch({ type: 'RESOURCE_SET', values: { food: 900, water: 800, meds: 200, ammo: 600 } });
  // Record the haul as it lands, so the two runs can be compared directly.
  const original = store.dispatch.bind(store);
  store.dispatch = (a) => {
    if (a?.type === 'EXPEDITION_RESOLVE') run.loot = { ...(a.loot || {}), ...(a.artifacts || {}) };
    return original(a);
  };
  store.dispatchAll(launch(s, s.military.squadIds[0], band));
}

// ---------------------------------------------------------------------------
// 3. The combat log has to be worth reading
// ---------------------------------------------------------------------------
{
  const { store, squadId } = expeditionarySilo();
  const s = store.state;
  const members = s.military.squads[squadId].members;

  let namedDeathLines = 0;
  let deaths = 0;
  const samples = [];

  for (const def of [...RAIDERS, ...MUTANTS]) {
    const rng = streamFor(SEED, 'test-combat', def.id);
    const enemy = rollEnemyForce(rng, def, { bandIndex: 2, dayIndex: 200 });
    const res = resolveCombat(s, members, enemy, { battleId: `test:${def.id}`, leaderId: members[0] });

    if (res.log.length < 4) fail(`combat with ${def.name} produced only ${res.log.length} log lines`);
    if (res.log.length > 8) fail(`combat with ${def.name} produced ${res.log.length} log lines — too long to read`);
    if (!Number.isFinite(res.ratio)) fail(`combat with ${def.name} produced a non-finite ratio`);
    if (!res.outcome) fail(`combat with ${def.name} produced no outcome`);

    for (const id of res.casualties) {
      deaths++;
      const c = s.citizens[id];
      if (res.log.some((l) => l.includes(fullName(c)))) namedDeathLines++;
    }
    samples.push({ name: enemy.displayName, outcome: res.outcome.name, ratio: res.ratio, log: res.log });
  }

  if (deaths > 0 && namedDeathLines < deaths) {
    fail(`${deaths - namedDeathLines} of ${deaths} combat deaths were never named in the log`);
  } else if (deaths > 0) {
    ok(`every one of ${deaths} combat deaths is named in the log`);
  }
  ok(`all ${samples.length} enemy types resolve with a readable log`);

  // Show one, so a human can judge whether it reads.
  const shown = samples.find((x) => x.log.length >= 6) || samples[0];
  console.log(`\n      — ${shown.name}: ${shown.outcome} (ratio ${shown.ratio.toFixed(2)}) —`);
  for (const line of shown.log) console.log(`      ${line}`);
  console.log('');

  // Mutation escalation: the same enemy must get worse over the campaign.
  const early = [];
  const late = [];
  for (let i = 0; i < 40; i++) {
    early.push(rollEnemyForce(streamFor(SEED, 'esc-e', i), getEnemy('rippers'), { bandIndex: 1, dayIndex: 5 }).level);
    late.push(rollEnemyForce(streamFor(SEED, 'esc-l', i), getEnemy('rippers'), { bandIndex: 1, dayIndex: 500 }).level);
  }
  const avgEarly = early.reduce((a, b) => a + b) / early.length;
  const avgLate = late.reduce((a, b) => a + b) / late.length;
  if (avgLate <= avgEarly) {
    fail(`the wasteland does not get worse over time (mutation ${avgEarly.toFixed(2)} → ${avgLate.toFixed(2)})`);
  } else {
    ok(`the wasteland escalates: mutation level ${avgEarly.toFixed(2)} on day 5 → ${avgLate.toFixed(2)} on day 500`);
  }

  // A Hulk must be near-immune to tier-2 weapons.
  const hulkRng = streamFor(SEED, 'hulk', 1);
  const hulk = rollEnemyForce(hulkRng, getEnemy('hulks'), { bandIndex: 2, dayIndex: 100 });
  const vsHulk = resolveCombat(s, members, hulk, { battleId: 'test:hulk' });
  if (!vsHulk.log.some((l) => /tier-3|go through it/i.test(l))) {
    fail('a tier-2 squad fought a Hulk with no mention of being unable to hurt it');
  } else {
    ok('a Hulk is immune to sub-tier-3 weapons, and the log says so');
  }
}

// ---------------------------------------------------------------------------
// 4. Risk is shown as a range, never a single number
// ---------------------------------------------------------------------------
{
  const { store, squadId } = expeditionarySilo();
  const preview = riskPreview(store.state, squadId, 'mid');
  if (!preview) {
    fail('no risk preview for a valid squad');
  } else {
    const [lo, hi] = preview.ratioRange;
    if (!(hi > lo)) fail(`risk preview is a point estimate, not a range (${lo} .. ${hi})`);
    else if (!preview.verdict || preview.verdict.length < 15) fail('risk preview has no plain-language verdict');
    else {
      ok(
        `risk shown as a range: ${lo.toFixed(2)}–${hi.toFixed(2)}, ` +
          `readiness ${Math.round(preview.readiness * 100)}% — "${preview.verdict}"`
      );
    }
    if (!preview.radRange || preview.radRange[1] <= preview.radRange[0]) {
      fail('radiation exposure is not shown as a range either');
    }
  }
}

// ---------------------------------------------------------------------------
// 5. A full run through the game loop, end to end
// ---------------------------------------------------------------------------
{
  const { store, game, squadId } = expeditionarySilo();
  const s = store.state;
  store.dispatch({ type: 'RESOURCE_SET', values: { food: 900, water: 800 } });

  const popBefore = s.citizenIds.length;
  const scrapBefore = s.resources.scrap;
  store.dispatchAll(launch(s, squadId, 'near'));

  if (!s.expeditions.active.length) fail('launch produced no active expedition');
  const away = s.citizenIds.filter((id) => s.citizens[id].status === 'expedition').length;
  if (away !== 8) fail(`${away} citizens are marked as outside, expected 8`);

  game.runDays(3);

  if (s.expeditions.active.length) fail('the expedition never came home');
  else {
    const hist = s.expeditions.history[0];
    // Guarded, because this section used to CRASH rather than fail when the
    // fixture could not get a squad out of the door — and a crash here takes
    // every section below it with it, so one broken fixture read as a whole
    // suite of silence. A missing history entry is a failure like any other.
    if (!hist) fail('the run came home but wrote no history entry');
    else ok(
      `a near run went out and came back: ${hist.survivors.length} home, ` +
        `${hist.casualties.length} lost, ${Math.round(s.resources.scrap - scrapBefore)} net scrap`
    );
    if (s.citizenIds.some((id) => s.citizens[id].status === 'expedition')) {
      fail('somebody is still flagged as being outside after the squad returned');
    }
    if (!s.pendingDecon) fail('no decontamination was queued on return');
    else {
      // Decon must actually remove the dose.
      const before = s.pendingDecon.members.map((id) => s.citizens[id].radiation);
      store.dispatch({ type: 'DECON', members: s.pendingDecon.members });
      const after = s.pendingDecon === null
        ? before.map((_, i) => s.citizens[hist.survivors[i]]?.radiation ?? 0)
        : [];
      const totalBefore = before.reduce((a, b) => a + b, 0);
      const totalAfter = after.reduce((a, b) => a + b, 0);
      if (totalBefore > 0 && totalAfter >= totalBefore) fail('decontamination removed no radiation');
      else ok(`decontamination cut the squad's dose ${totalBefore.toFixed(0)} → ${totalAfter.toFixed(0)}`);
    }
    if (s.citizenIds.length < popBefore - 8) fail('the silo lost more people than went out');
  }

  // Nothing anywhere may be non-finite after all that.
  const bad = [];
  (function scan(o, path = '', seen = new Set()) {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof v === 'number' && !Number.isFinite(v) && !/^caps\./.test(p)) bad.push(`${p}=${v}`);
      else if (typeof v === 'object') scan(v, p, seen);
    }
  })(s);
  if (bad.length) fail(`non-finite state after an expedition: ${bad.slice(0, 6).join(', ')}`);
  if (store.unknownActionTypes.size) {
    fail(`actions with no reducer: ${[...store.unknownActionTypes].join(', ')}`);
  }
}

console.log('');
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
console.log('  PASS — military and expeditions\n');
