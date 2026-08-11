/**
 * conquest.js — taking a silo, for real this time.
 *
 * `CONQUEST_STAGES` has described four stages since Phase 6, the radio panel
 * has drawn them with a reason string under whichever one is current, and
 * `canAdvance` has correctly said what each one needs. None of it did
 * anything: `CONQUEST_PATCH` was dispatched from nowhere in `src/` — only by
 * `test/conquest.mjs`, driving the reducer by hand — so no player could ever
 * advance a conquest by playing. Four stages, a gate function, a reducer and
 * a test, and no way in.
 *
 * The panel's own note said how it was meant to work: "Four stages, each a
 * separate expedition." The expedition record has carried unused `target` and
 * `purpose` fields since Phase 5 for exactly this. So a conquest run is an
 * ordinary expedition on the `approach` band with a target silo and a stage
 * as its purpose, and this module is what happens when it gets there instead
 * of the salvage pipeline.
 *
 * What each stage costs:
 *
 *   scout      contested. Failure alerts them and costs reputation, which is
 *              the cost CONQUEST_STAGES has always advertised.
 *   undermine  contested, harder. Success cuts `defenseMult`.
 *   breach     a real fight against the whole garrison at the door.
 *   hold       `holdCombats` sequential fights on one load-out, ammunition
 *              decaying between them. Winning all of them takes the silo.
 *
 * Every roll is a seeded stream keyed on the expedition id, so a conquest run
 * resolves identically whether it was watched or replayed during catch-up.
 *
 * Pure: (state, expedition) -> { actions, journal }. No dispatch, no DOM.
 */

import { BAL } from '../config/balance.js';
import { streamFor } from '../core/rng.js';
import { resolve as resolveCombat, applyResolution, unitPower } from './combat.js';
import { conquestState, CONQUEST_STAGES } from './diplomacy.js';
import { getItem, LOOT } from '../data/items.js';

const Q = BAL.conquest;

/** The stage a run against this silo would attempt next. */
export function nextStage(state, siloId) {
  const c = conquestState(state, siloId);
  return c.stage || 'scout';
}

/**
 * Can a squad go out on the current stage right now, and why not.
 *
 * Deliberately not `canAdvance`. That function answers a different question —
 * "is this stage finished?" — and returns `ok: false` with "1/2 approach runs
 * completed. Send another." while scouting is in progress. Gating the launch
 * on it would refuse the very run it is asking for. `canAdvance` gates the
 * *ladder*; this gates the *sortie*.
 */
export function canLaunchRun(state, siloId) {
  const silo = state.world.silos[siloId];
  if (!silo) return { ok: false, reason: 'No such silo.' };
  if (silo.status === 'collapsed') return { ok: false, reason: 'There is nothing left there to take.' };
  if (silo.contact === 'satellite') return { ok: false, reason: 'It is already yours.' };

  const c = conquestState(state, siloId);
  const stage = c.stage || 'scout';

  // 'held' is a terminal marker, not a stage anyone can run. `resolveRun` has
  // no branch for it, so letting a squad launch on it burned twelve days and a
  // supply load for nothing. It is reachable: a satellite that revolts used to
  // keep this marker (see SATELLITE_REVOLT, which now clears it), and an
  // in-flight run can land after another has taken the silo.
  if (stage === 'held') return { ok: false, stage, reason: 'It is already yours.' };

  if (stage === 'undermine' && (c.scoutRuns || 0) < Q.scoutRunsRequired) {
    return { ok: false, stage, reason: 'Their defences are not mapped yet.' };
  }
  if (stage === 'breach') {
    if (!state.research.completed.includes('breaching_charges')) {
      return { ok: false, stage, reason: 'Breaching charges are not researched.' };
    }
    // The `!sq` guard `raid.defenders` has and this did not. Nothing in the
    // game produces a squadId without a squad, but a gate that throws is a
    // worse answer than a gate that says no.
    const ready = state.military.squadIds.filter((id) => !state.military.squads[id]?.deployed).length;
    if (ready < Q.breachSquadsRequired) {
      return {
        ok: false,
        stage,
        reason: `Needs ${Q.breachSquadsRequired} squads standing by; ${ready} are.`,
      };
    }
  }
  return { ok: true, stage };
}

/** True for the purposes this module handles, i.e. not a salvage run. */
export function isConquestRun(expedition) {
  return !!expedition?.target && expedition.purpose !== 'salvage';
}

