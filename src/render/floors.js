/**
 * floors.js — the cutaway itself.
 *
 * Rooms are lit interiors in a dark shaft, and the unexcavated rock below the
 * last dug floor is drawn as solid darkness. That boundary is the visible
 * frontier of the game — it should always be obvious where the silo stops.
 *
 * Room interiors come out of the atlas, one fixture per bay, so a three-wide
 * room reads as three machines rather than one stretched one. The shapes,
 * lighting and category colouring underneath are what a room falls back to
 * when the atlas has not loaded or has no frame for that type — see
 * `missingRoomArt()` for which types those are.
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

  // The void behind the stair, so the shaft has a back wall to be cut into
  // rather than floating over whatever room is behind it. The stair itself is
  // drawn after the rooms — see `drawStair`.
  if (visBottom > visTop) {
    ctx.fillStyle = PALETTE.concreteDeeper;
    ctx.fillRect(stairLeft(), visTop, BAL.render.stairWidth, visBottom - visTop);
  }
}

/** Where the shaft starts, in world units. Between slot 2 and slot 3. */
export function stairLeft() {
  return Math.round(WORLD_W / 2 - BAL.render.stairWidth / 2);
}

/** The centre line people walk down. */
export function stairX() {
  return stairLeft() + BAL.render.stairWidth / 2;
}

/**
 * The great stair.
 *
 * Drawn *over* the rooms, and that is the whole of what makes it read as
 * architecture. It used to be six translucent pixels behind them, which meant
 * that on any floor with a room across the middle — most floors — it was not
 * there at all, and where it was visible it read as a scratch on the glass.
 * A stairwell in a cutaway is a shaft the floors open onto; it occludes what
 * it passes, the way the real thing would.
 *
 * Switchbacks rather than a spiral. A spiral seen side-on needs more pixels
 * across than a 22-unit shaft has, and what it degrades into at this size is
 * noise; alternating flights read as stairs immediately. Which way a flight
 * leans is decided by the floor number, so the zigzag is continuous down the
 * whole silo rather than random per floor.
 *
 * Only across dug floors: the stair does not exist in rock nobody has cut yet,
 * and drawing it there would say the silo is deeper than it is.
 */
export function drawStair(ctx, state, range) {
  const R = BAL.render;
  const left = stairLeft();
  const w = R.stairWidth;
  const lastDug = lastExcavatedFloor(state);
  const from = Math.max(1, range.from);
  const to = Math.min(lastDug, range.to);
  if (to < from) return;

  const top = (from - 1) * FLOOR_H;
  const height = (to - from + 1) * FLOOR_H;

  // Opaque, and that is the point. The first version of this drew two
  // translucent walls over the rooms and the room art carried on between them,
  // so the whole thing read as a pair of scratches on the glass — which is
  // exactly what the six-pixel bar it replaced looked like. A shaft is a hole
  // through the building. It has to be dark inside and it has to cover what it
  // passes in front of.
  ctx.fillStyle = PALETTE.concreteDeeper;
  ctx.fillRect(left, top, w, height);
  ctx.fillStyle = PALETTE.concrete;
  ctx.fillRect(left, top, 1, height);
  ctx.fillRect(left + w - 1, top, 1, height);

  const steps = R.stairStepsPerFlight;
  const rise = FLOOR_H / steps;
  const run = (w - 6) / steps;
  for (let n = from; n <= to; n++) {
    const fTop = (n - 1) * FLOOR_H;
    // The flight: `stairStepsPerFlight` treads crossing the shaft. Even floors
    // lean one way and odd floors the other, so it switches back at every
    // landing the way a real stairwell does, and the zigzag is continuous down
    // the whole silo rather than random per floor.
    const leftward = n % 2 === 0;
    for (let i = 0; i < steps; i++) {
      const y = Math.round(fTop + i * rise);
      const x = leftward
        ? Math.round(left + 3 + (steps - 1 - i) * run)
        : Math.round(left + 3 + i * run);
      const tread = Math.max(3, Math.round(run) + 1);
      // The tread, then the riser under its leading edge — two tones, because
      // a single line of one colour at this size reads as a dash rather than
      // as a step.
      ctx.fillStyle = PALETTE.concreteLit;
      ctx.fillRect(x, y, tread, 1);
      ctx.fillStyle = withAlpha(PALETTE.concrete, 0.9);
      ctx.fillRect(leftward ? x : x + tread - 1, y, 1, Math.round(rise));
    }
    // The landing, which is what the floor's corridor actually opens onto.
    ctx.fillStyle = PALETTE.bone;
    ctx.fillRect(left + 1, Math.round(fTop + FLOOR_H) - 2, w - 2, 1);
  }
}

