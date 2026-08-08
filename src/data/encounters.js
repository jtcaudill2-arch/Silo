/**
 * encounters.js — the enemy roster and the encounter tables (spec §11).
 *
 * Two rules shape everything here. Raiders are human: they use cover, they
 * take prisoners, and they break at 40% losses. Mutants are not: they have no
 * morale, they never flee, and several of them do something worse when they
 * die than when they're alive.
 *
 * Encounter weights shift with distance band and with total elapsed days —
 * the wasteland gets worse over time, which is what eventually forces a
 * turtling player out of the silo.
 */

// --------------------------------------------------------------- enemies ---

export const RAIDERS = [
  {
    id: 'scrappers', name: 'Scrappers', tier: 1, power: 8, human: true,
    flee: 0.4, count: [3, 7],
    desc: 'Half-starved and carrying whatever they found. They will run.',
  },
  {
    id: 'dust_runners', name: 'Dust Runners', tier: 2, power: 18, human: true,
    flee: 0.4, count: [4, 8], ambush: 0.25,
    desc: 'Fast, mounted on nothing, and they pick the ground.',
  },
  {
    id: 'slag_crews', name: 'The Slag Crews', tier: 3, power: 35, human: true,
    flee: 0.4, count: [5, 10], armored: 0.2, takesPrisoners: true,
    desc: 'Organised, armoured, and they do not kill everybody. That is worse.',
  },
  {
    id: 'warband', name: 'Warband', tier: 4, power: 60, human: true,
    flee: 0.4, count: [8, 16], vehicles: true, pursues: true,
    desc: 'Vehicles, discipline, and a stated intention to follow you home.',
  },
];

export const MUTANTS = [
  {
    id: 'shamblers', name: 'Shamblers', tier: 1, power: 6, human: false,
    flee: 0, count: [6, 14], swarm: true,
    desc: 'Slow. There are always more than you counted.',
  },
  {
    id: 'rippers', name: 'Rippers', tier: 2, power: 16, human: false,
    flee: 0, count: [3, 8], bleed: 6,
    desc: 'Fast, and the wounds keep opening on the walk home.',
  },
  {
    id: 'bloats', name: 'Bloats', tier: 3, power: 28, human: false,
    flee: 0, count: [2, 5], ruptureRad: 14,
    desc: 'Ruptures when killed. The whole squad takes the dose.',
  },
  {
    id: 'hulks', name: 'Hulks', tier: 4, power: 50, human: false,
    flee: 0, count: [1, 3], minWeaponTier: 3,
    desc: 'Armour-piercing, and immune to anything under a tier-three weapon.',
  },
  {
    id: 'broodmother', name: 'Broodmother', tier: 5, power: 85, human: false,
    flee: 0, count: [1, 1], spawns: 'shamblers', unique: true, anchored: true,
    desc: 'Spawns more of them every round. It does not move, and it does not have to.',
  },
];

export const ENEMIES = Object.fromEntries([...RAIDERS, ...MUTANTS].map((e) => [e.id, e]));

export function getEnemy(id) {
  return ENEMIES[id] || null;
}

// ------------------------------------------------------------ encounters ---

/**
 * Encounter definitions. `weight` is the base draw chance; `bands` limits
 * which distance bands it can appear in. `type` drives resolution:
 *
 *   combat   — fight it, or don't go
 *   scavenge — a risk/reward choice
 *   survivor — a recruit, possibly a trap
 *   hazard   — happens to you; no choice
 *   discovery— map nodes, caches, beacons
 *   moral    — a choice with Order and reputation consequences
 */
const E = (def) => ({ weight: 10, bands: ['near', 'mid', 'deep', 'approach', 'scar'], ...def });

