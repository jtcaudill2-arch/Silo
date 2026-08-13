/**
 * ui.mjs — the chrome. Panel frames, buttons, nav icons and resource glyphs.
 *
 * Everything else in tools/art/ draws things that live in the world: rooms,
 * people, threats, kit. This file draws the INTERFACE, which is a different
 * job with a different constraint, and the constraint is worth stating first
 * because it decided every size in the file.
 *
 * ---------------------------------------------------------------------------
 * THE BRIEF: PIXEL FRAME, READABLE TYPE
 *
 * The panels are HTML with a web font on top of a strict-palette pixel canvas,
 * and the two did not read as one game. The fix is NOT a bitmap font. There is
 * a great deal of prose in this game — room descriptions, standing orders,
 * shift reports, the ledger — and it is read on a 412px phone. A 5x7 bitmap
 * face would cost about a third of the words on every screen and buy an
 * aesthetic nobody asked for.
 *
 * So the period feel comes from the FRAME, the ICONS and the PALETTE, and the
 * body copy stays IBM Plex at 13.5px. What this file draws:
 *
 *   1. a 9-slice panel frame — riveted steel plate, so a panel reads as a
 *      hatch cut into the silo rather than as a div,
 *   2. three button frames — raised, pressed, dead — matching the three
 *      states styles.css already distinguishes and no more,
 *   3. nine navbar icons, each a 3-frame idle loop,
 *   4. thirteen resource glyphs, each a 2-frame idle loop.
 *
 * ---------------------------------------------------------------------------
 * HOW IT REACHES THE SCREEN, AND WHY IT IS NOT frameCanvas()
 *
 * src/render/sprites.js:frameCanvas() cuts an atlas frame out as a <canvas>,
 * and that is how the Armory shows a rifle. It is the wrong tool here, and the
 * measurement is the argument:
 *
 *   frameCanvas   9 nav icons + 13 counters = 22 canvases, each an element,
 *                 a 2D context and a drawImage, rebuilt whenever the shell
 *                 rebuilds the strip (every cycle) — and ANIMATING them means
 *                 a JS timer redrawing 22 canvases forever, on the same main
 *                 thread as the simulation.
 *   data URI      one decode of a 42x126 sheet and a 20x130 sheet, shared by
 *                 every element that names them, animated by the compositor
 *                 with `steps()` and costing the main thread nothing. The two
 *                 sheets plus the four frames are 6.9 KB of base64 in total —
 *                 measured, printed by the self-test, and gated at 12 KB.
 *                 Frame rate was measured too, on a day-220 silo at 412x892:
 *                 60.3 fps with all twenty idle loops running and 60.3 with
 *                 them switched off. `steps()` on a background-position is
 *                 compositor work; the simulation never hears about it.
 *
 * The other half of it is that the shell builds the navbar from `panel.glyph`
 * and the strip from its own STRIP table, and neither can grow a canvas child
 * without editing files this change does not own. A background-image keyed off
 * `[data-panel]` and `[data-res]` — attributes the shell already writes — needs
 * no DOM change at all.
 *
 * So the art is emitted TWICE from the same draw functions:
 *
 *   assets/atlas.png     as `ui_*` frames, packed by tools/gen-atlas.mjs, so
 *                        the canvas layer can use them and so the frames are
 *                        auditable by every tool that reads the sheet.
 *   src/ui/styles.css    as base64 PNGs inside a generated block, which is
 *                        what the DOM actually paints.
 *
 * They cannot drift, because both come from the functions below and the
 * self-test regenerates the CSS block and fails if the file's copy differs.
 * Rewriting a source file from a tool is the pattern tools/gen-precache.mjs
 * already uses on sw.js, down to the BEGIN/END markers.
 *
 * ---------------------------------------------------------------------------
 * SIZES, AND WHY THESE ONES
 *
 * ZOOM 2. Everything here is authored at half its CSS size and blitted at
 * exactly 2x, because tools/art/gear.mjs already established 2x as the DOM's
 * scale (24x24 gear icons at 48 CSS px in the Armory row) and because a
 * non-integer zoom on nearest-neighbour art produces uneven pixels — the one
 * thing that instantly reads as "a picture of pixel art" rather than pixel art.
 *
 * NAV 14x14 -> 28 CSS px. The navbar is EXACTLY full: nine buttons in 390px is
 * 43px each, and the mobile suite fails the build if a tenth pixel of width is
 * needed. Height is the binding constraint, not width: --navbar-h is 54px, the
 * button spends 8px on padding and ~12.3px on its label plus a 2px gap, which
 * leaves 31px. 14x14 at 2x is 28 and fits with 3px to spare; 16x16 at 2x is 32
 * and does not fit at all. 14 is therefore the largest even authoring size the
 * navbar can hold, and the icons need every column of it — see the note over
 * the nav set on what has to fit in one.
 *
 * RES 12x12 -> 24 CSS px. The counter is 46px tall and carries two lines of
 * type, so the glyph goes to the LEFT of both of them rather than above, and
 * its budget is the height of the pair (~25px) and whatever width the strip
 * can afford before it scrolls a counter sooner than it used to.
 *
 * It was 10x10 for one draft and that was too small, which the self-test said
 * before anybody looked: at a 10px frame with a keyline the interior is 8x8,
 * the cog filled 96% of its own box and the cog and the coolant coil came out
 * ONE cell apart on the silhouette grid. Thirteen glyphs that have to be told
 * apart from each other in a row need outlines that differ, and an outline
 * needs somewhere to differ. 12x12 buys a 10x10 interior — 56% more area — for
 * 4 CSS px of strip width per counter, which is the best trade in the file.
 *
 * PANEL FRAME slice 4 -> 8 CSS px of border. Two pixels of plate between two
 * keylines: ink, highlight, base, ink. That is the thinnest thing that still
 * reads as a bevelled plate rather than as a border-width, and 8px is what a
 * 412px panel can give up on both sides without squeezing the rows inside it.
 * The middle of each edge is 12px and carries one rivet, so rivets land every
 * 24 CSS px along a panel edge.
 *
 * BUTTON FRAME slice 4 -> 8 CSS px, on a 16x16 tile. Same plate, shorter run:
 * an 8px middle, so a rivet every 16 CSS px, which puts two or three down the
 * side of an ordinary button instead of one lonely one.
 *
 * ---------------------------------------------------------------------------
 * HOUSE RULES, inherited from scenery.mjs and gear.mjs
 *
 *   - every solid form carries a 1px PAL.ink keyline, grown by form.keyline()
 *     on the icons and placed by hand on the 9-slice frames, where the keyline
 *     IS the outer and inner ring and growing it would eat the plate,
 *   - light from the upper left, always,
 *   - colour is a PAL entry through tone(), or shade() of one. PAL.toxin is
 *     radiation only and appears nowhere in this file,
 *   - nothing is random. Not one call to Math.random or to rng(): every
 *     function here is a pure function of its arguments, so the atlas and the
 *     stylesheet regenerate byte-identically.
 *
 * Run: node tools/art/ui.mjs               (self-test)
 *      node tools/art/ui.mjs --write-css   (self-test, then update styles.css)
 *      node tools/art/ui.mjs --out=/tmp/ui.png --zoom=8   (contact sheet)
 */

import { PAL, shade, atlas } from './lib.mjs';
import { tone, form, legalColour } from './scenery.mjs';

/* ---------------------------------------------------------------- layout -- */

/** CSS pixels per authored pixel. Integer, everywhere, forever. */
export const UI_ZOOM = 2;

export const NAV_SIZE = 14;
export const NAV_FRAMES = 3;
export const RES_SIZE = 12;
export const RES_FRAMES = 2;

/** 9-slice tiles: [size, corner slice]. Middle run = size - 2 * slice. */
export const PANEL_TILE = 20, PANEL_SLICE = 4;
export const BTN_TILE = 16, BTN_SLICE = 4;

/* --------------------------------------------------------------- colours -- */

const INK = PAL.ink;

// The plate every frame is pressed out of. Steel, because the panels sit on
// concrete and a concrete frame on a concrete field has no edge at all.
const MET = tone('steel', -0.16);
const MET_HI = tone('steelLit', 0.06);
const MET_LO = tone('steelDark', -0.14);
const MET_DK = tone('steelDark', -0.34);
const RIVET = tone('steelLit', 0.34);

// A dead control. Concrete, not dimmed steel: styles.css already drops the
// opacity of a disabled button, and dimming a dim thing leaves a smudge.
const OFF = tone('concrete');
const OFF_HI = tone('concrete', 0.14);
const OFF_LO = tone('concrete', -0.18);

// The silo's own warm colour: power, lamps, hazard marks, anything live.
const AMBER = tone('sodium');
const AMBER_HI = tone('sodium', 0.42);
const AMBER_LO = tone('sodium', -0.42);
const AMBER_DK = tone('sodium', -0.66);

// Glass, screens, water, coolant — anything that emits or flows.
const GLASS = tone('verdigris', 0.26);
const GLASS_HI = tone('verdigris', 0.54);
const GLASS_MID = tone('verdigris');
const GLASS_LO = tone('verdigris', -0.30);

// Rust and salvage.
const RUSTY = tone('rust', -0.06);
const RUST_HI = tone('rust', 0.22);
const RUST_LO = tone('rust', -0.38);
const WOOD = tone('rust', -0.46);
const WOOD_HI = tone('rust', -0.26);
const WOOD_LO = tone('rust', -0.60);

