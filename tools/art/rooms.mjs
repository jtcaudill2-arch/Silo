/**
 * rooms.mjs — the room art.
 *
 * Two families, both drawn on lib.mjs's painter, palette and seeded rng — see
 * WHY SO LITTLE OF lib.mjs's SHAPE VOCABULARY IS USED HERE for the shapes:
 *
 *   ROOM_FIXTURES  64x36, TRANSPARENT background. This is the machinery seen
 *                  in the silo cross-section. The renderer fills the interior
 *                  with a category tint behind it, washes the top six rows
 *                  with lamp light, and paints level pips, a condition bar and
 *                  status glyphs on top — so the art here is a silhouette of
 *                  three or four strong shapes and nothing precious in the
 *                  top-right corner or the bottom-left strip.
 *
 *   ROOM_CUTAWAYS  128x88, fully opaque. The room as you would see it through
 *                  a cut wall: a chamfered vault of block coursing, one amber
 *                  ceiling fixture, a lighter floor band, and the room's
 *                  contents standing on it.
 *
 * House rules, same as the rest of the pipeline:
 *   - every solid form carries a PAL.ink keyline: four-sided if it is big
 *     enough to afford one, otherwise on its shaded edges — see THE KEYLINE
 *     BUDGET, which is where the whole of that argument lives,
 *   - light comes from the upper left, always,
 *   - colour is a PAL entry or ONE shade() of a PAL entry, never a shade of a
 *     shade — see THE PALETTE RAY,
 *   - PAL.toxin is radiation and contamination only. In this file that means
 *     the reactor core and what leaks past the airlock's outer door. Nowhere
 *     else. Amber (PAL.sodium) does all ordinary warm work.
 *   - all randomness goes through rng(seed) so the atlas is byte-identical
 *     between runs and the repository stays diffable. The seed is derived from
 *     the room id inside this module (see bind() at the foot of the file), so a
 *     caller cannot change it by passing a different sprite name.
 *
 * ---------------------------------------------------------------------------
 * THE KEYLINE BUDGET
 *
 * "Everything is outlined" is not the same instruction at 64x36 as it is at
 * 512x512, and taking it literally is what a measured audit of the first draft
 * of this file caught: every fixture came out between 29% and 51% pure black,
 * because a 1px outline around a 40x30 machine costs 12% of its pixels but a
 * 1px outline around eight 5x4 sub-details inside that machine costs 50%.
 * Outlined lace is not outlined art.
 *
 * The rule this file actually follows, and the self-test enforces:
 *
 *   1. SILHOUETTE SHAPES — anything whose edge meets the room behind it —
 *      carry a full four-sided ink frame. There are three or four per sprite
 *      and they are large, because 2*(w+h)-4 over w*h only stays cheap when
 *      the shape is big. A 24x20 block is 15% ink; a 30x3 bench is 69%.
 *   2. SUB-DETAILS living inside an already-outlined shell carry NO ink of
 *      their own. Tone does the separating: lit face on top and left, shaded
 *      face on bottom and right, which is the same light the shell obeys.
 *   3. THIN RUNS — pipes, benches, shelves, rails, floor plates — and anything
 *      below 6x5 carry their keyline on the SHADED side only (underneath, or to
 *      the right), because that is the edge that reads as a silhouette; the lit
 *      side is a highlight and an ink line on top of a highlight is just a lost
 *      pixel. ledge(), pipeh(), pipev() and solid()'s own small-shape path are
 *      the only ways to draw one.
 *   4. AN OBJECT STANDING ON THE FLOOR ENDS ON THE CONTACT LINE, not one row
 *      above it. ground() lays a full-width ink row at y=32 for exactly this;
 *      stopping short leaves the object's own bottom keyline stacked on top of
 *      it, which is a 2px black band under every machine in the silo and, over
 *      the set, several hundred pixels of keyline drawn twice.
 *
 * The self-test measures two different things and they are not the same number:
 *
 *   LACE, the ink that touches no empty pixel — a keyline drawn around
 *   something that was already inside an outline — is budgeted hard, at 12% of
 *   painted pixels. This is the quantity the audit was actually looking at when
 *   it said the sprites read as black lace, and it is the one that responds to
 *   drawing better.
 *
 *   TOTAL INK keeps a loose 30% ceiling as a backstop. It cannot be pushed much
 *   below that on a transparent sprite without abolishing the keyline, and the
 *   keyline is the style: an outlined solid costs (2(w+h)-4)/(w*h), which is 15%
 *   for a 24x20 machine but 25% for a 12x20 hanging suit, so a 64x36 frame
 *   holding three or four objects that size against the bare shaft is a quarter
 *   ink before a single detail is drawn. A flat 15-18% target is not reachable
 *   by outlined art at this size, and anything reporting that it had been met
 *   would be reporting that the outlines were gone.
 *
 * If a sprite is over either number, the fix is always fewer and bigger shapes,
 * never a thinner outline.
 *
 * ---------------------------------------------------------------------------
 * THE PALETTE RAY
 *
 * shade(c, t) mixes c toward black or toward PAL.bone, so shade(PAL.rust, -0.3)
 * is on the palette and shade(shade(PAL.rust, -0.3), +0.2) is NOT: it has left
 * the ray, and because it desaturates on the way it lands on a milky neutral
 * where a warm highlight was wanted. An audit of the first draft found 135
 * such colours across 5401 pixels, all of them arrived at by handing an
 * already-darkened working tone to a helper that lightens internally.
 *
 * So a colour in this file is a `tone`: a PAL entry plus a position on its ray.
 * tone(c, t) walks ALONG the ray rather than mixing again, so tone(WOOD, 0.2)
 * is shade(PAL.rust, -0.14) and never shade(shade(PAL.rust, -0.34), 0.2). Every
 * drawing helper below lightens and darkens through tone(). The self-test
 * checks every painted pixel against the ray of every PAL entry and fails on
 * anything else — including alpha-blended pixels, which land between two legal
 * colours and are therefore on no ray at all. That is why nothing in this file
 * draws with alpha: soft light is ordered dither between two legal tones
 * (spill(), fade(), coneGlow()), which is also what keeps it looking like
 * pixel art rather than like a screenshot of pixel art.
 *
 * ---------------------------------------------------------------------------
 * WHY SO LITTLE OF lib.mjs's SHAPE VOCABULARY IS USED HERE
 *
 * lib.mjs is the contract and this module draws through its painter, its
 * palette, its seeded rng and its atlas. It does not use lib's box(), collar(),
 * elbow(), valve(), screen() or cylinder(), and that is deliberate rather than
 * a fork: at the sizes this file works in, each of them fails measurably.
 *
 *   box(w,h)     frame() runs last, so at h<=2 or w<=2 the fill is never seen
 *                and the shape is 100% ink; at 3 the shaded pass overwrites
 *                the lit pass and the object is lit from nowhere.
 *   collar()     box(x, y-1, 2, thick+2) — 2 wide, so it is entirely frame:
 *                a solid black notch punched into every pipe run.
 *   elbow(2)     a 4x4 that is 75% frame.
 *   valve(3)     16 of 29 disc pixels are the ink annulus and the cross takes
 *                9 more; four pixels of wheel survive.
 *   screen/box/  all lighten their argument internally with shade(c, +t), so
 *   cylinder/    passing any derived working tone leaves the palette ray.
 *   pipeH/pipeV
 *
 * The local replacements below fix those specific failures and are otherwise
 * the same shapes. If lib.mjs is ever repaired — frame before fill, a minimum
 * size guard, and shading taken from a base colour rather than the argument —
 * these should collapse back into it.
 *
 * ---------------------------------------------------------------------------
 * TWO SIZING FACTS THE INTEGRATOR OWNS (this module cannot fix them alone)
 *
 *   FIXTURES. 64x36 is drawn 1:1 only if src/render/floors.js stops insetting
 *   the fixture box: today drawRoom() computes x = slot*64 + GAP, w =
 *   width*64 - GAP*2, h = FLOOR_H - 3 - GAP*2, so drawFixture() blits a 64x36
 *   source into 60x33 (or 62x33, or 62.667x33) with imageSmoothingEnabled
 *   false — a fractional nearest-neighbour resample that drops four columns
 *   and three rows and stretches the result 2.3% anisotropically, which is
 *   exactly what a 1px keyline cannot survive. The fix is in drawRoom:
 *       x = room.slot * SLOT_W;   w = room.width * SLOT_W;   // no GAP
 *       y = (room.floor - 1) * FLOOR_H + 1;  h = FLOOR_H - 4; // 36 rows
 *   which makes bayW exactly 64 for every room width and kills the width-3
 *   seam as well. Authoring at 60x33 instead would fix the arithmetic and lose
 *   the integer-bay property for widths 2 and 3, so it is the wrong half of
 *   the problem to solve. FIXTURE_DEST below states the contract so the
 *   integrating agent can assert it.
 *
 *   CUTAWAYS. 128x88 is 16:11 and 3x it is exactly the 384x264 that
 *   tools/import-art.mjs specifies for the room detail panel — but the panel
 *   itself is fluid: src/ui/styles.css sets `.room-art img { width: 100% }`,
 *   so the real upscale is viewport/128 and at, say, 360px wide that is 2.81x,
 *   which duplicates some source columns twice and some three times. Nothing
 *   here can prevent that, so the cutaways are drawn with 2px minimum features
 *   and no 1px-critical reading, and the panel should be pinned to a
 *   max-width of 384px (or 256px) if it is ever to be pixel-exact.
 *
 * Self-test: node tools/art/rooms.mjs
 */

import { PAL, shade, rng, atlas } from './lib.mjs';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Move a colour along its own palette ray. `c` is either a PAL entry or a tone
 * produced by this function; either way the result is exactly one shade() of a
 * PAL entry, which is the only derivation the palette law allows.
 */
function tone(c, t = 0) {
  const base = c.base || c;
  const at = clamp((c.t || 0) + t, -0.9, 0.9);
  const out = shade(base, at);
  out.base = base;
  out.t = at;
  return out;
}

// ------------------------------------------------------------ working tones ---

const CONC = tone(PAL.concrete);
const STEEL = tone(PAL.steel);
const STEEL_LIT = tone(PAL.steelLit);
const DARK = tone(PAL.steelDark);
const IRON = tone(PAL.steelDark, -0.35);
const WOOD = tone(PAL.rust, -0.34);
const WOOD_LIT = tone(PAL.rust, -0.14);
const GLASS = tone(PAL.verdigris, -0.42);
const LEAF = tone(PAL.verdigris);
const SLUDGE = tone(PAL.rust, -0.06);
const AMBER = tone(PAL.sodium);
const AMBER_DIM = tone(PAL.sodium, -0.42);
const CLOTH = tone(PAL.bone, -0.22);
const SOOT = tone(PAL.concrete, -0.45);
const RUST_DK = tone(PAL.rust, -0.4);
const VOID = tone(PAL.deeper);

/** Room ids, in src/data/rooms.js order. Both maps must cover exactly these. */
export const ROOM_IDS = [
  'generator_hall', 'reactor', 'water_reclaimer', 'hydroponics', 'protein_vats',
  'air_filtration', 'residences', 'cafeteria', 'clinic', 'chem_lab', 'workshop',
  'recycling', 'foundry', 'munitions', 'armory', 'barracks', 'training_yard',
  'sheriffs_office', 'holding_cells', 'laboratory', 'archive', 'schoolhouse',
  'radio_room', 'airlock', 'suit_bay', 'storage_depot', 'deep_mine', 'maintenance_bay',
  // Added late to the game and never to this list, so the atlas carried 28
  // frames for 29 room types and the Heat Exchange fell through to the
  // procedural tile everywhere. `missingRoomArt()` could not report it either,
  // because it was absent from ROOM_ART rather than null in it.
  'heat_exchange',
];

// =============================================================================
// PRIMITIVES
//
// Everything missing from lib.mjs — or broken in lib.mjs at these sizes — lives
// here rather than there: other agents are editing lib.mjs concurrently and a
// merge conflict in the shared contract costs far more than a leaf module that
// repeats itself a little.
// =============================================================================

/**
 * The workhorse: an outlined solid lit from the upper left.
 *
 * The highlight owns the whole top row and the whole left column; the shade is
 * inset one pixel from each, so the two never fight over a corner and the
 * shape reads as a box rather than as a frame with a stripe in it.
 *
 * SMALL SHAPES GET AN L, NOT A FRAME. A four-sided keyline costs 2(w+h)-4 of
 * w*h, which is 15% of a 24x20 machine and 70% of a 5x4 chip — the same
 * arithmetic that turned lib's box() into a black domino at small sizes. Below
 * 6x5 the keyline drops to the bottom and right edges, which under light from
 * the upper left are the two that read as silhouette; the top and left are
 * already carrying a highlight, and ink on top of a highlight is a lost pixel.
 * This is the compromise ledge() makes, applied consistently.
 */
const MIN_FRAME_W = 6;
const MIN_FRAME_H = 5;

function solid(p, x, y, w, h, c, o = {}) {
  const lit = o.lit ?? 0.22;
  const dark = o.dark ?? -0.24;
  const ink = o.ink === null ? null : o.ink || PAL.ink;
  p.rect(x, y, w, h, c);
  if (w > 2 && h > 2) {
    p.hline(x + 1, y + 1, w - 2, tone(c, lit));
    p.vline(x + 1, y + 1, h - 2, tone(c, lit));
    if (h > 3) p.hline(x + 2, y + h - 2, w - 3, tone(c, dark));
    if (w > 3) p.vline(x + w - 2, y + 2, h - 3, tone(c, dark));
  }
  if (!ink) return p;
  if (w >= MIN_FRAME_W && h >= MIN_FRAME_H) p.frame(x, y, w, h, ink);
  else {
    p.hline(x, y, w, tone(c, lit + 0.14));
    p.vline(x, y, h, tone(c, lit + 0.14));
    p.hline(x, y + h - 1, w, ink);
    p.vline(x + w - 1, y, h, ink);
  }
  return p;
}

/**
 * A sub-detail inside an already-outlined shell: same light, no keyline of its
 * own. This is rule 2 of the keyline budget and it is the single biggest
 * saving in the file — a machine with six inner details costs the ink of one.
 */
function inner(p, x, y, w, h, c, o = {}) {
  return solid(p, x, y, w, h, c, { ...o, ink: null });
}

/**
 * A bench, shelf, rail, plate or table top. Too thin to survive a four-sided
 * keyline (a 30x3 outlined box is 69% ink), so the ink is the underside — the
 * edge that actually reads as a silhouette against the room — and the lit top
 * surface carries the other edge. Occupies rows y .. y+h, the last being ink.
 *
 * caps:false leaves the ends open, which is what makes a run tile from bay to
 * bay: the renderer draws the same 64px frame once per slot, so anything that
 * touches x=0 and x=63 at the same y with the same colour is continuous.
 */
function ledge(p, x, y, w, h, c, o = {}) {
  p.rect(x, y, w, h, c);
  p.hline(x, y, w, tone(c, 0.3));
  if (h > 2) p.hline(x, y + h - 1, w, tone(c, -0.2));
  p.hline(x, y + h, w, PAL.ink);
  if (o.caps !== false) {
    p.vline(x, y, h, PAL.ink);
    p.vline(x + w - 1, y, h, PAL.ink);
  }
  return p;
}

/** A 2px leg or stile: one lit column and its own shadow. */
function leg(p, x, y, h, c = WOOD) {
  p.vline(x, y, h, tone(c, 0.12));
  p.vline(x + 1, y, h, PAL.ink);
  return p;
}

/**
 * A lit port cut into a machine. A hole in a solid is the one small shape that
 * has earned a full frame, because the frame is the wall thickness.
 */
function port(p, x, y, w, h, glow) {
  p.frame(x, y, w, h, PAL.ink);
  p.rect(x + 1, y + 1, w - 2, h - 2, glow);
  p.hline(x + 1, y + 1, w - 2, tone(glow, 0.34));
  p.hline(x + 1, y + h - 2, w - 2, tone(glow, -0.26));
  return p;
}

/** A lit console screen: scanlined, so it reads as emitting. */
function screenBox(p, x, y, w, h, glow = LEAF) {
  p.frame(x, y, w, h, PAL.ink);
  p.rect(x + 1, y + 1, w - 2, h - 2, glow);
  p.hline(x + 1, y + 1, w - 2, tone(glow, 0.42));
  for (let j = y + 3; j < y + h - 1; j += 2) p.hline(x + 1, j, w - 2, tone(glow, -0.26));
  return p;
}

/** A console: dark cabinet, lit screen, a row of indicator lamps. */
function deskPanel(p, x, y, w, h, glow = LEAF) {
  solid(p, x, y, w, h, DARK);
  screenBox(p, x + 2, y + 2, w - 4, Math.max(4, h - 6), glow);
  for (let i = 3; i + 1 < w - 2; i += 4) {
    p.set(x + i, y + h - 3, (i >> 2) % 2 ? AMBER : tone(PAL.rust, 0.12));
  }
  return p;
}

/**
 * A vertical cylinder: flat colour, a bright band down the left quarter, a
 * dark band down the right, and a 1px-chamfered cap so it does not read as a
 * box. Returns the interior span that a window may safely occupy — putting a
 * port over the bands is what flattened every large vessel in the first draft.
 */
function tube(p, x, y, w, h, c) {
  const hiW = Math.max(2, Math.round(w * 0.24));
  const loW = Math.max(1, Math.round(w * 0.16));
  p.rect(x + 1, y + 1, w - 2, h - 2, c);
  p.rect(x + 1, y + 1, hiW, h - 2, tone(c, 0.3));
  p.rect(x + w - 1 - loW, y + 1, loW, h - 2, tone(c, -0.3));
  p.hline(x + 2, y + 1, w - 4, tone(c, 0.44));
  p.hline(x + 2, y, w - 4, PAL.ink);
  p.set(x + 1, y + 1, PAL.ink);
  p.set(x + w - 2, y + 1, PAL.ink);
  p.vline(x, y + 2, h - 3, PAL.ink);
  p.vline(x + w - 1, y + 2, h - 3, PAL.ink);
  p.hline(x, y + h - 1, w, PAL.ink);
  return { x: x + 1 + hiW, w: w - 2 - hiW - loW };
}

/** A horizontal pipe run. Rows y .. y+thick-1 are body, row y+thick is ink. */
function pipeh(p, x, y, len, thick = 2, c = STEEL) {
  p.rect(x, y, len, thick, c);
  p.hline(x, y, len, tone(c, 0.34));
  if (thick > 2) p.hline(x, y + thick - 1, len, tone(c, -0.26));
  p.hline(x, y + thick, len, PAL.ink);
  return p;
}

/** A vertical pipe run. Columns x .. x+thick-1 are body, x+thick is ink. */
function pipev(p, x, y, len, thick = 2, c = STEEL) {
  p.rect(x, y, thick, len, c);
  p.vline(x, y, len, tone(c, 0.34));
  if (thick > 2) p.vline(x + thick - 1, y, len, tone(c, -0.26));
  p.vline(x + thick, y, len, PAL.ink);
  return p;
}

/**
 * The union collar where two lengths of pipe are joined — the motif that stops
 * a pipe reading as a painted stripe. Three columns: a bright leading edge, a
 * body, and its own shadow. It adds no ink row of its own; the pipe's keyline
 * already closes the silhouette, and inking the flanks at this scale is what
 * turned lib's collar into a black notch.
 */
function collarH(p, x, y, thick, c = STEEL_LIT) {
  p.rect(x, y, 3, thick, tone(c, 0.08));
  p.vline(x, y, thick, tone(c, 0.32));
  p.vline(x + 2, y, thick, PAL.ink);
  return p;
}

function collarV(p, x, y, thick, c = STEEL_LIT) {
  p.rect(x, y, thick, 3, tone(c, 0.08));
  p.hline(x, y, thick, tone(c, 0.32));
  p.hline(x, y + 2, thick, PAL.ink);
  return p;
}

/** Pipe elbow: a mitre block at the junction. Never thinner than 3 — a 4x4 is
 *  three quarters frame and reads as a full stop. */
function elbowAt(p, x, y, thick = 3, c = STEEL) {
  const t = Math.max(3, thick);
  return solid(p, x, y, t + 2, t + 2, c, { lit: 0.3, dark: -0.26 });
}

/** Filled disc with a keyline and upper-left light. */
function disc(p, cx, cy, r, c, edge = PAL.ink) {
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const d = i * i + j * j;
      if (d > r * r) continue;
      if (edge && d > (r - 1) * (r - 1)) { p.set(cx + i, cy + j, edge); continue; }
      const k = i + j;
      p.set(cx + i, cy + j, k < -r * 0.45 ? tone(c, 0.26) : k > r * 0.5 ? tone(c, -0.26) : c);
    }
  }
  return p;
}

/** One-pixel circle. */
function ring(p, cx, cy, r, c) {
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const d = i * i + j * j;
      if (d <= r * r && d > (r - 1) * (r - 1)) p.set(cx + i, cy + j, c);
    }
  }
  return p;
}

/**
 * A valve handwheel. r>=4 only: below that the ink annulus and the spokes eat
 * the whole disc and what is left is a smudge, so fixtures get taps and
 * cutaways get wheels.
 */
function wheel(p, cx, cy, r, c = STEEL_LIT) {
  disc(p, cx, cy, r, c);
  ring(p, cx, cy, r, PAL.ink);
  const spoke = tone(c, -0.4);
  p.hline(cx - r + 2, cy, r * 2 - 3, spoke);
  p.vline(cx, cy - r + 2, r * 2 - 3, spoke);
  p.rect(cx - 1, cy - 1, 2, 2, tone(c, -0.55));
  p.set(cx - 1, cy - 1, tone(c, 0.24));
  return p;
}

/**
 * A hand tap: what a valve looks like when there is no room for a wheel. Two
 * bright rows on a stem, one ink row under them. Eleven pixels, and it reads.
 */
function tap(p, cx, y, w = 5, c = STEEL_LIT) {
  const x = cx - (w >> 1);
  p.hline(x, y, w, tone(c, 0.3));
  p.hline(x, y + 1, w, tone(c, -0.15));
  p.hline(x, y + 2, w, PAL.ink);
  p.set(cx, y + 3, PAL.ink);
  return p;
}

/** A gauge face. s>=6 only: a 4x4 dial is twelve pixels of frame and two of
 *  face, which is a rivet, not an instrument. Cutaway scale. */
