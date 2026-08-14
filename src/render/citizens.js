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
import { onDuty } from './sprites.js';
import { defenders as raidDefenders } from '../sim/raid.js';

/**
 * Everybody the cross-section would draw, and what each of them is doing.
 *
 * Separated from the drawing so the answer can be inspected without a canvas.
 * This is where every decision lives — which floors, which lanes, who is
 * fighting, who is talking, who is asleep — and `drawCitizens` below is a loop
 * over the result. Splitting them is what lets test/wiring.mjs assert that the
 * game can actually reach the animations the atlas bakes, which is the check
 * that would have caught three of them being unreachable for a whole phase.
 */
export function citizensInView(state, cam) {
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
  const out = [];
  const range = cam.visibleFloorRange();
  const centreFloor = Math.floor((cam.camY + cam.viewWorldH() / 2) / FLOOR_H) + 1;
  const from = range.from;
  const to = range.to;
  if (to < from) return out;

  const t = cam.time * 0.001;
  const reduced = state.settings.reducedMotion;

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

  // Who is holding the airlock, and whether it is the middle of the night.
  //
  // Both are properties of the silo rather than of a person, which is why
  // `citizenAction` takes them as context: a citizen record cannot know that
  // raiders are at the door.
  const defending = new Set(state.world?.pendingRaid ? raidDefenders(state) : []);
  const night = BAL.render.nightShifts.includes(state.clock.shift);
  const beds = bedFloors(state);

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

    // ---- what everybody on this floor is doing ---------------------------
    //
    // Resolved before anything is drawn, because two of the answers depend on
    // the neighbours: a conversation needs somebody to have it with, and the
    // pairing has to agree from both sides or one of them talks to a person
    // who is walking away.
    //
    // Talking is decided on the lane centres rather than the drifted
    // positions, which breaks what would otherwise be a circle — drift decides
    // who is close enough to talk, and talkers stand still, which decides
    // their drift.
    const home = new Map();
    for (const item of shown) home.set(item.c.id, laneHome(item.room, item.lane, item.lanes, extent));
    const chatting = talkers(shown, home);

    for (const { c, room, lane, lanes } of shown) {
      if (out.length >= BAL.render.maxSpritesPerFrame - cam.drawn) return out;
      const fighting = defending.has(c.id);
      const talking = chatting.has(c.id);
      // Standing still: at a post, in a conversation, asleep, or in the
      // stationary half of an off-duty wander. Anything else is walking.
      const sleeping = night && !onDuty(c) && beds.has(floorN);
      // On duty and in a room: they work a round between two stations, and
      // `moving` comes back from that rather than being assumed false. Reduced
      // motion pins them to the lane, which is what it did for everybody
      // before and is the whole point of the setting.
      const round = onDuty(c) && room && !reduced
        ? postRound(c, room, t, lane, lanes, extent)
        : null;
      const still = onDuty(c) ? !round?.moving : (talking || sleeping || loitering(c, t));
      const x = fighting
        ? citizenX(c, room, t, reduced, lane, lanes, extent)
        : round
          ? round.x
          : still
            ? home.get(c.id)
            : citizenX(c, room, t, reduced, lane, lanes, extent);
      // The sprite picker needs to know what job somebody holds to choose a
      // farmer over a plain resident, and it has no room table of its own —
      // importing one would drag the data layer into the render path. The
      // floor renderer already has the room, so it stamps the skill on the way
      // past. Non-enumerable so it never reaches a save or a structured clone.
      if (room && !Object.getOwnPropertyDescriptor(c, '_jobSkill')) {
        Object.defineProperty(c, '_jobSkill', { value: null, writable: true, enumerable: false });
      }
      if (room) c._jobSkill = roomSkill(room);
      const action = sprites.citizenAction(c, {
        fighting,
        talking,
        sleeping,
        moving: !still && !reduced,
      });
      out.push({ c, x, y, action });
    }
  }

  return out;
}

