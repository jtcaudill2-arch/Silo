/**
 * sections.js — what each of the hundred and forty-four levels was built for.
 *
 * Silo 12 was not dug. sim/dig.js has said so from the beginning — "it was
 * built, all hundred and forty-four floors of it, and the ones below the lit
 * part were sealed by somebody who had a reason" — but nothing a player could
 * see agreed. A sealed level was an unknown behind a door, the word on the
 * button was "Dig", and the six bays behind every seal were interchangeable.
 * A silo you are excavating and a silo you are relighting are different games,
 * and the game was showing the first one.
 *
 * So the builders had a plan, and every level is on it. A level is *fitted*
 * for one kind of work: the ducting for a support level, the deep footings and
 * the crane rail for a machine level, the water risers for a residential one.
 * The fittings are still in the walls, and they buy exactly one thing — a room
 * of that kind can be extended one bay wider than the silo's ordinary limit,
 * because the level has the span for it.
 *
 * That is the answer to "the floors should have more space for the things that
 * suit them", and it is the whole of the answer: a build discount was tried
 * alongside it and measured out, for the reason written against
 * `silo.section` in config/balance.js. It is not a penalty anywhere either — a
 * room out of place is built at the ordinary price to the ordinary width,
 * exactly as before this file existed. Nothing already standing became worse.
 *
 * DERIVED, NOT STORED. A level's designation is a pure function of its number,
 * so there is nothing to migrate, nothing to save, and two players who reach
 * floor 96 find the same crane rail. That is also why it is a repeating cycle
 * per tier rather than a hand-written table of 144 entries: a plan is regular.
 * The Uppers' cycle is the one that is hand-fitted, because the first six
 * levels are the ones the silo starts with and the opening has to read as a
 * silo that was built correctly — residences on 1, the life-support spine on
 * 2 to 5, and the gate on 6.
 */

import { BAL } from '../config/balance.js';
import { CATEGORIES, getRoom } from './rooms.js';

/**
 * What the silo's own records call a level of each kind.
 *
 * Deliberately not the category names from rooms.js. Those are a build menu's
 * vocabulary — "Life Support", "Production" — and this is signage on a
 * bulkhead. A player reading "Floor 58 · Machine Level" should hear the silo
 * talking about itself.
 */
export const SECTION_NAMES = {
  life: 'Support Level',
  civic: 'Residential Level',
  production: 'Machine Level',
  security: 'Guard Level',
  science: 'Technical Level',
  surface: 'Gate Level',
  storage: 'Store Level',
};

/** One line on what the builders put in the walls, shown when a level opens. */
export const SECTION_BLURBS = {
  life: 'Trunk ducting, a water riser and drains on every bay.',
  civic: 'Warm walls, lighting circuits and a landing wide enough to queue on.',
  production: 'Deep footings, a crane rail across the ceiling and a heavy feed.',
  security: 'Blast frames on the bays and a gate at the stair head.',
  science: 'Clean floors, shielded conduit and a bench run down one wall.',
  surface: 'The stair ends here. Above it is the ramp and the outer door.',
  storage: 'Bare span, a hoist point, and nothing that needs power.',
};

/**
 * The plan, tier by tier.
 *
 * Each entry is the cycle of designations that tier repeats, starting at its
 * first floor. Read down the list and you are reading the silo: people at the
 * top, the things that keep them alive just under them, then what the silo
 * makes, then what makes the silo, then the works.
 *
 * The Uppers' first six entries are load-bearing and match core/newgame.js's
 * STARTING_ROOMS one for one — residences (civic) on 1, air, crop, water and
 * generation (all life) on 2 to 5, and the gate on 6, which is the floor the
 * silo opens on and the one the airlock is built on. If you change the opening
 * rooms, change these with them, or the silo starts with five rooms in the
 * wrong levels and the first thing the game teaches is that placement does not
 * matter.
 */
