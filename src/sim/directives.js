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
import { canBuild, canExcavate, canRepair } from './build.js';
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
// A life-support surplus thinner than this fraction of current draw is treated
// as a problem you can still build your way out of, rather than one you can't.
const THIN_MARGIN = 0.35;
// Above the "no income" band (76–79) — running out of food outranks being
// poor — and below a line that is already falling (80–95).
const MARGIN_TOP = 79;

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

/** "a Generator Hall" / "an Airlock", for naming a room mid-sentence. */
const aOrAn = (name) => `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;

/**
 * How far short of affording a room the silo is, as readable text, or null if
 * it can pay. An order you cannot carry out is worse than no order — it is the
 * game asking for something it will not let you do — so when the blocker is
 * money the line says so instead of repeating the instruction.
 */
function shortOf(state, cost) {
  const missing = [];
  for (const [k, v] of Object.entries(cost || {})) {
    if (k === 'labor') continue;
    const have = state.resources[k] ?? 0;
    if (have < v) missing.push(`${Math.ceil(v - have)} ${k}`);
  }
  return missing.length ? missing.join(' and ') : null;
}

function shortfall(state, type) {
  const def = getRoom(type);
  if (!def) return null;
  return shortOf(state, def.buildCost);
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

  // ---- about to *start* killing somebody --------------------------------
  // The block above only speaks once net flow has gone negative, which for a
  // growing silo is already too late. A bay produces a fixed amount and people
  // eat per head, so food sits comfortably positive right up until the
  // population crosses what one bay can carry and then flips — with the tank
  // still full, so the runway reads as years and nothing sounds urgent until
  // the tank drains. Obedient players starved through that gap: they were told
  // to build a fourth Laboratory on day 15 and never told to build a second
  // hydroponics at all.
  //
  // So watch the *margin*, not the level: when a bay's surplus falls under a
  // third of what the silo is already drawing, the next dozen births eat it.
  for (const key of ['water', 'food']) {
    if (runway(state, key) !== Infinity) continue; // already falling — handled above
    const f = state.flows?.[key];
    const draw = f?.out ?? 0;
    if (draw <= 0) continue;
    const margin = (f.in - draw) / draw;
    if (margin >= THIN_MARGIN) continue;
    const type = key === 'water' ? 'water_reclaimer' : 'hydroponics';
    const def = getRoom(type);
    const noun = key === 'water' ? 'Water' : 'Food';
    add({
      id: `margin_${key}`,
      text: `Build another ${def.name}`,
      room: type,
      why:
        `${noun} production is only ${Math.round(margin * 100)}% ahead of what the silo drinks. ` +
        'A bay makes a fixed amount and people eat per head, so the next few births take it negative.',
      panel: 'build',
      weight: MARGIN_TOP - Math.round(margin * 10),
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

  // Housing and air both derive from air.capacity, which the economy fills in
  // on its first cycle. Asked before that has ever run — the instant a new
  // game is created, which is exactly when the shell first paints — capacity
  // reads zero and every resident appears to be sleeping in a corridor. Wait
  // for the silo to have taken one breath before saying anything about it.
  const measured = state.air.capacity > 0;

  if (measured && env.housingFree < 0) {
    add({
      id: 'housing',
      text: 'Build Residences',
      room: 'residences',
      why: `${Math.abs(Math.round(env.housingFree))} people have nowhere to sleep. Nobody new is born while that is true.`,
      panel: 'build',
      weight: 88,
    });
  }

  if (measured && state.air.capacity - state.air.load < 0) {
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
      // Above the income orders (75), not below them. Salvage throughput can
      // always be argued to be a little short, so a first Laboratory ranked
      // under it never comes up at all: an obedient silo ran 200 days and 46
      // rooms and never researched anything, because "build another Recycling
      // plant" was always one place higher. Ranking it above is safe because
      // an unaffordable order is demoted by UNAFFORDABLE_PENALTY anyway — so a
      // silo too poor for a Laboratory still gets told to fix its income
      // first, and a silo that can pay for one is told to go and do it.
      text: 'Build a Laboratory',
      room: 'laboratory',
      why: 'Nothing else in the silo produces research points, and every deeper floor, every suit and every treaty is behind one. It costs 220 scrap, so it waits until nothing is running out.',
      panel: 'build',
      weight: 76,
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
  // A floor plus a per-head rate: room prices are flat, so a small silo needs
  // roughly as much income as a large one before it can afford anything.
  const wantScrap = BAL.alerts.scrapBasePerCycle + (BAL.alerts.scrapPerCyclePerHundred * pop) / 100;
  const wantParts = BAL.alerts.partsBasePerCycle + (BAL.alerts.partsPerCyclePerHundred * pop) / 100;
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
      // Which room, not just how many. An order that names a place can be
      // pointed at one: the shell puts the floor on the bar and takes the
      // cross-section there. "Crew 4 empty rooms" with no floor on it is a
      // search task, and the silo is ninety-two floors deep.
      roomId: empty[0].id,
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
        wait: true,
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

  // If the best remaining order is still one the silo cannot pay for, saying
  // it again tomorrow is not advice. An obedient player was told to build a
  // Generator Hall on 36 separate days and could never once afford it, while
  // the thing that would have made it affordable was never mentioned — the
  // income orders sit at 75 and go quiet the moment throughput is nominally
  // adequate, which it can be while the treasury is still empty.
  //
  // So when the top order is blocked on money, and there is somewhere to put a
  // salvage plant the silo *can* pay for today, that becomes the order. Guarded
  // on affordability and placement, because swapping one impossible instruction
  // for another is the same failure wearing a different hat.
  const best = out.reduce((a, b) => (b.weight > (a?.weight ?? -Infinity) ? b : a), null);
  if (best?.blocked && /scrap/.test(best.blocked)) {
    const canSalvage =
      count(state, 'recycling') > 0 && !shortfall(state, 'recycling') && placeable(state, 'recycling');
    if (canSalvage) {
      // Promote rather than add — the income order is usually already in the
      // list, sitting at 75 and demoted for being unaffordable itself.
      const existing = out.find((d) => d.id === 'scrap_income');
      const why =
        `The silo is ${best.blocked} short of what it most needs — ${best.text.toLowerCase()} — ` +
        'and salvage is the only thing that closes that gap. A plant it can afford today buys the one it cannot.';
      if (existing) {
        existing.weight = best.weight + 1;
        existing.blocked = null;
        existing.why = why;
      } else {
        add({
          id: 'scrap_income',
          text: 'Build another Recycling plant',
          room: 'recycling',
          why,
          panel: 'build',
          weight: best.weight + 1,
        });
      }
    } else {
      // Nothing affordable would improve income either: the silo is simply
      // poor, and the honest order is to save up. Say that, with the number
      // and how long it will take, instead of repeating an instruction it
      // cannot follow — that repetition was the standing order on 36 days out
      // of 200 in a silo that was otherwise doing fine.
      const income = flow(state, 'scrap');
      const need = Math.max(0, (getRoom(best.room)?.buildCost?.scrap ?? 0) - (state.resources.scrap ?? 0));
      const days = income > 0 ? Math.ceil(need / (income * BAL.time.CYCLES_PER_DAY)) : null;
      add({
        id: 'hold_for_scrap',
        // Deliberately carries no room: obeying this order means doing
        // nothing today, and anything that reads directives — the panel, the
        // obedient-player test — needs to be able to tell "wait" apart from
        // "we have no advice".
        wait: true,
        text: `Save up for ${aOrAn(best.text.replace(/^Build (a|an|another) /, ''))}`,
        why:
          `${best.why} Salvage is running at ${income.toFixed(1)} a shift, so the silo is ` +
          (days === null
            ? 'not earning anything towards it — nothing is being salvaged at all.'
            : `about ${days} day${days === 1 ? '' : 's'} away from affording it. Nothing else needs doing first.`),
        panel: 'build',
        weight: best.weight + 1,
      });
    }
  }

  // A repair the silo cannot pay for at all says so, but keeps its rank.
  //
  // Deliberately after the ranking above and deliberately without the
  // unaffordable penalty. `blocked` is read by the UI to replace the do-it
  // button with the shortfall, and that is all it is doing here: repairs are
  // priced off the room, partial repairs are allowed, and a repair only fails
  // outright when the silo cannot afford a single point of condition. Sinking
  // it 40 places would also feed it to the hold-for-scrap branch above, which
  // is written for "Build a …" orders and would produce "Save up for a Repair
  // the Generator Hall on floor 4".
  for (const d of out) {
    if (d.id !== 'repair' || !d.roomId) continue;
    const check = canRepair(state, d.roomId);
    if (!check.ok && check.cost) d.blocked = shortOf(state, check.cost);
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/** The single most important thing, or null when nothing needs doing. */
export function topDirective(state) {
  if (state.meta.gameOver) return null;
  return directives(state)[0] || null;
}

export default { directives, topDirective };
