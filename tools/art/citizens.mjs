/**
 * citizens.mjs — the people of the silo, and their portraits.
 *
 * Two renderers live here, and they are deliberately different animals:
 *
 *   drawCitizen()  12x16, drawn in the shaft cross-section at 1:1. Sixteen
 *                  rows to carry a whole human being, so every row is spent
 *                  on something: 1 cowlick, 4 head, 5 torso, 2 leg, 2 boot,
 *                  and a keyline row underneath that lands on the floor.
 *                  Legibility beats detail here. The read must survive being
 *                  four pixels wide and moving.
 *
 *   drawPortrait() 32x32 head-and-shoulders for the citizen card, shown at
 *                  3x. This one has room, so it gets a face — two eyes, a
 *                  nose, seeded hair, a collar, and the role marking.
 *
 * The character both share is the one from the reference sheet: black shaggy
 * hair with a small cowlick, pale skin, one large mostly-white eye in profile,
 * a grey-blue jumpsuit with a chest pocket and a leg seam, chunky dark navy
 * boots. Roles do NOT redesign that character. Each role adds exactly one
 * strong silhouette-or-colour cue on top of it, because at 12x16 a second cue
 * is not read, it is noise.
 *
 * Three rules the code enforces rather than trusting:
 *
 *   - Every colour except the keyline goes through tone(), which takes a PAL
 *     key and a shade amount. PAL.ink is the one exception: it is written raw
 *     (the pupil, the pocket flap, and every keyline pass) because it is not a
 *     material, it is the outline, and routing it through tone() would put it
 *     in the provenance map as if it were a garment. tone() refuses PAL.toxin
 *     to every role but 'irradiated' — the spec reserves that green for
 *     radiation and contamination, and a citizen sick with radiation is the
 *     one thing in the silo it is actually for.
 *   - Every solid meets EMPTY SPACE across a 1px near-black keyline. Rather
 *     than hand-drawing it (impossible to keep right across 200 frames), the
 *     figure is composed in a grid and grid.keyline() grows ink into the empty
 *     pixels touching it. That pass is not optional and nothing overrides it.
 *
 *     Where two parts of the same figure meet is a different question, and the
 *     answer is not automatically "a line". Twelve pixels wide, every ink pixel
 *     spent inside the body is a pixel of body that no longer exists: the far
 *     arm outlined against the torso deleted the jumpsuit's only lit column,
 *     and a belt outlined against the legs deleted half the leg. So an interior
 *     boundary is drawn with grid.stamp() where the two materials are close in
 *     value, and with the value step itself where they are not — which is why
 *     c.sleeveBack is derived to sit below every tone on the body. stamp()
 *     takes an allowInk(dx, dy, nx, ny) predicate; it is given the cell as well
 *     as the direction, because "may I keyline downward" is usually the wrong
 *     question — the arm must keyline down against the torso and must not
 *     keyline down into the legs, and those are one direction on two rows.
 *   - Randomness is rng(seed) from lib.mjs and is derived from the citizen
 *     seed only, never from the frame index, so a citizen looks like the same
 *     person for the whole animation and the atlas regenerates byte-identical.
 *     (Both PRNGs here are lib's sin-based hash, so "byte-identical" holds for
 *     any one JS engine; ECMAScript does not pin the last bits of Math.sin
 *     across engines. Generating the atlas is a single-machine build step, so
 *     that is a known and accepted limit, not an oversight.)
 *
 * Light is from the upper left in both renderers: top faces and the trailing
 * (left) edge are lit, bottom faces and the leading (right) edge are shaded.
 * The figure faces right; `facing` mirrors the finished grid, which keeps the
 * lighting attached to the world rather than to the character.
 *
 * Standalone: node tools/art/citizens.mjs
 *   --out=<path.png>  write a magnified contact sheet
 *   --zoom=N          contact sheet magnification (default 6)
 *   --role=<name>     restrict the sheet to one role
 *   --action=<name>   restrict the sheet to one action
 *   --portraits       portraits only
 */

import { PAL, shade, rng } from './lib.mjs';

/* ---------------------------------------------------------------- sizes -- */

/** In-world sprite size. Feet land on the bottom row. */
export const W = 12;
export const H = 16;

/** Card portrait size. Drawn at 3x on the citizen card. */
export const PORTRAIT = 32;

/**
 * Frame counts per action. walk is six because six is the smallest count that
 * gives a full stride two distinguishable poses per half-step (contact, swing
 * low, swing high) without the mirrored halves colliding into duplicates.
 */
export const ACTIONS = { walk: 6, idle: 4, work: 4, sleep: 2, injured: 4, talk: 4, fight: 4 };

/**
 * What the game actually asks the atlas for, and what this module must be able
 * to answer with.
 *
 * The two vocabularies have converged, and this note used to describe the
 * split as though it were still open. It said `citizenRole()` "can only ever
 * return one of five palettes: worker, idle, hurt, irradiated, child" and
 * "samples walk at four frames and work at two". None of that is true now, and
 * three of those five names are not among the things it returns at all.
 *
 * src/render/sprites.js:citizenFrame() names frames
 * `citizen_<role>_<action><n>`, and `citizenRole()` returns exactly the eleven
 * ids in ROLES below — base, resident, farmer, mechanic, medic, deputy,
 * militia, child, elder, hazmat, irradiated — so every role this module draws
 * is reachable art. Its FRAME_COUNTS matches ACTIONS above exactly: walk 6,
 * idle 4, work 4, sleep 2, injured 4, talk 4, fight 4.
 *
 * Neither of those sentences is taken on trust any more, and neither survived
 * being checked: this one said ten roles and left `resident` out of a list of
 * ten, and it described five of the seven actions. test/atlas.mjs sweeps every
 * name the renderer can produce against the shipped sheet in both directions,
 * so a role or an action that stops matching fails there rather than sitting
 * in a comment. It found a `die: 4` in FRAME_COUNTS that this file had stopped
 * baking — 44 frames the renderer could name and the atlas did not have.
 *
 * CONSUMER_ROLES survives as a compatibility alias for the old five names.
 * Only `irradiated` and `child` are still asked for and both map to
 * themselves; `worker`, `idle` and `hurt` are aliases onto 'base' that nothing
 * requests any more. An alias resolves to a role in config() and draws
 * identically, so keeping them costs nothing and an older caller still works.
 *
 * WALK SAMPLING. A four-frame consumer reading a six-frame cycle wraps 3 -> 0,
 * which lands mid-stride and pops. WALK_4 is therefore not a slice of WALK: it
 * is the same stride resampled at four phases that close, so `walkFrames(4)`
 * is a clean loop and `walkFrames(6)` is the full one. The shipped renderer
 * takes the six, but CONSUMER_ACTIONS below still describes the four-frame
 * sampling, and the resampled cycle is what makes that safe.
 */
export const CONSUMER_ROLES = {
  worker: 'base',
  idle: 'base',
  hurt: 'base',
  irradiated: 'irradiated',
  child: 'child',
};

/** Frame counts the current consumer samples, for whoever bakes the atlas. */
export const CONSUMER_ACTIONS = { walk: 4, work: 2, idle: 2, sleep: 2 };

/** One cue each. See the per-role notes in ROLE_CUES. */
export const ROLES = [
  'base', 'resident', 'farmer', 'mechanic', 'medic', 'deputy', 'militia',
  'child', 'elder', 'hazmat', 'irradiated',
];

/* -------------------------------------------------------------- palette -- */

/** Every colour this module has ever produced, keyed "r,g,b" -> provenance. */
const USED = new Map();

/**
 * The tones the render in progress has asked for. USED accumulates forever, so
 * on its own it proves nothing: once any role has requested hazmat bone, a
 * farmer painted in hazmat bone would pass an audit against it. SCOPE is reset
 * per render, so "every pixel in this frame is a tone this frame asked for" is
 * an assertion that can actually fail.
 */
let SCOPE = null;

/** Set for the duration of one render; the only role allowed to touch toxin. */
let TOXIN_OK = false;

/**
 * The only way to make a colour in this file. Takes a PAL key so the
 * provenance of every pixel is a palette entry by construction rather than by
 * inspection, and gates the one entry the spec reserves.
 *
 * PAL.toxin is radiation and contamination and nothing else. It is not
 * decoration and no ordinary citizen may be made of it — but the 'irradiated'
 * citizen IS contamination, walking around, and is the single subject in the
 * silo the colour exists for. So the gate is a scope rather than a wall: it
 * opens only while an irradiated citizen is being drawn, and the self-test
 * checks that no other role ever emits a toxin pixel.
 */
function tone(name, t = 0) {
  const base = PAL[name];
  if (!base) throw new Error(`tone(): "${name}" is not a PAL entry`);
  if (name === 'toxin' && !TOXIN_OK) {
    throw new Error('tone(): PAL.toxin is reserved for radiation and contamination');
  }
  const c = t ? shade(base, t) : base;
  const prov = t ? `${name}@${t}` : name;
  USED.set(c.join(','), prov);
  if (SCOPE) SCOPE.set(c.join(','), prov);
  return c;
}

/** Run one render with its own provenance scope. Returns [result, scope]. */
function scoped(role, fn) {
  const outer = SCOPE;
  const outerToxin = TOXIN_OK;
  SCOPE = new Map();
  TOXIN_OK = resolveRole(role) === 'irradiated';
  try {
    return [fn(), SCOPE];
  } finally {
    SCOPE = outer;
    TOXIN_OK = outerToxin;
  }
}

/** Tones produced by the most recent drawCitizen/drawPortrait call. */
let LAST_SCOPE = new Map();

/** Provenance map for the last render, which is what an audit should read. */
export function tonesUsed() {
  return new Map(LAST_SCOPE);
}

/** Every tone this module has ever produced, across every role. */
export function tonesEverUsed() {
  return new Map(USED);
}

/* ----------------------------------------------------------------- grid -- */

/**
 * A sprite-local colour grid. Composition happens here rather than straight
 * onto the painter because two things need to look backwards at what has
 * already been drawn: the keyline pass, and stamped parts that must outline
 * themselves against the body they overlap.
 */
function grid(w, h) {
  const cells = new Array(w * h).fill(null);
  const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  const g = {
    w,
    h,
    at(x, y) {
      return x < 0 || y < 0 || x >= w || y >= h ? null : cells[y * w + x];
    },
    px(x, y, c) {
      if (c && x >= 0 && y >= 0 && x < w && y < h) cells[y * w + x] = c;
      return g;
    },
    rect(x, y, rw, rh, c) {
      for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) g.px(x + i, y + j, c);
      return g;
    },
    hline(x, y, n, c) {
      for (let i = 0; i < n; i++) g.px(x + i, y, c);
      return g;
    },
    vline(x, y, n, c) {
      for (let j = 0; j < n; j++) g.px(x, y + j, c);
      return g;
    },
    /** Paint only where a solid pixel already is. Shading, not adding. */
    over(x, y, c) {
      if (g.at(x, y)) g.px(x, y, c);
      return g;
    },

    /**
     * Lay a part on top of the figure, keylined against whatever it covers.
     * The outer keyline against empty space is left to keyline(); this only
     * handles the internal boundary, which is the one a swinging arm over a
     * torso needs and which no outline pass can infer.
     *
     * allowInk is called with the direction AND the cell about to be inked,
     * because "may I keyline downward" is usually the wrong question: the arm
     * needs to keyline down against the torso and must not keyline down into
     * the legs, and those are the same direction on different rows.
     */
    stamp(list, allowInk = null) {
      const own = new Set(list.map(([x, y]) => y * w + x));
      for (const [x, y] of list) {
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = x + dx;
          const ny = y + dy;
          if (own.has(ny * w + nx)) continue;
          if (allowInk && !allowInk(dx, dy, nx, ny)) continue;
          if (g.at(nx, ny)) g.px(nx, ny, PAL.ink);
        }
      }
      for (const [x, y, c] of list) g.px(x, y, c);
      return g;
    },

    /** stamp(), clipped to whatever is already solid. For worn things. */
    stampOn(list, allowInk = null) {
      return g.stamp(list.filter(([x, y]) => g.at(x, y)), allowInk);
    },

    /** Grow a 1px keyline into every empty pixel touching a solid one. */
    keyline(ink) {
      const snap = cells.slice();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (snap[y * w + x]) continue;
          let touches = false;
          for (const [dx, dy] of NEIGHBOURS) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (snap[ny * w + nx]) { touches = true; break; }
          }
          if (touches) cells[y * w + x] = ink;
        }
      }
      return g;
    },

    /** Fill everything still empty, for the portrait backdrop. */
    fillEmpty(fn) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) if (!cells[y * w + x]) cells[y * w + x] = fn(x, y);
      }
      return g;
    },

    blit(p, flip) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = cells[y * w + x];
          if (c) p.set(flip ? w - 1 - x : x, y, c);
        }
      }
      return g;
    },
  };
  return g;
}

/** Collector for grid.stamp(): the same drawing verbs, deferred. */
function cells() {
  const list = [];
  const api = {
    list,
    px(x, y, c) { if (c) list.push([x, y, c]); return api; },
    rect(x, y, w, h, c) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) api.px(x + i, y + j, c);
      return api;
    },
    hline(x, y, n, c) { for (let i = 0; i < n; i++) api.px(x + i, y, c); return api; },
    vline(x, y, n, c) { for (let j = 0; j < n; j++) api.px(x, y + j, c); return api; },
  };
  return api;
}

/* -------------------------------------------------------------- metrics -- */

/**
 * The vertical budget, in sprite rows. Row 0 is left empty so the cowlick can
 * take its keyline; row 15 is left empty so the boots can take theirs, which
 * means the last painted row of a standing citizen is the dark sole line and
 * that is what lands on the floor.
 *
 * Adult: cowlick 1, head 4, torso 5, leg 2, boot 2. The head is 4 of the 15
 * painted rows — a shade over a quarter, which is the reference's proportion.
 */
const METRICS = {
  adult: { headY: 2, torsoY: 6, torsoH: 5, legY: 11, bootY: 13 },
  // Shorter by two rows with the same head, so the head reads as a third of
  // the figure. Legs lose the most, which is what makes a child a child: one
  // thigh row and a boot, against the adult's two.
  //
  // torsoH is 4 rather than 3 and the whole figure moved up a row to pay for
  // it. drawTorso squashes by one on a bob frame, and a 3-row torso squashed
  // to 2 is a lit row over a shaded row with nothing between — the child's
  // body would contain no jumpsuit colour at all, just a light bar over a dark
  // one. The boot rows are not negotiable (13 and 14, so the keyline lands on
  // 15 and the feet stand on the floor), so the row came out of the shortness
  // budget instead. Two rows plus the wide suit and the swallowed hands still
  // read as a child; a bodyless torso did not read as anything.
  child: { headY: 4, torsoY: 8, torsoH: 4, legY: 12, bootY: 13 },
  // One row shorter, and the head is pushed forward by headDX into a stoop.
  elder: { headY: 3, torsoY: 7, torsoH: 4, legY: 11, bootY: 13 },
};
// The cowlick is not in METRICS: drawHead derives it from the crown row it
// actually sits on (headY - 1), so a `cowY` key here would be a knob that
// silently does nothing. If the cowlick ever needs to float free of the crown,
// give drawHead an explicit offset rather than reviving a parallel row budget.

