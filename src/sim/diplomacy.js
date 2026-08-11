/**
 * diplomacy.js — reputation, offers, treaties, and memory.
 *
 * The rule that gives the diplomatic layer teeth (spec §12.2): silos
 * remember. Every broken deal, every raid, every gift goes into `memory[]`
 * and decays about a point per ten days but never to zero. Break a treaty
 * with Ninefold and it is in the log forever, and their accept score carries
 * it for the rest of the campaign.
 */

import { BAL } from '../config/balance.js';
import { streamFor } from '../core/rng.js';
import { siloDef, ARCHETYPES, PLAYER_SILO_ID } from '../data/silos.js';
import { playerPower, specialtyResource, inRange } from './world.js';

const D = BAL.diplomacy;

// ------------------------------------------------------------------ value ---

/** Rough market value of a resource bundle, in chits. */
const VALUE = {
  food: 1.0, water: 0.7, scrap: 0.8, parts: 3.0, alloy: 5.0, meds: 4.0,
  ammo: 2.0, fuel: 2.2, filters: 2.4, ore: 1.6, coolant: 3.0, chits: 1.0,
};

export function bundleValue(bundle) {
  let total = 0;
  for (const [k, v] of Object.entries(bundle || {})) total += (VALUE[k] ?? 1) * v;
  return total;
}

/**
 * How badly this silo wants what you're offering. Returned as a divisor, so
 * lower means keener: a bundle made entirely of things on their needs list is
 * worth `needDiscount` more than the same value in something they already
 * have plenty of.
 */
export function needWeight(silo, bundle) {
  const entries = Object.entries(bundle || {});
  if (!entries.length) return 1;
  let total = 0;
  let wanted = 0;
  for (const [k, v] of entries) {
    const value = (VALUE[k] ?? 1) * v;
    total += value;
    if ((silo.needs || []).includes(k)) wanted += value;
  }
  const share = total > 0 ? wanted / total : 0;
  return 1 - share * BAL.diplomacy.needDiscount;
}

// ----------------------------------------------------------------- memory ---

export function remember(silo, entry) {
  return {
    type: 'SILO_MEMORY',
    siloId: silo.id,
    entry: { ...entry, weight: entry.weight ?? 0 },
  };
}

/** Net memory score: positive is goodwill, negative is grudge. */
export function memoryScore(silo) {
  let score = 0;
  for (const m of silo.memory || []) score += m.weight;
  return score;
}

export function dealsHonored(silo) {
  return (silo.memory || []).filter((m) => m.kind === 'honored').length;
}

export function dealsBroken(silo) {
  return (silo.memory || []).filter((m) => m.kind === 'broken').length;
}

// ------------------------------------------------------------ evaluation ---

/**
 * The accept score from spec §12.2, with every weight a balance number.
 * Returns the score plus the terms, so the UI can show the player *why*
 * an offer is being refused rather than just that it was.
 */
export function evaluate(state, silo, offer) {
  const mine = playerPower(state);
  const theirs = silo.power;

  const offerValue = bundleValue(offer.give);
  const askValue = bundleValue(offer.want);
  const net = offerValue - askValue;
  const weight = needWeight(silo, offer.give);

  const terms = {};
  // Generosity relative to the ask, not absolute value: offering 120 food for
  // 30 parts should read as a good deal whatever the numbers are. Divided by
  // how much they actually want what you're offering.
  terms.offer = ((net / Math.max(D.offerFloor, askValue + D.offerFloor)) * D.offerWeight) / weight;
  terms.reputation = silo.reputation * D.reputationWeight;
  terms.fear =
    theirs.military < mine.military
      ? D.fearBonus * (1 - theirs.military / Math.max(1, mine.military))
      : -D.aggressionPenaltyWeight * silo.disposition.aggression;
  terms.honesty = silo.disposition.honesty * dealsHonored(silo) * D.honestyWeight;
  terms.memory = memoryScore(silo);

  // Paranoid silos hate watching you arm up.
  const growth = Math.max(0, mine.military - (state.world.lastPlayerMilitary ?? mine.military));
  terms.paranoia = -silo.disposition.paranoia * (growth / 100) * D.paranoiaWeight;

  // Some asks are just harder than others.
  terms.action = actionModifier(offer.action, silo, mine, theirs);

  const score = Object.values(terms).reduce((a, b) => a + b, 0);
  const threshold = D.thresholds[silo.archetype] ?? 50;

  return { score, threshold, terms, accepted: score > threshold };
}

