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
import { rollEnemyForce, resolve as resolveCombat, applyResolution, ammoAppetite, averageSuitStat } from './combat.js';
import { squadMembers, readiness, lootGear } from './military.js';
import { isConquestRun, resolveRun as resolveConquestRun, canLaunchRun, accumulate } from './conquest.js';
import { doctrineMod } from './doctrine.js';

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

/**
 * What the airlock has to be able to hand over before it opens.
 *
 * `appetite` is the squad's mean `stats.ammo` — see `ammoAppetite` in
 * combat.js. Food, water and meds are per body and do not care what anybody is
 * carrying; ammunition is per *weapon*, which is the whole cost side of the
 * appetite stat. It defaults to 1.0, which is the Service Rifle, which is the
 * number the game charged for everybody before there were per-item stats.
 */
export function supplyCost(band, memberCount, appetite = 1) {
  const days = band.travelDays;
  const S = BAL.expedition.supplies;
  return {
    food: Math.ceil(S.foodPerMemberPerDay * memberCount * days),
    water: Math.ceil(S.waterPerMemberPerDay * memberCount * days),
    meds: Math.ceil(S.medsPerMemberPerDay * memberCount * days),
    ammo: Math.ceil(S.ammoPerMemberPerDay * memberCount * days * appetite),
  };
}

