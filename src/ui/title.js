/**
 * title.js — the door.
 *
 * The game used to boot straight into the silo, which meant the first thing a
 * player ever saw was a control panel. What the premise actually is — a very
 * deep hole with people living in it — was something you had to infer from a
 * scrollbar. This screen says it in three seconds by showing it: a slow
 * descent through the cross-section, lights on in a few of the levels, tiny
 * people moving in them, and the depth counter climbing past a hundred.
 *
 * ---------------------------------------------------------------------------
 * Why the backdrop is generated rather than simulated
 * ---------------------------------------------------------------------------
 * This is the first thing on screen on every single launch, so nothing it
 * needs may sit behind an await. Three options were on the table:
 *
 *   1. Draw the player's real silo. Needs `loadGame` (IndexedDB, tens of ms
 *      on a cold phone) before a single pixel, and a new player's silo is six
 *      dug floors and a hundred and thirty-eight sealed doors — the opposite
 *      of the thing being sold.
 *   2. `createNewGame` and run it forward a few hundred days. Correct-looking,
 *      and hundreds of milliseconds of simulation on the critical path of the
 *      launch screen. Rejected on that alone.
 *   3. Generate an arrangement of floors, rooms and people directly, in the
 *      shape the renderer already reads, and hand it to the *real* draw
 *      functions.
 *
 * Three, at about a millisecond, off a fixed seed so the silo on the door is
 * the same place every time you open it. `drawShaft`, `drawFloor`, `drawRoom`,
 * `drawFloorLabel` and `drawCitizens` are imported from the render layer
 * unchanged, so the title cannot drift away from the game's own look: change
 * how a lit room is drawn and this changes with it. Nothing here reimplements
 * a pixel.
 *
 * The state object is a stand-in, not a game state — it is never dispatched
 * to, never saved, and its clock sits at cycle -1 so the render layer's
 * cycle-keyed caches invalidate the moment the real silo takes over.
 */

import { BAL } from '../config/balance.js';
import { ROOMS, getRoom } from '../data/rooms.js';
import { PALETTE, FLOOR_H, SLOTS, WORLD_W, syncPaletteFromCSS } from '../render/canvas.js';
import { drawShaft, drawFloor, drawRoom, drawFloorLabel } from '../render/floors.js';
import { drawCitizens } from '../render/citizens.js';
import { isLoaded as spritesLoaded } from '../render/sprites.js';
import { el } from './dom.js';

const TOTAL = BAL.silo.totalFloors;

/**
 * World units per second of descent — about three and a quarter levels, or the
 * whole silo in a little over half a minute.
 *
 * Slow enough to read as a descent rather than a scroll, fast enough that it
 * is visibly moving inside the three seconds most people will look at it for.
 * At 96 it covered a fifth of a screen height in that time, which reads as a
 * still image with a drift on it.
 */
const SCROLL_SPEED = 130;
/** How long the bottom of the silo is held before the descent starts again. */
const HOLD_MS = 1600;
const WRAP_FADE_MS = 520;
/**
 * Where the top of the viewport sits when nothing is allowed to move.
 *
 * A level, not a centre: parking *on* a floor near the top left half the
 * screen showing the rock above the silo, because there is nothing above
 * floor one. This puts a full screen of cross-section up instead.
 */
const STILL_TOP_FLOOR = 5;

/**
 * Open the title screen.
 *
 * Returns immediately with a handle; the first frame is painted on the next
 * animation frame, before the caller has loaded anything.
 *
 *   handle.firstPaint      a promise, for anybody measuring
 *   handle.setSave(s)      what `loadGame` found (or null) — fills the menu in
 *   handle.setReducedMotion(b)
 *   handle.ready(opts)     the game is built; wire Settings up
 *   handle.choice()        resolves 'continue' | 'new' when the player picks
 *   handle.close()         fades out and removes; resolves when it is gone
 */
