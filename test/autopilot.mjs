/**
 * autopilot.mjs — a competent-but-not-clever player, for regression testing.
 *
 * This is not an AI opponent and it is not shipped in the game. It exists so
 * the harness can drive the *real* six-room opening the way a player would —
 * building, excavating, researching, re-staffing — and assert that the silo
 * survives. A pure passive run can only ever prove the opening is lethal; it
 * can't prove it's solvable, which is the more important claim.
 *
 * It plays by simple priority rules and never looks more than one build
 * ahead, so if the autopilot survives, a thinking player comfortably will.
 */

import { BAL } from '../src/config/balance.js';
import { getRoom } from '../src/data/rooms.js';
import { autoAssign } from '../src/sim/jobs.js';
import { canBuild, build, canExcavate, startExcavation, canUpgrade, upgrade, canRepair, repair } from '../src/sim/build.js';
import { canStart, isComplete } from '../src/sim/research.js';
import { RESEARCH_LIST } from '../src/data/research.js';
import { readEnvironment } from '../src/sim/population.js';
import { computeCaps } from '../src/sim/economy.js';
import { employableCitizens } from '../src/sim/jobs.js';
import {
  formSquad, squadMembers, equipBest, craft, canCraft, craftableItems, unassignedGear,
} from '../src/sim/military.js';
import { canLaunch, launch, airlockCapacity } from '../src/sim/expedition.js';

/** Research order: unblock the economy first, then reach outward. */
const RESEARCH_ORDER = [
  'antibiotics',
  'hydroponic_yield_1',
  'deep_excavation_1',
  'radio_range_1',
  'env_suit_1',
  'power_efficiency',
  'food_preservation',
  'blight_resistance',
  'alloy_refining',
  'shoring',
  'battery_banks',
  'shift_scheduling',
  'decon_protocols',
  'atmospheric_analysis',
  'treaty_law',
  'deep_excavation_2',
  'rad_treatment_1',
  'firearms_1',
  'surgery',
  'protein_vats',
  'hydroponic_yield_2',
];

/**
 * One decision pass. Returns actions; issues at most one construction order
 * per call so costs are re-checked against real stock each time.
 */
