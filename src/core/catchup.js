/**
 * catchup.js — what happened while you were gone.
 *
 * Three tiers, per spec §3.4:
 *
 *   elapsed <= 5 min          full fidelity, cycle by cycle — identical to
 *                             having watched it
 *   5 min < elapsed <= 12 h   coarse replay in one-game-day steps with
 *                             averaged production. Population events still
 *                             roll per day off the seeded RNG: people still
 *                             die, shortages still cascade.
 *   elapsed > 12 h            simulate 12 h and stop. Long absences are not
 *                             punished beyond the cap — this is a plane game.
 *
 * The output is a ReturnReport, and the report *is* the reward for coming
 * back, so it is assembled here rather than being scraped out of the log by
 * the UI: named deaths with causes, births, expeditions that came home, radio
 * traffic, and the resource swing, in the order they happened.
 */

import { BAL, TIME } from '../config/balance.js';
import { RES_KEYS } from '../sim/economy.js';
import { fullName } from '../sim/population.js';
import { unlockedIds, newlyUnlocked } from '../sim/unlocks.js';

/** Absences shorter than this don't warrant a report at all. */
const MIN_REPORTABLE_MS = 45_000;

export function classify(elapsedMs) {
  if (elapsedMs <= BAL.catchup.fullFidelityMs) return 'fine';
  if (elapsedMs <= BAL.catchup.capMs) return 'coarse';
  return 'capped';
}

/**
 * Replay the player's absence and return a ReturnReport (or null if nothing
 * worth reporting happened).
 *
 * @param {Store} store
 * @param {Game}  game
 * @param {{now?: number}} opts
 */
export function runCatchup(store, game, opts = {}) {
  const state = store.state;
  const now = opts.now ?? Date.now();
  const lastSave = state.meta.lastSaveTs || now;
  let elapsedMs = Math.max(0, now - lastSave);

  const mode = classify(elapsedMs);
  const simulatedMs = mode === 'capped' ? BAL.catchup.capMs : elapsedMs;

  if (elapsedMs < MIN_REPORTABLE_MS) {
    // Still advance the clock so a quick tab-switch doesn't lose time.
    if (simulatedMs > BAL.time.TICK_MS) replayFine(store, game, simulatedMs);
    state.meta.lastSaveTs = now;
    return null;
  }

  const before = snapshot(state);
  const logStart = state.log.length;
  const t0 = Date.now();

  // The UI is not mounted yet (or is showing the report), and a burst of a
  // thousand actions must not each trigger a repaint.
  store.runSilent(() => {
    if (mode === 'fine') replayFine(store, game, simulatedMs);
    else replayCoarse(store, game, simulatedMs);
  });

  const after = snapshot(state);
  state.meta.lastSaveTs = now;

  const report = buildReport({
    state,
    before,
    after,
    entries: state.log.slice(logStart),
    elapsedMs,
    simulatedMs,
    mode,
    computeMs: Date.now() - t0,
  });

  state.lastReport = report;
  return report;
}

/**
 * What is sitting on the player's desk when they get back.
 *
 * The report was a record of what happened and nothing else, which makes
 * coming back a thing you read rather than a thing you act on. This is the
 * other half: the decisions that were waiting the whole time you were away,
 * named, so the first thirty seconds back have somewhere to go.
 *
 * Everything here is derived from state rather than from the log, because a
 * pending decision is a fact about now, not an event that happened. Each entry
 * is one sentence and names the panel that resolves it — a list of vague
 * nudges is worse than no list.
 *
 * Deliberately conservative: only things that are genuinely actionable and
 * genuinely idle. Nagging somebody about a research slot that is already busy
 * is how a player learns to skip this section.
 */
