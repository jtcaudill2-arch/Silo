/**
 * shell.js — the persistent chrome: resource bar, clock, navbar, panel host.
 *
 * Panels register themselves here. Each panel is a plain object with a
 * `render(state)` that returns a DOM node; the shell rebuilds the active one
 * when the store changes, throttled to animation frames so a burst of actions
 * costs one repaint, not fifty.
 *
 * It also owns placement mode — the half of construction that happens on the
 * cross-section rather than in a panel. See the placement section below.
 *
 * And it owns the four questions a player asks while watching a silo run,
 * because all four are answered by the chrome rather than by any one panel:
 *
 *   what just changed — the shift report under the standing order, and the
 *     flash on the counter that moved. One line per shift, not a firehose;
 *     the returning-player report covers absences, this covers the minute
 *     you looked away from the screen.
 *   why it happened   — every alert carries a sentence of cause, and every
 *     counter can be opened onto what produces it, what spends it and what
 *     the net is.
 *   what to do next   — the standing order carries the action itself, not
 *     just a description of it. Orders that mean "wait" carry no button, and
 *     orders the silo cannot pay for say what they are short of.
 *   where things are  — anything that names a room takes the cross-section
 *     to it: alerts, log entries, standing orders, the resource breakdown.
 */

import { BAL } from '../config/balance.js';
import { el, clear, fmt, fmtDelta, fmtClock, closeTopModal, button, chip, row, toast } from './dom.js';
import { on } from '../core/events.js';
import { topDirective } from '../sim/directives.js';
import { getRoom } from '../data/rooms.js';
import { setPlacement } from '../render/canvas.js';
import {
  allPlacements,
  canBuild,
  build,
  describeCost,
  canRepair,
  repair,
  canExcavate,
  startExcavation,
  canShore,
  shoreFloor,
} from '../sim/build.js';
import { autoAssign } from '../sim/jobs.js';
import { liveResourceKeys, newlyUnlocked, unlockedIds } from '../sim/unlocks.js';

/** Resources shown in the top strip, in this order. */
const STRIP = [
  { key: 'power', label: 'PWR', name: 'Power' },
  { key: 'food', label: 'FOOD', name: 'Food' },
  { key: 'water', label: 'WATER', name: 'Water' },
  { key: 'scrap', label: 'SCRAP', name: 'Scrap' },
  { key: 'parts', label: 'PARTS', name: 'Parts' },
  { key: 'fuel', label: 'FUEL', name: 'Fuel' },
  { key: 'meds', label: 'MEDS', name: 'Meds' },
  { key: 'alloy', label: 'ALLOY', name: 'Alloy' },
  { key: 'ammo', label: 'AMMO', name: 'Ammunition' },
  { key: 'chits', label: 'CHITS', name: 'Chits' },
  { key: 'filters', label: 'FILT', name: 'Filters' },
];

const RES_NAME = Object.fromEntries(STRIP.map((d) => [d.key, d.name]));

const SPEEDS = [0, 1, 2, 4];

/**
 * How loud each kind of change is, when a shift produced several.
 *
 * The bar has room for one line, so it has to be the right one: somebody
 * dying outranks a bay coming online, and a supply line crossing into deficit
 * outranks one crossing back out of it. Ties break toward the newest.
 */
const CHANGE_WEIGHT = {
  death: 100,
  brownout: 92,
  turned_down: 84,
  lost: 76,
  unlock: 64,
  turned_up: 52,
  online: 44,
  started: 30,
  counter: 28,
  birth: 20,
  plain: 10,
};

/**
 * Panels hold slow-moving data, so they redraw at 2Hz rather than every
 * frame. Rebuilding a few hundred rows sixty times a second is both wasted
 * work on a mid-range phone and — worse — it detaches the node under the
 * player's finger mid-tap, so presses get silently swallowed.
 */
const PANEL_REFRESH_MS = 500;