const TIER_CYCLES = {
  // Where the silo was lived in, with the bench that kept it lived-in.
  //
  // This cycle read ['civic','life','life','life','life','surface','civic',
  // 'storage','life','science'] and had no Machine Level anywhere in it, which
  // is a pleasing idea about a residential section and an unsurvivable one. The
  // Uppers are floors 1 to 20 and `production` is where salvage and parts are
  // made, so the first Recycling Plant on the whole plan stood on floor 23 and
  // the first Workshop on floor 31. Scrap buys every dig, every repair and every
  // restoration, and the silo opens with 298 of it: measured at three actions a
  // day, an obedient player spent the lot digging toward an income it could not
  // reach, sat at zero scrap from day 31, watched generation decay from 33 to 0
  // as the hall wore out unrepairable, and suffocated on day 78 with 4,285 water
  // in tanks it could not pump.
  //
  // So the seventh level is the bench. It replaces the Store Level that used to
  // sit eighth — measured, floor 8 came out as five Storage Depots and a
  // Residences, the emptiest level in the building — and the civic level it
  // displaces moves down one rather than being lost. Everything else is
  // untouched, and the cycle still repeats at 17, so a silo that misses the
  // first machine level gets another within ten floors.
  upper: ['civic', 'life', 'life', 'life', 'life', 'surface', 'production', 'civic', 'life', 'science'],
  // The growing levels: the crop and the water that feed a silo that has
  // outgrown its spine, with the first benches and the first stores.
  mids: ['life', 'life', 'production', 'civic', 'life', 'science', 'storage', 'security'],
  // Where things are made rather than grown.
  lowers: ['production', 'production', 'life', 'storage', 'security', 'production', 'science', 'civic'],
  // The machine half of the silo. Guard levels between them, because this is
  // the part that was worth sealing.
  deeps: ['production', 'production', 'security', 'production', 'storage', 'science', 'life', 'production'],
  // What holds it up.
  foundations: ['production', 'science', 'production', 'security', 'storage', 'production'],
  // The works. Everything down here is machinery or the store for it.
  shaft: ['production', 'production', 'storage', 'security', 'production', 'science'],
};

/**
 * What floor `n` was built for.
 *
 * Returns null for a floor outside the silo rather than guessing, so a caller
 * that has lost track of its bounds fails visibly instead of quietly telling
 * the player that floor 200 is a Machine Level.
 */
export function sectionFor(n) {
  const tier = BAL.silo.tiers.find((t) => n >= t.from && n <= t.to);
  const cycle = tier && TIER_CYCLES[tier.key];
  if (!cycle || !cycle.length) return null;
  const key = cycle[(n - tier.from) % cycle.length];
  return {
    key,
    name: SECTION_NAMES[key] || CATEGORIES[key] || key,
    blurb: SECTION_BLURBS[key] || '',
    tier: tier.name,
  };
}

/** Is this the kind of room floor `n` was fitted for? */
export function suitsSection(n, def) {
  if (!def?.category) return false;
  return sectionFor(n)?.key === def.category;
}

/**
 * How wide a room may be extended on this floor.
 *
 * The ordinary ceiling everywhere, plus `section.extraWidth` on a level built
 * for that kind of work. This is the whole of "more space to build out for
 * specific things that are good for that section" — a four-bay Hydroponics on
 * a Support Level against three anywhere else, at +15% output and -12% power
 * per bay through the merge machinery that was already here, compounding with
 * the room's level on top of that.
 */
export function maxWidthOn(n, def) {
  return BAL.silo.merge.maxWidth + (suitsSection(n, def) ? BAL.silo.section.extraWidth : 0);
}

// ------------------------------------------------------- what is standing ---

/**
 * The rooms on a level, as the builders left them and as the dark left them.
 *
 * SILO 12 IS ABANDONED, NOT EMPTY. Every one of the 144 levels was fitted out
 * and lived in, and behind each seal the fittings are still bolted down — dark,
 * seized, and waiting for somebody to put them back into service. That is the
 * game: you open a level, read what is on it, and decide what you can afford to
 * bring back. Nothing is built from nothing.
 *
 * It replaces a build catalogue, and it replaces it for a reason a player said
 * plainly: dropped into a half-built silo with a menu of twenty-nine rooms and
 * a hundred and forty-four empty floors, the first decision the game asked for
 * was a layout puzzle, and the answer to "where does this go" is not
 * interesting when the honest answer is "anywhere". The builders already
 * decided. Reading their decision is a much better first move than second-
 * guessing it.
 *
 * SHAPE OF A LEVEL. Six bays. The level's own kind of work takes the wide
 * ones — a Machine Level's workshops run three and four bays across, because
 * the level was built with the span for them — and the last bay or two carry
 * the ordinary things every floor of a lived-in building has: a store, or
 * bunks. That mixture is what keeps `suitsSection` meaningful now that every
 * room arrives on a level rather than being placed on one: the fitted rooms are
 * the wide ones, and the lodgers are narrow.
 *
 * DERIVED, NOT STORED, like the designation above it. A level's contents are a
 * pure function of its number, so a save carries nothing new, two players who
 * reach floor 96 find the same foundry, and the Levels panel can show you what
 * is behind a seal before you pay to break it.
 */

