/**
 * research.js — progress, unlocks, and the aggregated effect table.
 *
 * Completed nodes are folded into one flat modifier object that the rest of
 * the sim reads. That aggregation is memoised on the completed-list length
 * plus the active node, because it's queried every cycle by the economy and
 * recomputing it from forty nodes each time would be silly.
 */

import { BAL } from '../config/balance.js';
import { RESEARCH, getResearch, RESEARCH_LIST } from '../data/research.js';

/** Additive modifier keys; everything else is a max() or a set-union. */
const ADDITIVE = new Set([
  'foodYield', 'waterYield', 'powerEfficiency', 'researchSpeed', 'healRate',
  'radTreatment', 'blightResist', 'vitalityDecline', 'combatBonus',
  'deconEfficiency', 'deconFilters', 'orderBonus', 'tradeBonus',
  'treatyStrength', 'travelSpeed', 'encounterIntel', 'collapseResist',
  'injuryDeathResist', 'radPermanentResist', 'shoringCost', 'foodCap',
  'batteryCap', 'batteryThroughput', 'intelResist',
]);

/** Keys where the highest completed tier wins. */
const MAX_KEYS = new Set(['weaponTier', 'armorTier', 'suitTier', 'radioTier', 'mapRange', 'shiftRotation']);

/** Keys that collect a set of ids. */
const LIST_KEYS = new Set(['unlockRoom', 'unlockTier', 'unlockPolicy']);

let cacheKey = null;
let cacheValue = null;

/**
 * Flatten every completed node into one modifier object.
 * @returns {object} e.g. { foodYield: 0.35, suitTier: 2, unlockRoom: Set }
 */
export function effects(state) {
  const key = state.research.completed.length + ':' + state.research.completed.join(',');
  if (cacheKey === key) return cacheValue;

  const out = {
    unlockRoom: new Set(),
    unlockTier: new Set(),
    unlockPolicy: new Set(),
  };

  for (const id of state.research.completed) {
    const node = getResearch(id);
    if (!node) continue;
    for (const [k, v] of Object.entries(node.effects)) {
      if (LIST_KEYS.has(k)) {
        for (const item of v) out[k].add(item);
      } else if (MAX_KEYS.has(k)) {
        out[k] = Math.max(out[k] || 0, v);
      } else if (ADDITIVE.has(k)) {
        out[k] = (out[k] || 0) + v;
      } else {
        out[k] = v;
      }
    }
  }

  cacheKey = key;
  cacheValue = out;
  return out;
}

export function clearEffectCache() {
  cacheKey = null;
}

// ------------------------------------------------------------ availability --

export function isComplete(state, id) {
  return state.research.completed.includes(id);
}

/** Missing prerequisites, if any. */
export function missingRequirements(state, id) {
  const node = getResearch(id);
  if (!node) return ['unknown node'];
  return node.requires.filter((r) => !isComplete(state, r));
}

/** Artifacts the player is short of, if any. */
export function missingArtifacts(state, id) {
  const node = getResearch(id);
  if (!node) return [];
  const out = [];
  for (const [artifact, count] of Object.entries(node.artifacts)) {
    const have = state.research.artifacts[artifact] || 0;
    if (have < count) out.push({ artifact, need: count, have });
  }
  return out;
}

export function canStart(state, id) {
  if (isComplete(state, id)) return { ok: false, reason: 'Already researched.' };
  const missing = missingRequirements(state, id);
  if (missing.length) {
    const names = missing.map((r) => getResearch(r)?.name || r);
    return { ok: false, reason: `Needs ${names.join(', ')} first.` };
  }
  const artifacts = missingArtifacts(state, id);
  if (artifacts.length) {
    const names = artifacts.map((a) => `${a.artifact.replace(/_/g, ' ')} (${a.have}/${a.need})`);
    return {
      ok: false,
      reason: `Needs recovered material: ${names.join(', ')}. Send an expedition.`,
      needsExpedition: true,
    };
  }
  return { ok: true };
}

export function available(state) {
  return RESEARCH_LIST.filter((n) => !isComplete(state, n.id) && !missingRequirements(state, n.id).length);
}

// ------------------------------------------------------------------ cycle ---

/**
 * Advance the active project. Points accumulate globally; the active node
 * spends them. `minCycles` is a floor on elapsed time so a stockpile can't
 * buy a node instantly.
 */
export function simulateCycle(state) {
  const active = state.research.active;
  if (!active) return advanceQueue(state);

  const node = getResearch(active.id);
  if (!node) return [{ type: 'RESEARCH_SET_ACTIVE', active: null }];

  const spend = Math.min(state.research.points, node.cost - active.progress);
  if (spend <= 0 && active.progress < node.cost) return [];

  const progress = active.progress + spend;
  const cycles = active.cycles + 1;
  const actions = [
    { type: 'RESEARCH_SPEND', amount: spend, progress, cycles, emit: false },
  ];

  if (progress >= node.cost && cycles >= node.minCycles) {
    actions.push({ type: 'RESEARCH_COMPLETE', id: node.id });
    for (const [artifact, count] of Object.entries(node.artifacts)) {
      actions.push({ type: 'ARTIFACT_ADD', id: artifact, count: -count });
    }
    actions.push({
      type: 'LOG',
      entry: { kind: 'alert', text: `Research complete: ${node.name}. ${node.desc}` },
    });
    actions.push(...advanceQueue(state, node.id));
  }
  return actions;
}

/** Start the next queued project when one finishes. */
function advanceQueue(state, justFinished) {
  const queue = (state.research.queue || []).filter((id) => id !== justFinished);
  for (const id of queue) {
    if (canStart(state, id).ok) {
      return [
        { type: 'RESEARCH_QUEUE', queue: queue.filter((q) => q !== id) },
        { type: 'RESEARCH_SET_ACTIVE', active: { id, progress: 0, cycles: 0 } },
      ];
    }
  }
  if (queue.length !== (state.research.queue || []).length) {
    return [{ type: 'RESEARCH_QUEUE', queue }];
  }
  return [];
}

/** Research points produced this cycle, after the speed modifier. */
export function speedMultiplier(state) {
  const e = effects(state);
  let mult = 1 + (e.researchSpeed || 0);
  if (state.order.policies.includes('open_archives')) mult += BAL.research.openArchivesBonus;
  return mult;
}

// -------------------------------------------------------------- unlocks ---

/** Is this room type buildable yet? */
export function roomUnlocked(state, roomDef) {
  if (!roomDef.unlock) return true;
  // A room is unlocked either by completing its named gate node, or by any
  // node that lists it in unlockRoom — the tree uses both.
  if (isComplete(state, roomDef.unlock)) return true;
  return effects(state).unlockRoom.has(roomDef.id);
}

export function tierUnlocked(state, tierKey) {
  const tier = BAL.silo.tiers.find((t) => t.key === tierKey);
  if (!tier || !tier.gate) return true;
  return isComplete(state, tier.gate) || effects(state).unlockTier.has(tierKey);
}

export function tierForFloor(n) {
  return BAL.silo.tiers.find((t) => n >= t.from && n <= t.to) || BAL.silo.tiers[0];
}

export function policyUnlocked(state, policyId) {
  const e = effects(state);
  return e.unlockPolicy.has(policyId);
}

export { RESEARCH, getResearch };
export default { effects, simulateCycle, canStart, roomUnlocked, tierUnlocked, available };
