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
import {
  canBuild, build, canExcavate, startExcavation, canUpgrade, upgrade, canRepair, repair,
  canShore, shoreFloor, strainedFloors,
} from '../src/sim/build.js';
import { canStart, isComplete } from '../src/sim/research.js';
import { RESEARCH_LIST } from '../src/data/research.js';
import { readEnvironment } from '../src/sim/population.js';
import { computeCaps, staffSlots } from '../src/sim/economy.js';
import { employableCitizens } from '../src/sim/jobs.js';
import {
  formSquad, squadMembers, equipBest, equipGroup, craft, canCraft, craftableItems, unassignedGear, getItem,
} from '../src/sim/military.js';
import { canLaunch, launch, airlockCapacity } from '../src/sim/expedition.js';

/**
 * Research order: unblock the economy, then climb the suit line, then finish.
 *
 * The suit line is load-bearing and it is easy to under-rate. The near ruins
 * drop no artifacts at all, so a silo that never fields tier-2 suits never
 * recovers a single artifact, and every artifact-gated node — a third of the
 * tree, including all three endings — sits permanently out of reach while
 * the lab keeps busy on yield upgrades. This list used to stop at the
 * economy nodes and reached env_suit_2 only by accident, four hundred days
 * late, which is exactly what that failure looks like from the inside: no
 * error, no warning, just a tree that quietly stops having anything in it.
 */
