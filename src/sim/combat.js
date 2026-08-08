/**
 * combat.js — auto-resolve. One function, used by expeditions, sieges,
 * silo defence and uprisings (spec §13).
 *
 * The maths is exactly the spec's. What earns auto-resolve its keep is the
 * log: round-by-round, four to eight lines, naming citizens. "Deputy Marra
 * Voss takes fire covering the retreat. Marra Voss did not make it back."
 * The writing does the work a tactical layer would have.
 *
 * Every roll comes from a stream keyed on (seed, purpose, battleId), so a
 * fight resolves identically whether the player watched it or it was replayed
 * during offline catch-up. There is no save-scumming.
 */

import { BAL } from '../config/balance.js';
import { streamFor } from '../core/rng.js';
import { getItem } from '../data/items.js';
import { fullName } from './population.js';
import { traitMod } from '../data/traits.js';
import { effects as researchEffects } from './research.js';

const C = BAL.combat;

// ------------------------------------------------------------- unit power ---

/**
 * One citizen's contribution. Exactly the spec's formula; every term is a
 * balance number, none are inline.
 */
export function unitPower(state, c, opts = {}) {
  const gear = c.gear || {};
  const weapon = gear.weapon ? state.military.gear[gear.weapon] : null;
  const armor = gear.armor ? state.military.gear[gear.armor] : null;

  const weaponTier = weapon ? getItem(weapon.item)?.tier ?? 1 : 0;
  const armorTier = armor ? getItem(armor.item)?.tier ?? 1 : 0;

  const base =
    c.stats.str * C.weights.str +
    c.stats.agi * C.weights.agi +
    (c.skills.combat || 0) * C.weights.combat;

  // A weapon in poor repair is worth less than its tier claims.
  const wear = weapon ? 0.6 + 0.4 * (weapon.durability / BAL.gear.durabilityMax) : 1;
  const weaponMult = (C.gearTierMult[Math.max(0, weaponTier - 1)] ?? 0.8) * (weapon ? wear : 0.8);
  const armorMult = 1 + armorTier * C.armorPerTier;

  const research = researchEffects(state);

  return (
    base *
    weaponMult *
    armorMult *
    (c.health / 100) *
    (c.vitality / 100) *
    (opts.ammoFactor ?? 1) *
    (1 + (opts.leaderBonus ?? 0)) *
    (1 + (research.combatBonus || 0)) *
    traitMod(c.traits, 'combatPower') *
    traitMod(c.traits, 'combatEvade')
  );
}

/** Ammunition multiplier for the whole force. */
export function ammoFactor(state, memberCount) {
  const need = memberCount * BAL.expedition.supplies.ammoPerMemberPerDay;
  const have = state.resources.ammo;
  if (have >= need) return C.ammoFactorFull;
  if (need <= 0) return C.ammoFactorFull;
  const ratio = Math.max(0, have / need);
  return C.ammoFactorEmpty + (C.ammoFactorFull - C.ammoFactorEmpty) * ratio;
}

/** Leader bonus applies to the whole squad. */
export function leaderBonus(leader) {
  if (!leader) return 0;
  return leader.stats.cha / C.leaderChaDivisor + (leader.skills.combat || 0) / C.leaderCombatDivisor;
}

// ------------------------------------------------------------- enemy side ---

/**
 * Roll a concrete enemy force from a roster entry. Mutation level rises with
 * distance band and with elapsed days — the wasteland gets worse (spec §11).
 */
export function rollEnemyForce(rng, enemyDef, { bandIndex = 0, dayIndex = 0, sizeScale = 1 } = {}) {
  const M = BAL.mutation;
  const count = Math.max(1, Math.round(rng.int(enemyDef.count[0], enemyDef.count[1]) * sizeScale));

  let level = 1;
  let modifier = null;
  if (!enemyDef.human) {
    const shift = bandIndex * M.bandShift + (dayIndex / 100) * M.dayShiftPer100Days;
    const weights = [
      Math.max(0.02, M.baseWeights[0] - shift * 1.4),
      M.baseWeights[1] + shift * 0.5,
      M.baseWeights[2] + shift * 0.9,
    ];
    level = rng.weighted([1, 2, 3], (_v, i) => weights[i]);
    if (rng.chance(M.modifierChance)) modifier = rng.pick(M.modifiers);
  }

  const levelMult = M.levels[level - 1] ?? 1;
  let power = enemyDef.power * count * levelMult;
  if (modifier?.damageMult) power *= modifier.damageMult;

  return {
    id: enemyDef.id,
    name: enemyDef.name,
    def: enemyDef,
    count,
    level,
    modifier,
    power,
    human: !!enemyDef.human,
    displayName:
      level > 1 || modifier
        ? `${modifier ? modifier.name + ' ' : ''}${enemyDef.name}${level > 1 ? ` (mutation ${level})` : ''}`
        : enemyDef.name,
  };
}

