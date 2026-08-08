/**
 * traits.js — citizen traits.
 *
 * Traits are multipliers and flags, never flat "+5 to everything". Each one
 * should change how you'd deploy the person, not just how good they are.
 * `weight` is the relative chance of rolling it when a trait is granted.
 */

export const TRAITS = {
  hardy: {
    id: 'hardy',
    name: 'Hardy',
    weight: 10,
    good: true,
    desc: 'Shrugs off what puts other people in the clinic.',
    mods: { healthRegen: 1.5, radResist: 0.7, vitalityDecline: 0.85 },
  },
  gifted: {
    id: 'gifted',
    name: 'Gifted',
    weight: 5,
    good: true,
    desc: 'Learns roughly twice as fast as anyone expects.',
    mods: { skillGrowth: 2.0 },
  },
  steady: {
    id: 'steady',
    name: 'Steady',
    weight: 9,
    good: true,
    desc: 'Morale barely moves. Useful in a bad year.',
    mods: { moraleSwing: 0.45 },
  },
  loyalist: {
    id: 'loyalist',
    name: 'Loyalist',
    weight: 8,
    good: true,
    desc: 'Believes in the office of the mayor. Will not join an uprising.',
    mods: { orderContribution: 1.6, uprisingSide: 'loyal' },
  },
  sure_hands: {
    id: 'sure_hands',
    name: 'Sure Hands',
    weight: 7,
    good: true,
    desc: 'Machines last longer under their care.',
    mods: { conditionWear: 0.7, workOutput: 1.1 },
  },
  ironlung: {
    id: 'ironlung',
    name: 'Iron Lung',
    weight: 5,
    good: true,
    desc: 'Bad air barely registers. Born for the deep floors.',
    mods: { airResist: 0.4 },
  },
  quick: {
    id: 'quick',
    name: 'Quick',
    weight: 7,
    good: true,
    desc: 'Faster than the thing coming at them.',
    mods: { combatEvade: 1.25 },
  },
  nurturer: {
    id: 'nurturer',
    name: 'Nurturer',
    weight: 6,
    good: true,
    desc: 'People heal faster with them in the room.',
    mods: { healOthers: 1.4, relationshipGrowth: 1.5 },
  },

  sickly: {
    id: 'sickly',
    name: 'Sickly',
    weight: 8,
    good: false,
    desc: 'Something was wrong from the start and the clinic never fixed it.',
    mods: { healthRegen: 0.5, vitalityDecline: 1.4, deathChance: 1.5 },
  },
  coward: {
    id: 'coward',
    name: 'Coward',
    weight: 7,
    good: false,
    desc: 'Will break before the line does.',
    mods: { combatPower: 0.7, squadMorale: -4 },
  },
  dissident: {
    id: 'dissident',
    name: 'Dissident',
    weight: 8,
    good: false,
    hidden: true, // only visible with the Informant Network policy
    desc: 'Does not believe the Compact, the mayor, or the official story.',
    mods: { dissentMultiplier: 1.35, uprisingSide: 'rebel', orderContribution: -1.2 },
  },
  glutton: {
    id: 'glutton',
    name: 'Glutton',
    weight: 6,
    good: false,
    desc: 'Eats for two and works for one.',
    mods: { foodConsumption: 1.8 },
  },
  brittle: {
    id: 'brittle',
    name: 'Brittle',
    weight: 6,
    good: false,
    desc: 'Injuries land harder and heal slower.',
    mods: { injuryTaken: 1.5 },
  },
  sullen: {
    id: 'sullen',
    name: 'Sullen',
    weight: 7,
    good: false,
    desc: 'Drags the mood of every room they are put in.',
    mods: { moraleAura: -0.35, relationshipGrowth: 0.5 },
  },
  clumsy: {
    id: 'clumsy',
    name: 'Clumsy',
    weight: 6,
    good: false,
    desc: 'Equipment does not survive them.',
    mods: { conditionWear: 1.5, accidentChance: 2.0 },
  },

  // ---- acquired: never rolled at birth, only granted by events ----
  crippled: {
    id: 'crippled',
    name: 'Crippled',
    weight: 0,
    acquired: true,
    good: false,
    desc: 'Came back from the surface, but not all the way.',
    mods: { workOutput: 0.6, combatPower: 0.45, vitalityDecline: 1.2 },
  },
  scarred: {
    id: 'scarred',
    name: 'Scarred',
    weight: 0,
    acquired: true,
    good: false,
    desc: 'Carries the mark. Other people notice it first.',
    mods: { moraleAura: -0.15, combatPower: 1.08 },
  },
  shellshocked: {
    id: 'shellshocked',
    name: 'Shell-shocked',
    weight: 0,
    acquired: true,
    good: false,
    desc: 'Cannot be sent out again without cost.',
    mods: { moraleSwing: 1.8, combatPower: 0.75, expeditionMoraleHit: -8 },
  },
  veteran: {
    id: 'veteran',
    name: 'Veteran',
    weight: 0,
    acquired: true,
    good: true,
    desc: 'Has been out, and come back, more than once.',
    mods: { combatPower: 1.2, squadMorale: 3 },
  },
  irradiated: {
    id: 'irradiated',
    name: 'Irradiated',
    weight: 0,
    acquired: true,
    good: false,
    desc: 'The dose is permanent now. The clinic can only slow it.',
    mods: { radDecay: 0.3, vitalityDecline: 1.5 },
  },
  bereaved: {
    id: 'bereaved',
    name: 'Bereaved',
    weight: 0,
    acquired: true,
    good: false,
    temporary: true,
    desc: 'Lost someone close. It will pass, or it will not.',
    mods: { moraleSwing: 1.4, workOutput: 0.85 },
  },
};

export const TRAIT_LIST = Object.values(TRAITS);
export const BIRTH_TRAITS = TRAIT_LIST.filter((t) => t.weight > 0);

export function getTrait(id) {
  return TRAITS[id] || null;
}

/**
 * Resolve a modifier across a citizen's traits. Multiplicative mods default
 * to 1 and multiply; additive mods (named in ADDITIVE) default to 0 and sum.
 */
const ADDITIVE = new Set(['squadMorale', 'moraleAura', 'expeditionMoraleHit', 'orderContribution']);

export function traitMod(traits, key) {
  const additive = ADDITIVE.has(key);
  let acc = additive ? 0 : 1;
  if (!traits || traits.length === 0) return acc;
  for (const id of traits) {
    const t = TRAITS[id];
    if (!t || !t.mods || t.mods[key] === undefined) continue;
    const v = t.mods[key];
    if (typeof v !== 'number') continue;
    if (additive) acc += v;
    else acc *= v;
  }
  return acc;
}

export function traitFlag(traits, key) {
  if (!traits) return null;
  for (const id of traits) {
    const t = TRAITS[id];
    if (t && t.mods && t.mods[key] !== undefined && typeof t.mods[key] !== 'number') {
      return t.mods[key];
    }
  }
  return null;
}

export default TRAITS;