// Paper, bone, pre-collapse plastic.
const PRE = tone('bone', -0.16);
const PRE_HI = tone('bone', 0.02);
const PRE_LO = tone('bone', -0.42);

// A person. The same denim the citizens in the cross-section wear, so the
// People icon is visibly the same species as the figures on the floors.
const SKIN = tone('skin', -0.10);
const SKIN_LO = tone('skinShade', -0.18);
const DENIM = tone('denim');
const DENIM_HI = tone('denimLit');
const DENIM_LO = tone('denimDark');

const CONC = tone('concrete');
const CONC_HI = tone('concrete', 0.22);
const CONC_LO = tone('concrete', -0.24);

/* =============================================================== 9-slice == */
/*
 * A border-image tile. The four corners are drawn once and never stretch; the
 * four edge middles tile along their run. What makes it a FRAME rather than a
 * rectangle is that every one of those nine regions is lit consistently: the
 * top and left plates catch the light, the bottom and right plates are in
 * shadow, and both are held between an outer and an inner keyline so the panel
 * sits in a well.
 *
 * `form.keyline()` is deliberately NOT used here. It grows ink into every
 * empty pixel touching the figure, and on a shape that is all edge that means
 * ink everywhere: the plate is two pixels thick and the keyline would eat both
 * of them. The two rings are placed by hand instead, which is also the only
 * way to guarantee the inner one lands exactly on the slice line.
 */

/**
 * @param spec.face   the plate colour
 * @param spec.lit    the top and left plate — light from the upper left
 * @param spec.dark   the bottom and right plate
 * @param spec.rivet  rivet head colour, or null for a plain bevel
 */
function nineSlice(f, size, slice, spec) {
  const { face, lit, dark, rivet } = spec;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dt = y, dl = x, db = size - 1 - y, dr = size - 1 - x;
      const d = Math.min(dt, dl, db, dr);
      if (d >= slice) continue;               // the middle stays transparent
      if (d === 0 || d === slice - 1) { f.px(x, y, INK); continue; }
      // Which edge owns this pixel decides whether it is lit or shaded. Ties
      // go to the lit side, so the top-left corner is unambiguously the near
      // one and the bottom-right unambiguously the far one.
      const near = d === dt || d === dl;
      f.px(x, y, d === 1 ? (near ? lit : dark) : face);
    }
  }
  if (rivet) {
    // One rivet in the centre of each edge's tiling run, so a repeated edge
    // spaces them evenly however long the panel is.
    const mid = slice + Math.floor((size - 2 * slice) / 2) - 1;
    const hi = shade(rivet, 0.2);
    const dome = (x, y) => {
      f.px(x, y, hi); f.px(x + 1, y, rivet);
      f.px(x, y + 1, rivet); f.px(x + 1, y + 1, INK);
    };
    dome(mid, 1);                       // top
    dome(mid, size - 3);                // bottom
    dome(1, mid);                       // left
    dome(size - 3, mid);                // right
  }
  return f;
}

/** The panel bezel. Riveted steel plate, lit from the upper left. */
function framePanel(f) {
  return nineSlice(f, PANEL_TILE, PANEL_SLICE, {
    face: MET, lit: MET_HI, dark: MET_LO, rivet: RIVET,
  });
}

/** A raised button. */
function frameBtn(f) {
  return nineSlice(f, BTN_TILE, BTN_SLICE, {
    face: MET, lit: MET_HI, dark: MET_LO, rivet: RIVET,
  });
}

/**
 * A pressed button: the same plate with the light swapped end for end, so the
 * bevel goes from proud to sunken. The face darkens too — a button that only
 * flips its bevel reads as a rendering glitch at 38px; a button that also
 * loses a shade reads as one somebody is holding down.
 */
function frameBtnDown(f) {
  return nineSlice(f, BTN_TILE, BTN_SLICE, {
    face: MET_LO, lit: MET_DK, dark: MET_HI, rivet: null,
  });
}

/** A dead button. Flat concrete, no bevel to invite a press, no rivets. */
function frameBtnOff(f) {
  return nineSlice(f, BTN_TILE, BTN_SLICE, {
    face: OFF, lit: OFF_HI, dark: OFF_LO, rivet: null,
  });
}

export const UI_FRAMES = {
  frame_panel: { size: PANEL_TILE, slice: PANEL_SLICE, draw: framePanel },
  frame_btn: { size: BTN_TILE, slice: BTN_SLICE, draw: frameBtn },
  frame_btn_down: { size: BTN_TILE, slice: BTN_SLICE, draw: frameBtnDown },
  frame_btn_off: { size: BTN_TILE, slice: BTN_SLICE, draw: frameBtnOff },
};

/* ============================================================ nav icons == */
/*
 * Nine panels, 14x14 each, three frames each.
 *
 * WHAT AN IDLE LOOP IS FOR. Not decoration: a navbar that wriggles is a
 * navbar nobody can read. Every one of these holds its SILHOUETTE still across
 * all three frames and animates a light, a level or a signal inside it — a
 * weld arc striking, a bubble rising, a hatch handle being worked, a set of
 * scales rocking. The shape is what you navigate by and the movement is what
 * tells you the game is running. The two exceptions earn it: the antenna
 * throws its arcs outward, which is the whole meaning of the icon, and the
 * bust breathes, which is the whole meaning of that one.
 *
 * WHY THEY ARE NOT SIMPLER. 14x14 with a keyline leaves a 12x12 interior, and
 * the temptation at that size is nine flat pictograms. They would have read as
 * a different game from the one behind them: the silo is drawn with lit faces,
 * shaded faces and an ink line round everything, so these are too. Every icon
 * here is a solid object with a light on it, not a symbol.
 *
 * The self-test measures the thing that actually breaks — that no two of the
 * nine collapse to the same 11x11 silhouette — and fault-injects it.
 */

/** Left-lit, right-shaded block. The workhorse, as everywhere else. */
const slab = (f, x, y, w, h, c, lit = 0.24, dk = -0.26) => f.slab(x, y, w, h, c, lit, dk);

/**
 * BUILD — an angle bracket with a weld arc struck at the inside corner.
 *
 * An L is the only shape in the nine that is mostly absence, which is why it
 * was chosen: nothing else here can be mistaken for it at a glance. The arc
 * flashes off / small / wide, which is what an arc does.
 */
function navBuild(f, k) {
  slab(f, 2, 1, 4, 11, MET);            // the upright
  slab(f, 2, 8, 10, 4, MET);            // the foot
  f.keyline();
  f.hline(3, 2, 2, MET_HI);             // the lit inner faces
  f.vline(3, 2, 6, MET_HI);
  f.hline(3, 9, 8, MET_HI);
  f.px(4, 4, RIVET); f.px(4, 6, RIVET); // rivets down the upright
  f.px(7, 10, RIVET); f.px(9, 10, RIVET);
  f.px(5, 11, MET_LO); f.px(11, 11, MET_LO);
  if (k >= 1) {
    f.px(7, 6, AMBER_HI); f.px(7, 7, AMBER);
    f.px(8, 6, AMBER); f.px(6, 6, AMBER_LO);
  }
  if (k >= 2) {
    f.px(6, 5, AMBER); f.px(8, 5, AMBER_LO); f.px(9, 6, AMBER);
    f.px(6, 7, AMBER_LO); f.px(7, 4, AMBER_LO); f.px(9, 7, AMBER_LO);
    f.px(10, 6, AMBER_LO); f.px(8, 4, AMBER_LO);
  }
  return f;
}

/**
 * PEOPLE — a bust in silo denim, breathing.
 *
 * The head is skin and the shoulders are denim because that is exactly what a
 * citizen twelve pixels tall on floor 3 is made of, and the icon should be
 * recognisably one of them rather than a generic person symbol.
 */
function navPeople(f, k) {
  const rise = k === 0 ? 0 : 1;         // frames 1 and 2 are the top of a breath
  const drop = k === 2 ? 1 : 0;         // and 2 lets the shoulders go first
  f.rect(5, 2 - rise, 4, 4, SKIN);      // head
  f.clr(5, 2 - rise); f.clr(8, 2 - rise);   // rounded at the crown
  f.hline(5, 2 - rise, 4, tone('skin', 0.14));
  f.hline(5, 5 - rise, 4, SKIN_LO);
  f.rect(6, 6 - rise, 2, 1, SKIN_LO);   // neck
  const top = 7 - rise + drop;
  for (let j = 0; j + top < 13; j++) {  // shoulders, tapering outward
    const w = Math.min(10, 4 + j * 3);
    const x = 7 - Math.floor(w / 2);
    f.hline(x, top + j, w, DENIM);
    f.px(x, top + j, DENIM_HI);
    f.px(x + w - 1, top + j, DENIM_LO);
  }
  f.keyline();
  f.hline(4, top + 1, 6, DENIM_HI);     // a collar
  f.px(6, 3 - rise, tone('skin', 0.2));
  f.px(8, 4 - rise, SKIN_LO);
  f.px(7, top + 2, DENIM_LO);
  return f;
}

/**
 * RESEARCH — a retort with a bubble climbing through the medium.
 *
 * Verdigris is the game's colour for anything that glows, and a flask is the
 * one shape a player will read as "science" without a caption. The bubble
 * starts at the bottom of the liquid and pops at the surface.
 */
