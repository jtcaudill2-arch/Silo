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
import { canBuild, canExcavate } from './build.js';
import { getResearch } from '../data/research.js';
import { canStart } from './research.js';

/**
 * @typedef {object} Directive
 * @property {string} id      stable key, so the UI can avoid re-animating
 * @property {string} text    the order itself, imperative and short
 * @property {string} why     one sentence on the consequence of ignoring it
 * @property {string} panel   which panel to open when tapped
 * @property {number} weight  higher is more urgent
 * @property {string} [room]    room type to build, when that's the action
 * @property {string} [roomId]  specific room to act on, for repairs
 */

/**
 * Priority bands. These are the whole design of this module, so they are
 * spelled out rather than scattered as literals:
 *
 *   95+   something runs out today
 *   80-95 something is trending to zero, sooner is higher
 *   76-79 no income of a resource every single room is built from
 *   70-75 rooms standing empty, which is free output being thrown away
 *   60-69 the first Laboratory, and idle labs after it
 *   50-59 the surface chain
 *   <40   growth
 *
 * The Laboratory sits below life support deliberately. It is the most
 * important building in the game and it costs 220 scrap, and an opening that
 * buys it before it has fixed a falling food line cannot then afford the
 * hydroponics bay that would have saved it. Measured: obedient players died
 * on day 24 with the lab built and the order still reading "Build a
 * Hydroponics Bay" they could not pay for.
 */
const LIFE_SUPPORT_TOP = 95;
const RUNWAY_HORIZON = 15;

/**
 * How far an order sinks when the silo cannot currently pay for it.
 *
 * A standing order you cannot carry out is worse than no order at all: it is
 * the game asking for something it will not let you do, and a player who
 * trusts it simply waits. Measured, that is fatal — the order read "Build a
 * Hydroponics Bay" for twenty consecutive days at forty scrap short while
 * eighty people died of thirst, because the water reclaimer never got a turn
 * to be suggested. An unaffordable order still appears when nothing else is
 * possible, and then its reason says what the silo is short of.
 *
 * Large enough to sink the most urgent blocked order below the cheapest
 * affordable one.
 */
const UNAFFORDABLE_PENALTY = 40;

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

/**
 * How far short of affording a room the silo is, as readable text, or null if
 * it can pay. An order you cannot carry out is worse than no order — it is the
 * game asking for something it will not let you do — so when the blocker is
 * money the line says so instead of repeating the instruction.
 */
