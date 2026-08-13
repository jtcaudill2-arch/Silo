/**
 * doctrine.js — Commendations, and what they buy.
 *
 * Two halves. The mint: what a returning expedition is worth. The ledger:
 * which nodes are taken, what they cost, and what they are currently doing to
 * the game's numbers.
 *
 * Nothing here dispatches. This is a pure read/derive module in the project's
 * usual shape — the reducers do the writing, the sim modules ask questions.
 */

import { BAL } from '../config/balance.js';
import { NODES, NODE_LIST, getNode, requires } from '../data/doctrine.js';

/**
 * `BAL.expedition.bands` is an array keyed by `key`, not a map. `expedition.js`
 * exports a `getBand` that does this, and importing it here would be the
 * obvious move and the wrong one: expedition.js has to import *this* module to
 * read `lootMult` and `artifactMult`, so taking the helper would close a cycle.
 * Six lines of duplication is cheaper than an import loop.
 *
 * Worth stating plainly because the first version of this file wrote
 * `bands?.[band]`, which is `undefined` for every band in the game — so the
 * mint returned 0 for ever and the whole tree would have been unbuyable, with
 * nothing anywhere throwing.
 */
function rewardTierOf(bandKey) {
  const bands = BAL.expedition.bands || [];
  return bands.find((b) => b.key === bandKey)?.rewardTier || 0;
}

/**
 * Is a node bought?
 *
 * Everything downstream funnels through here, so a save without a `doctrine`
 * block — every save written before this feature, and any fixture that builds
 * a bare state — reads as "no doctrine" rather than throwing. The migration
 * backfills the block, but the sim must not depend on the migration having run
 * in order to not crash: `test/harness.mjs` builds states by hand.
 */
export function has(state, id) {
  return !!state?.doctrine?.taken?.includes(id);
}

/**
 * The current value of an effect key.
 *
 * Multiplicative keys default to 1 and additive ones to 0, matching
 * `traitMod`'s contract in data/traits.js so the two read the same way at a
 * call site that uses both. A key no node grants returns the identity, which
 * is what makes it safe to multiply this in unconditionally.
 */
// `ammoFloor` is additive and it matters that it is. It is consumed as
// `Math.max(factor, floor)`, so a multiplicative default of 1 would have
// pinned the ammunition factor at full for every silo in the game, doctrine
// or not, silently deleting the dry-stores penalty entirely. A key's identity
// has to match the shape of the expression that reads it.
const ADDITIVE = new Set(['squadMaxBonus', 'commendationBonus', 'ammoFloor']);

export function doctrineMod(state, key) {
  const additive = ADDITIVE.has(key);
  let acc = additive ? 0 : 1;
  const taken = state?.doctrine?.taken;
  if (!taken || taken.length === 0) return acc;
  for (const id of taken) {
    const v = NODES[id]?.effect?.[key];
    if (typeof v !== 'number') continue;
    if (additive) acc += v;
    else acc *= v;
  }
  return acc;
}

/** Boolean effects — `succession` is a switch, not a multiplier. */
export function doctrineFlag(state, key) {
  const taken = state?.doctrine?.taken;
  if (!taken) return false;
  return taken.some((id) => NODES[id]?.effect?.[key] === true);
}

// ------------------------------------------------------------- the ledger ---

/**
 * Why a node cannot be bought, or null if it can.
 *
 * Order matters for the message the player reads: "you already took the other
 * one" is a more useful sentence than "you cannot afford it", because the
 * first is permanent and the second is a matter of time.
 */
export function whyNot(state, id) {
  const node = getNode(id);
  if (!node) return 'No such doctrine.';
  if (has(state, id)) return 'Already taken.';
  if (node.excludes && has(state, node.excludes)) {
    return `Closed by ${NODES[node.excludes].name}.`;
  }
  const need = requires(node);
  if (need.length && !need.some((r) => has(state, r))) {
    return `Needs ${need.map((r) => NODES[r].name).join(' or ')}.`;
  }
  if ((state.doctrine?.points || 0) < node.cost) {
    return `Costs ${node.cost}. You have ${state.doctrine?.points || 0}.`;
  }
  return null;
}

export function canTake(state, id) {
  return whyNot(state, id) === null;
}

/** Every node, with the one fact the panel needs about each. */
export function ledger(state) {
  return NODE_LIST.map((n) => ({
    node: n,
    taken: has(state, n.id),
    closed: !!(n.excludes && has(state, n.excludes)),
    reason: whyNot(state, n.id),
  }));
}

// --------------------------------------------------------------- the mint ---

/**
 * What a returning expedition is worth in Commendations.
 *
 * Three conditions, and each one is doing a job:
 *
 *   nobody lost      — makes this a currency of preparation rather than of
 *                      time. You earn doctrine by kitting a squad properly and
 *                      picking a fight you can win, which is exactly the
 *                      decision the gear ladder exists to pose.
 *   at the frontier  — a band whose reward tier is at least the best you have
 *                      ever come back from. Without it the near ruins pay for
 *                      ever and the optimal play is to farm the safest ground
 *                      in the game until the tree is full, which is the
 *                      opposite of what a doctrine is.
 *   scaled by tier   — the Scar is worth three of the near ruins, because it
 *                      is three of the near ruins.
 *
 * `Debrief` adds a flat point on top, which is why the root is worth buying
 * first: it is the only node that pays for the others.
 *
 * Returns 0, never null, so the caller can add it unconditionally.
 */
export function commendationsFor(state, { band, casualties }) {
  if (casualties && casualties.length) return 0;
  const tier = rewardTierOf(band);
  if (!tier) return 0;
  if (tier < (state.doctrine?.frontier || 0)) return 0;
  return tier + doctrineMod(state, 'commendationBonus');
}

/**
 * The deepest reward tier this silo has ever come back from.
 *
 * Kept as its own field rather than derived from expedition history, because
 * history is capped at 30 entries (reducers.js trims it) and a silo that has
 * run two hundred expeditions would quietly forget it had ever reached the
 * Scar — and then start paying doctrine for near-ruins runs again.
 */
export function frontierAfter(state, band) {
  return Math.max(state.doctrine?.frontier || 0, rewardTierOf(band));
}

/** Total spent, for the panel's header and for the campaign probes. */
export function spent(state) {
  return (state.doctrine?.taken || []).reduce((sum, id) => sum + (NODES[id]?.cost || 0), 0);
}
