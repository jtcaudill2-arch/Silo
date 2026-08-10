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
 */

import { BAL } from '../config/balance.js';
import { el, clear, fmt, fmtDelta, fmtClock, closeTopModal, button, chip, row, toast } from './dom.js';
import { on } from '../core/events.js';
import { topDirective } from '../sim/directives.js';
import { getRoom } from '../data/rooms.js';
import { setPlacement } from '../render/canvas.js';
import { allPlacements, canBuild, build, describeCost } from '../sim/build.js';

/** Resources shown in the top strip, in this order. */
const STRIP = [
  { key: 'power', label: 'PWR' },
  { key: 'food', label: 'FOOD' },
  { key: 'water', label: 'WATER' },
  { key: 'scrap', label: 'SCRAP' },
  { key: 'parts', label: 'PARTS' },
  { key: 'fuel', label: 'FUEL' },
  { key: 'meds', label: 'MEDS' },
  { key: 'alloy', label: 'ALLOY' },
  { key: 'ammo', label: 'AMMO' },
  { key: 'chits', label: 'CHITS' },
  { key: 'filters', label: 'FILT' },
];

/**
 * Always on the strip, even at zero — these four are the ones a decision is
 * ever made about on the first morning, and a counter that vanishes when it
 * empties is worse than one that reads zero.
 */
const ALWAYS_SHOWN = new Set(['power', 'food', 'water', 'scrap']);

const SPEEDS = [0, 1, 2, 4];

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
    this.directive.addEventListener('click', () => {
      if (this._directivePanel) this.open(this._directivePanel);
    });

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
            chip(`${spots.length} bay${spots.length === 1 ? '' : 's'} lit`, 'warn')
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
    this.clockDate.textContent = fmtClock(state.clock);
    this.clockShift.textContent = `SHIFT ${state.clock.shift + 1}/${BAL.time.CYCLES_PER_DAY}`;
    this.syncNav();
    if (this.activePanel) this.renderPanel();
  }

  /**
   * The one thing worth doing next. Recomputed from state, so it stays true
   * whether the player follows it, ignores it, or comes back after a week.
   * Text only changes when the underlying directive does — a line that
   * rewrites itself every cycle is a line nobody can read.
   */
  renderDirective(state) {
    const d = topDirective(state);
    if (!d) {
      this.directive.hidden = true;
      this._directiveId = null;
      return;
    }
    this.directive.hidden = false;
    this._directivePanel = d.panel;
    if (this._directiveId === d.id && this._directiveWhy === d.why) return;
    this._directiveId = d.id;
    this._directiveWhy = d.why;
    this.directiveText.textContent = d.text;
    this.directiveWhy.textContent = d.why;
    this.directive.classList.toggle('urgent', d.weight >= 85);
  }

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
          { type: 'button', role: 'listitem', onclick: () => this.open('resources'), dataset: { res: def.key } },
          el('span.res-label', def.label),
          el('span.res-row', val, delta)
        );
        this.strip.appendChild(node);
        this._stripNodes.set(def.key, { node, val, delta });
      }
    }

    const live = this.liveResources(state);
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
      const perDay = -net * BAL.time.CYCLES_PER_DAY;
      const critical =
        amount <= 0 || (net < 0 && perDay > 0 && amount / perDay < 1);
      ref.node.classList.toggle('critical', !!critical);
      ref.node.title =
        `${def.label} ${amount.toFixed(1)}${cap === Infinity ? '' : ' / ' + cap}` +
        `\n${fmtDelta(net)} per cycle`;

      ref.node.hidden = !live.has(def.key);
    }
  }

  /**
   * Which counters the strip should carry.
   *
   * Eleven of them on the first morning — most reading a starting stock the
   * silo has no way to spend or replace for hours — is a good part of what
   * makes this look impenetrable, and it buries the three that decide whether
   * anybody lives. A resource earns its place when the silo actually handles
   * it: some room you have built makes it or burns it. Alloy arrives with the
   * foundry, ammunition with the armoury, filters with the scrubbers.
   *
   * Derived from the rooms rather than remembered, so it survives a reload
   * and never disagrees with itself.
   */
  liveResources(state) {
    const live = new Set(ALWAYS_SHOWN);
    for (const room of Object.values(state.silo.rooms)) {
      const def = getRoom(room.type);
      if (!def) continue;
      for (const k of Object.keys(def.produces || {})) live.add(k);
      for (const k of Object.keys(def.consumes || {})) live.add(k);
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

  /** Transient banner in the top-right of the stage. */
  pushAlert({ kind = 'alert', glyph = '!', text, floor }) {
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
      existing.timer = setTimeout(() => this.dropAlert(text), 7000);
      // Move it back to the bottom so the newest thing is where the eye is.
      this.alertRail.appendChild(existing.node);
      if (floor != null) this.onAlertFloor?.(floor, kind);
      return;
    }

    const node = el(
      'div.alert' + (kind ? '.' + kind : ''),
      el('span.glyph', glyph),
      el('span', text)
    );
    this.alertRail.appendChild(node);
    this._alertNodes ??= new Map();
    this._alertNodes.set(text, {
      node,
      timer: setTimeout(() => this.dropAlert(text), 7000),
    });

    while (this.alertRail.children.length > 3) {
      const oldest = this.alertRail.firstChild;
      const key = [...this._alertNodes].find(([, v]) => v.node === oldest)?.[0];
      if (key) this.dropAlert(key);
      else oldest.remove();
    }
    if (floor != null) this.onAlertFloor?.(floor, kind);
  }

  dropAlert(text) {
    const entry = this._alertNodes?.get(text);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.node.remove();
    this._alertNodes.delete(text);
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