function shortfall(state, type) {
  const def = getRoom(type);
  if (!def) return null;
  const missing = [];
  for (const [k, v] of Object.entries(def.buildCost || {})) {
    const have = state.resources[k] ?? 0;
    if (have < v) missing.push(`${Math.ceil(v - have)} ${k}`);
  }
  return missing.length ? missing.join(' and ') : null;
}

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
  // On the trend, not only on the emergency. A silo whose food is falling has
  // to start building before the tank looks alarming, because the answer costs
  // scrap it may not have yet and then takes shifts to put up. Waiting for the
  // eight-day warning and *then* ordering a bay is how an obedient player
  // starves: by the time the order arrives the treasury is empty.
  for (const key of ['water', 'food']) {
    const days = runway(state, key);
    if (days === Infinity) continue;
    const type = key === 'water' ? 'water_reclaimer' : 'hydroponics';
    const def = getRoom(type);
    const whole = Math.max(0, Math.floor(days));
    const noun = key === 'water' ? 'Water' : 'Food';
    const short = shortfall(state, type);
    const when =
      whole === 0 ? 'within the day' : `in about ${whole} day${whole === 1 ? '' : 's'}`;
    add({
      id: `runway_${key}`,
      text: `Build a ${def.name}`,
      room: type,
      why: short
        ? `${noun} runs out ${when}, and the silo is ${short} short of a ${def.name}. ` +
          'Salvage income is the real problem.'
        : `${noun} is falling — it runs out ${when} at the current rate.`,
      panel: 'build',
      weight: LIFE_SUPPORT_TOP - Math.min(days, RUNWAY_HORIZON),
    });
  }

  const gen = state.power?.generation || 0;
  const demand = state.power?.demand || 0;
  if (gen > 0 && demand > gen * 0.9) {
    add({
      id: 'power',
      text: 'Build a Generator Hall',
      room: 'generator_hall',
      why: 'Demand is at the limit of generation. Past it, rooms shut down from the bottom of the priority list — including the ones people drink from.',
      panel: 'build',
      weight: 92,
    });
  }

  if (env.housingFree < 0) {
    add({
      id: 'housing',
      text: 'Build Residences',
      room: 'residences',
      why: `${Math.abs(Math.round(env.housingFree))} people have nowhere to sleep. Nobody new is born while that is true.`,
      panel: 'build',
      weight: 88,
    });
  }

  if (state.air.capacity - state.air.load < 0) {
    add({
      id: 'air',
      text: 'Build Air Filtration',
      room: 'air_filtration',
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
      roomId: worst.id,
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
      room: 'recycling',
      why: 'The silo has no scrap income. Every room is built out of scrap, and the starting stores buy about five.',
      panel: 'build',
      weight: 79,
    });
  }
  if (flow(state, 'parts') <= 0 && count(state, 'workshop') === 0) {
    add({
      id: 'workshop',
      text: 'Build a Workshop',
      room: 'workshop',
      why: 'Nothing here makes parts, and every room needs them alongside scrap.',
      panel: 'build',
      weight: 77,
    });
  }
  if (count(state, 'laboratory') === 0) {
    add({
      id: 'laboratory',
      text: 'Build a Laboratory',
      room: 'laboratory',
      why: 'Nothing else in the silo produces research points, and every deeper floor, every suit and every treaty is behind one. It costs 220 scrap, so it waits until nothing is running out.',
      panel: 'build',
      weight: 65,
    });
  }

  // ---- the silo cannot afford its own advice -----------------------------
  // Income, not any single building, is what makes an opening solvable. A
  // silo with one recycling plant and two hundred people is permanently four
  // hundred scrap short of everything, and every order it receives bounces:
  // measured, forty consecutive days of "Build a Laboratory" at a treasury
  // that never cleared two hundred, while the reclaimers it also could not
  // afford let a hundred and eighty people die of thirst. Repairs are priced
  // in scrap too, so a worn silo with thin income spirals.
  const pop = Math.max(1, state.citizenIds.length);
  const wantScrap = (BAL.alerts.scrapPerCyclePerHundred * pop) / 100;
  const wantParts = (BAL.alerts.partsPerCyclePerHundred * pop) / 100;
  if (count(state, 'recycling') > 0 && flow(state, 'scrap') < wantScrap) {
    add({
      id: 'scrap_income',
      text: 'Build another Recycling plant',
      room: 'recycling',
      why:
        `Salvage is running at ${flow(state, 'scrap').toFixed(1)} a shift for ${pop} people. ` +
        'Everything — rooms, repairs, digging — is bought with scrap, and at this rate the silo cannot afford any of it.',
      panel: 'build',
      weight: 75,
    });
  }
  if (count(state, 'workshop') > 0 && flow(state, 'parts') < wantParts) {
    add({
      id: 'parts_income',
      text: 'Build another Workshop',
      room: 'workshop',
      why: `Parts are running at ${flow(state, 'parts').toFixed(1)} a shift. Every room needs them alongside scrap.`,
      panel: 'build',
      weight: 74,
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
      weight: 72,
    });
  }

  // ---- the labs are idle -------------------------------------------------
  if (!state.research.active && has(state, 'laboratory') && availableResearch(state).length) {
    add({
      id: 'research',
      text: 'Choose a research project',
      why: `${Math.floor(state.research.points)} points are banked and nothing is being worked on.`,
      panel: 'research',
      weight: 62,
    });
  }

  // ---- reaching outward --------------------------------------------------
  const suitResearched = state.research.completed.includes('env_suit_1');
  if (suitResearched && !has(state, 'airlock') && placeable(state, 'airlock')) {
    add({
      id: 'airlock',
      text: 'Build an Airlock',
      room: 'airlock',
      why: 'Salvage, recruits and every artifact the research tree wants are outside. None of it is down here.',
      panel: 'build',
      weight: 55,
    });
  }
  if (suitResearched && has(state, 'airlock') && !has(state, 'suit_bay') && placeable(state, 'suit_bay')) {
    add({
      id: 'suit_bay',
      text: 'Build a Suit Bay',
      room: 'suit_bay',
      why: 'The airlock opens onto a sky that kills in under an hour. Nobody goes through it without a suit.',
      panel: 'build',
      weight: 54,
    });
  }
  if (has(state, 'suit_bay') && has(state, 'airlock') && !has(state, 'armory') && placeable(state, 'armory')) {
    add({
      id: 'armory',
      text: 'Build an Armory',
      room: 'armory',
      why: 'It is the only bench that makes a weapon or a vest. A squad without either does not get sent anywhere.',
      panel: 'build',
      weight: 53,
    });
  }
  if (has(state, 'suit_bay') && has(state, 'armory') && !state.military.squadIds.length) {
    add({
      id: 'squad',
      text: 'Form a squad',
      why: 'The surface is the fastest way this silo grows, and nothing goes out until there is somebody to send.',
      panel: 'military',
      weight: 52,
    });
  }

  // ---- steady state ------------------------------------------------------
  // Ask the excavator, rather than guessing from the treasury. The next floor
  // down is often behind a research gate, and an order to dig it is an order
  // that cannot be followed until that node lands — measured at 136 days of
  // "Excavate the next floor" against a tier that needed Deep Excavation I.
  if (!state.silo.excavating) {
    const dig = canExcavate(state);
    if (dig.ok) {
      add({
        id: 'excavate',
        text: 'Excavate the next floor',
        why: 'There is scrap spare and the silo is ninety-two floors deep. Bays are the constraint on everything else.',
        panel: 'build',
        weight: 30,
      });
    } else if (dig.needsResearch && !state.research.active && canStart(state, dig.needsResearch).ok) {
      // Only while the labs are idle. Telling somebody to research a node the
      // benches are already busy above is an order they cannot follow without
      // throwing away the work in progress.
      const node = getResearch(dig.needsResearch);
      add({
        id: 'dig_research',
        text: `Research ${node?.name || dig.needsResearch}`,
        why: `${dig.reason} Everything below the current tier is behind it.`,
        panel: 'research',
        weight: 32,
        research: dig.needsResearch,
      });
    }
  }

  // Never nothing. A silo with no problems still has a next move, and a bar
  // that empties out is a bar the player stops reading — the whole point is
  // that there is always one line worth glancing at.
  if (!out.length) {
    if (!has(state, 'radio_room') && state.research.completed.includes('radio_range_1')) {
      add({
        id: 'radio',
        text: 'Build a Radio Room',
        room: 'radio_room',
        why: 'Nineteen other silos are out there. Silo 12 has been listening for two generations without being able to answer.',
        panel: 'build',
        weight: 20,
      });
    } else if (count(state, 'laboratory') < 3) {
      add({
        id: 'more_labs',
        text: 'Build another Laboratory',
        room: 'laboratory',
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

  // Rank by what can actually be done now. An order the silo cannot pay for
  // keeps its urgency in the text but yields the top slot to anything it can.
  for (const d of out) {
    if (!d.room) continue;
    const short = shortfall(state, d.room);
    if (!short) continue;
    d.blocked = short;
    d.weight -= UNAFFORDABLE_PENALTY;
    if (!/short/.test(d.why)) {
      d.why = `${d.why} The silo is ${short} short of one.`;
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
