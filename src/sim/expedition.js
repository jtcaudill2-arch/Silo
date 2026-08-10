/**
 * expedition.js — the wasteland.
 *
 * The determinism rule from spec §3.4 is the important one here. An
 * expedition in flight when the player closes the tab is **not** replayed
 * tick-by-tick during catch-up. It resolves once, at its scheduled return
 * day, from a stream seeded on the expedition id — so the result is the same
 * whether the player watched it, fast-forwarded past it, or was asleep. There
 * is no save-scumming, and catch-up stays cheap.
 *
 * That means `resolveExpedition` must be a pure function of
 * (seed, expeditionId, the squad as it left, the destination) — nothing about
 * *when* it is called may change the outcome.
 */

import { BAL } from '../config/balance.js';
import { streamFor } from '../core/rng.js';
import { poolFor, getEnemy } from '../data/encounters.js';
import { LOOT, getItem } from '../data/items.js';
import { getRoom } from '../data/rooms.js';
import { fullName, makeCitizen } from './population.js';
import { effects as researchEffects } from './research.js';
import { rollEnemyForce, resolve as resolveCombat, applyResolution } from './combat.js';
import { squadMembers, readiness } from './military.js';

export const BANDS = BAL.expedition.bands;

export function getBand(key) {
  return BANDS.find((b) => b.key === key) || BANDS[0];
}

export function bandIndex(key) {
  return Math.max(0, BANDS.findIndex((b) => b.key === key));
}

// ---------------------------------------------------------------- launch ---

export function airlockCapacity(state) {
  let cap = 0;
  for (const room of Object.values(state.silo.rooms)) {
    const def = getRoom(room.type);
    if (def?.provides?.airlock && room.powered && room.buildingUntilCycle === 0) {
      cap += def.provides.deconCapacity * room.level;
    }
  }
  return cap;
}

export function supplyCost(band, memberCount) {
  const days = band.travelDays;
  const S = BAL.expedition.supplies;
  return {
    food: Math.ceil(S.foodPerMemberPerDay * memberCount * days),
    water: Math.ceil(S.waterPerMemberPerDay * memberCount * days),
    meds: Math.ceil(S.medsPerMemberPerDay * memberCount * days),
    ammo: Math.ceil(S.ammoPerMemberPerDay * memberCount * days),
  };
}

export function canLaunch(state, squadId, bandKey) {
  const sq = state.military.squads[squadId];
  if (!sq) return { ok: false, reason: 'No such squad.' };
  if (sq.deployed) return { ok: false, reason: `${sq.name} is already outside.` };

  const members = squadMembers(state, squadId);
  if (members.length < BAL.military.squadMin) {
    return { ok: false, reason: `A squad needs at least ${BAL.military.squadMin} people. ${sq.name} has ${members.length}.` };
  }

  const cap = airlockCapacity(state);
  if (cap <= 0) return { ok: false, reason: 'No working Airlock. Nothing leaves the silo without one.' };
  if (members.length > cap) {
    return {
      ok: false,
      reason: `The Airlock can decontaminate ${cap} at a time. ${sq.name} is ${members.length} strong — upgrade it or send fewer.`,
    };
  }

  const band = getBand(bandKey);
  const suits = members.map((c) => (c.gear?.suit ? state.military.gear[c.gear.suit] : null));
  const missing = suits.filter((s) => !s).length;
  if (missing) {
    return { ok: false, reason: `${missing} of the squad have no env-suit. Nobody goes out without one.` };
  }
  const worstTier = Math.min(...suits.map((s) => getItem(s.item)?.tier ?? 0));
  if (worstTier < band.suitTier) {
    return {
      ok: false,
      reason: `${band.name} needs tier-${band.suitTier} suits. The worst one going out is tier ${worstTier}.`,
    };
  }

  const cost = supplyCost(band, members.length);
  for (const [k, v] of Object.entries(cost)) {
    if ((state.resources[k] || 0) < v) {
      return { ok: false, reason: `Not enough ${k} to supply ${members.length} for ${band.travelDays} days (needs ${v}).` };
    }
  }

  return { ok: true, cost, band, members };
}

