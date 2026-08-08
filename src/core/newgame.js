/**
 * newgame.js — build a fresh Silo 12.
 *
 * The starting state is a deliberate design object, not a blank slate. Silo 12
 * has been running for three generations: the life-support spine is built and
 * upgraded, and nothing else is. Six rooms, per spec §4 — generator hall,
 * water, hydroponics, filtration, residences, cafeteria. There is no clinic,
 * no workshop and no airlock, which is why the opening 45 minutes has anything
 * to do.
 *
 * Air filtration capacity is sized to just cover 180 people, so population
 * growth immediately runs into a wall the player has to build their way out
 * of. That's the intended first lesson.
 */

import { BAL, TIME } from '../config/balance.js';
import { Rng, freshSeed } from './rng.js';
import { makeCitizen, resetIdCounter, vitalityForAge } from '../sim/population.js';
import { getRoom } from '../data/rooms.js';
import { SILOS } from '../data/silos.js';
import { RES_KEYS } from '../sim/economy.js';

/**
 * The six rooms Silo 12 starts with. Sized so the opening reads at a glance:
 * housing and air just cover 180 people (so growth immediately hits a wall),
 * water runs a small surplus, and food runs a small deficit. That deficit is
 * the first thing the player has to notice and fix.
 */
const STARTING_ROOMS = [
  { type: 'residences', floor: 3, slot: 0, width: 3, level: 3 },
  { type: 'cafeteria', floor: 5, slot: 1, width: 3, level: 2 },
  { type: 'air_filtration', floor: 7, slot: 0, width: 2, level: 2 },
  { type: 'hydroponics', floor: 8, slot: 0, width: 2, level: 2 },
  { type: 'water_reclaimer', floor: 9, slot: 0, width: 2, level: 3 },
  { type: 'generator_hall', floor: 11, slot: 0, width: 3, level: 3 },
];

/**
 * A silo that has already solved its opening problems. Not reachable in play —
 * this exists so the headless harness can fast-forward a *stable* economy for
 * 100 days and catch divergence, which a starving silo can't test.
 */
const SUFFICIENT_EXTRA = [
  { type: 'residences', floor: 4, slot: 0, width: 3, level: 3 },
  { type: 'hydroponics', floor: 8, slot: 2, width: 2, level: 3 },
  { type: 'water_reclaimer', floor: 9, slot: 2, width: 2, level: 2 },
  { type: 'recycling', floor: 12, slot: 0, width: 2, level: 2 },
  { type: 'recycling', floor: 13, slot: 1, width: 2, level: 2 },
  { type: 'workshop', floor: 12, slot: 2, width: 2, level: 2 },
  { type: 'clinic', floor: 6, slot: 0, width: 2, level: 2 },
  { type: 'maintenance_bay', floor: 12, slot: 4, width: 1, level: 2 },
  { type: 'storage_depot', floor: 13, slot: 0, width: 1, level: 2 },
  { type: 'air_filtration', floor: 7, slot: 2, width: 2, level: 2 },
  // Every room added above draws power, so the generation has to follow.
  { type: 'generator_hall', floor: 11, slot: 3, width: 3, level: 3 },
];