function navResearch(f, k) {
  f.rect(5, 1, 4, 1, PRE_HI);           // the rim
  f.rect(6, 2, 2, 3, PRE);              // the neck
  for (let j = 0; j < 7; j++) {         // the bulb
    const w = Math.min(10, 4 + j * 2);
    const x = 7 - Math.floor(w / 2);
    f.hline(x, 5 + j, w, PRE);
  }
  f.keyline();
  f.rect(3, 8, 8, 4, GLASS_LO);         // the medium
  f.hline(3, 8, 8, GLASS);
  f.vline(3, 8, 4, GLASS_MID);
  f.px(4, 9, GLASS_HI);
  f.vline(6, 2, 3, PRE_HI);             // the lit side of the neck
  f.px(8, 4, PRE_LO);
  f.hline(4, 6, 5, PRE_HI);
  const bubble = [[6, 11], [6, 10], [8, 9]][k];
  f.rect(bubble[0], bubble[1], 2, 1, GLASS_HI);
  f.px(bubble[0], bubble[1] - 1, GLASS);
  if (k === 2) { f.px(5, 8, GLASS_HI); f.px(10, 8, GLASS_HI); }
  return f;
}

/**
 * SQUADS — a shield with a boss that lights.
 *
 * It has to separate from PEOPLE, which is the other icon here built round a
 * body, and it does it by having no neck: a shield is one uninterrupted taper
 * from shoulder width to a point, where the bust has a narrow head over wide
 * shoulders. The amber chevron is the same device the Breacher Plate carries
 * in gear.mjs, so the game's armour and the game's squads are marked alike.
 */
function navSquads(f, k) {
  const spans = [
    [3, 10], [2, 11], [2, 11], [2, 11], [2, 11], [2, 11],
    [3, 10], [3, 10], [4, 9], [5, 8], [6, 7],
  ];
  spans.forEach(([a, b], j) => {
    f.hline(a, 1 + j, b - a + 1, MET);
    f.px(a, 1 + j, MET_HI);
    f.px(b, 1 + j, MET_LO);
  });
  f.hline(3, 1, 8, MET_HI);
  f.keyline();
  for (let i = 0; i < 3; i++) {         // the chevron
    f.px(4 + i, 5 + i, AMBER); f.px(9 - i, 5 + i, AMBER);
    f.px(4 + i, 6 + i, AMBER_LO); f.px(9 - i, 6 + i, AMBER_LO);
  }
  f.px(6, 9, AMBER_LO); f.px(7, 9, AMBER_LO);
  const boss = [AMBER_DK, AMBER_LO, AMBER_HI][k];
  f.rect(6, 3, 2, 2, boss);             // the boss, running its lamp up
  f.px(6, 3, shade(boss, 0.3));
  f.px(5, 4, MET_LO); f.px(8, 3, MET_LO);
  return f;
}

/**
 * SURFACE — the airlock hatch, with somebody working the handle.
 *
 * The only disc in the nine. The handle is a straight bar rather than a wheel
 * cross because a cross has four-fold symmetry and a three-frame rotation of
 * one lands back where it started: frames would repeat, and a repeated frame
 * in an animation is the exact failure this project has shipped before. A bar
 * has two-fold symmetry, so 0, 45 and 90 degrees are three distinct images.
 */
function navSurface(f, k) {
  f.disc(6, 6, 5, 5, MET);
  f.keyline();
  f.disc(6, 6, 3, 3, MET_LO);           // the recessed face, one ring in
  f.hline(3, 2, 6, MET_HI);             // the lit upper rim
  f.px(2, 4, MET_HI); f.px(10, 8, MET_DK);
  for (const [x, y] of [[6, 1], [1, 6], [11, 6], [6, 11]]) {   // the dogs
    f.px(x, y, RIVET);
  }
  const bar = [
    [[3, 6], [4, 6], [5, 6], [7, 6], [8, 6], [9, 6]],                 // 0 degrees
    [[3, 9], [4, 8], [5, 7], [7, 5], [8, 4], [9, 3]],                 // 45
    [[6, 3], [6, 4], [6, 5], [6, 7], [6, 8], [6, 9]],                 // 90
  ][k];
  for (const [x, y] of bar) f.px(x, y, MET_HI);
  f.rect(5, 5, 2, 2, RIVET);            // the boss the handle turns on
  f.px(6, 6, INK);
  return f;
}

/**
 * WORLD — a relay mast throwing signal out.
 *
 * The one icon whose silhouette is allowed to change frame to frame, because
 * the change IS the subject: no arcs, one pair, two, and round again. Nothing
 * else in the navbar grows.
 *
 * The three crossarms are what stop the rest frame being a bare stick. A mast
 * with nothing on it was 33% covered and read as a scratch down the middle of
 * the button, which is the state the icon spends a third of its life in.
 */
function navWorld(f, k) {
  slab(f, 6, 2, 2, 10, MET);            // the mast
  f.hline(3, 4, 8, MET);                // three crossarms, widening downward
  f.hline(2, 7, 10, MET);
  f.hline(4, 10, 6, MET);
  f.hline(4, 12, 6, MET_LO);            // the footing
  f.keyline();
  f.hline(3, 4, 8, MET_HI); f.hline(2, 7, 10, MET_HI);
  f.px(6, 3, MET_HI); f.px(7, 6, MET_LO); f.px(6, 9, MET_HI);
  f.px(6, 1, AMBER_HI); f.px(7, 1, AMBER_LO);    // the beacon on top
  const arcs = [
    [[[4, 1], [4, 2], [3, 2]], [[9, 1], [9, 2], [10, 2]]],
    [[[1, 0], [1, 1], [1, 2], [1, 3]], [[12, 0], [12, 1], [12, 2], [12, 3]]],
  ];
  if (k >= 1) for (const side of arcs[0]) for (const [x, y] of side) f.px(x, y, AMBER);
  if (k >= 2) for (const side of arcs[1]) for (const [x, y] of side) f.px(x, y, AMBER_LO);
  return f;
}

/**
 * ORDER — a balance, rocking.
 *
 * Order is the panel where the silo's law lives: doctrine, policy, and the
 * people caught breaking it. A balance is the one object that says all three
 * without a word, and its idle is the best motion in the set because it is
 * genuinely what the object does — level, tip, tip back.
 */
function navOrder(f, k) {
  const tilt = [0, -1, 1][k];           // which way the beam is leaning
  const bl = 3 + tilt, br = 3 - tilt;   // the two ends of the beam
  const pl = 6 + tilt * 2, pr = 6 - tilt * 2;   // and the pans under them
  slab(f, 6, 3, 2, 9, MET);             // the post
  slab(f, 4, 11, 6, 2, MET);            // the plinth
  f.hline(1, bl, 6, MET); f.hline(1, bl + 1, 6, MET_LO);       // the beam
  f.hline(7, br, 6, MET); f.hline(7, br + 1, 6, MET_LO);
  f.hline(1, bl, 6, MET_HI); f.hline(7, br, 6, MET_HI);
  for (let y = bl + 2; y < pl; y++) f.px(2, y, MET_LO);        // the hangers
  for (let y = br + 2; y < pr; y++) f.px(11, y, MET_LO);
  f.hline(1, pl, 3, PRE); f.hline(1, pl + 1, 3, PRE_LO);       // the pans
  f.hline(10, pr, 3, PRE); f.hline(10, pr + 1, 3, PRE_LO);
  f.keyline();
  f.px(1, pl, PRE_HI); f.px(10, pr, PRE_HI);
  f.px(2, pl, PRE_HI); f.px(11, pr, PRE_HI);
  f.px(6, 2, RIVET);                    // the pivot
  f.px(6, 6, MET_HI); f.px(7, 9, MET_LO);
  f.px(5, 12, MET_LO); f.px(9, 12, MET_LO);
  return f;
}

/**
 * STORES — three crates and a level gauge that counts up.
 *
 * The gauge is the animation and it is not arbitrary: Stores is the panel that
 * answers "how much is there", and three amber pips filling one, two, three is
 * a stockpile being counted. It also keeps the icon's outline dead still,
 * which matters because this one sits next to LOG and both are boxes.
 */
function navStores(f, k) {
  slab(f, 1, 7, 6, 5, WOOD);            // two crates on the deck
  slab(f, 7, 7, 5, 5, WOOD);
  slab(f, 3, 2, 7, 5, WOOD);            // and one stacked on them
  f.keyline();
  f.hline(2, 8, 4, WOOD_HI); f.hline(8, 8, 3, WOOD_HI);
  f.hline(2, 11, 4, WOOD_LO); f.hline(8, 11, 3, WOOD_LO);
  f.vline(3, 8, 3, MET_LO); f.vline(9, 8, 3, MET_LO);    // strapping
  f.hline(4, 3, 5, WOOD_HI);
  f.hline(4, 6, 5, WOOD_LO);
  f.px(3, 2, MET); f.px(9, 2, MET); f.px(3, 6, MET); f.px(9, 6, MET);
  for (let i = 0; i < 3; i++) {         // the count
    const on = i <= k;
    f.rect(4 + i * 2, 3, 1, 3, on ? AMBER : AMBER_DK);
    f.px(4 + i * 2, 3, on ? AMBER_HI : AMBER_DK);
  }
  return f;
}

