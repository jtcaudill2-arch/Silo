/**
 * items.js — gear. Weapons, armour, env-suits.
 *
 * Gear is individually tracked inventory (spec §10), not a stat on a
 * citizen: each piece has its own durability, gets repaired in the Armory,
 * and can be lost when a squad is routed. That's what makes a defeat cost
 * something beyond the casualty list.
 *
 * ---------------------------------------------------------------- stats ---
 *
 * Each piece carries a `stats` block, and every field in it has exactly one
 * read site in the sim. They are per-item rather than per-tier because a tier
 * is a rank and these are trade-offs: the Slag Autogun hits harder than
 * anything else at its weight and eats twice the ammunition doing it, which is
 * not a thing a single tier number can say.
 *
 *   weapon.power     unitPower's weapon multiplier          combat.js
 *   weapon.ammo      rounds per person per day, a multiplier on
 *                    `supplies.ammoPerMemberPerDay`          combat/expedition/military
 *   weapon.pierce    against `enemy.def.minWeaponTier`       combat.js
 *   armor.dr         unitPower's armour multiplier, as `1 + dr`  combat.js
 *   armor.soak       fraction taken off a survivor's wound   combat.js
 *   suit.band        the band tier this suit may go out to   expedition.js
 *   suit.shielding   dose multiplier on `band.radPerHour`    expedition/conquest
 *   suit.wear        integrity lost per hour outside         expedition/conquest
 *
 * `power` for the crafted four is what `BAL.combat.gearTierMult` was, and
 * `dr` is what `1 + tier * BAL.combat.armorPerTier` computed, to the digit —
 * so the crafted ladder every other balance number was tuned against has not
 * moved. That equivalence is asserted in test/wiring.mjs §40.
 *
 * A `loot: true` item has no `craft` block. It cannot be built, only found;
 * see `bestCraftable`, `itemsOfKind` and `military.canCraft` for the guards
 * that keep the benches from reaching for a recipe that is not there.
 */

export const WEAPONS = [
  {
    id: 'pipe_gun', name: 'Pipe Gun', kind: 'weapon', tier: 1,
    craft: { scrap: 22, parts: 4 },
    stats: { power: 1.0, ammo: 0.8, pierce: 1 },
    desc: 'Scrap barrel, hand-turned firing pin. Loud, and roughly accurate.',
  },
  {
    id: 'service_rifle', name: 'Service Rifle', kind: 'weapon', tier: 2,
    craft: { alloy: 8, parts: 8 }, unlock: 'firearms_2',
    stats: { power: 1.4, ammo: 1.0, pierce: 2 },
    desc: 'Machined receiver. The first weapon here that was designed rather than improvised.',
  },
  {
    id: 'breaching_carbine', name: 'Breaching Carbine', kind: 'weapon', tier: 3,
    craft: { alloy: 20, parts: 16 }, unlock: 'firearms_3',
    stats: { power: 1.9, ammo: 1.4, pierce: 3 },
    desc: 'Short, heavy, and unpleasant to be in front of at any range.',
  },
  {
    id: 'mag_rifle', name: 'Magnetic Rifle', kind: 'weapon', tier: 4,
    craft: { alloy: 44, parts: 34 }, unlock: 'firearms_4',
    stats: { power: 2.5, ammo: 1.1, pierce: 4 },
    desc: 'Punches a hole through a Hulk. Punches a hole through most things.',
  },

  // ---- looted only ---------------------------------------------------------
  {
    id: 'garrison_rifle', name: 'Garrison Rifle', kind: 'weapon', tier: 4, loot: true,
    stats: { power: 2.4, ammo: 0.85, pierce: 4 },
    desc: 'Taken off a silo that issued them by the rack. Cheap to feed, and it was never meant to leave a corridor.',
  },
  {
    id: 'slag_autogun', name: 'Slag Autogun', kind: 'weapon', tier: 4, loot: true,
    // 3.0, not 2.6. At 2.6 this was +4% power over a Magnetic Rifle for +82%
    // ammunition and a lost pierce tier — a trade nobody who could see the
    // numbers would ever take, and one the auto-equipper took for them. It is
    // now the hardest-hitting weapon in the game, including the tier-5
    // Rail-Carbine, and still cannot open a tier-4 gate and still eats twice
    // the rounds. That is a choice; the old numbers were a mistake with a
    // description attached.
    stats: { power: 3.0, ammo: 2.0, pierce: 3 },
    desc: 'Belt-fed, welded together out of two other guns. Hits harder than anything the benches make, and empties the pouches doing it.',
  },
  {
    id: 'rail_carbine', name: 'Rail-Carbine', kind: 'weapon', tier: 5, loot: true,
    stats: { power: 2.9, ammo: 1.3, pierce: 4 },
    desc: 'Pre-collapse, and still sighted true. Only the Scar has them, and only off somebody who was carrying one.',
  },
];

