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
  const range = cam.visibleFloorRange();
  const centre = cam.camY + cam.viewWorldH() / 2;
  const centreFloor = Math.floor(centre / FLOOR_H) + 1;
  const half = Math.floor(BAL.render.citizenFloorsRendered / 2);
  const from = Math.max(range.from, centreFloor - half);
  const to = Math.min(range.to, centreFloor + half);
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

  for (const [floorN, list] of byFloor) {
    const y = (floorN - 1) * FLOOR_H + FLOOR_H - 6;

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
      const x = citizenX(c, room, t, reduced, lane, lanes);
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
 * Horizontal position. Working citizens mill inside their room; idle ones
 * drift along the whole floor. Both are pure functions of id + time, which is
 * what keeps this free of per-citizen render state.
 */
function citizenX(c, room, t, reduced, lane = 0, lanes = 1) {
  const phase = ((c.id * 2654435761) % 1000) / 1000;
  const span = room ? room.width * SLOT_W - 14 : SLOT_W * BAL.silo.slotsPerFloor - 16;
  const left = room ? room.slot * SLOT_W + 7 : 8;

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
let idleFloorCache = { cycle: -1, floor: 1 };

function idleFloor(state, c) {
  if (idleFloorCache.cycle !== state.clock.cycle) {
    let floor = 1;
    for (const room of Object.values(state.silo.rooms)) {
      if (room.type === 'cafeteria' || room.type === 'residences') {
        floor = room.floor;
        break;
      }
    }
    idleFloorCache = { cycle: state.clock.cycle, floor };
  }
  // Spread them across the residential floors rather than stacking them.
  return idleFloorCache.floor + (c.id % 2);
}

export default { drawCitizens };
