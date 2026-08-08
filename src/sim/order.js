/**
 * order.js — dissent, policing, and uprisings.
 *
 * The political layer, and it should be genuinely uncomfortable. Two things
 * make it so rather than making it a second happiness bar:
 *
 *   - The murder investigation can convict the wrong person. The Sheriff
 *     produces evidence, not truth, and a wrong verdict costs Order *and*
 *     kills somebody innocent. There is no way to be certain.
 *   - Winning an uprising is a loss. It resolves through the same combat
 *     function as the wasteland, against your own named citizens, and the
 *     log reads like it.
 */

import { BAL } from '../config/balance.js';
import { streamFor } from '../core/rng.js';
import { getRoom } from '../data/rooms.js';
import { POLICIES, CRIME_LIST, CRIMES, policyEffects } from '../data/policies.js';
import { fullName, isDissident } from './population.js';
import { idleDissent } from './jobs.js';
import { resolve as resolveCombat, applyResolution } from './combat.js';
import { traitMod } from '../data/traits.js';

const O = BAL.order;

// ------------------------------------------------------------- policy caps ---

/**
 * How many policies can run at once. The spec keys this to the mayor's admin
 * skill; the mayor is the player, so it reads the silo's *administration* —
 * the best admin skill on the payroll. Hiring a good clerk is how you get
 * another lever.
 */
export function policyCapacity(state) {
  let best = 0;
  for (const id of state.citizenIds) {
    const c = state.citizens[id];
    if (!c || c.status === 'dead') continue;
    best = Math.max(best, c.skills.admin || 0);
  }
  return O.maxPoliciesBase + Math.floor(best / O.policyPerAdminSkill);
}

export function canTogglePolicy(state, id) {
  const p = POLICIES[id];
  if (!p) return { ok: false, reason: 'No such policy.' };
  const active = state.order.policies.includes(id);
  if (active) return { ok: true, turningOff: true };
  if (p.unlock && !state.research.completed.includes(p.unlock)) {
    return { ok: false, reason: `Needs research: ${p.unlock.replace(/_/g, ' ')}.` };
  }
  const cap = policyCapacity(state);
  if (state.order.policies.length >= cap) {
    return {
      ok: false,
      reason:
        `Your administration can run ${cap} policies at once. ` +
        'Put a better administrator on the payroll, or turn something off.',
    };
  }
  return { ok: true };
}

// ------------------------------------------------------------------- daily ---

/**
 * One day of the political layer. Returns actions.
 * Order drift itself lives in game.js with the economic pressures; this adds
 * the policy effects, crime, investigations and the uprising check.
 */
