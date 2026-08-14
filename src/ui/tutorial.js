/**
 * tutorial.js — the guided first session.
 *
 * The handover note used to be the whole tutorial: seven screens of prose, and
 * then the player was on their own in front of nine panels. This replaces most
 * of it. The silo now points at the control it wants, says one sentence about
 * it, and waits — and nothing advances until the player actually does the
 * thing. Steps live in `data/tutorial.js`; this file is only the machinery.
 *
 * Five rules it is built around:
 *
 *   1. It never intercepts a tap. The whole overlay is `pointer-events: none`
 *      except the Skip button, so every step is completed on the real control,
 *      not on a copy of it drawn over the top. A guide that eats input is a
 *      guide that has to be got out of the way, and a player who wants to
 *      ignore it can simply play.
 *   2. It advances on evidence, never on a timer. A step finishes when a
 *      pointer press-and-release lands on the target, or when a predicate on
 *      game state says the thing is done — a room now standing, a panel now
 *      open. That is also what makes it honest about the game's own pace: a
 *      building takes shifts, and the guide does not pretend otherwise.
 *   3. It re-anchors every frame. Panels rebuild themselves twice a second and
 *      replace every node in them, the cross-section scrolls, and the phone
 *      rotates; the spotlight is recomputed from the target's live rect rather
 *      than positioned once and trusted.
 *   4. It follows the player back. Cancelling a placement or closing a panel
 *      undoes the step before it, so the guide steps back too rather than
 *      pointing at a control that is no longer there.
 *   5. It never covers what it is talking about. The chrome in `KEEP_CLEAR` —
 *      the clock, the counters, the standing order and the shift report — is a
 *      floor the card sits under, not space it may borrow. Half the guide
 *      points at a target that is most of the screen, and "outside" a target
 *      that tall is the chrome.
 *
 * The current step index is persisted in `flags.tutorialStep`, so a reload in
 * the middle resumes in the middle; -1 means finished or skipped, and is never
 * shown again — except from Settings ⚙, which sets it back to 0. A run started
 * with `persist: false` writes no flag at all: that is the one-card alert
 * coach, which is offered in memory and only to somebody who has just finished
 * the guide. Sodium amber throughout — toxin green means radiation in this
 * game and nothing else, least of all "look here".
 */

import { el } from './dom.js';
import { TUTORIAL } from '../data/tutorial.js';
import { topDirective } from '../sim/directives.js';

/** Persisted step index meaning "finished or skipped; never again". */
export const TUTORIAL_DONE = -1;

/** Predicates and target lookups are cheap but not free; 10Hz is plenty. */
const EVAL_MS = 96;
/**
 * How long a step is safe from its own `back` rule after being entered. A tap
 * completes on pointerup and the click that opens the panel lands after it, so
 * without this a slow press would step forward and immediately back again.
 */
const BACK_GRACE_MS = 800;
/** A press that travels further than this was a drag, not a tap. */
const TAP_SLOP = 12;
/** Attempts to scroll a step's control into view, per step. See `resolve`. */
const SCROLL_TRIES = 4;

const GAP = 10; // between the spotlight and the card
const EDGE = 8; // between the card and the edge of the screen
const BOTTOM_SAFE = 62; // the navbar, plus air — the card never sits on it

/**
 * Chrome the card is never allowed to sit on.
 *
 * This is not politeness. The first step of the guide targets `#stage`, which
 * is 634px of a 844px screen: there is no room outside it on either side, and
 * the card used to resolve that by going "above" — which on a full-height
 * target is not empty space, it is the clock, the counters and the standing
 * order. Measured on the first frame of a new game, the card covered 79% of
 * `#directive`, one screen after the cold open said "there is a standing order
 * across the top of the screen".
 *
 * The target of the current step is exempt — a card pointing at the standing
 * order is allowed to be near the standing order, and the geometry below puts
 * it under rather than over it anyway. That is also why `#resource-strip` is
 * named as well as the `#topbar` it sits in: a step that points at one counter
 * exempts the topbar, and the strip still has to be readable.
 */
