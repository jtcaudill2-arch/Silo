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
import { stairX } from './floors.js';
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
  //
  // Off-shift people who are between floors come out of this pass entirely and
  // go onto the stair instead — they are not on a floor, which is the whole
  // point of them. `travelling` is checked before the range test because a
  // journey from floor 3 to floor 19 passes through everything in between, and
  // the traveller has to be drawn wherever they currently are rather than
  // wherever they started.
  // Whether it is the small hours, hoisted above the bucketing loop because an
  // errand depends on it — people turn in at night — and the loop is where a
  // journey is decided.
  const night = BAL.render.nightShifts.includes(state.clock.shift);
  const byFloor = new Map();
  const travellers = [];
  for (const id of state.citizenIds) {
    const c = state.citizens[id];
    if (!c || c.status === 'dead' || c.status === 'expedition') continue;
    const room = c.job ? state.silo.rooms[c.job.roomId] : null;
    const floorN = room ? room.floor : idleFloor(state, c);
    // Posted or not. This read `!room` and so only ever put the jobless on the
    // steps, which in a silo at full employment means children: measured over
    // eight hundred frames of a day-150 silo, sixteen people used the stair, one
    // of them was an adult and none of them held a post. A hundred and forty-four
    // floors of building, and the only traffic between them was the school run.
    if (!reduced) {
      const trip = journey(state, c, t, floorN, night, !!room);
      if (trip) {
        // World y, not floor y: they are on the steps between two landings.
        const ty = (trip.floor - 1) * FLOOR_H + FLOOR_H - 6;
        if (trip.floor >= from - 1 && trip.floor <= to + 1) travellers.push({ c, y: ty, trip });
        continue;
      }
    }
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
      let take;
      if (key === 'idle') {
        take = group.slice(0, cap);
        take.forEach((item, i) => { item.lane = i; item.lanes = take.length; });
      } else {
        // A room's lanes come off its roster, not off who happens to be inside
        // it this frame.
        //
        // Indexing the drawn group meant the lane a person stood in depended on
        // how many colleagues were currently elsewhere, so the moment one of
        // them stepped onto the stair every worker behind them slid a lane
        // across — a whole room twitching sideways because somebody went for
        // their dinner. It was rare while only the jobless travelled; it is
        // every fifty seconds in an eight-person bay now that the posted do.
        //
        // The cap is applied to the *roster* and not to the drawn group, which
        // is the half that has to be got right. Capping the two independently
        // put a worker in a lane the room does not have: `maxCitizensPerRoom`
        // is five and a merged, upgraded bay holds eleven, so as soon as one of
        // the five lowest-numbered staff stepped onto the stair the sixth took
        // their place in the drawn group, matched nothing in the capped roster,
        // and was posted a lane past the last one — measured at 568 sprites
        // drawn outside their own room's walls over two thousand frames.
        //
        // Capping by roster position instead means an absent worker leaves
        // their station empty rather than shuffling the queue, which is what
        // the room actually looks like when somebody is off getting their
        // dinner.
        const roster = (group[0].room?.staff || [])
          .filter((cid) => state.citizens[cid] && state.citizens[cid].status !== 'dead');
        // Anybody drawn here who is somehow not on the roster still gets a
        // lane rather than being dropped: a room and a citizen disagreeing
        // about who works there is a bug elsewhere, and silently not drawing
        // somebody is the worst way to find out about it.
        const ids = [...new Set([...roster, ...group.map((g) => g.c.id)])].sort((a, b) => a - b);
        const laneOf = new Map(ids.map((id, i) => [id, i]));
        const lanes = Math.min(cap, ids.length);
        take = group.filter((item) => laneOf.get(item.c.id) < cap);
        take.forEach((item) => { item.lane = laneOf.get(item.c.id); item.lanes = lanes; });
      }
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

  // And whoever is on the stair. Last, so the shaft's traffic survives a
  // sprite budget that has already been spent on the floor the player is
  // looking at — but before the cap, so it is spent rather than exceeded.
  for (const { c, y, trip } of travellers) {
    if (out.length >= BAL.render.maxSpritesPerFrame - cam.drawn) break;
    // `stair` is on the record rather than inferred from x, because x alone
    // cannot tell a traveller from somebody working in a bay that happens to
    // span the middle of the floor — a test that guessed from geometry read
    // one room citizen a frame as being on the steps.
    out.push({ c, x: trip.x, y, action: 'walk', stair: true, purpose: trip.purpose, to: trip.to });
  }

  return out;
}