/**
 * Horizontal layout. The skull sits at cols 3..8, the torso at 4..8, and the
 * body centres on column 6.
 *
 * ANCHOR CONTRACT. src/render/citizens.js today draws at
 * `Math.round(x) - 3, y - 9`, which is centred and baselined for the 8x10
 * sprite in the current atlas. A 12x16 sprite needs `Math.round(x) - 6,
 * y - 15` to keep the same feet row on the same floor line. That edit belongs
 * to whoever swaps the atlas over; until it lands this sprite would sit 3px
 * left of centre and 6px below the floor. Stated here so the mismatch is a
 * known handoff rather than a surprise — this file cannot make it true.
 */
const HEAD_X = 3;
const TORSO_X = 4;
const SHOULDER_X = 5;

/** One line per role: what the single cue is, and why it survives 12 pixels. */
const ROLE_CUES = {
  base: 'nothing added — the reference character, grey-blue jumpsuit',
  resident:
    'the same person off shift: grey coveralls instead of the working blue. ' +
    'No silhouette cue is added, because being off duty is not a job and ' +
    'should not hand anybody equipment. The whole read is the colour, which ' +
    'is what survives at twelve pixels when an apron does not',
  farmer: 'canvas apron down the front, breaking the jumpsuit silhouette',
  mechanic: 'tool belt at the waist and goggles pushed up above the hairline',
  medic: 'pale coat over the jumpsuit, tails past the hip',
  deputy: 'near-black indigo uniform and a 2x2 amber badge on the chest',
  militia: 'steel plates: a pauldron off the back shoulder, a chest plate',
  child: 'two rows shorter, oversized suit, sleeves past the hands',
  elder: 'grey hair, receding fringe, stooped forward',
  hazmat: 'off-white sealed hood, amber visor, hip canister — no skin shows',
  irradiated: 'sick green pallor and a contamination bloom at the collar',
};

/**
 * Resolve a role and a seed into every colour and dimension the drawing code
 * needs. Seeded variation is colour and hair only: silhouette stays fixed per
 * role so the animation never jitters between frames.
 */
/** Consumer alias, job role, or nonsense -> a role this file can draw. */
function resolveRole(role) {
  if (ROLES.includes(role)) return role;
  if (Object.prototype.hasOwnProperty.call(CONSUMER_ROLES, role)) return CONSUMER_ROLES[role];
  return 'base';
}

/** Over sixty, whatever the job. Both renderers must agree on this. */
function isOld(role, age) {
  return resolveRole(role) === 'elder' || (age != null && age >= 60);
}

/** Under sixteen, whatever the job. */
function isYoung(role, age) {
  return resolveRole(role) === 'child' || (age != null && age < 16);
}

function config(role, seed, { age = null } = {}) {
  const id = resolveRole(role);
  // The role is deliberately NOT in the rng seed. It used to be, which meant
  // two roles asked for the same seed rolled different suit and skin jitter —
  // so the self-test's "this role differs from base" check was satisfied by
  // palette noise before any cue was drawn, and could not tell a missing cue
  // from a present one. Keyed on the seed alone, the same person in a
  // different job is the same person, and a cue has to earn its difference.
  const r = rng(`citizen:${seed}`);
  const vSuit = r();
  const vSkin = r();
  const vHair = r();

  // Three suit tones and three skin tones, so a crowd is not a clone army.
  const jitter = [-0.07, 0, 0.07][Math.floor(vSuit * 3) % 3];
  const skinT = [0.1, 0, -0.13][Math.floor(vSkin * 3) % 3];

  const c = {
    role: id,
    m: METRICS.adult,
    torsoW: 5,
    legW: 2,
    nearHip: SHOULDER_X,
    farHip: TORSO_X,
    stride: 2,
    armExtra: 0,
    headDX: 0,

    // PAL.hair is within a few points of PAL.ink, so used raw it fuses with
    // its own keyline into one black slab. Lifted a tenth toward bone it is
    // still black hair, but the outline reads as an outline.
    hair: tone('hair', 0.12),
    hairLit: tone('hair', 0.34),
    skin: tone('skin', skinT),
    skinLo: tone('skinShade', skinT),
    eye: tone('bone'),
    lid: tone('skinShade', -0.45),

    suit: tone('denim', jitter),
    suitLit: tone('denimLit', jitter),
    suitDark: tone('denimDark', jitter),
    sleeve: tone('denim', jitter + 0.1),

    boot: tone('boot'),
    bootLit: tone('boot', 0.2),
    // The far boot needs its own lit row. Flat boot@-0.08 against a keyline at
    // (18,20,22) is a 1.8 luminance ratio — a near-black rectangle inside a
    // black outline, which at 1:1 is a smudge rather than a foot.
    bootBack: tone('boot', -0.06),
    bootBackLit: tone('boot', 0.1),

    hairStyle: Math.floor(vHair * 3) % 3,
    sealed: false,
  };

  switch (id) {
    // Off shift, and the only thing that says so is the colour.
    //
    // Every other role here earns its difference with a silhouette cue — an
    // apron, a coat, goggles. This one deliberately does not, because "not
    // working" is not a job and should not hand anybody equipment. It is the
    // same person in grey coveralls.
    //
    // Steel rather than a desaturated denim: denim pushed toward grey stays
    // blue enough to be taken for the working suit at sprite size, and the
    // entire point is that a glance across a floor separates the crew from
    // everyone else.
    case 'resident':
      c.suit = tone('steel', jitter - 0.06);
      c.suitLit = tone('steelLit', jitter - 0.06);
      c.suitDark = tone('steelDark', jitter - 0.06);
      c.sleeve = tone('steel', jitter + 0.04);
      break;

    // The working roles carry their unit's colour as well as their cue. At
    // 12x16 on a phone an apron is two pixels and a colour is the whole
    // torso, so the colour is what reads across a floor; the cue is what
    // tells them apart when the player leans in.
    case 'farmer':
      c.apron = true;
      c.suit = tone('verdigris', jitter - 0.18);
      c.suitLit = tone('verdigris', jitter + 0.02);
      c.suitDark = tone('verdigris', jitter - 0.46);
      c.sleeve = tone('verdigris', jitter - 0.08);
      break;

    case 'mechanic':
      c.belt = true;
      c.goggles = true;
      // Sodium at full strength is the lamp colour used all over the rooms
      // behind these sprites, so it is taken well down: dark enough to be a
      // work coverall rather than a light source, warm enough to be nobody
      // else on the floor.
      c.suit = tone('sodium', jitter - 0.22);
      c.suitLit = tone('sodium', jitter - 0.04);
      c.suitDark = tone('sodium', jitter - 0.46);
      c.sleeve = tone('sodium', jitter - 0.14);
      break;

    case 'medic':
      // The sleeve belongs to the coat, not to the jumpsuit under it. The
      // jumpsuit tones stay denim on purpose: they clothe the legs and the
      // collar, which the coat does not cover. What used to be wrong was the
      // arm's cast shadow, which took c.suitDark and so ran a navy stripe down
      // a white coat; that now comes from shadeMap, keyed on the material the
      // shadow actually lands on.
      c.coat = true;
      c.sleeve = tone('bone', -0.16);
      // The far sleeve has to sit below the coat's own shade tone
      // (bone@-0.34) or it disappears into the coat's front edge, which is
      // exactly what the far arm swings past.
      c.sleeveBack = tone('bone', -0.58);
      break;

    case 'deputy':
      // Near-black, but NOT on the neutral grey axis: PAL.concrete (58,64,66)
      // and PAL.lit (90,97,99) are the block coursing of the wall this sprite
      // stands in front of, and deep@0.13 / deep@0.34 landed on top of both of
      // them to within a couple of points. The one role that has to be spotted
      // at a glance was the same colour as the wall. Very dark denimDark keeps
      // him reading as black while the blue channel separates him from the
      // concrete, and the four steps below hold a real 1.4x ramp instead of
      // the 1.16x the greys had.
      c.badge = true;
      c.suit = tone('denimDark', -0.42);
      c.suitLit = tone('denimDark', -0.16);
      c.suitDark = tone('denimDark', -0.64);
      c.sleeve = tone('denimDark', -0.29);
      break;

    case 'militia':
      // Rust, because dark denim made a soldier the hardest figure on the
      // screen to identify. Measured as the mean colour of the torso block,
      // the old militia sat 23 from `base` and 18 from `resident` — a fighter
      // was harder to tell from somebody off shift than an ordinary worker
      // was, which is the exact opposite of what the player needs to see.
      //
      // Rust is the last unused hue in the palette and it is the right one:
      // it is the only warm red here, it reads as danger, and it is nowhere
      // near the greys the walls and machinery are built from. Kept a shade
      // down from full strength so it is webbing and hard-wearing cloth
      // rather than a warning light.
      c.plates = true;
      c.suit = tone('rust', jitter - 0.14);
      c.suitLit = tone('rust', jitter + 0.10);
      c.suitDark = tone('rust', jitter - 0.44);
      c.sleeve = tone('rust', jitter - 0.04);
      break;

    case 'child':
      c.m = METRICS.child;
      c.torsoW = 6;
      // legW stays 2. At 3 the two boots (each a leg wide plus a toe column)
      // spanned 8 of the 12 columns with nothing between them, so the child's
      // feet rendered as one dark mass and the stride was invisible.
      c.farHip = 3;
      c.stride = 1;
      // armExtra stays 0: the hand must stop on the torso's last row. With the
      // extra row it landed exactly on legY, between the two hips, and filled
      // the gap that separates the legs. The oversized-suit read comes from
      // longSleeve instead, which is a cue rather than a collision.
      c.longSleeve = true;
      // Grey, like every other role that is not at a post.
      //
      // `citizenRole` only reaches 'child' and 'elder' *after* the shift
      // check, so both are off-shift roles by construction, and wearing the
      // working denim made them read as crew. That was not a small error:
      // measured on a day-220 silo, 53 of the 93 people inside were children,
      // so the single largest group of non-workers wore the colour that means
      // "working". Lifted from the adult grey so oversized coveralls still
      // read as hand-me-downs.
      c.suit = tone('steel', jitter + 0.08);
      c.suitLit = tone('steelLit', jitter + 0.08);
      c.suitDark = tone('steelDark', jitter + 0.08);
      c.sleeve = tone('steel', jitter + 0.16);
      break;

    case 'elder':
      c.m = METRICS.elder;
      c.headDX = 1;
      // Off shift by construction, like 'child' above — see the note there.
      c.suit = tone('steel', jitter - 0.1);
      c.suitLit = tone('steelLit', jitter - 0.1);
      c.suitDark = tone('steelDark', jitter - 0.1);
      c.sleeve = tone('steel', jitter - 0.02);
      break;

    case 'hazmat':
      // Four tones spread across a real ramp — 98 / 148 / 182 / 217 — instead
      // of the five near-identical bones this used to have, where suit and
      // sleeve differed by a 1.06 luminance ratio and the suit was therefore a
      // flat white slab with no internal form at any size.
      c.sealed = true;
      c.suitLit = tone('bone', 0);
      c.sleeve = tone('bone', -0.16);
      c.suit = tone('bone', -0.32);
      c.suitDark = tone('bone', -0.55);
      c.boot = tone('steelDark');
      c.bootLit = tone('steelDark', 0.24);
      c.bootBack = tone('steelDark', -0.12);
      c.bootBackLit = tone('steelDark', 0.08);
      c.visor = tone('sodium');
      c.visorLit = tone('sodium', 0.4);
      break;

    case 'irradiated':
      // The one role the reserved green is for. It is not a costume: the suit
      // stays denim, and toxin appears only as sickness — a pallor across the
      // face and a contamination bloom at the collar. tone() only opens the
      // toxin gate while this role is being drawn.
      c.sick = true;
      c.skin = tone('toxin', -0.14);
      c.skinLo = tone('toxin', -0.42);
      c.lid = tone('toxin', -0.55);
      c.suit = tone('denim', jitter - 0.14);
      c.suitLit = tone('denimLit', jitter - 0.14);
      c.suitDark = tone('denimDark', jitter - 0.14);
      c.sleeve = tone('denim', jitter - 0.04);
      c.bloom = tone('toxin', 0.18);
      c.bloomLo = tone('toxin', -0.3);
      break;

    default:
      break;
  }

  // Ageing is keyed on the age, not on the job title.
  //
  // The grey used to live inside `case 'elder'` while drawPortrait computed
  // its own `old` from the age and used it for the receding hairline and the
  // wrinkles. The two disagreed: an eighty-year-old farmer got a young man's
  // jet-black hair on a lined, receding face, and a thirty-year-old 'elder'
  // got grey. A silo is full of old farmers, so this was the common case.
  //
  // Grey toward steel, not toward bone. bone@-0.34 is (143,139,131), a 1.21
  // luminance ratio off the skin beside it — hair, face and eye-white became
  // three steps of one warm grey and the shaggy silhouette that IS this
  // character turned into a pale blob. Steel is cool and dark, so it separates
  // from warm skin by hue as well as by value.
  if (isOld(id, age)) {
    c.receding = true;
    c.hair = tone('steel', -0.26);
    c.hairLit = tone('steel', 0.14);
  }

  c.hand = c.sealed ? c.suitDark : c.skin;

  // The far side of the body. Derived from suitDark rather than rolled
  // independently from denimDark: at tone('denimDark', -0.08) the far arm and
  // the torso's own front-edge shade could land one channel apart, because
  // -0.08 is inside the seed jitter's own range, and on those seeds the far
  // limb vanished into the body it was meant to stand clear of.
  c.suitBack = shadeOf(c.suitDark, -0.22);
  // And the far SLEEVE below that again, not off c.sleeve. Derived from the
  // sleeve it came out at denimDark@-0.34 = (68,81,102) against a front edge
  // of denimDark = (63,81,110) — eight points apart — so on the walk frames
  // where the far arm swings out past the front of the body it vanished into
  // the body's own shading. Below the darkest tone on the figure it is
  // legible against both the lit back edge and the shaded front one, which is
  // what lets it go without an internal keyline (see drawFarArm).
  if (!c.sleeveBack) c.sleeveBack = shadeOf(c.suitBack, -0.12);

  // Universal accessories: any role can be injured (rust), and any role can be
  // handed a tool by the work action (steelLit). Everything else is requested
  // by the role that wears it, so the per-render provenance scope stays tight
  // enough for the palette audit to mean something.
  c.rust = tone('rust');
  c.rustLo = tone('rust', -0.25);
  c.steelLit = tone('steelLit');
  if (c.apron) {
    c.canvas = tone('bone', -0.3);
    c.canvasLit = tone('bone', -0.12);
    c.canvasDark = tone('bone', -0.5);
  }
  if (c.goggles || c.plates || c.sealed) {
    c.steel = tone('steel');
    c.steelDark = tone('steelDark');
  }
  if (c.badge || c.belt || c.goggles) c.amber = tone('sodium');

  // Each garment declares how it takes a shadow, so the near arm can cast onto
  // whatever it is actually crossing. Before this the arm always cast
  // c.suitDark, which put a navy stripe down the middle of the medic's white
  // coat — a hue jump to a different material, not a shadow. Role cues add
  // their own entries as they are drawn.
  c.shadeMap = new Map();
  c.shade = (from, to) => { if (from && to) c.shadeMap.set(from.join(','), to); };
  c.shade(c.suit, c.suitDark);
  c.shade(c.suitLit, c.suitDark);
  c.shade(c.suitDark, c.suitBack);
  return c;
}

