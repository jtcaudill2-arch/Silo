/**
 * tutorial.js — the guided first session, as content.
 *
 * Ten steps, each one a real control and a real consequence. Nothing here
 * simulates the game or narrates it: every step points at something that is
 * already on the screen, says one sentence about it, and waits. The engine in
 * `ui/tutorial.js` owns the spotlight, the anchoring and the persistence; this
 * file owns what is taught and in what order.
 *
 * The order is the first session, in the order a competent mayor would do it:
 * look at the silo, notice the clock is running, read the standing order, do
 * what it says, see what it cost, crew what you built, and know what tomorrow
 * looks like. The standing order (sim/directives.js) is the thread the whole
 * game hangs on, so three of the steps exist to teach the player to read it and
 * follow it rather than to teach any particular building.
 *
 * Three surfaces answer questions rather than give orders: a counter opened
 * onto its own arithmetic, the shift report under the standing order, and an
 * alert card. Those were built and then never mentioned, which is the same as
 * not having built them. The counter is a step of the guide because a counter
 * is always there; the other two are one-card coaches below, fired the first
 * time each thing actually happens, because neither exists to point at on the
 * first morning.
 *
 * The voice is the silo's: administrative, specific, second person, and never
 * congratulatory. Nothing here says "great job" because nothing in this game
 * ever does.
 *
 * One name per thing, and it is the name the screen already uses: the room
 * definition's own name for a room, the label on the button for a panel. The
 * guide is read two inches under the controls it is describing and cannot
 * afford a second vocabulary.
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
 *   after    (ctx) => void, run once when the step is completed — never on the
 *            way back and never on a skip. For a step that moved something on
 *            the player's behalf and has to put it back.
 *
 * `ctx` is { state, shell, el, mark, directive } — `directive` is the live top
 * standing order, computed once per evaluation.
 */

import { BAL } from '../config/balance.js';
import { getRoom } from './rooms.js';
import { employmentSummary } from '../sim/jobs.js';

/**
 * How long a shift actually is, in real seconds.
 *
 * Derived, not written down. Three separate places used to assert that a shift
 * was a minute; `TICKS_PER_CYCLE` had been raised to 90 to give the player time
 * to read a shift before the next one landed, and none of the prose moved with
 * it. A figure the player can time with a wristwatch is not a figure to keep a
 * second copy of.
 */
export const SHIFT_SECONDS = Math.round(
  (BAL.time.TICKS_PER_CYCLE * BAL.time.TICK_MS) / 1000
);

/** The speed the silo runs at when nobody has touched the clock. */
const DEFAULT_SPEED = 1;

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

/** On screen at all — not merely present, which the shift report always is. */
const onScreen = (node) => !!node && !node.hidden && node.getClientRects().length > 0;

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

/**
 * A counter worth opening. Food if it is on the strip, because food is the one
 * with people on both sides of the sum; otherwise whatever is showing.
 */
function liveCounter() {
  const strip = document.getElementById('resource-strip');
  if (!strip) return null;
  const shown = [...strip.querySelectorAll('.res')].filter(onScreen);
  return shown.find((n) => n.dataset.res === 'food') || shown[0] || null;
}

