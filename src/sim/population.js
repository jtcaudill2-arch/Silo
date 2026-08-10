/**
 * population.js — birth, aging, health, morale, vitality, death.
 *
 * Pure: `simulateDay(state, ctx)` returns actions, touches nothing. All
 * randomness comes from streams keyed on (seed, purpose, citizenId, day) so
 * a day replayed during offline catch-up produces exactly the day the player
 * would have watched.
 *
 * The design point that matters here (spec §6): vitality and health are
 * separate. Health is what the clinic fixes. Vitality is what age takes, and
 * it is felt as declining output for years before it ever kills anybody.
 */

import { BAL, TIME } from '../config/balance.js';
import { streamFor } from '../core/rng.js';
import { makeName, pickGender } from '../data/names.js';
import { BIRTH_TRAITS, traitMod, traitFlag, TRAITS } from '../data/traits.js';
import { SKILLS } from '../data/rooms.js';

const C = BAL.citizens;

// ---------------------------------------------------------------- factory --

let _idCounter = 1;
export function resetIdCounter(n) {
  _idCounter = n;
}
export function peekIdCounter() {
  return _idCounter;
}

/**
 * Build a citizen. `opts.age` in game years; everything else is rolled.
 * Always call with a deterministic Rng.
 */
export function makeCitizen(rng, opts = {}) {
  const gender = opts.gender || pickGender(rng);
  const { firstName, lastName } = opts.name || makeName(rng, gender);
  const age = opts.age !== undefined ? opts.age : rng.float(0, 62);

  const stats = opts.stats || rollStats(rng, opts.statBonus || 0);
  const skills = opts.skills || rollSkills(rng, age, stats);
  const traits = opts.traits || rollTraits(rng, opts.traitChance);

  const id = opts.id !== undefined ? opts.id : _idCounter++;
  if (opts.id !== undefined && opts.id >= _idCounter) _idCounter = opts.id + 1;

  return {
    id,
    firstName,
    lastName,
    gender,
    portraitSeed: opts.portraitSeed !== undefined ? opts.portraitSeed : rng.int(0, 0xffffff),
    age,
    birthTick: opts.birthTick ?? 0,
    stats,
    skills,
    health: opts.health ?? C.health.start,
    vitality: vitalityForAge(age, traits),
    morale: opts.morale ?? Math.round(rng.float(C.morale.start - 12, C.morale.start + 12)),
    radiation: opts.radiation ?? 0,
    traits,
    job: null,
    squadId: null,
    gear: { weapon: null, armor: null, suit: null },
    relationships: {},
    status: 'idle',
    causeOfDeath: null,
    deathDay: null,
    shiftsWorked: 0,
    restShifts: 0,
    pregnantUntilDay: null,
    partnerId: null,
    origin: opts.origin || 'born',
    history: opts.history || [],
  };
}

function rollStats(rng, bonus) {
  const s = {};
  for (const k of ['str', 'agi', 'int', 'end', 'cha']) {
    s[k] = clamp(
      rng.int(C.birthStatRoll.min, C.birthStatRoll.max) + bonus,
      C.statMin,
      C.statMax
    );
  }
  return s;
}

/**
 * One or two specialities, drawn without replacement against the weights in
 * `citizens.skillWeights`. Falls back to whatever is left if a weight is
 * missing, so adding a skill to SKILLS can never silently make it unrollable.
 */
function weightedFocus(rng, n) {
  const pool = SKILLS.slice();
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    const pick = rng.weighted(pool, (k) => BAL.citizens.skillWeights?.[k] ?? 1);
    if (!pick) break;
    out.push(pick);
    pool.splice(pool.indexOf(pick), 1);
  }
  return out;
}