export function launch(state, squadId, bandKey, opts = {}) {
  const check = canLaunch(state, squadId, bandKey);
  if (!check.ok) return [];
  const { cost, band, members } = check;
  const sq = state.military.squads[squadId];

  const deltas = {};
  for (const [k, v] of Object.entries(cost)) deltas[k] = -v;

  const id = state.expeditions.nextId;
  const expedition = {
    id,
    squadId,
    band: bandKey,
    target: opts.target ?? null,
    purpose: opts.purpose ?? 'salvage',
    launchDay: state.clock.day,
    returnDay: state.clock.day + band.travelDays,
    // The roster is frozen at launch: the outcome must not depend on anything
    // that happens in the silo while they're gone.
    roster: members.map((c) => c.id),
    leaderId: sq.leaderId ?? members[0].id,
    resolved: false,
  };

  return [
    { type: 'RESOURCE_DELTA', deltas },
    { type: 'EXPEDITION_LAUNCH', expedition },
    { type: 'SQUAD_PATCH', id: squadId, patch: { deployed: true, assignment: 'expedition' } },
    ...members.map((c) => ({ type: 'CITIZEN_STATUS', id: c.id, status: 'expedition' })),
    { type: 'STAT_BUMP', stats: { expeditionsLaunched: 1 } },
    {
      type: 'LOG',
      entry: {
        kind: 'expedition',
        text: `${sq.name} went out through the airlock — ${members.length} bodies, ${band.name}, back in ${band.travelDays} days.`,
      },
    },
  ];
}

// -------------------------------------------------------------- resolution ---

/**
 * Resolve an expedition, deterministically, from its id. Safe to call at any
 * time on or after the return day; the result never depends on when.
 */