export const ARMOR = [
  {
    id: 'padded_vest', name: 'Padded Vest', kind: 'armor', tier: 1,
    craft: { scrap: 18, parts: 3 },
    stats: { dr: 0.12, soak: 0.0 },
    desc: 'Layered canvas over foam. Stops a knife, argues with a bullet.',
  },
  {
    id: 'plate_harness', name: 'Plate Harness', kind: 'armor', tier: 2,
    craft: { alloy: 10, parts: 6 }, unlock: 'ballistic_armor_1',
    stats: { dr: 0.24, soak: 0.1 },
    desc: 'Salvaged plate on webbing. Heavy, and worth every kilo.',
  },
  {
    id: 'composite_rig', name: 'Composite Rig', kind: 'armor', tier: 3,
    craft: { alloy: 26, parts: 18 }, unlock: 'firearms_3',
    stats: { dr: 0.36, soak: 0.15 },
    desc: 'Layered alloy and weave. Turns a Ripper into an inconvenience.',
  },
  {
    id: 'breacher_plate', name: 'Breacher Plate', kind: 'armor', tier: 4,
    craft: { alloy: 52, parts: 30 }, unlock: 'firearms_4',
    stats: { dr: 0.48, soak: 0.25 },
    desc: 'Built for standing in a doorway somebody else is shooting at.',
  },

  // ---- looted only ---------------------------------------------------------
  {
    id: 'slag_plate', name: 'Slag Plate', kind: 'armor', tier: 4, loot: true,
    stats: { dr: 0.42, soak: 0.45 },
    desc: 'Vehicle skin cut down and re-hung. Turns fewer rounds than a Breacher Plate and spreads the ones it does not.',
  },
  {
    id: 'compact_cuirass', name: 'Compact Cuirass', kind: 'armor', tier: 5, loot: true,
    stats: { dr: 0.55, soak: 0.35 },
    desc: 'Moulded to somebody who is long dead. The best plate anyone here has seen, and it fits whoever it fits.',
  },
];

export const SUITS = [
  {
    id: 'suit_1', name: 'Env-Suit I', kind: 'suit', tier: 1,
    craft: { alloy: 6, parts: 8 }, unlock: 'env_suit_1',
    stats: { band: 1, shielding: 0.55, wear: 0.55 },
    desc: 'Sealed canvas and a scrubber. Near ruins only, and not for long.',
  },
  {
    id: 'suit_2', name: 'Env-Suit II', kind: 'suit', tier: 2,
    craft: { alloy: 16, parts: 16 }, unlock: 'env_suit_2',
    stats: { band: 2, shielding: 0.42, wear: 0.42 },
    desc: 'Layered shielding. The Mid waste becomes survivable.',
  },
  {
    id: 'suit_3', name: 'Env-Suit III', kind: 'suit', tier: 3,
    craft: { alloy: 34, parts: 30 }, unlock: 'env_suit_3',
    stats: { band: 3, shielding: 0.3, wear: 0.3 },
    desc: 'Deep waste and silo approaches. Woven from something you had to go and find.',
  },
  {
    id: 'suit_4', name: 'Env-Suit IV', kind: 'suit', tier: 4,
    craft: { alloy: 70, parts: 55 }, unlock: 'env_suit_4',
    stats: { band: 4, shielding: 0.2, wear: 0.2 },
    desc: 'The Scar. Twelve days out and back, if the seals hold.',
  },

  // ---- looted only ---------------------------------------------------------
  {
    id: 'registry_skin', name: 'Registry Skin', kind: 'suit', tier: 5, loot: true,
    // Its advantage is `wear`, not `shielding`, and that is measured rather
    // than stylistic: dose on every band a tier-4 suit can reach already
    // clamps at 100 whatever it is multiplied by, so a better-shielded suit
    // would change no number the player can see. Integrity does move.
    stats: { band: 4, shielding: 0.2, wear: 0.1 },
    desc: 'Grey, unmarked, and the seams do not fray. Two Scar runs on a set that should have failed after one.',
  },
];

