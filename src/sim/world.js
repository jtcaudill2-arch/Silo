/**
 * world.js — the other nineteen, ticked once per game day.
 *
 * Deliberately coarse. Each silo is five numbers and five disposition dials,
 * and the whole world costs a few hundred arithmetic operations a day. What
 * buys the feeling of a living world for that price is the radio: silos war
 * each other, collapse, and send refugees whether or not the player is
 * involved, and the player *hears about it*. A war you had nothing to do with,
 * reported over the radio, does more for the world than any amount of
 * simulation depth would.
 */

import { BAL } from '../config/balance.js';
import { streamFor } from '../core/rng.js';
import { siloDef, PLAYER_SILO_ID } from '../data/silos.js';
import { effects as researchEffects } from './research.js';

const W = BAL.world;

/** Player strength, in the same 0-100 terms the world silos use. */
export function playerPower(state) {
  const pop = state.citizenIds.length;
  let soldiers = 0;
  for (const id of state.military.squadIds) {
    soldiers += state.military.squads[id]?.members.length || 0;
  }
  const rooms = Object.keys(state.silo.rooms).length;
  const research = state.research.completed.length;
  return {
    military: clamp(soldiers * 4 + (researchEffects(state).weaponTier || 0) * 8, 0, 100),
    economy: clamp(rooms * 2.2, 0, 100),
    science: clamp(research * 2.4, 0, 100),
    population: clamp(pop / 6, 0, 100),
    stability: clamp(state.order.value, 0, 100),
  };
}

/**
 * One world day. Returns actions.
 *
 * Silos drift, collapse, and occasionally go to war with each other. Nothing
 * here consults the player unless the player is a party to it.
 */
export function simulateDay(state) {
  const actions = [];
  const day = state.clock.day;
  const rng = streamFor(state.meta.seed, 'world', day);
  const silos = Object.values(state.world.silos);

  const patches = [];
  const transmissions = [];

  for (const silo of silos) {
    if (silo.status === 'collapsed' || silo.status === 'unknown') continue;

    const p = { ...silo.power };

    // Population drifts on economy minus the cost of a standing army.
    p.population = clamp(
      p.population + (p.economy - p.military * W.militaryDriftWeight) / W.populationDriftDivisor,
      0,
      100
    );

    // Stability chases a target set by how well fed and how militarised the
    // silo is, plus whatever happened to it recently.
    const target = clamp(p.economy * 0.6 + p.population * 0.2 + (100 - p.military) * 0.2, 0, 100);
    p.stability = clamp(p.stability + Math.sign(target - p.stability) * W.stabilityDrift, 0, 100);

    // Economy follows population, slowly.
    p.economy = clamp(p.economy + (p.population - p.economy) * 0.004, 0, 100);

    // Wars drain both sides.
    const atWar = (silo.treaties || []).some((t) => t.kind === 'war');
    if (atWar) {
      p.stability = clamp(p.stability - W.warStabilityDrain, 0, 100);
      p.military = clamp(p.military - W.warMilitaryDrain, 0, 100);
    }

    // Status follows stability, and the label the player sees follows status.
    let status = silo.status;
    if (p.stability <= W.collapseAtStability) status = 'collapsed';
    else if (p.stability < 30) status = 'struggling';
    else if (p.stability > 70 && p.economy > 60) status = 'thriving';
    else status = 'stable';

    if (status === 'collapsed' && silo.status !== 'collapsed') {
      actions.push(...collapseSilo(state, rng, silo));
    } else if (status !== silo.status) {
      transmissions.push({
        day,
        siloId: silo.id,
        text: statusChangeText(silo, status),
      });
    }

    patches.push({ id: silo.id, power: p, status });
  }

  // ---- wars the player has nothing to do with ---------------------------
  actions.push(...maybeStartWar(state, rng, silos, day, transmissions));

  // ---- radio traffic ------------------------------------------------------
  if (state.world.radioTier > 0 && rng.chance(W.radioIntelChancePerDay)) {
    const heard = overheard(state, rng, silos, day);
    if (heard) transmissions.push(heard);
  }

  if (patches.length) actions.push({ type: 'WORLD_PATCH', patches, emit: false });
  for (const t of transmissions) {
    actions.push({ type: 'TRANSMISSION', transmission: t });
  }

  // ---- satellites contribute, and cost -----------------------------------
  actions.push(...tickSatellites(state));

  return actions;
}