/**
 * LOG — a terminal with a cursor.
 *
 * The narrowest brief in the set: it must not read as STORES. It gets there by
 * being a screen on a stalk — a wide lit rectangle with a two-pixel foot —
 * where the crates are a stack of solids filling the frame corner to corner.
 * The lit verdigris face does the rest.
 */
function navLog(f, k) {
  slab(f, 1, 1, 12, 8, MET);            // the case
  slab(f, 6, 9, 2, 2, MET_LO);          // the stalk
  slab(f, 4, 11, 6, 1, MET_LO);         // and the foot
  f.keyline();
  f.rect(2, 2, 10, 6, GLASS_LO);        // the screen
  f.hline(2, 2, 10, GLASS_MID);
  for (let y = 3; y < 8; y += 2) f.hline(2, y, 10, tone('verdigris', -0.44));
  f.hline(3, 3, 7, GLASS);              // lines of log
  f.hline(3, 5, 5, GLASS);
  if (k >= 1) f.hline(3, 6, 6, GLASS_MID);
  if (k === 2) f.hline(9, 5, 2, GLASS_MID);
  if (k !== 1) { f.rect(3, 6, 2, 1, AMBER); f.px(3, 6, AMBER_HI); }   // the cursor
  f.px(2, 8, MET_HI); f.px(11, 8, MET_LO);
  f.px(6, 10, MET_LO);
  return f;
}

/**
 * The navbar, in the order src/main.js registers the panels. The key is the
 * panel id, which is what the shell writes into `data-panel` and what the CSS
 * selects on, and the self-test reads main.js and every panel module to prove
 * this table has not fallen behind the game.
 */
export const NAV_ICONS = {
  build: navBuild,
  population: navPeople,
  research: navResearch,
  military: navSquads,
  airlock: navSurface,
  radio: navWorld,
  policy: navOrder,
  resources: navStores,
  log: navLog,
};

/* ======================================================= resource glyphs == */
/*
 * Thirteen counters, 10x10, two frames each.
 *
 * Two frames, not three: the strip carries eleven of these at once directly
 * above the cross-section, and a three-phase animation on eleven small objects
 * in a 46px bar is a shimmer rather than a heartbeat. One alternate frame per
 * glyph gives a slow tick — a bolt flickering, a cog stepping a tooth, a level
 * settling — that is visible when you look at a counter and invisible when you
 * are not looking at it.
 *
 * They also have to be told apart from EACH OTHER at 20 CSS px while sitting in
 * a row, which is a harder problem than the nav's nine, so the families are
 * kept deliberately far apart in outline: uprights (meds, ammo, filters),
 * discs and blobs (parts, ore, water), flats (alloy, chits, fuel), and combs
 * (coolant, scrap, food, power).
 */

/** A run of rows given as [x0, x1] spans, lit on the left, shaded on the right. */
function spans(f, top, list, c, lit = 0.24, dk = -0.26) {
  list.forEach(([a, b], j) => {
    f.hline(a, top + j, b - a + 1, c);
    f.px(a, top + j, shade(c, lit));
    f.px(b, top + j, shade(c, dk));
  });
  return f;
}

/**
 * POWER — a bolt. It flickers rather than moves: the whole glyph steps up a
 * shade and gains a corona, which at a glance reads as current arriving.
 */
function resPower(f, k) {
  spans(f, 1, [[6, 7], [5, 7], [4, 6], [3, 8], [5, 7], [4, 6], [3, 5], [4, 4]],
    k ? AMBER_HI : AMBER, 0.3, -0.34);
  f.keyline();
  f.px(6, 1, PRE_HI);
  f.px(4, 4, k ? PRE_HI : AMBER_HI);
  f.px(7, 4, AMBER_LO); f.px(5, 6, AMBER_LO); f.px(4, 7, AMBER_LO);
  if (k) { f.px(9, 3, AMBER_LO); f.px(2, 7, AMBER_LO); }
  return f;
}

/** FOOD — a sprout in a tray. The leaves lift on the second frame. */
function resFood(f, k) {
  f.rect(2, 8, 8, 3, WOOD);             // the tray
  f.hline(2, 8, 8, WOOD_HI);
  f.hline(2, 10, 8, WOOD_LO);
  f.vline(5, 4, 5, GLASS_MID);          // the stem
  const y = k ? 3 : 4;
  f.hline(1, y + 1, 4, GLASS);          // the low leaf, to the left
  f.px(2, y, GLASS_HI); f.px(3, y, GLASS);
  f.hline(6, y, 4, GLASS);              // and the high one, to the right
  f.px(8, y - 1, GLASS_HI); f.px(7, y - 1, GLASS);
  f.keyline();
  f.px(5, 7, tone('verdigris', -0.48));
  f.px(3, 9, WOOD_LO); f.px(8, 9, WOOD_HI);
  return f;
}

/** WATER — a drop, with the highlight sliding round it. */
function resWater(f, k) {
  spans(f, 1, [[5, 5], [5, 6], [4, 6], [3, 7], [3, 8], [3, 8], [4, 7], [5, 6]],
    GLASS_MID, 0.3, -0.3);
  f.keyline();
  f.hline(4, 5, 4, GLASS);
  f.rect(k ? 4 : 5, k ? 5 : 3, 2, 1, GLASS_HI);
  f.px(7, 6, GLASS_LO); f.px(6, 7, GLASS_LO);
  f.px(5, 6, GLASS);
  return f;
}

/**
 * SCRAP — a torn plate with a bolt hole through it.
 *
 * The most angular glyph in the thirteen, and asymmetric on purpose: ORE is
 * the other salvage-coloured lump and the two must not swap. This one is flat,
 * bitten and man-made; the ore is round and broken.
 */
function resScrap(f, k) {
  spans(f, 3, [[3, 8], [1, 10], [1, 9], [2, 8], [4, 7]], RUSTY, 0.3, -0.34);
  f.clr(10, 4); f.px(10, 3, RUSTY);     // a corner turned up
  f.clr(1, 6); f.px(1, 7, RUSTY);       // and one torn away
  f.keyline();
  f.hline(4, 3, 4, RUST_HI);
  f.hline(3, 7, 5, RUST_LO);
  f.rect(5, 5, 2, 2, INK);              // the bolt hole
  f.px(5, 5, MET_LO);
  f.rect(k ? 2 : 7, k ? 4 : 6, 2, 1, PRE_LO);   // a cut edge catching the light
  f.px(2, 5, RUST_LO); f.px(8, 5, RUST_HI);
  return f;
}

/**
 * PARTS — a cog, stepping half a tooth between frames.
 *
 * IT WAS A PLUS SIGN. The first draft was a small disc with four 2x2 teeth on
 * the compass points, and at that scale the teeth were most of the shape: the
 * self-test put it FIVE cells of eighty-one from the medical cross, which is
 * two icons in the same row of counters that a player would have had to read
 * the label to tell apart.
 *
 * What fixed it is scale. A disc wide enough to have a rim, with one-pixel
 * teeth around it and a dark bore in the middle, reads as a WHEEL: the teeth
 * stop being most of the shape and start being a detail on it. Separation from
 * the cross went from 5 to 11, and the icon got easier to recognise rather
 * than merely more different.
 */
function resParts(f, k) {
  f.disc(5, 5, 4, 4, MET);
  const teeth = k
    ? [[3, 1], [8, 3], [7, 9], [2, 8], [1, 3], [9, 7], [6, 0], [4, 10]]
    : [[5, 0], [10, 5], [5, 10], [0, 5], [2, 2], [8, 2], [8, 8], [2, 8]];
  for (const [x, y] of teeth) f.px(x, y, MET);
  f.keyline();
  f.disc(5, 5, 3, 3, MET_HI);
  f.disc(5, 5, 2, 2, MET);
  f.rect(4, 4, 3, 3, INK);              // the bore, right through
  f.px(3, 3, tone('steelLit', 0.32));
  f.px(8, 8, MET_DK);
  return f;
}

/**
 * ALLOY — a poured ingot, with a sheen crossing the top face.
 *
 * Two faces, not one: a narrow lit deck sitting on a wider dark body is the
 * whole reason it reads as a solid bar rather than as a grey mound, and it is
 * also what separates it from the fuel drum, which is a plain rectangle.
 */
function resAlloy(f, k) {
  f.rect(1, 7, 10, 3, MET);             // the bar on the bottom
  f.rect(2, 3, 7, 3, MET);              // and the one stacked on it, set back
  f.keyline();
  f.hline(1, 7, 10, tone('steelLit', 0.18));
  f.hline(1, 9, 10, MET_LO);
  f.hline(2, 3, 7, tone('steelLit', 0.18));
  f.hline(2, 5, 7, MET_LO);
  f.px(1, 8, tone('steelLit', 0.36)); f.px(10, 8, MET_DK);
  f.px(2, 4, tone('steelLit', 0.36)); f.px(8, 4, MET_DK);
  f.rect(k ? 6 : 3, 3, 2, 1, PRE_HI);   // the sheen, crossing the top bar
  f.rect(k ? 3 : 6, 3, 2, 1, MET_LO);
  return f;
}

/**
 * MEDS — a cross. The only glyph here that is a symbol rather than an object,
 * and it stays because at twelve pixels a syringe is a scratch and a pill is a
 * dot, while a cross is unmistakable at any size anybody will ever see it.
 */