export function openTitle({ onFirstPaint } = {}) {
  syncPaletteFromCSS();

  const state = buildSilo();
  const root = el('div.title', { id: 'title', role: 'dialog', 'aria-label': 'Deepwater' });
  const canvas = el('canvas.title-canvas', { 'aria-hidden': 'true' });
  const level = el('div.title-level', `LEVELS 001–${TOTAL}`);

  const plate = el(
    'div.title-plate',
    el('div.title-eyebrow', "Mayor's office · Silo 12"),
    el('h1.title-word', 'DEEPWATER'),
    el('div.title-rule'),
    el('div.title-sub', `${TOTAL} levels. The clock does not stop.`)
  );

  const menu = el('div.title-menu');

  root.append(canvas, el('div.title-scrim', { 'aria-hidden': 'true' }), level, plate, menu);
  document.body.appendChild(root);

  // ---- the menu ------------------------------------------------------------
  // Nothing is offered until the save layer has answered. The gap is a few
  // milliseconds, and the alternative is a returning player being able to tap
  // "New silo" in the window before the game knows they have one.
  let resolveChoice = null;
  const chosen = new Promise((res) => (resolveChoice = res));
  let settled = false;
  let onSettings = null;
  let save = undefined; // undefined = still asking; null = nothing there

  const primary = el('button.title-btn.primary', { id: 'title-primary', type: 'button', disabled: true });
  const primaryLabel = el('span.title-btn-label', 'Loading…');
  const primarySub = el('span.title-btn-sub');
  primary.append(primaryLabel, primarySub);

  const fresh = el('button.title-btn', { id: 'title-new', type: 'button', disabled: true, hidden: true });
  fresh.append(
    el('span.title-btn-label', 'New silo'),
    el(
      'span.title-btn-sub',
      `${BAL.citizens.startPopulation} people, ${BAL.silo.startExcavatedFloors} of ${BAL.silo.totalFloors} levels lit.`
    )
  );

  const settingsBtn = el('button.title-btn.ghost', { id: 'title-settings', type: 'button', disabled: true });
  settingsBtn.append(el('span.title-btn-label', 'Settings'));

  menu.append(primary, fresh, settingsBtn);

  const pick = (what) => {
    if (settled) return;
    settled = true;
    for (const b of [primary, fresh, settingsBtn]) b.disabled = true;
    resolveChoice(what);
  };

  primary.addEventListener('click', () => (save ? pick('continue') : pick('new')));
  fresh.addEventListener('click', () => confirmReplace());
  settingsBtn.addEventListener('click', () => onSettings?.());

  /**
   * Replacing a silo that exists is the only destructive thing on this screen,
   * so it asks — in the menu, in the game's own voice, rather than in a dialog
   * that would have to fight this screen for the top of the stack.
   */
  function confirmReplace() {
    if (settled || !save) return;
    menu.replaceChildren(
      el(
        'div.title-confirm',
        el('div.title-confirm-q', 'Replace the silo in the slot?'),
        el(
          'div.title-confirm-a',
          `Day ${save.day}, ${save.population} resident${save.population === 1 ? '' : 's'}. ` +
            'There is no way back to it afterwards.'
        )
      )
    );
    const keep = el('button.title-btn', { type: 'button' });
    keep.append(el('span.title-btn-label', 'Keep it'));
    keep.addEventListener('click', () => restoreMenu());
    const replace = el('button.title-btn.warn', { type: 'button' });
    replace.append(el('span.title-btn-label', 'Replace it'));
    replace.addEventListener('click', () => pick('new'));
    menu.append(keep, replace);
    replace.focus?.();
  }

  function restoreMenu() {
    menu.replaceChildren(primary, fresh, settingsBtn);
  }

  // A tap anywhere that is not a control does what the primary button does.
  // A player coming back to a silo should never have to aim at anything.
  root.addEventListener('pointerdown', (e) => {
    if (settled || save === undefined) return;
    if (e.target.closest('button')) return;
    if (menu.querySelector('.title-confirm')) return; // a question is on screen
    pick(save ? 'continue' : 'new');
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target.closest('button')) return;
      e.preventDefault();
      if (!settled && save !== undefined) pick(save ? 'continue' : 'new');
    }
  });

  // ---- the backdrop --------------------------------------------------------
  const ctx = canvas.getContext('2d', { alpha: false });
  const cam = {
    state,
    camY: -FLOOR_H * 0.5,
    time: 0,
    drawn: 0,
    scale: 1,
    dpr: 1,
    w: 0,
    h: 0,
    viewWorldH() {
      return this.h / this.scale;
    },
    visibleFloorRange() {
      const top = this.camY;
      const bottom = this.camY + this.viewWorldH();
      return {
        from: Math.max(1, Math.floor(top / FLOOR_H)),
        to: Math.min(TOTAL, Math.ceil(bottom / FLOOR_H) + 1),
      };
    },
  };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cam.dpr = Math.min(window.devicePixelRatio || 1, 2);
    cam.w = Math.max(1, Math.round(rect.width));
    cam.h = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(cam.w * cam.dpr);
    canvas.height = Math.round(cam.h * cam.dpr);
    // Pulled a long way further back than the game's own camera, which fits
    // the six bays across the screen and shows twenty levels. This one shows
    // about thirty-six, with bare rock either side of the shaft — the thing
    // being sold is the column, not the room you are standing in.
    cam.scale = Math.max(0.4, Math.min(1.1, (cam.w * 0.58) / WORLD_W));
    ctx.imageSmoothingEnabled = false;
    dirty = true;
  }

  let dirty = true;
  let hadSprites = false;
  let last = 0;
  let hold = 0;
  let parked = null;
  let wrapFade = 0;
  let raf = 0;
  let painted = false;
  let firstPaintResolve;
  const firstPaint = new Promise((res) => (firstPaintResolve = res));

  const bottomY = () => Math.max(0, TOTAL * FLOOR_H - cam.viewWorldH());
  const topY = () => -FLOOR_H * 0.5;

  function step(now) {
    raf = requestAnimationFrame(step);
    const dt = last ? Math.min(64, now - last) : 16;
    last = now;

    if (state.settings.reducedMotion) {
      // Parked. The clock stops too, so the flicker, the gait and the drift
      // are all still — this is one frame, held, not a slow version of the
      // same thing. Nothing is redrawn until something actually changes.
      const want = Math.min(bottomY(), Math.max(topY(), (STILL_TOP_FLOOR - 1) * FLOOR_H));
      if (cam.camY !== want) {
        cam.camY = want;
        dirty = true;
      }
      // The atlas usually lands after the first frame. In the moving case the
      // next frame picks it up for free; a still screen has to be told, or it
      // holds the fallback stick figures for as long as it is up.
      const hasSprites = spritesLoaded();
      if (hasSprites !== hadSprites) {
        hadSprites = hasSprites;
        dirty = true;
      }
      if (!dirty) return;
      dirty = false;
      draw();
      return;
    }

    cam.time += dt;
    if (parked != null) {
      const want = (parked - 1) * FLOOR_H - cam.viewWorldH() / 2 + FLOOR_H / 2;
      cam.camY = Math.min(bottomY(), Math.max(topY(), want));
      draw();
      return;
    }
    if (hold > 0) {
      hold -= dt;
      if (hold <= 0) wrapFade = WRAP_FADE_MS;
    } else if (wrapFade > 0) {
      // Fade down, cut back to the top at the darkest point, fade up.
      const before = wrapFade;
      wrapFade -= dt;
      if (before > WRAP_FADE_MS / 2 && wrapFade <= WRAP_FADE_MS / 2) cam.camY = topY();
      if (wrapFade < 0) wrapFade = 0;
    } else {
      cam.camY += (SCROLL_SPEED * dt) / 1000;
      if (cam.camY >= bottomY()) {
        cam.camY = bottomY();
        hold = HOLD_MS;
      }
    }
    draw();
  }

  function draw() {
    if (!cam.w || !cam.h) return;
    cam.drawn = 0;
    ctx.save();
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    ctx.fillStyle = PALETTE.concreteDeep;
    ctx.fillRect(0, 0, cam.w, cam.h);

    // Land the drawn edge on a whole device pixel, as canvas.js does, or the
    // whole cross-section shimmers on the way past.
    const k = cam.scale * cam.dpr;
    const drawnY = k > 0 ? Math.round(cam.camY * k) / k : cam.camY;
    ctx.translate(Math.round(cam.w / 2), 0);
    ctx.scale(cam.scale, cam.scale);
    ctx.translate(-WORLD_W / 2, -drawnY);

    const range = cam.visibleFloorRange();
    const flicker = state.settings.reducedMotion ? 1 : flickerAt(cam.time);

    drawShaft(ctx, state, range, cam);
    for (let n = range.from; n <= range.to; n++) {
      const floor = state.silo.floors[n - 1];
      if (!floor) continue;
      drawFloor(ctx, floor, n, cam);
      cam.drawn++;
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
        drawRoom(ctx, room, state, cam, flicker);
        cam.drawn++;
      }
    }
    drawCitizens(ctx, state, cam);
    for (let n = range.from; n <= range.to; n++) drawFloorLabel(ctx, n, state, cam);

    ctx.restore();

    if (wrapFade > 0) {
      // A triangle: 1 at the cut, 0 at both ends.
      const t = 1 - Math.abs(wrapFade - WRAP_FADE_MS / 2) / (WRAP_FADE_MS / 2);
      ctx.save();
      ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
      ctx.globalAlpha = Math.max(0, Math.min(1, t));
      ctx.fillStyle = PALETTE.concreteDeeper;
      ctx.fillRect(0, 0, cam.w, cam.h);
      ctx.restore();
    }

    const { from, to } = levelsInView();
    const text = `LEVELS ${pad3(from)}–${pad3(to)}`;
    if (level.textContent !== text) level.textContent = text;

    if (!painted) {
      painted = true;
      try {
        performance.mark?.('deepwater:title-first-paint');
      } catch {}
      onFirstPaint?.();
      firstPaintResolve(performance.now());
    }
  }

  /**
   * Which levels are on the glass, top to bottom.
   *
   * The counter shows both ends rather than a single number, and that was a
   * correction: the middle of the viewport starts the descent at nineteen and
   * finishes it at a hundred and twenty-six, so a one-number readout never
   * showed either end of the silo — and the bottom of it is the whole point.
   */
  function levelsInView() {
    const from = Math.max(1, Math.min(TOTAL, Math.floor(cam.camY / FLOOR_H) + 1));
    const to = Math.max(from, Math.min(TOTAL, Math.ceil((cam.camY + cam.viewWorldH()) / FLOOR_H)));
    return { from, to };
  }

  /** The same sodium flicker the silo uses, off the same balance numbers. */
  function flickerAt(t) {
    const s = t * 0.001 * BAL.render.flickerSpeed;
    const n = Math.sin(s * 2.1) * 0.5 + Math.sin(s * 5.7) * 0.3 + Math.sin(s * 11.3) * 0.2;
    return 1 + n * BAL.render.flickerAmplitude;
  }

  const onResize = () => resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // The OS preference is known before anything is loaded; the player's own
  // setting is in the save and arrives a moment later. Last launch's answer is
  // remembered so somebody who turned it on by hand gets a still screen from
  // the first frame rather than a second of scroll they asked not to have.
  state.settings.reducedMotion =
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false) ||
    readReducedMotionHint();

  resize();
  raf = requestAnimationFrame(step);

  // ---- handle --------------------------------------------------------------
  let closed = false;
  return {
    node: root,
    firstPaint,
    state,
    choice: () => chosen,

    setSave(summary) {
      save = summary || null;
      if (save) {
        primaryLabel.textContent = 'Continue';
        primarySub.textContent =
          `${save.siloName || 'Silo 12'} · Day ${save.day} · ` +
          `${save.population} resident${save.population === 1 ? '' : 's'}`;
        primarySub.hidden = false;
        fresh.hidden = false;
        fresh.disabled = false;
      } else {
        primaryLabel.textContent = 'New silo';
        primarySub.textContent =
          `${BAL.citizens.startPopulation} people, ${BAL.silo.startExcavatedFloors} of ${BAL.silo.totalFloors} levels lit.`;
        primarySub.hidden = false;
        fresh.hidden = true;
      }
      primary.disabled = false;
      primary.focus?.();
    },

    setReducedMotion(on) {
      state.settings.reducedMotion = !!on;
      dirty = true;
      writeReducedMotionHint(!!on);
    },

    /**
     * Hold the descent on one level, or `null` to let it fall again. For
     * screenshots and for anything that needs a frame it can compare — the
     * scroll is otherwise a function of the wall clock and never repeats.
     */
    park(floorN) {
      parked = floorN == null ? null : Math.max(1, Math.min(TOTAL, floorN));
      dirty = true;
    },

    /** Which levels are on the glass right now, as the counter reads them. */
    inView: levelsInView,

    /** The game behind this is built. Settings can be opened for real now. */
    ready(opts = {}) {
      onSettings = opts.onSettings || null;
      settingsBtn.disabled = !onSettings;
    },

    close() {
      if (closed) return Promise.resolve();
      closed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      const instant = state.settings.reducedMotion;
      root.classList.add('is-out');
      return new Promise((res) => {
        const done = () => {
          root.remove();
          res();
        };
        if (instant) done();
        else setTimeout(done, 320);
      });
    },
  };
}