function collapseSilo(state, rng, silo) {
  const actions = [
    {
      type: 'WORLD_PATCH',
      patches: [{ id: silo.id, status: 'collapsed', contact: 'none' }],
    },
  ];

  // A holding that collapses stops being a holding.
  //
  // Nothing removed the entry, so `tickSatellites` went on paying its yield
  // off a dead silo's `power.economy`, went on ticking its order, and it went
  // on counting toward `dominionSilosRequired` — a player could hold the
  // ending open with silos that had stopped transmitting. Reachable through
  // `warStabilityDrain` on a held silo.
  if ((state.world.satellites || []).some((s) => s.siloId === silo.id)) {
    actions.push({ type: 'SATELLITE_REVOLT', siloId: silo.id, cause: 'collapse' });
  }

  actions.push(
    {
      type: 'TRANSMISSION',
      transmission: {
        day: state.clock.day,
        siloId: silo.id,
        kind: 'collapse',
        text: `${silo.name} has stopped transmitting. The carrier is still up. Nobody is answering it.`,
      },
    }
  );

  const roll = rng.next();
  if (roll < W.collapseRefugeeChance && silo.known) {
    // Refugees arrive at your airlock some days later.
    actions.push({
      type: 'WORLD_EVENT_QUEUE',
      event: {
        kind: 'refugees',
        fromSilo: silo.id,
        day: state.clock.day + rng.int(2, 6),
        count: rng.int(4, 14),
      },
    });
  } else if (roll < W.collapseRefugeeChance + W.collapseRaiderHostChance) {
    actions.push({
      type: 'TRANSMISSION',
      transmission: {
        day: state.clock.day,
        siloId: silo.id,
        kind: 'collapse',
        text: `Whatever is living in ${silo.name} now is not running a silo. Raider traffic on their frequency.`,
      },
    });
  }
  return actions;
}

function maybeStartWar(state, rng, silos, day, transmissions) {
  const actions = [];
  const active = silos.filter((s) => s.status !== 'collapsed' && s.status !== 'unknown' && s.id !== PLAYER_SILO_ID);
  if (active.length < 2) return actions;

  for (let i = 0; i < 3; i++) {
    const a = rng.pick(active);
    const b = rng.pick(active);
    if (!a || !b || a.id === b.id) continue;
    if ((a.treaties || []).some((t) => t.kind === 'war' && t.with === b.id)) continue;

    const aggression = (a.disposition.aggression + b.disposition.greed) / 2;
    if (!rng.chance(W.warChancePerDayPerPair * (1 + aggression * 3))) continue;

    actions.push({ type: 'WORLD_WAR', a: a.id, b: b.id, at: day });
    transmissions.push({
      day,
      siloId: a.id,
      kind: 'war',
      text: `${a.name} is shooting at ${b.name}. Nobody asked you, and nobody is going to.`,
    });
    break;
  }
  return actions;
}

/**
 * Something the radio picks up. Cheap, and it does more work than any of the
 * simulation above for making the world feel inhabited.
 */