function rollSkills(rng, age, stats) {
  const sk = {};
  // Adults arrive with a lifetime of work behind them; children with none.
  const yearsWorked = Math.max(0, Math.min(age - C.workingAgeMin, 30));
  for (const k of SKILLS) sk[k] = 0;
  if (yearsWorked <= 0) return sk;
  // One or two things they're actually good at, everything else incidental.
  // Weighted by what the silo actually needs a lot of — see
  // `citizens.skillWeights` for the counts this is drawn from.
  const focus = weightedFocus(rng, rng.int(1, 2));
  for (const k of SKILLS) {
    const base = rng.float(0, 8);
    const depth = focus.includes(k) ? rng.float(1.4, 2.6) : rng.float(0.1, 0.5);
    sk[k] = Math.round(clamp(base + yearsWorked * depth * (0.7 + stats.int / 20), 0, C.skillMax));
  }
  return sk;
}

function rollTraits(rng, chanceOverride) {
  const traits = [];
  const chance = chanceOverride ?? BAL.traits.rollChance;
  if (!rng.chance(chance)) return traits;
  const n = rng.chance(0.18) ? 2 : 1;
  for (let i = 0; i < Math.min(n, BAL.traits.maxAtBirth); i++) {
    const pool = BIRTH_TRAITS.filter((t) => !traits.includes(t.id));
    const pick = rng.weighted(pool, (t) => t.weight);
    if (pick) traits.push(pick.id);
  }
  return traits;
}

/** The vitality curve (spec §6). Flat, then a slope, then a cliff. */
export function vitalityForAge(age, traits) {
  const V = C.vitality;

  // Childhood is a ramp *up*. Trait modifiers must not touch it — applying an
  // age-decline multiplier to a toddler's "not fully grown yet" number pushes
  // them under the death threshold and kills infants of old age.
  if (age < V.childRampAge) {
    return clamp(V.childMin + (age / V.childRampAge) * (100 - V.childMin), 0, 100);
  }
  if (age <= V.flatUntilAge) return 100;

  let v;
  if (age <= V.declineSteepAge) {
    v = 100 - (age - V.declineStartAge) * V.declinePerYearEarly;
  } else {
    const atSteep = 100 - (V.declineSteepAge - V.declineStartAge) * V.declinePerYearEarly;
    v = atSteep - (age - V.declineSteepAge) * V.declinePerYearLate;
  }
  // Traits bend how fast the decline bites, never the plateau.
  if (traits && traits.length) {
    const mult = traitMod(traits, 'vitalityDecline');
    if (mult !== 1) v = 100 - (100 - v) * mult;
  }
  return clamp(v, 0, 100);
}

// ------------------------------------------------------------- day update --

/**
 * One game day of population simulation.
 * @returns {Array} actions
 */