/**
 * Where somebody off shift is between floors, or null if they are not.
 *
 * The silo has a stair running its whole depth and nobody had ever been drawn
 * on it. Everyone was always *on a floor* — at a post or loitering in a
 * corridor — so a hundred and forty-four levels of building had no traffic
 * between them at all.
 *
 * A journey is a pure function of id and time, like every other position in
 * this file, so a paused silo and a resumed one draw the same frame and
 * nothing has to be stored. Each citizen has a personal cycle whose length is
 * `stairJourneySeconds / stairTravellerFraction`; they are on the stair for
 * the first `stairTravellerFraction` of it and on a floor for the rest. That
 * makes the *share* of people travelling constant while *which* people they
 * are keeps turning over — a fixed roll per citizen would have put the same
 * dozen on the steps for the whole campaign.
 *
 * Where they are going is their own floor and one other, alternating, so a
 * journey has somewhere to arrive rather than being a walk that resets. The
 * other floor is drawn from the id and the cycle number, which is what stops
 * one person shuttling between the same two levels for six hundred days.
 */
function journey(state, c, t, homeFloor, night, posted = false) {
  const R = BAL.render;
  // A posted worker walks a much narrower share of the day than somebody off
  // shift, which is what keeps the rooms full while the stair stops being
  // empty. It is a share of the *workforce* at any instant, not of the day: at
  // three per cent, a silo of a hundred workers has three of them on the steps
  // in a given frame and the other ninety-seven at their posts.
  const share = posted ? R.postedTravellerFraction : R.stairTravellerFraction;
  if (share <= 0) return null;

  const period = R.stairJourneySeconds / share;
  const at = ((t / period) + hash01(c.id, 2971215073)) % 1;
  if (at >= share) return null;

  const cycle = Math.floor(t / period + hash01(c.id, 2971215073));
  const errand = errandFor(state, c, night, posted);
  if (!errand) return null;
  // Somewhere with the right room on it, and never the floor they are already
  // stood on — a journey to where you are is a person twitching in a doorway.
  const options = errand.floors.filter((f) => f !== homeFloor);
  if (!options.length) return null;
  const other = options[hash01(c.id + cycle * 7919, 433494437) * options.length | 0];
  const out = cycle % 2 === 0;
  const a = out ? homeFloor : other;
  const b = out ? other : homeFloor;

  const k = at / share;
  // Ease the ends, so somebody steps off a landing rather than teleporting
  // into a sprint. Same shape as a person taking the first stair carefully.
  const eased = k * k * (3 - 2 * k);
  const floor = a + (b - a) * eased;
  // A hand's width either side of the centre line, so two people passing on
  // the same flight do not occupy one pixel column. `drawCitizens` draws a
  // sprite from `x - 6` and a body is about twelve across, so the spread has
  // to leave seven either side or somebody's shoulder is drawn through the
  // shaft wall — which it was at the first attempt.
  const lane = (hash01(c.id, 104729) - 0.5) * (BAL.render.stairWidth - 16);
  // The errand names the *outbound* leg only. Coming back is its own thing:
  // reporting "clinic" on the return trip pointed at whatever floor they set
  // out from, which is how a check on "does the destination have the room this
  // journey is named for" caught 91 people apparently walking to a bunk on the
  // cafeteria level.
  // And what "coming back" means depends on who is walking. Somebody off shift
  // is going home; somebody who holds a post is going back to it, which is a
  // different room on a different floor and was reported as `home` for one
  // measured run — 548 journeys arriving at a generator hall and calling it a
  // bunk, caught by the same check that caught the first version of this.
  const back = posted ? 'post' : 'home';
  return { floor, x: stairX() + lane, purpose: out ? errand.purpose : back, to: b };
}