function overheard(state, rng, silos, day) {
  const known = silos.filter((s) => s.known && s.status !== 'collapsed' && s.status !== 'unknown');
  if (!known.length) return null;
  const silo = rng.pick(known);
  const def = siloDef(silo.id);

  const lines = [
    `${silo.name} is broadcasting a manifest again. Either they have a surplus or they want you to think so.`,
    `Somebody on ${silo.name}'s frequency spent an hour reading names. A casualty list, probably.`,
    `${silo.name} has gone quiet on the open channel and moved to something encrypted.`,
    `${silo.name} is asking after ${rng.pick(known).name}. They did not say why.`,
    `A supply convoy left ${silo.name} heading somewhere they would not name.`,
    `${silo.mayorName || 'Their mayor'} made a speech. The parts you could hear were about rationing.`,
    `${silo.name} reports a hull breach on their lower floors. They report it as minor.`,
  ];

  if (silo.power.stability < 35) {
    lines.push(`There is shouting on ${silo.name}'s open channel. It went off the air mid-sentence.`);
  }
  if (silo.power.military > 70) {
    lines.push(`${silo.name} is running drills on an open frequency. That is a message, not an oversight.`);
  }
  if (def?.specialty) {
    lines.push(`${silo.name} is offering ${def.specialty} at a price that suggests they have too much of it.`);
  }

  return { day, siloId: silo.id, kind: 'chatter', text: rng.pick(lines) };
}

function statusChangeText(silo, status) {
  switch (status) {
    case 'thriving': return `${silo.name} sounds prosperous lately. Confident, even.`;
    case 'struggling': return `${silo.name} has started asking around for food. That is new.`;
    default: return `${silo.name} appears to have steadied.`;
  }
}

// ------------------------------------------------------------ satellites ---

/**
 * Conquered silos contribute at reduced efficiency and cost Order every day
 * (spec §12.3). Two is comfortable. Five will break you.
 */
function tickSatellites(state) {
  const actions = [];
  if (!state.world.satellites.length) return actions;

  // A garrison is a squad standing on the silo doing nothing else. There are
  // only so many of those, so past a certain number of satellites some of
  // them are held by nobody — and an ungarrisoned occupation slides toward
  // throwing you out. This is what stops Dominion being free: six silos is
  // six squads permanently off the board, fed and paid every day.
  const garrisons = state.military.squadIds.filter((id) => {
    const sq = state.military.squads[id];
    return sq && !sq.deployed && sq.assignment === 'garrison';
  }).length;

  const deltas = {};
  const orderShifts = [];
  const revolts = [];
  state.world.satellites.forEach((sat, i) => {
    const silo = state.world.silos[sat.siloId];
    if (!silo) return;
    const eff = BAL.conquest.satelliteEfficiency * (sat.order / 100);
    const scale = (silo.power.economy / 100) * eff;
    const def = siloDef(sat.siloId);
    const yieldKey = specialtyResource(def?.specialty);
    if (yieldKey) deltas[yieldKey] = (deltas[yieldKey] || 0) + BAL.conquest.satelliteYieldPerDay * scale;
    deltas.chits = (deltas.chits || 0) + BAL.conquest.satelliteChitsPerDay * scale;

    const held = i < garrisons;
    const shift = held ? BAL.conquest.satelliteWarmPerDay : BAL.conquest.satelliteDecayPerDay;
    if (!held && sat.order + shift <= BAL.conquest.revoltOrderThreshold) revolts.push(sat.siloId);
    else orderShifts.push({ siloId: sat.siloId, amount: shift });
  });

  if (Object.keys(deltas).length) actions.push({ type: 'RESOURCE_DELTA', deltas, emit: false });
  actions.push({
    type: 'ORDER_DELTA',
    amount: BAL.conquest.satelliteOrderPerDay * state.world.satellites.length,
    reason: 'occupation duty',
    emit: false,
  });
  if (orderShifts.length) actions.push({ type: 'SATELLITE_TICK', shifts: orderShifts, emit: false });
  for (const siloId of revolts) actions.push({ type: 'SATELLITE_REVOLT', siloId });
  return actions;
}

// ---------------------------------------------------------- world events ---

/**
 * A queued world event arriving at the silo. These are the moments the world
 * reaches in and touches the player: refugees at the door, an ally invoking
 * the pact, a raid that was set in motion days ago.
 */
