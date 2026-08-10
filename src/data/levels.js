/**
 * levels.js — the levels that are not interchangeable.
 *
 * Most of the 144 are shell: six bays, a lighting circuit, and whatever the
 * outcome roll in sim/dig.js gives them. That is right for most of a silo. But
 * a descent where every door opens onto the same kind of surprise is a slot
 * machine, and the reason to go down should sometimes be a *specific* reason.
 *
 * So roughly one level in eight was built for something, and is still standing
 * there — seized, unlit, and repairable. Finding one hands the silo a room it
 * would otherwise have to buy, at the price of putting it back into service:
 * `silo.repair.fractionOfBuildCost` of the build cost, spent through the
 * repair machinery that already exists. That reuse is deliberate. A found room
 * needs no new action, no new reducer path and no schema change — it is an
 * ordinary room that happens to arrive at eighteen per cent condition.
 *
 * Two rules held while writing these:
 *
 *   Every one is about this game's economy, not its atmosphere. A level worth
 *   opening is one that changes a plan — the only source of ore, a chem plant
 *   that unbottlenecks expeditions, a reactor that ends the fuel clock. A
 *   level with a good name and no consequence is set-dressing with a floor
 *   number.
 *
 *   Nothing is borrowed. The names are this game's own vocabulary, per the
 *   originality rule in the brief: no characters, place-names or terms lifted
 *   from anything else.
 *
 * Depth is the difficulty dial. The rooms found up top are cheap and useful;
 * the ones at the bottom are things nothing else in the silo can produce, on
 * levels that also carry the worst collapse and contamination odds.
 */

/** @typedef {object} NamedLevel
 *  @property {string} name    what the level was, in the silo's own records
 *  @property {string} room    room type id found there, still standing
 *  @property {number} width   slots it occupies
 *  @property {number} level   the level it was built to, which it keeps
 *  @property {number} condition  what is left of it — repair is the price
 *  @property {string} text    the line the log prints when the door opens
 */

