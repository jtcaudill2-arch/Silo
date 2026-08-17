/**
 * newgame.js — build a fresh Silo 12.
 *
 * The starting state is a deliberate design object, not a blank slate. Silo 12
 * has been running for three generations: the life-support spine is built and
 * nothing else is. Five rooms — generator hall, water reclaimer, hydroponics,
 * filtration, residences. There is no cafeteria, no clinic, no workshop and no
 * airlock, which is why the first session has anything to do.
 *
 * Nothing here is a fixed number: the population is `citizens.startPopulation`
 * and the bays are sized against it in STARTING_ROOMS below, with the
 * arithmetic written out. Filtration covers ninety against a starting
 * forty-four, and the residences sleep sixty-three — headroom to grow into
 * rather than a wall to hit on the first morning.
 *
 * (This paragraph described six rooms including a cafeteria, and filtration
 * "sized to just cover 180 people", for several revisions after none of that
 * was true. The header of the file that builds the silo is the worst place in
 * the codebase to leave a stale description, so if you change the opening,
 * change this.)
 */

import { BAL, TIME } from '../config/balance.js';
import { Rng, freshSeed } from './rng.js';
import { makeCitizen, resetIdCounter, vitalityForAge } from '../sim/population.js';
import { getRoom } from '../data/rooms.js';
import { manifestFor } from '../data/sections.js';
import { SILOS } from '../data/silos.js';
import { SCHEMA_VERSION } from './migrations.js';
import { RES_KEYS } from '../sim/economy.js';

/**
 * The rooms Silo 12 starts with.
 *
 * Four life-support bays and somewhere to sleep. That is the whole silo.
 *
 * This has been cut down twice. It was six rooms running a deliberate food
 * deficit from the first shift, which read well and killed everyone by day
 * twenty-five. It was then eight rooms that fed and watered themselves, which
 * survived — and put eight staffed rooms, six resource counters and most of a
 * production chain in front of someone who had not yet been told what a bay
 * is. Surviving the opening and understanding it are different problems, and
 * the second one was still failing.
 *
 * So: five rooms at level one and `citizens.startPopulation` people — forty-
 * four. One of each thing, which means each room can be pointed at and
 * explained in a sentence, and the chain between them is short enough to see
 * whole — fuel burns to make power, power runs the reclaimer, the reclaimer
 * waters the crop, the crop feeds the people who work the generator.
 *
 * The margins are deliberately loose at this size, and loose in *real* output
 * rather than rated: forty-four people eat five and a half food a shift — one
 * a day each over eight shifts — against a two-slot bay that rates about
 * twenty-five and delivers ten to fifteen with a green crew. That is not an
 * oversight. Production is per-room and consumption is per-head, so the
 * surplus closes on its own as the population grows, and the silo asks for a
 * second bay exactly when the player has had time to learn what the first
 * one does.
 *
 * Eighteen posts across the four staffed bays, filled from forty-four people
 * with plenty spare, so nothing runs part-crewed on the first morning.
 *
 * (These figures have gone stale twice while the rooms underneath them moved,
 * and they are stated here and again on the list itself. If you change a
 * width or the population, redo the arithmetic in both.)
 */
