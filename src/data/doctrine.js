/**
 * doctrine.js — the talent tree.
 *
 * Doctrine is what the silo learns from sending people outside and getting
 * them back. It is bought with Commendations, which are minted only when a
 * squad comes home from a run at or beyond the silo's frontier with nobody
 * lost — so the currency is preparation, not patience. A player who kits a
 * squad properly and picks winnable fights earns doctrine; one who grinds the
 * near ruins for four hundred days earns nothing, because the near ruins stop
 * paying the moment you have come back from somewhere worse.
 *
 * The tree is thirteen nodes: a root, and three doctrines of two ranks each,
 * every rank a **pair you must choose between**. Taking Cadre closes
 * Spearhead for the rest of the run. That is the whole design — a measured
 * campaign earns enough for six or seven of the seven slots, so the tree is
 * never a checklist and two silos never end up the same shape.
 *
 * ---------------------------------------------------------------------------
 * EVERY NODE'S EFFECT MUST BE READ SOMEWHERE.
 *
 * This codebase's characteristic bug is a declared effect that nothing
 * consumes: `durabilityLossPerCombat` and `GEAR_WEAR` were dead for the whole
 * project, `traits.temporary` was read by nothing so grief never lifted, and
 * `armorTier` was off by one so a priced tier-4 plate could not be built with
 * every research node in the game complete. Each of those shipped green.
 *
 * A talent tree is the worst possible place to do it again, because the player
 * spends a scarce currency on the node and has no way to tell. So `effect` is
 * not documentation: `test/wiring.mjs` iterates this table and, for every
 * entry, measures the quantity named in `proves` with the node off and on and
 * fails if the outcome does not move. Add a fourteenth node and it is covered
 * the moment it appears here.
 */

/** Multiplier keys, read through `doctrineMod(state, key)` in sim/doctrine.js. */
export const DOCTRINES = [
  { id: 'roster', name: 'Roster', blurb: 'Who you send, and what they are worth when they come back.' },
  { id: 'field', name: 'Field', blurb: 'What happens to them out there.' },
  { id: 'door', name: 'Door', blurb: 'What happens when it comes to you instead.' },
];

export const NODES = {
  // ---- root ---------------------------------------------------------------
  debrief: {
    id: 'debrief', name: 'Debrief', doctrine: null, rank: 0, cost: 4,
    desc: 'Every party is walked through the run on the way in. What they saw is worth as much as what they carried.',
    effect: { commendationBonus: 1 },
    proves: 'commendations',
  },

  // ---- I. Roster ----------------------------------------------------------
  cadre: {
    id: 'cadre', name: 'Cadre', doctrine: 'roster', rank: 1, cost: 12, excludes: 'spearhead',
    desc: 'Squads carry two more. More rifles at the door, and more mouths on the supply bill.',
    effect: { squadMaxBonus: 2 },
    proves: 'squadMax',
  },
  spearhead: {
    id: 'spearhead', name: 'Spearhead', doctrine: 'roster', rank: 1, cost: 12, excludes: 'cadre',
    desc: 'A small party moves as one. Four or fewer, and every one of them fights above their weight.',
    effect: { smallPartyPower: 1.25 },
    proves: 'unitPower',
  },
  succession: {
    id: 'succession', name: 'Succession', doctrine: 'roster', rank: 2, cost: 34, excludes: 'hard_school',
    desc: 'Nobody takes what they knew with them. A squadmate inherits it, in the room where it is still useful.',
    effect: { succession: true },
    proves: 'succession',
  },
  hard_school: {
    id: 'hard_school', name: 'Hard School', doctrine: 'roster', rank: 2, cost: 34, excludes: 'succession',
    desc: 'Soldiers learn from the outside faster than anyone learns from a classroom.',
    effect: { soldierSkillGrowth: 1.6 },
    proves: 'skillGrowth',
  },

  // ---- II. Field ----------------------------------------------------------
  discipline: {
    id: 'discipline', name: 'Discipline', doctrine: 'field', rank: 1, cost: 12, excludes: 'pockets',
    desc: 'Break contact on the terms you chose. People come back hurt instead of not at all.',
    effect: { injuryTaken: 0.78 },
    proves: 'wounds',
  },
  pockets: {
    id: 'pockets', name: 'Full Pockets', doctrine: 'field', rank: 1, cost: 12, excludes: 'discipline',
    desc: 'Nobody walks past anything. The run takes longer and the crates come back heavier.',
    effect: { lootMult: 1.3 },
    proves: 'loot',
  },
  prospectors: {
    id: 'prospectors', name: 'Prospectors', doctrine: 'field', rank: 2, cost: 34, excludes: 'wardens',
    desc: 'They know what a sealed canister looks like under forty years of dust, and they stop for it.',
    effect: { artifactMult: 1.6 },
    proves: 'artifacts',
  },
  wardens: {
    id: 'wardens', name: 'Wardens', doctrine: 'field', rank: 2, cost: 34, excludes: 'prospectors',
    desc: 'The things in the deep do not fight like people. Train for the things.',
    effect: { mutantPower: 1.35 },
    proves: 'mutantPower',
  },

  // ---- III. Door ----------------------------------------------------------
  muster: {
    id: 'muster', name: 'Muster', doctrine: 'door', rank: 1, cost: 12, excludes: 'cache',
    desc: 'The alarm reaches the whole silo. Anyone who has been outside and lived picks up a rifle, squad or no squad.',
    effect: { musterVeterans: true },
    proves: 'defenders',
  },
  cache: {
    id: 'cache', name: 'Door Cache', doctrine: 'door', rank: 1, cost: 12, excludes: 'muster',
    desc: 'Rounds sealed at the airlock and counted separately. A raid never finds you dry.',
    effect: { ammoFloor: 0.85 },
    proves: 'ammoFloor',
  },
  clean_room: {
    id: 'clean_room', name: 'Clean Room', doctrine: 'door', rank: 2, cost: 34, excludes: 'sealed',
    desc: 'Decontamination done properly the first time, on everyone, before anybody sits down.',
    effect: { deconRate: 1.5 },
    proves: 'decon',
  },
  sealed: {
    id: 'sealed', name: 'Sealed Doors', doctrine: 'door', rank: 2, cost: 34, excludes: 'clean_room',
    desc: 'They get in. They do not get far, and they do not get to break much on the way.',
    effect: { raidTheft: 0.55 },
    proves: 'theft',
  },
};

export const NODE_LIST = Object.values(NODES);

export function getNode(id) {
  return NODES[id] || null;
}

/**
 * What a node needs before it can be bought.
 *
 * The root needs nothing. Rank 1 needs the root. Rank 2 needs *either* node of
 * rank 1 in the same doctrine — not both, because both is impossible: they
 * exclude each other. Writing it as "either" rather than naming one keeps the
 * pair symmetric, so neither branch is secretly the main line.
 */
export function requires(node) {
  if (!node || node.rank === 0) return [];
  if (node.rank === 1) return ['debrief'];
  return NODE_LIST.filter((n) => n.doctrine === node.doctrine && n.rank === node.rank - 1).map((n) => n.id);
}
