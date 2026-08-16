/**
 * directives.js — what to do next, in one line.
 *
 * The silo has twenty-nine rooms, forty-eight research nodes and nine panels,
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
import { NODE_LIST as DOCTRINE_NODES } from '../data/doctrine.js';
import { canTake as canTakeDoctrine } from './doctrine.js';
import { available as availableResearch } from './research.js';
import {
  canBuild, canExcavate, nextFloorToExcavate, canRepair, canShore, canUpgrade, upgradeCost, strainedFloors,
  buildCostFor, describeCost, affordable,
} from './build.js';
import { staffSlots, inService, roomCapability } from './economy.js';
import { readySquads } from './military.js';
import { canLaunch } from './expedition.js';
import { canLaunchRun, breachPierce } from './conquest.js';
import { raiderBandFor, defenders as raidDefenders, forecast as raidForecast } from './raid.js';
import { employableCitizens, openSlots, reassignmentAvailable } from './jobs.js';
import { getResearch } from '../data/research.js';
import { canStart, isComplete } from './research.js';

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
 * Priority bands. These are the whole design of this module, so each order
 * carries its own rank beside the sentence it decides, rather than being
 * looked up somewhere else:
 *
 *   97    somebody is at the airlock and there is one day to answer
 *   88-95 a hard stop already reached — no generation headroom, no coolant,
 *         more breath than scrubbers, nowhere to sleep — or a floor that is
 *         about to come down (88 minus its integrity)
 *   50-95 something is trending to zero, sooner is higher: see `runwayWeight`,
 *         which starts at 95 the day it empties and falls to 50 past a season
 *   85-   a room about to fail, 85 minus its condition
 *   76-79 no income at all of a resource every single room is built from,
 *         with the first Laboratory at the bottom of the band
 *   74-79 income of one that exists but is running short — a base of 75 for
 *         scrap and 74 for parts, plus up to `incomeUrgencyRange` (4) as the
 *         flow falls toward nothing. The guard is `flow < want`, so the
 *         urgency term is always above zero and the true floor is just over
 *         74. This row read "74-75" until the arithmetic was checked; it
 *         deliberately overlaps the band above, because a Workshop running at
 *         a tenth of what the silo needs is worth more than a resource that
 *         merely has no source yet
 *   72    rooms standing empty, which is free output being thrown away
 *   62    a Laboratory with nothing on the bench
 *   51-55 the surface chain, and the munitions line at the end of it
 *   40    a seized room waiting to be restored
 *   <40   growth: digging, the radio, more benches
 *
 * The Laboratory sits below life support deliberately. It is the most
 * important building in the game and it costs 220 scrap, and an opening that
 * buys it before it has fixed a falling food line cannot then afford the
 * hydroponics bay that would have saved it. Measured: obedient players died
 * on day 24 with the lab built and the order still reading "Build a
 * Hydroponics Bay" they could not pay for.
 *
 * Everything shared between orders — the top of the life-support band, how
 * urgency decays with runway, the unaffordable penalty, the horizon a savings
 * plan has to finish inside — is in `BAL.directives`, with the measurements
 * that set it.
 */
const D = BAL.directives;

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

/**
 * How urgent a falling resource is, from its runway in days.
 *
 * Two segments, joined at `runwayHorizonDays` so the curve is continuous: the
 * near one is the old `lifeSupportTop - days` untouched, the far one keeps
 * falling to `runwayFloor` instead of clamping. The clamp was the bug — a
 * 424-day leak and a 15-day one both scored 80, and 80 outranks the first
 * Laboratory for ever. See `BAL.directives` for the numbers and the crossover.
 */
function runwayWeight(days) {
  if (days <= D.runwayHorizonDays) return D.lifeSupportTop - days;
  const shoulder = D.lifeSupportTop - D.runwayHorizonDays;
  const along = Math.min(1, (days - D.runwayHorizonDays) / (D.runwayTailDays - D.runwayHorizonDays));
  return shoulder - (shoulder - D.runwayFloor) * along;
}

// Both skip seized rooms. "Does the silo have one of these" has to mean one it
// can use: the found Workshop on floor 45 standing dark otherwise answers yes
// and the order to build a working one never comes.
const has = (state, type) =>
  Object.values(state.silo.rooms).some(
    (r) => r.type === type && r.buildingUntilCycle === 0 && inService(r)
  );
const count = (state, type) =>
  Object.values(state.silo.rooms).filter((r) => r.type === type && inService(r)).length;

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

/** Every resource the silo is short of for this room, and by how much. */
function gaps(state, type) {
  const out = [];
  for (const [k, v] of Object.entries(getRoom(type)?.buildCost || {})) {
    if (k === 'labor') continue;
    const need = v - (state.resources[k] ?? 0);
    if (need > 0) out.push({ key: k, need });
  }
  return out;
}

/**
 * Days until the silo can pay for this room at the income it actually has, or
 * null if something it is short of is not coming in at all — saving for a
 * resource with no source is not a plan, it is a wait with no end.
 *
 * The slowest of the shortfalls decides it, not the largest: a room is bought
 * when the last of its costs is met.
 */
function daysToAfford(state, type) {
  let worst = 0;
  for (const { key, need } of gaps(state, type)) {
    const income = flow(state, key);
    if (income <= 0) return null;
    worst = Math.max(worst, need / (income * BAL.time.CYCLES_PER_DAY));
  }
  return worst;
}

/** Which shortfall is furthest off — the one saving up is really waiting on. */
function scarcest(state, type) {
  let key = 'scrap';
  let worst = -Infinity;
  for (const g of gaps(state, type)) {
    const income = flow(state, g.key);
    const days = income > 0 ? g.need / (income * BAL.time.CYCLES_PER_DAY) : Infinity;
    if (days > worst) {
      worst = days;
      key = g.key;
    }
  }
  return key;
}

/**
 * The room that would fix a shortfall of `key`, if the silo can put one up
 * today, or null. Guarded on affordability and on placement, because swapping
 * one impossible instruction for another is the same failure wearing a
 * different hat.
 *
 * Scrap, parts, coolant, ammunition and alloy — every shortfall a room can
 * answer.
 *
 * Alloy was left out on the grounds that it is a research problem, the Foundry
 * being behind a node. That is true right up until the silo has one, and
 * `incomeRelief` already refuses to name a room the silo has never built, so
 * the guard was always there. What the omission actually cost: 193 of the
 * first 300 days unable to afford the sixteen alloy a Munitions line costs,
 * while holding 4,699 scrap and 1,884 parts. A Foundry turns three scrap into
 * one alloy, so the silo was not short of the material — it was short of
 * furnaces, and nothing ever said so.
 *
 * Coolant is here because it stopped being a surface problem. This comment
 * used to say it was one, and it was wrong: the deep band loots nothing to
 * twenty a haul, the scar ten to forty-five, and a crewed Reactor burns about
 * twenty-seven a day — so no amount of walking outside ever kept one lit. The Heat Exchange makes it out
 * of mined ore, so a silo staring at an idle Reactor now gets told the room
 * that fixes it instead of being told to wait.
 */
const RELIEF = {
  scrap: { id: 'scrap_income', room: 'recycling', noun: 'salvage' },
  parts: { id: 'parts_income', room: 'workshop', noun: 'parts work' },
  coolant: { id: 'coolant_income', room: 'heat_exchange', noun: 'coolant' },
  ammo: { id: 'ammo_income', room: 'munitions', noun: 'ammunition' },
  alloy: { id: 'alloy_income', room: 'foundry', noun: 'smelting' },
};

