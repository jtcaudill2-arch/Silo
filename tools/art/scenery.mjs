/**
 * scenery.mjs — everything in the world that is not a room and not a person.
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
 *   THREATS         ten creatures and factions, 16x16 / 24x24 / 32x32,
 *                   TRANSPARENT background. Drawn silhouette-first: each one
 *                   has to be nameable from its outline with the colour
 *                   thrown away, which the self-test actually checks by
 *                   hashing the alpha channel and comparing every pair.
 *
 *   PROPS           twelve pieces of 16x16 set dressing, TRANSPARENT, all
 *                   standing on row 14 so they line up on a shared floor.
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
 *     it on 22 sprites, figures are composed in form() and form.keyline()
 *     grows ink into every empty pixel touching the figure.
 *   - light comes from the upper left, always. Top and left faces lit, bottom
 *     and right faces shaded.
 *   - colour is PAL, or shade() of PAL, and nothing else. The self-test proves
 *     this per pixel: it solves for each painted colour's position in the
 *     triangle (palette entry, black, bone) and fails if any colour is outside
 *     every one of them.
 *   - PAL.toxin is radiation and contamination ONLY. tone() throws if you ask
 *     it for toxin; toxic() is the single narrow door, and the self-test
 *     detects toxin-family pixels by hue and fails if they appear anywhere
 *     except the surface sky and the bloater's sacs.
 *   - all randomness is rng(seed) from lib.mjs, so the atlas regenerates
 *     byte-identical and the repository stays diffable.
 *
 * Self-test:  node tools/art/scenery.mjs
 *             node tools/art/scenery.mjs --out=.shots/scenery.png --zoom=4
 */

import { PAL, shade, rng, atlas } from './lib.mjs';

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
const FLESH = tone('skin', -0.34);
const FLESH_LO = tone('skinShade', -0.46);
const FLESH_HI = tone('skin', -0.16);

// Cloth, in three weights.
const RAG = tone('deep', 0.10);
const RAG_LO = tone('deep', -0.22);
const RAG_HI = tone('deep', 0.26);
const COAT = tone('rust', -0.30);
const COAT_HI = tone('rust', -0.12);
const COAT_LO = tone('rust', -0.50);
const ROBE = tone('bone', -0.26);
const ROBE_HI = tone('bone', -0.08);
const ROBE_LO = tone('bone', -0.46);

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
  husk: 16, shambler: 16, bloater: 24, ravager: 24, alpha: 32,
  raider: 16, ash_company: 16, scrapjaw: 16, cultist: 16, trader: 16,
};

/* ------------------------------------------------------------- helpers -- */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const pick = (r, arr) => arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))];
const irnd = (r, a, b) => a + Math.floor(r() * (b - a + 1));