export function simulateDay(state) {
  const actions = [];
  const day = state.clock.day;
  const rng = streamFor(state.meta.seed, 'order', day);
  const pe = policyEffects(state);

  // ---- policy effects ----------------------------------------------------
  if (pe.orderPerDay) {
    actions.push({ type: 'ORDER_DELTA', amount: pe.orderPerDay, reason: 'active policies', emit: false });
  }
  if (pe.moralePerDay || pe.healthPerDay) {
    const patches = [];
    for (const id of state.citizenIds) {
      const c = state.citizens[id];
      if (!c || c.status === 'dead') continue;
      const p = { id };
      if (pe.moralePerDay) {
        p.morale = clamp(c.morale + pe.moralePerDay * traitMod(c.traits, 'moraleSwing'), 0, 100);
      }
      if (pe.healthPerDay) p.health = clamp(c.health + pe.healthPerDay, 1, 100);
      patches.push(p);
    }
    if (patches.length) actions.push({ type: 'CITIZENS_PATCH', patches, emit: false });
  }
  if (pe.chitsPerCitizenPerDay) {
    actions.push({
      type: 'RESOURCE_DELTA',
      emit: false,
      deltas: { chits: pe.chitsPerCitizenPerDay * state.citizenIds.length },
    });
  }
  if (pe.relationshipDecay) {
    actions.push({ type: 'RELATIONSHIP_DELTA', edges: [], decay: pe.relationshipDecay, emit: false });
  }

  // ---- dissent -----------------------------------------------------------
  actions.push(...dissentPressure(state, pe));

  // ---- forced labour kills people ---------------------------------------
  if (pe.accidentChancePerDay) {
    const workers = state.citizenIds.filter((id) => state.citizens[id]?.status === 'working');
    for (const id of workers) {
      if (!rng.chance(pe.accidentChancePerDay / Math.max(1, workers.length / 6))) continue;
      const c = state.citizens[id];
      actions.push({
        type: 'CITIZEN_DIE',
        id,
        cause: 'industrial accident',
        text: `${fullName(c)}, ${Math.floor(c.age)}, was killed on the dig. The shift did not stop.`,
      });
      break; // at most one a day; a massacre is not the intent
    }
  }

  // ---- exile -------------------------------------------------------------
  if (pe.exileDissidents) actions.push(...exileOne(state, rng, pe));

  // ---- crime -------------------------------------------------------------
  actions.push(...rollCrime(state, rng, pe));
  actions.push(...advanceInvestigations(state, rng));

  // ---- uprising ----------------------------------------------------------
  actions.push(...checkUprising(state, rng));

  return actions;
}

// ----------------------------------------------------------------- dissent ---

function dissentPressure(state, pe) {
  let pressure = 0;

  // Dissidents multiply whatever discontent already exists.
  let dissidents = 0;
  for (const id of state.citizenIds) {
    const c = state.citizens[id];
    if (!c || c.status === 'dead') continue;
    if (isDissident(c)) dissidents++;
  }
  const unrest = Math.max(0, O.driftToward - state.order.value) / 100;
  pressure += dissidents * unrest * O.dissidentMultiplier;
  pressure += idleDissent(state);

  // Sheriffs and deputies push back.
  let policing = 0;
  for (const room of Object.values(state.silo.rooms)) {
    const def = getRoom(room.type);
    if (def?.provides?.order && room.powered) {
      policing += O.sheriffBonusPerLevel * room.level + room.staff.length * O.deputyBonus;
    }
  }

  const net = policing - pressure;
  return [
    { type: 'DISSENT_SET', value: pressure, emit: false },
    net !== 0 ? { type: 'ORDER_DELTA', amount: net * 0.4, reason: 'policing', emit: false } : null,
  ].filter(Boolean);
}

function exileOne(state, rng, pe) {
  const dissidents = state.citizenIds
    .map((id) => state.citizens[id])
    .filter((c) => c && c.status !== 'dead' && isDissident(c));
  if (!dissidents.length) return [];
  if (!rng.chance(0.2)) return [];

  const victim = rng.pick(dissidents);
  return [
    {
      type: 'CITIZEN_EXILE',
      id: victim.id,
      text: `${fullName(victim)} was put through the airlock with four hours of air and a direction.`,
    },
    { type: 'ORDER_DELTA', amount: 2, reason: 'an exile', emit: false },
    {
      type: 'BROADCAST_REPUTATION',
      amount: pe.reputationPerExile ?? -6,
      reason: 'Silo 12 exiling its own people',
    },
  ];
}

// ------------------------------------------------------------------- crime ---

