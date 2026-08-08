/**
 * build.js — excavation, placement, merging, upgrades, demolition.
 *
 * Every operation is split into a `canX()` that returns a reason string when
 * it can't, and a `doX()` that returns actions. The UI shows the reason
 * verbatim, which is why the reasons are written as sentences a person would
 * say rather than error codes (spec §15: failure states explain and offer the
 * fix).
 *
 * Merging is the interesting one. Building a room adjacent to an identical
 * room of the same level absorbs it into a wider unit, up to three slots.
 * Wider units produce more per slot and draw less power per slot, so floor
 * layout is a real puzzle rather than a filing exercise.
 */

import { BAL } from '../config/balance.js';
import { getRoom, ROOM_LIST } from '../data/rooms.js';
import { roomUnlocked, tierUnlocked, tierForFloor, effects } from './research.js';

// ------------------------------------------------------------ excavation ---

/** Cost of digging the next floor. Scales with how much you've already dug. */
export function excavationCost(state) {
  const dug = state.silo.floors.filter((f) => f.excavated).length;
  const growth = Math.pow(BAL.silo.excavation.growth, dug - BAL.silo.startExcavatedFloors);
  const next = nextFloorToExcavate(state);
  const cost = {
    scrap: Math.round(BAL.silo.excavation.baseScrap * growth),
    labor: Math.round(BAL.silo.excavation.baseLabor * growth),
  };
  if (next && next >= BAL.silo.excavation.shoringRequiredBelowFloor) {
    const e = effects(state);
    const discount = 1 + (e.shoringCost || 0);
    cost.alloy = Math.max(1, Math.round(BAL.silo.excavation.shoringAlloyPerFloor * discount));
  }
  return cost;
}

export function nextFloorToExcavate(state) {
  for (let i = 0; i < state.silo.floors.length; i++) {
    if (!state.silo.floors[i].excavated) return i + 1;
  }
  return null;
}

export function canExcavate(state) {
  if (state.silo.excavating) return { ok: false, reason: 'A dig is already under way.' };
  const n = nextFloorToExcavate(state);
  if (n == null) return { ok: false, reason: 'Every floor is already open.' };

  const tier = tierForFloor(n);
  if (!tierUnlocked(state, tier.key)) {
    const gate = BAL.silo.tiers.find((t) => t.key === tier.key)?.gate;
    return {
      ok: false,
      reason: `Floor ${n} is in the ${tier.name}. Research ${gate ? gate.replace(/_/g, ' ') : 'the next excavation tier'} first.`,
    };
  }

  const cost = excavationCost(state);
  const short = shortfall(state, cost);
  if (short) return { ok: false, reason: `Not enough ${short}. Digging floor ${n} needs ${describeCost(cost)}.` };

  return { ok: true, floor: n, cost };
}

export function startExcavation(state) {
  const check = canExcavate(state);
  if (!check.ok) return [];
  const cycles = Math.max(2, Math.round(check.cost.labor / BAL.silo.excavation.ticksPerLaborHour / 10));
  const deltas = {};
  for (const [k, v] of Object.entries(check.cost)) {
    if (k === 'labor') continue;
    deltas[k] = -v;
  }
  return [
    { type: 'RESOURCE_DELTA', deltas },
    {
      type: 'EXCAVATION_START',
      floor: check.floor,
      untilCycle: state.clock.cycle + cycles,
    },
    {
      type: 'LOG',
      entry: { kind: 'alert', text: `Excavation of floor ${check.floor} has begun. Expected: ${cycles} shifts.` },
    },
  ];
}

// ------------------------------------------------------------- placement ---