// ---------------------------------------------------------------- the silo --

/**
 * A hundred and forty-four levels of somewhere.
 *
 * Built to be read on the way past rather than to be played: the head of the
 * silo is dense and lit, the middle thins out, and the bottom is mostly shut
 * doors with the occasional light still burning in them. That gradient is the
 * whole argument the screen is making — it gets deeper, and it gets darker,
 * and there are still people down there.
 */
function buildSilo() {
  const rnd = seeded(0xdeb9a7e5);
  const floors = [];
  const rooms = {};
  const citizens = {};
  const citizenIds = [];
  let nextRoom = 1;
  let nextCitizen = 1;

  for (let n = 1; n <= TOTAL; n++) {
    const d = (n - 1) / (TOTAL - 1);
    // Eased rather than linear. A straight ramp had the first screenful
    // already halfway to derelict, and the head of the silo is the part that
    // has to look inhabited — it is what is behind the name, in the three
    // seconds most people give a title screen.
    const e = Math.pow(d, 0.75);
    // Sealed levels: none at the top, common at the bottom. Floor 144 is
    // always dug so the shaft is drawn the whole way down.
    const sealChance = n <= 8 || n === TOTAL ? 0 : Math.min(0.5, Math.max(0, e - 0.08) * 0.62);
    const excavated = rnd() >= sealChance;
    const floor = {
      excavated,
      slots: new Array(SLOTS).fill(null),
      shored: true,
      integrity: 100,
      dugOnDay: 0,
    };
    floors.push(floor);
    if (!excavated) continue;

    // Dug, and nothing on it. Rhythm: a run of built floors reads as a silo,
    // an unbroken column of them reads as a wall of machinery.
    if (n > 6 && rnd() < 0.06 + e * 0.26) continue;

    const fill = 0.76 - e * 0.48;
    const litChance = 0.72 - e * 0.6;
    // Every so often, deep down, one room that is definitely still running.
    // An unbroken hundred floors of dark is a ruin; this is an inhabited silo.
    const beacon = n > 60 && n % 13 === 0;

    let slot = 0;
    while (slot < SLOTS) {
      if (rnd() > fill) {
        slot += 1;
        continue;
      }
      const type = pickType(rnd, d);
      const def = getRoom(type);
      const width = Math.min(def.width || 1, SLOTS - slot);
      const lit = beacon && slot === 0 ? true : rnd() < litChance;
      const id = String(nextRoom++);
      const room = {
        id,
        type,
        floor: n,
        slot,
        width,
        level: 1 + (rnd() < 0.25 ? 1 : 0) + (rnd() < 0.08 ? 1 : 0),
        condition: lit ? 70 + rnd() * 30 : 30 + rnd() * 55,
        staff: [],
        powered: lit,
        contaminated: false,
        buildingUntilCycle: 0,
        upgradingUntilCycle: 0,
      };
      rooms[id] = room;
      for (let s = slot; s < slot + width; s++) floor.slots[s] = id;
      slot += width;

      // Crew for the rooms that are running, so the lights have somebody in
      // them. `roomCapability` reads these, and a room with nobody at the post
      // draws as a dark shell however much power it has.
      if (lit && def.staff) {
        const crew = 2 + Math.floor(rnd() * Math.min(3, width * 2));
        for (let i = 0; i < crew; i++) {
          const c = makePerson(nextCitizen++, rnd, {
            status: 'working',
            job: { roomId: id, skill: def.staff.skill },
            skill: def.staff.skill,
          });
          citizens[c.id] = c;
          citizenIds.push(c.id);
          room.staff.push(c.id);
        }
      }
    }
  }

  // Everybody who is not on shift. `idleFloor` deals them across every floor
  // with a bed or a canteen on it, which is why those were scattered up there
  // rather than stacked at the top.
  const offShift = Math.round(citizenIds.length * 0.9);
  for (let i = 0; i < offShift; i++) {
    const c = makePerson(nextCitizen++, rnd, { status: 'idle', job: null });
    citizens[c.id] = c;
    citizenIds.push(c.id);
  }

  return {
    meta: { siloName: 'Silo 12', seed: 0, gameOver: null },
    // Cycle -1 and not 0: the render layer keeps two caches keyed on the cycle
    // number, and a real silo opens on cycle 0. Sharing it would hand the game
    // this screen's bed and canteen floors on its first frame.
    clock: { tick: 0, cycle: -1, shift: 3, day: 1, year: 0 },
    settings: { reducedMotion: false },
    ui: { selectedRoom: null, cameraFloor: 1 },
    silo: { floors, rooms, nextRoomId: nextRoom, powerPriority: [], excavating: null, shoring: {} },
    citizens,
    citizenIds,
    world: {},
    resources: {},
    flows: {},
  };
}