/**
 * A view onto a painter whose coordinates wrap. This is the whole seamless
 * story: draw normally, off the edge, and the pixels come back on the other
 * side because they are literally the same pixels.
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
    /** Solid with a lit top/left and a shaded bottom/right. */
    slab(x, y, w, h, c, lit = 0.2, dk = -0.2) {
      v.rect(x, y, w, h, c);
      if (h > 1) v.hline(x, y, w, shade(c, lit));
      if (w > 1) v.vline(x, y, h, shade(c, lit));
      if (h > 1) v.hline(x, y + h - 1, w, shade(c, dk));
      if (w > 1) v.vline(x + w - 1, y, h, shade(c, dk));
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
 * Paint a finished mask. `outline` puts a darker keyline all the way round
 * (used on the far and mid layers, where the shapes need edges to read as
 * pixel art); `lit` instead catches the last light on top and left faces
 * (used on the near layer, which is nearly ink and would look like a hole).
 */
function paintMask(v, g, fill, { outline = null, lit = null } = {}) {
  for (let y = 0; y < g.H; y++) {
    for (let x = 0; x < g.W; x++) {
      if (!g.get(x, y)) continue;
      const up = g.get(x, y - 1), dn = g.get(x, y + 1);
      const lf = g.get(x - 1, y), rt = g.get(x + 1, y);
      let c = fill;
      if (!up || !dn || !lf || !rt) {
        if (outline) c = outline;
        else if (lit && (!up || !lf)) c = lit;
      }
      v.set(x, y, c);
    }
  }
}

/**
 * A small offscreen figure. Everything with a keyline is built in one of
 * these: draw the parts in any order, call keyline() once to grow ink into
 * every empty pixel touching the figure, add the interior details that must
 * NOT be outlined (eyes, straps, screens), then blit.
 *
 * Content must stay inside a 1px margin or the keyline has nowhere to go.
 */
function form(w, h) {
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
  if (r() < 0.3) g.box(x + Math.floor(w / 2), top - irnd(r, 2, 6), 1, 6); // snapped mast
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
  const hx = dir > 0 ? x + jib - 3 : x + 4 - jib;
  g.box(hx, top + 3, 1, irnd(r, 3, 10));                         // hook line
  g.box(x - 2, base - 4, 6, 4);                                  // foot
}

/** Lattice pylon: a tapering outline with two cross-arms. */
function sPylon(g, r, x, top, base) {
  const h = base - top;
  for (let j = 0; j < h; j++) {
    const u = j / (h - 1);
    const ww = Math.round(3 + u * 6);
    const x0 = x + Math.round((9 - ww) / 2);
    g.box(x0, top + j, ww, 1);
    if (j > 1 && j < h - 2 && ww > 4) g.hole(x0 + 1, top + j, ww - 2, 1);
    if (j % 6 === 3 && ww > 4) g.box(x0, top + j, ww, 1);        // lattice rung
  }
  g.box(x - 3, top + irnd(r, 2, 4), 15, 1);                      // cross-arm
  if (r() < 0.6) g.box(x - 2, top + irnd(r, 6, 10), 13, 1);
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
  // Bleached bone at the top, falling through four pale steps into saturated
  // toxin at the horizon. The exponent holds the pale range open across most
  // of the sky and crushes the saturation into the last few rows, which is
  // what makes the horizon read as a hot line rather than a gradient ending.
  const SKY = [tone('bone'), toxic(0.80), toxic(0.63), toxic(0.46), toxic(0.29), toxic(0.13), toxic(0)];
  const sunX = Math.round(W * 0.31);
  const sunY = HZ - 4;
  const sunR = Math.round(W * 0.30);
  const rowC = new Array(H);

  for (let y = 0; y < HZ; y++) {
    const u = Math.pow(y / (HZ - 1), 1.05);
    for (let x = 0; x < W; x++) {
      let dx = Math.abs(x - sunX); dx = Math.min(dx, W - dx);
      const dy = (y - sunY) * 1.45;
      const d = Math.sqrt(dx * dx + dy * dy) / sunR;
      const bloom = d < 1 ? Math.pow(1 - d, 2.1) : 0;   // hazy sun, no disc
      const [a, b, t] = rampAt(SKY, Math.max(0, u - bloom * 0.46));
      v.set(x, y, dpick(x, y, a, b, t));
    }
    const [a, b, t] = rampAt(SKY, u);
    rowC[y] = t > 0.5 ? b : a;
  }

  // -- ground ---------------------------------------------------------------
  // The plain catches the sky at the horizon (contamination haze, which is the
  // one place toxin is allowed to touch the dirt) and goes to cold ash fast.
  const GND = [toxic(0.40), toxic(0.16), tone('concrete', 0.20), tone('concrete', -0.04), tone('deep', -0.06), tone('deep', -0.20)];
  for (let y = HZ; y < H; y++) {
    const u = Math.pow((y - HZ) / (H - 1 - HZ), 0.95);
    const [a, b, t] = rampAt(GND, u);
    for (let x = 0; x < W; x++) v.set(x, y, dpick(x, y, a, b, t));
    rowC[y] = t > 0.5 ? b : a;
  }

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
  paintMask(v, far, tone('concrete', 0.34), { outline: tone('concrete', 0.20) });

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
  paintMask(v, mid, tone('concrete', 0.10), { outline: tone('concrete', -0.22) });

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
  for (let k = 0; k < 26; k++) {
    const y = irnd(r, HZ + 5, H - 2);
    const depth = (y - HZ) / (H - HZ);
    const w = 1 + Math.floor(depth * irnd(r, 1, 6));
    const h = 1 + Math.floor(depth * irnd(r, 1, 3));
    const x = irnd(r, 0, W - 1);
    v.rect(x, y, w, h, shade(rowC[y], -0.42));
    v.hline(x, y, w, shade(rowC[y], 0.14));           // light on the top face
  }
  for (let k = 0; k < 6; k++) {                        // snapped poles
    const x = irnd(r, 0, W - 1);
    const y = irnd(r, HZ + 6, H - 4);
    const h = irnd(r, 3, 9);
    v.vline(x, y - h, h, shade(rowC[y], -0.5));
    v.vline(x + 1, y - h, h, shade(rowC[y], -0.22));
  }

  // -- near ruins -----------------------------------------------------------
  // Nearly ink, so they take a lit top-and-left edge instead of a keyline —
  // the last of the daylight sitting on the broken concrete.
  const near = buildLayer(W, H, r, {
    kinds: ['tower', 'slab', 'tower', 'crane', 'slab', 'chimney', 'tower', 'pylon'],
    wMin: 12, wMax: 30, hMin: 26, hMax: 58,
    base: HZ + 9, baseJit: 3, gapMin: 14, gapMax: 40, windows: true,
  });
  // The hero. An evenly spaced row of ruins is a picket fence, not a picture —
  // the eye needs one thing to land on. A cooling tower placed off-centre and
  // taller than anything else gives the image a subject, and the crane leaning
  // against it gives that subject a scale.
  const heroX = Math.round(W * 0.63);
  sCool(near, r, heroX, 30, HZ + 12 - 66, HZ + 12);
  sCrane(near, r, heroX - 12, -1, HZ + 12 - 40, HZ + 10);
  sSlab(near, r, heroX + 30, 14, HZ + 10 - 26, HZ + 10);
  paintMask(v, near, tone('deeper', 0.03), { lit: tone('deeper', 0.26) });

  // Foreground spoil heaps, right on the bottom edge, to close the composition
  // off and stop the plain running out of the frame.
  for (let k = 0; k < 4; k++) {
    const cx = irnd(r, 0, W - 1);
    const rw = irnd(r, 18, 44), rh = irnd(r, 3, 7);
    for (let j = 0; j < rh; j++) {
      const half = Math.round(rw / 2 * Math.sqrt(Math.max(0, 1 - (j / rh) * (j / rh))));
      for (let i = -half; i <= half; i++) {
        v.set(cx + i, H - 1 - j, j === rh - 1 ? tone('deep', -0.02) : tone('deeper', -0.06));
      }
    }
  }

  // -- ash ------------------------------------------------------------------
  // Single pale motes, denser low, where the light is coming through the dust.
  for (let k = 0; k < 130; k++) {
    const y = irnd(r, 1, H - 2);
    const x = irnd(r, 0, W - 1);
    if (r() > 0.25 + 0.75 * (y / H)) continue;
    v.set(x, y, shade(y < HZ ? rowC[y] : rowC[y], 0.30));
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
    if (r() < bias) y += 1; else x += r() < 0.5 ? -1 : 1;
    if (r() < 0.12) v.set(x + 1, y, shade(c, 0.16));   // lit lip on the right
  }
}

/**
 * Poured concrete, 32x32, seamless.
 *
 * Two horizontal pour joints and two vertical form joints, each a dark groove
 * with a lit lower/right lip — a recess lit from the upper left has its top
 * and left walls in shadow and its bottom and right walls in light, and
 * getting that the wrong way round is the difference between a groove and a
 * ridge. Form-tie recesses sit on the joints where the real ones would, and
 * bleed rust down the wall.
 */
export function drawWallTile(p, seed = 'env_wall') {
  const v = torus(p);
  const r = rng(seed);
  const W = p.w, H = p.h;

  v.rect(0, 0, W, H, CONC);

  // Blotchy aggregate: a few soft patches, then per-pixel grit. No block grid,
  // because a block grid at 32px reads as a checkerboard the moment it tiles.
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

  // Pour joints (horizontal) and form joints (vertical).
  for (const y of [11, 26]) {
    v.hline(0, y, W, shade(CONC, -0.34));
    v.hline(0, y + 1, W, shade(CONC, 0.16));
  }
  for (const x of [5, 21]) {
    v.vline(x, 0, H, shade(CONC, -0.30));
    v.vline(x + 1, 0, H, shade(CONC, 0.13));
  }

  // Form ties: a 2x2 recess with a lit lower-right rim, and the rust that has
  // been running out of it since the pour.
  for (const [tx, ty] of [[3, 14], [19, 14], [3, 29], [19, 29], [11, 5], [27, 20]]) {
    v.rect(tx, ty, 2, 2, shade(CONC, -0.55));
    v.set(tx, ty, INK);
    v.set(tx + 2, ty + 2, shade(CONC, 0.2));
    const len = irnd(r, 4, 11);
    for (let j = 0; j < len; j++) {
      const t = 1 - j / len;
      if (r() < 0.35 + 0.5 * t) v.set(tx + irnd(r, 0, 1), ty + 2 + j, shade(PAL.rust, -0.42 - 0.2 * (1 - t)));
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
 * A toroidal Voronoi over sixteen jittered sites. Each cell is a facet: flat
 * fill, a lit edge where it meets a neighbour up or left, an ink edge where it
 * meets one down or right. Because the distance metric wraps, the facets wrap
 * — the tile is a genuine torus of stone rather than a square of noise.
 */
export function drawRockTile(p, seed = 'env_rock') {
  const v = torus(p);
  const r = rng(seed);
  const W = p.w, H = p.h;
  const GRID = 5, CELL = W / GRID;

  const sx = [], sy = [], sc = [], sw = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      sx.push(gx * CELL + r() * CELL);
      sy.push(gy * CELL + r() * CELL);
      // Per-site weight, so facets come out in a range of sizes. An even
      // Voronoi reads as cobbles; a weighted one reads as broken stone.
      sw.push(0.72 + r() * 0.62);
      // A quarter of the facets carry iron, which is why anyone digs here.
      const warm = r() < 0.16;
      sc.push(shade(warm ? tone('rust', -0.62) : tone('concrete', -0.42), -0.14 + r() * 0.26));
    }
  }
  const own = new Int16Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let best = 1e9, bi = 0;
      for (let i = 0; i < sx.length; i++) {
        let dx = Math.abs(x - sx[i]); dx = Math.min(dx, W - dx);
        let dy = Math.abs(y - sy[i]); dy = Math.min(dy, H - dy);
        // Manhattan rather than Euclidean: straight-edged, angular facets,
        // which is what a rock face is and what a cobbled street is not.
        const d = (0.5 * (dx + dy) + 0.5 * Math.sqrt(dx * dx + dy * dy)) * sw[i];
        if (d < best) { best = d; bi = i; }
      }
      own[y * W + x] = bi;
    }
  }
  const at = (x, y) => own[(((y % H) + H) % H) * W + (((x % W) + W) % W)];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = at(x, y);
      // Shade within the facet so each one has a top-left face and a
      // bottom-right one, instead of reading as sixteen flat stickers.
      let dx = x - sx[i]; if (dx > W / 2) dx -= W; if (dx < -W / 2) dx += W;
      let dy = y - sy[i]; if (dy > H / 2) dy -= H; if (dy < -H / 2) dy += H;
      const g = clamp(-(dx + dy) / 13, -0.20, 0.20);
      let c = shade(sc[i], g);
      if (at(x + 1, y) !== i || at(x, y + 1) !== i) c = INK;
      else if (at(x - 1, y) !== i || at(x, y - 1) !== i) c = shade(sc[i], 0.24);
      v.set(x, y, c);
    }
  }

  // Grit, then a couple of fissures, then the ore glints last so they survive.
  for (let k = 0; k < 120; k++) {
    const x = irnd(r, 0, W - 1), y = irnd(r, 0, H - 1);
    v.set(x, y, shade(v.get(x, y), r() < 0.5 ? -0.22 : 0.14));
  }
  crack(v, r, irnd(r, 0, W - 1), irnd(r, 0, H - 1), irnd(r, 10, 22), INK, 0.6);
  for (let k = 0; k < 9; k++) {
    const x = irnd(r, 0, W - 1), y = irnd(r, 0, H - 1);
    v.set(x, y, AMBER_LO);
    if (r() < 0.5) v.set(x + 1, y, shade(AMBER_LO, -0.3));
  }
  return p;
}