function rollCrime(state, rng, pe) {
  const C = O.crime;
  const orderFactor = 1 + ((O.driftToward - state.order.value) / 100) * C.orderScaling;
  const chance = C.baseChancePerDay * Math.max(0.1, orderFactor) * (pe.crimeMult ?? 1);
  if (!rng.chance(chance)) return [];

  const pool = CRIME_LIST.filter((c) => !c.needsDissent || state.order.dissentPressure > 1);
  const crime = rng.weighted(pool, (c) => c.weight);
  if (!crime) return [];

  const actions = [];
  const day = state.clock.day;

  switch (crime.id) {
    case 'theft': {
      const key = rng.pick(['food', 'meds', 'scrap', 'chits', 'parts']);
      const amount = Math.round((state.resources[key] || 0) * C.theftFraction);
      if (amount > 0) actions.push({ type: 'RESOURCE_DELTA', deltas: { [key]: -amount } });
      actions.push({
        type: 'CRIME_ADD',
        crime: { id: crime.id, day, text: `${amount} ${key} is missing from stores. The ledger does not explain it.` },
      });
      break;
    }
    case 'hoarding': {
      actions.push({
        type: 'CRIME_ADD',
        crime: { id: crime.id, day, text: 'A false panel on the residential floors, and three months of rations behind it.' },
      });
      actions.push({ type: 'ORDER_DELTA', amount: -2, reason: 'hoarding discovered' });
      break;
    }
    case 'black_market': {
      actions.push({ type: 'RESOURCE_DELTA', deltas: { chits: -Math.round(state.resources.chits * 0.06) } });
      actions.push({
        type: 'CRIME_ADD',
        crime: { id: crime.id, day, text: 'There is a second economy on the residential floors, and morale is better inside it than outside.' },
      });
      // Uncomfortable: the black market genuinely helps morale.
      actions.push({ type: 'MORALE_ALL', amount: 2, emit: false });
      break;
    }
    case 'sabotage': {
      const rooms = Object.values(state.silo.rooms).filter((r) => r.condition > 20);
      const target = rng.pick(rooms);
      if (target) {
        actions.push({
          type: 'ROOM_PATCH',
          id: target.id,
          patch: { condition: Math.max(0, target.condition + C.sabotageConditionHit) },
        });
        const def = getRoom(target.type);
        actions.push({
          type: 'CRIME_ADD',
          crime: {
            id: crime.id, day, roomId: target.id,
            text: `Somebody has been inside the ${def?.name || target.type} on floor ${target.floor} who had no business being inside it.`,
          },
        });
        actions.push({ type: 'ORDER_DELTA', amount: -4, reason: 'sabotage' });
      }
      break;
    }
    case 'murder': {
      const living = state.citizenIds.map((id) => state.citizens[id]).filter((c) => c && c.status !== 'dead');
      if (living.length < 6) break;
      const victim = rng.pick(living);
      const culprit = rng.pick(living.filter((c) => c.id !== victim.id));
      if (!victim || !culprit) break;

      actions.push({
        type: 'CITIZEN_DIE',
        id: victim.id,
        cause: 'murdered',
        text: `${fullName(victim)}, ${Math.floor(victim.age)}, was found dead on floor ${rng.int(1, 14)}. It was not an accident.`,
      });
      actions.push({ type: 'ORDER_DELTA', amount: -6, reason: 'a murder' });

      // Suspects: the culprit plus innocents. The Sheriff never knows which.
      const suspects = rng
        .shuffle([culprit, ...rng.sample(living.filter((c) => c.id !== victim.id && c.id !== culprit.id), 2)])
        .map((c) => c.id);

      actions.push({
        type: 'INVESTIGATION_OPEN',
        investigation: {
          id: `inv-${day}-${victim.id}`,
          crime: 'murder',
          victimId: victim.id,
          culpritId: culprit.id,
          suspects,
          openedDay: day,
          resolvesDay: day + C.investigationDays,
          evidence: {},
          verdict: null,
        },
      });
      break;
    }
  }

  return actions;
}

// ---------------------------------------------------------- investigations ---

/**
 * The Sheriff's office produces evidence over three days. Evidence points at
 * the culprit *on average* and at an innocent often enough that the player
 * can convict the wrong person and never find out.
 */
/**
 * One day of legwork on one case. Exported so the evidence model can be
 * measured directly over many trials rather than inferred from however many
 * murders a campaign happens to produce.
 */