function resMeds(f, k) {
  f.rect(4, 1, 4, 9, PRE);
  f.rect(1, 4, 10, 3, PRE);
  f.keyline();
  f.hline(4, 1, 4, PRE_HI); f.hline(1, 4, 10, PRE_HI);
  f.hline(1, 6, 10, PRE_LO); f.hline(4, 9, 4, PRE_LO);
  f.vline(4, 1, 9, PRE_HI); f.vline(7, 1, 9, PRE_LO);
  f.rect(4, 4, 4, 3, k ? RUST_HI : RUSTY);   // the mark on it, catching light
  f.hline(4, 4, 4, k ? PRE_HI : RUST_HI);
  return f;
}

/** AMMO — a cased round standing on its rim. */
function resAmmo(f, k) {
  f.rect(5, 1, 2, 1, AMBER_LO);         // the bullet
  f.rect(4, 2, 4, 2, AMBER_LO);
  f.rect(4, 4, 4, 6, AMBER);            // the case
  f.rect(3, 9, 6, 1, AMBER);            // and its rim
  f.keyline();
  f.vline(4, 4, 6, AMBER_HI);
  f.vline(7, 4, 6, AMBER_LO);
  f.hline(3, 9, 6, AMBER_LO);
  f.hline(4, 8, 4, AMBER_DK);           // the extractor groove
  f.px(5, 2, PRE_HI);
  f.rect(5, k ? 7 : 5, 2, 1, PRE_HI);   // a glint travelling down the brass
  return f;
}

/**
 * CHITS — a stack of three stamped tokens, each one lying slightly off the
 * one below. The offsets are the point: a single coin is a disc and this set
 * already has two round things in it, where a leaning stack is a stack and
 * nothing else.
 */
function resChits(f, k) {
  const coin = (x, y, top) => {
    f.rect(x, y, 8, 2, AMBER);
    f.hline(x, y, 8, top ? AMBER_HI : AMBER);
    f.hline(x, y + 1, 8, AMBER_LO);
    f.clr(x, y + 1); f.clr(x + 7, y + 1);      // rims, rounded off
  };
  coin(1, 8); coin(2, 6); coin(1, 4); coin(2, 2, true);
  f.keyline();
  f.hline(3, 3, 6, AMBER_DK);           // the shadow each coin throws on the next
  f.hline(2, 5, 6, AMBER_DK);
  f.hline(3, 7, 6, AMBER_DK);
  f.rect(k ? 6 : 3, 2, 2, 1, PRE_HI);   // the stamp on top, turning in the light
  f.rect(k ? 3 : 6, 2, 2, 1, AMBER_LO);
  return f;
}

/**
 * FILTERS — a scrubber canister, its media scrolling a row between frames.
 *
 * Fat and domed rather than tall and square, so it cannot be confused with the
 * ammunition case: the round shoulder is visible at 24 CSS px and a straight
 * one is not.
 */
function resFilters(f, k) {
  f.rect(5, 0, 3, 2, MET_LO);           // the spigot
  spans(f, 2, [[3, 8], [2, 9], [2, 9], [2, 9], [2, 9], [2, 9], [2, 9], [3, 8]],
    PRE_LO, 0.26, -0.3);
  f.keyline();
  f.hline(3, 2, 6, PRE_HI);
  for (let y = 4 + (k ? 1 : 0); y < 9; y += 2) f.hline(3, y, 6, GLASS_MID);
  f.vline(2, 3, 6, PRE);
  f.px(5, 0, MET);
  return f;
}

/**
 * FUEL — a drum lying on its side, hooped, with a bung on the top.
 *
 * Lying down rather than standing, purely so it does not share an outline with
 * FILTERS, which is the other cylinder in the set.
 */
function resFuel(f, k) {
  f.rect(1, 5, 10, 5, RUSTY);
  f.keyline();
  f.hline(1, 5, 10, RUST_HI);
  f.hline(1, 9, 10, RUST_LO);
  f.vline(3, 5, 5, RUST_LO); f.vline(8, 5, 5, RUST_LO);   // the rolling hoops
  f.vline(2, 5, 5, RUST_HI); f.vline(7, 5, 5, RUST_HI);
  f.rect(5, 4, 2, 1, MET_LO);                             // the bung
  f.px(5, 5, MET);
  f.rect(k ? 9 : 4, 7, 2, 1, AMBER_LO);                   // a stencil, weathering
  f.rect(k ? 4 : 9, 7, 2, 1, RUST_LO);
  return f;
}

/**
 * COOLANT — a serpentine run of pipe with a pulse travelling down it.
 *
 * A comb, which nothing else here is, and the clearest two-frame animation in
 * the set: the bright cell jumps a limb, so a counter that is flowing looks
 * like it is flowing.
 */
function resCoolant(f, k) {
  for (const y of [1, 5, 9]) f.hline(1, y, 10, MET);
  f.vline(10, 1, 5, MET);
  f.vline(1, 5, 5, MET);
  f.keyline();
  for (const y of [1, 5, 9]) f.hline(1, y, 10, MET_HI);
  f.vline(10, 2, 3, MET_LO); f.vline(1, 6, 3, MET_LO);
  f.px(10, 1, tone('steelLit', 0.3));
  const lit = k ? [[3, 1], [10, 3], [6, 5], [1, 7], [4, 9]] : [[7, 1], [10, 4], [3, 5], [1, 8], [8, 9]];
  for (const [x, y] of lit) f.px(x, y, GLASS_HI);
  return f;
}

/** ORE — a broken lump with a seam in it, one facet catching the lamp. */
function resOre(f, k) {
  const ROCK = tone('concrete', 0.20);
  spans(f, 2, [[5, 7], [3, 9], [2, 10], [1, 10], [1, 9], [2, 8], [4, 7]], ROCK, 0.26, -0.3);
  f.clr(10, 4); f.px(9, 3, shade(ROCK, 0.26));   // knocked off the shoulder
  f.keyline();
  f.hline(5, 2, 3, shade(ROCK, 0.26));
  f.hline(2, 7, 7, shade(ROCK, -0.3));
  f.px(3, 5, shade(ROCK, 0.26)); f.px(8, 6, shade(ROCK, -0.3));
  f.rect(6, 5, 2, 1, k ? AMBER_HI : AMBER_LO);   // the seam
  f.rect(4, 6, 2, 1, k ? AMBER_LO : AMBER_HI);
  f.px(4, 4, tone('concrete', 0.44)); f.px(7, 4, CONC_LO);
  return f;
}

/**
 * The thirteen, keyed by the resource key the shell writes into `data-res`.
 * The self-test requires one for every key in src/sim/economy.js:RES_KEYS and
 * for every counter in the shell's own strip.
 */
export const RES_ICONS = {
  power: resPower,
  food: resFood,
  water: resWater,
  scrap: resScrap,
  parts: resParts,
  alloy: resAlloy,
  meds: resMeds,
  ammo: resAmmo,
  chits: resChits,
  filters: resFilters,
  fuel: resFuel,
  coolant: resCoolant,
  ore: resOre,
};

/* ================================================================ build == */

/**
 * Every frame this module produces, as `name -> {w, h, draw(painter)}`.
 * gen-atlas.mjs iterates this and needs to know nothing else.
 */
export const UI_SPRITES = (() => {
  const out = {};
  for (const [id, spec] of Object.entries(UI_FRAMES)) {
    out[`ui_${id}`] = {
      w: spec.size, h: spec.size,
      draw: (p) => { const f = form(spec.size, spec.size); spec.draw(f); f.blit(p); },
    };
  }
  for (const [id, draw] of Object.entries(NAV_ICONS)) {
    for (let k = 0; k < NAV_FRAMES; k++) {
      out[`ui_nav_${id}${k}`] = {
        w: NAV_SIZE, h: NAV_SIZE,
        draw: (p) => { const f = form(NAV_SIZE, NAV_SIZE); draw(f, k); f.blit(p); },
      };
    }
  }
  for (const [id, draw] of Object.entries(RES_ICONS)) {
    for (let k = 0; k < RES_FRAMES; k++) {
      out[`ui_res_${id}${k}`] = {
        w: RES_SIZE, h: RES_SIZE,
        draw: (p) => { const f = form(RES_SIZE, RES_SIZE); draw(f, k); f.blit(p); },
      };
    }
  }
  return out;
})();

/** Draw one sprite into a flat RGBA buffer. Used by both emitters. */
function render(w, h, drawForm) {
  const px = new Uint8Array(w * h * 4);
  const f = form(w, h);
  drawForm(f);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = f.at(x, y);
      if (!c) continue;
      const i = (y * w + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  return px;
}

/* -------------------------------------------------------- PNG, in a URI -- */

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crc32.table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/**
 * A minimal RGBA PNG. deflate is called at level 9 with no dictionary and no
 * timestamp, so the same pixels always produce the same bytes — which is what
 * lets the stylesheet be regenerated and diffed rather than trusted.
 */
export function encodePng(w, h, rgba) {
  const { deflateSync } = require_zlib();
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

let _zlib = null;
function require_zlib() {
  if (!_zlib) throw new Error('ui.mjs: call await initCodec() before encoding');
  return _zlib;
}
/** node:zlib is only needed by the emitters, and only Node has it. */
export async function initCodec() {
  if (!_zlib) _zlib = await import('node:zlib');
  return _zlib;
}

const dataUri = (png) => `data:image/png;base64,${png.toString('base64')}`;

/**
 * A vertical strip of animation frames laid out COLUMNS x ROWS: one row per
 * icon, one column per frame. The DOM then picks the row with
 * background-position-y and steps through the columns with one keyframe rule
 * shared by every icon.
 */
function sheetPng(ids, draws, size, frames) {
  const W = size * frames, H = size * ids.length;
  const buf = new Uint8Array(W * H * 4);
  ids.forEach((id, row) => {
    for (let k = 0; k < frames; k++) {
      const px = render(size, size, (f) => draws[id](f, k));
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const s = (y * size + x) * 4;
          if (!px[s + 3]) continue;
          const d = ((row * size + y) * W + k * size + x) * 4;
          buf[d] = px[s]; buf[d + 1] = px[s + 1]; buf[d + 2] = px[s + 2]; buf[d + 3] = 255;
        }
      }
    }
  });
  return encodePng(W, H, buf);
}