export const ITEMS = Object.fromEntries(
  [...WEAPONS, ...ARMOR, ...SUITS].map((i) => [i.id, i])
);

export const ITEM_LIST = Object.values(ITEMS);

export function getItem(id) {
  return ITEMS[id] || null;
}

/**
 * Best craftable item of a kind at the player's current tech.
 *
 * `item.loot` is the whole point of the skip. A looted piece has no `craft`
 * block at all, so anything that treats this answer as "the thing to build"
 * reads `undefined.something` — and the tier-5 kit would otherwise win this
 * comparison outright, since it sits above everything the benches can make.
 */
export function bestCraftable(kind, tier) {
  const pool = kind === 'weapon' ? WEAPONS : kind === 'armor' ? ARMOR : SUITS;
  let best = null;
  for (const item of pool) {
    if (item.loot) continue;
    if (item.tier > tier) continue;
    if (!best || item.tier > best.tier) best = item;
  }
  return best;
}

/**
 * The craftable items of a kind, in ladder order. This is what the Armory
 * panel enumerates to draw its rows, and each row prints
 * `Object.entries(item.craft)` — so a looted piece in this list is not a
 * cosmetic wart, it is `TypeError: Cannot convert undefined or null to object`
 * thrown out of the panel render, taking the whole Military tab with it.
 * Measured against the un-guarded version with one loot item injected.
 */
export function itemsOfKind(kind) {
  const pool = kind === 'weapon' ? WEAPONS : kind === 'armor' ? ARMOR : SUITS;
  return pool.filter((i) => !i.loot);
}

/** Every item of a kind, looted included — for display of what is racked. */
export function allOfKind(kind) {
  return kind === 'weapon' ? WEAPONS : kind === 'armor' ? ARMOR : SUITS;
}

/**
 * Loot tables by reward tier — what an expedition can bring home.
 *
 * `gear` is read in the same loop as `artifacts` (expedition.js `addLoot`), so
 * it is a chance per draw and inherits the same `mult` off combat wins,
 * scavenge choices and caches. It only exists on tiers 3 and 4: the ground a
 * squad can only reach in a tier-3 suit is the first ground that pays in kit,
 * and the tier-5 set is the Scar's alone.
 *
 * Rates were set against the measured number of `addLoot` draws a campaign
 * makes at each tier — 24-34 at tier 3 and 16-53 at tier 4 over two 900-day
 * runs — and then re-measured in play; see test/wiring.mjs §42.
 */
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
    gear: { slag_autogun: 0.05, slag_plate: 0.06 },
    chance: { survivor: 0.35 },
  },
  4: {
    resources: { alloy: [40, 110], parts: [30, 70], meds: [20, 50], ammo: [40, 120], coolant: [10, 45] },
    artifacts: { origin_shard: 0.28, reactor_core: 0.22, suit_weave: 0.25, optics_array: 0.25 },
    // The tier-5 rates are 0.09, not 0.04, and the reason is the window
    // rather than the rate.
    //
    // Measured over six campaigns: the deep band opens on day 405-480 and
    // tier-4 loot is plentiful — 5.8 Slag Plates and 3.7 Slag Autoguns a
    // campaign, first sighted around day 490, so roughly 230 days of use. The
    // Scar opens day 572-684 against campaigns that end around 719, which is
    // a hundred and twenty days, and at 0.04 that paid 2.3 tier-5 pieces
    // across all three types put together. A Compact Cuirass landing on day
    // 721 of a 725-day run is not a reward, it is a receipt.
    //
    // These are the only three items in the game that exist above the crafted
    // ladder, and they drop from the hardest ground there is. They should kit
    // part of a squad by the end, not arrive one at a time as the credits
    // roll.
    gear: {
      slag_autogun: 0.06, slag_plate: 0.07,
      rail_carbine: 0.09, compact_cuirass: 0.09, registry_skin: 0.09,
    },
    chance: { survivor: 0.25 },
  },
};

export default ITEMS;
