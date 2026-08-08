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
  // One real minute is one cycle; one game day is CYCLES_PER_DAY of them.
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
  };
}

function buildReport({ state, before, after, entries, elapsedMs, simulatedMs, mode, computeMs }) {
  const deaths = [];
  const births = [];
  const expeditions = [];
  const radio = [];
  const alerts = [];

  for (const e of entries) {
    if (e.kind === 'death') {
      const c = e.data?.citizenId != null ? state.citizens[e.data.citizenId] : null;
      deaths.push({
        day: e.day,
        text: e.text,
        name: c ? fullName(c) : null,
        age: c ? Math.floor(c.age) : null,
        cause: e.data?.cause || 'unknown',
      });
    } else if (e.kind === 'birth') births.push({ day: e.day, text: e.text });
    else if (e.kind === 'expedition') expeditions.push({ day: e.day, text: e.text });
    else if (e.kind === 'radio' || e.kind === 'diplomacy') radio.push({ day: e.day, text: e.text });
    else if (e.kind === 'alert' || e.kind === 'rad') alerts.push({ day: e.day, text: e.text, kind: e.kind });
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
