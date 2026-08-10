/**
 * economy.js — per-cycle production and consumption.
 *
 * Resolves once per cycle (spec §3.3), never per tick. The order below is
 * load-bearing and shouldn't be shuffled:
 *
 *   1. caps        — depots decide how much of anything you can hold
 *   2. capability  — staffing, condition, level and merge multipliers
 *   3. power       — demand first, then run the plant to it, then brown out
 *                    from the bottom of the player's priority list up
 *   4. throughput  — only powered rooms produce or consume
 *   5. people      — food and water off the top
 *   6. air         — filtration capacity vs headcount
 *   7. wear        — condition decay on everything that ran
 *
 * Power has to be decided before throughput because a browned-out hydroponics
 * bay neither grows food nor drinks water. Getting that backwards is how you
 * end up with a silo that starves while its tanks are full.
 */

import { BAL } from '../config/balance.js';
import { ROOMS, getRoom } from '../data/rooms.js';
import { workFactor } from './population.js';
import { traitMod } from '../data/traits.js';
import { effects as researchEffects, speedMultiplier } from './research.js';

const RES_KEYS = [
  'power', 'water', 'food', 'meds', 'scrap', 'alloy',
  'ammo', 'chits', 'filters', 'parts', 'fuel', 'ore', 'coolant',
];

export { RES_KEYS };

// ------------------------------------------------------------------ caps ---

/**
 * A room the silo is actually running.
 *
 * A level found with a room still in it arrives seized: breakers open, nobody
 * on the roster, nothing coming out of it. It joins the silo when it has been
 * restored, not when the door is opened — which is what makes the restoration
 * a purchase rather than a formality. Without this a twenty-per-cent
 * Hydroponics Bay started feeding people the moment it was found, the silo
 * grew to a hundred and seventy on capacity it had never paid for, and the
 * whole surface chain fell off the end of the campaign.
 *
 * Rooms the player built are in service the moment they finish, as ever.
 */
export function inService(room) {
  return !room?.found;
}

export function computeCaps(state) {
  const caps = { ...BAL.resources.baseCaps };
  const e = researchEffects(state);
  if (e.foodCap) caps.food += e.foodCap;
  if (e.batteryCap) caps.power += e.batteryCap;
  for (const id of Object.keys(state.silo.rooms)) {
    const room = state.silo.rooms[id];
    const def = getRoom(room.type);
    if (!def || !inService(room)) continue;
    if (def.provides.depot) {
      const scale = room.level * room.width;
      for (const [k, v] of Object.entries(BAL.resources.depotCapBonus)) {
        caps[k] = (caps[k] || 0) + v * scale;
      }
    }
    if (def.provides.cap) {
      for (const [k, v] of Object.entries(def.provides.cap)) {
        caps[k] = (caps[k] || 0) + v * room.level;
      }
    }
  }
  return caps;
}

// ------------------------------------------------------------ capability ---

/**
 * What a room is worth at full crew: condition, level and merge width, and
 * nothing about who is standing in it. `roomCapability` is this multiplied by
 * the fraction of its posts that are filled.
 *
 * Split out so the two halves of "how well is this room running" can be read
 * apart, because they have different answers: a half-crewed bay and a worn-out
 * one both produce half, and only one of them is fixed by posting somebody.
 */
function roomCeiling(state, room) {
  const def = getRoom(room.type);
  if (!def) return 0;
  if (room.condition <= BAL.silo.condition.failAt) return 0;

  // Condition penalty only bites below the threshold, then scales to zero.
  const cond =
    room.condition >= BAL.silo.condition.penaltyBelow
      ? 1
      : room.condition / BAL.silo.condition.penaltyBelow;

  const level = 1 + (room.level - 1) * BAL.silo.upgrade.outputPerLevel;
  const mergeSteps = room.width - 1;
  const merge = room.width * (1 + mergeSteps * BAL.silo.merge.efficiencyPerStep);
  return cond * level * merge;
}

