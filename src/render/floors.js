/**
 * floors.js — the cutaway itself.
 *
 * Rooms are lit interiors in a dark shaft, and the unexcavated rock below the
 * last dug floor is drawn as solid darkness. That boundary is the visible
 * frontier of the game — it should always be obvious where the silo stops.
 *
 * Room art is placeholder blocks for now (Phase 1 ships without an atlas);
 * the shapes, lighting and category colouring are already final so swapping
 * in sprites is a drop-in at Phase 8.
 */

import { BAL } from '../config/balance.js';
import { getRoom } from '../data/rooms.js';
import { roomCapability } from '../sim/economy.js';
import { PALETTE, SLOT_W, FLOOR_H, SLOTS, WORLD_W } from './canvas.js';
import * as sprites from './sprites.js';

const GAP = 2; // gutter between a room and the floor shell

/** Category → interior tint. Sodium does the ordinary work; toxin is reserved. */
const CATEGORY_TINT = {
  life: 'verdigris',
  production: 'sodium',
  civic: 'sodium',
  security: 'rust',
  science: 'verdigris',
  surface: 'sodium',
  storage: 'concreteLit',
};

export function drawShaft(ctx, state, range, cam) {
  // The dug column: slightly lighter than the void so the silo reads as a
  // shape even where no rooms are built.
  const lastDug = lastExcavatedFloor(state);
  ctx.fillStyle = PALETTE.concreteDeeper;
  ctx.fillRect(-8, (range.from - 1) * FLOOR_H, WORLD_W + 16, (range.to - range.from + 2) * FLOOR_H);

  ctx.fillStyle = PALETTE.concreteDeep;
  const dugTop = 0;
  const dugBottom = lastDug * FLOOR_H;
  const visTop = Math.max(dugTop, (range.from - 1) * FLOOR_H);
  const visBottom = Math.min(dugBottom, range.to * FLOOR_H);
  if (visBottom > visTop) ctx.fillRect(-6, visTop, WORLD_W + 12, visBottom - visTop);

  // The central stairwell that makes it read as one building.
  ctx.fillStyle = withAlpha(PALETTE.concrete, 0.5);
  ctx.fillRect(WORLD_W / 2 - 3, visTop, 6, Math.max(0, visBottom - visTop));
}

export function drawFloor(ctx, floor, n, cam) {
  const y = (n - 1) * FLOOR_H;

  if (!floor.excavated) {
    // Unexcavated rock. Nothing but a hairline to suggest the level exists.
    ctx.fillStyle = withAlpha(PALETTE.concrete, 0.14);
    ctx.fillRect(0, y + FLOOR_H - 1, WORLD_W, 1);
    return;
  }

  // Floor plate.
  ctx.fillStyle = PALETTE.concrete;
  ctx.fillRect(0, y + FLOOR_H - 3, WORLD_W, 3);

  // Empty slots read as dark bays, so open space is legible as buildable.
  for (let s = 0; s < SLOTS; s++) {
    if (floor.slots[s] != null) continue;
    ctx.fillStyle = withAlpha(PALETTE.concreteDeeper, 0.85);
    ctx.fillRect(s * SLOT_W + GAP, y + GAP, SLOT_W - GAP * 2, FLOOR_H - 3 - GAP * 2);
  }

  // Structural warning on an unshored deep floor.
  if (!floor.shored && n >= BAL.silo.excavation.shoringRequiredBelowFloor) {
    ctx.fillStyle = PALETTE.rust;
    for (let x = 4; x < WORLD_W; x += 24) ctx.fillRect(x, y + 1, 8, 1);
  }
}