/** The squad as it will go out, for anything that needs their gear. */
function rosterCitizens(state, ids) {
  return ids.map((id) => state.citizens[id]).filter(Boolean);
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
  // The suit's own `stats.band`, not its rank. They agree for the crafted
  // four; they part company for the Registry Skin, which is a tier-5 suit
  // that opens the Scar and not some band above it that does not exist.
  const worstTier = Math.min(...suits.map((s) => getItem(s.item)?.stats?.band ?? 0));
  if (worstTier < band.suitTier) {
    return {
      ok: false,
      reason: `${band.name} needs tier-${band.suitTier} suits. The worst one going out is tier ${worstTier}.`,
    };
  }

  const cost = supplyCost(band, members.length, ammoAppetite(state, members));
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

/**
 * Send a squad against another silo, on whichever conquest stage is current.
 *
 * A conquest run is an ordinary expedition — same band, same suit tier, same
 * supplies, same airlock capacity, same days out — so it goes through
 * `launch` rather than around it. What makes it a conquest is the `target`
 * and `purpose` it carries, which `resolveExpedition` reads at the top to
 * send it to sim/conquest.js instead of into the salvage pipeline below.
 *
 * It lives here rather than in conquest.js because conquest.js is imported
 * *by* this module; putting the launcher there would close the cycle.
 *
 * Returns actions, or [] if either gate refuses — conquest's, for whether the
 * stage can be attempted at all, and `canLaunch`, for whether this squad can
 * go outside.
 */
export function launchConquest(state, squadId, siloId) {
  const gate = canLaunchRun(state, siloId);
  if (!gate.ok) return [];
  // One run at a time against one silo.
  //
  // Without this, two squads sent at the same target both froze the same
  // `purpose` and both read the same pre-dispatch state, and the results were
  // not merely redundant — they were wrong. Two clean scout runs both wrote
  // `scoutRuns: 1` and the ladder could not be finished; two won holds both
  // dispatched `SATELLITE_ADD` and `world.satellites` carried the same silo
  // twice, which paid its yield twice, mis-assigned garrisons, left the
  // duplicate never warming or decaying, and — because the Dominion ending
  // counts `satellites.length` — let three silos taken twice read as six and
  // fire an ending the player had not earned.
  //
  // Reachable by ordinary clicking: open the silo, send a squad, reopen the
  // panel, send the next one.
  const inFlight = state.expeditions.active.some(
    (e) => !e.resolved && e.target === siloId && e.purpose !== 'salvage'
  );
  if (inFlight) return [];
  return launch(state, squadId, BAL.conquest.band, { target: siloId, purpose: gate.stage });
}

// -------------------------------------------------------------- resolution ---

/**
 * Resolve an expedition, deterministically, from its id. Safe to call at any
 * time on or after the return day; the result never depends on when.
 */
export function resolveExpedition(state, expedition) {
  // A run with a target silo and a purpose that is not salvage is a conquest
  // sortie, and none of what follows applies to it: no wasteland encounter
  // table, no loot, no artifacts, no recruits. sim/conquest.js owns it.
  if (isConquestRun(expedition)) return resolveConquestRun(state, expedition);

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

  // "days each way" was wrong, and it is where the twelve-day figure that
  // spread through conquest.js and research.js came from. `returnDay` is
  // `day + band.travelDays` and the wear and dose are billed at
  // `travelDays * hoursPerDay`, so this is the whole trip, not one leg.
  journal.push(
    `${band.name}. ${roster.length} out, ${Math.round(travelDays)} days there and back, ` +
      `${radPerHour} rad an hour on the surface.`
  );

  // Wounds, carried across the run's encounters by hand.
  //
  // The same defect the hold stage was fixed for, on the path that runs far
  // more often. `applyResolution` builds an *absolute* health from the citizen
  // it can see, nothing dispatches between a run's encounters, and the reducer
  // assigns — so two fights in one expedition both read the same pre-run
  // health and the later patch overwrote the earlier. Measured on the deep
  // band: 48 points of wounds landing as 35, and 47 as 24.
  //
  // Radiation was worse. The second patch's dose is `min(100, c.radiation +
  // this fight's rad)` off the original reading, so the first fight's dose was
  // not reduced, it was dropped.
  //
  // conquest.js used to say this mattered less here because "nothing depends
  // on the accumulation". That is not true of survival odds on a five-day run:
  // a squad that should be at 40 health going into the last fight goes in at
  // 75, and lives through fights it should not.
  const hurt = new Map();

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
      recruits, actions, casualties, day, hurt,
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
            // Their kit does not come home either, and nothing here has to
            // arrange that. CITIZEN_DIE hands a dead citizen's gear back to
            // the rack — right for a death in a corridor, wrong for one four
            // days into the waste — but a total wipe always ends on a defeat
            // or a rout, and both carry `outcome.gearLost`, which destroys
            // the casualties' kit already.
            //
            // That is arithmetic rather than luck: a winning outcome caps
            // casualties at 0.35 of the party, and `round(1 * 0.35)` is zero,
            // so a win can never kill the last person standing. Measured over
            // 400 seeds — 287 total wipes, and `gearLost` covered the kit in
            // every one of them.
            //
            // A `strandGear` helper was written for this and taken back out.
            // It was unreachable, and the mutation said so: deleting the call
            // changed nothing any test could see.
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
            const wound = rng.int(enc.injury[0], enc.injury[1]);
            // Through the accumulator, like every other wound on this run —
            // this is an absolute health computed from the same pre-run
            // reading, so on its own it would overwrite the fights.
            accumulate(hurt, [{ id: victim, health: Math.max(1, c.health - wound) }], state);
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
  // Two numbers off the suits themselves, where there used to be one array
  // indexed by a rounded average tier. Rounding the tier had a cliff in it —
  // a squad in tier-5 suits indexed past the end of the array and fell back to
  // 0.55, the *worst* value in it — and averaging the stat has no such edge.
  const shielding = averageSuitStat(state, expedition.roster, 'shielding');
  const wearRate = averageSuitStat(state, expedition.roster, 'wear');
  const breached = suitIntegrity <= 0;
  const doseRate = breached ? BAL.gear.suit.breachRadPerHour : radPerHour * shielding;
  radAccrued += doseRate * hoursOutside;
  suitIntegrity = Math.max(0, suitIntegrity - wearRate * hoursOutside * BAL.gear.suit.wearHoursFraction);

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
  // Nobody left means nothing comes back: the refund used to read only the
  // fight count, so a squad annihilated on day one of four still posted 75% of
  // its ammunition home, one line after the journal said there was nobody left
  // to carry anything.
  // Off the same frozen roster and the same appetite the supply was bought
  // with, so a squad of autogunners gets its own oversized load back rather
  // than the baseline squad's.
  const carried = supplyCost(
    band,
    expedition.roster.length,
    ammoAppetite(state, rosterCitizens(state, expedition.roster))
  ).ammo;
  const unfired = survivors.length ? Math.floor(carried * (1 - fightDays / dayCount)) : 0;
  if (unfired > 0) {
    actions.push({ type: 'RESOURCE_DELTA', deltas: { ammo: unfired } });
    journal.push(
      fightDays === 0
        ? `Nobody fired a shot. All ${unfired} rounds came back.`
        : `${unfired} unfired rounds came back to the armoury.`
    );
  }

  // The wounds, once, at their true total — and only for people still alive to
  // carry them home.
  {
    const patches = [...hurt.entries()]
      .filter(([id]) => !casualties.includes(id))
      .map(([id, v]) => (v.rad ? { id, health: v.health, radiation: v.radiation } : { id, health: v.health }));
    if (patches.length) actions.push({ type: 'CITIZENS_PATCH', patches });
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
  // Everything except the wounds; see `hurt` in resolveExpedition.
  for (const a of applyResolution(state, res, { context: 'expedition' })) {
    if (a.type === 'CITIZENS_PATCH') { accumulate(ctx.hurt, a.patches, state); continue; }
    actions.push(a);
  }
  actions.push({
    type: 'STAT_BUMP',
    stats: def.human ? { raidersKilled: res.enemyKilled } : { mutantsKilled: res.enemyKilled },
  });

  if (res.outcome.win && res.loot > 0) {
    addLoot(ctx, ctx.band.rewardTier, res.loot * 0.5);
  }
  // What the enemy itself was carrying, keyed on who they were rather than on
  // the ground they were standing on. A Warband met on the approach drops the
  // same table as a Warband met at your own airlock — see raid.js, which rolls
  // this one too.
  if (res.outcome.win) rollDrops(ctx, def);
  return res;
}

/** Roll an enemy's `drops` table once, for a fight that was won. */
function rollDrops(ctx, def) {
  for (const [gid, chance] of Object.entries(def?.drops || {})) {
    if (!ctx.rng.chance(chance)) continue;
    const got = lootGear(gid);
    if (!got) continue;
    ctx.actions.push(got.action);
    ctx.journal.push(`They stripped a ${got.item.name} off the dead and carried it back.`);
  }
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
      accumulate(ctx.hurt, [{ id: victim, health: Math.max(1, c.health - rng.int(20, 45)) }], ctx.state);
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
    for (const a of applyResolution(state, res, { context: 'expedition' })) {
      if (a.type === 'CITIZENS_PATCH') { accumulate(ctx.hurt, a.patches, state); continue; }
      actions.push(a);
    }
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
  const { rng, loot, artifacts, journal, state } = ctx;
  const taken = [];
  // Full Pockets weighs the crates; Prospectors reads the labels. They are
  // kept on separate terms on purpose: one node makes a run pay more tonnage
  // and the other makes it pay more research, and a player choosing between
  // them is choosing which of those the silo is short of. Neither touches the
  // gear chance below, which is priced against a measured yield of its own.
  const lootMult = mult * doctrineMod(state, 'lootMult');
  for (const [res, range] of Object.entries(table.resources)) {
    let amount = rng.int(range[0], range[1]) * lootMult;
    if (bias === res) amount *= 1.8;
    amount = Math.round(amount);
    if (amount <= 0) continue;
    loot[res] = (loot[res] || 0) + amount;
    taken.push(`${amount} ${res}`);
  }
  for (const [aid, chance] of Object.entries(table.artifacts)) {
    if (rng.chance(chance * mult * doctrineMod(state, 'artifactMult') + artifactBonus)) {
      artifacts[aid] = (artifacts[aid] || 0) + 1;
      taken.push(`a ${aid.replace(/_/g, ' ')}`);
    }
  }
  if (taken.length) journal.push(`Recovered: ${taken.join(', ')}.`);
  // Gear, in the same loop and on the same `mult`, but on its own line: a
  // rifle nobody in the silo could have built is not an item in a list of
  // scrap tonnages. `artifactBonus` deliberately does not apply — that is a
  // scavenge choice's bet on the archive, not on the armoury.
  for (const [gid, chance] of Object.entries(table.gear || {})) {
    if (!rng.chance(chance * mult)) continue;
    const got = lootGear(gid);
    if (!got) continue;
    ctx.actions.push(got.action);
    journal.push(`A ${got.item.name} came back with them. Nothing in the silo could have made one.`);
  }
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
    supplies: supplyCost(band, members.length, ammoAppetite(state, members)),
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
