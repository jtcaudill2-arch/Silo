/**
 * policies.js — the political layer (spec §9).
 *
 * Every policy is a toggle with a real trade-off. None of them are simply
 * good: the ones that keep the silo running make people miserable, and the
 * ones that make people happy cost you control. That is the point.
 *
 * `effects` are read by the sim; `benefit` and `cost` are the copy shown on
 * the toggle, so the trade is legible before the player commits.
 */

export const POLICIES = {
  rationing: {
    id: 'rationing',
    name: 'Rationing',
    benefit: 'Food consumption −25%.',
    cost: 'Morale −10, Order −8. People notice a smaller plate immediately.',
    effects: { foodConsumption: -0.25, moralePerDay: -1.2, orderPerDay: -1.0 },
    desc: 'Half portions on the evening shift and no seconds. It buys weeks.',
  },

  curfew: {
    id: 'curfew',
    name: 'Curfew',
    benefit: 'Order +12, crime halved.',
    cost: 'Morale −8, and the night shift produces 20% less.',
    effects: { orderPerDay: 1.5, crimeMult: 0.5, moralePerDay: -1.0, nightOutput: -0.2 },
    desc: 'Corridors clear after the eighth shift. Deputies on the stairwells.',
  },

  informants: {
    id: 'informants',
    name: 'Informant Network',
    benefit: 'Dissidents and saboteurs become visible before they act.',
    cost: 'Morale −12, and relationships decay across the whole silo.',
    effects: { moralePerDay: -1.5, relationshipDecay: 3, detectDissidents: true, crimeMult: 0.7 },
    desc: 'Somebody on every floor is writing things down. Everybody knows, and nobody knows who.',
    unlock: 'informant_networks',
  },

  conscription: {
    id: 'conscription',
    name: 'Conscription',
    benefit: 'Half again as many people are available for the military.',
    cost: 'Order −10, and 15% of the workforce is in uniform instead of working.',
    effects: { orderPerDay: -1.2, workforce: -0.15, recruitPool: 0.5 },
    desc: 'Service is no longer voluntary. Nobody says so out loud.',
  },

  open_archives: {
    id: 'open_archives',
    name: 'Open Archives',
    benefit: 'Research +20%, morale +10.',
    cost: 'Order −15. People read what is in there, and then they talk.',
    effects: { researchSpeed: 0.2, moralePerDay: 1.2, orderPerDay: -1.8 },
    desc: 'The pre-Collapse record, unlocked. Some of it contradicts what they were taught.',
    unlock: 'pre_collapse_archives',
  },

  stipend: {
    id: 'stipend',
    name: 'Stipend Increase',
    benefit: 'Morale +15.',
    cost: 'Chits drain steadily. You cannot trade what you have spent.',
    effects: { moralePerDay: 1.8, chitsPerCitizenPerDay: -0.08 },
    desc: 'More chits in every hand. It works, for exactly as long as you can pay for it.',
  },

  forced_labor: {
    id: 'forced_labor',
    name: 'Forced Labour',
    benefit: 'Excavation and construction 40% faster.',
    cost: 'Order −20, health falls, and people die on the shift.',
    effects: {
      orderPerDay: -2.4, healthPerDay: -0.8, buildSpeed: 0.4,
      accidentChancePerDay: 0.02,
    },
    desc: 'Double shifts on the dig, and no argument about it.',
  },

  exile: {
    id: 'exile',
    name: 'Exile Sentencing',
    benefit: 'Dissidents are removed from the silo cleanly.',
    cost: 'Every silo that hears about it thinks less of you. Yours end up in Gallow Deep.',
    effects: { exileDissidents: true, orderPerDay: 0.8, reputationPerExile: -6 },
    desc: 'The airlock, a suit with four hours in it, and a direction.',
  },
};

export const POLICY_LIST = Object.values(POLICIES);

export function getPolicy(id) {
  return POLICIES[id] || null;
}

/** Aggregate the active policies into one flat effect table. */
export function policyEffects(state) {
  const out = {};
  for (const id of state.order.policies || []) {
    const p = POLICIES[id];
    if (!p) continue;
    for (const [k, v] of Object.entries(p.effects)) {
      if (typeof v === 'boolean') out[k] = out[k] || v;
      else if (k === 'crimeMult' || k === 'foodConsumption') {
        // Multipliers compose rather than sum.
        out[k] = (out[k] ?? 1) * (k === 'foodConsumption' ? 1 + v : v);
      } else out[k] = (out[k] || 0) + v;
    }
  }
  return out;
}

// ------------------------------------------------------------------ crime ---

export const CRIMES = {
  theft: {
    id: 'theft',
    name: 'Theft',
    weight: 34,
    desc: 'Stores are short and the ledger does not explain it.',
  },
  sabotage: {
    id: 'sabotage',
    name: 'Sabotage',
    weight: 20,
    desc: 'Somebody has been inside a machine that they had no business being inside.',
    needsDissent: true,
  },
  black_market: {
    id: 'black_market',
    name: 'Black market',
    weight: 26,
    desc: 'There is a second economy on the residential floors, and it works better than yours.',
  },
  murder: {
    id: 'murder',
    name: 'Murder',
    weight: 12,
    desc: 'A body, and no plausible accident to hang it on.',
    investigation: true,
  },
  hoarding: {
    id: 'hoarding',
    name: 'Hoarding',
    weight: 18,
    desc: 'Somebody has three months of rations behind a false panel.',
  },
};

export const CRIME_LIST = Object.values(CRIMES);

export default POLICIES;
