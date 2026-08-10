/**
 * unlocks.js — the order the silo hands its systems over in.
 *
 * Nine panels and eleven resource counters on the first morning is the game
 * telling a new mayor that all of it is their problem simultaneously, which
 * is the same as telling them nothing. Most of the gating already existed —
 * what it did not have was one place that said in what order and on what
 * evidence, so five `locked()` functions drifted into five different files
 * and answered to five different ideas of when a system is ready. A gate you
 * cannot read in one sitting is a gate nobody can keep honest.
 *
 * This is that place. One ordered list: what arrives, what earns it, and the
 * sentence the silo says while it is still shut. The panels ask this module
 * now; they no longer decide.
 *
 * The order, and why it is this order:
 *
 *   0. Build, Residents, Resources, Log — always on. Feeding, watering and
 *      housing people is the whole of day one and each of those four is part
 *      of doing it. They are not in the list below because nothing gates
 *      them, and a silo that could lose the build panel is a silo that can
 *      be softlocked.
 *   1. Research — a Laboratory. Nothing else in the silo makes research
 *      points, it is the standing order the moment income is nominal
 *      (directives.js ranks it 76, above salvage), and every gate below this
 *      one is behind a node it pays for.
 *   2. World — Radio Range I. Seventy-five points and no prerequisites: the
 *      cheapest root in the tree and normally the first thing a first
 *      Laboratory buys. It needs nothing from outside, which is what puts it
 *      ahead of the surface.
 *   3. Surface — an Airlock. Ninety points of research for the suit, then 260
 *      scrap, 30 parts and 14 alloy for the door. The whole research tree
 *      turns artifact-gated shortly after this, so this is the hinge of the
 *      early game rather than a branch off it.
 *   4. Squads — an Armory or Barracks, or a squad already standing. It lands
 *      after the surface because that is where the silo is told to go: the
 *      standing order asks for an Armory only once the Airlock and the Suit
 *      Bay are up (directives.js, weight 53).
 *   5. Order — order in genuine trouble, an investigation open, a policy in
 *      force, or a Sheriff's Office built. This one was arriving second, on
 *      day five of every game, because its old line sat above the level
 *      order settles at on its own; see the entry below for the measurement.
 *      On a badly run silo it is now still exactly as early as it needs to
 *      be, and on a well run one it waits.
 *
 * They arrive one at a time because each one is paid for out of the one
 * before it, not because this list forces a sequence. Nothing here is gated
 * on an earlier entry, deliberately: a player who puts up an Armory on the
 * first morning — it needs no research and the starting stores cover it —
 * gets the Squads panel on the first morning, and should. Hiding a panel
 * from somebody who has already bought the room it belongs to is the same
 * failure this module exists to fix, pointing the other way.
 *
 * Cross-checked against directives.js, which is the thing that actually tells
 * the player to do any of this. The invariant is that no standing order ever
 * points at a panel that is still shut:
 *
 *   - `research` (62) and `dig_research` (32) are the only orders aimed at
 *     the Research panel. The first is guarded on a finished Laboratory. The
 *     second is not — but while the silo has no Laboratory, directives.js
 *     always carries `laboratory` at 76, or 36 once demoted for being
 *     unaffordable, or a promoted salvage order at best+1. All three outrank
 *     32, so `dig_research` cannot reach the top slot before the panel opens.
 *   - `squad` (52) is guarded on an Armory, which is the Squads gate itself.
 *   - `radio` (20) asks for the Radio Room and opens the *build* panel; by
 *     then the World panel has been open since the research landed, which is
 *     the right way round — the panel is where you find out there are
 *     nineteen other silos worth building a room to talk to.
 *   - Everything else points at build, population or log, none of which lock.
 *
 * Checked as well as argued: an obedient player — the test/obedient.mjs
 * driver, doing exactly what the standing order says and nothing else — was
 * run for 400 days on three seeds while every order was compared against the
 * panel it points at. No order ever pointed at a shut panel. That run also
 * says what the opening now looks like from the desk: four counters and four
 * panels on the first morning, the Research panel and the parts and fuel
 * counters on day one behind the Workshop and the Recycling plant the silo
 * itself asks for, filters around day sixty, and Order only when a silo
 * that is losing people has earned it.
 *
 * Pure: (state) -> data. No DOM, no dispatch, no mutation.
 */

import { BAL } from '../config/balance.js';
import { getRoom } from '../data/rooms.js';

/** Is there a room of any of these types in the silo, finished or going up? */
const hasRoom = (state, ...types) =>
  Object.values(state.silo.rooms).some((r) => types.includes(r.type));

/**
 * @typedef {object} Unlock
 * @property {string} id       stable key; also the panel it opens
 * @property {string} label    what the nav button will say once it is there
 * @property {string} panel    panel id to reveal
 * @property {(state: object) => boolean} earnedBy  has the silo earned it yet
 * @property {string} why      one sentence, shown while it is still shut
 */