export function resolveExpedition(state, expedition) {
  const seed = state.meta.seed;
  const band = getBand(expedition.band);
  const bi = bandIndex(expedition.band);
  const research = researchEffects(state);

  const journal = [];
  const actions = [];
  const loot = {};
  const artifacts = {};
  const recruits = [];

  // Snapshot the squad as it left. Anyone who somehow died at home in the
  // meantime is simply not out there.
  const roster = expedition.roster.filter((id) => {
    const c = state.citizens[id];
    return c && c.status !== 'dead';
  });
  if (!roster.length) {
    return {
      actions: [
        { type: 'EXPEDITION_RESOLVE', id: expedition.id },
        { type: 'LOG', entry: { kind: 'expedition', text: 'The expedition never reported in. Nobody came back.' } },
      ],
      journal: ['Nobody came back.'],
    };
  }

  let suitIntegrity = averageSuitIntegrity(state, roster);
  const radPerHour = band.radPerHour;
  const travelDays = band.travelDays * (1 - (research.travelSpeed || 0));
  let radAccrued = 0;
  const casualties = [];
  let extraDays = 0;

  journal.push(
    `${band.name}. ${roster.length} out, ${Math.round(travelDays)} days each way, ` +
      `${radPerHour} rad an hour on the surface.`
  );

  // ---- one encounter per travel day ---------------------------------------
  // Days on which somebody actually shot at them. Counted because the rounds
  // they carried and did not fire come home in the pouch — see the refund
  // below.
  let fightDays = 0;
  const dayCount = Math.max(1, Math.round(travelDays));
  for (let day = 0; day < dayCount; day++) {
    const rng = streamFor(seed, 'expedition-day', expedition.id, day);
    const pool = poolFor(expedition.band, state.clock.day);
    const enc = rng.weighted(pool, (e) => e.weight);
    if (!enc) continue;

    journal.push(`— Day ${day + 1} —`);
    journal.push(enc.text);

    const ctx = {
      state, rng, expedition, band, bi, roster, journal, loot, artifacts,
      recruits, actions, casualties, day,
    };

    switch (enc.type) {
      case 'combat': {
        fightDays++;
        const res = runCombat(ctx, enc, suitIntegrity);
        suitIntegrity = Math.max(0, suitIntegrity - BAL.gear.suit.degradePerCombatHit);
        if (res) {
          for (const id of res.casualties) {
            casualties.push(id);
            const i = roster.indexOf(id);
            if (i >= 0) roster.splice(i, 1);
          }
          if (!roster.length) {
            journal.push('There was nobody left to carry anything home.');
            day = dayCount; // abort the run
          }
        }
        break;
      }
      case 'scavenge':
        radAccrued += runScavenge(ctx, enc);
        break;
      case 'survivor':
        runSurvivor(ctx, enc);
        break;
      case 'hazard': {
        const dmg = enc.suitDamage || 0;
        suitIntegrity = Math.max(0, suitIntegrity - dmg);
        if (enc.rad) radAccrued += enc.rad;
        if (enc.timeCost) extraDays += enc.timeCost;
        if (enc.injury) {
          const victim = rng.pick(roster);
          const c = state.citizens[victim];
          if (c) {
            const hurt = rng.int(enc.injury[0], enc.injury[1]);
            actions.push({ type: 'CITIZENS_PATCH', patches: [{ id: victim, health: Math.max(1, c.health - hurt) }] });
            journal.push(`${fullName(c)} came out of it worst.`);
          }
        }
        journal.push(dmg ? `Suit integrity down to ${Math.round(suitIntegrity)}.` : '');
        break;
      }
      case 'discovery':
        runDiscovery(ctx, enc);
        break;
      case 'moral':
        runMoral(ctx, enc);
        break;
    }
  }

  // ---- radiation from time outside ----------------------------------------
  const hoursOutside = (dayCount + extraDays) * BAL.expedition.hoursPerDay;
  const suitTierAvg = averageSuitTier(state, expedition.roster);
  const shielding = BAL.gear.suit.degradePerHourOutside[Math.max(0, suitTierAvg - 1)] ?? 0.55;
  const breached = suitIntegrity <= 0;
  const doseRate = breached ? BAL.gear.suit.breachRadPerHour : radPerHour * shielding;
  radAccrued += doseRate * hoursOutside;
  suitIntegrity = Math.max(0, suitIntegrity - shielding * hoursOutside * 0.35);

  if (breached) {
    journal.push('At least one suit failed outright. Everyone in it took the full dose.');
  }

  // ---- home ----------------------------------------------------------------
  const survivors = roster.slice();
  const radEach = Math.round(radAccrued);

  // Unfired ammunition comes back.
  //
  // Food and water are eaten and meds are used up, but a squad that walks to
  // the near ruins, finds nobody, and walks home again is carrying every round
  // it left with. The supply was being written off wholesale regardless of
  // what happened out there, which made a quiet patrol cost exactly as much as
  // a running battle — and ammunition is the one supply the silo can barely
  // make. Measured over 300 days: a squad blocked at the airlock for want of
  // rounds on 192 of them, while the weapons benches stood empty because the
  // silo was at full employment and had nobody to put in them. The demand was
  // the part that was wrong, not the supply.
  //
  // Charged by the day, from the same frozen roster the supply was bought for,
  // so re-resolving the same expedition always returns the same number.
  const carried = supplyCost(band, expedition.roster.length).ammo;
  const unfired = Math.floor(carried * (1 - fightDays / dayCount));
  if (unfired > 0) {
    actions.push({ type: 'RESOURCE_DELTA', deltas: { ammo: unfired } });
    journal.push(
      fightDays === 0
        ? `Nobody fired a shot. All ${unfired} rounds came back.`
        : `${unfired} unfired rounds came back to the armoury.`
    );
  }

  actions.push({
    type: 'EXPEDITION_RESOLVE',
    id: expedition.id,
    survivors,
    casualties,
    loot,
    artifacts,
    radiation: radEach,
    suitIntegrity,
    recruits,
    journal,
  });

  return { actions, journal, survivors, casualties, loot, artifacts, radiation: radEach };
}

// ------------------------------------------------------- encounter runners ---