/**
 * How well a room can actually run right now, ignoring power.
 * Returns 0..~2. Zero means it produces nothing this cycle.
 */
export function roomCapability(state, room) {
  const def = getRoom(room.type);
  if (!def) return 0;
  if (room.buildingUntilCycle && state.clock.cycle < room.buildingUntilCycle) return 0;

  const ceiling = roomCeiling(state, room);
  if (ceiling <= 0) return 0;
  if (!def.staff) return ceiling;

  const slots = staffSlots(def, room);
  if (slots <= 0) return 0;
  let sum = 0;
  let filled = 0;
  for (const cid of room.staff) {
    if (cid == null) continue;
    const c = state.citizens[cid];
    if (!c || c.status === 'dead') continue;
    if (c.status !== 'working' && c.status !== 'training') continue;
    const matched = c.skills[def.staff.skill] !== undefined;
    const f = workFactor(c, def.staff.skill);
    sum += matched ? f : f * BAL.jobs.mismatchedOutput;
    filled++;
  }
  if (filled === 0) return 0;
  // Partially-staffed rooms run at the fraction they're crewed for.
  const staffing = sum / slots;
  return ceiling * staffing;
}

export function staffSlots(def, room) {
  if (!def.staff) return 0;
  const per = def.staff.slotsPerLevel[Math.min(room.level, 5) - 1] || 1;
  return per * room.width;
}

/** Power a room draws this cycle. Idle rooms still draw a trickle. */
export function roomDraw(state, room, capability) {
  const def = getRoom(room.type);
  if (!def || !def.consumes.power) return 0;
  const mergeSteps = room.width - 1;
  const discount = 1 - mergeSteps * BAL.silo.merge.powerDiscountPerStep;
  const level = 1 + (room.level - 1) * BAL.silo.upgrade.outputPerLevel * 0.6;
  const efficiency = 1 - (researchEffects(state).powerEfficiency || 0);
  const base = def.consumes.power * room.width * discount * level * efficiency;
  // A room nobody is crewing still keeps its lights on.
  return capability > 0 ? base : base * 0.25;
}

// ----------------------------------------------------------------- plant ---

/** Capability and power draw for every room, the way the cycle works them out. */
function roomLoads(state, roomIds) {
  const capability = {};
  const draw = {};
  for (const id of roomIds) {
    const room = state.silo.rooms[id];
    if (!getRoom(room.type)) continue;
    const cap = roomCapability(state, room);
    capability[id] = cap;
    draw[id] = roomDraw(state, room, cap);
  }
  return { capability, draw };
}

/**
 * What the plant does with one cycle: which halls light, how hard each one
 * runs, and what that costs it.
 *
 * Generators are never browned out — they're the source — but they do stop if
 * they run dry, and they no longer run flat out. Demand is summed before a
 * single hall is lit, and that ordering is the whole of it. Generation used to
 * come straight off capability: every hall flat out every shift regardless of
 * what the silo drew, with the surplus above the battery's charge rate
 * discarded thirty lines further down. The fuel was not discarded. Measured on
 * the 700-day pacing run, twenty-one halls burned 14,184 fuel to move 199 of a
 * generated 270 power — better than a quarter of every litre burned for power
 * nobody drew.
 *
 * It is the trap a player is walked into by the silo's own advice: the standing
 * order says "Build a Generator Hall" at 90% load, so a silo that obeys ends up
 * over-provisioned, and over-provisioning used to have a permanent running cost
 * that is invisible until the fuel runs out and the lights go off. That is what
 * killed the day-553 silo.
 *
 * So the plant follows the load. Halls light cheapest-fuel-first until they
 * cover the draw plus whatever the battery can still take this cycle; the one
 * that crosses the line runs part-loaded and the rest stay cold. Counted
 * against what the same cycle would have burned unthrottled, on the same
 * trajectory, that is 20% less fuel over 300 days and 27% over 700 — the gap
 * widens because a silo over-builds its plant as it grows, which is exactly
 * when the old behaviour hurt most.
 *
 * This lives outside `simulateCycle` because the throttle is not only the
 * cycle's business. A hall held at a third of the load burns a third of the
 * fuel, and while the share was a local variable the Stores ledger had no way
 * to know: it priced every hall's draw at the plate rating and reported a
 * four-hall silo burning 2.09 fuel a shift under a header that said 0.34, six
 * times over, with the discrepancy hidden because the leftover line went
 * negative and was suppressed. One function, two callers, one answer.
 *
 * Pure. `capability` and `draw` come in from `roomLoads`; the capability map
 * that comes back is a copy with any hall that could not get its fuel zeroed
 * out, which is what the rest of the cycle then treats as an idle room.
 */