/**
 * What tends to be on a level, by how far down it is.
 *
 * Weighted by repetition, and weighted warm on purpose. Sodium amber is what
 * an ordinary running room looks like in this game; verdigris belongs to the
 * few rooms that grow or mend things, and a silo drawn mostly out of clinics
 * and hydroponics racks comes out green, which is the wrong silo.
 */
const BANDS = [
  {
    to: 0.06,
    types: ['airlock', 'suit_bay', 'sheriffs_office', 'radio_room', 'residences', 'cafeteria',
      'storage_depot', 'schoolhouse'],
  },
  {
    to: 0.2,
    types: ['residences', 'residences', 'residences', 'cafeteria', 'cafeteria', 'workshop',
      'schoolhouse', 'storage_depot', 'sheriffs_office', 'recycling', 'clinic', 'hydroponics',
      'generator_hall', 'water_reclaimer'],
  },
  {
    to: 0.5,
    types: ['residences', 'residences', 'workshop', 'workshop', 'recycling', 'foundry',
      'storage_depot', 'storage_depot', 'barracks', 'armory', 'training_yard', 'cafeteria',
      'maintenance_bay', 'munitions', 'air_filtration', 'hydroponics'],
  },
  {
    to: 0.78,
    types: ['foundry', 'foundry', 'recycling', 'heat_exchange', 'storage_depot', 'storage_depot',
      'maintenance_bay', 'maintenance_bay', 'munitions', 'barracks', 'holding_cells', 'workshop',
      'reactor'],
  },
  {
    to: 1.01,
    types: ['deep_mine', 'deep_mine', 'deep_mine', 'heat_exchange', 'storage_depot',
      'storage_depot', 'maintenance_bay', 'maintenance_bay', 'foundry', 'reactor'],
  },
];