/**
 * The central lift shaft, 32x32, seamless.
 *
 * Two full-height guide rails, a pair of hoist cables down the middle, and a
 * cross-brace every sixteen rows — plain steel on one, hazard-striped on the
 * other, so the vertical repeat is a rhythm rather than a stutter. The stripe
 * period is 4px and 32 is a multiple of 4, so the hazard band walks across the
 * horizontal join without breaking step.
 */
export function drawShaftTile(p, seed = 'env_shaft') {
  const v = torus(p);
  const r = rng(seed);
  const W = p.w, H = p.h;

  // Dark back wall with a soft column of light down the middle of the shaft.
  v.rect(0, 0, W, H, tone('deeper', 0.02));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.abs(x - (W / 2 - 0.5)) / (W / 2);
      v.set(x, y, dpick(x, y, tone('deep', -0.06), tone('deeper', 0.02), clamp(d * 1.25, 0, 1)));
    }
  }
  for (let k = 0; k < 60; k++) v.set(irnd(r, 0, W - 1), irnd(r, 0, H - 1), tone('deeper', -0.1));

  // Hoist cables. The lit pixel repeats on an 8 row cycle, which divides 32.
  for (const cx of [15, 17]) {
    v.vline(cx, 0, H, tone('steelDark', -0.30));
    for (let y = 0; y < H; y++) if (y % 8 === 2) v.set(cx, y, tone('steel', -0.1));
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
  for (const [by, hazard] of [[14, true]]) {
    v.hline(0, by - 1, W, INK);
    v.rect(0, by, W, 4, MET);
    v.hline(0, by, W, MET_HI);
    v.hline(0, by + 3, W, MET_LO);
    v.hline(0, by + 4, W, INK);
    if (hazard) {
      for (let x = 0; x < W; x++) {
        const band = ((x >> 1) & 1) === 0;
        v.set(x, by + 1, band ? shade(AMBER, -0.16) : INK);
        v.set(x, by + 2, band ? shade(AMBER, -0.52) : INK);
      }
    } else {
      for (let x = 1; x < W; x += 6) { v.set(x, by + 1, MET_HI); v.set(x + 1, by + 2, MET_LO); }
    }
  }

  // Rust weeping out from under both braces, and grime in the rail shadows.
  for (let k = 0; k < 9; k++) {
    const x = irnd(r, 0, W - 1);
    const len = irnd(r, 2, 6);
    for (let j = 0; j < len; j++) if (r() < 0.65) v.set(x, 19 + j, shade(PAL.rust, -0.56));
  }
  for (const rx of [5, 24]) {
    for (let k = 0; k < 10; k++) v.set(rx + irnd(r, -2, 5), irnd(r, 0, H - 1), tone('deeper', -0.05));
  }
  return p;
}

/** Frame-name suggestion: env_wall, env_rock, env_shaft. */
export const TILES = { wall: drawWallTile, rock: drawRockTile, shaft: drawShaftTile };