export function drawFloor(ctx, floor, n, cam) {
  const y = (n - 1) * FLOOR_H;

  if (!floor.excavated) {
    // A sealed level, and it has to read as sealed rather than as nothing.
    //
    // This was a single hairline at 14% alpha, which was right when eight
    // undug floors sat below the player. There are now a hundred and thirty
    // eight, and at that count a hairline is not a closed door, it is void —
    // the silo appeared to simply stop a few floors down. So: a face slightly
    // above the black of the shaft, a lintel line, and the seam of the door
    // itself down the middle. Quiet enough that a hundred of them stacked do
    // not compete with the lit silo above; present enough to say there is
    // something there and it is shut.
    ctx.fillStyle = withAlpha(PALETTE.concrete, 0.09);
    ctx.fillRect(0, y + 1, WORLD_W, FLOOR_H - 2);
    ctx.fillStyle = withAlpha(PALETTE.concrete, 0.22);
    ctx.fillRect(0, y + FLOOR_H - 1, WORLD_W, 1);
    const mid = Math.round(WORLD_W / 2);
    ctx.fillStyle = withAlpha(PALETTE.concrete, 0.3);
    ctx.fillRect(mid - 1, y + 6, 2, FLOOR_H - 13);
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

  // What the rock is doing to this floor, read straight off its integrity.
  //
  // It used to be one bit — shored or not — which drew the same mark on a
  // floor with two hundred days in it as on one about to come down. The
  // standing order names a floor number; this is what makes that number
  // findable by scrolling, so the hatching thickens as the floor runs down and
  // goes solid once the shoring has actually failed.
  if (n >= BAL.silo.excavation.shoringRequiredBelowFloor) {
    const S = BAL.silo.strain;
    const integrity = Number.isFinite(floor.integrity) ? floor.integrity : 100;
    const gone = !floor.shored;
    if (gone || integrity < S.warnBelow) {
      const t = gone ? 1 : Math.min(1, (S.warnBelow - integrity) / S.warnBelow);
      ctx.fillStyle = withAlpha(PALETTE.rust, 0.4 + 0.6 * t);
      const step = gone ? 12 : 24;
      const dash = gone ? 10 : 8;
      for (let x = 4; x < WORLD_W; x += step) ctx.fillRect(x, y + 1, dash, gone ? 2 : 1);
    }
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
 * Which fixture a room of this level draws.
 *
 * Level 1 keeps the bare `room_<id>`, so every save, test and caller that
 * predates levelled art goes on working and a type with no variants baked
 * still draws. Mirrors `tools/art/rooms.mjs:fixtureName` — the renderer cannot
 * import from tools/, so the two agree by test rather than by sharing code
 * (test/atlas.mjs walks every name this can produce against the sheet).
 */
function fixtureAtLevel(id, level) {
  const n = Math.max(1, Math.min(BAL.silo.upgrade.maxLevel, Math.round(level || 1)));
  const name = n === 1 ? `room_${id}` : `room_${id}_l${n}`;
  return sprites.frame(name) ? name : `room_${id}`;
}

/**
 * One atlas fixture per bay, so a three-wide room reads as three machines
 * rather than one stretched one. Dimmed when the room isn't running.
 */
function drawFixture(ctx, room, def, x, y, w, h, running) {
  if (!sprites.isLoaded()) return false;
  // The room at its level. An upgraded room used to draw the same picture as a
  // new one and the only thing that changed was the pips below — six pixels for
  // the main thing a mid-game silo does. The sheet carries five fixtures per
  // type now; `tools/art/rooms.mjs:upgradeLayer` is what the extra plant is.
  //
  // Falls back to the bare name, which is level 1's, so a room type whose
  // variants have not been baked still draws rather than vanishing.
  const name = fixtureAtLevel(def.id, room.level);
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
 * Placement mode: where the chosen building could go, ranked.
 *
 * This used to light every legal bay identically. On the first morning that is
 * twenty-four amber boxes across six floors, of which exactly one — the bay
 * that would merge into the room beside it — is a different decision from the
 * other twenty-three. Twenty-four equal targets is not a choice, and the one
 * that mattered was drawn as a 2px bar between 2px corner ticks in the same
 * colour, so it was not even visible.
 *
 * So the bays are ranked, and only the ranked ones are drawn as targets:
 *
 *   merge      the bay that joins an identical neighbour into a wider unit.
 *              Wider units make more per slot and draw less power per slot, so
 *              this is the only bay that is genuinely better than its
 *              neighbours. Drawn as a bracket around *both* bays with an arrow
 *              into the neighbour: two things becoming one, not a bar.
 *   suggested  one plain bay per floor near the camera, so every floor with
 *              room on it offers somewhere to tap without offering six.
 *   free       everything else. Still legal, still tappable, drawn as an empty
 *              bay with a hairline instead of as a target competing for the eye.
 *
 * The rest of the silo is washed back so the targets are the brightest things
 * on the screen. Sodium amber throughout: toxin green means radiation in this
 * game and nothing else.
 */
export function drawPlacement(ctx, mode, range, cam, pulse) {
  const P = BAL.render.placement;
  const W = BAL.wayfinding.placement;

  // Wash. Drawn wider and taller than the viewport so a mid-drag camera never
  // shows an un-dimmed strip at the edge.
  const top = cam.camY - FLOOR_H;
  const height = cam.viewWorldH() + FLOOR_H * 2;
  ctx.fillStyle = withAlpha(PALETTE.concreteDeeper, P.washAlpha);
  ctx.fillRect(-WORLD_W, top, WORLD_W * 3, height);

  const state = cam.state;
  const focus = cameraFloor(cam);
  const fill = P.fillAlpha + P.fillPulse * pulse;

  for (let n = range.from; n <= range.to; n++) {
    const slots = mode.bays.get(n);
    if (!slots) continue;
    const y = (n - 1) * FLOOR_H + GAP;
    const h = FLOOR_H - 3 - GAP * 2;
    const suggested = suggestedSlots(state, n, slots, focus, W);

    for (const [slot, mergeSide] of slots) {
      const x = slot * SLOT_W + GAP;
      const w = SLOT_W - GAP * 2;

      // ---- a free bay nobody is pointing at ------------------------------
      if (!mergeSide && !suggested.has(slot)) {
        ctx.fillStyle = withAlpha(PALETTE.sodium, W.quietFill);
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = withAlpha(PALETTE.sodium, W.quietEdge);
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        continue;
      }

      ctx.fillStyle = withAlpha(PALETTE.sodium, mergeSide ? fill + W.mergeFill : fill);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = withAlpha(PALETTE.sodium, mergeSide ? W.mergeEdge : P.edgeAlpha);
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

      if (mergeSide) drawMerge(ctx, state, n, slot, mergeSide, y, h);
      else {
        // A plus in the middle: "something goes here".
        const mx = x + w / 2;
        const my = y + h / 2;
        ctx.fillRect(mx - 5, my - 1, 10, 2);
        ctx.fillRect(mx - 1, my - 5, 2, 10);
      }
    }
  }
}

/** Whichever floor is in the middle of the viewport right now. */
function cameraFloor(cam) {
  return Math.round((cam.camY + cam.viewWorldH() / 2) / FLOOR_H) + 1;
}

/**
 * The one plain bay per floor worth pointing at — or none, on a floor the
 * camera is nowhere near.
 *
 * A bay beside something already built is preferred over one out on its own:
 * it keeps a floor contiguous, which is what leaves a clean run of empty bays
 * for the next thing and what makes a future merge possible at all. Floors
 * that already carry a merge target are left alone — the merge is the answer
 * on that floor and a second bright box beside it is just noise.
 */
function suggestedSlots(state, n, slots, focus, W) {
  const out = new Set();
  // A floor with a merge on it has its answer already, and a second bright box
  // beside the merge only competes with it.
  for (const side of slots.values()) if (side) return out;

  const floor = state.silo.floors[n - 1];
  const adjacent = [...slots.keys()].filter(
    (s) => floor?.slots?.[s - 1] != null || floor?.slots?.[s + 1] != null
  );
  // Beside something already standing, on any floor that has something
  // standing; otherwise the first bay of a floor the player is actually
  // looking at. Bare rock eleven floors away offers nothing, which is correct:
  // one empty bay down there is exactly as good as the next thirty.
  const pool = adjacent.length
    ? adjacent
    : Math.abs(n - focus) <= W.suggestFloorRadius
      ? [...slots.keys()]
      : [];
  for (const slot of [...pool].sort((a, b) => a - b).slice(0, W.suggestedPerFloor)) out.add(slot);
  return out;
}

/**
 * What a merge actually does, drawn: a bracket around the bay *and* the room
 * it would join, and an arrow pointing through the wall between them.
 *
 * The old drawing was a two-pixel bar against one edge, between two-pixel
 * corner ticks in the same colour, on a bay the same size and brightness as
 * seventy-three others. Nothing about it said "these two become one unit".
 */
function drawMerge(ctx, state, n, slot, side, y, h) {
  const floor = state.silo.floors[n - 1];
  const neighbour = state.silo.rooms[floor?.slots?.[slot + side]];
  const from = neighbour ? Math.min(slot, neighbour.slot) : Math.min(slot, slot + side);
  const to = neighbour
    ? Math.max(slot + 1, neighbour.slot + neighbour.width)
    : Math.max(slot + 1, slot + side + 1);

  const bx = from * SLOT_W + GAP;
  const bw = (to - from) * SLOT_W - GAP * 2;
  const my = y + h / 2;

  // The unit the merge would produce, bracketed top and bottom.
  ctx.fillStyle = PALETTE.sodium;
  ctx.fillRect(bx - 2, y - 3, bw + 4, 2);
  ctx.fillRect(bx - 2, y + h + 1, bw + 4, 2);
  ctx.fillRect(bx - 2, y - 3, 2, 5);
  ctx.fillRect(bx + bw, y - 3, 2, 5);
  ctx.fillRect(bx - 2, y + h - 1, 2, 5);
  ctx.fillRect(bx + bw, y + h - 1, 2, 5);

  // An arrow through the wall it joins through, pointing at the neighbour.
  const x = slot * SLOT_W + GAP;
  const w = SLOT_W - GAP * 2;
  const tip = side < 0 ? x - 1 : x + w + 1;
  const tail = side < 0 ? x + w - 5 : x + 5;
  ctx.fillRect(Math.min(tip, tail), my - 1, Math.abs(tip - tail), 2);
  for (let i = 0; i < 5; i++) {
    // A triangle: one pixel tall at the tip, widening back along the shaft.
    ctx.fillRect(tip + (side < 0 ? i : -i), my - i, 1, 1 + i * 2);
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