function plantPlan(state, roomIds, capability, draw, caps) {
  const res = state.resources;
  const generators = generatorOrder(state, roomIds);
  const isGenerator = new Set(generators);
  const out = { ...capability };

  // The whole draw, not the browned-out draw. Sizing the plant against demand
  // that has already been shed would hold a brownout open for ever.
  let demand = 0;
  for (const id of roomIds) {
    if (!isGenerator.has(id)) demand += draw[id] || 0;
  }

  // Charging is the only honest reason to generate above the draw, and only up
  // to the rate the battery accepts and the room actually left in it. Topping
  // up a battery that is already full is the same wasted litre as generating
  // into nothing — and a silo with more plant than load sits at full battery
  // permanently, so that was the common case, not the corner one.
  const batteryThroughput = researchEffects(state).batteryThroughput || 0;
  const chargeWant = Math.max(
    0,
    Math.min(BAL.power.batteryChargePerCycle + batteryThroughput, caps.power - res.power)
  );
  const wanted = demand + chargeWant;

  let fuelAvailable = res.fuel;
  let coolantAvailable = res.coolant;
  const throttle = {};
  const burn = {};
  let generation = 0;

  for (const id of generators) {
    const def = getRoom(state.silo.rooms[id].type);
    const cap = out[id];
    if (cap <= 0) continue;
    const rated = def.produces.power * cap;
    // What this hall has to cover is whatever the ones ahead of it did not.
    const share = Math.max(0, Math.min(1, (wanted - generation) / rated));
    if (share <= 0) {
      throttle[id] = 0;
      continue;
    }
    // Consumption scales with capability, which already folds in width,
    // level and staffing. Multiplying by width again would double-count it.
    const fuelWant = (def.consumes.fuel || 0) * cap * share;
    const coolWant = (def.consumes.coolant || 0) * cap * share;
    if (fuelWant > fuelAvailable || coolWant > coolantAvailable) {
      out[id] = 0;
      continue;
    }
    fuelAvailable -= fuelWant;
    coolantAvailable -= coolWant;
    throttle[id] = share;
    burn[id] = { fuel: fuelWant, coolant: coolWant };
    generation += rated * share;
  }

  // What the plant could deliver if the silo asked for it, which is a different
  // number from what it did deliver and is the one the readouts and the
  // standing orders want: "demand is at the limit of generation" is a question
  // about headroom, and headroom is a question about capacity. Halls that ran
  // dry are already zeroed above, so a fuel shortage still shows up here as
  // capacity falling, exactly as it did before.
  let capacity = 0;
  for (const id of generators) {
    capacity += (getRoom(state.silo.rooms[id].type).produces.power || 0) * out[id];
  }

  return { generators, isGenerator, throttle, burn, generation, capacity, demand, capability: out };
}

/**
 * How hard every room is running this cycle, without running one.
 *
 * `load` is the fraction of its capability a room is actually worked at, which
 * is what its running stores are charged against. It is 1 for everything in the
 * silo except a throttled generator hall, and that exception is the whole
 * reason this is exported: the ledger has to be able to say what a hall really
 * burns, and it cannot get that from the room definition.
 *
 * Recomputed rather than remembered. It is the same walk the panel already does
 * for `roomCapability`, it costs nothing next to the repaint it feeds, and a
 * remembered copy would need somewhere in the save to live.
 *
 * @returns {{capability: object, draw: object, load: object, demand: number, capacity: number, generation: number}}
 */
