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
 * ---------------------------------------------------------------------------
 * THE ONE RULE: A GATE MAY NOT CLOSE.
 *
 * Every `earnedBy` below reads only state that never travels backwards — a
 * room that is standing, a research node that is finished, a counter that only
 * counts up. That is what makes a panel that has arrived stay arrived, and it
 * is enforced rather than asserted: `test/unlocks.mjs` drives the silo through
 * eight hundred days of a campaign that goes badly and fails if any gate ever
 * reads true and then false.
 *
 * It is enforced because it was broken. `policy` used to read
 * `order.value < 45` — and order is pulled toward
 * `order.driftToward`, 50, at a quarter of the gap a day. The gate sat *below*
 * the attractor, so every silo that crossed it was hauled back over the line
 * within two or three days and the Order panel vanished again:
 *
 *     order 41.0  unlocked=true
 *     day 1: 43.7 unlocked=true
 *     day 2: 45.7 unlocked=FALSE     <- the panel is gone, and stays gone
 *
 * Through the shell that is worse than it looks: the nav button disappears
 * while the panel is open, and `shell.js` only ever announces an unlock once,
 * so a later dip returns the panel with no announcement at all. A latch held in
 * state would have needed a save migration; none of this needs one, because
 * "has this silo had politics" has monotonic answers already sitting in the
 * save — see the `policy` entry.
 * ---------------------------------------------------------------------------
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
 *      one is behind a node it pays for. Lands on day one to three.
 *   2. World — Radio Range I. Seventy-five points and no prerequisites, which
 *      makes it the third-cheapest root in the tree behind Hydroponic Yield I
 *      (55) and Antibiotics (70), and the cheapest one that opens a panel. It
 *      needs nothing from outside, which is what puts it ahead of the
 *      surface.
 *   3. Surface — the suit, or the door. Ninety points of research for
 *      Env-Suit I, then 260 scrap, 30 parts and 14 alloy for the Airlock. The
 *      panel is a ladder of bands with the dose and the suit tier each one
 *      costs, and the whole research tree turns artifact-gated shortly after
 *      this, so it is the hinge of the early game rather than a branch off it.
 *   4. Squads — an Armory or Barracks, or a squad already standing. It lands
 *      after the surface because that is where the silo is told to go: the
 *      standing order asks for an Armory only once the Airlock and the Suit
 *      Bay are up (directives.js, weight 53).
 *   5. Order — politics, once the silo has some: a Sheriff's Office, a policy
 *      in force, an investigation open, a pattern of crime on the books, or
 *      enough funerals to be a subject. See the entry for the measurement.
 *
 * They arrive one at a time because each one is paid for out of the one
 * before it, not because this list forces a sequence. Nothing here is gated
 * on an earlier entry, deliberately: a player who puts up an Armory on the
 * first morning — it needs no research and the starting stores cover it —
 * gets the Squads panel on the first morning, and should. Hiding a panel
 * from somebody who has already bought the room it belongs to is the same
 * failure this module exists to fix, pointing the other way. The list is the
 * order the silo *expects* to reach them in, and the arrivals below are what
 * a competent player actually gets; a player who spends their first research
 * on Radio Range I rather than on Antibiotics has the World panel three weeks
 * earlier, and that is their decision to make, not this file's.
 *
 * Cross-checked against directives.js, which is the thing that actually tells
 * the player to do any of this. The invariant is that no standing order ever
 * points at a panel that is still shut:
 *
 *   - `research` (62), `ammo_research` (51) and `dig_research` (32) are the
 *     orders aimed at the Research panel. The first is guarded on a finished
 *     Laboratory; the second on `canStart(firearms_1)`, which cannot be true
 *     until a node has been completed, and nothing completes without a
 *     Laboratory. `dig_research` is guarded on neither — but while the silo
 *     has no Laboratory, directives.js always carries `laboratory` at 76, or
 *     36 once demoted for being unaffordable, or a promoted salvage order at
 *     best+1. All three outrank 32, so `dig_research` cannot reach the top
 *     slot before the panel opens.
 *   - `squad` (52) is guarded on an Armory, which is the Squads gate itself.
 *   - `airlock` (55) and `suit_bay` (54) open the *build* panel, and both are
 *     inside the Surface gate below rather than behind it.
 *   - `radio` (20) asks for the Radio Room and opens the *build* panel; by
 *     then the World panel has been open since the research landed, which is
 *     the right way round — the panel is where you find out there are
 *     nineteen other silos worth building a room to talk to.
 *   - Everything else points at build, population or log, none of which lock.
 *
 * Measured, not argued. `test/unlocks.mjs` drives the project's own autopilot
 * for a hundred and sixty days on three seeds and prints the day each panel
 * arrives; it fails if any gate ever closes, if Research is not first, if the
 * Surface panel does not land inside the first third, or if it is still
 * hostage to a finished Airlock. What it currently reports:
 *
 *     seed 0x1234   d3 Research  d26 Squads  d42 World    d45 Order   d49 Surface
 *     seed 0xbeef   d3 Research  d30 World   d32 Order    d37 Surface d47 Squads
 *     seed 0xd00d   d3 Research  d33 Squads  d45 World    d49 Order   d57 Surface
 *
 * Order is not last on any of the three, and the test deliberately does not
 * demand that it is. Order arriving third on 0xbeef is not the calendar
 * coming back: a murder was committed on day 32 of that silo and there is a
 * verdict waiting. A panel the player is *required* to use has to be there,
 * and the test asserts the thing that actually went wrong before — that no
 * value of `order.value`, on a silo with no crime, no case, no policy and no
 * sheriff, opens the panel.
 *
 * (The claim that used to sit here — that test/obedient.mjs had verified this
 * ordering over 400 days on three seeds — was not true of that file. It drives
 * a player who only follows standing orders and asserts that they survive; it
 * never looks at a panel. The ordering coverage is test/unlocks.mjs, above.)
 *
 * Pure: (state) -> data. No DOM, no dispatch, no mutation.
 */