/**
 * The garrison, as something `combat.resolve` can be handed.
 *
 * `silo.power.military` is a 0-100 rating in the world table, not a force, so
 * it is converted here rather than anywhere else — one place to look when the
 * defence feels wrong. `defenseMult` is whatever undermining has already done
 * to them, and `scale` is how much of the garrison this particular fight
 * meets: all of it at the door, a share of it on each floor above.
 *
 * `human: true` on purpose. It hands the fight to combat.js's
 * `raiderFleeLossFraction` cap, which is the difference between a hard fight
 * and a squad wipe — these are people defending their home, and they break.
 */
export function garrisonForce(silo, scale = 1, defenseMult = 1) {
  const military = silo?.power?.military ?? 40;
  const power = Math.max(1, military * Q.garrisonPowerPerMilitary * defenseMult * scale);
  return {
    id: `garrison:${silo?.id ?? '?'}`,
    name: `${silo?.name || 'The silo'}'s garrison`,
    def: { id: 'garrison', name: 'Garrison', human: true },
    count: Math.max(2, Math.round(military / 8)),
    level: 1,
    modifier: null,
    power,
    human: true,
    displayName: `${silo?.name || 'The silo'}'s garrison`,
  };
}

/**
 * A contested check, for the two stages that are not battles.
 *
 * Scouting and undermining are not fights — CONQUEST_STAGES says failure
 * *alerts* them, not that it kills you — so these do not go through
 * `combat.resolve` and cannot produce casualties.
 *
 * Three things about the shape, all of which the first version got wrong by
 * reusing the battle maths:
 *
 * 1. It is the party's *average* quality, not its total. Twelve people are
 *    not twice as good at getting in unseen as six; they are twice as easy to
 *    see. Summing made a stealth check into a force check, so the answer to
 *    "how do I scout a dangerous silo" was "bring more people", which is the
 *    opposite of true.
 * 2. A bigger party is actively worse, by `approachSizePenalty` a head over
 *    the minimum. That is what makes scouting a job for a small team and the
 *    breach a job for everyone, rather than both being the same decision.
 * 3. Detection scales with the *root* of their military rating, not linearly
 *    with it. Average unit power runs from about 5 (green, unarmed) to about
 *    20 (veteran in tier-4 kit) — a four-fold range — while military runs 0
 *    to 95. Mapped linearly, no achievable squad could scout anything above
 *    the middle of the table: measured, a geared squad against The Anvil
 *    scored 0.21 against a threshold of 1, on every roll, for ever. The
 *    stage was not hard, it was closed.
 */
function contest(state, roster, silo, rng, detection) {
  const total = roster.reduce((a, id) => {
    const c = state.citizens[id];
    return a + (c ? unitPower(state, c) : 0);
  }, 0);
  const avg = total / Math.max(1, roster.length);
  const over = Math.max(0, roster.length - BAL.military.squadMin);
  const sizePenalty = 1 + over * Q.approachSizePenalty;

  const c = conquestState(state, silo.id);
  const military = silo?.power?.military ?? 40;
  const theirs = Math.max(
    0.5,
    Math.sqrt(military) * detection * (c.defenseMult ?? 1) * sizePenalty
  );
  return (avg * rng.float(0.7, 1.3)) / theirs;
}

/**
 * What a squad carries out of a silo it has just been inside.
 *
 * Scaled off the target's own row in the world table — `power.economy` for
 * the storerooms, `power.science` for what is in the archive — so that
 * choosing a target is a decision about that row rather than about which one
 * is nearest. `share` is how much of it this stage gets at: the breach opens
 * the doors, the hold is what lets you empty them.
 *
 * Artifacts come off the deep band's table. A silo standing since the
 * collapse holds the same class of thing as the deep ruins, and keeping
 * `origin_shard` on tier 4 means the Scar is still somewhere you have to walk
 * to — conquest is a second road to the research tree, not a bypass round it.
 */