const STARTING_ROOMS = [
  // From floor one down, with nothing above them and nothing empty between.
  // The silo used to open on floors 3 to 7 inside fourteen excavated floors,
  // so the first thing a player saw was two empty floors above their home and
  // seven below it — a silo that had already been dug for them, in which
  // digging was something to do eventually rather than the way it grows.
  // Widths are chosen from posts, not floor space. Staffing is `slotsPerLevel
  // × width` and output scales by the fraction of posts crewed, so a wide bay
  // in a small silo is a half-crewed bay: at width 2 across the board the
  // generator ran at 35 of a possible 73 power and browned out everything the
  // player then built. These are sized so all eighteen posts are filled with
  // people to spare, and so the ceilings each room provides — 63 beds, 90 air
  // — sit far enough above 44 to leave somewhere to grow into.
  { type: 'residences', floor: 1, slot: 0, width: 3, level: 1 }, // 63 beds
  { type: 'air_filtration', floor: 2, slot: 0, width: 2, level: 1 }, // 90 air cap
  // Two slots each, not one, and the reason is the same one written against
  // the generator below: rated output is not real output. A single bay is
  // rated 11 food against the 5.5 that 44 people eat, which looks like a
  // comfortable double — but a green crew works at 40-60% of rating, so the
  // real figure is 4.4 to 6.6 and it *straddles* the requirement. Whether the
  // opening silo feeds itself then depends on the quality of the crew the seed
  // happened to roll. It does on the default seed; on seed 2024 food ran
  // negative from day 3 with thirty people idle and 697 scrap unspent, and
  // everyone starved on day 49. An opening that is survivable on some seeds
  // and not others is not a difficulty setting, it is a coin toss.
  { type: 'hydroponics', floor: 3, slot: 0, width: 2, level: 1 },
  // Sized against the crop as well as the people: the bay above drinks 12 a
  // shift on top of the 6.6 that 44 residents do.
  { type: 'water_reclaimer', floor: 4, slot: 0, width: 2, level: 1 },
  // Deliberately oversized. A green crew works at roughly sixty per cent of a
  // bay's rated output, so "enough generation for today" is a silo that
  // browns out the moment the player builds anything — and the power priority
  // correctly sheds the Laboratory first, which quietly removes research from
  // the game. Three slots is about 125 rated, ~75 real, against a starting
  // draw of 31: room to build three or four rooms before power is the lesson.
  { type: 'generator_hall', floor: 5, slot: 0, width: 3, level: 1 },
];

/**
 * A silo that has already solved its opening problems. Not reachable in play —
 * this exists so the headless harness can fast-forward a *stable* economy for
 * 100 days and catch divergence, which a starving silo can't test.
 *
 * It used to be a hand-written list of rooms laid on top of the opening, and
 * that list had to be kept clear of the opening's own slots or `placeRoom`
 * would silently drop a room and quietly suffocate the control silo. There is
 * nothing to keep clear now: the scenario simply has more of the building
 * open, with everything on it commissioned. `manifestFor` decides what is
 * there, exactly as it does for a level the player unseals, so the control silo
 * cannot drift away from the game it is a control for.
 */
const SUFFICIENT_FLOORS = 9;