export function simulateDay(state, ctx) {
  const actions = [];
  const day = state.clock.day;
  const seed = state.meta.seed;
  const ids = state.citizenIds;
  if (ids.length === 0) return actions;

  const env = readEnvironment(state);
  const patches = [];
  const deaths = [];
  const logs = [];

  for (const id of ids) {
    const c = state.citizens[id];
    if (!c || c.status === 'dead') continue;
    const rng = streamFor(seed, 'citizen-day', id, day);
    const p = { id };

    // ---- age -------------------------------------------------------------
    const newAge = c.age + 1 / TIME.daysPerYear;
    p.age = newAge;
    p.vitality = vitalityForAge(newAge, c.traits);

    // ---- radiation -------------------------------------------------------
    let rad = c.radiation;
    if (rad > 0 && env.clinicLevel > 0 && env.meds > 0) {
      const decayResist = traitMod(c.traits, 'radDecay');
      const treated =
        C.radiation.clinicTreatPerDayPerLevel * env.clinicLevel * env.clinicCapacityShare * decayResist;
      rad = Math.max(0, rad - treated);
    }
    p.radiation = clamp(rad, 0, C.radiation.max);

    // ---- health ----------------------------------------------------------
    let health = c.health;
    let hDelta = 0;

    if (env.starving) hDelta += BAL.resources.shortage.starvation.healthPerDay;
    if (env.dehydrated) hDelta += BAL.resources.shortage.dehydration.healthPerDay;
    if (env.airQuality < BAL.air.healthDecayBelow) {
      const resist = traitMod(c.traits, 'airResist');
      const severity = (BAL.air.healthDecayBelow - env.airQuality) / BAL.air.healthDecayBelow;
      hDelta += BAL.air.healthDecayPerDay * severity * resist;
    }
    if (p.radiation >= C.radiation.sicknessThreshold) {
      hDelta += C.radiation.sicknessHealthPerDay * (p.radiation / C.radiation.max);
    }
    if (hDelta >= 0 && health < C.health.max && !env.starving && !env.dehydrated) {
      const regen =
        C.health.regenPerDayFed * traitMod(c.traits, 'healthRegen') +
        (env.meds > 0 ? C.health.regenClinicPerLevel * env.clinicLevel * env.clinicCapacityShare : 0);
      hDelta += regen;
    }
    health = clamp(health + hDelta, 0, C.health.max);
    p.health = health;

    // ---- morale ----------------------------------------------------------
    let morale = c.morale;
    let mDelta = (C.morale.driftToward - morale) * C.morale.driftRate;
    if (env.starving) mDelta += BAL.resources.shortage.starvation.moralePerDay;
    if (env.dehydrated) mDelta += BAL.resources.shortage.dehydration.moralePerDay;
    if (env.brownout) mDelta += BAL.resources.shortage.brownoutMoralePerDay;
    if (env.overcrowdedBy > 0) mDelta -= env.overcrowdedBy * C.morale.overcrowdPenaltyPerOver;
    if (c.status === 'idle' && c.age >= C.workingAgeMin) mDelta += C.morale.idlePenaltyPerDay;
    if (env.cafeteriaMorale > 0) mDelta += env.cafeteriaMorale;
    if (c.shiftsWorked > C.morale.overworkShiftThreshold) {
      mDelta += C.morale.overworkPenaltyPerDay;
      p.health = clamp(p.health + C.morale.overworkHealthPerDay, 0, C.health.max);
    }
    mDelta += env.moraleAura;
    mDelta *= traitMod(c.traits, 'moraleSwing');
    morale = clamp(morale + mDelta, C.morale.min, C.morale.max);
    p.morale = morale;

    // ---- skill growth ----------------------------------------------------
    if (c.job && c.status === 'working') {
      const skill = ctx.jobSkillFor ? ctx.jobSkillFor(state, c) : null;
      if (skill) {
        const cur = c.skills[skill] || 0;
        let gain = (C.skillGrowthBase + c.stats.int / C.skillGrowthIntDivisor) *
          traitMod(c.traits, 'skillGrowth');
        if (cur > C.skillDiminishingAbove) gain *= C.skillDiminishingMult;
        if (gain > 0) p.skills = { ...c.skills, [skill]: Math.min(C.skillMax, cur + gain) };
      }
    } else if (c.status === 'school') {
      const focus = pickSchoolFocus(rng, c);
      const cur = c.skills[focus] || 0;
      let gain =
        (C.skillGrowthBase + c.stats.int / C.skillGrowthIntDivisor) *
        C.schoolGrowthMult *
        traitMod(c.traits, 'skillGrowth');
      if (cur > C.skillDiminishingAbove) gain *= C.skillDiminishingMult;
      p.skills = { ...c.skills, [focus]: Math.min(C.skillMax, cur + gain) };
    }

    // ---- cancer from long-term dose --------------------------------------
    if (
      p.radiation >= C.radiation.cancerThreshold &&
      !c.traits.includes('irradiated') &&
      rng.chance(C.radiation.cancerChancePerDay)
    ) {
      p.traits = [...c.traits, 'irradiated'];
      logs.push({
        kind: 'rad',
        text: `${fullName(c)} has been diagnosed with radiation sickness. The dose is permanent now.`,
      });
    }

    // ---- death -----------------------------------------------------------
    const death = rollDeath(rng, c, p, env);
    if (death) {
      deaths.push({ id, cause: death });
    } else {
      patches.push(p);
    }
  }

  if (patches.length) actions.push({ type: 'CITIZENS_PATCH', patches });

  for (const d of deaths) {
    actions.push({ type: 'CITIZEN_DIE', id: d.id, cause: d.cause, day });
  }

  for (const l of logs) actions.push({ type: 'LOG', entry: { ...l, day } });

  // ---- relationships, births -------------------------------------------
  actions.push(...simulateRelationships(state, env));
  actions.push(...simulateBirths(state, env));

  return actions;
}

