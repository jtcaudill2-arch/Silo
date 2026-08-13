/**
 * combat.js — auto-resolve. One function, called from four places:
 * expeditions (expedition.js), uprisings (order.js), silo defence (raid.js)
 * and the breach and hold stages of a conquest (conquest.js). That is the
 * spec's §13 list, less the siege — `diplomacy.js` still advances a conquest
 * through its gates rather than besieging anybody, which is by design: the
 * fighting happens on the approach runs.
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
import { doctrineMod } from './doctrine.js';
import { streamFor } from '../core/rng.js';
import { getItem, SUITS } from '../data/items.js';
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

  const base =
    c.stats.str * C.weights.str +
    c.stats.agi * C.weights.agi +
    (c.skills.combat || 0) * C.weights.combat;

  // A weapon in poor repair is worth less than the item claims.
  const wear = weapon ? 0.6 + 0.4 * (weapon.durability / BAL.gear.durabilityMax) : 1;
  // `stats.power` off the item, not a tier index. For the crafted four these
  // are the numbers `gearTierMult` held; a looted piece can sit between two
  // rungs, which is the whole point of it.
  const weaponPower = weapon ? getItem(weapon.item)?.stats?.power ?? C.unarmedPower : C.unarmedPower;
  const weaponMult = weaponPower * (weapon ? wear : 1);
  // Likewise `stats.dr` — `1 + tier * 0.12` for the crafted ladder, and
  // nothing for a citizen with an empty armour slot.
  const armorMult = 1 + (armor ? getItem(armor.item)?.stats?.dr ?? 0 : 0);

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
    traitMod(c.traits, 'combatEvade') *
    // Spearhead pays a small party; Wardens pays a party facing something
    // that is not people. Both come in through opts because neither is a fact
    // about the citizen: `unitPower` is also called with no context at all by
    // the conquest and raid previews, and there the identity is right — a
    // preview should not promise a bonus that depends on who turns up.
    (opts.partySize != null && opts.partySize <= C.spearheadMaxParty
      ? doctrineMod(state, 'smallPartyPower') : 1) *
    (opts.mutant ? doctrineMod(state, 'mutantPower') : 1)
  );
}

/**
 * Rounds per person per day this force actually wants, as a multiplier on
 * `supplies.ammoPerMemberPerDay`. A Slag Autogun is 2.0 of them and a Pipe Gun
 * is 0.8, so the hardest-hitting weapon in the game is also the one that can
 * leave a squad standing at the airlock.
 *
 * A member with nothing in the weapon slot reads 1.0 rather than 0. That is
 * deliberate and it is what the shipped game charged: a squad with no rifles
 * still draws its two rounds a head a day, and making bare hands free would
 * quietly cut the early silo's supply bill for a squad that cannot shoot.
 *
 * The single read of `?? 1` per member is what keeps the whole crafted-kit
 * baseline where it was: `service_rifle` is 1.0, so a squad carrying the
 * weapon everything else is priced against costs exactly what it always did.
 */
export function ammoAppetite(state, members) {
  if (!Array.isArray(members) || !members.length) return 1;
  let total = 0;
  for (const c of members) {
    const gid = c?.gear?.weapon;
    const item = gid ? getItem(state.military.gear[gid]?.item) : null;
    total += item?.stats?.ammo ?? 1;
  }
  return total / members.length;
}

/**
 * The squad's mean value of one env-suit stat, by citizen id.
 *
 * It lives here rather than in expedition.js because conquest.js needs it too
 * and conquest.js is imported *by* expedition.js — putting it there would
 * close the cycle. Both already import this module.
 *
 * Somebody with no suit reads the tier-1 figure, which is what the old
 * rounded-tier version did with a missing suit; `canLaunch` refuses to send a
 * bare body outside in the first place.
 *
 * Averaging the stat rather than rounding the average *tier* also removes a
 * cliff: a squad in tier-5 suits rounded to tier 5, indexed past the end of
 * the four-entry `degradePerHourOutside` array, and fell back to 0.55 — the
 * worst value in it. The best suits in the game read as the worst.
 */