function actionModifier(action, silo, mine, theirs) {
  switch (action) {
    case 'hail': return 60; // almost always answered
    case 'gift': return 45;
    case 'share_intel': return 30;
    case 'trade': return 10;
    case 'trade_agreement': return -5;
    case 'nap': return 0;
    case 'defense_pact': return -18 - silo.disposition.paranoia * 20;
    case 'alliance': return -30 - silo.disposition.paranoia * 25;
    case 'tribute':
      // They pay tribute only if they are frightened of you.
      return theirs.military < mine.military * 0.5 ? 20 : -70;
    case 'threaten':
      return theirs.military < mine.military * 0.7 ? 10 : -60;
    case 'peace': return 15 - silo.disposition.aggression * 30;
    default: return 0;
  }
}

// -------------------------------------------------------------- actions ---

export const ACTIONS = [
  { id: 'hail', label: 'Hail', desc: 'Open a channel. Costs nothing but the transmission.', needs: 'none' },
  { id: 'gift', label: 'Send a gift', desc: 'Give something and ask for nothing. Buys reputation.', needs: 'radio', give: true },
  { id: 'trade', label: 'Propose a trade', desc: 'A one-off exchange.', needs: 'radio', give: true, want: true },
  { id: 'share_intel', label: 'Share intel', desc: 'Hand over what your expeditions found.', needs: 'radio' },
  { id: 'trade_agreement', label: 'Trade agreement', desc: 'A recurring exchange, every few days.', needs: 'trade', give: true, want: true },
  { id: 'nap', label: 'Non-aggression pact', desc: 'Neither silo raids the other.', needs: 'radio' },
  { id: 'defense_pact', label: 'Defence pact', desc: 'If either is attacked, the other comes. Both ways.', needs: 'trade' },
  { id: 'alliance', label: 'Full alliance', desc: 'Everything, including being called in.', needs: 'trade' },
  { id: 'tribute', label: 'Demand tribute', desc: 'Only works if they are afraid of you.', needs: 'radio', hostile: true },
  { id: 'threaten', label: 'Threaten', desc: 'Lower their disposition, raise their fear.', needs: 'radio', hostile: true },
  { id: 'war', label: 'Declare war', desc: 'Ends every treaty and every trade route.', needs: 'radio', hostile: true },
  { id: 'peace', label: 'Sue for peace', desc: 'Ask them to stop.', needs: 'war' },
];

export function availableActions(state, silo) {
  const atWar = hasTreaty(silo, 'war');
  return ACTIONS.filter((a) => {
    if (a.needs === 'war') return atWar;
    if (atWar && a.id !== 'peace' && a.id !== 'threaten') return false;
    if (a.needs === 'trade') return silo.contact === 'trade' || silo.contact === 'allied';
    if (a.needs === 'radio') return silo.contact !== 'none';
    return true;
  });
}

export function hasTreaty(silo, kind, withId) {
  return (silo.treaties || []).some((t) => t.kind === kind && (withId === undefined || t.with === withId));
}

