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
    // Not until it has been restored — a seized Armoury has no shelves in use.
    if (room.found) continue;
    if (def?.provides?.gearStorage) cap += def.provides.gearStorage * room.level * room.width;
  }
  return cap;
}

export function unassignedGear(state, kind) {
  return Object.values(state.military.gear).filter(
    (g) => !g.assignedTo && (!kind || getItem(g.item)?.kind === kind)
  );
}

/**
 * Give a citizen the best available piece in each slot — including when the
 * slot is already filled with something worse.
 *
 * It used to skip any occupied slot, which quietly made the whole gear
 * progression cosmetic: research Env-Suit II, craft the suits, and the squad
 * keeps wearing the tier-1 ones it was issued on day seventy, because every
 * slot is full. Since band access is decided by the *worst* suit going out,
 * that squad can never reach the mid waste, never bring an artifact home,
 * and the research tree dead-ends with nothing startable. Eight hundred days
 * of play, a hundred and fifty expeditions, and zero artifacts recovered.
 *
 * GEAR_ASSIGN already frees whatever was in the slot, so the old piece goes
 * back in the rack for somebody else.
 */
export function equipBest(state, citizenId, claimed = new Set()) {
  const actions = [];
  const c = state.citizens[citizenId];
  if (!c) return actions;
  const better = (a, b) =>
    (getItem(b.item)?.tier ?? 0) - (getItem(a.item)?.tier ?? 0) || b.durability - a.durability;

  for (const kind of ['weapon', 'armor', 'suit']) {
    // `claimed` is what earlier citizens in this same batch have already been
    // promised. Actions are built against state as it is *now*, so without it
    // every member of a squad is handed the same top-ranked rifle, and
    // GEAR_ASSIGN — which correctly takes a piece off whoever held it —
    // strips all but the last of them bare.
    const pool = unassignedGear(state, kind).filter((g) => !claimed.has(g.id));
    if (!pool.length) continue;
    pool.sort(better);
    const candidate = pool[0];

    const wornId = c.gear?.[kind];
    if (wornId) {
      const worn = state.military.gear[wornId];
      // Only swap for a strictly better piece. Equal tier and equal wear is
      // a lateral move that would churn the rack every time this is called.
      if (worn && better(candidate, worn) >= 0) continue;
    }
    claimed.add(candidate.id);
    actions.push({ type: 'GEAR_ASSIGN', gearId: candidate.id, citizenId, slot: kind });
  }
  return actions;
}

/**
 * Equip a group in one pass, so they compete for the rack instead of all
 * being issued the same piece. Always use this for a squad.
 */
export function equipGroup(state, citizenIds) {
  const claimed = new Set();
  const actions = [];
  for (const id of citizenIds) actions.push(...equipBest(state, id, claimed));
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
 * Squad ids that could actually go somewhere: home, and crewed by enough
 * living people to be a squad.
 *
 * One predicate, in one place, because three copies of it had already drifted
 * apart. The conquest breach gate counted `squadIds.filter(id => !deployed)`,
 * which `SQUAD_CREATE` satisfies with `members: []` — so "Needs 2 squads
 * standing by" was cleared by pressing New Squad twice and never crewing the
 * second one. The radio panel that calls that gate was meanwhile filtering on
 * living members and `squadMin`, so the button and the gate behind it
 * disagreed about what a squad is.
 */
export function readySquads(state) {
  return state.military.squadIds.filter((id) => {
    const sq = state.military.squads[id];
    return sq && !sq.deployed && squadMembers(state, id).length >= BAL.military.squadMin;
  });
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
  // How many garrison squads are actually *at home*.
  //
  // A squad cannot both reassure people in the corridors and occupy somebody
  // else's silo, and it used to do both: `world.tickSatellites` counts idle
  // garrison squads as holding satellites, and this paid every one of them
  // the presence bonus regardless. So each garrisoned satellite was +2.5 Order
  // for the squad and -1 for the occupation — a net +1.5 a day — and Dominion
  // made a silo *more* stable, against a radio panel that says "Two is
  // comfortable. Five will break you." Measured, six satellites with six
  // garrisons ran at Order 77 where none at all ran at 45.
  //
  // The occupations are taken off the top, matching `tickSatellites`, which
  // assigns them to the first satellites in the list.
  let homeGarrisons = Math.max(
    0,
    state.military.squadIds.filter((id) => {
      const q = state.military.squads[id];
      return q && !q.deployed && q.assignment === 'garrison';
    }).length - (state.world?.satellites?.length || 0)
  );

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

    // Same predicate the counter above was built from, which it was not: the
    // budget counts `!deployed && assignment === 'garrison'` and this spent it
    // on the assignment alone.
    //
    // Tidiness, not a fix — and the honest version of this comment is the
    // second one, because the first claimed a bug that does not exist. The
    // budget caps the total either way. With H squads home, D deployed but
    // still labelled 'garrison', and S satellites, the old code paid
    // `min(max(0, H-S), H+D)`, which is `max(0, H-S)` for every non-negative
    // D — exactly what the new code pays. Only *which* squad is credited
    // changes, and the action carries no squad id, so nothing can observe it.
    // Mutation-tested: reverting this line is invisible to the whole suite,
    // and no test was added, because a test that cannot fail is worse than the
    // gap it pretends to close.
    //
    // It stays because one budget should have one predicate, and a fourth way
    // to set an assignment would turn an equivalence into a bug.
    if (!sq.deployed && sq.assignment === 'garrison' && homeGarrisons-- > 0) {
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
export default { readiness, simulateDay, simulateCycle, craft, formSquad, equipBest, equipGroup, militarySummary };