export function createNewGame(opts = {}) {
  const seed = opts.seed !== undefined ? opts.seed : freshSeed();
  const rng = new Rng(seed);
  resetIdCounter(1);

  const state = {
    meta: {
      schemaVersion: BAL.meta.schemaVersion,
      seed,
      createdAt: opts.now ?? Date.now(),
      lastSaveTs: opts.now ?? Date.now(),
      playedMs: 0,
      slot: opts.slot ?? 0,
      siloName: 'Silo 12',
      mayorName: opts.mayorName || 'you',
      gameOver: null,
      ending: null,
    },

    clock: { tick: 0, cycle: 0, day: 0, year: 0, shift: 0 },

    resources: {},
    caps: {},
    flows: {},

    air: { quality: BAL.air.start, capacity: 0, load: 0 },

    silo: {
      floors: buildFloors(),
      rooms: {},
      nextRoomId: 1,
      powerPriority: [],
      excavating: null,
      shoring: {},
    },

    citizens: {},
    citizenIds: [],

    research: { points: 0, completed: [], active: null, queue: [], bonus: 0, artifacts: {} },

    order: {
      value: BAL.order.start,
      policies: [],
      daysBelowThreshold: 0,
      crimes: [],
      investigations: [],
      dissentPressure: 0,
    },

    military: { squads: {}, squadIds: [], nextSquadId: 1, gear: {}, nextGearId: 1 },

    expeditions: { active: [], history: [], nextId: 1 },

    world: {
      silos: {},
      lastWorldDay: 0,
      lastDiploDay: 0,
      transmissions: [],
      satellites: [],
      radioTier: 0,
    },

    map: { nodes: {}, discovered: [], fog: {} },

    log: [],

    stats: {
      births: 0,
      deaths: 0,
      kia: 0,
      expeditionsLaunched: 0,
      expeditionsReturned: 0,
      raidersKilled: 0,
      mutantsKilled: 0,
      tradesCompleted: 0,
      peakPopulation: 0,
      causes: {},
    },

    flags: { brownout: false, crises: {}, firstContact: false, tutorialSeen: false },

    settings: {
      reducedMotion: false,
      muted: true,
      speed: 1,
      showTooltips: true,
    },

    ui: { view: 'silo', cameraFloor: 3, selectedRoom: null, selectedCitizen: null },
  };

  // ---- resources ----------------------------------------------------------
  for (const k of RES_KEYS) state.resources[k] = BAL.resources.start[k] ?? 0;

  // ---- rooms --------------------------------------------------------------
  for (const spec of STARTING_ROOMS) placeRoom(state, spec);
  if (opts.scenario === 'sufficient') {
    for (const spec of SUFFICIENT_EXTRA) placeRoom(state, spec);
  }

  // ---- people -------------------------------------------------------------
  const pop = opts.population ?? BAL.citizens.startPopulation;
  for (let i = 0; i < pop; i++) {
    const c = makeCitizen(rng, { age: rollStartingAge(rng) });
    c.history.push({ day: 0, text: 'Already here when you took the office.' });
    state.citizens[c.id] = c;
    state.citizenIds.push(c.id);
  }
  state.stats.peakPopulation = pop;

  // Seed a handful of existing bonds so births are possible from day one and
  // the first deaths land on somebody who mattered to somebody.
  seedRelationships(state, rng);

  // ---- the other nineteen -------------------------------------------------
  for (const def of SILOS) {
    if (def.id === 12) continue; // that's us
    state.world.silos[def.id] = {
      id: def.id,
      name: def.name,
      status: def.status,
      archetype: def.archetype,
      mayorName: def.mayorName,
      mayorPortraitSeed: rng.int(0, 0xffffff),
      known: !!def.knownAtStart,
      contact: 'none',
      reputation: def.startReputation ?? 0,
      power: { ...def.power },
      specialty: def.specialty,
      needs: [...(def.needs || [])],
      disposition: { ...def.disposition },
      treaties: [],
      grudges: [],
      memory: [],
      conquest: null,
      lastOffer: null,
    };
  }

  // ---- opening log --------------------------------------------------------
  state.log.push({
    day: 0,
    kind: 'alert',
    text:
      'Handover complete. Silo 12 is yours: ninety-two floors, fourteen of them dug, ' +
      `${pop} residents, and a radio nobody has been allowed to use.`,
  });
  state.log.push({
    day: 0,
    kind: 'plain',
    text:
      'The previous mayor left one note on the desk. It says: "Watch the air. ' +
      'Everything else you can argue with."',
  });

  return state;
}

function buildFloors() {
  const floors = [];
  for (let n = 1; n <= BAL.silo.totalFloors; n++) {
    floors.push({
      n,
      excavated: n <= BAL.silo.startExcavatedFloors,
      shored: n < BAL.silo.excavation.shoringRequiredBelowFloor,
      slots: new Array(BAL.silo.slotsPerFloor).fill(null),
      integrity: 100,
    });
  }
  return floors;
}