/**
 * Why somebody is on the stair, and where that puts them.
 *
 * The first version of this picked a destination floor at random, which looked
 * like traffic and meant nothing: a person walked eleven floors to a level
 * they had no business on and walked back. Traffic you can read is the whole
 * difference between a busy building and a screensaver.
 *
 * So an errand comes off the citizen's own record, in the order somebody would
 * actually weigh it. Each rung falls through if the silo has nowhere to go —
 * a silo with no clinic cannot send anybody to one — so a half-built silo gets
 * fewer kinds of journey rather than people walking to rooms that do not
 * exist.
 *
 * `purpose` rides out on the sprite. Nothing draws it yet; it is what makes
 * this testable, and it is what a tapped citizen would want to say.
 *
 * There was a fifth clause here — go and see your partner — and it is gone
 * because it never once fired. Everyone with a partner in a measured silo has
 * a job, and only people without one were ever on the stair, so the clause was
 * complete, reasonable, and unreachable: the exact thing the rest of this
 * branch has spent its time deleting. Somebody at a post has a reason to leave
 * it now, which is the prerequisite that note asked for; a partner errand is
 * still not back, because it wants a rule about where the partner *is* and
 * that is a bigger thing than this.
 *
 * Somebody who is posted gets the first three rungs and not the fallback. A
 * person off shift wandering to the mess is what off shift is; a mechanic
 * leaving a running generator hall to loiter needs a better reason than
 * nothing, and "hurt, hungry, or the end of the day" is the whole list of
 * reasons a silo would accept. It also makes the traffic legible in the one
 * way that matters — every worker on the steps is going somewhere you can
 * name — and it is what keeps the rooms full: the fallback is by far the most
 * common branch, so admitting it for the posted would have emptied the bays.
 */
function errandFor(state, c, night, posted = false) {
  const R = BAL.render;
  const hurt =
    c.health < R.injuredBelowHealth ||
    c.radiation >= BAL.citizens.radiation.sicknessThreshold ||
    c.pregnantUntilDay != null;
  if (hurt) {
    const f = floorsWith(state, 'clinic');
    if (f.length) return { purpose: 'clinic', floors: f };
  }
  if (c.status === 'school' || c.age < BAL.citizens.workingAgeMin) {
    const f = floorsWith(state, 'schoolhouse');
    if (f.length) return { purpose: 'school', floors: f };
  }
  if (night) {
    const f = floorsWith(state, 'residences');
    if (f.length) return { purpose: 'bunk', floors: f };
  }
  // The canteen: a grievance for somebody off shift, and simply a meal for
  // somebody who is working. The morale gate is what tells an off-shift drift
  // towards the mess apart from a drift towards the bunks, and a posted worker
  // has no such choice to make — the mess is the only place they are going.
  //
  // Written as two labels for a moment, `mess` and `a break`, and measured:
  // every posted worker in a day-150 silo sits between 49 and 54 morale, so the
  // second was unreachable, and where it *was* reachable it named the same walk
  // to the same room. One rung, one word.
  if (posted || c.morale < R.messBelowMorale) {
    const f = floorsWith(state, 'cafeteria');
    if (f.length) return { purpose: 'mess', floors: f };
  }
  // And nothing further for somebody at a post. Off shift drifting between the
  // mess and the bunks is what off shift *is*; a mechanic walking out of a
  // running generator hall to loiter in the residences is a mechanic who should
  // be sacked. It is also what keeps the bays full — this is by far the most
  // common branch, so admitting the posted to it would have emptied them.
  if (posted) return null;
  const f = floorsWith(state, 'cafeteria', 'residences');
  return f.length ? { purpose: 'off shift', floors: f } : null;
}

/**
 * Which floors carry a given kind of room, cached for the cycle.
 *
 * The cache lives in this module rather than on `state`, like every other one
 * here: render code must never write to the store, or the cache is serialised
 * into a save file.
 */
let roomFloorCache = { cycle: -1, byType: new Map() };

function floorsWith(state, ...types) {
  if (roomFloorCache.cycle !== state.clock.cycle) {
    const byType = new Map();
    for (const room of Object.values(state.silo.rooms)) {
      if (room.buildingUntilCycle !== 0) continue;
      if (!byType.has(room.type)) byType.set(room.type, []);
      const arr = byType.get(room.type);
      if (!arr.includes(room.floor)) arr.push(room.floor);
    }
    for (const arr of byType.values()) arr.sort((a, b) => a - b);
    roomFloorCache = { cycle: state.clock.cycle, byType };
  }
  const out = [];
  for (const type of types) {
    for (const f of roomFloorCache.byType.get(type) || []) if (!out.includes(f)) out.push(f);
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