export function createNewGame(opts = {}) {
  const seed = opts.seed !== undefined ? opts.seed : freshSeed();
  const rng = new Rng(seed);
  resetIdCounter(1);

  const state = {
    meta: {
      schemaVersion: SCHEMA_VERSION,
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
      raidsRepelled: 0,
      raidsLost: 0,
      silosTaken: 0,
      tradesCompleted: 0,
      peakPopulation: 0,
      causes: {},
    },

    // Doctrine. `frontier` is the deepest reward tier ever returned from, and
    // it starts at 0 rather than 1 so the very first near-ruins run still pays
    // — the rule is "at or beyond the frontier", and a silo that has been
    // nowhere has no frontier to fall short of.
    doctrine: { points: 0, earned: 0, taken: [], frontier: 0 },

    flags: { brownout: false, crises: {}, firstContact: false, tutorialSeen: false },

    settings: {
      reducedMotion: false,
      muted: true,
      speed: 1,
      showTooltips: true,
    },

    ui: { view: 'silo', cameraFloor: 3, selectedRoom: null, selectedCitizen: null },

    lastReport: null,
  };

  // ---- resources ----------------------------------------------------------
  for (const k of RES_KEYS) state.resources[k] = BAL.resources.start[k] ?? 0;

  // ---- rooms --------------------------------------------------------------
  //
  // THE SILO IS INHERITED, NOT BUILT. Every level of Silo 12 was fitted out and
  // lived in, and the lit ones at the top are where the people who are left
  // have been keeping the lights on. So the opening is not a list of rooms
  // written here any more — it is `manifestFor` on the levels that are open,
  // which is the same function that furnishes every level the player later
  // unseals. One source for what is standing in this building, whether the
  // player inherited it on the first morning or opened the seal themselves.
  //
  // Worn rather than derelict, and that is the first thing the game teaches: a
  // new mayor's opening move is a repair on something they can see running,
  // not a purchase from a menu of twenty-nine rooms and a hundred and forty-
  // four empty floors.
  for (let n = 1; n <= BAL.silo.startExcavatedFloors; n++) {
    for (const spec of manifestFor(n)) {
      placeRoom(state, {
        type: spec.type, floor: n, slot: spec.slot, width: spec.width,
        level: spec.level, condition: spec.condition, strict: true,
      });
    }
  }
  if (opts.scenario === 'sufficient') {
    for (let n = BAL.silo.startExcavatedFloors + 1; n <= SUFFICIENT_FLOORS; n++) {
      state.silo.floors[n - 1].excavated = true;
      for (const spec of manifestFor(n)) {
        placeRoom(state, {
          type: spec.type, floor: n, slot: spec.slot, width: spec.width,
          // A PLANT AT RANK, which is what "sufficient" has to mean now.
          //
          // This scenario is the control silo — the one the harness measures
          // divergence against, the one the expedition and conquest fixtures
          // are built on, and the one whose whole job is to have already
          // solved its opening problems. It had not solved the first one. The
          // builders' plan puts a Generator Hall on floors 3, 9 and 15 and
          // nowhere between, so a silo standing on floors 1 to 9 has five bays
          // of generation for thirty-five rooms and a hundred and twenty
          // people: measured at 91 generated against 153 drawn on day two,
          // browned out from the first morning, sixteen residents left of a
          // hundred and twenty by day 100. Every "No working Airlock" in the
          // expedition and conquest fixtures is that brownout — the airlock
          // sits low on the shed order and never came up.
          //
          // Ranking the plant is the only lever the plan leaves, and it is
          // also exactly what the game's own upgrade order would have told
          // this silo to do. Measured over 100 days, generation at rank:
          //
          //   1   91 against 153, 16 residents left
          //   2  121 against 153, 102 left
          //   3  146 against 153, 101 left
          //   4  171 against 153, 173 left
          //   5  197 against 153, 176 left
          //
          // Four: the first rank with real headroom, and the campaign grows
          // rather than shrinking. Ranking every room instead was measured and
          // is worse in both directions — demand rises faster than generation
          // (109 against 212 at rank 4) and the posts outrun the people, 92
          // filled of 141 — which is the same over-building wall the opening
          // has, reached from the other end.
          level: (getRoom(spec.type)?.produces?.power || 0) > 0
            ? Math.max(spec.level, BAL.silo.sufficientPlantRank)
            : spec.level,
          condition: BAL.silo.condition.start, strict: true,
        });
      }
    }
  }

  // ---- people -------------------------------------------------------------
  const defaultPop =
    opts.scenario === 'sufficient'
      ? BAL.citizens.sufficientPopulation
      : BAL.citizens.startPopulation;
  const pop = opts.population ?? defaultPop;
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
      // Read off the constants rather than written out, because this sentence
      // has been wrong twice: it still said ninety-two floors after the silo
      // became 144, and fourteen dug after the opening was cut to six. It is
      // the first thing a new player reads.
      `Handover complete. Silo 12 is yours: ${BAL.silo.totalFloors} floors, ` +
      `${BAL.silo.startExcavatedFloors} of them dug, ${pop} residents, and a radio ` +
      'nobody has been allowed to use.',
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
  // Returning null on a bad spec is right for runtime callers, which offer
  // the player only placements they have already validated. It is wrong for
  // the hand-written starting layouts above: a typo'd floor or an overlapping
  // slot there silently removes a room from a silo that is supposed to be
  // complete, and the game only tells you about it fifty game days later when
  // the air runs out. `strict` is set for those, and only those.
  const reject = (why) => {
    if (spec.strict) throw new Error(`placeRoom: ${spec.type} on floor ${spec.floor} slot ${spec.slot} — ${why}`);
    return null;
  };

  const def = getRoom(spec.type);
  if (!def) return reject('no such room type');
  const floor = state.silo.floors[spec.floor - 1];
  if (!floor) return reject('floor out of range');
  if (!floor.excavated) return reject('floor is not excavated');

  const width = spec.width ?? def.width;
  if (spec.slot + width > BAL.silo.slotsPerFloor) return reject(`width ${width} overruns the floor`);
  for (let i = 0; i < width; i++) {
    if (floor.slots[spec.slot + i] != null) return reject(`slot ${spec.slot + i} is already occupied`);
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