/**
 * shade() from lib, routed so the result still lands in the provenance map.
 * Used where a tone has to be derived from another derived tone (the far side
 * of a garment) rather than from a PAL key directly.
 */
function shadeOf(c, t) {
  const out = shade(c, t);
  const k = out.join(',');
  const prov = `${USED.get(c.join(',')) ?? 'derived'}~${t}`;
  USED.set(k, prov);
  if (SCOPE) SCOPE.set(k, prov);
  return out;
}

/* ---------------------------------------------------------------- poses -- */

/**
 * A pose is what the frame tables carry:
 *
 *   nl / fl        near and far leg horizontal offset from the hip
 *   nLift / fLift  that boot is off the floor by one row
 *   bob            head and shoulders drop by this many rows and the torso
 *                  squashes to match, so the feet stay planted — a knee bend,
 *                  not a float
 *   arm            near-arm swing; the hand ends this far from the shoulder
 *   drop           extra downward reach of the hand, for the work pump
 *   lean           head pushed forward, for work and for the injured hunch
 *   blink / clutch / tool  one-shot flags
 *
 * WALK. Six frames, one full stride. The two halves are mirror images, which
 * is exactly what makes a naive six-frame cycle collapse — sampling any
 * symmetric curve at six points duplicates frames 1/5 and 2/4. The fix is that
 * a real walk is not symmetric in time: the stance leg travels backwards
 * slowly and stays down, while the swing leg whips forward and is LIFTED. So
 * frames 1 and 5 share leg positions but differ in which boot is off the
 * floor, and the cycle reads as six distinct poses.
 *
 * Frame 5 has the near leg forward and lifted; frame 0 has it forward and
 * planted. That single-row plant is the whole wrap, so 5 leads into 0 with no
 * pop — the same transition as 2 into 3, which is the same event half a stride
 * later.
 */
const WALK = [
  { nl: 2, fl: -2, nLift: 0, fLift: 0, bob: 1, arm: -2, far: 3 },
  { nl: 1, fl: -1, nLift: 0, fLift: 1, bob: 0, arm: -1, far: 2 },
  { nl: -1, fl: 1, nLift: 0, fLift: 1, bob: 0, arm: 1, far: -2 },
  { nl: -2, fl: 2, nLift: 0, fLift: 0, bob: 1, arm: 2, far: -3 },
  { nl: -1, fl: 1, nLift: 1, fLift: 0, bob: 0, arm: 1, far: -2 },
  { nl: 1, fl: -1, nLift: 1, fLift: 0, bob: 0, arm: -1, far: 2 },
];

/**
 * Standing. A breath, a slow nod, and a heavy lid on the way back.
 *
 * The bob is worth about forty of the sprite's hundred and ninety cells,
 * because it translates everything above the hip. An arm swing is worth seven.
 * A cycle built out of both alone therefore reads as a two-frame hop with a
 * pair of near-duplicates hanging off it — measured 40, 8, 44, 7. The fix is a
 * second motion in the same weight class as the bob and out of phase with it:
 * the head leans forward a pixel on the back half, which is a nod, costs about
 * twenty cells, and turns four transitions into two pairs instead of one pair
 * and two stutters.
 *
 * The blink is a lowered lid rather than a closed eye. At four frames anything
 * one-shot is on for a quarter of the cycle, and a quarter-second of shut eye
 * is a squint; a hooded eye at the same duty cycle just reads as breathing.
 */
const IDLE = [
  { nl: 1, fl: -1, bob: 0, arm: 0, lean: 0, far: -3 },
  { nl: 1, fl: -1, bob: 1, arm: 0, lean: 0, far: -3 },
  { nl: 1, fl: -1, bob: 1, arm: -1, lean: 1, far: -4, blink: true },
  { nl: 1, fl: -1, bob: 0, arm: -1, lean: 1, far: -4 },
];

/**
 * At a machine: braced stance, leaning in, near arm pumping a tool.
 *
 * Same problem and same fix as IDLE — it measured 51, 14, 49, 13. The bob and
 * the tool drop are in phase (that pair IS the downstroke), so the lean and
 * the arm swing carry the other two transitions together and every step of the
 * cycle now moves something worth seeing.
 */
const WORK = [
  { nl: 1, fl: -2, bob: 0, arm: 2, drop: 0, lean: 1, far: -3, tool: true },
  { nl: 1, fl: -2, bob: 1, arm: 2, drop: 1, lean: 1, far: -3, tool: true },
  { nl: 1, fl: -2, bob: 1, arm: 1, drop: 1, lean: 2, far: -4, tool: true },
  { nl: 1, fl: -2, bob: 0, arm: 1, drop: 0, lean: 2, far: -4, tool: true },
];

/**
 * A limp. The good leg (near) takes a full step; the bad leg (far) never
 * swings past the body and never fully lifts, so the figure lurches rather
 * than walks. The near arm is clutched across the chest instead of swinging,
 * which is most of the read at this size.
 */
const INJURED = [
  { nl: 2, fl: -1, nLift: 0, fLift: 0, bob: 1, arm: 1, lean: 1, far: -3, clutch: true },
  { nl: 1, fl: -1, nLift: 0, fLift: 1, bob: 0, arm: 1, lean: 1, far: -3, clutch: true },
  { nl: -1, fl: 1, nLift: 0, fLift: 0, bob: 1, arm: 1, lean: 1, far: -4, clutch: true },
  { nl: 0, fl: -1, nLift: 1, fLift: 0, bob: 0, arm: 1, lean: 1, far: -4, clutch: true },
];

/**
 * Two people talking. The whole read is one raised hand and a turned head.
 *
 * A conversation cannot be drawn with a body: at twelve pixels the torso is
 * five columns and it is doing nothing but standing. What it can be drawn with
 * is the hand, which is the one part of this sprite that can leave the
 * silhouette — `drop` is negative here, which lifts the last row of the arm
 * instead of extending it downward the way the work pump does.
 *
 * The gesture is off-beat against the lean on purpose. Both peaking together
 * gave a two-frame nod with two near-duplicates hanging off it, which is the
 * failure IDLE and WORK were both rebuilt to fix. Hand up on 0 and 1, head
 * turned on 1 and 2, so each of the four transitions moves something.
 *
 * The feet never move. People talking shift their weight; they do not walk on
 * the spot, and a stride here read as two people arguing while pacing.
 */
const TALK = [
  { nl: 1, fl: -1, bob: 0, arm: 1, drop: -2, lean: 0, far: -3 },
  { nl: 1, fl: -1, bob: 0, arm: 2, drop: -3, lean: 1, far: -3 },
  { nl: 1, fl: -1, bob: 1, arm: 1, drop: -1, lean: 1, far: -2, blink: true },
  // The hand comes down but not all the way. A true rest frame here rendered
  // pixel-identical to IDLE frame 1 — the cross-action check below caught it —
  // and a conversation that drops into a standing pose for a quarter of its
  // cycle reads as somebody who has stopped listening.
  { nl: 1, fl: -1, bob: 1, arm: 0, drop: -1, lean: 0, far: -2 },
];

/**
 * Braced against something coming through the door.
 *
 * A wide stance with the weight back, the weapon hand forward and level, and
 * the head down behind it. The cycle is a jab: gather on 0, drive on 1, hold
 * on 2, recover on 3 — so the extreme is a single frame and the pose reads as
 * a strike rather than as somebody waving.
 *
 * `tool: true` is what puts the steel in the hand. It is the same flag the
 * work pose uses for a spanner, which is the right economy: at this size the
 * difference between a tool and a weapon is what the body around it is doing.
 *
 * `arm` is capped at 2, which is not a stylistic choice. The hand starts at
 * SHOULDER_X + sw + 1 and is two columns wide, the tool adds a third, and the
 * outer silhouette needs the last column for its keyline — so on a 12-wide
 * sprite anything past 2 puts solid paint on the border. The self-test
 * caught it at arm 3 and 4 on every role that carries a weapon or a long
 * sleeve. The reach in this pose comes from the stance and the lean instead.
 *
 * The far leg is planted well back and never lifts. A fighter who picked a
 * foot up would be dancing, and the one thing this pose has to say is that
 * they are not giving ground.
 */
const FIGHT = [
  { nl: 2, fl: -3, nLift: 0, fLift: 0, bob: 1, arm: 0, drop: -1, lean: 1, far: -4, tool: true },
  { nl: 3, fl: -3, nLift: 0, fLift: 0, bob: 0, arm: 2, drop: -3, lean: 2, far: -4, tool: true },
  { nl: 3, fl: -3, nLift: 0, fLift: 0, bob: 0, arm: 2, drop: -2, lean: 2, far: -3, tool: true },
  { nl: 2, fl: -3, nLift: 0, fLift: 0, bob: 1, arm: 1, drop: -1, lean: 1, far: -3, tool: true },
];

const POSES = { walk: WALK, idle: IDLE, work: WORK, injured: INJURED, talk: TALK, fight: FIGHT };

/* ----------------------------------------------------------------- head -- */

/**
 * Four rows plus a cowlick. The hair is the whole crown plus the back column
 * all the way down to the collar — shaggy, and it is what gives the profile
 * its silhouette. The eye is a 2x2 of bone with one ink pupil, set a column
 * back from the nose so it reads as a profile rather than a face-on stare;
 * at this size it is the single most character-carrying detail in the sprite.
 */
function drawHead(g, c, { dy = 0, dx = 0, blink = false, bandage = false }) {
  // The head is six columns wide and needs a keyline column past the nose, so
  // it cannot start further right than 5. The elder already carries a headDX
  // of 1 for the stoop; without this cap a lean of 2 on top of that would push
  // the nose onto the last column and there would be nowhere for its outline
  // to go — a solid pixel flush against the sprite border, which bleeds into
  // the atlas gutter.
  const x = Math.min(HEAD_X + dx + c.headDX, W - 7);
  const y = c.m.headY + dy;

  if (c.sealed) {
    // Hood: no hair, no skin, an amber visor where the eye would be.
    //
    // The visor is 2x2, not 3x2. At 3x2 it took 6 of the hood's 24 pixels and
    // its keyline took 8 more, which left ten pixels of hood crammed into a
    // two-column strip at the back and turned the whole front-lower quadrant
    // of the head solid black. A window has to be smaller than the thing it is
    // set into, and its keyline is part of its size.
    g.hline(x + 1, y - 1, 4, c.suitLit);
    g.rect(x, y, 6, 4, c.suit);
    g.hline(x, y, 5, c.suitLit);
    g.vline(x, y, 4, c.suitLit);
    g.px(x + 1, y + 1, c.sleeve);
    g.px(x + 2, y + 1, c.sleeve);
    g.vline(x + 5, y + 1, 3, c.suitDark);
    g.hline(x + 1, y + 3, 5, c.suitDark);
    // Inset on the left and below only: the right column is the hood's own
    // silhouette edge and the row above is its lit crown, and inking either
    // spends the hood to draw the window.
    g.stamp(cells()
      .rect(x + 3, y + 1, 2, 2, c.visor)
      .px(x + 3, y + 1, c.visorLit)
      .px(x + 4, y + 2, tone('sodium', -0.35))
      .list, (dx, dy) => dx < 0 || dy > 0);
    return;
  }

  // Cowlick: one or two pixels of hair standing up off the crown.
  g.px(x + 1, y - 1, c.hair);
  if (c.hairStyle !== 1 && !c.receding) g.px(x + 2, y - 1, c.hair);

  // Crown, lit at the upper left.
  g.hline(x, y, 5, c.hair);
  g.hline(x + 1, y, 2, c.hairLit);

  // Fringe row: hair over the back and brow, then the top of the eye.
  g.px(x, y + 1, c.hair);
  g.px(x + 1, y + 1, c.receding ? c.skin : c.hair);
  // `blink` lowers the lid over the top of the eye rather than closing it. A
  // four-frame idle holds any one-shot for a quarter of the cycle, and a
  // quarter of the time with the eye deleted is a squint on the one detail the
  // whole sprite is carried by; hooding it costs two pixels and still reads.
  g.hline(x + 2, y + 1, 2, blink ? c.lid : c.eye);
  g.px(x + 4, y + 1, c.skin);

  // Eye row: pupil set one column back from the nose so it reads as a profile.
  g.px(x, y + 2, c.hair);
  g.px(x + 1, y + 2, c.skin);
  g.px(x + 2, y + 2, c.eye);
  g.px(x + 3, y + 2, PAL.ink);
  g.px(x + 4, y + 2, c.skin);
  g.px(x + 5, y + 2, c.skin); // nose

  // Jaw. The nape hair reaches the collar; the chin catches the shadow.
  g.px(x, y + 3, c.hair);
  g.hline(x + 1, y + 3, 3, c.skin);
  g.px(x + 4, y + 3, c.skinLo);

  if (c.receding) g.px(x + 1, y + 3, c.skinLo); // hollow cheek

  if (c.goggles) {
    // ABOVE the hairline, on the cowlick row, not on the crown.
    //
    // On the crown row this was a disaster: stamp() inks every solid
    // neighbour, and the row below the crown is the fringe row that carries
    // the top of the eye, so the mechanic rendered with a seven-pixel black
    // bar across his head, one white pixel of eye left, and the cowlick inked
    // out too. One row up, the band's neighbours are empty space, so its
    // keyline is drawn by the global pass against the background where it
    // belongs — and the band becomes a silhouette change, which is the kind of
    // cue that survives being twelve pixels wide.
    //
    // It replaces the cowlick rather than fighting it: goggles pushed up onto
    // the forehead would flatten the hair anyway.
    g.stamp(cells()
      .hline(x + 1, y - 1, 3, c.steelDark)
      .px(x + 4, y - 1, c.amber)
      .list, (dx, dy) => dy < 0);
  }

  if (bandage) {
    // Over the back of the skull, where there is nothing but hair to cover.
    //
    // This used to run across row y+1, which is exactly where the eye whites
    // are: the strip overwrote the first white pixel, its keyline inked the
    // second, and the upward keyline took three of the five crown pixels — so
    // the injured frames of every unsealed role had no eye at all, in a sprite
    // whose whole read is the eye. Bone on near-black hair is the highest
    // contrast pair on the figure, so the dressing is far louder back here
    // than it ever was over the face, and it costs nothing.
    g.stamp(cells()
      .hline(x, y, 2, tone('bone', -0.05))
      .px(x, y + 1, tone('bone', -0.28))
      .px(x + 1, y, c.rust)
      .list, (dx, dy) => dx > 0 && dy === 0);
  }
}

