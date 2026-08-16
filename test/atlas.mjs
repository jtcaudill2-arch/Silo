#!/usr/bin/env node
/**
 * atlas.mjs — the branch the player actually sees.
 *
 * `drawCitizens` has two of them. The one on screen draws from the sprite
 * sheet; the other is the procedural fallback of two rectangles a person that
 * runs when the sheet is missing. Every assertion in this project went through
 * the fallback, because `sprites.drawAt` returns false before it looks at its
 * arguments when no atlas is loaded, and nothing under test/ could load one —
 * `loadAtlas` needs `Image` and `fetch`, neither of which node has. Measured:
 * moving the atlas anchor two hundred pixels sideways passed the entire suite,
 * sixteen files and every assertion in them.
 *
 * So this file reads the real assets/atlas.json off disk, installs it through
 * `sprites.adoptAtlas`, and checks the half of the renderer nothing else
 * reaches: whether the sheet carries every frame the game can name, where the
 * frames land, and whether the two branches agree about where somebody is
 * standing. They have to. main.js:83 starts the fetch without awaiting it —
 * deliberately, because the title screen draws people — so the opening of a
 * session is painted from the fallback and swaps to the sheet part-way
 * through. Anchors that disagree are a silo that jumps.
 *
 * Not swept here: the `ui_`, `tile_` and `prop_` frames other than the skull,
 * which are named by literals at their call sites, where a missing one is a
 * hole somebody sees rather than a silent gap. The families below are the ones
 * built from data, and those fail quietly: a room type or an item added
 * without art draws as a block for ever and nothing says so.
 *
 * Run: node test/atlas.mjs
 */

import { readFileSync } from 'node:fs';
import { Store } from '../src/core/store.js';
import { registerCoreReducers } from '../src/core/reducers.js';
import { createNewGame } from '../src/core/newgame.js';
import { Game } from '../src/core/game.js';
import { autoAssign } from '../src/sim/jobs.js';
import { ROOM_LIST } from '../src/data/rooms.js';
import { ITEM_LIST } from '../src/data/items.js';
import { BAL } from '../src/config/balance.js';
import { CONSUMER_ROLES } from '../tools/art/citizens.mjs';
import { ROOM_FIXTURES_LEVELLED } from '../tools/art/rooms.mjs';
import { atlas as artAtlas } from '../tools/art/lib.mjs';
import {
  adoptAtlas, citizenAction, citizenFrame, citizenRole, isLoaded,
} from '../src/render/sprites.js';
import { drawCitizens, citizensInView, deathMarks, deathMarkAt } from '../src/render/citizens.js';
import { drawRoom } from '../src/render/floors.js';

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

const sheet = JSON.parse(readFileSync(new URL('../assets/atlas.json', import.meta.url), 'utf8'));

console.log('');
console.log('  DEEPWATER — the sprites the player is actually shown');
console.log('  ' + '─'.repeat(58));
console.log('');