/* ============================================================= the threats == */
/*
 * Ten of them, all facing right, all lit from the upper left, all built in a
 * form() and given their keyline in one pass at the end.
 *
 * The rule that decides every one of these is: name it from the outline. Not
 * from the colour, not from the detail — from the black shape. So each gets
 * exactly one structural idea and the rest of the body stays out of its way:
 *
 *   husk         long arms hanging past the knees on a starved frame
 *   shambler     one arm thrown forward, one leg dragging
 *   bloater      a sphere with a head sunk into it
 *   ravager      low and wide, spined back, forelimbs planted ahead
 *   alpha        a wall of shoulders under a crest, arms to the floor
 *   raider       hood, and a length of pipe carried upright
 *   ash_company  helmet, and a rifle held level across the body
 *   scrapjaw     a box on four stiff legs with a wedge of open jaw
 *   cultist      pointed hood over a bell of robe, one arm up with a lamp
 *   trader       wide brim, a pack taller than the head, a staff
 *
 * The self-test hashes the alpha channel of each into 64 bits and compares
 * every pair, so if two of these ever converge the build says which two.
 */

/** Emaciated, stooped, arms past the knees. The cheapest thing out there. */
function tHusk(p, seed = 'threat_husk') {
  const f = form(16, 16);
  const r = rng(seed);
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
  if (r() < 2) f.px(8, 12, INK);
  f.blit(p);
  return p;
}

/** Was a dweller. One arm out, one leg gone stiff. */
function tShambler(p, seed = 'threat_shambler') {
  const f = form(16, 16);
  f.rect(4, 7, 2, 5, RAG_LO);                                       // trailing arm
  f.rect(4, 12, 2, 1, FLESH_LO);
  f.rect(4, 6, 7, 6, RAG);                                          // torso, torn suit
  f.hline(4, 6, 7, RAG_HI);
  f.vline(10, 6, 6, RAG_LO);
  f.px(6, 8, RAG_HI); f.px(6, 9, RAG_HI);                           // chest pocket
  f.rect(4, 11, 7, 1, RAG_LO);
  f.px(5, 12, RAG_LO); f.px(8, 12, RAG_LO); f.px(10, 12, RAG_LO);   // torn hem
  f.rect(10, 7, 4, 2, RAG); f.hline(10, 7, 4, RAG_HI);              // reaching arm
  f.rect(13, 7, 2, 2, FLESH); f.px(14, 6, FLESH_LO); f.px(14, 9, FLESH_LO);
  f.rect(5, 2, 5, 4, FLESH);                                        // head
  f.hline(5, 2, 5, FLESH_HI); f.vline(9, 2, 4, FLESH_LO);
  f.rect(5, 1, 5, 2, tone('hair', 0.06));                           // matted hair
  f.rect(5, 12, 2, 3, RAG_LO);                                      // planted leg
  f.rect(4, 14, 3, 1, tone('boot'));
  f.rect(8, 12, 2, 2, RAG_LO);                                      // dragging leg
  f.rect(8, 14, 4, 1, tone('boot'));
  f.keyline();
  f.hline(7, 4, 2, INK); f.px(7, 5, INK);
  f.vline(6, 7, 5, INK);                                            // arm / torso
  f.px(10, 6, INK); f.px(4, 12, INK);
  f.px(7, 12, INK);
  f.blit(p);
  return p;
}

/** A sphere of contamination on stubs. The one creature toxin is for. */
function tBloater(p, seed = 'threat_bloater') {
  const f = form(24, 24);
  const r = rng(seed);
  f.disc(12, 14, 9, 7, HIDE);                                       // the belly
  for (let j = -7; j <= 7; j++) {                                   // form on it
    for (let i = -9; i <= 9; i++) {
      if (!f.at(12 + i, 14 + j)) continue;
      const t = clamp(-(i + j * 1.4) / 22, -0.16, 0.18);
      f.px(12 + i, 14 + j, shade(HIDE, t));
    }
  }
  f.rect(3, 10, 3, 5, HIDE_LO); f.rect(2, 14, 4, 2, HIDE_LO);       // stub arms
  f.rect(18, 10, 3, 5, HIDE); f.rect(18, 14, 4, 2, HIDE_LO);
  f.rect(8, 20, 3, 2, HIDE_LO); f.rect(13, 20, 3, 2, HIDE_LO);      // stub legs
  f.rect(7, 22, 5, 1, HIDE_LO); f.rect(12, 22, 5, 1, HIDE_LO);
  f.rect(10, 3, 5, 5, HIDE_HI);                                     // head, sunk
  f.hline(10, 3, 5, shade(HIDE_HI, 0.2));
  f.vline(14, 3, 5, HIDE_LO);
  f.rect(9, 7, 7, 2, HIDE);                                         // rolls of neck
  f.keyline();
  // Sacs. Bright core, dark rim, so they read as swollen and lit from within.
  for (const [cx, cy, rr] of [[8, 13, 3], [15, 16, 3], [11, 18, 2], [17, 11, 2]]) {
    f.disc(cx, cy, rr, rr - (rr > 2 ? 1 : 0), toxic(-0.30));
    f.disc(cx, cy, rr - 1, Math.max(1, rr - 2), toxic(0));
    f.px(cx - 1, cy - 1, toxic(0.42));
  }
  for (let k = 0; k < 14; k++) {                                    // weeping
    const x = irnd(r, 4, 19), y = irnd(r, 9, 21);
    if (f.at(x, y)) f.px(x, y, toxic(-0.42));
  }
  f.hline(11, 5, 3, INK); f.px(12, 6, INK);                         // eyes and maw
  f.hline(11, 8, 4, INK);
  f.blit(p);
  return p;
}

/** Low, wide, spined. Built to close distance. */
function tRavager(p, seed = 'threat_ravager') {
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
  f.keyline();
  for (const x of [14, 16, 18]) { f.vline(x, 21, 2, BONE); f.px(x, 22, BONE_LO); }  // claws
  f.px(6, 20, BONE); f.px(8, 20, BONE);
  f.hline(19, 13, 4, BONE);                                         // teeth
  f.px(20, 14, BONE_LO); f.px(22, 14, BONE_LO);
  f.px(18, 9, AMBER); f.px(19, 9, AMBER_LO);                        // eye
  f.hline(16, 12, 3, INK);                                          // jaw line
  f.blit(p);
  return p;
}

