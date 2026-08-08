/**
 * economy.js — per-cycle production and consumption.
 *
 * Resolves once per cycle (spec §3.3), never per tick. The order below is
 * load-bearing and shouldn't be shuffled:
 *
 *   1. caps        — depots decide how much of anything you can hold
 *   2. capability  — staffing, condition, level and merge multipliers
 *   3. power       — generation vs demand, then brown out from the bottom
 *                    of the player's priority list up
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

const RES_KEYS = [
  'power', 'water', 'food', 'meds', 'scrap', 'alloy',
  'ammo', 'chits', 'filters', 'parts', 'fuel', 'ore', 'coolant',
];

export { RES_KEYS };

// ------------------------------------------------------------------ caps ---

export function computeCaps(state) {
  const caps = { ...BAL.resources.baseCaps };
  for (const id of Object.keys(state.silo.rooms)) {
    const room = state.silo.rooms[id];
    const def = getRoom(room.type);
    if (!def) continue;
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
 * How well a room can actually run right now, ignoring power.
 * Returns 0..~2. Zero means it produces nothing this cycle.
 */
export function roomCapability(state, room) {
  const def = getRoom(room.type);
  if (!def) return 0;
  if (room.buildingUntilCycle && state.clock.cycle < room.buildingUntilCycle) return 0;
  if (room.condition <= BAL.silo.condition.failAt) return 0;

  // Condition penalty only bites below the threshold, then scales to zero.
  const cond =
    room.condition >= BAL.silo.condition.penaltyBelow
      ? 1
      : room.condition / BAL.silo.condition.penaltyBelow;

  const level = 1 + (room.level - 1) * BAL.silo.upgrade.outputPerLevel;
  const mergeSteps = room.width - 1;
  const merge = room.width * (1 + mergeSteps * BAL.silo.merge.efficiencyPerStep);

  if (!def.staff) return cond * level * merge;

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
  return cond * level * merge * staffing;
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
  const base = def.consumes.power * room.width * discount * level;
  // A room nobody is crewing still keeps its lights on.
  return capability > 0 ? base : base * 0.25;
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
  const roomIds = Object.keys(state.silo.rooms);
  const capability = {};
  const draw = {};
  let generation = 0;

  for (const id of roomIds) {
    const room = state.silo.rooms[id];
    const def = getRoom(room.type);
    if (!def) continue;
    const cap = roomCapability(state, room);
    capability[id] = cap;
    draw[id] = roomDraw(state, room, cap);
  }

  // ---- 2. generation. Generators are never browned out — they're the
  //         source — but they do stop if they run dry. -------------------
  const generators = roomIds.filter((id) => (getRoom(state.silo.rooms[id].type)?.produces || {}).power);
  let fuelAvailable = res.fuel;
  let coolantAvailable = res.coolant;

  for (const id of generators) {
    const room = state.silo.rooms[id];
    const def = getRoom(room.type);
    const cap = capability[id];
    if (cap <= 0) {
      room.__running = false;
      continue;
    }
    // Consumption scales with capability, which already folds in width,
    // level and staffing. Multiplying by width again would double-count it.
    const fuelWant = (def.consumes.fuel || 0) * cap;
    const coolWant = (def.consumes.coolant || 0) * cap;
    if (fuelWant > fuelAvailable || coolWant > coolantAvailable) {
      capability[id] = 0;
      continue;
    }
    fuelAvailable -= fuelWant;
    coolantAvailable -= coolWant;
    bump('fuel', -fuelWant);
    bump('coolant', -coolWant);
    const out = def.produces.power * cap;
    generation += out;
    flows.power.in += out;
  }

  // ---- 3. brownout. Walk the player's priority list top down. -----------
  const battery = Math.min(res.power, BAL.power.batteryDischargePerCycle);
  let budget = generation + battery;
  const powered = {};
  let unpoweredCount = 0;

  const priority = orderedRoomIds(state, roomIds);
  for (const id of priority) {
    if (generators.includes(id)) {
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
    batteryDelta = Math.min(surplus, BAL.power.batteryChargePerCycle);
  } else {
    batteryDelta = Math.max(surplus, -BAL.power.batteryDischargePerCycle);
  }

  // ---- 4. throughput for everything that got power ----------------------
  let airCapacity = 0;
  let researchPoints = 0;
  let maintenance = 0;

  for (const id of roomIds) {
    const room = state.silo.rooms[id];
    const def = getRoom(room.type);
    if (!def) continue;
    const isGen = generators.includes(id);
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

    if (def.provides.research) {
      researchPoints +=
        BAL.research.pointsPerLabPerCycleBase * cap * (1 + state.research.bonus || 0);
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
      bump(k, -v * cap * ratio);
    }
    for (const [k, v] of Object.entries(def.produces)) {
      if (k === 'power') continue; // charged above
      bump(k, v * cap * ratio);
    }
  }

  bump('power', batteryDelta);

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
  const wear = [];
  for (const id of roomIds) {
    const room = state.silo.rooms[id];
    const running = powered[id] && capability[id] > 0;
    let d = running
      ? -BAL.silo.condition.decayPerCycleWorking * room.width
      : -BAL.silo.condition.decayPerCycleIdle * room.width;
    d *= crewWearFactor(state, room);
    wear.push({ id, delta: d });
  }
  if (maintenance > 0) {
    // Maintenance spreads across whatever is worst first.
    const worst = wear
      .map((w) => ({ w, cond: state.silo.rooms[w.id].condition }))
      .sort((a, b) => a.cond - b.cond)
      .slice(0, 4);
    const share = maintenance / Math.max(1, worst.length);
    for (const { w } of worst) w.delta += share;
  }

  // ---- emit --------------------------------------------------------------
  actions.push({ type: 'RESOURCE_DELTA', deltas, caps, emit: false });
  actions.push({ type: 'POWER_STATE', powered, brownout, generation, demand: flows.power.out, emit: false });
  actions.push({ type: 'AIR_DELTA', delta: airDelta, capacity: airCapacity, load, emit: false });
  actions.push({ type: 'CONDITION_DELTA', wear, emit: false });
  actions.push({ type: 'FLOWS_SET', flows, emit: false });
  if (researchPoints > 0) actions.push({ type: 'RESEARCH_POINTS', amount: researchPoints, emit: false });

  return actions;
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
  const seen = new Set();
  const out = [];
  for (const id of explicit) {
    if (state.silo.rooms[id]) {
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

function clampMag(v, mag) {
  return v > mag ? mag : v < -mag ? -mag : v;
}

/** Human-readable per-cycle net for the resource bar. */
export function netFlow(state, key) {
  const f = state.flows?.[key];
  if (!f) return 0;
  return f.in - f.out;
}

export default { simulateCycle, computeCaps, roomCapability, orderedRoomIds, RES_KEYS };
