/**
 * citizens.js — the moving dots.
 *
 * Only citizens on the floors nearest the camera are drawn at all; everyone
 * else is simulated as numbers (spec §3.5). Positions are derived, never
 * stored: a citizen's x is a stable function of their id and the clock, so
 * this costs nothing to save and nothing to catch up.
 */

import { BAL } from '../config/balance.js';
import { PALETTE, SLOT_W, FLOOR_H } from './canvas.js';
import { withAlpha } from './floors.js';

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
    for (const { c, room } of list) {
      if (drawn >= BAL.render.maxSpritesPerFrame - cam.drawn) return;
      const x = citizenX(c, room, t, reduced);
      drawOne(ctx, c, x, y);
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
function citizenX(c, room, t, reduced) {
  const phase = (c.id * 2654435761) % 1000 / 1000;
  if (room) {
    const left = room.slot * SLOT_W + 4;
    const width = room.width * SLOT_W - 10;
    const wander = reduced ? 0.5 : (Math.sin(t * 0.4 + phase * 6.28) * 0.5 + 0.5);
    return left + wander * width;
  }
  const wander = reduced ? phase : (Math.sin(t * 0.22 + phase * 6.28) * 0.5 + 0.5);
  return 6 + wander * (SLOT_W * BAL.silo.slotsPerFloor - 12);
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

/** Where an unemployed citizen hangs around: their nearest social space. */
function idleFloor(state, c) {
  if (state.__idleFloor === undefined || state.__idleFloorCycle !== state.clock.cycle) {
    let floor = 1;
    for (const room of Object.values(state.silo.rooms)) {
      if (room.type === 'cafeteria' || room.type === 'residences') {
        floor = room.floor;
        break;
      }
    }
    state.__idleFloor = floor;
    state.__idleFloorCycle = state.clock.cycle;
  }
  // Spread them across the residential floors rather than stacking them.
  return state.__idleFloor + (c.id % 2);
}

export default { drawCitizens };