// ---- 1. the sheet carries every frame the game can name --------------------
//
// Both directions, and the second one is the half that pays. A name the game
// asks for and the sheet lacks is a figure drawn as a grey block for ever; a
// frame in the sheet that nothing can ask for is weight in a file the player
// downloads. This found `die: 4` in FRAME_COUNTS — 44 names, no art, and the
// only thing that could have asked for them was a helper with no callers left
// over from before deaths became a marker on the floor.
//
// The names are derived rather than listed. Actions come out of
// `citizenAction` by asking it, roles out of `citizenRole` the same way, and
// the posts come from the room table, because a new room with a new skill is
// exactly how a role with no art gets into the game.
{
  const actions = new Set();
  for (const fighting of [false, true]) {
    for (const sleeping of [false, true]) {
      for (const moving of [false, true]) {
        for (const talking of [false, true]) {
          for (const health of [100, BAL.render.injuredBelowHealth - 1]) {
            for (const status of ['working', 'idle']) {
              const c = { health, status, radiation: 0, age: 30 };
              actions.add(citizenAction(c, { fighting, sleeping, moving, talking }));
            }
          }
        }
      }
    }
  }

  // role -> a citizen that reads as that role, kept so the frame sweep below
  // can drive `citizenFrame` (which does its own `citizenRole` lookup).
  const probeOf = new Map();
  const remember = (probe) => {
    const role = citizenRole(probe);
    if (!probeOf.has(role)) probeOf.set(role, { id: 0, ...probe });
    return role;
  };

  const named = [
    ['irradiated', { radiation: BAL.citizens.radiation.sicknessThreshold, status: 'idle', age: 30 }],
    ['hazmat', { radiation: 0, status: 'expedition', age: 30 }],
    ['militia', { radiation: 0, status: 'working', age: 30, squadId: 1 }],
    ['child', { radiation: 0, status: 'idle', age: BAL.citizens.workingAgeMin - 1 }],
    ['elder', { radiation: 0, status: 'idle', age: BAL.citizens.vitality.declineSteepAge }],
    ['resident', { radiation: 0, status: 'idle', age: 30 }],
  ];
  const drifted = [];
  for (const [want, probe] of named) {
    const got = remember(probe);
    if (got !== want) drifted.push(`the ${want} probe reads as "${got}"`);
  }
  for (const def of ROOM_LIST) {
    if (def.staff) remember({ radiation: 0, status: 'working', age: 30, _jobSkill: def.staff.skill });
  }
  // A post whose room stamps no skill: `jobSkillOf` documents that as a
  // correct answer rather than a broken one, so it names a frame too.
  remember({ radiation: 0, status: 'working', age: 30 });

  // Every name `citizenFrame` can produce. The frame index is a function of
  // time and id, and the fastest action holds each frame for 110ms, so a sweep
  // in steps of 10 cannot step over one. 4000ms clears the longest cycle
  // (sleep, 2 frames at 1400ms) several times over.
  const wanted = new Set();
  for (const [, probe] of probeOf) {
    for (const act of actions) {
      for (let t = 0; t <= 4000; t += 10) wanted.add(citizenFrame(probe, t, act));
    }
  }

  // The aliases the baker keeps on purpose — `worker`, `idle` and `hurt` all
  // resolve to `base` and tools/art/citizens.mjs documents them as a
  // compatibility shim for an older caller. Read off its own export, so
  // retiring one there retires the exemption here rather than leaving a hole.
  const aliases = Object.keys(CONSUMER_ROLES)
    .filter((k) => CONSUMER_ROLES[k] !== k)
    .map((k) => `citizen_${k}_`);

  const inSheet = Object.keys(sheet.frames).filter((n) => n.startsWith('citizen_'));
  const missing = [...wanted].filter((n) => !sheet.frames[n]);
  const spare = inSheet.filter((n) => !wanted.has(n) && !aliases.some((p) => n.startsWith(p)));

  if (drifted.length) {
    fail(`${drifted.join('; ')} — this file's idea of who is who has drifted from citizenRole, ` +
      'so the sweep below is covering the wrong roles');
  }
  if (missing.length) {
    fail(`the game can ask for ${missing.length} citizen frames the sheet does not have ` +
      `(${missing.slice(0, 4).join(', ')}) — those figures draw as blocks`);
  }
  if (spare.length) {
    fail(`the sheet carries ${spare.length} citizen frames nothing can ask for ` +
      `(${spare.slice(0, 4).join(', ')}) — baked art the game cannot reach`);
  }
  if (!drifted.length && !missing.length && !spare.length) {
    ok(`the sheet is exactly the ${wanted.size} citizen frames the game can name ` +
      `(${probeOf.size} roles x ${actions.size} actions), plus ${inSheet.length - wanted.size} alias frames`);
  }

  // The families built from data. One direction only: these live beside frames
  // named by literals, so an unused one proves nothing.
  const fromData = [
    // Every room at every level it can reach. The sheet used to carry one
    // fixture per type, so an upgraded room drew the same picture as a new one;
    // there are five each now and `render/floors.js:fixtureAtLevel` names them
    // by the same rule `tools/art/rooms.mjs:fixtureName` bakes them by. The two
    // cannot import from each other, so this is where they are held together.
    ...ROOM_LIST.flatMap((r) =>
      Array.from({ length: BAL.silo.upgrade.maxLevel }, (_, i) =>
        (i === 0 ? `room_${r.id}` : `room_${r.id}_l${i + 1}`))),
    ...ROOM_LIST.map((r) => `cutaway_${r.id}`),
    ...ITEM_LIST.map((i) => `gear_${i.id}`),
    ...[...probeOf.keys()].map((r) => `portrait_${r}`),
    ...'0123456789'.split('').map((d) => `digit_${d}`),
    'prop_skull',
  ];
  const gaps = fromData.filter((n) => !sheet.frames[n]);
  if (gaps.length) {
    fail(`${gaps.length} of ${fromData.length} frames the game builds from the data tables are ` +
      `not in the sheet (${gaps.slice(0, 4).join(', ')})`);
  } else {
    ok(`all ${fromData.length} frames named from the room, item and role tables are in the sheet`);
  }
}

