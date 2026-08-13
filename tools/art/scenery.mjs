/**
 * scenery.mjs — everything in the world that is not a room and not a person.
 *
 * INTEGRATION STATUS — read this before assuming any of it is on screen.
 *   Nothing in this module reaches the game yet. tools/gen-atlas.mjs does not
 *   import it, so assets/atlas.json contains only room_*, citizen_* and
 *   digit_* frames, and src/ never names an env_*, prop_* or threat_* frame.
 *   src/data/artwork.js:THREAT_ART maps hostile keys to art ids but is read
 *   only by tools/import-art.mjs. This is a staged batch, and three edits
 *   outside this file are what land it:
 *     1. gen-atlas.mjs imports TILES/THREATS/PROPS and emits these frames
 *        (SIZE must go 1024 -> 2048; the skyline alone is 256 rows).
 *     2. src/sim/combat.js (or its report view) looks an enemy id up through
 *        THREAT_FOR_ENEMY below to pick a frame.
 *     3. a draw call above y=0 in src/render/floors.js, plus the camera
 *        headroom in canvas.js, for the skyline to be visible at all.
 *   Until then, regenerating this file's art costs nothing and breaks nothing.
 *
 * Four families live here:
 *
 *   drawSkyline()   256x96, opaque. The surface as seen from the airlock and
 *                   the expedition screens: a bleached near-white sky dithered
 *                   down through pale yellow-green into saturated toxin at the
 *                   horizon, three depth layers of ruined industry, and an ash
 *                   plain in front. This is the only picture in the game that
 *                   is allowed to be pretty rather than merely legible, so it
 *                   gets the most work: a hazy sun bloom, atmospheric haze
 *                   over the far layer, and drifting ash.
 *
 *   drawWallTile()  32x32, opaque, SEAMLESS. Poured concrete.
 *   drawRockTile()  32x32, opaque, SEAMLESS. Unexcavated rock, faceted.
 *   drawShaftTile() 32x32, opaque, SEAMLESS. The central lift shaft.
 *
 *   THREATS         eleven creatures and factions, 16x16 / 24x24 / 32x32,
 *                   TRANSPARENT background. Drawn silhouette-first: each one
 *                   has to be nameable from its outline with the colour
 *                   thrown away, which the self-test actually checks by
 *                   padding every sprite into a common pixel field, hashing
 *                   the alpha channel and comparing every pair.
 *
 *   PROPS           fourteen pieces of 16x16 set dressing, TRANSPARENT, all
 *                   standing on row 14 with the keyline on row 15 so they line
 *                   up on a shared floor — except the two that hang off a
 *                   wall, which are named in WALL_PROPS and checked as such.
 *
 * SEAMLESSNESS — how it is guaranteed, not hoped for.
 *   Every tile is painted through torus(), a view whose set() takes the
 *   coordinate modulo the tile size. A crack, a rust streak or a rock facet
 *   that runs off the right edge is therefore the *same write* that lands on
 *   the left edge, and one that runs off the bottom lands on the top. There is
 *   no seam to hide because the two edges are not two edges; they are one.
 *   The self-test then proves it empirically: it measures the mean absolute
 *   RGBA difference between every adjacent column pair inside the tile, and
 *   between column w-1 and column 0 — the pair that becomes adjacent when the
 *   tile repeats — and requires the wrap pair to be no more of a jump than the
 *   worst honest pair inside the tile. Same for row h-1 against row 0.
 *   (Note it does NOT require column w-1 to *equal* column 0: identical edge
 *   columns would mean a duplicated column, which is a visible doubling every
 *   32px, not a seamless tile. Continuity across the join is the property that
 *   matters, and continuity is what is measured.)
 *
 * House rules, same as the rest of the pipeline:
 *   - every solid form carries a 1px PAL.ink keyline. Rather than hand-placing
 *     it on 25 sprites, figures are composed in form() and form.keyline()
 *     grows ink into every empty pixel touching the figure.
 *
 *     ONE DOCUMENTED EXCEPTION, and only one: the FAR ruin band in the skyline
 *     is outlined in a dark concrete tone rather than in ink. The style brief
 *     asks for a keyline on every solid form and, in the same breath, for the
 *     surface layers to be "paler and lower-contrast the further back". Those
 *     two instructions collide on exactly one layer, and aerial perspective
 *     wins there: an ink keyline eight miles away is a hard black line on a
 *     bleached sky and it pulls the far band forward on top of the hero. The
 *     mid band takes full ink; so does the near band, on its shaded faces.
 *     Every other solid in the file, without exception, is inked.
 *   - light comes from the upper left, always. Top and left faces lit, bottom
 *     and right faces shaded.
 *   - colour is PAL, or shade() of PAL, and nothing else — reached through
 *     tone() and toxic(), never by calling shade(PAL.x, …) directly, so the
 *     provenance map stays complete. The self-test proves the rule twice: once
 *     per requested tone and once per painted pixel, by solving for the
 *     colour's position in the triangle (palette entry, black, bone).
 *   - PAL.toxin is radiation and contamination ONLY. tone() throws if you ask
 *     it for toxin; toxic() is the single narrow door, and the self-test
 *     detects toxin-family pixels by hue and fails if they appear anywhere
 *     except the surface sky, the bloater's sacs and the broodmother's eggs.
 *     Note that "the sky" means the sky and the haze standing on the plain —
 *     not the objects lying in it. A rock in the dirt is a rock, however
 *     green the air above it is; see gndC() in drawSkyline.
 *   - all randomness is rng(seed), which this module defines locally rather
 *     than taking from lib.mjs — see the note on rng() below.
 *
 * Self-test:  node tools/art/scenery.mjs
 *             node tools/art/scenery.mjs --out=.shots/scenery.png --zoom=4
 */

import { PAL, shade, hash, painter, atlas } from './lib.mjs';

/**
 * Seeded randomness — mulberry32 over lib's FNV hash().
 *
 * lib.mjs's rng() is fract(sin(seed * 12.9898 + n * 78.233) * 43758.5453) with
 * seed a full uint32, so the argument to sin() reaches ~5.6e10, where a
 * double's ulp is around 1e-5 radians. ECMAScript explicitly permits Math.sin
 * to be implementation-approximated, which means that generator's output is
 * decided by argument-reduction detail and is only stable within one engine
 * build. This file promises byte-identical regeneration, so it does the
 * arithmetic in integers instead: same call shape as lib's rng(), same seeding
 * from hash(), exactly reproducible on any engine. It is deliberately NOT
 * exported — lib's version stays the pipeline default until someone fixes it
 * there.
 */
function rng(seedStr) {
  let a = (hash(seedStr) + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------- palette -- */

/** Every distinct colour this module has produced, "r,g,b" -> provenance. */
const USED = new Map();

const reg = (c, prov) => { USED.set(c.join(','), prov); return c; };

/**
 * The only way to reach an ordinary palette entry. Refuses toxin outright, so
 * a stray `tone('toxin')` is a crash at generation time rather than a green
 * pixel someone notices in a screenshot three weeks later.
 */
export function tone(key, t = 0) {
  const base = PAL[key];
  if (!base) throw new Error(`tone(): "${key}" is not a PAL entry`);
  if (key === 'toxin') throw new Error('tone(): PAL.toxin is reserved — use toxic()');
  return reg(t === 0 ? base : shade(base, t), t ? `${key}@${t}` : key);
}

/**
 * The single door to PAL.toxin. Radiation, contamination, and the surface sky
 * — which is contamination you are looking through. Nothing else.
 */
export function toxic(t = 0) {
  return reg(t === 0 ? PAL.toxin : shade(PAL.toxin, t), `toxin@${t}`);
}

/* --------------------------------------------------------- working tones -- */

const INK = PAL.ink;

// Flesh that has stopped being maintained.
/**
 * Blend two tones.
 *
 * THE OLD DOC HERE WAS WRONG, AND IT SHIPPED A BUG. It said "both ends stay
 * on-palette, so the result does", which is only true when both ends lie on
 * the ray of the SAME palette entry. The legality test below is membership of
 * the triangle (entry, black, bone) for SOME ONE entry, and a straight blend
 * of two DIFFERENT entries leaves every such triangle — it is a chord between
 * two of them, and the interior of a chord is outside both.
 *
 * That is exactly what happened: SUIT was mix(denim, concrete, 0.55) and
 * landed at rgb(72,86,103), which is on no entry's ray at all, and the
 * shambler shipped with 23 off-palette pixels that the self-test correctly
 * reported and nobody could see by eye.
 *
 * So: mix() is for two tones of the same entry, or for a result you have
 * checked. Anything else wants tone().
 *
 * And it now REGISTERS its result, which is the reason the bug survived. The
 * [palette] audit walks USED — every tone the module asked for — and mix()
 * was the one door into a colour that never went through reg(), so the audit
 * reported "every one checked" over a set that excluded the only illegal
 * colour in the file. A blend that never reaches a pixel now fails the build
 * too, instead of waiting to be drawn.
 */
function mix(a, b, t) {
  return reg([
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ], `mix(${a},${b},${t})`);
}

const FLESH = tone('skin', -0.34);
const FLESH_LO = tone('skinShade', -0.46);
const FLESH_HI = tone('skin', -0.16);

// Cloth, in four families that must never be confused with each other at
// 16px: rag (grey), coat (rust), robe (bone) and company (field green). Note
// how far every one of them sits from INK — a cloth tone within sixteen levels
// of the keyline turns the whole figure into one black mass, which is what
// happened to the shambler and the Ash Company soldier when their coats were
// cut from PAL.deep.
const RAG = tone('deep', 0.34);
const RAG_LO = tone('deep', 0.14);
const RAG_HI = tone('deep', 0.52);
const COAT = tone('rust', -0.30);
const COAT_HI = tone('rust', -0.12);
const COAT_LO = tone('rust', -0.50);
const ROBE = tone('bone', -0.26);
const ROBE_HI = tone('bone', -0.08);
const ROBE_LO = tone('bone', -0.46);
const FIELD = tone('verdigris', -0.42);      // Ash Company greatcoat
const FIELD_HI = tone('verdigris', -0.20);
const FIELD_LO = tone('verdigris', -0.58);

// Silo denim — the jumpsuit every citizen wears. Reserved for the shambler,
// which is the one threat whose whole read is "that used to be one of ours".
/**
 * The shambler's jumpsuit.
 *
 * A shambler is a former resident, still in silo issue, and drawing it that
 * way is a better idea than a generic mutant — it means the thing coming at
 * you out of the dust used to work two floors down. But at PAL.denim it was
 * literally the living citizen sprite's colour, so a shambler and a farmer
 * were the same blue figure and the player could not tell a threat from their
 * own people. The dye has gone out of it: desaturated toward the concrete of
 * everything else out there, and darker, so it reads as issue cloth that has
 * been outside for years rather than as somebody's uniform.
 *
 * THE MID TONE WAS OFF-PALETTE and had been since it was written: as
 * mix(denim, concrete, 0.55) it landed on rgb(72,86,103), a chord between two
 * entries and therefore on neither one's ray, and the shambler shipped with 23
 * illegal pixels. It is now the nearest legal colour to what was intended,
 * denimLit darkened, which is rgb(71,85,107) — a move of 4.2 out of 255, below
 * anything an eye resolves in a 16px sprite, and the sprite is otherwise
 * pixel-identical.
 *
 * The highlight and the shade stay as they were. Both were measured against
 * the same test and both DO sit inside the denim triangle, so there is no bug
 * to fix there and no reason to shift art that is already legal — and mix()
 * now registers, so if either ever drifts out the build says so.
 */
const SUIT = tone('denimLit', -0.39);
const SUIT_HI = mix(tone('denimLit'), tone('lit'), 0.5);
const SUIT_LO = mix(tone('denimDark'), tone('deep'), 0.55);

// Mutant hide.
const HIDE = tone('rust', -0.40);
const HIDE_HI = tone('rust', -0.22);
const HIDE_LO = tone('rust', -0.60);

// Bone: claws, teeth, spines, masks.
const BONE = tone('bone', -0.12);
const BONE_LO = tone('bone', -0.38);

// Metal.
const MET = tone('steel');
const MET_HI = tone('steelLit');
const MET_LO = tone('steelDark');
const IRON = tone('steelDark', -0.38);

// Wood and canvas.
const WOOD = tone('rust', -0.46);
const WOOD_HI = tone('rust', -0.28);
const CANVAS = tone('verdigris', -0.34);
const CANVAS_HI = tone('verdigris', -0.14);

// Light sources and warnings. Amber does all ordinary warm work.
const AMBER = tone('sodium');
const AMBER_HI = tone('sodium', 0.42);
const AMBER_LO = tone('sodium', -0.46);
const GREEN = tone('verdigris');
const GREEN_HI = tone('verdigris', 0.34);

// Structure.
const CONC = tone('concrete');
const CONC_HI = tone('concrete', 0.18);
const CONC_LO = tone('concrete', -0.24);
const DARK = tone('deeper', 0.06);

/* -------------------------------------------------------------- sizes -- */

export const SKYLINE_W = 256;
export const SKYLINE_H = 96;
export const TILE = 32;
export const PROP_SIZE = 16;

export const THREAT_SIZES = {
  husk: 16, shambler: 16, bloater: 24, ravager: 24, alpha: 32, broodmother: 32,
  raider: 16, ash_company: 16, scrapjaw: 16, cultist: 16, trader: 16,
};

/**
 * The bridge to src/data/encounters.js, which is the only list of hostiles the
 * game actually fights. It names nine — scrappers, dust_runners, slag_crews,
 * warband (human) and shamblers, rippers, bloats, hulks, broodmother — and
 * none of those ids appears anywhere in this file, so without this table a
 * combat report cannot select a sprite even in principle.
 *
 * Two pairs share a frame, deliberately: scrappers and dust_runners are both
 * lightly-armed scavengers and read identically at 16px, and slag_crews and
 * warband are both organised armour. The tier-5 boss does NOT share: the one
 * fight that decides an expedition gets its own 32x32.
 *
 * The four keys with no encounter — husk, scrapjaw, cultist, trader — are the
 * non-combat figures: survivor, discovery and moral encounters, and the DOM
 * threat cards in src/data/artwork.js:THREAT_ART, which names all of them.
 */
/**
 * FRAME NAMES, and a warning for whoever integrates this.
 *
 * The frames this module registers are `threat_<key>` for the keys above, i.e.
 * threat_raider, threat_ash_company, threat_cultist, threat_trader. The DOM
 * art path in src/data/artwork.js names the same four hostiles
 * threat_wasteland_raider, threat_ash_company_soldier, threat_choir_cultist
 * and threat_freerider_trader — those are ids for a separate commissioned
 * batch of <img> assets, not for these atlas frames, and the two paths are
 * meant to coexist. Do not "reconcile" them by renaming these.
 *
 * If a frame IS renamed, note that the seed is the frame name, so for the five
 * frames that consume randomness — env_skyline, the three tiles, the bloater
 * and the broodmother — a rename also changes the pixels. Every other draw
 * function is fully deterministic and ignores its seed; none of them declares
 * the parameter, so the signature says which is which.
 */
export const THREAT_FOR_ENEMY = {
  scrappers: 'raider',
  dust_runners: 'raider',
  slag_crews: 'ash_company',
  warband: 'ash_company',
  shamblers: 'shambler',
  rippers: 'ravager',
  bloats: 'bloater',
  hulks: 'alpha',
  broodmother: 'broodmother',
};

/* ------------------------------------------------------------- helpers -- */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const pick = (r, arr) => arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))];
const irnd = (r, a, b) => a + Math.floor(r() * (b - a + 1));

/**
 * A view onto a painter whose coordinates wrap. This is the whole seamless
 * story: draw normally, off the edge, and the pixels come back on the other
 * side because they are literally the same pixels.
 *
 * Why this reimplements rect/hline/vline instead of using lib's painter: every
 * one of lib's helpers calls its own captured `set`, which clips at the sprite
 * edge. Wrapping has to happen underneath them, which means owning the write
 * path. The tiles therefore get a deliberately minimal vocabulary — the lit
 * lip on a groove, the shaded face on a rail, all of it is spelled out — and
 * anything that wants lib's box/cylinder/screen is a sprite, not a tile, and
 * goes through libDraw() into a form() instead.
 */
function torus(p, { x: wx = true, y: wy = true } = {}) {
  const W = p.w, H = p.h;
  const set = (x, y, c) => {
    if (!c) return;
    let sx = x | 0, sy = y | 0;
    if (wx) sx = ((sx % W) + W) % W; else if (sx < 0 || sx >= W) return;
    if (wy) sy = ((sy % H) + H) % H; else if (sy < 0 || sy >= H) return;
    p.set(sx, sy, c);
  };
  const v = {
    w: W, h: H, set,
    get(x, y) {
      let sx = ((x % W) + W) % W, sy = ((y % H) + H) % H;
      if (!wy && (y < 0 || y >= H)) return null;
      return p.get(sx, sy);
    },
    rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c); return v; },
    hline(x, y, len, c) { for (let i = 0; i < len; i++) set(x + i, y, c); return v; },
    vline(x, y, len, c) { for (let j = 0; j < len; j++) set(x, y + j, c); return v; },
    frame(x, y, w, h, c) {
      v.hline(x, y, w, c); v.hline(x, y + h - 1, w, c);
      v.vline(x, y, h, c); v.vline(x + w - 1, y, h, c);
      return v;
    },
  };
  return v;
}

/** Ordered dither driven by ABSOLUTE coordinates, so it tiles and ramps. */
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const dpick = (x, y, a, b, t) =>
  (t > (BAYER[((y % 4) + 4) % 4][((x % 4) + 4) % 4] + 0.5) / 16 ? b : a);