/**
 * Every gated system, in the order the silo is expected to reach them.
 *
 * The `why` strings are the ones the panels have been showing all along. They
 * were the good part of the old arrangement: each names the specific thing to
 * go and do, so a locked button is a hint rather than a wall.
 *
 * @type {Unlock[]}
 */
export const UNLOCKS = [
  {
    id: 'research',
    label: 'Research',
    panel: 'research',
    /**
     * A Laboratory, counted from the moment it is ordered rather than the
     * moment it comes online. Six shifts of construction is a long time to
     * hold a panel back from somebody who has just spent 220 scrap on the
     * only building that produces the thing the panel is about, and the tree
     * is worth reading while the bay goes up. The two trailing clauses cover
     * a silo that has research to show and no bench standing — a lab lost to
     * a collapse should not take the record of what it discovered with it.
     */
    earnedBy: (state) =>
      hasRoom(state, 'laboratory') ||
      state.research.points > 0 ||
      state.research.completed.length > 0,
    why: 'Build a Laboratory first — nothing else in the silo produces research points.',
  },
  {
    id: 'radio',
    label: 'World',
    panel: 'radio',
    /**
     * Radio range, not the Radio Room. The room is scenery as far as the
     * simulation is concerned — world.js, the intel rolls and the events that
     * need an answer all read `world.radioTier`, which follows research and
     * nothing else. Gating the panel on the room would mean a silo that can
     * already hear a call to arms and has nowhere to answer it.
     */
    earnedBy: (state) => (state.world.radioTier || 0) > 0,
    why: 'Build a Radio Room. Silo 12 has been listening for two generations; now you can transmit.',
  },
  {
    id: 'airlock',
    label: 'Surface',
    panel: 'airlock',
    /**
     * The door itself, and only the door. The panel is a ladder of bands with
     * the dose and the suit tier each one costs, so it is worth reading from
     * the first day it exists even though the near ruins need tier-1 suits
     * and nothing goes out without a squad — that ladder is how a player
     * finds out what the surface will take.
     */
    earnedBy: (state) => hasRoom(state, 'airlock'),
    why: 'Build an Airlock first. Nothing leaves the silo without one.',
  },
  {
    id: 'military',
    label: 'Squads',
    panel: 'military',
    /**
     * Either bench that makes a standing army possible, or an army that
     * already exists. The squad clause is not redundant: squads survive the
     * armoury that raised them, and a silo with people outside must be able
     * to see them.
     */
    earnedBy: (state) =>
      hasRoom(state, 'armory', 'barracks') || state.military.squadIds.length > 0,
    why: 'Build an Armory or Barracks first.',
  },
  {
    id: 'policy',
    label: 'Order',
    panel: 'policy',
    /**
     * Politics arrives when there is politics. On a first morning of a silo
     * that is fed, housed and calm there is nothing here to decide, and a
     * panel with nothing in it is one more thing to work out before you can
     * start playing.
     *
     * The old line was `order.contentThreshold`, 55, and it did not mean
     * that. Order starts at 64 and decays toward 50, so it crossed 55 on day
     * five of every silo regardless of how it was run — measured at day 5 on
     * three separate seeds — and the Order panel arrived second, ahead of
     * Research, having been earned by nothing. `unlocks.orderTroubleBelow`
     * sits under the drift attractor instead, so crossing it takes deaths,
     * crowding or idle hands rather than a calendar. On the same seeds it
     * first trips on days 61, 75 and 83.
     *
     * The other three clauses are the doors the player opens deliberately.
     * A Sheriff's Office is 120 scrap and needs no research, so anyone who
     * wants the politics early can simply have it.
     */
    earnedBy: (state) =>
      state.order.value < BAL.unlocks.orderTroubleBelow ||
      (state.order.investigations || []).length > 0 ||
      (state.order.policies || []).length > 0 ||
      hasRoom(state, 'sheriffs_office'),
    why: 'Nothing to govern yet. This opens when order slips, or when you build a Sheriff’s Office.',
  },
];

const BY_ID = new Map(UNLOCKS.map((u) => [u.id, u]));

/** Has the silo earned this system? Unknown ids are ungated, not shut. */
export function unlocked(state, id) {
  const u = BY_ID.get(id);
  return u ? !!u.earnedBy(state) : true;
}

/**
 * The sentence to show while a system is still shut, or null once it isn't.
 * Shaped for `panel.locked(state)`, which is the only caller.
 */
export function lockReason(state, id) {
  const u = BY_ID.get(id);
  if (!u) return null;
  return u.earnedBy(state) ? null : u.why;
}

/** Ids of everything currently open, in list order. */
export function unlockedIds(state) {
  return UNLOCKS.filter((u) => u.earnedBy(state)).map((u) => u.id);
}

/**
 * What has opened between one look and the next, in list order — so a caller
 * that wants to announce an arrival can tell a new one from the ones it has
 * already announced.
 *
 * `prev` wants the *ids* from an earlier `unlockedIds()`, not an earlier
 * state. Reducers write in place, so a held reference to last frame's state is
 * this frame's state and would report that nothing has ever changed. A whole
 * state is accepted anyway, for a caller that genuinely holds a separate one,
 * and a missing baseline returns nothing at all: a save opened on a Thursday
 * should not announce five systems at once.
 *
 * @param {Set<string>|string[]|object|null} prev
 * @param {object} next  current state
 * @returns {Unlock[]}
 */