export function autopilot(state) {
  const actions = [];
  const env = readEnvironment(state);
  const caps = computeCaps(state);
  const flow = (k) => {
    const f = state.flows?.[k];
    return f ? f.in - f.out : 0;
  };

  // ---- 1. research: always be researching something -------------------
  if (!state.research.active) {
    for (const id of RESEARCH_ORDER) {
      if (isComplete(state, id)) continue;
      if (canStart(state, id).ok) {
        actions.push({ type: 'RESEARCH_SET_ACTIVE', active: { id, progress: 0, cycles: 0 } });
        break;
      }
    }
    // Fall back to anything at all, so the labs are never idle.
    if (!actions.length) {
      const any = RESEARCH_LIST.find((n) => canStart(state, n.id).ok);
      if (any) actions.push({ type: 'RESEARCH_SET_ACTIVE', active: { id: any.id, progress: 0, cycles: 0 } });
    }
  }

  // ---- 2. repair first. A sabotaged generator will kill the silo long
  //         before the Maintenance Bay catches up with it, and a damaged
  //         life-support room beats any new construction. -----------------
  const CRITICAL = new Set(['generator_hall', 'reactor', 'water_reclaimer', 'air_filtration', 'hydroponics']);
  const damaged = Object.values(state.silo.rooms)
    .filter((r) => r.condition < (CRITICAL.has(r.type) ? 58 : 42))
    .sort((a, b) => {
      const critA = CRITICAL.has(a.type) ? 0 : 1;
      const critB = CRITICAL.has(b.type) ? 0 : 1;
      return critA - critB || a.condition - b.condition;
    })[0];
  if (damaged) {
    const fix = canRepair(state, damaged.id);
    if (fix.ok) actions.push(...repair(state, damaged.id));
  }

  // ---- 3. the build queue, in the order a player would panic ----------
  const count = (type) => Object.values(state.silo.rooms).filter((r) => r.type === type).length;

  const runway = (key) => {
    const net = flow(key);
    if (net >= 0) return Infinity;
    return state.resources[key] / (-net * BAL.time.CYCLES_PER_DAY);
  };

  const foodDays = runway('food');
  const waterDays = runway('water');
  const fuelDays = runway('fuel');
  const gen = state.power?.generation || 0;
  const demand = state.power?.demand || 0;
  const airHeadroom = state.air.capacity - state.air.load;

  const scrapIncome = flow('scrap');
  const partsIncome = flow('parts');
  const powerHeadroom = gen > 0 ? (gen - demand) / gen : 1;

  // The bootstrap. The opening silo has no scrap income and no parts income,
  // and every single building costs both. Recycling and the Workshop are
  // therefore not optional and not a matter of taste — without them the
  // starting stock buys four or five rooms and the silo is then permanently
  // unable to build anything ever again.
  const wants = [];
  if (scrapIncome <= 0 && count('recycling') === 0) wants.push('recycling');
  if (partsIncome <= 0 && count('workshop') === 0) wants.push('workshop');
  // The Laboratory is the third mandatory building and for the same kind of
  // reason: nothing else in the silo produces research points, and every
  // tier, every suit, every treaty and the chem lab that keeps the clinic
  // stocked all sit behind one. Deferring it until the silo feels
  // comfortable defers the entire game — measured at a hundred days, which
  // is most of the way to the §16 mid-game before the first node lands.
  if (count('laboratory') === 0) wants.push('laboratory');

  // Anything on this list is about to kill somebody. Sorted by how soon.
  const urgent = [];
  if (waterDays < 8) urgent.push({ type: 'water_reclaimer', when: waterDays });
  if (foodDays < 14) urgent.push({ type: 'hydroponics', when: foodDays });
  if (fuelDays < 12) urgent.push({ type: 'recycling', when: fuelDays });
  if (gen > 0 && demand > gen * 0.85) urgent.push({ type: 'generator_hall', when: 4 });
  if (airHeadroom < 0) urgent.push({ type: 'air_filtration', when: 5 });
  if (env.housingFree < 0) urgent.push({ type: 'residences', when: 9 });
  urgent.sort((a, b) => a.when - b.when);
  wants.push(...urgent.map((u) => u.type));

  // Then the trend fixes: act on a margin that is *shrinking*, not on one
  // that has already run out. A reclaimer ordered when the tank hits zero
  // arrives four shifts after the first person dies of thirst.
  // Salvage throughput has to grow with the silo. Scrap is the universal
  // currency — every room, every repair and every floor of excavation is
  // priced in it — so a silo that keeps its recycling at the level that was
  // adequate for a hundred and eighty people simply stops being able to
  // afford anything once it doubles.
  const pop = state.citizenIds.length;
  if (flow('water') < 4) wants.push('water_reclaimer');
  if (flow('food') < 4) wants.push('hydroponics');
  if (scrapIncome < 5 + pop / 30) wants.push('recycling');
  if (partsIncome < 1.5 + pop / 160) wants.push('workshop');
  if (powerHeadroom < 0.25) wants.push('generator_hall');
  if (count('laboratory') === 0 && scrapIncome > 3) wants.push('laboratory');

  // Everything else waits until nothing is on fire and there's a reserve
  // left over. Spending the last of the scrap on a schoolhouse while the
  // water runs out is exactly the mistake this ordering exists to prevent.
  const RESERVE = 170;
  if (!urgent.length && state.resources.scrap > RESERVE) {
    // Reaching outward is the growth lever (§6), and the chain only pays
    // once every link exists — an airlock without an armoury sends nobody
    // anywhere. It goes first because a growing silo wants another dormitory
    // and another filtration bay every single day, and a build queue that
    // services those first never reaches the end of the chain at all: the
    // door stayed shut for a hundred days that way. Anything genuinely about
    // to kill somebody is on the urgent list above, which outranks all of
    // this. These are research-gated; canBuild refuses until the node lands
    // and the loop moves on.
    if (count('radio_room') < 1) wants.push('radio_room');
    if (count('airlock') < 1) wants.push('airlock');
    if (count('suit_bay') < 1) wants.push('suit_bay');
    // The armoury is the bench. There is no other room that can make a
    // weapon or a vest, so without one a squad can be formed, housed and
    // fed, and never sent anywhere.
    if (count('armory') < 1) wants.push('armory');
    // Suits, weapons and armour above tier one are all made of alloy, and
    // the foundry is the only thing that makes any.
    if (count('foundry') < 1) wants.push('foundry');
    if (airHeadroom < 30) wants.push('air_filtration');
    if (env.housingFree < 12) wants.push('residences');
    // Meds and filters both come out of the chem lab and nothing else makes
    // either. Without it the clinic runs dry, no expedition can be supplied,
    // and no squad that comes home can be decontaminated. Filter demand
    // scales with the headcount — every air filtration bay draws media all
    // day — so one chem lab that was comfortable at two hundred people goes
    // quietly negative at four hundred and closes the airlock for good.
    if (count('chem_lab') < 1 + Math.floor(pop / 220)) wants.push('chem_lab');
    if (count('clinic') < 1) wants.push('clinic');
    if (count('maintenance_bay') < 1) wants.push('maintenance_bay');
    if (count('laboratory') < 2) wants.push('laboratory');
    if (count('cafeteria') < 2) wants.push('cafeteria');
    if (count('schoolhouse') < 1) wants.push('schoolhouse');
    if (foodDays > 25 && waterDays > 25 && count('storage_depot') < 2) wants.push('storage_depot');
    if (count('sheriffs_office') < 1) wants.push('sheriffs_office');
    // Research is the long pole all game; keep adding benches to it.
    if (count('laboratory') < 4 && state.resources.scrap > RESERVE * 3) wants.push('laboratory');
  }

  for (const type of wants) {
    const spot = findSpot(state, type);
    if (!spot) continue;
    const check = canBuild(state, spot.floor, spot.slot, type);
    if (!check.ok) continue;
    actions.push(...build(state, spot.floor, spot.slot, type));
    break; // one order per pass
  }

  // ---- 3. excavate when bays are running out --------------------------
  const freeBays = state.silo.floors
    .filter((f) => f.excavated)
    .reduce((n, f) => n + f.slots.filter((s) => s == null).length, 0);
  // Silos expand: dig when bays are getting tight, or whenever there's scrap
  // spare for it. Sitting on a full treasury and an unopened tier is not a
  // thing a player does.
  if (!state.silo.excavating && (freeBays < 14 || state.resources.scrap > 400)) {
    const dig = canExcavate(state);
    if (dig.ok) actions.push(...startExcavation(state));
  }

  // ---- 4. spend a surplus on upgrades ---------------------------------
  if (state.resources.scrap > caps.scrap * 0.8 && state.resources.chits > 200) {
    const target = Object.values(state.silo.rooms)
      .filter((r) => r.level < BAL.silo.upgrade.maxLevel && r.upgradingUntilCycle === 0)
      .sort((a, b) => a.level - b.level)[0];
    if (target && canUpgrade(state, target.id).ok) actions.push(...upgrade(state, target.id));
  }

  // ---- 5. the surface -------------------------------------------------
  // Recruitment is the main growth lever (spec §6), so a player who never
  // opens the airlock never reaches the pacing targets. The autopilot runs
  // expeditions once it can, which is also the only way the harness covers
  // the military and expedition paths at all.
  actions.push(...runSurface(state));

  // ---- 6. keep everyone posted ----------------------------------------
  actions.push(...autoAssign(state));

  return actions;
}