function rollDeath(rng, c, p, env) {
  const vit = p.vitality;
  // Health reaching zero kills regardless of age, but the cause has to name
  // what actually did it — "organ failure" tells the player nothing.
  if (p.health <= 0) return causeFromConditions(p, env);

  if (vit >= C.death.vitalityThreshold) return null;

  let chance = (C.death.vitalityThreshold - vit) / C.death.divisor;
  // Poor health and a heavy dose both bring it forward.
  if (p.health < 60) chance *= 1 + ((60 - p.health) / 60) * C.death.healthFactor;
  if (p.radiation > 20) chance *= 1 + (p.radiation / 100) * (C.death.radiationFactor - 1);
  chance *= traitMod(c.traits, 'deathChance');
  chance *= Math.max(0.25, 1 - env.clinicLevel * C.death.clinicMitigationPerLevel);

  if (!rng.chance(chance)) return null;

  if (p.radiation >= C.radiation.cancerThreshold) return 'radiation sickness';
  if (env.starving) return 'starvation';
  if (env.dehydrated) return 'dehydration';
  if (p.health < 35) return 'disease';
  // "Old age" has to mean it. Anyone younger died of something else.
  return p.age >= C.vitality.declineSteepAge ? 'old age' : 'disease';
}

/**
 * Which of the silo's failures killed them. Ordered by how fast each one
 * actually kills, so the named cause matches the thing the player let happen.
 */
function causeFromConditions(p, env) {
  if (env.dehydrated) return 'dehydration';
  if (env.starving) return 'starvation';
  if (p.radiation >= C.radiation.sicknessThreshold) return 'radiation sickness';
  if (env.airQuality < BAL.air.massCasualtyBelow) return 'toxic exposure';
  return 'disease';
}

function pickSchoolFocus(rng, c) {
  // Children lean toward whatever they're already best at — plus a nudge
  // from int, which makes Gifted kids drift to science.
  const weights = SKILLS.map((k) => 1 + (c.skills[k] || 0) / 20 + (k === 'science' ? c.stats.int / 6 : 0));
  return rng.weighted(SKILLS, (_k, i) => weights[i]);
}

// ----------------------------------------------------------- relationships --

function simulateRelationships(state, env) {
  const day = state.clock.day;
  const rng = streamFor(state.meta.seed, 'relationships', day);
  const living = state.citizenIds.filter((id) => state.citizens[id]?.status !== 'dead');
  if (living.length < 2) return [];

  const edges = [];

  // People who share a room grow closer. This is where couples come from.
  for (const roomId of Object.keys(state.silo.rooms)) {
    const room = state.silo.rooms[roomId];
    const staff = room.staff.filter((s) => s != null);
    for (let i = 0; i < staff.length; i++) {
      for (let j = i + 1; j < staff.length; j++) {
        edges.push([staff[i], staff[j], C.relationships.sameRoomGrowthPerDay]);
      }
    }
  }

  // Neighbours. Living close is the other way people come to know each
  // other, and it's the one that doesn't require a job. Grouping is by
  // position in the roster, which is stable enough that the same handful of
  // people keep running into each other — that recurrence is the whole
  // point, because a bond that never sees the same face twice never climbs
  // anywhere. Groups scale with the headcount, so a bigger silo really is a
  // busier one.
  const R = C.relationships;
  for (let start = 0; start < living.length; start += R.neighbourhoodSize) {
    const block = living.slice(start, start + R.neighbourhoodSize);
    for (let i = 0; i < block.length; i++) {
      for (let j = i + 1; j < block.length; j++) {
        edges.push([block[i], block[j], R.neighbourGrowthPerDay]);
      }
    }
  }

  // The cafeteria mixes everybody. A handful of random pairs per day.
  const venue = env.hasCafeteria ? R.cafeteriaGrowthPerDay : 0;
  const pairs = R.randomPairsPerDay + (env.hasCafeteria ? 4 : 0);
  for (let i = 0; i < pairs; i++) {
    const a = rng.pick(living);
    const b = rng.pick(living);
    if (a === b) continue;
    const drift = rng.float(-0.9, 1.6) + venue;
    edges.push([a, b, drift]);
  }

  if (!edges.length) return [];
  return [{ type: 'RELATIONSHIP_DELTA', edges, decay: C.relationships.decayPerDay }];
}

