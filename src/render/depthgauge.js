/**
 * depthgauge.js — the signature element (spec §14).
 *
 * The whole 92-floor silo rendered as one column of 3px bars pinned to the
 * left edge: excavated floors lit, unexcavated dark, the current viewport a
 * bright sodium bracket you can drag. Alerts pulse as coloured ticks at their
 * floor.
 *
 * It is navigation, minimap and alarm panel in one object. Everything else in
 * the UI stays quiet so this can be loud.
 */

import { BAL } from '../config/balance.js';
import { getRoom } from '../data/rooms.js';
import { PALETTE } from './canvas.js';
import { withAlpha, mix } from './floors.js';

const BAR_H = BAL.render.depthGaugeBarHeight;

export class DepthGauge {
  constructor(canvas, store, siloRenderer) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;
    this.silo = siloRenderer;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.time = 0;
    this.alerts = new Map(); // floor -> {kind, until}
    this._bind();
    this.resize();
  }

  get state() {
    return this.store.state;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /**
   * Flash a tick at a floor. Kinds: warn, rad, good, alert, focus.
   *
   * `focus` is the one the player asked for rather than one the silo raised:
   * it fires when a tap on a line of text — an alert, a log entry, a standing
   * order, a room in the resource breakdown — sends the camera somewhere. The
   * cross-section eases toward the floor over several frames, and without a
   * mark on the rail there is nothing to tell you where in ninety-two floors
   * you have just been sent. It is drawn as a bracket rather than a wash, and
   * it is deliberately short: it is a pointer, not a warning.
   */
  flag(floor, kind = 'alert', ms) {
    const life = ms ?? (kind === 'focus' ? BAL.legibility.gaugeFocusMs : 9000);
    this.alerts.set(floor, { kind, until: this.time + life, life });
  }

  /** Pixel geometry: the rail always shows all 92 floors, scaled to fit. */
  layout() {
    const total = BAL.silo.totalFloors;
    const pad = 6;
    const usable = this.h - pad * 2;
    const step = Math.max(2, Math.min(BAR_H + 1, usable / total));
    return { pad, step, total, barH: Math.max(1.5, step - 1) };
  }

  floorAtY(y) {
    const { pad, step, total } = this.layout();
    return Math.max(1, Math.min(total, Math.floor((y - pad) / step) + 1));
  }

  render(dt) {
    const ctx = this.ctx;
    const state = this.state;
    this.time += dt;
    const { pad, step, total, barH } = this.layout();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = PALETTE.concreteDeeper;
    ctx.fillRect(0, 0, this.w, this.h);

    const left = 5;
    const right = this.w - 5;
    const barW = right - left;

    // ---- the column -------------------------------------------------------
    for (let n = 1; n <= total; n++) {
      const floor = state.silo.floors[n - 1];
      const y = pad + (n - 1) * step;

      if (!floor || !floor.excavated) {
        // Unexcavated rock: a bare hint, so the frontier is visible.
        ctx.fillStyle = withAlpha(PALETTE.concrete, 0.28);
        ctx.fillRect(left, y, barW, barH);
        continue;
      }

      // An excavated floor is lit in proportion to how much of it is built
      // and running — so the rail doubles as a build-out progress read.
      const { filled, running } = floorOccupancy(state, floor);
      const base = filled === 0 ? withAlpha(PALETTE.concrete, 0.75) : PALETTE.concrete;
      ctx.fillStyle = base;
      ctx.fillRect(left, y, barW, barH);

      if (filled > 0) {
        const lit = running / Math.max(1, filled);
        ctx.fillStyle = mix(PALETTE.concrete, PALETTE.sodium, 0.25 + lit * 0.75);
        ctx.fillRect(left, y, barW * (filled / BAL.silo.slotsPerFloor), barH);
      }
    }

    // ---- tier divisions ---------------------------------------------------
    ctx.fillStyle = withAlpha(PALETTE.bone, 0.18);
    for (const tier of BAL.silo.tiers) {
      if (tier.from === 1) continue;
      const y = pad + (tier.from - 1) * step - 1;
      ctx.fillRect(2, y, this.w - 4, 1);
    }

    // ---- alert ticks ------------------------------------------------------
    for (const [floor, a] of [...this.alerts]) {
      if (a.until < this.time) {
        this.alerts.delete(floor);
        continue;
      }
      const y = pad + (floor - 1) * step;
      const h = Math.max(2, barH + 2);

      if (a.kind === 'focus') {
        // A bracket closing on the floor you were just sent to, fading as it
        // goes. Never a wash: a wash reads as an alarm, and this is a pointer.
        const left = Math.max(0, 1 - (a.until - this.time) / (a.life || 1));
        ctx.fillStyle = withAlpha(PALETTE.bone, 0.85 * (1 - left));
        const arm = 4 + 5 * (1 - left);
        ctx.fillRect(0, y - 2, arm, 1);
        ctx.fillRect(this.w - arm, y - 2, arm, 1);
        ctx.fillRect(0, y + h, arm, 1);
        ctx.fillRect(this.w - arm, y + h, arm, 1);
        ctx.fillStyle = withAlpha(PALETTE.bone, 0.28 * (1 - left));
        ctx.fillRect(0, y - 1, this.w, h);
        continue;
      }

      const pulse = state.settings.reducedMotion
        ? 1
        : 0.55 + 0.45 * Math.sin(this.time * 0.006);
      ctx.fillStyle = withAlpha(alertColour(a.kind), pulse);
      ctx.fillRect(0, y - 1, this.w, h);
      // A notch on the edge, so the alert survives a colourblind read.
      ctx.fillStyle = alertColour(a.kind);
      ctx.fillRect(this.w - 3, y - 1, 3, h);
    }

    // ---- viewport bracket -------------------------------------------------
    const range = this.silo.visibleFloorRange();
    const top = pad + (range.from - 1) * step - 1;
    const height = Math.max(6, (range.to - range.from + 1) * step);
    ctx.strokeStyle = PALETTE.sodium;
    ctx.lineWidth = 1;
    ctx.strokeRect(1.5, top + 0.5, this.w - 3, height);
    // Bracket ticks top and bottom make the handle look grabbable.
    ctx.fillStyle = PALETTE.sodium;
    ctx.fillRect(1, top, 5, 1);
    ctx.fillRect(this.w - 6, top, 5, 1);
    ctx.fillRect(1, top + height, 5, 1);
    ctx.fillRect(this.w - 6, top + height, 5, 1);
  }

  _bind() {
    let dragging = false;
    const jump = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const floor = this.floorAtY(e.clientY - rect.top);
      this.silo.focusFloor(floor);
      this.canvas.parentElement?.setAttribute('aria-valuenow', String(floor));
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      this.canvas.setPointerCapture?.(e.pointerId);
      jump(e);
    });
    this.canvas.addEventListener('pointermove', (e) => dragging && jump(e));
    this.canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      this.canvas.releasePointerCapture?.(e.pointerId);
    });
    this.canvas.addEventListener('pointercancel', () => (dragging = false));

    // Keyboard: the gauge is a slider, so arrows move a floor at a time.
    const host = this.canvas.parentElement;
    host?.addEventListener('keydown', (e) => {
      const cur = Number(host.getAttribute('aria-valuenow') || 1);
      let next = cur;
      if (e.key === 'ArrowDown') next = cur + 1;
      else if (e.key === 'ArrowUp') next = cur - 1;
      else if (e.key === 'PageDown') next = cur + 10;
      else if (e.key === 'PageUp') next = cur - 10;
      else if (e.key === 'Home') next = 1;
      else if (e.key === 'End') next = BAL.silo.totalFloors;
      else return;
      e.preventDefault();
      next = Math.max(1, Math.min(BAL.silo.totalFloors, next));
      host.setAttribute('aria-valuenow', String(next));
      this.silo.focusFloor(next);
    });
  }
}

function floorOccupancy(state, floor) {
  let filled = 0;
  let running = 0;
  const counted = new Set();
  for (const id of floor.slots) {
    if (id == null) continue;
    filled++;
    if (counted.has(id)) continue;
    counted.add(id);
    const room = state.silo.rooms[id];
    if (room && room.powered) running += room.width;
  }
  return { filled, running };
}

function alertColour(kind) {
  switch (kind) {
    case 'warn':
      return PALETTE.rust;
    case 'rad':
      return PALETTE.toxin;
    case 'good':
      return PALETTE.verdigris;
    default:
      return PALETTE.sodium;
  }
}

export default DepthGauge;