function sack(silo, rng, share) {
  const S = Q.sack;
  const economy = silo?.power?.economy ?? 40;
  const science = silo?.power?.science ?? 30;
  const total = economy * S.perEconomy * share;

  const loot = {};
  const taken = [];
  // Split across the keys with a per-key roll, so two sacks of the same silo
  // do not read identically.
  const weights = S.keys.map(() => 0.5 + rng.next());
  const sum = weights.reduce((a, b) => a + b, 0);
  S.keys.forEach((k, i) => {
    const amount = Math.round((total * weights[i]) / sum);
    if (amount > 0) { loot[k] = amount; taken.push(`${amount} ${k}`); }
  });

  const artifacts = {};
  const table = LOOT[S.artifactTier] || {};
  for (const aid of Object.keys(table.artifacts || {})) {
    if (rng.chance(science * S.artifactChancePerScience * share)) {
      artifacts[aid] = (artifacts[aid] || 0) + 1;
      taken.push(`a ${aid.replace(/_/g, ' ')}`);
    }
  }
  return { loot, artifacts, taken };
}

/**
 * Fold one floor's wounds into the running total.
 *
 * `applyResolution` hands back absolute values computed from the citizen as
 * it currently stands, so the *first* patch for anyone is the real reading
 * and every later one is that same starting point minus only its own floor's
 * damage. Taking the difference recovers each floor's actual wound, which is
 * what accumulates.
 */
function accumulate(hurt, patches, state) {
  for (const p of patches || []) {
    const c = state.citizens[p.id];
    if (!c) continue;
    const wound = Math.max(0, c.health - p.health);
    const dose = Math.max(0, (p.radiation ?? c.radiation) - c.radiation);
    const seen = hurt.get(p.id) || { health: c.health, radiation: c.radiation, rad: false };
    seen.health = Math.max(1, seen.health - wound);
    if (dose > 0) { seen.radiation = Math.min(100, seen.radiation + dose); seen.rad = true; }
    hurt.set(p.id, seen);
  }
}

/**
 * The time-outside costs, which a conquest run pays exactly like a salvage
 * run does.
 *
 * These are not decoration. `EXPEDITION_RESOLVE` reads `a.suitIntegrity ?? 100`
 * and `a.radiation || 0`, so an action that simply omits them does not leave
 * suits and doses alone — it writes every suit back to 100 and everybody's
 * dose to nothing. Measured on the same band, same days, same seed: a salvage
 * run came home with suits at 1.9 and 202 rad waiting for decontamination; a
 * conquest run came home with suits at 100 and no dose at all.
 *
 * That made a conquest sortie a free suit refurbisher that strictly dominated
 * the salvage run it borrows its band from — and since the stages stay put on
 * failure, it could be cycled forever.
 *
 * Same arithmetic as expedition.js, deliberately: this is the same twelve days
 * on the same ground in the same suits.
 */
function outsideWear(state, expedition, roster) {
  const band = BAL.expedition.bands.find((b) => b.key === expedition.band) || { travelDays: 6 };
  const start = averageSuitIntegrity(state, roster);
  const hours = band.travelDays * BAL.expedition.hoursPerDay;
  const shielding = suitShielding(state, roster);
  return Math.max(0, start - shielding * hours * 0.35);
}

function outsideDose(expedition, state, roster) {
  const band = BAL.expedition.bands.find((b) => b.key === expedition.band) || { travelDays: 6, radPerHour: 7 };
  const hours = band.travelDays * BAL.expedition.hoursPerDay;
  if (!state) return Math.round(band.radPerHour * hours * 0.55);
  return Math.round(band.radPerHour * suitShielding(state, roster) * hours);
}

function suitShielding(state, roster) {
  const tiers = roster
    .map((id) => state.citizens[id]?.gear?.suit)
    .map((gid) => (gid ? getItem(state.military.gear[gid]?.item)?.tier ?? 1 : 1));
  const tier = tiers.length ? Math.round(tiers.reduce((a, b) => a + b, 0) / tiers.length) : 1;
  return BAL.gear.suit.degradePerHourOutside[Math.max(0, tier - 1)] ?? 0.55;
}