/** @type {object[]} */
export const TUTORIAL = [
  {
    id: 'silo',
    target: '#stage',
    prefer: 'below',
    tap: true,
    copy: ({ state }) =>
      `Silo 12 in section: ${dugFloors(state)} levels lit of ${BAL.silo.totalFloors}, ` +
      `${state.citizenIds.length} people inside. Tap a floor to look at it.`,
  },
  {
    id: 'clock',
    target: '#btn-speed',
    prefer: 'below',
    tap: true,
    // Space bar pauses too, and a player who finds that has learned the step.
    done: ({ state }) => (state.settings.speed ?? DEFAULT_SPEED) !== DEFAULT_SPEED,
    // And then it is put back. A tap on this button goes to 2×, so a player who
    // followed the guide exactly used to finish their first session at double
    // speed without ever having been told they were. The copy says what the
    // button does and what the guide does; `after` does it.
    after: ({ shell }) => shell.setSpeed(DEFAULT_SPEED),
    copy:
      `A shift is ${SHIFT_SECONDS} seconds of real time and the silo runs whether you are ` +
      'watching. Tap the clock: 2×, 4×, then ❙❙ for the stop. It goes back to 1× ' +
      'before the next step.',
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
      `Pick ${rowName(el) || 'the room the order named'} — the catalogue is every room the ` +
      'silo knows, and the order named that one.',
  },
  {
    id: 'place',
    target: '#stage',
    prefer: 'above',
    mark: ({ state }) => occupiedBays(state),
    done: ({ state, mark }) => occupiedBays(state) > mark,
    back: ({ shell }) => !shell.placement,
    copy: ({ shell }) =>
      `${shell.placement ? shell.placement.def.name : 'The room'} needs a bay, and every one ` +
      'that could take it is lit. Tap one — that is where it gets built.',
  },
  {
    id: 'counter',
    target: liveCounter,
    prefer: 'below',
    tap: true,
    done: ({ state }) => showing(state, 'resources'),
    // The build just spent scrap, so at least one counter has visibly moved and
    // the question "where did that go" is already in the player's head.
    copy: ({ el }) =>
      `That cost something. Every counter opens onto its own arithmetic — tap ` +
      `${el?.querySelector('.res-label')?.textContent || 'one'} for what makes it, what ` +
      'spends it, and what the net comes to.',
  },
  {
    id: 'roster',
    target: '.nav-btn[data-panel="population"]',
    prefer: 'above',
    done: ({ state }) => showing(state, 'population'),
    copy: 'A room comes up empty and produces nothing at all until somebody is posted to it. Open People.',
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

/**
 * The shift report, taught when there is a shift report.
 *
 * This was the tenth step of the guide and it could not work there. The bar
 * only exists once a shift has ended *with something to put in it*, and the
 * thing the guide has just had the player do — order a room — does not report
 * until that room comes online. Measured on a real first session: the card was
 * reached with `clock.cycle` at 0 and the line did not land until cycle 3, so
 * at 1× the guide spent its last twelve seconds saying "the silo files one
 * line here… Tap it" over an empty strip of screen with no ring under it, then
 * timed out. The final impression of the guided session was a sentence
 * pointing at nothing.
 *
 * Waiting longer is not the fix — three shifts is four and a half minutes at
 * 1×, and a card that sits on the screen that long has stopped being a guide.
 * So this uses the same shape as the alert coach below, for the same reason:
 * some things cannot be taught before they happen, and the honest moment to
 * say one sentence about the shift report is the shift it first appears.
 */
export const REPORT_COACH = [
  {
    id: 'report',
    target: '#change-line',
    prefer: 'below',
    tap: true,
    done: ({ state }) => showing(state, 'log'),
    copy:
      `That line is the shift report. Every ${SHIFT_SECONDS} seconds the silo files one: the ` +
      'loudest thing that changed, and a count of what is queued behind it. Tap it for the rest.',
  },
];

/**
 * The one card that is not part of the guide.
 *
 * Alerts are the fourth surface and the only one that cannot be taught in
 * advance, because there is nothing to point at until the silo has something to
 * interrupt you about. So this waits: `main.js` arms it when the guide is
 * finished and fires it on the first alert of that session. One card, once.
 */
export const ALERT_COACH = [
  {
    id: 'alert',
    target: () => document.querySelector('#alert-rail .alert'),
    prefer: 'below',
    tap: true,
    // The card expires on its own after a few seconds. When it goes, so does
    // this — there is no point ringing an empty corner of the screen.
    done: ({ el }) => !el,
    copy:
      'That card is the silo interrupting you: something that could not wait for the shift ' +
      'report. Tap it once for the reason it happened, again to go to the floor it happened on.',
  },
];

export default TUTORIAL;