/* ------------------------------------------------------- the CSS block -- */

export const CSS_BEGIN = '/* ---- UISPRITES:BEGIN (generated by tools/art/ui.mjs — do not edit by hand) ---- */';
export const CSS_END = '/* ---- UISPRITES:END ---- */';

/**
 * Everything the stylesheet cannot know without running the art: the four
 * border-image tiles, the two animation sheets, and the row each icon occupies
 * in its sheet. The rules that USE them are hand-written in styles.css, so the
 * generated part stays small, readable in a diff, and free of design decisions.
 *
 * The per-icon `animation-delay` is a decision, though, and it belongs here
 * because it is derived from the sheet: nine icons started in lockstep read as
 * one blinking object with nine parts. The offsets are a fixed fraction of the
 * cycle spread by index — deterministic, and no two adjacent icons in phase.
 */
export function cssBlock() {
  const navIds = Object.keys(NAV_ICONS);
  const resIds = Object.keys(RES_ICONS);
  const navPng = sheetPng(navIds, NAV_ICONS, NAV_SIZE, NAV_FRAMES);
  const resPng = sheetPng(resIds, RES_ICONS, RES_SIZE, RES_FRAMES);

  const tile = (id) => {
    const spec = UI_FRAMES[id];
    return dataUri(encodePng(spec.size, spec.size, render(spec.size, spec.size, spec.draw)));
  };

  const lines = [CSS_BEGIN, ':root {'];
  lines.push(`  --ui-slice-panel: ${PANEL_SLICE};`);
  lines.push(`  --ui-border-panel: ${PANEL_SLICE * UI_ZOOM}px;`);
  lines.push(`  --ui-slice-btn: ${BTN_SLICE};`);
  lines.push(`  --ui-border-btn: ${BTN_SLICE * UI_ZOOM}px;`);
  lines.push(`  --ui-nav-size: ${NAV_SIZE * UI_ZOOM}px;`);
  lines.push(`  --ui-nav-sheet-w: ${NAV_SIZE * NAV_FRAMES * UI_ZOOM}px;`);
  lines.push(`  --ui-nav-sheet-h: ${NAV_SIZE * Object.keys(NAV_ICONS).length * UI_ZOOM}px;`);
  lines.push(`  --ui-res-size: ${RES_SIZE * UI_ZOOM}px;`);
  lines.push(`  --ui-res-sheet-w: ${RES_SIZE * RES_FRAMES * UI_ZOOM}px;`);
  lines.push(`  --ui-res-sheet-h: ${RES_SIZE * Object.keys(RES_ICONS).length * UI_ZOOM}px;`);
  for (const id of Object.keys(UI_FRAMES)) {
    lines.push(`  --ui-${id.replace(/_/g, '-')}: url("${tile(id)}");`);
  }
  lines.push(`  --ui-nav-sheet: url("${dataUri(navPng)}");`);
  lines.push(`  --ui-res-sheet: url("${dataUri(resPng)}");`);
  lines.push('}');
  navIds.forEach((id, i) => {
    lines.push(
      `.nav-btn[data-panel="${id}"] .nav-glyph { ` +
      `background-position-y: ${-i * NAV_SIZE * UI_ZOOM}px; ` +
      `animation-delay: ${((i * 7) % navIds.length) * 0.11}s; }`
    );
  });
  resIds.forEach((id, i) => {
    lines.push(
      `.res[data-res="${id}"]::before { ` +
      `background-position-y: ${-i * RES_SIZE * UI_ZOOM}px; ` +
      `animation-delay: ${((i * 5) % resIds.length) * 0.17}s; }`
    );
  });
  lines.push(CSS_END);
  return lines.join('\n') + '\n';
}

/**
 * Splice the generated block into a stylesheet's text. Same contract as
 * gen-precache.mjs: markers must already be there, and everything between them
 * is replaced.
 */
export function spliceCss(css, block) {
  const a = css.indexOf(CSS_BEGIN);
  const b = css.indexOf(CSS_END);
  if (a < 0 || b < 0) throw new Error('styles.css has no UISPRITES:BEGIN/END markers');
  return css.slice(0, a) + block.trimEnd() + css.slice(b + CSS_END.length);
}

export default { UI_SPRITES, UI_FRAMES, NAV_ICONS, RES_ICONS, cssBlock, spliceCss };

/* ============================================================= self-test == */
/*
 * `node tools/art/ui.mjs`. Same standard as gear.mjs: coverage derived from
 * what the interface actually asks for, palette law per pixel, separation
 * measured rather than asserted, and every gate fault-injected below to prove
 * it fires.
 *
 * The one this file exists to catch is the LAST one. An animation whose frames
 * are identical is invisible and silent; this project has already shipped a
 * death animation whose third frame was pixel-for-pixel a sleep frame, and a
 * "distinct colours" test that passed while two roles looked the same. So
 * every frame of every loop is compared with every other frame of the same
 * loop, and a duplicate is a failure, not a warning.
 *
 * EVERY GATE BELOW HAS BEEN BROKEN ON PURPOSE AND SEEN TO FIRE. Nineteen
 * injections, each checked for the RIGHT message rather than merely a non-zero
 * exit: a panel registered with no icon; an icon for a panel that does not
 * exist; a resource with no glyph; a glyph for a resource the economy does not
 * have; a frame the shipped atlas does not carry; a packed frame at the wrong
 * size; a stylesheet left behind the art; a sheet over the size budget; an
 * icon that draws nothing; a partially transparent pixel; an off-palette
 * colour; an icon too sparse to read; an icon with no air round it; paint in a
 * 9-slice middle; a 9-slice corner with a hole in it; a loop with two
 * identical frames; a loop that moves by one pixel; two nav icons with the
 * same silhouette; two counters with the same silhouette.
 */

function readPixel(px, size, at, x, y) {
  const i = ((at.y + y) * size + (at.x + x)) * 4;
  return [px[i], px[i + 1], px[i + 2], px[i + 3]];
}

function frameStats(px, size, at) {
  let painted = 0, illegal = 0, partial = 0, firstBad = null;
  const tones = new Set();
  for (let y = 0; y < at.h; y++) {
    for (let x = 0; x < at.w; x++) {
      const c = readPixel(px, size, at, x, y);
      if (c[3] === 0) continue;
      if (c[3] !== 255) partial++;
      painted++;
      tones.add(c.slice(0, 3).join(','));
      if (!legalColour(c.slice(0, 3))) {
        illegal++;
        if (!firstBad) firstBad = { x, y, c };
      }
    }
  }
  return { painted, illegal, partial, firstBad, tones, total: at.w * at.h };
}

/**
 * A 1-bit silhouette, at the same sampling density scenery.mjs and gear.mjs
 * use — four thirds of a source pixel per cell — so the numbers here mean the
 * same thing as the numbers there. A 14px icon gives an 11x11 map (121 cells)
 * and a 10px glyph an 8x8 one (64).
 */
const SIL_PITCH = 16 / 12;
function silhouette(px, size, at) {
  const G = Math.round(at.w / SIL_PITCH), cell = at.w / G;
  const sig = [];
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      let n = 0, t = 0;
      for (let y = Math.floor(gy * cell); y < Math.floor((gy + 1) * cell); y++) {
        for (let x = Math.floor(gx * cell); x < Math.floor((gx + 1) * cell); x++) {
          t++;
          if (readPixel(px, size, at, x, y)[3] > 127) n++;
        }
      }
      sig.push(n / Math.max(1, t) >= 0.5 ? 1 : 0);
    }
  }
  return sig;
}

const hamming = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

/** How many pixels differ between two frames of the same loop, colour included. */
function pixelDiff(px, size, a, b) {
  let n = 0;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const p = readPixel(px, size, a, x, y), q = readPixel(px, size, b, x, y);
      if (p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2] || p[3] !== q[3]) n++;
    }
  }
  return n;
}

/**
 * The interface's own demands, read out of the source rather than counted.
 *
 * NAV: src/main.js names the panels it registers, in order, and each panel
 * module carries its own id. Add a tenth panel and this list grows by itself,
 * so the coverage check fails until the panel has an icon — which is the
 * whole point of deriving it.
 *
 * RES: the shell's STRIP is what the top bar renders; economy.js's RES_KEYS is
 * every resource the simulation has. Both are checked, and they are not the
 * same list — the strip carries eleven, the economy thirteen — so the two
 * counters that never reach the strip (ore, coolant) are drawn as well and
 * reported rather than gated.
 */
