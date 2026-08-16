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
import { CATEGORIES } from './rooms.js';

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
  // Where the silo was lived in. Nothing is made up here and the artifact
  // tables agree — sim/dig.js weights caches to zero in the Uppers.
  upper: ['civic', 'life', 'life', 'life', 'life', 'surface', 'civic', 'storage', 'life', 'science'],
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

export default { sectionFor, suitsSection, maxWidthOn, SECTION_NAMES };
