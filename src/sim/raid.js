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
import { rollEnemyForce, resolve as resolveCombat, applyResolution } from './combat.js';
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
      amount: res.outcome.win ? -8 : -20,
    });
  }

  actions.push({ type: 'RAID_RESOLVED' });
  return actions;
}

export default { simulateDay, defenders, raiderBandFor };