/** The rooms of each kind that a level of that kind was fitted with, best first. */
const FITTINGS = {
  // The gated ones are in these lists on purpose. `allowed` below filters them
  // out above their tier, so a Reactor is only ever standing on a Foundations
  // level and a Deep Mine only in the Deeps — which is the whole reason to go
  // down there, and it cannot be true unless they are listed here.
  life: ['hydroponics', 'water_reclaimer', 'generator_hall', 'air_filtration', 'clinic',
    'protein_vats', 'reactor'],
  civic: ['residences', 'cafeteria', 'schoolhouse', 'radio_room'],
  production: ['workshop', 'recycling', 'foundry', 'maintenance_bay', 'munitions',
    'heat_exchange', 'deep_mine'],
  security: ['armory', 'barracks', 'training_yard', 'sheriffs_office', 'holding_cells'],
  science: ['laboratory', 'chem_lab', 'archive'],
  surface: ['airlock', 'suit_bay'],
  storage: ['storage_depot'],
};

/**
 * What every level carries regardless of what it was for. A silo is a place
 * people lived, so there are beds and cupboards on the machine floors too.
 */
const LODGERS = ['storage_depot', 'residences'];

/**
 * How the fitted bays are divided, and why there is more than one answer.
 *
 * Four bays and one room in them makes every level in the silo the same shape:
 * one wide thing and two cupboards. These are the ways four bays split, and
 * which one a level got is decided by its number — so some levels hand you a
 * single big plant and others hand you three smaller rooms, and reading the
 * manifest before you open one is worth doing.
 */
const SPLITS = [[4], [2, 2], [3, 1], [2, 1, 1]];

/**
 * Which split a level got — hashed, not multiplied.
 *
 * `(n * 3) % SPLITS.length` looked fine and had a hole in it. A tier's cycle is
 * eight long, so every civic level in the Mids sits at a floor divisible by
 * eight, and any linear function of n over a four-entry table is then constant
 * across the whole group: all four of them drew the same one-room split, so
 * the third entry in the civic fittings was never reached and the Schoolhouse
 * stood on no level in the silo. A hash has no such structure.
 */
function splitFor(n) {
  let h = 2166136261;
  h ^= n;
  h = Math.imul(h, 16777619);
  return SPLITS[(h >>> 0) % SPLITS.length];
}

/**
 * The three levels the silo is living on when you take the desk.
 *
 * TWELVE POSTS FOR SIXTEEN ADULTS, and the four spare are the point. These
 * widths come from that arithmetic rather than from what looks like a silo.
 *
 * Two measured failures got it here. Eighteen posts and a Cafeteria ran 27
 * power generated against 59 wanted from the first morning — generation scales
 * with the fraction of a room's posts that are crewed, so an opening with more
 * posts than people does not run a little short of everything, it runs the
 * GENERATOR at part crew and browns out the rooms that make the food. Dead on
 * day 41. Sixteen posts for sixteen adults then balanced on paper and was
 * worse: `crewed()` refuses any order the silo has not got spare hands for, so
 * at exactly zero spare every order in the game is filtered and the standing
 * order is "wait for people" for ever. An opening has to have slack in it or
 * the player is handed a silo with nothing they are allowed to do.
 *
 * Authored rather than generated, for the same reason the Uppers' cycle above
 * is hand-fitted: this is the opening, and the opening is the tutorial. It has
 * to cover the four things that keep people alive — crop, water, generation,
 * air — with somewhere to sleep and eat, and no generator can afford to depend
 * on which way a modulus fell.
 *
 * These are the only rooms in the silo that are NOT derelict. The building is
 * abandoned; these three floors are where the twenty people who are left have
 * been keeping the lights on, and they are worn rather than dead — which makes
 * the first thing a new mayor can usefully do a repair on something they can
 * already see working, rather than a purchase from a menu.
 */
const OPENING = {
  // Home. Nothing here needs crewing — beds and cupboards are passive — so the
  // level a new mayor looks at first asks nothing of them.
  // Home, and nothing on it needs crewing: beds and cupboards are passive, so
  // the level a new mayor looks at first asks nothing of them.
  1: [
    { type: 'residences', slot: 0, width: 3 },
    { type: 'storage_depot', slot: 3, width: 3 },
  ],
  // What is eaten and drunk.
  2: [
    { type: 'hydroponics', slot: 0, width: 2 },
    { type: 'water_reclaimer', slot: 2, width: 1 },
    { type: 'storage_depot', slot: 3, width: 2 },
    { type: 'residences', slot: 5, width: 1 },
  ],
  // What keeps it running and breathable.
  3: [
    { type: 'generator_hall', slot: 0, width: 2 },
    { type: 'air_filtration', slot: 2, width: 1 },
    { type: 'storage_depot', slot: 3, width: 2 },
    { type: 'residences', slot: 5, width: 1 },
  ],
};