/** Every room type the player could build right now, with a reason if not. */
export function buildable(state, floorN) {
  const tier = tierForFloor(floorN);
  return ROOM_LIST.map((def) => {
    const unlocked = roomUnlocked(state, def);
    const tierOk = !def.tierGate || tierUnlocked(state, def.tierGate);
    const tierMatch = !def.tierGate || tierForFloor(floorN).key === def.tierGate ||
      tierIndex(tierForFloor(floorN).key) >= tierIndex(def.tierGate);
    let reason = null;
    if (!unlocked) reason = `Needs research: ${(def.unlock || '').replace(/_/g, ' ')}.`;
    else if (!tierOk) reason = `Needs the ${def.tierGate} excavated.`;
    else if (!tierMatch) reason = `Only builds in the ${def.tierGate} or below.`;
    else {
      const short = shortfall(state, def.buildCost);
      if (short) reason = `Not enough ${short}.`;
    }
    return { def, ok: !reason, reason, tier };
  });
}

function tierIndex(key) {
  return BAL.silo.tiers.findIndex((t) => t.key === key);
}

/**
 * Where a room of this type can go on this floor, and what merging would
 * happen if it did. Returns one entry per legal starting slot.
 */
export function placements(state, floorN, typeId) {
  const def = getRoom(typeId);
  const floor = state.silo.floors[floorN - 1];
  if (!def || !floor || !floor.excavated) return [];

  const out = [];
  for (let slot = 0; slot < BAL.silo.slotsPerFloor; slot++) {
    const fit = fitsAt(state, floor, def, slot);
    if (fit) out.push(fit);
  }
  return out;
}

/**
 * Can a 1-wide unit of `def` start at `slot`? Returns the placement, with
 * the room it would merge into if there is one.
 */
function fitsAt(state, floor, def, slot) {
  const occupant = floor.slots[slot];
  if (occupant != null) return null;

  // Look for an identical neighbour to merge with.
  let merge = null;
  if (def.canMerge) {
    for (const adj of [slot - 1, slot + 1]) {
      if (adj < 0 || adj >= BAL.silo.slotsPerFloor) continue;
      const id = floor.slots[adj];
      if (id == null) continue;
      const neighbour = state.silo.rooms[id];
      if (!neighbour || neighbour.type !== def.id) continue;
      if (neighbour.width >= BAL.silo.merge.maxWidth) continue;
      // Merging must not skip a slot: the neighbour has to be contiguous.
      const wouldSpan = adj < slot ? neighbour.slot : slot;
      const wouldWidth = neighbour.width + 1;
      if (wouldSpan + wouldWidth > BAL.silo.slotsPerFloor) continue;
      merge = { roomId: id, newSlot: wouldSpan, newWidth: wouldWidth };
      break;
    }
  }

  return {
    floor: floor.n,
    slot,
    merge,
    label: merge
      ? `Merge into the ${def.name} beside it — ${merge.newWidth} wide`
      : `New ${def.name}`,
  };
}

export function canBuild(state, floorN, slot, typeId) {
  const def = getRoom(typeId);
  if (!def) return { ok: false, reason: 'No such room.' };
  const floor = state.silo.floors[floorN - 1];
  if (!floor) return { ok: false, reason: 'No such floor.' };
  if (!floor.excavated) return { ok: false, reason: `Floor ${floorN} has not been excavated.` };
  if (!roomUnlocked(state, def)) {
    return { ok: false, reason: `${def.name} needs research: ${(def.unlock || '').replace(/_/g, ' ')}.` };
  }
  if (def.tierGate && !tierUnlocked(state, def.tierGate)) {
    return { ok: false, reason: `${def.name} needs the ${def.tierGate} opened first.` };
  }
  if (def.tierGate && tierIndex(tierForFloor(floorN).key) < tierIndex(def.tierGate)) {
    return { ok: false, reason: `${def.name} belongs in the ${def.tierGate}, not up here.` };
  }
  if (floor.slots[slot] != null) return { ok: false, reason: 'That bay is occupied.' };

  const short = shortfall(state, def.buildCost);
  if (short) {
    return { ok: false, reason: `Not enough ${short}. ${def.name} costs ${describeCost(def.buildCost)}.` };
  }
  return { ok: true };
}