function gauge(p, x, y, s, face = PAL.bone) {
  const f = tone(face, -0.2);
  p.rect(x + 1, y + 1, s - 2, s - 2, f);
  p.hline(x + 1, y + 1, s - 2, tone(face, 0.02));
  p.vline(x + 1, y + 1, s - 2, tone(face, 0.02));
  p.frame(x, y, s, s, PAL.ink);
  const c = s >> 1;
  p.set(x + c, y + c, tone(PAL.rust, -0.3));
  p.set(x + c - 1, y + c - 1, tone(PAL.rust, -0.1));
  p.set(x + c - 2, y + c - 2, tone(PAL.rust, 0.1));
  return p;
}

/**
 * Diagonal hazard chevrons. The dark stripe is a deep rust rather than ink: at
 * 50% coverage an ink stripe doubles a sprite's keyline budget on its own, and
 * hazard paint on a silo wall has never been black anyway.
 *
 * Below four rows the diagonal cannot be seen at all — a 1px window through a
 * 2px diagonal is a dashed line, which means something else entirely — so thin
 * bands fall back to a solid amber rail.
 */
function hazardBand(p, x, y, w, h, c = AMBER) {
  const dk = tone(PAL.rust, -0.66);
  if (h < 4) {
    p.rect(x, y, w, h, c);
    p.hline(x, y, w, tone(c, 0.3));
    return p;
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) p.set(x + i, y + j, ((i + j) >> 1) & 1 ? dk : c);
  }
  return p;
}

/**
 * A line cut INTO a surface: a lid joint, a bedding plane in rock, a panel
 * seam. Dark row on top, lit row beneath — the reverse of ledge(), and not a
 * mistake. A shape standing proud takes the light on its top face; a groove is
 * shadowed under its upper lip and lit on its lower one. An audit of the first
 * draft found eleven places where a shelf edge had these two rows the wrong way
 * round and the whole game read as lit from the floor; the way to keep that
 * from coming back is for every deliberate inversion to say that it is one, so
 * this is the only function in the file that puts dark above light.
 */
function seam(p, x, y, w, c, t = -0.5) {
  p.hline(x, y, w, tone(c, t));
  p.hline(x, y + 1, w, tone(c, Math.min(0.4, t + 0.62)));
  return p;
}

/** A row of rivet highlights. */
function rivets(p, x, y, n, step, c = STEEL_LIT) {
  for (let i = 0; i < n; i++) p.set(x + i * step, y, c);
  return p;
}

const DITHER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

/**
 * Lamp spill: an ordered dither of one legal tone, thinning downward. Alpha
 * would land the result between two colours and off every palette ray, so the
 * softness comes from coverage instead of from opacity.
 */
function spill(p, x, y, w, h, c, amt = 0.6) {
  for (let j = 0; j < h; j++) {
    const t = amt * (1 - j / h);
    for (let i = 0; i < w; i++) {
      if (t > (DITHER[j & 3][(x + i) & 3] + 0.5) / 16) p.set(x + i, y + j, c);
    }
  }
  return p;
}

/** The same dither, fading a tone IN as it descends: wall depth, floor grime. */
function fade(p, x, y, w, h, c, amt = 1) {
  for (let j = 0; j < h; j++) {
    const t = amt * (j / (h - 1));
    for (let i = 0; i < w; i++) {
      if (t > (DITHER[j & 3][(x + i) & 3] + 0.5) / 16) p.set(x + i, y + j, c);
    }
  }
  return p;
}

/** A contact shadow pooled under a standing object. */
function contact(p, x, y, w, c = tone(PAL.concrete, -0.5)) {
  for (let i = 0; i < w; i++) {
    if (0.85 > (DITHER[0][(x + i) & 3] + 0.5) / 16) p.set(x + i, y, c);
    if (0.4 > (DITHER[1][(x + i) & 3] + 0.5) / 16) p.set(x + i, y + 1, tone(c, 0.12));
  }
  return p;
}

/** Sparks / embers. */
function sparks(p, x, y, w, h, n, seed) {
  const r = rng(seed);
  for (let k = 0; k < n; k++) {
    p.set(x + ((r() * w) | 0), y + ((r() * h) | 0), r() < 0.35 ? PAL.bone : AMBER);
  }
  return p;
}

/** Rising motes: steam, dust, bubbles. */
function motes(p, x, y, w, h, c, n, seed) {
  const r = rng(seed);
  for (let k = 0; k < n; k++) {
    const mx = x + ((r() * w) | 0);
    const my = y + ((r() * h) | 0);
    p.set(mx, my, c);
    if (r() < 0.3) p.set(mx + 1, my, tone(c, 0.25));
  }
  return p;
}

// =============================================================================
// FURNITURE — the objects rooms are built out of.
// =============================================================================

/**
 * A shipping crate: banded box with a stencil mark. `inside:true` is for a
 * crate racked in an already-outlined shell — rule 2 of the keyline budget —
 * where tone alone separates it from its neighbours; six framed crates on one
 * set of shelves was the single largest block of lace in the file.
 */
function crate(p, x, y, w, h, c = WOOD, o = {}) {
  solid(p, x, y, w, h, c, { lit: 0.22, dark: -0.26, ink: o.inside ? null : undefined });
  if (h > 7) p.hline(x + 1, y + (h >> 1), w - 2, tone(c, -0.34));
  if (w > 9 && h > 5) {
    p.rect(x + 2, y + 2, 4, 3, tone(PAL.bone, -0.2));
    p.hline(x + 2, y + 2, 4, tone(PAL.bone, -0.05));
  }
  return p;
}

/** A hooped drum. */
function drum(p, x, y, w, h, c = tone(PAL.rust)) {
  tube(p, x, y, w, h, c);
  p.hline(x + 1, y + Math.max(3, (h * 0.32) | 0), w - 2, tone(c, 0.3));
  p.hline(x + 1, y + ((h * 0.74) | 0), w - 2, tone(c, 0.3));
  return p;
}

/**
 * A hooded strip light seen edge-on: ink hood, warm reflector, the tube, and a
 * dithered spill under it. Three rows and one ink row, so a full-width run
 * costs one keyline instead of two.
 */
function lampBar(p, x, y, w, c = AMBER, drop = 3, caps = true) {
  p.hline(x, y, w, PAL.ink);
  p.hline(x, y + 1, w, tone(PAL.rust, -0.3));
  p.hline(x + 1, y + 1, w - 2, tone(PAL.rust, -0.12));
  p.hline(x, y + 2, w, c);
  p.hline(x + 1, y + 2, w - 2, tone(c, 0.4));
  if (caps) {
    // Closing the ends costs two ink pixels; leaving them open is what lets a
    // full-width run cross the bay seam without a black notch every 64px.
    p.vline(x, y + 1, 2, PAL.ink);
    p.vline(x + w - 1, y + 1, 2, PAL.ink);
  }
  if (drop) spill(p, x + 1, y + 3, w - 2, drop, tone(c, -0.5), 0.55);
  return p;
}

/**
 * A bank of leaves. Built from 3-4px clumps stepped 2px in height with a
 * shadow down the trailing side of each, not from independently jittered 1px
 * columns: at this scale a per-column offset is sub-pixel noise that the
 * renderer's resample turns into flicker, whereas a clump wider than the
 * resample error keeps its shape. One ink row underneath, and none inside.
 */
function canopy(p, x, y, w, h, c = LEAF, seed = 'leaf') {
  const r = rng(seed);
  const base = y + h;
  let i = 0;
  while (i < w) {
    const cw = Math.min(3 + ((r() * 3) | 0), w - i);
    const lift = [0, 2, 3, 1, 2][(r() * 5) | 0];
    const top = y + lift;
    p.rect(x + i, top, cw, base - top, c);
    p.hline(x + i, top, cw, tone(c, 0.3));
    p.hline(x + i, top + 1, cw, tone(c, 0.08));
    // A crown leaf above the clump, so the row is not a flat-topped bar chart.
    if (lift > 0 && cw >= 4 && r() < 0.6) {
      p.set(x + i + 1, top - 1, tone(c, 0.26));
      p.set(x + i + 2, top - 1, tone(c, 0.06));
    }
    if (i > 0) p.vline(x + i, top, base - top, tone(c, -0.36));
    if (r() < 0.4) p.set(x + i + 1, base - 2, tone(c, -0.28));
    i += cw;
  }
  p.hline(x, base, w, PAL.ink);
  return p;
}

/**
 * A shelf of book spines. No separator column between spines — the tone change
 * is already the boundary, and a 1px ink separator on a 3px repeat turns a
 * bookshelf into a picket fence — and one deliberately lighter spine per shelf
 * so the eye has somewhere to land.
 *
 * The line under the shelf is a shadow tone rather than ink: three shelves of
 * books live inside an outlined case, so by rule 2 they get no keyline of their
 * own, and 28px of ink under each was the case's own outline drawn three more
 * times.
 */
function spines(p, x, y, w, h, seed = 'books', under = tone(PAL.rust, -0.72)) {
  const r = rng(seed);
  const tones = [
    tone(PAL.rust, -0.2), tone(PAL.verdigris, -0.3),
    tone(PAL.bone, -0.46), tone(PAL.concrete, 0.12),
  ];
  const accent = 1 + ((r() * 4) | 0);
  let i = 0;
  let k = 0;
  while (i < w) {
    const bw = Math.min(2 + ((r() * 3) | 0), w - i);
    const dh = r() < 0.5 ? 0 : 2;
    const t = k === accent ? tone(PAL.bone, -0.1) : tones[(r() * tones.length) | 0];
    p.rect(x + i, y + dh, bw, h - dh, t);
    p.vline(x + i, y + dh, h - dh, tone(t, 0.22));
    p.hline(x + i, y + dh, bw, tone(t, 0.34));
    i += bw;
    k++;
  }
  p.hline(x, y + h, w, under);
  return p;
}

/**
 * A rifle standing in a rack. The barrel IS the dark line — outlining it on
 * both sides put two ink columns and one grey one in every three, on a
 * near-black rack, which is how six rifles became one texture. The rack
 * interior is deliberately lighter than the cabinet so the line has something
 * to be dark against.
 */
function longarm(p, x, y, h) {
  const bl = h - Math.max(4, (h * 0.4) | 0);
  p.vline(x + 1, y, bl, PAL.ink);
  p.vline(x, y, bl, tone(PAL.steel, 0.3));
  p.rect(x - 1, y + bl, 3, h - bl, WOOD);
  p.hline(x - 1, y + bl, 3, WOOD_LIT);
  p.vline(x + 1, y + bl, h - bl, PAL.ink);
  p.set(x - 1, y + h - 1, PAL.ink);
  return p;
}

/** A rifle lying on a rest, muzzle left. The training yard is a firing range. */
function longarmFlat(p, x, y, w) {
  const bl = (w * 0.62) | 0;
  p.hline(x, y + 1, bl, tone(PAL.steel, 0.3));
  p.hline(x, y + 2, bl, PAL.ink);
  p.rect(x + bl, y, w - bl, 3, WOOD);
  p.hline(x + bl, y, w - bl, WOOD_LIT);
  p.hline(x + bl, y + 3, w - bl, PAL.ink);
  p.set(x + bl - 1, y, PAL.ink);
  return p;
}

/**
 * A target board: three bands, not r concentric 1px rings. Alternating bone
 * and rust one pixel at a time is a moire generator — it shimmers under any
 * fractional resample and reads as a disc of grey noise.
 */
function target(p, cx, cy, r) {
  // PAL.bone is the top of its own ray, so shading bone toward bone is a no-op
  // and there is no such thing as a brighter white here. The lit face is bone
  // itself and the contrast comes from darkening everything around it.
  const boneLit = PAL.bone;
  const bone = tone(PAL.bone, -0.12);
  const red = tone(PAL.rust, 0.02);
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const d = Math.sqrt(i * i + j * j);
      if (d > r) continue;
      let c;
      if (d > r - 1) c = PAL.ink;
      else if (d > r * 0.7) c = i + j < -r * 0.5 ? boneLit : bone;
      else if (d > r * 0.35) c = red;
      else c = i + j < -r * 0.2 ? boneLit : bone;
      p.set(cx + i, cy + j, c);
    }
  }
  p.set(cx, cy, tone(PAL.rust, -0.2));
  return p;
}

/**
 * An impeller: a flat dark disc with three solid swept blades. The first draft
 * shaded the disc diagonally and drew 2px arms whose stagger ran the same way,
 * and the two patterns cancelled into static. Solid masses, flat ground.
 */
function impeller(p, cx, cy, r, c = STEEL) {
  disc(p, cx, cy, r, tone(PAL.deep, -0.2));
  const TAU = Math.PI * 2;
  const seg = TAU / 3;
  // One flat tone per blade, chosen by which blade it is rather than by where
  // the pixel is. Shading each blade across its own width splits it in two and
  // the fan reads as a globe with continents on it, which is what happened.
  const face = [tone(c, 0.32), tone(c, 0.0), tone(c, -0.3)];
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const d = Math.sqrt(i * i + j * j);
      if (d > r - 1.2 || d < 1.4) continue;
      const raw = Math.atan2(j, i) - d * 0.16;
      const norm = ((raw % TAU) + TAU) % TAU;
      const k = Math.floor(norm / seg) % 3;
      const a = norm - k * seg;
      if (a < seg * 0.56) p.set(cx + i, cy + j, face[k]);
      else if (a < seg * 0.7) p.set(cx + i, cy + j, tone(c, -0.62));
    }
  }
  disc(p, cx, cy, Math.max(2, (r * 0.26) | 0), STEEL_LIT, null);
  return p;
}

/** A locker or cabinet: split door with two handles. */
function locker(p, x, y, w, h, c = DARK) {
  solid(p, x, y, w, h, c, { lit: 0.2, dark: -0.24 });
  const m = x + (w >> 1);
  p.vline(m, y + 1, h - 2, tone(c, -0.38));
  p.set(m - 1, y + (h >> 1), STEEL_LIT);
  p.set(m + 1, y + (h >> 1), STEEL_LIT);
  p.hline(x + 1, y + 1, w - 2, tone(c, 0.2));
  return p;
}

/**
 * A drawer stack — filing cabinet, card catalogue, parts bins. Drawer fronts
 * are lit-and-shaded bands rather than framed boxes: the shell is outlined, so
 * the drawers are sub-details and rule 2 applies.
 */
function drawerBank(p, x, y, w, h, cols, rows, c = DARK) {
  solid(p, x, y, w, h, c, { lit: 0.2, dark: -0.24 });
  const dw = (w - 2) / cols;
  const dh = (h - 2) / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const dx = x + 1 + Math.round(i * dw);
      const dy = y + 1 + Math.round(j * dh);
      const ww = Math.round((i + 1) * dw) - Math.round(i * dw);
      const hh = Math.round((j + 1) * dh) - Math.round(j * dh);
      p.rect(dx, dy, ww, hh, c);
      p.hline(dx, dy, ww, tone(c, 0.24));
      p.hline(dx, dy + hh - 1, ww, tone(c, -0.42));
      if (i) p.vline(dx, dy, hh, tone(c, -0.34));
      if (ww >= 5 && hh >= 3) p.hline(dx + ((ww - 3) >> 1), dy + ((hh - 1) >> 1), 3, STEEL_LIT);
    }
  }
  return p;
}

/**
 * A made bed, seen from the side. The blanket is a parameter because a bed is
 * otherwise the least distinguishable object in the game — a clinic cot, a
 * family bunk and a soldier's rack are the same shape and only the bedding
 * says which room you are in.
 *
 * The pillow is NOT framed. A 1px frame on a 5x3 pillow leaves a 3x1 interior,
 * which turns the brightest and most identifying pixel group on a bed into a
 * black rectangle; it gets ink on its trailing edge only.
 *
 * Row y+th-1 is the bed's contact keyline, so callers place a bed with that row
 * ON the room's floor line — the headboard ends there too, and the legs drop
 * into the floor plate below it. `th` exists because a bed drawn 5 rows deep is
 * right in a 36-row fixture and is a stripe on the floor in an 88-row cutaway.
 */
function bed(p, x, y, w, { blanket = tone(PAL.denim, -0.24), th = 5, head = 5 } = {}) {
  const hb = Math.max(4, (w * 0.13) | 0);
  const bt = th - 2;
  solid(p, x, y - head, hb, head + th, IRON, { lit: 0.26, dark: -0.28 });
  p.rect(x + hb, y, w - hb, th, IRON);
  p.hline(x + hb, y, w - hb, tone(IRON, 0.3));
  const pw = Math.max(5, (w * 0.24) | 0);
  p.rect(x + hb, y + 1, pw, bt, tone(PAL.bone, -0.16));
  p.hline(x + hb, y + 1, pw, PAL.bone);
  p.vline(x + hb + pw, y + 1, bt, tone(PAL.bone, -0.7));
  p.rect(x + hb + pw + 1, y + 1, w - hb - pw - 2, bt, blanket);
  p.hline(x + hb + pw + 1, y + 1, w - hb - pw - 2, tone(blanket, 0.28));
  p.hline(x + hb + pw + 1, y + bt, w - hb - pw - 2, tone(blanket, -0.3));
  p.hline(x + hb, y + th - 1, w - hb, PAL.ink);
  p.vline(x + hb + 1, y + th, 2, PAL.ink);
  p.vline(x + w - 2, y + th, 2, PAL.ink);
  return p;
}

/**
 * A low military cot: bare frame, rolled blanket at the head, kit bag at the
 * foot. Row y+4 is its contact keyline, so a caller places it with y+4 on the
 * room's floor line and the legs drop into the plate below.
 */
function cot(p, x, y, w, blanket = tone(PAL.rust, -0.3)) {
  p.rect(x, y, w, 5, IRON);
  p.hline(x, y, w, tone(IRON, 0.3));
  p.rect(x + 1, y + 1, w - 2, 3, tone(PAL.bone, -0.36));
  p.hline(x + 1, y + 1, w - 2, tone(PAL.bone, -0.2));
  p.hline(x + 1, y + 3, w - 2, tone(PAL.bone, -0.54));
  p.rect(x + 1, y, 5, 4, blanket);
  p.hline(x + 1, y, 5, tone(blanket, 0.3));
  p.hline(x + 1, y + 3, 5, tone(blanket, -0.34));
  p.hline(x, y + 4, w, tone(IRON, -0.4));
  p.hline(x, y + 5, w, PAL.ink);
  p.vline(x + 1, y + 6, 2, PAL.ink);
  p.vline(x + w - 2, y + 6, 2, PAL.ink);
  return p;
}

/** A two-high bunk recessed into the wall: posts, two made berths, a rung. */
function bunkStack(p, x, y, w, h, blanket = tone(PAL.denim, -0.24)) {
  p.rect(x, y, w, h, tone(PAL.deep, 0.04));
  p.frame(x, y, w, h, PAL.ink);
  p.vline(x + 1, y + 1, h - 2, tone(STEEL, 0.1));
  p.vline(x + w - 2, y + 1, h - 2, tone(STEEL, -0.4));
  const bh = clamp((h * 0.3) | 0, 5, 9);
  for (const dy of [2, h - 2 - bh]) {
    p.rect(x + 2, y + dy, w - 4, bh, IRON);
    p.hline(x + 2, y + dy, w - 4, tone(IRON, 0.3));
    const pw = Math.max(4, (w * 0.24) | 0);
    p.rect(x + 2, y + dy + 1, pw, bh - 2, tone(PAL.bone, -0.16));
    p.hline(x + 2, y + dy + 1, pw, PAL.bone);
    p.rect(x + 3 + pw, y + dy + 1, w - 5 - pw, bh - 2, blanket);
    p.hline(x + 3 + pw, y + dy + 1, w - 5 - pw, tone(blanket, 0.3));
    p.hline(x + 3 + pw, y + dy + bh - 2, w - 5 - pw, tone(blanket, -0.32));
    p.vline(x + 2 + pw, y + dy + 1, bh - 2, tone(PAL.bone, -0.66));
    p.hline(x + 2, y + dy + bh - 1, w - 4, PAL.ink);
  }
  // The ladder rung between the berths is a bright bar on its own shadow, not
  // on a keyline: it is inside the recess, and the recess is already outlined.
  const mid = y + 1 + bh + (((h - 2 - bh * 2) >> 1) | 0);
  p.hline(x + 2, mid, w - 4, STEEL_LIT);
  p.hline(x + 2, mid + 1, w - 4, tone(STEEL, -0.55));
  return p;
}

/**
 * A hanging env-suit. Amber, because amber does all the warm work.
 *
 * All the shaping is done in tone inside one outline: a yoke seam under the
 * shoulders, a chest pocket, the regulator, a rust belt, an inseam and dark
 * boots. Splitting the torso and legs into two outlined shapes would read no
 * better and would cost a second keyline on the tallest object in the set —
 * without the shaping it is a flat amber slab, which is what it was.
 */
function suitHang(p, x, y, w, h) {
  const hx = x + ((w - 5) >> 1);
  p.hline(hx + 1, y, 3, PAL.ink);
  p.rect(hx, y + 1, 5, 3, STEEL_LIT);
  p.hline(hx + 1, y + 1, 3, tone(PAL.steelLit, 0.2));
  p.rect(hx + 1, y + 2, 3, 2, GLASS);
  p.hline(hx + 1, y + 2, 3, tone(PAL.verdigris, -0.2));
  p.set(hx, y + 1, PAL.ink);
  p.set(hx + 4, y + 1, PAL.ink);
  p.vline(hx, y + 2, 2, PAL.ink);
  p.vline(hx + 4, y + 2, 2, PAL.ink);

  // The silhouette is drawn row by row rather than as a box, because the whole
  // difference between a hung suit and an amber wardrobe is the outline:
  // chamfered shoulders, a torso, a step in at the waist, narrower legs.
  const ty = y + 4;
  const bh = h - 4;
  const waist = (bh * 0.44) | 0;
  const legIn = 2;
  for (let j = 0; j < bh; j++) {
    const in0 = Math.max(j < 2 ? 1 : 0, j > waist ? legIn : 0);
    const x0 = x + in0;
    const x1 = x + w - 1 - in0;
    p.hline(x0, ty + j, x1 - x0 + 1, AMBER);
    p.set(x0 + 1, ty + j, tone(AMBER, 0.2));
    p.set(x1 - 1, ty + j, tone(AMBER, -0.32));
    p.set(x0, ty + j, PAL.ink);
    p.set(x1, ty + j, PAL.ink);
  }
  p.hline(x + 1, ty, w - 2, PAL.ink);
  p.hline(x + 2, ty + 1, w - 4, tone(AMBER, 0.3));
  p.hline(x + legIn, ty + bh - 1, w - legIn * 2, PAL.ink);
  p.hline(x, ty + waist + 1, legIn + 1, PAL.ink);
  p.hline(x + w - 1 - legIn, ty + waist + 1, legIn + 1, PAL.ink);

  p.hline(x + 1, ty + 3, w - 2, tone(AMBER, -0.44));
  inner(p, x + 2, ty + 5, 4, 4, tone(AMBER, -0.3));
  inner(p, x + w - 5, ty + 5, 3, 3, tone(PAL.verdigris, -0.16));
  p.vline(hx + 2, ty, 2, tone(STEEL, -0.36));
  p.hline(x + 1, ty + waist - 1, w - 2, tone(PAL.rust, -0.24));
  p.hline(x + 1, ty + waist, w - 2, tone(PAL.rust, -0.56));
  p.vline(x + (w >> 1), ty + waist + 2, bh - waist - 5, tone(AMBER, -0.52));
  p.rect(x + legIn + 1, ty + bh - 4, w - legIn * 2 - 2, 3, tone(PAL.rust, -0.5));
  p.hline(x + legIn + 1, ty + bh - 4, w - legIn * 2 - 2, tone(PAL.rust, -0.34));
  return p;
}