/** Position u in [0,1] along a list of stops -> [from, to, blend]. */
function rampAt(stops, u) {
  const n = stops.length - 1;
  const s = clamp(u * n, 0, n - 1e-6);
  const i = Math.floor(s);
  return [stops[i], stops[i + 1], s - i];
}

/**
 * A 1-bit occupancy grid with wrapping columns, used to accumulate a whole
 * skyline layer before any colour is chosen. Building the silhouette first is
 * what lets the layer be given one flat fill and one derived edge — which is
 * exactly how the reference art reads.
 */
function maskLayer(W, H) {
  const m = new Uint8Array(W * H);
  const wrap = (x) => ((x % W) + W) % W;
  const g = {
    W, H, m,
    put(x, y) { if (y >= 0 && y < H) m[y * W + wrap(x)] = 1; },
    clr(x, y) { if (y >= 0 && y < H) m[y * W + wrap(x)] = 0; },
    get(x, y) { return y >= 0 && y < H ? m[y * W + wrap(x)] : 0; },
    box(x, y, w, h) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) g.put(x + i, y + j); return g; },
    hole(x, y, w, h) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) g.clr(x + i, y + j); return g; },
  };
  return g;
}

/**
 * Paint a finished mask. Two modes:
 *
 *   { outline }    a single edge colour all the way round. Used on the mid
 *                  band with PAL.ink, and on the FAR band with a dark concrete
 *                  tone — the one documented exception to the keyline rule,
 *                  argued in the module header under aerial perspective.
 *
 *   { lit, ink }   the near band, which is nearly ink already and would read
 *                  as a hole if it were outlined in ink all round. Upper and
 *                  left faces catch the last of the daylight; lower and right
 *                  faces take the keyline. Both halves are required: `lit`
 *                  alone left every bottom and right edge untreated, so the
 *                  largest solid forms in the largest image in the game had no
 *                  keyline on the side the eye reads a silhouette from.
 *
 * THIN RUNS take the fill, not an edge colour. A one-pixel-wide column is its
 * own left AND right edge and has no interior at all, so edge-colouring paints
 * the entire feature in edge colour: masts and hook lines came out darker than
 * the buildings they belong to, and in the near band — where any 1px column
 * satisfies !lf — a whole pylon came out as 100% highlight, an object made
 * only of its own lit edge. Anything that wants modelling has to be 2px; see
 * sPylon, which is built as a filled taper for exactly this reason.
 */
function paintMask(v, g, fill, { outline = null, lit = null, ink = null } = {}) {
  for (let y = 0; y < g.H; y++) {
    for (let x = 0; x < g.W; x++) {
      if (!g.get(x, y)) continue;
      const up = g.get(x, y - 1), dn = g.get(x, y + 1);
      const lf = g.get(x - 1, y), rt = g.get(x + 1, y);
      const thin = (!lf && !rt) || (!up && !dn);
      let c = fill;
      if (!thin && (!up || !dn || !lf || !rt)) {
        if (outline) c = outline;
        else if (!up || !lf) c = lit || fill;
        else c = ink || fill;
      }
      v.set(x, y, c);
    }
  }
}

/**
 * Render a lib.mjs primitive into a form() buffer.
 *
 * The props have to speak the same material language as the room interiors
 * another module is drawing straight out of lib — a hand-rolled barrel with
 * square corners next to a p.cylinder tank visibly does not belong to the same
 * set. lib's painter writes RGBA through to an atlas immediately, and form()
 * needs a deferred colour buffer so keyline() can grow ink into it afterwards,
 * so the two cannot share a surface. They can share a renderer: run the lib
 * primitive onto a scratch buffer, then lift the opaque pixels into the form.
 * The result is pixel-for-pixel lib's cylinder, screen and box.
 */
export function libDraw(f, ox, oy, w, h, fn) {
  const px = new Uint8Array(w * h * 4);
  fn(painter(px, w, { x: 0, y: 0, w, h }));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] === 255) f.px(ox + x, oy + y, reg([px[i], px[i + 1], px[i + 2]], 'lib.mjs primitive'));
    }
  }
  return f;
}

/**
 * A small offscreen figure. Everything with a keyline is built in one of
 * these: draw the parts in any order, call keyline() once to grow ink into
 * every empty pixel touching the figure, add the interior details that must
 * NOT be outlined (eyes, straps, screens), then blit.
 *
 * Content must stay inside a 1px margin or the keyline has nowhere to go.
 */
export function form(w, h) {
  const buf = new Array(w * h).fill(null);
  const inb = (x, y) => x >= 0 && y >= 0 && x < w && y < h;
  const f = {
    w, h,
    px(x, y, c) { if (c && inb(x, y)) buf[y * w + x] = c; return f; },
    clr(x, y) { if (inb(x, y)) buf[y * w + x] = null; return f; },
    at(x, y) { return inb(x, y) ? buf[y * w + x] : null; },
    rect(x, y, rw, rh, c) { for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) f.px(x + i, y + j, c); return f; },
    hole(x, y, rw, rh) { for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) f.clr(x + i, y + j); return f; },
    hline(x, y, len, c) { for (let i = 0; i < len; i++) f.px(x + i, y, c); return f; },
    vline(x, y, len, c) { for (let j = 0; j < len; j++) f.px(x, y + j, c); return f; },
    frame(x, y, rw, rh, c) {
      f.hline(x, y, rw, c); f.hline(x, y + rh - 1, rw, c);
      f.vline(x, y, rh, c); f.vline(x + rw - 1, y, rh, c);
      return f;
    },
    /** Lit top/left, shaded bottom/right. The workhorse. */
    slab(x, y, rw, rh, c, lit = 0.22, dk = -0.22) {
      f.rect(x, y, rw, rh, c);
      if (rh > 1) f.hline(x, y, rw, shade(c, lit));
      if (rw > 1) f.vline(x, y, rh, shade(c, lit));
      if (rh > 1) f.hline(x, y + rh - 1, rw, shade(c, dk));
      if (rw > 1) f.vline(x + rw - 1, y, rh, shade(c, dk));
      return f;
    },
    /** Filled disc, flat. Lighting is applied by the caller. */
    disc(cx, cy, rx, ry, c) {
      for (let j = -ry; j <= ry; j++) {
        for (let i = -rx; i <= rx; i++) {
          if ((i * i) / (rx * rx + 0.001) + (j * j) / (ry * ry + 0.001) <= 1.02) f.px(cx + i, cy + j, c);
        }
      }
      return f;
    },
    /** Grow a 1px ink border into every empty pixel touching the figure. */
    keyline(c = INK) {
      const add = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (buf[y * w + x]) continue;
          let touch = false;
          for (let j = -1; j <= 1 && !touch; j++) {
            for (let i = -1; i <= 1 && !touch; i++) {
              if (!i && !j) continue;
              if (inb(x + i, y + j) && buf[(y + j) * w + (x + i)]) touch = true;
            }
          }
          if (touch) add.push(y * w + x);
        }
      }
      for (const i of add) buf[i] = c;
      return f;
    },
    blit(p, ox = 0, oy = 0) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const c = buf[y * w + x];
        if (c) p.set(ox + x, oy + y, c);
      }
      return f;
    },
  };
  return f;
}

/* =========================================================== the skyline == */
/*
 * Silhouette vocabulary. Every one of these writes into a maskLayer, never
 * into pixels, and every one wraps in x, so a tower placed at x = -6 finishes
 * itself on the right edge of the image and the backdrop can repeat forever.
 *
 * Ruins, not buildings: everything is broken somewhere. The tells are a
 * stepped-away top corner, a punched-out window grid, a missing floor, and a
 * mast snapped off short.
 */

/** Slab block: parapet lip, a bitten corner, and blown-out windows. */
function sTower(g, r, x, w, top, base, { windows = true } = {}) {
  g.box(x, top, w, base - top);
  g.box(x - 1, top, w + 2, 2);                       // parapet lip
  if (r() < 0.6) {                                   // a corner has come away
    const bw = irnd(r, 1, Math.max(1, w - 2));
    const bh = irnd(r, 1, 5);
    g.hole(r() < 0.5 ? x - 1 : x + w + 1 - bw, top, bw, bh);
  }
  if (windows && w >= 7) {
    for (let yy = top + 4; yy < base - 3; yy += 4) {
      if (r() < 0.45) continue;                        // most floors are intact
      const run = r() < 0.4;                           // a whole gutted floor
      for (let xx = x + 2; xx < x + w - 2; xx += 3) {
        if (run || r() < 0.5) g.hole(xx, yy, run ? 2 : 1, 1);
      }
    }
  }
  // Two pixels wide, not one: paintMask cannot model a 1px run, so a 1px mast
  // came out as flat edge colour and read as a scratch rather than a mast.
  if (r() < 0.3) g.box(x + Math.floor(w / 2) - 1, top - irnd(r, 2, 6), 2, 7);
}

/** Chimney: narrow, capped, flaring at the foot. */
function sChimney(g, r, x, w, top, base) {
  g.box(x, top + 2, w, base - top - 2);
  g.box(x - 1, top, w + 2, 3);                       // cap band
  const fl = Math.min(8, Math.max(3, Math.floor((base - top) * 0.22)));
  g.box(x - 1, base - fl, w + 2, fl);                // flared foot
  if (r() < 0.45) g.hole(x - 1, top, irnd(r, 1, w), irnd(r, 2, 4)); // broken lip
}

/** Cooling tower: waisted, wide at the foot, a rim at the top. */
function sCool(g, r, x, w, top, base) {
  const h = base - top;
  for (let j = 0; j < h; j++) {
    const u = j / (h - 1);
    // Waist at 55% of the height: narrow there, flaring hard to the foot and
    // gently to the lip. That double curve is the whole silhouette.
    const d = u - 0.55;
    const k = 0.55 + (d < 0 ? 0.30 * (d / 0.55) * (d / 0.55) : 0.45 * (d / 0.45) * (d / 0.45));
    const ww = Math.max(3, Math.round(w * k));
    g.box(x + Math.round((w - ww) / 2), top + j, ww, 1);
  }
  const rimW = Math.max(5, Math.round(w * 0.90));
  g.box(x + Math.round((w - rimW) / 2) - 1, top, rimW + 2, 2);
  if (r() < 0.5) g.hole(x - 1, top, irnd(r, 2, Math.max(2, w - 3)), irnd(r, 2, 6));
}

/** Broken slab: an eroded top edge and, sometimes, a collapsed floor. */
function sSlab(g, r, x, w, top, base) {
  let d = irnd(r, 0, 3);
  for (let i = 0; i < w; i += 2) {
    d = clamp(d + irnd(r, -1, 1), 0, 6);
    g.box(x + i, top + d, 2, base - top - d);
  }
  if (r() < 0.4 && w >= 7) {
    g.hole(x + irnd(r, 1, w - 5), top + irnd(r, 4, Math.max(5, base - top - 4)), irnd(r, 3, 4), irnd(r, 2, 3));
  }
}

/** Gantry crane: mast, jib, counter-jib, hook line, A-frame foot. */
function sCrane(g, r, x, dir, top, base) {
  g.box(x, top, 2, base - top);
  const jib = irnd(r, 8, 17);
  const cj = irnd(r, 3, 6);
  if (dir > 0) { g.box(x, top + 1, jib, 2); g.box(x - cj, top + 1, cj, 2); }
  else { g.box(x + 2 - jib, top + 1, jib, 2); g.box(x + 2, top + 1, cj, 2); }
  g.box(x - 2, top + 4, 6, 3);                                   // cab
  const hx = dir > 0 ? x + jib - 4 : x + 4 - jib;
  g.box(hx, top + 3, 2, irnd(r, 3, 10));                         // hook line, 2px
  g.box(x - 2, base - 4, 6, 4);                                  // foot
}

/**
 * Lattice pylon: a filled taper with the middle punched out.
 *
 * Built solid first and holed second, never as an outline. An outline is
 * nothing but 1px runs, and a 1px run has no interior for paintMask to fill,
 * so an outlined pylon is painted entirely in edge colour — pixel noise in the
 * far band and a pylon-shaped highlight in the near one. Legs are two pixels
 * so each has a lit face and a body, and the rungs are left solid.
 */
function sPylon(g, r, x, top, base) {
  const h = base - top;
  for (let j = 0; j < h; j++) {
    const u = j / (h - 1);
    const ww = Math.round(4 + u * 7);                            // 4 at the top
    const x0 = x + Math.round((11 - ww) / 2);
    g.box(x0, top + j, ww, 1);
    if (ww >= 8 && j > 2 && j < h - 3 && j % 5 !== 3) g.hole(x0 + 2, top + j, ww - 4, 1);
  }
  g.box(x - 2, top + irnd(r, 2, 4), 15, 2);                      // cross-arm
  if (r() < 0.6) g.box(x - 1, top + irnd(r, 6, 10), 13, 2);
}

/** Spherical storage tank on legs. */
function sTank(g, r, x, w, top, base) {
  const rr = Math.floor(w / 2);
  const cy = top + rr;
  for (let j = -rr; j <= rr; j++) {
    const hw = Math.round(Math.sqrt(Math.max(0, rr * rr - j * j)));
    g.box(x + rr - hw, cy + j, hw * 2 + 1, 1);
  }
  g.box(x + 1, cy, 2, base - cy);
  g.box(x + w - 3, cy, 2, base - cy);
  g.box(x, base - 2, w, 2);
  if (r() < 0.45) g.hole(x + irnd(r, 0, rr), top, irnd(r, 2, 4), irnd(r, 2, 4));
}

/** Half-dome, usually collapsed on one side. */
function sDome(g, r, x, w, base) {
  const rr = Math.floor(w / 2);
  for (let j = 0; j <= rr; j++) {
    const hw = Math.round(Math.sqrt(Math.max(0, rr * rr - j * j)));
    g.box(x + rr - hw, base - j, hw * 2 + 1, 1);
  }
  g.box(x, base - 2, w, 2);
  g.hole(x + (r() < 0.5 ? 0 : rr), base - rr, irnd(r, 3, rr + 1), irnd(r, 3, rr));
  return g;
}

/**
 * Walk a layer across the width, wrapping deliberately at both ends.
 *
 * `o.kinds` is a bag drawn from with replacement, so repeating a name in it
 * weights that shape — which is how each distance gets its own character: the
 * far band is mostly towers and chimneys, the near band mostly heavy masses.
 * The walk starts at a negative x on purpose, so one structure always straddles
 * the wrap and the backdrop can repeat without a bald patch at the join.
 */
function buildLayer(W, H, r, o) {
  const g = maskLayer(W, H);
  let x = -irnd(r, 4, 10);
  let guard = 0;
  while (x < W - 2 && guard++ < 200) {
    const kind = pick(r, o.kinds);
    const w = irnd(r, o.wMin, o.wMax);
    const hgt = irnd(r, o.hMin, o.hMax);
    const base = o.base + irnd(r, 0, o.baseJit);
    const top = base - hgt;
    switch (kind) {
      case 'chimney': sChimney(g, r, x, Math.max(2, Math.round(w * 0.45)), top - o.hMax * 0.15 | 0, base); break;
      case 'cool': sCool(g, r, x, Math.max(5, w), top + (hgt * 0.25 | 0), base); break;
      case 'slab': sSlab(g, r, x, w, top + (hgt * 0.3 | 0), base); break;
      case 'crane': sCrane(g, r, x + 2, r() < 0.5 ? 1 : -1, top, base); break;
      case 'pylon': sPylon(g, r, x, top, base); break;
      case 'tank': sTank(g, r, x, Math.max(6, Math.round(w * 0.8)), base - Math.max(7, w), base); break;
      case 'dome': sDome(g, r, x, Math.max(7, w), base); break;
      default: sTower(g, r, x, w, top, base, { windows: o.windows }); break;
    }
    x += w + irnd(r, o.gapMin, o.gapMax);
  }
  return g;
}

/**
 * The surface. 256x96, fully opaque.
 *
 * Horizontally seamless as well — the sky dither, the ground ramp and all
 * three ruin layers are drawn through an x-wrapping view, so the backdrop can
 * be repeated or scrolled without a join.
 */