/** Perform a diplomatic action. Returns actions. */
export function perform(state, siloId, action, offer = {}) {
  const silo = state.world.silos[siloId];
  if (!silo) return [];
  const day = state.clock.day;
  const out = [];

  const full = { action, give: offer.give || {}, want: offer.want || {} };

  // Hostile actions don't get evaluated — you're telling them, not asking.
  if (action === 'war') {
    out.push({ type: 'SILO_TREATY', siloId, treaty: { kind: 'war', with: PLAYER_SILO_ID, since: day }, add: true });
    out.push({ type: 'SILO_PATCH', siloId, patch: { contact: 'war' } });
    out.push({ type: 'SILO_REPUTATION', siloId, amount: -50 });
    out.push(remember(silo, { day, kind: 'war_declared', weight: -30, text: 'Silo 12 declared war.' }));
    out.push({
      type: 'LOG',
      entry: { kind: 'diplomacy', text: `War declared on ${silo.name}. Every treaty with them is void.` },
    });
    // Everyone else notices.
    out.push({ type: 'BROADCAST_REPUTATION', amount: -6, except: [siloId], reason: 'declaring war' });
    return out;
  }

  const verdict = evaluate(state, silo, full);
  const rng = streamFor(state.meta.seed, 'diplomacy', siloId, day);

  if (!verdict.accepted) {
    out.push({
      type: 'LOG',
      entry: { kind: 'diplomacy', text: `${silo.name} declined. ${refusalText(silo, action, verdict)}` },
    });
    if (action === 'threaten' || action === 'tribute') {
      out.push({ type: 'SILO_REPUTATION', siloId, amount: -8 });
      out.push(remember(silo, { day, kind: 'threatened', weight: -8, text: 'Silo 12 tried to lean on us.' }));
    }
    out.push({ type: 'SILO_PATCH', siloId, patch: { lastOffer: { day, action, accepted: false } } });
    return out;
  }

  // ---- accepted -----------------------------------------------------------
  switch (action) {
    case 'hail':
      out.push({ type: 'SILO_PATCH', siloId, patch: { contact: 'radio', known: true } });
      out.push({
        type: 'LOG',
        entry: { kind: 'diplomacy', text: `${silo.name} answered. ${greeting(silo)}` },
      });
      if (!state.flags.firstContact) {
        out.push({ type: 'FLAG_SET', flags: { firstContact: true } });
      }
      break;

    case 'gift': {
      const deltas = {};
      for (const [k, v] of Object.entries(full.give)) deltas[k] = -v;
      const value = bundleValue(full.give);
      out.push({ type: 'RESOURCE_DELTA', deltas });
      out.push({ type: 'SILO_REPUTATION', siloId, amount: value * D.giftRepPerValue });
      out.push(remember(silo, { day, kind: 'gift', weight: value * 0.02, text: 'Silo 12 sent us something for nothing.' }));
      out.push({ type: 'LOG', entry: { kind: 'diplomacy', text: `${silo.name} accepted the gift.` } });
      break;
    }

    case 'trade': {
      const deltas = {};
      for (const [k, v] of Object.entries(full.give)) deltas[k] = (deltas[k] || 0) - v;
      for (const [k, v] of Object.entries(full.want)) deltas[k] = (deltas[k] || 0) + v;
      out.push({ type: 'RESOURCE_DELTA', deltas });
      out.push({ type: 'SILO_REPUTATION', siloId, amount: D.tradeRepPerDeal });
      out.push({ type: 'SILO_PATCH', siloId, patch: { contact: silo.contact === 'radio' ? 'trade' : silo.contact } });
      out.push(remember(silo, { day, kind: 'honored', weight: 2, text: 'We traded with Silo 12 and it went fine.' }));
      out.push({ type: 'STAT_BUMP', stats: { tradesCompleted: 1 } });
      out.push({ type: 'ORDER_DELTA', amount: BAL.order.tradeBonus, reason: 'a successful trade' });
      out.push({ type: 'LOG', entry: { kind: 'diplomacy', text: `Trade with ${silo.name} completed.` } });
      break;
    }

    case 'share_intel':
      out.push({ type: 'SILO_REPUTATION', siloId, amount: 6 });
      out.push(remember(silo, { day, kind: 'gift', weight: 3, text: 'Silo 12 shared survey data.' }));
      out.push({ type: 'LOG', entry: { kind: 'diplomacy', text: `${silo.name} took the survey data and thanked you for it.` } });
      break;

    case 'trade_agreement':
      out.push({
        type: 'SILO_TREATY',
        siloId,
        add: true,
        treaty: { kind: 'trade_agreement', with: PLAYER_SILO_ID, since: day, give: full.give, want: full.want, everyDays: 4 },
      });
      out.push({ type: 'SILO_PATCH', siloId, patch: { contact: 'trade' } });
      out.push({ type: 'LOG', entry: { kind: 'diplomacy', text: `${silo.name} signed a standing trade agreement.` } });
      break;

    case 'nap':
    case 'defense_pact':
    case 'alliance': {
      const kind = action === 'nap' ? 'nap' : action === 'defense_pact' ? 'defense' : 'alliance';
      out.push({ type: 'SILO_TREATY', siloId, add: true, treaty: { kind, with: PLAYER_SILO_ID, since: day } });
      out.push({ type: 'SILO_PATCH', siloId, patch: { contact: kind === 'alliance' ? 'allied' : 'trade' } });
      out.push({ type: 'SILO_REPUTATION', siloId, amount: 10 });
      out.push({
        type: 'LOG',
        entry: {
          kind: 'diplomacy',
          text:
            kind === 'alliance'
              ? `${silo.name} has allied with Silo 12. They will call on you, and refusing will cost you everything.`
              : `${silo.name} signed a ${kind === 'nap' ? 'non-aggression pact' : 'defence pact'}.`,
        },
      });
      break;
    }

    case 'tribute': {
      const take = tributeBundle(silo, rng);
      out.push({ type: 'RESOURCE_DELTA', deltas: take });
      out.push({ type: 'SILO_REPUTATION', siloId, amount: -18 });
      out.push(remember(silo, { day, kind: 'extorted', weight: -20, text: 'Silo 12 took tribute from us.' }));
      out.push({
        type: 'LOG',
        entry: {
          kind: 'diplomacy',
          text: `${silo.name} paid. ${Object.entries(take).map(([k, v]) => `${Math.round(v)} ${k}`).join(', ')}. They will not forget it.`,
        },
      });
      break;
    }

    case 'threaten':
      out.push({ type: 'SILO_REPUTATION', siloId, amount: -12 });
      out.push({ type: 'SILO_PATCH', siloId, patch: { disposition: { ...silo.disposition, paranoia: Math.min(1, silo.disposition.paranoia + 0.1) } } });
      out.push(remember(silo, { day, kind: 'threatened', weight: -12, text: 'Silo 12 threatened us and meant it.' }));
      out.push({ type: 'LOG', entry: { kind: 'diplomacy', text: `${silo.name} backed down. They will remember who made them.` } });
      break;

    case 'peace':
      out.push({ type: 'SILO_TREATY', siloId, remove: 'war' });
      out.push({ type: 'SILO_PATCH', siloId, patch: { contact: 'radio' } });
      out.push({ type: 'LOG', entry: { kind: 'diplomacy', text: `${silo.name} has agreed to stop. For now.` } });
      break;
  }

  out.push({ type: 'SILO_PATCH', siloId, patch: { lastOffer: { day, action, accepted: true } } });
  return out;
}