/** Cart rails with sleepers. Runs edge to edge; the track is the tunnel. */
function rails(p, x, y, w) {
  p.hline(x, y, w, STEEL_LIT);
  p.hline(x, y + 1, w, PAL.ink);
  for (let i = x + ((4 - (x % 4)) % 4); i < x + w; i += 4) p.rect(i, y + 2, 2, 1, RUST_DK);
  return p;
}

/** A ladder: two thin rails with daylight between them, and bright rungs. */
function ladder(p, x, y, w, h) {
  p.vline(x, y, h, tone(STEEL, 0.24));
  p.vline(x + 1, y, h, PAL.ink);
  p.vline(x + w - 2, y, h, tone(STEEL, -0.2));
  p.vline(x + w - 1, y, h, PAL.ink);
  for (let j = y + 3; j < y + h - 1; j += 5) {
    p.hline(x + 2, j, w - 4, STEEL_LIT);
    p.hline(x + 2, j + 1, w - 4, PAL.ink);
  }
  return p;
}

/**
 * An I-beam. Deliberately NOT a box with rungs in it — that is a ladder, and
 * the first draft's mine timbering, radio mast and maintenance ladder were all
 * the same silhouette. Wide flanges, a narrow web, bolt plates at the ends.
 */
function ibeam(p, x, y, w, h, c = DARK) {
  solid(p, x, y, w, h, c, { lit: 0.24, dark: -0.28 });
  const web = tone(c, -0.4);
  for (let j = y + 4; j < y + h - 4; j++) {
    p.set(x + 1, j, web);
    p.set(x + w - 2, j, web);
  }
  p.hline(x + 1, y + 3, w - 2, web);
  p.hline(x + 1, y + h - 4, w - 2, web);
  p.hline(x + 1, y + 4, w - 2, tone(c, 0.24));
  rivets(p, x + 2, y + 1, Math.max(1, (w - 3) >> 1), 2, tone(c, 0.34));
  return p;
}

/**
 * A ragged rock face. Strata in offset segments, ragged on BOTH edges, with
 * the ore in visible seams — this room's whole output is ore, and a dusting of
 * dark specks is not a cue.
 */
function rockface(p, x, y, w, h, seed = 'rock') {
  const r = rng(seed);
  const base = tone(PAL.concrete, -0.44);
  for (let j = 0; j < h; j++) {
    const bl = (r() * 4) | 0;
    const br = (r() * 3) | 0;
    p.hline(x + bl, y + j, w - bl - br, base);
    p.set(x + bl, y + j, PAL.ink);
    p.set(x + bl + 1, y + j, tone(base, 0.22));
    p.set(x + w - 1 - br, y + j, PAL.ink);
  }
  for (let j = 3; j < h - 2; j += 4 + ((r() * 4) | 0)) {
    let i = 3 + ((r() * 4) | 0);
    while (i < w - 4) {
      const seg = 4 + ((r() * 9) | 0);
      seam(p, x + i, y + j, Math.min(seg, w - 4 - i), base, -0.45);
      i += seg + 2 + ((r() * 4) | 0);
    }
  }
  p.speckle(x + 4, y + 2, w - 8, h - 4, tone(base, -0.3), 0.05, seed + ':grit');
  for (let k = 0; k < 4; k++) {
    const ox = x + 5 + ((r() * (w - 12)) | 0);
    const oy = y + 4 + ((r() * (h - 9)) | 0);
    p.hline(ox, oy, 3 + ((r() * 3) | 0), tone(PAL.sodium, -0.46));
    p.hline(ox + 1, oy + 1, 2 + ((r() * 3) | 0), tone(PAL.sodium, -0.3));
    p.set(ox + 1, oy, tone(PAL.sodium, -0.05));
  }
  return p;
}

/**
 * A sheriff's star on a backing disc — the only thing that identifies the
 * sheriff's office, since a desk, a noticeboard and a filing cabinet are
 * generic. Rasterised from the five-pointed polygon at whatever r it is given:
 * a fixed 5px glyph vanished inside a 21px disc, and a thin plus with four
 * corner pixels — which is what replaced it — reads as a sunburst, not a badge.
 */
function star(p, cx, cy, r, c = AMBER) {
  disc(p, cx, cy, r, tone(PAL.bone, -0.3));
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rad = k % 2 ? r * 0.46 : r - 0.5;
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      let inside = false;
      for (let a = 0, b = 9; a < 10; b = a++) {
        const [xa, ya] = pts[a];
        const [xb, yb] = pts[b];
        if ((ya > j) !== (yb > j) && i < ((xb - xa) * (j - ya)) / (yb - ya) + xa) inside = !inside;
      }
      if (inside) p.set(cx + i, cy + j, i + j < -r * 0.35 ? tone(c, 0.28) : i + j > r * 0.55 ? tone(c, -0.24) : c);
    }
  }
  return p;
}

// ------------------------------------------------------- fixture scaffolding ---

const FX_W = 64;
const FX_H = 36;
const FX_LINE = 32; // the ink contact line: everything in the room stands on it

/**
 * The floor plate and overhead conduit every fixture shares.
 *
 * Both run edge to edge, which is what makes a two- or three-bay room read as
 * one continuous space: the renderer draws the SAME 64px frame once per bay,
 * so anything that touches x=0 and x=63 at the same y tiles seamlessly. The
 * collar spacing is 16 because 16 divides 64 — at 19 the run stuttered at
 * every bay seam and clipped a collar in half at x=63.
 *
 * The conduit's keyline goes underneath it, never on top: the renderer washes
 * the top rows of every fixture with lamp light, so an ink row up there sits
 * inside the wash and is lost, while a highlight reads as the lamp catching the
 * pipe. It is four rows deep rather than three for the same reason a keyline is
 * only worth drawing around something big — one ink row serving four rows of
 * duct is half the cost of one serving two.
 *
 * Row 32 is ink and is the contact line for the whole sprite — the keyline
 * every object standing on the floor would otherwise have to draw for itself.
 * A citizen sprite's feet land on row 33, the plate's lit face.
 *
 * So an object standing on the floor ENDS ON ROW 32, not on row 31. Ending a
 * row short leaves its own bottom keyline sitting directly above this one: a
 * 2px black band under every machine in the silo, and, across the set, several
 * hundred pixels of keyline drawn twice.
 */
function ground(p, seed, o = {}) {
  const W = p.w;
  const H = p.h;
  p.hline(0, FX_LINE, W, PAL.ink);
  p.rect(0, FX_LINE + 1, W, H - FX_LINE - 1, CONC);
  p.hline(0, FX_LINE + 1, W, tone(CONC, 0.28));
  p.hline(0, H - 1, W, tone(CONC, -0.24));
  for (let i = o.seam ?? 8; i < W; i += 16) p.vline(i, H - 2, 2, tone(CONC, -0.36));
  p.speckle(0, FX_LINE + 1, W, H - FX_LINE - 1, RUST_DK, o.grime ?? 0.05, seed + ':grime');
  if (o.conduit !== false) {
    pipeh(p, 0, 1, W, 4, o.conduitColor ?? DARK);
    for (let i = 8; i < W; i += 16) collarH(p, i, 1, 4);
  }
  return p;
}

// ------------------------------------------------------- cutaway scaffolding ---

const CUT_W = 128;
const CUT_H = 88;
const CUT_FLOOR = 78; // the ink contact line; contents stand on it

/** Block coursing with offset rows and a few lighter and darker blocks. */
function courses(p, x, y, w, h, c, seed, bw = 13, bh = 7) {
  p.rect(x, y, w, h, c);
  const r = rng(seed);
  let row = 0;
  for (let j = y; j < y + h; j += bh, row++) {
    const off = (row % 2) * ((bw / 2) | 0);
    for (let i = x - off; i < x + w; i += bw) {
      const v = r();
      const t = v > 0.86 ? 0.07 : v < 0.14 ? -0.08 : 0;
      if (!t) continue;
      const bx = Math.max(x, i + 1);
      const bwid = Math.min(i + bw, x + w) - bx;
      if (bwid > 0) p.rect(bx, j + 1, bwid, Math.min(bh - 1, y + h - j - 1), tone(c, t));
    }
    p.hline(x, j, w, tone(c, -0.18));
    for (let i = x - off; i < x + w; i += bw) {
      if (i >= x) p.vline(i, j, Math.min(bh, y + h - j), tone(c, -0.18));
    }
  }
  return p;
}

/** The cone of light under a ceiling fixture, dithered so it stays on-palette. */
function coneGlow(p, cx, y, w, h, base, amt = 0.2) {
  const hi = tone(base, amt);
  const warm = tone(PAL.sodium, -0.52);
  for (let j = 0; j < h; j++) {
    const half = Math.max(1, Math.round((w / 2) * (0.3 + 0.7 * (j / h))));
    for (let i = -half; i <= half; i++) {
      const x = cx + i;
      const t = (1 - j / h) * (1 - Math.abs(i) / (half + 1));
      if (t > (DITHER[j & 3][x & 3] + 0.5) / 16) p.set(x, y + j, t > 0.72 ? warm : hi);
    }
  }
  return p;
}

/**
 * The chamfered vault every cutaway sits in: block coursing behind, cut
 * corners, a lighter floor band, one amber ceiling fixture and its spill.
 *
 * lib.mjs has vault(), but it fills the wall flat; the reference wall is
 * coursed, so this lays bricks first and then masks the chamfer back out.
 * `rock:true` swaps the coursing for bare cut stone, because a mine is the one
 * room in the silo that is not a finished bunker.
 */
function vaultShell(p, seed, o = {}) {
  const W = p.w;
  const H = p.h;
  const chamfer = o.chamfer ?? 14;
  const floorH = o.floor ?? CUT_H - CUT_FLOOR;
  const wall = o.wall ?? CONC;
  const top = H - floorH;

  p.rect(0, 0, W, H, VOID);
  if (o.rock) {
    p.rect(0, 0, W, top, tone(wall, -0.16));
    p.speckle(0, 0, W, top, tone(wall, -0.36), 0.1, seed + ':stone');
    p.speckle(0, 0, W, top, tone(wall, 0.08), 0.05, seed + ':stone2');
  } else {
    courses(p, 0, 0, W, top, wall, seed + ':bricks');
  }
  fade(p, 0, top - 16, W, 16, tone(wall, -0.3), 0.85);

  const lx = o.lightX ?? W >> 1;
  coneGlow(p, lx, 4, o.coneW ?? 52, 30, wall);

  for (let j = 0; j < chamfer; j++) {
    const cut = chamfer - j;
    p.hline(0, j, cut, VOID);
    p.hline(W - cut, j, cut, VOID);
    p.set(cut, j, PAL.ink);
    p.set(W - 1 - cut, j, PAL.ink);
    p.set(cut + 1, j, tone(wall, 0.2));
    p.set(W - 2 - cut, j, tone(wall, -0.24));
  }
  p.hline(chamfer, 0, W - chamfer * 2, PAL.ink);
  p.hline(chamfer + 1, 1, W - chamfer * 2 - 2, tone(wall, 0.2));
  p.vline(1, chamfer, top - chamfer, tone(wall, 0.18));
  p.vline(W - 2, chamfer, top - chamfer, tone(wall, -0.24));

  p.rect(0, top, W, floorH, tone(wall, 0.14));
  p.hline(0, top, W, PAL.ink);
  p.hline(0, top + 1, W, tone(wall, 0.3));
  const r = rng(seed + ':floor');
  for (let i = 8; i < W; i += 17) p.vline(i + ((r() * 4) | 0), top + 2, floorH - 3, tone(wall, -0.16));
  p.speckle(0, top + 2, W, floorH - 3, tone(wall, -0.26), 0.05, seed + ':dust');

  p.vline(0, chamfer, H - chamfer, PAL.ink);
  p.vline(W - 1, chamfer, H - chamfer, PAL.ink);
  p.hline(0, H - 1, W, PAL.ink);

  p.speckle(1, top - 12, 18, 12, RUST_DK, 0.11, seed + ':g1');
  p.speckle(W - 19, top - 12, 18, 12, RUST_DK, 0.09, seed + ':g2');

  if (o.light !== false) {
    p.vline(lx, 0, 2, PAL.ink);
    p.ceilingLight(lx, 1, o.lightW ?? 15);
  }
  return { top, chamfer };
}

/** A service pipe run along the back wall, with union collars. */
function wallPipes(p, y, x, w, c = STEEL, thick = 3, step = 21) {
  pipeh(p, x, y, w, thick, c);
  for (let i = x + 6; i < x + w - 3; i += step) collarH(p, i, y, thick);
  return p;
}

// =============================================================================
// FIXTURES — 64x36, transparent. Three or four strong shapes each.
//
// Every room wider than one slot carries at least one element that runs from
// x=0 to x=63 at a fixed row, because the renderer repeats this same frame per
// bay: without one, a two-bay room reads as two 64px dioramas with a dead
// gutter between them. ground() supplies the conduit and the floor; each room
// below adds one more at working height. The self-test counts them.
// =============================================================================