export const ENCOUNTERS = [
  // ---- combat ------------------------------------------------------------
  E({
    id: 'scrapper_ambush', type: 'combat', enemy: 'scrappers', weight: 22,
    bands: ['near', 'mid'],
    text: 'Movement in a collapsed stairwell. Four of them, maybe five, and they have seen you.',
  }),
  E({
    id: 'shambler_drift', type: 'combat', enemy: 'shamblers', weight: 20,
    bands: ['near', 'mid', 'deep'],
    text: 'They come out of the dust in ones and twos, and then not in ones and twos.',
  }),
  E({
    id: 'dust_runner_hit', type: 'combat', enemy: 'dust_runners', weight: 16,
    bands: ['mid', 'deep', 'approach'],
    text: 'They were waiting on the high ground. Of course they were.',
  }),
  E({
    id: 'ripper_pack', type: 'combat', enemy: 'rippers', weight: 15,
    bands: ['mid', 'deep', 'scar'],
    text: 'Something fast crosses the road ahead. Then something fast crosses behind.',
  }),
  E({
    id: 'slag_patrol', type: 'combat', enemy: 'slag_crews', weight: 12,
    bands: ['deep', 'approach'],
    text: 'A cordon, properly set. Somebody down here is being paid to hold this ground.',
  }),
  E({
    id: 'bloat_nest', type: 'combat', enemy: 'bloats', weight: 11,
    bands: ['deep', 'approach', 'scar'],
    text: 'The smell arrives a full minute before they do.',
  }),
  E({
    id: 'hulk', type: 'combat', enemy: 'hulks', weight: 8,
    bands: ['deep', 'scar'],
    text: 'It stands up. It keeps standing up.',
  }),
  E({
    id: 'warband_column', type: 'combat', enemy: 'warband', weight: 6,
    bands: ['approach', 'scar'],
    text: 'Engines. Nobody out here has engines except the Anvil.',
  }),
  E({
    id: 'broodmother', type: 'combat', enemy: 'broodmother', weight: 3,
    bands: ['scar'],
    text: 'The floor of the crater is moving, and at the centre of it something is not.',
  }),

  // ---- scavenge ----------------------------------------------------------
  E({
    id: 'collapsed_hospital', type: 'scavenge', weight: 14, bands: ['near', 'mid', 'deep'],
    text: 'A hospital, three floors of it still standing, and the pharmacy wing is intact.',
    choices: [
      { id: 'enter', label: 'Go in', loot: 1.6, rad: 12, riskCollapse: 0.18, lootBias: 'meds' },
      { id: 'surface', label: 'Strip the ground floor only', loot: 0.5, rad: 3, riskCollapse: 0.02 },
      { id: 'leave', label: 'Leave it', loot: 0, rad: 0, riskCollapse: 0 },
    ],
  }),
  E({
    id: 'fuel_depot', type: 'scavenge', weight: 12, bands: ['near', 'mid'],
    text: 'A tank farm. Most of it burst decades ago; two tanks did not.',
    choices: [
      { id: 'siphon', label: 'Siphon both', loot: 1.4, rad: 4, riskFire: 0.15, lootBias: 'fuel' },
      { id: 'one', label: 'Take one and go', loot: 0.6, rad: 1, riskFire: 0.02 },
      { id: 'leave', label: 'Leave it', loot: 0, rad: 0 },
    ],
  }),
  E({
    id: 'motor_pool', type: 'scavenge', weight: 11, bands: ['mid', 'deep'],
    text: 'A maintenance pit with four vehicles over it, all of them stripped except one.',
    choices: [
      { id: 'cut', label: 'Cut it apart', loot: 1.3, rad: 2, timeCost: 1, lootBias: 'parts' },
      { id: 'quick', label: 'Take what lifts out', loot: 0.55, rad: 1 },
      { id: 'leave', label: 'Leave it', loot: 0, rad: 0 },
    ],
  }),
  E({
    id: 'hot_cache', type: 'scavenge', weight: 9, bands: ['deep', 'approach', 'scar'],
    text: 'A sealed pre-Collapse cache. The dosimeter is not happy about the seal.',
    choices: [
      { id: 'open', label: 'Open it', loot: 2.0, rad: 26, artifactBonus: 0.35 },
      { id: 'mark', label: 'Mark it and come back with better suits', loot: 0, rad: 2, marks: true },
      { id: 'leave', label: 'Leave it', loot: 0, rad: 0 },
    ],
  }),

  // ---- survivors ---------------------------------------------------------
  E({
    id: 'lone_survivor', type: 'survivor', weight: 12, bands: ['near', 'mid', 'deep'],
    text: 'One person, alone, upwind of you and making no effort to hide.',
    trapChance: 0.16,
  }),
  E({
    id: 'silo_exile', type: 'survivor', weight: 9, bands: ['mid', 'deep', 'approach'],
    text: 'Exiled from somewhere. They will not say where, which tells you where.',
    trapChance: 0.1, dissidentBonus: 0.3,
  }),
  E({
    id: 'drift_scout', type: 'survivor', weight: 7, bands: ['deep', 'approach'],
    text: 'A scout from Drift, injured, a long way from the ruins they live in.',
    trapChance: 0.02, reputation: { silo: 14, amount: 6 }, skillBias: 'combat',
  }),

  // ---- hazards -----------------------------------------------------------
  E({
    id: 'dust_storm', type: 'hazard', weight: 16,
    text: 'The horizon goes the colour of rust and then there is no horizon.',
    suitDamage: 20, timeCost: 1,
  }),
  E({
    id: 'sinkhole', type: 'hazard', weight: 10, bands: ['mid', 'deep', 'approach', 'scar'],
    text: 'The road gives way. It takes a while to work out who is still on it.',
    injury: [10, 30], suitDamage: 8,
  }),
  E({
    id: 'chem_pocket', type: 'hazard', weight: 11, bands: ['mid', 'deep', 'scar'],
    text: 'Still air in a low place, and the filters start screaming.',
    rad: 14, suitDamage: 12,
  }),
  E({
    id: 'hard_going', type: 'hazard', weight: 12,
    text: 'Rubble the whole way. The suits take it worse than the squad does.',
    suitDamage: 10,
  }),

  // ---- discovery ---------------------------------------------------------
  E({
    id: 'radio_beacon', type: 'discovery', weight: 9, bands: ['mid', 'deep', 'approach'],
    text: 'A repeater mast, still transmitting on a Compact frequency nobody uses any more.',
    reveals: 'silo', intel: 1,
  }),
  E({
    id: 'map_node', type: 'discovery', weight: 12,
    text: 'A survey marker, and under it a case of charts somebody meant to come back for.',
    reveals: 'map',
  }),
  E({
    id: 'sealed_airlock', type: 'discovery', weight: 6, bands: ['approach', 'deep'],
    text: 'A silo airlock. Sealed, lit from inside, and somebody is looking back through the port.',
    reveals: 'silo', contact: true,
  }),
  E({
    id: 'cache', type: 'discovery', weight: 11,
    text: 'A stash under a slab. Whoever left it did not come back for it.',
    loot: 0.8,
  }),

  // ---- moral choices -----------------------------------------------------
  E({
    id: 'starving_family', type: 'moral', weight: 10, bands: ['near', 'mid'],
    text: 'Four of them under a culvert. Two are children. They have no water and they know it.',
    choices: [
      { id: 'feed', label: 'Give them supplies', cost: { food: 40, water: 30 }, order: 3, morale: 4, recruit: 0.5 },
      { id: 'recruit', label: 'Bring them back to Silo 12', order: -2, recruit: 1, crowding: true },
      { id: 'pass', label: 'Walk on', order: -4, morale: -6 },
    ],
  }),
  E({
    id: 'wounded_raider', type: 'moral', weight: 9, bands: ['mid', 'deep'],
    text: 'One of them is still alive. Not for long without help, and he knows the ground here.',
    choices: [
      { id: 'treat', label: 'Treat him', cost: { meds: 12 }, intel: 1, order: -2, recruit: 0.35 },
      { id: 'question', label: 'Question him and leave him', intel: 1, order: -3, morale: -3 },
      { id: 'finish', label: 'Finish it', order: -5, morale: -5, hardens: true },
    ],
  }),
  E({
    id: 'silo_exile_plea', type: 'moral', weight: 7, bands: ['deep', 'approach'],
    text: 'Gallow Deep exiled her for something she will not name. She is asking for the airlock.',
    choices: [
      { id: 'admit', label: 'Take her in', recruit: 1, reputation: { silo: 16, amount: -10 } },
      { id: 'trade', label: 'Sell her back to Gallow Deep', chits: 180, order: -8, reputation: { silo: 16, amount: 12 } },
      { id: 'refuse', label: 'Refuse', order: -1, morale: -2 },
    ],
  }),
];

/**
 * The encounter pool for a band, weighted. Combat weights shift upward with
 * elapsed days: the wasteland gets worse, so turtling stops being free.
 */
export function poolFor(band, dayIndex) {
  const escalation = Math.min(1, dayIndex / 400);
  return ENCOUNTERS.filter((e) => e.bands.includes(band)).map((e) => {
    let w = e.weight;
    if (e.type === 'combat') {
      const enemy = ENEMIES[e.enemy];
      // Higher-tier fights become more likely as the years pass.
      w *= 1 + escalation * (enemy ? enemy.tier * 0.35 : 0.5);
    } else if (e.type === 'scavenge' || e.type === 'discovery') {
      w *= 1 - escalation * 0.25; // the easy salvage runs out
    }
    return { ...e, weight: Math.max(1, w) };
  });
}

export default ENCOUNTERS;
