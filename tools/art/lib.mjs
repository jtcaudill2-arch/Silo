/**
 * lib.mjs — the pixel drawing library the whole art pipeline is built on.
 *
 * The old atlas had exactly one primitive, `rect`, which is why every room in
 * the game read as an arrangement of coloured blocks. The reference art the
 * game is being matched to is built from a specific and quite small vocabulary
 * — outlined cylinders with a highlight down one side, pipe runs with union
 * collars, valve wheels, lit console screens, brick coursing, an amber ceiling
 * fixture — and once those exist as primitives, a room is a short composition
 * rather than two hundred lines of rectangles.
 *
 * Rules this library enforces so a hundred sprites drawn by different hands
 * still look like one game:
 *
 *   - Everything is outlined. A dark keyline around every solid is the single
 *     biggest reason the reference reads as deliberate pixel art rather than
 *     as shapes. `outline` is not optional on the shape helpers.
 *   - Light comes from the upper left. Highlights go on top and left faces,
 *     shade on bottom and right. Consistently, or nothing looks solid.
 *   - Colour comes from the palette in `PAL`, or from `shade()` of a palette
 *     entry. Nothing else. The spec reserves toxin green for radiation and
 *     contamination; `PAL.toxin` is deliberately not used by any room fixture.
 *   - Randomness is seeded by sprite name, so regenerating the atlas produces
 *     a byte-identical file and the repo stays diffable.
 *
 * Coordinates are sprite-local: (0,0) is the top-left of the sprite you asked
 * for, not of the atlas.
 */

// ---------------------------------------------------------------- palette ---

/** Spec §14. Nothing off-palette may appear in any generated art. */
export const PAL = {
  deeper: [0x1a, 0x1d, 0x1f],
  deep: [0x23, 0x27, 0x29],
  concrete: [0x3a, 0x40, 0x42],
  lit: [0x5a, 0x61, 0x63],
  sodium: [0xe8, 0xa3, 0x3d],
  verdigris: [0x4e, 0x8c, 0x7a],
  rust: [0xa3, 0x4b, 0x2a],
  toxin: [0x8f, 0xb3, 0x3a], // RESERVED: radiation and contamination only
  bone: [0xd9, 0xd2, 0xc4],

  // Derived working tones. All are palette entries pushed toward black or
  // bone, so the set stays coherent — see shade().
  steel: [0x6e, 0x76, 0x79],
  steelLit: [0x8a, 0x92, 0x95],
  steelDark: [0x4a, 0x51, 0x54],
  ink: [0x12, 0x14, 0x16], // the universal keyline
  skin: [0xe3, 0xbe, 0x9a],
  skinShade: [0xc2, 0x9c, 0x79],
  hair: [0x16, 0x16, 0x1c],
  denim: [0x5a, 0x70, 0x95],
  denimLit: [0x74, 0x8b, 0xb0],
  denimDark: [0x3f, 0x51, 0x6e],
  boot: [0x25, 0x2b, 0x3a],
};

/** Mix a colour toward black (t<0) or bone (t>0). t in [-1, 1]. */
export function shade(c, t) {
  const to = t < 0 ? [0, 0, 0] : PAL.bone;
  const k = Math.abs(t);
  return [
    Math.round(c[0] + (to[0] - c[0]) * k),
    Math.round(c[1] + (to[1] - c[1]) * k),
    Math.round(c[2] + (to[2] - c[2]) * k),
  ];
}

