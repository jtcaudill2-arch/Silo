/**
 * military.js — squads, gear inventory, training, readiness.
 *
 * The strategic tension the spec asks for (§10) is that a standing army eats.
 * Soldiers draw food and a stipend, and every one of them is a body not in
 * hydroponics. That cost is charged here, per day, whether or not they ever
 * leave the silo.
 */

import { BAL } from '../config/balance.js';
import { getItem, bestCraftable, ITEM_LIST } from '../data/items.js';
import { getRoom } from '../data/rooms.js';
import { fullName } from './population.js';
import { effects as researchEffects } from './research.js';
import { SQUAD_NAMES } from '../data/names.js';

// ------------------------------------------------------------------ gear ---

export function craftableItems(state) {
  const e = researchEffects(state);
  return ITEM_LIST.filter((item) => {
    if (item.unlock && !state.research.completed.includes(item.unlock)) return false;
    const maxTier =
      item.kind === 'weapon' ? e.weaponTier || 1 :
      item.kind === 'armor' ? e.armorTier || 1 :
      e.suitTier || 0;
    return item.tier <= Math.max(1, maxTier);
  });
}

export function canCraft(state, itemId) {
  const item = getItem(itemId);
  if (!item) return { ok: false, reason: 'No such item.' };
  if (item.unlock && !state.research.completed.includes(item.unlock)) {
    return { ok: false, reason: `Needs research: ${item.unlock.replace(/_/g, ' ')}.` };
  }
  const needsRoom = item.kind === 'suit' ? 'suitCraft' : 'gearRepair';
  const hasRoom = Object.values(state.silo.rooms).some((r) => {
    const def = getRoom(r.type);
    return def?.provides?.[needsRoom] && r.powered && r.buildingUntilCycle === 0;
  });
  if (!hasRoom) {
    return {
      ok: false,
      reason: item.kind === 'suit' ? 'Needs a Suit Bay.' : 'Needs an Armory.',
    };
  }
  for (const [k, v] of Object.entries(item.craft)) {
    if ((state.resources[k] || 0) < v) return { ok: false, reason: `Not enough ${k}.` };
  }
  return { ok: true };
}

export function craft(state, itemId) {
  const check = canCraft(state, itemId);
  if (!check.ok) return [];
  const item = getItem(itemId);
  const deltas = {};
  for (const [k, v] of Object.entries(item.craft)) deltas[k] = -v;
  return [
    { type: 'RESOURCE_DELTA', deltas },
    { type: 'GEAR_CRAFT', item: itemId },
    { type: 'LOG', entry: { kind: 'plain', text: `${item.name} finished and racked.` } },
  ];
}

export function gearStorageCap(state) {
  let cap = 0;
  for (const room of Object.values(state.silo.rooms)) {
    const def = getRoom(room.type);
    if (def?.provides?.gearStorage) cap += def.provides.gearStorage * room.level * room.width;
  }
  return cap;
}

export function unassignedGear(state, kind) {
  return Object.values(state.military.gear).filter(
    (g) => !g.assignedTo && (!kind || getItem(g.item)?.kind === kind)
  );
}

/** Give a citizen the best available piece in each slot. */
export function equipBest(state, citizenId) {
  const actions = [];
  const c = state.citizens[citizenId];
  if (!c) return actions;
  for (const kind of ['weapon', 'armor', 'suit']) {
    if (c.gear?.[kind]) continue;
    const pool = unassignedGear(state, kind);
    if (!pool.length) continue;
    pool.sort((a, b) => (getItem(b.item)?.tier ?? 0) - (getItem(a.item)?.tier ?? 0) || b.durability - a.durability);
    actions.push({ type: 'GEAR_ASSIGN', gearId: pool[0].id, citizenId, slot: kind });
  }
  return actions;
}

// ---------------------------------------------------------------- squads ---

export function canFormSquad(state) {
  if (state.military.squadIds.length >= BAL.military.maxSquads) {
    return { ok: false, reason: `Already running ${BAL.military.maxSquads} squads.` };
  }
  return { ok: true };
}

export function formSquad(state, name) {
  const check = canFormSquad(state);
  if (!check.ok) return [];
  const used = new Set(state.military.squadIds.map((id) => state.military.squads[id].name));
  const auto = SQUAD_NAMES.find((n) => !used.has(n)) || `Squad ${state.military.nextSquadId}`;
  return [{ type: 'SQUAD_CREATE', name: name || auto }];
}

export function squadMembers(state, squadId) {
  const sq = state.military.squads[squadId];
  if (!sq) return [];
  return sq.members.map((id) => state.citizens[id]).filter((c) => c && c.status !== 'dead');
}

/**
 * Readiness, 0-1. A weighted blend of training, equipment, health, morale and
 * whether there is ammunition in the armoury (spec §10).
 */
export function readiness(state, squadId) {
  const sq = state.military.squads[squadId];
  if (!sq) return 0;
  const members = squadMembers(state, squadId);
  if (!members.length) return 0;
  const W = BAL.military.readinessWeights;

  const training = avg(members.map((c) => (c.skills.combat || 0) / 100));
  const health = avg(members.map((c) => c.health / 100));
  const morale = avg(members.map((c) => c.morale / 100));

  const equipment = avg(
    members.map((c) => {
      let score = 0;
      const w = c.gear?.weapon ? state.military.gear[c.gear.weapon] : null;
      const a = c.gear?.armor ? state.military.gear[c.gear.armor] : null;
      if (w) score += 0.6 * ((getItem(w.item)?.tier ?? 1) / 4) * (w.durability / 100);
      if (a) score += 0.4 * ((getItem(a.item)?.tier ?? 1) / 4) * (a.durability / 100);
      return score;
    })
  );

  const ammoNeed = members.length * BAL.expedition.supplies.ammoPerMemberPerDay * 3;
  const ammo = Math.min(1, state.resources.ammo / Math.max(1, ammoNeed));

  return (
    training * W.training +
    equipment * W.equipment +
    health * W.health +
    morale * W.morale +
    ammo * W.ammo
  );
}