import { BAL } from '../config/balance.js';
import { getRoom } from '../data/rooms.js';
import { inService } from './economy.js';

/** Is there a room of any of these types in the silo, finished or going up? */
// A seized room does not open a panel. The Armoury on floor 96 is standing
// there dark until it is paid for, and a Squads panel that arrives on the
// strength of a room the silo cannot use is a promise it has to take back.
const hasRoom = (state, ...types) =>
  Object.values(state.silo.rooms).some((r) => types.includes(r.type) && inService(r));

/** Has this node been finished? `research.completed` is append-only. */
const researched = (state, id) => (state.research.completed || []).includes(id);

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
     * is worth reading while the bay goes up. The trailing clause covers a
     * silo that has research to show and no bench standing — a lab lost to a
     * collapse should not take the record of what it discovered with it, and
     * `research.completed` is append-only, so once it is the reason the panel
     * is open it stays the reason.
     */
    earnedBy: (state) =>
      hasRoom(state, 'laboratory') || (state.research.completed || []).length > 0,
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
     *
     * `radioTier` is only ever raised, and the node behind it is named as a
     * second clause so the gate does not depend on that staying true.
     */
    earnedBy: (state) => (state.world.radioTier || 0) > 0 || researched(state, 'radio_range_1'),
    why: 'Research Radio Range I. Silo 12 has been listening for two generations; now you can transmit.',
  },
  {
    id: 'airlock',
    label: 'Surface',
    panel: 'airlock',
    /**
     * The suit or the door, whichever the silo reaches first.
     *
     * This used to be the door and only the door, and it made the hinge of the
     * early game the *last* thing to arrive: measured across three seeds of the
     * project's own autopilot, the Airlock went up on days 31, 70 and 62, and
     * on two of the three the Surface panel was the fifth and final unlock.
     * A game day is twelve real minutes, so that is twelve to fourteen hours
     * of real play before the screen that explains why any of the rest of it
     * matters.
     *
     * Env-Suit I is the honest earlier line. It is the first half of going
     * outside — the door is useless without it and directives.js asks for both
     * in the same breath (airlock 55, suit_bay 54) — and the panel is a ladder
     * of bands with the dose and the suit tier each one costs, so it is worth
     * reading from the day the silo starts paying for the chain rather than the
     * day it finishes. Same seeds, same runs: days 49, 37 and 57.
     *
     * Both clauses are monotonic: a finished research node is never unfinished,
     * and the Suit Bay is named alongside the Airlock so losing the door to a
     * collapse does not shut the ladder.
     */
    earnedBy: (state) =>
      hasRoom(state, 'airlock', 'suit_bay') || researched(state, 'env_suit_1'),
    why: 'Research Env-Suit I, then build an Airlock. Nothing leaves the silo without both.',
  },
  {
    id: 'military',
    label: 'Squads',
    panel: 'military',
    /**
     * Either bench that makes a standing army possible, or an army that
     * already exists. The squad clause is not redundant: squads survive the
     * armoury that raised them, and a silo with people outside must be able
     * to see them. `stats.expeditionsLaunched` is the third: it only counts
     * up, and a silo that has sent people to the surface has had a squad
     * whatever is left standing now.
     */
    earnedBy: (state) =>
      hasRoom(state, 'armory', 'barracks') ||
      state.military.squadIds.length > 0 ||
      (state.stats?.expeditionsLaunched || 0) > 0,
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
     * Two lines have been wrong here, in opposite directions, and it is worth
     * having both written down.
     *
     * `order.contentThreshold` — 55 — was a calendar. Order starts at 64 and
     * drifts toward 50, so it crossed 55 on day four or five of every silo
     * ever played and the Order panel arrived second, ahead of Research,
     * having been earned by nothing.
     *
     * a gate at 45 replaced it and was worse, because it
     * could close. It sits *under* the drift attractor, so a silo that crossed
     * it was pulled back above within two or three days and the panel it had
     * just been given disappeared, permanently and silently. That key is no
     * longer read by anything; see the note at the top of this file.
     *
     * What replaced it is the wreckage low order leaves behind, all of which
     * is already in the save and none of which is ever cleared:
     *
     *   - a Sheriff's Office (120 scrap, no research — anyone who wants the
     *     politics on the first morning can simply have it);
     *   - a policy in force;
     *   - an investigation, which reducers only ever unshift;
     *   - `order.crimes`, likewise: a pattern rather than a single incident,
     *     and crime scales with disorder (order.crime.orderScaling), so a
     *     badly run silo reaches it sooner;
     *   - `stats.deaths`, which is a counter, for the silo that is failing
     *     quietly rather than criminally.
     *
     * Measured on three autopilot seeds it first trips on days 45, 32 and 49 —
     * and the day-32 one is a murder with a verdict waiting, not a drift. It
     * never closes again on any of them, nor on a silo driven to order 18 and
     * left to recover, which is the run the old line could not survive.
     */
    earnedBy: (state) =>
      hasRoom(state, 'sheriffs_office') ||
      (state.order.policies || []).length > 0 ||
      (state.order.investigations || []).length > 0 ||
      (state.order.crimes || []).length >= BAL.wayfinding.orderCrimesBefore ||
      (state.stats?.deaths || 0) >= BAL.wayfinding.orderDeathsBefore,
    why: 'Nothing to govern yet. This opens when the silo starts having politics, or when you build a Sheriff’s Office.',
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
 * anybody lives. Deriving them from the rooms cuts it to exactly those four.
 * Fuel and filters make the clearest case for leaving one out: the opening
 * hall burns about 0.42 fuel a shift against a starting 260, and the
 * filtration bay 0.05 filters against 40 — seventy-eight days and a hundred
 * days of stock, on the first morning, with no building in the catalogue that
 * changes either number. A figure that cannot be acted on teaches the player
 * to stop reading the strip.
 *
 * The fuel figure is a measurement, not a rating, and it has to be: halls
 * throttle to the load now (economy.js, `plantPlan`), so what a hall burns
 * depends on what the silo is drawing that shift. The opening silo draws 36
 * against 50 of capacity, so its one hall runs at about three quarters and
 * burns about three quarters. This line used to say 0.65 — the old flat-out
 * figure — which overstated the burn by half again and made the runway look
 * shorter than it is.
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

export default {
  UNLOCKS,
  unlocked,
  lockReason,
  unlockedIds,
  newlyUnlocked,
  liveResourceKeys,
};