export function newlyUnlocked(prev, next) {
  if (prev == null) return [];
  const before =
    prev instanceof Set
      ? prev
      : Array.isArray(prev)
        ? new Set(prev)
        : new Set(unlockedIds(prev));
  return UNLOCKS.filter((u) => u.earnedBy(next) && !before.has(u.id));
}

// ------------------------------------------------------------- resources ---

/**
 * Always on the strip, even at zero.
 *
 * These four are the ones a decision is ever made about on the first morning,
 * and a counter that vanishes when it empties is worse than one that reads
 * zero. Everything else has to earn its place below.
 */
const CORE_RESOURCES = ['power', 'food', 'water', 'scrap'];

/**
 * Which counters the strip should carry.
 *
 * Eleven of them on the first morning — most reading a starting stock the
 * silo has no way to spend or replace for hours — is a good part of what
 * makes this look impenetrable, and it buries the four that decide whether
 * anybody lives. Deriving them from the rooms cut it to six; the two that
 * were left over, fuel and filters, are the two the opening silo consumes and
 * can do nothing about. A generator hall burns about 0.65 fuel a shift
 * against a starting 260, and a filtration bay about 0.11 filters against 40:
 * fifty days and forty-five days of stock, on the first morning, with no
 * building in the catalogue that changes either number. A figure that cannot
 * be acted on teaches the player to stop reading the strip.
 *
 * So a resource earns its counter three ways, and any one of them is enough:
 *
 *   - some room the player has built *makes* it — alloy arrives with the
 *     foundry, ammunition with the armoury, filters with the chem lab, and
 *     fuel with the first Recycling plant, which is also the first standing
 *     order the silo gives;
 *   - some room the player has built *spends* it at a rate worth watching,
 *     which is what puts fuel up once there is more than one generator hall;
 *   - or the stock left is inside `resourceRunwayDays` of that draw. That last
 *     one is the safety net, and it is why hiding fuel and filters is safe:
 *     whatever the player does or doesn't build, both appear well before they
 *     stop the generators and the scrubbers.
 *
 * Derived rather than remembered, so it survives a reload and never
 * disagrees with itself. Rebuilding the set on every paint is fine — it is a
 * walk of at most a few hundred rooms and it costs nothing next to the
 * repaint it feeds.
 *
 * @returns {Set<string>} resource keys the strip should show
 */
export function liveResourceKeys(state) {
  const live = new Set(CORE_RESOURCES);

  // Base rates, not the level- and staffing-scaled ones the economy charges.
  // The threshold is about whether the player has taken on a *kind* of
  // upkeep, not about this shift's throughput, and a counter that came and
  // went as a crew changed shift would be worse than either answer.
  const draw = {};
  for (const room of Object.values(state.silo.rooms)) {
    const def = getRoom(room.type);
    if (!def) continue;
    for (const k of Object.keys(def.produces || {})) live.add(k);
    for (const [k, v] of Object.entries(def.consumes || {})) {
      draw[k] = (draw[k] || 0) + v;
    }
  }
  for (const [k, v] of Object.entries(draw)) {
    if (v >= BAL.unlocks.resourceDrawPerCycle) live.add(k);
  }

  // Anything draining toward nothing, whoever is drinking it.
  //
  // Measured against the same base draw rather than against `state.flows`,
  // which is this shift's realised throughput and moves for reasons that have
  // nothing to do with whether the number is worth watching. A silo in a
  // brownout sheds rooms and picks them back up cycle by cycle; read from
  // flows, the fuel counter appeared on day 65, left on day 66, came back on
  // day 67. A counter that blinks during a collapse is noise laid over a
  // collapse. Base draw only changes when the player builds or loses a room.
  //
  // The cost of that is a conservative estimate — base rates ignore the
  // width, level and staffing scaling the economy actually charges, so the
  // real runway is roughly half what this reads. Deliberate: it makes the
  // safety net late rather than jumpy, and by the time a counter appears the
  // strip's own critical styling has something to say about it.
  const perDay = BAL.time.CYCLES_PER_DAY * BAL.unlocks.resourceRunwayDays;
  for (const [k, v] of Object.entries(draw)) {
    if (live.has(k) || v <= 0) continue;
    if ((state.resources[k] || 0) <= v * perDay) live.add(k);
  }

  // Chits are nobody's output — no room makes or burns them — so they need
  // their own rule. They start mattering when there is a soldier drawing a
  // stipend or somebody on the radio to trade with. Not on room level: the
  // silo you inherit already has rooms at level three.
  if (state.military.squadIds.length || (state.world.radioTier || 0) > 0) {
    live.add('chits');
  }

  return live;
}

export default { UNLOCKS, unlocked, lockReason, unlockedIds, newlyUnlocked, liveResourceKeys };