export function drawSkyline(p, seed = 'env_skyline') {
  const W = p.w, H = p.h;
  const v = torus(p, { x: true, y: false });
  const r = rng(seed);
  const HZ = Math.round(H * 0.74);            // the horizon row

  // -- sky ------------------------------------------------------------------
  // The brief is specific about this one: "bleached near-white sky at the top,
  // fading down through pale yellow-green to a saturated toxic yellow-green at
  // the horizon". So the pale stops have to own most of the picture. Two bone
  // stops weight the top of the ramp, and the exponent then holds the pale
  // range open across the upper two thirds and crushes the saturation into the
  // last quarter — at half height the sky is still bone-into-palest-toxin, and
  // it does not reach full toxin until the last few rows. (It used to run at
  // an exponent of 1.05, which is a straight line: bone for twelve rows and
  // then toxin all the way down, which is not what was asked for.)
  const SKY = [
    tone('bone'), tone('bone', -0.07),
    toxic(0.86), toxic(0.71), toxic(0.54), toxic(0.34), toxic(0.15), toxic(0),
  ];
  const sunX = Math.round(W * 0.31);
  const sunY = HZ - 6;
  const sunR = Math.round(W * 0.34);
  const rowC = new Array(H);

  for (let y = 0; y < HZ; y++) {
    const u = Math.pow(y / (HZ - 1), 2.15);
    for (let x = 0; x < W; x++) {
      let dx = Math.abs(x - sunX); dx = Math.min(dx, W - dx);
      const dy = (y - sunY) * 1.35;
      const d = Math.sqrt(dx * dx + dy * dy) / sunR;
      // A hazy sun, never a disc. Worth two full stops of lift or it is not
      // worth the per-pixel sqrt: at the old 0.46 it moved the ramp by less
      // than half a stop and nobody could see it. At 1.05 it opens a pale
      // well in the toxin band and the ruins in front of it read as backlit.
      const bloom = d < 1 ? Math.pow(1 - d, 1.9) : 0;
      const [a, b, t] = rampAt(SKY, Math.max(0, u - bloom * 1.05));
      v.set(x, y, dpick(x, y, a, b, t));
    }
    const [a, b, t] = rampAt(SKY, u);
    rowC[y] = t > 0.5 ? b : a;
  }

  // -- ground ---------------------------------------------------------------
  // The plain catches the sky at the horizon (contamination haze, which is the
  // one place toxin is allowed to touch the dirt) and goes to cold ash fast.
  // The plain has to stay a MID tone: the near ruins are nearly ink, and if
  // the ground falls to ink as well the bottom third of the picture is one
  // undifferentiated dark band and the ruins have nothing to silhouette
  // against. Bright sky, mid plain, dark ruins — in that order.
  const GND = [toxic(0.40), toxic(0.16), tone('concrete', 0.26), tone('concrete', 0.04), tone('concrete', -0.18), tone('deep', 0.02)];
  for (let y = HZ; y < H; y++) {
    const u = Math.pow((y - HZ) / (H - 1 - HZ), 0.95);
    const [a, b, t] = rampAt(GND, u);
    for (let x = 0; x < W; x++) v.set(x, y, dpick(x, y, a, b, t));
    rowC[y] = t > 0.5 ? b : a;
  }

  /**
   * The colour source for SOLID THINGS lying on the plain, as opposed to the
   * plain itself.
   *
   * The top seven rows of the ground ramp resolve to toxin, because that is
   * where you are looking at the dirt through the haze — haze is contamination
   * and toxin is legal there. A block of rubble and a snapped pole are not
   * haze. They were sampling rowC at their own row, which put dark yellow-green
   * rocks in the dirt and quietly turned the reserved colour into a material.
   * Clamping the sample below the haze band gives them concrete and ash, which
   * is what they are made of. The drifts and the surface streaks deliberately
   * do NOT use this: they are the plain's own surface, seen through the same
   * haze as the rows they lie on, and they should match it.
   */
  const gndC = (y) => rowC[Math.max(y, HZ + 8)];

  // -- high cloud -----------------------------------------------------------
  // Long, tapered, barely-there streaks. Anything stronger fights the ruins.
  for (let k = 0; k < 16; k++) {
    const y = irnd(r, 2, Math.max(3, HZ - 24));
    const len = irnd(r, 20, 80);
    const x0 = irnd(r, 0, W - 1);
    const c = shade(rowC[y], r() < 0.55 ? 0.15 : -0.09);
    for (let i = 0; i < len; i++) {
      const u = i / (len - 1);
      const edge = Math.min(1, Math.min(u, 1 - u) * 2.4);
      if (r() < 0.22 + 0.6 * edge) v.set(x0 + i, y, c);
    }
  }

  // -- ruins, three layers --------------------------------------------------
  // Bases step DOWN as the layers come forward, because on a flat plain the
  // horizon is the furthest thing there is and nothing stands above it.
  const far = buildLayer(W, HZ + 2, r, {
    kinds: ['tower', 'tower', 'chimney', 'cool', 'slab', 'tank', 'dome', 'pylon'],
    wMin: 5, wMax: 14, hMin: 16, hMax: 46,
    base: HZ - 1, baseJit: 1, gapMin: 1, gapMax: 7, windows: false,
  });
  // The documented exception. See the module header: ink here is a hard black
  // line on a bleached sky at the furthest distance in the picture, and it
  // drags the far band forward over the hero. The edge is still a real edge,
  // just held down to the contrast the distance can carry.
  paintMask(v, far, tone('concrete', 0.34), { outline: tone('concrete', 0.14) });

  // Distance haze: dithered sky over the far layer, thickening toward the
  // horizon. Dithered rather than alpha-blended so the result stays on palette
  // and stays crisp at 1:1.
  for (let y = HZ - 13; y <= HZ + 2; y++) {
    if (y < 0 || y >= H) continue;
    const t = clamp((y - (HZ - 13)) / 15, 0, 1) * 0.36;
    for (let x = 0; x < W; x++) if (dpick(x + 2, y + 1, 0, 1, t)) v.set(x, y, rowC[y]);
  }

  const mid = buildLayer(W, HZ + 8, r, {
    kinds: ['tower', 'slab', 'cool', 'tower', 'chimney', 'crane', 'tank', 'slab'],
    wMin: 8, wMax: 20, hMin: 14, hMax: 42,
    base: HZ + 2, baseJit: 2, gapMin: 3, gapMax: 11, windows: true,
  });
  paintMask(v, mid, tone('concrete', 0.10), { outline: INK });

  // -- ground texture -------------------------------------------------------
  // Drifts first (broad, soft), then streaks, then rubble, then dust. Ordered
  // coarse to fine so the fine work lands on top and survives.
  for (let k = 0; k < 5; k++) {
    const y = irnd(r, HZ + 3, H - 3);
    const len = irnd(r, 40, 130);
    const x0 = irnd(r, 0, W - 1);
    const c = shade(rowC[y], 0.11);
    for (let j = 0; j < irnd(r, 1, 3); j++) {
      for (let i = 0; i < len; i++) {
        const u = i / (len - 1);
        const edge = Math.min(1, Math.min(u, 1 - u) * 3);
        if (r() < 0.35 + 0.5 * edge) v.set(x0 + i, y + j, c);
      }
    }
  }
  for (let k = 0; k < 58; k++) {
    const y = irnd(r, HZ + 1, H - 1);
    const depth = (y - HZ) / (H - HZ);
    const len = 2 + Math.floor(depth * irnd(r, 3, 13));
    const c = shade(rowC[y], r() < 0.5 ? -0.16 : 0.10);
    v.hline(irnd(r, 0, W - 1), y, len, c);
  }
  for (let k = 0; k < 26; k++) {                       // rubble, made of rock
    const y = irnd(r, HZ + 5, H - 2);
    const depth = (y - HZ) / (H - HZ);
    const w = 1 + Math.floor(depth * irnd(r, 1, 6));
    const h = 1 + Math.floor(depth * irnd(r, 1, 3));
    const x = irnd(r, 0, W - 1);
    v.rect(x, y, w, h, shade(gndC(y), -0.42));
    v.hline(x, y, w, shade(gndC(y), 0.14));           // light on the top face
  }
  for (let k = 0; k < 6; k++) {                        // snapped poles
    const x = irnd(r, 0, W - 1);
    const y = irnd(r, HZ + 6, H - 4);
    const h = irnd(r, 3, 9);
    v.vline(x, y - h, h, shade(gndC(y), 0.16));        // lit face, left
    v.vline(x + 1, y - h, h, shade(gndC(y), -0.44));   // shaded face, right
  }

  // -- near ruins -----------------------------------------------------------
  // Nearly ink, so they take a lit top-and-left edge instead of a keyline —
  // the last of the daylight sitting on the broken concrete.
  const near = buildLayer(W, H, r, {
    kinds: ['tower', 'slab', 'tower', 'crane', 'slab', 'chimney', 'tower', 'pylon'],
    wMin: 12, wMax: 26, hMin: 22, hMax: 46,
    base: HZ + 9, baseJit: 3, gapMin: 24, gapMax: 58, windows: true,
  });
  // The hero. An evenly spaced row of ruins is a picket fence, not a picture —
  // the eye needs one thing to land on. A cooling tower placed off-centre and
  // taller than anything else gives the image a subject, and the crane leaning
  // against it gives that subject a scale.
  const heroX = Math.round(W * 0.63);
  sCool(near, r, heroX, 30, HZ + 12 - 66, HZ + 12);
  sCrane(near, r, heroX - 12, -1, HZ + 12 - 40, HZ + 10);
  sSlab(near, r, heroX + 30, 14, HZ + 10 - 26, HZ + 10);
  paintMask(v, near, tone('deeper', 0.03), { lit: tone('deeper', 0.26), ink: INK });

  // Foreground spoil heaps, right on the bottom edge, to close the composition
  // off and stop the plain running out of the frame.
  for (let k = 0; k < 4; k++) {
    const cx = irnd(r, 0, W - 1);
    const rw = irnd(r, 18, 44), rh = irnd(r, 4, 8);
    const halfAt = (j) => Math.round(rw / 2 * Math.sqrt(Math.max(0, 1 - (j / rh) * (j / rh))));
    for (let j = 0; j < rh; j++) {
      const half = halfAt(j);
      for (let i = -half; i <= half; i++) v.set(cx + i, H - 1 - j, tone('deeper', -0.16));
    }
    // A keyline over the crest, and the last of the light on the crest itself.
    // Without the ink the heap's body is within a level per channel of the ash
    // behind it, so the element that is supposed to close the composition is
    // simply not visible. This is the only solid in the picture whose outline
    // has to be found column by column, because it is the only one built as a
    // stack of spans rather than through a mask.
    for (let i = -rw; i <= rw; i++) {
      let top = -1;
      for (let j = 0; j < rh; j++) if (Math.abs(i) <= halfAt(j)) top = j;
      if (top < 0) continue;
      v.set(cx + i, H - 1 - top, tone('deep', 0.06));
      v.set(cx + i, H - 2 - top, INK);
    }
  }

  // -- ash ------------------------------------------------------------------
  // Single pale motes, denser low, where the light is coming through the dust.
  // Motes in the air catch the sky and go toward bone; motes lying on the
  // plain are dust on dirt and go toward the ash the dirt is made of, which
  // also keeps them off the toxin part of the ramp. (The two branches used to
  // be the same expression, so somebody had meant this and never finished it.)
  for (let k = 0; k < 130; k++) {
    const y = irnd(r, 1, H - 2);
    const x = irnd(r, 0, W - 1);
    if (r() > 0.25 + 0.75 * (y / H)) continue;
    v.set(x, y, y < HZ ? shade(rowC[y], 0.34) : shade(gndC(y), 0.22));
  }
  return p;
}

/* ============================================================== the tiles == */
/*
 * All three are painted through torus(p), so every write wraps in both axes.
 * A crack that leaves the right edge is the same write that arrives on the
 * left; a rust streak that runs off the bottom arrives at the top. The right
 * column therefore continues into the left column and the bottom row into the
 * top row — verified numerically in the self-test, which compares the wrap
 * transition against the worst transition inside the tile and fails if the
 * join is the bigger jump.
 */

/** A wrapped random walk, the honest way to draw a crack. */
function crack(v, r, x, y, len, c, bias = 0.72) {
  for (let i = 0; i < len; i++) {
    v.set(x, y, c);
    const px = x, py = y;
    let left = false;
    if (r() < bias) y += 1;
    else { left = r() < 0.5; x += left ? -1 : 1; }
    // The lit lip belongs to the pixel just drawn, not to wherever the walk
    // went next — and only when the walk did not step left, because after a
    // left step the pixel to the right of the new position IS the groove, and
    // the "lip" punched a highlight straight through the middle of it.
    if (!left && r() < 0.12) v.set(px + 1, py, shade(c, 0.16));
  }
}

/**
 * Poured concrete, 32x32, seamless.
 *
 * ONE pour joint and ONE form joint, both placed from the seed, each a dark
 * groove with a lit lower/right lip — a recess lit from the upper left has its
 * top and left walls in shadow and its bottom and right walls in light, and
 * getting that the wrong way round is the difference between a groove and a
 * ridge.
 *
 * One of each, not two, and seeded rather than fixed. Two horizontal grooves
 * at y=11,26 plus two vertical ones at x=5,21 is a four-cell grid repeating
 * identically every 32px — which is the checkerboard this tile's own comment
 * claimed to be avoiding while the code drew it. A single asymmetric cross,
 * placed by the seed, gives the surface a pour line without giving the eye a
 * lattice to lock onto.
 *
 * Form-tie recesses sit on the joints where the real ones would, and weep a
 * little rust. The rust is deliberately weak: it is the only warm thing in the
 * tile and therefore the only thing that survives downsampling, so at the old
 * strength six fixed streaks were the eye's anchor and the anchor repeated
 * every 32 pixels. Now there are at most four, in seeded positions, at about
 * half the chroma.
 */
export function drawWallTile(p, seed = 'env_wall') {
  const v = torus(p);
  const r = rng(seed);
  const W = p.w, H = p.h;

  v.rect(0, 0, W, H, CONC);

  // Blotchy aggregate: a few soft patches, then per-pixel grit. This is what
  // carries the surface — the joints below are one line each precisely so that
  // this, which is different in every pixel, is what the eye lands on.
  for (let k = 0; k < 26; k++) {
    const x = irnd(r, 0, W - 1), y = irnd(r, 0, H - 1);
    const w = irnd(r, 3, 8), h = irnd(r, 2, 6);
    const c = shade(CONC, r() < 0.5 ? 0.07 : -0.08);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (r() < 0.72) v.set(x + i, y + j, c);
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const q = r();
    if (q < 0.11) v.set(x, y, shade(CONC, 0.06));
    else if (q < 0.22) v.set(x, y, shade(CONC, -0.07));
  }

  // One pour joint, one form joint, both seeded.
  const pourY = irnd(r, 7, 25);
  const formX = irnd(r, 4, 26);
  v.hline(0, pourY, W, shade(CONC, -0.34));
  v.hline(0, pourY + 1, W, shade(CONC, 0.16));
  v.vline(formX, 0, H, shade(CONC, -0.30));
  v.vline(formX + 1, 0, H, shade(CONC, 0.13));

  // Form ties: a 2x2 recess with a lit rim along the two walls it actually
  // has, and the rust that has been running out of it since the pour. The rim
  // is the row under the recess and the column beside it — a single highlight
  // set diagonally off the corner, as this used to do, touches no wall of the
  // recess at all and reads as a stray dot.
  const ties = [
    [irnd(r, 1, W - 4), pourY + irnd(r, 3, 8)],
    [irnd(r, 1, W - 4), pourY - irnd(r, 4, 9)],
    [formX + irnd(r, 3, 8), irnd(r, 1, H - 4)],
    [formX - irnd(r, 4, 9), irnd(r, 1, H - 4)],
  ];
  for (const [tx, ty] of ties) {
    v.rect(tx, ty, 2, 2, shade(CONC, -0.55));
    v.hline(tx, ty, 2, INK);                              // shadowed top wall
    v.set(tx, ty + 1, INK);                               // shadowed left wall
    v.hline(tx, ty + 2, 3, shade(CONC, 0.12));            // lit bottom rim
    v.vline(tx + 2, ty, 2, shade(CONC, 0.12));            // lit right rim
    if (r() < 0.55) continue;                             // most ties are dry
    const len = irnd(r, 3, 9);
    for (let j = 0; j < len; j++) {
      const t = 1 - j / len;
      if (r() < 0.22 + 0.35 * t) v.set(tx + irnd(r, 0, 1), ty + 3 + j, tone('rust', -0.66 - 0.12 * (1 - t)));
    }
  }

  // Two hairline cracks and settled dust in the joint shadows.
  crack(v, r, irnd(r, 0, W - 1), irnd(r, 0, H - 1), irnd(r, 9, 20), shade(CONC, -0.44));
  crack(v, r, irnd(r, 0, W - 1), irnd(r, 0, H - 1), irnd(r, 6, 14), shade(CONC, -0.38));
  for (let k = 0; k < 70; k++) {
    const x = irnd(r, 0, W - 1), y = irnd(r, 0, H - 1);
    v.set(x, y, shade(CONC, -0.20));
  }
  return p;
}

/**
 * Unexcavated rock, 32x32, seamless.
 *
 * A toroidal Voronoi over sixteen jittered sites — a 4x4 grid, so the facets
 * average eight pixels across. Five across the tile put twenty-five facets in
 * 32 pixels, and a six-pixel facet with a hard edge all the way round is a
 * cobble; the tile is supposed to be a rock face, and a rock face is made of a
 * few large planes.
 *
 * The metric is pure Manhattan, which gives straight-edged angular cells. It
 * used to say Manhattan and compute a half-and-half blend with Euclidean,
 * which rounds every cell off — the comment described the intent and the code
 * described a cobbled street.
 *
 * Edges are conditional, which is the other half of the cobble problem. An ink
 * line on every facet boundary separates the surface into pebbles; ink only
 * where the two facets differ in value groups the shallow neighbours into
 * planes and reserves the black line for a real step in the stone.
 */