/** Kit out a squad and keep it working the near and mid bands. */
function runSurface(state) {
  const actions = [];
  const research = state.research.completed;
  if (!research.includes('env_suit_1')) return actions;

  const hasAirlock = Object.values(state.silo.rooms).some(
    (r) => r.type === 'airlock' && r.buildingUntilCycle === 0
  );
  const hasSuitBay = Object.values(state.silo.rooms).some(
    (r) => r.type === 'suit_bay' && r.buildingUntilCycle === 0
  );
  if (!hasSuitBay || !hasAirlock) return actions; // the build queue handles these

  const hasChemLab = Object.values(state.silo.rooms).some(
    (r) => r.type === 'chem_lab' && r.buildingUntilCycle === 0
  );

  // Decontaminate anyone waiting. Skipping is only ever right when no filter
  // is coming — with a chem lab running it is worth waiting a few shifts,
  // because the dose from a skip does not land on the squad, it lands thinly
  // on all four hundred people, and it never leaves. Skipping habitually is
  // fatal on a horizon of about two hundred days: silo-wide radiation climbs
  // past fifty, health follows it down, the work factor goes with health,
  // and the generator hall quietly stops making enough power to run the
  // water reclaimers.
  if (state.pendingDecon) {
    const cost = BAL.expedition.decon.filtersPerMember * state.pendingDecon.members.length;
    if (state.resources.filters >= cost) {
      actions.push({ type: 'DECON', members: state.pendingDecon.members });
    } else if (!hasChemLab) {
      actions.push({
        type: 'DECON',
        skip: true,
        radiation: state.pendingDecon.radiation,
        members: state.pendingDecon.members,
      });
    }
    return actions;
  }

  // One squad, kept at strength.
  if (!state.military.squadIds.length) {
    actions.push(...formSquad(state));
    return actions;
  }
  const squadId = state.military.squadIds[0];
  const squad = state.military.squads[squadId];
  if (squad.deployed) return actions;

  const cap = airlockCapacity(state);
  const target = Math.min(BAL.military.squadMax, Math.max(BAL.military.squadMin, cap));
  const members = squadMembers(state, squadId);

  if (members.length < target) {
    const candidate = employableCitizens(state)
      .filter((c) => c.squadId == null && c.age >= 18 && c.age < 50 && c.health > 60)
      .sort((a, b) => (b.skills.combat || 0) - (a.skills.combat || 0))[0];
    if (candidate) {
      actions.push({ type: 'SQUAD_MEMBER', squadId, citizenId: candidate.id });
      actions.push(...equipBest(state, candidate.id));
    }
    return actions;
  }

  // Kit: craft whatever the squad is short of, best tier available.
  for (const kind of ['suit', 'weapon', 'armor']) {
    const missing = members.filter((c) => !c.gear?.[kind]).length;
    if (!missing) continue;
    const spare = unassignedGear(state, kind).length;
    if (spare > 0) {
      for (const c of members) actions.push(...equipBest(state, c.id));
      return actions;
    }
    const buildable = craftableItems(state)
      .filter((i) => i.kind === kind)
      .sort((a, b) => b.tier - a.tier)[0];
    if (buildable && canCraft(state, buildable.id).ok) {
      actions.push(...craft(state, buildable.id));
      return actions;
    }
    return actions; // can't kit them; don't send them
  }

  // Don't send a squad you cannot clean when it gets back. The filters have
  // to be on the shelf before the door opens, not hoped for.
  const deconCost = BAL.expedition.decon.filtersPerMember * members.length;
  if (state.resources.filters < deconCost) return actions;

  // Send them out — the furthest band the suits allow.
  for (const band of ['mid', 'near']) {
    const check = canLaunch(state, squadId, band);
    if (check.ok) {
      actions.push(...launch(state, squadId, band));
      break;
    }
  }
  return actions;
}

