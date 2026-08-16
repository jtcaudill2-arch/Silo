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
 * before it reaches a draw call — at 144 floors that matters.
 */

import { BAL } from '../config/balance.js';
import { drawFloor, drawRoom, drawShaft, drawStair, drawFloorLabel, drawPlacement } from './floors.js';
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
    this.fitScale = 1;
    this.zoom = 1;

    // Camera is expressed in world Y (pixels down from the top of floor 1).
    this.camY = 0;
    this.targetY = 0;
    this.fling = 0; // world units per ms of coast left after a flick
    // Real milliseconds, for anything that belongs to the interface: the
    // placement pulse, the lamp flicker. Those are affordances the player is
    // looking at, and they should not race when the clock is turned up.
    this.time = 0;
    // Silo milliseconds, for anything that belongs to the world. A citizen's
    // walk is the silo's time passing, so it runs at the silo's rate.
    this.worldTime = 0;
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
    // This is the *fitted* scale — the whole width of the silo on screen — and
    // it is the anchor the zoom multiplies, so a resize or a rotation keeps
    // whatever magnification the player chose instead of throwing it away.
    this.fitScale = Math.max(0.42, Math.min(1.6, (this.w * 0.96) / WORLD_W));
    this.applyZoom();
    this.ctx.imageSmoothingEnabled = false;
  }

  /**
   * How close the player is standing.
   *
   * There was no zoom at all, and on a phone the cross-section is six slots
   * wide in about 380 pixels — a citizen is twelve pixels tall and a room
   * fixture is forty. Everything the game spent its art budget on was too
   * small to look at, which is most of "it's hard to stay engaged": there was
   * nothing to lean into.
   *
   * Multiplied onto the fitted scale rather than replacing it, so 1 always
   * means "the whole silo across the screen" whatever the device, and the
   * clamp is in units a player can reason about: all the way out is the fit,
   * all the way in is three times that.
   */
  applyZoom() {
    this.zoom = Math.max(1, Math.min(BAL.render.maxZoom, this.zoom || 1));
    this.scale = this.fitScale * this.zoom;
  }

  /**
   * Zoom about a point on the glass, so what is under the fingers stays under
   * them. Without that anchoring a pinch drags the silo out from under the
   * hand that is pinching it, which reads as the camera fighting back.
   */
  setZoom(next, anchorClientY = null) {
    const before = this.zoom;
    this.zoom = next;
    this.applyZoom();
    if (this.zoom === before) return;

    if (anchorClientY != null) {
      const rect = this.canvas.getBoundingClientRect();
      const y = anchorClientY - rect.top;
      // World point under the anchor before the change, held there after it.
      const world = y / (this.fitScale * before) + this.camY;
      this.targetY = this.clampCamera(world - y / this.scale);
      this.camY = this.targetY;
    } else {
      // No anchor: hold the middle of the screen.
      const mid = this.camY + this.h / (this.fitScale * before) / 2;
      this.targetY = this.clampCamera(mid - this.viewWorldH() / 2);
      this.camY = this.targetY;
    }
    this.fling = 0;
    this.onZoom?.(this.zoom);
  }

  /** Centre the camera on a floor. */
  focusFloor(n, immediate = false) {
    const target = (n - 1) * FLOOR_H - this.viewWorldH() / 2 + FLOOR_H / 2;
    this.targetY = this.clampCamera(target);
    // Any coast in progress is over: something has asked for a specific
    // floor, and a fling still decaying underneath it would slide the view
    // back off the room the player was just sent to. `n` may be fractional —
    // the depth gauge passes an exact position while a finger is on it.
    this.fling = 0;
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

  render(dt, simDt = dt) {
    const ctx = this.ctx;
    const state = this.state;
    this.time += dt;
    this.worldTime += simDt;
    this.drawn = 0;

    // Coast from a flick, before the easing — the fling moves the *target*, so
    // a jump ordered mid-coast (an alert, the depth gauge) still wins and the
    // two never fight over camY. Reduced motion means no coast at all: it is
    // motion the player did not ask for once their finger has left the glass.
    if (this.fling && !state.settings.reducedMotion) {
      const before = this.targetY;
      this.targetY = this.clampCamera(this.targetY + this.fling * dt);
      // Decay per millisecond, so the coast is the same length whatever the
      // frame rate. Stop at the floor, and stop dead against the ends rather
      // than grinding there.
      this.fling *= Math.pow(BAL.render.flingDecayPerMs, dt);
      if (Math.abs(this.fling) < BAL.render.flingMinVelocity || this.targetY === before) {
        this.fling = 0;
      }
      this.camY = this.targetY;
    } else if (this.fling) {
      this.fling = 0;
    }

    // Camera easing. Killed under reduced-motion so nothing glides.
    const lerp = state.settings.reducedMotion ? 1 : BAL.render.cameraLerp;
    this.camY += (this.targetY - this.camY) * lerp;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = PALETTE.concreteDeep;
    ctx.fillRect(0, 0, this.w, this.h);

    // Snap the camera to a whole *device* pixel, not a whole world unit.
    //
    // Pixel art has to land on pixel boundaries or it shimmers, which is why
    // this rounded at all. But it rounded `camY`, which is in world units, and
    // the transform then multiplies that by scale and dpr — so the smallest
    // move the screen could make was one world unit, two or three device
    // pixels depending on zoom. A finger travelling one CSS pixel moved the
    // camera by a fraction of a world unit, `Math.round` threw it away, and
    // the screen stayed still until enough movement accumulated to cross a
    // half-unit and jump. Measured mid-drag: the drawn position only ever took
    // integer values, so a slow drag advanced in visible steps of 5, 6 and 7
    // units rather than sliding.
    //
    // Dividing back out by the same factor keeps the drawn edge on a device
    // pixel — the crispness the rounding was for — while letting the camera
    // hold any position in between.
    const k = this.scale * this.dpr;
    this._drawnCamY = k > 0 ? Math.round(this.camY * k) / k : this.camY;
    ctx.translate(Math.round(this.w / 2), 0);
    ctx.scale(this.scale, this.scale);
    ctx.translate(-WORLD_W / 2, -this._drawnCamY);

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

    // The stair over the rooms and under the people: it is a shaft the floors
    // open onto, so it occludes what it passes, and somebody climbing it has
    // to be in front of the steps rather than behind them.
    drawStair(ctx, state, range);

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
    // World coords come back too: a room is not the only thing on the
    // cross-section that can be tapped, and callers that hit-test something
    // finer than a bay need the position rather than the grid cell.
    return { floor: floorN, slot, roomId: floor ? floor.slots[slot] : null, worldX, worldY };
  }

  // ----------------------------------------------------------- pointer ---

  _bindPointer() {
    let dragging = false;
    let lastY = 0;
    let moved = 0;
    let downAt = 0;
    let lastT = 0;
    let velocity = 0; // world units per ms, smoothed across recent moves

    // Live pointers, so a second finger can be told from a second tap. A pinch
    // is the only two-finger gesture the cross-section has, and while one is
    // in progress the one-finger drag is suspended rather than fighting it.
    const points = new Map();
    let pinch = null; // { gap, zoom, midY }

    const midpointOf = () => {
      const ys = [...points.values()].map((p) => p.y);
      return (ys[0] + ys[1]) / 2;
    };
    const gapOf = () => {
      const p = [...points.values()];
      return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    };

    const down = (e) => {
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (points.size === 2) {
        // Second finger down: the drag becomes a pinch, and whatever coast was
        // running stops — two fingers on the glass is not a flick.
        dragging = false;
        this.fling = 0;
        pinch = { gap: gapOf(), zoom: this.zoom, midY: midpointOf() };
        return;
      }
      if (points.size > 2) return;
      dragging = true;
      moved = 0;
      lastY = e.clientY;
      downAt = performance.now();
      lastT = downAt;
      velocity = 0;
      this.fling = 0; // catching a coasting silo stops it, as it should
      this.canvas.setPointerCapture?.(e.pointerId);
    };
    const move = (e) => {
      if (points.has(e.pointerId)) points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && points.size >= 2) {
        const gap = gapOf();
        if (pinch.gap > 8) this.setZoom(pinch.zoom * (gap / pinch.gap), midpointOf());
        return;
      }
      if (!dragging) return;
      const dy = e.clientY - lastY;
      lastY = e.clientY;
      moved += Math.abs(dy);
      // Velocity in world units per millisecond, smoothed, so a flick can be
      // told from a slow drag that happens to end while still moving.
      const t = performance.now();
      const dtMs = Math.max(1, t - lastT);
      lastT = t;
      const v = -dy / this.scale / dtMs;
      const a = BAL.render.flingVelocitySmoothing;
      velocity = velocity * (1 - a) + v * a;
      this.targetY = this.clampCamera(this.targetY - dy / this.scale);
      this.camY = this.targetY; // dragging is 1:1, no easing
      this.fling = 0; // a new touch kills any coast in progress
    };
    const up = (e) => {
      points.delete(e.pointerId);
      if (pinch) {
        // Lifting one of two fingers ends the pinch. The remaining finger does
        // not silently become a drag: it has been still relative to the other
        // one and its `lastY` is stale, so treating it as a drag would jump the
        // camera by whatever the pinch moved.
        if (points.size < 2) { pinch = null; dragging = false; }
        return;
      }
      if (!dragging) return;
      dragging = false;
      this.canvas.releasePointerCapture?.(e.pointerId);
      // Let go mid-flick and the silo keeps going, the way every scrollable
      // surface on a phone does. Without this the cross-section stopped dead
      // under the finger, which reads as the drag having been dropped.
      const idle = performance.now() - lastT > BAL.render.flingStaleMs;
      this.fling = idle || Math.abs(velocity) < BAL.render.flingMinVelocity ? 0 : velocity;
      velocity = 0;
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
    this.canvas.addEventListener('pointercancel', (e) => {
      points.delete(e.pointerId);
      dragging = false;
      if (points.size < 2) pinch = null;
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Ctrl-wheel is the desktop pinch, and it is what a trackpad sends.
        if (e.ctrlKey) {
          this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientY);
          return;
        }
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
