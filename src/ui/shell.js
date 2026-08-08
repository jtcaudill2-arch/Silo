/**
 * shell.js — the persistent chrome: resource bar, clock, navbar, panel host.
 *
 * Panels register themselves here. Each panel is a plain object with a
 * `render(state)` that returns a DOM node; the shell rebuilds the active one
 * when the store changes, throttled to animation frames so a burst of actions
 * costs one repaint, not fifty.
 */

import { BAL } from '../config/balance.js';
import { el, clear, fmt, fmtDelta, fmtClock, closeTopModal } from './dom.js';
import { on } from '../core/events.js';

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

    this.topbar = document.getElementById('topbar');
    this.strip = document.getElementById('resource-strip');
    this.navbar = document.getElementById('navbar');
    this.host = document.getElementById('panel-host');
    this.clockDate = document.getElementById('clock-date');
    this.clockShift = document.getElementById('clock-shift');
    this.speedBtn = document.getElementById('btn-speed');
    this.alertRail = document.getElementById('alert-rail');

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
    this.clockDate.textContent = fmtClock(state.clock);
    this.clockShift.textContent = `SHIFT ${state.clock.shift + 1}/${BAL.time.CYCLES_PER_DAY}`;
    this.syncNav();
    if (this.activePanel) this.renderPanel();
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
    }
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
    const node = el(
      'div.alert' + (kind ? '.' + kind : ''),
      el('span.glyph', glyph),
      el('span', text)
    );
    this.alertRail.appendChild(node);
    if (this.alertRail.children.length > 4) this.alertRail.firstChild.remove();
    setTimeout(() => node.remove(), 7000);
    if (floor != null) this.onAlertFloor?.(floor, kind);
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

export default Shell;
