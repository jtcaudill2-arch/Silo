/**
 * dig.js — what is behind the door.
 *
 * Silo 12 is not being carved out of bedrock. It was built, all hundred and
 * forty-four floors of it, and the ones below the lit part were sealed by somebody who
 * had a reason. Opening one is therefore not construction, it is a door being
 * broken — and what is on the other side is the point.
 *
 * Before this, every floor opened onto the same sentence: "Six bays of bare
 * rock and a lighting circuit." Opening one was a purchase with a known price
 * and a known result, which made the only question whether the silo could
 * afford it. That is a budget, not a decision.
 *
 * The rock is also gone from that sentence, and it had to be: a level the
 * builders sealed is a built level with its fittings stripped, not a cavity.
 * Every opened floor now leads with its designation off the silo's own plan —
 * see data/sections.js — so even the emptiest one arrives as a Machine Level
 * or a Support Level with the ducting still in the wall, rather than as six
 * interchangeable holes.
 *
 * Depth does two things here, and they pull against each other. It raises what
 * a level is worth — the old stores nearer the Foundations are richer, and the
 * things worth researching are only found down there — and it raises what a
 * level can cost you, because the deeper seals were the ones that most needed
 * sealing. A player who digs as fast as they can afford to will get hurt; one
 * who never digs stays poor and never finds an artifact. That is the decision.
 *
 * Shoring used to be the lever between the two, and is no longer: below
 * `shoringRequiredBelowFloor` the dig is charged alloy for it and `canExcavate`
 * will not start one that cannot pay, so every crew is working behind supports
 * and `shoredCollapseMultiplier` applies to every dig. The alloy is a toll, not
 * a premium — there is no policy to decline. If it is ever meant to be a choice
 * again, `digOutcome`'s `shored` is where the decision would have to be read.
 *
 * Pure: (state, floorN, rng) -> outcome descriptor. The caller dispatches.
 */

import { BAL } from '../config/balance.js';
import { sectionFor } from '../data/sections.js';
import { tierForFloor } from './research.js';
import { LOOT } from '../data/items.js';
import { namedLevel } from '../data/levels.js';
import { getRoom } from '../data/rooms.js';

/** 0 for the Uppers, 4 for the Foundations. */
function tierIndex(floorN) {
  const key = tierForFloor(floorN).key;
  return BAL.silo.tiers.findIndex((t) => t.key === key);
}

/**
 * Pick from a weighted table. Weights are per-tier arrays, so a table can be
 * absent up top and common at the bottom without a second mechanism.
 */
function pick(rng, table, ti) {
  const weights = table.map((row) => row.weight[Math.min(ti, row.weight.length - 1)] ?? 0);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return table[0];
  let roll = rng.next() * total;
  for (let i = 0; i < table.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return table[i];
  }
  return table[table.length - 1];
}

/**
 * The outcomes, and how their likelihood moves with depth.
 *
 * Weights are indexed by tier: [Uppers, Mids, Lowers, Deeps, Foundations,
 * Shaft Floor].
 * The Uppers are almost always empty, because the top of the silo is the part
 * that was lived in and stripped. Everything interesting is further down.
 */