/* ---------------------------------------------------------------- torso -- */

/**
 * Five rows of jumpsuit. Lit top and back edge, shaded front edge and waist,
 * and a chest pocket: one ink line for the flap over one dark row for the
 * pouch, which is as small as a pocket can get and still be a pocket.
 */
function drawTorso(g, c, { dy = 0, squash = 0 }) {
  const x = TORSO_X;
  const y = c.m.torsoY + dy;
  const h = Math.max(2, c.m.torsoH - squash);
  const w = c.torsoW;

  g.rect(x, y, w, h, c.suit);
  g.hline(x, y, w, c.suitLit);
  g.vline(x, y, h, c.suitLit);
  g.vline(x + w - 1, y + 1, h - 1, c.suitDark);
  g.hline(x, y + h - 1, w, c.suitDark);

  if (!c.sealed && h >= 4) {
    // Chest pocket, at the two front columns. It used to start at x+w-3, which
    // for every adult role is the exact column drawArm's cast shadow lands in,
    // so half the flap was painted over on every frame and the pouch was the
    // same suitDark as the shadow beside it and the front edge past it — three
    // identical dark pixels in a row, which is not a pocket, it is a dark half.
    //
    // A dark flap line over a pouch that stands PROUD of the front edge. The
    // pouch used to be one lit pixel with the front-edge shade beside it, so
    // the whole pocket was a line with a dot under it; giving it both columns
    // and interrupting the edge shade for one row is what makes it read as a
    // thing hanging off the chest rather than as a nick in the outline.
    g.hline(x + w - 2, y + 1, 2, PAL.ink);
    g.px(x + w - 2, y + 2, c.suitLit);
    g.px(x + w - 1, y + 2, c.suit);
  }

  // The neck seal. The air tank that goes with it is a role cue and is drawn
  // in drawRoleCue, because everything here runs BEFORE the far arm: hung off
  // the back from inside drawTorso, the tank sat in exactly the column the far
  // arm snaps to and was overpainted by it on every standing frame.
  if (c.sealed) g.hline(x, y, w, c.suitDark);

  if (c.sick) {
    // Contamination at the collar, where a suit would be sealed and is not.
    // Two pixels, but toxin green against denim is the largest hue jump on the
    // sprite, and the pallor on the face is carrying the read anyway.
    g.over(x + w - 2, y, c.bloom);
    g.over(x + w - 1, y + 1, c.bloomLo);
  }
}

/* ----------------------------------------------------------------- limbs -- */

/**
 * The near arm. The shoulder stays put and the hand carries the swing, so the
 * arm bends rather than slides across the body.
 */
function drawArm(g, c, { dy = 0, squash = 0, sw = 0, drop = 0, clutch = false, tool = false }) {
  const y = c.m.torsoY + dy;
  const len = Math.max(2, c.m.torsoH - squash - 1 + c.armExtra);
  const front = TORSO_X + c.torsoW - 1;
  const cl = cells();
  // The arm keylines DOWNWARD against the torso and stops ABOVE the waist row.
  // Asking stamp() for "dy > 0" alone was the wrong question twice over. The
  // hand ends on the torso's last row, so its downward neighbour is legY and
  // METRICS gives the leg two rows — on the child, whose hand reaches the hem
  // on every frame, that inked the whole near thigh out and the boots hung
  // under a black bar. And the waist row itself is where a garment puts its
  // hem, so the injured clutch, which folds one row above it, took the
  // farmer's apron hem with it on every squashed frame.
  const waist = y + Math.max(2, c.m.torsoH - squash) - 1;
  const onBody = (dx, dy2, nx, ny) => dy2 > 0 && ny < waist;

  // A shadow lands on whatever it is cast onto. Looking the surface up in
  // shadeMap rather than reaching for c.suitDark is what stops the medic's arm
  // painting a navy stripe down the middle of a white coat.
  const castShadow = (list) => {
    for (const [sx, sy] of list) {
      const under = g.at(sx, sy);
      if (!under) continue;
      g.px(sx, sy, c.shadeMap.get(under.join(',')) || c.suitDark);
    }
  };

  if (clutch) {
    // Folded across the chest, hand over the wound.
    //
    // It used to reach backwards: the forearm ran from SHOULDER_X-1 and the
    // hand sat at SHOULDER_X-2, one column BEHIND the torso's rear edge, while
    // drawWound bled from the front edge. The figure was clutching its own
    // back and the hand was a lone skin nub off the back of the silhouette.
    // Forward, it lands on the blood, which is the only place a clutch means
    // anything.
    //
    // The downward-only predicate matters as much as the direction: an
    // unrestricted stamp here inked (SHOULDER_X, y) and (SHOULDER_X+1, y),
    // taking a two-pixel black bite out of the middle of the lit shoulder.
    cl.px(SHOULDER_X, y + 1, c.sleeve);
    cl.px(SHOULDER_X + 1, y + 2, c.sleeve);
    cl.rect(Math.min(SHOULDER_X + 2, front - 1), y + 2, 2, 1, c.hand);
    g.stamp(cl.list, onBody);
    castShadow([[SHOULDER_X + 1, y + 1]]);
    return;
  }

  // The sleeve is one pixel wide and the hand is two. A two-pixel sleeve with
  // an ink keyline down each side spends four of the torso's five columns and
  // turns the body into a dark stripe, so the arm separates from the torso by
  // the shadow it casts rather than by an outline. The outer silhouette still
  // gets its keyline from the global pass, which is where the rule matters.
  const hand = SHOULDER_X + sw + (sw > 0 ? 1 : 0);
  const shadow = [];
  for (let i = 1; i <= len; i++) {
    const t = len > 1 ? (i - 1) / (len - 1) : 1;
    const cx = SHOULDER_X + Math.round((hand - SHOULDER_X) * t);
    const row = y + i + (i === len ? drop : 0);
    if (i === len) {
      // Hand. An oversized suit swallows it and leaves one knuckle showing —
      // forward, on the same row, not a row down. A row down put the child's
      // knuckle on the boot line as a lone skin pixel between the two feet.
      if (c.longSleeve) {
        cl.rect(cx, row, 2, 1, c.sleeve);
        cl.px(cx + 2, row, c.hand);
      } else {
        cl.rect(cx, row, 2, 1, c.hand);
      }
      if (tool) cl.vline(cx + 2, row - 1, 2, c.steelLit);
    } else {
      cl.px(cx, row, c.sleeve);
      shadow.push([cx + 1, row]);
    }
  }
  g.stamp(cl.list, onBody);
  castShadow(shadow);
}

/**
 * The far arm: a dark column on the far side of the body, swinging opposite to
 * the near one.
 *
 * It used to be drawn before the torso at exactly `SHOULDER_X + 1 + sw`, which
 * meant two things went wrong at once. It was overpainted by the torso in
 * twenty of the twenty-two standing frames — every idle, work and injured
 * frame had `far` small enough to land under the body, so those citizens were
 * one-armed and the column was pure waste. And on the two walk frames where it
 * did show it was laid down with a raw vline, so it got no keyline against the
 * torso it abutted; with c.suitBack rolled independently of c.suitDark the two
 * could come out a single channel apart and the limb simply vanished.
 *
 * Now the column is snapped clear of the torso instead of allowed to hide
 * under it, and c.sleeveBack is derived from c.suitBack — below the darkest
 * tone anywhere on the body — so the two sides of one garment cannot collide
 * by construction.
 *
 * It is the one part of the figure that does NOT lay an internal keyline, and
 * that is deliberate. Being snapped clear, its only solid neighbour is the
 * torso: at the back that is the jumpsuit's lit edge, which is the single
 * brightest column the body has, and inking it to draw a boundary that a 1.7
 * luminance step already draws costs four pixels of form on every frame to buy
 * nothing. The rule this file enforces is that no solid meets EMPTY space
 * without a keyline; two adjacent parts of one figure may separate by value,
 * and here they must.
 */
function drawFarArm(g, c, { dy = 0, squash = 0, sw = 0 }) {
  const y = c.m.torsoY + dy;
  const len = Math.max(2, c.m.torsoH - squash - 1 + c.armExtra);
  const back = TORSO_X - 1;
  const fwd = TORSO_X + c.torsoW;
  const raw = SHOULDER_X + 1 + sw;
  const col = raw <= back || raw >= fwd ? raw : (sw <= 0 ? back : fwd);
  g.stamp(cells()
    .vline(col, y + 1, len, c.sleeveBack)
    .px(col, y + len, c.suitBack)
    .list, () => false);
}

/**
 * One leg. The thigh follows the hip and the shin follows the foot, which at
 * two rows is all the articulation there is room for but is enough to read as
 * a bend rather than a slide. The boot is one column wider than the leg, with
 * the extra column forward, so it reads as a toe.
 */
function drawLeg(g, c, { off = 0, lift = 0, near = true }) {
  const lw = c.legW;
  const hip = near ? c.nearHip : c.farHip;
  const kx = hip + Math.sign(off);
  const fx = hip + off;
  const top = c.m.legY;
  const bootY = c.m.bootY - lift;

  const body = near ? c.suit : c.suitBack;
  const seam = near ? c.suitDark : c.suitBack;
  const boot = near ? c.boot : c.bootBack;
  // The far boot gets its own lit row. Flat bootBack is a 1.8 luminance ratio
  // against the keyline around it — a near-black rectangle inside a black
  // outline, which at 1:1 is a smudge and not a foot.
  const bootLit = near ? c.bootLit : c.bootBackLit;

  const cl = cells();
  cl.rect(kx, top, lw, 1, body);
  cl.px(kx + lw - 1, top, seam);
  const shin = bootY - top - 1;
  if (shin > 0) {
    cl.rect(fx, top + 1, lw, shin, body);
    cl.vline(fx + lw - 1, top + 1, shin, seam);
  }
  // An ankle and a sole, not a block.
  //
  // Both rows used to be `lw + 1` wide, so each boot was a 3x2 slab and the
  // two of them took six of the sprite's twelve columns in near-black. On a
  // figure whose leg is only four rows tall that made the foot half the leg,
  // and the global keyline pass then outlined the slab, which added a column
  // of ink on each side of it. The read was a person standing in two bricks.
  //
  // Narrowing the upper row to the width of the leg leaves the toe on the
  // sole where a toe belongs, and turns the silhouette from a rectangle into
  // an L. Same two rows, so the far boot keeps the lit row it needs to not be
  // a smudge, and the stride is unaffected — the width that reads as a foot
  // in profile is the sole, and that has not changed.
  cl.rect(fx, bootY, lw, 1, bootLit);
  cl.rect(fx, bootY + 1, lw + 1, 1, boot);
  // Never keyline downward. Nothing is ever under a leg except the floor,
  // which the global pass outlines, or the OTHER leg — and on the frame where
  // the near foot lifts off the far one, a downward keyline is laid straight
  // across the far boot's only visible row. That frame rendered as a single
  // boot sitting on a solid black bar.
  g.stamp(cl.list, (dx, dy) => dy <= 0);
}

/* ------------------------------------------------------------ role cues -- */