export function drawRockTile(p, seed = 'env_rock') {
  const v = torus(p);
  const r = rng(seed);
  const W = p.w, H = p.h;
  const GRID = 4, CELL = W / GRID;

  const sx = [], sy = [], sc = [], sw = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      sx.push(gx * CELL + r() * CELL);
      sy.push(gy * CELL + r() * CELL);
      // Per-site weight, so facets come out in a range of sizes. An even
      // Voronoi reads as cobbles; a weighted one reads as broken stone.
      // ADDITIVE, not multiplicative: scaling the distance bends every cell
      // boundary into an arc (that is an Apollonius diagram, and it is the
      // real reason this tile came out as a cobbled street no matter what the
      // metric said). Subtracting a constant keeps every boundary straight.
      sw.push(r() * 5);
      // About a sixth of the facets carry iron, which is why anyone digs here.
      const warm = r() < 0.16;
      sc.push(shade(warm ? tone('rust', -0.62) : tone('concrete', -0.42), -0.14 + r() * 0.26));
    }
  }
  const ownerAt = (x, y, ox, oy) => {
    let best = 1e9, bi = 0;
    for (let i = 0; i < sx.length; i++) {
      let dx = Math.abs(((x - sx[i] - ox) % W + W) % W); dx = Math.min(dx, W - dx);
      let dy = Math.abs(((y - sy[i] - oy) % H + H) % H); dy = Math.min(dy, H - dy);
      const d = (dx + dy) - sw[i];                    // Manhattan, as advertised
      if (d < best) { best = d; bi = i; }
    }
    return bi;
  };

  // Slide the whole site field so the tile's own edges do not land along a
  // facet boundary.
  //
  // This is a crop, not a fudge. The diagram is toroidal whichever offset is
  // used, so the tile is seamless either way — the offset only decides which
  // row and column of an endless stone face this particular 32x32 window is
  // cut on. But a hard ink line lying exactly on the join is the one thing
  // that makes a genuinely seamless tile MEASURE as though it had a seam, and
  // the seam test is only worth having if it can be run strictly. The score is
  // the number of facet changes across the two joins; the offset is chosen
  // deterministically, so the tile still regenerates byte-identical.
  let ox = 0, oy = 0, bestScore = Infinity;
  for (let cy = 0; cy < CELL; cy++) {
    for (let cx = 0; cx < CELL; cx++) {
      let s = 0;
      for (let x = 0; x < W; x++) if (ownerAt(x, H - 1, cx, cy) !== ownerAt(x, 0, cx, cy)) s++;
      for (let y = 0; y < H; y++) if (ownerAt(W - 1, y, cx, cy) !== ownerAt(0, y, cx, cy)) s++;
      if (s < bestScore) { bestScore = s; ox = cx; oy = cy; }
    }
  }
  for (let i = 0; i < sx.length; i++) { sx[i] = (sx[i] + ox) % W; sy[i] = (sy[i] + oy) % H; }

  const own = new Int16Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) own[y * W + x] = ownerAt(x, y, 0, 0);
  const at = (x, y) => own[(((y % H) + H) % H) * W + (((x % W) + W) % W)];
  const lum = (c) => (c[0] * 2 + c[1] * 5 + c[2]) / 8;
  const STEP = 16;                                    // levels that earn an edge

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = at(x, y);
      // Shade within the facet so each one has a top-left face and a
      // bottom-right one, instead of reading as sixteen flat stickers.
      let dx = x - sx[i]; if (dx > W / 2) dx -= W; if (dx < -W / 2) dx += W;
      let dy = y - sy[i]; if (dy > H / 2) dy -= H; if (dy < -H / 2) dy += H;
      const g = clamp(-(dx + dy) / 9, -0.26, 0.26);
      let c = shade(sc[i], g);
      const nR = at(x + 1, y), nD = at(x, y + 1), nL = at(x - 1, y), nU = at(x, y - 1);
      const drop = Math.max(
        nR !== i ? Math.abs(lum(sc[i]) - lum(sc[nR])) : 0,
        nD !== i ? Math.abs(lum(sc[i]) - lum(sc[nD])) : 0,
      );
      const rise = Math.max(
        nL !== i ? Math.abs(lum(sc[nL]) - lum(sc[i])) : 0,
        nU !== i ? Math.abs(lum(sc[nU]) - lum(sc[i])) : 0,
      );
      if (drop > STEP) c = INK;                       // a real step in the rock
      else if (rise > STEP) c = shade(sc[i], 0.24);   // the plane behind stands
      v.set(x, y, c);
    }
  }

  // Grit, then a fissure, then the ore glints last so they survive. Four
  // glints, not nine: they are the highest-chroma thing in the tile and a
  // constellation of nine of them is what the eye locks onto once the tile
  // repeats. (Their positions already come from the seed, and that cannot
  // help — a tile repeats identically by definition, so the only lever on a
  // repeating constellation is how few and how quiet its members are.)
  for (let k = 0; k < 120; k++) {
    const x = irnd(r, 0, W - 1), y = irnd(r, 0, H - 1);
    v.set(x, y, shade(v.get(x, y), r() < 0.5 ? -0.22 : 0.14));
  }
  crack(v, r, irnd(r, 0, W - 1), irnd(r, 0, H - 1), irnd(r, 10, 22), INK, 0.6);
  for (let k = 0; k < 4; k++) {
    const x = irnd(r, 0, W - 1), y = irnd(r, 0, H - 1);
    v.set(x, y, AMBER_LO);
    if (r() < 0.5) v.set(x + 1, y, shade(AMBER_LO, -0.3));
  }
  return p;
}

/**
 * The central lift shaft, 32x32, seamless.
 *
 * Two full-height guide rails, a pair of hoist cables down the middle, and TWO
 * cross-braces sixteen rows apart — plain steel with rivets on one,
 * hazard-striped on the other, so the vertical repeat is a rhythm rather than
 * a stutter. That is what three separate comments here have always claimed and
 * what the code, which iterated a one-element list, never did: one identical
 * amber band every 32 rows, beating against the 40px floor pitch on a
 * five-floor cycle all the way down a 144-floor silo.
 *
 * The stripe period is 8px — four on, four off — and 32 is a multiple of 8, so
 * the band walks across the horizontal join without breaking step. Eight
 * rather than four because the camera clamps down to 0.42 world scale, at
 * which a 2px stripe is under one screen pixel and the whole band greys out.
 * The amber is held well down in chroma for the same reason the wall tile's
 * rust is: it is the only warm thing in a very dark tile.
 */
export function drawShaftTile(p, seed = 'env_shaft') {
  const v = torus(p);
  const r = rng(seed);
  const W = p.w, H = p.h;

  // Dark back wall with a soft column of light down the middle of the shaft.
  // (No base fill: the loop below writes every pixel of the tile, so a fill
  // under it is 1024 writes that nothing ever sees. The two tones are hoisted
  // for the same reason — inside the loop they were 2048 shade() allocations
  // and 2048 Map writes per tile to produce two colours.)
  const backLit = tone('deep', -0.06), backDark = tone('deeper', 0.02);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.abs(x - (W / 2 - 0.5)) / (W / 2);
      v.set(x, y, dpick(x, y, backLit, backDark, clamp(d * 1.25, 0, 1)));
    }
  }
  for (let k = 0; k < 60; k++) v.set(irnd(r, 0, W - 1), irnd(r, 0, H - 1), tone('deeper', -0.1));

  // Hoist cables, two pixels wide with ink either side. A 1px column of
  // steelDark on a back wall of deep/deeper is dark grey on dark grey with no
  // keyline — it does not read as a cable, it reads as dirt, and the docstring
  // sells it as one of the shaft's three defining features. Two pixels give it
  // a lit face and a shaded one; the ink gives it an edge. The lit pixel
  // repeats on an 8 row cycle, which divides 32.
  for (const cx of [13, 18]) {
    v.vline(cx - 1, 0, H, INK);
    v.vline(cx, 0, H, MET);
    v.vline(cx + 1, 0, H, tone('steelDark', -0.24));
    v.vline(cx + 2, 0, H, INK);
    for (let y = 0; y < H; y++) if (y % 8 === 2) { v.set(cx, y, MET_HI); v.set(cx + 1, y, MET); }
  }

  // Guide rails: ink, lit face, body, shaded face, ink.
  for (const rx of [5, 24]) {
    v.vline(rx - 1, 0, H, INK);
    v.vline(rx, 0, H, MET_HI);
    v.vline(rx + 1, 0, H, MET);
    v.vline(rx + 2, 0, H, MET_LO);
    v.vline(rx + 3, 0, H, INK);
    for (let y = 0; y < H; y++) if (y % 4 === 1) v.set(rx + 1, y, shade(MET, -0.22)); // rail joints
  }

  // Cross-braces. y=2 plain with rivets, y=18 hazard-striped.
  for (const [by, hazard] of [[2, false], [18, true]]) {
    v.hline(0, by - 1, W, INK);
    v.rect(0, by, W, 4, MET_LO);
    v.hline(0, by, W, MET);
    v.hline(0, by + 3, W, IRON);
    v.hline(0, by + 4, W, INK);
    if (hazard) {
      for (let x = 0; x < W; x++) {
        const band = ((x >> 2) & 1) === 0;
        v.set(x, by + 1, band ? shade(AMBER, -0.40) : INK);
        v.set(x, by + 2, band ? shade(AMBER, -0.66) : INK);
      }
    } else {
      for (let x = 1; x < W; x += 6) { v.set(x, by + 1, MET_HI); v.set(x + 1, by + 2, MET_LO); }
    }
    // Rust weeping out from under this brace — driven off its own y, so it
    // follows the brace instead of a literal that silently assumed there was
    // only ever one of them and that it sat at y=14.
    for (let k = 0; k < 5; k++) {
      const x = irnd(r, 0, W - 1);
      const len = irnd(r, 2, 6);
      for (let j = 0; j < len; j++) if (r() < 0.65) v.set(x, by + 5 + j, tone('rust', -0.62));
    }
  }

  // Grime in the rail shadows.
  for (const rx of [5, 24]) {
    for (let k = 0; k < 10; k++) v.set(rx + irnd(r, -2, 5), irnd(r, 0, H - 1), tone('deeper', -0.05));
  }
  return p;
}

/** Frame-name suggestion: env_wall, env_rock, env_shaft. */
export const TILES = { wall: drawWallTile, rock: drawRockTile, shaft: drawShaftTile };

/* ============================================================= the threats == */
/*
 * Eleven of them, all facing right, all lit from the upper left, all built in
 * a form() and given their keyline in one pass at the end.
 *
 * The rule that decides every one of these is: name it from the outline. Not
 * from the colour, not from the detail — from the black shape. So each gets
 * exactly one structural idea and the rest of the body stays out of its way:
 *
 *   husk         long arms hanging past the knees on a starved frame
 *   shambler     one arm thrown forward, one leg dragging
 *   bloater      a sphere with a head sunk into it and stubs sticking out
 *   ravager      low and wide, spined back, forelimbs planted ahead
 *   alpha        a wall of shoulders under a crest, arms to the floor
 *   broodmother  rooted: a spread mass, no legs, a small head carried high
 *   raider       hood, and a length of pipe carried upright
 *   ash_company  helmet, and a rifle held level across the body
 *   scrapjaw     a box on three stiff legs with a wedge of open jaw
 *   cultist      pointed hood over a bell of robe, one arm up with a lamp
 *   trader       wide brim, a bedroll above the shoulder, a leaning staff
 *
 * The self-test pads each one onto a common 32px field, hashes the alpha
 * channel into a 24x24 map and compares every pair, so if two of these ever
 * converge the build says which two. Padding is what makes the comparison
 * about the creatures rather than about their bounding boxes: on its own box a
 * 16px husk and a 32px alpha score as near neighbours, which is nonsense.
 */

/** Emaciated, stooped, arms past the knees. The cheapest thing out there. */
function tHusk(p) {
  const f = form(16, 16);
  f.rect(3, 6, 2, 3, FLESH_LO);                                     // far arm, swinging out
  f.rect(2, 9, 2, 3, FLESH_LO); f.rect(1, 12, 2, 2, FLESH_LO);
  f.rect(10, 6, 2, 3, FLESH);                                       // near arm, past the knee
  f.rect(11, 9, 2, 3, FLESH); f.rect(13, 12, 2, 2, FLESH);
  f.rect(5, 6, 5, 6, FLESH);                                        // torso, starved narrow
  f.vline(9, 6, 6, FLESH_LO);
  f.hline(6, 8, 3, FLESH_LO); f.hline(6, 10, 3, FLESH_LO);          // ribs
  f.rect(6, 2, 4, 4, FLESH);                                        // head, lolling forward
  f.hline(6, 2, 4, FLESH_HI);
  f.vline(9, 2, 4, FLESH_LO);
  f.rect(5, 11, 5, 2, RAG_LO);                                      // hip wrap
  f.hline(5, 11, 5, RAG);
  f.rect(6, 13, 2, 2, FLESH_LO); f.rect(8, 13, 2, 2, FLESH);        // legs, together
  f.keyline();
  // The arms hang against the ribs, so nothing separates them from the torso
  // unless it is drawn. Without these two lines the whole figure reads as one
  // hooded lump, which is the failure mode of every 16px humanoid.
  f.vline(4, 6, 3, INK); f.vline(10, 6, 3, INK);                    // arm / torso
  f.hline(7, 3, 2, INK); f.px(7, 4, INK);                           // sunken eye
  f.hline(6, 6, 3, INK);                                            // hollow throat
  f.px(6, 5, INK); f.px(9, 5, INK);                                 // jaw corners
  f.px(7, 13, INK);                                                 // between the legs
  f.blit(p);
  return p;
}

/**
 * Was a dweller. One arm out, one leg gone stiff.
 *
 * The one threat whose whole read is "that used to be one of ours", so it is
 * the one threat wearing the silo jumpsuit — PAL.denim, with the chest pocket
 * and the leg seam the citizens have. It used to be cut from PAL.deep at a
 * tenth, sixteen levels off the keyline, which cost it both its premise and
 * its legibility: nearly half its painted pixels were ink or indistinguishable
 * from ink, so torso, coat hem, hair and both boots collapsed into one mass
 * and the internal separator strokes were ink drawn on ink. Denim sits ninety
 * levels clear of the keyline, so the silhouette survives, the rag tones do
 * the torn hem only, and the separators separate.
 */
function tShambler(p) {
  const f = form(16, 16);
  f.rect(4, 7, 2, 5, SUIT_LO);                                      // trailing arm
  f.rect(4, 12, 2, 1, FLESH_LO);
  f.rect(4, 6, 7, 6, SUIT);                                         // torso, torn suit
  f.hline(4, 6, 7, SUIT_HI);
  f.vline(10, 6, 6, SUIT_LO);
  f.rect(6, 8, 2, 2, SUIT_HI);                                      // chest pocket
  f.px(6, 9, SUIT_LO);
  f.rect(4, 11, 7, 1, SUIT_LO);
  f.px(5, 12, RAG_LO); f.px(8, 12, RAG_LO); f.px(10, 12, RAG_LO);   // torn hem
  f.rect(10, 7, 4, 2, SUIT); f.hline(10, 7, 4, SUIT_HI);            // reaching arm
  f.rect(13, 7, 2, 2, FLESH); f.px(14, 6, FLESH_LO); f.px(14, 9, FLESH_LO);
  f.rect(5, 2, 5, 4, FLESH);                                        // head
  f.hline(5, 2, 5, FLESH_HI); f.vline(9, 2, 4, FLESH_LO);
  // Hair as a shape, not a rectangle: a shaggy fringe over the brow with the
  // reference's cowlick standing off the crown. A flat near-ink slab on top of
  // a head is a hat.
  f.rect(5, 1, 5, 1, tone('hair', 0.20));
  f.px(4, 2, tone('hair', 0.12)); f.px(5, 2, tone('hair', 0.12));
  f.px(9, 1, tone('hair', 0.12));
  f.px(10, 2, tone('hair', 0.22));                                  // cowlick, off the back
  f.rect(5, 12, 2, 3, SUIT_LO);                                     // planted leg
  f.vline(5, 12, 3, SUIT);                                          // leg seam
  f.rect(4, 14, 3, 1, tone('boot', 0.12));
  f.rect(8, 12, 2, 2, SUIT_LO);                                     // dragging leg
  f.rect(8, 14, 4, 1, tone('boot', 0.12));
  f.keyline();
  f.hline(7, 4, 2, INK); f.px(7, 5, INK);                           // sunken eye
  f.vline(6, 7, 5, INK);                                            // arm / torso
  f.px(10, 6, INK);
  f.px(7, 12, INK);                                                 // between the legs
  f.blit(p);
  return p;
}

/**
 * A sphere of contamination on stubs. The one creature toxin is for.
 *
 * Three belly tones, hard-edged. It used to run a continuous per-pixel ramp,
 * which produced thirty-seven distinct tones over three hundred pixels and
 * seventy-six single-pixel islands — an airbrush, not pixel art, and it is
 * exactly what the reference vocabulary does not do. Lit, base, shade: the
 * banding IS the modelling.
 *
 * The head is broken away from the mass with ink rather than bridged by a
 * neck. Disc plus neck rolls plus a sunk head is the profile of a bottle, and
 * that is what this read as; a head that sits in a socket reads as a head.
 */