/**
 * The first seven seals, which are the tutorial.
 *
 * Everything below floor 10 is generated, and generating the first levels a
 * player ever opens was measured as unplayable twice over. `pick` chooses from
 * a list that is written best-first and ignores the ordering, so which rooms
 * are within reach of a twenty-person silo is a lottery: before the hash was
 * fixed the first Recycling Plant on the plan stood on floor 23 and the first
 * Workshop on 31, and fixing the hash moved salvage to 47. Scrap and parts are
 * what every dig, every repair and every restoration is priced in. A silo that
 * cannot reach either is dead in eleven weeks whatever the player does, and
 * nothing on screen ever says why.
 *
 * So these seven are authored, for the same reason floors 1 to 3 are, and they
 * are authored to teach in order: the spine that keeps people alive, then the
 * crop and the clinic, then the door to the surface, then the two rooms the
 * economy is denominated in, then somewhere to live, then power, then the
 * bench. Read down them and you are reading what a silo needs, which is the
 * one thing the old build catalogue did say and this had stopped saying.
 *
 * Still derelict, still priced, still yours only when you pay for them — this
 * decides what is behind the seal, not whether you can afford it. Below floor
 * 10 the plan goes back to being generated, by which point the silo has an
 * income and can absorb a level that turns out to be four bays of munitions.
 */
const NEAR = {
  // Air and water, doubled. The opening runs one of each and both are the
  // first things a growing silo runs out of.
  4: [{ type: 'air_filtration', width: 2 }, { type: 'water_reclaimer', width: 2 }],
  // What is eaten, and who patches you up.
  5: [{ type: 'hydroponics', width: 3 }, { type: 'clinic', width: 1 }],
  // The door. Nothing on the surface is reachable without both of these, and
  // this is the level the whole outside half of the game is behind.
  6: [{ type: 'airlock', width: 2 }, { type: 'suit_bay', width: 2 }],
  // THE ECONOMY. Salvage, parts and the bay that keeps the building standing,
  // seven levels down — the one level on this list that is not optional, and
  // the reason the Uppers carry a Machine Level at all.
  //
  // The Maintenance Bay is here because decay is what actually kills an
  // untouched silo and nothing in reach answered it. A crew walks the floors
  // restoring `maintenanceRestorePerCyclePerCrew` to each of the six worst
  // rooms, which at two mechanics is about seven condition a day per room
  // against a working decay of under one — so one bay maintains the whole
  // opening, and it was standing on floor 23 at the nearest. Measured with
  // nobody able to reach it: an untouched silo's rooms fall from 62 condition
  // to 25 by day 50 and 14 by day 100, generation reaches zero, the air follows
  // it, and everybody suffocates around day 110 with 660 scrap in the bank.
  7: [
    { type: 'recycling', width: 2 },
    { type: 'workshop', width: 2 },
  ],
  // Where the people the silo is about to have will live and eat.
  8: [{ type: 'cafeteria', width: 2 }, { type: 'residences', width: 2 }],
  // Power, which is what everything above becomes once it is switched on.
  9: [{ type: 'generator_hall', width: 3 }, { type: 'air_filtration', width: 1 }],
  // And the bench, which is every floor below this one.
  10: [{ type: 'laboratory', width: 2 }, { type: 'chem_lab', width: 2 }],
};

/** Is this one of the levels the silo starts alive on? */
export function isOpeningLevel(n) {
  return Object.prototype.hasOwnProperty.call(OPENING, n);
}

/**
 * Deterministic, and deliberately not a seeded stream.
 *
 * A level's contents are a fact about the building rather than about the save.
 * The brief's rule is that all randomness goes through `streamFor`, and this is
 * not randomness: two players who open floor 96 have to find the same foundry,
 * or the panel that shows them what is down there before they pay is lying.
 */
function pick(list, n, salt) {
  return list[hash(n, salt) % list.length];
}

/**
 * The same lesson `splitFor` already learned, applied where it was still wrong.
 *
 * This was `(n * 7 + salt * 13) % list.length`, and the production fittings
 * list has exactly seven entries — so `n * 7 % 7` is zero for every floor in
 * the silo and the pick did not depend on the floor number at all. Every
 * Machine Level in the game drew from the same four-long walk of salts.
 *
 * Measured: floor 7 came out `munitions, munitions, munitions, foundry` and
 * floor 17 came out four bays of munitions, while `workshop` and `recycling` —
 * the first two entries in the list, the two rooms every other price in the
 * game is denominated in — stood on no level above floor 23. A hash has no
 * such structure, and the same call now returns a Recycling Plant and a
 * Workshop on floor 7.
 */