export function applyWorldEvent(state, event) {
  const rng = streamFor(state.meta.seed, 'world-event', event.kind, event.day);
  const silo = event.siloId != null ? state.world.silos[event.siloId] : null;
  const from = event.fromSilo != null ? state.world.silos[event.fromSilo] : null;

  switch (event.kind) {
    case 'refugees': {
      // Housing decides how many you can actually take. The rest is a choice
      // the player has already made by not building residences.
      const housing = state.air.capacity - state.citizenIds.length;
      const taken = Math.max(0, Math.min(event.count, Math.floor(housing)));
      const actions = [];
      for (let i = 0; i < taken; i++) {
        const r = makeRefugee(state, rng, from, i);
        actions.push({ type: 'CITIZEN_ADD', citizen: r });
      }
      actions.push({
        type: 'LOG',
        entry: {
          kind: 'alert',
          text:
            taken === 0
              ? `${event.count} refugees from ${from?.name || 'a dead silo'} reached the airlock. There was no air for them and they were turned away.`
              : taken < event.count
              ? `${event.count} refugees from ${from?.name || 'a dead silo'} reached the airlock. You could take ${taken}.`
              : `${taken} refugees from ${from?.name || 'a dead silo'} are inside. They arrived with nothing.`,
        },
      });
      if (taken < event.count) {
        actions.push({ type: 'ORDER_DELTA', amount: -4, reason: 'turning people away at the door' });
      }
      return actions;
    }

    case 'call_to_arms':
      // Presented, not auto-resolved: refusing is a decision with a price.
      return [
        { type: 'WORLD_EVENT_QUEUE', event: { ...event, kind: 'call_to_arms_pending', day: state.clock.day } },
        {
          type: 'LOG',
          entry: {
            kind: 'diplomacy',
            text: `${silo?.name || 'An ally'} is under attack and is invoking the alliance. They are waiting on an answer.`,
          },
        },
      ];

    case 'raid': {
      const strength = (silo?.power.military || 40) / 100;
      return [
        {
          type: 'LOG',
          entry: {
            kind: 'alert',
            text: `${silo?.name || 'Somebody'} has put a raiding party on your airlock.`,
          },
        },
        { type: 'PENDING_RAID', siloId: event.siloId, strength },
      ];
    }

    default:
      return [];
  }
}

function makeRefugee(state, rng, from, index) {
  // Imported lazily via the factory the population module owns; refugees are
  // ordinary citizens with a worse start and a story.
  const { makeCitizen } = refugeeFactory;
  const c = makeCitizen(streamFor(state.meta.seed, 'refugee', from?.id ?? 0, state.clock.day * 100 + index), {
    age: rng.float(6, 55),
    origin: 'refugee',
    health: rng.int(40, 80),
    radiation: rng.int(0, 30),
    morale: rng.int(15, 40),
    traitChance: 0.55,
  });
  c.history.push({
    day: state.clock.day,
    text: `Walked here from ${from?.name || 'a silo that stopped answering'}.`,
  });
  return c;
}

/** Injected at boot to keep world.js free of an import cycle with population. */
export const refugeeFactory = { makeCitizen: null };
export function setRefugeeFactory(fn) {
  refugeeFactory.makeCitizen = fn;
}

export function specialtyResource(specialty) {
  switch (specialty) {
    case 'alloy': return 'alloy';
    case 'food': return 'food';
    case 'meds': return 'meds';
    case 'ammo': return 'ammo';
    case 'fuel': return 'fuel';
    case 'parts': return 'parts';
    case 'scrap': return 'scrap';
    case 'chits': return 'chits';
    default: return null;
  }
}

/** Which silos the radio can reach at the current tier. */
export function inRange(state, silo) {
  const tier = state.world.radioTier || 0;
  if (tier <= 0) return false;
  const limit = BAL.diplomacy.radioRangeTiers[Math.min(tier, BAL.diplomacy.radioRangeTiers.length) - 1];
  // Distance stands in for silo-number difference from 12 — a cheap and
  // stable ordering that makes range upgrades feel like reaching further out.
  return Math.abs(silo.id - PLAYER_SILO_ID) <= Math.ceil(limit / 2);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export default { simulateDay, playerPower, inRange };