/** Keyed by floor number. */
export const NAMED_LEVELS = {
  // ---- Upper (1-20): nothing. Deliberately -------------------------------
  //
  // The Uppers are the part of the silo that was lived in, and sim/dig.js has
  // always said so — 'bare' is weighted 70 up here and the artifact caches are
  // weighted 0, because "they did not leave anything in the part of the silo
  // people lived in". Two found rooms on floors 9 and 16 contradicted that,
  // and cost more than the fiction.
  //
  // The first twenty floors are where the surface half of the game is decided.
  // A silo that spends its early scrap and its early *attention* on a
  // schoolhouse it did not ask for reaches Env-Suit I late, and the Surface
  // panel — the screen that explains why any of the rest of it matters — slid
  // from day 50 to day 73 on the project's own autopilot. Measured both ways:
  // with every other change in this phase kept and only these two entries
  // removed, it went straight back to 50.
  //
  // So the reward for digging starts where the silo stops being a place people
  // remember and starts being a place they sealed.

  // ---- Mids (21-48): the levels that pay for themselves -------------------
  // Neither of these is life support, and that is the whole point of them.
  //
  // They were a Water Reclaimer and a Hydroponics Bay to begin with, which
  // read as the obvious gift to hand a struggling silo and was the single
  // worst thing in this file. Free food and water capacity in the Mids does
  // not change a plan, it enlarges one: the population went to a hundred and
  // seventy against a hundred and twenty-nine, the extra was children, and a
  // silo with fifty-nine residents in school and the same sixty-odd workers
  // could no longer crew everything it owned. The posts it dropped were the
  // Foundry and the Suit Bay — so the campaign never smelted alloy, never
  // built a suit, and never once reached the surface in three hundred days.
  //
  // A found level has to be worth opening without moving the population
  // curve. These two are: one keeps what the silo already has running, the
  // other is capacity that needs nobody to stand in it.
  24: {
    name: 'The Works',
    room: 'maintenance_bay', width: 2, level: 2, condition: 16,
    text: 'A maintenance shop with the silo\'s own drawings still pinned up, seized solid. The lathes turn by hand, which means they will turn under power.',
  },
  31: {
    name: 'Seed Store',
    room: 'storage_depot', width: 2, level: 2, condition: 20,
    text: 'Racks, bins, and trays of seed stock somebody labelled carefully and never came back for.',
  },
  38: {
    name: 'Records',
    room: 'archive', width: 2, level: 2, condition: 22,
    text: 'Shelved paper, floor to ceiling, most of it ledgers. Whoever kept it stopped ninety years ago.',
  },
  45: {
    name: 'The Bench',
    room: 'workshop', width: 2, level: 2, condition: 18,
    text: 'A machine shop with the tools still in their outlines on the board. Nothing was taken.',
  },

  // ---- Lowers (49-76) ----------------------------------------------------
  53: {
    name: 'The Sealed Ward',
    room: 'clinic', width: 2, level: 2, condition: 14,
    text: 'A clinic. The door was welded shut from the corridor side, and the log does not say why.',
  },
  61: {
    name: 'Filter House',
    room: 'chem_lab', width: 2, level: 2, condition: 15,
    text: 'Scrubber stacks and a filter press. This is where the silo used to make its own air cartridges.',
  },
  68: {
    name: 'The Long Gallery',
    room: 'residences', width: 3, level: 2, condition: 26,
    text: 'Sixty bunks in rows, made up. Nobody has slept here in three generations.',
  },
  74: {
    name: 'Salvage Yard',
    room: 'recycling', width: 2, level: 2, condition: 17,
    text: 'Sorting belts and a baler, under forty years of dust and nothing worse.',
  },

  // ---- Deeps (77-104): things the silo cannot make yet --------------------
  81: {
    name: 'The Foundry Floor',
    room: 'foundry', width: 2, level: 2, condition: 12,
    text: 'Crucibles, cold. Alloy without waiting on the research — if the linings can be brought back.',
  },
  89: {
    name: 'Muster',
    room: 'barracks', width: 2, level: 2, condition: 20,
    text: 'Bunks, lockers, and a duty roster with every name struck through in the same hand.',
  },
  96: {
    name: 'The Armoury',
    room: 'armory', width: 2, level: 2, condition: 16,
    text: 'Racks and a workbench. Emptied properly, by people who signed for what they took.',
  },
  103: {
    name: 'Second Plant',
    room: 'generator_hall', width: 3, level: 2, condition: 13,
    text: 'A second generator hall the schematics never mentioned. The fuel line runs somewhere else.',
  },

  // ---- Foundations (105-124) ---------------------------------------------
  108: {
    name: 'Ore Face',
    room: 'deep_mine', width: 3, level: 2, condition: 14,
    text: 'The rock is open here and the seam is still in it. This is the only ore in the silo.',
  },
  115: {
    name: 'The Cold Room',
    room: 'protein_vats', width: 2, level: 2, condition: 15,
    text: 'Vats, chilled by something that is still running. Nobody has fed it in a very long time.',
  },
  // The three levels that carry the endgame, and why they carry it.
  //
  // Every one of the three endings is behind The Origin Record, and that node
  // wants two origin shards and a compact seal. Both are rollable — deep
  // expeditions and the sealed caches a dig turns up can each produce either —
  // but rollable is the whole problem: whether a campaign could be finished at
  // all came down to those tables being kind. Measured on two seeds of the
  // project's own autopilot: one drew the seal and won on day 713; the other
  // dug all 144 floors, finished 45 of 48 research nodes, kept 2,000 people
  // alive for 900 days, and could not finish the game, because it never turned
  // one up.
  //
  // The surface is still the faster road when the rolls are kind. This is the
  // other one: dig to the bottom of the shaft and the silo finds the same
  // evidence for itself. Two progressions, two ways to the same door — which
  // is the shape the rest of the game already has, and it means the deepest
  // twenty levels are worth reaching for a reason the player can plan.
  122: {
    name: 'Signal Room',
    room: 'radio_room', width: 2, level: 3, condition: 18,
    text: 'A radio set an order of magnitude beyond anything upstairs, aimed at nothing on the surface.',
    // Aimed at nothing on the surface because it was never pointed there.
    artifact: 'compact_seal',
    artifactText: 'The log book is still in the desk, and the call signs in it are not this silo\'s.',
  },

  // ---- Shaft Floor (125-144): the reasons to have come this far -----------
  129: {
    name: 'The Deep Bench',
    room: 'laboratory', width: 2, level: 3, condition: 12,
    text: 'A laboratory built to a standard the silo has never matched. The benches are still calibrated.',
    artifact: 'origin_shard',
    artifactText: 'One of the sample drawers was left locked, and what is in it predates the silo.',
  },
  136: {
    name: 'The Old Plant',
    room: 'reactor', width: 3, level: 2, condition: 10,
    text: 'A reactor. Shut down deliberately, cleanly, and left in a state that expected to be restarted.',
  },
  143: {
    name: 'Last Store',
    room: 'storage_depot', width: 3, level: 3, condition: 20,
    text: 'The deepest room in the silo is a warehouse, and it was stocked for somebody who never arrived.',
    artifact: 'origin_shard',
    artifactText: 'The manifest on the door lists a delivery date, and it is eleven years before the silo was sealed.',
  },
};

/** The named level at this floor, or null. */
export function namedLevel(floorN) {
  return NAMED_LEVELS[floorN] || null;
}

export default { NAMED_LEVELS, namedLevel };
