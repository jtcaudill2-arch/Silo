/**
 * rooms.js — the room catalogue (spec §4.1).
 *
 * All rates are "per cycle, at level 1, width 1, fully staffed by a citizen
 * with the matching skill at 50, at 100 condition". Everything else is a
 * multiplier applied in sim/economy.js. Costs and rates are content, not
 * balance knobs, but the multipliers that act on them all live in
 * config/balance.js.
 */

/** Skill keys used for staffing matches. */
export const SKILLS = ['farming', 'mechanics', 'medicine', 'science', 'combat', 'engineering', 'admin'];

/** Job categories shown in the population panel. */
export const CATEGORIES = {
  life: 'Life Support',
  production: 'Production',
  civic: 'Civic',
  security: 'Security',
  science: 'Science',
  surface: 'Surface',
  storage: 'Storage',
};

/**
 * @typedef {object} RoomDef
 * @property {string} id
 * @property {string} name
 * @property {string} category
 * @property {number} width           default slot width when built
 * @property {object} produces        per-cycle output
 * @property {object} consumes        per-cycle input
 * @property {object} upkeep          consumed even when unstaffed
 * @property {object|null} staff      { skill, slotsPerLevel }
 * @property {object} buildCost
 * @property {object} provides        non-resource effects
 * @property {string|null} unlock     research id gate
 * @property {string|null} tierGate   floor tier key required
 */

const R = (def) => ({
  width: 1,
  produces: {},
  consumes: {},
  upkeep: {},
  staff: null,
  buildCost: {},
  provides: {},
  unlock: null,
  tierGate: null,
  canMerge: true,
  breachable: true,
  ...def,
});