const OUTCOMES = [
  {
    id: 'bare',
    kind: 'alert',
    weight: [70, 40, 26, 18, 12, 8],
    text: () => 'Six bays stripped to the shell, and a lighting circuit that still works.',
  },
  {
    id: 'stores',
    kind: 'good',
    weight: [22, 30, 28, 24, 20, 18],
    apply: (rng, ti) => {
      const m = BAL.excavationFinds.storesPerTier[ti];
      return {
        resources: {
          scrap: Math.round(m * (0.8 + rng.next() * 0.6)),
          parts: Math.round(m * 0.16 * (0.6 + rng.next() * 0.8)),
        },
      };
    },
    text: (o) =>
      `A storeroom nobody emptied — ${Math.round(o.resources.scrap)} scrap and ` +
      `${Math.round(o.resources.parts)} parts, still on the shelves.`,
  },
  {
    id: 'cistern',
    kind: 'good',
    weight: [4, 10, 12, 10, 8, 6],
    apply: (rng, ti) => ({
      resources: { water: Math.round(BAL.excavationFinds.cisternPerTier[ti] * (0.7 + rng.next() * 0.6)) },
    }),
    text: (o) =>
      `The level is half flooded, and the water is clean — ${Math.round(o.resources.water)} ` +
      'recovered before the pumps caught up.',
  },
  {
    id: 'cache',
    kind: 'good',
    // Nothing above the Mids: the artifacts are what the builders left behind,
    // and they did not leave anything in the part of the silo people lived in.
    weight: [0, 6, 12, 20, 26, 32],
    apply: (rng, ti) => {
      // LOOT is keyed by expedition band 1-4 with the artifacts nested inside,
      // not an array of pools. Indexing it as an array silently produced an
      // empty table, so caches turned up all the way down and never once held
      // an artifact — measured at 0% across every tier.
      //
      // Tier index 1-4 maps onto band 1-4: the Mids pay out like the near
      // ruins, the Foundations like the scar — tier index 4 is `LOOT[4]`,
      // which is the scar band's table and the only one carrying origin
      // shards. The Uppers are clamped up into band 1 rather than having a
      // band of their own.
      const band = LOOT[Math.max(1, Math.min(4, ti))] || {};
      const ids = Object.keys(band.artifacts || {});
      const out = {
        resources: { alloy: Math.round(BAL.excavationFinds.cacheAlloyPerTier[ti] * (0.7 + rng.next() * 0.6)) },
      };
      if (ids.length && rng.next() < BAL.excavationFinds.artifactChance) {
        out.artifact = ids[Math.floor(rng.next() * ids.length)];
      }
      return out;
    },
    text: (o) =>
      o.artifact
        ? `A sealed cache behind the wall: ${Math.round(o.resources.alloy)} alloy, and something ` +
          'the Laboratory will want to look at.'
        : `A sealed cache behind the wall — ${Math.round(o.resources.alloy)} alloy.`,
  },
  {
    id: 'collapse',
    kind: 'warn',
    // The reason to shore, and the reason not to dig faster than you can.
    weight: [3, 8, 12, 16, 20, 24],
    apply: (rng, ti) => ({
      condition: -Math.round(BAL.excavationFinds.collapseConditionPerTier[ti] * (0.7 + rng.next() * 0.6)),
      hurts: true,
    }),
    text: (o) =>
      'The ceiling came down as the seal gave. The crew got clear, and the floor above ' +
      `took ${Math.abs(o.condition)} points of damage.`,
  },
  {
    id: 'contamination',
    kind: 'rad',
    // Rare in the Uppers and common below. This is the one place `--toxin`
    // green is allowed on screen.
    weight: [1, 6, 10, 12, 14, 16],
    apply: (rng, ti) => ({
      air: -Math.round(BAL.excavationFinds.contaminationAirPerTier[ti] * (0.7 + rng.next() * 0.6)),
    }),
    text: (o) =>
      'Whatever was sealed in there is still leaking. The air went sour across the silo — ' +
      `${Math.abs(o.air)} points of quality, and it will take shifts to scrub back.`,
  },
];

/**
 * Roll what a newly opened floor contains.
 *
 * Deterministic in (seed, floor): the caller passes a stream keyed on the
 * floor number, so re-opening the same save reveals the same level and the
 * catch-up replay agrees with live play.
 */
export function digOutcome(state, floorN, rng) {
  // A level that was built for something is not rolled for. Roughly one in
  // eight of the 144 is standing there seized rather than empty, and which one
  // is a fact about the silo, not about the seed — two players who reach floor
  // 136 find the same reactor.
  const named = namedLevel(floorN);
  if (named) {
    const def = getRoom(named.room);
    const out = {
      id: 'found',
      kind: 'good',
      floor: floorN,
      levelName: named.name,
      found: {
        type: named.room,
        width: named.width,
        level: named.level,
        condition: named.condition,
      },
      text:
        `Floor ${floorN} is open — ${named.name}. ${named.text} ` +
        `The ${def?.name || named.room} is at ${named.condition}% and will run again if it is repaired.`,
    };
    // A few of the deepest carry the evidence the ending chain is built on.
    // Not rolled for, for the same reason the level itself is not: whether a
    // campaign can be finished should not come down to a loot table.
    if (named.artifact) {
      out.artifact = named.artifact;
      if (named.artifactText) out.text += ` ${named.artifactText}`;
    }
    return out;
  }

  const ti = tierIndex(floorN);
  // Every dig is behind supports, so the discount is unconditional.
  //
  // Above the shoring line `buildFloors` sets `shored: true`; below it,
  // `canExcavate` refuses to start a dig the silo cannot pay the alloy for. The
  // two together cover all 144 floors, which makes the old `floor?.shored ||
  // floorN >= line` expression a constant `true` and the unshored branch dead.
  // It is written as a constant rather than left looking like a decision — if
  // the premium is ever meant to be optional, this is where the choice would
  // have to be read back, and there is currently nothing to read.
  const shored = true;

  const table = OUTCOMES.map((o) => {
    if (o.id !== 'collapse' || !shored) return o;
    // Shoring is bought with alloy and this is what it buys.
    const weight = o.weight.map((w) => w * BAL.excavationFinds.shoredCollapseMultiplier);
    return { ...o, weight };
  });

  const chosen = pick(rng, table, ti);
  const out = { id: chosen.id, kind: chosen.kind, floor: floorN };
  Object.assign(out, chosen.apply ? chosen.apply(rng, ti) : {});

  // The designation leads, because on most levels it is the only news. Roughly
  // half of every roll is `bare` up top, and "six bays and a lighting circuit"
  // told the player nothing they could act on; "a Machine Level, deep footings
  // and a crane rail" tells them what to put there and that it will take a
  // fourth bay when they do.
  const section = sectionFor(floorN);
  out.section = section?.key || null;
  out.text = section
    ? `Floor ${floorN} is open — a ${section.name}. ${chosen.text(out)} ${section.blurb}`
    : `Floor ${floorN} is open. ${chosen.text(out)}`;
  return out;
}

export default { digOutcome };