function tributeBundle(silo, rng) {
  const def = siloDef(silo.id);
  const key = specialtyResource(def?.specialty) || 'chits';
  return { [key]: rng.int(30, 90), chits: rng.int(20, 60) };
}

function greeting(silo) {
  const arch = ARCHETYPES[silo.archetype]?.name || '';
  switch (silo.archetype) {
    case 'merchant': return 'They want to know what you have before they want to know who you are.';
    case 'warlord': return 'They took the call. That is not the same as being pleased about it.';
    case 'agrarian': return 'They sound relieved to hear another voice.';
    case 'archivist': return 'A single voice, unhurried, asking whether you have read the Compact.';
    case 'theocratic': return 'They opened with a blessing and then asked what you wanted.';
    case 'democratic': return 'Nine people took turns speaking. It took a while.';
    case 'slaver': return 'They asked, immediately, how many people you have.';
    case 'scientific': return 'They wanted your atmospheric readings before your name.';
    default: return `${arch}. Cautious, but talking.`;
  }
}

function refusalText(silo, action, verdict) {
  const worst = Object.entries(verdict.terms).sort((a, b) => a[1] - b[1])[0];
  switch (worst?.[0]) {
    case 'reputation': return 'They do not think much of Silo 12.';
    case 'memory': return 'They brought up something you did.';
    case 'paranoia': return 'They have noticed how fast you are arming.';
    case 'fear': return 'They are not frightened of you, and it shows.';
    case 'offer': return 'The offer was not worth what you asked for.';
    default: return 'No reason given.';
  }
}

// -------------------------------------------------------------- daily AI ---

/**
 * Runs every three game days per contacted silo (spec §12.2): memory decays,
 * standing agreements pay out, and allies call for help.
 */