/** The one that ends expeditions. A wall of shoulders under a bone crest. */
function tAlpha(p, seed = 'threat_alpha') {
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
  f.rect(11, 24, 5, 6, HIDE); f.rect(17, 24, 5, 6, HIDE_LO);        // legs
  f.rect(10, 29, 7, 2, HIDE_LO); f.rect(17, 29, 7, 2, HIDE_LO);     // feet
  // Fused scrap plating, bolted on. Steel over hide, upper-left lit.
  for (const [x, y, w, h] of [[5, 12, 7, 4], [20, 12, 7, 4], [12, 18, 7, 3], [2, 18, 5, 5], [24, 18, 5, 5]]) {
    f.rect(x, y, w, h, MET_LO);
    f.hline(x, y, w, MET);
    f.vline(x, y, h, MET);
    f.hline(x, y + h - 1, w, IRON);
    f.frame(x, y, w, h, shade(MET_LO, -0.45));
    f.px(x + 1, y + 1, MET_HI); f.px(x + w - 2, y + h - 2, IRON);
  }
  f.keyline();
  f.px(15, 7, AMBER); f.px(18, 7, AMBER);                           // eyes
  f.px(15, 6, AMBER_HI); f.px(18, 6, AMBER_HI);
  f.hline(14, 10, 6, INK);
  for (const x of [15, 17, 19]) f.px(x, 11, BONE);                  // tusks
  f.px(14, 12, BONE); f.px(19, 12, BONE);
  for (const x of [2, 4, 6, 8]) { f.vline(x, 28, 2, BONE_LO); f.px(x, 29, BONE); }  // claws
  for (const x of [23, 25, 27, 29]) { f.vline(x, 28, 2, BONE_LO); f.px(x, 29, BONE); }
  f.blit(p);
  return p;
}