const KEEP_CLEAR = ['#topbar', '#resource-strip', '#directive', '#change-line'];

/*
 * There used to be a `when` gate here: a step could declare that it was about
 * something not on screen yet, wait twelve seconds for it, and stand aside if
 * it never came. One step ever used it — the shift report — and waiting was
 * the wrong answer for it. The bar needs a shift that had something to report,
 * which for the room the guide has just had the player order means the shift
 * it comes online: measured, cycle 3, four and a half minutes at 1×. Twelve
 * seconds was never going to reach it and four minutes of a card on the screen
 * is not a guide. It is a one-card coach now (`REPORT_COACH`), fired the shift
 * the line first appears, so nothing here has to guess how long to wait.
 */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Start the guided session, or don't.
 *
 * @param {object} opts
 * @param {object} opts.store   the game store
 * @param {object} opts.shell   the UI shell (placement state, panels)
 * @param {object[]} [opts.steps]
 * @param {boolean} [opts.alreadySeen]  true when this save had already read the
 *        handover before this build existed. A silo on day 200 does not get
 *        ambushed with a spotlight.
 * @param {function} [opts.onPersist]  called when the guide ends, to flush the
 *        save. The step index goes into state on every step and rides out on
 *        the ordinary autosave; ending is the one transition that cannot wait
 *        for it, because a player who skips and closes the tab inside the
 *        thirty-second interval would be shown the whole thing again.
 * @param {boolean} [opts.persist]  false for a run that is not *the* first
 *        session — the one-card alert coach, which is armed in memory for the
 *        session the guide was finished in and writes no flag of its own.
 * @param {function} [opts.onEnd]  called with true when the last step was
 *        completed, false when the player skipped out of it.
 * @param {string} [opts.label]  the eyebrow on every card.
 * @returns {{stop: function}|null}
 */
