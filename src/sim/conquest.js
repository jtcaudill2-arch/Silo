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
import { resolve as resolveCombat, applyResolution, unitPower, averageSuitStat } from './combat.js';
import { conquestState, CONQUEST_STAGES } from './diplomacy.js';
import { readySquads, squadMembers, lootGear } from './military.js';
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
  // no branch for it, so letting a squad launch on it burned six days and a
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
    // Crewed squads, not squad records. This counted `!deployed` alone, and
    // `SQUAD_CREATE` makes a squad with `members: []` — so the hardest gate in
    // the game was cleared by pressing New Squad twice. `readySquads` is the
    // same predicate the radio panel draws its button from, so the two cannot
    // disagree about what a squad is again.
    const ready = readySquads(state).length;
    if (ready < Q.breachSquadsRequired) {
      return {
        ok: false,
        stage,
        reason: `Needs ${Q.breachSquadsRequired} squads standing by; ${ready} are.`,
      };
    }
    // And something to open the door with.
    //
    // Every other clause here is about the ladder or the roster; none was
    // about what the party is holding, so a squad of pipe guns — twenty-two
    // scrap and four parts apiece — could be sent at a sealed silo. The
    // Breaching Carbine and the Breacher Plate are crafted, described in
    // exactly those words, and were required by nothing.
    const kit = breachPierce(state);
    if (kit.mean < Q.breachPierce) {
      return {
        ok: false,
        stage,
        reason:
          `Nothing here will open that door. The party averages ${kit.mean.toFixed(1)} pierce ` +
          `and forcing a silo takes ${Q.breachPierce} — a Breaching Carbine is 3, and so is ` +
          'anything heavier off the surface.',
      };
    }
  }
  return { ok: true, stage };
}

/**
 * What the standing squads could bring to a door, as mean pierce.
 *
 * Exported because the World panel has to be able to say *why* a breach is
 * refused before the player has walked anybody anywhere, and because the
 * standing order that points at the Armory reads the same number. One
 * definition, three readers.
 *
 * Squads at home, since those are the ones who would go. An unarmed body
 * counts as 0 rather than being skipped: eight people with two carbines
 * between them are not a breaching party, and averaging only over the armed
 * would say they were.
 */