function tBloater(p, seed = 'threat_bloater') {
  const f = form(24, 24);
  const r = rng(seed);
  const bellyTone = (i, j) => {
    const t = -(i + j * 1.3);
    return t > 4 ? HIDE_HI : t < -5 ? HIDE_LO : HIDE;
  };
  // The head goes down first and the body over it, so the shoulders cover its
  // base and it sits IN the mass rather than on a neck.
  f.rect(9, 2, 7, 7, HIDE_HI);
  f.hline(9, 2, 7, shade(HIDE_HI, 0.24));
  f.vline(15, 2, 7, HIDE_LO);
  // Limbs next, for the same reason: the belly overlaps their inner ends, so
  // they read as coming out from under it. They also have to project past the
  // belly, or the silhouette is a circle and the creature has no limbs at all
  // — which is precisely what it used to be, with every stub buried inside the
  // disc that was drawn on top of them.
  f.rect(1, 13, 5, 4, HIDE_LO); f.hline(1, 13, 5, HIDE);            // stub arms
  f.rect(18, 13, 5, 4, HIDE_LO); f.hline(18, 13, 5, HIDE);
  f.rect(6, 18, 5, 5, HIDE_LO); f.hline(6, 18, 5, HIDE);            // stub legs
  f.rect(13, 18, 5, 5, HIDE_LO); f.hline(13, 18, 5, HIDE);
  for (let j = -6; j <= 6; j++) {                                   // the belly
    for (let i = -8; i <= 8; i++) {
      if ((i * i) / 64 + (j * j) / 36 > 1.02) continue;
      f.px(12 + i, 14 + j, bellyTone(i, j));
    }
  }
  for (let j = 0; j < 5; j++) {                                     // squared shoulders
    for (let i = 0; i < 11; i++) f.px(7 + i, 9 + j, bellyTone(i - 5, j - 5));
  }
  f.keyline();
  f.hline(9, 9, 7, INK);                                            // head off the mass
  // Sacs. Bright core, ink rim, so they read as swollen and lit from within.
  // Two, well apart, both on the lit side of the belly. Four overlapping discs
  // merged into two amorphous green patches the moment the sprite was seen at
  // size; a sac that touches another sac is not a sac.
  // Drawn by hand rather than as three nested discs: at this radius disc()
  // returns a diamond, so nesting them gave a dark blob with a green cross
  // through it. A squared-distance cut at 10 is a real 7px circle and a cut at
  // 5 leaves a 1px ink ring round it.
  for (const [cx, cy] of [[7, 15], [16, 17]]) {
    for (let j = -3; j <= 3; j++) {
      for (let i = -3; i <= 3; i++) {
        const d = i * i + j * j;
        if (d <= 10) f.px(cx + i, cy + j, d > 5 ? INK : toxic(-0.22));
      }
    }
    f.px(cx - 1, cy - 1, toxic(0.45));
    f.px(cx, cy, toxic(0.14));
    f.px(cx + 1, cy + 1, toxic(-0.50));
  }
  for (let k = 0; k < 10; k++) {                                    // weeping
    const x = irnd(r, 5, 18), y = irnd(r, 11, 20);
    if (f.at(x, y)) f.px(x, y, toxic(-0.46));
  }
  f.px(11, 4, INK); f.px(14, 4, INK);                               // eyes
  f.hline(11, 6, 4, INK); f.px(12, 7, INK);                         // maw
  f.blit(p);
  return p;
}

/** Low, wide, spined. Built to close distance. */
function tRavager(p) {
  const f = form(24, 24);
  f.rect(4, 9, 15, 7, HIDE);                                        // barrel body
  f.hline(4, 9, 15, HIDE_HI);
  f.hline(4, 15, 15, HIDE_LO);
  f.rect(2, 9, 4, 4, HIDE_LO);                                      // haunch
  f.disc(6, 12, 4, 4, HIDE);
  f.hline(3, 9, 6, HIDE_HI);
  f.rect(16, 7, 6, 6, HIDE);                                        // skull
  f.hline(16, 7, 6, HIDE_HI);
  f.rect(19, 10, 4, 3, HIDE_LO);                                    // snout
  f.rect(1, 8, 5, 2, HIDE_LO); f.rect(1, 6, 3, 3, HIDE_LO);         // tail, kinked up
  for (let i = 0; i < 6; i++) {                                     // spine ridge
    const x = 5 + i * 2;
    const h = 2 + ((i * 5) % 3);
    f.rect(x, 9 - h, 2, h, BONE_LO);
    f.vline(x, 9 - h, h, BONE);
  }
  f.rect(15, 15, 3, 5, HIDE);                                       // forelimb
  f.rect(14, 20, 5, 2, HIDE_LO);
  f.rect(5, 15, 3, 4, HIDE_LO);                                     // hind foot
  f.rect(4, 19, 5, 2, HIDE_LO);
  // Claws BEFORE the keyline. They hang below the foot, so they are the
  // silhouette's lowest edge, not a marking on an already-outlined form — and
  // the ink that grows between them is what separates one claw from the next.
  for (const x of [14, 16, 18]) f.px(x, 22, BONE);
  f.px(5, 21, BONE); f.px(7, 21, BONE);
  f.keyline();
  // Teeth and the eye stay post-keyline: they are markings inside a mouth and
  // a socket that already carry ink all round, and outlining a one-pixel tooth
  // is the same as deleting it.
  f.hline(19, 13, 4, BONE);
  f.px(20, 14, BONE_LO); f.px(22, 14, BONE_LO);
  f.px(18, 9, AMBER); f.px(19, 9, AMBER_LO);                        // eye
  f.hline(16, 12, 3, INK);                                          // jaw line
  f.blit(p);
  return p;
}

/** The one that ends expeditions. A wall of shoulders under a bone crest. */
function tAlpha(p) {
  const f = form(32, 32);
  f.rect(3, 11, 26, 7, HIDE);                                       // shoulder mass
  f.hline(3, 11, 26, HIDE_HI);
  f.hline(3, 17, 26, HIDE_LO);
  f.rect(11, 17, 10, 7, HIDE);                                      // torso
  f.hline(11, 17, 10, HIDE_HI);
  f.vline(20, 17, 7, HIDE_LO);
  f.rect(12, 20, 8, 4, HIDE_LO);                                    // gut
  f.rect(2, 13, 6, 12, HIDE);                                       // far arm
  f.vline(2, 13, 12, HIDE_HI);
  f.rect(1, 24, 8, 4, HIDE_LO);                                     // fist
  f.rect(24, 13, 6, 12, HIDE_LO);                                   // near arm
  f.rect(23, 24, 8, 4, HIDE_LO);
  f.rect(13, 5, 7, 6, HIDE_HI);                                     // skull, sunk
  f.hline(13, 5, 7, shade(HIDE_HI, 0.22));
  f.vline(19, 5, 6, HIDE_LO);
  f.rect(14, 10, 6, 3, HIDE);                                       // heavy jaw
  f.rect(9, 2, 15, 3, BONE_LO);                                     // the crest
  f.rect(13, 1, 7, 2, BONE);
  f.hline(13, 1, 7, shade(BONE, 0.2));
  f.px(9, 1, BONE_LO); f.px(23, 1, BONE_LO);                        // crest horns
  f.rect(11, 24, 5, 5, HIDE); f.rect(17, 24, 5, 5, HIDE_LO);        // legs
  f.rect(10, 29, 7, 1, HIDE_LO); f.rect(17, 29, 7, 1, HIDE_LO);     // feet
  // Fused scrap plating, bolted on. Steel over hide, upper-left lit.
  //
  // Bolted edge FIRST, modelling inside it. Drawn the other way round — lit
  // top face, lit left face, shaded bottom, then the frame — every one of
  // those faces lies on the plate's perimeter and the frame overwrites all
  // three, so the game's hero threat wore five uniformly dark rectangles with
  // no light direction on them and three lines of lighting code that could not
  // reach a pixel.
  for (const [x, y, w, h] of [[5, 12, 7, 4], [20, 12, 7, 4], [12, 18, 7, 3], [2, 18, 5, 5], [24, 18, 5, 5]]) {
    f.frame(x, y, w, h, shade(MET_LO, -0.45));
    f.rect(x + 1, y + 1, w - 2, h - 2, MET_LO);
    f.hline(x + 1, y + 1, w - 2, MET);                              // lit top face
    f.vline(x + 1, y + 1, h - 2, MET);                              // lit left face
    f.hline(x + 1, y + h - 2, w - 2, IRON);                         // shaded bottom
    f.px(x + 1, y + 1, MET_HI);                                     // bolt head
  }
  // Toe claws before the keyline. They are the bottom edge of the silhouette,
  // not a marking on it, and the ink that grows into the gaps between them is
  // the only thing that makes three claws read as three rather than as a bar.
  for (const x of [10, 12, 14, 16]) f.px(x, 30, BONE_LO);
  for (const x of [17, 19, 21, 23]) f.px(x, 30, BONE_LO);
  f.keyline();
  f.px(15, 7, AMBER); f.px(18, 7, AMBER);                           // eyes
  f.px(15, 6, AMBER_HI); f.px(18, 6, AMBER_HI);
  f.hline(14, 10, 6, INK);
  for (const x of [15, 17, 19]) f.px(x, 11, BONE);                  // tusks, in the jaw
  f.px(14, 12, BONE); f.px(19, 12, BONE);
  f.blit(p);
  return p;
}

/** Wasteland scavenger: hood, pack, and a length of pipe carried upright. */
function tRaider(p) {
  const f = form(16, 16);
  f.rect(2, 6, 4, 6, RAG_LO);                                       // pack
  f.hline(2, 6, 4, RAG);
  f.hline(2, 8, 4, BONE_LO); f.hline(2, 10, 4, shade(BONE_LO, -0.3));  // straps
  f.rect(5, 6, 6, 6, COAT);                                         // coat
  f.hline(5, 6, 6, COAT_HI);
  f.vline(10, 6, 6, COAT_LO);
  f.rect(5, 11, 6, 2, COAT_LO);
  f.rect(4, 3, 7, 4, RAG);                                          // hood
  f.hline(4, 3, 7, RAG_HI);
  f.vline(10, 3, 4, RAG_LO);
  f.rect(6, 5, 4, 2, INK);                                          // face shadow
  f.rect(9, 7, 3, 2, COAT); f.hline(9, 7, 3, COAT_HI);              // arm to the pipe
  f.rect(5, 13, 2, 2, tone('boot')); f.rect(8, 13, 2, 2, tone('boot'));
  f.rect(4, 14, 3, 1, tone('boot', -0.2)); f.rect(8, 14, 3, 1, tone('boot', -0.2));
  f.rect(12, 2, 2, 11, MET);                                        // the pipe, shouldered
  f.vline(12, 2, 11, MET_HI);
  f.vline(13, 2, 11, MET_LO);
  f.rect(11, 1, 4, 2, MET_LO); f.hline(11, 1, 4, MET);              // club head, clear of the hood
  f.keyline();
  f.px(9, 6, AMBER);                                                // the one eye
  f.px(6, 6, shade(BONE_LO, -0.2));                                 // rag knot
  f.blit(p);
  return p;
}

/**
 * Ash Company: helmet, greatcoat, and a rifle held level across the body.
 *
 * Four elements, and only four: helmet-with-brim, coat mass, rifle, boots.
 * There used to be eleven, eight of them cut from the same steel family and
 * sitting on a greatcoat cut from near-ink grey, so the one structural idea
 * this figure has — the horizontal of the weapon crossing the vertical of the
 * body — was a 1px value step and disappeared. The rifle now crosses a green
 * coat with a full ink keyline underneath it, which is the only way a weapon
 * separates from the man carrying it at sixteen pixels.
 */
function tAshCompany(p) {
  const f = form(16, 16);
  f.rect(4, 6, 8, 7, FIELD);                                        // greatcoat
  f.hline(4, 6, 8, FIELD_HI);
  f.vline(11, 6, 7, FIELD_LO);
  f.rect(3, 10, 10, 3, FIELD);                                      // skirt, flaring
  f.hline(3, 10, 10, FIELD_HI);
  f.hline(3, 12, 10, FIELD_LO);
  // Helmet and brim are ONE head, not two stacked bars: the brim overhangs the
  // dome by a single pixel each side and shares its bottom row. Ten pixels
  // wide and two rows deep, as it was, it read as a shelf between the head and
  // the body and gave the figure a third horizontal to compete with the rifle.
  f.rect(5, 1, 6, 3, MET_LO);
  f.hline(5, 1, 6, MET);
  f.vline(10, 1, 3, IRON);
  f.rect(4, 4, 8, 2, IRON);                                         // brim
  f.hline(4, 4, 8, MET);                                            // lit top, dark under
  f.px(4, 4, MET_HI);
  f.rect(5, 13, 3, 1, tone('boot')); f.rect(9, 13, 3, 1, tone('boot'));
  f.rect(5, 14, 3, 1, tone('boot', -0.2)); f.rect(9, 14, 3, 1, tone('boot', -0.2));
  // The rifle, held level. Drawn before keyline() so the ends that project
  // past the coat get outlined for free, and hand-inked top and bottom where
  // it crosses the body — the coat is a solid form with its own keyline, so
  // keyline() has nothing empty to grow into there and cannot separate them.
  // The whole figure is arranged around this one line: helmet six wide, brim
  // eight, chest eight, rifle fourteen, skirt ten, so the eye steps out to the
  // weapon and back in again.
  f.rect(2, 9, 12, 2, MET);
  f.hline(2, 9, 12, MET_HI);
  f.hline(2, 10, 12, IRON);
  f.hline(13, 9, 2, MET);                                           // thin muzzle
  f.rect(1, 8, 4, 3, WOOD); f.hline(1, 8, 4, WOOD_HI);              // stock
  f.keyline();
  f.hline(5, 8, 7, INK);
  f.hline(5, 11, 7, INK);
  f.hline(5, 2, 5, INK);                                            // visor slot
  f.hline(6, 2, 3, AMBER);
  f.vline(7, 7, 2, FIELD_HI); f.px(7, 12, FIELD_HI);                 // coat placket
  f.blit(p);
  return p;
}

/**
 * A machine that was a mining charge sled, and is now mostly jaw.
 *
 * THREE legs, not four, and spaced three pixels apart. keyline() grows ink one
 * pixel into every empty neighbour, so four 1px legs at x=3,6,8,10 had their
 * gaps completely filled from both sides: the output at leg height was a 50%
 * black hatch, and the feet — three pixels each at a three-pixel pitch — ran
 * together into one solid bar. Three legs at a four-pixel pitch leave a real
 * transparent column between each pair, which is the only thing that makes a
 * box on legs read as a box on legs.
 */
function tScrapjaw(p) {
  const f = form(16, 16);
  f.rect(2, 5, 9, 5, MET_LO);                                       // chassis
  f.hline(2, 5, 9, MET);
  f.vline(2, 5, 5, MET);
  f.hline(2, 9, 9, IRON);
  f.rect(4, 6, 3, 2, tone('rust', -0.42));                          // rust patch
  f.rect(10, 4, 5, 3, MET);                                         // upper jaw
  f.hline(10, 4, 5, MET_HI);
  f.rect(10, 8, 5, 3, MET_LO);                                      // lower jaw
  f.hline(10, 10, 5, IRON);
  f.rect(9, 4, 2, 7, MET_LO);                                       // hinge block
  f.vline(9, 4, 7, MET);
  for (const x of [3, 7, 11]) {                                     // three stiff legs
    f.vline(x, 10, 4, MET_LO);
    f.px(x, 10, MET);
    f.hline(x - 1, 14, 2, IRON);                                    // 2px foot, no bar
  }
  f.rect(3, 2, 1, 3, MET_LO);                                       // antenna
  f.keyline();
  f.px(3, 1, AMBER);
  f.px(8, 6, AMBER); f.px(8, 7, AMBER_LO);                          // optic
  for (const x of [11, 13]) { f.px(x, 7, BONE); f.px(x + 1, 8, BONE); }   // teeth
  f.px(12, 7, BONE_LO); f.px(14, 8, BONE_LO);
  f.hline(10, 7, 5, INK);                                           // the open gap
  f.blit(p);
  return p;
}

/** Choir cultist: pointed hood, bell of robe, one arm up with a lamp. */
function tCultist(p) {
  const f = form(16, 16);
  for (let j = 0; j < 8; j++) {                                     // the robe, flaring
    const w = 5 + j;
    const x = 7 - Math.floor(w / 2);
    f.rect(x, 7 + j, w, 1, ROBE);
    f.px(x, 7 + j, ROBE_HI);
    f.px(x + w - 1, 7 + j, ROBE_LO);
  }
  f.rect(3, 14, 9, 1, ROBE_LO);
  f.rect(5, 2, 5, 5, ROBE);                                         // hood
  f.hline(5, 2, 5, ROBE_HI);
  f.vline(9, 2, 5, ROBE_LO);
  f.rect(6, 1, 3, 2, ROBE);                                         // the point
  f.px(7, 1, ROBE_HI);
  f.rect(10, 4, 2, 4, ROBE);                                        // raised arm
  f.vline(10, 4, 4, ROBE_HI);
  f.rect(5, 9, 4, 1, ROBE_LO);                                      // folded arm
  f.rect(11, 2, 3, 3, MET_LO);                                      // the lamp
  f.hline(11, 2, 3, MET);
  f.keyline();
  f.rect(6, 4, 3, 3, BONE);                                         // mask
  f.hline(6, 4, 3, shade(BONE, 0.18));
  f.vline(7, 4, 3, INK);                                            // the slit
  f.px(12, 3, AMBER_HI);                                            // lamp flame
  f.px(11, 3, AMBER); f.px(13, 3, AMBER_LO);
  f.hline(4, 10, 7, tone('rust', -0.34));                           // rope belt
  f.px(7, 11, tone('rust', -0.5));
  f.blit(p);
  return p;
}

/**
 * Freerider: wide brim, a bedroll above the shoulder, and a staff.
 *
 * Rebuilt for air. The old one covered 77% of its box — pack at x=2-5, coat at
 * 6-10, brim spanning 4-12 and staff at 12, so after the keyline it was a
 * solid rectangle edge to edge and read at size as a brown door. The pack is
 * now short and low, the staff stands a clear column off the body with sky
 * between them, and the brim is two pixels tall so it survives its own keyline
 * and actually silhouettes as a hat. The tone count is halved.
 *
 * It also has to stay clear of the raider, which is the pair a player really
 * confuses: both are a hooded figure with a pack and something vertical on the
 * right. The raider keeps the rust coat and a straight iron pipe; the trader
 * gets a pale canvas load, a wide hat and a staff that leans.
 */
