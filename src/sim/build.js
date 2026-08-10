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
import { fullName } from './population.js';

// ------------------------------------------------------------ excavation ---

/** Cost of digging the next floor. Scales with how much you've already dug. */
export function excavationCost(state) {
  const next = nextFloorToExcavate(state);
  if (next == null) return { scrap: 0, labor: 0 };
  const tier = tierForFloor(next);
  const tierIdx = BAL.silo.tiers.findIndex((t) => t.key === tier.key);
  // Depth from the top, not depth into the current tier.
  //
  // It used to compound within a tier and reset at every boundary, with a
  // multiplier per tier meant to make up the difference. It did not: floor 14
  // cost 123 scrap and floor 15 cost 88, floor 58 cost 1405 and floor 59 cost
  // 426. Digging got *cheaper* four times on the way down, each time the silo
  // reached somewhere it had needed a research node to reach — so the deeper
  // the silo went the less each floor was worth thinking about, which is the
  // opposite of a decision.
  //
  // Compounding on absolute depth cannot do that: every floor costs more than
  // the one above it, and a tier boundary is a step on top rather than a
  // reset. The growth rate is correspondingly gentler, because it now applies
  // over ninety-two floors instead of restarting five times.
  const growth =
    Math.pow(BAL.silo.excavation.growth, next - 1) *
    Math.pow(BAL.silo.excavation.tierMultiplier, tierIdx);
  const cost = {
    scrap: Math.round(BAL.silo.excavation.baseScrap * growth),
    labor: Math.round(BAL.silo.excavation.baseLabor * growth),
  };
  if (next && next >= BAL.silo.excavation.shoringRequiredBelowFloor) {
    const e = effects(state);
    const discount = 1 + (e.shoringCost || 0);
    // Shoring scales with the tier, not flat. A fixed six alloy a floor is a
    // rounding error by the time a silo is deep enough to be charged it, which
    // left nothing but scrap gating the descent — and scrap cannot gate it
    // without the store becoming the late game. This is what makes the bottom
    // of the silo compete with the surface for the same alloy.
    const step = Math.pow(BAL.silo.excavation.tierMultiplier, tierIdx);
    cost.alloy = Math.max(1, Math.round(BAL.silo.excavation.shoringAlloyPerFloor * step * discount));
  }
  return cost;
}

export function nextFloorToExcavate(state) {
  const limit = Math.min(state.silo.floors.length, BAL.silo.reachableFloors);
  for (let i = 0; i < limit; i++) {
    if (!state.silo.floors[i].excavated) return i + 1;
  }
  return null;
}

