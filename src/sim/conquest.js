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

  if (stage === 'undermine' && (c.scoutRuns || 0) < Q.scoutRunsRequired) {
    return { ok: false, stage, reason: 'Their defences are not mapped yet.' };
  }
  if (stage === 'breach') {
    if (!state.research.completed.includes('breaching_charges')) {
      return { ok: false, stage, reason: 'Breaching charges are not researched.' };
    }
    const ready = state.military.squadIds.filter((id) => !state.military.squads[id].deployed).length;
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

  if (!silo || !roster.length) {
    return {
      actions: [
        { type: 'EXPEDITION_RESOLVE', id: expedition.id, survivors: roster, journal },
        {
          type: 'LOG',
          entry: { kind: 'expedition', text: 'The approach run never reported in. Nobody came back.' },
        },
      ],
      journal: ['Nobody came back.'],
    };
  }

  const rng = streamFor(state.meta.seed, 'conquest', expedition.id, expedition.target);
  const c = conquestState(state, silo.id);
  const stage = expedition.purpose;
  const stageName = CONQUEST_STAGES.find((s) => s.id === stage)?.name || stage;
  journal.push(`${stageName} — ${silo.name}. ${roster.length} out.`);

  let casualties = [];
  let survivors = roster.slice();

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
      actions.push(
        ...applyResolution(state, res, { context: 'conquest', kiaKind: 'killed taking the floors' })
      );
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

    if (won >= Q.holdCombats) {
      actions.push({ type: 'CONQUEST_PATCH', siloId: silo.id, patch: { stage: 'held' } });
      actions.push({ type: 'SATELLITE_ADD', siloId: silo.id });
      actions.push({ type: 'STAT_BUMP', stats: { silosTaken: 1 } });
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
  });

  return { actions, journal, survivors, casualties };
}

export default { resolveRun, isConquestRun, nextStage, canLaunchRun, garrisonForce };