/** The one thing that makes each role that role, laid over the finished body. */
function drawRoleCue(g, c, { dy = 0, squash = 0 }) {
  const x = TORSO_X;
  const y = c.m.torsoY + dy;
  const h = Math.max(2, c.m.torsoH - squash);
  const w = c.torsoW;

  // Two rules bound every cue below, and they are the two rows the figure can
  // least afford to lose.
  //
  // DOWN is legY. METRICS gives the leg two rows at most, so a garment that
  // spends one of them on its own hem severs the body from the boots.
  //
  // UP, for anything worn on the chest, is the torso's lit top row — the one
  // bright row the body has and the thing that makes it read as a shoulder
  // rather than a plank. A 2x2 fitting that keylines upward puts a black bar
  // across it; the militia plate and the deputy badge both did, and between
  // them and the arm the militia's chest was three ink pixels wide.
  //
  // A cue that covers the WHOLE torso has no internal boundary to draw at all
  // and passes no-ink: its only solid neighbour is the far arm behind it, and
  // inking that deletes the limb to outline a garment the global keyline pass
  // is already going to outline.
  const notDown = (dx, dy) => dy <= 0;
  const sideways = (dx, dy) => dy === 0;
  const noInk = () => false;

  if (c.apron) {
    // Bib and skirt down the front.
    //
    // It used to span cols 6-8 and run a row past the hip. Col 6 is the near
    // arm's guaranteed shadow column, so the lit left edge — the only thing
    // giving a 3px strip a light direction — was overpainted on every single
    // frame, and the apron rendered as a flat two-column sheet of paper. The
    // overhanging row then keylined into the thigh and took the near leg with
    // it. Moved forward to cols 7-8 the highlight is outside the arm's
    // footprint, and the hem now lands on the waist.
    //
    // Lit left column, shaded HEM — not a shaded right column. Two pixels wide
    // is not enough for a lit face, a body and a shaded face: lighting the
    // left and shading the right left no canvas in between, so the apron had
    // three tones and no material. Shading the bottom face instead keeps the
    // light coming from the upper left and gives the strip a middle.
    const ax = x + w - 2;
    g.stamp(cells()
      .rect(ax, y, 2, h, c.canvas)
      .hline(ax, y, 2, c.canvasLit)
      .vline(ax, y + 1, h - 2, c.canvasLit)
      .hline(ax, y + h - 1, 2, c.canvasDark)
      .list, notDown);
    c.shade(c.canvas, c.canvasDark);
    c.shade(c.canvasLit, c.canvas);
  }

  if (c.coat) {
    // Pale coat over the jumpsuit, with the jumpsuit showing at the collar.
    //
    // The coat used to be drawn `h + 1` rows tall so its tails hung past the
    // hip. Its stamp then keylined the row below across the full torso width,
    // which put a solid 6-8px ink bar on legY in every medic frame — the legs
    // were severed from the body and two of the six frames were 100% ink
    // across that row. A coat cannot hang past a hip that only has two rows of
    // leg beneath it; the waist shading carries the hem instead.
    const coat = tone('bone', -0.1);
    const coatLit = tone('bone', 0);
    const coatEdge = tone('bone', -0.34);
    g.stamp(cells()
      .rect(x, y, w, h, coat)
      .hline(x, y, w, coatLit)
      .vline(x, y, h, coatLit)
      .vline(x + w - 1, y + 1, h - 1, coatEdge)
      .hline(x, y + h - 1, w, coatEdge)
      .hline(x + w - 3, y, 2, c.suitDark)
      .px(x + w - 2, y + 1, c.suitDark)
      .list, noInk);
    c.shade(coat, coatEdge);
    c.shade(coatLit, coatEdge);
  }

  if (c.belt) {
    // One row up from the hem, so the keyline lands on torso rather than leg,
    // and inset to the columns the hand never occupies. On the hem it inked
    // the whole of legY and the hand punched two skin pixels through its
    // middle — a dashed line with a hole in it, not a belt.
    g.stamp(cells()
      .hline(x, y + h - 2, w, tone('rust', -0.15))
      .px(x + w - 1, y + h - 2, c.amber)
      .list, (dx, dy) => dy < 0);
  }

  if (c.badge) {
    // 2x2, inboard of the silhouette. A single stamped pixel is always
    // self-defeating: stamp() inks all four of its neighbours, so a 1px badge
    // digs its own black hole and then sits in it, and at the 0.98x draw scale
    // the game actually uses it is gone entirely.
    //
    // No keyline of its own: saturated amber on a uniform four steps off black
    // is the largest value jump anywhere on this citizen, and an ink outline
    // around it would be invisible against the uniform and would cost the lit
    // shoulder row above.
    g.stamp(cells()
      .rect(x + w - 2, y + 1, 2, 2, c.amber)
      .px(x + w - 2, y + 1, tone('sodium', 0.35))
      .px(x + w - 1, y + 2, tone('sodium', -0.35))
      .list, noInk);
  }

  if (c.plates) {
    // The pauldron hangs off the BACK shoulder, outside the torso, where no
    // arm can reach it — that is a silhouette change and it survives. Steel on
    // denim is only a 1.03 luminance step, so this one does need its keyline
    // against the body; sideways only, so it takes the boundary and not the
    // shoulder.
    g.stamp(cells()
      .rect(x - 2, y, 2, 3, c.steel)
      .hline(x - 2, y, 2, c.steelLit)
      .px(x - 2, y + 2, c.steelDark)
      .list, sideways);
    // The chest plate is inset to the two front columns for the same reason
    // the pocket is: the arm owns the two behind them, and a plate drawn
    // across them lost half its pixels every frame and left a lone saturated
    // rust dot that read as a stuck pixel. It carries its own rust as a 2px
    // edge instead of a 1px accent.
    g.stamp(cells()
      .rect(x + w - 2, y + 1, 2, 2, c.steel)
      .hline(x + w - 2, y + 1, 2, c.steelLit)
      .hline(x + w - 2, y + 2, 2, c.rust)
      .list, sideways);
    c.shade(c.steel, c.steelDark);
    c.shade(c.steelLit, c.steel);
  }

  if (c.sealed) {
    // The air tank, off the BACK of the suit and outside the torso, where
    // nothing on the figure can overwrite it and it changes the silhouette —
    // the only kind of cue that reads at this size. It used to be a 2x2 filter
    // on the chest at cols 5-6, the arm's sleeve and shadow columns, and
    // survived as one pixel in two of six walk frames.
    //
    // No keyline into the body: steel against the hood-white suit is a two-to-
    // one value step and the tank's outer edge is silhouette, which the global
    // pass outlines.
    g.stamp(cells()
      .rect(x - 2, y + 1, 2, h - 1, c.steel)
      .vline(x - 2, y + 1, h - 1, c.steelLit)
      .hline(x - 2, y + h - 1, 2, c.steelDark)
      .list, noInk);
    c.shade(c.steel, c.steelDark);
    c.shade(c.steelLit, c.steel);
  }
}

/** Wound dressing, added by the injured action whatever the role is. */
function drawWound(g, c, { dy = 0, squash = 0 }) {
  const y = c.m.torsoY + dy;
  const h = Math.max(2, c.m.torsoH - squash);
  const fx = TORSO_X + c.torsoW - 1;
  // Down the front edge at chest height, which is where the clutching hand
  // lands. Drawn before the arm so the hand covers the top of it and the blood
  // shows past the fingers, rather than the arm and the wound being on
  // opposite sides of the body as they used to be.
  //
  // over(), not stamp(): a stain is not an object and has no outline. Stamped,
  // its keyline reached sideways and upward into whatever it was bleeding
  // through — on the farmer that was the apron, and three of the apron's eight
  // visible pixels went black to draw a border around two pixels of blood.
  g.over(fx, y + 1, c.rust);
  g.over(fx, y + 2, c.rustLo);
  g.over(fx - 1, Math.min(y + 3, y + h - 1), c.rustLo);
}

/* ------------------------------------------------------------ assembly -- */

/**
 * Back to front for a right-facing side view: far arm, far leg, near leg,
 * torso over the hips, near arm over the torso, head, then the role cue.
 */
function drawBody(g, c, pose, action) {
  const bob = pose.bob | 0;
  const lean = pose.lean | 0;
  const bandage = action === 'injured';

  // Feet. Halfway through a stride the swing foot passes the stance foot, and
  // in a side view the far one goes BEHIND: it should be occluded, cleanly.
  // The two hips are a column apart, so at the passing pose the boots landed
  // one column apart — and the near boot, drawn second, covered all of the far
  // one except a single pixel, which at 1:1 is a speck of dirt beside a foot.
  // Snapped flush, the far leg hides behind the near one and the pose reads as
  // a pass. Only the column is snapped, never the lift: with both matched the
  // two passing frames of the walk would be identical.
  const nearOff = strideOf(c, pose.nl);
  let farOff = strideOf(c, pose.fl);
  if (Math.abs((c.nearHip + nearOff) - (c.farHip + farOff)) < c.legW + 1) {
    farOff = c.nearHip + nearOff - c.farHip;
  }

  drawLeg(g, c, { off: farOff, lift: pose.fLift | 0, near: false });
  drawLeg(g, c, { off: nearOff, lift: pose.nLift | 0, near: true });
  drawTorso(g, c, { dy: bob, squash: bob });
  // The far arm goes on AFTER the torso, not before it: snapped clear of the
  // body rather than allowed to hide under it, there is nothing left for the
  // torso to occlude, and it was being overpainted in twenty of the twenty-two
  // standing frames when it went first.
  drawFarArm(g, c, { dy: bob, squash: bob, sw: pose.far | 0 });
  // The role cue is worn on the torso, so it goes on before the arm: a coat
  // drawn last would swallow the arm swing and the idle frames would collapse
  // into each other.
  drawRoleCue(g, c, { dy: bob, squash: bob });
  if (bandage) drawWound(g, c, { dy: bob, squash: bob });
  drawArm(g, c, {
    dy: bob,
    squash: bob,
    sw: pose.arm | 0,
    drop: pose.drop | 0,
    clutch: !!pose.clutch,
    tool: !!pose.tool && !c.sealed,
  });
  // NO shoulder restore here, deliberately.
  //
  // There used to be a `g.over(SHOULDER_X + i, torsoY + bob, c.suitLit)` pair
  // guarded by `if (!pose.clutch)`, to repair a keyline the arm was said to
  // cut through the shoulder highlight. It was wrong twice over. The swinging
  // arm stamps with dy > 0 and cannot ink upward at all, so on every pose the
  // guard admitted the repair was a no-op; the one pose that DID ink the
  // shoulder was the clutch, which the guard excluded. And because it wrote
  // c.suitLit unconditionally it assumed the shoulder was bare jumpsuit — so
  // on the four roles wearing something there it punched denim through a bone
  // coat, broke the militia pauldron's lit edge, and put two raw white pixels
  // in the middle of the hazmat neck seal. The clutch now carries the same
  // downward-only predicate as the swing, which removes the artifact at its
  // source, and no role has its garment overwritten to pay for it.
  drawHead(g, c, { dy: bob, dx: lean, blink: !!pose.blink, bandage });
}

/** Child legs are wide and short, so their stride is halved to stay in frame. */
function strideOf(c, off) {
  const v = off | 0;
  if (c.stride >= 2) return v;
  return Math.sign(v) * Math.min(Math.abs(v), c.stride);
}

/**
 * Asleep: curled on the right side, head to the left, knees drawn up because
 * a stretched-out adult is sixteen pixels long and the sprite is twelve. Two
 * frames, and the only thing that moves is the chest.
 *
 * The body still bottoms out on the same row as a standing citizen, so a
 * sleeper drawn at the normal anchor lies on the floor rather than in it.
 *
 * THE LESSON THIS SPRITE WAS REBUILT AROUND. Lying down, everything is
 * horizontal and everything is adjacent: the head touches the shoulder, the
 * arm lies along the chest, the knee folds over the hip. The first version
 * stamped all of them at full width with no allowInk, and stamp() inks every
 * solid neighbour — so the arm alone put an ink bar across the whole row above
 * it AND the whole row below it, and in a body four rows deep that left two.
 * Every sleeping citizen rendered as a black slab with a boot.
 *
 * So the geometry changed before the code did, and nothing here draws an
 * interior keyline at all. The head no longer overlaps the shoulder, it butts
 * against it, and the global pass outlines that boundary for free. The arm
 * lies in a row the torso has already shaded, so a value step tells it apart.
 * The folded leg is painted in the far side's tones, which is what it is. Four
 * rows of body cannot afford a single line drawn inside them, so none is.
 */
function drawSleeper(g, c, f) {
  // A child sleeps like a child: shorter along the floor, same size head.
  // drawSleeper used to hard-code adult geometry and never call drawRoleCue,
  // so every role collapsed into two silhouettes the moment a citizen lay
  // down — a sleeping child was pixel-for-pixel a sleeping adult apart from
  // the seeded suit tone, which is the one role whose entire cue is its
  // proportions.
  const small = c.m === METRICS.child;
  const breath = f === 1 ? 1 : 0;

  // Head 1..4, torso 5..bodyR, folded legs off the end of it. The child keeps
  // the adult's head at full size and loses length off the body, so lying down
  // its head is a bigger share of the figure exactly as it is standing. Depth
  // is NOT what shrinks: four rows is already the minimum that carries lit /
  // shadowed / body / floor, and at three the child's torso would hold no
  // jumpsuit colour at all — the same bodyless-torso failure METRICS.child
  // exists to avoid.
  const headX = 1;
  const bodyX = 5;
  const bodyR = small ? 8 : 9;
  const bodyW = bodyR - bodyX + 1;
  const rest = 11;
  // The chest rises a row on frame 1 and the arm rides up with it. The floor
  // row never moves, and neither does the head: a sleeper who bobbed would be
  // levitating, and a head that breathed would be nodding.
  const top = rest - breath;
  const headY = rest - 3;
  const armY = top + 1;

  // ---- torso, lying on its side, shoulder to hip -------------------------
  //
  // Four values top to bottom — lit, shadowed, body, floor — because the whole
  // sprite is horizontal bands and the bands are the only modelling there is.
  // The row the arm lies in is shaded across its full width, so the arm reads
  // as a lighter thing lying IN the chest's under-curve rather than needing a
  // keyline to be told apart from it.
  g.rect(bodyX, top, bodyW, 15 - top, c.suit);
  g.hline(bodyX, top, bodyW, c.suitLit);      // the up-facing side takes light
  g.hline(bodyX, armY, bodyW, c.suitDark);
  g.hline(bodyX, 14, bodyW, c.suitDark);      // the floor-facing side

  // ---- knees drawn up, on the FAR side of the body -----------------------
  //
  // Far-side tones rather than an ink crease. The fold lies along the torso
  // for its whole length, and a keyline between two parts of one body four
  // rows deep spends more than it buys — worse, it lands in the columns the
  // arm needs. c.suitBack is two steps below c.suit by construction, so the
  // leg reads as depth instead of as a seam, and the boot follows it onto the
  // far-side boot tones for the same reason.
  //
  // The fold ends at kneeX+2, which is col 10 on an adult, leaving col 11 free
  // for its outline. These used to run to col 11 itself, which put unkeylined
  // solids flush against the frame and bled them into the atlas gutter.
  const kneeX = bodyR - 1;
    g.stamp(cells()
      .rect(kneeX, 12, 3, 3, c.suitBack)
      .hline(kneeX, 12, 3, c.suitDark)
      .list, () => false);
    g.stamp(cells()
      .rect(kneeX + 1, 13, 2, 1, c.bootBackLit)
      .rect(kneeX + 1, 14, 2, 1, c.bootBack)
      .list, () => false);


  // ---- the arm laid along the chest --------------------------------------
  //
  // No keyline anywhere: it lies in the shaded row drawn above, and sleeve on
  // suitDark is a value step the whole length of it. Outlining a three-pixel
  // arm inside a four-row body spends the body to draw the arm. Stamped after
  // the fold so the hand rests on the knee rather than under it.
  const armLen = bodyR - bodyX - 2;
  g.stamp(cells()
    .hline(bodyX + 1, armY, armLen, c.sleeve)
    .px(bodyX + 1 + armLen, armY, c.hand)
    .list, () => false);

  drawSleeperCue(g, c, { bodyX, bodyR, top, armY });

  if (c.sealed) {
    // The hood, same footprint as the head, with the visor turned up. Its
    // keyline goes on the inboard side only — below it is the hood's own dark
    // bottom row and to the right is the silhouette, and inking either spends
    // a quarter of a four-by-four hood to draw a two-by-two window.
    g.rect(headX, headY, 4, 4, c.suit);
    g.hline(headX, headY, 4, c.suitLit);
    g.vline(headX, headY, 4, c.suitLit);
    g.hline(headX, headY + 3, 4, c.suitDark);
    g.stamp(cells()
      .rect(headX + 2, headY + 1, 2, 2, c.visor)
      .px(headX + 2, headY + 1, c.visorLit)
      .list, (dx) => dx < 0);
    return;
  }

  // ---- head on the pillow -------------------------------------------------
  //
  // The hair mass takes the weight at the back, the face turns up and forward,
  // the eye is one closed lid line. Nothing else fits and nothing else is
  // needed: a horizontal figure with a black mass at one end reads as asleep.
  // Plain-drawn, because the head no longer overlaps anything — it sits in its
  // own four columns and the global keyline pass outlines it.
  g.rect(headX, headY, 4, 4, c.hair);
  g.hline(headX + 1, headY, 2, c.hairLit);
  g.px(headX, headY + 1, c.hairLit);
  g.px(headX + 3, headY + 1, c.skin);        // brow
  g.hline(headX + 2, headY + 2, 2, c.skin);  // cheek and nose
  g.px(headX + 2, headY + 2, c.lid);         // the closed eye
  g.px(headX + 3, headY + 3, c.skinLo);      // jaw, in shadow
  g.px(headX + 2, headY + 3, c.skin);        // chin catching the light
}