export function canExcavate(state) {
  if (state.silo.excavating) return { ok: false, reason: 'A dig is already under way.' };
  const n = nextFloorToExcavate(state);
  if (n == null) {
    // Two different silences. One is a silo that has opened everything it can
    // reach; the other is one that has run out of stair, with levels still
    // drawn underneath it. Saying "every floor is already open" while a
    // hundred and thirty dark doors are on screen is the game lying.
    const opened = state.silo.floors.filter((f) => f.excavated).length;
    if (opened >= BAL.silo.reachableFloors && BAL.silo.reachableFloors < BAL.silo.totalFloors) {
      return {
        ok: false,
        reason:
          `The stair ends at floor ${BAL.silo.reachableFloors}. Whatever is below it was ` +
          'sealed from the other side, and nothing the silo currently has will open it.',
      };
    }
    return { ok: false, reason: 'Every floor is already open.' };
  }

  const tier = tierForFloor(n);
  if (!tierUnlocked(state, tier.key)) {
    const gate = BAL.silo.tiers.find((t) => t.key === tier.key)?.gate;
    return {
      ok: false,
      // Named, not just described: callers that want to *act* on this — the
      // standing order, for one — need the node id, not prose about it.
      needsResearch: gate || null,
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
  const cycles = Math.max(
    2,
    Math.min(
      BAL.silo.excavation.maxDigCycles,
      Math.round(check.cost.labor / BAL.silo.excavation.ticksPerLaborHour / 10)
    )
  );
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

/**
 * The whole room catalogue, judged against the silo rather than against one
 * floor.
 *
 * Construction is pick-then-place: the player chooses a building and only then
 * a bay, so the question this answers is "could this go anywhere at all?" — and
 * when the answer is no, `reason` is the single sentence the panel prints
 * underneath it (spec §15). `bays` is how many legal spots it has right now,
 * which is what the cross-section is about to light up.
 */
export function catalogue(state) {
  return ROOM_LIST.map((def) => {
    let reason = null;
    let bays = 0;

    if (!roomUnlocked(state, def)) {
      reason = `Needs research: ${(def.unlock || '').replace(/_/g, ' ')}.`;
    } else if (def.tierGate && !tierUnlocked(state, def.tierGate)) {
      reason = `Needs the ${tierName(def.tierGate)} excavated.`;
    } else {
      const short = shortfall(state, def.buildCost);
      if (short) reason = `Not enough ${short}. It costs ${describeCost(def.buildCost)}.`;
      else {
        bays = allPlacements(state, def.id).length;
        if (!bays) {
          reason = def.tierGate
            ? `Every bay in the ${tierName(def.tierGate)} is already taken. Dig deeper.`
            : 'Every bay in the silo is already taken. Excavate another floor.';
        }
      }
    }
    return { def, ok: !reason, reason, bays };
  });
}

/**
 * Every legal placement for a room type, across every floor that will take it.
 * This is what the cross-section highlights while the player is placing.
 */
export function allPlacements(state, typeId) {
  const def = getRoom(typeId);
  if (!def) return [];
  const out = [];
  for (const floor of state.silo.floors) {
    if (!floor.excavated) continue;
    if (!floorAcceptsRoom(state, floor.n, def)) continue;
    for (const spot of placements(state, floor.n, typeId)) out.push(spot);
  }
  return out;
}

/** Deep-tier rooms belong deep: a floor above their tier will not take them. */
export function floorAcceptsRoom(state, floorN, def) {
  if (!def?.tierGate) return true;
  if (!tierUnlocked(state, def.tierGate)) return false;
  return tierIndex(tierForFloor(floorN).key) >= tierIndex(def.tierGate);
}

function tierIndex(key) {
  return BAL.silo.tiers.findIndex((t) => t.key === key);
}

function tierName(key) {
  return BAL.silo.tiers.find((t) => t.key === key)?.name || key;
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

// --------------------------------------------------------------- repair ---

/**
 * Restore a room's condition directly, for scrap and parts.
 *
 * The Maintenance Bay handles ordinary wear across the silo, but it cannot
 * pull a sabotaged generator back from 28 before the lights go out — and
 * without this the player would watch a critical room die with no lever to
 * touch. Repair is that lever: expensive, immediate, and always available.
 */
/**
 * What a room of a given width actually cost to put up.
 *
 * Building charges `buildCost` once for the room at its natural width, and
 * once more for each merge step past it. So a three-wide Storage Depot (base
 * one) was paid for three times, while a three-wide Reactor (base three) was
 * paid for once. Width on its own does not tell you the price, which is the
 * trap the repair and salvage prices below both fell into.
 */
export function buildCostFor(def, width) {
  const base = def?.buildCost || { scrap: 50 };
  const natural = def?.width || 1;
  const steps = Math.max(1, (width || natural) - natural + 1);
  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = v * steps;
  return out;
}

/** Cost of restoring `points` of condition. Priced off the room's build cost. */
export function repairCost(room, points) {
  const def = getRoom(room.type);
  const share = (points / BAL.silo.condition.start) * BAL.silo.repair.fractionOfBuildCost;
  const out = {};
  // Against what the room cost, not against how many slots it covers. Charging
  // per slot made a full restore of a base-three room 149% of building a new
  // one, so the cheapest way to fix a wrecked Reactor was to demolish it and
  // start again — the exact opposite of what `fractionOfBuildCost` promises.
  for (const [k, v] of Object.entries(buildCostFor(def, room.width))) {
    const amount = Math.ceil(v * share);
    if (amount > 0) out[k] = amount;
  }
  return out;
}

/**
 * How much of a room the silo can currently afford to fix. Partial repair
 * matters: a sabotaged generator at 28 condition has to be improvable with
 * whatever is in the store, not only with the full amount.
 */
export function affordableRepairPoints(state, room) {
  const missing = BAL.silo.condition.start - room.condition;
  if (missing < 1) return 0;
  // Binary search would be overkill; the cost is linear in points.
  const full = repairCost(room, missing);
  let ratio = 1;
  for (const [k, v] of Object.entries(full)) {
    if (v <= 0) continue;
    ratio = Math.min(ratio, (state.resources[k] || 0) / v);
  }
  return Math.floor(missing * Math.max(0, Math.min(1, ratio)));
}

export function canRepair(state, roomId) {
  const room = state.silo.rooms[roomId];
  if (!room) return { ok: false, reason: 'No such room.' };
  const missing = BAL.silo.condition.start - room.condition;
  if (missing < 1) return { ok: false, reason: 'Nothing to repair.' };
  const points = affordableRepairPoints(state, room);
  const fullCost = repairCost(room, missing);
  if (points < 1) {
    const short = shortfall(state, fullCost);
    return {
      ok: false,
      reason: `Not enough ${short}. A full repair costs ${describeCost(fullCost)}.`,
      cost: fullCost,
      missing,
    };
  }
  return {
    ok: true,
    cost: repairCost(room, points),
    fullCost,
    points,
    missing,
    partial: points < missing,
  };
}

export function repair(state, roomId, requestedPoints) {
  const check = canRepair(state, roomId);
  if (!check.ok) return [];
  const room = state.silo.rooms[roomId];
  const def = getRoom(room.type);
  const points = Math.max(1, Math.min(requestedPoints ?? check.points, check.points));
  const cost = repairCost(room, points);
  const deltas = {};
  for (const [k, v] of Object.entries(cost)) deltas[k] = -v;
  const next = Math.min(BAL.silo.condition.start, room.condition + points);
  return [
    { type: 'RESOURCE_DELTA', deltas },
    {
      type: 'ROOM_PATCH',
      id: roomId,
      // Brought all the way back, a found room stops being a discovery and
      // becomes an ordinary room of the silo — so the next time it falls, it
      // is an emergency like any other.
      patch: { condition: next, breached: false, ...(next >= BAL.silo.condition.start ? { found: false } : {}) },
    },
    {
      type: 'LOG',
      entry: {
        kind: 'alert',
        text:
          next >= BAL.silo.condition.start
            ? `${def?.name || room.type} on floor ${room.floor} has been repaired back to full condition.`
            : `${def?.name || room.type} on floor ${room.floor} patched up to ${Math.round(next)}. It needs more than you could spare.`,
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
  return { ok: true, refund: refundFor(def, room.width) };
}

function refundFor(def, width) {
  const out = {};
  // Salvage returns a share of what was spent, merges included — stripping out
  // a room somebody paid for three times should not refund a third of it.
  for (const [k, v] of Object.entries(buildCostFor(def, width))) out[k] = Math.round(v * 0.4);
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

// ------------------------------------------------------------ holding it ---

/** Rooms standing on a floor. */
function roomsOn(state, n) {
  return Object.values(state.silo.rooms).filter((r) => r.floor === n);
}

/** How much of a floor is carrying something. Empty floors hold themselves. */
function occupiedSlots(state, n) {
  return roomsOn(state, n).reduce((sum, r) => sum + r.width, 0);
}

/** Is this a floor the rock is still working on? */
function strains(floor) {
  return !!floor?.excavated && floor.n >= BAL.silo.excavation.shoringRequiredBelowFloor;
}

/** Integrity a floor loses in a day, before research resistance. */
function strainPerDay(state, floor, load) {
  const S = BAL.silo.strain;
  const tierIdx = BAL.silo.tiers.findIndex((t) => t.key === tierForFloor(floor.n).key);
  return (
    S.decayPerDayPerSlot *
    Math.pow(S.tierMultiplier, Math.max(0, tierIdx)) *
    (S.occupiedFloorBase + load * S.perSlot) *
    (floor.shored ? S.shoredMultiplier : 1)
  );
}

/**
 * The floor goes.
 *
 * Deliberately survivable. Everything standing on it is breached rather than
 * deleted — `breached` is a state the repair machinery already understands, so
 * a lost floor is an expensive morning and not a save the player has to walk
 * away from. What does not come back is the crew who were standing in it, and
 * the shoring, which has to be bought again before the floor is worth anything.
 */
function collapse(state, floor, rng) {
  const S = BAL.silo.strain;
  const actions = [
    { type: 'FLOOR_PATCH', n: floor.n, patch: { shored: false, integrity: 0 } },
    {
      type: 'LOG',
      entry: {
        kind: 'warn',
        text:
          `The shoring on floor ${floor.n} has failed and the floor has come down on itself. ` +
          'Everything on it is wrecked, and it will hold nothing until it is shored again.',
      },
    },
  ];

  for (const room of roomsOn(state, floor.n)) {
    const def = getRoom(room.type);
    actions.push({ type: 'ROOM_PATCH', id: room.id, patch: { condition: 0, breached: true } });
    actions.push({
      type: 'LOG',
      entry: { kind: 'alert', text: `${def?.name || room.type} on floor ${floor.n} was crushed. It can be rebuilt from what is left.` },
    });
    // Every death in this game is named and has a cause, so this rolls per
    // person rather than taking a shift wholesale.
    for (const cid of room.staff) {
      const c = state.citizens[cid];
      if (!c || c.status === 'dead') continue;
      if (!rng.chance(S.crewLostChance)) continue;
      // The cause is the bucket `stats.causes` counts, so it stays generic —
      // one key per floor would shatter the tally into "the collapse of floor
      // 110", "…of floor 136" and so on. The floor goes in the sentence
      // instead, which is also the only place it reads properly: the reducer
      // writes "<name>, <age>, died of <cause>." and a participle there gives
      // "died of crushed in the collapse of floor 110".
      actions.push({
        type: 'CITIZEN_DIE',
        id: cid,
        cause: 'a collapse',
        day: state.clock.day,
        text: `${fullName(c)}, ${Math.floor(c.age)}, was on floor ${floor.n} when it came down.`,
      });
    }
  }
  return actions;
}

/** What it costs to put the shoring back on an open floor. */
export function shoreCost(state, n) {
  const S = BAL.silo.strain;
  const tierIdx = BAL.silo.tiers.findIndex((t) => t.key === tierForFloor(n).key);
  const step = Math.pow(BAL.silo.excavation.tierMultiplier, Math.max(0, tierIdx));
  const discount = 1 + (effects(state).shoringCost || 0);
  return {
    alloy: Math.max(1, Math.round(BAL.silo.excavation.shoringAlloyPerFloor * step * S.reshoreAlloyMultiplier * discount)),
    scrap: Math.round(S.reshoreScrapPerFloor * step),
  };
}

export function canShore(state, n) {
  const floor = state.silo.floors[n - 1];
  if (!floor) return { ok: false, reason: 'No such floor.' };
  if (!floor.excavated) return { ok: false, reason: `Floor ${n} has not been opened.` };
  if (!strains(floor)) {
    return { ok: false, reason: `Floor ${n} is above the shoring line. The rock holds itself up here.` };
  }
  if (floor.shored && (floor.integrity ?? 100) >= BAL.silo.condition.start) {
    return { ok: false, reason: `The shoring on floor ${n} is sound.` };
  }
  const cost = shoreCost(state, n);
  const short = shortfall(state, cost);
  if (short) return { ok: false, reason: `Not enough ${short}. Shoring floor ${n} needs ${describeCost(cost)}.`, cost };
  return { ok: true, cost };
}

export function shoreFloor(state, n) {
  const check = canShore(state, n);
  if (!check.ok) return [];
  const deltas = {};
  for (const [k, v] of Object.entries(check.cost)) deltas[k] = -v;
  return [
    { type: 'RESOURCE_DELTA', deltas },
    { type: 'FLOOR_PATCH', n, patch: { shored: true, integrity: BAL.silo.condition.start } },
    {
      type: 'LOG',
      entry: { kind: 'alert', text: `Floor ${n} has been shored again. The supports are new and the floor is sound.` },
    },
  ];
}

/**
 * Floors the rock is winning against, worst first. The standing orders and the
 * cross-section both read this, so "which floor" only has one answer.
 */
export function strainedFloors(state) {
  const out = [];
  for (const floor of state.silo.floors) {
    if (!strains(floor)) continue;
    const load = occupiedSlots(state, floor.n);
    if (load === 0) continue;
    const integrity = Number.isFinite(floor.integrity) ? floor.integrity : 100;
    if (integrity >= BAL.silo.strain.warnBelow) continue;
    out.push({ n: floor.n, integrity, load, shored: !!floor.shored });
  }
  return out.sort((a, b) => a.integrity - b.integrity);
}

// ---------------------------------------------------------------- daily ---

/**
 * Structural risk. Deep floors carrying rooms wear their own shoring down;
 * rooms at zero condition can breach. Both are per-day (spec §4).
 */
export function simulateDay(state, rng) {
  const actions = [];
  const e = effects(state);
  const resist = 1 - (e.collapseResist || 0);

  for (const floor of state.silo.floors) {
    const load = occupiedSlots(state, floor.n);
    if (!strains(floor) || load === 0) continue;

    const before = Number.isFinite(floor.integrity) ? floor.integrity : 100;
    const after = Math.max(0, before - strainPerDay(state, floor, load) * resist);
    actions.push({ type: 'FLOOR_PATCH', n: floor.n, patch: { integrity: after } });

    // ---- the floor gives way --------------------------------------------
    if (after <= 0 && before > 0) {
      actions.push(...collapse(state, floor, rng));
      continue;
    }

    // ---- it starts working on what is standing on it ---------------------
    const S = BAL.silo.strain;
    if (after < S.strainBelow) {
      const bite = S.roomWearPerDay * (1 - after / S.strainBelow);
      for (const room of roomsOn(state, floor.n)) {
        actions.push({
          type: 'ROOM_PATCH',
          id: room.id,
          patch: { condition: Math.max(0, room.condition - bite) },
        });
      }
    }

    // ---- and it says so, once, on the way past each line ------------------
    for (const line of [S.strainBelow, S.warnBelow]) {
      if (before >= line && after < line) {
        actions.push({
          type: 'LOG',
          entry: {
            kind: 'warn',
            text:
              line === S.warnBelow
                ? `The shoring on floor ${floor.n} is working. It is carrying ${load} bays and the rock is taking them back — ` +
                  'shore it again before it starts pulling the rooms apart.'
                : `Floor ${floor.n} is coming apart around its own machinery. Everything on it is taking damage every day ` +
                  'until it is shored.',
          },
        });
      }
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

export default {
  build,
  canBuild,
  upgrade,
  canUpgrade,
  demolish,
  startExcavation,
  canExcavate,
  placements,
  allPlacements,
  catalogue,
};