export function drawRoom(ctx, room, state, cam, flicker) {
  const def = getRoom(room.type);
  if (!def) return;
  const x = room.slot * SLOT_W + GAP;
  const y = (room.floor - 1) * FLOOR_H + GAP;
  const w = room.width * SLOT_W - GAP * 2;
  const h = FLOOR_H - 3 - GAP * 2;

  const cap = roomCapability(state, room);
  const running = room.powered && cap > 0;
  const building = room.buildingUntilCycle > state.clock.cycle;

  // Interior. Lit rooms glow; dark rooms are just a shell.
  const tintKey = CATEGORY_TINT[def.category] || 'sodium';
  const tint = PALETTE[tintKey] || PALETTE.sodium;

  ctx.fillStyle = running ? mix(PALETTE.concreteDeeper, tint, 0.16 * flicker) : PALETTE.concreteDeeper;
  ctx.fillRect(x, y, w, h);

  // Floor of the room + a light bar along the ceiling.
  if (running) {
    ctx.fillStyle = withAlpha(tint, 0.55 * flicker);
    ctx.fillRect(x + 2, y + 1, w - 4, 1);
    ctx.fillStyle = withAlpha(tint, 0.1 * flicker);
    ctx.fillRect(x + 1, y + 2, w - 2, 4);
  }

  // Atlas fixture if we have one, procedural blocks if we don't. The game
  // must never fail to draw a room because an image didn't load.
  if (!drawFixture(ctx, room, def, x, y, w, h, running)) {
    drawPlaceholderContents(ctx, room, def, x, y, w, h, running ? tint : PALETTE.concrete);
  }

  // Shell.
  ctx.strokeStyle = running ? withAlpha(tint, 0.45) : withAlpha(PALETTE.concrete, 0.9);
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  // ---- status marks. Every alert has a shape, never colour alone. ------
  const marks = [];
  if (building) marks.push({ glyph: '▤', color: PALETTE.sodium });
  else if (!room.powered) marks.push({ glyph: '✕', color: PALETTE.rust });
  else if (def.staff && room.staff.length === 0) marks.push({ glyph: '○', color: PALETTE.sodium });
  if (room.condition < BAL.silo.condition.penaltyBelow) {
    marks.push({ glyph: '▲', color: PALETTE.rust });
  }
  if (room.contaminated) marks.push({ glyph: '☣', color: PALETTE.toxin });

  ctx.font = '8px monospace';
  ctx.textBaseline = 'top';
  let mx = x + w - 8;
  for (const m of marks) {
    ctx.fillStyle = m.color;
    ctx.fillText(m.glyph, mx, y + 2);
    mx -= 9;
  }

  // Condition bar along the bottom edge — always visible, never a tooltip.
  if (room.condition < BAL.silo.condition.start - 1) {
    const pct = room.condition / BAL.silo.condition.start;
    ctx.fillStyle = withAlpha(PALETTE.concrete, 0.8);
    ctx.fillRect(x + 1, y + h - 2, w - 2, 1);
    ctx.fillStyle = pct < 0.4 ? PALETTE.rust : withAlpha(PALETTE.bone, 0.45);
    ctx.fillRect(x + 1, y + h - 2, (w - 2) * pct, 1);
  }

  // Selection bracket.
  if (state.ui.selectedRoom === room.id) {
    ctx.strokeStyle = PALETTE.sodium;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
  }
}

/**
 * One atlas fixture per bay, so a three-wide room reads as three machines
 * rather than one stretched one. Dimmed when the room isn't running.
 */
function drawFixture(ctx, room, def, x, y, w, h, running) {
  if (!sprites.isLoaded()) return false;
  const name = `room_${def.id}`;
  if (!sprites.frame(name)) return false;
  const bayW = w / room.width;
  ctx.save();
  ctx.globalAlpha = running ? 1 : 0.45;
  for (let i = 0; i < room.width; i++) {
    sprites.draw(ctx, name, x + i * bayW, y, bayW, h);
  }
  ctx.restore();
  // Upgrade pips stay: level has to be readable without opening the room.
  ctx.fillStyle = withAlpha(PALETTE.bone, 0.6);
  for (let i = 0; i < room.level; i++) ctx.fillRect(x + 3 + i * 3, y + h - 5, 2, 2);
  return true;
}

/**
 * Deterministic block shapes per room type — the same room always looks the
 * same, so the player learns to recognise floors by silhouette.
 */
function drawPlaceholderContents(ctx, room, def, x, y, w, h, tint) {
  const seed = hash(def.id);
  const baseY = y + h - 3;
  const count = Math.min(room.width * 3, 9);
  ctx.fillStyle = withAlpha(tint, 0.5);
  for (let i = 0; i < count; i++) {
    const r = rand(seed + i * 977);
    const bw = 3 + Math.floor(r * 5);
    const bh = 3 + Math.floor(rand(seed + i * 131) * (h - 8));
    const bx = x + 3 + Math.floor((i / count) * (w - 8)) + Math.floor(rand(seed + i * 31) * 3);
    ctx.fillRect(bx, baseY - bh, bw, bh);
  }
  // Upgrade pips: level shown as marks along the top-left, readable at a glance.
  ctx.fillStyle = withAlpha(PALETTE.bone, 0.55);
  for (let i = 0; i < room.level; i++) ctx.fillRect(x + 3 + i * 3, y + h - 5, 2, 2);
}