/** First floor with a free bay that this room type is allowed to occupy. */
function findSpot(state, typeId) {
  const def = getRoom(typeId);
  if (!def) return null;
  for (const floor of state.silo.floors) {
    if (!floor.excavated) continue;
    if (def.tierGate) {
      const tier = BAL.silo.tiers.find((t) => floor.n >= t.from && floor.n <= t.to);
      const need = BAL.silo.tiers.findIndex((t) => t.key === def.tierGate);
      const have = BAL.silo.tiers.findIndex((t) => t.key === tier?.key);
      if (have < need) continue;
    }
    // Prefer a bay next to an identical room, so the autopilot merges rather
    // than scattering — merging is what the layout puzzle rewards.
    let fallback = null;
    for (let slot = 0; slot < BAL.silo.slotsPerFloor; slot++) {
      if (floor.slots[slot] != null) continue;
      const neighbours = [slot - 1, slot + 1]
        .map((i) => (i >= 0 && i < BAL.silo.slotsPerFloor ? floor.slots[i] : null))
        .map((id) => (id != null ? state.silo.rooms[id] : null));
      if (def.canMerge && neighbours.some((r) => r && r.type === typeId && r.width < BAL.silo.merge.maxWidth)) {
        return { floor: floor.n, slot };
      }
      if (fallback === null) fallback = slot;
    }
    if (fallback !== null) return { floor: floor.n, slot: fallback };
  }
  return null;
}

export default autopilot;
