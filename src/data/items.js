/**
 * items.js — gear. Weapons, armour, env-suits.
 *
 * Gear is individually tracked inventory (spec §10), not a stat on a
 * citizen: each piece has its own durability, gets repaired in the Armory,
 * and can be lost when a squad is routed. That's what makes a defeat cost
 * something beyond the casualty list.
 */

export const WEAPONS = [
  {
    id: 'pipe_gun', name: 'Pipe Gun', kind: 'weapon', tier: 1,
    craft: { scrap: 22, parts: 4 },
    desc: 'Scrap barrel, hand-turned firing pin. Loud, and roughly accurate.',
  },
  {
    id: 'service_rifle', name: 'Service Rifle', kind: 'weapon', tier: 2,
    craft: { alloy: 8, parts: 8 }, unlock: 'firearms_2',
    desc: 'Machined receiver. The first weapon here that was designed rather than improvised.',
  },
  {
    id: 'breaching_carbine', name: 'Breaching Carbine', kind: 'weapon', tier: 3,
    craft: { alloy: 20, parts: 16 }, unlock: 'firearms_3',
    desc: 'Short, heavy, and unpleasant to be in front of at any range.',
  },
  {
    id: 'mag_rifle', name: 'Magnetic Rifle', kind: 'weapon', tier: 4,
    craft: { alloy: 44, parts: 34 }, unlock: 'firearms_4',
    desc: 'Punches a hole through a Hulk. Punches a hole through most things.',
  },
];

export const ARMOR = [
  {
    id: 'padded_vest', name: 'Padded Vest', kind: 'armor', tier: 1,
    craft: { scrap: 18, parts: 3 },
    desc: 'Layered canvas over foam. Stops a knife, argues with a bullet.',
  },
  {
    id: 'plate_harness', name: 'Plate Harness', kind: 'armor', tier: 2,
    craft: { alloy: 10, parts: 6 }, unlock: 'ballistic_armor_1',
    desc: 'Salvaged plate on webbing. Heavy, and worth every kilo.',
  },
  {
    id: 'composite_rig', name: 'Composite Rig', kind: 'armor', tier: 3,
    craft: { alloy: 26, parts: 18 }, unlock: 'firearms_3',
    desc: 'Layered alloy and weave. Turns a Ripper into an inconvenience.',
  },
  {
    id: 'breacher_plate', name: 'Breacher Plate', kind: 'armor', tier: 4,
    craft: { alloy: 52, parts: 30 }, unlock: 'firearms_4',
    desc: 'Built for standing in a doorway somebody else is shooting at.',
  },
];

export const SUITS = [
  {
    id: 'suit_1', name: 'Env-Suit I', kind: 'suit', tier: 1,
    craft: { alloy: 6, parts: 8 }, unlock: 'env_suit_1',
    desc: 'Sealed canvas and a scrubber. Near ruins only, and not for long.',
  },
  {
    id: 'suit_2', name: 'Env-Suit II', kind: 'suit', tier: 2,
    craft: { alloy: 16, parts: 16 }, unlock: 'env_suit_2',
    desc: 'Layered shielding. The Mid waste becomes survivable.',
  },
  {
    id: 'suit_3', name: 'Env-Suit III', kind: 'suit', tier: 3,
    craft: { alloy: 34, parts: 30 }, unlock: 'env_suit_3',
    desc: 'Deep waste and silo approaches. Woven from something you had to go and find.',
  },
  {
    id: 'suit_4', name: 'Env-Suit IV', kind: 'suit', tier: 4,
    craft: { alloy: 70, parts: 55 }, unlock: 'env_suit_4',
    desc: 'The Scar. Twelve days out and back, if the seals hold.',
  },
];

export const ITEMS = Object.fromEntries(
  [...WEAPONS, ...ARMOR, ...SUITS].map((i) => [i.id, i])
);

export const ITEM_LIST = Object.values(ITEMS);

export function getItem(id) {
  return ITEMS[id] || null;
}

/** Best craftable item of a kind at the player's current tech. */
export function bestCraftable(kind, tier) {
  const pool = kind === 'weapon' ? WEAPONS : kind === 'armor' ? ARMOR : SUITS;
  let best = null;
  for (const item of pool) {
    if (item.tier > tier) continue;
    if (!best || item.tier > best.tier) best = item;
  }
  return best;
}

export function itemsOfKind(kind) {
  return kind === 'weapon' ? WEAPONS : kind === 'armor' ? ARMOR : SUITS;
}

/** Loot tables by reward tier — what an expedition can bring home. */
export const LOOT = {
  1: {
    resources: { scrap: [20, 70], food: [10, 45], parts: [0, 6], filters: [0, 4] },
    artifacts: {},
    chance: { survivor: 0.2 },
  },
  2: {
    resources: { scrap: [40, 120], alloy: [4, 18], parts: [4, 16], meds: [2, 12], fuel: [10, 40] },
    // Shielded weave drops here as well as in the deep, and it has to: the
    // deep band needs tier-3 suits, tier-3 suits need weave, and weave used
    // to come only from the deep. Tier 3 required tier 3, the whole late
    // tree sat above it, and all three endings were unreachable — on any
    // seed, by any player, forever. Every suit tier must be fundable by the
    // band the tier below it can already reach. Rarer here than in the deep,
    // so a mid-band silo bootstraps slowly and a deep-band one re-supplies.
    artifacts: { intact_servo: 0.22, sealed_canister: 0.2, alloy_ingot: 0.16, suit_weave: 0.12 },
    chance: { survivor: 0.3 },
  },
  3: {
    resources: { scrap: [60, 180], alloy: [14, 46], parts: [12, 34], meds: [8, 26], ammo: [10, 60], coolant: [0, 20] },
    artifacts: { optics_array: 0.2, suit_weave: 0.18, medical_press: 0.12, reactor_core: 0.08, compact_seal: 0.06 },
    chance: { survivor: 0.35 },
  },
  4: {
    resources: { alloy: [40, 110], parts: [30, 70], meds: [20, 50], ammo: [40, 120], coolant: [10, 45] },
    artifacts: { origin_shard: 0.28, reactor_core: 0.22, suit_weave: 0.25, optics_array: 0.25 },
    chance: { survivor: 0.25 },
  },
};

export default ITEMS;
