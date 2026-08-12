/**
 * raid.js — somebody comes to you.
 *
 * Every other fight in this game is opt-in. The player decides to open the
 * airlock, picks the band, picks the squad, and reads a risk forecast first.
 * This is the one that arrives whether or not anybody is ready, which is what
 * makes keeping a squad *home* a decision rather than an oversight.
 *
 * The half that already existed: `diplomacy.js` queues a `raid` event when a
 * hostile silo either holds a grudge or simply likes the look of you — the
 * opportunity clause is the one a peaceful player actually meets — `world.js`
 * applies it when it matures, `data/events.js` fires a scripted one five
 * hours in, and `PENDING_RAID` writes `world.pendingRaid`. Nothing
 * read it. The alert went up, the coaching line in shell.js said "Squads
 * defend the silo; without one, the raid takes what it wants", and then the
 * raid stood at the door for the rest of the campaign.
 *
 * This is the resolver. It runs from the day loop, one day after the alert,
 * and it always ends with `RAID_RESOLVED` — a pending raid that cannot be
 * resolved is the bug this module exists to fix, so there is no path through
 * `simulateDay` that leaves one standing.
 *
 * Pure: (state) -> actions. No dispatch, no DOM.
 */

import { BAL } from '../config/balance.js';
import { streamFor } from '../core/rng.js';
import { RAIDERS } from '../data/encounters.js';
import { rollEnemyForce, resolve as resolveCombat, applyResolution, unitPower } from './combat.js';
import { fullName } from './population.js';

const R = BAL.raid;

/**
 * Which of the four human bands turns up, from the attacker's strength.
 *
 * `strength` is the raiding silo's `power.military / 100`, so it is a rating
 * of them rather than a roll: The Anvil at military 95 sends a warband every
 * time, and a scavenger silo sends scrappers every time. Deliberately not
 * randomised — the world table tells the player who is dangerous, and a raid
 * that contradicted it would make that table a decoration.
 */
export function raiderBandFor(strength) {
  const s = Number.isFinite(strength) ? strength : 0.25;
  let i = 0;
  while (i < R.bandByStrength.length && s > R.bandByStrength[i]) i++;
  return RAIDERS[Math.min(i, RAIDERS.length - 1)];
}

/**
 * What standing here is likely to cost, before it is paid.
 *
 * Every other fight in this game shows a forecast first — this module's own
 * header says so, and `riskPreview` is what the airlock draws for a salvage
 * run. The raid directive showed a head count instead: "4 people are standing
 * to meet them", which reads as sufficiency. Measured against a Warband, four
 * defenders won 3 of 40 while losing 2.0 of the 4, and the balance table
 * already recorded that. Telling the player the count and not the odds pointed
 * them at the losing play.
 *
 * Deterministic on purpose: it consumes no rng, because a preview that drew
 * from the raid's own stream would change the raid. It uses the resolver's
 * terms — `unitPower` per defender, the same morale, size and terrain
 * modifiers, the enemy's power at the midpoint of its count range — and drops
 * only the two gaussian rolls, plus the ammunition and leader terms, which is
 * what makes it an estimate rather than a promise.
 *
 * Checked against the resolver rather than assumed. Forty real raids per cell,
 * ratio from this function, win rate from `simulateDay`:
 *
 *                  4 unarmed   4 armed    8 armed    8 tier-4
 *   Scrappers      2.33  93%   2.57 100%  8.78 100%  10.89 100%
 *   Dust Runners   0.60  43%   1.74  78%  2.16 100%   7.64 100%
 *   Slag Crews     0.22   0%   0.25  20%  1.40  85%   3.51 100%
 *   Warband        0.12   0%   0.31   0%  0.70  13%   0.91  60%
 *
 * Monotone in the right direction everywhere, and the thresholds below are
 * read off it: above 2.0 is a formality, 1.4 holds, under 0.6 is a funeral.
 * The one soft cell is four unarmed against Dust Runners — 0.60 predicted, 43%
 * measured — where the estimate is harsher than the outcome because it drops
 * the ammunition term. Erring toward "do not stand here" is the right side to
 * be wrong on for a warning.
 */