function incomeRelief(state, key) {
  const r = RELIEF[key];
  if (!r) return null;
  if (count(state, r.room) === 0) return null;
  if (shortfall(state, r.room)) return null;
  if (!placeable(state, r.room)) return null;
  return r;
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
/** Every line of a cost, twice over. See the `upgrade` order's surplus test. */
function doubled(cost) {
  const out = {};
  for (const [k, v] of Object.entries(cost || {})) out[k] = v * 2;
  return out;
}

/**
 * Where a room type sits in the silo's own idea of what matters, which is the
 * crewing order. Types nobody listed fall in behind the ones that were.
 */
function staffingRank(type) {
  const i = BAL.jobs.staffingPriority.indexOf(type);
  return i < 0 ? BAL.jobs.staffingPriority.length : i;
}

export function directives(state) {
  const out = [];
  const env = readEnvironment(state);

  // ---- how many hands are free -------------------------------------------
  //
  // Nothing built and uncrewed does anything. A room with nobody in it produces
  // nothing, draws a quarter of its power anyway, and wears out on the same
  // schedule as one that is working — so an order to build a room the silo
  // cannot staff makes every figure on the strip worse, and it does not go
  // away once obeyed, because the thing that would satisfy it is a person and
  // the order asked for a room.
  //
  // That is the same fault as the treadmill at the bottom of this file wearing
  // a different hat, and it is what the treadmill was hiding. Measured on an
  // obedient silo at three actions a day: by day 130 it had thirty-three rooms,
  // sixty-five residents, seventeen posts standing empty with nobody free to
  // fill them, and a standing order that spent the next forty days asking for
  // more hydroponics bays and more reclaimers — each one another five or six
  // power of draw against a plant already short, none of them producing a
  // thing. It suffocated on day 181.
  //
  // So every order below that asks for a room somebody has to stand in is
  // conditional on there being people unassigned to crew it. When there are
  // not, the orders that remain are the ones that are actually worth a shift:
  // repairs, housing, a research project, digging. That is also what makes
  // obedience converge — each order carried out is one that can be finished,
  // and carrying one out spends the hands that would have let the next one be
  // issued, so the list shortens as the player works down it.
  //
  // Half the posts, not all of them. Output scales with the fraction of a room
  // that is crewed, so a bay at half crew is half a bay and worth having, while
  // a bay at no crew is a hole in the power budget. Asking for the full
  // complement is how this gate first went wrong: it left a silo with two spare
  // hands, a full treasury and every single order filtered out.
  //
  // And some rooms are exempt entirely, because what they give the silo does
  // not come out of the crew. Usually that is a *ceiling*, and a ceiling still
  // stands with nobody under it: bunks are bunks whether the lights are on or
  // not (population.js counts housing regardless), a depot raises the stockpile
  // cap out of its own walls, and economy.js pays an uncrewed filtration bay
  // 55% of its air capacity — which matters more than it sounds, because air
  // capacity is the hard ceiling on population and population is what the silo
  // is short of. Gating filtration on spare hands is a deadlock with the key
  // locked inside it: no air, so no births, so no hands, so no air.
  //
  // The Schoolhouse reaches the same exemption by a different road and it is
  // worth saying which, because the first attempt at it was wrong. School is
  // not a ceiling; it is simply not staffed. Nothing about it reads a roster —
  // `manageSchool` asks whether a room providing school is `powered` — so the
  // room now carries no slots at all (see data/rooms.js) and `crewed` clears it
  // on `!def.staff` before this list is consulted. Exempting it *here* while it
  // still had slots was the wrong fix and it killed a silo: the order started
  // firing at silos with no spare hands, `autoAssign` put two of them in a room
  // that produces nothing, and seed 42 starved on day 283 with its hydroponics
  // dark. An order to build a room the silo cannot staff is exactly what this
  // gate is for; the answer was to stop the room needing staff.
  const spare = employableCitizens(state).filter((c) => !c.job).length;
  const PASSIVE = ['airCapacity', 'housing', 'depot', 'cap'];
  const crewed = (type) => {
    const def = getRoom(type);
    if (!def?.staff) return true;
    if (PASSIVE.some((k) => def.provides?.[k])) return true;
    return spare * 2 >= (def.staff.slotsPerLevel[0] || 1) * (def.width || 1);
  };

  // The same question asked backwards: is the silo getting anything out of the
  // ones it has already got? An "n+1th" order is a bet that the nth is
  // producing, and when it is not — dark below the cut line, or half-crewed —
  // the bet is lost before it is placed and the order comes back tomorrow
  // unchanged. It is how a browned-out silo ends up with five Workshops making
  // the parts of one: the parts income the order is watching never rises,
  // because the workshops it keeps buying are switched off. Measured at eight
  // actions a day, that is exactly what it built, twenty of its thirty-nine
  // working hands standing in workshops with the lights out and the Laboratory
  // dark behind them.
  //
  // The first of a kind is always allowed — there is nothing to be running yet
  // — and the bar is finished-and-lit rather than fully crewed, because the
  // crew half of the question is what `crewed` above already answers. It also
  // covers the case that used to produce three Generator Halls in three
  // consecutive shifts: one still in the bay is not a running one.
  //
  // Seized rooms are excluded, and leaving them in was the worst bug this pass
  // produced. A found room is created dark and the economy never recomputes
  // `powered` for it, so `running()` was false for ever — and `add()` drops an
  // order silently when it is, with no `blocked` and nothing on the bar. Open
  // floor 103 and "Build a Generator Hall", the highest-weighted build order in
  // the game, simply stops existing. Eight room types have a named level and
  // were all affected: the power order, the scrap, parts and alloy reliefs, the
  // bootstrap and the housing order.
  const running = (type) => {
    const rooms = Object.values(state.silo.rooms).filter((r) => r.type === type && inService(r));
    if (!rooms.length) return true;
    return rooms.every((r) => r.buildingUntilCycle === 0 && r.powered);
  };

  /**
   * Where the silo would get one of these.
   *
   * SILO 12 IS INHERITED, NOT BUILT. There is no construction: every level was
   * fitted out by the builders and is standing behind its seal, dark. So an
   * order that used to read "Build a Laboratory" has two possible answers now,
   * and which one it is depends only on what the silo can already reach —
   * either there is a dead Laboratory on a level that is open, in which case
   * restoring it is the move, or there is not, in which case the move is to go
   * further down.
   *
   * Cheapest first among rooms of the SAME type, because a Laboratory at 30%
   * and one at 8% are the same order at very different prices and the player is
   * being told what to do next, not what to aspire to. Across types the caller
   * decides — see `restorable` further down, which does not take the cheapest
   * room in the silo for exactly the reason a measured run showed: the cheapest
   * thing behind any seal is a Storage Depot, and a silo that spends its whole
   * opening treasury restoring cupboards is dead in six weeks.
   */
  const sourceFor = (type) => {
    const derelict = Object.values(state.silo.rooms)
      .filter((r) => r.type === type && r.found && r.buildingUntilCycle === 0)
      .map((r) => ({ room: r, check: canRepair(state, r.id) }))
      .filter((c) => c.check.ok)
      .sort((a, b) => (a.check.cost.scrap || 0) - (b.check.cost.scrap || 0))[0];
    if (derelict) return { kind: 'restore', room: derelict.room, cost: derelict.check.cost };
    return { kind: 'open' };
  };

  /**
   * One interception point, so every order in this file keeps its own weight,
   * its own reason and its own place in the ranking, and only its VERB changes.
   *
   * The alternative was rewriting twenty-two call sites into restore-or-open
   * pairs, which would have been forty-four things to keep in step with each
   * other and with the balance band they sit in. The reason an order fires is
   * unchanged by the silo no longer having a build menu; only the answer is.
   */
  const add = (d) => {
    if (!d.room) { out.push(d); return; }
    if (!crewed(d.room) || !running(d.room)) return;
    const def = getRoom(d.room);
    const src = sourceFor(d.room);
    if (src.kind === 'restore') {
      out.push({
        ...d,
        room: null,
        roomId: src.room.id,
        text: `Restore the ${def?.name || d.room} on floor ${src.room.floor}`,
        why: `${d.why} One is standing on floor ${src.room.floor} at ${Math.round(src.room.condition)}% ` +
          `and has never run — putting it back into service costs ${describeCost(src.cost)}.`,
      });
      return;
    }
    // Nowhere open has one, so the answer is depth. Not "open floor 12 where
    // the Laboratory is" — a seal is only ever broken on the next level down,
    // so an order naming a floor the silo cannot reach yet is an order nobody
    // can follow. The reason it wants one rides along instead.
    const next = nextFloorToExcavate(state);
    if (next == null || !canExcavate(state).ok) return;
    out.push({
      ...d,
      room: null,
      id: `${d.id}_open`,
      floor: next,
      text: `Open floor ${next}`,
      why: `${d.why} Nothing standing on an open level is a ${def?.name || d.room}, and the silo ` +
        'cannot build one — every level below is furnished and sealed, so the way to one is down.',
      panel: 'build',
    });
  };

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
      weight: runwayWeight(days),
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
    if (margin >= D.thinMargin) continue;
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
      weight: D.marginTop - Math.round(margin * 10),
    });
  }

  // ---- the lights ---------------------------------------------------------
  //
  // Demand here is the silo's whole draw, not the part of it that got served
  // (economy.js, POWER_STATE) — a brownout that is 200 short has to read as 200
  // short or the order it produces is sized against the wrong number.
  //
  // And it is guarded on the plant being crewed, which is the difference
  // between an order that converges and one that cannot. Another hall raises
  // what the silo *could* generate; it does nothing at all for a plant that is
  // short of people rather than short of halls, and a hall with nobody in it
  // generates zero, which leaves the shortfall exactly where it was and the
  // order exactly where it was. Measured, obeying that: nineteen generator
  // halls by day 200 at eight actions a day — seventy-six posts of generation
  // in a silo of ninety-six people — none of them properly crewed, dead of
  // thirst at 0 power with 617 fuel in the tanks.
  //
  // A hall still under construction counts as uncrewed, which is deliberate:
  // it is what stops three being ordered in a row while the first is in the
  // bay. When the plant is short-handed the order that matters is `staff`, at
  // 72, and it names the hall.
  const gen = state.power?.generation || 0;
  const demand = state.power?.demand || 0;
  let genPosts = 0;
  let genCrew = 0;
  for (const room of Object.values(state.silo.rooms)) {
    const def = getRoom(room.type);
    // Seized halls are not part of the plant. This census is the gate on the
    // whole order, and fixing `running()` above without fixing it here left
    // the reported bug exactly where it was: a found Generator Hall on floor
    // 103 is level 2 and three wide, so it contributes nine posts and no crew,
    // `genCrew >= genPosts` is false for ever, and "Build a Generator Hall" —
    // weight 92, the highest build order in the game — silently stops being
    // offered the moment the floor is opened.
    if (!def?.produces?.power || !def.staff || !inService(room)) continue;
    genPosts += staffSlots(def, room);
    genCrew += room.staff.filter((cid) => cid != null && state.citizens[cid]?.status !== 'dead').length;
  }
  if (gen > 0 && demand > gen * 0.9 && genCrew >= genPosts) {
    add({
      id: 'power',
      text: 'Build a Generator Hall',
      room: 'generator_hall',
      why: 'Demand is at the limit of generation. Past it, rooms shut down from the bottom of the priority list — including the ones people drink from.',
      panel: 'build',
      weight: 92,
    });
  }

  // When there is nobody to put in another hall, the plant it has is the only
  // plant it is going to get.
  //
  // OUTSIDE the census gate above, and that is the whole point of it. `power`
  // is guarded on `genCrew >= genPosts` because another hall does nothing for a
  // plant short of people rather than short of halls — correct, for building.
  // For a RANK it is exactly backwards: a step that opens no new posts is the
  // one move that makes the crew already standing there produce more, so a
  // short-handed plant is precisely when it is worth ordering.
  //
  // Measured on the 200-day obedient run before this existed. From day 60 the
  // silo sat at 69 to 88 generated against 98 to 105 wanted, with thirteen
  // posts across three halls, ten people in them, and ZERO idle working-age
  // residents. So the census gated `power` out, `staff` at 72 had nobody to
  // post, `crewed()` would have dropped the build order anyway, and
  // `research_stalled` at 62 took the bar — a hold — on 109 of the 200 days.
  // The silo was told its labs were dark and given nothing whatever to do
  // about it, for half a campaign. That is the sharpest form of "it feels like
  // a sit and wait game" the measurements found.
  //
  // A rank is the move that fits, and it fits exactly: `staffSlotsPerLevel` is
  // [1, 1, 2, 2, 3], so a hall going from rank 1 to 2 or from 3 to 4 opens no
  // new posts at all and makes 35% more power out of the same people. Only
  // those steps are offered — a step wanting two more bodies is the same order
  // the silo already cannot follow.
  //
  // On a real shortfall rather than on the 90% warning `power` takes. A hall
  // has to be ordered before the lights go because it takes shifts to build;
  // this is the substitute for an order that cannot be followed at all, so it
  // waits until rooms are actually being shed.
  if (gen > 0 && demand > gen && !crewed('generator_hall')) {
    const slots = BAL.silo.upgrade.staffSlotsPerLevel;
    const hall = Object.values(state.silo.rooms)
      .filter((r) => {
        const def = getRoom(r.type);
        if (!def?.produces?.power || !def.staff || !inService(r)) return false;
        if ((slots[r.level] || 1) > (slots[r.level - 1] || 1)) return false;
        return canUpgrade(state, r.id).ok;
      })
      .sort((a, b) => a.level - b.level || b.width - a.width)[0];
    if (hall) {
      const per = BAL.silo.upgrade.outputPerLevel;
      const lift = Math.round((per / (1 + per * (hall.level - 1))) * 100);
      add({
        id: 'power_rank',
        text: `Upgrade the Generator Hall on floor ${hall.floor}`,
        roomId: hall.id,
        why:
          `Demand is ${Math.round(demand)} against ${Math.round(gen)} generated, and there is ` +
          `nobody spare to stand in another hall. Rank ${hall.level + 1} opens no new posts and ` +
          `makes about ${lift}% more power out of the same crew, for ${describeCost(upgradeCost(hall))}.`,
        panel: 'build',
        // Below `power` at 92 and below the failing-room band at 85, because it
        // is a SMALLER answer to the same problem: a hall is a hall and a rank
        // is 35% of one. Above `research_stalled` at 62, which is the hold it
        // exists to break.
        weight: 70,
      });
    }
  }

  // ---- a Reactor with nothing to cool it ---------------------------------
  //
  // Said loudly, because the loss is enormous and completely silent. A Reactor
  // is 1,500 research points, two artifacts and 900 scrap, and it makes four
  // Generator Halls' worth of power — but economy.js scales a room's output by
  // its worst-supplied input, so a Reactor with no coolant is a fully crewed,
  // fully powered, dark room. Nothing else in the game wants coolant and,
  // until the Heat Exchange, nothing made any: measured, a campaign ran its
  // Reactor at capability 3.7 and near-zero output for 830 of 900 days and was
  // never once told why.
  if (has(state, 'reactor') && count(state, 'heat_exchange') === 0) {
    add({
      id: 'coolant_plant',
      text: 'Build a Heat Exchange',
      room: 'heat_exchange',
      why:
        'The Reactor burns coolant and nothing in the silo makes any. Until something does, it runs at ' +
        'almost nothing however well it is crewed.',
      panel: 'build',
      weight: 91,
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

  // ---- somebody is at the door -------------------------------------------
  //
  // The one order that outranks a resource running out today, and the only one
  // with a deadline the player cannot move.
  //
  // `world.pendingRaid` carries `strength`, which decides the whole fight —
  // which of the four bands turns up, and therefore whether four people with
  // pipe guns are a garrison or a funeral. For the whole of this feature's
  // life that number was rendered nowhere: `grep -rn pendingRaid src/ui/`
  // returned nothing. The player got a transient toast reading "Raiders at the
  // airlock" and had to decide, blind, whether to spend the day arming people.
  // A warning that carries no information is not a warning, and a grace day
  // nobody can act on is theatre — which is what a design review measured it
  // as: 16 of 20 raids met by a standing squad, and lost, because the squad
  // that was standing was the wrong size for the band that came.
  //
  // So the band is named, the defenders are counted, and the two cases read
  // differently. Ranked above life support deliberately: a shortage is a curve
  // and this is a cliff with a date on it.
  if (state.world.pendingRaid) {
    const raid = state.world.pendingRaid;
    const from = state.world.silos[raid.siloId]?.name || 'Somebody';
    const band = raiderBandFor(raid.strength);
    const held = raidDefenders(state).length;
    const daysLeft = Math.max(0, raid.day + BAL.raid.graceDays - state.clock.day);
    const when = daysLeft <= 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
    // The band names are a mix: "Scrappers" and "Dust Runners" are plural,
    // "The Slag Crews" carries its own article, and "Warband" is a bare
    // singular. Lowercasing all four produced "has warband at the door".
    const party = /^the /i.test(band.name) || /s$/.test(band.name) ? band.name : aOrAn(band.name);
    add({
      id: 'raid',
      text: held ? `Hold the airlock — ${band.name}` : `Get somebody on the airlock — ${band.name}`,
      // The odds, not just the head count. "4 people are standing to meet
      // them" reads as sufficiency, and against a Warband four defenders win
      // 3 of 40. See `forecast` in sim/raid.js.
      why: held
        ? `${from} has ${party} at the door, arriving ${when}. ` +
          `${held} ${held === 1 ? 'person is' : 'people are'} standing to meet them. ` +
          `${raidForecast(state, raid.strength).verdict} ${band.desc}`
        : `${from} has ${party} at the door, arriving ${when}, and nobody is standing there. ` +
          `Without a squad they take a third of everything portable and kill whoever is nearest. ${band.desc}`,
      panel: 'military',
      weight: BAL.directives.raidTop,
    });
  }

  // ---- a holding about to throw you out ----------------------------------
  //
  // `conqueredStartOrder` is 62 and derived: (62 - 20) / 1.4 is exactly
  // `holdGarrisonDays`, so an ungarrisoned holding slides for a month rather
  // than falling off a cliff. That was careful, and the player could not see
  // a second of it. Nothing in src/ui or src/render draws a satellite's
  // order, there was no directive, and the first word you got was the revolt
  // itself: "has thrown out your garrison. Everything you spent taking it is
  // gone." Measured: 37 days, 30 days, 144 days. A countdown nobody can see
  // is a cliff with extra steps.
  //
  // Below life support and below the raid, deliberately. Losing a holding is
  // expensive and it is not fatal, and an order about a silo six days' walk
  // away must not outrank the scrubbers.
  {
    const Q = BAL.conquest;
    const sats = state.world.satellites || [];
    const failing = sats
      .map((sat) => ({
        sat,
        silo: state.world.silos[sat.siloId],
        days: Math.ceil((sat.order - Q.revoltOrderThreshold) / Math.abs(Q.satelliteDecayPerDay)),
      }))
      .filter((x) => x.silo && x.sat.order < D.satelliteWarnOrder)
      .sort((a, b) => a.days - b.days)[0];

    if (failing) {
      const when = failing.days <= 1 ? 'tomorrow' : `in about ${failing.days} days`;
      add({
        id: 'satellite_order',
        text: `Garrison ${failing.silo.name}`,
        why:
          `${failing.silo.name} is at ${Math.round(failing.sat.order)} order and sliding. ` +
          `Without a squad standing on it, it throws your garrison out ${when} and everything ` +
          'spent taking it is gone.',
        panel: 'military',
        weight: D.satelliteTop,
      });
    }
  }

  // ---- a room about to fail --------------------------------------------
  //
  // A room the silo has never crewed is excluded, however bad its number is.
  // The found levels arrive at ten to twenty-six condition, which reads to a
  // straight worst-first sort exactly like a generator hall about to die — so
  // opening floor 24 put "Repair The Works" at the top of the standing orders
  // and an obedient silo spent 74 scrap and 6 parts restoring a maintenance
  // bay it had no crew for and no need of. Measured on the level table of the
  // day: it cost the campaign five research nodes and every expedition it
  // would otherwise have run. Getting crewed makes a found
  // room ordinary again, and so does a full repair.
  // Not `inService`: this is a looser question than the imported one, and
  // naming it the same shadowed the import for the rest of the function.
  const notAnEmergency = (r) => !(r.found && (r.staff?.length || 0) === 0);
  const worst = Object.values(state.silo.rooms)
    .filter((r) => r.buildingUntilCycle === 0 && notAnEmergency(r))
    .sort((a, b) => a.condition - b.condition)[0];
  if (worst && worst.condition <= BAL.alerts.conditionWarnAt) {
    const def = getRoom(worst.type);
    // What the wear is actually costing, which is not the same for every room.
    //
    // This ranked every room by condition alone and said the same sentence
    // about all of them: "a room that reaches zero stops, and if it is making
    // power the rest of the silo stops with it". Measured over ten 400-day
    // campaigns, the room it named was unstaffed on 75 of the 76 days it fired,
    // and 54 of those were the Airlock — a room with no crew, making nothing,
    // being described as though the lights depended on it. It named the same
    // room for up to fourteen days running.
    //
    // A room nobody is standing in has already stopped; its decay costs the
    // silo nothing today and something the day it is needed. So it is still
    // worth saying and it is not worth saying loudly, and the sentence changes
    // to the true one.
    const idle = def?.staff && (worst.staff?.length || 0) === 0;
    add({
      id: 'repair',
      text: `Repair the ${def?.name || worst.type} on floor ${worst.floor}`,
      roomId: worst.id,
      why: idle
        ? `It is at ${Math.round(worst.condition)} condition and nobody is posted to it, so the ` +
          'wear is costing nothing today. It will cost the day the silo needs the room and finds ' +
          'it has rotted through.'
        : `It is at ${Math.round(worst.condition)} condition. A room that reaches zero stops, ` +
          'and if it is making power the rest of the silo stops with it.',
      panel: 'build',
      // The weight is condition alone, still. Scaling it down for an idle room
      // was the obvious next move and was measured: it changed nothing at all,
      // because on the days this order is top the directive list is nearly
      // empty and there is nothing for a lower weight to lose to. A knob that
      // moves no number is a knob that reads as a fix and is not one.
      weight: 85 - worst.condition,
    });
  }

  // ---- a floor the rock is taking back -----------------------------------
  //
  // Ranked on how far gone it is, the same way a failing room is, and for the
  // same reason: a floor at fifty is worth doing before the next dig, and one
  // at five is worth doing before almost anything. It is the more expensive
  // failure of the two — a collapse breaches every room on the level and can
  // kill the shift standing in them — so it tops out slightly above a repair.
  // Hoisted, because the research order further down has to know about it: the
  // node that fixes this is one the labs must choose, and the only place the
  // silo ever chooses a node on its own is the idle-labs order.
  let alloyStarved = false;
  const worstFloor = strainedFloors(state)[0];
  if (worstFloor) {
    // Shoring is the one bill a silo cannot stop paying: every floor below
    // `shoringRequiredBelowFloor` decays whether or not anybody is on it, and
    // the fix costs alloy. Alloy has exactly one tap — the Foundry, behind
    // Alloy Refining — so a silo that dug past the line without either is on a
    // clock it cannot read, and this order is the only thing it ever hears.
    //
    // Measured across twelve 600-day runs of a player doing exactly what the
    // silo says: five of them spent between 19 and 200 days being told to shore
    // a floor they could not afford, and on none of those days did anything
    // name alloy, the Foundry, or the node it is behind.
    //
    // Said here rather than as an order of its own, and that is the whole
    // lesson of the first attempt. A separate "Research Alloy Refining" order
    // has to wait for the benches to be free and a "Build a Foundry" order for
    // the room to be placeable, and measured against the same runs those two
    // together fired on 2 days out of 196. This sentence is on screen every one
    // of those days, because the order it is attached to is already the top of
    // the list — an unfollowable order at least becomes a legible one.
    const shoreCheck = canShore(state, worstFloor.n);
    alloyStarved = !shoreCheck.ok && /alloy/i.test(shoreCheck.reason || '') &&
      flow(state, 'alloy') <= 0 && count(state, 'foundry') === 0;
    const gate = getRoom('foundry')?.unlock;
    const alloyWhy = !alloyStarved ? ''
      : ' Shoring it takes alloy the silo has none of and no way to make: a Foundry is the only ' +
        `thing that makes any, and it is behind ${getResearch(gate)?.name || gate}.`;
    add({
      id: 'shore',
      text: `Shore floor ${worstFloor.n}`,
      floor: worstFloor.n,
      why:
        `The shoring is down to ${Math.round(worstFloor.integrity)} and the floor is carrying ` +
        `${worstFloor.load} bays. At zero it comes down: every room on it is wrecked and some of ` +
        'the crew do not get out.' + alloyWhy,
      panel: 'build',
      weight: BAL.directives.shoreTop - worstFloor.integrity,
    });

  }

  // ---- a level that came with something in it ----------------------------
  //
  // The other half of the split above. This is never urgent — nothing breaks
  // if it is ignored — but it is usually the best value on the board, so it
  // sits above digging and below anything the silo actually needs today.
  // Cheapest first, because an order the silo can finish is worth more than a
  // better one it can only stare at.
  // Only offered when the silo can finish it today. A repair pays for whatever
  // it can afford and stops, which is right for a generator dying at eleven
  // condition and wrong here: a silo drip-feeding scrap into a found room
  // held this order at the top of the list for day after day, spent the
  // actions it had on it, and pushed Env-Suit I — and with it the whole
  // surface half of the game — nine days past where it belongs. A found room
  // is a purchase. If it cannot be bought outright it is not yet advice, and
  // the log already said the room is down there.
  const restorable = Object.values(state.silo.rooms)
    .filter((r) => r.found && (r.staff?.length || 0) === 0 && r.buildingUntilCycle === 0)
    .map((r) => ({ room: r, check: canRepair(state, r.id) }))
    .filter((c) => c.check.ok && !c.check.partial)
    // What the silo needs most, not what is cheapest. Cheapest picks a Storage
    // Depot every time — it is the smallest room in the game and one stands on
    // most levels — and measured on the opening that is exactly what happened:
    // the silo restored a cupboard on day 2, was down to 17 scrap on day 3, and
    // starved on day 41. `staffingPriority` is the silo's own answer to which
    // rooms matter, and it already governs who gets crewed first.
    .sort((a, b) => staffingRank(a.room.type) - staffingRank(b.room.type)
      || (a.check.cost.scrap || 0) - (b.check.cost.scrap || 0))[0];
  if (restorable) {
    const r = restorable.room;
    const def = getRoom(r.type);
    const build = buildCostFor(def, r.width);
    add({
      id: 'restore',
      text: `Restore the ${def?.name || r.type} on floor ${r.floor}`,
      roomId: r.id,
      why:
        `It came with the level and has never run. Putting it back into service costs ` +
        `${describeCost(restorable.check.cost)}, against ${describeCost(build)} to build one.`,
      panel: 'build',
      weight: BAL.directives.restoreFound,
    });
  }

  // ---- the bootstrap ----------------------------------------------------
  if (flow(state, 'scrap') <= 0 && count(state, 'recycling') === 0) {
    add({
      id: 'recycling',
      text: `Build a ${getRoom('recycling').name}`,
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
  // How short of target, as urgency. A tenth of the income the silo needs is a
  // different order from nine tenths of it, and both used to rank the same —
  // see `directives.incomeUrgencyRange` for the two runs that separated.
  const starved = (had, want) => D.incomeUrgencyRange * (1 - Math.min(1, Math.max(0, had / want)));
  if (count(state, 'recycling') > 0 && flow(state, 'scrap') < wantScrap) {
    add({
      id: 'scrap_income',
      text: `Build another ${getRoom('recycling').name}`,
      room: 'recycling',
      why:
        `Salvage is running at ${flow(state, 'scrap').toFixed(1)} a shift for ${pop} people. ` +
        'Everything — rooms, repairs, digging — is bought with scrap, and at this rate the silo cannot afford any of it.',
      panel: 'build',
      weight: 75 + starved(flow(state, 'scrap'), wantScrap),
    });
  }
  if (count(state, 'workshop') > 0 && flow(state, 'parts') < wantParts) {
    add({
      id: 'parts_income',
      text: 'Build another Workshop',
      room: 'workshop',
      why: `Parts are running at ${flow(state, 'parts').toFixed(1)} a shift. Every room needs them alongside scrap.`,
      panel: 'build',
      weight: 74 + starved(flow(state, 'parts'), wantParts),
    });
  }

  // ---- posts standing empty ---------------------------------------------
  // Seized rooms are excluded, and it is not cosmetic. A found room always has
  // an empty roster, and `openSlots` — what auto-assign actually walks — skips
  // it until it has been restored. Left in, "Crew The Works" stands at
  // 72 for ever: above digging, above the surface chain, and impossible to
  // carry out. Measured, a silo sat on that order with thirty-seven people
  // idle and its Foundry and Suit Bay uncrewed, and never reached the surface.
  //
  // And not only when somebody is spare, which is where this went wrong in the
  // more expensive direction. A silo whose crew has *drifted* — everybody
  // posted, the top of the priority list holding all of them, and the rooms
  // that feed it standing dark — has nobody unassigned by definition, so the
  // one order that names the one button that fixes it went quiet at exactly
  // the moment it decided the campaign. Measured on seed 0xfeed: three
  // Recycling Plants at 0 of 8 from day 160, generation at a third of what its
  // roster implied because nothing was making fuel, and seventy-seven people
  // starved on day 274. `reassignmentAvailable` asks the question the button
  // will answer, so the order is offered exactly when pressing it does
  // something.
  //
  // The dark rooms are counted first and the transfer is only asked about when
  // there is one, which is not tidiness — `directives` is read from
  // `renderChrome` on a rAF, `spare` is zero in the steady state, and
  // `reassignmentAvailable` runs the whole assignment pass. Asked
  // unconditionally it would walk every open post against every room on every
  // frame, and answer "no" almost every time. A silo with no dark room has
  // nothing for the transfer to do by construction, so the cheap census is a
  // sound gate rather than a guess.
  const darkRooms = Object.values(state.silo.rooms).filter((r) => {
    const def = getRoom(r.type);
    return def?.staff && r.staff.length === 0 && r.buildingUntilCycle === 0 && inService(r);
  });
  const drifted = !spare && darkRooms.length > 0 && reassignmentAvailable(state);
  const empty = spare || drifted ? darkRooms : [];
  if (empty.length) {
    const def = getRoom(empty[0].type);
    add({
      id: 'staff',
      text: empty.length === 1 ? `Crew the ${def?.name || empty[0].type}` : `Crew ${empty.length} empty rooms`,
      // Which room, not just how many. An order that names a place can be
      // pointed at one: the shell puts the floor on the bar and takes the
      // cross-section there. "Crew 4 empty rooms" with no floor on it is a
      // search task, and the silo is a hundred and forty-four floors deep.
      roomId: empty[0].id,
      why: drifted
        ? `Nobody is unassigned, so these have to be crewed out of somewhere else. ` +
          `The ${def?.name || empty[0].type} is producing nothing while rooms the silo ranks ` +
          'lower are fully staffed — auto-assign on the Residents panel will move people across.'
        : 'A room with nobody in it produces nothing at all. Auto-assign on the Residents panel will fill them.',
      panel: 'population',
      weight: 72,
    });
  }

  // ---- more rooms than people --------------------------------------------
  // The other side of the gate above, said out loud. A silo with empty posts
  // and nobody unassigned has over-built, and the useful thing to know is that
  // the constraint has moved: it is no longer scrap, it is people, and people
  // arrive by being housed, fed, watered and left alone for a while. Without
  // this the standing order goes quiet at exactly the moment the player most
  // needs telling why nothing they build is helping.
  if (!spare) {
    const openPosts = openSlots(state).reduce((n, s) => n + s.free, 0);
    if (openPosts > 0) {
      add({
        id: 'hold_for_crew',
        wait: true,
        text: 'Wait for people, not rooms',
        why:
          `${openPosts} post${openPosts === 1 ? ' is' : 's are'} standing empty and nobody is unassigned. ` +
          'A room with no crew produces nothing and draws power anyway, so the silo has built past what it can run. ' +
          'Births are the way out: keep them housed, fed and watered.',
        panel: 'population',
        // Deliberately at the bottom, under digging and under the surface
        // chain. This is a diagnosis, not an instruction — there is no action
        // that discharges it — and a silo waiting for people has spare hours
        // and a full treasury, which is exactly when it should be excavating.
        // At 60 it outranked `excavate` at 30 and an obedient silo sat on 900
        // scrap and the fourteen floors it had dug by then, for a hundred and
        // seventy days, rather than digging a fifteenth: the hold was true, and
        // it was still the wrong thing to say.
        weight: 5,
      });
    }
  }

  // ---- the benches are dark ----------------------------------------------
  //
  // A project the silo has chosen and is not working on.
  //
  // `research.simulateCycle` spends banked points on the active node and
  // returns nothing at all when there are none to spend, so a frozen project
  // is indistinguishable from a slow one: the same bar in the same place, no
  // line anywhere, and the player finds out weeks later that the thing they
  // were waiting for never started.
  //
  // Measured across ten 400-day campaigns: research stood still on 619 days of
  // 4000, the worst run 139 unbroken days on seed 2001 with Decontamination
  // Protocols at 69/230. The cause on 516 of those days was a laboratory that
  // was crewed and dark — a lab sits low on the power list, so it is among the
  // first things a brownout drops — and on 342 of them the whole directive
  // list held one order or none. The silo was not saying the wrong thing about
  // it. It was saying nothing at all.
  //
  // A hold, pointed at the panel that can do something about it.
  //
  // Those are two separate decisions and both were wrong in the first version,
  // which sent the player to the research panel — the screen that shows the
  // frozen bar and offers no way to unfreeze it. The panel that names the
  // problem is not the panel that solves it. `ui/panels/resources.js` carries
  // the power priority list, drag-to-reorder, with a "GENERATION RUNS OUT
  // HERE" cutline drawn through it: it shows the laboratory sitting below the
  // line and lets the player move it. `shell.js:125` opens `panel` when the
  // order bar is tapped whether or not it is a hold, so pointing it there is
  // the whole route.
  //
  // And still a hold, deliberately, because there is no move the game should
  // make on the player's behalf. Every room raised up that list is another
  // pushed down, and the panel's own note is "moving the water reclaimer down
  // is how silos die" — an action button here would be the game reshuffling
  // the shed order for research and handing back a dark hydroponics. The two
  // orders that do own actions cover the safe ones: `staff` at 72 when the
  // answer is crew, `power` at 92 when it is generation. Both go quiet exactly
  // when the silo is short of people, which is when this fires most. What it
  // adds then is the sentence neither says — the thing the shortage is costing
  // you is the project on the bench — and the way to the list that shows it.
  {
    const active = state.research.active;
    const node = active ? getResearch(active.id) : null;
    if (node && active.progress < node.cost) {
      const labs = Object.values(state.silo.rooms).filter(
        (r) => getRoom(r.type)?.provides?.research && r.buildingUntilCycle === 0 && inService(r)
      );
      // The same two tests `economy.js` applies before a room produces
      // anything, so the order and the sim cannot disagree about whether a
      // bench is working.
      const crewed = labs.filter((r) => roomCapability(state, r) > 0);
      const working = crewed.filter((r) => r.powered);
      if (labs.length && !working.length) {
        const dark = crewed.length > 0;
        const done = Math.floor((active.progress / node.cost) * 100);
        add({
          id: 'research_stalled',
          wait: true,
          text: dark ? 'The labs are dark' : 'The benches are empty',
          why: dark
            ? `${node.name} is ${done}% done and has not moved since the ` +
              `${labs.length === 1 ? 'laboratory' : 'laboratories'} last had power. Rooms shut off ` +
              'from the bottom of the priority list up, and a laboratory sits near the bottom of ' +
              'it — so research is the first thing a brownout takes and the one thing in the silo ' +
              'that stops without a sound. The list is here, with the line generation runs out at ' +
              'drawn through it: move the labs above it and something else goes below, or build ' +
              'the generation to carry them both.'
            : `${node.name} is ${done}% done and nobody is at a bench. Points come from the crew, ` +
              'so an empty laboratory makes none and the project stands exactly where it is.',
          panel: dark ? 'resources' : 'research',
          // The same weight as the idle-labs order below, because it is the
          // same problem seen from the other side and the two can never both
          // fire: one wants a project chosen, this one has a project nobody is
          // working on.
          weight: 62,
        });
      }
    }
  }

  // ---- the labs are idle -------------------------------------------------
  //
  // Name the project. This used to read "Choose a research project" and leave
  // it there, which is not advice — it is the game noticing something and
  // declining to say what. Worse, it outranked `dig_research` (32), the one
  // order that names the node the silo is actually blocked on, so a player
  // taking each order at face value started whatever came first in the tree
  // and never reached the gate: seed 99 sat at floor 14 — the exact boundary
  // of the Uppers — for a hundred and seventy days with the Mids one node
  // away, and finished with four research nodes where every other seed had
  // ten to fourteen.
  //
  // The tier gate wins when the silo has run out of room and that gate is what
  // is holding the next floor, because "we cannot dig any deeper" is a more
  // specific problem than "the labs are idle".
  //
  // And alloy wins over the tier gate, because it is the difference between
  // growing and keeping. A silo below the shoring line with no Foundry pays a
  // bill every day in a currency it cannot mint: the floors decay, the fix
  // costs alloy, and the repairs it cannot afford take the rooms with them.
  // Measured on seed 51966, following the silo's own orders: it held 3 alloy at
  // zero income from day 405 with Alloy Refining unresearched, was told to
  // shore on 89 days and to repair on 50 more, could do none of them, and 126
  // people starved by day 688 with five research nodes finished.
  //
  // This is the only place the silo ever picks a node for itself. The order
  // beside the shoring names the same node, but it has to stay silent while the
  // benches are busy — telling somebody to research something is telling them
  // to throw away the project in progress — and on that seed the benches were
  // busy on Hydroponic Yield II for a hundred and sixty-seven cycles while the
  // floors came apart. Naming it here is what makes the answer arrive the
  // moment the labs can act on it.
  if (!state.research.active && has(state, 'laboratory')) {
    const open = availableResearch(state);
    if (open.length) {
      const dig = canExcavate(state);
      const alloyGate = alloyStarved ? getRoom('foundry')?.unlock : null;
      const gate =
        alloyGate && open.some((n) => n.id === alloyGate) ? alloyGate
          : dig.needsResearch && open.some((n) => n.id === dig.needsResearch) ? dig.needsResearch
            : null;
      const pick = gate ? getResearch(gate) : open[0];
      // `gate &&` is load-bearing. Without it this read `gate === alloyGate`,
      // and both are null whenever there is no gate at all — so `null === null`
      // picked the alloy sentence for a silo with no alloy problem, pinned to
      // whatever node happened to be first in the tree. Playing a session on a
      // phone hit it seven times in 120 days: "Research Rack Density", because
      // "the floors below the shoring line are coming apart and shoring them
      // takes alloy" — about a node that has nothing to do with alloy, in a
      // silo whose floors were fine.
      //
      // It also meant the third branch had never once been shown. The banked-
      // points sentence is the ordinary case, the one most silos see most of
      // the time, and it was unreachable from the day it was written.
      const why = gate && gate === alloyGate
        ? 'The floors below the shoring line are coming apart and shoring them takes alloy the ' +
          'silo has none of and no way to make. A Foundry is the only thing that makes any, and ' +
          'it is behind this.'
        : gate
          ? `${dig.reason} It is the only thing standing between the silo and the next floor down.`
          : `${Math.floor(state.research.points)} points are banked and nothing is being worked on.`;
      add({
        id: 'research',
        text: `Research ${pick.name}`,
        research: pick.id,
        why,
        panel: 'research',
        weight: 62,
      });
    }
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
  // The last link in the chain, and the one nothing ever mentioned.
  //
  // The surface programme runs on rounds — two per person per day, and the
  // bands run 1, 3, 5, 6 and 10 days, so four people carry between 8 and 80. Unfired rounds come home, but a squad
  // that meets something spends them. The only other source is the Armory's
  // hand-loading bench at 0.35 a shift, from a room that stands dark most of
  // the time: measured at 77 running days out of 265.
  //
  // So a silo that has built the whole chain — suits, door, armoury, squad —
  // then sits behind it. Measured over the first 300 days, 211 of them had a
  // squad ready to leave and stopped at the ammunition locker, and not one
  // standing order in the game so much as named the room that fixes it.
  if (has(state, 'armory') && has(state, 'airlock') && count(state, 'munitions') === 0 && flow(state, 'ammo') <= 0) {
    const why =
      'A squad carries two rounds a person a day and fires most of them. The Armory hand-loads ' +
      'a fraction of that, so the silo can equip an expedition it cannot supply.';
    const gate = getRoom('munitions')?.unlock;
    if (placeable(state, 'munitions')) {
      add({ id: 'munitions', text: 'Build a Munitions line', room: 'munitions', why, panel: 'build', weight: 51 });
    } else if (gate && !isComplete(state, gate) && !state.research.active && canStart(state, gate).ok) {
      // Name the node, the way the excavation order does. The room is behind
      // 190 points of Firearms I, and a standing order that says "build the
      // thing you cannot build" is not an order. Measured, this is the whole
      // bottleneck: munitions was unbuildable on 298 of the first 300 days and
      // the reason was never alloy or money, it was that nothing in the game
      // ever suggested the cheap node that unlocks it.
      const node = getResearch(gate);
      add({
        id: 'ammo_research',
        text: `Research ${node?.name || gate}`,
        why: `${why} The line that fixes it is behind this.`,
        panel: 'research',
        weight: 51,
        research: gate,
      });
    }
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

  // ---- children learning nothing -------------------------------------------
  //
  // The Schoolhouse is the best return in the game and nothing had ever
  // mentioned it. Measured on a day-150 silo over sixty days: a child in class
  // gains 1.19 skill points a day and an adult at a post gains 0.11 — school
  // is eleven times on-the-job learning, because it carries a 2.2x multiplier
  // and a worker only ever grows the one skill their post uses, halved once it
  // passes 70.
  //
  // A silo with no Schoolhouse has children who learn *nothing at all* for
  // eleven years, and the only place that fact appeared was the catalogue
  // line — which you read after deciding to look. 140 scrap and 10 parts,
  // against a compounding return on every child born from here on.
  {
    const C = BAL.citizens;
    const kids = state.citizenIds.filter((id) => {
      const c = state.citizens[id];
      return c && c.status !== 'dead' && c.age >= C.schoolMinAge && c.age < C.schoolMaxAge;
    }).length;
    // Placeable, like every other order in this band. The Schoolhouse is
    // `tierGate: 'mids'`, so a silo still in the Uppers is told to build a room
    // the bay rejects: measured before this guard, 21 consecutive days of
    // "Build a Schoolhouse" answered with "Schoolhouse needs the mids opened
    // first". The order that fixes that is already on the list — it is
    // "Open the next level down" — and this one waits for it.
    if (kids > 0 && !has(state, 'schoolhouse') && placeable(state, 'schoolhouse')) {
      add({
        id: 'schoolhouse',
        text: 'Build a Schoolhouse',
        room: 'schoolhouse',
        why:
          `${kids} child${kids === 1 ? '' : 'ren'} in the silo and nowhere to teach ${kids === 1 ? 'them' : 'them'}. ` +
          'A schooled child learns about eleven times as fast as an adult picks things up at a ' +
          'post, and they carry it into whatever job they take at ' + C.schoolMaxAge + '.',
        panel: 'build',
        // 46: above digging (30) and restoring a seized room (40), below the
        // surface chain (51-55) and everything that keeps the lights on.
        //
        // It was 58 for one run and test/obedient.mjs failed it in the way
        // that check exists for — an obedient player holding scrap for a
        // Recycling Plant on day 15 had the savings spent on a Schoolhouse
        // instead, and the held target went seven days further away. School is
        // the best *return* in the game and it is not the most *urgent* thing
        // in it: eleven times nothing is still nothing if the silo starves
        // while the children study.
        weight: 46,
      });
    }
  }

  // ---- a door nothing here will open ---------------------------------------
  //
  // The breach stage now asks what the party is carrying, and a gate the
  // player only meets as a refusal is a gate that reads as a bug. This is the
  // order that gets ahead of it: once a silo has been scouted and undermined,
  // the next stage is the door, and the door wants pierce.
  //
  // It fires only when the ladder is actually at that rung, so it is never
  // advice about a thing the player is not doing.
  if (state.research?.completed?.includes('breaching_charges')) {
    const atTheDoor = Object.values(state.world?.silos || {}).find(
      (s) => s.conquest?.stage === 'breach'
    );
    if (atTheDoor) {
      const kit = breachPierce(state);
      if (kit.heads && kit.mean < BAL.conquest.breachPierce) {
        add({
          id: 'breach_kit',
          text: 'Issue something that opens a door',
          why:
            `${atTheDoor.name} is mapped and undermined, and the next run is the door itself. ` +
            `The squads average ${kit.mean.toFixed(1)} pierce and forcing a silo takes ` +
            `${BAL.conquest.breachPierce}. Breaching Carbines are made in the Armory; a Garrison ` +
            'Rifle or a Rail-Carbine off the surface does the same job.',
          panel: 'military',
          weight: 56,
        });
      }
    }
  }

  // ---- a silo with no soldiers in it ---------------------------------------
  //
  // The Training Yard is the only thing in the game that grows combat skill,
  // and nothing had ever mentioned it. Measured on two 400-day campaigns: a
  // silo of 223 people, fifty expeditions returned, and **one person** above
  // combat 40. `assignment: 'training'` is a button on the Squads panel that
  // no order, no unlock and no tutorial step has ever named, and the autopilot
  // — which plays the game as well as anything does — never once pressed it.
  //
  // That is what makes the door indefensible. balance.js's own raid table says
  // four defenders with tier-1 kit turn back Scrappers 40 times out of 40 and
  // eight with tier-3 kit turn back a Warband 27 of 40; what actually shows up
  // to every raid is four untrained bodies, so across three campaigns and
  // twenty-one raids the best forecast the player was ever offered was 0.9 —
  // "too close" — and three of the forecast's five verdicts have never been
  // seen by anybody. The raids were not too strong. The silo had no soldiers.
  {
    const M = BAL.military;
    const squads = state.military?.squadIds || [];
    const home = squads.filter((id) => {
      const sq = state.military.squads[id];
      return sq && !sq.deployed && (sq.members || []).length;
    });
    const members = home.flatMap((id) =>
      (state.military.squads[id].members || []).map((cid) => state.citizens[cid]).filter(Boolean)
    );
    if (members.length) {
      const mean = members.reduce((a, c) => a + (c.skills?.combat || 0), 0) / members.length;
      const yard = Object.values(state.silo.rooms).some(
        (r) => getRoom(r.type)?.provides?.training && inService(r)
      );
      const training = home.some((id) => state.military.squads[id].assignment === 'training');
      // Untrained enough that the door is a formality. Above this the squad is
      // a real garrison and what to do with it is the player's business.
      if (mean < M.trainedEnough && !training) {
        if (!yard) {
          add({
            id: 'training_yard',
            text: 'Build a Training Yard',
            room: 'training_yard',
            why:
              `Your squad averages ${Math.round(mean)} combat. Nothing else in the silo raises that, ` +
              'and a raid met by untrained people is a raid you lose whoever is standing there.',
            panel: 'build',
            weight: 47,
          });
        } else {
          const days = Math.ceil((M.trainedEnough - mean) / Math.max(0.01, M.trainingSkillPerDay));
          add({
            id: 'train',
            text: 'Put a squad on training',
            why:
              `Your garrison averages ${Math.round(mean)} combat and the Training Yard is standing ` +
              `empty. About ${days} day${days === 1 ? '' : 's'} of it, paid in ammunition, is the ` +
              'difference between holding the airlock and reading about it afterwards.',
            panel: 'military',
            weight: 54,
          });
        }
      }
    }
  }

  // ---- kit nobody is carrying ---------------------------------------------
  //
  // Looted gear arrives unassigned and stays that way. `equipBest` is the only
  // thing that issues anything and it runs when a squad is formed or equipped,
  // not when a Rail-Carbine turns up in a crate — so the best weapon in the
  // game can sit on the rack for the rest of a campaign while the squad that
  // fought for it carries what it already had.
  //
  // This is also the only thing that tells a player the loadout screen exists.
  // It is reached by tapping a squad member, which is a gesture nothing else
  // in the game asks for.
  {
    const spare = Object.values(state.military?.gear || {}).filter((g) => !g.assignedTo);
    const looted = spare.filter((g) => g.loot).length;
    const soldiers = (state.military?.squadIds || []).reduce(
      (n, id) => n + (state.military.squads[id]?.members?.length || 0), 0
    );
    if (looted > 0 && soldiers > 0) {
      add({
        id: 'issue_loot',
        text: 'Issue what you brought back',
        why:
          `${looted} piece${looted === 1 ? '' : 's'} of found kit ${looted === 1 ? 'is' : 'are'} on the ` +
          'rack and nobody is carrying it. Tap a squad member to see what they have and change it.',
        panel: 'military',
        weight: 49,
      });
    }
  }

  // ---- doctrine ----------------------------------------------------------
  //
  // The talent tree was reachable and unannounced. It lives as a third tab
  // inside Military, commendations arrive quietly in a log line, and nothing
  // anywhere told a player it existed — so the most valuable decision in the
  // late game was one you found by tapping a tab you had no reason to tap.
  //
  // This is what the standing order is for. It fires only once there is
  // something to spend, so it is never an order you cannot follow, and it goes
  // away the moment the tree is exhausted rather than nagging about a
  // currency with nowhere left to go.
  if (state.doctrine && state.doctrine.points > 0) {
    const affordable = DOCTRINE_NODES.filter((n) => canTakeDoctrine(state, n.id));
    const cheapest = affordable.sort((a, b) => a.cost - b.cost)[0];
    if (cheapest) {
      add({
        id: 'doctrine',
        text: `Adopt ${cheapest.name}`,
        why:
          `${state.doctrine.points} commendation${state.doctrine.points === 1 ? '' : 's'} unspent. ` +
          'Doctrine is permanent, and each rank is a choice between two — taking one closes the other.',
        panel: 'military',
        weight: 50,
      });
    }
  }

  // ---- the ladder nobody is told about -----------------------------------
  //
  // Conquest is four stages, its own module, its own reducer and a drawn
  // ladder in the World panel, and the only way a player meets it is by
  // opening a silo's card and scrolling past the trade offers. It is the
  // largest thing in the game that nothing points at.
  //
  // This fires once and retires for good: the moment a single approach run
  // has gone out, the player has met the system and the World panel carries
  // it from there. It waits for a run to be launchable *now*, which makes it
  // late — and that lateness is the system, not the order.
  //
  // Measured over two campaigns with every conquest launch suppressed, so the
  // gate never closes: a crewed squad is standing by on 270 and 405 days, and
  // of those it can actually go out on the approach band on 43 and 15,
  // starting day 273 and day 465. The rest is one blocker — 173 and 229 days
  // of "Silo approach needs tier-3 suits", and on every no-suit day there was
  // no unassigned suit anywhere in the silo, so there is no issuing hole
  // hiding behind it. Conquest is a tier-3 system and this is when it opens.
  //
  // The obvious alternative was to raise it anyway and name the blocker in
  // the sentence. Measured against the real order list, that variant leads on
  // 232 of 270 days and 378 of 405, with unbroken runs of 136 and 167 days as
  // the headline — the thread would read "Scout Harlow" for four real hours
  // straight while the answer was a research ladder. Nothing in the UI shows
  // a directive below the first, so there is no quiet rank to demote it to
  // either. Saying it early is a job for the unlock announcement, which the
  // World panel now carries; this stays an order that can be obeyed the day
  // it appears.
  if (
    (state.world?.radioTier || 0) > 0 &&
    !(state.world.satellites || []).length &&
    !Object.values(state.world.silos || {}).some((s) => (s.conquest?.scoutRuns || 0) > 0 || s.conquest?.stage)
  ) {
    // `readySquads` returns ids, not squads. Getting that wrong is silent —
    // `canLaunch(state, undefined)` answers "No such squad" and the order
    // simply never appears — and it cost this one 500 measured days of not
    // firing once.
    const squad = readySquads(state).find((id) => canLaunch(state, id, BAL.conquest.band).ok);
    // The weakest door, since this is the one that teaches the ladder.
    const target = Object.values(state.world.silos || {})
      .filter((s) => canLaunchRun(state, s.id).ok)
      .sort((a, b) => (a.power?.military ?? 40) - (b.power?.military ?? 40))[0];
    if (squad != null && target) {
      add({
        id: 'conquest',
        text: `Scout ${target.name}`,
        why:
          'A silo can be taken, not just traded with. It runs as four expeditions — map them, ' +
          'undermine them, force the door, hold the floors — and what it leaves you pays ' +
          `${BAL.conquest.satelliteYieldPerDay} a day of their specialty for as long as you garrison it. ` +
          'Open their card in the World panel to start it.',
        panel: 'radio',
        weight: 48,
      });
    }
  }
  // ---- growth: make what you have better before making more of it --------
  //
  // THE SILO NEVER UPGRADED ANYTHING. Every room has five ranks, each rank is
  // +35% of base output and the third and fifth also add posts, and there is a
  // drawn fixture for all five on the sprite sheet. Measured across three
  // 300-day campaigns, mean room level came out at 1.1, 1.1 and 1.2 — and the
  // standing-order tally over those nine hundred order-days contained
  // hold_for_crew, research_stalled, excavate, hold_for_scrap, steady, staff,
  // repair and restore, and no upgrade at all. A player doing what the game
  // tells them finishes a campaign with a silo entirely at rank one. That is
  // the measured form of "it's missing that building up and improving factor"
  // and of "not enough upgrades visually": the upgrades were there, drawn, and
  // never once asked for.
  //
  // Ranked ABOVE `excavate` deliberately, and it is the whole point of putting
  // it here. Both are what a silo does with a surplus, and the brief is a silo
  // that is built rather than dug — so when there is spare, improving what is
  // standing comes before opening another level to stand things on.
  //
  // Only a room that is actually at work. A rank on an empty bay buys nothing
  // — output scales with the crew in it — and a rank on a seized room is
  // refused by `canUpgrade` for the same reason.
  {
    const rungSlots = BAL.silo.upgrade.staffSlotsPerLevel;
    const ranked = Object.values(state.silo.rooms)
      .filter((r) => {
        const def = getRoom(r.type);
        if (!def) return false;
        // A room with posts has to have somebody in them; one without posts
        // (beds, stores) produces its provision on its own and is worth a rank
        // whatever the roster is doing.
        if (def.staff && !(r.staff?.length > 0)) return false;
        // AND THE RANK HAS TO BE AN IMPROVEMENT, which two of the four are not.
        //
        // `roomCapability` is ceiling x (crew / slots) and `staffSlotsPerLevel`
        // is [1, 1, 2, 2, 3], so at unchanged crew a step from rank 2 to 3
        // multiplies a room's output by 0.63 and rank 4 to 5 by 0.78. Those are
        // not small: a 37% cut sold to the player as an upgrade, on a room they
        // just paid to improve. The other two rungs are x1.35 and x1.21.
        //
        // It is not a corner case either. Measured on the 200-day obedient run,
        // the silo carries 39 workers against 65 posts with zero idle adults
        // from about day 50 on — so on the silo this order actually meets, the
        // post-opening rungs are always a cut. This order sorts lowest-rank
        // first, so without this line it would have walked every room in the
        // silo from rank 2 into a 37% loss and called it building up.
        if (def.staff) {
          const opens = ((rungSlots[r.level] || 1) - (rungSlots[r.level - 1] || 1)) * r.width;
          if (opens > 0 && spare < opens) return false;
        }
        return canUpgrade(state, r.id).ok;
      })
      // Lowest rank first, then the widest, then the busiest: the cheapest
      // step on the biggest room the silo is actually leaning on.
      .sort((a, b) => a.level - b.level || b.width - a.width || (b.staff?.length || 0) - (a.staff?.length || 0))[0];
    // ...and only out of a surplus, defined as being able to pay for it twice.
    //
    // `canUpgrade` only asks whether the silo can cover the bill, which is not
    // the same question. Measured on the obedient playthrough with the plain
    // affordability check: the silo took the two upgrades it was offered on
    // days 44 and 60, spent 300 scrap doing it, and its first Laboratory —
    // ranked 76, forty places above this — slipped from day 68 to day 100,
    // because an unaffordable order is demoted and the money for it had just
    // been spent on a rank. Research is the long pole on everything below the
    // Mids, so buying a rank with the lab's money is a bad trade however good
    // the rank is. Paying twice over is a legible line: you are spending money
    // you have two of, not the money you need.
    const canPayTwice = ranked && affordable(state, doubled(upgradeCost(ranked)));
    if (ranked && canPayTwice) {
      const def = getRoom(ranked.type);
      const cost = upgradeCost(ranked);
      const per = BAL.silo.upgrade.outputPerLevel;
      // The lift the player actually gets, which is not `outputPerLevel`: that
      // is a share of BASE output, so a step off rank 1 is +35% and a step off
      // rank 4 is 0.35/2.05, a little over 17%. Quoting the flat number would
      // be selling the fifth rank at the first rank's price.
      const lift = Math.round((per / (1 + per * (ranked.level - 1))) * 100);
      const opens = ((rungSlots[ranked.level] || 1) - (rungSlots[ranked.level - 1] || 1)) * ranked.width;
      // Only ever a positive number here — the filter above refuses a step
      // that opens posts the silo has nobody for — but it still has to be said,
      // because those posts have to be crewed for the rank to be worth
      // anything and the player is the one who will have to do it.
      const posts = opens > 0
        ? ` and opens ${opens} more post${opens === 1 ? '' : 's'} to fill`
        : '';
      add({
        id: 'upgrade',
        text: `Upgrade the ${def.name} on floor ${ranked.floor}`,
        roomId: ranked.id,
        why:
          `It is at rank ${ranked.level} of ${BAL.silo.upgrade.maxLevel} with ${ranked.staff?.length || 0} ` +
          `at work in it. Rank ${ranked.level + 1} lifts what it makes by about ${lift}%${posts}, ` +
          `for ${describeCost(cost)}. The silo has more to gain from what is standing than from ` +
          'another empty level.',
        panel: 'build',
        weight: 34,
      });
    }
  }

  // ---- steady state ------------------------------------------------------
  // Ask the excavator, rather than guessing from the treasury. The next floor
  // down is often behind a research gate, and an order to dig it is an order
  // that cannot be followed until that node lands — measured at 136 days of
  // "Open the next level down" against a tier that needed Deep Excavation I.
  if (!state.silo.excavating) {
    const dig = canExcavate(state);
    if (dig.ok) {
      add({
        id: 'excavate',
        text: 'Open the next level down',
        why: `There is scrap spare and the silo is ${BAL.silo.totalFloors} floors deep. Bays are the constraint on everything else.`,
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
    }
  }
  // …and if even that was filtered out — every fallback above asks for a room,
  // and a room the silo cannot crew is not offered — then it really is a silo
  // with nothing to do. Pushed past `add` on purpose: this is the line that
  // makes "never nothing" true, so it cannot be allowed to be filtered. It was,
  // for twenty-eight consecutive days of one measured silo, and the standing
  // order bar simply disappeared.
  if (!out.length) {
    out.push({
      id: 'steady',
      wait: true,
      text: 'The silo is steady',
      why: 'Nothing is failing and nothing is running out. A good time to dig, or to look at what is outside.',
      panel: 'build',
      weight: 1,
    });
  }

  // ---- what the silo is actually trying to do ---------------------------
  //
  // The goal is read off the *unpenalised* ranking, before affordability gets
  // a say, because affordability answers a different question. "What matters
  // most" is a fact about the silo; "what can I do about it this minute" is a
  // fact about the treasury, and mixing them is what made obedience a
  // treadmill. Measured over fifteen game days of perfect obedience:
  //
  //   d3.7  hold  Save up for a Generator Hall — 172 scrap short, ~4 days away
  //   d6.6  act   Build another Recycling plant  -> obeyed, -130 scrap
  //   d6.7  hold  Save up for a Generator Hall — 177 scrap short, ~9 days away
  //   d8.6  act   Build another Recycling plant  -> obeyed, -130 scrap
  //   d8.7  hold  Save up for a Generator Hall — 163 scrap short, ~3 days away
  //
  // Five days of doing exactly what it said moved the Hall from 172 short to
  // 163 short, because the ranker re-decided every time the treasury crossed a
  // price point: the moment the silo could afford the cheap thing it was told
  // to buy the cheap thing, and the moment it could not it was told to save for
  // the expensive one. Acting more often was strictly worse — at eight actions
  // a day it reached day 40 with 21 rooms and one research node against 13 and
  // two at three a day, and the Generator Hall the order kept naming never got
  // bought at all.
  const goal = out.reduce((a, b) => (b.weight > (a?.weight ?? -Infinity) ? b : a), null);
  for (const d of out) d.baseWeight = d.weight;

  // Rank by what can actually be done now. An order the silo cannot pay for
  // keeps its urgency in the text but yields the top slot to anything it can.
  for (const d of out) {
    if (!d.room) continue;
    const short = shortfall(state, d.room);
    if (!short) continue;
    d.blocked = short;
    d.weight -= D.unaffordablePenalty;
    if (!/short/.test(d.why)) {
      d.why = `${d.why} The silo is ${short} short of one.`;
    }
  }

  // If the thing the silo most needs is one it cannot pay for, saying so again
  // tomorrow is not advice. An obedient player was told to build a Generator
  // Hall on 36 separate days and could never once afford it, while the thing
  // that would have made it affordable was never mentioned — the income orders
  // sit at 75 and go quiet the moment throughput is nominally adequate, which
  // it can be while the treasury is still empty.
  //
  // There are exactly two honest answers, and which one applies is a question
  // about arithmetic rather than about priority: *can the silo save its way
  // there from here*. If it can, the order is to save, and nothing less urgent
  // is allowed to spend the reserve while it does — that lockout is the fix,
  // and without it "save up" is just the odd-numbered half of a treadmill. If
  // it cannot, saving is not a plan and the real problem is income, so a
  // salvage plant it can afford today becomes the order instead.
  //
  // Both answers reserve the treasury, so neither is honest about a goal that
  // will not still be the goal on the next check-in — a growth order can reach
  // the top of this list in the gaps between the orders that outrank it (while
  // the room one of them named is still in the bay, say), and a plan made in a
  // gap is spent the moment the gap closes. The guard against that is not here:
  // it is that every order in the growth band checks `placeable` before it is
  // raised at all, and `canBuild` counts the price. A growth order the silo
  // cannot pay for is never offered, so it never becomes a blocked goal.
  // Measured over sixteen 400-day campaigns, the only goal under the surface
  // chain that ever reaches this branch is `more_labs`, where "Save up for a
  // Laboratory" is exactly the right thing to say.
  if (goal?.blocked && goal.room) {
    const days = daysToAfford(state, goal.room);
    const savable = days !== null && days <= D.holdHorizonDays;
    const gap = scarcest(state, goal.room);
    const relief = savable ? null : incomeRelief(state, gap);

    if (relief) {
      // Promote rather than add — the income order is usually already in the
      // list, sitting at 75 or 74 and demoted for being unaffordable itself.
      const why =
        `The silo is ${goal.blocked} short of what it most needs — ${goal.text.toLowerCase()} — ` +
        `and ${relief.noun} is the only thing that closes that gap at this rate. ` +
        'One it can afford today buys the one it cannot.';
      const existing = out.find((d) => d.id === relief.id);
      if (existing) {
        existing.weight = goal.weight + 1;
        existing.blocked = null;
        existing.why = why;
      } else {
        add({
          id: relief.id,
          text: `Build another ${getRoom(relief.room).name}`,
          room: relief.room,
          why,
          panel: 'build',
          weight: goal.weight + 1,
        });
      }
    } else {
      // Saving up, then. The hold sits one place above the goal it is saving
      // for — which is where the goal would sit if it were payable — and every
      // *other* building order that the silo could pay for out of the reserve
      // is put below it, so obeying the order twice in a day cannot undo the
      // first obedience. The exception is the life-support band: an order at
      // `holdYieldsAbove` or over that the silo can pay for today is never
      // worth deferring for one it cannot, which is the guard that stops this
      // becoming a hold held through a famine.
      //
      // Free orders — crewing an empty room, choosing a project, forming a
      // squad — are untouched and keep their own ranks above the hold. They
      // cost nothing, so a silo saving up should still be doing them, and a
      // hold that silenced them would be advice to sit still for a week.
      const hold = goal.weight + 1;
      // Only a plan that finishes gets to reserve the treasury. A silo that
      // cannot save its way there *and* cannot afford the salvage plant that
      // would fix it has nothing worth protecting — it is simply broke — and
      // holding the lockout open there is how it stays broke: measured, an
      // obedient silo at eight actions a day sat at 0.2 scrap a shift for
      // sixty days with the income order pinned below a hold for a Generator
      // Hall it was fifty days from, and suffocated on day 181. So the hold is
      // still said, because it is true and it names the number, but the moment
      // anything that improves income becomes payable it takes the slot.
      if (savable) {
        for (const d of out) {
          if (d === goal || !d.room) continue;
          if (d.baseWeight >= D.holdYieldsAbove) continue;
          d.weight = Math.min(d.weight, hold - 1);
        }
      }
      const income = flow(state, gap);
      const whole = days === null ? null : Math.max(1, Math.ceil(days));
      add({
        id: 'hold_for_scrap',
        // Deliberately carries no room: obeying this order means doing
        // nothing today, and anything that reads directives — the panel, the
        // obedient-player test — needs to be able to tell "wait" apart from
        // "we have no advice".
        wait: true,
        // What is being saved for, though, as a room type. Not for the UI —
        // `target` is how test/obedient.mjs can watch a held target get closer
        // rather than further away, which is the whole assertion that keeps the
        // treadmill from coming back.
        target: goal.room,
        text: `Save up for ${aOrAn(goal.text.replace(/^Build (a|an|another) /, ''))}`,
        why:
          `${goal.why} ${gap === 'scrap' ? 'Salvage' : `${gap[0].toUpperCase()}${gap.slice(1)}`} is ` +
          `running at ${income.toFixed(1)} a shift, so the silo is ` +
          (whole === null
            ? `not earning anything towards it — no ${gap} is coming in at all.`
            : `about ${whole} day${whole === 1 ? '' : 's'} away from affording it. ` +
              'Nothing else needs doing first, and nothing else should be bought first.'),
        panel: 'build',
        weight: hold,
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
    if (d.id === 'shore' && d.floor) {
      // Same treatment, same reason: a floor the silo cannot currently afford
      // to shore still has to be said out loud, with the shortfall on it. This
      // is the one order where going quiet costs the player a whole level.
      const check = canShore(state, d.floor);
      if (!check.ok && check.cost) d.blocked = shortOf(state, check.cost);
      continue;
    }
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