// ---- the fixture -----------------------------------------------------------
//
// A silo with people in it and somebody buried on a floor in view. Short, like
// the rest of the suite: a long unmanaged run starves the place to nobody and
// an empty roster proves nothing about where sprites land.

registerCoreReducers();
const store = new Store(createNewGame({ seed: 0x51d0, now: 1_700_000_000_000 }));
store.silent = true;
const s = store.state;
store.dispatchAll(autoAssign(s));
new Game(store).runDays(5);
store.dispatchAll(autoAssign(s));

const cam = {
  camY: -20, time: 1000, drawn: 0, spriteBudget: 400,
  viewWorldH: () => 838,
  visibleFloorRange: () => ({ from: 1, to: 22 }),
};
const range = cam.visibleFloorRange();

let noVictim = false;
{
  const onScreen = s.citizenIds
    .map((id) => s.citizens[id])
    .find((c) => {
      const f = c && c.status !== 'dead' && c.job ? s.silo.rooms[c.job.roomId]?.floor : null;
      return f != null && f >= range.from && f <= range.to;
    });
  if (!onScreen) noVictim = true;
  else store.dispatch({ type: 'CITIZEN_DIE', id: onScreen.id, cause: 'a test', text: 'a test death' });
}

/** A canvas that remembers, and nothing else. */
function recorder() {
  const rects = [];
  const blits = [];
  return {
    rects,
    blits,
    ctx: {
      set fillStyle(_v) {}, get fillStyle() { return ''; },
      set globalAlpha(_v) {}, get globalAlpha() { return 1; },
      save() {}, restore() {},
      fillRect(x, y, w, h) { rects.push({ x, y, w, h }); },
      drawImage(_img, sx, sy, sw, sh, dx, dy, dw, dh) {
        blits.push({ sx, sy, sw, sh, dx, dy, dw, dh });
      },
    },
  };
}

// The fallback pass has to run first: adopting an atlas is one-way, which is
// the whole point of it — a sheet does not un-load itself mid-session either.
const before = recorder();
cam.drawn = 0;
drawCitizens(before.ctx, s, cam);

// JSON that parses and is not an atlas has to bounce off, and the order
// matters: this is the only moment in the run when nothing is loaded, and
// adopting is one-way. A sheet that installed itself here would make every
// later `table.frames[name]` throw — a harder failure than the fallback the
// module exists to guarantee.
if (adoptAtlas({}, { version: 3 }) || isLoaded()) {
  fail('sprites.js installed a frame table with no frames in it, and every draw after that throws');
}

if (!adoptAtlas({ width: sheet.width, height: sheet.height }, sheet)) {
  fail('assets/atlas.json would not install — every check below is about nothing');
} else if (!isLoaded()) {
  fail('the atlas installed and sprites.js still reports nothing loaded');
}

const after = recorder();
cam.drawn = 0;
const people = citizensInView(s, cam);
const marks = deathMarks(s, range.from, range.to);
drawCitizens(after.ctx, s, cam);