// --------------------------------------------------------------- resolve ---

/**
 * Resolve one battle.
 *
 * @param {object} state
 * @param {number[]} memberIds  our side, by citizen id
 * @param {object} enemy        from rollEnemyForce
 * @param {object} opts         { battleId, leaderId, ambush, terrain, suitIntegrity, defending }
 * @returns {object} { outcome, ratio, casualties, injuries, loot, log, gearLost }
 */
export function resolve(state, memberIds, enemy, opts = {}) {
  const rng = streamFor(state.meta.seed, 'combat', opts.battleId ?? 'battle', state.clock.day);
  const members = memberIds.map((id) => state.citizens[id]).filter((c) => c && c.status !== 'dead');
  const log = [];

  if (!members.length) {
    return { outcome: emptyOutcome(), ratio: 0, casualties: [], injuries: [], loot: 0, log: ['Nobody was left to fight.'], gearLost: [] };
  }

  const leader = opts.leaderId != null ? state.citizens[opts.leaderId] : members[0];
  const lb = leaderBonus(leader);
  const af = ammoFactor(state, members.length);

  // ---- our effective power ----------------------------------------------
  const powers = members.map((c) => ({
    c,
    p: unitPower(state, c, { ammoFactor: af, leaderBonus: lb }),
  }));
  let squadPower = powers.reduce((a, b) => a + b.p, 0);

  const avgMorale = members.reduce((a, c) => a + c.morale, 0) / members.length;
  const moraleMod = C.moraleModBase + (avgMorale / 100) * C.moraleModRange +
    traitMod(members.map((m) => m.traits).flat(), 'squadMorale') / 100;
  const sizeMod = 1 + Math.log2(Math.max(1, members.length)) * C.sizeModPerLog2;

  const ambush = opts.ambush ?? 0; // -1 (ambushed) .. +1 (ambushing)
  const ambushMod = 1 + ambush * C.ambushSwing;
  const terrainMod = 1 + (opts.terrain ?? 0) * C.terrainSwing;
  const suitMod = opts.suitIntegrity !== undefined
    ? C.suitIntegrityMin + (1 - C.suitIntegrityMin) * (opts.suitIntegrity / 100)
    : 1;

  const roll = rng.gaussianClamped(C.rollMean, C.rollSd, C.rollClamp[0], C.rollClamp[1]);
  const effectiveOurs = squadPower * moraleMod * sizeMod * ambushMod * terrainMod * suitMod * roll;

  // ---- theirs -------------------------------------------------------------
  let theirPower = enemy.power;
  if (enemy.modifier?.incomingMult) theirPower /= enemy.modifier.incomingMult; // carapace = harder to hurt
  // A Hulk is immune to weapons below tier 3 (spec §11).
  if (enemy.def?.minWeaponTier) {
    const best = bestWeaponTier(state, members);
    if (best < enemy.def.minWeaponTier) {
      theirPower *= 3.5;
      log.push(
        `Nothing the squad is carrying will go through it. Tier-${enemy.def.minWeaponTier} weapons or nothing.`
      );
    }
  }
  const theirRoll = rng.gaussianClamped(C.rollMean, C.rollSd, C.rollClamp[0], C.rollClamp[1]);
  const effectiveTheirs = Math.max(0.001, theirPower * theirRoll);

  const ratio = effectiveOurs / effectiveTheirs;
  const outcome = C.outcomes.find((o) => ratio >= o.min) || C.outcomes[C.outcomes.length - 1];

  // ---- casualties, weighted inversely to unit power -----------------------
  const casFraction = rng.float(outcome.cas[0], outcome.cas[1]);
  let casCount = Math.round(members.length * casFraction);
  // Raiders break rather than fight to the last, which caps how bad it gets.
  if (enemy.human && outcome.win) casCount = Math.min(casCount, Math.ceil(members.length * C.raiderFleeLossFraction));
  casCount = Math.min(casCount, members.length);

  const casualties = [];
  const pool = powers.slice();
  for (let i = 0; i < casCount; i++) {
    if (!pool.length) break;
    // Weak members die first, but roll it — it must not be deterministic.
    const pick = rng.weighted(pool, (u) => Math.pow(1 / Math.max(0.2, u.p), C.casualtyWeightExponent));
    if (!pick) break;
    casualties.push(pick.c);
    pool.splice(pool.indexOf(pick), 1);
  }

  // ---- survivors: injuries, traits, bleed, rad ----------------------------
  const injuries = [];
  for (const { c } of pool) {
    const hurt = Math.round(
      rng.int(C.injury.survivorHealthLoss[0], C.injury.survivorHealthLoss[1]) *
        (outcome.win ? 0.7 : 1.2) *
        traitMod(c.traits, 'injuryTaken')
    );
    const inj = { id: c.id, health: -hurt, rad: 0, trait: null };
    if (enemy.def?.bleed) inj.bleed = enemy.def.bleed;
    if (enemy.modifier?.radOnHit) inj.rad += enemy.modifier.radOnHit;
    if (enemy.def?.ruptureRad) inj.rad += enemy.def.ruptureRad;
    if (rng.chance(C.injury.permanentTraitChance * (outcome.win ? 0.6 : 1.3))) {
      inj.trait = rng.pick(C.injury.permanentTraits);
    }
    injuries.push(inj);
  }

  // ---- gear ---------------------------------------------------------------
  const gearLost = [];
  if (outcome.gearLost) {
    for (const c of casualties) {
      for (const slot of ['weapon', 'armor', 'suit']) {
        const gid = c.gear?.[slot];
        if (gid) gearLost.push(gid);
      }
    }
  }

  // ---- the log ------------------------------------------------------------
  log.push(...writeCombatLog(rng, { members, casualties, enemy, outcome, ratio, leader, ammoFactor: af, ambush }));

  return {
    outcome,
    ratio,
    casualties: casualties.map((c) => c.id),
    injuries,
    loot: outcome.loot,
    gearLost,
    log,
    captured:
      outcome.captureRisk && enemy.def?.takesPrisoners && rng.chance(outcome.captureRisk)
        ? rng.sample(casualties.map((c) => c.id), 1)
        : [],
    enemyKilled: Math.round(enemy.count * Math.min(1, ratio * 0.7)),
  };
}