function hash(n, salt) {
  let h = 2166136261;
  h ^= n;
  h = Math.imul(h, 16777619);
  h ^= salt + 0x9e37;
  h = Math.imul(h, 16777619);
  return h >>> 0;
}

/**
 * How wrecked a level is when the seal comes off.
 *
 * Everything arrives below `silo.repair.commissionBelow`, so nothing behind a
 * seal can be mistaken for a room that works. Deeper is worse: the seals
 * nearest the Foundations are the ones that most needed sealing, which is what
 * sim/dig.js has always said about depth and what makes a deep level a decision
 * rather than a shopping trip.
 */
function conditionAt(n, salt) {
  const D = BAL.silo.derelict;
  const depth = Math.min(1, (n - 1) / Math.max(1, BAL.silo.totalFloors - 1));
  const band = D.conditionTop - (D.conditionTop - D.conditionDeep) * depth;
  // A few points of spread inside the band, so a level is not six identical
  // numbers and the eye has something to sort on.
  return Math.max(D.conditionFloor, Math.round(band - ((n * 5 + salt * 11) % D.conditionSpread)));
}

/**
 * Every room standing on floor `n`, left to right.
 *
 * Rooms whose `tierGate` puts them below this floor are skipped rather than
 * substituted — a Reactor is on a Foundations level and nowhere else, which is
 * the whole reason to go down there.
 */
export function manifestFor(n) {
  if (OPENING[n]) {
    return OPENING[n].map((r) => ({
      ...r,
      level: 1,
      condition: BAL.silo.derelict.openingCondition,
      working: true,
    }));
  }

  const section = sectionFor(n);
  if (!section) return [];
  const tierRank = BAL.silo.tiers.findIndex((t) => n >= t.from && n <= t.to);

  // The authored levels, filled out the same way a generated one is: the fitted
  // bays are written down, the lodgers fall in behind them, and the condition
  // comes from the same depth curve so nothing about them reads as special.
  if (NEAR[n]) {
    const out = [];
    let slot = 0;
    let salt = 0;
    for (const r of NEAR[n]) {
      const def = getRoom(r.type);
      if (!def) continue;
      const width = Math.max(1, Math.min(r.width, maxWidthOn(n, def)));
      out.push({
        type: r.type, slot, width,
        level: 1 + ((n + salt) % BAL.silo.derelict.maxFoundLevel),
        condition: conditionAt(n, salt),
      });
      slot += width;
      salt++;
    }
    while (slot < BAL.silo.slotsPerFloor) {
      out.push({ type: pick(LODGERS, n, salt), slot, width: 1, level: 1, condition: conditionAt(n, salt) });
      slot++;
      salt++;
    }
    return out;
  }
  const allowed = (id) => {
    const def = getRoom(id);
    if (!def) return false;
    if (!def.tierGate) return true;
    return BAL.silo.tiers.findIndex((t) => t.key === def.tierGate) <= tierRank;
  };

  const fitted = (FITTINGS[section.key] || []).filter(allowed);
  const lodgers = LODGERS.filter(allowed);
  if (!fitted.length || !lodgers.length) return [];

  const W = BAL.silo.slotsPerFloor;
  const fittedBays = W - BAL.silo.derelict.lodgerBays;
  const split = splitFor(n).filter((w) => w <= fittedBays);

  const out = [];
  let slot = 0;
  let salt = 0;
  for (const want of split) {
    if (slot >= fittedBays) break;
    const id = pick(fitted, n, salt);
    const def = getRoom(id);
    if (!def) break;
    // Never wider than the level would carry — `maxWidthOn` is the same
    // ceiling the merge rule uses, so the level's own kind of work is the only
    // thing on it that ever runs four bays across.
    const width = Math.max(1, Math.min(want, maxWidthOn(n, def), fittedBays - slot));
    out.push({ type: id, slot, width, level: 1 + ((n + salt) % BAL.silo.derelict.maxFoundLevel), condition: conditionAt(n, salt) });
    slot += width;
    salt++;
  }
  while (slot < W) {
    const id = pick(lodgers, n, salt);
    out.push({ type: id, slot, width: 1, level: 1, condition: conditionAt(n, salt) });
    slot++;
    salt++;
  }
  return out;
}

export default { sectionFor, suitsSection, maxWidthOn, manifestFor, isOpeningLevel, SECTION_NAMES };