/** Squad power for the risk preview, without rolling anything. */
export function squadPower(state, squadId) {
  // Imported lazily to avoid a cycle: combat imports population, not military.
  const members = squadMembers(state, squadId);
  if (!members.length) return 0;
  let total = 0;
  for (const c of members) {
    const gear = c.gear || {};
    const weapon = gear.weapon ? state.military.gear[gear.weapon] : null;
    const armor = gear.armor ? state.military.gear[gear.armor] : null;
    const wTier = weapon ? getItem(weapon.item)?.tier ?? 1 : 0;
    const aTier = armor ? getItem(armor.item)?.tier ?? 1 : 0;
    const base =
      c.stats.str * BAL.combat.weights.str +
      c.stats.agi * BAL.combat.weights.agi +
      (c.skills.combat || 0) * BAL.combat.weights.combat;
    total +=
      base *
      (BAL.combat.gearTierMult[Math.max(0, wTier - 1)] ?? 0.8) *
      (1 + aTier * BAL.combat.armorPerTier) *
      (c.health / 100) *
      (c.vitality / 100);
  }
  return total;
}

// ------------------------------------------------------------------ daily ---

/**
 * The standing army's upkeep, and training. Charged every day, deployed or
 * not — that's the whole strategic cost of the militarist path.
 */
export function simulateDay(state) {
  const actions = [];
  let soldiers = 0;
  const patches = [];

  const trainingRooms = Object.values(state.silo.rooms).filter((r) => {
    const def = getRoom(r.type);
    return def?.provides?.training && r.powered && r.buildingUntilCycle === 0;
  });
  const trainingCapacity = trainingRooms.reduce((n, r) => n + r.level * r.width * 2, 0);
  let trained = 0;

  for (const squadId of state.military.squadIds) {
    const sq = state.military.squads[squadId];
    if (!sq) continue;
    const members = squadMembers(state, squadId);
    soldiers += members.length;

    if (sq.assignment === 'training' && trainingCapacity > 0) {
      for (const c of members) {
        if (trained >= trainingCapacity) break;
        if (state.resources.ammo < BAL.military.trainingAmmoPerDay) break;
        trained++;
        patches.push({
          id: c.id,
          skills: {
            ...c.skills,
            combat: Math.min(BAL.citizens.skillMax, (c.skills.combat || 0) + BAL.military.trainingSkillPerDay),
          },
        });
      }
    }

    if (sq.assignment === 'garrison') {
      actions.push({
        type: 'ORDER_DELTA',
        amount: BAL.military.garrisonOrderBonusPerSquad,
        reason: 'garrison presence',
        emit: false,
      });
    }
  }

  if (patches.length) actions.push({ type: 'CITIZENS_PATCH', patches, emit: false });

  if (soldiers > 0) {
    const deltas = {
      food: -soldiers * BAL.military.barracksFoodPerSoldierPerDay,
      chits: -soldiers * BAL.military.stipendChitsPerSoldierPerDay,
    };
    if (trained > 0) deltas.ammo = -(trained * BAL.military.trainingAmmoPerDay);
    actions.push({ type: 'RESOURCE_DELTA', deltas, emit: false });
  }

  return actions;
}

/** Per-cycle armoury repair of worn gear. */
export function simulateCycle(state) {
  const armories = Object.values(state.silo.rooms).filter((r) => {
    const def = getRoom(r.type);
    return def?.provides?.gearRepair && r.powered && r.staff.length > 0;
  });
  if (!armories.length) return [];

  const capacity = armories.reduce((n, r) => n + r.level * r.width, 0) *
    BAL.gear.repairPerCyclePerQuartermaster;

  const worn = Object.values(state.military.gear)
    .filter((g) => g.durability < BAL.gear.durabilityMax)
    .sort((a, b) => a.durability - b.durability)
    .slice(0, 4);
  if (!worn.length) return [];

  const perItem = capacity / worn.length;
  const scrapCost = capacity * BAL.gear.repairScrapPerPoint;
  if (state.resources.scrap < scrapCost) return [];

  return [
    { type: 'RESOURCE_DELTA', deltas: { scrap: -scrapCost }, emit: false },
    {
      type: 'GEAR_REPAIR',
      emit: false,
      repairs: worn.map((g) => ({ id: g.id, amount: perItem })),
    },
  ];
}

export function militarySummary(state) {
  let soldiers = 0;
  for (const id of state.military.squadIds) {
    soldiers += squadMembers(state, id).length;
  }
  const gear = Object.values(state.military.gear);
  return {
    squads: state.military.squadIds.length,
    soldiers,
    weapons: gear.filter((g) => getItem(g.item)?.kind === 'weapon').length,
    armor: gear.filter((g) => getItem(g.item)?.kind === 'armor').length,
    suits: gear.filter((g) => getItem(g.item)?.kind === 'suit').length,
    foodPerDay: soldiers * BAL.military.barracksFoodPerSoldierPerDay,
    chitsPerDay: soldiers * BAL.military.stipendChitsPerSoldierPerDay,
  };
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export { bestCraftable, getItem, fullName };
export default { readiness, simulateDay, simulateCycle, craft, formSquad, equipBest, militarySummary };