function runCombat(ctx, enc, suitIntegrity) {
  const { state, rng, expedition, bi, roster, journal, actions } = ctx;
  const def = getEnemy(enc.enemy);
  if (!def) return null;

  const enemy = rollEnemyForce(rng, def, {
    bandIndex: bi,
    dayIndex: state.clock.day,
    sizeScale: 0.6 + roster.length / 12,
  });

  const res = resolveCombat(state, roster, enemy, {
    battleId: `${expedition.id}:${ctx.day}`,
    leaderId: expedition.leaderId,
    ambush: def.ambush ? -def.ambush : rng.float(-0.2, 0.3),
    terrain: rng.float(-0.3, 0.3),
    suitIntegrity,
  });

  journal.push(...res.log);
  actions.push(...applyResolution(state, res, { context: 'expedition' }));
  actions.push({
    type: 'STAT_BUMP',
    stats: def.human ? { raidersKilled: res.enemyKilled } : { mutantsKilled: res.enemyKilled },
  });

  if (res.outcome.win && res.loot > 0) {
    addLoot(ctx, ctx.band.rewardTier, res.loot * 0.5);
  }
  return res;
}

function runScavenge(ctx, enc) {
  const { rng, journal } = ctx;
  // The squad chooses on the player's standing orders; without a UI decision
  // in flight, they take the middle option unless the run is going badly.
  const choice = pickScavengeChoice(rng, enc, ctx);
  journal.push(`They ${choice.label.toLowerCase()}.`);

  if (choice.riskCollapse && rng.chance(choice.riskCollapse)) {
    const victim = rng.pick(ctx.roster);
    const c = ctx.state.citizens[victim];
    if (c) {
      ctx.actions.push({
        type: 'CITIZENS_PATCH',
        patches: [{ id: victim, health: Math.max(1, c.health - rng.int(20, 45)) }],
      });
      journal.push(`Part of it came down. ${fullName(c)} was under it.`);
    }
  }
  if (choice.riskFire && rng.chance(choice.riskFire)) {
    journal.push('One of the tanks went up. They lost most of what they had already loaded.');
    return (choice.rad || 0) + 6;
  }

  if (choice.loot > 0) {
    addLoot(ctx, ctx.band.rewardTier, choice.loot, choice.lootBias, choice.artifactBonus);
  }
  return choice.rad || 0;
}

function pickScavengeChoice(rng, enc, ctx) {
  const choices = enc.choices || [];
  if (!choices.length) return { label: 'moved on', loot: 0, rad: 0 };
  // Standing orders: take the risk when the squad is fresh, not when it isn't.
  const health = avg(ctx.roster.map((id) => ctx.state.citizens[id]?.health ?? 0));
  const bold = health > 70 ? 0 : health > 45 ? 1 : choices.length - 1;
  return choices[Math.min(bold, choices.length - 1)];
}

function runSurvivor(ctx, enc) {
  const { state, rng, journal, actions, recruits } = ctx;
  if (rng.chance(enc.trapChance ?? 0.1)) {
    journal.push('It was bait. They were waiting in the building behind.');
    const def = getEnemy('dust_runners');
    const enemy = rollEnemyForce(rng, def, { bandIndex: ctx.bi, dayIndex: state.clock.day, sizeScale: 0.7 });
    const res = resolveCombat(state, ctx.roster, enemy, {
      battleId: `${ctx.expedition.id}:trap:${ctx.day}`,
      leaderId: ctx.expedition.leaderId,
      ambush: -0.5,
    });
    journal.push(...res.log);
    actions.push(...applyResolution(state, res, { context: 'expedition' }));
    for (const id of res.casualties) {
      ctx.casualties.push(id);
      const i = ctx.roster.indexOf(id);
      if (i >= 0) ctx.roster.splice(i, 1);
    }
    return;
  }

  if (!rng.chance(BAL.expedition.survivorRecruitChance)) {
    journal.push('They would not come. Some people out here have made their peace with it.');
    return;
  }

  const rng2 = streamFor(state.meta.seed, 'survivor', ctx.expedition.id, ctx.day);
  const recruit = makeCitizen(rng2, {
    age: rng2.float(17, 44),
    origin: 'survivor',
    statBonus: 1, // wasteland survivors are the best stats you can get
    radiation: rng2.int(BAL.expedition.survivorRadRange[0], BAL.expedition.survivorRadRange[1]),
    traitChance: 0.7,
  });
  if (rng2.chance(BAL.expedition.survivorDissidentChance + (enc.dissidentBonus || 0))) {
    if (!recruit.traits.includes('dissident')) recruit.traits.push('dissident');
  }
  if (enc.skillBias) {
    recruit.skills[enc.skillBias] = Math.min(100, (recruit.skills[enc.skillBias] || 0) + rng2.int(20, 45));
  }
  recruit.history.push({ day: state.clock.day, text: 'Found in the wasteland and brought inside.' });
  recruits.push(recruit);
  journal.push(
    `${fullName(recruit)} came back with them — ${Math.floor(recruit.age)}, ` +
      `carrying a dose of ${Math.round(recruit.radiation)}.`
  );
  if (enc.reputation) {
    actions.push({ type: 'SILO_REPUTATION', siloId: enc.reputation.silo, amount: enc.reputation.amount });
  }
}