function bestWeaponTier(state, members) {
  let best = 0;
  for (const c of members) {
    const gid = c.gear?.weapon;
    if (!gid) continue;
    const item = getItem(state.military.gear[gid]?.item);
    if (item) best = Math.max(best, item.tier);
  }
  return best;
}

function emptyOutcome() {
  return C.outcomes[C.outcomes.length - 1];
}

// ------------------------------------------------------------- the writer ---

/**
 * Four to eight lines, naming people. This is where auto-resolve earns its
 * keep, so the lines are built from the *actual* resolution — who died, who
 * led, whether the ammunition held — not from a generic template.
 */
function writeCombatLog(rng, { members, casualties, enemy, outcome, ratio, leader, ammoFactor: af, ambush }) {
  const dead = new Set(casualties.map((c) => c.id));
  const survivors = members.filter((m) => !dead.has(m.id));

  // Three fixed beats — opening, a middle, a close — plus optional colour and
  // the names of the dead. The fixed beats guarantee the four-line floor even
  // in a clean win against raiders, where nothing else has anything to say.
  const opening =
    ambush < 0
      ? `${enemy.displayName} hit the squad before anyone saw them — ${enemy.count} of them, already inside the line.`
      : ambush > 0
      ? `The squad had the ground first. ${enemy.count} ${enemy.displayName} walked into it.`
      : `${enemy.count} ${enemy.displayName}. No cover worth the name on either side.`;

  const command = leader
    ? rng.pick([
        `${fullName(leader)} put the squad on the left wall and held them there.`,
        `${fullName(leader)} called it early and moved everyone off the open ground.`,
        `${fullName(leader)} took the front. Whether that was brave or careless depends on how it ends.`,
        `${fullName(leader)} split them and took the flank personally.`,
      ])
    : 'Nobody was in charge of it, and it showed.';

  // How the middle of the fight actually went, from the ratio.
  const middle =
    ratio >= 2
      ? rng.pick([
          'The first volley did most of the work. The rest was tidying up.',
          'They never got close enough to be a problem.',
        ])
      : ratio >= 1.1
      ? rng.pick([
          'It turned on the second push, and it turned the right way.',
          'Close work in the middle of it, and then it broke their way.',
          'The line bent twice and held both times.',
        ])
      : ratio >= 0.9
      ? rng.pick([
          'It went on far longer than it should have, and neither side gained a metre.',
          'Both sides spent everything they had and neither could finish it.',
        ])
      : rng.pick([
          'The line came apart in the middle and never re-formed.',
          'They were flanked inside a minute and spent the rest of it withdrawing.',
        ]);

  const colour = [];
  if (af < 0.8) {
    colour.push(
      af < 0.55
        ? 'They ran dry in the first minute and finished it with whatever was to hand.'
        : 'Ammunition ran short halfway through, and the rate of fire fell off with it.'
    );
  }
  if (enemy.def?.swarm) colour.push('They kept coming in twos and threes long after it should have stopped.');
  if (enemy.def?.bleed) colour.push('Everything they touched kept bleeding.');
  if (enemy.def?.ruptureRad) colour.push('The first one to die came apart, and the dosimeters went over together.');
  if (enemy.def?.spawns) colour.push('Every time the squad cleared ground, more of them came up out of it.');
  if (enemy.def?.takesPrisoners && !outcome.win) colour.push('They took at least one alive. That is not mercy.');
  if (enemy.modifier) colour.push(modifierLine(enemy.modifier));

  // The dead, by name. Never summarised into a count alone.
  const named = casualties.slice(0, 3).map((c) =>
    rng.pick([
      `${fullName(c)} takes fire covering the withdrawal. ${fullName(c)} did not make it back.`,
      `${fullName(c)} went down in the first exchange and stayed down.`,
      `${fullName(c)} was carrying the spare rounds forward when it happened.`,
      `They could not reach ${fullName(c)}. They tried twice.`,
    ])
  );
  if (casualties.length > 3) {
    named.push(
      `${casualties.slice(3).map(fullName).join(', ')} did not come back either.`
    );
  }

  const closing = outcome.win
    ? ratio >= 2
      ? 'Over almost before it started. They walked the ground afterwards and took what was worth taking.'
      : ratio >= 1.4
      ? 'The line held. They stripped what they could carry and moved on.'
      : 'They won it, but slowly, and they paid for every metre.'
    : outcome.key === 'stalemate'
    ? 'Neither side could finish it. The squad broke contact and went the long way round.'
    : outcome.key === 'rout'
    ? 'The squad broke. What came back came back in pieces, and without its gear.'
    : 'They lost the position and most of what they were carrying.';

  const tail =
    survivors.length && !outcome.win ? [`${fullName(rng.pick(survivors))} got the rest of them out.`] : [];

  // Assemble to the 4-8 line budget: the fixed beats and the named dead are
  // never cut; colour is trimmed to fit.
  const fixed = [opening, command, middle, closing];
  const budget = 8 - fixed.length - named.length - tail.length;
  const trimmedColour = budget > 0 ? colour.slice(0, budget) : [];

  return [opening, command, ...trimmedColour, ...named, middle, closing, ...tail].filter(Boolean);
}