function tTrader(p) {
  const f = form(16, 16);
  const LOAD = tone('bone', -0.38), LOAD_HI = tone('bone', -0.18);
  f.rect(2, 7, 4, 4, LOAD);                                         // pack, low and small
  f.hline(2, 7, 4, LOAD_HI);
  f.rect(3, 4, 4, 3, LOAD_HI);                                      // bedroll, above it
  f.hline(3, 6, 4, LOAD);
  f.rect(6, 7, 5, 5, COAT);                                         // coat
  f.hline(6, 7, 5, COAT_HI);
  f.vline(10, 7, 5, COAT_LO);
  f.rect(6, 11, 5, 2, COAT_LO);
  f.rect(6, 4, 4, 3, FLESH);                                        // head
  f.hline(6, 4, 4, FLESH_HI);
  f.vline(9, 4, 3, FLESH_LO);
  f.rect(5, 2, 7, 2, WOOD);                                         // the brim, 2px
  f.hline(5, 2, 7, WOOD_HI);
  f.rect(7, 1, 3, 2, WOOD_HI);                                      // the crown
  // The staff leans, and it stands off the body: column 13 at the top, 14 at
  // the foot, with 12 left empty so daylight shows between man and stick.
  f.vline(13, 1, 7, WOOD_HI);
  f.vline(14, 8, 7, WOOD);
  f.rect(6, 13, 2, 2, tone('boot')); f.rect(9, 13, 2, 2, tone('boot'));
  f.rect(5, 14, 3, 1, tone('boot', -0.2)); f.rect(9, 14, 3, 1, tone('boot', -0.2));
  f.keyline();
  f.px(9, 5, INK);                                                  // eye under the brim
  f.px(13, 2, AMBER_LO);                                            // a charm on the staff
  f.blit(p);
  return p;
}

/**
 * The Broodmother. encounters.js tier 5, power 85, anchored, spawns shamblers
 * — the one fight that decides an expedition, and the only enemy in the game
 * that had no sprite at all.
 *
 * Anchored is the whole design. Everything else in this roster stands or runs;
 * this one is rooted. So it has no legs: a low fused mass spread on the ground
 * with rooted limbs splayed left and right, a birth sac slung under it, and a
 * small head carried high on a long neck over a body far too wide for it. The
 * silhouette is a broad triangle, which nothing else here is.
 */
function tBroodmother(p, seed = 'threat_broodmother') {
  const f = form(32, 32);
  const r = rng(seed);
  // The rooted base: a spread of fused limbs along the floor, widest at the
  // bottom, so the whole thing reads as grown out of the ground.
  for (let j = 0; j < 6; j++) {
    const w = 20 + j * 2;
    f.rect(16 - (w >> 1), 25 + j, w, 1, j > 3 ? HIDE_LO : HIDE);
  }
  f.hline(6, 25, 20, HIDE_HI);
  for (const x of [3, 7, 24, 28]) f.rect(x, 28, 2, 3, HIDE_LO);     // root claws
  f.rect(6, 14, 20, 12, HIDE);                                      // the mass
  f.hline(6, 14, 20, HIDE_HI);
  f.vline(6, 14, 12, HIDE_HI);
  f.hline(6, 25, 20, HIDE_LO);
  f.vline(25, 14, 12, HIDE_LO);
  f.rect(8, 20, 16, 5, HIDE_LO);                                    // the slung sac
  f.hline(8, 20, 16, HIDE);
  f.rect(2, 16, 5, 6, HIDE_LO); f.rect(1, 21, 4, 3, HIDE_LO);       // rooted limbs
  f.rect(25, 16, 5, 6, HIDE); f.rect(27, 21, 4, 3, HIDE_LO);
  f.rect(14, 8, 4, 7, HIDE);                                        // neck
  f.vline(14, 8, 7, HIDE_HI); f.vline(17, 8, 7, HIDE_LO);
  f.rect(12, 3, 8, 6, HIDE_HI);                                     // the small head
  f.hline(12, 3, 8, shade(HIDE_HI, 0.24));
  f.vline(19, 3, 6, HIDE_LO);
  f.rect(11, 1, 4, 3, BONE_LO); f.rect(17, 1, 4, 3, BONE_LO);       // paired horns
  f.hline(11, 1, 4, BONE); f.hline(17, 1, 4, BONE);
  f.keyline();
  f.hline(14, 9, 4, INK);                                           // head off the neck
  // The brood. Egg light through the sac wall — the one thing on this sprite
  // that is allowed to be toxin, and the reason it is the boss.
  for (const [cx, cy] of [[11, 22], [16, 23], [21, 22]]) {
    f.disc(cx, cy, 2, 2, INK);
    f.disc(cx, cy, 1, 1, toxic(-0.24));
    f.px(cx, cy, toxic(0.30));
  }
  for (let k = 0; k < 16; k++) {                                    // weeping
    const x = irnd(r, 7, 24), y = irnd(r, 15, 26);
    if (f.at(x, y)) f.px(x, y, toxic(-0.52));
  }
  f.px(13, 5, AMBER); f.px(18, 5, AMBER);                           // eyes
  f.px(13, 4, AMBER_HI); f.px(18, 4, AMBER_HI);
  f.hline(13, 7, 6, INK);                                           // the maw
  for (const x of [14, 16, 18]) f.px(x, 7, BONE);
  f.blit(p);
  return p;
}

export const THREATS = {
  husk: tHusk,
  shambler: tShambler,
  bloater: tBloater,
  ravager: tRavager,
  alpha: tAlpha,
  broodmother: tBroodmother,
  raider: tRaider,
  ash_company: tAshCompany,
  scrapjaw: tScrapjaw,
  cultist: tCultist,
  trader: tTrader,
};

/* =============================================================== the props == */
/*
 * Fourteen pieces of 16x16 set dressing, transparent, every floor-standing one
 * of them standing on row 14 with its keyline landing on row 15. That shared
 * baseline is the whole point: drop any of these into a room at the same y and
 * they sit on the same floor, which is not true of art authored one sprite at
 * a time. Two of them hang off a wall instead and are named in WALL_PROPS; the
 * self-test checks both rules rather than trusting this paragraph, which is
 * how the two wall props used to be silent violations of it.
 *
 * TWO THINGS DECIDE A PROP, in this order: its outline, and its overall value.
 * Colour accents decide nothing, because at the size these are drawn a 1px
 * accent is the only thing that survives downsampling — and when nine of
 * twelve props carried the same amber dot on the same 12x10 grey slab, the set
 * read as one object with twelve reskins. So: no two footprints alike, a
 * different dominant tone each, and amber reserved for the three props where a
 * lit indicator or a hazard marking IS the object — the lamp, the barrel and
 * the terminal. The self-test compares every prop silhouette against every
 * other and fails the build if two converge, exactly as it does for threats.
 *
 * COVERAGE, against src/data/rooms.js. The old set was five containers out of
 * twelve — crate, barrel, locker, sacks and shelf — which dresses a storeroom
 * and a dormitory and offers the other twenty-odd rooms a crate. The sacks
 * were cut (three touching discs that rendered as one pale boulder) and three
 * props that carry a room's function added in their place: a gurney for the
 * clinic, a weapon rack for the armory, an ore cart for the deep mine. That
 * leaves four containers in fourteen. suit_bay, archive and schoolhouse are
 * still undressed and are the next three to draw.
 */

/** Props that hang off a wall, and are therefore exempt from the floor line. */
export const WALL_PROPS = new Set(['toolboard', 'fan']);

/**
 * A tool or a fitting lying ON an already-solid surface still gets a keyline
 * — it is a separate object, not a marking — but keyline() cannot supply one,
 * because it only grows ink into EMPTY pixels and there are none under a tool
 * hanging on a board. So the ink goes down first and the tool is drawn inside
 * it. Post-keyline drawing stays for what the contract actually sanctions:
 * eyes, screens, emissive dots.
 */
function inked(f, x, y, w, h, paint) {
  f.rect(x - 1, y - 1, w + 2, h + 2, INK);
  paint();
  return f;
}

/** Wooden crate. Overhanging lid, so the outline is a T and not a rectangle. */
function pCrate(p) {
  const f = form(16, 16);
  f.slab(1, 4, 14, 3, WOOD, 0.26, -0.26);                                // lid, proud
  f.slab(3, 7, 10, 8, WOOD, 0.22, -0.26);                                // body, narrower
  for (let x = 5; x < 12; x += 3) {
    f.vline(x, 8, 6, shade(WOOD, -0.34));                                // plank seam
    f.vline(x + 1, 8, 6, WOOD_HI);                                       // and its lit lip
  }
  for (const [x, y] of [[3, 7], [10, 7], [3, 12], [10, 12]]) {            // corner plates
    f.rect(x, y, 3, 3, MET_LO); f.hline(x, y, 3, MET); f.px(x + 1, y + 1, MET_HI);
  }
  f.keyline();
  f.hline(5, 10, 6, shade(WOOD, -0.46));                                 // stencil
  f.hline(5, 5, 6, shade(WOOD, -0.46));
  return f.blit(p), p;
}

/**
 * Steel drum. Drawn through lib's cylinder rather than by hand, so it has the
 * shaved cap and the 22%/18% highlight-and-shade split that every tank in
 * every room interior has — a hand-rolled barrel with square corners standing
 * next to a p.cylinder tank visibly does not belong to the same game. lib's
 * cylinder brings its own keyline, so this is the one prop that does not call
 * keyline() at all.
 */
function pBarrel(p) {
  const f = form(16, 16);
  libDraw(f, 4, 3, 8, 13, (q) => q.cylinder(0, 0, 8, 13, MET));
  for (const y of [6, 12]) {                                             // hoops
    f.hline(5, y, 6, MET_HI);
    f.hline(5, y + 1, 6, IRON);
  }
  // The hazard band follows the curve. Laid flat across the full width it
  // wiped out the highlight column, both shade columns and the underside of a
  // hoop, and for two of its twelve rows the barrel stopped being a cylinder.
  // A band painted on a round thing is still round.
  for (const [y, k] of [[8, 0], [9, -0.3]]) {
    f.hline(5, y, 2, shade(AMBER_HI, k));
    f.hline(7, y, 3, shade(AMBER, k));
    f.px(10, y, shade(AMBER_LO, k));
  }
  f.px(6, 5, shade(MET, -0.3)); f.px(9, 11, shade(MET, -0.3));           // dents
  return f.blit(p), p;
}

/** Tall locker. Capped, and standing on two feet with daylight between them. */
function pLocker(p) {
  const f = form(16, 16);
  f.slab(2, 1, 12, 2, MET, 0.26, -0.30);                                 // cap, overhanging
  f.slab(4, 3, 8, 10, MET_LO, 0.26, -0.26);                              // body
  f.vline(7, 4, 8, IRON); f.vline(8, 4, 8, MET_HI);                      // door seam
  // Vent slats lit like pFan's: a lit top face and a shaded underside, so
  // each slat has a direction. Two dark tones alternating gave a smudge.
  for (let y = 4; y <= 7; y++) {
    f.hline(5, y, 2, y % 2 ? MET_HI : IRON);
    f.hline(9, y, 2, y % 2 ? MET_HI : IRON);
  }
  f.vline(6, 9, 3, MET_HI); f.px(6, 12, IRON);                           // handles
  f.vline(9, 9, 3, MET_HI); f.px(9, 12, IRON);
  f.rect(4, 13, 2, 2, IRON); f.rect(10, 13, 2, 2, IRON);                 // feet, 4px apart
  f.keyline();
  return f.blit(p), p;
}

/**
 * Two-tier bunk. The ladder projects past the frame, which is its outline.
 *
 * The open air under each bunk is load-bearing and is why the mattresses are
 * two rows and not three: at 86% cover this was a filled rectangle with a
 * pattern on it, and a bunk that has no space under it is a cupboard.
 */
function pBunk(p) {
  const f = form(16, 16);
  f.vline(2, 2, 13, MET); f.vline(3, 2, 13, MET_LO);                     // posts
  f.vline(10, 2, 13, MET); f.vline(11, 2, 13, MET_LO);
  for (const y of [6, 12]) {
    f.rect(2, y, 10, 1, MET_HI);                                         // the deck
    f.rect(3, y - 2, 8, 2, tone('bone', -0.26));                         // mattress
    f.hline(3, y - 2, 8, tone('bone', -0.06));
    f.rect(3, y - 1, 5, 1, COAT); f.hline(3, y - 1, 5, COAT_HI);         // blanket
    f.rect(8, y - 3, 3, 1, tone('bone', -0.04));                         // pillow
  }
  f.vline(14, 3, 12, MET_LO);                                            // ladder stile
  for (const y of [4, 7, 10, 13]) f.hline(12, y, 3, MET_HI);             // rungs
  f.rect(2, 14, 10, 1, IRON);
  f.keyline();
  return f.blit(p), p;
}

/** Console. Wide overhanging head on a narrow pedestal — a mushroom, not a box. */
function pTerminal(p) {
  const f = form(16, 16);
  f.slab(1, 3, 14, 7, MET_LO, 0.24, -0.26);                              // the head
  f.slab(5, 10, 6, 4, IRON, 0.20, -0.20);                                // pedestal
  f.rect(3, 14, 10, 1, MET_LO);                                          // foot plate
  f.keyline();
  // Through lib's screen(), so it gets the scanline every second row that
  // makes a screen read as emitting rather than painted — the same screen the
  // room interiors use.
  libDraw(f, 3, 4, 10, 5, (q) => q.screen(0, 0, 10, 5, PAL.verdigris));
  f.px(13, 4, AMBER);                                                    // power lamp
  f.px(13, 6, shade(GREEN, -0.2));
  return f.blit(p), p;
}

/**
 * Hydroponic planter. Three overlapping leaf lobes over a visible stem.
 *
 * A leaf is not a lozenge. The previous version stacked three ellipses three
 * rows apart, which overlapped into one solid mass and hid the stem entirely,
 * and then drew each lozenge's lit and shaded edges as FULL-WIDTH hlines
 * regardless of how wide the ellipse actually was at that row — so the top and
 * bottom of every "leaf" was a straight nine-pixel bar and the whole thing
 * rendered as two green cushions in a tin.
 *
 * What makes foliage read at sixteen pixels is a LOBED OUTLINE. Three discs
 * that overlap give one automatically, and each drawn as a shaded body with a
 * lit core offset up and left gives each lobe its own light without a single
 * straight edge anywhere.
 */
function pPlant(p) {
  const f = form(16, 16);
  f.rect(3, 12, 10, 2, MET_LO); f.hline(3, 12, 10, MET_HI);              // tray
  f.rect(4, 13, 8, 1, tone('rust', -0.55));                              // growing medium
  f.rect(3, 14, 10, 1, IRON);
  f.vline(7, 8, 4, GREEN);                                               // stem, lit LEFT
  f.vline(8, 8, 4, shade(GREEN, -0.38));                                 // shaded RIGHT
  // Back lobe first, front lobes over it: each new lobe's shaded rim cuts a
  // dark line across the one behind, which is the separation.
  for (const [cx, cy, rr] of [[7, 5, 4], [4, 7, 3], [11, 7, 3]]) {
    f.disc(cx, cy, rr, rr, shade(GREEN, -0.34));
    f.disc(cx - 1, cy - 1, rr - 1, rr - 1, GREEN);
    f.disc(cx - 1, cy - 1, rr - 2, rr - 2, shade(GREEN, 0.18));
  }
  f.keyline();
  f.px(6, 4, shade(GREEN, -0.5)); f.px(7, 5, shade(GREEN, -0.5));        // midribs
  f.px(3, 6, shade(GREEN, -0.5)); f.px(10, 6, shade(GREEN, -0.5));
  return f.blit(p), p;
}

/** Tool board, wall-hung. Two tools, each with its own ink, and nothing else. */
function pToolboard(p) {
  const f = form(16, 16);
  f.slab(2, 1, 12, 12, WOOD, 0.20, -0.24);                               // the board
  for (let y = 3; y < 12; y += 3) for (let x = 4; x < 13; x += 3) f.px(x, y, shade(WOOD, -0.42));
  inked(f, 3, 3, 3, 8, () => {                                           // a wrench
    f.rect(3, 3, 3, 2, MET_HI); f.px(4, 4, IRON);
    f.vline(4, 5, 6, MET); f.vline(5, 5, 6, MET_LO);
  });
  inked(f, 9, 3, 4, 8, () => {                                           // a hammer
    f.rect(9, 3, 4, 2, MET_LO); f.hline(9, 3, 4, MET);
    f.vline(10, 5, 6, WOOD_HI); f.vline(11, 5, 6, WOOD);
  });
  f.keyline();
  return f.blit(p), p;
}

/**
 * Work lamp. Cone, mast, splayed feet, and one lit face.
 *
 * The dithered spill is gone. It was nine unoutlined single amber pixels
 * scattered on transparency below the lamp — seventeen percent of the sprite
 * as 1px islands, which at the size this is drawn is dirt on the screen rather
 * than light. It also only stayed inside the sprite by a Bayer coincidence at
 * one threshold, so any tweak to the falloff broke the border check. A bright
 * face inside an inked cone reads as a lamp on its own.
 */
function pLamp(p) {
  const f = form(16, 16);
  f.vline(7, 8, 6, MET); f.vline(8, 8, 6, MET_LO);                       // mast
  f.rect(3, 13, 4, 1, MET_LO); f.rect(9, 13, 4, 1, MET_LO);              // splayed feet
  f.px(5, 12, MET); f.px(10, 12, MET_LO);
  f.rect(3, 14, 10, 1, IRON);
  for (let j = 0; j < 4; j++) {                                          // conical shade
    const w = 6 + j * 2;
    f.rect(8 - Math.floor(w / 2), 2 + j, w, 1, j ? MET_LO : MET);
    f.px(8 - Math.floor(w / 2), 2 + j, MET_HI);
    f.px(8 + Math.ceil(w / 2) - 1, 2 + j, IRON);
  }
  f.rect(2, 6, 12, 2, MET_LO);                                           // the rim
  f.keyline();
  f.rect(3, 6, 10, 2, AMBER);                                            // the lit face
  f.hline(4, 6, 8, AMBER_HI);
  f.hline(4, 7, 8, AMBER_LO);
  return f.blit(p), p;
}

