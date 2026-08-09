/**
 * directives.js — what to do next, in one line.
 *
 * The silo has twenty-eight rooms, forty-six research nodes and nine panels,
 * and on the first morning it presents all of them at once with no indication
 * of which matters. That is the single loudest complaint from playing it: not
 * that any one system is hard, but that there is no thread.
 *
 * This is the thread. It reads the same signals a competent player reads —
 * runway in days, missing income, idle labs, worn rooms — and names the one
 * thing most worth doing, with the reason it matters. It is deliberately not
 * a quest log and not a tutorial script: it is derived from state every time
 * it is asked, so it stays true if the player ignores it, does something
 * else, or comes back after a week away.
 *
 * The voice is the same as everything else the silo writes: administrative,
 * specific, and never congratulatory.
 *
 * Pure: (state) -> directives[]. No dispatch, no DOM.
 */

import { BAL } from '../config/balance.js';
import { getRoom } from '../data/rooms.js';
import { readEnvironment } from './population.js';
import { available as availableResearch } from './research.js';
import { canBuild } from './build.js';

/**
 * @typedef {object} Directive
 * @property {string} id      stable key, so the UI can avoid re-animating
 * @property {string} text    the order itself, imperative and short
 * @property {string} why     one sentence on the consequence of ignoring it
 * @property {string} panel   which panel to open when tapped
 * @property {number} weight  higher is more urgent
 */

/** Net flow per cycle for a resource, from the economy's own bookkeeping. */
function flow(state, key) {
  const f = state.flows?.[key];
  return f ? f.in - f.out : 0;
}

/** Days of stock left at the current rate, or Infinity if it isn't falling. */
function runway(state, key) {
  const net = flow(state, key);
  if (net >= 0) return Infinity;
  return (state.resources[key] ?? 0) / (-net * BAL.time.CYCLES_PER_DAY);
}

const has = (state, type) =>
  Object.values(state.silo.rooms).some((r) => r.type === type && r.buildingUntilCycle === 0);
const count = (state, type) =>
  Object.values(state.silo.rooms).filter((r) => r.type === type).length;

/** Is there anywhere at all this room could go right now? */
function placeable(state, type) {
  for (const floor of state.silo.floors) {
    if (!floor.excavated) continue;
    for (let slot = 0; slot < BAL.silo.slotsPerFloor; slot++) {
      if (canBuild(state, floor.n, slot, type).ok) return true;
    }
  }
  return false;
}

/**
 * Every directive that currently applies, most urgent first.
 * The UI shows the top one; the panel lists the rest.
 */