/**
 * A skull where each unclaimed death happened.
 *
 * Not an animation. A collapse plays for a few seconds and then the moment is
 * gone whether or not anybody was looking at that floor — and a death in this
 * game is a named person with a cause written into the log, which deserves a
 * mark that waits. These stay until the player taps one, which is also the
 * only acknowledgement the game asks for anywhere.
 *
 * Read from `state.citizens`, which keeps the record after death — only the
 * roster is filtered — so nothing here writes to state and nothing has to
 * clean up after it.
 */
export function deathMarks(state, from = 1, to = BAL.silo.totalFloors) {
  const out = [];
  for (const c of Object.values(state.citizens)) {
    if (c.status !== 'dead' || c.deathTick == null || c.deathSeen) continue;
    const floorN = c.deathFloor ?? idleFloor(state, c);
    if (floorN < from || floorN > to) continue;
    out.push({
      c,
      x: citizenX(c, null, 0, true, c.id % 4, 4, builtExtent(state, floorN)),
      y: (floorN - 1) * FLOOR_H + FLOOR_H - 6,
      floor: floorN,
    });
  }
  // Newest first, capped. See `maxDeathMarks` — the older ones are hidden
  // rather than dismissed, so clearing one brings the next up.
  out.sort((a, b) => b.c.deathTick - a.c.deathTick);
  return out.slice(0, BAL.render.maxDeathMarks);
}

/**
 * The mark under a tap, or null. Screen-space is the caller's problem; this
 * takes world units, which is what `hitTest` already computes.
 *
 * The box is deliberately wider than the sprite. A 16px marker on a phone is
 * under four millimetres, and test/mobile.mjs holds every control to 30px for
 * exactly that reason.
 */
export function deathMarkAt(state, worldX, worldY) {
  const R = BAL.render.deathMarkTapRadius;
  let best = null;
  let bestD = Infinity;
  for (const m of deathMarks(state)) {
    const dx = Math.abs(worldX - m.x);
    const dy = Math.abs(worldY - (m.y - 8));
    if (dx > R || dy > R) continue;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = m; }
  }
  return best;
}

/**
 * Draw everybody, from the list above.
 *
 * Sprites are 12x16 with the feet on the bottom row: half the width to the
 * left of the anchor, the full height above the floor line.
 */
export function drawCitizens(ctx, state, cam) {
  const people = citizensInView(state, cam);
  for (const p of people) {
    const frame = sprites.citizenFrame(p.c, cam.time, p.action);
    if (!sprites.drawAt(ctx, frame, Math.round(p.x) - 6, p.y - 15, 1)) {
      drawOne(ctx, p.c, p.x, p.y);
    }
  }

  // The dead, over everybody, because a mark that a living person can stand in
  // front of is a mark the player cannot tap.
  const range = cam.visibleFloorRange();
  const marks = deathMarks(state, range.from, range.to);
  for (const m of marks) {
    if (!sprites.drawAt(ctx, 'prop_skull', Math.round(m.x) - 8, m.y - 16, 1)) {
      drawSkullFallback(ctx, m.x, m.y);
    }
  }
  cam.drawn += people.length + marks.length;
}

/** If the atlas never loaded, a death is still not allowed to be invisible. */
function drawSkullFallback(ctx, x, y) {
  ctx.fillStyle = PALETTE.bone;
  ctx.fillRect(Math.round(x) - 3, y - 12, 6, 5);
  ctx.fillStyle = PALETTE.deep;
  ctx.fillRect(Math.round(x) - 2, y - 11, 2, 2);
  ctx.fillRect(Math.round(x), y - 11, 2, 2);
}

/** Floors with somewhere to sleep, so the night shift means something. */
let bedCache = { cycle: -1, floors: new Set() };
function bedFloors(state) {
  if (bedCache.cycle !== state.clock.cycle) {
    const floors = new Set();
    for (const room of Object.values(state.silo.rooms)) {
      if (room.type === 'residences') floors.add(room.floor);
    }
    bedCache = { cycle: state.clock.cycle, floors };
  }
  return bedCache.floors;
}

/** Where a lane sits before any drift is applied. */
function laneHome(room, lane, lanes, extent) {
  return citizenX({ id: 0 }, room, 0, true, lane, lanes, extent);
}

/**
 * Off-duty people stop walking sometimes.
 *
 * A pure function of id and time, like every other position in this file, so
 * nobody's gait depends on when the renderer happened to look. The phase is
 * offset per citizen, which is what stops a corridor of people all stopping on
 * the same beat.
 */