/**
 * Cable drum. A wooden flange with the wound cable filling it.
 *
 * The winding is the point, so it is most of what you see: a banded disc of
 * cold metal inside a warm rim, every band clamped to the disc's own half
 * width at that row. Drawn as four constant-length hlines it painted metal
 * from x=4 to x=10 on rows where the drum was one pixel across, so the result
 * was four full-width bars lying over a wooden ring — a metal box in a hoop.
 */
function pSpool(p) {
  const f = form(16, 16);
  const RIM = 36, DRUM = 17;                                             // squared radii
  for (let j = -6; j <= 6; j++) {                                        // flange
    for (let i = -6; i <= 6; i++) {
      const d = i * i + j * j;
      if (d > RIM || d <= DRUM) continue;
      f.px(7 + i, 8 + j, i + j < -4 ? WOOD_HI : i + j > 4 ? shade(WOOD, -0.34) : WOOD);
    }
  }
  for (let j = -4; j <= 4; j++) {                                        // the wound cable
    const half = Math.floor(Math.sqrt(Math.max(0, DRUM - j * j)));
    if (half < 0) continue;
    const coil = (j + 4) % 2 === 0;
    f.hline(7 - half, 8 + j, half * 2 + 1, coil ? MET : shade(MET, -0.46));
    if (coil) f.px(7 - half, 8 + j, MET_HI);
  }
  f.rect(6, 7, 3, 3, MET_LO); f.hline(6, 7, 3, MET); f.px(7, 8, IRON);   // hub
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {           // flange spokes
    for (let k = 5; k <= 6; k++) f.px(7 + dx * k, 8 + dy * k, shade(WOOD, -0.40));
  }
  f.rect(12, 10, 3, 4, shade(MET, -0.42));                               // cable paid out
  f.hline(12, 10, 3, shade(MET, -0.2));
  f.rect(3, 14, 9, 1, IRON);                                             // chock
  f.keyline();
  return f.blit(p), p;
}

/** Extractor fan, wall-mounted. A round bezel, which nothing else here is. */
function pFan(p) {
  const f = form(16, 16);
  const R2 = 42, R1 = 20;                                                // squared radii
  for (let j = -6; j <= 6; j++) {
    for (let i = -6; i <= 6; i++) {
      const d = i * i + j * j;
      if (d > R2) continue;
      f.px(8 + i, 7 + j, d > R1
        ? (i + j < -3 ? MET_HI : i + j > 3 ? IRON : MET_LO)
        : tone('deeper', 0.04));
    }
  }
  // Slats inset one pixel inside the duct, so the dark duct shows as a ring
  // round them and the thing reads as a grille set into a bezel rather than as
  // a striped ball.
  for (let j = -3; j <= 2; j += 2) {                                     // louvre slats
    const a = Math.max(0, Math.floor(Math.sqrt(Math.max(0, R1 - j * j))) - 1);
    const b = Math.max(0, Math.floor(Math.sqrt(Math.max(0, R1 - (j + 1) * (j + 1)))) - 1);
    if (a >= 1) f.hline(8 - a, 7 + j, a * 2 + 1, MET_HI);                // lit top face
    if (b >= 1) f.hline(8 - b, 7 + j + 1, b * 2 + 1, IRON);              // shaded underside
  }
  for (const [x, y] of [[4, 3], [12, 3], [4, 11], [12, 11]]) f.px(x, y, MET_HI);  // bolts
  f.keyline();
  return f.blit(p), p;
}

/** Storage rack. Stepped outline, and a case standing proud of the top board. */
function pShelf(p) {
  const f = form(16, 16);
  f.vline(2, 5, 10, MET); f.vline(3, 5, 10, MET_LO);                     // uprights
  f.vline(12, 5, 10, MET); f.vline(13, 5, 10, MET_LO);
  for (const y of [5, 9, 13]) { f.hline(2, y, 12, MET_HI); f.hline(2, y + 1, 12, IRON); }
  f.rect(4, 2, 5, 3, WOOD); f.hline(4, 2, 5, WOOD_HI);                   // case, standing proud
  f.rect(5, 7, 3, 2, CANVAS); f.hline(5, 7, 3, CANVAS_HI);               // a bundle
  f.rect(9, 6, 2, 3, MET_LO); f.hline(9, 6, 2, MET);                     // a tin
  f.rect(4, 11, 8, 2, WOOD); f.hline(4, 11, 8, WOOD_HI);                 // a long case
  f.vline(8, 11, 2, shade(WOOD, -0.34));
  f.keyline();
  return f.blit(p), p;
}

/** Clinic gurney. Long and low on thin legs — the flattest outline in the set. */
function pGurney(p) {
  const f = form(16, 16);
  f.rect(2, 4, 12, 2, tone('bone', -0.24));                              // mattress
  f.hline(2, 4, 12, tone('bone', -0.04));
  f.rect(9, 3, 4, 1, tone('bone', -0.06));                               // pillow
  f.rect(2, 5, 6, 1, ROBE_LO);                                           // a sheet, thrown back
  f.rect(1, 6, 14, 1, MET_HI);                                           // the frame
  f.hline(1, 7, 14, IRON);
  f.vline(3, 8, 4, MET); f.vline(12, 8, 4, MET_LO);                      // legs
  f.vline(6, 8, 4, MET_LO); f.vline(9, 8, 4, MET_LO);
  for (const cx of [3, 12]) {                                            // castors
    f.disc(cx, 12, 2, 2, IRON);
    f.px(cx - 1, 11, MET);
  }
  f.keyline();
  f.hline(3, 5, 3, tone('rust', -0.42));                                 // a blanket edge
  return f.blit(p), p;
}

/** Armory rack. Three rifles standing, with real daylight between the barrels. */
function pWeaponrack(p) {
  const f = form(16, 16);
  for (const x of [2, 7, 12]) {                                          // the arms
    f.vline(x, 2, 8, MET);
    f.vline(x + 1, 2, 8, MET_LO);
    f.px(x, 2, MET_HI);
  }
  f.rect(1, 10, 14, 2, WOOD);                                            // the retaining bar
  f.hline(1, 10, 14, WOOD_HI);
  f.rect(2, 12, 12, 2, shade(WOOD, -0.30));                              // the trough
  f.hline(2, 12, 12, WOOD);
  f.rect(2, 14, 12, 1, IRON);
  f.keyline();
  for (const x of [2, 7, 12]) f.px(x, 5, shade(WOOD, -0.20));            // furniture
  return f.blit(p), p;
}

/** Mine cart. A heaped trapezoid on two wheels: nothing else here is a taper. */
function pOrecart(p) {
  const f = form(16, 16);
  const ROCK = tone('concrete', -0.30), ROCK_HI = tone('concrete', -0.04);
  f.rect(4, 2, 8, 2, ROCK); f.hline(4, 2, 8, ROCK_HI);                   // the heap
  f.px(6, 1, ROCK_HI); f.px(9, 1, ROCK);
  for (let j = 0; j < 7; j++) {                                          // the hopper
    const w = 13 - j * 2;
    const x = 8 - (w >> 1);
    f.rect(x, 4 + j, w, 1, IRON);
    f.px(x, 4 + j, MET);
    f.px(x + w - 1, 4 + j, shade(IRON, -0.3));
  }
  f.hline(2, 4, 13, MET_HI);                                             // the lip
  f.rect(4, 10, 9, 1, MET_LO);                                           // the chassis
  for (const cx of [5, 11]) {                                            // wheels
    f.disc(cx, 12, 2, 2, MET_LO);
    f.px(cx - 1, 11, MET_HI); f.px(cx + 1, 13, IRON);
  }
  f.keyline();
  for (const cx of [5, 11]) f.px(cx, 12, IRON);                          // hubs
  return f.blit(p), p;
}

/**
 * A skull and crossbones, for where somebody died.
 *
 * The one marker in the game that is not a machine, and it has to read at 1:1
 * against a busy room interior — so it is built for silhouette rather than
 * detail: a wide cranium, a narrow jaw, two deep sockets, and the bones
 * crossing behind at a diagonal that nothing else on screen uses. Bone against
 * the greys is the highest-contrast pairing this palette has, which is the
 * point; a death marker that has to be looked for is not a marker.
 *
 * Sockets and nasal cavity are ink rather than a dark tone. At this size a
 * shaded socket fills in against the skull's own shadow and the face reads as
 * a blank oval, which is a stone, not a skull.
 */
function pSkull(p) {
  const f = form(16, 16);

  // Crossbones first, so the skull sits over them.
  for (let i = 0; i < 9; i++) {
    f.px(4 + i, 5 + i, BONE_LO);
    f.px(4 + i, 13 - i, BONE_LO);
  }
  // Knuckle ends, which is what makes them bones and not sticks.
  for (const [bx, by] of [[3, 4], [3, 12], [12, 13], [12, 5]]) {
    f.rect(bx, by, 2, 2, BONE_LO);
  }

  // Cranium: six wide at the brow, tapering to a four-wide jaw.
  f.rect(5, 4, 6, 5, BONE);
  f.hline(6, 3, 4, BONE);
  f.rect(6, 9, 4, 2, BONE);
  // The lit crown, top-left, matching every other sprite in this file.
  f.hline(6, 3, 3, tone('bone', 0.24));
  f.px(5, 4, tone('bone', 0.24));

  f.keyline();

  // The face, after the keyline so the sockets stay open.
  f.rect(6, 5, 2, 2, INK);
  f.rect(9, 5, 2, 2, INK);
  f.px(8, 7, INK);
  // Teeth: two gaps in the jaw, which is all there is room for.
  f.px(7, 10, INK);
  f.px(9, 10, INK);

  return f.blit(p), p;
}

export const PROPS = {
  skull: pSkull,
  crate: pCrate,
  barrel: pBarrel,
  locker: pLocker,
  bunk: pBunk,
  terminal: pTerminal,
  plant: pPlant,
  toolboard: pToolboard,
  lamp: pLamp,
  spool: pSpool,
  fan: pFan,
  shelf: pShelf,
  gurney: pGurney,
  weaponrack: pWeaponrack,
  orecart: pOrecart,
};

export default {
  PAL, tone, toxic,
  SKYLINE_W, SKYLINE_H, TILE, PROP_SIZE, THREAT_SIZES,
  drawSkyline, drawWallTile, drawRockTile, drawShaftTile,
  TILES, THREATS, PROPS, WALL_PROPS, THREAT_FOR_ENEMY,
};

/* ============================================================= self-test == */
/*
 * Everything below runs only from `node tools/art/scenery.mjs` and proves the
 * four claims the rest of the file makes. It is deliberately measurement
 * rather than eyeballing: none of these are things a human notices reliably in
 * a 32px sprite, and all of them are things that break silently.
 */

/**
 * Palette law, per pixel. Legal colours are exactly the convex hull of
 * (palette entry, black, bone) — shade() interpolates a palette entry toward
 * black or toward bone, and shading an already-shaded colour stays inside that
 * triangle. So: least-squares solve c = s*entry + t*bone for every entry and
 * accept if some entry gives a small residual with s,t >= 0 and s+t <= 1.
 */
function fitTriangle(c, b) {
  const w = PAL.bone;
  const bb = b[0] * b[0] + b[1] * b[1] + b[2] * b[2];
  const ww = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
  const bw = b[0] * w[0] + b[1] * w[1] + b[2] * w[2];
  const bc = b[0] * c[0] + b[1] * c[1] + b[2] * c[2];
  const wc = w[0] * c[0] + w[1] * c[1] + w[2] * c[2];
  const det = bb * ww - bw * bw;
  if (Math.abs(det) < 1e-6) return null;
  const s = (bc * ww - wc * bw) / det;
  const t = (bb * wc - bw * bc) / det;
  let res = 0;
  for (let i = 0; i < 3; i++) res += Math.abs(s * b[i] + t * w[i] - c[i]);
  return { s, t, res };
}

export function legalColour(c) {
  for (const k of Object.keys(PAL)) {
    const f = fitTriangle(c, PAL[k]);
    if (!f) continue;
    if (f.res <= 2.6 && f.s >= -0.03 && f.t >= -0.03 && f.s + f.t <= 1.03) return k;
  }
  return null;
}

/** Toxin-family by hue AND by hull position, so greys cannot false-positive. */
export function toxinish(c) {
  if (!(c[1] > c[0] + 2 && c[0] > c[2] + 8)) return false;
  const f = fitTriangle(c, PAL.toxin);
  return !!f && f.res <= 2.6 && f.s >= 0.15 && f.s <= 1.03 && f.t >= -0.03 && f.s + f.t <= 1.03;
}

function readPixel(px, size, at, x, y) {
  const i = ((at.y + y) * size + (at.x + x)) * 4;
  return [px[i], px[i + 1], px[i + 2], px[i + 3]];
}

/**
 * Seam continuity. Mean absolute RGBA difference between adjacent columns
 * inside the tile versus between the last column and the first — the pair that
 * becomes adjacent once the tile repeats. The wrap join has to be no bigger a
 * jump than the worst honest join inside the tile, which is the property a
 * viewer actually perceives. Equality of the edge columns is NOT wanted: that
 * would be a duplicated column, visible as a doubling every 32px.
 */
function seamReport(px, size, at) {
  const { w, h } = at;
  const colDiff = (a, b) => {
    let s = 0;
    for (let y = 0; y < h; y++) {
      const p1 = readPixel(px, size, at, a, y), p2 = readPixel(px, size, at, b, y);
      for (let k = 0; k < 4; k++) s += Math.abs(p1[k] - p2[k]);
    }
    return s / (h * 4);
  };
  const rowDiff = (a, b) => {
    let s = 0;
    for (let x = 0; x < w; x++) {
      const p1 = readPixel(px, size, at, x, a), p2 = readPixel(px, size, at, x, b);
      for (let k = 0; k < 4; k++) s += Math.abs(p1[k] - p2[k]);
    }
    return s / (w * 4);
  };
  let colMax = 0, colSum = 0;
  for (let x = 0; x < w - 1; x++) { const d = colDiff(x, x + 1); colMax = Math.max(colMax, d); colSum += d; }
  let rowMax = 0, rowSum = 0;
  for (let y = 0; y < h - 1; y++) { const d = rowDiff(y, y + 1); rowMax = Math.max(rowMax, d); rowSum += d; }
  return {
    colWrap: colDiff(w - 1, 0), colMax, colMean: colSum / (w - 1),
    rowWrap: rowDiff(h - 1, 0), rowMax, rowMean: rowSum / (h - 1),
  };
}

/**
 * Silhouette hash: a GRID x GRID occupancy map of the alpha channel, one bit
 * per cell, cell set when it is MAJORITY opaque.
 *
 * Both numbers were tuned against the art rather than guessed. At an 8x8 grid
 * a 16px sprite gets 2x2 pixels per cell, and since the keyline fattens every
 * figure by a pixel in all directions, every humanoid collapses to the same
 * filled blob — that measures the metric, not the art. At 12x12 with a
 * majority fill the interior gaps that make a figure read as a figure (the ink
 * between an arm and a torso, the space under a raised weapon) survive
 * downsampling, which is exactly the information a player uses.
 */
/**
 * Cell pitch for the silhouette hash, in source pixels — NOT a grid count.
 *
 * Both numbers below were tuned against the art rather than guessed. At two
 * pixels per cell a 16px sprite gets an 8x8 map, and since the keyline fattens
 * every figure by a pixel in all directions, every humanoid collapses to the
 * same filled blob — that measures the metric, not the art. At four thirds of
 * a pixel per cell with a majority fill, the interior gaps that make a figure
 * read as a figure (the ink between an arm and a torso, the space under a
 * raised weapon) survive downsampling, which is exactly the information a
 * player uses.
 *
 * It has to be a PITCH and not a grid count because the sprites are padded
 * into a common field before hashing. A fixed 12x12 grid over a 32px field
 * gives a 16px sprite six cells across — coarser than the metric was ever
 * validated at, and coarse enough that two quite different 16px threats came
 * out three bits apart. Holding the pitch constant holds the sampling density
 * constant no matter what the field is.
 */
const SIL_PITCH = 16 / 12;
const SIL_FILL = 0.5;
const silGrid = (field) => Math.round(field / SIL_PITCH);
/**
 * What counts as no seam: the wrap transition must be no bigger a jump than
 * the worst honest transition inside the tile, or a healthy multiple of the
 * typical one, whichever is kinder to the tile.
 *
 * This used to carry a 15% margin on the max term, and the rock tile passed
 * ONLY because of it — 26.3 against a worst interior pair of 25.3, i.e. the
 * wrap join was the single most contrasty transition in the whole tile, which
 * is exactly the condition the strict test exists to catch. Fitting the
 * criterion to the artefact is not a test. The margin is gone; the rock tile
 * was fixed instead, by sliding the site field so the join does not fall along
 * a facet boundary, and every tile now clears the strict bar several times
 * over. The margins are printed so a regression is visible before it fails.
 *
 * A REAL seam is not a few percent over: an edge that does not wrap puts
 * unrelated pixels next to each other and lands multiples above both terms.
 * The probe at the bottom of this file demonstrates that on a broken tile.
 */