const FIXTURE_ART = {
  // Two engine blocks slung under a bus bar, inspection ports lit, exhaust up
  // into the overhead run. The bar is the element that ties the bays together.
  generator_hall(p, s) {
    ground(p, s);
    ledge(p, 0, 6, FX_W, 3, DARK, { caps: false });
    for (let i = 0; i < 2; i++) {
      const x = 2 + i * 31;
      pipev(p, x + 8, 10, 4, 2, tone(PAL.rust, -0.2));
      solid(p, x, 13, 29, 20, IRON, { lit: 0.26, dark: -0.3 });
      port(p, x + 2, 16, 13, 10, AMBER_DIM);
      p.rect(x + 4, 18, 9, 6, AMBER);
      p.hline(x + 4, 18, 9, tone(AMBER, 0.42));
      // The flywheel's rim is a dark tone, not a keyline: it lives inside the
      // block's outline, so an ink annulus here is a ring of lace.
      disc(p, x + 21, 21, 5, tone(STEEL, -0.12), tone(IRON, -0.3));
      ring(p, x + 21, 21, 2, tone(STEEL, -0.44));
      inner(p, x + 2, 28, 25, 3, tone(IRON, -0.2));
      rivets(p, x + 3, 29, 7, 4, tone(IRON, 0.34));
    }
  },

  // Shielded containment with the one legal use of toxin green in the silo,
  // flanked by hazard-striped shield blocks on a coolant header.
  reactor(p, s) {
    ground(p, s, { conduit: false });
    pipeh(p, 0, 3, FX_W, 3, tone(PAL.verdigris, -0.26));
    for (let i = 8; i < FX_W; i += 16) collarH(p, i, 3, 3);
    solid(p, 0, 12, 11, 20, CONC, { lit: 0.2, dark: -0.26 });
    solid(p, 53, 12, 11, 20, CONC, { lit: 0.2, dark: -0.26 });
    hazardBand(p, 2, 15, 7, 6);
    hazardBand(p, 55, 15, 7, 6);
    pipev(p, 11, 8, 22, 2, tone(PAL.verdigris, -0.26));
    pipev(p, 50, 8, 22, 2, tone(PAL.verdigris, -0.26));
    const v = tube(p, 15, 8, 34, 24, DARK);
    port(p, v.x, 12, v.w, 16, tone(PAL.toxin, -0.34));
    p.rect(v.x + 2, 14, v.w - 4, 12, PAL.toxin);
    p.rect(v.x + 4, 16, v.w - 8, 8, tone(PAL.toxin, 0.3));
    p.rect(v.x + 6, 18, v.w - 12, 4, tone(PAL.toxin, 0.58));
    for (let j = 13; j < 27; j += 3) p.hline(v.x + 1, j, v.w - 2, tone(PAL.toxin, -0.3));
    inner(p, 16, 28, 32, 3, tone(DARK, -0.28));
    rivets(p, 17, 29, 8, 4, tone(DARK, 0.3));
  },

  // Two closed-loop tanks hung off one transfer main, with a sight glass and a
  // waterline in each. The main runs the full width: reclamation is a circuit.
  water_reclaimer(p, s) {
    ground(p, s, { conduitColor: tone(PAL.verdigris, -0.34) });
    pipeh(p, 0, 8, FX_W, 3, STEEL);
    for (let i = 8; i < FX_W; i += 16) collarH(p, i, 8, 3);
    const a = tube(p, 1, 14, 30, 19, STEEL);
    port(p, a.x, 17, a.w, 13, tone(PAL.verdigris, -0.28));
    p.hline(a.x + 1, 20, a.w - 2, tone(PAL.verdigris, 0.44));
    p.hline(a.x + 1, 21, a.w - 2, tone(PAL.verdigris, 0.14));
    motes(p, a.x + 1, 23, a.w - 2, 6, tone(PAL.verdigris, 0.34), 5, s + ':bub');
    const b = tube(p, 34, 17, 22, 16, STEEL);
    port(p, b.x, 20, b.w, 10, tone(PAL.verdigris, -0.28));
    p.hline(b.x + 1, 23, b.w - 2, tone(PAL.verdigris, 0.44));
    pipev(p, 16, 12, 3, 2, STEEL);
    pipev(p, 44, 12, 6, 2, STEEL);
    // The return riser: a full-height standpipe off the main with its handwheel
    // where the two meet, rather than a wheel on a stick.
    pipev(p, 58, 12, 21, 3, STEEL);
    wheel(p, 59, 16, 4);
    motes(p, 6, 10, 12, 3, tone(PAL.bone, -0.3), 4, s + ':vapour');
  },

  // Two tiers of greens under sodium grow bars. Everything runs edge to edge,
  // so a two-bay farm is one long rack rather than two crates of salad.
  hydroponics(p, s) {
    ground(p, s, { conduit: false });
    for (let k = 0; k < 2; k++) {
      const y = 3 + k * 14;
      lampBar(p, 0, y, FX_W, AMBER, 2, false);
      canopy(p, 0, y + 6, FX_W, 5, LEAF, `${s}:row${k}`);
      ledge(p, 0, y + 11, FX_W, 2, tone(STEEL, -0.22), { caps: false });
    }
    pipev(p, 2, 6, 24, 2, tone(PAL.verdigris, -0.28));
    for (let k = 0; k < 3; k++) collarV(p, 2, 9 + k * 8, 2);
  },

  // Squat agitated vats under a feed header: motor housings on top, a sludge
  // sight window. Wide and low, so they never read as the reclaimer's towers.
  protein_vats(p, s) {
    ground(p, s);
    pipeh(p, 0, 7, FX_W, 2, STEEL);
    for (let i = 8; i < FX_W; i += 16) collarH(p, i, 7, 2);
    for (let i = 0; i < 2; i++) {
      const x = 1 + i * 32;
      pipev(p, x + 14, 10, 3, 2, STEEL);
      solid(p, x + 8, 12, 14, 6, DARK, { lit: 0.26, dark: -0.3 });
      const v = tube(p, x, 17, 30, 16, tone(STEEL, -0.3));
      port(p, v.x, 20, v.w, 10, tone(SLUDGE, -0.2));
      p.hline(v.x + 1, 23, v.w - 2, tone(SLUDGE, 0.26));
      motes(p, v.x + 1, 25, v.w - 2, 4, tone(SLUDGE, 0.44), 5, `${s}:b${i}`);
      tap(p, x + 26, 24);
    }
  },

  // One big impeller in its housing and two louvred filter cassettes — one of
  // them visibly loaded — hung under a full-width duct.
  air_filtration(p, s) {
    ground(p, s, { conduit: false });
    ledge(p, 0, 2, FX_W, 5, DARK, { caps: false });
    for (let i = 8; i < FX_W; i += 16) p.vline(i, 3, 4, tone(DARK, -0.35));
    solid(p, 1, 10, 30, 22, DARK, { lit: 0.22, dark: -0.26 });
    impeller(p, 16, 21, 9, STEEL);
    pipev(p, 15, 8, 3, 2, STEEL);
    for (let k = 0; k < 2; k++) {
      const x = 34 + k * 15;
      const dirty = k === 1;
      solid(p, x, 10, 14, 22, tone(STEEL, dirty ? -0.4 : -0.16), { lit: 0.2, dark: -0.26 });
      for (let j = 13; j < 29; j += 3) p.hline(x + 2, j, 10, tone(STEEL, -0.5));
      for (let j = 14; j < 29; j += 3) p.hline(x + 2, j, 10, tone(STEEL, dirty ? -0.3 : 0.02));
      if (dirty) p.speckle(x + 2, 18, 10, 11, RUST_DK, 0.3, `${s}:clog`);
      inner(p, x + 4, 29, 6, 2, STEEL_LIT);
    }
  },

  // Two stacks of bunks either side of a closed cabin door, under the
  // services duct that runs the length of the residential floor.
  residences(p, s) {
    ground(p, s);
    ledge(p, 0, 6, FX_W, 3, DARK, { caps: false });
    bunkStack(p, 1, 12, 23, 21);
    bunkStack(p, 40, 12, 23, 21);
    solid(p, 26, 12, 12, 21, DARK, { lit: 0.2, dark: -0.26 });
    inner(p, 28, 15, 8, 16, tone(STEEL, -0.26));
    p.vline(31, 15, 16, tone(STEEL, -0.46));
    p.set(30, 23, STEEL_LIT);
    p.set(32, 23, STEEL_LIT);
    inner(p, 28, 10, 8, 2, AMBER);
    spill(p, 27, 12, 10, 3, tone(AMBER, -0.5), 0.5);
  },

  // Serving counter under heat lamps, and the mess table — which runs the full
  // width, because one long table across the bays is what a canteen is.
  cafeteria(p, s) {
    ground(p, s);
    ledge(p, 0, 6, FX_W, 2, tone(PAL.rust, -0.4), { caps: false });
    lampBar(p, 2, 9, 26, AMBER, 3);
    solid(p, 1, 17, 28, 16, WOOD, { lit: 0.24, dark: -0.28 });
    p.rect(2, 18, 26, 2, tone(PAL.bone, -0.3));
    p.hline(2, 18, 26, tone(PAL.bone, -0.05));
    for (let k = 0; k < 3; k++) inner(p, 4 + k * 8, 21, 6, 4, tone(STEEL, 0.06));
    ledge(p, 32, 21, 32, 3, WOOD_LIT, { caps: false });
    for (let k = 0; k < 3; k++) {
      const x = 36 + k * 10;
      inner(p, x, 25, 6, 3, IRON);
      leg(p, x + 2, 28, 4, IRON);
      p.rect(x + 1, 19, 4, 2, tone(PAL.bone, -0.2));
      p.hline(x + 1, 19, 4, PAL.bone);
      p.hline(x + 1, 21, 4, PAL.ink);
    }
    leg(p, 34, 25, 7, WOOD);
    leg(p, 61, 25, 7, WOOD);
  },

  // Two beds under a curtain rail, the vitals monitor, and the drug cabinet
  // with its red cross — the one prop that says clinic and not dormitory.
  //
  // The instrument trolley is on the LEFT and the beds are pushed right,
  // because the renderer paints the level pips at 60% bone across the
  // bottom-left strip and a bed puts its pillow — the palest thing in the
  // room — exactly there. Dark kit under the pips, pale linen away from them.
  clinic(p, s) {
    ground(p, s);
    ledge(p, 0, 6, FX_W, 2, STEEL, { caps: false });
    for (let i = 4; i < FX_W; i += 8) p.set(i, 6, tone(STEEL, -0.5));
    deskPanel(p, 1, 10, 18, 13, LEAF);
    solid(p, 1, 25, 15, 8, DARK, { lit: 0.2, dark: -0.26 });
    p.hline(3, 28, 11, tone(STEEL, 0.1));
    p.hline(3, 29, 11, tone(STEEL, -0.5));
    for (let k = 0; k < 3; k++) p.set(4 + k * 4, 27, tone(PAL.bone, -0.2));
    disc(p, 4, 32, 2, tone(PAL.deep, 0.04), null);
    disc(p, 13, 32, 2, tone(PAL.deep, 0.04), null);
    solid(p, 45, 10, 17, 15, tone(PAL.bone, -0.32), { lit: 0.22, dark: -0.26 });
    p.rect(52, 13, 3, 9, tone(PAL.rust, 0.02));
    p.rect(49, 16, 9, 3, tone(PAL.rust, 0.02));
    p.hline(46, 26, 15, tone(PAL.bone, -0.5));
    p.hline(46, 27, 15, PAL.ink);
    bed(p, 18, 28, 21, { blanket: tone(PAL.verdigris, 0.02) });
    bed(p, 41, 28, 22, { blanket: tone(PAL.verdigris, 0.02) });
    p.vline(40, 12, 20, PAL.ink);
    p.vline(39, 12, 20, STEEL_LIT);
    inner(p, 38, 9, 5, 4, tone(PAL.bone, -0.12));
    p.rect(39, 10, 3, 2, tone(PAL.verdigris, 0.16));
  },

  // Fume hood, distillation column, and the bench that says what this room is
  // FOR: a rack of amber medicine vials and a stack of filter cartridges.
  chem_lab(p, s) {
    ground(p, s);
    pipeh(p, 0, 6, FX_W, 2, tone(PAL.verdigris, -0.34));
    for (let i = 8; i < FX_W; i += 16) collarH(p, i, 6, 2);
    solid(p, 1, 10, 26, 23, DARK, { lit: 0.22, dark: -0.26 });
    port(p, 3, 13, 22, 14, GLASS);
    inner(p, 6, 17, 5, 9, tone(PAL.verdigris, 0.1));
    inner(p, 15, 19, 5, 7, tone(PAL.rust, 0.1));
    motes(p, 5, 15, 18, 3, tone(PAL.bone, -0.36), 5, s + ':fume');
    inner(p, 3, 29, 22, 3, tone(DARK, -0.3));
    const col = tube(p, 30, 8, 11, 25, STEEL);
    for (const y of [13, 19, 25]) {
      p.hline(col.x - 1, y, col.w + 2, tone(STEEL, 0.2));
      p.hline(col.x - 1, y + 1, col.w + 2, tone(STEEL, -0.44));
    }
    tap(p, 35, 28);
    ledge(p, 44, 24, 20, 3, WOOD_LIT, { caps: false });
    leg(p, 46, 28, 4, WOOD);
    leg(p, 61, 28, 4, WOOD);
    solid(p, 44, 14, 10, 10, DARK, { lit: 0.2, dark: -0.26 });
    for (let k = 0; k < 3; k++) {
      p.rect(46 + k * 3, 16, 2, 6, tone(PAL.sodium, -0.24));
      p.set(46 + k * 3, 16, tone(PAL.sodium, 0.2));
    }
    for (let k = 0; k < 3; k++) {
      p.rect(56, 15 + k * 3, 7, 2, tone(PAL.bone, -0.3));
      p.hline(56, 15 + k * 3, 7, tone(PAL.bone, -0.05));
      p.hline(56, 17 + k * 3, 7, PAL.ink);
    }
  },

  // Pegboard, a bench that runs the whole floor, and the rack of finished
  // parts this room exists to produce, with the scrap it eats beneath it.
  workshop(p, s) {
    ground(p, s);
    solid(p, 1, 7, 27, 13, DARK, { lit: 0.2, dark: -0.24 });
    const r = rng(s + ':tools');
    for (let k = 0; k < 6; k++) {
      const x = 4 + k * 4;
      const h = 4 + ((r() * 6) | 0);
      p.vline(x, 9, h, r() < 0.5 ? STEEL_LIT : tone(PAL.rust, 0.05));
      p.vline(x + 1, 9, h, tone(DARK, -0.4));
    }
    solid(p, 35, 7, 28, 15, DARK, { lit: 0.2, dark: -0.24 });
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 5; k++) {
        const c = (j + k) % 3 ? tone(STEEL, 0.12) : tone(PAL.rust, 0.04);
        p.rect(37 + k * 5, 9 + j * 4, 4, 2, c);
        p.hline(37 + k * 5, 9 + j * 4, 4, tone(c, 0.24));
      }
      p.hline(36, 11 + j * 4, 26, tone(DARK, -0.4));
    }
    ledge(p, 0, 23, FX_W, 4, WOOD_LIT, { caps: false });
    leg(p, 3, 28, 4, WOOD);
    leg(p, 30, 28, 4, WOOD);
    leg(p, 59, 28, 4, WOOD);
    solid(p, 8, 19, 7, 4, STEEL, { lit: 0.24, dark: -0.28 });
    crate(p, 38, 23, 14, 9, tone(PAL.rust, -0.42));
    p.rect(41, 25, 8, 2, tone(STEEL, -0.24));
    sparks(p, 16, 20, 6, 4, 4, s + ':grind');
  },

  // Salvage in at the hopper, along the belt that runs the length of the floor,
  // into the crusher — and the fuel it renders down standing under the belt,
  // because this room is the only fuel source above the Deeps and the art had
  // never said so.
  recycling(p, s) {
    ground(p, s);
    const r = rng(s + ':junk');
    const junk = () => [tone(PAL.rust, -0.06), tone(STEEL, -0.14), tone(PAL.verdigris, -0.3), WOOD][(r() * 4) | 0];
    // The intake hopper, heaped over its rim and tapering into the chute. A
    // rectangle with a rectangle inside it — which is what this was — reads as
    // a picture frame, and said nothing about what the room takes in.
    for (let k = 0; k < 5; k++) {
      const w = 4 + ((r() * 4) | 0);
      const x = 2 + ((r() * 15) | 0);
      solid(p, x, 4 + ((r() * 3) | 0), Math.min(w, 22 - x), 7, junk(), { lit: 0.24, dark: -0.28 });
    }
    for (let j = 0; j < 13; j++) {
      const in0 = j < 6 ? 0 : Math.min(7, (j - 5) * 2);
      const x0 = 1 + in0;
      const x1 = 22 - in0;
      p.hline(x0, 9 + j, x1 - x0 + 1, tone(STEEL, -0.44));
      p.set(x0 + 1, 9 + j, tone(STEEL, -0.16));
      p.set(x1 - 1, 9 + j, tone(STEEL, -0.58));
      p.set(x0, 9 + j, PAL.ink);
      p.set(x1, 9 + j, PAL.ink);
    }
    p.hline(1, 8, 22, PAL.ink);
    p.hline(2, 9, 20, tone(STEEL, -0.1));
    for (let k = 0; k < 3; k++) {
      const w = 3 + ((r() * 3) | 0);
      const x = 4 + ((r() * 12) | 0);
      solid(p, x, 10, Math.min(w, 20 - x), 4, junk(), { lit: 0.24, dark: -0.28 });
    }
    // The belt, and what is riding it.
    for (let k = 0; k < 4; k++) {
      const w = 4 + ((r() * 4) | 0);
      const h = 3 + ((r() * 4) | 0);
      solid(p, 18 + k * 7, 22 - h, w, h, junk(), { lit: 0.24, dark: -0.28 });
    }
    ledge(p, 0, 22, FX_W, 4, DARK, { caps: false });
    for (let i = 3; i < FX_W; i += 8) {
      p.vline(i, 23, 3, STEEL_LIT);
      p.vline(i + 1, 23, 3, tone(STEEL, -0.44));
    }
    // The crusher: a lit mouth with the rollers in it, not a cabinet.
    solid(p, 44, 7, 20, 26, IRON, { lit: 0.22, dark: -0.26 });
    port(p, 46, 10, 16, 12, tone(PAL.rust, -0.62));
    for (let k = 0; k < 2; k++) {
      const cy = 12 + k * 5;
      p.rect(47, cy, 14, 3, tone(STEEL, -0.3));
      p.hline(47, cy, 14, tone(STEEL, 0.1));
      for (let i = 48 + k * 2; i < 61; i += 4) p.vline(i, cy + 1, 2, tone(STEEL, 0.26));
    }
    sparks(p, 48, 15, 12, 4, 5, s + ':grind');
    inner(p, 46, 27, 16, 3, tone(IRON, -0.3));
    p.hline(48, 28, 12, tone(PAL.sodium, -0.3));
    // Fuel out: the decanting drum stands under the belt, with its sight glass.
    drum(p, 30, 27, 10, 6, tone(PAL.verdigris, -0.3));
    p.rect(34, 29, 3, 3, AMBER);
    p.hline(34, 29, 3, tone(AMBER, 0.4));
    leg(p, 4, 27, 6, IRON);
    leg(p, 24, 27, 6, IRON);
  },

  // Furnace with a lit mouth under a smoke hood, and the crucible pouring into
  // its moulds. The hood runs the width: the whole floor is one heat.
  foundry(p, s) {
    ground(p, s, { conduitColor: tone(PAL.rust, -0.34) });
    ledge(p, 0, 6, FX_W, 3, tone(PAL.rust, -0.5), { caps: false });
    pipev(p, 12, 9, 3, 3, tone(PAL.rust, -0.28));
    solid(p, 1, 12, 27, 21, tone(PAL.rust, -0.44), { lit: 0.2, dark: -0.26 });
    port(p, 4, 16, 17, 13, AMBER_DIM);
    p.rect(6, 18, 13, 9, AMBER);
    p.rect(9, 20, 7, 5, tone(AMBER, 0.5));
    rivets(p, 3, 31, 7, 4, tone(PAL.rust, 0.06));
    solid(p, 35, 11, 20, 11, IRON, { lit: 0.22, dark: -0.26 });
    inner(p, 37, 13, 16, 5, AMBER);
    p.vline(44, 22, 6, AMBER);
    p.vline(45, 22, 6, tone(AMBER, 0.45));
    p.vline(46, 22, 6, tone(AMBER, -0.2));
    sparks(p, 41, 23, 9, 6, 6, s + ':pour');
    for (let k = 0; k < 3; k++) {
      solid(p, 37 + k * 9, 28, 8, 4, DARK, { lit: 0.2, dark: -0.26 });
      p.rect(38 + k * 9, 29, 6, 1, k === 1 ? AMBER : tone(AMBER, -0.62));
    }
  },

  // The press, a rack of loaded brass, and crates of finished rounds on a
  // bench that runs the length of the line.
  munitions(p, s) {
    ground(p, s);
    solid(p, 1, 6, 24, 23, DARK, { lit: 0.22, dark: -0.26 });
    port(p, 4, 10, 18, 13, tone(PAL.deep, 0.02));
    inner(p, 7, 11, 11, 6, STEEL);
    inner(p, 9, 17, 7, 3, STEEL_LIT);
    p.hline(5, 21, 16, tone(DARK, -0.42));
    tap(p, 19, 24);
    solid(p, 28, 8, 34, 15, tone(PAL.steelDark, -0.18), { lit: 0.2, dark: -0.26 });
    for (let k = 0; k < 5; k++) {
      const x = 30 + k * 6;
      p.rect(x, 10, 4, 11, tone(AMBER, -0.32));
      p.vline(x, 10, 11, tone(AMBER, -0.08));
      p.vline(x + 3, 10, 11, tone(AMBER, -0.55));
      p.rect(x, 11, 4, 2, tone(PAL.rust, 0.1));
      p.hline(x, 11, 4, tone(PAL.rust, 0.3));
    }
    ledge(p, 0, 24, FX_W, 3, DARK, { caps: false });
    crate(p, 44, 19, 18, 8, WOOD);
    p.rect(48, 21, 5, 2, tone(AMBER, -0.2));
  },

  // A wall rack of long arms over the quartermaster's counter, gear lockers at
  // the end, and the hazard rail that runs the length of the armoury.
  armory(p, s) {
    ground(p, s);
    ledge(p, 0, 6, FX_W, 4, tone(PAL.rust, -0.24), { caps: false });
    hazardBand(p, 0, 6, FX_W, 4);
    solid(p, 1, 12, 34, 15, IRON, { lit: 0.22, dark: -0.26 });
    p.rect(3, 14, 30, 11, tone(PAL.concrete, -0.06));
    p.hline(3, 14, 30, tone(PAL.concrete, 0.14));
    for (let k = 0; k < 4; k++) longarm(p, 6 + k * 8, 14, 11);
    ledge(p, 0, 29, 38, 3, WOOD_LIT);
    solid(p, 22, 23, 9, 5, STEEL_LIT, { lit: 0.24, dark: -0.3 });
    p.rect(24, 25, 5, 2, GLASS);
    locker(p, 39, 12, 12, 21);
    locker(p, 51, 12, 12, 21);
  },

  // A squad bay: three bed spaces in a rank — footlocker, cot, pack on the kit
  // rail — rather than three ranks of horizontal bars. The old version put the
  // lockers in mid-air above the cots and the eye had nothing vertical to hold
  // on to, so the room read as a barcode.
  barracks(p, s) {
    ground(p, s);
    ledge(p, 0, 8, FX_W, 2, STEEL, { caps: false });
    const blankets = [tone(PAL.rust, -0.3), tone(PAL.denim, -0.24), tone(PAL.verdigris, -0.34)];
    for (let k = 0; k < 3; k++) {
      const x = 1 + k * 21;
      solid(p, x + 3, 11, 13, 12, tone(PAL.rust, -0.34), { lit: 0.22, dark: -0.28 });
      p.hline(x + 4, 14, 11, tone(PAL.rust, -0.1));
      p.hline(x + 4, 19, 11, tone(PAL.rust, -0.5));
      inner(p, x + 5, 15, 4, 4, tone(PAL.rust, -0.5));
      p.set(x + 9, 10, STEEL_LIT);
      p.set(x + 9, 9, PAL.ink);
      solid(p, x, 25, 7, 8, WOOD, { lit: 0.22, dark: -0.28 });
      p.hline(x + 1, 28, 5, tone(WOOD, -0.42));
      p.set(x + 3, 29, STEEL_LIT);
      cot(p, x + 8, 27, 12, blankets[k]);
    }
  },

  // A firing range: the bench and its rest, one target downrange on the mat,
  // and the beaten dummy. This is the only room in the silo that burns ammo,
  // so the ammunition has to be visible.
  training_yard(p, s) {
    ground(p, s);
    ledge(p, 0, 26, FX_W, 5, tone(PAL.rust, -0.46), { caps: false });
    for (let i = 4; i < FX_W; i += 8) p.vline(i, 27, 4, tone(PAL.rust, -0.58));
    target(p, 40, 14, 7);
    p.vline(40, 21, 6, PAL.ink);
    p.vline(39, 21, 6, DARK);
    p.vline(38, 8, 18, PAL.ink);
    p.vline(37, 8, 18, DARK);
    solid(p, 52, 9, 11, 14, tone(PAL.rust, -0.2), { lit: 0.22, dark: -0.28 });
    p.hline(53, 13, 9, tone(PAL.rust, -0.5));
    p.hline(53, 18, 9, tone(PAL.rust, -0.5));
    p.speckle(53, 10, 9, 12, RUST_DK, 0.1, s + ':wear');
    ledge(p, 1, 20, 26, 3, WOOD, { caps: false });
    leg(p, 3, 24, 3, WOOD);
    leg(p, 24, 24, 3, WOOD);
    longarmFlat(p, 3, 16, 22);
    inner(p, 8, 18, 5, 2, IRON);
    for (let k = 0; k < 4; k++) p.set(6 + k * 4, 30 - (k & 1), tone(AMBER, -0.15));
  },

  // The desk under its lamp, the badge on the wall, and the paperwork. One
  // slot wide, so it is composed as a single view rather than a repeat.
  sheriffs_office(p, s) {
    ground(p, s);
    star(p, 11, 13, 7);
    solid(p, 21, 7, 19, 14, DARK, { lit: 0.2, dark: -0.26 });
    const r = rng(s + ':notes');
    for (let k = 0; k < 4; k++) {
      inner(p, 23 + (k % 2) * 9, 9 + ((k / 2) | 0) * 6, 7, 5, tone(PAL.bone, -0.2 - r() * 0.3));
    }
    ledge(p, 1, 22, 30, 3, WOOD_LIT);
    solid(p, 3, 26, 14, 6, WOOD, { lit: 0.2, dark: -0.26 });
    p.hline(4, 29, 12, tone(WOOD, -0.42));
    leg(p, 28, 26, 6, WOOD);
    solid(p, 5, 17, 8, 5, tone(PAL.rust, -0.18), { lit: 0.2, dark: -0.26 });
    p.hline(6, 20, 6, AMBER);
    spill(p, 4, 22, 10, 3, tone(AMBER, -0.5), 0.5);
    drawerBank(p, 44, 13, 18, 19, 1, 3);
  },

  // Three barred cells, because the room provides six of them and a player
  // will count. The bars catch the light; they are not black. A dark cell
  // behind bright bars is the whole read — which is also why the block stands
  // clear of the frame instead of filling it: at 97% coverage the renderer's
  // category tint had nothing to show through, and this was the one room in the
  // silo with no colour of its own.
  holding_cells(p, s) {
    ground(p, s);
    p.rect(3, 9, 58, 24, tone(PAL.deeper, 0.06));
    p.frame(3, 9, 58, 24, PAL.ink);
    p.hline(4, 10, 56, tone(PAL.deeper, 0.16));
    for (let k = 0; k < 3; k++) {
      const x = 4 + k * 19;
      const w = 19;
      p.rect(x + 2, 23, w - 5, 4, IRON);
      p.hline(x + 2, 23, w - 5, tone(IRON, 0.32));
      p.rect(x + 3, 24, 6, 2, CLOTH);
      p.hline(x + 3, 24, 6, tone(PAL.bone, -0.08));
      p.hline(x + 2, 27, w - 5, PAL.ink);
      for (let i = x; i < x + w - 2; i += 4) {
        p.vline(i, 10, 22, tone(STEEL, 0.14));
        p.vline(i + 1, 10, 22, tone(STEEL, -0.46));
      }
      p.hline(x - 1, 15, w + 1, tone(STEEL, 0.08));
      p.hline(x - 1, 16, w + 1, tone(STEEL, -0.5));
      inner(p, x + 7, 18, 5, 5, STEEL_LIT);
      if (k) p.vline(x - 2, 10, 22, PAL.ink);
    }
    // A warder's lamp over the corridor, so the block is not one flat black.
    solid(p, 27, 5, 10, 4, tone(PAL.rust, -0.3), { lit: 0.2, dark: -0.26 });
    p.hline(29, 8, 6, AMBER);
    spill(p, 26, 9, 12, 4, tone(AMBER, -0.5), 0.5);
  },

  // The centrifuge, the research console — amber-lit, because four rooms
  // reading as "grey slab with a green rectangle" is one problem the set does
  // not need — and a rack of sample vials.
  laboratory(p, s) {
    ground(p, s);
    pipeh(p, 0, 6, FX_W, 2, STEEL);
    for (let i = 8; i < FX_W; i += 16) collarH(p, i, 6, 2);
    const c = tube(p, 1, 13, 19, 19, STEEL_LIT);
    seam(p, c.x - 2, 17, c.w + 4, PAL.steelLit, -0.42);
    inner(p, c.x, 21, c.w, 6, tone(PAL.steelLit, -0.28));
    pipev(p, 9, 9, 4, 2, STEEL);
    deskPanel(p, 23, 10, 20, 15, tone(PAL.sodium, -0.28));
    ledge(p, 23, 26, 20, 3, DARK, { caps: false });
    solid(p, 46, 9, 17, 24, DARK, { lit: 0.2, dark: -0.26 });
    for (let k = 0; k < 3; k++) {
      const y = 12 + k * 7;
      for (let i = 0; i < 6; i++) {
        const t = i % 2 ? tone(PAL.verdigris, 0.06) : tone(PAL.bone, -0.26);
        p.rect(48 + i * 2, y, 1, 5, t);
        p.set(48 + i * 2, y, tone(t, 0.3));
      }
      p.hline(47, y + 5, 15, tone(STEEL, 0.14));
      p.hline(47, y + 6, 15, tone(STEEL, -0.42));
    }
  },

  // Racked spines, the card catalogue, and one green reading lamp. The top
  // board runs the width so the stacks continue into the next bay.
  archive(p, s) {
    ground(p, s);
    // The gantry board runs the width and is the element that joins the bays;
    // the case hangs a row clear of its keyline so that line reads as the
    // board's underside rather than as the top of the case.
    ledge(p, 0, 6, FX_W, 3, WOOD, { caps: false });
    solid(p, 1, 11, 32, 22, WOOD, { lit: 0.22, dark: -0.28 });
    for (let k = 0; k < 3; k++) {
      const y = 13 + k * 6;
      spines(p, 3, y, 28, 5, `${s}:shelf${k}`);
      p.hline(2, y + 6, 30, tone(WOOD, 0.2));
    }
    drawerBank(p, 37, 15, 20, 18, 3, 3, WOOD_LIT);
    solid(p, 37, 11, 20, 4, WOOD, { lit: 0.24, dark: -0.3 });
    solid(p, 58, 17, 6, 4, tone(PAL.verdigris, -0.24), { lit: 0.2, dark: -0.26 });
    p.hline(59, 20, 4, AMBER);
    spill(p, 58, 21, 6, 3, tone(AMBER, -0.5), 0.5);
    p.vline(60, 21, 12, PAL.ink);
  },

  // A blackboard, a row of small desks, and the globe.
  schoolhouse(p, s) {
    ground(p, s);
    ledge(p, 0, 6, FX_W, 2, WOOD, { caps: false });
    solid(p, 2, 10, 34, 16, tone(PAL.verdigris, -0.64), { lit: 0.14, dark: -0.18 });
    const r = rng(s + ':chalk');
    for (let k = 0; k < 4; k++) {
      p.hline(5 + ((r() * 4) | 0), 13 + k * 3, 8 + ((r() * 16) | 0), tone(PAL.bone, -0.26));
    }
    p.rect(4, 24, 5, 1, PAL.bone);
    for (let k = 0; k < 3; k++) {
      const x = 4 + k * 11;
      ledge(p, x, 27, 10, 2, WOOD_LIT);
      leg(p, x + 1, 30, 2, WOOD);
      leg(p, x + 7, 30, 2, WOOD);
      solid(p, x + 2, 23, 6, 4, WOOD, { lit: 0.22, dark: -0.28 });
    }
    p.vline(50, 22, 10, PAL.ink);
    p.vline(49, 22, 10, DARK);
    disc(p, 50, 15, 6, tone(PAL.verdigris, -0.16));
    p.hline(45, 15, 11, tone(PAL.verdigris, 0.28));
    p.hline(46, 12, 8, tone(PAL.verdigris, 0.12));
  },

  // The transmitter rack with its scope, the feeder going up to the mast, and
  // the operator's desk. The feeder carries insulators, not rungs: a ladder is
  // a different object and this room has no ladder.
  radio_room(p, s) {
    ground(p, s);
    solid(p, 1, 6, 25, 27, DARK, { lit: 0.22, dark: -0.26 });
    disc(p, 10, 14, 7, tone(PAL.deep, 0.02));
    ring(p, 10, 14, 6, tone(PAL.verdigris, 0.2));
    p.hline(5, 14, 11, tone(PAL.verdigris, 0.46));
    p.set(10, 11, tone(PAL.verdigris, 0.6));
    p.set(13, 17, tone(PAL.verdigris, 0.5));
    for (let k = 0; k < 3; k++) {
      inner(p, 19, 9 + k * 6, 5, 5, tone(PAL.bone, -0.36));
      p.set(21, 11 + k * 6, tone(PAL.rust, -0.1));
    }
    for (let k = 0; k < 4; k++) p.rect(4 + k * 4, 24, 2, 5, k % 2 ? tone(STEEL, -0.2) : tone(STEEL, 0.12));
    p.hline(3, 29, 20, tone(DARK, -0.42));
    pipev(p, 32, 5, 22, 3, STEEL_LIT);
    for (let j = 8; j < 26; j += 6) {
      p.rect(30, j, 6, 2, tone(PAL.bone, -0.34));
      p.hline(30, j, 6, tone(PAL.bone, -0.1));
      p.hline(30, j + 2, 6, PAL.ink);
    }
    ledge(p, 40, 23, 22, 3, WOOD);
    leg(p, 42, 27, 5, WOOD);
    leg(p, 59, 27, 5, WOOD);
    p.vline(47, 19, 4, PAL.ink);
    solid(p, 45, 15, 6, 4, DARK, { lit: 0.24, dark: -0.3 });
    solid(p, 54, 18, 7, 5, IRON, { lit: 0.22, dark: -0.28 });
  },

  // The only door: a dogged pressure hatch under a hazard lintel, and the
  // green that only ever means contamination seeping past the outer seal.
  airlock(p, s) {
    ground(p, s, { conduit: false });
    ledge(p, 0, 2, FX_W, 4, CONC, { caps: false });
    hazardBand(p, 0, 2, FX_W, 4);
    solid(p, 4, 8, 46, 24, CONC, { lit: 0.2, dark: -0.26 });
    rivets(p, 7, 10, 10, 4, tone(PAL.concrete, 0.3));
    disc(p, 27, 21, 11, DARK);
    ring(p, 27, 21, 8, tone(STEEL, -0.44));
    ring(p, 27, 21, 9, tone(STEEL, 0.18));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      p.set(27 + Math.round(Math.cos(a) * 10), 21 + Math.round(Math.sin(a) * 10), STEEL_LIT);
    }
    wheel(p, 27, 21, 4);
    deskPanel(p, 52, 12, 11, 13, tone(PAL.sodium, -0.3));
    p.rect(14, 30, 26, 2, tone(PAL.toxin, -0.5));
    motes(p, 15, 27, 24, 4, tone(PAL.toxin, -0.24), 7, s + ':seep');
  },

  // Suits on the rail, the helmet on its stand, and the compressor that tests
  // them. Nothing else in the silo is this shape.
  suit_bay(p, s) {
    ground(p, s);
    ledge(p, 0, 7, FX_W, 2, STEEL_LIT, { caps: false });
    for (let k = 0; k < 3; k++) suitHang(p, 1 + k * 15, 10, 14, 21);
    solid(p, 47, 22, 16, 10, DARK, { lit: 0.22, dark: -0.26 });
    disc(p, 52, 27, 3, STEEL);
    inner(p, 57, 25, 5, 5, tone(PAL.bone, -0.34));
    p.vline(54, 18, 4, PAL.ink);
    solid(p, 50, 12, 10, 7, STEEL_LIT, { lit: 0.24, dark: -0.3 });
    p.rect(52, 14, 6, 3, GLASS);
    p.hline(52, 14, 6, tone(PAL.verdigris, -0.16));
  },

  // Racked and stacked. Boring, cheap, always the right call.
  // Ore in at the top, coolant out at the bottom. The read is a bank of
  // finned tubes with a condensate drum under it — deliberately cold in
  // palette where the Foundry and the Reactor are hot, since the two sit
  // beside each other in the Deeps and the player picks them apart at a
  // glance.
  heat_exchange(p, s) {
    ground(p, s);
    // The hot feed and the condensate gutter both run the full width, because
    // this room is two slots wide and its art is drawn once per bay: a shape
    // that stops short of the edge makes one room read as two dioramas. The
    // self-test checks for it — six joining rows, at least one at working
    // height — and caught exactly that on the first attempt.
    pipeh(p, 0, 5, FX_W, 3, tone(PAL.rust, -0.3));
    for (let i = 6; i < FX_W - 6; i += 14) collarH(p, i, 5, 3);
    // The tube bank: five finned verticals, alternating so the fins read.
    solid(p, 4, 9, 40, 18, DARK, { lit: 0.2, dark: -0.26 });
    for (let k = 0; k < 5; k++) {
      const x = 7 + k * 8;
      inner(p, x, 11, 4, 14, tone(PAL.steel, k % 2 ? 0.06 : -0.12));
      for (let y = 12; y < 25; y += 3) p.hline(x - 1, y, 6, tone(PAL.verdigris, -0.28));
    }
    // Condensate, running off the bank into the drum.
    motes(p, 6, 26, 36, 3, tone(PAL.verdigris, 0.12), 6, s + ':drip');
    pipeh(p, 0, 28, FX_W, 3, tone(PAL.verdigris, -0.34));
    // The cold line out, low and to the right.
    drum(p, 47, 16, 14, 16, tone(PAL.verdigris, -0.34));
    pipev(p, 52, 8, 8, 3, tone(PAL.verdigris, -0.2));
    tap(p, 54, 31);
  },

  storage_depot(p, s) {
    ground(p, s);
    solid(p, 1, 6, 32, 27, DARK, { lit: 0.2, dark: -0.26 });
    for (let k = 0; k < 3; k++) {
      const y = 8 + k * 8;
      crate(p, 3, y, 13, 6, k === 1 ? tone(PAL.rust, -0.24) : WOOD, { inside: true });
      crate(p, 18, y, 13, 6, k === 1 ? WOOD : tone(PAL.rust, -0.24), { inside: true });
      p.hline(2, y + 6, 30, tone(STEEL, 0.14));
      p.hline(2, y + 7, 30, tone(STEEL, -0.42));
    }
    crate(p, 36, 21, 16, 11);
    crate(p, 38, 12, 12, 9, tone(PAL.rust, -0.24));
    drum(p, 53, 18, 10, 14);
    drum(p, 53, 7, 10, 10, tone(PAL.verdigris, -0.3));
  },

  // A drift with a rib of unmined rock at its right-hand edge: the roof beam
  // and the track run edge to edge so the bays read as one continuous tunnel,
  // and the ore is heaped in the cart, because ore is what this room makes.
  //
  // A single working face at the end of a three-slot mine is not drawable here
  // and asking for it is a category error: floors.js repeats this ONE frame per
  // bay, so anything that appears once would have to be a different frame
  // (room_deep_mine_left/_mid/_right) and a change to drawFixture's loop. A rib
  // per bay is the read that survives the repeat.
  deep_mine(p, s) {
    ground(p, s, { conduit: false });
    ledge(p, 0, 2, FX_W, 4, DARK, { caps: false });
    rockface(p, 48, 7, 16, 25, s + ':face');
    ibeam(p, 4, 7, 6, 25);
    ibeam(p, 28, 7, 6, 25);
    ledge(p, 0, 7, 48, 3, DARK, { caps: false });
    rails(p, 0, 29, FX_W);
    solid(p, 11, 20, 18, 10, IRON, { lit: 0.22, dark: -0.26 });
    p.rect(13, 17, 14, 3, tone(PAL.concrete, -0.3));
    p.hline(13, 17, 14, tone(PAL.concrete, -0.02));
    p.hline(15, 16, 3, tone(PAL.sodium, -0.3));
    p.hline(21, 16, 4, tone(PAL.sodium, -0.42));
    p.set(19, 16, tone(PAL.sodium, -0.08));
    disc(p, 14, 30, 2, DARK);
    disc(p, 26, 30, 2, DARK);
    p.vline(39, 7, 3, PAL.ink);
    solid(p, 37, 10, 6, 4, tone(PAL.rust, -0.22), { lit: 0.2, dark: -0.26 });
    p.hline(38, 13, 4, AMBER);
    spill(p, 36, 14, 8, 4, tone(AMBER, -0.5), 0.45);
    motes(p, 34, 14, 12, 14, tone(PAL.concrete, 0.12), 6, s + ':dust');
  },

  // Work orders on the board, the trolley, a ladder to the shaft and the
  // welding set. The parts store belongs to the workshop; this room fixes
  // things, so what it shows is the queue of jobs and the kit to do them.
  maintenance_bay(p, s) {
    ground(p, s);
    solid(p, 1, 6, 23, 15, DARK, { lit: 0.2, dark: -0.26 });
    const r = rng(s + ':orders');
    for (let k = 0; k < 6; k++) {
      inner(p, 3 + (k % 3) * 7, 8 + ((k / 3) | 0) * 6, 6, 5, tone(PAL.bone, -0.22 - r() * 0.34));
    }
    solid(p, 1, 24, 21, 9, tone(PAL.rust, -0.22), { lit: 0.22, dark: -0.28 });
    p.hline(2, 28, 19, tone(PAL.rust, -0.48));
    disc(p, 5, 31, 2, DARK);
    disc(p, 18, 31, 2, DARK);
    inner(p, 4, 21, 9, 3, DARK);
    ladder(p, 26, 6, 8, 26);
    solid(p, 38, 18, 15, 15, DARK, { lit: 0.22, dark: -0.26 });
    inner(p, 40, 20, 5, 5, tone(PAL.bone, -0.34));
    p.rect(47, 21, 4, 8, tone(STEEL, -0.22));
    p.hline(47, 21, 4, tone(STEEL, 0.12));
    p.vline(51, 21, 8, PAL.ink);
    p.vline(56, 19, 13, tone(PAL.rust, -0.16));
    p.vline(57, 19, 13, PAL.ink);
    solid(p, 55, 13, 7, 6, IRON, { lit: 0.22, dark: -0.28 });
    p.rect(57, 15, 3, 3, PAL.bone);
    sparks(p, 54, 10, 10, 7, 9, s + ':arc');
  },
};