export function accumulateEvidence(state, inv, deputies) {
  const evidence = { ...inv.evidence };
  for (const sid of inv.suspects) {
    const r = streamFor(state.meta.seed, 'evidence', inv.id, sid + state.clock.day);
    const truthful = String(sid) === String(inv.culpritId);
    // A well-staffed office finds signal; an empty one mostly finds noise.
    const signal = truthful
      ? O.crime.evidenceSignal + deputies * O.crime.evidencePerDeputy
      : O.crime.evidenceNoise - deputies * O.crime.evidencePerDeputy * 0.25;
    evidence[sid] = (evidence[sid] || 0) + r.float(0, 1) * Math.max(0.05, signal) * 100;
  }
  return evidence;
}

function advanceInvestigations(state, rng) {
  const actions = [];
  for (const inv of state.order.investigations || []) {
    if (inv.verdict) continue;
    const deputies = sheriffStrength(state);
    const evidence = accumulateEvidence(state, inv, deputies);
    actions.push({ type: 'INVESTIGATION_PATCH', id: inv.id, patch: { evidence } });

    if (state.clock.day >= inv.resolvesDay && !inv.verdict) {
      actions.push({
        type: 'LOG',
        entry: {
          kind: 'alert',
          text: `The investigation into ${nameOf(state, inv.victimId)}'s death is ready for a verdict.`,
        },
      });
    }
  }
  return actions;
}

function sheriffStrength(state) {
  let n = 0;
  for (const room of Object.values(state.silo.rooms)) {
    const def = getRoom(room.type);
    if (def?.provides?.investigations && room.powered) n += room.level + room.staff.length * 0.5;
  }
  return n;
}

/** The player's verdict. Returns actions; being wrong is expensive. */
export function deliverVerdict(state, investigationId, accusedId, sentence) {
  const inv = (state.order.investigations || []).find((i) => i.id === investigationId);
  if (!inv) return [];
  const C = O.crime;
  const right = accusedId === inv.culpritId;
  const accused = state.citizens[accusedId];
  if (sentence !== 'unsolved' && (!accused || accused.status === 'dead')) {
    return [
      { type: 'INVESTIGATION_PATCH', id: investigationId, patch: { verdict: { accusedId, sentence: 'moot', right } } },
      {
        type: 'LOG',
        entry: { kind: 'alert', text: 'The accused died before the verdict could be delivered. The case is closed.' },
      },
    ];
  }
  const actions = [{ type: 'INVESTIGATION_PATCH', id: investigationId, patch: { verdict: { accusedId, sentence, right } } }];

  if (sentence === 'execute') {
    actions.push({
      type: 'CITIZEN_DIE',
      id: accusedId,
      cause: 'executed',
      text: `${fullName(accused)}, ${Math.floor(accused.age)}, was executed for the murder of ${nameOf(state, inv.victimId)}.`,
    });
    actions.push({ type: 'ORDER_DELTA', amount: O.executionPenalty, reason: 'an execution' });
  } else if (sentence === 'imprison') {
    actions.push({ type: 'CITIZEN_STATUS', id: accusedId, status: 'imprisoned' });
    actions.push({ type: 'CITIZEN_ASSIGN', citizenId: accusedId, roomId: null, status: 'imprisoned' });
  } else {
    actions.push({ type: 'ORDER_DELTA', amount: -3, reason: 'an unsolved murder' });
  }

  actions.push({
    type: 'ORDER_DELTA',
    amount: right ? C.rightVerdictOrder : C.wrongVerdictOrder,
    reason: right ? 'a case closed' : 'a verdict people did not believe',
  });

  // The player is never told outright whether they were right. The silo's
  // reaction is the only signal, and it is ambiguous on purpose.
  actions.push({
    type: 'LOG',
    entry: {
      kind: 'alert',
      text: right
        ? `The verdict on ${fullName(accused)} was accepted. The floors are quieter than they were.`
        : `The verdict on ${fullName(accused)} has not settled anything. People are still talking.`,
    },
  });
  return actions;
}