export function averageSuitStat(state, roster, key) {
  const worst = SUITS[0].stats[key];
  if (!roster?.length) return worst;
  let total = 0;
  for (const id of roster) {
    const gid = state.citizens[id]?.gear?.suit;
    const item = gid ? getItem(state.military.gear[gid]?.item) : null;
    total += item?.stats?.[key] ?? worst;
  }
  return total / roster.length;
}

/**
 * Ammunition multiplier for the whole force. Takes the members rather than a
 * count, because what they are carrying decides how much they need.
 */
export function ammoFactor(state, members) {
  const count = Array.isArray(members) ? members.length : members;
  const need = count * BAL.expedition.supplies.ammoPerMemberPerDay * ammoAppetite(state, members);
  const have = state.resources.ammo;
  if (have >= need) return C.ammoFactorFull;
  if (need <= 0) return C.ammoFactorFull;
  const ratio = Math.max(0, have / need);
  const factor = C.ammoFactorEmpty + (C.ammoFactorFull - C.ammoFactorEmpty) * ratio;
  // Door Cache: rounds sealed at the airlock and counted separately, so a
  // fight never opens dry. A floor rather than a bonus — it does nothing at
  // all for a silo with full stores, and everything for one that has just been
  // sacked, which is the silo that is about to be raided again.
  return Math.max(factor, doctrineMod(state, 'ammoFloor') * C.ammoFactorFull);
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
  // Normally what is in the armoury at home. `ammoFactorOverride` is for a
  // fight where that is the wrong question: a squad five floors inside
  // somebody else's silo is carrying what it carried in, and the stores back
  // home are irrelevant to it. See sim/conquest.js, the hold stage.
  const af = opts.ammoFactorOverride ?? ammoFactor(state, members);

  // ---- our effective power ----------------------------------------------
  const powers = members.map((c) => ({
    c,
    p: unitPower(state, c, {
      ammoFactor: af, leaderBonus: lb, partySize: members.length, mutant: enemy.def ? !enemy.def.human : false,
    }),
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
  // A Hulk is immune to weapons below tier 3 (spec §11). What gets through is
  // the weapon's own `pierce`, not its rank: the Slag Autogun is a tier-4
  // piece that pierces 3, so it out-hits a Mag Rifle everywhere except in
  // front of the one thing that needs punching through.
  if (enemy.def?.minWeaponTier) {
    const best = bestPierce(state, members);
    if (best < enemy.def.minWeaponTier) {
      theirPower *= 3.5;
      log.push(
        `Nothing the squad is carrying will go through it. Pierce ${enemy.def.minWeaponTier} or nothing.`
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
    // `soak` is the fraction of a wound the plate takes instead of the person
    // wearing it. It is deliberately read *after* the outcome and the
    // casualty draw, and it consumes no rolls of its own — so armour decides
    // how badly the survivors come home and cannot decide who lives, who
    // dies, or whether the fight was won. That separation is what keeps every
    // win rate in the game where it was.
    const soak = armorSoak(state, c);
    const hurt = Math.round(
      rng.int(C.injury.survivorHealthLoss[0], C.injury.survivorHealthLoss[1]) *
        (outcome.win ? 0.7 : 1.2) *
        (1 - soak) *
        traitMod(c.traits, 'injuryTaken') * doctrineMod(state, 'injuryTaken')
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

/** The fraction of a wound this citizen's armour absorbs. Bare skin is 0. */
function armorSoak(state, c) {
  const gid = c.gear?.armor;
  if (!gid) return 0;
  return getItem(state.military.gear[gid]?.item)?.stats?.soak ?? 0;
}

/** The best `stats.pierce` anybody in the squad is carrying. Nothing is 0. */
function bestPierce(state, members) {
  let best = 0;
  for (const c of members) {
    const gid = c.gear?.weapon;
    if (!gid) continue;
    const item = getItem(state.military.gear[gid]?.item);
    if (item) best = Math.max(best, item.stats?.pierce ?? item.tier);
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
/**
 * Where a death happened, by the context that produced the fight.
 *
 * This used to be a ternary on `context === 'uprising'`, with everything else
 * falling through to "on the surface". That was true while the only two
 * callers were expeditions and uprisings; it stopped being true the moment
 * somebody could die defending the airlock, which is inside, or on the fifth
 * floor of somebody else's silo, which is neither.
 *
 * A death log that says the wrong place is worse than one that says nothing:
 * the log is the only record a player has of who this person was and what
 * happened to them, and it is read long after the event.
 */
const LOSS_PLACE = {
  expedition: 'losses on the surface',
  uprising: 'losses putting down an uprising',
  raid: 'losses defending the airlock',
  conquest: 'losses taking another silo',
};

const DEATH_PLACE = {
  expedition: 'was killed in action on the surface.',
  uprising: 'was killed holding the admin floor.',
  raid: 'was killed holding the airlock.',
  conquest: 'was killed inside somebody else’s silo.',
};

export function applyResolution(state, res, { context = 'expedition', kiaKind = 'killed in action' } = {}) {
  const actions = [];

  for (const id of res.casualties) {
    const c = state.citizens[id];
    if (!c) continue;
    actions.push({
      type: 'CITIZEN_DIE',
      id,
      cause: kiaKind,
      text: `${fullName(c)}, ${Math.floor(c.age)}, ${DEATH_PLACE[context] || DEATH_PLACE.expedition}`,
    });
  }
  if (res.casualties.length) {
    actions.push({
      type: 'ORDER_DELTA',
      amount: BAL.order.kiaPenalty * res.casualties.length,
      // The same correction `DEATH_PLACE` above exists for. This said "on the
      // surface" for people killed at the airlock and on the fifth floor of
      // another silo. Nothing reads `reason` today, which is precisely why it
      // was able to rot.
      reason: LOSS_PLACE[context] || LOSS_PLACE.expedition,
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

  // A fight wears out what was carried through it.
  //
  // `durabilityLossPerCombat` has sat in balance.js since gear existed and was
  // read by nothing; `GEAR_WEAR` had a reducer and was dispatched from nowhere
  // in src/. So `unitPower`'s wear term above was pinned at exactly 1.0 for
  // the whole history of the project, every weapon in every save finished its
  // campaign at durability 100, and the Armory's repair loop — which filters
  // on `durability < max` — had never repaired a single item.
  //
  // Measured here, at the shipped loss of 6 a fight, mag_rifle +
  // breacher_plate, 600 fights a cell:
  //
  //   fights unrepaired   durability   wear   Warband raid   breach mil 95
  //                    0          100   1.00           82%             93%
  //                    2           88   0.95           76%             92%
  //                    5           70   0.88           66%             88%
  //                    8           52   0.81           56%             85%
  //                   12           28   0.71           40%             75%
  //
  // Sixteen points against a Warband at the door for five unrepaired fights.
  // That is the Armory becoming a room worth staffing.
  //
  // Survivors only. The casualties' kit is either destroyed above or handed
  // back to the rack by CITIZEN_DIE, and wearing a piece that is about to be
  // deleted is a write nobody can see. Weapons and armour only: a suit's
  // condition is `integrity`, and EXPEDITION_RESOLVE already writes that from
  // the hours spent outside.
  const wear = [];
  for (const inj of res.injuries) {
    const c = state.citizens[inj.id];
    if (!c) continue;
    for (const slot of ['weapon', 'armor']) {
      const gid = c.gear?.[slot];
      if (gid && state.military.gear[gid]) {
        wear.push({ id: gid, durability: BAL.gear.durabilityLossPerCombat });
      }
    }
  }
  if (wear.length) actions.push({ type: 'GEAR_WEAR', wear, emit: false });

  if (res.outcome.win) {
    actions.push({ type: 'ORDER_DELTA', amount: BAL.order.victoryBonus, reason: 'a victory' });
  }

  return actions;
}

export default { resolve, unitPower, rollEnemyForce, applyResolution, ammoFactor, ammoAppetite };