// =============================================================================
// CUTAWAYS — 128x88, opaque. The chamfered vault, the coursed wall, one amber
// fixture, and the room's contents standing on the ink floor line at y=78.
// =============================================================================

const CUTAWAY_ART = {
  generator_hall(p, s) {
    vaultShell(p, s);
    wallPipes(p, 17, 8, 112, tone(PAL.rust, -0.22), 3, 25);
    deskPanel(p, 96, 26, 26, 20, LEAF);
    for (let i = 0; i < 2; i++) {
      const x = 6 + i * 44;
      pipev(p, x + 12, 21, 13, 3, tone(PAL.rust, -0.2));
      solid(p, x, 34, 42, 44, IRON, { lit: 0.26, dark: -0.3 });
      port(p, x + 4, 40, 20, 15, AMBER_DIM);
      p.rect(x + 6, 42, 16, 11, AMBER);
      p.hline(x + 6, 42, 16, tone(AMBER, 0.45));
      disc(p, x + 31, 47, 9, tone(STEEL, -0.1));
      ring(p, x + 31, 47, 4, tone(STEEL, -0.44));
      disc(p, x + 31, 47, 2, STEEL_LIT, null);
      inner(p, x + 3, 62, 36, 5, tone(IRON, -0.2));
      rivets(p, x + 4, 63, 9, 4, tone(IRON, 0.34));
      gauge(p, x + 26, 62, 8);
      contact(p, x - 1, 79, 44);
    }
    drum(p, 100, 56, 16, 22);
    contact(p, 99, 79, 18);
    p.speckle(4, 66, 24, 12, RUST_DK, 0.09, s + ':soot');
  },

  reactor(p, s) {
    vaultShell(p, s, { coneW: 60 });
    wallPipes(p, 16, 6, 116, tone(PAL.verdigris, -0.26), 4, 27);
    solid(p, 0, 30, 28, 48, CONC, { lit: 0.2, dark: -0.26 });
    solid(p, 100, 30, 28, 48, CONC, { lit: 0.2, dark: -0.26 });
    hazardBand(p, 3, 34, 22, 8);
    hazardBand(p, 103, 34, 22, 8);
    p.speckle(3, 58, 24, 18, RUST_DK, 0.1, s + ':shield');
    pipev(p, 30, 24, 54, 4, tone(PAL.verdigris, -0.26));
    pipev(p, 93, 24, 54, 4, tone(PAL.verdigris, -0.26));
    const v = tube(p, 38, 20, 52, 58, DARK);
    port(p, v.x, 30, v.w, 36, tone(PAL.toxin, -0.36));
    p.rect(v.x + 3, 33, v.w - 6, 30, PAL.toxin);
    p.rect(v.x + 7, 38, v.w - 14, 20, tone(PAL.toxin, 0.32));
    p.rect(v.x + 12, 43, v.w - 24, 10, tone(PAL.toxin, 0.6));
    for (let j = 31; j < 65; j += 4) p.hline(v.x + 1, j, v.w - 2, tone(PAL.toxin, -0.3));
    inner(p, 41, 68, 46, 6, tone(DARK, -0.3));
    rivets(p, 42, 25, 12, 4, tone(DARK, 0.32));
    wheel(p, 32, 48, 5);
    wheel(p, 95, 48, 5);
    gauge(p, 8, 48, 9);
    gauge(p, 111, 48, 9);
    deskPanel(p, 4, 60, 20, 18, tone(PAL.verdigris, -0.04));
    solid(p, 104, 60, 20, 18, DARK, { lit: 0.22, dark: -0.26 });
    inner(p, 108, 63, 12, 12, tone(PAL.rust, 0.05));
    p.rect(110, 65, 8, 8, AMBER);
    contact(p, 37, 79, 54);
  },

  water_reclaimer(p, s) {
    vaultShell(p, s);
    wallPipes(p, 15, 6, 116, tone(PAL.verdigris, -0.22), 3, 23);
    const a = tube(p, 6, 26, 42, 52, STEEL);
    port(p, a.x, 34, a.w, 34, tone(PAL.verdigris, -0.26));
    p.hline(a.x + 1, 41, a.w - 2, tone(PAL.verdigris, 0.46));
    p.hline(a.x + 1, 42, a.w - 2, tone(PAL.verdigris, 0.16));
    motes(p, a.x + 1, 45, a.w - 2, 20, tone(PAL.verdigris, 0.32), 9, s + ':bub1');
    rivets(p, 10, 30, 9, 4, STEEL_LIT);
    const b = tube(p, 54, 36, 30, 42, STEEL);
    port(p, b.x, 44, b.w, 26, tone(PAL.verdigris, -0.26));
    p.hline(b.x + 1, 50, b.w - 2, tone(PAL.verdigris, 0.46));
    pipeh(p, 46, 20, 46, 3, STEEL);
    collarH(p, 62, 20, 3);
    elbowAt(p, 89, 19, 3, STEEL);
    pipev(p, 90, 24, 14, 3, STEEL);
    pipeh(p, 84, 56, 40, 4, STEEL);
    collarH(p, 104, 56, 4);
    wheel(p, 96, 42, 5);
    wheel(p, 114, 46, 5);
    solid(p, 92, 64, 30, 14, DARK, { lit: 0.22, dark: -0.26 });
    for (let j = 67; j < 76; j += 3) {
      p.hline(95, j, 24, tone(STEEL, 0.14));
      p.hline(95, j + 1, 24, tone(STEEL, -0.44));
    }
    contact(p, 5, 79, 44);
    contact(p, 53, 79, 32);
  },

  hydroponics(p, s) {
    vaultShell(p, s, { coneW: 70 });
    for (let k = 0; k < 3; k++) {
      const y = 16 + k * 21;
      lampBar(p, 4, y, 120, AMBER, 4);
      canopy(p, 4, y + 8, 120, 8, LEAF, `${s}:tier${k}`);
      ledge(p, 4, y + 17, 120, 3, tone(STEEL, -0.22), { caps: false });
    }
    pipev(p, 8, 20, 56, 3, tone(PAL.verdigris, -0.28));
    for (let k = 0; k < 4; k++) collarV(p, 8, 24 + k * 14, 3);
    solid(p, 96, 66, 24, 12, IRON, { lit: 0.22, dark: -0.26 });
    p.hline(98, 71, 20, tone(IRON, -0.34));
    disc(p, 100, 77, 3, DARK);
    disc(p, 115, 77, 3, DARK);
    contact(p, 95, 79, 26);
  },

  protein_vats(p, s) {
    vaultShell(p, s);
    wallPipes(p, 18, 8, 112, STEEL, 3, 24);
    for (let i = 0; i < 2; i++) {
      const x = 6 + i * 60;
      pipev(p, x + 26, 22, 6, 3, STEEL);
      solid(p, x + 16, 27, 24, 12, IRON, { lit: 0.26, dark: -0.3 });
      p.hline(x + 18, 30, 20, tone(IRON, -0.4));
      const v = tube(p, x, 39, 56, 39, tone(STEEL, -0.32));
      port(p, v.x, 46, v.w, 26, tone(SLUDGE, -0.22));
      p.hline(v.x + 1, 51, v.w - 2, tone(SLUDGE, 0.28));
      motes(p, v.x + 1, 53, v.w - 2, 16, tone(SLUDGE, 0.46), 12, `${s}:v${i}`);
      wheel(p, x + 47, 58, 5);
      rivets(p, x + 4, 43, 10, 4, tone(STEEL, 0.22));
      contact(p, x - 1, 79, 58);
    }
    p.speckle(6, 70, 116, 8, tone(SLUDGE, -0.36), 0.05, s + ':spill');
  },

  air_filtration(p, s) {
    vaultShell(p, s, { coneW: 46 });
    ledge(p, 0, 14, CUT_W, 8, DARK, { caps: false });
    for (let i = 6; i < 124; i += 14) p.vline(i, 15, 7, tone(DARK, -0.36));
    solid(p, 4, 26, 52, 52, DARK, { lit: 0.22, dark: -0.26 });
    impeller(p, 30, 52, 21, STEEL);
    pipev(p, 29, 23, 4, 3, STEEL);
    rivets(p, 7, 30, 12, 4, tone(DARK, 0.32));
    solid(p, 62, 24, 60, 54, DARK, { lit: 0.22, dark: -0.26 });
    for (let k = 0; k < 2; k++) {
      const x = 66 + k * 27;
      const dirty = k === 1;
      solid(p, x, 28, 24, 42, tone(STEEL, dirty ? -0.42 : -0.16), { lit: 0.22, dark: -0.26 });
      for (let j = 31; j < 68; j += 4) {
        p.hline(x + 2, j, 20, tone(STEEL, dirty ? -0.32 : 0.06));
        p.hline(x + 2, j + 1, 20, tone(STEEL, -0.5));
      }
      if (dirty) p.speckle(x + 2, 48, 20, 20, RUST_DK, 0.28, `${s}:clog`);
      inner(p, x + 8, 71, 8, 4, STEEL_LIT);
    }
    gauge(p, 110, 32, 9);
    contact(p, 3, 79, 54);
    contact(p, 61, 79, 62);
  },

  residences(p, s) {
    vaultShell(p, s, { coneW: 44 });
    wallPipes(p, 18, 6, 116, DARK, 3, 26);
    bunkStack(p, 4, 32, 38, 46);
    bunkStack(p, 86, 32, 38, 46);
    solid(p, 52, 30, 24, 48, DARK, { lit: 0.2, dark: -0.26 });
    inner(p, 55, 34, 18, 41, tone(STEEL, -0.26));
    p.vline(64, 34, 41, tone(STEEL, -0.46));
    p.set(62, 56, STEEL_LIT);
    p.set(66, 56, STEEL_LIT);
    inner(p, 56, 25, 16, 4, AMBER);
    spill(p, 53, 30, 22, 6, tone(AMBER, -0.5), 0.55);
    solid(p, 24, 24, 22, 10, WOOD_LIT, { lit: 0.24, dark: -0.3 });
    inner(p, 26, 26, 18, 6, tone(PAL.verdigris, -0.34));
    solid(p, 82, 24, 22, 10, WOOD_LIT, { lit: 0.24, dark: -0.3 });
    inner(p, 84, 26, 18, 6, tone(PAL.rust, -0.34));
    contact(p, 3, 79, 40);
    contact(p, 85, 79, 40);
  },

  cafeteria(p, s) {
    vaultShell(p, s, { coneW: 62 });
    solid(p, 6, 18, 42, 15, tone(PAL.verdigris, -0.62), { lit: 0.14, dark: -0.18 });
    const r = rng(s + ':menu');
    for (let k = 0; k < 4; k++) p.hline(9, 21 + k * 3, 10 + ((r() * 24) | 0), tone(PAL.bone, -0.3));
    lampBar(p, 6, 37, 44, AMBER, 4);
    solid(p, 4, 48, 48, 30, WOOD, { lit: 0.24, dark: -0.28 });
    p.rect(6, 50, 44, 3, tone(PAL.bone, -0.3));
    p.hline(6, 50, 44, tone(PAL.bone, -0.05));
    p.hline(5, 53, 46, tone(WOOD, -0.42));
    for (let k = 0; k < 4; k++) {
      inner(p, 7 + k * 11, 42, 10, 6, tone(STEEL, 0.06));
      p.rect(9 + k * 11, 44, 6, 2, k % 2 ? tone(PAL.verdigris, -0.08) : tone(PAL.rust, 0.06));
    }
    ledge(p, 62, 50, 62, 5, WOOD_LIT, { caps: false });
    leg(p, 66, 56, 22, WOOD);
    leg(p, 116, 56, 22, WOOD);
    for (let k = 0; k < 4; k++) {
      const x = 68 + k * 14;
      inner(p, x, 60, 10, 5, IRON);
      leg(p, x + 4, 65, 13, IRON);
      p.rect(x + 1, 46, 8, 3, tone(PAL.bone, -0.2));
      p.hline(x + 1, 46, 8, PAL.bone);
      p.hline(x + 1, 49, 8, PAL.ink);
    }
    contact(p, 3, 79, 50);
  },

  // The room that gates all healing read as an unfurnished corridor with two
  // stripes on the floor: a 5-row bed is right in a 36-row fixture and is
  // nothing in an 88-row one. Full-height beds on the floor line, a curtain
  // half-drawn between the bays, an exam light over each bed and the drip at
  // the foot of the second — which is what a ward looks like.
  clinic(p, s) {
    vaultShell(p, s, { coneW: 58 });
    wallPipes(p, 16, 10, 108, STEEL, 2, 30);
    ledge(p, 4, 24, 120, 2, STEEL, { caps: false });
    for (let i = 8; i < 124; i += 8) p.set(i, 24, tone(STEEL, -0.5));
    p.rect(56, 26, 15, 41, CLOTH);
    p.hline(56, 26, 15, tone(PAL.bone, -0.04));
    for (let i = 58; i < 70; i += 3) p.vline(i, 27, 40, tone(PAL.bone, -0.42));
    p.vline(55, 26, 41, PAL.ink);
    p.vline(71, 26, 41, PAL.ink);
    p.hline(56, 67, 15, PAL.ink);
    deskPanel(p, 4, 32, 22, 20, LEAF);
    solid(p, 96, 28, 26, 26, tone(PAL.bone, -0.32), { lit: 0.22, dark: -0.26 });
    p.rect(107, 33, 5, 16, tone(PAL.rust, 0.02));
    p.rect(101, 38, 17, 5, tone(PAL.rust, 0.02));
    ledge(p, 94, 57, 30, 3, STEEL, { caps: false });
    drawerBank(p, 98, 62, 24, 17, 2, 2, DARK);
    for (let k = 0; k < 2; k++) {
      const x = 4 + k * 44;
      bed(p, x, 67, 40, { blanket: tone(PAL.verdigris, 0.02), th: 12, head: 13 });
      contact(p, x - 1, 79, 42);
      const lx = x + 30;
      p.vline(lx, 26, 6, PAL.ink);
      p.vline(lx - 1, 26, 6, STEEL_LIT);
      solid(p, lx - 6, 32, 13, 6, tone(PAL.rust, -0.24), { lit: 0.2, dark: -0.26 });
      p.hline(lx - 4, 37, 9, AMBER);
      spill(p, lx - 8, 38, 17, 7, tone(AMBER, -0.5), 0.5);
    }
    p.vline(90, 40, 38, STEEL_LIT);
    p.vline(91, 40, 38, PAL.ink);
    solid(p, 86, 34, 9, 7, tone(PAL.bone, -0.2), { lit: 0.24, dark: -0.28 });
    p.rect(88, 36, 4, 4, tone(PAL.verdigris, 0.1));
  },

  chem_lab(p, s) {
    vaultShell(p, s);
    wallPipes(p, 15, 8, 112, tone(PAL.verdigris, -0.3), 2, 26);
    solid(p, 4, 24, 48, 54, DARK, { lit: 0.22, dark: -0.26 });
    port(p, 8, 30, 40, 32, GLASS);
    inner(p, 14, 42, 11, 18, tone(PAL.verdigris, 0.08));
    inner(p, 32, 46, 10, 14, tone(PAL.rust, 0.08));
    motes(p, 12, 33, 32, 8, tone(PAL.bone, -0.36), 8, s + ':fume');
    inner(p, 7, 66, 42, 6, tone(DARK, -0.3));
    pipev(p, 26, 19, 6, 3, STEEL);
    const col = tube(p, 60, 20, 20, 58, STEEL);
    for (const y of [32, 44, 56, 68]) {
      p.hline(col.x - 2, y, col.w + 4, tone(STEEL, 0.2));
      p.hline(col.x - 2, y + 1, col.w + 4, tone(STEEL, -0.44));
    }
    wheel(p, 70, 74, 4);
    pipeh(p, 80, 34, 22, 3, STEEL);
    elbowAt(p, 101, 33, 3, STEEL);
    solid(p, 86, 36, 38, 14, DARK, { lit: 0.2, dark: -0.26 });
    for (let k = 0; k < 6; k++) {
      p.rect(89 + k * 6, 38, 4, 9, tone(PAL.sodium, -0.26));
      p.hline(89 + k * 6, 38, 4, tone(PAL.sodium, 0.2));
      p.hline(89 + k * 6, 47, 4, tone(PAL.sodium, -0.55));
    }
    ledge(p, 86, 54, 38, 4, WOOD_LIT, { caps: false });
    leg(p, 89, 59, 19, WOOD);
    leg(p, 120, 59, 19, WOOD);
    for (let k = 0; k < 4; k++) {
      p.rect(90, 60 + k * 5, 14, 4, tone(PAL.bone, -0.3));
      p.hline(90, 60 + k * 5, 14, tone(PAL.bone, -0.05));
      p.hline(90, 63 + k * 5, 14, PAL.ink);
    }
    inner(p, 110, 60, 12, 14, tone(PAL.verdigris, 0.04));
    contact(p, 3, 79, 50);
  },

  workshop(p, s) {
    vaultShell(p, s);
    solid(p, 4, 16, 52, 26, DARK, { lit: 0.2, dark: -0.24 });
    const r = rng(s + ':pegs');
    for (let k = 0; k < 9; k++) {
      const x = 8 + k * 5;
      const h = 8 + ((r() * 12) | 0);
      p.vline(x, 19, h, r() < 0.5 ? STEEL_LIT : tone(PAL.rust, 0.05));
      p.vline(x + 1, 19, h, tone(DARK, -0.42));
      p.set(x, 19 + h, PAL.ink);
    }
    solid(p, 64, 16, 60, 30, DARK, { lit: 0.2, dark: -0.24 });
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 6; k++) {
        const c = (j + k) % 3 ? tone(STEEL, 0.12) : tone(PAL.rust, 0.04);
        p.rect(67 + k * 9, 19 + j * 9, 7, 5, c);
        p.hline(67 + k * 9, 19 + j * 9, 7, tone(c, 0.26));
        p.hline(67 + k * 9, 23 + j * 9, 7, tone(c, -0.3));
      }
      p.hline(65, 25 + j * 9, 58, tone(DARK, -0.42));
    }
    ledge(p, 4, 50, 60, 6, WOOD_LIT, { caps: false });
    leg(p, 8, 57, 21, WOOD);
    leg(p, 57, 57, 21, WOOD);
    solid(p, 14, 42, 14, 8, STEEL, { lit: 0.24, dark: -0.28 });
    p.hline(15, 46, 12, tone(STEEL, -0.42));
    crate(p, 30, 62, 24, 16);
    solid(p, 70, 52, 50, 26, DARK, { lit: 0.22, dark: -0.26 });
    disc(p, 90, 65, 11, tone(STEEL, -0.08));
    ring(p, 90, 65, 6, tone(STEEL, -0.44));
    disc(p, 90, 65, 2, STEEL_LIT, null);
    sparks(p, 96, 68, 16, 9, 14, s + ':grind');
    contact(p, 69, 79, 52);
  },

  // Salvage in at the top left, scrap and fuel out at the bottom right. The
  // first draft was three grey rectangles, a grey belt and a grey cabinet, all
  // the same tone: nothing said what came in, what happened to it, or what came
  // out, and the room is the only fuel source above the Deeps.
  recycling(p, s) {
    vaultShell(p, s, { coneW: 42, lightX: 34 });
    const r = rng(s + ':salvage');
    const junk = () => [tone(PAL.rust, -0.06), tone(STEEL, -0.14), tone(PAL.verdigris, -0.3), WOOD][(r() * 4) | 0];

    // The intake hopper: a trapezoid heaped over the rim, tapering into the
    // chute that feeds the belt.
    for (let k = 0; k < 9; k++) {
      const w = 5 + ((r() * 7) | 0);
      const x = 6 + ((r() * 44) | 0);
      solid(p, x, 12 + ((r() * 4) | 0), Math.min(w, 58 - x), 7, junk(), { lit: 0.24, dark: -0.28 });
    }
    for (let j = 0; j < 15; j++) {
      const x0 = 4 + Math.round(j * 1.2);
      const x1 = 60 - Math.round(j * 1.2);
      p.hline(x0, 19 + j, x1 - x0 + 1, tone(STEEL, -0.38));
      p.hline(x0 + 1, 19 + j, 2, tone(STEEL, -0.1));
      p.set(x1 - 1, 19 + j, tone(STEEL, -0.54));
      p.set(x0, 19 + j, PAL.ink);
      p.set(x1, 19 + j, PAL.ink);
    }
    p.hline(4, 18, 57, PAL.ink);
    p.rect(22, 34, 20, 18, tone(STEEL, -0.44));
    p.vline(23, 34, 18, tone(STEEL, -0.16));
    p.vline(40, 34, 18, tone(STEEL, -0.58));
    p.vline(22, 34, 18, PAL.ink);
    p.vline(41, 34, 18, PAL.ink);
    seam(p, 23, 42, 18, STEEL, -0.6);

    // The belt, running into the crusher, with salvage riding it.
    for (let k = 0; k < 7; k++) {
      const w = 5 + ((r() * 6) | 0);
      const h = 4 + ((r() * 7) | 0);
      solid(p, 3 + k * 10, 52 - h, w, h, junk(), { lit: 0.24, dark: -0.28 });
    }
    ledge(p, 0, 52, 74, 7, DARK, { caps: false });
    for (let i = 3; i < 72; i += 7) {
      p.vline(i, 54, 4, STEEL_LIT);
      p.vline(i + 1, 54, 4, tone(STEEL, -0.44));
    }
    leg(p, 6, 60, 18, IRON);
    leg(p, 66, 60, 18, IRON);

    // The crusher: a lit mouth with the rollers turning in it, and the swarf
    // and sparks that come off them.
    solid(p, 76, 16, 48, 62, IRON, { lit: 0.22, dark: -0.26 });
    rivets(p, 79, 19, 14, 3, tone(IRON, 0.34));
    port(p, 80, 26, 40, 26, tone(PAL.rust, -0.62));
    for (let k = 0; k < 2; k++) {
      const cy = 34 + k * 10;
      p.rect(83, cy, 34, 6, tone(STEEL, -0.3));
      p.hline(83, cy, 34, tone(STEEL, 0.1));
      p.hline(83, cy + 5, 34, tone(STEEL, -0.6));
      for (let i = 84 + k * 3; i < 117; i += 6) {
        p.vline(i, cy + 1, 4, tone(STEEL, 0.28));
        p.vline(i + 1, cy + 1, 4, tone(STEEL, -0.55));
      }
    }
    sparks(p, 84, 40, 32, 8, 12, s + ':grind');
    inner(p, 80, 56, 40, 5, tone(IRON, -0.3));
    p.hline(82, 58, 36, tone(PAL.sodium, -0.3));

    // Decanting: the fuel drum with its sight glass, and the jerrican rack.
    drum(p, 14, 60, 18, 18, tone(PAL.verdigris, -0.3));
    p.rect(19, 65, 4, 9, tone(AMBER, -0.5));
    p.rect(19, 69, 4, 5, AMBER);
    p.hline(19, 69, 4, tone(AMBER, 0.4));
    for (let k = 0; k < 3; k++) {
      const x = 38 + k * 11;
      solid(p, x, 66, 9, 12, tone(PAL.sodium, -0.34), { lit: 0.22, dark: -0.3 });
      p.hline(x + 2, 68, 5, tone(PAL.sodium, -0.06));
      p.set(x + 4, 65, tone(STEEL, -0.2));
      p.set(x + 4, 64, PAL.ink);
    }
    p.speckle(78, 68, 44, 9, RUST_DK, 0.12, s + ':swarf');
    contact(p, 13, 79, 20);
    contact(p, 75, 79, 50);
  },

  foundry(p, s) {
    vaultShell(p, s, { coneW: 40 });
    ledge(p, 0, 14, CUT_W, 6, tone(PAL.rust, -0.52), { caps: false });
    pipev(p, 26, 21, 6, 4, tone(PAL.rust, -0.3));
    solid(p, 4, 26, 56, 52, tone(PAL.rust, -0.46), { lit: 0.2, dark: -0.26 });
    port(p, 12, 38, 34, 28, AMBER_DIM);
    p.rect(16, 42, 26, 20, AMBER);
    p.rect(22, 47, 14, 10, tone(AMBER, 0.5));
    rivets(p, 7, 29, 13, 4, tone(PAL.rust, 0.08));
    p.hline(6, 70, 52, tone(PAL.rust, -0.62));
    p.speckle(4, 66, 56, 12, SOOT, 0.14, s + ':soot');
    solid(p, 72, 26, 40, 24, IRON, { lit: 0.22, dark: -0.26 });
    inner(p, 75, 29, 34, 9, AMBER);
    p.vline(90, 50, 16, AMBER);
    p.vline(91, 50, 16, tone(AMBER, 0.5));
    p.vline(92, 50, 16, tone(AMBER, -0.22));
    sparks(p, 82, 52, 18, 16, 18, s + ':pour');
    for (let k = 0; k < 3; k++) {
      const x = 74 + k * 16;
      solid(p, x, 66, 14, 12, DARK, { lit: 0.2, dark: -0.26 });
      p.rect(x + 2, 68, 10, 3, k === 1 ? AMBER : tone(AMBER, -0.62));
    }
    wheel(p, 65, 44, 4);
    contact(p, 71, 79, 42);
  },

  munitions(p, s) {
    vaultShell(p, s);
    wallPipes(p, 16, 8, 112, DARK, 2, 28);
    solid(p, 6, 22, 46, 56, DARK, { lit: 0.22, dark: -0.26 });
    port(p, 11, 28, 36, 32, tone(PAL.deep, 0.02));
    inner(p, 18, 29, 22, 16, STEEL);
    inner(p, 21, 45, 16, 8, STEEL_LIT);
    p.hline(12, 55, 34, tone(STEEL, -0.42));
    inner(p, 9, 64, 40, 6, tone(DARK, -0.3));
    wheel(p, 44, 68, 5);
    gauge(p, 12, 64, 9);
    solid(p, 58, 26, 64, 26, tone(PAL.steelDark, -0.18), { lit: 0.2, dark: -0.26 });
    for (let k = 0; k < 7; k++) {
      const x = 61 + k * 9;
      p.rect(x, 29, 6, 20, tone(AMBER, -0.32));
      p.vline(x, 29, 20, tone(AMBER, -0.06));
      p.vline(x + 5, 29, 20, tone(AMBER, -0.55));
      p.rect(x, 30, 6, 3, tone(PAL.rust, 0.1));
      p.hline(x, 30, 6, tone(PAL.rust, 0.3));
    }
    ledge(p, 58, 54, 66, 4, DARK, { caps: false });
    crate(p, 60, 60, 28, 18);
    crate(p, 92, 64, 28, 14, tone(PAL.rust, -0.26));
    p.rect(66, 66, 14, 4, tone(AMBER, -0.2));
    contact(p, 59, 79, 60);
  },

  armory(p, s) {
    vaultShell(p, s, { coneW: 50 });
    ledge(p, 0, 14, CUT_W, 6, tone(PAL.rust, -0.26), { caps: false });
    hazardBand(p, 0, 14, CUT_W, 6);
    solid(p, 4, 24, 64, 30, IRON, { lit: 0.22, dark: -0.26 });
    p.rect(7, 27, 58, 24, tone(PAL.concrete, -0.06));
    p.hline(7, 27, 58, tone(PAL.concrete, 0.16));
    for (let k = 0; k < 5; k++) longarm(p, 13 + k * 12, 28, 22);
    ledge(p, 4, 58, 64, 6, WOOD_LIT, { caps: false });
    leg(p, 8, 65, 13, WOOD);
    leg(p, 62, 65, 13, WOOD);
    solid(p, 12, 48, 16, 10, STEEL_LIT, { lit: 0.24, dark: -0.3 });
    p.rect(16, 51, 8, 5, GLASS);
    for (let k = 0; k < 4; k++) {
      p.rect(38 + k * 6, 49, 4, 8, tone(AMBER, -0.3));
      p.hline(38 + k * 6, 49, 4, tone(AMBER, 0.1));
      p.hline(38 + k * 6, 57, 4, PAL.ink);
    }
    crate(p, 22, 66, 28, 12, tone(PAL.rust, -0.3));
    locker(p, 74, 24, 24, 54);
    locker(p, 100, 24, 24, 54);
    contact(p, 3, 79, 66);
    contact(p, 73, 79, 52);
  },

  barracks(p, s) {
    vaultShell(p, s, { coneW: 66 });
    ledge(p, 4, 22, 120, 2, STEEL, { caps: false });
    for (let k = 0; k < 6; k++) {
      const x = 10 + k * 20;
      solid(p, x, 25, 14, 16, tone(PAL.rust, -0.34), { lit: 0.22, dark: -0.28 });
      p.hline(x + 1, 29, 12, tone(PAL.rust, -0.1));
      p.hline(x + 1, 35, 12, tone(PAL.rust, -0.5));
      p.set(x + 7, 24, STEEL_LIT);
    }
    for (let k = 0; k < 3; k++) {
      const x = 6 + k * 40;
      cot(p, x, 73, 34);
      solid(p, x + 2, 56, 30, 7, IRON, { lit: 0.22, dark: -0.28 });
      p.rect(x + 4, 58, 26, 4, CLOTH);
      p.rect(x + 4, 58, 9, 4, tone(PAL.rust, -0.3));
      p.hline(x + 4, 58, 9, tone(PAL.rust, -0.05));
      leg(p, x + 4, 63, 9, IRON);
      leg(p, x + 29, 63, 9, IRON);
      contact(p, x - 1, 79, 36);
    }
    solid(p, 110, 44, 14, 34, DARK, { lit: 0.2, dark: -0.26 });
    for (let j = 48; j < 74; j += 6) {
      p.hline(112, j, 10, tone(DARK, 0.2));
      p.hline(112, j + 1, 10, tone(DARK, -0.4));
    }
  },

  training_yard(p, s) {
    vaultShell(p, s, { coneW: 60 });
    // The scoreboard goes in before the targets, so a target that overlaps it
    // reads as standing in front of it rather than as a bite out of the card.
    solid(p, 4, 20, 30, 14, DARK, { lit: 0.2, dark: -0.26 });
    inner(p, 7, 23, 24, 8, tone(PAL.verdigris, -0.5));
    p.hline(9, 25, 14, tone(PAL.bone, -0.3));
    ledge(p, 0, 66, CUT_W, 12, tone(PAL.rust, -0.46), { caps: false });
    for (let i = 6; i < 124; i += 9) p.vline(i, 68, 9, tone(PAL.rust, -0.58));
    target(p, 84, 34, 14);
    p.vline(84, 48, 18, PAL.ink);
    p.vline(83, 48, 18, DARK);
    p.hline(79, 66, 11, DARK);
    solid(p, 100, 20, 24, 32, tone(PAL.rust, -0.2), { lit: 0.22, dark: -0.28 });
    p.hline(102, 30, 20, tone(PAL.rust, -0.5));
    p.hline(102, 42, 20, tone(PAL.rust, -0.5));
    p.speckle(101, 21, 22, 30, RUST_DK, 0.08, s + ':wear');
    p.vline(112, 12, 8, PAL.ink);
    ledge(p, 6, 46, 54, 6, WOOD, { caps: false });
    leg(p, 10, 53, 13, WOOD);
    leg(p, 54, 53, 13, WOOD);
    longarmFlat(p, 10, 38, 46);
    solid(p, 24, 41, 10, 5, IRON, { lit: 0.22, dark: -0.28 });
    for (let k = 0; k < 8; k++) p.set(12 + k * 6, 70 + (k & 1) * 3, tone(AMBER, -0.12));
    crate(p, 62, 62, 16, 16, tone(PAL.rust, -0.34));
    contact(p, 61, 79, 18);
  },

  sheriffs_office(p, s) {
    vaultShell(p, s, { coneW: 48 });
    star(p, 22, 30, 12);
    solid(p, 42, 18, 42, 28, DARK, { lit: 0.2, dark: -0.26 });
    const r = rng(s + ':board');
    for (let k = 0; k < 6; k++) {
      inner(p, 45 + (k % 3) * 13, 21 + ((k / 3) | 0) * 12, 11, 10, tone(PAL.bone, -0.18 - r() * 0.34));
    }
    ledge(p, 8, 52, 64, 6, WOOD_LIT, { caps: false });
    solid(p, 12, 59, 28, 19, WOOD, { lit: 0.22, dark: -0.28 });
    for (let j = 62; j < 76; j += 6) {
      p.hline(14, j, 24, tone(WOOD, 0.22));
      p.hline(14, j + 1, 24, tone(WOOD, -0.44));
      p.hline(24, j + 2, 4, STEEL_LIT);
    }
    leg(p, 68, 59, 19, WOOD);
    solid(p, 14, 40, 16, 7, tone(PAL.rust, -0.18), { lit: 0.2, dark: -0.26 });
    p.hline(16, 45, 12, AMBER);
    spill(p, 12, 47, 20, 5, tone(AMBER, -0.5), 0.5);
    p.vline(21, 47, 5, PAL.ink);
    solid(p, 46, 46, 20, 6, tone(PAL.bone, -0.24), { lit: 0.24, dark: -0.28 });
    drawerBank(p, 90, 32, 32, 46, 1, 4);
    solid(p, 90, 26, 32, 6, DARK, { lit: 0.2, dark: -0.26 });
    contact(p, 89, 79, 34);
  },

  // Three cells and the warder's post. A wall of bars filling the whole frame
  // is a texture rather than a room: the block stops short of the ceiling and
  // of the right-hand wall so that the vault, the lamp, the desk and the keys
  // have somewhere to be, and each cell keeps a lit back wall behind its bars
  // so there is depth to see into.
  holding_cells(p, s) {
    vaultShell(p, s, { coneW: 44, lightX: 104 });
    const bx = 4;
    for (let k = 0; k < 3; k++) {
      const x = bx + 1 + k * 29;
      const w = 28;
      p.rect(x, 25, w, 53, tone(PAL.deep, -0.06));
      fade(p, x, 25, w, 20, tone(PAL.deeper, -0.14), 0.95);
      p.hline(x, 25, w, tone(PAL.deeper, -0.3));
      // The bunk against the cell's back wall, and the slop bucket.
      p.rect(x + 3, 58, 20, 6, IRON);
      p.hline(x + 3, 58, 20, tone(IRON, 0.32));
      p.rect(x + 4, 60, 8, 3, CLOTH);
      p.hline(x + 4, 60, 8, tone(PAL.bone, -0.06));
      p.hline(x + 3, 64, 20, PAL.ink);
      leg(p, x + 4, 65, 8, IRON);
      leg(p, x + 20, 65, 8, IRON);
      p.rect(x + 24, 72, 3, 5, tone(STEEL, -0.4));
      p.hline(x + 24, 72, 3, tone(STEEL, -0.1));
      // Bars, and the two cross rails they are welded to.
      for (let i = x + 1; i < x + w - 1; i += 5) {
        p.vline(i, 25, 53, tone(STEEL, 0.16));
        p.vline(i + 1, 25, 53, tone(STEEL, -0.46));
      }
      p.hline(x, 34, w, tone(STEEL, 0.1));
      p.hline(x, 35, w, tone(STEEL, -0.52));
      p.hline(x, 68, w, tone(STEEL, 0.1));
      p.hline(x, 69, w, tone(STEEL, -0.52));
      solid(p, x + 11, 42, 9, 12, STEEL_LIT, { lit: 0.24, dark: -0.3 });
      p.rect(x + 14, 46, 3, 4, tone(PAL.deeper, 0.04));
      p.set(x + 15, 51, tone(STEEL, -0.3));
      p.speckle(x + 2, 71, w - 4, 6, RUST_DK, 0.1, `${s}:c${k}`);
      if (k) p.vline(x - 1, 24, 54, PAL.ink);
    }
    p.frame(bx, 24, 88, 54, PAL.ink);
    // The warder's post: the key board, the day book, the lamp and the stool.
    solid(p, 98, 26, 26, 20, WOOD, { lit: 0.22, dark: -0.28 });
    for (let j = 0; j < 3; j++) {
      p.hline(100, 29 + j * 6, 22, tone(WOOD, -0.4));
      for (let i = 0; i < 5; i++) {
        p.set(101 + i * 5, 30 + j * 6, tone(PAL.bone, -0.16));
        p.set(101 + i * 5, 31 + j * 6, tone(PAL.sodium, -0.3));
      }
    }
    solid(p, 106, 48, 12, 7, tone(PAL.rust, -0.2), { lit: 0.2, dark: -0.26 });
    p.hline(108, 54, 8, AMBER);
    spill(p, 103, 55, 18, 6, tone(AMBER, -0.5), 0.55);
    ledge(p, 94, 62, 30, 5, WOOD_LIT, { caps: false });
    leg(p, 97, 68, 10, WOOD);
    leg(p, 120, 68, 10, WOOD);
    p.rect(100, 58, 12, 4, tone(PAL.bone, -0.16));
    p.hline(100, 58, 12, tone(PAL.bone, -0.02));
    p.hline(100, 61, 12, tone(PAL.rust, -0.6));
    solid(p, 114, 70, 9, 8, IRON, { lit: 0.22, dark: -0.28 });
    contact(p, 93, 79, 32);
  },

  laboratory(p, s) {
    vaultShell(p, s);
    wallPipes(p, 15, 10, 108, STEEL, 2, 32);
    const c = tube(p, 6, 38, 36, 40, STEEL_LIT);
    seam(p, c.x - 3, 47, c.w + 6, PAL.steelLit, -0.44);
    inner(p, c.x, 54, c.w, 14, tone(PAL.steelLit, -0.28));
    gauge(p, 16, 58, 9);
    pipev(p, 20, 22, 16, 3, STEEL);
    deskPanel(p, 48, 22, 42, 32, tone(PAL.sodium, -0.28));
    ledge(p, 46, 58, 46, 5, DARK, { caps: false });
    leg(p, 50, 64, 14, IRON);
    leg(p, 88, 64, 14, IRON);
    solid(p, 96, 20, 28, 58, DARK, { lit: 0.2, dark: -0.26 });
    for (let k = 0; k < 4; k++) {
      const y = 24 + k * 13;
      for (let i = 0; i < 8; i++) {
        const t = i % 2 ? tone(PAL.verdigris, 0.06) : tone(PAL.bone, -0.28);
        p.rect(99 + i * 3, y, 2, 9, t);
        p.hline(99 + i * 3, y, 2, tone(t, 0.3));
      }
      p.hline(97, y + 9, 26, tone(STEEL, 0.12));
      p.hline(97, y + 10, 26, tone(STEEL, -0.4));
    }
    contact(p, 5, 79, 38);
  },

  archive(p, s) {
    vaultShell(p, s, { coneW: 44 });
    solid(p, 4, 16, 62, 62, WOOD, { lit: 0.22, dark: -0.28 });
    for (let k = 0; k < 6; k++) {
      const y = 19 + k * 10;
      spines(p, 7, y, 56, 8, `${s}:shelf${k}`);
      p.hline(6, y + 9, 58, tone(WOOD, 0.22));
    }
    drawerBank(p, 74, 40, 40, 38, 4, 4, WOOD_LIT);
    solid(p, 74, 34, 40, 6, WOOD, { lit: 0.24, dark: -0.3 });
    solid(p, 78, 26, 15, 8, tone(PAL.bone, -0.24), { lit: 0.24, dark: -0.28 });
    solid(p, 98, 22, 14, 12, tone(PAL.verdigris, -0.28), { lit: 0.2, dark: -0.26 });
    p.hline(100, 33, 10, AMBER);
    spill(p, 98, 34, 14, 5, tone(AMBER, -0.5), 0.5);
    p.speckle(70, 66, 54, 12, RUST_DK, 0.06, s + ':dust');
    contact(p, 73, 79, 42);
  },

  schoolhouse(p, s) {
    vaultShell(p, s, { coneW: 60 });
    solid(p, 6, 18, 76, 34, tone(PAL.verdigris, -0.64), { lit: 0.14, dark: -0.18 });
    const r = rng(s + ':chalk');
    for (let k = 0; k < 7; k++) {
      p.hline(10 + ((r() * 8) | 0), 22 + k * 4, 14 + ((r() * 46) | 0), tone(PAL.bone, -0.26));
    }
    p.rect(10, 49, 9, 2, PAL.bone);
    ledge(p, 6, 52, 76, 3, WOOD, { caps: false });
    for (let k = 0; k < 3; k++) {
      const x = 12 + k * 26;
      ledge(p, x, 62, 22, 5, WOOD_LIT);
      leg(p, x + 2, 68, 10, WOOD);
      leg(p, x + 18, 68, 10, WOOD);
      solid(p, x + 5, 55, 12, 7, WOOD, { lit: 0.22, dark: -0.28 });
      p.rect(x + 7, 58, 8, 2, tone(PAL.bone, -0.2));
      p.hline(x + 7, 58, 8, tone(PAL.bone, -0.02));
      contact(p, x - 1, 79, 24);
    }
    p.vline(104, 48, 30, PAL.ink);
    p.vline(103, 48, 30, DARK);
    p.hline(99, 77, 12, DARK);
    disc(p, 104, 36, 12, tone(PAL.verdigris, -0.18));
    p.hline(94, 36, 21, tone(PAL.verdigris, 0.28));
    p.hline(96, 30, 16, tone(PAL.verdigris, 0.1));
  },

  radio_room(p, s) {
    vaultShell(p, s, { coneW: 44 });
    solid(p, 6, 18, 50, 60, DARK, { lit: 0.22, dark: -0.26 });
    disc(p, 22, 34, 13, tone(PAL.deep, 0.02));
    ring(p, 22, 34, 12, tone(PAL.verdigris, 0.18));
    p.hline(11, 34, 23, tone(PAL.verdigris, 0.46));
    p.hline(18, 29, 5, tone(PAL.verdigris, 0.6));
    p.hline(25, 39, 5, tone(PAL.verdigris, 0.6));
    for (let k = 0; k < 4; k++) gauge(p, 40, 22 + k * 12, 10);
    for (let k = 0; k < 6; k++) p.rect(10 + k * 6, 52, 4, 12, k % 2 ? tone(STEEL, -0.22) : tone(STEEL, 0.12));
    p.hline(8, 68, 46, tone(DARK, -0.42));
    p.hline(8, 72, 46, tone(DARK, -0.42));
    pipev(p, 68, 14, 44, 3, STEEL_LIT);
    for (let j = 18; j < 56; j += 8) {
      p.rect(64, j, 11, 3, tone(PAL.bone, -0.34));
      p.hline(64, j, 11, tone(PAL.bone, -0.08));
      p.hline(64, j + 3, 11, PAL.ink);
    }
    elbowAt(p, 66, 58, 3, STEEL);
    solid(p, 78, 20, 32, 22, DARK, { lit: 0.2, dark: -0.26 });
    const r = rng(s + ':map');
    for (let k = 0; k < 5; k++) p.hline(81 + ((r() * 6) | 0), 24 + k * 3, 6 + ((r() * 18) | 0), tone(PAL.verdigris, -0.2));
    ledge(p, 78, 52, 46, 5, WOOD, { caps: false });
    leg(p, 82, 58, 20, WOOD);
    leg(p, 120, 58, 20, WOOD);
    p.vline(95, 44, 8, PAL.ink);
    solid(p, 91, 36, 10, 8, DARK, { lit: 0.24, dark: -0.3 });
    solid(p, 106, 44, 14, 8, IRON, { lit: 0.22, dark: -0.28 });
    p.hline(108, 46, 10, tone(STEEL, 0.2));
    contact(p, 5, 79, 52);
  },

  airlock(p, s) {
    vaultShell(p, s, { coneW: 36 });
    ledge(p, 0, 14, CUT_W, 7, CONC, { caps: false });
    hazardBand(p, 0, 14, CUT_W, 7);
    solid(p, 12, 24, 80, 54, CONC, { lit: 0.2, dark: -0.26 });
    rivets(p, 16, 27, 18, 4, tone(PAL.concrete, 0.3));
    disc(p, 52, 50, 24, DARK);
    ring(p, 52, 50, 20, tone(STEEL, 0.18));
    ring(p, 52, 50, 19, tone(STEEL, -0.44));
    ring(p, 52, 50, 12, tone(STEEL, -0.36));
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const dx = 52 + Math.round(Math.cos(a) * 22);
      const dy = 50 + Math.round(Math.sin(a) * 22);
      inner(p, dx - 1, dy - 1, 3, 3, STEEL_LIT);
    }
    wheel(p, 52, 50, 8);
    deskPanel(p, 96, 30, 28, 26, tone(PAL.sodium, -0.3));
    solid(p, 96, 60, 28, 18, DARK, { lit: 0.22, dark: -0.26 });
    for (let j = 63; j < 76; j += 4) {
      p.hline(99, j, 22, tone(STEEL, 0.12));
      p.hline(99, j + 1, 22, tone(STEEL, -0.44));
    }
    p.rect(28, 75, 56, 3, tone(PAL.toxin, -0.5));
    motes(p, 30, 64, 52, 12, tone(PAL.toxin, -0.24), 16, s + ':seep');
    p.speckle(16, 68, 74, 9, tone(PAL.toxin, -0.4), 0.06, s + ':dust');
  },

  suit_bay(p, s) {
    vaultShell(p, s, { coneW: 62 });
    ledge(p, 2, 20, 124, 2, STEEL_LIT, { caps: false });
    for (let k = 0; k < 4; k++) {
      const x = 6 + k * 22;
      p.vline(x + 8, 22, 2, PAL.ink);
      suitHang(p, x, 24, 18, 44);
      contact(p, x, 79, 18);
    }
    solid(p, 96, 30, 28, 24, DARK, { lit: 0.22, dark: -0.26 });
    solid(p, 100, 34, 20, 15, STEEL_LIT, { lit: 0.24, dark: -0.3 });
    p.rect(104, 38, 12, 8, GLASS);
    p.hline(104, 38, 12, tone(PAL.verdigris, -0.16));
    solid(p, 96, 58, 28, 20, DARK, { lit: 0.22, dark: -0.26 });
    disc(p, 104, 68, 6, STEEL);
    ring(p, 104, 68, 3, tone(STEEL, -0.44));
    gauge(p, 113, 62, 9);
    pipev(p, 110, 54, 5, 3, STEEL);
    solid(p, 4, 66, 18, 12, IRON, { lit: 0.22, dark: -0.28 });
    p.hline(6, 71, 14, tone(IRON, -0.4));
  },

  // The same read at four times the size: the tube bank fills the left, the
  // condensate drum and the cold line stand on the right, and the hot feed
  // crosses the top. Cold palette throughout, against the Foundry's rust.
  heat_exchange(p, s) {
    vaultShell(p, s, { coneW: 58 });
    wallPipes(p, 13, 8, 112, tone(PAL.rust, -0.34), 3, 30);
    solid(p, 6, 22, 68, 56, DARK, { lit: 0.2, dark: -0.26 });
    for (let k = 0; k < 6; k++) {
      const x = 11 + k * 11;
      inner(p, x, 26, 6, 44, tone(PAL.steel, k % 2 ? 0.06 : -0.14));
      for (let y = 28; y < 69; y += 5) p.hline(x - 2, y, 10, tone(PAL.verdigris, -0.3));
    }
    inner(p, 8, 71, 64, 4, tone(DARK, -0.32));
    motes(p, 10, 66, 60, 6, tone(PAL.verdigris, 0.12), 10, s + ':drip');
    drum(p, 80, 40, 20, 38, tone(PAL.verdigris, -0.34));
    drum(p, 104, 52, 18, 26, tone(PAL.verdigris, -0.22));
    pipev(p, 88, 22, 18, 4, tone(PAL.verdigris, -0.2));
    tap(p, 91, 77, 7);
    p.speckle(76, 76, 48, 6, tone(PAL.verdigris, -0.4), 0.07, s + ':wet');
    contact(p, 79, 79, 22);
    contact(p, 103, 79, 20);
  },

  storage_depot(p, s) {
    vaultShell(p, s, { coneW: 58 });
    solid(p, 4, 16, 64, 62, DARK, { lit: 0.2, dark: -0.26 });
    for (let k = 0; k < 4; k++) {
      const y = 19 + k * 15;
      crate(p, 7, y, 27, 12, k % 2 ? tone(PAL.rust, -0.26) : WOOD);
      crate(p, 37, y, 27, 12, k % 2 ? WOOD : tone(PAL.rust, -0.26));
      p.hline(6, y + 12, 60, tone(STEEL, 0.14));
      p.hline(6, y + 13, 60, tone(STEEL, -0.4));
    }
    crate(p, 74, 52, 30, 26);
    crate(p, 78, 32, 22, 20, tone(PAL.rust, -0.26));
    drum(p, 108, 46, 16, 32);
    drum(p, 108, 24, 16, 21, tone(PAL.verdigris, -0.32));
    p.speckle(70, 70, 54, 8, RUST_DK, 0.07, s + ':floor');
    contact(p, 73, 79, 32);
    contact(p, 107, 79, 18);
  },

  // The one room in the silo that is not a finished bunker: bare cut stone
  // behind, not machine-laid brick.
  deep_mine(p, s) {
    vaultShell(p, s, { wall: tone(PAL.concrete, -0.2), coneW: 40, lightW: 11, rock: true });
    rockface(p, 74, 14, 54, 64, s + ':face');
    ledge(p, 0, 12, 76, 8, DARK, { caps: false });
    ibeam(p, 8, 20, 10, 58);
    ibeam(p, 44, 20, 10, 58);
    rails(p, 0, 72, 76);
    solid(p, 20, 48, 36, 24, IRON, { lit: 0.24, dark: -0.3 });
    p.rect(23, 43, 30, 5, tone(PAL.concrete, -0.3));
    p.hline(23, 43, 30, tone(PAL.concrete, -0.02));
    for (let k = 0; k < 5; k++) {
      const ox = 25 + k * 6;
      p.hline(ox, 42, 4, tone(PAL.sodium, -0.42));
      p.set(ox + 1, 41, tone(PAL.sodium, -0.2));
    }
    p.hline(22, 68, 32, tone(IRON, -0.42));
    disc(p, 26, 74, 4, DARK);
    disc(p, 48, 74, 4, DARK);
    p.vline(64, 20, 6, PAL.ink);
    solid(p, 60, 26, 10, 7, tone(PAL.rust, -0.22), { lit: 0.2, dark: -0.26 });
    p.hline(62, 32, 6, AMBER);
    spill(p, 58, 33, 14, 6, tone(AMBER, -0.5), 0.5);
    motes(p, 58, 36, 16, 34, tone(PAL.concrete, 0.14), 14, s + ':dust');
    crate(p, 4, 62, 14, 16, tone(PAL.rust, -0.34));
  },

  maintenance_bay(p, s) {
    vaultShell(p, s);
    wallPipes(p, 16, 8, 112, STEEL, 3, 22);
    solid(p, 4, 24, 46, 30, DARK, { lit: 0.2, dark: -0.26 });
    const r = rng(s + ':orders');
    for (let k = 0; k < 8; k++) {
      inner(p, 7 + (k % 4) * 11, 27, 9, 10, tone(PAL.bone, -0.2 - r() * 0.34));
      inner(p, 7 + (k % 4) * 11, 40, 9, 10, tone(PAL.bone, -0.2 - r() * 0.34));
    }
    solid(p, 4, 60, 40, 18, tone(PAL.rust, -0.24), { lit: 0.22, dark: -0.28 });
    p.hline(6, 68, 36, tone(PAL.rust, -0.48));
    inner(p, 8, 54, 20, 6, DARK);
    disc(p, 11, 77, 3, DARK);
    disc(p, 38, 77, 3, DARK);
    ladder(p, 56, 22, 13, 56);
    solid(p, 78, 44, 30, 34, DARK, { lit: 0.22, dark: -0.26 });
    gauge(p, 81, 47, 10);
    p.rect(94, 48, 9, 20, tone(STEEL, -0.22));
    p.hline(94, 48, 9, tone(STEEL, 0.12));
    p.vline(103, 48, 20, PAL.ink);
    for (let j = 52; j < 66; j += 4) p.hline(95, j, 7, tone(STEEL, -0.44));
    p.vline(110, 46, 32, tone(PAL.rust, -0.16));
    p.vline(111, 46, 32, PAL.ink);
    solid(p, 106, 34, 15, 12, IRON, { lit: 0.22, dark: -0.28 });
    p.rect(110, 38, 6, 5, PAL.bone);
    sparks(p, 104, 26, 18, 14, 16, s + ':arc');
    contact(p, 77, 79, 32);
    p.speckle(56, 70, 22, 8, RUST_DK, 0.09, s + ':swarf');
  },
};