export const ROOMS = {
  generator_hall: R({
    id: 'generator_hall',
    name: 'Generator Hall',
    category: 'life',
    width: 2,
    produces: { power: 32 },
    consumes: { fuel: 0.3, scrap: 0.1 },
    staff: { skill: 'mechanics', slotsPerLevel: [2, 3, 4, 5, 6] },
    buildCost: { scrap: 180, parts: 12 },
    desc: 'Burns fuel for power. Everything in the silo hangs off this one number.',
  }),

  reactor: R({
    id: 'reactor',
    name: 'Reactor',
    category: 'life',
    width: 3,
    produces: { power: 128 },
    consumes: { fuel: 1.1, coolant: 0.9 },
    staff: { skill: 'mechanics', slotsPerLevel: [2, 3, 4, 5, 6] },
    buildCost: { scrap: 900, alloy: 220, parts: 90 },
    unlock: 'reactor_tech',
    tierGate: 'deeps',
    hazard: 'meltdown',
    desc: 'Four times the output of a generator hall and a failure mode to match.',
  }),

  water_reclaimer: R({
    id: 'water_reclaimer',
    name: 'Water Reclaimer',
    category: 'life',
    width: 2,
    produces: { water: 22 },
    consumes: { power: 6 },
    staff: { skill: 'mechanics', slotsPerLevel: [2, 2, 3, 4, 5] },
    buildCost: { scrap: 150, parts: 10 },
    desc: 'Closed-loop reclamation. When this fails the silo has about four days.',
  }),

  hydroponics: R({
    id: 'hydroponics',
    name: 'Hydroponics Bay',
    category: 'life',
    width: 2,
    produces: { food: 11 },
    consumes: { power: 5, water: 6 },
    staff: { skill: 'farming', slotsPerLevel: [2, 3, 4, 5, 6] },
    buildCost: { scrap: 140, parts: 8 },
    hazard: 'blight',
    desc: 'Racked greens under sodium lamps. Vulnerable to blight.',
  }),

  protein_vats: R({
    id: 'protein_vats',
    name: 'Protein Vats',
    category: 'life',
    width: 2,
    produces: { food: 19 },
    consumes: { power: 10, water: 4 },
    staff: { skill: 'farming', slotsPerLevel: [2, 2, 3, 4, 5] },
    buildCost: { scrap: 260, parts: 30, alloy: 20 },
    unlock: 'protein_vats',
    tierGate: 'mids',
    provides: { moralePenaltyPerCycle: 0.12 },
    desc: 'More calories per watt than anything else. Nobody likes eating it.',
  }),

  air_filtration: R({
    id: 'air_filtration',
    name: 'Air Filtration',
    category: 'life',
    width: 2,
    consumes: { power: 7, filters: 0.05 },
    staff: { skill: 'mechanics', slotsPerLevel: [2, 2, 3, 4, 5] },
    buildCost: { scrap: 170, parts: 14 },
    provides: { airCapacity: 45 }, // per slot per level — the population ceiling
    desc: 'Scrubs the air. Its capacity is the hard ceiling on your population.',
  }),

  residences: R({
    id: 'residences',
    name: 'Residences',
    category: 'civic',
    width: 2,
    consumes: { power: 2 },
    buildCost: { scrap: 110, parts: 4 },
    provides: { housing: 21 }, // per slot per level
    desc: 'Bunks and a door that closes. Overcrowding is felt in Order first.',
  }),

  cafeteria: R({
    id: 'cafeteria',
    name: 'Cafeteria',
    category: 'civic',
    width: 2,
    consumes: { power: 3, food: 1.2 },
    staff: { skill: 'farming', slotsPerLevel: [2, 2, 3, 4, 5] },
    buildCost: { scrap: 120, parts: 6 },
    provides: { moraleBonusPerCycle: 0.5, relationshipVenue: true },
    desc: 'The only room where the whole silo mixes. Morale and gossip both.',
  }),

  clinic: R({
    id: 'clinic',
    name: 'Clinic',
    category: 'life',
    width: 2,
    consumes: { power: 4, meds: 0.35 },
    staff: { skill: 'medicine', slotsPerLevel: [2, 3, 4, 5, 6] },
    buildCost: { scrap: 160, parts: 12 },
    provides: { healing: true, radTreatment: true },
    desc: 'Treats injury and radiation. Rad treatment is always the bottleneck.',
  }),

  chem_lab: R({
    id: 'chem_lab',
    name: 'Chem Lab',
    category: 'science',
    width: 2,
    // Filters are otherwise a one-way resource: nothing in the silo makes
    // scrubber media, so the starting forty run out around day sixty and
    // decontamination becomes impossible for the rest of the game. Putting
    // media behind the first medicine node makes keeping the airlock usable
    // a research decision rather than a countdown.
    produces: { meds: 1.0, filters: 0.6 },
    consumes: { power: 5, water: 1.5, scrap: 0.6 },
    staff: { skill: 'medicine', slotsPerLevel: [2, 2, 3, 4, 5] },
    buildCost: { scrap: 200, parts: 20 },
    unlock: 'antibiotics',
    desc: 'Medicine, stimulants and scrubber media out of scrap chemistry.',
  }),

  workshop: R({
    id: 'workshop',
    name: 'Workshop',
    category: 'production',
    width: 2,
    produces: { parts: 1.8 },
    consumes: { power: 5, scrap: 2.2 },
    staff: { skill: 'engineering', slotsPerLevel: [2, 3, 4, 5, 6] },
    buildCost: { scrap: 150, parts: 6 },
    desc: 'Turns scrap into parts. Every construction project queues here.',
  }),

  recycling: R({
    id: 'recycling',
    name: 'Recycling',
    category: 'production',
    width: 2,
    produces: { scrap: 6.0, fuel: 1.3 },
    consumes: { power: 4 },
    staff: { skill: 'engineering', slotsPerLevel: [2, 3, 4, 5, 6] },
    buildCost: { scrap: 130, parts: 6 },
    desc: 'Waste and salvage back into usable stock, plus whatever will still burn. The only fuel source above the Deeps.',
  }),

  foundry: R({
    id: 'foundry',
    name: 'Foundry',
    category: 'production',
    width: 2,
    produces: { alloy: 1.1 },
    consumes: { power: 9, scrap: 3.3 },
    staff: { skill: 'engineering', slotsPerLevel: [2, 3, 4, 5, 6] },
    buildCost: { scrap: 320, parts: 34 },
    unlock: 'alloy_refining',
    // Not depth-gated. Alloy Refining is a tier-one node with no
    // prerequisites and env-suits are made of alloy, so putting the only
    // furnace behind the Lowers meant the starting forty alloy — eighteen of
    // which the Suit Bay itself eats — had to cover the whole surface
    // programme. It bought three suits, one short of a squad, and the
    // airlock stayed shut for ninety days waiting on a foundry that was
    // three research nodes and twenty floors away. The research is gate
    // enough; the Lowers keep munitions, barracks and the deep mine.
    desc: 'Three scrap in, one alloy out. Gates every weapon worth carrying.',
  }),

  munitions: R({
    id: 'munitions',
    name: 'Munitions',
    category: 'production',
    width: 2,
    produces: { ammo: 4.4 },
    consumes: { power: 6, alloy: 0.55 },
    staff: { skill: 'engineering', slotsPerLevel: [2, 2, 3, 4, 5] },
    buildCost: { scrap: 280, parts: 30, alloy: 16 },
    unlock: 'firearms_1',
    tierGate: 'lowers',
    desc: 'Ammunition. The single biggest multiplier on combat power.',
  }),

  armory: R({
    id: 'armory',
    name: 'Armory',
    category: 'security',
    width: 2,
    // Hand-loading, at the rate one bench can manage. Ammunition is
    // otherwise unobtainable above the Lowers — the near band never loots
    // any — so a silo's starting stock funds about fifteen expeditions and
    // then the airlock closes for good. Munitions is still the volume
    // source by an order of magnitude; this is just enough to keep a squad
    // walking while you dig toward one.
    produces: { ammo: 0.35 },
    consumes: { power: 2, scrap: 0.7 },
    staff: { skill: 'engineering', slotsPerLevel: [2, 2, 3, 4, 5] },
    buildCost: { scrap: 200, parts: 18 },
    provides: { gearStorage: 24, gearRepair: true, cap: { ammo: 300 } },
    desc: 'Racks, benches, and a quartermaster who reloads and repairs what comes back.',
  }),

  barracks: R({
    id: 'barracks',
    name: 'Barracks',
    category: 'security',
    width: 2,
    consumes: { power: 3 },
    buildCost: { scrap: 170, parts: 10 },
    provides: { militaryHousing: 12 },
    tierGate: 'lowers',
    desc: 'Housing for a standing army. A standing army eats.',
  }),

  training_yard: R({
    id: 'training_yard',
    name: 'Training Yard',
    category: 'security',
    width: 2,
    consumes: { power: 3, ammo: 0.5 },
    staff: { skill: 'combat', slotsPerLevel: [1, 2, 2, 3, 3] },
    buildCost: { scrap: 190, parts: 14 },
    provides: { training: true },
    tierGate: 'lowers',
    desc: 'Combat skill growth, paid for in ammunition.',
  }),

  sheriffs_office: R({
    id: 'sheriffs_office',
    name: "Sheriff's Office",
    category: 'security',
    width: 1,
    consumes: { power: 2 },
    staff: { skill: 'admin', slotsPerLevel: [2, 3, 4, 5, 6] },
    buildCost: { scrap: 120, parts: 8 },
    provides: { order: true, investigations: true },
    desc: 'Deputies, a desk, and the paperwork that follows a body.',
  }),

  holding_cells: R({
    id: 'holding_cells',
    name: 'Holding Cells',
    category: 'security',
    width: 1,
    consumes: { power: 2, food: 0.3 },
    staff: { skill: 'admin', slotsPerLevel: [1, 2, 2, 3, 3] },
    buildCost: { scrap: 140, parts: 10 },
    provides: { cells: 6 },
    desc: 'Six cells. You will fill them faster than you expect.',
  }),

  laboratory: R({
    id: 'laboratory',
    name: 'Laboratory',
    category: 'science',
    width: 2,
    consumes: { power: 6 },
    staff: { skill: 'science', slotsPerLevel: [2, 3, 4, 5, 6] },
    buildCost: { scrap: 220, parts: 22 },
    provides: { research: true },
    desc: 'Research points. Nothing else in the silo produces them, which is why it is not gated behind any.',
  }),

  archive: R({
    id: 'archive',
    name: 'Archive',
    category: 'science',
    width: 2,
    consumes: { power: 4 },
    staff: { skill: 'science', slotsPerLevel: [1, 2, 2, 3, 3] },
    buildCost: { scrap: 300, parts: 40, alloy: 30 },
    provides: { researchBonus: 0.25, lore: true },
    unlock: 'pre_collapse_archives',
    tierGate: 'lowers',
    desc: 'Pre-Collapse records, most of them unreadable. Most.',
  }),

  schoolhouse: R({
    id: 'schoolhouse',
    name: 'Schoolhouse',
    category: 'civic',
    width: 2,
    consumes: { power: 3, food: 0.4 },
    staff: { skill: 'admin', slotsPerLevel: [1, 2, 2, 3, 3] },
    buildCost: { scrap: 140, parts: 10 },
    provides: { school: true },
    tierGate: 'mids',
    desc: 'Children learn faster and produce nothing. That is the trade.',
  }),

  radio_room: R({
    id: 'radio_room',
    name: 'Radio Room',
    category: 'civic',
    width: 1,
    consumes: { power: 5 },
    staff: { skill: 'admin', slotsPerLevel: [1, 2, 2, 3, 3] },
    buildCost: { scrap: 230, parts: 26 },
    provides: { radio: true },
    unlock: 'radio_range_1',
    desc: 'It has always worked. Until now nobody was allowed to transmit.',
  }),

  airlock: R({
    id: 'airlock',
    name: 'Airlock',
    category: 'surface',
    width: 2,
    consumes: { power: 4, filters: 0.05 },
    buildCost: { scrap: 260, parts: 30, alloy: 14 },
    provides: { airlock: true, deconCapacity: 4 },
    canMerge: false,
    desc: 'The only door. Decontamination capacity limits how big a squad goes out.',
  }),

  suit_bay: R({
    id: 'suit_bay',
    name: 'Suit Bay',
    category: 'surface',
    width: 2,
    consumes: { power: 4 },
    staff: { skill: 'engineering', slotsPerLevel: [2, 2, 3, 4, 5] },
    buildCost: { scrap: 240, parts: 28, alloy: 18 },
    provides: { suitCraft: true, suitRepair: true },
    unlock: 'env_suit_1',
    desc: 'Builds and patches env-suits. Suit integrity is what actually limits range.',
  }),

  storage_depot: R({
    id: 'storage_depot',
    name: 'Storage Depot',
    category: 'storage',
    width: 1,
    buildCost: { scrap: 80 },
    provides: { depot: true },
    desc: 'Raises stockpile caps. Cheap, boring, always the right call.',
  }),

  deep_mine: R({
    id: 'deep_mine',
    name: 'Deep Mine',
    category: 'production',
    width: 3,
    produces: { ore: 2.6, fuel: 1.3 },
    consumes: { power: 8 },
    staff: { skill: 'engineering', slotsPerLevel: [2, 3, 4, 5, 6] },
    buildCost: { scrap: 420, parts: 48, alloy: 30 },
    tierGate: 'deeps',
    unlock: 'deep_excavation_3',
    hazard: 'cavein',
    desc: 'Ore and fuel out of the rock below the silo. Cave-ins are not rare.',
  }),

  maintenance_bay: R({
    id: 'maintenance_bay',
    name: 'Maintenance Bay',
    category: 'production',
    width: 1,
    consumes: { power: 3, scrap: 0.5 },
    staff: { skill: 'mechanics', slotsPerLevel: [2, 3, 4, 5, 6] },
    buildCost: { scrap: 110, parts: 8 },
    provides: { maintenance: true },
    desc: 'A crew that walks the floors restoring condition. Pays for itself.',
  }),
};

export const ROOM_LIST = Object.values(ROOMS);

export function getRoom(id) {
  return ROOMS[id] || null;
}

/** Resources a room type touches, for UI preview. */
export function roomFlows(def) {
  return { produces: def.produces || {}, consumes: def.consumes || {} };
}

export default ROOMS;
