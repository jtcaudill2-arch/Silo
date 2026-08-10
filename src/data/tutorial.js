/**
 * tutorial.js — the guided first session, as content.
 *
 * Eight steps, each one a real control and a real consequence. Nothing here
 * simulates the game or narrates it: every step points at something that is
 * already on the screen, says one sentence about it, and waits. The engine in
 * `ui/tutorial.js` owns the spotlight, the anchoring and the persistence; this
 * file owns what is taught and in what order.
 *
 * The order is the first session, in the order a competent mayor would do it:
 * look at the silo, notice the clock is running, read the standing order, do
 * what it says, crew what you built, and know what tomorrow looks like. The
 * standing order (sim/directives.js) is the thread the whole game hangs on, so
 * three of the eight steps exist to teach the player to read it and follow it
 * rather than to teach any particular building.
 *
 * The voice is the silo's: administrative, specific, second person, and never
 * congratulatory. Nothing here says "great job" because nothing in this game
 * ever does.
 *
 * Step shape — all of it optional except `target` and `copy`:
 *
 *   target   CSS selector, or (ctx) => Element|null when the control has to be
 *            found by what it says rather than by what it is.
 *   copy     one sentence, or (ctx) => string when it has to name a real room.
 *   prefer   'above' | 'below' — which side of the target the card wants. A
 *            target too tall to sit outside of gets the card on that inside
 *            edge instead.
 *   tap      true: a real pointer press-and-release on the target completes it.
 *   done     (ctx) => boolean, a predicate on game state. Checked before `back`.
 *   back     (ctx) => boolean, true when the player has undone the step before
 *            it — cancelling a placement, closing a panel — and the guide
 *            should follow them back rather than point at nothing.
 *   mark     (ctx) => any, captured when the step is entered and handed back as
 *            `ctx.mark`, for steps that mean "more of this than there was".
 *
 * `ctx` is { state, shell, el, mark, directive } — `directive` is the live top
 * standing order, computed once per evaluation.
 */

import { BAL } from '../config/balance.js';
import { getRoom } from './rooms.js';
import { employmentSummary } from '../sim/jobs.js';

/** How many floors are open. Read, never remembered: the player digs more. */
const dugFloors = (state) => state.silo.floors.filter((f) => f.excavated).length;

/**
 * Bays with something in them. The completion test for "put it somewhere" has
 * to count this rather than rooms, because placing a room against a matching
 * neighbour widens that room instead of creating one — same tap, same cost,
 * same lesson, and a room count that never moves.
 */
const occupiedBays = (state) =>
  state.silo.floors.reduce((n, f) => n + f.slots.filter((s) => s != null).length, 0);

/** The name on a catalogue row, so the copy and the ring can never disagree. */
const rowName = (el) => el?.querySelector('.build-name')?.textContent || null;

/**
 * Is this panel actually open?
 *
 * `ui.view` alone is not that. It is persisted, and the shell does not reopen
 * a panel on boot, so a save closed with Construction on top comes back
 * reading `view: 'build'` with nothing on screen. A step that trusted it would
 * complete against a panel that isn't there — and the step after would step
 * straight back, forever. The host element is the honest answer.
 */
const showing = (state, view) =>
  state.ui.view === view && document.getElementById('panel-host')?.hidden === false;

/**
 * The catalogue row for the room the standing order asked for.
 *
 * Falls back to the first row that can actually be built. An order the silo
 * cannot pay for is already demoted by directives.js, but a spotlight on a
 * disabled button is a dead end no matter how it got there.
 */
function orderedBuildRow({ directive }) {
  const rows = [...document.querySelectorAll('.build-row')];
  const open = rows.filter((r) => !r.classList.contains('locked') && !r.disabled);
  // Matched on the room definition's own name rather than on the order's
  // wording: the order for a Recycling plant reads "Build a Recycling plant"
  // and the catalogue row says "Recycling".
  const wanted = directive?.room ? getRoom(directive.room)?.name : null;
  if (wanted) {
    const hit = open.find((r) => rowName(r) === wanted);
    if (hit) return hit;
  }
  return open[0] || null;
}

/** @type {object[]} */
export const TUTORIAL = [
  {
    id: 'silo',
    target: '#stage',
    prefer: 'below',
    tap: true,
    copy: ({ state }) =>
      `Silo 12 in section: ${dugFloors(state)} floors dug of ${BAL.silo.totalFloors}, ` +
      `${state.citizenIds.length} people inside. Tap a floor to look at it.`,
  },
  {
    id: 'clock',
    target: '#btn-speed',
    prefer: 'below',
    tap: true,
    // Space bar pauses too, and a player who finds that has learned the step.
    done: ({ state }) => (state.settings.speed ?? 1) !== 1,
    copy: 'A shift is a minute of real time and the silo runs whether you are watching — this is the pace, and the stop.',
  },
  {
    id: 'order',
    target: '#directive',
    prefer: 'below',
    tap: true,
    // Reaching Construction any other way is the same lesson learned sideways.
    done: ({ state }) => showing(state, 'build'),
    copy: 'The standing order is the one thing most worth doing next, recomputed from the silo every shift. Tap it.',
  },
  {
    id: 'pick',
    target: orderedBuildRow,
    prefer: 'below',
    done: ({ shell }) => !!shell.placement,
    // No catalogue on screen and nothing being placed: the player closed the
    // panel, or reopened the game with it shut. Go back and ask for it again
    // rather than ring a row that is not there.
    back: ({ el, shell }) => !el && !shell.placement,
    copy: ({ el }) =>
      `Pick the ${rowName(el) || 'room the order named'} — the catalogue is every room the silo knows, ` +
      'and the order named that one.',
  },
  {
    id: 'place',
    target: '#stage',
    prefer: 'above',
    mark: ({ state }) => occupiedBays(state),
    done: ({ state, mark }) => occupiedBays(state) > mark,
    back: ({ shell }) => !shell.placement,
    copy: ({ shell }) =>
      `Every bay that could take ${
        shell.placement ? `a ${shell.placement.def.name}` : 'it'
      } is lit. Tap one — that is where it gets built.`,
  },
  {
    id: 'roster',
    target: '.nav-btn[data-panel="population"]',
    prefer: 'above',
    done: ({ state }) => showing(state, 'population'),
    copy: 'A room comes up empty and produces nothing at all until somebody is posted to it. Open the roster.',
  },
  {
    id: 'crew',
    target: '.roster-controls .btn',
    prefer: 'below',
    tap: true,
    back: ({ el }) => !el,
    // A post on a bay still going up counts as open, so the room ordered two
    // steps ago is usually already asking for people. Read it rather than
    // assert it: the room the standing order names is not always the same one,
    // and a tutorial that says "two" when the panel says four is worse than
    // one that says nothing.
    copy: ({ state }) => {
      const open = employmentSummary(state).open;
      return open > 0
        ? `Auto-assign posts people by skill, and ${open} post${open === 1 ? ' is' : 's are'} ` +
            'standing empty right now. Tap it.'
        : 'Auto-assign posts people by skill to every empty room — the bay you just ordered will ' +
            'want it the day it comes online. Tap it.';
    },
  },
  {
    id: 'tomorrow',
    target: '.panel-close',
    prefer: 'below',
    // There is no close button because there is nothing left open: done.
    done: ({ el }) => !el,
    copy: 'Close this. The silo keeps running with the tab shut, and there will be a report and a fresh standing order when you come back.',
  },
];

export default TUTORIAL;