export function forecast(state, strength) {
  const C = BAL.combat;
  const ours = defenders(state);
  const band = raiderBandFor(strength);
  const theirs = band.power * ((band.count[0] + band.count[1]) / 2) * R.sizeScale;
  if (!ours.length) return { ratio: 0, band, defenders: 0, verdict: null };

  const members = ours.map((id) => state.citizens[id]).filter(Boolean);
  const squadPower = members.reduce((a, c) => a + unitPower(state, c), 0);
  const avgMorale = members.reduce((a, c) => a + c.morale, 0) / members.length;
  const moraleMod = C.moraleModBase + (avgMorale / 100) * C.moraleModRange;
  const sizeMod = 1 + Math.log2(Math.max(1, members.length)) * C.sizeModPerLog2;
  const terrainMod = 1 + R.homeTerrain * C.terrainSwing;

  const ratio = (squadPower * moraleMod * sizeMod * terrainMod) / Math.max(0.001, theirs);
  return { ratio, band, defenders: members.length, verdict: raidVerdict(ratio) };
}

/**
 * The same vocabulary `verdictFor` uses at the airlock, against the outcome
 * thresholds this fight will actually be scored on rather than against numbers
 * picked to sound right.
 */
function raidVerdict(ratio) {
  const win = BAL.combat.outcomes.find((o) => o.win && o.min <= ratio);
  if (ratio >= 2.0) return 'They will not get through this.';
  if (ratio >= 1.4) return 'The door should hold.';
  if (win) return 'It should hold, and it will cost people.';
  if (ratio >= 0.9) return 'Too close. Expect to lose some of them and some of the stores.';
  if (ratio >= 0.6) return 'This is a defeat. More bodies or better weapons, or let them have it.';
  return 'Standing here kills the squad and loses the stores anyway.';
}

/**
 * Everyone who is actually in the silo to fight.
 *
 * A squad that is outside is outside: an expedition's roster is frozen at
 * launch and its members are `status: 'expedition'`, and no amount of trouble
 * at home brings them back early. That is the cost this whole module puts a
 * price on — sending everybody out is a choice about the silo's own door.
 */
export function defenders(state) {
  const out = [];
  for (const id of state.military.squadIds) {
    const sq = state.military.squads[id];
    if (!sq || sq.deployed) continue;
    for (const cid of sq.members || []) {
      const c = state.citizens[cid];
      if (c && c.status !== 'dead' && c.status !== 'expedition') out.push(cid);
    }
  }
  return out;
}

/** What a raid carries off: a share of the portable stores, rounded down. */
function theft(state, fraction) {
  const deltas = {};
  const taken = [];
  for (const k of R.theftKeys) {
    const have = state.resources[k] || 0;
    const amount = Math.floor(have * fraction);
    if (amount > 0) {
      deltas[k] = -amount;
      taken.push(`${amount} ${k}`);
    }
  }
  return { deltas, taken };
}

/** "12 scrap, 4 parts and 30 food", or null if they found nothing worth taking. */
function theftText(taken) {
  if (!taken.length) return null;
  if (taken.length === 1) return taken[0];
  return `${taken.slice(0, -1).join(', ')} and ${taken[taken.length - 1]}`;
}

/**
 * Who dies when there is nobody to stop it.
 *
 * Not a squad and not a choice: whoever was nearest the door. Drawn from
 * living citizens who are in the silo, weighted by nothing at all, because
 * that is the point of the scene — an undefended raid is not a fight the
 * player lost, it is a fight the player did not have.
 */
function civilianLosses(state, rng, siloName) {
  const actions = [];
  if (!rng.chance(R.undefendedDeathChance)) return actions;

  const present = state.citizenIds.filter((id) => {
    const c = state.citizens[id];
    return c && c.status !== 'dead' && c.status !== 'expedition';
  });
  if (!present.length) return actions;

  const count = Math.min(rng.int(1, R.undefendedDeathsMax), present.length);
  const pool = present.slice();
  for (let i = 0; i < count; i++) {
    const idx = rng.int(0, pool.length - 1);
    const id = pool.splice(idx, 1)[0];
    const c = state.citizens[id];
    if (!c) continue;
    actions.push({
      type: 'CITIZEN_DIE',
      id,
      cause: 'a raid',
      text: `${fullName(c)}, ${Math.floor(c.age)}, was killed when ${siloName} came through the airlock.`,
    });
  }
  return actions;
}

/**
 * Resolve any raid that has come due.
 *
 * Returns actions, always including `RAID_RESOLVED` when it acted, so the
 * pending raid cannot survive its own resolution. Called from the day loop
 * after `world.simulateDay`, so a raid queued today gets its grace day before
 * this looks at it.
 */