export function powerPicture(state) {
  // Seized rooms a dig turned up are not part of the plant until restored.
  const roomIds = Object.keys(state.silo.rooms).filter((id) => inService(state.silo.rooms[id]));
  const { capability, draw } = roomLoads(state, roomIds);
  const plant = plantPlan(state, roomIds, capability, draw, computeCaps(state));
  const load = {};
  for (const id of roomIds) load[id] = plant.isGenerator.has(id) ? (plant.throttle[id] ?? 0) : 1;
  return {
    capability: plant.capability,
    draw,
    load,
    demand: plant.demand,
    capacity: plant.capacity,
    generation: plant.generation,
  };
}

// ----------------------------------------------------------------- cycle ---

/**
 * One cycle of economy. Pure — returns actions.
 * @returns {Array} actions
 */
export function simulateCycle(state, ctx = {}) {
  const actions = [];
  const caps = computeCaps(state);
  const res = state.resources;

  const flows = {};
  for (const k of RES_KEYS) flows[k] = { in: 0, out: 0 };

  const deltas = {};
  const bump = (k, v) => {
    if (!v) return;
    deltas[k] = (deltas[k] || 0) + v;
    if (v > 0) flows[k].in += v;
    else flows[k].out += -v;
  };

  // ---- 1. what can each room do, and what does it want to draw ----------
  // Seized rooms a dig turned up are not part of the plant until restored.
  const roomIds = Object.keys(state.silo.rooms).filter((id) => inService(state.silo.rooms[id]));
  const { capability, draw } = roomLoads(state, roomIds);

  // ---- 2. generation, run to the load ------------------------------------
  const plant = plantPlan(state, roomIds, capability, draw, caps);
  const { isGenerator, throttle, demand, generation, capacity } = plant;
  for (const id of plant.generators) {
    capability[id] = plant.capability[id]; // a hall that ran dry is off for the rest of the cycle
    const burn = plant.burn[id];
    if (!burn) continue;
    bump('fuel', -burn.fuel);
    bump('coolant', -burn.coolant);
  }
  flows.power.in += generation;

  // ---- 3. brownout. Walk the player's priority list top down. -----------
  const batteryThroughput = researchEffects(state).batteryThroughput || 0;
  const throughput = BAL.power.batteryDischargePerCycle + batteryThroughput;
  const battery = Math.min(res.power, throughput);
  let budget = generation + battery;
  const powered = {};
  let unpoweredCount = 0;

  const priority = orderedRoomIds(state, roomIds);
  for (const id of priority) {
    if (isGenerator.has(id)) {
      powered[id] = capability[id] > 0;
      continue;
    }
    const want = draw[id];
    if (want <= budget) {
      budget -= want;
      powered[id] = true;
      flows.power.out += want;
    } else {
      powered[id] = false;
      if (capability[id] > 0) unpoweredCount++;
    }
  }

  const brownout = unpoweredCount > 0;
  const surplus = generation - flows.power.out;
  let batteryDelta;
  if (surplus >= 0) {
    batteryDelta = Math.min(surplus, BAL.power.batteryChargePerCycle + batteryThroughput);
  } else {
    batteryDelta = Math.max(surplus, -throughput);
  }

  // ---- 4. throughput for everything that got power ----------------------
  const research = researchEffects(state);
  let airCapacity = 0;
  let researchPoints = 0;
  let maintenance = 0;

  for (const id of roomIds) {
    const room = state.silo.rooms[id];
    const def = getRoom(room.type);
    if (!def) continue;
    const isGen = isGenerator.has(id);
    const on = powered[id] && capability[id] > 0;

    // Passive provisions need power but not crew.
    if (powered[id]) {
      if (def.provides.airCapacity) {
        airCapacity += def.provides.airCapacity * room.level * room.width *
          (capability[id] > 0 ? 1 : 0.55);
      }
    }
    if (!on) continue;

    const cap = capability[id];
    // What the room is actually working at. Only a throttled generator differs
    // from its capability, and its running stores go with the load: the scrap
    // a hall eats is bearings and belts, and a hall at a third of load turns
    // over a third as much of it.
    const worked = cap * (throttle[id] ?? 1);

    if (def.provides.research) {
      researchPoints += BAL.research.pointsPerLabPerCycleBase * cap * speedMultiplier(state);
    }
    if (def.provides.researchBonus) {
      // Archives multiply what the labs already produced this cycle.
      researchPoints *= 1 + def.provides.researchBonus * room.level;
    }
    if (def.provides.maintenance) {
      maintenance += BAL.silo.condition.maintenanceRestorePerCyclePerCrew * cap;
    }

    // Inputs first: a room that can't get its inputs produces nothing.
    let ratio = 1;
    for (const [k, v] of Object.entries(def.consumes)) {
      if (k === 'power' || isGen) continue;
      const want = v * cap;
      const have = res[k] + (deltas[k] || 0);
      if (want > 0 && have < want) ratio = Math.min(ratio, Math.max(0, have / want));
    }
    if (ratio <= 0) continue;

    for (const [k, v] of Object.entries(def.consumes)) {
      if (k === 'power') continue;
      if (isGen && (k === 'fuel' || k === 'coolant')) continue; // already charged above
      bump(k, -v * worked * ratio);
    }
    for (const [k, v] of Object.entries(def.produces)) {
      if (k === 'power') continue; // charged above
      bump(k, v * cap * ratio * yieldMultiplier(research, k));
    }
  }

  // The battery moves by the difference between the two power figures already
  // in `flows` — generation in, served draw out — so putting it through
  // `bump` wrote it a second time and the strip's PWR delta read double.
  // Measured on a steady four-hall silo: 6.1 in, 0.0 out, and a strip showing
  // +12.2. The store still has to move, so the delta is written directly and
  // the flow is left as the two honest halves it is made of.
  deltas.power = (deltas.power || 0) + batteryDelta;

  // ---- 5. people eat -----------------------------------------------------
  const pop = state.citizenIds.length;
  const perCycle = 1 / BAL.time.CYCLES_PER_DAY;
  let foodWant = 0;
  for (const cid of state.citizenIds) {
    const c = state.citizens[cid];
    if (!c || c.status === 'dead' || c.status === 'expedition') continue;
    foodWant += BAL.resources.perCitizen.foodPerDay * perCycle * traitMod(c.traits, 'foodConsumption');
  }
  const waterWant = pop * BAL.resources.perCitizen.waterPerDay * perCycle;
  bump('food', -foodWant);
  bump('water', -waterWant);

  // ---- 6. air ------------------------------------------------------------
  const load = pop * BAL.resources.perCitizen.airLoadPerCitizen;
  const target = airCapacity <= 0 ? 0 : Math.min(BAL.air.max, (airCapacity / Math.max(1, load)) * 100);
  const airDelta = clampMag(target - state.air.quality, BAL.air.driftPerCycle);

  // ---- 7. wear -----------------------------------------------------------
  //
  // Wear follows how hard a room is worked rather than whether it is switched
  // on, which only makes a difference to a throttled generator: a hall held at
  // a third of load is turning over, not hammering, and charging it the full
  // working rate would hand back with one figure what the throttle saved on
  // the other. It interpolates between the two rates the file already has
  // rather than inventing a third. Everything but a generator is on or off, so
  // for every other room this is exactly the old two-way choice.
  const C = BAL.silo.condition;
  const wear = [];
  for (const id of roomIds) {
    const room = state.silo.rooms[id];
    const running = powered[id] && capability[id] > 0;
    const loadFactor = running ? (throttle[id] ?? 1) : 0;
    let d = -(C.decayPerCycleIdle + loadFactor * (C.decayPerCycleWorking - C.decayPerCycleIdle)) * room.width;
    d *= crewWearFactor(state, room);
    wear.push({ id, delta: d });
  }
  if (maintenance > 0) {
    // Maintenance spreads across whatever is worst first.
    const worst = wear
      .map((w) => ({ w, cond: state.silo.rooms[w.id].condition }))
      .sort((a, b) => a.cond - b.cond)
      .slice(0, BAL.silo.condition.maintenanceTargets);
    const share = maintenance / Math.max(1, worst.length);
    for (const { w } of worst) w.delta += share;
  }

  // ---- emit --------------------------------------------------------------
  actions.push({ type: 'RESOURCE_DELTA', deltas, caps, emit: false });
  // `generation` is the plant's *capacity* and `demand` is the silo's whole
  // draw. Neither is "what happened this shift", and both are deliberate:
  // every reader of this pair — the strip, the Stores subtitle, the brownout
  // alert, the ambient hum, and the standing order at 90% load — is asking
  // the headroom question, and headroom is capacity against demand.
  //
  // `demand` used to be `flows.power.out`, the *served* draw, which is the one
  // number that can never answer it: served draw is clamped to what the plant
  // delivered, so a silo 200 short of its own load reported being 2 short and
  // the brownout alert read "demand 61 against 59 generated" while 26 rooms
  // stood dark. What was shed is `flows.power.in - flows.power.out` away in
  // the ledger; what is *wanted* had no home at all until this line.
  actions.push({ type: 'POWER_STATE', powered, brownout, generation: capacity, demand, emit: false });
  actions.push({ type: 'AIR_DELTA', delta: airDelta, capacity: airCapacity, load, emit: false });
  actions.push({ type: 'CONDITION_DELTA', wear, emit: false });
  actions.push({ type: 'FLOWS_SET', flows, emit: false });
  if (researchPoints > 0) actions.push({ type: 'RESEARCH_POINTS', amount: researchPoints, emit: false });

  return actions;
}