/**
 * The role cue, laid along a horizontal body. Short, because a sleeper is
 * mostly torso and the cue only has to say which of nine people this is.
 *
 * All of these are stampOn(), which clips to what is already solid — a cue may
 * recolour the sleeper but may never change his outline, or two roles asleep
 * would have different bodies. And none of them keylines: the body is four
 * rows deep, so a cue that outlines itself top and bottom IS the body. They
 * separate from the jumpsuit by material instead, which is what they are.
 */
function drawSleeperCue(g, c, { bodyX, bodyR, top, armY }) {
  // The chest, which is everything from the shoulder up to the leg fold. The
  // fold owns bodyR-1 onward, so a garment that reaches the hip covers the
  // boots — the sleeping farmer's apron did exactly that, and he had no feet.
  const chest = bodyR - 2 - bodyX + 1;

  if (c.coat) {
    // The coat runs one column further than the rest, over the top of the
    // folded knee, because tails hanging over drawn-up legs is what a coat
    // looks like on someone curled up.
    const coat = tone('bone', -0.1);
    g.stampOn(cells()
      .rect(bodyX, top, chest + 1, 15 - top, coat)
      .hline(bodyX, top, chest + 1, tone('bone', 0))
      .hline(bodyX, 14, chest + 1, tone('bone', -0.34))
      .hline(bodyX + 1, armY, chest - 1, tone('bone', -0.16))
      .list, () => false);
  }
  if (c.apron) {
    g.stampOn(cells()
      .rect(bodyX + 1, top, chest - 1, 15 - top, c.canvas)
      .hline(bodyX + 1, top, chest - 1, c.canvasLit)
      .hline(bodyX + 1, 14, chest - 1, c.canvasDark)
      .list, () => false);
  }
  if (c.plates) {
    // Chest plate still on, because the militia sleep in their kit.
    g.stampOn(cells()
      .rect(bodyX, top, 2, 14 - top, c.steel)
      .hline(bodyX, top, 2, c.steelLit)
      .px(bodyX + 1, armY, c.rust)
      .list, () => false);
  }
  if (c.belt) {
    g.stampOn(cells()
      .hline(bodyX + 1, 13, chest - 1, tone('rust', -0.15))
      .px(bodyX + 1, 13, c.amber)
      .list, () => false);
  }
  if (c.badge) {
    // Two amber pixels over one shaded one, on the shoulder. Three tones,
    // because the deputy's other cue — a near-black uniform — is a recolour,
    // and a recolour is not a cue: asleep every role is a horizontal bar, so
    // the badge is the only thing saying which bar this is.
    g.stampOn(cells()
      .rect(bodyX, top, 2, 2, c.amber)
      .px(bodyX, top, tone('sodium', 0.35))
      .px(bodyX + 1, top + 1, tone('sodium', -0.35))
      .list, () => false);
  }
  if (c.sick) {
    g.over(bodyX, top, c.bloom);
    g.over(bodyX + 1, top + 1, c.bloomLo);
  }
}

/* -------------------------------------------------------------- citizen -- */

function isFlipped(facing) {
  return facing === -1 || facing === 'left' || facing === 'l' || facing === false;
}

/**
 * Draw one citizen frame onto a 12x16 painter from lib.mjs.
 *
 * Unknown roles fall back to 'base' and unknown actions to 'walk' rather than
 * throwing: this is called in a loop over generated name lists, and a typo
 * that produces a plain worker is easier to spot in the contact sheet than a
 * build that dies halfway through the atlas.
 */
export function drawCitizen(p, {
  frame = 0, action = 'walk', role = 'base', seed = '', facing = 1, age = null,
} = {}) {
  const act = ACTIONS[action] ? action : 'walk';
  const n = ACTIONS[act];
  const f = (((frame | 0) % n) + n) % n;

  const [, sc] = scoped(role, () => {
    // age is threaded through so the sprite and the card agree about whether
    // this person is old. drawCitizen used to ignore it entirely.
    const c = config(role, seed, { age });
    const g = grid(W, H);
    if (act === 'sleep') drawSleeper(g, c, f);
    else drawBody(g, c, POSES[act][f], act);
    g.keyline(PAL.ink);
    g.blit(p, isFlipped(facing));
  });
  LAST_SCOPE = sc;
  return p;
}

/**
 * The four-frame walk the current consumer samples, and the two-frame work.
 *
 * sprites.js asks for walk0..3 and work0..1. Handing it frames 0..3 of a
 * six-frame stride would wrap 3 -> 0 across half a step and pop, which is the
 * exact failure the six-frame table was built to avoid. These maps pick phases
 * that close instead: the four-frame walk is contact / passing / contact /
 * passing with the lifts alternating, and the two-frame work is the top and
 * the bottom of the stroke.
 */
const FRAME_MAP = {
  walk: { 4: [0, 1, 3, 4] },
  work: { 2: [0, 2] },
  idle: { 2: [0, 2] },
};

/** Resolve (action, frame, frameCount) to an index into this file's tables. */
export function frameIndex(action, frame, count) {
  const act = ACTIONS[action] ? action : 'walk';
  const n = ACTIONS[act];
  const map = FRAME_MAP[act] && FRAME_MAP[act][count];
  if (!map) return (((frame | 0) % n) + n) % n;
  return map[(((frame | 0) % map.length) + map.length) % map.length];
}

/* ------------------------------------------------------------- portrait -- */

/** Head silhouette, one [x0, x1] span per row from PORTRAIT_HEAD_TOP down. */
const PORTRAIT_HEAD_TOP = 5;
const HEAD_SPANS = [
  [12, 19], [10, 21], [9, 22], [9, 22], [9, 22], [9, 22], [9, 22], [9, 22],
  [9, 22], [9, 22], [9, 22], [9, 22], [10, 21], [10, 21], [11, 20], [12, 19],
  [13, 18],
];

/** Shoulder silhouette, one span per row from row 25 down. */
const SHOULDER_SPANS = [
  [12, 19], [9, 22], [7, 24], [5, 26], [4, 27], [3, 28], [3, 28], [3, 28],
  [3, 28],
];

const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

/**
 * 32x32 head and shoulders, front on, for the citizen card at 3x.
 *
 * Front on rather than in profile because a card wants a person looking back
 * at you, and because 32 pixels is enough for two eyes — which is the whole
 * reason to have a portrait renderer separate from the 12x16 sprite at all.
 * Everything else is the same character: the cowlick, the shaggy black hair,
 * the pale skin, the large mostly-white eyes, the jumpsuit collar.
 *
 * age and gender only move hair and proportion. Under 16 gets a bigger head
 * on smaller shoulders; over 60 greys and recedes the hair and adds the two
 * lines that read as age at this size. gender lengthens or shortens the side
 * hair and nothing else — the reference character is not built out of a set
 * of gendered features and inventing some here would be off-model.
 */
export function drawPortrait(p, opts = {}) {
  const [, sc] = scoped(opts.role ?? 'base', () => paintPortrait(p, opts));
  LAST_SCOPE = sc;
  return p;
}

function paintPortrait(p, { role = 'base', seed = '', age = null, gender = null } = {}) {
  const c = config(role, seed, { age });
  // Seeded off the citizen only, like config(), so the same person in a
  // different job has the same hair.
  const r = rng(`portrait:${seed}`);
  const vHair = r();

  const young = isYoung(role, age);
  const old = isOld(role, age);

  const g = grid(PORTRAIT, PORTRAIT);
  // The face is modelled in SHADOW, never in highlight, and that is a fact
  // about the palette rather than a preference. shade(c, +t) mixes toward
  // PAL.bone, and PAL.skin (227,190,154) is already brighter than PAL.bone in
  // the red channel — so tone('skin', 0.16) came out at (225,193,161), a
  // luminance ratio of 1.011 against the skin beside it. The head's lit edge,
  // the cheekbone and the bridge of the nose were all painted in it, which is
  // to say none of them existed. There is no lighter skin available; skinShade
  // is a 1.21 step the other way, so every face plane here is stated by where
  // the light ISN'T.
  const skin = c.skin;
  const skinLo = c.skinLo;

  // Younger faces sit lower in the frame on smaller shoulders, which reads as
  // a bigger head without redrawing the head.
  const dy = young ? 2 : 0;
  const headTop = PORTRAIT_HEAD_TOP + dy;
  const eyeY = 13 + dy;
  const span = (i) => HEAD_SPANS[Math.min(i, HEAD_SPANS.length - 1)];

  // ---- neck, then shoulders over it, so the collar sits in front ----------
  const neckTop = headTop + HEAD_SPANS.length - 1;
  const shoulderTop = neckTop + 2;
  g.rect(14, neckTop, 4, 5, skin);
  g.hline(14, neckTop, 4, skinLo);
  g.hline(14, neckTop + 1, 4, skinLo);
  g.vline(17, neckTop, 5, skinLo);

  SHOULDER_SPANS.forEach(([x0, x1], i) => {
    const y = shoulderTop + i;
    if (y >= PORTRAIT) return;
    // The collar opens in a V that closes two rows down.
    const gap = i < 3 ? [13 + i, 18 - i] : null;
    for (let x = x0; x <= x1; x++) {
      if (gap && x >= gap[0] && x <= gap[1]) continue;
      g.px(x, y, c.suit);
    }
    for (let x = x0; x <= x1; x++) {
      if (gap && x >= gap[0] && x <= gap[1]) continue;
      if (i === 0 || x === x0 || x === x0 + 1) g.px(x, y, c.suitLit);
      if (x === x1 || x === x1 - 1) g.px(x, y, c.suitDark);
    }
    if (gap) {
      // Collar edge, catching the light on the left lapel.
      g.px(gap[0] - 1, y, c.suitLit);
      g.px(gap[1] + 1, y, c.suitDark);
    }
  });

  // ---- head ---------------------------------------------------------------
  for (let i = 0; i < HEAD_SPANS.length; i++) {
    const [x0, x1] = span(i);
    const y = headTop + i;
    g.hline(x0, y, x1 - x0 + 1, skin);
    // Shaded on the right, plain on the left. The left edge used to be painted
    // skinLit, which is the same value as the skin: the "highlight" was the
    // absence of shadow all along, so now it says so.
    g.px(x1, y, skinLo);
    g.px(x1 - 1, y, skinLo);
  }
  // Jaw shadow, on the RIGHT of the chin. It used to run from col 12, which is
  // the lit side — the light is upper-left in both renderers, and the mouth
  // then covered everything except the four pixels that were on the wrong one.
  g.hline(16, headTop + 15, 4, skinLo);

  // ---- hair ---------------------------------------------------------------
  if (!c.sealed) {
    const fringeRow = headTop + (old ? 4 : 7);
    const sideRow = headTop + (hairLength(gender, vHair) ? 15 : 10);

    // The hairline wanders by a pixel, but it wanders CONTINUOUSLY and it can
    // only recede. Sampling an independent -1..+1 per column produced
    // single-column spikes that dropped below both their neighbours: in the
    // base portrait that put isolated hair pixels on the brow and one on the
    // bridge of the nose between the two eyes, which at 3x read as moles, not
    // as a shaggy fringe. Carrying the previous column and clamping the step
    // to one keeps it a hairline; clamping the value to 0 or -1 means it can
    // pull back off the forehead but never stab down into the face.
    const edgeAt = [];
    let e = 0;
    for (let x = 0; x < PORTRAIT; x++) {
      const step = Math.floor(r() * 3) - 1;
      e = Math.max(-1, Math.min(0, e + step));
      edgeAt[x] = e;
    }

    for (let i = 0; i < HEAD_SPANS.length; i++) {
      const [x0, x1] = span(i);
      const y = headTop + i;
      for (let x = x0; x <= x1; x++) {
        // A receding hairline pulls back at the temples, not in the middle.
        const temple = old ? Math.max(0, 3 - Math.min(x - x0, x1 - x)) : 0;
        const edge = fringeRow + edgeAt[x] - temple;
        const side = x <= x0 + 1 || x >= x1 - 1;
        if (y <= edge || (side && y <= sideRow)) g.px(x, y, c.hair);
      }
    }
    // Lit crown, upper left.
    g.hline(11, headTop, 5, c.hairLit);
    g.hline(10, headTop + 1, 4, c.hairLit);
    g.px(9, headTop + 2, c.hairLit);
    // Cowlick, off the crown and to the right of centre like the reference.
    g.rect(15, headTop - 2, 3, 2, c.hair);
    g.px(18, headTop - 2, c.hair);
    g.px(15, headTop - 2, c.hairLit);
  }

  // ---- face ---------------------------------------------------------------
  if (c.sealed) {
    // Sealed hood: the head shape in suit white with an amber visor band.
    for (let i = 0; i < HEAD_SPANS.length; i++) {
      const [x0, x1] = span(i);
      const y = headTop + i;
      g.hline(x0, y, x1 - x0 + 1, c.suit);
      g.px(x0, y, c.suitLit);
      g.px(x0 + 1, y, c.suitLit);
      g.px(x1, y, c.suitDark);
    }
    g.stamp(cells()
      .rect(10, eyeY - 2, 12, 6, c.visor)
      .hline(10, eyeY - 2, 12, c.visorLit)
      .rect(11, eyeY - 1, 3, 2, c.visorLit)
      .hline(10, eyeY + 3, 12, tone('sodium', -0.4))
      .list);
    g.stamp(cells()
      .rect(12, neckTop, 8, 2, c.steelDark)
      .hline(12, neckTop, 8, c.steel)
      .list);
    g.stamp(cells()
      .rect(6, shoulderTop + 2, 4, 5, c.steel)
      .hline(6, shoulderTop + 2, 4, c.steelLit)
      .hline(6, shoulderTop + 6, 4, c.steelDark)
      .hline(7, shoulderTop + 4, 2, c.steelDark)
      .list);
  } else {
    // Ears. Drawn here rather than with the rest of the head, because the
    // sealed branch redraws only the columns HEAD_SPANS covers (widest [9,22])
    // and can never reach x=8 or x=23 — so a hazmat portrait was wearing a
    // sealed hood with two 1x3 strips of bare skin sticking out of it.
    g.rect(8, eyeY + 1, 1, 3, skinLo);
    g.rect(23, eyeY + 1, 1, 3, skinLo);
    g.px(8, eyeY + 1, skin);

    // Eyes: 3x3 of bone with a 2x2 pupil and a catchlight on the light side.
    //
    // Both pupils sit on the SAME side of their white, not mirrored. Mirroring
    // them is symmetric, which is why it passed every test, but it converges
    // both pupils on the nose column and symmetric convergence is precisely
    // what reads as cross-eyed at 32px. Offset the same way, it reads as a
    // level gaze slightly off camera, which is what a portrait wants.
    for (const ex of [11, 18]) {
      g.hline(ex, eyeY - 1, 3, PAL.ink);
      g.rect(ex, eyeY, 3, 3, c.eye);
      g.rect(ex, eyeY + 1, 2, 2, PAL.ink);
      g.px(ex, eyeY + 1, c.eye);
    }

    // Nose. Light comes from the upper left, so the bridge is left in plain
    // skin and the nose is drawn entirely as the shadow on its right: two
    // pixels down the side and three under the tip. Five, and not one more —
    // at six it grew a cast shadow onto the cheek, and a shadow that reaches
    // from under the eye to the mouth on a face this size does not read as a
    // nose, it reads as a beard.
    g.vline(16, eyeY + 3, 2, skinLo);
    g.hline(15, eyeY + 5, 3, skinLo);

    // Mouth.
    g.hline(14, eyeY + 7, 4, tone('skinShade', -0.4));
    g.px(14, eyeY + 7, skinLo);
    g.px(17, eyeY + 7, skinLo);

    if (old) {
      // Two lines at the brow and one at the mouth. That is all age needs.
      g.hline(11, eyeY - 3, 3, skinLo);
      g.hline(18, eyeY - 3, 3, skinLo);
      g.vline(13, eyeY + 5, 2, skinLo);
      g.vline(18, eyeY + 5, 2, skinLo);
    }
    if (young) {
      // Freckles, seeded, on the cheeks only. Straight off the rng() stream:
      // there used to be a second hand-rolled PRNG here, seeded from a float
      // already in [0,1), so the whole variation space for the fringe, the
      // hair length and the freckles was a hundred and twenty-odd radians of
      // sine phase. The stream this portrait already owns has no such ceiling
      // and is the seeded source the project requires.
      for (let i = 0; i < 6; i++) {
        const x = (r() < 0.5 ? 11 : 18) + Math.floor(r() * 3);
        g.px(x, eyeY + 3 + Math.floor(r() * 2), skinLo);
      }
    }
  }

  drawPortraitRoleCue(g, c, { shoulderTop, headTop });

  g.keyline(PAL.ink);

  // Backdrop last, so the keyline is against the figure rather than the wall.
  //
  // The dark end has to stay a clear step away from PAL.ink. It used to be
  // tone('deeper', 0) — (26,29,31) against an ink of (18,20,22), a maximum
  // channel delta of nine — and since the fill is an ordered dither the
  // figure's outline alternated pixel by pixel between visible and invisible.
  // The gradient darkens downward, so the worst of it sat exactly behind the
  // shoulders, where the silhouette is widest and most needs its edge.
  const bgLit = tone('concrete', 0.08);
  const bgDark = tone('deep', 0.06);
  g.fillEmpty((x, y) => {
    const t = 0.12 + 0.8 * (y / (PORTRAIT - 1));
    return t > (BAYER[y & 3][x & 3] + 0.5) / 16 ? bgDark : bgLit;
  });

  g.blit(p, false);
  return p;
}