/**
 * Placement mode: every bay the chosen building could occupy, lit.
 *
 * Two things carry it at 390px wide, where a bay is about 57×36 real pixels:
 * the rest of the silo is washed back so the targets are the only bright
 * things on screen, and each target gets corner ticks plus a mark in the
 * middle — a plus for a new unit, a bar against the wall it would merge
 * through. Colour alone would not be enough, and the colour is sodium amber
 * because toxin green means radiation in this game and nothing else.
 */
export function drawPlacement(ctx, mode, range, cam, pulse) {
  const P = BAL.render.placement;

  // Wash. Drawn wider and taller than the viewport so a mid-drag camera never
  // shows an un-dimmed strip at the edge.
  const top = cam.camY - FLOOR_H;
  const height = cam.viewWorldH() + FLOOR_H * 2;
  ctx.fillStyle = withAlpha(PALETTE.concreteDeeper, P.washAlpha);
  ctx.fillRect(-WORLD_W, top, WORLD_W * 3, height);

  const fill = P.fillAlpha + P.fillPulse * pulse;
  for (let n = range.from; n <= range.to; n++) {
    const slots = mode.bays.get(n);
    if (!slots) continue;
    const y = (n - 1) * FLOOR_H + GAP;
    const h = FLOOR_H - 3 - GAP * 2;
    for (const [slot, mergeSide] of slots) {
      const x = slot * SLOT_W + GAP;
      const w = SLOT_W - GAP * 2;

      ctx.fillStyle = withAlpha(PALETTE.sodium, fill);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = withAlpha(PALETTE.sodium, P.edgeAlpha);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

      // Corner ticks, 2px thick — the part that survives being scaled down.
      ctx.fillStyle = PALETTE.sodium;
      const b = P.bracket;
      for (const [cx, cy, sx, sy] of [
        [x, y, 1, 1],
        [x + w, y, -1, 1],
        [x, y + h, 1, -1],
        [x + w, y + h, -1, -1],
      ]) {
        ctx.fillRect(sx > 0 ? cx : cx - b, sy > 0 ? cy : cy - 2, b, 2);
        ctx.fillRect(sx > 0 ? cx : cx - 2, sy > 0 ? cy : cy - b, 2, b);
      }

      if (mergeSide) {
        // It would join the room next door: mark the wall it goes through.
        ctx.fillRect(mergeSide < 0 ? x : x + w - 2, y + 3, 2, h - 6);
      }
      // A plus in the middle: "something goes here".
      const mx = x + w / 2;
      const my = y + h / 2;
      ctx.fillRect(mx - 5, my - 1, 10, 2);
      ctx.fillRect(mx - 1, my - 5, 2, 10);
    }
  }
}

export function drawFloorLabel(ctx, n, state, cam) {
  const floor = state.silo.floors[n - 1];
  if (!floor) return;
  const y = (n - 1) * FLOOR_H;
  // Painted on the bulkhead just inside the shaft — outside it there is no
  // margin at all once the silo fills the viewport.
  ctx.save();
  ctx.globalAlpha = floor.excavated ? 0.55 : 0.22;
  if (!sprites.drawNumber(ctx, n, 2, y + 3)) {
    // No atlas: fall back to a system glyph. This is in-world signage, not
    // UI text, which is why it's allowed on the canvas at all.
    ctx.globalAlpha = 1;
    ctx.font = '8px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillStyle = floor.excavated ? withAlpha(PALETTE.bone, 0.4) : withAlpha(PALETTE.bone, 0.15);
    ctx.fillText(String(n), 12, y + FLOOR_H / 2);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

export function lastExcavatedFloor(state) {
  for (let i = state.silo.floors.length - 1; i >= 0; i--) {
    if (state.silo.floors[i].excavated) return i + 1;
  }
  return 0;
}

// ------------------------------------------------------------- colour ----

export function withAlpha(hex, a) {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export function mix(a, b, t) {
  const A = parseHex(a);
  const B = parseHex(b);
  const r = Math.round(A.r + (B.r - A.r) * t);
  const g = Math.round(A.g + (B.g - A.g) * t);
  const bl = Math.round(A.b + (B.b - A.b) * t);
  return `rgb(${r},${g},${bl})`;
}

const hexCache = new Map();
function parseHex(hex) {
  if (hexCache.has(hex)) return hexCache.get(hex);
  let h = String(hex).trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
  hexCache.set(hex, v);
  return v;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rand(n) {
  const x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
}

export default { drawFloor, drawRoom, drawShaft, drawFloorLabel, drawPlacement };