function averageSuitIntegrity(state, roster) {
  const vals = roster
    .map((id) => state.citizens[id]?.gear?.suit)
    .map((gid) => (gid ? state.military.gear[gid]?.integrity ?? 100 : 0))
    .filter((v) => v > 0);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

/**
 * Resolve a conquest run. Called from `resolveExpedition` in place of the
 * salvage pipeline.
 *
 * Always returns an `EXPEDITION_RESOLVE` so the squad comes home and its
 * members stop being `status: 'expedition'`, whatever happened out there —
 * a stage that fails is a stage that stands, not a squad that vanishes.
 */
export function resolveRun(state, expedition) {
  const silo = state.world.silos[expedition.target];
  const journal = [];
  const actions = [];

  const roster = expedition.roster.filter((id) => {
    const c = state.citizens[id];
    return c && c.status !== 'dead';
  });

  // Two very different failures used to share one branch, and it told the
  // player the wrong one: with a live roster and a missing target it reported
  // "Nobody came back" over eight people walking back in through the airlock.
  if (!roster.length) {
    const text = 'The approach run never reported in. Nobody came back.';
    return {
      actions: [
        { type: 'EXPEDITION_RESOLVE', id: expedition.id, survivors: [], casualties: [], journal: [text] },
        { type: 'LOG', entry: { kind: 'alert', text } },
      ],
      journal: [text],
      survivors: [],
      casualties: [],
    };
  }
  if (!silo) {
    const text = 'The squad came home. Whatever they were sent to look at is not there any more.';
    return {
      actions: [
        {
          type: 'EXPEDITION_RESOLVE',
          id: expedition.id,
          survivors: roster,
          casualties: [],
          journal: [text],
          suitIntegrity: outsideWear(state, expedition, roster),
          radiation: outsideDose(expedition, state, roster),
        },
        { type: 'LOG', entry: { kind: 'expedition', text } },
      ],
      journal: [text],
      survivors: roster,
      casualties: [],
    };
  }

  // ---- the ladder may have moved while they were walking ------------------
  //
  // `purpose` is frozen at launch and the run is six days out each way, so by
  // the time it reports the stage can be somewhere else — another squad's run
  // landed first, or a satellite revolted. Writing the stage unconditionally
  // dragged the ladder *backwards*: a scout report arriving after the breach
  // had opened rewrote `stage` to 'undermine' and the player paid for the
  // undermine run a second time.
  const current = (conquestState(state, silo.id).stage) || 'scout';
  if (expedition.purpose !== current) {
    const text =
      `The party sent to ${silo.name} came back with work that has been overtaken. ` +
      'Whatever they learned, the situation there has moved on.';
    return {
      actions: [
        {
          type: 'EXPEDITION_RESOLVE',
          id: expedition.id,
          survivors: roster,
          casualties: [],
          journal: [text],
          suitIntegrity: outsideWear(state, expedition, roster),
          radiation: outsideDose(expedition, state, roster),
        },
        { type: 'LOG', entry: { kind: 'expedition', text } },
      ],
      journal: [text],
      survivors: roster,
      casualties: [],
    };
  }

  // ---- and the target may no longer be a target ---------------------------
  //
  // Gated at launch, and that is not enough: the world collapses silos on its
  // own and a run is twelve days round trip. Unchecked, an in-flight assault
  // conquered rubble — `SATELLITE_ADD` writes `status: 'satellite'`, which
  // resurrected a collapsed silo as a productive holding — or took one the
  // player already held, pushing a second entry for it.
  if (silo.status === 'collapsed' || silo.contact === 'satellite') {
    const text = silo.contact === 'satellite'
      ? `${silo.name} was already Silo 12's by the time they got there.`
      : `They reached ${silo.name} and found it had already fallen in on itself.`;
    return {
      actions: [
        {
          type: 'EXPEDITION_RESOLVE',
          id: expedition.id,
          survivors: roster,
          casualties: [],
          journal: [text],
          suitIntegrity: outsideWear(state, expedition, roster),
          radiation: outsideDose(expedition, state, roster),
        },
        { type: 'LOG', entry: { kind: 'expedition', text } },
      ],
      journal: [text],
      survivors: roster,
      casualties: [],
    };
  }

  const rng = streamFor(state.meta.seed, 'conquest', expedition.id, expedition.target);
  const c = conquestState(state, silo.id);
  const stage = expedition.purpose;
  const stageName = CONQUEST_STAGES.find((s) => s.id === stage)?.name || stage;
  journal.push(`${stageName} — ${silo.name}. ${roster.length} out.`);

  let casualties = [];
  let survivors = roster.slice();
  let loot = {};
  let artifacts = {};

  // ---- scout: get in, map it, get out unseen -----------------------------
  if (stage === 'scout') {
    const ratio = contest(state, roster, silo, rng, Q.scoutDetection);
    if (ratio >= Q.scoutSpottedBelowRatio) {
      const runs = (c.scoutRuns || 0) + 1;
      // The run that completes the mapping also moves the marker. Otherwise
      // `stage` sits on 'scout' for ever and there is nothing in the game to
      // move it — which is the shape of the bug this module exists to fix.
      const done = runs >= Q.scoutRunsRequired;
      actions.push({
        type: 'CONQUEST_PATCH',
        siloId: silo.id,
        patch: { stage: done ? 'undermine' : 'scout', scoutRuns: runs },
      });
      journal.push(`In and out without being seen. ${runs} of ${Q.scoutRunsRequired} approaches mapped.`);
      actions.push({
        type: 'LOG',
        entry: {
          kind: 'expedition',
          text: `${silo.name}: approach ${runs} of ${Q.scoutRunsRequired} mapped. Nobody saw them.`,
        },
      });
    } else {
      actions.push({ type: 'SILO_REPUTATION', siloId: silo.id, amount: Q.scoutFailAlertRep });
      journal.push('Spotted on the approach. They know somebody was looking, and who.');
      actions.push({
        type: 'LOG',
        entry: {
          kind: 'diplomacy',
          text: `${silo.name} caught a Silo 12 squad on their approach. They will remember it.`,
        },
      });
    }
  }

  // ---- undermine: cut something they need --------------------------------
  else if (stage === 'undermine') {
    const ratio = contest(state, roster, silo, rng, Q.undermineDetection);
    if (ratio >= 1) {
      const before = c.defenseMult ?? 1;
      actions.push({
        type: 'CONQUEST_PATCH',
        siloId: silo.id,
        patch: {
          stage: 'breach',
          undermined: true,
          defenseMult: before * (1 - Q.undermineDefenseReduction),
        },
      });
      journal.push('Their intake line is cut and nobody down there knows why yet.');
      actions.push({
        type: 'LOG',
        entry: {
          kind: 'expedition',
          text: `${silo.name}'s defences are ${Math.round(Q.undermineDefenseReduction * 100)}% thinner than they were. They do not know it.`,
        },
      });
    } else {
      journal.push('The line held. Whatever was cut was patched before it mattered.');
      actions.push({
        type: 'LOG',
        entry: { kind: 'expedition', text: `The attempt on ${silo.name}'s supply came to nothing.` },
      });
    }
  }

  // ---- breach: the whole garrison, at the door ---------------------------
  else if (stage === 'breach') {
    const enemy = garrisonForce(silo, Q.breachGarrisonScale, c.defenseMult ?? 1);
    const res = resolveCombat(state, roster, enemy, {
      battleId: `breach:${silo.id}:${expedition.id}`,
      leaderId: expedition.leaderId,
    });
    actions.push(
      ...applyResolution(state, res, { context: 'conquest', kiaKind: 'killed in the breach' })
    );
    casualties = res.casualties;
    survivors = roster.filter((id) => !casualties.includes(id));
    journal.push(...res.log);

    if (res.outcome.win) {
      actions.push({ type: 'CONQUEST_PATCH', siloId: silo.id, patch: { stage: 'hold' } });
      journal.push('The door is open and the first floor is theirs. Now they have to keep it.');
      const got = sack(silo, rng, Q.sack.breachShare);
      loot = got.loot; artifacts = got.artifacts;
      if (got.taken.length) journal.push(`Carried out of the entry level: ${got.taken.join(', ')}.`);
      actions.push({
        type: 'LOG',
        entry: { kind: 'expedition', text: `${silo.name} is breached. ${res.outcome.name}.` },
      });
    } else {
      journal.push('The door held. What is left of the squad came home.');
      actions.push({
        type: 'LOG',
        entry: { kind: 'alert', text: `The breach of ${silo.name} failed. ${res.outcome.name}.` },
      });
    }
  }

  // ---- hold: five floors, one load-out -----------------------------------
  else if (stage === 'hold') {
    let standing = roster.slice();
    let won = 0;
    let ammo = 1;
    // Wounds, carried across the floors by hand.
    //
    // `applyResolution` builds an *absolute* `health` from the citizen it can
    // see, and nothing dispatches between these five fights — so five patches
    // each read the same pre-assault health and the reducer, which assigns,
    // kept only the last. Measured on one citizen: wounds of 22, 8, 22, 17
    // and 13 became a single write of 87 against a start of 100. Eighty-two
    // points of damage arrived as thirteen, and the stage whose entire
    // premise is "five fights on one load-out" was being fought by people who
    // healed between floors.
    //
    // So the wounds are accumulated here and emitted once, at the true
    // cumulative value. The same shape exists on the salvage path, which
    // applies per-encounter-day; it matters less there because nothing
    // depends on the accumulation, but it is the same defect.
    const hurt = new Map();
    let victories = 0;

    for (let i = 0; i < Q.holdCombats; i++) {
      if (!standing.length) break;
      const enemy = garrisonForce(silo, Q.holdGarrisonScale, c.defenseMult ?? 1);
      const res = resolveCombat(state, standing, enemy, {
        battleId: `hold:${silo.id}:${expedition.id}:${i}`,
        leaderId: expedition.leaderId,
        // What is left in the pouches after each floor. There is no resupply
        // inside somebody else's silo, which is the whole difficulty of this
        // stage — the fifth fight is the same garrison against a squad with a
        // fraction of the ammunition it started with.
        ammoFactorOverride: ammo,
      });
      // Everything except the wounds. See `accumulate` below for why the
      // wounds cannot go through `applyResolution` here.
      for (const a of applyResolution(state, res, { context: 'conquest', kiaKind: 'killed taking the floors' })) {
        if (a.type === 'CITIZENS_PATCH') { accumulate(hurt, a.patches, state); continue; }
        if (a.type === 'ORDER_DELTA' && a.reason === 'a victory') { victories++; continue; }
        actions.push(a);
      }
      casualties = casualties.concat(res.casualties);
      standing = standing.filter((id) => !res.casualties.includes(id));
      journal.push(`— Floor ${i + 1} —`, ...res.log);
      if (!res.outcome.win) {
        journal.push(`Floor ${i + 1} is where it stopped.`);
        break;
      }
      won++;
      ammo = Math.max(0.2, ammo - Q.holdAmmoDecayPerFight);
    }

    survivors = standing;

    // The wounds, once, at their true total — and only for people who are
    // still alive to carry them.
    const patches = [...hurt.entries()]
      .filter(([id]) => !casualties.includes(id))
      .map(([id, v]) => (v.rad ? { id, health: v.health, radiation: v.radiation } : { id, health: v.health }));
    if (patches.length) actions.push({ type: 'CITIZENS_PATCH', patches });

    // And one victory bonus for the assault, not one per floor. Five floors
    // used to pay `order.victoryBonus` five times — +20 Order arriving in a
    // single action stream, which is twenty days of satellite upkeep repaid at
    // the moment of conquest and was never anybody's intention.
    if (victories > 0) {
      actions.push({ type: 'ORDER_DELTA', amount: BAL.order.victoryBonus, reason: 'a silo taken' });
    }

    if (won >= Q.holdCombats) {
      actions.push({ type: 'CONQUEST_PATCH', siloId: silo.id, patch: { stage: 'held' } });
      actions.push({ type: 'SATELLITE_ADD', siloId: silo.id });
      actions.push({ type: 'STAT_BUMP', stats: { silosTaken: 1 } });
      const got = sack(silo, rng, 1 - Q.sack.breachShare);
      loot = got.loot; artifacts = got.artifacts;
      if (got.taken.length) journal.push(`Out of their storerooms: ${got.taken.join(', ')}.`);
      journal.push(`All ${Q.holdCombats} floors. ${silo.name} is Silo 12's.`);
    } else {
      journal.push(`${won} of ${Q.holdCombats} floors held. The rest of it is still theirs.`);
      actions.push({
        type: 'LOG',
        entry: {
          kind: 'alert',
          text: `The assault on ${silo.name} stopped on floor ${won + 1} of ${Q.holdCombats}.`,
        },
      });
    }
  }

  actions.push({
    type: 'EXPEDITION_RESOLVE',
    id: expedition.id,
    survivors,
    casualties,
    journal,
    // Both are required, not optional. The reducer reads `a.suitIntegrity ??
    // 100`, so omitting it does not mean "leave the suits alone" — it means
    // "write every suit back to full". Same for the dose: `a.radiation || 0`
    // sends a squad home from twelve days outside with nothing to
    // decontaminate.
    loot,
    artifacts,
    suitIntegrity: outsideWear(state, expedition, roster),
    radiation: outsideDose(expedition, state, roster),
  });

  return { actions, journal, survivors, casualties, loot, artifacts };
}

export default { resolveRun, isConquestRun, nextStage, canLaunchRun, garrisonForce };