// ------------------------------------------------------------------ births --

function simulateBirths(state, env) {
  const actions = [];
  const day = state.clock.day;
  const B = C.birth;

  // Deliver anyone whose term is up first — freeing the housing check below.
  for (const id of state.citizenIds) {
    const c = state.citizens[id];
    if (!c || c.status === 'dead' || c.pregnantUntilDay == null) continue;
    if (day < c.pregnantUntilDay) continue;
    const rng = streamFor(state.meta.seed, 'birth', id, day);
    const partner = c.partnerId != null ? state.citizens[c.partnerId] : null;
    const child = makeCitizen(rng, {
      age: 0,
      birthTick: state.clock.tick,
      lastNameFrom: null,
      origin: 'born',
      name: {
        firstName: makeName(rng, pickGender(rng)).firstName,
        lastName: (partner && rng.chance(0.5) ? partner.lastName : c.lastName),
      },
      statBonus: rng.chance(0.12) ? 1 : 0,
    });
    child.history.push({ day, text: `Born in Silo 12 to ${fullName(c)}.` });
    actions.push({ type: 'CITIZEN_ADD', citizen: child });
    actions.push({ type: 'CITIZENS_PATCH', patches: [{ id, pregnantUntilDay: null }] });
    actions.push({
      type: 'LOG',
      entry: {
        kind: 'birth',
        day,
        text: `${fullName(child)} was born. ${fullName(c)} is recovering in the clinic.`,
      },
    });
    actions.push({ type: 'ORDER_DELTA', amount: BAL.order.birthBonus, reason: 'a birth' });
  }

  // Conception requires everything the spec lists, all at once.
  if (state.order.value < B.requiredOrder) return actions;
  if (env.housingFree <= 0 && B.housingRequired) return actions;

  // Density dependence. Every gate above this is an absolute threshold, and
  // absolute thresholds get *easier* to clear as a silo grows — couples
  // scale with the headcount, so births did too, and growth compounded with
  // nothing at all pushing back. Left alone it peaks around two and a half
  // thousand people on day 677, overruns its housing, loses order, and dies
  // in an uprising followed by mass dehydration. A population has to feel
  // the room it is in.
  const pop = Math.max(1, state.citizenIds.length);
  const larderDays = env.foodSurplus / (pop * BAL.resources.perCitizen.foodPerDay);
  if (larderDays < B.foodDaysRequired) return actions;
  const roomy = Math.min(1, env.housingFree / B.roomyBeds);

  const rng = streamFor(state.meta.seed, 'conception', day);
  const candidates = state.citizenIds
    .map((id) => state.citizens[id])
    .filter(
      (c) =>
        c &&
        c.status !== 'dead' &&
        c.pregnantUntilDay == null &&
        c.age >= B.minAge &&
        c.age <= B.maxAge &&
        c.health > 50
    );

  let slots = Math.max(0, env.housingFree);
  const used = new Set();
  for (const c of candidates) {
    if (slots <= 0) break;
    if (used.has(c.id)) continue;
    // Find their strongest relationship above the threshold.
    let best = null;
    let bestVal = B.relationshipThreshold;
    for (const [otherId, val] of Object.entries(c.relationships || {})) {
      if (val <= bestVal) continue;
      const other = state.citizens[otherId];
      if (
        !other ||
        other.status === 'dead' ||
        used.has(other.id) ||
        other.age < B.minAge ||
        other.age > B.maxAge ||
        other.pregnantUntilDay != null
      )
        continue;
      best = other;
      bestVal = val;
    }
    if (!best) continue;
    if (!rng.chance(B.chancePerDayPerCouple * roomy)) continue;

    used.add(c.id);
    used.add(best.id);
    slots--;
    actions.push({
      type: 'CITIZENS_PATCH',
      patches: [{ id: c.id, pregnantUntilDay: day + B.gestationDays, partnerId: best.id }],
    });
  }

  return actions;
}