/**
 * A whole game day of economy in one step, using averaged production and
 * consumption (spec §3.4). Used only by offline catch-up.
 *
 * This resolves one cycle honestly and then applies it CYCLES_PER_DAY times,
 * rather than simulating eight cycles. The fidelity it gives up is
 * intra-day ordering: if food would have run out four cycles into the day,
 * the coarse path just ends the day at zero and lets the population sim see
 * a starving silo. The qualitative outcome — they starved — is preserved,
 * which is what the return report has to get right.
 */
export function simulateDayCoarse(state, ctx = {}) {
  const cycleActions = simulateCycle(state, ctx);
  const n = BAL.time.CYCLES_PER_DAY;
  const out = [];

  for (const a of cycleActions) {
    if (!a) continue;
    switch (a.type) {
      case 'RESOURCE_DELTA': {
        const scaled = {};
        for (const [k, v] of Object.entries(a.deltas)) scaled[k] = v * n;
        out.push({ ...a, deltas: scaled });
        break;
      }
      case 'AIR_DELTA':
        // Air drifts toward a target, so scaling the step would overshoot it.
        // Clamp to the remaining distance instead.
        out.push({ ...a, delta: clampToTarget(state.air.quality, a.delta, n) });
        break;
      case 'CONDITION_DELTA':
        out.push({ ...a, wear: a.wear.map((w) => ({ ...w, delta: w.delta * n })) });
        break;
      case 'RESEARCH_POINTS':
        out.push({ ...a, amount: a.amount * n });
        break;
      default:
        // POWER_STATE and FLOWS_SET describe an instant, not a rate.
        out.push(a);
    }
  }
  return out;
}