const RESEARCH_ORDER = [
  // Keep the lights on and the people fed.
  'antibiotics',
  'hydroponic_yield_1',
  'deep_excavation_1',
  'radio_range_1',
  'env_suit_1',
  'power_efficiency',
  'alloy_refining',
  // Get to the mid waste. Nothing is recoverable below tier 2.
  'decon_protocols',
  'env_suit_2',
  'atmospheric_analysis',
  // Consolidate while the squad starts bringing things home.
  'food_preservation',
  'blight_resistance',
  'shoring',
  'deep_excavation_2',
  'battery_banks',
  'shift_scheduling',
  // Deeper, on both axes.
  'terrain_mapping',
  'env_suit_3',
  'deep_excavation_3',
  'firearms_1',
  'ballistic_armor_1',
  'rad_treatment_1',
  'surgery',
  'firearms_2',
  'treaty_law',
  'hydroponic_yield_2',
  'protein_vats',
  // The endgame chain. Every ending needs the Origin Record, and the Record
  // needs both of the long branches finished.
  'firearms_3',
  'env_suit_4',
  'propaganda',
  'radio_range_2',
  'encryption',
  'radio_range_3',
  'pre_collapse_archives',
  'origin_record',
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

  // ---- 2b. hold the deep. A floor that runs out of shoring breaches every
  //          room on it and kills part of the shift, which is a worse morning
  //          than any single repair — but it announces itself fifty days out,
  //          so a competent player deals with it well before it is urgent and
  //          never at the expense of something that is. ---------------------
  const failing = strainedFloors(state)[0];
  if (failing) {
    const prop = canShore(state, failing.n);
    if (prop.ok) actions.push(...shoreFloor(state, failing.n));
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
  // A store sitting at its cap throws away everything produced into it, so
  // its measured net flow reads flat however many producers are running.
  // Building against that reading is a treadmill with the same shape as the
  // generator one: the parts store pinned at 700 read as "no parts income"
  // for two hundred days and bought fourteen Workshops, which between them
  // took every engineer in the silo and left the Foundry — the only source
  // of alloy, and so of every suit above tier one — standing empty. A full
  // tank is not a shortage; it is a depot problem.
  const full = (k) => Number.isFinite(caps[k]) && state.resources[k] >= caps[k] * 0.95;
  const pop = state.citizenIds.length;
  if (flow('water') < 4 && !full('water')) wants.push('water_reclaimer');
  if (flow('food') < 4 && !full('food')) wants.push('hydroponics');
  if (scrapIncome < 5 + pop / 30 && !full('scrap')) wants.push('recycling');
  if (partsIncome < 1.5 + pop / 160 && !full('parts')) wants.push('workshop');
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
    // and no squad that comes home can be decontaminated.
    //
    // Size it against the thing that actually eats filters, which is the air
    // plant, not the headcount: a filtration bay draws media every shift
    // whether anyone is breathing hard or not. A bench makes 0.6 a shift at
    // full crew and a bay burns about 0.05, and neither runs at full crew, so
    // the honest ratio is nearer one bench per three bays than the one-per-
    // two-hundred-people this used to ask for. Under that rule the silo held
    // exactly one chem lab against six bays, ran a filter balance of zero,
    // and kept a fully equipped squad indoors for a hundred and twelve days
    // because it could never bank the eight filters a decon costs.
    if (count('chem_lab') < Math.max(1, Math.ceil(count('air_filtration') / 3))) {
      wants.push('chem_lab');
    }
    if (count('clinic') < 1) wants.push('clinic');
    if (count('maintenance_bay') < 1) wants.push('maintenance_bay');
    if (count('laboratory') < 2) wants.push('laboratory');
    if (count('cafeteria') < 2) wants.push('cafeteria');
    if (count('schoolhouse') < 1) wants.push('schoolhouse');
    if (foodDays > 25 && waterDays > 25 && count('storage_depot') < 2) wants.push('storage_depot');
    if (count('sheriffs_office') < 1) wants.push('sheriffs_office');
    // Ammunition. A mid-band run costs 24 rounds and brings none back, so
    // the armoury's hand-loading bench alone paces expeditions at one per
    // nine days. Munitions is the room that makes the surface sustainable.
    if (count('munitions') < 1) wants.push('munitions');
    if (count('foundry') < 2) wants.push('foundry');
    // Research is the long pole all game; keep adding benches to it.
    if (count('laboratory') < 4 && state.resources.scrap > RESERVE * 3) wants.push('laboratory');
  }

  // A room produces the fraction of its posts that are *crewed*, and
  // auto-assign only ever posts people who have no job — so a *second*
  // Generator Hall ordered by a silo with nobody spare opens empty, produces
  // nothing, and still draws its idle power. Worse, if the halls it already
  // has are standing part-empty, the new one cannot add output even in
  // principle: it shares the same crew, so it moves people sideways and
  // bills the silo for the privilege.
  //
  // The rule is about *more of the same*, not about new capability. The first
  // Chem Lab, the first Suit Bay, the first Laboratory are worth ordering
  // into a fully-employed silo, because they do something nothing else in the
  // silo does and a player would move somebody into them. Gating those on
  // spare labour was tested and is its own deadlock: this silo runs at zero
  // idle from about day 30 forever, so "wait for a spare pair of hands"
  // means the Suit Bay is never built and the surface never opens.
  //
  // Left ungated this is a treadmill with no exit. Generation runs level with
  // demand, the answer on the readout looks like another Generator Hall, the
  // new hall is uncrewed and adds no power, and the reading that ordered it
  // is still true the next morning. Measured at twenty-seven halls by day 260
  // sharing twenty-three mechanics — about four halls' worth of output
  // between them, every scrap of income spent on them, and one laboratory
  // built in three hundred days. It kills the silo twice over: auto-assign
  // crews rooms in power-priority order, so seventy generator posts are
  // filled before the first laboratory bench and research stops dead at
  // eight nodes; and on day 553 the plant's fuel draw finally outran the
  // recycling, the lights went out and everyone died of thirst.
  //
  // The rule a player learns from the first empty room: post somebody, or
  // don't build it.
  const spareCrew = employableCitizens(state).filter((c) => !c.job).length;
  const emptyPosts = (type) => {
    let gap = 0;
    for (const r of Object.values(state.silo.rooms)) {
      if (r.type !== type) continue;
      const def = getRoom(type);
      const live = r.staff.filter((id) => id != null && state.citizens[id]?.status !== 'dead');
      gap += staffSlots(def, r) - live.length;
    }
    return gap;
  };
  for (const type of wants) {
    if (getRoom(type)?.staff && count(type) > 0 && (spareCrew <= 0 || emptyPosts(type) > 0)) continue;
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
  // Normally that means filling open posts from whoever is idle. But a silo
  // with nobody idle and an empty post in the water plant is not fully
  // staffed, it is *mis*-staffed, and plain auto-assign cannot see the
  // difference: it only ever moves people who have no job, so the empty post
  // stays empty for as long as the roster is full. The reclaimers then run at
  // the fraction they are crewed for while somebody stands in a training
  // yard, and the build queue cannot fix it either — another reclaimer built
  // into a silo with no spare hands opens just as empty as the last one.
  //
  // Measured on seed 84934674: a squad on continuous expeditions holds four
  // to eight of a forty-five-person workforce off the roster permanently, the
  // water plant ran a post short from day 60, the tanks fell 800 → 0 over
  // fifty days and the silo died of thirst on day 128 with the answer being
  // "move one person". So move one person — which is what a player does when
  // the water goes red.
  //
  // Two things had to be narrowed to make that safe, and both were measured
  // the hard way:
  //
  //  - One move a pass, not a wholesale re-shuffle. Re-running the full
  //    assignment over every open post pulls the best hand out of one
  //    reclaimer to fill the next one, leaves a hole behind it, and does it
  //    again three times a day. Tried: it killed four silos out of five,
  //    which is worse than the problem.
  //  - Only when a tank is actually falling. An empty post is not by itself
  //    an emergency — this silo runs two or three posts short of a full
  //    roster permanently — and a rule that fires on that alone bleeds the
  //    benches one person at a time for ever. Tried: it saved every silo and
  //    cut research from fourteen nodes to five, which is trading the game
  //    for the silo.
  const CRITICAL_POSTS = ['water_reclaimer', 'air_filtration', 'hydroponics', 'generator_hall', 'recycling'];
  const emergency =
    waterDays < 12 || foodDays < 12 || fuelDays < 12 || (gen > 0 && demand > gen * 0.95);
  actions.push(...autoAssign(state));
  if (spareCrew <= 0 && emergency) {
    const short = CRITICAL_POSTS.filter((t) => emptyPosts(t) > 0)[0];
    if (short) {
      const rank = (r) => {
        const i = state.silo.powerPriority.indexOf(r.id);
        return i < 0 ? 999 : i;
      };
      const shortRoom = Object.values(state.silo.rooms)
        .filter((r) => r.type === short)
        .sort((a, b) => rank(a) - rank(b))[0];
      // Anything but the benches. The Laboratory and the Chem Lab are two
      // posts each and they are the only source of, respectively, every
      // research point and every filter and dose of medicine in the silo —
      // rob them to patch a water leak and the silo never reaches the node
      // that stops the leaks. There is always something further down the
      // list to take the shift from: an armoury, a training yard, a radio
      // room, a maintenance bay.
      const SPARE_LAST = new Set(['laboratory', 'chem_lab']);
      const donor = Object.values(state.silo.rooms)
        .filter((r) => rank(r) > rank(shortRoom) && !SPARE_LAST.has(r.type) && r.staff.some((id) => id != null))
        .sort((a, b) => rank(b) - rank(a))[0];
      if (donor && shortRoom) {
        const who = donor.staff.filter((id) => id != null && state.citizens[id]?.status === 'working')[0];
        if (who) actions.push({ type: 'CITIZEN_ASSIGN', citizenId: who, roomId: shortRoom.id });
      }
    }
  }

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

  // Kit: craft whatever the squad is short of *or out of date on*, best tier
  // available. Upgrading matters as much as filling an empty slot — band
  // access is decided by the worst suit going out, so one member still in a
  // tier-1 suit keeps the whole squad in the near ruins, where nothing worth
  // researching is ever found.
  for (const kind of ['suit', 'weapon', 'armor']) {
    const buildable = craftableItems(state)
      .filter((i) => i.kind === kind)
      .sort((a, b) => b.tier - a.tier)[0];
    const bestTier = buildable?.tier ?? 0;
    const behind = members.filter((c) => {
      const worn = c.gear?.[kind] ? state.military.gear[c.gear[kind]] : null;
      return !worn || (getItem(worn.item)?.tier ?? 0) < bestTier;
    }).length;
    if (!behind) continue;

    // Something better already on the rack? Issue it before making more.
    const spare = unassignedGear(state, kind).filter(
      (g) => (getItem(g.item)?.tier ?? 0) >= bestTier
    ).length;
    if (spare > 0) {
      actions.push(...equipGroup(state, members.map((c) => c.id)));
      return actions;
    }
    if (buildable && canCraft(state, buildable.id).ok) {
      actions.push(...craft(state, buildable.id));
      return actions;
    }
    // Can't improve this slot right now. If everyone at least has something,
    // that's no reason to keep them indoors — fall through and launch.
    if (members.some((c) => !c.gear?.[kind])) return actions;
  }

  // Don't send a squad you cannot clean when it gets back — *if* cleaning
  // them is on the table at all. Only the Chem Lab makes filters, and the
  // documented order of the chain (Env-Suit I, Airlock, Suit Bay, Armory,
  // Foundry, Chem Lab) puts it last on purpose, so the first runs out of
  // the door are meant to be made on the starting stock and, once that is
  // gone, on a skipped decon. Requiring filters unconditionally inverted
  // that: the silo starts with a hundred days of filter for its air plant
  // and no way to make more, so from about day 100 the door was shut by a
  // rule the game itself does not have — `canLaunch` never asks for filters
  // — and no expedition left in seven hundred days. With a Chem Lab running
  // the wait is right and the check stands; without one, skipping is the
  // intended cost and the decon handler above already pays it.
  const deconCost = BAL.expedition.decon.filtersPerMember * members.length;
  if (hasChemLab && state.resources.filters < deconCost) return actions;

  // Send them out — the furthest band the suits allow. Reward tier rises
  // with distance and the near ruins yield no artifacts at all, so a squad
  // that keeps walking to the same safe rubble is a squad the research tree
  // never hears from.
  for (const band of ['scar', 'approach', 'deep', 'mid', 'near']) {
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