const seamBar = (max, mean) => Math.max(max, mean * 2.2);

/**
 * Silhouette hash, on a COMMON PIXEL FIELD.
 *
 * Every sprite is padded into a `field` x `field` box, bottom-aligned on the
 * shared floor line and centred, before the grid is laid over it. Hashing each
 * sprite inside its own bounding box throws away scale, which is the single
 * strongest distinctiveness cue this set has: it scored a 16px husk against a
 * 32px alpha as though they were the same creature, ranked an emaciated stick
 * figure and a sphere as the closest pair in the roster, and had nothing to
 * say about the pair a player actually confuses. Padded, a small sprite and a
 * large one differ by all the area neither of them occupies, which is what a
 * player sees.
 */
function silhouette(px, size, at, field) {
  const ox = Math.floor((field - at.w) / 2), oy = field - at.h;
  const bits = [];
  const G = silGrid(field);
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      let on = 0, n = 0;
      const x0 = Math.floor(gx * field / G), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * field / G));
      const y0 = Math.floor(gy * field / G), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * field / G));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          n++;
          const sx = x - ox, sy = y - oy;
          if (sx < 0 || sy < 0 || sx >= at.w || sy >= at.h) continue;
          if (readPixel(px, size, at, sx, sy)[3] > 127) on++;
        }
      }
      bits.push(on / n > SIL_FILL ? 1 : 0);
    }
  }
  return bits;
}

/** Lowest row carrying any opaque pixel, or -1. The props' shared floor line. */
function lowestRow(px, size, at) {
  for (let y = at.h - 1; y >= 0; y--) {
    for (let x = 0; x < at.w; x++) if (readPixel(px, size, at, x, y)[3] > 127) return y;
  }
  return -1;
}

const hamming = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

function frameStats(px, size, at) {
  let painted = 0, opaque = 0, toxin = 0, illegal = 0, badAlpha = 0;
  let firstBad = null;
  for (let y = 0; y < at.h; y++) {
    for (let x = 0; x < at.w; x++) {
      const c = readPixel(px, size, at, x, y);
      if (c[3] !== 0 && c[3] !== 255) badAlpha++;
      if (c[3] === 0) continue;
      painted++;
      if (c[3] === 255) opaque++;
      if (toxinish(c)) toxin++;
      if (!legalColour(c)) { illegal++; if (!firstBad) firstBad = { x, y, c }; }
    }
  }
  return { painted, opaque, toxin, illegal, badAlpha, firstBad, total: at.w * at.h };
}

/**
 * The border may carry the keyline — that is where a figure drawn to row 1 is
 * supposed to put it — but it must never carry body colour, because a body
 * pixel on the edge is a form whose outline ran off the sprite.
 */
function borderLeak(px, size, at) {
  let n = 0;
  const bad = (x, y) => {
    const c = readPixel(px, size, at, x, y);
    if (!c[3]) return;
    if (c[0] === INK[0] && c[1] === INK[1] && c[2] === INK[2]) return;
    n++;
  };
  for (let x = 0; x < at.w; x++) { bad(x, 0); bad(x, at.h - 1); }
  for (let y = 1; y < at.h - 1; y++) { bad(0, y); bad(at.w - 1, y); }
  return n;
}

const TOXIN_OK = new Set(['env_skyline', 'threat_bloater', 'threat_broodmother']);

async function runSelfTest() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  }));

  const sheet = atlas(512);
  const problems = [];
  const rows = [];
  const built = [];

  const add = (name, w, h, fn, kind) => {
    const p = sheet.sprite(name, w, h);
    fn(p, name);
    built.push({ name, kind, at: sheet.frames[name] });
  };

  add('env_skyline', SKYLINE_W, SKYLINE_H, drawSkyline, 'scene');
  for (const [k, fn] of Object.entries(TILES)) add(`env_${k}`, TILE, TILE, fn, 'tile');
  for (const [k, fn] of Object.entries(THREATS)) {
    const s = THREAT_SIZES[k];
    if (!s) { problems.push(`threat ${k}: no entry in THREAT_SIZES`); continue; }
    add(`threat_${k}`, s, s, fn, 'threat');
  }
  for (const [k, fn] of Object.entries(PROPS)) add(`prop_${k}`, PROP_SIZE, PROP_SIZE, fn, 'prop');

  for (const k of Object.keys(THREAT_SIZES)) {
    if (!THREATS[k]) problems.push(`THREAT_SIZES has "${k}" with no draw function`);
  }

  // --- per frame ----------------------------------------------------------
  for (const b of built) {
    const st = frameStats(sheet.px, sheet.size, b.at);
    const cover = st.painted / st.total;
    if (st.painted === 0) problems.push(`${b.name}: nothing drawn`);
    if (st.badAlpha) problems.push(`${b.name}: ${st.badAlpha}px are partially transparent — no alpha blending allowed`);
    if (st.illegal) {
      const f = st.firstBad;
      problems.push(`${b.name}: ${st.illegal}px off palette, first at ${f.x},${f.y} = rgb(${f.c.slice(0, 3)})`);
    }
    if (st.toxin && !TOXIN_OK.has(b.name)) problems.push(`${b.name}: ${st.toxin}px of toxin green outside the sky and the bloater`);
    if ((b.kind === 'scene' || b.kind === 'tile') && st.opaque !== st.total) {
      problems.push(`${b.name}: ${st.total - st.opaque}px not opaque — backdrops and tiles must be solid`);
    }
    if ((b.kind === 'threat' || b.kind === 'prop')) {
      if (cover > 0.86) problems.push(`${b.name}: ${(cover * 100) | 0}% covered — silhouette has no air around it`);
      if (cover < 0.16) problems.push(`${b.name}: ${(cover * 100) | 0}% covered — too little to read`);
      const bt = borderLeak(sheet.px, sheet.size, b.at);
      if (bt) problems.push(`${b.name}: ${bt}px of body colour on the sprite border — the keyline ran off the edge`);
    }
    // The shared floor line, asserted rather than described. The props section
    // has always claimed every prop stands on row 14 with its keyline on row
    // 15; two of them did not, and nothing checked, so a genuine regression
    // would have been invisible. Wall-mounted props are a real exception and
    // are named, not hand-waved: they hang from row 1 instead.
    if (b.kind === 'prop') {
      const key = b.name.slice(5);
      const low = lowestRow(sheet.px, sheet.size, b.at);
      if (WALL_PROPS.has(key)) {
        const high = (() => {
          for (let y = 0; y < b.at.h; y++) {
            for (let x = 0; x < b.at.w; x++) if (readPixel(sheet.px, sheet.size, b.at, x, y)[3] > 127) return y;
          }
          return -1;
        })();
        if (high !== 0) problems.push(`${b.name}: wall prop hangs from row ${high}, not row 0`);
      } else if (low !== PROP_SIZE - 1) {
        problems.push(`${b.name}: floor line broken — lowest painted row is ${low}, must be ${PROP_SIZE - 1}`);
      }
    }
    rows.push({ name: b.name, kind: b.kind, w: b.at.w, h: b.at.h, cover, toxin: st.toxin });
  }

  // --- seams --------------------------------------------------------------
  const seamRows = [];
  for (const b of built.filter((x) => x.kind === 'tile')) {
    const s = seamReport(sheet.px, sheet.size, b.at);
    seamRows.push({ name: b.name, ...s });
    if (s.colWrap > seamBar(s.colMax, s.colMean)) {
      problems.push(`${b.name}: vertical seam — wrap column jump ${s.colWrap.toFixed(1)} over bar ${seamBar(s.colMax, s.colMean).toFixed(1)}`);
    }
    if (s.rowWrap > seamBar(s.rowMax, s.rowMean)) {
      problems.push(`${b.name}: horizontal seam — wrap row jump ${s.rowWrap.toFixed(1)} over bar ${seamBar(s.rowMax, s.rowMean).toFixed(1)}`);
    }
  }
  // The skyline repeats horizontally too, so it gets the column half of the test.
  {
    const b = built.find((x) => x.name === 'env_skyline');
    const s = seamReport(sheet.px, sheet.size, b.at);
    seamRows.push({ name: b.name, ...s, rowWrap: NaN, rowMax: NaN, rowMean: NaN });
    if (s.colWrap > seamBar(s.colMax, s.colMean)) {
      problems.push(`env_skyline: vertical seam — wrap column jump ${s.colWrap.toFixed(1)} over bar ${seamBar(s.colMax, s.colMean).toFixed(1)}`);
    }
  }

  // A seam test that never fails proves nothing, so prove it can. This builds
  // a tile that is textured exactly like a real one but whose x axis runs edge
  // to edge without meeting itself, and requires the detector to fire on that
  // axis and stay quiet on the y axis, which does wrap. It gets its OWN atlas:
  // allocated on the sheet under test it left a 32x32 gradient block and a
  // shelf advance behind, because deleting the frames entry does not delete
  // the pixels, and the row count reported below counted them.
  {
    const scratch = atlas(TILE * 2);
    const probe = scratch.sprite('__seam_probe', TILE, TILE);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) probe.set(x, y, shade(PAL.concrete, -0.5 + (x / (TILE - 1)) * 0.9));
    }
    const s = seamReport(scratch.px, scratch.size, scratch.frames.__seam_probe);
    const bar = seamBar(s.colMax, s.colMean);
    if (!(s.colWrap > bar)) problems.push(`seam detector is blind: a non-wrapping tile passed (${s.colWrap.toFixed(1)} vs bar ${bar.toFixed(1)})`);
    if (s.rowWrap > seamBar(s.rowMax, s.rowMean)) problems.push('seam detector is trigger-happy: it flagged an axis that does wrap');
    console.log(`\n  [detector]  non-wrapping probe: wrap ${s.colWrap.toFixed(1)} vs bar ${bar.toFixed(1)} ` +
      `(${(s.colWrap / Math.max(bar, 0.01)).toFixed(0)}x over) — caught`);
  }

  // --- silhouettes --------------------------------------------------------
  // Threats AND props. The props are all 16x16, all share a baseline and are
  // all built from the same slab(), which is precisely the situation this test
  // exists for — and they were never in it, so three pairs shipped below the
  // bar the threats were held to. Compared within kind, on the kind's own
  // pixel field, because a 16px prop and a 32px threat are never on screen
  // together in a way that could confuse them.
  const SIL_MIN = 12;
  const closest = {};
  for (const kind of ['threat', 'prop']) {
    const group = built.filter((b) => b.kind === kind);
    const field = Math.max(...group.map((b) => Math.max(b.at.w, b.at.h)));
    const sigs = group.map((b) => ({ name: b.name, sig: silhouette(sheet.px, sheet.size, b.at, field) }));
    let worst = { d: 999, a: '', b: '' };
    for (let i = 0; i < sigs.length; i++) {
      for (let j = i + 1; j < sigs.length; j++) {
        const d = hamming(sigs[i].sig, sigs[j].sig);
        if (d < worst.d) worst = { d, a: sigs[i].name, b: sigs[j].name };
      }
    }
    closest[kind] = worst;
    closest[kind].cells = silGrid(field) ** 2;
    if (worst.d < SIL_MIN) {
      problems.push(`${kind}s: ${worst.a} and ${worst.b} share a silhouette (${worst.d}/${closest[kind].cells} bits differ, need ${SIL_MIN})`);
    }
  }

  // --- report -------------------------------------------------------------
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`scenery.mjs — ${built.length} frames\n`);
  let kind = null;
  for (const r of rows) {
    if (r.kind !== kind) { kind = r.kind; console.log(`  [${kind}]`); }
    console.log(`    ${pad(r.name, 22)} ${pad(`${r.w}x${r.h}`, 8)} cover ${pad(`${Math.round(r.cover * 100)}%`, 5)}` +
      (r.toxin ? `  toxin ${r.toxin}px` : ''));
  }
  console.log('\n  [seams]  wrap vs bar (margin = how far under the bar; under 1.0x is a pass)');
  for (const s of seamRows) {
    const cb = seamBar(s.colMax, s.colMean);
    const rb = seamBar(s.rowMax, s.rowMean);
    console.log(`    ${pad(s.name, 22)} cols ${pad(s.colWrap.toFixed(1), 5)}/${pad(cb.toFixed(1), 5)} = ${pad((s.colWrap / cb).toFixed(2) + 'x', 6)}` +
      (Number.isNaN(s.rowWrap) ? '  rows n/a' : `  rows ${pad(s.rowWrap.toFixed(1), 5)}/${pad(rb.toFixed(1), 5)} = ${(s.rowWrap / rb).toFixed(2)}x`));
  }
  console.log(`\n  [silhouettes]  closest threat pair ${closest.threat.a} / ${closest.threat.b} at ${closest.threat.d}/${closest.threat.cells} bits`);
  console.log(`                 closest prop pair   ${closest.prop.a} / ${closest.prop.b} at ${closest.prop.d}/${closest.prop.cells} bits`);
  // Every entry of USED, not just the ones that happened to reach a pixel.
  // The old line claimed "all inside the PAL hull" for a set nothing had
  // tested — the real proof was frameStats, which reads pixels, and a tone
  // requested but never painted was never checked at all.
  const strays = [...USED].filter(([k]) => !legalColour(k.split(',').map(Number)));
  if (strays.length) problems.push(`palette: ${strays.length} requested tone(s) outside the PAL hull, first ${strays[0][1]} = rgb(${strays[0][0]})`);
  console.log(`  [palette]      ${USED.size} distinct tones requested, every one checked against the PAL hull`);
  console.log(`  [atlas]        ${sheet.usedHeight}/${sheet.size} rows used`);

  if (args.out) await contactSheet(sheet, built, String(args.out), Number(args.zoom ?? 4));

  if (problems.length) {
    console.log(`\n  ${problems.length} PROBLEM(S):`);
    for (const m of problems) console.log(`    - ${m}`);
    process.exitCode = 1;
  } else {
    console.log(`\n  ok — ${built.length} frames, palette law upheld, all tiles seamless, all threats distinct`);
  }
}

/* ---------------------------------------------------- contact sheet PNG -- */

/** Minimal PNG encoder. Same shape as the one in tools/gen-atlas.mjs. */
async function writePng(path, w, h, rgba) {
  const { deflateSync } = await import('node:zlib');
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc32 = (b) => {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ table[(c ^ b[i]) & 0xff];
    return (c ^ -1) >>> 0;
  };
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
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, png);
}

/**
 * Lay every frame out magnified on a dark checker, with the three tiles shown
 * as 2x2 repeats — the only arrangement in which a seam is actually visible.
 */
async function contactSheet(sheet, built, out, zoom) {
  const scene = built.find((b) => b.name === 'env_skyline');
  const tiles = built.filter((b) => b.kind === 'tile');
  const threats = built.filter((b) => b.kind === 'threat');
  const props = built.filter((b) => b.kind === 'prop');
  const PADX = 8;

  const skyZ = 2, tileZ = 3;
  const skyH = scene.at.h * skyZ;
  const tileBlock = TILE * 2 * tileZ;
  const threatH = 32 * zoom;
  const propH = PROP_SIZE * zoom;
  const W = Math.max(scene.at.w * skyZ + PADX * 2, tiles.length * (tileBlock + PADX) + PADX);
  // Rows needed once each strip wraps at the sheet width.
  const rowsFor = (items, wOf) => {
    let rows = 1, x = PADX;
    for (const b of items) { if (x + wOf(b) > W) { rows++; x = PADX; } x += wOf(b) + PADX; }
    return rows;
  };
  const threatRows = rowsFor(threats, (b) => b.at.w * zoom);
  const propRows = rowsFor(props, () => PROP_SIZE * zoom);
  const H = PADX * (4 + threatRows + propRows) + skyH + tileBlock
    + threatH * threatRows + propH * propRows;
  const buf = new Uint8Array(W * H * 4);

  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H || !c) return;
    const i = (y * W + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    put(x, y, ((x >> 3) + (y >> 3)) & 1 ? [26, 28, 30] : [20, 22, 24]);
  }
  const stamp = (b, ox, oy, z, tx = 1, ty = 1) => {
    for (let ry = 0; ry < b.at.h * ty; ry++) {
      for (let rx = 0; rx < b.at.w * tx; rx++) {
        const c = readPixel(sheet.px, sheet.size, b.at, rx % b.at.w, ry % b.at.h);
        if (!c[3]) continue;
        for (let j = 0; j < z; j++) for (let i = 0; i < z; i++) put(ox + rx * z + i, oy + ry * z + j, c);
      }
    }
  };

  let y = PADX;
  stamp(scene, PADX, y, skyZ);
  y += skyH + PADX;
  tiles.forEach((b, i) => stamp(b, PADX + i * (tileBlock + PADX), y, tileZ, 2, 2));
  y += tileBlock + PADX;
  let x = PADX;
  for (const b of threats) {
    if (x + b.at.w * zoom > W) { x = PADX; y += threatH + PADX; }
    stamp(b, x, y + (32 - b.at.h) * zoom, zoom);   // stand them on a shared baseline
    x += b.at.w * zoom + PADX;
  }
  y += threatH + PADX;
  x = PADX;
  for (const b of props) {
    if (x + PROP_SIZE * zoom > W) { x = PADX; y += propH + PADX; }
    stamp(b, x, y, zoom);
    x += PROP_SIZE * zoom + PADX;
  }

  await writePng(out, W, H, buf);
  console.log(`\n  contact sheet -> ${out} (${W}x${H})`);
  console.log(`  order: skyline | ${tiles.map((b) => b.name.slice(4)).join(' ')} | ` +
    `${threats.map((b) => b.name.slice(7)).join(' ')} | ${props.map((b) => b.name.slice(5)).join(' ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await runSelfTest();