// -------------------------------------------------------------- uprising ---

/**
 * Order below the threshold for three consecutive days rolls for an uprising.
 * It resolves through the same combat function as the wasteland, loyalists
 * against dissidents, and the log names both sides — because winning it is
 * supposed to feel bad.
 */
function checkUprising(state, rng) {
  if (state.order.daysBelowThreshold < O.uprisingConsecutiveDays) return [];
  if (!rng.chance(O.uprisingChancePerDay)) return [];

  const loyal = [];
  const rebel = [];
  for (const id of state.citizenIds) {
    const c = state.citizens[id];
    if (!c || c.status === 'dead' || c.age < BAL.citizens.workingAgeMin) continue;
    const side = traitMod(c.traits, 'uprisingSide');
    if (c.traits.includes('loyalist')) loyal.push(c);
    else if (isDissident(c) || c.morale < 25) rebel.push(c);
    else if (c.morale < 45 && rng.chance(0.4)) rebel.push(c);
    else loyal.push(c);
  }

  if (rebel.length < 4) return [];

  const rebelForce = {
    id: 'uprising',
    name: 'the rising',
    displayName: 'the rising',
    def: { human: true, flee: 0.9, count: [rebel.length, rebel.length] },
    count: rebel.length,
    level: 1,
    modifier: null,
    human: true,
    // Rebels fight with what they can carry, not with the armoury.
    power: rebel.reduce((a, c) => a + (4 + (c.skills.combat || 0) * 0.3) * (c.health / 100), 0),
  };

  const res = resolveCombat(state, loyal.map((c) => c.id), rebelForce, {
    battleId: `uprising-${state.clock.day}`,
    ambush: -0.15,
    terrain: 0,
  });

  const actions = [
    {
      type: 'LOG',
      entry: {
        kind: 'alert',
        text: `Order has collapsed. ${rebel.length} residents are barricaded on the residential floors.`,
      },
    },
  ];

  actions.push(...applyResolution(state, res, { context: 'uprising', kiaKind: 'killed in uprising' }));

  // The rebel dead are your people too, and they get named.
  const rebelLosses = Math.round(rebel.length * (res.outcome.win ? 0.45 : 0.15));
  const fallen = rng.sample(rebel, rebelLosses);
  for (const c of fallen) {
    actions.push({
      type: 'CITIZEN_DIE',
      id: c.id,
      cause: 'killed in uprising',
      text: `${fullName(c)}, ${Math.floor(c.age)}, was killed on the residential floors. They were unarmed.`,
    });
  }

  actions.push({ type: 'LOG_MANY', entries: res.log.map((text) => ({ kind: 'alert', text })) });

  if (res.outcome.win) {
    actions.push({ type: 'ORDER_SET', value: 45 });
    actions.push({
      type: 'LOG',
      entry: {
        kind: 'alert',
        text:
          'The rising is over. Order has been restored, at the cost of people who lived here, ' +
          'were fed here, and were buried here by the people who shot them.',
      },
    });
    actions.push({ type: 'MORALE_ALL', amount: -14 });
  } else {
    actions.push({ type: 'ORDER_SET', value: 20 });
    actions.push({
      type: 'GAME_OVER',
      reason: 'deposed',
      text:
        'The rising took the admin floor. You are no longer the mayor of Silo 12. ' +
        'Somebody else is writing in this log now.',
    });
  }

  actions.push({ type: 'ORDER_STREAK', days: 0 });
  return actions;
}

// ---------------------------------------------------------------- helpers ---

function nameOf(state, id) {
  const c = state.citizens[id];
  return c ? fullName(c) : 'the deceased';
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export { policyEffects, POLICIES, CRIMES };
export default { simulateDay, policyCapacity, canTogglePolicy, deliverVerdict };