export function build(state, floorN, slot, typeId) {
  const check = canBuild(state, floorN, slot, typeId);
  if (!check.ok) return [];
  const def = getRoom(typeId);
  const floor = state.silo.floors[floorN - 1];
  const place = fitsAt(state, floor, def, slot);

  const deltas = {};
  for (const [k, v] of Object.entries(def.buildCost)) deltas[k] = -v;
  const cycles = buildCycles(def);
  const actions = [{ type: 'RESOURCE_DELTA', deltas }];

  if (place?.merge) {
    const target = state.silo.rooms[place.merge.roomId];
    actions.push({
      type: 'ROOM_MERGE',
      id: target.id,
      slot: place.merge.newSlot,
      width: place.merge.newWidth,
      claimSlot: slot,
      // Merging into a running room shouldn't take it offline; the new bay
      // comes up on its own schedule.
      untilCycle: state.clock.cycle + cycles,
    });
    actions.push({
      type: 'LOG',
      entry: {
        kind: 'alert',
        text: `Extending the ${def.name} on floor ${floorN} to ${place.merge.newWidth} bays.`,
      },
    });
  } else {
    actions.push({
      type: 'ROOM_BUILD',
      room: {
        type: typeId,
        floor: floorN,
        slot,
        width: 1,
        level: 1,
        condition: BAL.silo.condition.start,
        staff: [],
        powered: true,
        buildingUntilCycle: state.clock.cycle + cycles,
        upgradingUntilCycle: 0,
      },
    });
    actions.push({
      type: 'LOG',
      entry: { kind: 'alert', text: `Construction started: ${def.name}, floor ${floorN}.` },
    });
  }
  return actions;
}

export function buildCycles(def) {
  const total = Object.values(def.buildCost).reduce((a, b) => a + b, 0);
  return Math.max(2, Math.round(total / 40));
}

// --------------------------------------------------------------- upgrade ---

export function upgradeCost(room) {
  const step = room.level - 1;
  return {
    scrap: Math.round(BAL.silo.upgrade.scrapBase * Math.pow(BAL.silo.upgrade.scrapGrowth, step) * room.width),
    chits: Math.round(BAL.silo.upgrade.chitsBase * Math.pow(BAL.silo.upgrade.chitsGrowth, step) * room.width),
  };
}

export function canUpgrade(state, roomId) {
  const room = state.silo.rooms[roomId];
  if (!room) return { ok: false, reason: 'No such room.' };
  if (room.level >= BAL.silo.upgrade.maxLevel) {
    return { ok: false, reason: 'Already at maximum level.' };
  }
  if (room.upgradingUntilCycle > state.clock.cycle) {
    return { ok: false, reason: 'Already being upgraded.' };
  }
  if (room.buildingUntilCycle > state.clock.cycle) {
    return { ok: false, reason: 'Still under construction.' };
  }
  const cost = upgradeCost(room);
  const short = shortfall(state, cost);
  if (short) return { ok: false, reason: `Not enough ${short}. This upgrade costs ${describeCost(cost)}.`, cost };
  return { ok: true, cost };
}

export function upgrade(state, roomId) {
  const check = canUpgrade(state, roomId);
  if (!check.ok) return [];
  const room = state.silo.rooms[roomId];
  const def = getRoom(room.type);
  const deltas = {};
  for (const [k, v] of Object.entries(check.cost)) deltas[k] = -v;
  return [
    { type: 'RESOURCE_DELTA', deltas },
    {
      type: 'ROOM_PATCH',
      id: roomId,
      patch: { upgradingUntilCycle: state.clock.cycle + BAL.silo.upgrade.downtimeCycles },
    },
    {
      type: 'LOG',
      entry: {
        kind: 'alert',
        text: `${def.name} on floor ${room.floor} is being upgraded to level ${room.level + 1}. Offline for ${BAL.silo.upgrade.downtimeCycles} shifts.`,
      },
    },
  ];
}

// ------------------------------------------------------------- demolish ---

