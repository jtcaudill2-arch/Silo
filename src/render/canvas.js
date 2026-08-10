/**
 * canvas.js — camera, culling, draw order.
 *
 * The silo is drawn as a side-on cutaway: a dark shaft with lit interiors.
 * World coordinates are fixed (a slot is SLOT_W wide, a floor is FLOOR_H
 * tall) and the camera scales them to the viewport, so nothing downstream has
 * to think about device pixel ratio or screen size.
 *
 * Draw order is back-to-front: shaft void, floor shells, room interiors,
 * room contents, citizens, overlays. Anything outside the viewport is culled
 * before it reaches a draw call — at 92 floors that matters.
 */

import { BAL } from '../config/balance.js';
import { drawFloor, drawRoom, drawShaft, drawFloorLabel, drawPlacement } from './floors.js';
import { drawCitizens } from './citizens.js';

export const SLOT_W = BAL.render.slotWidth;
export const FLOOR_H = BAL.render.floorHeight;
export const SLOTS = BAL.silo.slotsPerFloor;
export const WORLD_W = SLOT_W * SLOTS;

/**
 * Placement mode — the cross-section's half of pick-then-place.
 *
 * The shell owns the decision (which building, which bays are legal, what to
 * do when one is tapped) and parks it here; the renderer lights those bays and
 * routes the next tap back. It is module state rather than a constructor
 * argument because the shell and the renderer are wired together in main.js
 * and neither holds a reference to the other — and because it is transient UI,
 * so it deliberately never reaches the store or a save file.
 *
 * Shape: { typeId, bays: Map<floorN, Map<slot, mergeSide>>, onPick, onCancel,
 *          onCameraFloor? }
 *
 * `onCameraFloor` is optional and is called with the floor in the middle of
 * the viewport whenever that changes while placing. It exists because the
 * placing bar lists shortcuts to "the bays nearest what the player is already
 * looking at", and what the player is looking at is decided here — by a drag,
 * a wheel, or the depth gauge — not by the shell. Without it the bar is built
 * once at the start of the gesture and then lies: start on floor 2, drag to
 * floor 13, and it still offers Floor 2 Bay 1-6.
 */
let placing = null;

export function setPlacement(mode) {
  placing = mode || null;
}

/** The placement in progress, for other renderers that need to mark it. */
export function getPlacement() {
  return placing;
}

export class SiloRenderer {
  constructor(canvas, store) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.store = store;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.scale = 1;

    // Camera is expressed in world Y (pixels down from the top of floor 1).
    this.camY = 0;
    this.targetY = 0;
    this.time = 0;
    this.spriteBudget = BAL.render.maxSpritesPerFrame;
    this.drawn = 0;
    this.hoverRoom = null;