export function breachPierce(state) {
  const ids = readySquads(state);
  let total = 0;
  let heads = 0;
  let best = 0;
  for (const sid of ids) {
    for (const c of squadMembers(state, sid)) {
      heads++;
      const gid = c.gear?.weapon;
      const item = gid ? getItem(state.military.gear[gid]?.item) : null;
      const pierce = item?.stats?.pierce || 0;
      total += pierce;
      best = Math.max(best, pierce);
    }
  }
  return { mean: heads ? total / heads : 0, best, heads };
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
 * `human: true` on purpose, but not for the reason this comment used to give.
 * It claimed the flag bought the `raiderFleeLossFraction` cap, "the difference
 * between a hard fight and a squad wipe". It buys no such thing:
 * combat.js:200 applies that cap only when `outcome.win` is true, and the
 * worst winning band already caps casualties at 0.35 against a fraction of
 * 0.4, so `Math.min` never binds at any squad size. A wipe happens on defeat
 * or rout, where the clause is skipped entirely.
 *
 * What the flag actually does is keep `rollEnemyForce` from rolling mutation
 * levels and modifiers onto them (combat.js:96) — which `garrisonForce`
 * bypasses anyway by building the enemy object here — and make
 * expedition.js:393 record the dead as `raidersKilled` rather than
 * `mutantsKilled`. That last one is the honest reason to keep it: these are
 * people, and the tally should say so.
 */
export function garrisonForce(silo, scale = 1, defenseMult = 1, partyForce = 0) {
  const military = silo?.power?.military ?? 40;
  // They answer what is at the door. See `garrisonResponse` in balance.js for
  // the measurement — without this the target's military rating stops
  // deciding anything past about 430 of party force, which a squad of trained
  // veterans passes comfortably.
  const response = partyForce > 0
    ? Math.pow(Math.max(1, partyForce / Q.garrisonReferenceForce), Q.garrisonResponse)
    : 1;
  const power = Math.max(1, military * Q.garrisonPowerPerMilitary * defenseMult * scale * response);
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

/** What the party is worth in a fight, for the garrison to answer. */
function partyForce(state, roster) {
  return roster.reduce((a, id) => {
    const c = state.citizens[id];
    return a + (c ? unitPower(state, c) : 0);
  }, 0);
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
/**
 * Exported for the same reason `accumulate` is: what a sack pays is a balance
 * claim, and a balance claim that can only be reached through a whole resolved
 * conquest run cannot be measured across three hundred seeds without also
 * dragging in combat, casualties and the world table. Nothing outside this
 * module calls it in play.
 */
export function sack(silo, rng, share) {
  const S = Q.sack;
  const economy = silo?.power?.economy ?? 40;
  const science = silo?.power?.science ?? 30;
  const military = silo?.power?.military ?? 40;
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

  // And what was on their armoury racks, keyed on `power.military` — the
  // column that until now decided only how hard the fight was and paid nothing
  // for having been hard. The Anvil at 95 is roughly five times the yield of
  // Selby at 20. Neither piece can be built here; beating somebody who had one
  // is the only way to hold one.
  const gear = [];
  for (const gid of S.gearTable) {
    if (!rng.chance(military * S.gearChancePerMilitary * share)) continue;
    const got = lootGear(gid);
    if (!got) continue;
    gear.push(got.action);
    taken.push(`a ${got.item.name} off their racks`);
  }
  // And, off a silo that could really fight, something nobody here can build.
  if (military >= S.sackEliteMinimum) {
    for (const gid of S.sackEliteTable) {
      if (!rng.chance(military * S.sackEliteChancePerMilitary * share)) continue;
      const got = lootGear(gid);
      if (!got) continue;
      gear.push(got.action);
      taken.push(`a ${got.item.name}, which nobody in Silo 12 could have made`);
    }
  }
  return { loot, artifacts, taken, gear };
}

/**
 * Fold one floor's wounds into the running total.
 *
 * `applyResolution` hands back absolute values computed from the citizen as
 * it currently stands, so the *first* patch for anyone is the real reading
 * and every later one is that same starting point minus only its own floor's
 * damage. Taking the difference recovers each floor's actual wound, which is
 * what accumulates.
 *
 * Exported for test/wiring.mjs §11. The end-to-end assertion there can only
 * see the total, and a total cannot distinguish "five floors accumulated"
 * from "one bad floor" — combat.js:217 lets a single fight take
 * 34 x 1.2 x 1.5 = 61 points, which overlaps what several floors produce. So
 * the arithmetic is pinned there, exactly, on known wounds.
 */
export function accumulate(hurt, patches, state) {
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
 * Same arithmetic as expedition.js, deliberately: this is the same six days
 * on the same ground in the same suits.
 */
function outsideWear(state, expedition, roster) {
  const band = BAL.expedition.bands.find((b) => b.key === expedition.band) || { travelDays: 6 };
  const start = averageSuitIntegrity(state, roster);
  const hours = band.travelDays * BAL.expedition.hoursPerDay;
  // `wear`, not `shielding`. One constant used to do both jobs, which is why
  // a suit could never be better at surviving the walk than at stopping the
  // dose — and the dose is already clamped on every band that matters.
  const wear = averageSuitStat(state, roster, 'wear');
  return Math.max(0, start - wear * hours * BAL.gear.suit.wearHoursFraction);
}

function outsideDose(expedition, state, roster) {
  const band = BAL.expedition.bands.find((b) => b.key === expedition.band) || { travelDays: 6, radPerHour: 7 };
  const hours = band.travelDays * BAL.expedition.hoursPerDay;
  if (!state) return Math.round(band.radPerHour * hours * 0.55);
  return Math.round(band.radPerHour * averageSuitStat(state, roster, 'shielding') * hours);
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
  // `purpose` is frozen at launch and the whole run is six days, so by
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
  // own and a run is six days round trip. Unchecked, an in-flight assault
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
    const enemy = garrisonForce(silo, Q.breachGarrisonScale, c.defenseMult ?? 1, partyForce(state, roster));
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
      actions.push(...got.gear);
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
    // cumulative value. The same shape existed on the salvage path and has
    // since been fixed the same way — see the `hurt` map in expedition.js,
    // where two fights in one run were also overwriting each other.
    //
    // WHAT THIS STILL DOES NOT DO, on purpose, with the measurement.
    //
    // The recording is right; the feedback loop is not. `resolveCombat` and
    // `partyForce` read `state.citizens[id].health`, and nothing has written
    // these wounds there yet — so floor five is fought by a squad the game
    // scores at 100 that in fact finished floor four on 11. Ammunition decays
    // between floors and health does not, which is half of "one load-out".
    //
    // It was implemented — `unitPower` takes a health override, `resolve`
    // takes a `healthOf` — and then backed out, because it costs more than it
    // buys at the current numbers. With wounds carrying, the reference player
    // stopped being able to take a silo at all on one of the two campaign
    // seeds. Compensating on `holdGarrisonScale` does not cleanly recover it;
    // silos taken per campaign, two seeds each:
    //
    //   0.45 (today)   3, 3        with wounds carrying:  0, 3
    //   0.40                                              2, 1
    //   0.36                                              1, 1
    //   0.32                                              2, 2
    //   0.28                                              1, 2
    //   0.24                                              2, 3
    //
    // Halving the garrison does not restore throughput and would leave the
    // hold softer per floor than the breach, which is backwards. And it fights
    // the Dominion change made in the same pass: that was set to 3 concurrent
    // holdings on the measurement that the reference player peaks at 2, and a
    // campaign that takes 1-2 silos total puts it back out of reach.
    //
    // So it needs its own pass — probably `holdCombats` and the garrison scale
    // together, re-measured against Dominion — rather than being smuggled in
    // beside four other balance changes. The override plumbing was removed
    // rather than left dead, because unused plumbing implies a feature that is
    // not there.
    const hurt = new Map();
    let victories = 0;

    for (let i = 0; i < Q.holdCombats; i++) {
      if (!standing.length) break;
      const enemy = garrisonForce(silo, Q.holdGarrisonScale, c.defenseMult ?? 1, partyForce(state, standing));
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
      actions.push(...got.gear);
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
    // sends a squad home from six days outside with nothing to
    // decontaminate.
    loot,
    artifacts,
    suitIntegrity: outsideWear(state, expedition, roster),
    radiation: outsideDose(expedition, state, roster),
  });

  return { actions, journal, survivors, casualties, loot, artifacts };
}

export default { resolveRun, isConquestRun, nextStage, canLaunchRun, garrisonForce };