function runDiscovery(ctx, enc) {
  const { state, rng, journal, actions } = ctx;
  if (enc.loot) addLoot(ctx, ctx.band.rewardTier, enc.loot);
  if (enc.reveals === 'map') {
    actions.push({ type: 'MAP_REVEAL', band: ctx.expedition.band });
    journal.push('The charts were good. More of the map is usable now.');
  }
  if (enc.reveals === 'silo') {
    const unknown = Object.values(state.world.silos).filter((s) => !s.known);
    if (unknown.length) {
      const found = rng.pick(unknown);
      actions.push({ type: 'SILO_DISCOVER', siloId: found.id, contact: enc.contact ? 'radio' : 'none' });
      journal.push(`They found ${found.name}. It is on the board now.`);
    }
  }
  if (enc.intel) actions.push({ type: 'STAT_BUMP', stats: { intel: enc.intel } });
}

function runMoral(ctx, enc) {
  const { rng, journal, actions, state } = ctx;
  const choices = enc.choices || [];
  if (!choices.length) return;
  // Without a live decision, the squad follows the silo's Order: a
  // high-Order silo behaves decently, a desperate one does not.
  const order = state.order.value;
  const idx = order > 60 ? 0 : order > 35 ? 1 : choices.length - 1;
  const choice = choices[Math.min(idx, choices.length - 1)];
  journal.push(`Standing orders: ${choice.label.toLowerCase()}.`);

  if (choice.cost) {
    const deltas = {};
    for (const [k, v] of Object.entries(choice.cost)) deltas[k] = -v;
    actions.push({ type: 'RESOURCE_DELTA', deltas });
  }
  if (choice.chits) actions.push({ type: 'RESOURCE_DELTA', deltas: { chits: choice.chits } });
  if (choice.order) actions.push({ type: 'ORDER_DELTA', amount: choice.order, reason: 'a decision on the surface' });
  if (choice.reputation) {
    actions.push({ type: 'SILO_REPUTATION', siloId: choice.reputation.silo, amount: choice.reputation.amount });
  }
  if (choice.recruit && rng.chance(choice.recruit)) {
    const rng2 = streamFor(state.meta.seed, 'moral-recruit', ctx.expedition.id, ctx.day);
    const recruit = makeCitizen(rng2, { age: rng2.float(14, 50), origin: 'survivor', radiation: rng2.int(0, 20) });
    recruit.history.push({ day: state.clock.day, text: 'Taken in from the wasteland.' });
    ctx.recruits.push(recruit);
    journal.push(`${fullName(recruit)} walked back with them.`);
  }
  if (choice.morale) {
    journal.push(
      choice.morale < 0
        ? 'Nobody in the squad talked about it on the way home.'
        : 'It was the right call and everyone knew it.'
    );
  }
}

// --------------------------------------------------------------- loot ---