    this._bindPointer();
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
    // Fit the six slots across with a margin, but never shrink below legible.
    this.scale = Math.max(0.42, Math.min(1.6, (this.w * 0.96) / WORLD_W));
    this.ctx.imageSmoothingEnabled = false;
  }

  /** Centre the camera on a floor. */
  focusFloor(n, immediate = false) {
    const target = (n - 1) * FLOOR_H - this.viewWorldH() / 2 + FLOOR_H / 2;
    this.targetY = this.clampCamera(target);
    if (immediate) this.camY = this.targetY;
  }

  viewWorldH() {
    return this.h / this.scale;
  }

  clampCamera(y) {
    const maxFloor = BAL.silo.totalFloors;
    const max = maxFloor * FLOOR_H - this.viewWorldH();
    return Math.max(-FLOOR_H * 0.5, Math.min(Math.max(0, max) + FLOOR_H, y));
  }

  /** Which floors are on screen right now. */
  visibleFloorRange() {
    const top = this.camY;
    const bottom = this.camY + this.viewWorldH();
    return {
      from: Math.max(1, Math.floor(top / FLOOR_H)),
      to: Math.min(BAL.silo.totalFloors, Math.ceil(bottom / FLOOR_H) + 1),
    };
  }

  // ------------------------------------------------------------- render ---

  render(dt) {
    const ctx = this.ctx;
    const state = this.state;
    this.time += dt;
    this.drawn = 0;

    // Camera easing. Killed under reduced-motion so nothing glides.
    const lerp = state.settings.reducedMotion ? 1 : BAL.render.cameraLerp;
    this.camY += (this.targetY - this.camY) * lerp;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = PALETTE.concreteDeep;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.translate(Math.round(this.w / 2), 0);
    ctx.scale(this.scale, this.scale);
    ctx.translate(-WORLD_W / 2, -Math.round(this.camY));

    const range = this.visibleFloorRange();
    const flicker = this.flicker(state);

    drawShaft(ctx, state, range, this);

    // Floors first (shells), then the rooms sitting in them.
    for (let n = range.from; n <= range.to; n++) {
      const floor = state.silo.floors[n - 1];
      if (!floor) continue;
      drawFloor(ctx, floor, n, this);
      this.drawn++;
    }

    const seen = new Set();
    for (let n = range.from; n <= range.to; n++) {
      const floor = state.silo.floors[n - 1];
      if (!floor) continue;
      for (const id of floor.slots) {
        if (id == null || seen.has(id)) continue;
        seen.add(id);
        const room = state.silo.rooms[id];
        if (!room) continue;
        drawRoom(ctx, room, state, this, flicker);
        this.drawn++;
        if (this.drawn > this.spriteBudget) break;
      }
    }

    // Citizens only on the floors closest to the camera centre (spec §3.5).
    drawCitizens(ctx, state, this);

    for (let n = range.from; n <= range.to; n++) {
      drawFloorLabel(ctx, n, state, this);
    }

    // Placement targets sit on top of everything, over a wash that takes the
    // rest of the silo down — a lit bay has to be the brightest thing on the
    // screen or it is just another bay.
    if (placing) drawPlacement(ctx, placing, range, this, this.placementPulse(state));

    ctx.restore();

    // Tell the placing bar where the player has got to. Done here rather than
    // in the drag handler so it fires for every way the camera moves — finger,
    // wheel, depth gauge, or a jump made from a line of text — and only when
    // the answer has actually changed.
    if (placing) {
      const floor = Math.round((this.camY + this.viewWorldH() / 2) / FLOOR_H) + 1;
      if (floor !== this._placeFocus) {
        this._placeFocus = floor;
        placing.onCameraFloor?.(floor);
      }
    } else if (this._placeFocus != null) {
      this._placeFocus = null;
    }
  }

  /** 0 → 1 → 0 breath for the placement highlight. Flat under reduced motion. */
  placementPulse(state) {
    if (state.settings.reducedMotion) return 1;
    const t = (this.time % BAL.render.placement.pulseMs) / BAL.render.placement.pulseMs;
    return 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
  }

  /**
   * Sodium lighting flicker. Subtle, and completely off under
   * prefers-reduced-motion — it's the main source of motion on this screen.
   */
  flicker(state) {
    if (state.settings.reducedMotion) return 1;
    const t = this.time * 0.001 * BAL.render.flickerSpeed;
    const n = Math.sin(t * 2.1) * 0.5 + Math.sin(t * 5.7) * 0.3 + Math.sin(t * 11.3) * 0.2;
    return 1 + n * BAL.render.flickerAmplitude;
  }

  // ---------------------------------------------------------- hit test ---

  /** Screen coords -> {floor, slot, roomId} or null. */
  hitTest(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const worldX = (x - this.w / 2) / this.scale + WORLD_W / 2;
    const worldY = y / this.scale + this.camY;
    if (worldX < 0 || worldX > WORLD_W) return null;
    const floorN = Math.floor(worldY / FLOOR_H) + 1;
    if (floorN < 1 || floorN > BAL.silo.totalFloors) return null;
    const slot = Math.floor(worldX / SLOT_W);
    const floor = this.state.silo.floors[floorN - 1];
    return { floor: floorN, slot, roomId: floor ? floor.slots[slot] : null };
  }

  // ----------------------------------------------------------- pointer ---

  _bindPointer() {
    let dragging = false;
    let lastY = 0;
    let moved = 0;
    let downAt = 0;

    const down = (e) => {
      dragging = true;
      moved = 0;
      lastY = e.clientY;
      downAt = performance.now();
      this.canvas.setPointerCapture?.(e.pointerId);
    };
    const move = (e) => {
      if (!dragging) return;
      const dy = e.clientY - lastY;
      lastY = e.clientY;
      moved += Math.abs(dy);
      this.targetY = this.clampCamera(this.targetY - dy / this.scale);
      this.camY = this.targetY; // dragging is 1:1, no easing
    };
    const up = (e) => {
      if (!dragging) return;
      dragging = false;
      this.canvas.releasePointerCapture?.(e.pointerId);
      // A tap, not a drag. Dragging still pans while placing — reaching a bay
      // eleven floors down is the whole reason the cross-section is scrollable.
      if (moved >= 6 || performance.now() - downAt >= 600) return;
      const hit = this.hitTest(e.clientX, e.clientY);
      if (placing) {
        // A legal bay maps to a merge side, and 0 — "a new unit, no merge" —
        // is one of them, so this asks whether the key is there, not whether
        // it is truthy.
        const lit = hit ? placing.bays.get(hit.floor)?.has(hit.slot) : false;
        if (lit) placing.onPick(hit.floor, hit.slot);
        else placing.onCancel(); // tapping anywhere else backs out
        return;
      }
      if (hit) this.onTap?.(hit);
    };

    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', () => (dragging = false));
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.targetY = this.clampCamera(this.targetY + e.deltaY / this.scale);
      },
      { passive: false }
    );
  }
}

/**
 * The palette, mirrored from CSS so canvas and DOM can never drift apart.
 * Read from the stylesheet at boot rather than duplicated as literals.
 */
export const PALETTE = {
  concreteDeep: '#232729',
  concreteDeeper: '#1a1d1f',
  concrete: '#3a4042',
  concreteLit: '#5a6163',
  sodium: '#e8a33d',
  verdigris: '#4e8c7a',
  rust: '#a34b2a',
  toxin: '#8fb33a',
  bone: '#d9d2c4',
};

export function syncPaletteFromCSS() {
  if (typeof getComputedStyle !== 'function') return PALETTE;
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  PALETTE.concreteDeep = pick('--concrete-deep', PALETTE.concreteDeep);
  PALETTE.concrete = pick('--concrete', PALETTE.concrete);
  PALETTE.concreteLit = pick('--concrete-lit', PALETTE.concreteLit);
  PALETTE.sodium = pick('--sodium', PALETTE.sodium);
  PALETTE.verdigris = pick('--verdigris', PALETTE.verdigris);
  PALETTE.rust = pick('--rust', PALETTE.rust);
  PALETTE.toxin = pick('--toxin', PALETTE.toxin);
  PALETTE.bone = pick('--bone', PALETTE.bone);
  return PALETTE;
}

export default SiloRenderer;