// ---- 2. the sprite lands on the person the list has ------------------------
//
// Paired by index, not by nearness: `drawCitizens` walks `citizensInView` in
// order and blits once per person, so the pairing is exact and the count is an
// assertion in its own right. Nearness would be satisfied by rotating every
// sprite onto a neighbour's mark, which is exactly as broken.
//
// The offsets are checked against the frame's own size rather than against the
// literals in citizens.js, because the rule is what matters and the literals
// are one expression of it: a figure is centred on the anchor and stands on
// the floor line, so its bottom row of pixels is the line. Baking a sprite one
// pixel taller without moving the anchor puts the whole silo through the floor
// and would pass a check written as `p.y - 15`.
{
  const misplaced = [];
  const wanted = people.length + marks.length;
  const miscounted = after.blits.length !== wanted
    ? `${after.blits.length} sprites for ${people.length} people and ${marks.length} marks, ` +
      `which should be ${wanted}`
    : null;

  if (!miscounted) {
    people.forEach((p, i) => {
      const b = after.blits[i];
      const wx = Math.round(p.x) - b.sw / 2;
      const wy = p.y - b.sh + 1;
      if (b.dx !== wx || b.dy !== wy) {
        misplaced.push(`${p.c.id} blitted at ${b.dx},${b.dy} and standing at ${Math.round(p.x)},${p.y}`);
      } else if (b.dw !== b.sw || b.dh !== b.sh) {
        misplaced.push(`${p.c.id} drawn ${b.dw}x${b.dh} from a ${b.sw}x${b.sh} frame — a stretched person`);
      }
    });
  }

  if (!after.blits.length) {
    fail('the atlas is loaded and nothing was blitted — drawCitizens is still on the fallback');
  } else if (miscounted) {
    fail(`${miscounted} — the draw step and the list it draws from disagree about who is on screen`);
  } else if (misplaced.length) {
    fail(`${misplaced.length} of ${people.length} sprites were blitted somewhere other than where ` +
      `the list puts that person (${misplaced.slice(0, 2).join('; ')})`);
  } else {
    ok(`all ${people.length} sprites are centred on their citizen and standing on the floor line`);
  }
}

// ---- 3. the skull is drawn where the tap goes looking for it ---------------
//
// A death mark is the only thing on the cross-section a player is meant to
// touch, and the sprite and the hit box are computed in different functions
// from different numbers. `deathMarkAt` looks in a box around `m.y - 8`; the
// frame is anchored so that a 16-tall skull has its middle exactly there.
// Drift either one and the marker is visibly in a place that does not answer.
{
  const R = BAL.render.deathMarkTapRadius;
  const wrong = [];
  let probed = 0;
  marks.forEach((m, i) => {
    const b = after.blits[people.length + i];
    if (!b) { wrong.push('a death mark was not drawn at all'); return; }
    const wx = Math.round(m.x) - b.sw / 2;
    if (b.dx !== wx) wrong.push(`a skull at x${b.dx} for a mark at x${Math.round(m.x)}`);

    // Where the player would put a finger: the middle of what was painted. By
    // citizen rather than by object, because `deathMarkAt` recomputes the list
    // and hands back a mark that is equal to this one and not it.
    const hit = deathMarkAt(s, b.dx + b.sw / 2, b.dy + b.sh / 2);
    if (hit?.c.id !== m.c.id) {
      wrong.push(`tapping the middle of the skull drawn for ${m.c.id} ` +
        `${hit ? `finds ${hit.c.id} instead` : 'finds nothing'}`);
    }

    // That check alone only says the two overlap, and the box is 29 pixels
    // tall — a six-pixel drift is a skull visibly off its own marker and it
    // survives. So: find the box's centre by asking, sweeping y for the run of
    // taps that answer, and require the sprite to be centred on exactly that.
    // Derived rather than copied, so the offset lives in citizens.js alone.
    //
    // Skipped when another mark shadows part of the run — `deathMarkAt`
    // returns the nearest of them, so a truncated run has a midpoint that is
    // not the centre of anything.
    const ys = [];
    for (let y = Math.round(m.y) - (R + 40); y <= Math.round(m.y) + (R + 40); y++) {
      if (deathMarkAt(s, m.x, y)?.c.id === m.c.id) ys.push(y);
    }
    if (ys.length !== 2 * R + 1 || ys[ys.length - 1] - ys[0] !== 2 * R) return;
    probed++;
    const centre = (ys[0] + ys[ys.length - 1]) / 2;
    if (b.dy + b.sh / 2 !== centre) {
      wrong.push(`the skull for ${m.c.id} is drawn ${b.dy}..${b.dy + b.sh} with its middle at ` +
        `${b.dy + b.sh / 2}, and the tap box is centred on ${centre}`);
    }
  });

  if (noVictim) {
    fail('the fixture found nobody on a visible floor to bury, so the skull is unchecked');
  } else if (!marks.length) {
    fail('somebody died on a visible floor and no death mark was drawn');
  } else if (!probed) {
    fail(`all ${marks.length} marks shadow each other, so none of them could be measured ` +
      'against its own tap box');
  } else if (wrong.length) {
    fail(`${wrong.length} death marks are drawn away from their own tap box (${wrong.slice(0, 2).join('; ')})`);
  } else {
    ok(`the ${marks.length} death mark${marks.length === 1 ? ' is' : 's are'} drawn centred on ` +
      `the box deathMarkAt searches (${probed} measured exactly)`);
  }
}