function modifierLine(mod) {
  switch (mod.key) {
    case 'irradiated': return 'Whatever they were carrying, it was hot. Everyone downwind took a dose.';
    case 'carapaced': return 'Rounds came off them flat. Twice the shooting for half the effect.';
    case 'frenzied': return 'They did not slow down, and they did not appear to feel any of it.';
    default: return '';
  }
}

/**
 * Turn a resolution into actions. Kept separate from resolve() so the same
 * maths can be used for a preview the player sees before committing.
 */
export function applyResolution(state, res, { context = 'expedition', kiaKind = 'killed in action' } = {}) {
  const actions = [];

  for (const id of res.casualties) {
    const c = state.citizens[id];
    if (!c) continue;
    actions.push({
      type: 'CITIZEN_DIE',
      id,
      cause: kiaKind,
      text:
        context === 'uprising'
          ? `${fullName(c)}, ${Math.floor(c.age)}, was killed holding the admin floor.`
          : `${fullName(c)}, ${Math.floor(c.age)}, was ${kiaKind} on the surface.`,
    });
  }
  if (res.casualties.length) {
    actions.push({
      type: 'ORDER_DELTA',
      amount: BAL.order.kiaPenalty * res.casualties.length,
      reason: 'losses on the surface',
    });
    actions.push({ type: 'STAT_BUMP', stats: { kia: res.casualties.length } });
  }

  const patches = [];
  for (const inj of res.injuries) {
    const c = state.citizens[inj.id];
    if (!c) continue;
    const patch = { id: inj.id, health: Math.max(1, c.health + inj.health) };
    if (inj.rad) patch.radiation = Math.min(100, c.radiation + inj.rad);
    patches.push(patch);
    if (inj.trait) actions.push({ type: 'CITIZEN_TRAIT', id: inj.id, trait: inj.trait });
  }
  if (patches.length) actions.push({ type: 'CITIZENS_PATCH', patches });

  for (const gid of res.gearLost) actions.push({ type: 'GEAR_DESTROY', id: gid });

  if (res.outcome.win) {
    actions.push({ type: 'ORDER_DELTA', amount: BAL.order.victoryBonus, reason: 'a victory' });
  }

  return actions;
}

export default { resolve, unitPower, rollEnemyForce, applyResolution, ammoFactor };