function pendingDecisions(state) {
  const out = [];
  const push = (where, text) => out.push({ where, text });

  if (state.pendingDecon) {
    const n = state.pendingDecon.members?.length || 0;
    push('Surface', `${n} ${n === 1 ? 'person is' : 'people are'} at the airlock waiting to be hosed down.`);
  }

  if (!state.research?.active) {
    push('Research', 'The labs are idle. Nothing is being researched.');
  }

  const idleSquads = (state.military?.squadIds || []).filter((id) => {
    const sq = state.military.squads[id];
    return sq && !sq.deployed && (sq.members?.length || 0) > 0;
  }).length;
  if (idleSquads) {
    push('Squads', `${idleSquads} ${idleSquads === 1 ? 'squad is' : 'squads are'} crewed and standing in the silo.`);
  }

  const pts = state.doctrine?.points || 0;
  if (pts >= BAL.combat.commendCost) {
    push('Doctrine', `${pts} commendation${pts === 1 ? '' : 's'} unspent.`);
  }

  if (state.world?.pendingRaid) {
    push('World', 'Somebody is coming. There is a raid at the door.');
  }

  const unassigned = Object.values(state.military?.gear || {}).filter((g) => !g.assignedTo).length;
  if (unassigned >= 3) {
    push('Armory', `${unassigned} pieces of kit are on the rack and nobody is carrying them.`);
  }

  return out;
}

// ------------------------------------------------------------------ tiers ---

function replayFine(store, game, ms) {
  const cycles = Math.min(
    Math.floor(ms / (BAL.time.TICK_MS * TIME.ticksPerCycle)),
    BAL.catchup.maxFullFidelityCycles
  );
  for (let i = 0; i < cycles; i++) {
    if (store.state.meta.gameOver) break;
    game.runCycles(1);
  }
}

function replayCoarse(store, game, ms) {
  // A cycle is TICKS_PER_CYCLE real seconds, not one real minute; a game day
  // is CYCLES_PER_DAY of them, which is why this multiplies by ticksPerDay.
  const msPerGameDay = BAL.time.TICK_MS * TIME.ticksPerDay;
  const days = Math.floor(ms / msPerGameDay);
  const remainderMs = ms - days * msPerGameDay;

  for (let d = 0; d < days; d++) {
    if (store.state.meta.gameOver) break;
    game.coarseDay();
  }
  // Run the tail at full fidelity so the player resumes mid-day exactly where
  // the clock says they are, rather than on a day boundary.
  if (!store.state.meta.gameOver && remainderMs > 0) replayFine(store, game, remainderMs);
}

// ----------------------------------------------------------------- report ---

function snapshot(state) {
  const resources = {};
  for (const k of RES_KEYS) resources[k] = state.resources[k] || 0;
  return {
    day: state.clock.day,
    year: state.clock.year,
    tick: state.clock.tick,
    population: state.citizenIds.length,
    resources,
    order: state.order.value,
    air: state.air.quality,
    deaths: state.stats.deaths,
    births: state.stats.births,
    avgMorale: average(state.citizenIds.map((id) => state.citizens[id]?.morale ?? 0)),
    avgHealth: average(state.citizenIds.map((id) => state.citizens[id]?.health ?? 0)),
    // What the silo could reach. A panel opening is the single most "come and
    // look at this" thing that happens in the game, and it was invisible in
    // the report: unlocks are announced by the shell, which is not running
    // during catch-up, so they arrived as toasts *over* the report a moment
    // after it rendered — the one thing worth coming back for, delivered on
    // top of the thing telling you what you came back to.
    unlocks: unlockedIds(state),
  };
}