export class Shell {
  constructor(store, game) {
    this.store = store;
    this.game = game;
    this.panels = new Map();
    this.activePanel = null;
    this.dirty = true;
    this.rafPending = false;
    // Placement mode lives here rather than in the store: it is a half-finished
    // gesture, not a fact about the silo, and it must not survive a reload or
    // need a save migration to exist.
    this.placement = null;
    this.placementBar = null;

    this.topbar = document.getElementById('topbar');
    this.strip = document.getElementById('resource-strip');
    this.navbar = document.getElementById('navbar');
    this.host = document.getElementById('panel-host');
    this.clockDate = document.getElementById('clock-date');
    this.clockShift = document.getElementById('clock-shift');
    this.speedBtn = document.getElementById('btn-speed');
    this.alertRail = document.getElementById('alert-rail');
    this.directive = document.getElementById('directive');
    this.directiveText = document.getElementById('directive-text');
    this.directiveWhy = document.getElementById('directive-why');
    this.buildDirective();
    this.directive.addEventListener('click', () => this.openDirective());

    // ---- what just changed ------------------------------------------------
    // A shift report, one line, directly under the order it may well have
    // invalidated. It is its own row in the app grid rather than an overlay:
    // the cross-section is the thing the player is looking at and nothing new
    // is allowed to sit on top of it.
    this.changes = [];
    this.unreadChanges = 0;
    this._snap = null;
    this._flash = new Map(); // resource key -> {dir, until}
    this._flashTimer = null;
    this.buildChangeLine();
    on('cycle', () => this.onCycle());

    // Unlock announcements. The baseline is null until the first paint, which
    // is what stops a save opened on a Thursday announcing five systems at
    // once; after that it is a list of *ids*, because reducers write state in
    // place and a held state reference always reports that nothing changed.
    this._unlockIds = null;
    this._announced = new Set();
    this._freshPanels = new Set();

    this.speedBtn.addEventListener('click', () => this.cycleSpeed());
    document.getElementById('btn-clock').addEventListener('click', () => this.open('log'));

    on('alert', (a) => this.pushAlert(a));

    // Never rebuild a panel out from under a finger or a focused control.
    this.pointerDown = false;
    this.lastPanelRender = 0;
    this.host.addEventListener('pointerdown', () => (this.pointerDown = true));
    window.addEventListener('pointerup', () => {
      this.pointerDown = false;
    });
    window.addEventListener('pointercancel', () => (this.pointerDown = false));

    this.store.subscribe(() => this.markDirty());
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  get state() {
    return this.store.state;
  }

  // ------------------------------------------------------------ panels ---

  register(panel) {
    this.panels.set(panel.id, panel);
    return this;
  }

  buildNav() {
    clear(this.navbar);
    for (const panel of this.panels.values()) {
      if (panel.hidden) continue;
      const btn = el(
        'button.nav-btn',
        {
          type: 'button',
          dataset: { panel: panel.id },
          onclick: () => this.toggle(panel.id),
          'aria-label': panel.title,
        },
        el('span.nav-glyph', panel.glyph),
        el('span.nav-label', panel.nav || panel.title)
      );
      this.navbar.appendChild(btn);
    }
    this.syncNav();
  }

  syncNav() {
    for (const btn of this.navbar.children) {
      const id = btn.dataset.panel;
      const panel = this.panels.get(id);
      btn.classList.toggle('active', this.activePanel === id);
      const locked = panel?.locked?.(this.state);
      // A row of greyed-out buttons is a list of things you can't do. Nine
      // of them on the first morning reads as a game you have already fallen
      // behind in. Panels appear when they become usable and stay.
      btn.hidden = !!locked;
      btn.disabled = !!locked;
      btn.title = locked || panel?.title || '';
      // A panel that arrived while the player was watching keeps a mark until
      // they have opened it once. The announcement is a card that expires;
      // this is what is still there afterwards.
      btn.classList.toggle('fresh', this._freshPanels.has(id));

      const badgeCount = panel?.badge?.(this.state) || 0;
      let badge = btn.querySelector('.badge');
      if (badgeCount > 0) {
        if (!badge) {
          badge = el('span.badge');
          btn.appendChild(badge);
        }
        badge.textContent = badgeCount > 99 ? '99+' : String(badgeCount);
      } else if (badge) {
        badge.remove();
      }
    }
  }

  open(id) {
    const panel = this.panels.get(id);
    if (!panel) return;
    if (panel.locked?.(this.state)) return;
    // Opening anything at all ends a half-placed building. Leaving the lit bays
    // up behind another panel would be a mode the player cannot see they're in.
    if (this.placement) this.endPlacement(false);
    this._freshPanels.delete(id);
    this.activePanel = id;
    this.store.dispatch({ type: 'UI_SET', ui: { view: id } });
    panel.onOpen?.(this.state);
    this.host.hidden = false;
    this.renderPanel(true);
    this.syncNav();
  }

  close() {
    const panel = this.panels.get(this.activePanel);
    panel?.onClose?.(this.state);
    this.activePanel = null;
    this.host.hidden = true;
    clear(this.host);
    this.store.dispatch({ type: 'UI_SET', ui: { view: 'silo' } });
    this.syncNav();
  }

  toggle(id) {
    if (this.activePanel === id) this.close();
    else this.open(id);
  }

  /**
   * Rebuild the open panel. `force` bypasses the refresh throttle — used when
   * the player did something and expects to see the result immediately.
   */
  renderPanel(force = false) {
    if (!this.activePanel) return;
    const panel = this.panels.get(this.activePanel);
    if (!panel) return;

    const now = performance.now();
    if (!force) {
      if (this.pointerDown) return;
      if (now - this.lastPanelRender < PANEL_REFRESH_MS) return;
      // Don't yank a control the player is typing in or tabbing through.
      if (this.host.contains(document.activeElement) && document.activeElement !== document.body) {
        return;
      }
    }
    this.lastPanelRender = now;

    const scroller = this.host.querySelector('.panel-body');
    const scrollTop = scroller ? scroller.scrollTop : 0;
    clear(this.host);
    this.host.appendChild(this.panelFrame(panel));
    const next = this.host.querySelector('.panel-body');
    if (next && scrollTop) next.scrollTop = scrollTop;
  }

  panelFrame(panel) {
    const body = panel.render(this.state, this);
    return el(
      'div.panel',
      el(
        'div.panel-head',
        el('div.panel-title', panel.title),
        panel.subtitle ? el('div.panel-sub.mono', panel.subtitle(this.state)) : null,
        el('button.panel-close', { type: 'button', onclick: () => this.close(), 'aria-label': 'Close' }, '✕')
      ),
      body
    );
  }

  // ---------------------------------------------------------- placement ---
  //
  // Construction is pick-then-place. The player chooses a building from the
  // catalogue; the panel gets out of the way; every bay in the cross-section
  // that could take it lights up; one tap builds it there. The alternative —
  // choose a floor, then see what fits on it — made the player guess which
  // floor was the interesting one before the game would tell them anything.

  /** Enter placement mode for a room type. No-op if it can't go anywhere. */
  startPlacement(typeId) {
    const def = getRoom(typeId);
    if (!def) return;
    const spots = allPlacements(this.state, typeId);
    if (!spots.length) {
      toast(`There is no free bay for a ${def.name}.`, 'bad');
      return;
    }

    // floor -> slot -> which wall it would merge through (-1 left, 1 right, 0 new)
    const bays = new Map();
    for (const spot of spots) {
      if (!bays.has(spot.floor)) bays.set(spot.floor, new Map());
      const side = spot.merge ? (spot.merge.newSlot < spot.slot ? -1 : 1) : 0;
      bays.get(spot.floor).set(spot.slot, side);
    }

    const from = this.activePanel;
    if (this.activePanel) this.close();
    this.placement = { typeId, def, spots, bays, from };
    setPlacement({
      typeId,
      bays,
      onPick: (floor, slot) => this.placeAt(floor, slot),
      onCancel: () => this.cancelPlacement(),
      // The bar's shortcut list is drawn from wherever the camera is, and it
      // was only ever drawn once, at the moment placement started. Its whole
      // purpose is to save the player hunting for a bay by dragging — so
      // dragging was the one action that made it lie: start on floor 2, drag
      // to floor 13, and it still offered Floor 2 Bay 1-6.
      onCameraFloor: () => this.renderPlacementBar(),
    });

    // Take the camera to the nearest lit floor, so the mode is never invisible.
    const focus = this.state.ui.cameraFloor ?? spots[0].floor;
    this.onFocusFloor?.(nearestFloor(spots, focus));
    this.renderPlacementBar();
  }

  /** Build the pending room in this bay, if the silo still allows it. */
  placeAt(floor, slot) {
    const pending = this.placement;
    if (!pending) return;
    const check = canBuild(this.state, floor, slot, pending.typeId);
    if (!check.ok) {
      toast(check.reason, 'bad');
      return;
    }
    this.store.dispatchAll(build(this.state, floor, slot, pending.typeId));
    toast(`${pending.def.name}: construction started on floor ${floor}.`);
    this.endPlacement();
  }

  cancelPlacement() {
    if (this.placement) this.endPlacement();
  }

  /** Leave placement mode. `reopen` puts the player back in the catalogue. */
  endPlacement(reopen = true) {
    const pending = this.placement;
    this.placement = null; // cleared first: open() below must not re-enter here
    setPlacement(null);
    this.placementBar?.remove();
    this.placementBar = null;
    if (reopen && pending?.from) this.open(pending.from);
  }

  /**
   * The banner that says what is being placed. It sits in #modal-root, which
   * is pointer-events:none, so the silo behind it stays draggable — reaching a
   * bay eleven floors down is a normal part of placing something.
   */
  renderPlacementBar() {
    this.placementBar?.remove();
    this.placementBar = null;
    const pending = this.placement;
    if (!pending) return;

    const { def, spots } = pending;
    const focus = this.state.ui.cameraFloor ?? spots[0].floor;
    // Shortcuts to the bays nearest what the player is already looking at.
    // Hunting for the one lit bay on floor 12 by dragging is not a decision.
    const nearest = [...spots]
      .sort(
        (a, b) =>
          Math.abs(a.floor - focus) - Math.abs(b.floor - focus) ||
          a.floor - b.floor ||
          a.slot - b.slot
      )
      .slice(0, BAL.render.placement.nearestBays);

    const bar = el(
      'div.modal.placing',
      { role: 'dialog', 'aria-label': `Placing a ${def.name}` },
      el(
        'div.placing-head',
        el(
          'div.placing-main',
          el('div.placing-eyebrow', 'Placing'),
          el('div.placing-name', def.name),
          el(
            'div.placing-meta',
            chip(describeCost(def.buildCost)),
            // "24 bays lit" was true of the old drawing, which lit every
            // empty bay in the silo and made the choice a coin flip across
            // two dozen identical boxes. The renderer now ranks them — merges, then one
            // suggestion per floor, then the rest as hairlines — so the count
            // that matters is how many are worth looking at, and a merge is
            // worth saying out loud because it widens a room instead of
            // adding one.
            chip(placingSummary(spots), 'warn')
          )
        ),
        button('Cancel', { class: 'sm', onclick: () => this.cancelPlacement() })
      ),
      el('div.placing-hint', 'Tap a lit bay in the cross-section, or pick one here.'),
      el(
        'div.placing-list',
        nearest.map((spot) =>
          row({
            title: `Floor ${spot.floor} · Bay ${spot.slot + 1}`,
            sub: spot.label,
            onclick: () => this.placeAt(spot.floor, spot.slot),
          })
        )
      )
    );
    document.getElementById('modal-root').appendChild(bar);
    this.placementBar = bar;
  }

  // ------------------------------------------------------------- chrome ---

  markDirty() {
    this.dirty = true;
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      if (this.dirty) this.renderChrome();
      this.dirty = false;
    });
  }

  renderChrome() {
    const state = this.state;
    this.renderStrip(state);
    this.renderDirective(state);
    this.checkUnlocks(state);
    this.renderChangeLine(state);
    this.clockDate.textContent = fmtClock(state.clock);
    this.clockShift.textContent = `SHIFT ${state.clock.shift + 1}/${BAL.time.CYCLES_PER_DAY}`;
    this.syncNav();
    if (this.activePanel) this.renderPanel();
  }

  // ---------------------------------------------------------- directive ---
  //
  // The standing order used to be a sentence that opened a panel. A panel is
  // not the action: the player still had to find the room in a catalogue of
  // twenty-nine, or the resident in a roster of four hundred. The order now
  // carries the action itself — one tap places the building, orders the
  // repair, crews the empty post — with two deliberate exceptions. An order
  // flagged `wait` means "do nothing today" and must not offer a button, or
  // the player learns that the bar always wants a tap. An order the silo
  // cannot pay for shows the shortfall instead, because a button that toasts
  // "not enough scrap" is a worse answer than the number.

  /**
   * Split the bar into a text column and an action column. Done in script
   * rather than markup because the three spans are already in the document
   * and keep their ids — anything else that reads #directive-text still can.
   */
  buildDirective() {
    this.directiveEyebrow = this.directive.querySelector('.directive-eyebrow');
    this.directiveMeta = el('span.directive-meta');
    this.directiveAct = el('span.directive-act');
    const main = el('span.directive-main');
    main.append(this.directiveEyebrow, this.directiveText, this.directiveWhy, this.directiveMeta);
    this.directive.append(main, this.directiveAct);
  }

  /**
   * The one thing worth doing next. Recomputed from state, so it stays true
   * whether the player follows it, ignores it, or comes back after a week.
   * Text only changes when the underlying directive does — a line that
   * rewrites itself every cycle is a line nobody can read. Affordability is
   * part of the key: an order can become payable without a word of it
   * changing, and the button has to appear when it does.
   */
  renderDirective(state) {
    const d = topDirective(state);
    if (!d) {
      this.directive.hidden = true;
      this._directive = null;
      this._directiveKey = null;
      return;
    }
    this.directive.hidden = false;
    this._directive = d;
    this._directivePanel = d.panel;
    const key = `${d.id}|${d.why}|${d.blocked || ''}|${d.wait ? 'wait' : ''}`;
    if (this._directiveKey === key) return;
    this._directiveKey = key;
    this.directiveText.textContent = d.text;
    this.directiveWhy.textContent = d.why;
    this.directive.classList.toggle('urgent', d.weight >= 85);
    this.directive.classList.toggle('holding', !!d.wait);
    this.directiveEyebrow.textContent = d.wait ? 'Standing order · hold' : 'Standing order';

    // ---- where, and what it is short of ----------------------------------
    clear(this.directiveMeta);
    const room = d.roomId ? state.silo.rooms[d.roomId] : null;
    if (room) this.directiveMeta.appendChild(chip(`Floor ${room.floor}`));
    if (d.blocked) this.directiveMeta.appendChild(chip(`Short ${d.blocked}`, 'bad'));
    else if (d.room) {
      const cost = getRoom(d.room)?.buildCost;
      if (cost) this.directiveMeta.appendChild(chip(describeCost(cost)));
    }
    this.directiveMeta.hidden = !this.directiveMeta.childNodes.length;

    // ---- the action itself ------------------------------------------------
    clear(this.directiveAct);
    const act = this.directiveAction(d);
    this.directiveAct.hidden = !act;
    if (!act) return;
    // Not a <button>: this sits inside #directive, which is itself a button,
    // and nesting one inside the other is not something the HTML parser will
    // keep. A role and a keyboard handler get the same behaviour honestly.
    const node = el(
      'span.act-btn',
      {
        role: 'button',
        tabIndex: 0,
        'aria-label': `${act.label}: ${d.text}`,
        onclick: (e) => {
          e.stopPropagation();
          act.run();
        },
        onkeydown: (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          act.run();
        },
      },
      act.label
    );
    this.directiveAct.appendChild(node);
  }

  /**
   * The order, as something that can be done. Null when there is nothing to
   * offer — which is a real answer for a hold, and the honest one for an
   * order the treasury cannot cover.
   */
  directiveAction(d) {
    if (d.wait || d.blocked) return null;
    const state = this.state;
    if (d.room) {
      if (!allPlacements(state, d.room).length) return null;
      return { label: 'Place', run: () => this.startPlacement(d.room) };
    }
    if (d.id === 'repair' && d.roomId) return { label: 'Repair', run: () => this.doRepair(d.roomId) };
    // Same button, different word. Restoring a room a dig turned up runs the
    // repair path — it is the same bill — but "Repair" reads as fixing damage
    // the silo did, and this is the opposite: a room the silo never had.
    if (d.id === 'restore' && d.roomId) return { label: 'Restore', run: () => this.doRepair(d.roomId) };
    if (d.id === 'shore' && d.floor) return { label: 'Shore', run: () => this.doShore(d.floor) };
    if (d.id === 'staff') return { label: 'Crew', run: () => this.doAutoAssign() };
    if (d.id === 'excavate') return { label: 'Dig', run: () => this.doExcavate() };
    const panel = this.panels.get(d.panel);
    if (panel && !panel.locked?.(state)) return { label: 'Open', run: () => this.openDirective() };
    return null;
  }

  /** Tapping the bar itself: the panel that acts on the order, and the place. */
  openDirective() {
    const d = this._directive;
    const room = d?.roomId ? this.state.silo.rooms[d.roomId] : null;
    if (room) this.focusFloor(room.floor);
    // An order about a floor rather than a room still names a place, and the
    // cross-section should go there — "Shore floor 136" is a search task
    // otherwise, and the silo is a hundred and forty-four levels deep.
    else if (d?.floor) this.focusFloor(d.floor);
    if (d?.panel) this.open(d.panel);
  }

  doRepair(roomId) {
    const state = this.state;
    const room = state.silo.rooms[roomId];
    const check = canRepair(state, roomId);
    if (!check.ok) {
      toast(check.reason, 'bad');
      return;
    }
    this.store.dispatchAll(repair(state, roomId));
    const name = getRoom(room?.type)?.name || 'The room';
    toast(
      check.partial
        ? `${name}: patched as far as the stores allow.`
        : `${name} on floor ${room.floor} repaired.`
    );
    if (room) this.focusFloor(room.floor);
  }

  doAutoAssign() {
    const actions = autoAssign(this.state);
    if (!actions.length) {
      toast('Nobody is spare. Every working resident already has a post.', 'bad');
      return;
    }
    this.store.dispatchAll(actions);
    toast(`${actions.length} resident${actions.length === 1 ? '' : 's'} posted.`);
  }

  doShore(n) {
    const check = canShore(this.state, n);
    if (!check.ok) {
      toast(check.reason, 'bad');
      return;
    }
    this.store.dispatchAll(shoreFloor(this.state, n));
    toast(`Floor ${n} shored. The supports are new.`);
    this.focusFloor(n);
  }

  doExcavate() {
    const check = canExcavate(this.state);
    if (!check.ok) {
      toast(check.reason, 'bad');
      return;
    }
    const floor = check.floor;
    this.store.dispatchAll(startExcavation(this.state));
    toast(`Excavation of floor ${floor} has begun.`);
    if (floor) this.focusFloor(floor);
  }

  // -------------------------------------------------------------- strip ---

  renderStrip(state) {
    // Rebuilt in place: each tile keeps its node so the strip doesn't
    // re-layout (and lose scroll position) every cycle.
    if (!this._stripNodes) {
      this._stripNodes = new Map();
      clear(this.strip);
      for (const def of STRIP) {
        const val = el('span.res-val.mono', '0');
        const delta = el('span.res-delta.mono', '');
        const node = el(
          'button.res',
          {
            type: 'button',
            role: 'listitem',
            // Not "open the ledger" any more: open *this* resource, with what
            // makes it, what spends it and the net written out. A number you
            // cannot interrogate is a number you learn to ignore.
            onclick: () => this.openResource(def.key),
            dataset: { res: def.key },
          },
          el('span.res-label', def.label),
          el('span.res-row', val, delta)
        );
        this.strip.appendChild(node);
        this._stripNodes.set(def.key, { node, val, delta, flash: '' });
      }
    }

    const live = liveResourceKeys(state);
    for (const def of STRIP) {
      const ref = this._stripNodes.get(def.key);
      const amount = state.resources[def.key] || 0;
      const cap = state.caps?.[def.key] ?? Infinity;
      const flow = state.flows?.[def.key];
      const net = flow ? flow.in - flow.out : 0;

      ref.val.textContent = fmt(amount);
      ref.delta.textContent = fmtDelta(net);
      ref.delta.className =
        'res-delta mono ' + (net > 0.05 ? 'up' : net < -0.05 ? 'down' : 'flat');

      // Critical: either empty, or draining with under a day of stock left.
      //
      // `!!flow` guards the first frame. Power is a stock that starts at zero
      // and fills on the first cycle, so before the economy has run once this
      // read `amount <= 0` and painted PWR as a red zero — the very first
      // thing a new player sees, meaning nothing. An empty store is only a
      // crisis once there is a flow to judge it against.
      const perDay = -net * BAL.time.CYCLES_PER_DAY;
      const critical =
        !!flow && (amount <= 0 || (net < 0 && perDay > 0 && amount / perDay < 1));
      ref.node.classList.toggle('critical', !!critical);
      ref.node.title =
        `${def.name} ${amount.toFixed(1)}${cap === Infinity ? '' : ' / ' + cap}` +
        `\n${fmtDelta(net)} per shift` +
        (flow ? `\n${flow.in.toFixed(1)} in, ${flow.out.toFixed(1)} out` : '') +
        '\nTap for what moves it.';

      // The counter that moved wears the mark, so "a number dropped" has an
      // answer without reading anything. Toggled only on change: re-adding
      // the class every paint would restart the fade sixty times a second.
      const flash = this._flash.get(def.key)?.dir || '';
      if (ref.flash !== flash) {
        ref.node.classList.remove('moved', 'up', 'down', 'new');
        if (flash) {
          ref.node.style.animationDuration = `${BAL.legibility.counterFlashMs}ms`;
          ref.node.classList.add('moved', flash);
        }
        ref.flash = flash;
      }

      ref.node.hidden = !live.has(def.key);
    }
  }

  /** Open the ledger with one resource already opened onto its own causes. */
  openResource(key) {
    this.panels.get('resources')?.focusResource?.(key);
    this.open('resources');
  }

  cycleSpeed() {
    const cur = this.state.settings.speed ?? 1;
    const i = SPEEDS.indexOf(cur);
    const next = SPEEDS[(i + 1) % SPEEDS.length];
    this.game.setSpeed(next);
    this.speedBtn.textContent = next === 0 ? '❙❙' : `${next}×`;
    this.speedBtn.classList.toggle('paused', next === 0);
  }

  setSpeed(mult) {
    this.game.setSpeed(mult);
    this.speedBtn.textContent = mult === 0 ? '❙❙' : `${mult}×`;
    this.speedBtn.classList.toggle('paused', mult === 0);
  }

  /**
   * Transient banner in the top-right of the stage.
   *
   * An alert is three things at once and used to be one: the fact, the cause,
   * and the place. The card carries all three now — the headline stays short
   * enough to read at a glance, the cause is one sentence behind a tap, and
   * the floor is a chip that takes the cross-section there. Alerts raised by
   * reducers cannot carry prose (they are dispatched from state mutation, not
   * from anything that knows how to write), so `explainAlert` derives the
   * missing sentence from live state instead.
   */
  pushAlert({ kind = 'alert', glyph = '!', text, why, floor, roomId, resource, panel }) {
    const L = BAL.legibility;
    const detail = { kind, glyph, text, floor, roomId, resource, panel };
    detail.why = why || this.explainAlert(detail, this.state);

    // One rail entry per distinct message. A condition that flickers — the
    // brownout does, as generation crosses demand and crosses back — fires on
    // every transition, and each one used to stack another identical card
    // until four copies of "Brownout — check power priority" covered the top
    // floor of the silo. Repeating a warning does not make it more true; it
    // just hides the thing the player is being warned about. A repeat restarts
    // the timer instead, so it stays up while the condition lasts and leaves
    // when it stops.
    const existing = this._alertNodes?.get(text);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.dropAlert(text), L.alertDwellMs);
      // Move it back to the bottom so the newest thing is where the eye is.
      this.alertRail.appendChild(existing.node);
      if (floor != null) this.onAlertFloor?.(floor, kind);
      return;
    }

    const node = this.alertCard(detail);
    this.alertRail.appendChild(node);
    this._alertNodes ??= new Map();
    this._alertNodes.set(text, {
      node,
      timer: setTimeout(() => this.dropAlert(text), L.alertDwellMs),
    });

    // Let go of the oldest only once the stack itself is full. Everything
    // between alertMaxCards and alertStackMax is still here, just folded.
    while (this._alertNodes.size > L.alertStackMax) {
      const oldest = this.alertRail.querySelector('.alert');
      const key = [...this._alertNodes].find(([, v]) => v.node === oldest)?.[0];
      if (key) this.dropAlert(key);
      else if (oldest) oldest.remove();
      else break;
    }
    this.layoutAlerts();
    if (floor != null) this.onAlertFloor?.(floor, kind);
  }

  /**
   * Show the newest card and fold the rest behind a count.
   *
   * The rail used to stand three cards tall. On an ordinary day eleven — a
   * brownout, a water warning and a worn room — that covered floors one to
   * seven of the cross-section, which was every room the silo had: the player
   * was told three things and shown none of them. One card is a notice; three
   * are a curtain.
   *
   * The fold is not a dismissal. The older cards are still there, still hold
   * their reason and their destination, and one tap brings them back.
   */
  layoutAlerts() {
    const L = BAL.legibility;
    const cards = [...this.alertRail.querySelectorAll('.alert')];
    this._alertStackNode?.remove();
    this._alertStackNode = null;
    if (!cards.length) {
      this._alertsOpen = false;
      return;
    }

    const show = this._alertsOpen ? cards.length : Math.min(L.alertMaxCards, cards.length);
    // Newest last, so the visible ones are the tail.
    cards.forEach((c, i) => {
      c.hidden = i < cards.length - show;
    });

    // The control stays put whether or not anything is currently folded —
    // it was only rendered when `folded > 0`, so expanding the stack removed
    // the only way to collapse it again and the rail was stuck open.
    const folded = cards.length - show;
    if (!folded && !this._alertsOpen) return;
    const pill = el(
      'button.alert-stack',
      {
        type: 'button',
        'aria-label': this._alertsOpen
          ? 'Show fewer alerts'
          : `${folded} earlier alert${folded === 1 ? '' : 's'}`,
        onclick: () => {
          this._alertsOpen = !this._alertsOpen;
          this.layoutAlerts();
        },
      },
      this._alertsOpen ? 'Fewer' : `+${folded} earlier`
    );
    this._alertStackNode = pill;
    this.alertRail.insertBefore(pill, this.alertRail.firstChild);
  }

  /**
   * One card. The first tap answers "why", the second answers "where" — in
   * that order deliberately, because navigating away on the first tap means
   * the sentence explaining the alert is never read by anybody who wanted to
   * go and look at the thing.
   */
  alertCard(a) {
    const why = a.why ? el('span.alert-why', a.why) : null;
    if (why) why.hidden = true;
    // Somewhere to go, as well as something to say. A card with neither — a
    // scripted crisis, which has already taken the whole screen once — gets no
    // affordance, because a chevron that leads nowhere is a broken control.
    const goes = !!(a.roomId || a.floor != null || a.resource || a.panel);
    const more = why || goes ? el('span.alert-more.mono', why ? '?' : '›') : null;
    const card = el(
      'button.alert' + (a.kind ? '.' + a.kind : ''),
      { type: 'button', 'aria-label': a.text },
      el(
        'span.alert-head',
        el('span.glyph', a.glyph),
        el('span.alert-text', a.text),
        a.floor != null ? el('span.alert-where.mono', `FL ${a.floor}`) : null,
        more
      ),
      why
    );
    card.addEventListener('click', () => {
      if (why && why.hidden) {
        why.hidden = false;
        if (more) more.textContent = goes ? '›' : '';
        card.classList.add('open');
        // Reading takes longer than glancing, so an opened card stands longer.
        const entry = this._alertNodes?.get(a.text);
        if (entry) {
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => this.dropAlert(a.text), BAL.legibility.alertOpenedDwellMs);
        }
        return;
      }
      if (a.roomId && this.state.silo.rooms[a.roomId]) this.onOpenRoom?.(a.roomId);
      else if (a.floor != null) this.focusFloor(a.floor);
      else if (a.resource) this.openResource(a.resource);
      else if (a.panel) this.open(a.panel);
    });
    return card;
  }

  /**
   * The sentence an alert did not come with.
   *
   * Every alert raised inside a reducer arrives as a headline and nothing
   * else — `emit` is called from the middle of a state mutation, which is the
   * wrong place to be composing prose and has no business knowing what the
   * player can see. Rather than push explanations back into the reducers,
   * they are derived here from the state at the moment the alert lands, which
   * also makes them specific: "demand 84 against 71 generated" rather than a
   * canned line about brownouts.
   */
  explainAlert(a, state) {
    if (/^Brownout/i.test(a.text)) {
      const gen = Math.round(state.power?.generation || 0);
      const demand = Math.round(state.power?.demand || 0);
      const dark = Object.values(state.silo.rooms).filter((r) => !r.powered).length;
      return (
        `Demand is ${demand} against ${gen} generated, so ${dark || 'some'} room` +
        `${dark === 1 ? '' : 's'} at the bottom of the power priority are dark. ` +
        'Fix it with another Generator Hall, or by reordering the list.'
      );
    }
    if (/excavated$/i.test(a.text)) {
      return `Six more bays, empty. Nothing is built down there until you build it.`;
    }
    if (/^Investigation/i.test(a.text)) {
      const inv = (state.order.investigations || [])[0];
      return inv
        ? `A crime was committed and the sheriff has suspects. The verdict is yours, and a wrong one costs order.`
        : 'The sheriff has opened a case. The verdict is yours.';
    }
    if (/raider/i.test(a.text)) {
      return 'Somebody is at the door. Squads defend the silo; without one, the raid takes what it wants.';
    }
    if (a.resource) {
      const flow = state.flows?.[a.resource];
      return flow
        ? `${flow.in.toFixed(1)} in against ${flow.out.toFixed(1)} out per shift.`
        : null;
    }
    return null;
  }

  dropAlert(text) {
    const entry = this._alertNodes?.get(text);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.node.remove();
    this._alertNodes.delete(text);
    // The fold count is now wrong, and the card that was hiding behind it may
    // be the one that should now be on screen.
    this.layoutAlerts();
  }

  // ------------------------------------------------------------- places ---

  /**
   * Take the cross-section to a floor and mark it on the gauge, so a jump
   * made from a line of text can be followed by eye. Both hooks are wired in
   * main.js; neither is required for the shell to work.
   */
  focusFloor(floor) {
    if (floor == null) return;
    this.onFocusFloor?.(floor);
    this.onAlertFloor?.(floor, 'focus');
  }

  // ------------------------------------------------------ what changed ---
  //
  // A silo run at 1× resolves a shift every ninety seconds, and most of what
  // it does it does quietly: a number moves, a bay goes dark, a line crosses
  // zero with the tank still full. The log records all of it and is therefore
  // no use for this — reading a hundred entries to find the one that explains
  // the figure you just noticed is not reading, it is searching.
  //
  // So the shell keeps its own account, one shift at a time: it snapshots the
  // handful of things a player would notice, diffs them on the next shift
  // boundary, and writes the difference as a sentence. The bar under the
  // standing order shows the loudest one; the Log panel's Changes tab has the
  // rest. Nothing here is persisted — this is what happened while you were
  // watching, and `returnReport.js` is what happened while you were not.

  buildChangeLine() {
    this._flipAt = new Map();
    this.changeEyebrow = el('span.changeline-eyebrow', 'Last shift');
    this.changeText = el('span.changeline-text');
    this.changeMore = el('span.changeline-more.mono');
    this.changeMore.hidden = true;
    this.changeLine = el(
      'button.changeline',
      {
        type: 'button',
        id: 'change-line',
        hidden: true,
        'aria-label': 'The shift report — what changed, and the rest of it',
        onclick: () => this.openChanges(),
      },
      this.changeEyebrow,
      this.changeText,
      this.changeMore
    );
    this.directive.insertAdjacentElement('afterend', this.changeLine);
  }

  /** The shift boundary: diff, then repaint. */
  onCycle() {
    this.collectChanges(this.state);
    this.markDirty();
  }

  /** Everything the account watches, as of now. */
  snapshot(state) {
    const rooms = {};
    for (const [id, r] of Object.entries(state.silo.rooms)) {
      rooms[id] = {
        type: r.type,
        floor: r.floor,
        width: r.width,
        building: r.buildingUntilCycle > 0,
      };
    }
    const dir = {};
    const res = {};
    for (const def of STRIP) {
      res[def.key] = state.resources[def.key] || 0;
      dir[def.key] = flowDirection(state, def.key);
    }
    return {
      cycle: state.clock.cycle,
      res,
      dir,
      live: liveResourceKeys(state),
      rooms,
      logLen: state.log.length,
      // The brownout flag lives on flags, not on power — `state.power` is
      // rewritten wholesale every cycle with only generation and demand on it.
      brownout: !!state.flags.brownout,
    };
  }

  collectChanges(state) {
    const prev = this._snap;
    const now = this.snapshot(state);
    this._snap = now;
    // No baseline on the first shift after boot, deliberately: the difference
    // between "before you opened the tab" and "now" is the return report's
    // job, and it does it better.
    if (!prev) return;

    const L = BAL.legibility;

    // ---- supply lines, and the counters that carry them -------------------
    for (const def of STRIP) {
      const key = def.key;
      if (!now.live.has(key)) continue;
      const flow = state.flows?.[key] || { in: 0, out: 0 };

      if (!prev.live.has(key)) {
        // A counter that appears out of nowhere is its own small mystery.
        this.flashCounter(key, 'new');
        this.recordChange({
          kind: 'counter',
          res: key,
          text:
            `${def.name} is on the strip now — the silo has started ` +
            `${flow.in > 0 ? 'producing' : 'drawing on'} it.`,
        });
        continue;
      }

      const quiet = this._flipAt.get(key);
      const canSpeak = quiet == null || now.cycle - quiet >= L.changeQuietCycles;
      if (now.dir[key] !== prev.dir[key] && canSpeak) {
        if (now.dir[key] === 'down') {
          this._flipAt.set(key, now.cycle);
          this.flashCounter(key, 'down');
          this.recordChange({
            kind: 'turned_down',
            res: key,
            text:
              `${def.name} has turned negative — ${flow.in.toFixed(1)} in against ` +
              `${flow.out.toFixed(1)} out a shift.${runwayClause(state, key)}`,
          });
          continue;
        }
        if (now.dir[key] === 'up' && prev.dir[key] === 'down') {
          this._flipAt.set(key, now.cycle);
          this.flashCounter(key, 'up');
          this.recordChange({
            kind: 'turned_up',
            res: key,
            text:
              `${def.name} is back in surplus — ${flow.in.toFixed(1)} in against ` +
              `${flow.out.toFixed(1)} out a shift.`,
          });
          continue;
        }
      }

      // Anything that moved by a real amount in one shift gets marked, even
      // when nothing is wrong with it: paying 220 scrap for a Laboratory is
      // the commonest reason a number drops, and it should be visible that
      // *that* is the number that moved.
      if (this._flash.has(key)) continue;
      const moved = Math.abs(now.res[key] - prev.res[key]);
      const cap = state.caps?.[key];
      const bar = Math.max(L.stockMoveMin, Number.isFinite(cap) ? cap * L.stockMoveFraction : 0);
      if (moved >= bar) this.flashCounter(key, now.res[key] > prev.res[key] ? 'up' : 'down');
    }

    // ---- the building itself ----------------------------------------------
    for (const [id, r] of Object.entries(now.rooms)) {
      const before = prev.rooms[id];
      const name = getRoom(r.type)?.name || r.type;
      if (!before) {
        this.recordChange({
          kind: 'started',
          floor: r.floor,
          roomId: id,
          text: `${name} started on floor ${r.floor}.`,
        });
      } else if (before.building && !r.building) {
        this.recordChange({
          kind: 'online',
          floor: r.floor,
          roomId: id,
          text: `${name} on floor ${r.floor} is finished and online.`,
        });
      } else if (r.width > before.width) {
        this.recordChange({
          kind: 'online',
          floor: r.floor,
          roomId: id,
          text: `${name} on floor ${r.floor} is ${r.width} bays wide now.`,
        });
      }
    }
    for (const [id, r] of Object.entries(prev.rooms)) {
      if (now.rooms[id]) continue;
      const name = getRoom(r.type)?.name || r.type;
      this.recordChange({
        kind: 'lost',
        floor: r.floor,
        text: `${name} on floor ${r.floor} is gone.`,
      });
    }

    // ---- power ------------------------------------------------------------
    if (now.brownout !== prev.brownout) {
      this.recordChange(
        now.brownout
          ? {
              kind: 'brownout',
              panel: 'resources',
              text:
                `Brownout: demand ${Math.round(state.power?.demand || 0)} against ` +
                `${Math.round(state.power?.generation || 0)} generated. Rooms are shutting down ` +
                'from the bottom of the power priority.',
            }
          : { kind: 'plain', panel: 'resources', text: 'Generation is covering demand again.' }
      );
    }

    // ---- people -----------------------------------------------------------
    // Read off the log rather than off the headcount: the log entries were
    // written with a name and a cause on them, and a name is the difference
    // between "population fell by one" and knowing what happened.
    const fresh = state.log.slice(prev.logLen);
    const deaths = fresh.filter((e) => e.kind === 'death');
    if (deaths.length === 1) {
      this.recordChange({ kind: 'death', text: deaths[0].text, floor: floorOfEntry(deaths[0]) });
    } else if (deaths.length > 1) {
      this.recordChange({
        kind: 'death',
        text: `${deaths.length} deaths this shift. ${deaths[0].text}`,
      });
    }
    const births = fresh.filter((e) => e.kind === 'birth');
    if (births.length === 1) this.recordChange({ kind: 'birth', text: births[0].text });
    else if (births.length > 1) {
      this.recordChange({ kind: 'birth', text: `${births.length} children born this shift.` });
    }
  }

  recordChange(c) {
    const state = this.state;
    this.changes.push({ ...c, day: state.clock.day, cycle: state.clock.cycle });
    if (this.changes.length > BAL.legibility.changeLogMax) {
      this.changes.splice(0, this.changes.length - BAL.legibility.changeLogMax);
    }
    this.unreadChanges++;
  }

  flashCounter(key, dir) {
    this._flash.set(key, { dir, until: performance.now() + BAL.legibility.counterFlashMs });
    if (!this._flashTimer) {
      this._flashTimer = setTimeout(() => this.sweepFlashes(), BAL.legibility.counterFlashMs + 20);
    }
  }

  sweepFlashes() {
    this._flashTimer = null;
    const now = performance.now();
    let soonest = 0;
    for (const [key, f] of [...this._flash]) {
      if (f.until <= now) this._flash.delete(key);
      else soonest = Math.max(soonest, f.until - now);
    }
    if (soonest) this._flashTimer = setTimeout(() => this.sweepFlashes(), soonest + 20);
    this.markDirty();
  }

  /**
   * The loudest thing that has happened *lately*.
   *
   * Two rules, and the second one exists because the first one on its own is a
   * trap. Loudest, so a bay coming online cannot push a death off the bar —
   * and only from the last few shifts, because "loudest" alone meant the first
   * death a silo ever had sat here permanently. Death outweighs everything,
   * the pool was every unread line, and unread only cleared when the bar was
   * tapped — so a player who never tapped it read the same sentence every
   * ninety seconds for an hour while twenty-seven newer changes queued up
   * behind a label that said "Since you looked".
   *
   * The window is the same `changeLineShifts` the staleness rule always used;
   * it just applies to everybody now instead of only to people who had already
   * read the bar. Everything that ages out of it is still on the Changes tab,
   * which is the document that keeps things.
   */
  renderChangeLine(state) {
    const L = BAL.legibility;
    if (!this.changes.length) {
      this.changeLine.hidden = true;
      return;
    }
    const cutoff = state.clock.cycle - L.changeLineShifts;
    const unread = Math.min(this.unreadChanges, this.changes.length);
    const firstUnread = this.changes.length - unread;

    // One pass: the loudest unread line still inside the window, and the
    // newest line inside it at all. Unread wins when there is one — and there
    // always is one when anything is unread, because the newest change is by
    // definition both the newest and unread.
    let best = null;
    let newest = null;
    for (let i = 0; i < this.changes.length; i++) {
      const c = this.changes[i];
      if (c.cycle < cutoff) continue;
      newest = c;
      if (i < firstUnread) continue;
      if (!best || weightOfChange(c) >= weightOfChange(best)) best = c;
    }
    const line = best || newest;
    if (!line) {
      // Nothing has happened for most of a day. The bar has nothing to say and
      // says nothing, rather than repeating the last thing it said.
      this.changeLine.hidden = true;
      return;
    }

    this.changeLine.hidden = false;
    const age = state.clock.cycle - line.cycle;
    // The eyebrow is a claim about time, so it has to survive being read. Two
    // or more unread is "since you looked"; one is either this shift or an
    // honest count of how many ago.
    const eyebrow =
      unread > 1 ? 'Since you looked' : age <= 1 ? 'Last shift' : `${age} shifts ago`;
    const more = unread > 1 ? `+${unread - 1}` : '';
    if (this.changeEyebrow.textContent !== eyebrow) this.changeEyebrow.textContent = eyebrow;
    if (this.changeText.textContent !== line.text) this.changeText.textContent = line.text;
    if (this.changeMore.textContent !== more) this.changeMore.textContent = more;
    this.changeMore.hidden = !more;
    const tone = toneOfChange(line);
    this.changeLine.className = 'changeline' + (tone ? ' ' + tone : '');
  }

  /** Read the account. Opens the Log panel on the Changes tab. */
  openChanges() {
    this.unreadChanges = 0;
    this.panels.get('log')?.focusTab?.('changes');
    this.open('log');
    this.markDirty();
  }

  // ----------------------------------------------------------- unlocks ---

  /**
   * Say it once, out loud, when a system arrives.
   *
   * A panel that appears in the bar silently is indistinguishable from one
   * that was always there and never noticed — and the whole unlock spine
   * exists to make the game arrive in readable pieces, which only works if
   * each piece announces itself. The baseline is a list of ids rather than a
   * state: reducers write in place, so a held state reference is this frame's
   * state and would report that nothing has ever changed. Null until the
   * first paint, so a save opened on a Thursday announces nothing.
   */
  checkUnlocks(state) {
    const ids = unlockedIds(state);
    const prev = this._unlockIds;
    this._unlockIds = ids;
    if (prev == null || prev.join() === ids.join()) return;

    for (const u of newlyUnlocked(prev, state)) {
      if (this._announced.has(u.id)) continue;
      this._announced.add(u.id);
      this._freshPanels.add(u.panel);
      // A toast rather than a card on the alert rail, for one reason: the rail
      // is inside the stage and an open panel covers it, and an unlock lands
      // most often while the player is in the panel that caused it. The toast
      // sits directly above the bar it is talking about, and the button it
      // names keeps its mark until the panel has been opened once.
      toast(`${u.label} is open — a new panel on the bar below.`, 'good');
      this.recordChange({
        kind: 'unlock',
        panel: u.panel,
        text: `${u.label} is open — a new panel on the bar at the bottom.`,
      });
    }
  }

  onKey(e) {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape') {
      // Innermost thing first. This used to close the panel and leave any
      // open dialog stranded on top of it, so a citizen card or a crew
      // assignment could not be dismissed from the keyboard at all — and the
      // thing that did close was the one behind it.
      if (closeTopModal()) {
        e.preventDefault();
        return;
      }
      // A half-placed building is the next thing in. It has no panel of its
      // own to close, so it has to be named here or Escape would skip it.
      if (this.placement) {
        e.preventDefault();
        this.cancelPlacement();
        return;
      }
      if (this.activePanel) {
        e.preventDefault();
        this.close();
      }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      this.setSpeed(this.state.settings.speed === 0 ? 1 : 0);
      return;
    }
    // Number keys jump to panels in nav order.
    const n = Number(e.key);
    if (n >= 1 && n <= 9) {
      const ids = [...this.panels.values()].filter((p) => !p.hidden).map((p) => p.id);
      if (ids[n - 1]) {
        e.preventDefault();
        this.toggle(ids[n - 1]);
      }
    }
  }
}