export function simulateTick(state) {
  const actions = [];
  const day = state.clock.day;
  if (day - (state.world.lastDiploDay || 0) < D.evaluateEveryDays) return actions;
  actions.push({ type: 'DIPLO_TICK', day, emit: false });

  const rng = streamFor(state.meta.seed, 'diplomacy-tick', day);

  for (const silo of Object.values(state.world.silos)) {
    if (silo.contact === 'none') continue;

    // Standing trade agreements pay out. Deadline-based rather than modulo:
    // the diplomacy tick runs every three days and the agreement runs every
    // four, so an exact-match test silently skips most payments.
    for (const t of silo.treaties || []) {
      if (t.kind !== 'trade_agreement') continue;
      const due = t.nextDay ?? t.since + (t.everyDays || 4);
      if (day < due) continue;
      const deltas = {};
      let affordable = true;
      for (const [k, v] of Object.entries(t.give || {})) {
        if ((state.resources[k] || 0) < v) affordable = false;
        deltas[k] = -(v);
      }
      if (!affordable) {
        // Failing to hold up your end is remembered.
        actions.push({ type: 'SILO_TREATY', siloId: silo.id, remove: 'trade_agreement' });
        actions.push({ type: 'SILO_REPUTATION', siloId: silo.id, amount: D.treatyBreakRep });
        actions.push(
          remember(silo, { day, kind: 'broken', weight: -18, text: 'Silo 12 could not deliver on a standing agreement.' })
        );
        actions.push({
          type: 'LOG',
          entry: { kind: 'diplomacy', text: `The standing agreement with ${silo.name} has lapsed — you could not deliver.` },
        });
        continue;
      }
      for (const [k, v] of Object.entries(t.want || {})) deltas[k] = (deltas[k] || 0) + v;
      actions.push({ type: 'RESOURCE_DELTA', deltas, emit: false });
      actions.push({
        type: 'SILO_TREATY',
        siloId: silo.id,
        add: true,
        treaty: { ...t, nextDay: day + (t.everyDays || 4) },
      });
      actions.push(remember(silo, { day, kind: 'honored', weight: 1.5, text: 'A shipment arrived on time.' }));
    }

    // Allies call you in. Refusing is expensive and public.
    if (hasTreaty(silo, 'alliance') && rng.chance(0.05)) {
      actions.push({
        type: 'WORLD_EVENT_QUEUE',
        event: { kind: 'call_to_arms', siloId: silo.id, day: day + 1 },
      });
    }

    // Why anyone comes for Silo 12. Two reasons, and the second one is new.
    //
    // The first — a grudge — was the only one, and it never happened. Measured
    // over a 400-day campaign the worst reputation any silo reached was -15,
    // and over 300 days of *deliberately* antagonising The Anvil (repeated
    // approach runs, each failure worth `scoutFailAlertRep`) it reached -23.
    // The gate was -40, and only two silos of twenty have the aggression to
    // pass the second clause at all. So the dynamic raid was unreachable by
    // every playstyle, and the only raid a player ever saw in a whole
    // campaign was the scripted probe on day 26.
    //
    // That did not matter while `world.pendingRaid` was written and never
    // read. It matters now that sim/raid.js resolves it: a defence mechanic
    // that fires once per campaign, before the player can have formed a
    // squad, is a mechanic the player never gets to use.
    //
    // The second reason is the one The Anvil's own entry in data/silos.js has
    // always described — "Raids openly and keeps a ledger of who has not paid
    // yet" — which is not a grudge, it is a business. A silo that is fat and
    // lightly held gets visited whether or not it has given offence. That is
    // what makes keeping a squad at home a standing decision rather than a
    // reaction, and it is the only clause a peaceful player will ever meet.
    const grudge = silo.reputation < D.raidGrudgeReputation;
    const aggressive = silo.disposition.aggression > D.raidAggression;
    if (aggressive && !hasTreaty(silo, 'nap') && !hasTreaty(silo, 'alliance')) {
      const me = playerPower(state);
      // Worth robbing, and cheap to rob. Both halves matter: a poor silo is
      // not worth the walk, and a well-defended one is somebody else's
      // problem.
      const fat = me.economy >= D.raidTemptEconomy;
      const soft = me.military <= D.raidTemptMilitary;
      const opportunity = fat && soft;
      if ((grudge || opportunity) && rng.chance(grudge ? D.raidChanceGrudge : D.raidChanceOpportunity)) {
        actions.push({
          type: 'WORLD_EVENT_QUEUE',
          event: { kind: 'raid', siloId: silo.id, day: day + rng.int(2, 5) },
        });
      }
    }
  }

  actions.push({ type: 'MEMORY_DECAY', rate: D.memoryDecayPer10Days / 10, emit: false });
  return actions;
}