// ---- 4. the sheet and the fallback stand in the same place -----------------
//
// The atlas arrives during play, not before it, so both branches are on screen
// in the same session and a player watches one become the other. If the
// anchors disagree the whole silo shifts at the moment the sheet lands.
//
// The claim is containment rather than equality — the fallback is two
// rectangles four pixels of a twelve-pixel figure wide, so they cannot share
// an origin — and it is still tight enough to catch a moved anchor: the box is
// twelve wide and the rectangles sit inside it with three pixels to spare.
{
  const jumped = [];
  const perPerson = 2;
  if (before.rects.length < people.length * perPerson) {
    fail(`the fallback pass painted ${before.rects.length} rectangles for ${people.length} people — ` +
      'too few to compare, so this section is about nothing');
  } else {
    people.forEach((p, i) => {
      const b = after.blits[i];
      if (!b) return;
      for (let k = 0; k < perPerson; k++) {
        const r = before.rects[i * perPerson + k];
        const inside = r.x >= b.dx && r.x + r.w <= b.dx + b.sw &&
          r.y >= b.dy && r.y + r.h <= b.dy + b.sh;
        if (!inside) {
          jumped.push(`${p.c.id} is painted at ${r.x},${r.y} without the sheet and inside ` +
            `${b.dx},${b.dy}..${b.dx + b.sw},${b.dy + b.sh} with it`);
          break;
        }
      }
    });
    if (jumped.length) {
      fail(`${jumped.length} of ${people.length} people move when the atlas finishes loading ` +
        `(${jumped.slice(0, 2).join('; ')}) — the silo jumps mid-session`);
    } else {
      ok(`all ${people.length} people stand in the same place with the sheet and without it`);
    }
  }
}

