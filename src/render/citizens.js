/**
 * citizens.js — the moving dots.
 *
 * Only citizens on the floors nearest the camera are drawn at all; everyone
 * else is simulated as numbers (spec §3.5). Positions are derived, never
 * stored: a citizen's x is a stable function of their id and the clock, so
 * this costs nothing to save and nothing to catch up.
 */

import { BAL } from '../config/balance.js';
import { getRoom } from '../data/rooms.js';

/** The skill a room's post trains, or null for rooms with no crew. */
function roomSkill(room) {
  return getRoom(room.type)?.staff?.skill || null;
}
import { PALETTE, SLOT_W, FLOOR_H } from './canvas.js';
import { withAlpha } from './floors.js';
import * as sprites from './sprites.js';

export function drawCitizens(ctx, state, cam) {
  // Everybody on screen, not a three-floor slice of the middle of it.
  //
  // This used to draw `citizenFloorsRendered` (3) floors centred on the
  // geometric middle of the viewport, and the result was a silo with nobody in
  // it. The viewport is 838 world units tall — twenty-one floors — so three of
  // them is a seventh of what the player is looking at, and *which* three was
  // decided by arithmetic rather than by where anyone lives.
  //
  // Measured on a day-220 save: focusing floor 2 clamps `camY` to -20, which
  // puts the viewport centre at world y 399, which is floor 10. The game drew
  // people on floors 9-11. Every staffed room in that silo was on floors 1-7.
  // The people were not faint or small; they were somewhere else.
  //
  // The budget is what limits this now, not a window — see `order` below, which
  // spends it nearest-first so a crowded screen loses its most distant faces
  // rather than the ones under the player's thumb.
  const range = cam.visibleFloorRange();
  const centreFloor = Math.floor((cam.camY + cam.viewWorldH() / 2) / FLOOR_H) + 1;
  const from = range.from;
  const to = range.to;
  if (to < from) return;

  const t = cam.time * 0.001;
  const reduced = state.settings.reducedMotion;
  let drawn = 0;

  // Bucket the workforce by floor so we walk the roster once, not per floor.
  const byFloor = new Map();
  for (const id of state.citizenIds) {
    const c = state.citizens[id];
    if (!c || c.status === 'dead' || c.status === 'expedition') continue;
    const room = c.job ? state.silo.rooms[c.job.roomId] : null;
    const floorN = room ? room.floor : idleFloor(state, c);
    if (floorN < from || floorN > to) continue;
    if (!byFloor.has(floorN)) byFloor.set(floorN, []);
    byFloor.get(floorN).push({ c, room });
  }

  // Nearest the camera centre first. The sprite budget is real on a phone, and
  // when it runs out it should cost the player the floors they are least
  // looking at. Iterating the Map in insertion order spent it top-down, so a
  // deep silo drew its shallowest floors and left the focused one empty.
  const order = [...byFloor.keys()].sort(
    (a, b) => Math.abs(a - centreFloor) - Math.abs(b - centreFloor)
  );

  for (const floorN of order) {
    const list = byFloor.get(floorN);
    const y = (floorN - 1) * FLOOR_H + FLOOR_H - 6;
    const extent = builtExtent(state, floorN);

    // Give everyone a lane before drawing anybody.
    //
    // Every citizen used to wander the full width of their room on nothing but
    // a phase offset, and sin() lingers at its extremes — so eight people at
    // one post spent most of their time standing inside each other, and a busy
    // floor rendered as a smear of overlapping heads. Sorting by id and
    // dealing out lanes is deterministic, costs nothing, and turns a crowd
    // into a shift.
    const byRoom = new Map();
    for (const item of list) {
      const key = item.room ? item.room.id : 'idle';
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key).push(item);
    }
    const shown = [];
    for (const [key, group] of byRoom) {
      group.sort((a, b) => a.c.id - b.c.id);
      // Cap per post and per floor. Sorting by id first means the same faces
      // are shown every frame rather than the crowd flickering between them.
      const cap = key === 'idle'
        ? BAL.render.maxIdleCitizensPerFloor
        : BAL.render.maxCitizensPerRoom;
      const take = group.slice(0, cap);
      take.forEach((item, i) => { item.lane = i; item.lanes = take.length; });
      shown.push(...take);
    }

    for (const { c, room, lane, lanes } of shown) {
      if (drawn >= BAL.render.maxSpritesPerFrame - cam.drawn) return;
      const x = citizenX(c, room, t, reduced, lane, lanes, extent);
      // Walking if they're between posts or idle; working if they're at one.
      const moving = !room || c.status !== 'working';
      // The sprite picker needs to know what job somebody holds to choose a
      // farmer over a plain resident, and it has no room table of its own —
      // importing one would drag the data layer into the render path. The
      // floor renderer already has the room, so it stamps the skill on the way
      // past. Non-enumerable so it never reaches a save or a structured clone.
      if (room && !Object.getOwnPropertyDescriptor(c, '_jobSkill')) {
        Object.defineProperty(c, '_jobSkill', { value: null, writable: true, enumerable: false });
      }
      if (room) c._jobSkill = roomSkill(room);
      const frame = sprites.citizenFrame(c, cam.time, moving && !reduced);
      // Sprites are 12x16 with the feet on the bottom row: half the width to
      // the left of the anchor, the full height above the floor line.
      if (!sprites.drawAt(ctx, frame, Math.round(x) - 6, y - 15, 1)) {
        drawOne(ctx, c, x, y);
      }
      drawn++;
    }
  }
  cam.drawn += drawn;
}