// -------------------------------------------------------------- conquest ---

export const CONQUEST_STAGES = [
  { id: 'scout', name: 'Scout', desc: `${BAL.conquest.scoutRunsRequired} successful approach runs to map their defences. Failure alerts them.` },
  { id: 'undermine', name: 'Undermine', desc: 'Cut their power or water, turn a faction, or starve them through their trade partners.' },
  { id: 'breach', name: 'Breach', desc: `Breaching charges, ${BAL.conquest.breachSquadsRequired}+ squads, tier-${BAL.conquest.breachSuitTier} suits. The hardest single fight in the game.` },
  { id: 'hold', name: 'Hold', desc: `${BAL.conquest.holdCombats} sequential floor fights with no resupply, then ${BAL.conquest.holdGarrisonDays} days of garrison or they revolt.` },
];

export function conquestState(state, siloId) {
  const silo = state.world.silos[siloId];
  return silo?.conquest || { stage: null, scoutRuns: 0, undermined: false, defenseMult: 1 };
}

export function canAdvance(state, siloId) {
  const silo = state.world.silos[siloId];
  if (!silo) return { ok: false, reason: 'No such silo.' };
  if (silo.status === 'collapsed') return { ok: false, reason: 'There is nothing left there to take.' };
  const c = conquestState(state, siloId);
  const research = state.research.completed;

  if (!c.stage || c.stage === 'scout') {
    if (c.scoutRuns < BAL.conquest.scoutRunsRequired) {
      return {
        ok: false,
        stage: 'scout',
        reason: `${c.scoutRuns}/${BAL.conquest.scoutRunsRequired} approach runs completed. Send another.`,
      };
    }
    return { ok: true, stage: 'undermine' };
  }
  if (c.stage === 'undermine') {
    if (!c.undermined) return { ok: false, stage: 'undermine', reason: 'Their defences are still intact.' };
    return { ok: true, stage: 'breach' };
  }
  if (c.stage === 'breach') {
    if (!research.includes('breaching_charges')) {
      return { ok: false, stage: 'breach', reason: 'Breaching charges are not researched.' };
    }
    const ready = state.military.squadIds.filter((id) => !state.military.squads[id].deployed).length;
    if (ready < BAL.conquest.breachSquadsRequired) {
      return { ok: false, stage: 'breach', reason: `Needs ${BAL.conquest.breachSquadsRequired} squads standing by; ${ready} are.` };
    }
    return { ok: true, stage: 'hold' };
  }
  // The stage this function never had. A won breach writes stage 'hold', and
  // every value that is not scout/undermine/breach fell through to "Already
  // taken." — so a silo whose door had just been forced reported itself as
  // conquered and refused the assault that actually takes it. It never showed
  // up because nothing in the game wrote 'hold' in the first place: the only
  // caller was a test that stopped at breach.
  //
  // Note the contract, which the rest of this function set and which is
  // asserted in test/conquest.mjs: on success `stage` is the stage you may
  // now *reach*, not the one you are on. `ok: false` means "this stage is not
  // finished", not "you may not attempt it" — see `canLaunchRun` in
  // sim/conquest.js, which is what actually gates sending a squad.
  if (c.stage === 'hold') {
    const ready = state.military.squadIds.filter((id) => !state.military.squads[id].deployed).length;
    if (!ready) return { ok: false, stage: 'hold', reason: 'Every squad is already out.' };
    return { ok: true, stage: 'hold' };
  }
  return { ok: false, reason: 'Already taken.' };
}

export default { evaluate, perform, simulateTick, availableActions, bundleValue, conquestState };