export function directives(state) {
  const out = [];
  const env = readEnvironment(state);
  const add = (d) => out.push(d);

  // ---- about to kill somebody ------------------------------------------
  for (const key of ['water', 'food']) {
    const days = runway(state, key);
    if (days > BAL.alerts.runwayWarnDays) continue;
    const def = getRoom(key === 'water' ? 'water_reclaimer' : 'hydroponics');
    const whole = Math.max(0, Math.floor(days));
    add({
      id: `runway_${key}`,
      text: `Build a ${def.name}`,
      why:
        `${key === 'water' ? 'Water' : 'Food'} runs out ` +
        (whole === 0 ? 'within the day' : `in about ${whole} day${whole === 1 ? '' : 's'}`) +
        ' at the current rate.',
      panel: 'build',
      weight: 100 - days,
    });
  }

  const gen = state.power?.generation || 0;
  const demand = state.power?.demand || 0;
  if (gen > 0 && demand > gen * 0.9) {
    add({
      id: 'power',
      text: 'Build a Generator Hall',
      why: 'Demand is at the limit of generation. Past it, rooms shut down from the bottom of the priority list — including the ones people drink from.',
      panel: 'build',
      weight: 92,
    });
  }

  if (env.housingFree < 0) {
    add({
      id: 'housing',
      text: 'Build Residences',
      why: `${Math.abs(Math.round(env.housingFree))} people have nowhere to sleep. Nobody new is born while that is true.`,
      panel: 'build',
      weight: 88,
    });
  }

  if (state.air.capacity - state.air.load < 0) {
    add({
      id: 'air',
      text: 'Build Air Filtration',
      why: 'The silo is breathing more than it scrubs. Air quality falls from here, and health follows it.',
      panel: 'build',
      weight: 90,
    });
  }

  // ---- a room about to fail --------------------------------------------
  const worst = Object.values(state.silo.rooms)
    .filter((r) => r.buildingUntilCycle === 0)
    .sort((a, b) => a.condition - b.condition)[0];
  if (worst && worst.condition <= BAL.alerts.conditionWarnAt) {
    const def = getRoom(worst.type);
    add({
      id: 'repair',
      text: `Repair the ${def?.name || worst.type} on floor ${worst.floor}`,
      why:
        `It is at ${Math.round(worst.condition)} condition. A room that reaches zero stops, ` +
        'and if it is making power the rest of the silo stops with it.',
      panel: 'build',
      weight: 85 - worst.condition,
    });
  }

  // ---- the bootstrap ----------------------------------------------------
  if (flow(state, 'scrap') <= 0 && count(state, 'recycling') === 0) {
    add({
      id: 'recycling',
      text: 'Build a Recycling plant',
      why: 'The silo has no scrap income. Every room is built out of scrap, and the starting stores buy about five.',
      panel: 'build',
      weight: 80,
    });
  }
  if (flow(state, 'parts') <= 0 && count(state, 'workshop') === 0) {
    add({
      id: 'workshop',
      text: 'Build a Workshop',
      why: 'Nothing here makes parts, and every room needs them alongside scrap.',
      panel: 'build',
      weight: 78,
    });
  }
  if (count(state, 'laboratory') === 0) {
    add({
      id: 'laboratory',
      text: 'Build a Laboratory',
      why: 'Nothing else in the silo produces research points, and every deeper floor, every suit and every treaty is behind one.',
      panel: 'build',
      weight: 76,
    });
  }

  // ---- posts standing empty ---------------------------------------------
  const empty = Object.values(state.silo.rooms).filter((r) => {
    const def = getRoom(r.type);
    return def?.staff && r.staff.length === 0 && r.buildingUntilCycle === 0;
  });
  if (empty.length) {
    const def = getRoom(empty[0].type);
    add({
      id: 'staff',
      text: empty.length === 1 ? `Crew the ${def?.name || empty[0].type}` : `Crew ${empty.length} empty rooms`,
      why: 'A room with nobody in it produces nothing at all. Auto-assign on the Residents panel will fill them.',
      panel: 'population',
      weight: 74,
    });
  }

  // ---- the labs are idle -------------------------------------------------
  if (!state.research.active && has(state, 'laboratory') && availableResearch(state).length) {
    add({
      id: 'research',
      text: 'Choose a research project',
      why: `${Math.floor(state.research.points)} points are banked and nothing is being worked on.`,
      panel: 'research',
      weight: 70,
    });
  }

  // ---- reaching outward --------------------------------------------------
  const suitResearched = state.research.completed.includes('env_suit_1');
  if (suitResearched && !has(state, 'airlock') && placeable(state, 'airlock')) {
    add({
      id: 'airlock',
      text: 'Build an Airlock',
      why: 'Salvage, recruits and every artifact the research tree wants are outside. None of it is down here.',
      panel: 'build',
      weight: 60,
    });
  }
  if (suitResearched && has(state, 'airlock') && !has(state, 'suit_bay') && placeable(state, 'suit_bay')) {
    add({
      id: 'suit_bay',
      text: 'Build a Suit Bay',
      why: 'The airlock opens onto a sky that kills in under an hour. Nobody goes through it without a suit.',
      panel: 'build',
      weight: 59,
    });
  }
  if (has(state, 'suit_bay') && has(state, 'airlock') && !has(state, 'armory') && placeable(state, 'armory')) {
    add({
      id: 'armory',
      text: 'Build an Armory',
      why: 'It is the only bench that makes a weapon or a vest. A squad without either does not get sent anywhere.',
      panel: 'build',
      weight: 58,
    });
  }
  if (has(state, 'suit_bay') && has(state, 'armory') && !state.military.squadIds.length) {
    add({
      id: 'squad',
      text: 'Form a squad',
      why: 'The surface is the fastest way this silo grows, and nothing goes out until there is somebody to send.',
      panel: 'military',
      weight: 56,
    });
  }

  // ---- steady state ------------------------------------------------------
  if (!state.silo.excavating && state.resources.scrap > BAL.silo.excavation.baseScrap * 6) {
    add({
      id: 'excavate',
      text: 'Excavate the next floor',
      why: 'There is scrap spare and the silo is ninety-two floors deep. Bays are the constraint on everything else.',
      panel: 'build',
      weight: 30,
    });
  }

  // Never nothing. A silo with no problems still has a next move, and a bar
  // that empties out is a bar the player stops reading — the whole point is
  // that there is always one line worth glancing at.
  if (!out.length) {
    if (!has(state, 'radio_room') && state.research.completed.includes('radio_range_1')) {
      add({
        id: 'radio',
        text: 'Build a Radio Room',
        why: 'Nineteen other silos are out there. Silo 12 has been listening for two generations without being able to answer.',
        panel: 'build',
        weight: 20,
      });
    } else if (count(state, 'laboratory') < 3) {
      add({
        id: 'more_labs',
        text: 'Build another Laboratory',
        why: 'Research is the long pole on everything below the Mids. More benches is the only way it goes faster.',
        panel: 'build',
        weight: 15,
      });
    } else {
      add({
        id: 'steady',
        text: 'The silo is steady',
        why: 'Nothing is failing and nothing is running out. A good time to dig, or to look at what is outside.',
        panel: 'build',
        weight: 1,
      });
    }
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/** The single most important thing, or null when nothing needs doing. */
export function topDirective(state) {
  if (state.meta.gameOver) return null;
  return directives(state)[0] || null;
}

export default { directives, topDirective };