function addLoot(ctx, tier, mult, bias, artifactBonus = 0) {
  const table = LOOT[tier] || LOOT[1];
  const { rng, loot, artifacts, journal } = ctx;
  const taken = [];
  for (const [res, range] of Object.entries(table.resources)) {
    let amount = rng.int(range[0], range[1]) * mult;
    if (bias === res) amount *= 1.8;
    amount = Math.round(amount);
    if (amount <= 0) continue;
    loot[res] = (loot[res] || 0) + amount;
    taken.push(`${amount} ${res}`);
  }
  for (const [aid, chance] of Object.entries(table.artifacts)) {
    if (rng.chance(chance * mult + artifactBonus)) {
      artifacts[aid] = (artifacts[aid] || 0) + 1;
      taken.push(`a ${aid.replace(/_/g, ' ')}`);
    }
  }
  if (taken.length) journal.push(`Recovered: ${taken.join(', ')}.`);
}

// ------------------------------------------------------------------ daily ---

/** Resolve every expedition whose return day has arrived. */
export function simulateDay(state) {
  const actions = [];
  for (const exp of state.expeditions.active) {
    if (exp.resolved) continue;
    if (state.clock.day < exp.returnDay) continue;
    const { actions: a } = resolveExpedition(state, exp);
    actions.push(...a);
  }
  return actions;
}

// ---------------------------------------------------------------- helpers ---

function averageSuitIntegrity(state, roster) {
  const vals = roster
    .map((id) => state.citizens[id]?.gear?.suit)
    .map((gid) => (gid ? state.military.gear[gid]?.integrity ?? 100 : 0))
    .filter((v) => v > 0);
  return vals.length ? avg(vals) : 0;
}

function averageSuitTier(state, roster) {
  const tiers = roster
    .map((id) => state.citizens[id]?.gear?.suit)
    .map((gid) => (gid ? getItem(state.military.gear[gid]?.item)?.tier ?? 1 : 1));
  return tiers.length ? Math.round(avg(tiers)) : 1;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Risk preview for the launch screen. Shown as a *range*, never a single
 * percentage — the player should never feel lied to by a number (spec §15).
 */
export function riskPreview(state, squadId, bandKey) {
  const band = getBand(bandKey);
  const members = squadMembers(state, squadId);
  if (!members.length) return null;
  const ready = readiness(state, squadId);
  const bi = bandIndex(bandKey);

  // Rough expected threat for the band, from the encounter pool.
  const pool = poolFor(bandKey, state.clock.day).filter((e) => e.type === 'combat');
  const totalW = pool.reduce((a, e) => a + e.weight, 0) || 1;
  const expectedThreat = pool.reduce((a, e) => {
    const def = getEnemy(e.enemy);
    if (!def) return a;
    const mid = (def.count[0] + def.count[1]) / 2;
    return a + (e.weight / totalW) * def.power * mid;
  }, 0);

  const ours = members.reduce(
    (a, c) =>
      a +
      (c.stats.str * BAL.combat.weights.str +
        c.stats.agi * BAL.combat.weights.agi +
        (c.skills.combat || 0) * BAL.combat.weights.combat) *
        (c.health / 100),
    0
  );

  const ratio = ours / Math.max(1, expectedThreat);
  const lo = ratio * BAL.combat.rollClamp[0];
  const hi = ratio * BAL.combat.rollClamp[1];

  return {
    band,
    members: members.length,
    readiness: ready,
    ratioRange: [lo, hi],
    verdict: verdictFor(lo, hi),
    radRange: [
      Math.round(band.radPerHour * band.travelDays * BAL.expedition.hoursPerDay * 0.2),
      Math.round(band.radPerHour * band.travelDays * BAL.expedition.hoursPerDay * 0.6),
    ],
    supplies: supplyCost(band, members.length),
    encounters: Math.max(1, Math.round(band.travelDays)),
    bandIndex: bi,
  };
}

function verdictFor(lo, hi) {
  if (lo >= 1.4) return 'Comfortable. They should all come home.';
  if (lo >= 1.0) return 'Favourable, but the wasteland does not read forecasts.';
  if (hi >= 1.4) return 'It could go either way. Expect to lose somebody.';
  if (hi >= 1.0) return 'Poor odds. This is how squads stop existing.';
  return 'They are not coming back. Do not send them.';
}

export default { launch, canLaunch, resolveExpedition, simulateDay, riskPreview, airlockCapacity };