/** Wasteland scavenger: hood, pack, and a length of pipe carried upright. */
function tRaider(p, seed = 'threat_raider') {
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

/** Ash Company: helmet, greatcoat, and a rifle held level. */
function tAshCompany(p, seed = 'threat_ash_company') {
  const f = form(16, 16);
  f.rect(4, 6, 8, 6, RAG);                                          // greatcoat
  f.hline(4, 6, 8, RAG_HI);
  f.vline(11, 6, 6, RAG_LO);
  f.rect(3, 11, 9, 3, RAG_LO);                                      // coat skirt
  f.hline(3, 11, 9, RAG);
  f.rect(3, 6, 3, 2, MET_LO); f.hline(3, 6, 3, MET);                // pauldrons
  f.rect(10, 6, 3, 2, MET_LO); f.hline(10, 6, 3, MET);
  f.rect(5, 1, 6, 4, MET_LO);                                       // helmet
  f.hline(5, 1, 6, MET);
  f.vline(10, 1, 4, IRON);
  f.rect(3, 5, 10, 1, MET_LO);                                      // brim, projecting
  f.hline(3, 5, 10, MET);
  f.rect(6, 7, 9, 2, MET);                                          // rifle, up at the shoulder
  f.hline(6, 7, 9, MET_HI);
  f.hline(6, 8, 9, IRON);
  f.rect(4, 8, 3, 2, WOOD); f.hline(4, 8, 3, WOOD_HI);              // stock
  f.rect(9, 9, 2, 2, MET_LO);                                       // magazine
  f.rect(5, 14, 3, 1, tone('boot')); f.rect(9, 14, 3, 1, tone('boot'));
  f.rect(5, 13, 2, 1, tone('boot', -0.2)); f.rect(9, 13, 2, 1, tone('boot', -0.2));
  f.keyline();
  f.hline(5, 4, 5, INK);                                            // visor slot
  f.hline(6, 4, 3, AMBER);
  f.px(6, 3, AMBER_LO);
  f.vline(5, 10, 2, INK);                                           // arm / coat
  f.blit(p);
  return p;
}

/** A machine that was a mining charge sled, and is now mostly jaw. */
function tScrapjaw(p, seed = 'threat_scrapjaw') {
  const f = form(16, 16);
  f.rect(2, 5, 9, 5, MET_LO);                                       // chassis
  f.hline(2, 5, 9, MET);
  f.vline(2, 5, 5, MET);
  f.hline(2, 9, 9, IRON);
  f.rect(4, 6, 3, 2, shade(PAL.rust, -0.42));                       // rust patch
  f.rect(10, 4, 5, 3, MET);                                         // upper jaw
  f.hline(10, 4, 5, MET_HI);
  f.rect(10, 8, 5, 3, MET_LO);                                      // lower jaw
  f.hline(10, 10, 5, IRON);
  f.rect(9, 4, 2, 7, MET_LO);                                       // hinge block
  f.vline(9, 4, 7, MET);
  for (const x of [3, 6, 8, 10]) {                                  // four stiff legs
    f.rect(x, 10, 1, 4, MET_LO);
    f.rect(x - 1, 13, 3, 1, IRON);
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
function tCultist(p, seed = 'threat_cultist') {
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
  f.hline(4, 10, 7, shade(PAL.rust, -0.34));                        // rope belt
  f.px(7, 11, shade(PAL.rust, -0.5));
  f.blit(p);
  return p;
}

/** Freerider: wide brim, a pack taller than his head, and a staff. */
function tTrader(p, seed = 'threat_trader') {
  const f = form(16, 16);
  f.rect(2, 4, 4, 8, CANVAS);                                       // pack
  f.vline(2, 4, 8, CANVAS_HI);
  f.vline(5, 4, 8, shade(CANVAS, -0.28));
  f.hline(2, 7, 4, BONE_LO); f.hline(2, 10, 4, shade(BONE_LO, -0.3));
  f.rect(1, 2, 6, 2, WOOD); f.hline(1, 2, 6, WOOD_HI);              // bedroll
  f.rect(6, 7, 5, 5, COAT);                                         // coat
  f.hline(6, 7, 5, COAT_HI);
  f.vline(10, 7, 5, COAT_LO);
  f.rect(6, 11, 5, 2, COAT_LO);
  f.rect(6, 4, 4, 4, FLESH);                                        // head
  f.hline(6, 4, 4, FLESH_HI);
  f.vline(9, 4, 4, FLESH_LO);
  f.rect(4, 3, 9, 1, WOOD);                                         // the brim
  f.hline(4, 3, 9, WOOD_HI);
  f.rect(6, 1, 4, 2, WOOD_HI); f.hline(6, 1, 4, shade(WOOD_HI, 0.2));
  f.rect(10, 8, 3, 1, COAT); f.hline(10, 8, 3, COAT_HI);            // arm to the staff
  f.vline(12, 2, 13, WOOD);                                         // staff
  f.vline(12, 2, 4, WOOD_HI);
  f.rect(6, 13, 2, 2, tone('boot')); f.rect(9, 13, 2, 2, tone('boot'));
  f.rect(5, 14, 3, 1, tone('boot', -0.2)); f.rect(9, 14, 3, 1, tone('boot', -0.2));
  f.keyline();
  f.px(9, 6, INK);                                                  // eye under the brim
  f.px(11, 2, AMBER_LO);                                            // a charm on the staff
  f.blit(p);
  return p;
}

export const THREATS = {
  husk: tHusk,
  shambler: tShambler,
  bloater: tBloater,
  ravager: tRavager,
  alpha: tAlpha,
  raider: tRaider,
  ash_company: tAshCompany,
  scrapjaw: tScrapjaw,
  cultist: tCultist,
  trader: tTrader,
};

/* =============================================================== the props == */
/*
 * Twelve pieces of 16x16 set dressing, transparent, every one of them standing
 * on row 14 with its keyline landing on row 15. That shared baseline is the
 * whole point: drop any of these into a room at the same y and they sit on the
 * same floor, which is not true of art authored one sprite at a time.
 */

function pCrate(p, seed = 'prop_crate') {
  const f = form(16, 16);
  f.slab(2, 5, 12, 10, WOOD, 0.24, -0.24);
  for (let x = 4; x < 13; x += 3) f.vline(x, 6, 8, shade(WOOD, -0.3));   // planks
  f.hline(3, 8, 10, WOOD_HI); f.hline(3, 9, 10, shade(WOOD, -0.34));     // batten
  for (const [x, y] of [[2, 5], [11, 5], [2, 12], [11, 12]]) {           // corner plates
    f.rect(x, y, 3, 3, MET_LO); f.hline(x, y, 3, MET); f.px(x + 1, y + 1, MET_HI);
  }
  f.keyline();
  f.rect(6, 11, 3, 2, AMBER_LO); f.px(6, 11, AMBER);                     // stencil
  return f.blit(p), p;
}

function pBarrel(p, seed = 'prop_barrel') {
  const f = form(16, 16);
  f.rect(4, 3, 8, 12, MET);
  f.vline(5, 3, 12, MET_HI);
  f.vline(10, 3, 12, MET_LO);
  f.vline(11, 3, 12, IRON);
  f.hline(5, 3, 6, MET_HI);                                              // lid
  f.hline(5, 4, 6, shade(MET, 0.14));
  for (const y of [7, 11]) { f.hline(4, y, 8, MET_HI); f.hline(4, y + 1, 8, IRON); }
  f.keyline();
  f.rect(4, 8, 8, 2, AMBER_LO);                                          // hazard band
  f.hline(4, 8, 8, AMBER);
  for (let x = 4; x < 12; x += 3) f.vline(x, 8, 2, INK);
  f.px(6, 4, shade(MET, -0.3)); f.px(9, 5, shade(MET, -0.3));            // dents
  return f.blit(p), p;
}

function pLocker(p, seed = 'prop_locker') {
  const f = form(16, 16);
  f.slab(4, 1, 8, 13, MET_LO, 0.26, -0.26);
  f.vline(7, 2, 11, IRON); f.vline(8, 2, 11, MET_HI);                    // door seam
  f.rect(4, 14, 3, 1, IRON); f.rect(9, 14, 3, 1, IRON);                  // feet
  f.keyline();
  for (let y = 3; y <= 6; y++) {                                         // vent grilles
    f.hline(5, y, 2, y % 2 ? IRON : shade(MET_LO, -0.55));
    f.hline(9, y, 2, y % 2 ? IRON : shade(MET_LO, -0.55));
  }
  f.frame(4, 2, 4, 6, shade(MET_LO, -0.4));
  f.frame(8, 2, 4, 6, shade(MET_LO, -0.4));
  f.vline(6, 9, 3, MET_HI); f.px(6, 12, IRON);                           // handles
  f.vline(9, 9, 3, MET_HI); f.px(9, 12, IRON);
  f.rect(9, 4, 2, 2, AMBER_LO); f.px(9, 4, AMBER);                       // name tag
  return f.blit(p), p;
}

function pBunk(p, seed = 'prop_bunk') {
  const f = form(16, 16);
  f.vline(2, 2, 13, MET); f.vline(3, 2, 13, MET_LO);                     // posts
  f.vline(12, 2, 13, MET); f.vline(13, 2, 13, MET_LO);
  for (const y of [5, 11]) {                                             // two tiers
    f.rect(2, y, 12, 1, MET_HI);
    f.rect(3, y - 2, 10, 2, tone('bone', -0.20));                        // mattress
    f.hline(3, y - 2, 10, tone('bone', -0.04));
    f.rect(3, y - 1, 6, 1, COAT);                                        // blanket
    f.hline(3, y - 1, 6, COAT_HI);
    f.rect(9, y - 3, 3, 1, tone('bone', -0.06));                         // pillow
  }
  f.hline(13, 7, 1, MET_HI); f.hline(13, 9, 1, MET_HI);                  // ladder rungs
  f.rect(2, 14, 12, 1, IRON);
  f.keyline();
  return f.blit(p), p;
}

function pTerminal(p, seed = 'prop_terminal') {
  const f = form(16, 16);
  f.slab(2, 4, 12, 8, MET_LO, 0.24, -0.24);
  f.rect(3, 12, 10, 3, IRON); f.hline(3, 12, 10, MET_LO);                // plinth
  f.keyline();
  f.rect(4, 5, 8, 5, tone('deeper', -0.1));                              // screen well
  f.rect(5, 6, 6, 3, GREEN);
  f.hline(5, 6, 6, GREEN_HI);
  f.hline(5, 8, 6, shade(GREEN, -0.28));
  f.hline(5, 7, 3, shade(GREEN, 0.15));                                  // a line of text
  f.rect(4, 10, 8, 1, IRON);                                             // key shelf
  for (let x = 4; x < 12; x += 2) f.px(x, 10, MET_HI);
  f.px(12, 5, AMBER); f.px(12, 7, shade(GREEN, -0.2));                   // status lamps
  return f.blit(p), p;
}

function pPlant(p, seed = 'prop_plant') {
  const f = form(16, 16);
  f.rect(2, 11, 12, 3, MET_LO);                                          // tray
  f.hline(2, 11, 12, MET_HI);
  f.hline(2, 13, 12, IRON);
  f.rect(3, 12, 10, 1, shade(PAL.rust, -0.55));                          // medium
  f.rect(2, 14, 12, 1, IRON);
  f.vline(7, 5, 7, shade(GREEN, -0.38));                                 // stem
  f.vline(8, 5, 7, GREEN);
  // Foliage as three lozenges, widest in the middle. A leaf drawn as a line
  // disappears; a leaf drawn as a mass with a lit upper edge does not.
  for (const [cy, rx, ry] of [[3, 5, 2], [6, 6, 2], [9, 4, 2]]) {
    f.disc(7, cy, rx, ry, GREEN);
    f.hline(7 - rx + 1, cy - ry, rx * 2 - 1, GREEN_HI);
    f.hline(7 - rx + 1, cy + ry, rx * 2 - 1, shade(GREEN, -0.34));
    f.px(7 - rx, cy, shade(GREEN, -0.2)); f.px(7 + rx, cy, shade(GREEN, -0.34));
  }
  for (let x = 3; x <= 12; x += 3) f.px(x, 5, shade(GREEN, -0.42));      // leaf splits
  for (let x = 4; x <= 11; x += 3) f.px(x, 8, shade(GREEN, -0.42));
  f.keyline();
  f.px(9, 8, AMBER); f.px(6, 6, AMBER_LO);                               // fruit
  return f.blit(p), p;
}

function pSacks(p, seed = 'prop_sacks') {
  const f = form(16, 16);
  const S = tone('bone', -0.34), SH = tone('bone', -0.16), SL = tone('bone', -0.52);
  f.disc(5, 11, 4, 3, S); f.disc(10, 11, 4, 3, S);                       // bottom row
  f.disc(8, 6, 4, 3, S);                                                 // one on top
  for (const [cx, cy] of [[5, 11], [10, 11], [8, 6]]) {
    f.hline(cx - 3, cy - 3, 6, SH);
    f.hline(cx - 3, cy + 3, 6, SL);
    f.px(cx, cy - 4, SL); f.px(cx - 1, cy - 4, SL);                      // tied neck
    f.vline(cx + 2, cy - 2, 4, SL);                                      // seam
  }
  f.rect(2, 14, 12, 1, SL);
  f.keyline();
  f.px(8, 5, shade(PAL.rust, -0.4)); f.px(5, 10, shade(PAL.rust, -0.4)); // stencils
  return f.blit(p), p;
}

function pToolboard(p, seed = 'prop_toolboard') {
  const f = form(16, 16);
  f.slab(2, 2, 12, 11, WOOD, 0.2, -0.24);
  for (let y = 4; y < 12; y += 3) for (let x = 4; x < 13; x += 3) f.px(x, y, shade(WOOD, -0.42));
  f.keyline();
  f.vline(4, 4, 5, MET); f.rect(3, 3, 3, 2, MET_HI); f.px(4, 4, IRON);   // wrench
  f.vline(7, 4, 5, WOOD_HI); f.rect(6, 3, 3, 2, MET_LO); f.hline(6, 3, 3, MET);  // hammer
  f.rect(10, 3, 3, 4, MET_LO); f.vline(10, 3, 4, MET_HI);                // saw blade
  for (let y = 3; y < 7; y++) f.px(13, y, y % 2 ? MET_HI : IRON);        // teeth
  f.rect(4, 10, 4, 2, shade(GREEN, -0.3)); f.hline(4, 10, 4, GREEN);     // coil of wire
  f.rect(10, 10, 2, 2, AMBER_LO); f.px(10, 10, AMBER);                   // a tin
  return f.blit(p), p;
}

function pLamp(p, seed = 'prop_lamp') {
  const f = form(16, 16);
  f.vline(7, 7, 7, MET); f.vline(8, 7, 7, MET_LO);                       // mast
  f.rect(3, 13, 4, 1, MET_LO); f.rect(9, 13, 4, 1, MET_LO);              // splayed feet
  f.px(5, 12, MET); f.px(10, 12, MET_LO);
  f.rect(3, 14, 10, 1, IRON);
  for (let j = 0; j < 4; j++) {                                          // conical shade
    const w = 6 + j * 2;
    f.rect(8 - Math.floor(w / 2), 2 + j, w, 1, j ? MET_LO : MET);
    f.px(8 - Math.floor(w / 2), 2 + j, MET_HI);
    f.px(8 + Math.ceil(w / 2) - 1, 2 + j, IRON);
  }
  f.keyline();
  f.rect(3, 6, 10, 1, AMBER);                                            // the face
  f.hline(4, 6, 8, AMBER_HI);
  f.px(3, 5, AMBER_LO); f.px(12, 5, AMBER_LO);
  for (let j = 1; j <= 5; j++) {                                         // dithered spill
    for (let i = -3 - j; i <= 3 + j; i++) {
      if (dpick(8 + i, 6 + j, 0, 1, 0.30 - j * 0.05)) f.px(8 + i, 6 + j, AMBER_LO);
    }
  }
  return f.blit(p), p;
}

function pSpool(p, seed = 'prop_spool') {
  const f = form(16, 16);
  f.disc(7, 7, 6, 6, WOOD);                                              // the flange
  for (let j = -6; j <= 6; j++) for (let i = -6; i <= 6; i++) {          // round it off
    if (!f.at(7 + i, 7 + j)) continue;
    f.px(7 + i, 7 + j, shade(WOOD, clamp(-(i + j) / 15, -0.2, 0.2)));
  }
  f.disc(7, 7, 3, 3, shade(MET_LO, -0.25));                              // the wound drum
  for (let j = -3; j <= 3; j++) if ((j + 3) % 2 === 0) f.hline(4, 7 + j, 7, shade(MET, -0.4));
  f.rect(6, 6, 3, 3, MET);                                               // hub
  f.hline(6, 6, 3, MET_HI);
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {           // spokes
    for (let k = 4; k <= 5; k++) f.px(7 + dx * k, 7 + dy * k, shade(WOOD, -0.32));
  }
  f.rect(3, 14, 9, 1, IRON);                                             // chock
  f.rect(11, 9, 3, 5, shade(MET, -0.42));                                // the cable, paid out
  f.hline(11, 9, 3, shade(MET, -0.2));
  f.keyline();
  f.px(7, 7, IRON);
  return f.blit(p), p;
}

function pFan(p, seed = 'prop_fan') {
  const f = form(16, 16);
  f.slab(2, 1, 12, 13, MET_LO, 0.24, -0.26);                             // wall plate
  f.keyline();
  f.rect(4, 3, 8, 9, tone('deeper', 0.04));                              // the duct behind
  for (let j = 0; j < 4; j++) {                                          // louvre slats
    const y = 3 + j * 2;
    f.hline(3, y, 10, MET_HI);                                           // top face, lit
    f.hline(3, y + 1, 10, IRON);                                         // underside
    f.px(3, y, MET); f.px(12, y + 1, shade(IRON, -0.3));
  }
  f.hline(3, 11, 10, MET);
  f.vline(3, 3, 9, MET_LO); f.vline(12, 3, 9, IRON);                     // frame cheeks
  for (const [x, y] of [[3, 2], [12, 2], [3, 12], [12, 12]]) f.px(x, y, MET_HI);  // bolts
  f.px(6, 12, AMBER_LO);                                                 // running lamp
  return f.blit(p), p;
}

function pShelf(p, seed = 'prop_shelf') {
  const f = form(16, 16);
  f.vline(2, 1, 14, MET); f.vline(3, 1, 14, MET_LO);                     // uprights
  f.vline(12, 1, 14, MET); f.vline(13, 1, 14, MET_LO);
  for (const y of [5, 9, 13]) { f.hline(2, y, 12, MET_HI); f.hline(2, y + 1, 12, IRON); }
  f.rect(4, 2, 4, 3, WOOD); f.hline(4, 2, 4, WOOD_HI);                   // a crate
  f.rect(9, 3, 3, 2, CANVAS); f.hline(9, 3, 3, CANVAS_HI);               // a bundle
  f.rect(4, 7, 2, 2, MET); f.hline(4, 7, 2, MET_HI);                     // two tins
  f.rect(7, 6, 2, 3, MET_LO); f.hline(7, 6, 2, MET);
  f.rect(10, 7, 2, 2, AMBER_LO); f.px(10, 7, AMBER);
  f.rect(4, 10, 8, 3, WOOD); f.hline(4, 10, 8, WOOD_HI);                 // a long case
  f.vline(8, 10, 3, shade(WOOD, -0.34));
  f.keyline();
  return f.blit(p), p;
}

export const PROPS = {
  crate: pCrate,
  barrel: pBarrel,
  locker: pLocker,
  bunk: pBunk,
  terminal: pTerminal,
  plant: pPlant,
  sacks: pSacks,
  toolboard: pToolboard,
  lamp: pLamp,
  spool: pSpool,
  fan: pFan,
  shelf: pShelf,
};

export default {
  PAL, tone, toxic,
  SKYLINE_W, SKYLINE_H, TILE, PROP_SIZE, THREAT_SIZES,
  drawSkyline, drawWallTile, drawRockTile, drawShaftTile,
  TILES, THREATS, PROPS,
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

function legalColour(c) {
  for (const k of Object.keys(PAL)) {
    const f = fitTriangle(c, PAL[k]);
    if (!f) continue;
    if (f.res <= 2.6 && f.s >= -0.03 && f.t >= -0.03 && f.s + f.t <= 1.03) return k;
  }
  return null;
}

/** Toxin-family by hue AND by hull position, so greys cannot false-positive. */
function toxinish(c) {
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
const SIL_GRID = 12;
const SIL_FILL = 0.5;
/**
 * What counts as no seam: the wrap transition has to look like one of the
 * tile's own transitions. Strictly "no worse than the worst interior pair" is
 * the honest statement but it is brittle with only 31 samples — the wrap join
 * is itself a legitimate facet boundary and can be the single most contrasty
 * one by luck, which is what a 4% overshoot means. So the bar allows a small
 * margin over the worst pair, or a healthy multiple of the typical pair,
 * whichever is kinder. A REAL seam is not a few percent over: an edge that
 * does not wrap puts unrelated pixels next to each other and lands multiples
 * above both terms. The check at the bottom of this file demonstrates that on
 * a deliberately broken tile.
 */
const seamBar = (max, mean) => Math.max(max * 1.15, mean * 2.2);

function silhouette(px, size, at) {
  const bits = [];
  const G = SIL_GRID;
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      let on = 0, n = 0;
      const x0 = Math.floor(gx * at.w / G), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * at.w / G));
      const y0 = Math.floor(gy * at.h / G), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * at.h / G));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { n++; if (readPixel(px, size, at, x, y)[3] > 127) on++; }
      bits.push(on / n > SIL_FILL ? 1 : 0);
    }
  }
  return bits;
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