export function startTutorial({
  store,
  shell,
  steps = TUTORIAL,
  alreadySeen = false,
  onPersist,
  persist = true,
  onEnd,
  label = 'First shift',
} = {}) {
  const root = document.getElementById('tutorial-root');
  if (!root || !store || !shell || !steps.length) return null;

  const saved = persist ? store.state.flags?.tutorialStep : null;
  if (persist) {
    if (saved === TUTORIAL_DONE) return null;
    // Nothing at all for a save that has already had its tutorial. The step
    // index is normally stamped by the migration; this is the belt for it.
    if (saved == null && alreadySeen) return null;
  }

  let index = Number.isInteger(saved) ? clamp(saved, 0, steps.length - 1) : 0;
  let alive = true;
  let raf = 0;
  let lastEval = 0;
  let lastTick = 0;
  let enteredAt = 0;
  let mark = null;
  let current = null; // the resolved target element
  let tapped = false;
  let scrollTries = 0;
  let press = null; // { x, y } of a pointerdown inside the target
  let lastCopy = '';
  let measured = null; // cached card size; re-taken when the copy or screen changes

  // ---- furniture ---------------------------------------------------------
  const pulse = el('i.tut-pulse');
  const spot = el('div.tut-spot', { 'aria-hidden': 'true' }, pulse);
  const caret = el('i.tut-caret');
  const eyebrow = el('div.tut-eyebrow');
  const copy = el('div.tut-copy');
  const dots = el(
    'div.tut-dots',
    steps.map(() => el('i'))
  );
  const skip = el(
    'button.tut-skip',
    // Pressing "Done" on the last step is finishing, not walking out of it.
    { type: 'button', onclick: () => finish(index === steps.length - 1) },
    'Skip'
  );
  const card = el(
    'div.tut-card',
    { role: 'status', 'aria-live': 'polite' },
    caret,
    eyebrow,
    copy,
    el('div.tut-foot', dots, skip)
  );
  root.replaceChildren(spot, card);
  root.hidden = false;

  // ---- completion by touch -----------------------------------------------
  // Capturing, because a control that stops propagation is still a control the
  // player pressed. Press-and-release rather than press alone: the click that
  // opens a panel lands a moment after pointerup, and a step that advanced on
  // pointerdown would judge the next one before that had happened.
  const onDown = (e) => {
    press = null;
    if (!steps[index]?.tap) return;
    if (inTarget(e.target)) press = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e) => {
    const start = press;
    press = null;
    if (!start || !inTarget(e.target)) return;
    // A drag across the cross-section is how you look at floor forty. It is
    // not a tap and must not read as one.
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) return;
    tapped = true;
  };
  const onCancel = () => {
    press = null;
  };
  const onResize = () => {
    measured = null;
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  enter(index, true);
  raf = requestAnimationFrame(tick);

  return { stop: () => finish(false), get index() { return index; } };

  // ---- the loop ----------------------------------------------------------

  function tick(t) {
    if (!alive) return;
    raf = requestAnimationFrame(tick);
    const dt = lastTick ? t - lastTick : 0;
    lastTick = t;

    // A report, a dialog or the ending owns the screen while it is up. Nothing
    // that happens behind one is an answer to the step in front of the player,
    // and one of them is actively misread: the returning-player report stops
    // the clock, which is precisely what the clock step watches for. That step
    // would complete unseen, and then hand the silo back at 1× from behind a
    // modal that had deliberately paused it. So the guide stops thinking, and
    // the time does not count against any step's grace period either.
    if (document.querySelector('.modal-scrim')) {
      enteredAt += dt;
      lastEval = t;
      anchor();
      return;
    }

    if (t - lastEval >= EVAL_MS) {
      lastEval = t;
      // A step change resolves a different target, so re-run once it has moved
      // rather than spending a frame pointing at the last step's control.
      for (let i = 0; i < 3 && alive && evaluate(t); i++);
    }
    if (alive) anchor();
  }

  /**
   * @returns {boolean} true when the step changed and wants re-evaluating.
   *
   * Wrapped, because everything inside is content: a step's predicates and
   * copy are written against a game that keeps changing shape, and a throw in
   * one of them would fire sixty times a second behind a guide the player
   * cannot see failing. A broken step reports itself once and gets out of the
   * way; the silo is not held up by its own tutorial.
   */
  function evaluate(now) {
    try {
      return evaluateStep(now);
    } catch (err) {
      console.warn('[tutorial] step "%s" failed; ending the guide.', steps[index]?.id, err);
      finish();
      return false;
    }
  }

  function evaluateStep(now) {
    const step = steps[index];
    if (!step) return false;
    const state = store.state;

    let directive;
    const ctx = {
      state,
      shell,
      mark,
      el: null,
      get directive() {
        if (directive === undefined) directive = safeDirective(state);
        return directive;
      },
    };
    current = resolve(step.target, ctx);
    ctx.el = current;

    if (tapped) {
      tapped = false;
      return complete(ctx);
    }
    // `done` before `back`, always: finishing a step and undoing the one before
    // it can look identical for an instant — placement ends both ways.
    if (step.done?.(ctx)) return complete(ctx);
    if (index > 0 && now - enteredAt > BACK_GRACE_MS && step.back?.(ctx)) {
      enter(index - 1);
      return true;
    }
    return paint(step, ctx);
  }

  /** Write the step's sentence, if it has changed. */
  function paint(step, ctx) {
    const text = typeof step.copy === 'function' ? step.copy(ctx) : step.copy;
    if (text !== lastCopy) {
      lastCopy = text;
      copy.textContent = text;
      measured = null;
    }
    return false;
  }

  function anchor() {
    // A dialog, a report or the ending owns the screen while it is up, and the
    // player has to deal with it before anything here means anything. Every one
    // of them lays a scrim over the game, so one query catches the lot.
    if (document.querySelector('.modal-scrim')) {
      if (!root.hidden) root.hidden = true;
      return;
    }
    if (root.hidden) root.hidden = false;

    if (!measured) measured = { w: card.offsetWidth, h: card.offsetHeight };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = visibleRect(current);
    // The top of the screen the card is allowed to use. Everything above it is
    // the chrome the guide is talking about, and one line of it is the standing
    // order the whole game hangs on.
    const ceiling = cardCeiling(current);
    const floorY = Math.max(ceiling, vh - BOTTOM_SAFE - measured.h);

    if (!rect) {
      // The control is gone or something is over it. Keep the instruction and
      // the way out on screen — a guide you cannot skip because its own target
      // is buried is a guide that has trapped you.
      spot.classList.add('off');
      caret.className = 'tut-caret off';
      place((vw - measured.w) / 2, floorY);
      return;
    }

    spot.classList.remove('off');
    setBox(spot, rect.left - 3, rect.top - 3, rect.width + 6, rect.height + 6);

    const prefer = steps[index]?.prefer === 'above' ? 'above' : 'below';
    const roomAbove = rect.top - ceiling - GAP;
    const roomBelow = vh - BOTTOM_SAFE - rect.bottom - GAP;
    let top;
    let side;
    if (prefer === 'above' ? roomAbove >= measured.h : roomBelow >= measured.h) {
      side = prefer;
    } else if (prefer === 'above' ? roomBelow >= measured.h : roomAbove >= measured.h) {
      side = prefer === 'above' ? 'below' : 'above';
    } else {
      side = 'inside';
    }
    if (side === 'above') top = rect.top - GAP - measured.h;
    else if (side === 'below') top = rect.bottom + GAP;
    // Nothing fits beside a target that is most of the screen — the silo, the
    // cross-section — so the card sits on the edge of it the step asked for,
    // which is the edge with nothing to point at on it. `ceiling` is what
    // stops that landing on the chrome instead: on a 390×844 phone the stage
    // starts directly under the standing order, so "above the stage" and "on
    // top of the order" are the same pixels.
    else top = prefer === 'above' ? rect.top + GAP : rect.bottom - GAP - measured.h;

    top = clamp(top, ceiling, floorY);
    const left = clamp(
      rect.left + rect.width / 2 - measured.w / 2,
      EDGE,
      Math.max(EDGE, vw - EDGE - measured.w)
    );
    place(left, top);

    if (side === 'inside') {
      caret.className = 'tut-caret off';
    } else {
      caret.className = 'tut-caret ' + (side === 'above' ? 'down' : 'up');
      caret.style.left = clamp(rect.left + rect.width / 2 - left, 14, measured.w - 14) + 'px';
    }
  }

  // ---- steps -------------------------------------------------------------

  function enter(n, initial = false) {
    index = n;
    enteredAt = performance.now();
    tapped = false;
    press = null;
    current = null;
    scrollTries = 0;
    lastCopy = '';
    measured = null;
    const step = steps[index];
    mark = step?.mark ? step.mark({ state: store.state, shell }) : null;
    // "1 of 1" is not a position, it is an apology. A single-card run — the
    // alert coach — says what it is and shows no dots.
    eyebrow.textContent =
      steps.length > 1 ? `${label} · ${index + 1} of ${steps.length}` : label;
    dots.hidden = steps.length < 2;
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === index));
    skip.textContent = index === steps.length - 1 ? 'Done' : 'Skip';
    // Written to state on every step, so a reload in the middle resumes in the
    // middle. Not flushed to disk here: forcing a write on every step means
    // the silo is saved at moments nothing else would have saved it, and the
    // autosave a few seconds later is what a mid-tutorial reload actually
    // wants — the last state the player was in, not the last one the guide
    // happened to notice.
    if (persist && (!initial || store.state.flags.tutorialStep !== index)) {
      store.dispatch({ type: 'FLAG_SET', flags: { tutorialStep: index } });
    }
  }

  /**
   * The step is done. `after` runs here and nowhere else — not on `back`, not
   * on skip — so a step that changed something on the player's behalf only
   * puts it back when the player actually finished the step.
   */
  function complete(ctx) {
    try {
      steps[index]?.after?.(ctx);
    } catch (err) {
      console.warn('[tutorial] step "%s" could not tidy up:', steps[index]?.id, err);
    }
    return advance();
  }

  function advance() {
    if (index + 1 >= steps.length) {
      finish(true);
      return false;
    }
    enter(index + 1);
    return true;
  }

  function finish(completed = false) {
    if (!alive) return;
    alive = false;
    cancelAnimationFrame(raf);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    root.replaceChildren();
    root.hidden = true;
    if (persist) {
      store.dispatch({ type: 'FLAG_SET', flags: { tutorialStep: TUTORIAL_DONE } });
      onPersist?.();
    }
    onEnd?.(completed);
  }

  // ---- geometry ----------------------------------------------------------

  function place(left, top) {
    setBox(card, left, top, null, null);
  }

  /**
   * The highest the card may sit: under everything in `KEEP_CLEAR` that is
   * currently on screen.
   *
   * Measured live rather than assumed, because all three of those elements
   * come and go — the standing order hides when there is nothing to order, the
   * shift report only exists once something has changed — and a constant would
   * be wrong on the frame either of them appeared.
   *
   * A step is allowed under its own target: the target is what the player is
   * being sent to, and the geometry above always puts the card on the far side
   * of it in any case.
   */
  function cardCeiling(target) {
    let top = EDGE;
    for (const sel of KEEP_CLEAR) {
      const node = document.querySelector(sel);
      if (!node || node.hidden || !node.getClientRects().length) continue;
      if (target && (node === target || node.contains(target) || target.contains(node))) continue;
      top = Math.max(top, node.getBoundingClientRect().bottom + GAP);
    }
    return top;
  }

  /**
   * The target's rect, or null when there is nothing to point at.
   *
   * "Nothing to point at" includes being covered: a panel is absolutely
   * positioned over the cross-section, so the element is still there, still
   * measurable, and completely invisible. Asking the document what is actually
   * at that point is the only answer that survives that.
   */
  function visibleRect(node) {
    if (!node || !node.isConnected) return null;
    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) {
      return null;
    }
    const x = clamp(r.left + r.width / 2, 1, window.innerWidth - 1);
    const y = clamp(r.top + r.height / 2, 1, window.innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === node || node.contains(hit))) return null;
    return r;
  }

  function resolve(target, ctx) {
    try {
      const node = typeof target === 'function' ? target(ctx) : document.querySelector(target);
      // Bring it into view if it isn't. Measured with `visibleRect` rather than
      // against the viewport, because the catalogue row this most often points
      // at is clipped by the panel's own scroller long before it leaves the
      // screen — by the viewport's reckoning it was visible the whole time.
      //
      // A handful of attempts on entering the step, and then it stops. A guide
      // that kept scrolling the list back would be taking the panel off the
      // player every time they looked at something else in it.
      if (node && scrollTries < SCROLL_TRIES && !visibleRect(node)) {
        scrollTries++;
        node.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      return node || null;
    } catch (err) {
      console.warn('[tutorial] could not resolve a target:', err);
      return null;
    }
  }

  /**
   * Is this node the step's target, or inside it?
   *
   * Asked of the selector as well as of the resolved element, because panels
   * rebuild themselves twice a second and replace every node in them — the
   * element resolved a moment ago can be detached by the time the finger lands
   * on the one that took its place. Same control, same lesson.
   */
  function inTarget(node) {
    if (!node) return false;
    if (current?.isConnected && (current === node || current.contains(node))) return true;
    const target = steps[index]?.target;
    return typeof target === 'string' && !!node.closest?.(target);
  }

}

/** The live standing order, or null. Never allowed to break the guide. */
function safeDirective(state) {
  try {
    return topDirective(state);
  } catch {
    return null;
  }
}

/** Write geometry only when it has actually moved — this runs every frame. */
function setBox(node, x, y, w, h) {
  const last = node.__box || (node.__box = {});
  if (last.x !== x) node.style.left = (last.x = x) + 'px';
  if (last.y !== y) node.style.top = (last.y = y) + 'px';
  if (w != null && last.w !== w) node.style.width = (last.w = w) + 'px';
  if (h != null && last.h !== h) node.style.height = (last.h = h) + 'px';
}

export default startTutorial;