function loitering(c, t) {
  const period = BAL.render.idleWanderSeconds;
  const phase = ((c.id * 2246822519) % 1000) / 1000;
  const at = ((t / period) + phase) % 1;
  return at < BAL.render.idleStandFraction;
}

/**
 * A shift at a post, as a position and whether they are on the move.
 *
 * Somebody at a post used to be drawn on a mark and left there — `still` was
 * `onDuty(c) ? !!room : …`, so having a room meant never moving. Six frames of
 * walk cycle in the atlas were for off-duty people and nobody else, and a silo
 * at full employment rendered as rows of figures standing to attention.
 *
 * A post is two places now: the lane the crewing code dealt them, and a second
 * station elsewhere in the same room. They work at one, cross to the other,
 * work there, cross back. Everything below is a pure function of id and time,
 * like every other position in this file — no per-citizen render state, so a
 * paused game and a resumed one draw the same frame.
 *
 * Three things are seeded off the id rather than shared, because the point is
 * that a room looks like people rather than like a mechanism: how long a
 * citizen's round takes, where their second station is, and where in the cycle
 * they happen to be. Eight people at one post are on eight rhythms.
 *
 * @returns {{x: number, moving: boolean}}
 */
function postRound(c, room, t, lane, lanes, extent) {
  const R = BAL.render;
  const home = laneHome(room, lane, lanes, extent);
  if (!room) return { x: home, moving: false };

  const [minS, maxS] = R.postCycleSeconds;
  const period = minS + hash01(c.id, 40503) * (maxS - minS);
  const [lo, hi] = R.postStationSpread;
  const usable = room.width * SLOT_W - 14;
  const left = room.slot * SLOT_W + 7;
  // The second station, on whichever side of the lane has more room — so a
  // citizen on the left edge of a wide room crosses it rather than pressing
  // into the wall.
  const reach = (lo + hash01(c.id, 91711) * (hi - lo)) * usable;
  const away = home - left > usable / 2 ? home - reach : home + reach;
  const other = Math.max(left + 4, Math.min(left + usable - 4, away));

  const dwell = R.postDwellFraction / 2; // per station
  const at = ((t / period) + hash01(c.id, 15485863)) % 1;
  if (at < dwell) return { x: home, moving: false };
  if (at < 0.5) return { x: lerp(home, other, (at - dwell) / (0.5 - dwell)), moving: true };
  if (at < 0.5 + dwell) return { x: other, moving: false };
  return { x: lerp(other, home, (at - 0.5 - dwell) / (0.5 - dwell)), moving: true };
}

/** 0..1 from an id and a salt. The salt is what keeps the three draws apart. */
function hash01(id, salt) {
  return (((id * 2654435761) ^ salt) >>> 0) % 1000 / 1000;
}

const lerp = (a, b, k) => a + (b - a) * k;

/**
 * Who is talking to whom.
 *
 * Adjacent lanes, close enough to hear, and both standing off duty. Pairs are
 * taken in order and each person joins at most one, so nobody is drawn
 * gesturing at somebody who is already deep in another conversation.
 *
 * Not every eligible pair strikes up: `talkPairFraction` thins them out on a
 * hash of the two ids, because a floor where every neighbour was mid-sentence
 * read as a staged crowd rather than as a corridor.
 */
function talkers(shown, home) {
  const out = new Set();
  const loose = shown
    .filter((it) => !it.room)
    .sort((a, b) => home.get(a.c.id) - home.get(b.c.id));
  for (let i = 0; i + 1 < loose.length; i++) {
    const a = loose[i];
    const b = loose[i + 1];
    if (out.has(a.c.id) || out.has(b.c.id)) continue;
    if (Math.abs(home.get(a.c.id) - home.get(b.c.id)) > BAL.render.talkWithinPx) continue;
    const pick = ((a.c.id * 40503 + b.c.id * 12289) % 1000) / 1000;
    if (pick > BAL.render.talkPairFraction) continue;
    out.add(a.c.id);
    out.add(b.c.id);
  }
  return out;
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