/** Long side hair or short. Explicit gender wins; otherwise the seed picks. */
function hairLength(gender, v) {
  const gk = String(gender ?? '').toLowerCase();
  if (gk.startsWith('f') || gk === 'w') return true;
  if (gk.startsWith('m')) return false;
  return v > 0.5;
}

/** The same one cue per role, with room to say it properly. */
function drawPortraitRoleCue(g, c, { shoulderTop, headTop }) {
  if (c.apron) {
    g.stampOn(cells()
      .rect(11, shoulderTop + 3, 10, 4, c.canvas)
      .hline(11, shoulderTop + 3, 10, c.canvasLit)
      .vline(11, shoulderTop + 3, 4, c.canvasLit)
      .vline(12, shoulderTop, 3, c.canvas)
      .vline(19, shoulderTop, 3, c.canvas)
      .list);
  }

  if (c.goggles) {
    // Pushed up onto the UPPER forehead, with the hair left intact above.
    //
    // This used to be a 16x3 strap plus two 4x4 lenses covering rows 3-6 of a
    // head that is only fourteen columns wide, and the strap's keyline made
    // one portrait row sixteen consecutive ink pixels edge to edge. The hair —
    // the character's defining feature — was left as a nine-pixel band, a
    // four-pixel sliver flanked by ink, and then nothing. A prop may not cost
    // more than the face it sits on.
    //
    // No keyline either. The downward one it used to take made a twelve-pixel
    // solid ink row across the brow — a black bar wider than both eyebrows put
    // together, one row above the eyes. Steel on black hair is a 1.6 value
    // step and amber on it is four times that; a band that already carries its
    // own dark lower half does not need an outline drawn on the face below it.
    const gy = headTop + 5;
    g.stampOn(cells()
      .rect(10, gy, 12, 2, c.steelDark)
      .hline(10, gy, 12, c.steel)
      .rect(11, gy, 3, 2, c.amber)
      .rect(18, gy, 3, 2, c.amber)
      .hline(11, gy, 3, tone('sodium', 0.4))
      .hline(18, gy, 3, tone('sodium', 0.4))
      .list, () => false);
  }

  if (c.coat) {
    const coat = tone('bone', -0.1);
    const edge = tone('bone', -0.34);
    const cl = cells();
    SHOULDER_SPANS.forEach(([x0, x1], i) => {
      const gap = i < 3 ? [13 + i, 18 - i] : null;
      for (let x = x0; x <= x1; x++) {
        if (gap && x >= gap[0] && x <= gap[1]) continue;
        cl.px(x, shoulderTop + i, i === 0 || x <= x0 + 1 ? tone('bone', 0) : coat);
      }
      if (gap) { cl.px(gap[0] - 1, shoulderTop + i, edge); cl.px(gap[1] + 1, shoulderTop + i, edge); }
    });
    cl.rect(7, shoulderTop + 4, 3, 1, tone('verdigris'));
    cl.rect(8, shoulderTop + 3, 1, 3, tone('verdigris'));
    g.stampOn(cl.list);
  }

  if (c.badge) {
    // A shield, not a plus, and on the other shoulder.
    //
    // The plus was chosen because a star is not readable at four pixels, which
    // is true — but the medic already owns a plus, three rows away on the same
    // shoulder, and the two cues differed only in hue. Worse, the semantics
    // invert: an amber cross on a shoulder reads as MEDICAL. A filled block
    // tapering to a point is unmistakably not a cross at any size.
    g.stampOn(cells()
      .rect(22, shoulderTop + 2, 4, 3, c.amber)
      .hline(23, shoulderTop + 5, 2, c.amber)
      .hline(22, shoulderTop + 2, 4, tone('sodium', 0.4))
      .hline(23, shoulderTop + 4, 2, tone('sodium', -0.4))
      .list);
  }

  if (c.plates) {
    // Both plates draw their own border INSIDE their own footprint, and neither
    // asks stamp() for a keyline. That is the whole fix for what this used to
    // be. A stamped fill gets an ink row above AND below, so an eleven-wide
    // chest plate cost two solid eleven-pixel bars; the pauldron, stamped on
    // all four sides, added a third across the shoulder. Three black bars over
    // the chest at 3x read as damage, not as armour. Drawn as boxes they cost
    // one row each, they are the same rows the plate already occupies, and the
    // border is where a border belongs — on the object.
    //
    // The two plates also end on different rows. Sharing one — which they did
    // when both simply ran to the bottom of the shoulder — put their two
    // bottom borders on the same line and made a single black bar right across
    // the chest, which is the artifact this was supposed to remove. The
    // pauldron stops two rows short; the chest plate runs off the bottom edge
    // of the card instead of closing, exactly as the shoulders do.
    const py = shoulderTop;
    g.stampOn(cells()
      .rect(3, py, 9, 7, PAL.ink)
      .rect(4, py + 1, 7, 5, c.steel)
      .hline(4, py + 1, 7, c.steelLit)
      .hline(4, py + 5, 7, c.steelDark)
      .rect(5, py + 2, 5, 2, c.rust)
      .hline(5, py + 2, 5, tone('rust', 0.22))
      .list, () => false);
    const bx = 13;
    const by = shoulderTop + 3;
    g.stampOn(cells()
      .rect(bx, by, 13, PORTRAIT - by, PAL.ink)
      .rect(bx + 1, by + 1, 11, PORTRAIT - by - 1, c.steel)
      .hline(bx + 1, by + 1, 11, c.steelLit)
      .rect(bx + 3, by + 3, 7, 2, tone('steel', -0.16))
      .hline(bx + 3, by + 3, 7, c.rust)
      .list, () => false);
  }
}

export default {
  drawCitizen, drawPortrait, frameIndex,
  ACTIONS, ROLES, CONSUMER_ROLES, CONSUMER_ACTIONS,
  W, H, PORTRAIT,
};

/* ------------------------------------------------------------ self-test -- */