function clampToTarget(current, perCycleDelta, cycles) {
  const total = perCycleDelta * cycles;
  // The per-cycle delta was already clamped to the drift rate and points at
  // the target, so the furthest it can legitimately travel is to 0 or 100.
  const room = perCycleDelta > 0 ? BAL.air.max - current : current - BAL.air.min;
  return Math.sign(perCycleDelta) * Math.min(Math.abs(total), Math.max(0, room));
}

/** Research yield bonuses, by the resource being produced. */
const YIELD_KEY = { food: 'foodYield', water: 'waterYield', alloy: 'alloyYield' };

function yieldMultiplier(research, resourceKey) {
  const key = YIELD_KEY[resourceKey];
  return key ? 1 + (research[key] || 0) : 1;
}

function crewWearFactor(state, room) {
  let f = 1;
  let n = 0;
  for (const cid of room.staff) {
    if (cid == null) continue;
    const c = state.citizens[cid];
    if (!c) continue;
    f *= traitMod(c.traits, 'conditionWear');
    n++;
  }
  return n > 0 ? Math.pow(f, 1 / n) : 1;
}

/**
 * Room ids in power-priority order. Anything the player hasn't explicitly
 * ordered falls in at its room type's default rank, so a newly built room
 * lands somewhere sane instead of at the bottom of the list.
 */