// =============================================================================
// EXPORTS
//
// WHAT STILL HAS TO BE WIRED UP, because none of it belongs in this file:
//
//   1. tools/gen-atlas.mjs does not import this module — it still draws its own
//      rect-only room blocks — so none of this art reaches the game yet. It
//      needs to allocate FIXTURE_SIZE per id under FIXTURE_PREFIX and call
//      ROOM_FIXTURES[id](painter). src/render/floors.js already looks the
//      frames up under exactly those names, so that is a drop-in.
//   2. src/render/floors.js must stop insetting the fixture box, or the 64x36
//      art is fractionally resampled — see FIXTURE_DEST and the header.
//   3. The cutaways have NO consumer. src/ui/roomView.js reaches for art
//      through the DOM path (src/data/artwork.js + assets/art/index.json,
//      currently `{}`), not through the atlas, so serving them needs either a
//      draw call there or a PNG export with index.json entries. They are also
//      316 KB of pixels and should not sit in the boot-critical sheet: a second
//      atlas is the right home.
// =============================================================================

/**
 * Bind each room's drawing function to a seed derived from its own id.
 *
 * The seed decides every speckle, spark, mote, brick and book spine in the
 * sprite, so if the caller supplied it, a generator that passed anything other
 * than the exact convention would silently rewrite the whole atlas and the
 * diff would be total. The prefixes are exported so the atlas generator names
 * its frames the same way the renderer looks them up (`room_<id>` in
 * src/render/floors.js drawFixture).
 */