/** A painter-shaped sink that records pixels, so frames can be compared. */
function capture(w, h) {
  const px = new Array(w * h).fill(null);
  return {
    w,
    h,
    px,
    set(x, y, c) {
      if (c && x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = c;
    },
    key() {
      return px.map((c) => (c ? c.join(',') : '.')).join('|');
    },
    count() {
      return px.reduce((n, c) => n + (c ? 1 : 0), 0);
    },
  };
}

function frameOf(opts) {
  const cap = capture(W, H);
  drawCitizen(cap, opts);
  cap.tones = tonesUsed();
  return cap;
}

function differences(a, b) {
  let n = 0;
  for (let i = 0; i < a.px.length; i++) {
    const x = a.px[i] ? a.px[i].join(',') : '.';
    const y = b.px[i] ? b.px[i].join(',') : '.';
    if (x !== y) n++;
  }
  return n;
}

/**
 * Cells where one frame is solid and the other is empty, or where one is ink
 * and the other is paint. This is the measure a role cue has to move: total
 * pixel difference counts a recoloured jumpsuit, and a recoloured jumpsuit is
 * not a cue, it is a palette.
 */
function silhouetteDiff(a, b) {
  const ink = PAL.ink.join(',');
  const cls = (c) => (!c ? 0 : c.join(',') === ink ? 1 : 2);
  let n = 0;
  for (let i = 0; i < a.px.length; i++) if (cls(a.px[i]) !== cls(b.px[i])) n++;
  return n;
}

/** Distinct non-ink colours in a frame, keyed "r,g,b". */
function hues(cap) {
  const ink = PAL.ink.join(',');
  const s = new Set();
  for (const c of cap.px) if (c && c.join(',') !== ink) s.add(c.join(','));
  return s;
}

async function selfTest() {
  const fails = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); };

  // Every action the renderer can ask for is drawable, and every action drawn
  // is one somebody asks for. Same correction as the ROLES check below: a
  // count is a number that must be edited whenever the set grows and says
  // nothing about whether the set is right.
  const ASKED_ACTIONS = ['walk', 'idle', 'work', 'sleep', 'injured', 'talk', 'fight'];
  for (const a of ASKED_ACTIONS) {
    check(!!ACTIONS[a], `src/render/sprites.js can ask for "${a}" and ACTIONS does not list it`);
    check(a === 'sleep' || !!POSES[a], `"${a}" has no pose table, so every frame of it would be a walk`);
  }
  check(Object.keys(ACTIONS).every((a) => ASKED_ACTIONS.includes(a)),
    `ACTIONS bakes ${Object.keys(ACTIONS).filter((a) => !ASKED_ACTIONS.includes(a)).join(', ')}, which nothing asks for`);
  check(ACTIONS.walk === 6 && ACTIONS.idle === 4 && ACTIONS.work === 4
    && ACTIONS.sleep === 2 && ACTIONS.injured === 4, 'ACTIONS frame counts drifted');

  // No two actions may render the same picture.
  //
  // This check exists because the death animation shipped, briefly, with its
  // last frame pixel-identical to a sleeping citizen — both ended on
  // `drawSleeper` and nothing here noticed. A body that looks exactly like
  // somebody having a nap is the single worst thing this animation could do,
  // and it passed every other check in this file: the palette was legal, the
  // keyline was clean, the frames within each action were distinct.
  {
    const seen = new Map();
    for (const action of Object.keys(ACTIONS)) {
      for (let f = 0; f < ACTIONS[action]; f++) {
        const key = frameOf({ action, frame: f, role: 'base', seed: 'same' }).key();
        const prior = seen.get(key);
        // Within one action, a repeated frame is caught elsewhere and is
        // sometimes legitimate; across two, it means one of them is a lie.
        if (prior && prior.split('/')[0] !== action) {
          check(false, `${action}${f} is pixel-identical to ${prior} — two different things look the same`);
        }
        if (!prior) seen.set(key, `${action}/${f}`);
      }
    }
  }
  // Every role the renderer can ask for is drawable, rather than a count.
  //
  // This was `ROLES.length === 10`, which is a number that has to be edited
  // every time a role is added and says nothing about whether the set is
  // right. What matters is that src/render/sprites.js:citizenRole() cannot
  // return a name this module does not draw — that is a 404 in the atlas and
  // a citizen who renders as nothing.
  const ASKED_FOR = [
    'base', 'resident', 'farmer', 'mechanic', 'medic', 'deputy', 'militia',
    'child', 'elder', 'hazmat', 'irradiated',
  ];
  for (const role of ASKED_FOR) {
    check(ROLES.includes(role), `citizenRole() can return "${role}" and ROLES does not list it`);
  }
  check(ROLES.every((r) => ASKED_FOR.includes(r)),
    `ROLES draws ${ROLES.filter((r) => !ASKED_FOR.includes(r)).join(', ')}, which nothing asks for`);
  for (const role of ROLES) check(!!ROLE_CUES[role], `role "${role}" has no documented cue`);

  // Everything the shipped renderer can ask for must resolve to something this
  // file draws. This is the check that would have caught the two vocabularies
  // drifting apart in the first place.
  for (const [alias, role] of Object.entries(CONSUMER_ROLES)) {
    check(ROLES.includes(role), `consumer palette "${alias}" maps to unknown role "${role}"`);
  }
  for (const [action, count] of Object.entries(CONSUMER_ACTIONS)) {
    check(!!ACTIONS[action], `consumer action "${action}" is not an action here`);
    const seen = new Set();
    for (let f = 0; f < count; f++) {
      const i = frameIndex(action, f, count);
      check(i >= 0 && i < ACTIONS[action], `frameIndex(${action},${f},${count}) = ${i} is out of range`);
      seen.add(i);
    }
    check(seen.size === count, `frameIndex(${action}, .., ${count}) repeats a frame`);
  }

  let frames = 0;

  for (const role of ROLES) {
    for (const [action, n] of Object.entries(ACTIONS)) {
      const shots = [];
      for (let f = 0; f < n; f++) {
        const cap = frameOf({ frame: f, action, role, seed: `${role}-7` });
        shots.push(cap);
        frames++;

        // Something was actually drawn, and it is not a blob.
        check(cap.count() > 26, `${role}/${action}${f}: only ${cap.count()} px painted`);
        check(cap.count() < W * H * 0.9, `${role}/${action}${f}: sprite is a solid block`);

        // Feet on the bottom row: the keyline under the planted boot lands
        // there, which is what the renderer stands on the floor.
        let bottom = 0;
        for (let x = 0; x < W; x++) if (cap.px[(H - 1) * W + x]) bottom++;
        check(bottom >= 2, `${role}/${action}${f}: nothing on the bottom row`);

        // Every border cell is either empty or ink. The atlas packs sprites
        // with a single pixel of gutter, so a solid flush against the frame
        // edge has nowhere to put its keyline and bleeds into its neighbour.
        // Compared by value, not by reference: every sibling check here does
        // the same, and identity only worked because keyline() happens to
        // store the PAL.ink array object itself rather than a copy.
        const inkKey = PAL.ink.join(',');
        const border = (x, y) => {
          const c = cap.px[y * W + x];
          check(!c || c.join(',') === inkKey,
            `${role}/${action}${f}: unkeylined solid at the sprite edge (${x},${y})`);
        };
        for (let x = 0; x < W; x++) { border(x, 0); border(x, H - 1); }
        for (let y = 0; y < H; y++) { border(0, y); border(W - 1, y); }

        // Palette law, and this time it can actually fail. USED accumulates
        // every tone every role has ever asked for, so checking against it
        // proved nothing — a farmer painted in hazmat bone would have passed.
        // cap.tones is the set THIS render requested.
        for (const c of cap.px) {
          if (!c) continue;
          const k = c.join(',');
          check(k === inkKey || cap.tones.has(k),
            `${role}/${action}${f}: colour ${k} was not requested by this render`);
          check(k !== PAL.toxin.join(',') || role === 'irradiated',
            `${role}/${action}${f}: PAL.toxin on a citizen that is not irradiated`);
        }

        // Two boots side by side with nothing between them is one dark mass,
        // not a stride — the failure a legW of 3 used to give the child, whose
        // feet then spanned eight of the twelve columns as a single block.
        //
        // The measure is the WIDTH of a run, not the number of runs. Demanding
        // two runs on the sole row is a rule a walk cannot keep and should not
        // be asked to: halfway through a stride the swing foot passes the
        // stance foot and is hidden behind it, and while a boot is off the
        // floor there is only one foot on that row at all. What must never
        // happen is a horizontal mass wider than a single boot, which is
        // legW + 1 = 3 for every role, plus a column of slack.
        //
        // Rows 13 and 14 are the whole boot band. A planted boot sits on both;
        // a lifted one sits on 12 and 13. So two boots can only ever share a
        // row on 13 or 14, and looking higher would start measuring thighs and
        // the hands that reach past them, which is a different question.
        // Standing figures only: a figure with no boot band cannot fail a
        // boot-band check.
        if (action !== 'sleep') {
          for (let y = H - 3; y <= H - 2; y++) {
            let run = 0;
            let worst = 0;
            for (let x = 0; x < W; x++) {
              const c = cap.px[y * W + x];
              run = c && c.join(',') !== inkKey ? run + 1 : 0;
              worst = Math.max(worst, run);
            }
            check(worst <= 4, `${role}/${action}${f}: ${worst}px of fused foot on row ${y}`);
          }
        }
      }

      // No duplicate frames — a cycle that repeats a pose reads as a stutter.
      const keys = shots.map((s) => s.key());
      check(new Set(keys).size === keys.length,
        `${role}/${action}: duplicate frames (${keys.length - new Set(keys).size})`);
    }

    // The walk must loop: the wrap from the last frame to the first has to be
    // an ordinary step, not a jump. Compare it against the other transitions.
    const walk = [];
    for (let f = 0; f < ACTIONS.walk; f++) walk.push(frameOf({ frame: f, action: 'walk', role, seed: `${role}-7` }));
    const steps = walk.map((s, i) => differences(s, walk[(i + 1) % walk.length]));
    const wrap = steps[steps.length - 1];
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    check(wrap <= mean * 1.6,
      `${role}/walk: pops on the loop (wrap ${wrap} px vs mean ${mean.toFixed(1)})`);

    // Portrait.
    const pc = capture(PORTRAIT, PORTRAIT);
    drawPortrait(pc, { role, seed: `${role}-7`, age: 30 });
    const ptones = tonesUsed();
    check(pc.count() === PORTRAIT * PORTRAIT, `${role}: portrait has holes in the backdrop`);
    for (const c of pc.px) {
      const k = c.join(',');
      check(k === PAL.ink.join(',') || ptones.has(k),
        `${role}: portrait colour ${k} was not requested by this render`);
      check(k !== PAL.toxin.join(',') || role === 'irradiated',
        `${role}: PAL.toxin in a portrait that is not irradiated`);
    }
  }

  // Facing mirrors, and does not change the pixel count.
  const rightFace = frameOf({ action: 'walk', frame: 1, role: 'base', seed: 'm' });
  const leftFace = frameOf({ action: 'walk', frame: 1, role: 'base', seed: 'm', facing: -1 });
  check(rightFace.count() === leftFace.count(), 'facing changed the sprite');
  check(rightFace.key() !== leftFace.key(), 'facing did not mirror anything');

  // Seeds vary the person but never the frame counts or the silhouette rows.
  const a = frameOf({ action: 'idle', frame: 0, role: 'base', seed: 'aaa' });
  const b = frameOf({ action: 'idle', frame: 0, role: 'base', seed: 'zzz' });
  check(a.count() === b.count(), 'seed changed the silhouette, not just the palette');

  // Deterministic: the atlas has to regenerate byte-identical.
  check(frameOf({ action: 'walk', frame: 2, role: 'militia', seed: 'q' }).key()
    === frameOf({ action: 'walk', frame: 2, role: 'militia', seed: 'q' }).key(),
    'rendering is not deterministic');

  // Roles differ from base, in every action, in a way that is actually a cue.
  //
  // The old form of this check compared total pixel difference against a
  // threshold of 6, on frames drawn from a stream seeded with the role name —
  // so two roles at the same `seed` rolled different suit and skin jitter and
  // differed by 27-37 pixels before any cue was drawn. It measured noise. It
  // also only ever rendered 'idle', which is why every role cue silently
  // vanishing the moment a citizen lay down went unnoticed for as long as it
  // did. Same seed now means the same person, and the assertion is on
  // silhouette or on the set of materials, either of which a real cue moves
  // and a recoloured jumpsuit does not.
  const baseHues = {};
  for (const action of Object.keys(ACTIONS)) {
    baseHues[action] = frameOf({ action, frame: 0, role: 'base', seed: 'same' });
  }
  for (const role of ROLES.filter((x) => x !== 'base')) {
    for (const action of Object.keys(ACTIONS)) {
      const cue = frameOf({ action, frame: 0, role, seed: 'same' });
      const plain = baseHues[action];
      const shape = silhouetteDiff(cue, plain);
      const added = [...hues(cue)].filter((k) => !hues(plain).has(k)).length;
      check(shape >= 3 || added >= 3,
        `role "${role}" in "${action}" is not a cue: ${shape} silhouette px, ${added} new tones`);
    }
  }

  // The seed varies the person; the role does not vary the person.
  const sameA = frameOf({ action: 'idle', frame: 0, role: 'base', seed: 'twin' });
  const sameB = frameOf({ action: 'idle', frame: 0, role: 'farmer', seed: 'twin' });
  check(hues(sameA).size > 0 && [...hues(sameA)].some((k) => hues(sameB).has(k)),
    'role changed the whole palette — the same seed should be the same person');

  // Age greys the hair whatever the job, in both renderers.
  const oldFarmer = capture(PORTRAIT, PORTRAIT);
  drawPortrait(oldFarmer, { role: 'farmer', seed: 'g', age: 80 });
  const youngFarmer = capture(PORTRAIT, PORTRAIT);
  drawPortrait(youngFarmer, { role: 'farmer', seed: 'g', age: 30 });
  check(differences(oldFarmer, youngFarmer) > 20, 'age does not change the portrait');
  const oldSprite = frameOf({ action: 'idle', frame: 0, role: 'farmer', seed: 'g', age: 80 });
  const youngSprite = frameOf({ action: 'idle', frame: 0, role: 'farmer', seed: 'g', age: 30 });
  check(differences(oldSprite, youngSprite) > 0, 'age does not reach the sprite');

  // tone() refuses the reserved colour outside an irradiated render.
  let threw = false;
  try { tone('toxin'); } catch { threw = true; }
  check(threw, 'tone() allowed PAL.toxin outside an irradiated render');
  let opened = false;
  scoped('irradiated', () => { try { tone('toxin'); opened = true; } catch { /* noop */ } });
  check(opened, 'tone() refused PAL.toxin to the one role it is for');

  const args = Object.fromEntries(process.argv.slice(2).map((s) => {
    const [k, v] = s.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  }));
  if (args.out) await writeSheet(String(args.out), args);

  const total = frames + ROLES.length;
  if (fails.length) {
    console.error(`citizens: ${fails.length} failure(s) across ${total} renders`);
    for (const f of fails.slice(0, 40)) console.error(`  - ${f}`);
    if (fails.length > 40) console.error(`  ... and ${fails.length - 40} more`);
    process.exitCode = 1;
  } else {
    console.log(`citizens: ok — ${frames} sprite frames + ${ROLES.length} portraits, `
      + `${USED.size} palette tones, no toxin, walk loops clean`);
  }
}

/* --------------------------------------------------- contact sheet (PNG) -- */

async function writeSheet(out, args) {
  const { deflateSync } = await import('node:zlib');
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');

  const zoom = Number(args.zoom ?? 6);
  const roles = args.role ? ROLES.filter((r) => r === args.role) : ROLES;
  const acts = args.portraits
    ? []
    : Object.entries(ACTIONS).filter(([a]) => !args.action || a === args.action);
  const cols = acts.reduce((n, [, k]) => n + k, 0);

  const pad = 2;
  const cellW = W * zoom + pad;
  const cellH = H * zoom + pad;
  const portH = PORTRAIT * zoom + pad;
  const portW = args.action ? 0 : PORTRAIT * zoom + pad * 2;
  // The row has to clear the TALLER of the two things in it. A portrait is
  // twice the height of a sprite, so a row pitched at the sprite's height drew
  // each portrait over the top of the one above and only the last role's
  // survived — the sheet this file exists to be judged from could not show
  // nine of its ten faces.
  const rowH = args.portraits || portW ? portH : cellH;
  const pCols = args.portraits ? Math.ceil(Math.sqrt(roles.length)) : 1;
  const sheetW = args.portraits ? pCols * (PORTRAIT * zoom + pad) + pad : cols * cellW + pad + portW;
  const sheetH = args.portraits
    ? Math.ceil(roles.length / pCols) * rowH + pad
    : roles.length * rowH + pad;

  const buf = new Uint8Array(sheetW * sheetH * 4);
  for (let i = 0; i < sheetW * sheetH; i++) {
    const x = i % sheetW;
    const y = Math.floor(i / sheetW);
    const dark = ((x >> 3) + (y >> 3)) & 1;
    // PAL entries, not literals. These happened to equal steelDark and lit,
    // but this was the one place in the file writing a colour without going
    // through PAL, and it is the one buffer the palette self-test cannot see.
    const c = dark ? PAL.steelDark : PAL.lit;
    buf[i * 4] = c[0]; buf[i * 4 + 1] = c[1]; buf[i * 4 + 2] = c[2]; buf[i * 4 + 3] = 255;
  }
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= sheetW || y >= sheetH) return;
    const i = (y * sheetW + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
  };
  const view = (ox, oy) => ({
    w: W,
    h: H,
    set(x, y, c) {
      for (let j = 0; j < zoom; j++) for (let i = 0; i < zoom; i++) put(ox + x * zoom + i, oy + y * zoom + j, c);
    },
  });

  roles.forEach((role, ri) => {
    let cx = pad;
    // Sprites sit on the baseline of their row rather than the top of it, so
    // that with a taller row the whole cast still stands on one line.
    const cy = pad + ri * rowH + (rowH - cellH);
    for (const [action, n] of acts) {
      for (let f = 0; f < n; f++) {
        drawCitizen(view(cx, cy), { frame: f, action, role, seed: `${role}-7` });
        cx += cellW;
      }
    }
    if (portW) {
      const ox = args.portraits
        ? pad + (ri % pCols) * (PORTRAIT * zoom + pad)
        : cols * cellW + pad * 2;
      const oy = pad + (args.portraits ? Math.floor(ri / pCols) : ri) * rowH;
      drawPortrait({
        w: PORTRAIT,
        h: PORTRAIT,
        set(x, y, c) {
          for (let j = 0; j < zoom; j++) for (let i = 0; i < zoom; i++) put(ox + x * zoom + i, oy + y * zoom + j, c);
        },
      }, { role, seed: `${role}-7`, age: role === 'child' ? 9 : role === 'elder' ? 71 : 30 });
    }
  });

  // Minimal PNG. Same encoder shape as tools/gen-atlas.mjs.
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let cc = n;
      for (let k = 0; k < 8; k++) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1;
      t[n] = cc;
    }
    return t;
  })();
  const crc32 = (b) => {
    let cc = -1;
    for (let i = 0; i < b.length; i++) cc = (cc >>> 8) ^ crcTable[(cc ^ b[i]) & 0xff];
    return (cc ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(sheetW, 0);
  ihdr.writeUInt32BE(sheetH, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(sheetH * (sheetW * 4 + 1));
  for (let y = 0; y < sheetH; y++) {
    raw[y * (sheetW * 4 + 1)] = 0;
    Buffer.from(buf.buffer, y * sheetW * 4, sheetW * 4).copy(raw, y * (sheetW * 4 + 1) + 1);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, png);
  console.log(`citizens: contact sheet -> ${out} (${sheetW}x${sheetH} @ ${zoom}x)`);
}

if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  const { pathToFileURL } = await import('node:url');
  if (import.meta.url === pathToFileURL(process.argv[1]).href) await selfTest();
}