/** Place a room and claim its slots. Returns the room, or null if blocked. */
export function placeRoom(state, spec) {
  const def = getRoom(spec.type);
  if (!def) return null;
  const floor = state.silo.floors[spec.floor - 1];
  if (!floor || !floor.excavated) return null;

  const width = spec.width ?? def.width;
  if (spec.slot + width > BAL.silo.slotsPerFloor) return null;
  for (let i = 0; i < width; i++) {
    if (floor.slots[spec.slot + i] != null) return null;
  }

  const id = String(state.silo.nextRoomId++);
  const room = {
    id,
    type: spec.type,
    floor: spec.floor,
    slot: spec.slot,
    width,
    level: spec.level ?? 1,
    condition: spec.condition ?? BAL.silo.condition.start,
    staff: [],
    powered: true,
    buildingUntilCycle: spec.buildingUntilCycle ?? 0,
    upgradingUntilCycle: 0,
  };
  state.silo.rooms[id] = room;
  for (let i = 0; i < width; i++) floor.slots[spec.slot + i] = id;
  insertIntoPriority(state, room);
  return room;
}

/** New rooms slot into the priority list at their type's default rank. */
export function insertIntoPriority(state, room) {
  const list = state.silo.powerPriority;
  const rank = (t) => {
    const i = BAL.power.defaultPriority.indexOf(t);
    return i < 0 ? 999 : i;
  };
  const mine = rank(room.type);
  let at = list.length;
  for (let i = 0; i < list.length; i++) {
    const other = state.silo.rooms[list[i]];
    if (!other) continue;
    if (rank(other.type) > mine) {
      at = i;
      break;
    }
  }
  list.splice(at, 0, room.id);
}

/**
 * Starting age distribution. Not uniform: a sealed population that has been
 * stable for decades is roughly flat from 0-60 with a thin tail, and the
 * oldest residents were children when the doors closed.
 */
function rollStartingAge(rng) {
  const r = rng.next();
  if (r < 0.22) return rng.float(0, 17); // children
  if (r < 0.62) return rng.float(18, 39); // the working core
  if (r < 0.88) return rng.float(40, 59);
  if (r < 0.98) return rng.float(60, 71);
  return rng.float(71, 79); // the few who remember the handover before yours
}

function seedRelationships(state, rng) {
  const adults = state.citizenIds.filter((id) => {
    const c = state.citizens[id];
    return c.age >= BAL.citizens.birth.minAge && c.age <= BAL.citizens.birth.maxAge;
  });
  const shuffled = rng.shuffle(adults);
  // Roughly a third of adults are already paired off.
  for (let i = 0; i + 1 < shuffled.length; i += 3) {
    const a = state.citizens[shuffled[i]];
    const b = state.citizens[shuffled[i + 1]];
    const bond = rng.int(62, 95);
    a.relationships[b.id] = bond;
    b.relationships[a.id] = bond;
  }
  // Plus a scatter of friendships and a few genuine feuds.
  const all = state.citizenIds;
  for (let i = 0; i < all.length * 2; i++) {
    const a = state.citizens[rng.pick(all)];
    const b = state.citizens[rng.pick(all)];
    if (!a || !b || a.id === b.id) continue;
    const v = rng.chance(0.85) ? rng.int(10, 60) : rng.int(-70, -20);
    a.relationships[b.id] = v;
    b.relationships[a.id] = v;
  }
}

/** Recompute derived fields after a load or a migration. */
export function rehydrate(state) {
  for (const id of state.citizenIds) {
    const c = state.citizens[id];
    if (!c) continue;
    if (c.vitality === undefined || Number.isNaN(c.vitality)) {
      c.vitality = vitalityForAge(c.age, c.traits);
    }
  }
  let maxId = 0;
  for (const id of state.citizenIds) maxId = Math.max(maxId, Number(id));
  resetIdCounter(maxId + 1);
  return state;
}

export { TIME };
export default createNewGame;