function pickType(rnd, d) {
  const band = BANDS.find((b) => d <= b.to) || BANDS[BANDS.length - 1];
  const list = band.types.filter((t) => ROOMS[t]);
  return list[Math.floor(rnd() * list.length)] || 'storage_depot';
}

/**
 * The fields the render layer actually reads off a citizen, and nothing else.
 *
 * Deliberately not `makeCitizen`: that rolls a name, seven skills, five stats,
 * traits and a portrait seed for every one of a few hundred people, all of
 * which are for screens this one never opens.
 */
function makePerson(id, rnd, { status, job, skill }) {
  const r = rnd();
  const age = status === 'working'
    ? 19 + rnd() * 42
    : r < 0.17
      ? 4 + rnd() * 12
      : r < 0.29
        ? 58 + rnd() * 24
        : 18 + rnd() * 38;
  return {
    id,
    age,
    status,
    job,
    squadId: null,
    health: 72 + rnd() * 28,
    vitality: 70 + rnd() * 30,
    morale: 50 + rnd() * 40,
    radiation: 0,
    traits: [],
    skills: skill ? { [skill]: 35 + rnd() * 55 } : {},
    deathTick: null,
    deathSeen: true,
  };
}

const pad3 = (n) => String(n).padStart(3, '0');

/** mulberry32 — small, fast, and the same silo every launch. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The setting itself lives in the save, which is not loaded yet when the first
// frame goes up. This is a hint, not the truth: it is corrected by
// `setReducedMotion` the moment the real one is known.
const HINT = 'deepwater:stillTitle';

function readReducedMotionHint() {
  try {
    return localStorage.getItem(HINT) === '1';
  } catch {
    return false;
  }
}

function writeReducedMotionHint(on) {
  try {
    if (on) localStorage.setItem(HINT, '1');
    else localStorage.removeItem(HINT);
  } catch {
    /* private mode; the OS preference still applies */
  }
}

export default openTitle;