/** up / down / flat, with a deadband so rounding noise is not a direction. */
function flowDirection(state, key) {
  const flow = state.flows?.[key];
  const net = flow ? flow.in - flow.out : 0;
  const dead = BAL.legibility.flowFlipDeadband;
  return net > dead ? 'up' : net < -dead ? 'down' : 'flat';
}

/** " The store is gone in 6 days at that rate." — or nothing, if it is not. */
function runwayClause(state, key) {
  const flow = state.flows?.[key];
  const net = flow ? flow.in - flow.out : 0;
  if (net >= 0) return '';
  const days = (state.resources[key] ?? 0) / (-net * BAL.time.CYCLES_PER_DAY);
  if (!Number.isFinite(days) || days > 60) return '';
  const whole = Math.max(0, Math.floor(days));
  return whole === 0
    ? ' The store is gone within the day at that rate.'
    : ` The store is gone in about ${whole} day${whole === 1 ? '' : 's'} at that rate.`;
}

function weightOfChange(c) {
  return CHANGE_WEIGHT[c.kind] ?? CHANGE_WEIGHT.plain;
}

function toneOfChange(c) {
  if (['death', 'lost', 'turned_down', 'brownout'].includes(c.kind)) return 'bad';
  if (['turned_up', 'online', 'unlock', 'birth'].includes(c.kind)) return 'good';
  return '';
}

/** Where a log entry happened: what it was written with, or what it says. */
export function floorOfEntry(entry) {
  if (entry?.data?.floor != null) return entry.data.floor;
  const m = /\bfloor (\d{1,2})\b/i.exec(entry?.text || '');
  return m ? Number(m[1]) : null;
}

/**
 * How many places are worth looking at, said in the terms the drawing uses.
 * A merge is called out separately because it does something different from
 * the other seventy: it widens the room already standing there rather than
 * adding another one, and that is the only choice on the screen with a
 * consequence attached.
 */
function placingSummary(spots) {
  const merges = spots.filter((s) => s.merge).length;
  const free = spots.length - merges;
  const parts = [];
  if (merges) parts.push(`${merges} merge${merges === 1 ? '' : 's'}`);
  if (free) parts.push(`${free} free bay${free === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'nowhere to put it';
}

/** The lit floor closest to the one the player is already looking at. */
function nearestFloor(spots, focus) {
  let best = spots[0].floor;
  let bestGap = Infinity;
  for (const spot of spots) {
    const gap = Math.abs(spot.floor - focus);
    if (gap < bestGap) {
      bestGap = gap;
      best = spot.floor;
    }
  }
  return best;
}

export default Shell;