// ------------------------------------------------------------------ noise ---

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic [0,1) from a seed and an index. */
export function rnd(seed, n) {
  const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** A small seeded generator, for when a helper wants a stream. */
export function rng(seedStr) {
  let n = 0;
  const s = hash(seedStr);
  return () => rnd(s, n++);
}

// ------------------------------------------------------------------ canvas ---

/**
 * A sprite-local painting surface. Writes through to the atlas buffer at an
 * offset, so composition helpers never need to know where they landed.
 */
export function painter(px, atlasW, at) {
  const inside = (x, y) => x >= 0 && y >= 0 && x < at.w && y < at.h;

  const set = (x, y, c, a = 255) => {
    if (!c || !inside(x, y)) return;
    const i = ((at.y + y) * atlasW + (at.x + x)) * 4;
    if (a >= 255) {
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
      return;
    }
    // Source-over against whatever is already there.
    const sa = a / 255;
    const da = px[i + 3] / 255;
    const out = sa + da * (1 - sa);
    if (out <= 0) return;
    px[i] = Math.round((c[0] * sa + px[i] * da * (1 - sa)) / out);
    px[i + 1] = Math.round((c[1] * sa + px[i + 1] * da * (1 - sa)) / out);
    px[i + 2] = Math.round((c[2] * sa + px[i + 2] * da * (1 - sa)) / out);
    px[i + 3] = Math.round(out * 255);
  };

  const get = (x, y) => {
    if (!inside(x, y)) return null;
    const i = ((at.y + y) * atlasW + (at.x + x)) * 4;
    return [px[i], px[i + 1], px[i + 2], px[i + 3]];
  };

  const p = {
    w: at.w,
    h: at.h,
    set,
    get,

    /** Filled rectangle. */
    rect(x, y, w, h, c, a = 255) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c, a);
      return p;
    },

    /** One-pixel rectangle border. */
    frame(x, y, w, h, c, a = 255) {
      for (let i = 0; i < w; i++) { set(x + i, y, c, a); set(x + i, y + h - 1, c, a); }
      for (let j = 0; j < h; j++) { set(x, y + j, c, a); set(x + w - 1, y + j, c, a); }
      return p;
    },

    /** Axis-aligned line. Diagonals are deliberately not offered: they alias. */
    hline(x, y, len, c, a = 255) { for (let i = 0; i < len; i++) set(x + i, y, c, a); return p; },
    vline(x, y, len, c, a = 255) { for (let j = 0; j < len; j++) set(x, y + j, c, a); return p; },

    /**
     * A solid box with a keyline and light from the upper left. The workhorse:
     * almost every piece of machinery in the game is one of these or several.
     */
    box(x, y, w, h, c, { outline = PAL.ink, lit = 0.22, shaded = -0.22 } = {}) {
      p.rect(x, y, w, h, c);
      if (h > 2) p.hline(x + 1, y + 1, w - 2, shade(c, lit));
      if (w > 2) p.vline(x + 1, y + 1, h - 2, shade(c, lit));
      if (h > 2) p.hline(x + 1, y + h - 2, w - 2, shade(c, shaded));
      if (w > 2) p.vline(x + w - 2, y + 1, h - 2, shade(c, shaded));
      // A 1px keyline on every side needs 3px to have anything left in the
      // middle. Below that the outline eats the whole shape and the colour
      // argument is silently discarded — a 2x5 box came out as ten pixels of
      // solid ink, which is what every union collar in the game was. Outline
      // only the long sides of a thin shape, so it still reads as a raised
      // band and still keeps its metal.
      if (outline) {
        if (w >= 3 && h >= 3) p.frame(x, y, w, h, outline);
        else if (w < 3 && h >= 3) { p.hline(x, y, w, outline); p.hline(x, y + h - 1, w, outline); }
        else if (h < 3 && w >= 3) { p.vline(x, y, h, outline); p.vline(x + w - 1, y, h, outline); }
      }
      return p;
    },

    /**
     * A vertical cylinder: flat colour with a bright band down the left third
     * and a dark band down the right, plus a rounded cap. This one shape is
     * most of what makes the reference rooms read as industrial.
     */
    cylinder(x, y, w, h, c, { outline = PAL.ink, cap = true } = {}) {
      p.rect(x, y, w, h, c);
      const hiW = Math.max(1, Math.round(w * 0.22));
      const loW = Math.max(1, Math.round(w * 0.18));
      p.rect(x + 1, y, hiW, h, shade(c, 0.3));
      p.rect(x + w - 1 - loW, y, loW, h, shade(c, -0.26));
      if (cap) {
        // Elliptical top: shave the corners so it doesn't read as a box.
        p.hline(x + 1, y, w - 2, shade(c, 0.42));
        set(x, y, null, 0); set(x + w - 1, y, null, 0);
        set(x, y + 1, outline); set(x + w - 1, y + 1, outline);
        p.hline(x + 1, y + 1, w - 2, shade(c, 0.36));
      }
      if (outline) {
        p.vline(x, y + (cap ? 1 : 0), h - (cap ? 1 : 0), outline);
        p.vline(x + w - 1, y + (cap ? 1 : 0), h - (cap ? 1 : 0), outline);
        p.hline(x + (cap ? 1 : 0), y + h - 1, w - (cap ? 2 : 0), outline);
        if (cap) { set(x + 1, y, outline); set(x + w - 2, y, outline); }
        else p.hline(x, y, w, outline);
      }
      return p;
    },

    /** A horizontal pipe run with a keyline top and bottom. */
    pipeH(x, y, len, thick = 3, c = PAL.steel) {
      p.rect(x, y, len, thick, c);
      p.hline(x, y, len, shade(c, 0.34));
      p.hline(x, y + thick - 1, len, shade(c, -0.3));
      p.hline(x, y - 1, len, PAL.ink);
      p.hline(x, y + thick, len, PAL.ink);
      return p;
    },

    /** A vertical pipe run. */
    pipeV(x, y, len, thick = 3, c = PAL.steel) {
      p.rect(x, y, thick, len, c);
      p.vline(x, y, len, shade(c, 0.34));
      p.vline(x + thick - 1, y, len, shade(c, -0.3));
      p.vline(x - 1, y, len, PAL.ink);
      p.vline(x + thick, y, len, PAL.ink);
      return p;
    },

    /**
     * The collar where two lengths of pipe are joined. Small, and the thing
     * that stops a pipe reading as a painted stripe.
     */
    collar(x, y, thick = 3, horizontal = true, c = PAL.steelLit) {
      // Three across the run, not two: a collar wants a lit face, a body and
      // a shaded face, and at two pixels there is no room for a body at all.
      if (horizontal) {
        p.rect(x, y - 1, 3, thick + 2, c);
        p.vline(x, y - 1, thick + 2, shade(c, 0.34));
        p.vline(x + 2, y - 1, thick + 2, shade(c, -0.3));
        p.hline(x, y - 2, 3, PAL.ink);
        p.hline(x, y + thick + 1, 3, PAL.ink);
      } else {
        p.rect(x - 1, y, thick + 2, 3, c);
        p.hline(x - 1, y, thick + 2, shade(c, 0.34));
        p.hline(x - 1, y + 2, thick + 2, shade(c, -0.3));
        p.vline(x - 2, y, 3, PAL.ink);
        p.vline(x + thick + 1, y, 3, PAL.ink);
      }
      return p;
    },

    /** Pipe elbow: a small filled square that hides the mitre. */
    elbow(x, y, thick = 3, c = PAL.steel) {
      p.box(x - 1, y - 1, thick + 2, thick + 2, c, { lit: 0.28, shaded: -0.24 });
      return p;
    },

    /** A valve wheel — circle with a cross. Reads at 7px and up. */
    valve(cx, cy, r = 3, c = PAL.steelLit) {
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          const d = i * i + j * j;
          if (d > r * r) continue;
          set(cx + i, cy + j, d > (r - 1) * (r - 1) ? PAL.ink : c);
        }
      }
      p.hline(cx - r + 1, cy, r * 2 - 1, shade(c, -0.35));
      p.vline(cx, cy - r + 1, r * 2 - 1, shade(c, -0.35));
      set(cx, cy, PAL.ink);
      return p;
    },

    /** A lit console screen. `glow` is the screen colour. */
    screen(x, y, w, h, glow = PAL.verdigris) {
      p.box(x, y, w, h, PAL.deeper, { lit: 0.1, shaded: -0.05 });
      p.rect(x + 1, y + 1, w - 2, h - 2, glow);
      p.hline(x + 1, y + 1, w - 2, shade(glow, 0.4));
      // Scanline, so it reads as emitting rather than painted.
      for (let j = y + 2; j < y + h - 1; j += 2) p.hline(x + 1, j, w - 2, shade(glow, -0.22));
      return p;
    },

    /** The amber ceiling fixture every interior in the reference has. */
    ceilingLight(cx, y, w = 9) {
      const h = 3;
      const x = cx - Math.floor(w / 2);
      p.box(x, y, w, h, PAL.rust, { lit: 0.15, shaded: -0.2 });
      p.rect(x + 1, y + 1, w - 2, h - 2, PAL.sodium);
      p.hline(x + 2, y + 1, w - 4, shade(PAL.sodium, 0.45));
      return p;
    },

    /**
     * Brick/block coursing for a back wall, with offset rows and a few
     * lighter and darker blocks so it isn't a grid.
     */
    bricks(x, y, w, h, c, seed = 'wall', bw = 11, bh = 6) {
      p.rect(x, y, w, h, c);
      const r = rng(seed);
      let row = 0;
      for (let j = y; j < y + h; j += bh, row++) {
        const off = (row % 2) * Math.floor(bw / 2);
        p.hline(x, j, w, shade(c, -0.16));
        for (let i = x - off; i < x + w; i += bw) {
          p.vline(i, j, Math.min(bh, y + h - j), shade(c, -0.16));
          const v = r();
          if (v > 0.86) p.rect(i + 1, j + 1, Math.min(bw - 1, x + w - i - 1), Math.min(bh - 1, y + h - j - 1), shade(c, 0.07));
          else if (v < 0.12) p.rect(i + 1, j + 1, Math.min(bw - 1, x + w - i - 1), Math.min(bh - 1, y + h - j - 1), shade(c, -0.07));
        }
      }
      return p;
    },

    /** Ordered dither between two colours, for gradients that stay on-palette. */
    dither(x, y, w, h, a, b, t) {
      const M = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const th = (M[j & 3][i & 3] + 0.5) / 16;
          set(x + i, y + j, t > th ? b : a);
        }
      }
      return p;
    },

    /** Speckle, for grime, rust and dust. */
    speckle(x, y, w, h, c, density, seed = 'sp') {
      const r = rng(seed);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) if (r() < density) set(x + i, y + j, c);
      }
      return p;
    },

    /**
     * The chamfered vault silhouette every cutaway in the reference sits in:
     * a room whose top corners are cut away at 45 degrees. Returns the y of
     * the ceiling at a given x, so contents can be placed under it.
     */
    vault(x, y, w, h, wall, { chamfer = 10, floor = 6 } = {}) {
      for (let j = 0; j < h; j++) {
        const cut = j < chamfer ? chamfer - j : 0;
        p.hline(x + cut, y + j, w - cut * 2, wall);
      }
      // Floor band, lighter, so the room has a ground to stand on.
      p.rect(x, y + h - floor, w, floor, shade(wall, 0.12));
      p.hline(x, y + h - floor, w, shade(wall, -0.25));
      // Keyline along the chamfer and the sides.
      for (let j = 0; j < chamfer; j++) {
        set(x + chamfer - j, y + j, PAL.ink);
        set(x + w - 1 - (chamfer - j), y + j, PAL.ink);
      }
      p.vline(x, y + chamfer, h - chamfer, PAL.ink);
      p.vline(x + w - 1, y + chamfer, h - chamfer, PAL.ink);
      p.hline(x, y + h - 1, w, PAL.ink);
      return p;
    },
  };
  return p;
}

// ------------------------------------------------------------------ atlas ---

/**
 * A growing atlas with a simple shelf allocator. Sprites are packed in rows;
 * a one-pixel gutter stops bilinear filtering from bleeding neighbours in if
 * anything ever draws this scaled.
 */
export function atlas(size) {
  const px = new Uint8Array(size * size * 4);
  const frames = {};
  let cx = 0, cy = 0, rowH = 0;

  return {
    px,
    frames,
    size,
    get usedHeight() { return Math.min(size, cy + rowH + 1); },

    /** Reserve a sprite, returning a painter positioned on it. */
    sprite(name, w, h) {
      if (cx + w > size) { cx = 0; cy += rowH + 1; rowH = 0; }
      if (cy + h > size) throw new Error(`atlas overflow adding "${name}" (${w}x${h})`);
      const at = { x: cx, y: cy, w, h };
      cx += w + 1;
      rowH = Math.max(rowH, h);
      frames[name] = at;
      return painter(px, size, at);
    },
  };
}

export default { PAL, shade, painter, atlas, hash, rnd, rng };