export function simulateDay(state) {
  const pending = state.world.pendingRaid;
  if (!pending) return [];
  if (state.clock.day < pending.day + R.graceDays) return [];

  const actions = [];
  const attacker = state.world.silos[pending.siloId];
  const siloName = attacker?.name || 'Somebody';
  const rng = streamFor(state.meta.seed, 'raid', pending.siloId, pending.day);

  const def = raiderBandFor(pending.strength);
  const enemy = rollEnemyForce(rng, def, { sizeScale: R.sizeScale });
  const ours = defenders(state);

  if (!ours.length) {
    // Nobody home. This is the branch the coaching line promised and the game
    // never had.
    const { deltas, taken } = theft(state, R.undefendedTheft);
    const what = theftText(taken);
    if (Object.keys(deltas).length) actions.push({ type: 'RESOURCE_DELTA', deltas });
    actions.push(...civilianLosses(state, rng, siloName));
    actions.push({
      type: 'ORDER_DELTA',
      amount: R.orderOnSacked,
      reason: 'a raid nobody met',
    });
    actions.push({
      type: 'LOG',
      entry: {
        kind: 'alert',
        text:
          `${enemy.count} of ${siloName}'s people came through the airlock and nobody was standing there. ` +
          (what ? `They took ${what}.` : 'They found nothing worth carrying.'),
      },
    });
    actions.push({ type: 'STAT_BUMP', stats: { raidsLost: 1 } });
    actions.push({ type: 'RAID_RESOLVED' });
    return actions;
  }

  // A fight, on ground the defenders know.
  const res = resolveCombat(state, ours, enemy, {
    battleId: `raid:${pending.siloId}:${pending.day}`,
    terrain: R.homeTerrain,
  });

  actions.push(
    ...applyResolution(state, res, { context: 'raid', kiaKind: 'killed defending the airlock' })
  );

  const fraction = res.outcome.win ? R.theftOnWin : R.defendedTheftOnLoss;
  const { deltas, taken } = theft(state, fraction);
  const what = theftText(taken);
  if (Object.keys(deltas).length) actions.push({ type: 'RESOURCE_DELTA', deltas });

  if (res.outcome.win) {
    actions.push({ type: 'ORDER_DELTA', amount: R.orderOnRepelled, reason: 'a raid turned back' });
    actions.push({ type: 'STAT_BUMP', stats: { raidsRepelled: 1 } });
  } else {
    actions.push({ type: 'STAT_BUMP', stats: { raidsLost: 1 } });
  }

  // The round-by-round goes into the log as its own lines. `pushLog` keeps
  // `text` and `data` and drops anything else, and a raid has no return
  // report to carry a journal the way an expedition does — so the fight is
  // only readable if it is written here.
  actions.push({
    type: 'LOG_MANY',
    entries: [
      {
        kind: 'alert',
        text:
          `${enemy.count} of ${siloName}'s people at the airlock, met by ${ours.length}. ` +
          `${res.outcome.name}.` +
          // A repelled raid still costs stores, but they burned in the
          // corridor — nobody carried them anywhere. "They got away with 27
          // scrap" under the words "Decisive victory" reads as a bug.
          (what ? (res.outcome.win ? ` ${what} went up in the fighting.` : ` They got away with ${what}.`) : ''),
      },
      ...res.log.filter(Boolean).map((line) => ({ kind: 'combat', text: line })),
    ],
  });

  // Whoever sent them now knows what it costs.
  if (attacker) {
    actions.push({
      type: 'SILO_REPUTATION',
      siloId: pending.siloId,
      // Turning them back is the one moment a warlord silo reconsiders.
      //
      // This was -8 for a repulse, which made reputation a one-way ratchet
      // into the higher-rate grudge path: `diplomacy.js` fires raids at
      // `raidChanceGrudge` once reputation passes `raidGrudgeReputation`, and
      // that clause bypasses the opportunity conjunction entirely, so arming
      // up stops helping. Measured, four *repelled* raids walked The Anvil
      // from -15 to -47 and every one of them made the next one likelier.
      // Nothing else in the game raises a silo's reputation except player
      // diplomacy, and a silo raiding you is usually `contact: 'none'`.
      //
      // There was no play — not even a perfect one — that walked a grudge
      // back. Now there is exactly one: beat them at the door.
      amount: res.outcome.win ? R.reputationOnRepelled : R.reputationOnSacked,
    });
  }

  actions.push({ type: 'RAID_RESOLVED' });
  return actions;
}

export default { simulateDay, defenders, raiderBandFor };