export const FIXTURE_PREFIX = 'room_';
export const CUTAWAY_PREFIX = 'cutaway_';

function bind(art, prefix) {
  const out = {};
  for (const id of Object.keys(art)) out[id] = (p) => art[id](p, prefix + id);
  return out;
}

export const ROOM_FIXTURES = bind(FIXTURE_ART, FIXTURE_PREFIX);
export const ROOM_CUTAWAYS = bind(CUTAWAY_ART, CUTAWAY_PREFIX);

export const FIXTURE_SIZE = { w: FX_W, h: FX_H };
export const CUTAWAY_SIZE = { w: CUT_W, h: CUT_H };

/**
 * The destination rectangle a fixture must be blitted into for its pixels to
 * land 1:1, in world units, for src/render/floors.js to assert against. Today
 * drawRoom() insets by GAP and loses four columns and three rows to a
 * fractional nearest-neighbour resample; see the header.
 */
export const FIXTURE_DEST = {
  x: (room) => room.slot * 64,
  y: (room) => (room.floor - 1) * 40 + 1,
  bayW: 64,
  h: 36,
  note: 'drawRoom must not inset the fixture box by GAP; bayW must be exactly 64',
};

/** Slot widths, mirrored from src/data/rooms.js. A room wider than one slot is
 *  drawn once per bay, so its art has to tile — the self-test checks it. */