// ------------------------------------------------------------ environment --

/** Snapshot of everything the population sim needs from the rest of state. */
export function readEnvironment(state) {
  const pop = state.citizenIds.length;
  const res = state.resources;
  const flows = state.flows || {};

  let clinicLevel = 0;
  let clinicSlots = 0;
  let cafeteriaMorale = 0;
  let hasCafeteria = false;
  let housing = 0;
  let moraleAura = 0;

  for (const id of Object.keys(state.silo.rooms)) {
    const room = state.silo.rooms[id];
    const def = ctxRoomDef(room);
    if (!def) continue;
    // Bunks are bunks. A browned-out residence is dark, not demolished — so
    // housing is counted regardless of power, unlike everything else here.
    if (def.provides.housing) housing += def.provides.housing * room.level * room.width;
    if (!room.powered) continue;
    if (def.provides.healing) {
      clinicLevel += room.level;
      clinicSlots += room.level * 8;
    }
    if (def.provides.moraleBonusPerCycle) {
      hasCafeteria = true;
      cafeteriaMorale += BAL.citizens.morale.cafeteriaBonusPerLevel * room.level;
    }
    if (def.provides.moralePenaltyPerCycle) moraleAura -= def.provides.moralePenaltyPerCycle;
  }

  const foodPerDay = pop * BAL.resources.perCitizen.foodPerDay;
  const waterPerDay = pop * BAL.resources.perCitizen.waterPerDay;

  return {
    pop,
    starving: res.food <= 0,
    dehydrated: res.water <= 0,
    brownout: !!state.flags.brownout,
    meds: res.meds,
    airQuality: state.air.quality,
    clinicLevel,
    clinicCapacityShare: pop > 0 ? Math.min(1, clinicSlots / pop) : 0,
    cafeteriaMorale,
    hasCafeteria,
    housing: Math.floor(housing),
    housingFree: Math.floor(housing) - pop,
    overcrowdedBy: Math.max(0, pop - Math.floor(housing)),
    foodSurplus: res.food - foodPerDay,
    waterSurplus: res.water - waterPerDay,
    moraleAura,
  };
}

// The room definition lookup is injected at boot so this module stays free of
// import cycles with the build system.
let _roomDefLookup = () => null;
export function setRoomDefLookup(fn) {
  _roomDefLookup = fn;
}
function ctxRoomDef(room) {
  return _roomDefLookup(room.type);
}

// ---------------------------------------------------------------- helpers --

export function fullName(c) {
  return `${c.firstName} ${c.lastName}`;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Top skill for a citizen, used by auto-assign and the population list. */
export function topSkill(c) {
  let best = SKILLS[0];
  let bestVal = -1;
  for (const k of SKILLS) {
    if ((c.skills[k] || 0) > bestVal) {
      bestVal = c.skills[k] || 0;
      best = k;
    }
  }
  return { skill: best, value: bestVal };
}

/** Work output multiplier for one citizen in one job. */
export function workFactor(c, matchedSkill) {
  const J = BAL.jobs;
  const skillVal = matchedSkill ? c.skills[matchedSkill] || 0 : 0;
  const skillPart = J.skillOutputFloor + (skillVal / 100) * J.skillOutputCurve;
  const health = c.health / 100;
  const vit = c.vitality / 100;
  const morale = 1 - J.moraleWeight + (c.morale / 100) * J.moraleWeight;
  return skillPart * health * vit * morale * traitMod(c.traits, 'workOutput');
}

export function isDissident(c) {
  return c.traits.includes('dissident') || traitFlag(c.traits, 'uprisingSide') === 'rebel';
}

export { TRAITS };
export default { makeCitizen, simulateDay, vitalityForAge, readEnvironment, workFactor, topSkill };