export function canDemolish(state, roomId) {
  const room = state.silo.rooms[roomId];
  if (!room) return { ok: false, reason: 'No such room.' };
  const def = getRoom(room.type);

  // Refuse to remove the last of anything the silo cannot live without.
  const critical = { water_reclaimer: 'water', air_filtration: 'air', generator_hall: 'power' };
  if (critical[room.type]) {
    const others = Object.values(state.silo.rooms).filter(
      (r) => r.type === room.type && r.id !== roomId
    );
    const hasReactor = room.type === 'generator_hall' &&
      Object.values(state.silo.rooms).some((r) => r.type === 'reactor');
    if (!others.length && !hasReactor) {
      return {
        ok: false,
        reason: `This is the only ${def.name}. Removing it ends the silo's ${critical[room.type]} supply. Build another first.`,
      };
    }
  }
  return { ok: true, refund: refundFor(def) };
}

function refundFor(def) {
  const out = {};
  for (const [k, v] of Object.entries(def.buildCost)) out[k] = Math.round(v * 0.4);
  return out;
}

export function demolish(state, roomId) {
  const check = canDemolish(state, roomId);
  if (!check.ok) return [];
  const room = state.silo.rooms[roomId];
  const def = getRoom(room.type);
  return [
    { type: 'RESOURCE_DELTA', deltas: check.refund },
    { type: 'ROOM_REMOVE', id: roomId },
    {
      type: 'LOG',
      entry: { kind: 'alert', text: `${def.name} on floor ${room.floor} has been stripped out. Salvage recovered.` },
    },
  ];
}

// ---------------------------------------------------------------- daily ---

/**
 * Structural risk. Unshored deep floors can collapse; rooms at zero
 * condition can breach. Both are per-day rolls (spec §4).
 */
export function simulateDay(state, rng) {
  const actions = [];
  const e = effects(state);
  const resist = 1 - (e.collapseResist || 0);

  for (const floor of state.silo.floors) {
    if (!floor.excavated || floor.shored) continue;
    if (floor.n < BAL.silo.excavation.shoringRequiredBelowFloor) continue;
    const load = Object.values(state.silo.rooms).filter((r) => r.floor === floor.n).length;
    if (load === 0) continue;
    if (rng.chance(BAL.silo.excavation.collapseChancePerDayUnshored * resist * load)) {
      actions.push({ type: 'FLOOR_PATCH', n: floor.n, patch: { integrity: Math.max(0, floor.integrity - 35) } });
      actions.push({
        type: 'LOG',
        entry: {
          kind: 'alert',
          text: `Partial collapse on floor ${floor.n}. It was never shored, and it is carrying ${load} rooms.`,
        },
      });
    }
  }

  for (const room of Object.values(state.silo.rooms)) {
    if (room.condition > BAL.silo.condition.failAt) continue;
    if (!rng.chance(BAL.silo.condition.breachChancePerDayAtZero)) continue;
    const def = getRoom(room.type);
    actions.push({
      type: 'LOG',
      entry: {
        kind: 'alert',
        text: `${def?.name || room.type} on floor ${room.floor} has failed completely. It will need rebuilding.`,
      },
    });
    actions.push({ type: 'ROOM_PATCH', id: room.id, patch: { condition: 0, breached: true } });
  }

  return actions;
}

// ---------------------------------------------------------------- helpers ---

/** Name of the first resource the player is short of, or null. */
export function shortfall(state, cost) {
  for (const [k, v] of Object.entries(cost || {})) {
    if (k === 'labor') continue;
    if ((state.resources[k] || 0) < v) return k;
  }
  return null;
}

export function describeCost(cost) {
  return Object.entries(cost)
    .filter(([k]) => k !== 'labor')
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
}

export function affordable(state, cost) {
  return !shortfall(state, cost);
}

export default { build, canBuild, upgrade, canUpgrade, demolish, startExcavation, canExcavate, placements, buildable };