/**
 * The built extent of a floor, in slots, or null if nothing stands on it.
 *
 * Idle citizens used to drift across the full `slotsPerFloor` width whether or
 * not there was anything there, so on a floor that is only half built people
 * stood in the dark outside the last room — figures with no floor under them,
 * which reads as a rendering fault rather than as a corridor.
 */
function builtExtent(state, floorN) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const room of Object.values(state.silo.rooms)) {
    if (room.floor !== floorN) continue;
    lo = Math.min(lo, room.slot);
    hi = Math.max(hi, room.slot + room.width);
  }
  return hi > lo ? { lo, hi } : null;
}

/**
 * Horizontal position. Working citizens mill inside their room; idle ones
 * drift along the built part of their floor. Both are pure functions of
 * id + time, which is what keeps this free of per-citizen render state.
 */
function citizenX(c, room, t, reduced, lane = 0, lanes = 1, extent = null) {
  const phase = ((c.id * 2654435761) % 1000) / 1000;
  const wide = extent
    ? { left: extent.lo * SLOT_W + 8, span: (extent.hi - extent.lo) * SLOT_W - 16 }
    : { left: 8, span: SLOT_W * BAL.silo.slotsPerFloor - 16 };
  const span = room ? room.width * SLOT_W - 14 : Math.max(SLOT_W / 2, wide.span);
  const left = room ? room.slot * SLOT_W + 7 : wide.left;

  // One lane each, centred in its share of the room. When a post is crowded
  // past what the width can hold the lanes overlap — but evenly, which reads
  // as a full room rather than as a rendering fault.
  const step = span / Math.max(1, lanes);
  const home = left + step * (lane + 0.5);

  if (reduced) return home;
  // Drift is a fraction of the lane, never more than a body width, so nobody
  // walks through the person next to them.
  const drift = Math.min(step * 0.35, 5);
  const speed = room ? 0.35 : 0.18;
  return home + Math.sin(t * speed + phase * 6.28) * drift;
}

function drawOne(ctx, c, x, y) {
  // Colour carries state, but shape carries it too: a citizen in trouble is
  // drawn shorter, so the read survives a colourblind viewer and a screenshot.
  let colour = PALETTE.bone;
  let h = 5;
  if (c.radiation >= BAL.citizens.radiation.sicknessThreshold) {
    colour = PALETTE.toxin;
  } else if (c.health < 45) {
    colour = PALETTE.rust;
    h = 4;
  } else if (c.status === 'idle') {
    colour = withAlpha(PALETTE.bone, 0.45);
  } else if (c.status === 'school') {
    colour = PALETTE.verdigris;
    h = 4;
  }
  if (c.age < BAL.citizens.workingAgeMin) h = 3;

  ctx.fillStyle = colour;
  ctx.fillRect(Math.round(x), y - h, 2, h);
  // Head pixel, so the dot reads as a person rather than a tick mark.
  ctx.fillRect(Math.round(x), y - h - 2, 2, 2);
}

/**
 * Where an unemployed citizen hangs around: their nearest social space.
 *
 * The cache lives in this module, not on `state` — render code must never
 * write to the store, or the cache ends up serialised into save files.
 */
let idleFloorCache = { cycle: -1, floors: [1] };

function idleFloor(state, c) {
  if (idleFloorCache.cycle !== state.clock.cycle) {
    // Every floor with somewhere to be, not the first one that matched.
    //
    // This took the *first* cafeteria or residence it found and put everybody
    // on that floor or the one below it, which meant the whole off-shift
    // population of the silo stood on two floors. With
    // `maxIdleCitizensPerFloor` at 8 that showed at most sixteen of them
    // however many there were — measured, 53 people off shift and 16 drawn —
    // so the silo read as empty in exactly the places people actually live.
    const floors = [];
    for (const room of Object.values(state.silo.rooms)) {
      if (room.type === 'cafeteria' || room.type === 'residences') {
        if (!floors.includes(room.floor)) floors.push(room.floor);
      }
    }
    floors.sort((a, b) => a - b);
    idleFloorCache = { cycle: state.clock.cycle, floors: floors.length ? floors : [1] };
  }
  // Dealt out by id, so the same person is always in the same place and the
  // crowd does not shuffle between frames.
  const { floors } = idleFloorCache;
  return floors[c.id % floors.length];
}

export default { drawCitizens };