export function orderedRoomIds(state, roomIds) {
  const explicit = state.silo.powerPriority || [];
  // Only rooms the caller is actually walking. This returned every id in the
  // priority list that resolved to a room, ignoring `roomIds` entirely — which
  // was harmless while seized rooms were absent from the list and stopped being
  // harmless the moment they were added to it. The resources panel walks this
  // to draw the brownout cut line, so it started charging power for rooms the
  // simulation does not run and drawing the line in the wrong place.
  const allowed = roomIds ? new Set(roomIds) : null;
  const seen = new Set();
  const out = [];
  for (const id of explicit) {
    if (state.silo.rooms[id] && (!allowed || allowed.has(id))) {
      out.push(id);
      seen.add(id);
    }
  }
  const rest = roomIds.filter((id) => !seen.has(id));
  rest.sort((a, b) => defaultRank(state, a) - defaultRank(state, b));
  return out.concat(rest);
}

function defaultRank(state, id) {
  const type = state.silo.rooms[id].type;
  const i = BAL.power.defaultPriority.indexOf(type);
  return i < 0 ? 999 : i;
}

/**
 * The order the plant lights its generators in: cheapest fuel per unit of
 * power first, then oldest first.
 *
 * Cheapest-first is what decides which hall carries base load and which one is
 * swing capacity, and it wants to be fuel rather than fuel-and-coolant: a
 * Reactor is the most fuel-efficient thing in the silo (1.1 fuel for 128
 * power against a hall's 0.3 for 32) and is exactly what should be carrying
 * the base, with the halls taking the swing above it. If its coolant runs out
 * it shuts down on the dry check like anything else and the halls pick the
 * load up.
 *
 * The tie-break is the room id, which for identical halls means the oldest one
 * runs and the newest one throttles. It is there because iteration order over
 * `state.silo.rooms` is an implementation detail and the fuel bill must not
 * be: the same silo replayed during offline catch-up has to burn the same
 * litres it burned live, to the last decimal.
 */
function generatorOrder(state, roomIds) {
  const gens = roomIds.filter((id) => (getRoom(state.silo.rooms[id].type)?.produces || {}).power);
  return gens.sort((a, b) => {
    const ca = fuelPerPower(state.silo.rooms[a]);
    const cb = fuelPerPower(state.silo.rooms[b]);
    if (ca !== cb) return ca - cb;
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function fuelPerPower(room) {
  const def = getRoom(room.type);
  const power = def?.produces?.power || 0;
  if (power <= 0) return Infinity;
  return (def.consumes.fuel || 0) / power;
}

function clampMag(v, mag) {
  return v > mag ? mag : v < -mag ? -mag : v;
}

export default {
  simulateCycle,
  computeCaps,
  roomCapability,
  orderedRoomIds,
  powerPicture,
  RES_KEYS,
};