async function readInterface() {
  const { readFile } = await import('node:fs/promises');
  const here = new URL('.', import.meta.url);
  const read = (rel) => readFile(new URL(rel, here), 'utf8');

  const main = await read('../../src/main.js');
  const registered = [...main.matchAll(/\.register\((\w+)Panel\)/g)].map((m) => m[1]);
  const imports = Object.fromEntries(
    [...main.matchAll(/import\s*\{\s*(\w+)Panel\s*\}\s*from\s*'(.+?)'/g)].map((m) => [m[1], m[2]])
  );
  const nav = [];
  for (const name of registered) {
    const rel = imports[name];
    if (!rel) { nav.push({ name, id: null }); continue; }
    const src = await read('../../src/' + rel.replace(/^\.\//, ''));
    // Anchored at the export, not the first `id:` in the file: several panels
    // build local tables with an `id` field long before they declare their own,
    // and an unanchored match reported the Log panel's id as "all".
    const decl = src.match(new RegExp(`export const ${name}Panel = \\{[\\s\\S]{0,600}`))?.[0] ?? '';
    const id = decl.match(/\bid:\s*'([\w-]+)'/)?.[1] ?? null;
    const label = decl.match(/\bnav:\s*'([^']+)'/)?.[1] ?? decl.match(/\btitle:\s*'([^']+)'/)?.[1] ?? '';
    nav.push({ name, id, label });
  }

  const shell = await read('../../src/ui/shell.js');
  const stripBlock = shell.match(/const STRIP = \[([\s\S]*?)\n\];/)?.[1] ?? '';
  const strip = [...stripBlock.matchAll(/key:\s*'(\w+)'/g)].map((m) => m[1]);

  const economy = await import('../../src/sim/economy.js');
  return { nav, strip, resKeys: economy.RES_KEYS };
}

async function runSelfTest() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  }));
  await initCodec();

  const sheet = atlas(512);
  const built = [];
  for (const [name, spec] of Object.entries(UI_SPRITES)) {
    const p = sheet.sprite(name, spec.w, spec.h);
    spec.draw(p);
    built.push({ name, at: sheet.frames[name] });
  }
  const frameAt = Object.fromEntries(built.map((b) => [b.name, b.at]));
  const problems = [];

  // --- coverage, derived from the interface --------------------------------
  const ui = await readInterface();
  for (const panel of ui.nav) {
    if (!panel.id) { problems.push(`could not read an id out of the ${panel.name} panel`); continue; }
    if (!NAV_ICONS[panel.id]) {
      problems.push(`src/main.js registers "${panel.id}" (${panel.label}) and the navbar has no icon for it`);
    }
  }
  const navOrphans = Object.keys(NAV_ICONS).filter((id) => !ui.nav.some((p) => p.id === id));
  if (navOrphans.length) problems.push(`icons for panels main.js does not register: ${navOrphans.join(', ')}`);
  console.log(`  [coverage]     ${ui.nav.length} panels registered in src/main.js, all with an icon` +
    ` (${ui.nav.map((p) => p.id).join(', ')})`);

  for (const key of ui.strip) {
    if (!RES_ICONS[key]) problems.push(`shell.js's resource strip carries "${key}" and there is no glyph for it`);
  }
  for (const key of ui.resKeys) {
    if (!RES_ICONS[key]) problems.push(`economy.js has resource "${key}" and there is no glyph for it`);
  }
  const resOrphans = Object.keys(RES_ICONS).filter((k) => !ui.resKeys.includes(k));
  if (resOrphans.length) problems.push(`glyphs for resources the economy does not have: ${resOrphans.join(', ')}`);
  const offStrip = ui.resKeys.filter((k) => !ui.strip.includes(k));
  console.log(`  [coverage]     ${ui.resKeys.length} resources in economy.js, all with a glyph;` +
    ` ${ui.strip.length} of them reach the top strip` +
    (offStrip.length ? ` (${offStrip.join(', ')} only appear in Stores)` : ''));

  // --- the shipped atlas ---------------------------------------------------
  // Absent, this is a tree that has not been built. Present and short of a
  // frame, the game is shipping a stylesheet whose art the atlas disagrees
  // with, which is the drift this whole arrangement exists to prevent.
  try {
    const { readFile } = await import('node:fs/promises');
    const table = JSON.parse(await readFile(new URL('../../assets/atlas.json', import.meta.url), 'utf8'));
    const missing = Object.keys(UI_SPRITES).filter((n) => !table.frames[n]);
    if (missing.length) {
      problems.push(`assets/atlas.json has no frame for ${missing.slice(0, 4).join(', ')}` +
        `${missing.length > 4 ? ` (+${missing.length - 4})` : ''} — run node tools/gen-atlas.mjs`);
    } else {
      const wrong = Object.entries(UI_SPRITES)
        .filter(([n, s]) => table.frames[n].w !== s.w || table.frames[n].h !== s.h)
        .map(([n]) => n);
      if (wrong.length) problems.push(`${wrong.length} packed ui frame(s) are the wrong size: ${wrong.slice(0, 3).join(', ')}`);
      console.log(`  [atlas]        assets/atlas.json carries all ${Object.keys(UI_SPRITES).length} ui_ frames`);
    }
  } catch {
    console.log('  [atlas]        assets/atlas.json not built yet — skipped');
  }

  // --- the stylesheet ------------------------------------------------------
  // The DOM paints the CSS copy, not the atlas copy. Both come from the draw
  // functions above, so the only way they can disagree is a stale file — which
  // is exactly what is checked, by regenerating the block and comparing bytes.
  const block = cssBlock();
  const bytes = Buffer.byteLength(block, 'utf8');
  {
    const { readFile, writeFile } = await import('node:fs/promises');
    const path = new URL('../../src/ui/styles.css', import.meta.url);
    try {
      const css = await readFile(path, 'utf8');
      const a = css.indexOf(CSS_BEGIN), b = css.indexOf(CSS_END);
      if (a < 0 || b < 0) {
        problems.push('src/ui/styles.css has no UISPRITES:BEGIN/END markers to put the sprites in');
      } else {
        const have = css.slice(a, b + CSS_END.length);
        if (have !== block.trimEnd()) {
          if (args['write-css']) {
            await writeFile(path, spliceCss(css, block));
            console.log('  [stylesheet]   src/ui/styles.css rewritten');
          } else {
            problems.push('src/ui/styles.css is stale — run node tools/art/ui.mjs --write-css');
          }
        } else {
          console.log('  [stylesheet]   src/ui/styles.css matches the art exactly');
        }
      }
    } catch (err) {
      problems.push(`could not read src/ui/styles.css: ${err.message}`);
    }
  }
  // The whole reason for choosing data URIs over 22 canvases was cost. Print
  // it, and gate it, so the decision stays true rather than remembered.
  const CSS_BUDGET = 12 * 1024;
  if (bytes > CSS_BUDGET) {
    problems.push(`the generated CSS block is ${(bytes / 1024).toFixed(1)} KB, over the ${CSS_BUDGET / 1024} KB budget ` +
      '— at that size a shared sprite sheet stops being cheaper than the canvases it replaced');
  }

  // --- per frame -----------------------------------------------------------
  const rows = [];
  for (const b of built) {
    const st = frameStats(sheet.px, sheet.size, b.at);
    if (!st.painted) problems.push(`${b.name}: nothing drawn`);
    if (st.partial) problems.push(`${b.name}: ${st.partial}px partially transparent — no alpha blending allowed`);
    if (st.illegal) {
      const f = st.firstBad;
      problems.push(`${b.name}: ${st.illegal}px off palette, first at ${f.x},${f.y} = rgb(${f.c.slice(0, 3)})`);
    }
    rows.push({ name: b.name, cover: st.painted / st.total, tones: st.tones.size });
  }

  // --- the icons have room to breathe --------------------------------------
  // An icon that fills its frame has no silhouette left, and one that fills a
  // twentieth of it is a speck on a 28px button. The bounds are measured off
  // the set rather than guessed, and the keyline is included in the coverage
  // because the keyline is part of what the eye sees.
  for (const [id] of Object.entries(NAV_ICONS)) {
    for (let k = 0; k < NAV_FRAMES; k++) {
      const r = rows.find((x) => x.name === `ui_nav_${id}${k}`);
      if (r.cover < 0.24) problems.push(`ui_nav_${id}${k}: ${Math.round(r.cover * 100)}% covered — too little to read at 28px`);
      if (r.cover > 0.86) problems.push(`ui_nav_${id}${k}: ${Math.round(r.cover * 100)}% covered — no air around the silhouette`);
    }
  }
  for (const [id] of Object.entries(RES_ICONS)) {
    for (let k = 0; k < RES_FRAMES; k++) {
      const r = rows.find((x) => x.name === `ui_res_${id}${k}`);
      if (r.cover < 0.20) problems.push(`ui_res_${id}${k}: ${Math.round(r.cover * 100)}% covered — too little to read at 20px`);
      if (r.cover > 0.86) problems.push(`ui_res_${id}${k}: ${Math.round(r.cover * 100)}% covered — no air around the silhouette`);
    }
  }

  // --- the 9-slice frames actually 9-slice ---------------------------------
  // Two properties, and both of them break silently. The middle must be empty,
  // or the panel's own background is covered by a smear of stretched plate.
  // And each edge's middle run must be constant ALONG the run, or `repeat`
  // shows the join: the tile is what gets repeated, so anything that varies
  // across it appears at every rivet pitch as a visible discontinuity except
  // where it happens to line up.
  for (const [id, spec] of Object.entries(UI_FRAMES)) {
    const at = frameAt[`ui_${id}`];
    const { size, slice } = spec;
    let filled = 0;
    for (let y = slice; y < size - slice; y++) {
      for (let x = slice; x < size - slice; x++) {
        if (readPixel(sheet.px, sheet.size, at, x, y)[3] > 0) filled++;
      }
    }
    if (filled) problems.push(`ui_${id}: ${filled}px painted in the middle region — border-image drops it, ` +
      'so it is invisible art at best and a smear if anyone ever adds `fill`');
    // The corners must be opaque all the way out, or the frame has a hole in
    // it exactly where the eye checks whether a box is closed.
    for (const [cx, cy] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
      if (readPixel(sheet.px, sheet.size, at, cx, cy)[3] === 0) {
        problems.push(`ui_${id}: corner ${cx},${cy} is transparent — the frame does not close`);
      }
    }
  }

  // --- every loop actually moves -------------------------------------------
  // The gate this file was written for. A three-frame loop with two identical
  // frames is a two-frame loop with a stutter, and nothing else would ever
  // report it.
  const MIN_MOVE = 2;
  const moves = [];
  const checkLoop = (prefix, ids, frames, label) => {
    for (const id of ids) {
      let least = Infinity, pair = '';
      for (let a = 0; a < frames; a++) {
        for (let b = a + 1; b < frames; b++) {
          const d = pixelDiff(sheet.px, sheet.size, frameAt[`${prefix}${id}${a}`], frameAt[`${prefix}${id}${b}`]);
          if (d < least) { least = d; pair = `${a}/${b}`; }
        }
      }
      moves.push({ label, id, least, pair });
      if (least === 0) {
        problems.push(`${prefix}${id}: frames ${pair} are pixel-identical — the loop has a dead frame`);
      } else if (least < MIN_MOVE) {
        problems.push(`${prefix}${id}: frames ${pair} differ by ${least}px — too little to see, and too much to be free`);
      }
    }
  };
  checkLoop('ui_nav_', Object.keys(NAV_ICONS), NAV_FRAMES, 'nav');
  checkLoop('ui_res_', Object.keys(RES_ICONS), RES_FRAMES, 'res');

  // --- and no two icons read as the same thing ------------------------------
  // Measured on frame 0, which is the frame a player sees most: the loops are
  // slow and every one of them rests there. gear.mjs holds eighteen 24x24
  // icons to 12 of 144 cells; these are smaller, so the bar is scaled by area
  // and then rounded down — 10/121 for the navbar, 6/64 for the counters.
  const separation = (prefix, ids, size, bar, what) => {
    const sigs = ids.map((id) => ({ id, sig: silhouette(sheet.px, sheet.size, frameAt[`${prefix}${id}0`]) }));
    const cells = sigs[0].sig.length;
    let worst = { d: 999, a: '', b: '' };
    const near = {};
    for (let i = 0; i < sigs.length; i++) {
      near[sigs[i].id] = { d: 999, id: '' };
      for (let j = 0; j < sigs.length; j++) {
        if (i === j) continue;
        const d = hamming(sigs[i].sig, sigs[j].sig);
        if (d < near[sigs[i].id].d) near[sigs[i].id] = { d, id: sigs[j].id };
        if (j > i && d < worst.d) worst = { d, a: sigs[i].id, b: sigs[j].id };
      }
    }
    if (worst.d < bar) {
      problems.push(`${what}: ${worst.a} and ${worst.b} share a silhouette ` +
        `(${worst.d}/${cells} cells differ, need ${bar}) — two icons in the same bar that look alike ` +
        'are one icon and a mistake');
    }
    return { worst, near, cells };
  };
  // The bars are set just under what the art measures, the way gear.mjs sets
  // its own: the navbar's closest pair is 14 of 121 and the counters' is 8 of
  // 81, so a redraw that loses a couple of cells is fine and one that halves
  // the margin is not.
  const navSep = separation('ui_nav_', Object.keys(NAV_ICONS), NAV_SIZE, 12, 'navbar');
  const resSep = separation('ui_res_', Object.keys(RES_ICONS), RES_SIZE, 7, 'counters');

  // --- report ---------------------------------------------------------------
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nui.mjs — ${built.length} frames: ${Object.keys(UI_FRAMES).length} 9-slice tiles, ` +
    `${Object.keys(NAV_ICONS).length}x${NAV_FRAMES} nav at ${NAV_SIZE}px, ` +
    `${Object.keys(RES_ICONS).length}x${RES_FRAMES} counters at ${RES_SIZE}px\n`);
  console.log(`  [navbar]   ${NAV_SIZE}x${NAV_SIZE}, drawn at ${NAV_SIZE * UI_ZOOM} CSS px`);
  for (const id of Object.keys(NAV_ICONS)) {
    const r = rows.find((x) => x.name === `ui_nav_${id}0`);
    const m = moves.find((x) => x.label === 'nav' && x.id === id);
    console.log(`    ${pad(id, 12)} cover ${pad(`${Math.round(r.cover * 100)}%`, 5)} tones ${pad(r.tones, 4)}` +
      ` loop moves ${pad(`${m.least}px`, 6)} nearest ${pad(navSep.near[id].id, 12)} ${navSep.near[id].d}/${navSep.cells}`);
  }
  console.log(`\n  [counters] ${RES_SIZE}x${RES_SIZE}, drawn at ${RES_SIZE * UI_ZOOM} CSS px`);
  for (const id of Object.keys(RES_ICONS)) {
    const r = rows.find((x) => x.name === `ui_res_${id}0`);
    const m = moves.find((x) => x.label === 'res' && x.id === id);
    console.log(`    ${pad(id, 12)} cover ${pad(`${Math.round(r.cover * 100)}%`, 5)} tones ${pad(r.tones, 4)}` +
      ` loop moves ${pad(`${m.least}px`, 6)} nearest ${pad(resSep.near[id].id, 12)} ${resSep.near[id].d}/${resSep.cells}`);
  }
  console.log(`\n  [closest]  navbar ${navSep.worst.a}/${navSep.worst.b} at ${navSep.worst.d}/${navSep.cells}` +
    `, counters ${resSep.worst.a}/${resSep.worst.b} at ${resSep.worst.d}/${resSep.cells}`);
  console.log(`  [cost]     generated CSS ${(bytes / 1024).toFixed(1)} KB of ${CSS_BUDGET / 1024} KB budget, ` +
    'one decode for the whole interface');

  if (args.out) await contactSheet(sheet, built, String(args.out), Number(args.zoom ?? 8));

  if (problems.length) {
    console.log(`\n  ${problems.length} PROBLEM(S):`);
    for (const m of problems) console.log(`    - ${m}`);
    process.exitCode = 1;
  } else {
    console.log(`\n  ok — ${built.length} frames, palette law upheld, every loop moves, ` +
      'every icon separated, the stylesheet is the art');
  }
}

/* ---------------------------------------------------- contact sheet PNG -- */

/** One row per icon, frames left to right, on the chrome's own background. */
async function contactSheet(sheet, built, out, zoom) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const PAD = 6;
  const bands = [
    Object.keys(UI_FRAMES).map((id) => [`ui_${id}`]),
    Object.keys(NAV_ICONS).map((id) => Array.from({ length: NAV_FRAMES }, (_, k) => `ui_nav_${id}${k}`)),
    Object.keys(RES_ICONS).map((id) => Array.from({ length: RES_FRAMES }, (_, k) => `ui_res_${id}${k}`)),
  ].flat();
  const cell = 24 * zoom + PAD;
  const cols = Math.max(...bands.map((b) => b.length));
  const W = cols * cell + PAD, H = bands.length * cell + PAD;
  const buf = new Uint8Array(W * H * 4);
  const bg = PAL.deep;
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = bg[0]; buf[i * 4 + 1] = bg[1]; buf[i * 4 + 2] = bg[2]; buf[i * 4 + 3] = 255;
  }
  bands.forEach((band, row) => {
    band.forEach((name, col) => {
      const b = built.find((x) => x.name === name);
      if (!b) return;
      const ox = PAD + col * cell, oy = PAD + row * cell;
      for (let y = 0; y < b.at.h; y++) {
        for (let x = 0; x < b.at.w; x++) {
          const c = readPixel(sheet.px, sheet.size, b.at, x, y);
          if (!c[3]) continue;
          for (let j = 0; j < zoom; j++) {
            for (let i = 0; i < zoom; i++) {
              const p = ((oy + y * zoom + j) * W + ox + x * zoom + i) * 4;
              buf[p] = c[0]; buf[p + 1] = c[1]; buf[p + 2] = c[2]; buf[p + 3] = 255;
            }
          }
        }
      }
    });
  });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, encodePng(W, H, buf));
  console.log(`\n  contact sheet -> ${out} (${W}x${H}) at ${zoom}x`);
  bands.forEach((b, i) => console.log(`    row ${i + 1}: ${b[0]}`));
}

if (import.meta.url === `file://${process.argv[1]}`) await runSelfTest();