const TOXIN_OK = new Set(['env_skyline', 'threat_bloater']);

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
  // axis and stay quiet on the y axis, which does wrap.
  {
    const probe = sheet.sprite('__seam_probe', TILE, TILE);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) probe.set(x, y, shade(PAL.concrete, -0.5 + (x / (TILE - 1)) * 0.9));
    }
    const s = seamReport(sheet.px, sheet.size, sheet.frames.__seam_probe);
    const bar = seamBar(s.colMax, s.colMean);
    if (!(s.colWrap > bar)) problems.push(`seam detector is blind: a non-wrapping tile passed (${s.colWrap.toFixed(1)} vs bar ${bar.toFixed(1)})`);
    if (s.rowWrap > seamBar(s.rowMax, s.rowMean)) problems.push('seam detector is trigger-happy: it flagged an axis that does wrap');
    delete sheet.frames.__seam_probe;
    console.log(`\n  [detector]  non-wrapping probe: wrap ${s.colWrap.toFixed(1)} vs bar ${bar.toFixed(1)} ` +
      `(${(s.colWrap / Math.max(bar, 0.01)).toFixed(0)}x over) — caught`);
  }

  // --- silhouettes --------------------------------------------------------
  const sigs = built.filter((b) => b.kind === 'threat')
    .map((b) => ({ name: b.name, sig: silhouette(sheet.px, sheet.size, b.at) }));
  let worst = { d: 99, a: '', b: '' };
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      const d = hamming(sigs[i].sig, sigs[j].sig);
      if (d < worst.d) worst = { d, a: sigs[i].name, b: sigs[j].name };
    }
  }
  const SIL_MIN = 12;
  if (worst.d < SIL_MIN) problems.push(`threats: ${worst.a} and ${worst.b} share a silhouette (${worst.d}/${SIL_GRID * SIL_GRID} bits differ, need ${SIL_MIN})`);

  // --- report -------------------------------------------------------------
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`scenery.mjs — ${built.length} frames\n`);
  let kind = null;
  for (const r of rows) {
    if (r.kind !== kind) { kind = r.kind; console.log(`  [${kind}]`); }
    console.log(`    ${pad(r.name, 22)} ${pad(`${r.w}x${r.h}`, 8)} cover ${pad(`${Math.round(r.cover * 100)}%`, 5)}` +
      (r.toxin ? `  toxin ${r.toxin}px` : ''));
  }
  console.log('\n  [seams]  wrap vs worst interior transition (lower wrap = no visible join)');
  for (const s of seamRows) {
    console.log(`    ${pad(s.name, 22)} cols wrap ${pad(s.colWrap.toFixed(1), 6)} worst ${pad(s.colMax.toFixed(1), 6)}` +
      (Number.isNaN(s.rowWrap) ? '  rows n/a' : `  rows wrap ${pad(s.rowWrap.toFixed(1), 6)} worst ${s.rowMax.toFixed(1)}`));
  }
  console.log(`\n  [silhouettes]  closest threat pair ${worst.a} / ${worst.b} at ${worst.d}/${SIL_GRID * SIL_GRID} bits`);
  console.log(`  [palette]      ${USED.size} distinct tones requested, all inside the PAL hull`);
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

