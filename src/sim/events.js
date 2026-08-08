/**
 * events.js — scripted crises, flavour, and the endings.
 *
 * Crises fire on elapsed *real* time, not on game days and not on dice
 * (spec §16). That's the point: pacing that depends on chance isn't pacing.
 * A player two hours in gets the blight whether or not the RNG felt like it;
 * what varies is how ready they were for it.
 */

import { BAL } from '../config/balance.js';
import { streamFor } from '../core/rng.js';
import { CRISIS_LIST, CRISES, FLAVOUR, ENDINGS } from '../data/events.js';

/** Crises whose time has come and which haven't fired yet. */
export function dueCrises(state) {
  const minutes = state.meta.playedMs / 60000;
  return CRISIS_LIST.filter((c) => {
    if (state.flags.crises[c.id]) return false;
    if (minutes < c.atMinutes) return false;
    if (c.requires && !c.requires(state)) return false;
    return true;
  });
}

/** Fire any due crisis. At most one a day, so two never land together. */
export function simulateDay(state) {
  const actions = [];

  const due = dueCrises(state);
  if (due.length) {
    const crisis = due[0];
    actions.push({ type: 'FLAG_SET', flags: { crises: { ...state.flags.crises, [crisis.id]: state.clock.day } } });
    actions.push({
      type: 'LOG',
      entry: { kind: 'alert', text: `${crisis.headline}. ${crisis.text}` },
    });
    actions.push(...(crisis.resolve ? crisis.resolve(state) : []));
    if (crisis.advice) {
      actions.push({ type: 'LOG', entry: { kind: 'plain', text: crisis.advice } });
    }
    actions.push({ type: 'CRISIS_ALERT', id: crisis.id, name: crisis.name });
    return actions; // a crisis day gets the day to itself
  }

  actions.push(...rollFlavour(state));
  actions.push(...checkEndings(state));
  return actions;
}

function rollFlavour(state) {
  const rng = streamFor(state.meta.seed, 'flavour', state.clock.day);
  if (!rng.chance(BAL.pacing.flavourChancePerDay)) return [];

  const pool = FLAVOUR.filter((e) => !e.requires || e.requires(state));
  const event = rng.weighted(pool, (e) => e.weight);
  if (!event) return [];

  return [
    { type: 'LOG', entry: { kind: event.kind || 'plain', text: event.text } },
    ...(event.effects ? event.effects(state) : []),
  ];
}

// ---------------------------------------------------------------- endings ---

export function checkEndings(state) {
  if (state.meta.ending || state.meta.gameOver) return [];
  for (const ending of ENDINGS) {
    if (!ending.check(state)) continue;
    return [
      {
        type: 'GAME_OVER',
        reason: 'ending',
        ending: ending.id,
        text: `${ending.name}. ${ending.text}`,
      },
    ];
  }
  return [];
}

/** Progress toward each ending, for the log panel. Never a spoiler. */
export function endingProgress(state) {
  const allies = Object.values(state.world.silos).filter((x) =>
    (x.treaties || []).some((t) => t.kind === 'alliance')
  ).length;
  const hasRecord = state.research.completed.includes('origin_record');

  return [
    {
      id: 'compact',
      name: 'The Compact',
      detail: `${allies}/${BAL.endings.compactAlliesRequired} alliances, the Registry's trust, and the Origin Record.`,
      progress: Math.min(1, allies / BAL.endings.compactAlliesRequired) * (hasRecord ? 1 : 0.6),
    },
    {
      id: 'dominion',
      name: 'Dominion',
      detail: `${state.world.satellites.length}/${BAL.endings.dominionSilosRequired} silos held, and the Record taken.`,
      progress:
        Math.min(1, state.world.satellites.length / BAL.endings.dominionSilosRequired) *
        (hasRecord ? 1 : 0.6),
    },
    {
      id: 'surface',
      name: 'Surface',
      detail: 'Tier-four suits, the Origin Record, and somebody standing in the Scar.',
      progress:
        ((state.research.completed.includes('env_suit_4') ? 1 : 0) +
          (hasRecord ? 1 : 0) +
          ((state.map.discovered || []).includes('scar') ? 1 : 0)) /
        3,
    },
  ];
}

export { CRISES, ENDINGS };
export default { simulateDay, dueCrises, checkEndings, endingProgress };