function buildReport({ state, before, after, entries, elapsedMs, simulatedMs, mode, computeMs }) {
  const deaths = [];
  const births = [];
  const expeditions = [];
  const radio = [];
  const alerts = [];
  const finished = [];

  // Where each log kind lands.
  //
  // This was a chain of `else if`s covering five kinds, and everything else
  // the game logs fell through it into nothing. Sixteen kinds were being
  // dropped: `unlock` and `good` (a research node done, a floor opened),
  // `warn` (a floor straining, a store running short), and thirteen more
  // including `war_declared`, `collapse`, `refugees`, `extorted` and
  // `call_to_arms`. A war could be declared on you while you were away and the
  // report would not mention it.
  //
  // A table instead of a chain, because the failure mode was structural — a
  // kind that matched no branch — and a table is something a test can check
  // for completeness. wiring.mjs §56 scans every module that logs and fails if
  // any kind it emits has no home here.
  const BUCKET = {
    death: 'deaths', birth: 'births', expedition: 'expeditions',
    radio: 'radio', diplomacy: 'radio', chatter: 'radio',
    gift: 'radio', honored: 'radio', trade_agreement: 'radio', refugees: 'radio',
    unlock: 'finished', good: 'finished',
    alert: 'alerts', rad: 'alerts', warn: 'alerts', combat: 'alerts', raid: 'alerts',
    collapse: 'alerts', broken: 'alerts', war: 'alerts', war_declared: 'alerts',
    threatened: 'alerts', extorted: 'alerts',
    call_to_arms: 'alerts', call_to_arms_pending: 'alerts',
  };
  const bins = { deaths: null, births, expeditions, radio, alerts, finished };

  for (const e of entries) {
    const bin = BUCKET[e.kind];
    if (bin === 'deaths') {
      const c = e.data?.citizenId != null ? state.citizens[e.data.citizenId] : null;
      deaths.push({
        day: e.day,
        text: e.text,
        name: c ? fullName(c) : null,
        age: c ? Math.floor(c.age) : null,
        cause: e.data?.cause || 'unknown',
      });
    } else if (bin === 'alerts') {
      alerts.push({ day: e.day, text: e.text, kind: e.kind });
    } else if (bin && bins[bin]) {
      bins[bin].push({ day: e.day, text: e.text });
    }
  }

  // Anything that opened while they were away, in the report rather than in a
  // toast behind it.
  for (const u of newlyUnlocked(before.unlocks, state)) {
    finished.push({ day: after.day, text: `${u.label} is open — a new panel on the bar at the bottom.` });
  }

  const resourceDelta = {};
  for (const k of RES_KEYS) {
    const d = after.resources[k] - before.resources[k];
    if (Math.abs(d) > 0.5) resourceDelta[k] = d;
  }

  // The causes, tallied — "four to radiation sickness" reads better than four
  // separate lines saying the same thing.
  const causeTally = {};
  for (const d of deaths) causeTally[d.cause] = (causeTally[d.cause] || 0) + 1;

  return {
    version: 1,
    generatedAt: Date.now(),
    mode,
    capped: mode === 'capped',
    elapsedMs,
    simulatedMs,
    computeMs,
    fromDay: before.day,
    toDay: after.day,
    daysElapsed: after.day - before.day,
    population: { from: before.population, to: after.population },
    order: { from: before.order, to: after.order },
    air: { from: before.air, to: after.air },
    morale: { from: before.avgMorale, to: after.avgMorale },
    health: { from: before.avgHealth, to: after.avgHealth },
    resourceDelta,
    deaths,
    births,
    expeditions,
    radio,
    alerts,
    finished,
    waiting: pendingDecisions(state),
    causeTally,
    entries: entries.map((e) => ({ day: e.day, kind: e.kind, text: e.text })),
    headline: headlineFor({ before, after, deaths, births, mode, state }),
    gameOver: state.meta.gameOver || null,
  };
}

/**
 * One sentence, in the silo's voice, that tells the player whether to be
 * relieved or worried before they read a word of the log.
 */
function headlineFor({ before, after, deaths, births, mode, state }) {
  const days = after.day - before.day;
  // Under a day, count shifts — "0 days passed" is not a sentence anybody
  // would write in a logbook.
  const shifts = Math.round((after.tick - before.tick) / TIME.ticksPerCycle);
  const dayWord =
    days > 0 ? `${days} day${days === 1 ? '' : 's'}` : `${shifts} shift${shifts === 1 ? '' : 's'}`;

  if (state.meta.gameOver) {
    return `Silo 12 did not survive your absence.`;
  }
  if (mode === 'capped') {
    return `Your silo held for twelve hours before the log runs out. ${dayWord} recorded.`;
  }
  if (deaths.length === 0 && births.length === 0) {
    return `${dayWord} passed without incident.`;
  }
  const parts = [];
  if (deaths.length) parts.push(`${deaths.length} died`);
  if (births.length) parts.push(`${births.length} born`);
  const net = after.population - before.population;
  const netStr = net === 0 ? 'no net change' : net > 0 ? `up ${net}` : `down ${-net}`;
  return `${dayWord} passed. ${parts.join(', ')} — population ${netStr}, now ${after.population}.`;
}

function average(arr) {
  if (!arr.length) return 0;
  let t = 0;
  for (const v of arr) t += v;
  return t / arr.length;
}

/** Human phrasing for how long they were away. */
export function describeAbsence(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const hours = ms / 3600000;
  if (hours < 36) {
    const h = hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export default { runCatchup, classify, describeAbsence };