// ---- 5. an upgraded room draws an upgraded room ----------------------------
//
// Placed after the sheet is installed, because `drawFixture` returns false
// before it looks at anything when no atlas is loaded — run earlier this
// blitted nothing at all and proved it.
//
// The sheet carrying five fixtures per type is only half of it: the renderer
// has to ask for the right one. It asked for `room_<id>` flat, so a level-5
// Hydroponics Bay drew the same picture as a new one and the only thing that
// changed on upgrade was `drawFixture`'s three 2x2 level pips — six pixels for
// the main thing a mid-game silo does.
//
// Checked through `drawFixture` itself rather than by reading the name it
// builds, because a room that draws *nothing* would also never draw the wrong
// thing. Each level must blit, and no two levels may blit the same frame.
{
  const store = new Store(createNewGame({ seed: 0x1e5e1, now: 1_700_000_000_000 }));
  store.silent = true;
  const s = store.state;
  const room = Object.values(s.silo.rooms)[0];
  const blits = new Map();
  const ctx = {
    set fillStyle(_v) {}, get fillStyle() { return ''; },
    set globalAlpha(_v) {}, get globalAlpha() { return 1; },
    save() {}, restore() {},
    set strokeStyle(_v) {}, get strokeStyle() { return ''; },
    set lineWidth(_v) {}, get lineWidth() { return 1; },
    set font(_v) {}, get font() { return ''; },
    set textAlign(_v) {}, get textAlign() { return ''; },
    set textBaseline(_v) {}, get textBaseline() { return ''; },
    fillRect() {}, strokeRect() {}, fillText() {}, beginPath() {}, moveTo() {},
    lineTo() {}, stroke() {}, closePath() {}, clip() {}, arc() {}, fill() {},
    measureText() { return { width: 0 }; },
    drawImage(_img, sx, sy) { blits.set(room.level, `${sx},${sy}`); },
  };

  const max = BAL.silo.upgrade.maxLevel;
  room.powered = true;
  room.buildingUntilCycle = 0;
  const cam = { time: 0, worldTime: 0, camY: 0, drawn: 0, spriteBudget: 400 };
  for (let n = 1; n <= max; n++) {
    room.level = n;
    drawRoom(ctx, room, s, cam, 0);
  }

  const drawn = [...blits.values()];
  const distinct = new Set(drawn).size;
  if (blits.size !== max) {
    fail(`only ${blits.size} of ${max} room levels blitted anything at all, so this cannot tell ` +
      'whether an upgrade changes the picture');
  } else if (distinct !== max) {
    fail(`${max} levels of the same room drew ${distinct} distinct frames — upgrading it does not ` +
      'change what is on screen, which is the whole of "there are not enough upgrades visually"');
  } else {
    ok(`all ${max} levels of a room draw a different fixture`);
  }

  // And the fixtures differ in their pixels, not just in their names.
  //
  // The check above compares which frame the renderer asks for, and five
  // identical pictures packed at five positions satisfy it — deleting the
  // upgrade layer entirely left it green. So the art is redrawn here and the
  // buffers compared: each level must differ from the one below it, and the
  // distance from level 1 must grow, because the layer accumulates rather than
  // replaces and a ladder that wanders is not a ladder.
  const shots = [];
  for (let n = 1; n <= max; n++) {
    const sheetN = artAtlas(128);
    const draw = ROOM_FIXTURES_LEVELLED[room.type];
    if (!draw) break;
    draw(sheetN.sprite('probe', 64, 36), n);
    shots.push(sheetN.px.slice(0, 128 * 40 * 4));
  }
  const diff = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 3] !== b[i + 3]) n++;
    return n;
  };
  if (shots.length !== max) {
    fail(`${room.type} has no levelled art at all, so nothing here compares anything`);
  } else {
    const steps = [];
    for (let i = 1; i < max; i++) steps.push(diff(shots[i - 1], shots[i]));
    const fromBase = shots.slice(1).map((s2) => diff(shots[0], s2));
    const still = steps.findIndex((d) => d === 0);
    const shrank = fromBase.findIndex((d, i) => i > 0 && d <= fromBase[i - 1]);
    if (still >= 0) {
      fail(`upgrading a ${room.type} from level ${still + 1} to ${still + 2} changes not one ` +
        'pixel of its art — the frames are distinct names for the same picture');
    } else if (shrank >= 0) {
      fail(`a ${room.type} at level ${shrank + 3} is closer to a new one than at level ` +
        `${shrank + 2} (${fromBase[shrank]} pixels against ${fromBase[shrank - 1]}) — the ladder ` +
        'goes backwards, so an upgrade undoes the last one');
    } else {
      ok(`and each level redraws it: ${steps.join(', ')} pixels changed per step, ` +
        `${fromBase[fromBase.length - 1]} from new to finished`);
    }
  }
}


console.log('');
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
console.log('  PASS — what the player is shown is what the game meant to draw\n');