export const ROOM_WIDTHS = {
  generator_hall: 2, reactor: 3, water_reclaimer: 2, hydroponics: 2, protein_vats: 2,
  air_filtration: 2, residences: 2, cafeteria: 2, clinic: 2, chem_lab: 2, workshop: 2,
  recycling: 2, foundry: 2, munitions: 2, armory: 2, barracks: 2, training_yard: 2,
  sheriffs_office: 1, holding_cells: 1, laboratory: 2, archive: 2, schoolhouse: 2,
  radio_room: 1, airlock: 2, suit_bay: 2, storage_depot: 1, deep_mine: 3, maintenance_bay: 1,
  heat_exchange: 2,
};

export default {
  ROOM_IDS, ROOM_FIXTURES, ROOM_CUTAWAYS, ROOM_WIDTHS,
  FIXTURE_SIZE, CUTAWAY_SIZE, FIXTURE_DEST, FIXTURE_PREFIX, CUTAWAY_PREFIX,
};

// =============================================================================
// Self-test: node tools/art/rooms.mjs
//
// Renders every fixture and every cutaway into a real atlas and checks the
// things the eye cannot check quickly:
//
//   - all 28 ids covered, nothing empty, nothing accidentally opaque;
//   - PALETTE. Every painted pixel is exactly shade(PAL_entry, t) for some
//     entry and some t, decided by interval arithmetic rather than by sampling
//     t on a grid. The first version of this test printed "palette law upheld"
//     while checking only a hand-tuned green-channel inequality, which is how
//     5401 off-ray pixels and 135 off-palette colours shipped; the second
//     sampled the ray at 1/1000 and failed the build on shade(PAL.bone, -0.3755)
//     — a legal colour that simply falls between two grid steps;
//   - LACE and INK. Two numbers, not one. See THE KEYLINE BUDGET in the header.
//     Lace is the check that stops the art drifting back into black lace one
//     detail at a time; total ink is a backstop against the 51% failure;
//   - TOXIN. On PAL.toxin's ray and nowhere but the reactor and the airlock.
//     Membership is by ray, not by channel inequality — the old test's guard
//     had a hole at t <= -0.52, which is a shade a room could plausibly use;
//   - TILING. A room wider than one slot is drawn once per bay from the same
//     frame, so it needs rows where column 0 and column 63 match;
//   - RESERVED REGIONS. The renderer paints status glyphs over the top-right
//     corner and level pips over the bottom-left strip, both at partial alpha
//     and both exactly when the player is looking, so both are checked for
//     enough contrast against whatever the fixture put underneath;
//   - DISTINCTNESS, by mean colour per cell rather than by a mean-thresholded
//     luminance bit — the old signature was blind to hue, so two rooms with
//     the same layout in different palettes scored as maximally different, and
//     it named pairs that look nothing alike. The threshold comes from the
//     observed distribution and the five closest pairs print every run, so it
//     is maintained by eye rather than by a constant nobody revisits.
// =============================================================================

/**
 * THE TWO INK NUMBERS, AND WHY THERE ARE TWO.
 *
 * The obvious measure — pure-black pixels over painted pixels — is the one the
 * audit used to catch the first draft at 29-51%, and it was right to. But it
 * cannot be pushed much below 24% on a transparent sprite without abolishing
 * the keyline, and the keyline is the style. The arithmetic: a convex outlined
 * solid costs (2(w+h)-4)/(w*h) in ink, which is 15% for a 24x20 machine, 25%
 * for a 12x20 hanging suit and 30% for a 12x12 crate. A 64x36 fixture holding
 * three or four objects that size, standing on nothing but the shaft behind
 * them, is 25% ink before a single detail is drawn. So a flat 15-18% target
 * cannot be met by outlined art at this size; anything reporting that it had
 * been met would be reporting that the outlines were gone.
 *
 * What actually went wrong in the first draft was not outlines, it was outlines
 * around things that were already inside an outline. That has a signature the
 * eye agrees with and the machine can see: ink that touches no empty pixel.
 * A silhouette keyline always has the room behind it on one side; lace never
 * does. So LACE is budgeted hard, and total ink keeps a loose ceiling as a
 * backstop against the 51% failure.
 *
 * Cutaways are fully opaque, so every one of their ink pixels is "lace" by that
 * test and only the total is meaningful there. They sit at 9-15%, which is what
 * the same drawing discipline costs when the room behind the object is painted.
 */
const INK_BUDGET = { fixture: 0.30, cutaway: 0.16 };
const LACE_BUDGET = { fixture: 0.12, cutaway: 1 };
/**
 * The distinctness floor, set just under the observed minimum so that it can
 * actually fire. The previous constant was 6 against a distribution whose
 * minimum was 8: it had never rejected anything and never could, which is the
 * failure mode of any threshold picked before the numbers were looked at. The
 * five closest pairs print on every run so this is maintained by eye.
 */
const DISTINCT_MIN = { fixture: 26, cutaway: 17 };
/**
 * The two regions the renderer paints ITS OWN marks into, on top of whatever
 * the fixture drew there (src/render/floors.js drawRoom): up to three 8px
 * status glyphs stepping left from the top-right corner, and the level pips —
 * five 2x2 blocks of 60%-alpha bone — along the bottom-left strip.
 *
 * Both are checked rather than left to a comment, because both are painted
 * exactly when the player is looking: a room is unpowered, unstaffed, damaged
 * or contaminated, or has just been upgraded.
 */
const GLYPH_BOX = { x: FX_W - 27, y: 0, w: 27, h: 9 };
const PIP_BOX = { x: 3, y: FX_H - 7, w: 18, h: 3 };
const BONE_LUMA = PAL.bone[0] * 0.3 + PAL.bone[1] * 0.59 + PAL.bone[2] * 0.11;
const PIP_ALPHA = 0.6;
const PIP_MIN_CONTRAST = 48;

/**
 * Is `c` exactly shade(base, ±k) for some k in [0,1]?
 *
 * shade rounds each channel independently, so each channel admits an interval
 * of k and the colour is on the ray only if the three intervals intersect.
 * Testing by SAMPLING t — which is what the first version of this test did, on
 * a 1/1000 grid — misses every colour that exists only between two grid steps:
 * shade(PAL.bone, -0.3755) is (136,131,122), is perfectly legal art, and no
 * grid t produces it, so the build failed on a colour it had itself declared
 * legal. Interval arithmetic is exact and needs no tolerance.
 */
function onRay(base, to, c) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 3; i++) {
    const d = to[i] - base[i];
    if (d === 0) {
      if (c[i] !== base[i]) return false;
      continue;
    }
    const a = (c[i] - 0.5 - base[i]) / d;
    const b = (c[i] + 0.5 - base[i]) / d;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
  }
  if (lo > hi) return false;
  const k = (lo + hi) / 2;
  for (let i = 0; i < 3; i++) if (Math.round(base[i] + (to[i] - base[i]) * k) !== c[i]) return false;
  return true;
}

const RAY_CACHE = new Map();

/** Which PAL entries can reach this colour. Empty means off-palette. */
function rayNames(key) {
  let names = RAY_CACHE.get(key);
  if (names) return names;
  const c = key.split(',').map(Number);
  names = [];
  for (const [name, base] of Object.entries(PAL)) {
    if (onRay(base, [0, 0, 0], c) || onRay(base, PAL.bone, c)) names.push(name);
  }
  RAY_CACHE.set(key, names);
  return names;
}

const isLegal = (key) => rayNames(key).length > 0;

/** A pixel is toxin if the only palette entry that reaches it is toxin. */
function isToxin(key) {
  const names = rayNames(key);
  return names.length === 1 && names[0] === 'toxin';
}

function px(sheet, at, x, y) {
  const i = ((at.y + y) * sheet.size + (at.x + x)) * 4;
  return [sheet.px[i], sheet.px[i + 1], sheet.px[i + 2], sheet.px[i + 3]];
}

const luma = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;

function measure(sheet, at) {
  const out = { painted: 0, opaque: 0, ink: 0, lace: 0, toxin: 0, bad: new Map() };
  const inkKey = PAL.ink.join(',');
  const clear = (x, y) => x < 0 || y < 0 || x >= at.w || y >= at.h || px(sheet, at, x, y)[3] === 0;
  for (let y = 0; y < at.h; y++) {
    for (let x = 0; x < at.w; x++) {
      const c = px(sheet, at, x, y);
      if (c[3] === 0) continue;
      out.painted++;
      if (c[3] === 255) out.opaque++;
      const k = `${c[0]},${c[1]},${c[2]}`;
      if (k === inkKey) {
        out.ink++;
        // Lace is ink that touches no empty pixel: a keyline drawn around
        // something that was already inside another outlined shape.
        if (!clear(x - 1, y) && !clear(x + 1, y) && !clear(x, y - 1) && !clear(x, y + 1)
          && !clear(x - 1, y - 1) && !clear(x + 1, y - 1) && !clear(x - 1, y + 1) && !clear(x + 1, y + 1)) out.lace++;
      }
      if (c[3] !== 255) out.bad.set(`alpha ${c[3]}`, (out.bad.get(`alpha ${c[3]}`) || 0) + 1);
      else if (!isLegal(k)) out.bad.set(k, (out.bad.get(k) || 0) + 1);
      else if (isToxin(k)) out.toxin++;
    }
  }
  return out;
}

/** Mean colour of each of 8x8 cells, with unpainted counted as the shaft dark
 *  the renderer paints behind a fixture. Hue-aware, unlike a luminance bit. */
function signature(sheet, at, cells = 8) {
  const bg = PAL.deeper;
  const sig = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const x0 = Math.floor((at.w * cx) / cells);
      const x1 = Math.max(x0 + 1, Math.floor((at.w * (cx + 1)) / cells));
      const y0 = Math.floor((at.h * cy) / cells);
      const y1 = Math.max(y0 + 1, Math.floor((at.h * (cy + 1)) / cells));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const c = px(sheet, at, x, y);
          const on = c[3] !== 0;
          r += on ? c[0] : bg[0];
          g += on ? c[1] : bg[1];
          b += on ? c[2] : bg[2];
          n++;
        }
      }
      sig.push([r / n, g / n, b / n]);
    }
  }
  return sig;
}

function sigDist(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i][0] - b[i][0]) ** 2 + (a[i][1] - b[i][1]) ** 2 + (a[i][2] - b[i][2]) ** 2;
  }
  return Math.sqrt(sum / a.length);
}

/**
 * What a sprite is MADE OF: the share of its painted pixels reaching each
 * palette entry. This is how a fixture is compared with its own cutaway, since
 * the per-cell colour signature cannot do it — one is a 64x36 mostly-empty
 * frame and the other a 128x88 opaque room, so their layouts have nothing in
 * common and the comparison is swamped by how much of each is background. What
 * the two families genuinely must agree on is the room's vocabulary: the
 * reactor is green, the foundry amber and rust, the archive wood.
 */
function palProfile(sheet, at) {
  const names = Object.keys(PAL);
  const out = new Array(names.length).fill(0);
  let n = 0;
  for (let y = 0; y < at.h; y++) {
    for (let x = 0; x < at.w; x++) {
      const c = px(sheet, at, x, y);
      if (c[3] === 0) continue;
      const hit = rayNames(`${c[0]},${c[1]},${c[2]}`);
      if (!hit.length) continue;
      n++;
      for (const h of hit) out[names.indexOf(h)] += 1 / hit.length;
    }
  }
  return out.map((v) => v / Math.max(1, n));
}

const profDist = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);

/** Rows where the frame's first and last columns match, so bays join up. */
function tileRows(sheet, at) {
  const rows = [];
  for (let y = 0; y < at.h; y++) {
    const a = px(sheet, at, 0, y);
    const b = px(sheet, at, at.w - 1, y);
    if (a[3] && b[3] && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) rows.push(y);
  }
  return rows;
}

function boxLuma(sheet, at, box) {
  let sum = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const c = px(sheet, at, x, y);
      sum += c[3] ? luma(c) : 0;
    }
  }
  return sum / (box.w * box.h);
}

function runSelfTest() {
  const TOXIN_OK = new Set(['reactor', 'airlock']);
  const problems = [];
  const sheet = atlas(2048);
  const rows = [];
  const sigs = { fixture: [], cutaway: [] };

  for (const kind of ['fixture', 'cutaway']) {
    const art = kind === 'fixture' ? FIXTURE_ART : CUTAWAY_ART;
    const map = kind === 'fixture' ? ROOM_FIXTURES : ROOM_CUTAWAYS;
    const size = kind === 'fixture' ? FIXTURE_SIZE : CUTAWAY_SIZE;
    const prefix = kind === 'fixture' ? FIXTURE_PREFIX : CUTAWAY_PREFIX;

    for (const id of ROOM_IDS) if (typeof art[id] !== 'function') problems.push(`${kind}: missing ${id}`);
    for (const id of Object.keys(art)) if (!ROOM_IDS.includes(id)) problems.push(`${kind}: unknown room id "${id}"`);

    for (const id of ROOM_IDS) {
      if (typeof map[id] !== 'function') continue;
      const name = prefix + id;
      const p = sheet.sprite(name, size.w, size.h);
      map[id](p);
      const at = sheet.frames[name];
      const st = measure(sheet, at);
      const cover = st.painted / (size.w * size.h);
      const inkPct = st.ink / Math.max(1, st.painted);
      const lacePct = st.lace / Math.max(1, st.painted);

      if (st.painted === 0) problems.push(`${name}: nothing drawn`);
      if (kind === 'fixture' && cover > 0.94) problems.push(`${name}: fixture is effectively opaque (${(cover * 100) | 0}%) — the category tint cannot read through`);
      if (kind === 'fixture' && cover < 0.24) problems.push(`${name}: fixture is nearly empty (${(cover * 100) | 0}%)`);
      if (kind === 'cutaway' && st.opaque !== size.w * size.h) problems.push(`${name}: cutaway has ${size.w * size.h - st.opaque} non-opaque px`);
      if (inkPct > INK_BUDGET[kind]) problems.push(`${name}: ${(inkPct * 100).toFixed(1)}% keyline, over the ${(INK_BUDGET[kind] * 100) | 0}% ceiling — fewer and bigger shapes`);
      if (lacePct > LACE_BUDGET[kind]) problems.push(`${name}: ${(lacePct * 100).toFixed(1)}% lace, over the ${(LACE_BUDGET[kind] * 100) | 0}% budget — ${st.lace}px of keyline drawn around something already inside an outline`);
      if (st.toxin > 0 && !TOXIN_OK.has(id)) problems.push(`${name}: ${st.toxin}px on PAL.toxin's ray outside reactor/airlock`);
      for (const [k, n] of st.bad) {
        problems.push(`${name}: ${n}px off-palette (${k})`);
        break; // one line per sprite is enough to find it
      }

      let tiles = '';
      if (kind === 'fixture') {
        const tr = tileRows(sheet, at);
        const working = tr.filter((y) => y >= 6 && y <= 31).length;
        tiles = `${tr.length}/${working}`;
        if (ROOM_WIDTHS[id] > 1) {
          if (tr.length < 6) problems.push(`${name}: only ${tr.length} rows join at the bay seam; a ${ROOM_WIDTHS[id]}-slot room needs a continuous run`);
          if (working < 1) problems.push(`${name}: nothing at working height crosses the bay seam — the room reads as two dioramas`);
        }
        const gl = boxLuma(sheet, at, GLYPH_BOX);
        if (gl > 118) problems.push(`${name}: status-glyph corner averages luma ${gl.toFixed(0)} — glyphs will not read on it`);
        // A pip is 60% bone over the art, so its contrast against what is
        // underneath is 0.6 * (bone luma - background luma). Anything pale in
        // the strip — a pillow, a lit screen — swallows it.
        const pipContrast = PIP_ALPHA * (BONE_LUMA - boxLuma(sheet, at, PIP_BOX));
        if (pipContrast < PIP_MIN_CONTRAST) problems.push(`${name}: level pips would land at ${pipContrast.toFixed(0)} luma contrast (need ${PIP_MIN_CONTRAST}) — the bottom-left strip is too pale`);
      }

      sigs[kind].push({ id, sig: signature(sheet, at), prof: palProfile(sheet, at) });
      rows.push({ kind, name, w: size.w, h: size.h, cover, inkPct, lacePct, toxin: st.toxin, tiles });
    }

    const pairs = [];
    for (let i = 0; i < sigs[kind].length; i++) {
      for (let j = i + 1; j < sigs[kind].length; j++) {
        pairs.push({ d: sigDist(sigs[kind][i].sig, sigs[kind][j].sig), a: sigs[kind][i].id, b: sigs[kind][j].id });
      }
    }
    pairs.sort((x, y) => x.d - y.d);
    for (const q of pairs.filter((z) => z.d < DISTINCT_MIN[kind])) {
      problems.push(`${kind}: ${q.a} and ${q.b} are the same picture (${q.d.toFixed(1)} < ${DISTINCT_MIN[kind]})`);
    }
    rows.push({
      divider: `${kind}s: closest — ` + pairs.slice(0, 5).map((q) => `${q.a}/${q.b} ${q.d.toFixed(1)}`).join(', '),
    });
  }

  // Is each room's fixture made of the same palette as its own cutaway?
  //
  // Compared as deviations from each family's own mean, because a cutaway is a
  // walled room and a fixture is machinery hanging in the dark: every cutaway
  // carries a big shared component of concrete coursing that no fixture has,
  // and without centring, the comparison ranks rooms by how much of their wall
  // is covered rather than by what colour they are.
  const centre = (list) => {
    const mean = list[0].prof.map((_, i) => list.reduce((s, e) => s + e.prof[i], 0) / list.length);
    for (const e of list) e.dev = e.prof.map((v, i) => v - mean[i]);
  };
  centre(sigs.fixture);
  centre(sigs.cutaway);
  const strayed = [];
  for (const f of sigs.fixture) {
    let best = null;
    for (const c of sigs.cutaway) {
      const d = profDist(f.dev, c.dev);
      if (!best || d < best.d) best = { d, id: c.id };
    }
    if (best.id !== f.id) strayed.push(`${f.id}->${best.id}`);
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`rooms.mjs — ${ROOM_IDS.length} room types, ${Object.keys(sheet.frames).length} frames\n`);
  for (const r of rows) {
    if (r.divider) { console.log(`  ${r.divider}\n`); continue; }
    console.log(
      `  ${pad(r.name, 26)} ${pad(`${r.w}x${r.h}`, 8)} cover ${pad(`${Math.round(r.cover * 100)}%`, 5)}` +
      ` ink ${pad(`${(r.inkPct * 100).toFixed(1)}%`, 6)}` +
      ` lace ${pad(`${(r.lacePct * 100).toFixed(1)}%`, 6)}` +
      (r.tiles ? ` seam ${pad(r.tiles, 6)}` : '        ') +
      (r.toxin ? `  toxin ${r.toxin}px` : '')
    );
  }
  const fx = rows.filter((r) => r.kind === 'fixture');
  const cu = rows.filter((r) => r.kind === 'cutaway');
  const worst = (list, key) => Math.max(...list.map((r) => r[key]));
  console.log(`  atlas used ${sheet.usedHeight}/${sheet.size} rows`);
  console.log(`  worst keyline: fixtures ${(worst(fx, 'inkPct') * 100).toFixed(1)}%, cutaways ${(worst(cu, 'inkPct') * 100).toFixed(1)}%`);
  console.log(`  worst lace: fixtures ${(worst(fx, 'lacePct') * 100).toFixed(1)}% (budget ${(LACE_BUDGET.fixture * 100) | 0}%)`);
  console.log(`  ${28 - strayed.length}/28 rooms whose fixture and cutaway are made of the same palette`
    + (strayed.length ? `; strayed: ${strayed.slice(0, 6).join(', ')}` : ''));

  if (problems.length) {
    console.log(`\n  ${problems.length} PROBLEM(S):`);
    for (const m of problems.slice(0, 40)) console.log(`    - ${m}`);
    if (problems.length > 40) console.log(`    ... and ${problems.length - 40} more`);
    process.exitCode = 1;
  } else {
    console.log('\n  ok — 56/56 frames drawn, every pixel on a palette ray, keyline inside budget,');
    console.log('       toxin confined to the reactor and the airlock, every multi-slot room tiles.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runSelfTest();
