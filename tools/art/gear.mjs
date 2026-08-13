/**
 * gear.mjs — the eighteen icons for weapons, armour and env-suits.
 *
 * These are the only sprites in the game that are drawn for a LIST rather than
 * for the world. The player meets them in the Armory, on a phone, scrolling a
 * column of rows, deciding what to issue to six people who are about to walk
 * out of the airlock. So the brief is different from a prop's: a prop has to
 * sit convincingly inside a room interior, an icon has to be told apart from
 * seventeen siblings in about a third of a second.
 *
 * ---------------------------------------------------------------------------
 * WHY 24x24
 *
 * The props are 16x16 because they are drawn 1:1 into a room. Nothing draws
 * these into the world; `.gear-row` in styles.css is a flex row about 72px
 * tall with a 10px gutter, so an icon at 24x24 blitted at an integer 2x is 48
 * CSS px and drops into the row without changing a single measurement of the
 * layout.
 *
 * The size is not a rounding of 16 upward, it is what the subject needs. A
 * rifle is a long thin object whose whole identity is in the FURNITURE hung
 * off the barrel line — stock, magazine, optic, foregrip, muzzle. At 16 px a
 * horizontal rifle has 14 usable columns; a 2px magazine and a 3px stock and a
 * 4px optic already overlap, and every weapon collapses into "a stick with a
 * bump", which is exactly the failure mode where tier stops reading. At 24 the
 * barrel line is 21 columns and each feature gets 3-5 columns of its own with
 * a gap either side, which is the minimum at which a silhouette can carry a
 * list of features rather than one.
 *
 * The armour and the suits do not need 24 columns of width — a cuirass is 14
 * wide and a suited figure is 12, the same width as a citizen — but they need
 * the HEIGHT, and a square frame lets all three classes share one baseline,
 * one pip strip and one blit size in the panel.
 *
 * ---------------------------------------------------------------------------
 * HOW TIER READS — three signals, deliberately redundant
 *
 * A player scanning a list must see that one rifle is better than another
 * without reading a word. One signal is not enough: colour alone fails for the
 * ~8% of men with a red-green deficiency and fails again under the panel's own
 * amber alert tint; silhouette alone fails at a glance because the difference
 * between a T3 and a T4 receiver is genuinely subtle at this size. So all
 * three are used, and they agree:
 *
 *   1. SILHOUETTE. Each tier adds a feature the tier below does not have, and
 *      never merely enlarges it: T1 has no magazine at all, T2 gains a box
 *      magazine and a real stock, T3 gains an optic, a foregrip and a vented
 *      shroud, T4 gains the coil assembly and the longest optic in the set.
 *      What the self-test GATES on is the pair of consequences that can be
 *      measured without lying — every crafted tier covers more pixels than the
 *      tier below it, and no two adjacent tiers come within 12 of 144
 *      silhouette cells of each other. See the [ladder] block, and the note
 *      there on why the "outline runs" number is printed and not gated.
 *
 *   2. MATERIAL. The body colour walks a ramp that is a fiction about
 *      manufacture, not a decoration: T1 is scrap iron and salvaged timber,
 *      T2 is plain machined steel, T3 adds a verdigris composite panel, T4 is
 *      bright alloy with a sodium-lit power fitting. Warm-and-dark to
 *      cold-and-bright, which survives being 24px tall behind a thumb.
 *
 *   3. THE PIP STRIP. Five slots along the bottom-left of every icon, in the
 *      same place on all eighteen, N filled and 5-N dim. It is the game's own
 *      meter widget shrunk to 15x4, and it is deliberately literal: the other
 *      two signals let a player LEARN the ranking, the pips let them READ it
 *      on the first day. Scanning a column, the eye tracks a single fixed
 *      x-position and the bar chart of a whole armoury falls out for free.
 *
 * The pips also carry PROVENANCE, in their colour, which is the second
 * question the list has to answer:
 *
 *      amber      — made here, in the Armory. Tiers 1-4.
 *      blue       — taken off a conquered silo's garrison. Another silo's
 *                   inventory paint, and the only blue in the game's kit.
 *      hot rust   — cut off the Slag Crews.
 *      verdigris  — out of the Scar. Pre-collapse.
 *
 * ---------------------------------------------------------------------------
 * THE THREE LOOT ITEMS MUST NOT READ AS CRAFTED
 *
 * At tier 4 the player is choosing between three weapons that behave
 * differently, so the icons cannot differ only in a pip. They differ in
 * manufacture, which is the fiction and also the fastest possible visual cut:
 *
 *   crafted (mag_rifle, breacher_plate, suit_4)
 *       Symmetrical, square-cut, bright alloy, sodium fittings. Everything is
 *       flush and aligned because a machine shop made it.
 *   garrison (garrison_rifle)
 *       Long, plain, full timber furniture, iron sights, a five-round box, a
 *       bolt handle standing out of the receiver — and a blue paint band with
 *       a stencil on the butt. It is old, it is somebody else's, and it is the
 *       thinnest silhouette in the set because it is the cheapest to feed.
 *   slag (slag_autogun, slag_plate)
 *       Asymmetric, over-built, welded from mismatched pieces with the beads
 *       left proud, rust and hazard amber. The autogun's drum magazine is a
 *       circle, and nothing else in the eighteen contains a circle that size.
 *   scar (rail_carbine, compact_cuirass, registry_skin)
 *       Pre-collapse: bone-white shell, no fasteners, no seams that were not
 *       designed, one verdigris light. FEWER pixels than anything else — the
 *       silo's tier 4 is busy because the silo has to bolt things together,
 *       and the Scar's tier 5 is smooth because whoever made it did not.
 *
 * ---------------------------------------------------------------------------
 * HOUSE RULES, same as scenery.mjs, which this file draws through
 *
 *   - every solid form carries a 1px PAL.ink keyline, grown by form.keyline(),
 *   - light from the upper left, always,
 *   - colour is a PAL entry through tone(), or shade() of one, never anything
 *     eyeballed. PAL.toxin is radiation only and appears nowhere in this file,
 *   - nothing is random: every draw function here is fully deterministic, so
 *     the atlas is byte-identical between runs and the repo stays diffable.
 *
 * Layout contract — four horizontal bands, every one of them asserted by the
 * self-test, and every assertion fault-injected to prove it can fail:
 *
 *   y 0..18    the art. Bodies stay inside x 1..22 and y 1..18 so the keyline
 *              has somewhere to grow; the four border lines of the frame may
 *              hold ink and nothing else.
 *   y 19       the keyline's own row, and the clear line above the pips. Ink
 *              may sit here. A body colour here is a failure.
 *   y 20..22   the five pip bars, x 1..14.
 *   y 23       their ink shadow. Nothing but the strip may paint right of
 *              x=16 in any of these last four rows.
 *
 * Run: node tools/art/gear.mjs            (self-test)
 *      node tools/art/gear.mjs --out=/tmp/gear.png --zoom=8   (contact sheet)
 */

import { PAL, shade, atlas } from './lib.mjs';
import { tone, form, legalColour } from './scenery.mjs';

/* --------------------------------------------------------------- layout -- */

export const GEAR_SIZE = 24;
/** Last row the art proper may paint. Below this is the pip strip. */
export const ART_BOTTOM = 18;
/** Top row of the pip bars. Bars are 3 tall, their ink shadow is on PIP_Y+3. */
export const PIP_Y = 20;
export const PIP_SLOTS = 5;
const PIP_X = 1, PIP_PITCH = 3, PIP_W = 2;

/* --------------------------------------------------------------- colours -- */

const INK = PAL.ink;

// Machined steel, the neutral spine of the whole set.
const MET = tone('steel');
const MET_HI = tone('steelLit');
const MET_LO = tone('steelDark');
// The two dark tones. Bores, gouges and the inside of a seam only — see the
// tone floor note over the weapons.
const IRON = tone('steelDark', -0.38);
const IRON_LO = tone('steelDark', -0.60);

// Salvaged timber and scrap iron: tier one, and the garrison's furniture.
const WOOD = tone('rust', -0.46);
const WOOD_HI = tone('rust', -0.28);
const WOOD_LO = tone('rust', -0.62);

// Rust proper, hot and dirty. The Slag Crews, and tier-one corrosion.
const RUSTY = tone('rust', -0.08);
const RUST_HI = tone('rust', 0.20);
const RUST_LO = tone('rust', -0.36);

// Canvas and webbing.
const CANVAS = tone('verdigris', -0.40);
const CANVAS_HI = tone('verdigris', -0.20);
const CANVAS_LO = tone('verdigris', -0.58);

// Composite weave: the tier-three material, and the tier-three tell.
const COMP = tone('verdigris', -0.22);
const COMP_HI = tone('verdigris', 0.04);
const COMP_LO = tone('verdigris', -0.44);

// Glass and light-pipe. Every visor and every emitter in the set.
const GLASS = tone('verdigris', 0.30);
const GLASS_HI = tone('verdigris', 0.55);
const GLASS_LO = tone('verdigris', -0.10);

// Sodium: power, lamps, hazard stripes. The silo's own warm colour.
const AMBER = tone('sodium');
const AMBER_HI = tone('sodium', 0.40);
const AMBER_LO = tone('sodium', -0.44);

// Pre-collapse shell. Warm white, and used by nothing the silo can build.
const PRE = tone('bone', -0.14);
const PRE_HI = tone('bone', 0.04);
const PRE_LO = tone('bone', -0.40);
const PRE_DK = tone('bone', -0.62);

// Another silo's inventory paint.
const BLUE = tone('denim');
const BLUE_HI = tone('denimLit');
const BLUE_LO = tone('denimDark');

const CONC = tone('concrete');
const SLOT = tone('concrete', -0.06);   // an empty pip

/** Pip fill by provenance: [bar, lit top]. */
const PIP_INK = {
  silo: [AMBER, AMBER_HI],
  garrison: [BLUE, BLUE_HI],
  slag: [RUSTY, RUST_HI],
  scar: [tone('verdigris', 0.12), GLASS_HI],
};

/* --------------------------------------------------------------- helpers -- */

/**
 * The tier strip. Drawn after keyline() so it never grows an ink halo into the
 * art above it, and carrying its own keyline on the shaded side only — the
 * thin-run rule: a 2px bar outlined on four sides is a black square.
 */
function pips(f, n, origin) {
  const [on, onHi] = PIP_INK[origin] || PIP_INK.silo;
  for (let i = 0; i < PIP_SLOTS; i++) {
    const x = PIP_X + i * PIP_PITCH;
    const lit = i < n;
    f.rect(x, PIP_Y, PIP_W, 3, lit ? on : SLOT);
    f.hline(x, PIP_Y, PIP_W, lit ? onHi : tone('concrete', 0.1));
    f.vline(x + PIP_W, PIP_Y, 3, INK);          // shaded side
    f.hline(x, PIP_Y + 3, PIP_W + 1, INK);      // and underneath
  }
  return f;
}

/** A horizontal barrel run: lit along the top, shaded along the bottom. */
function barrel(f, x, y, len, thick, c, lit = 0.26, dk = -0.30) {
  f.rect(x, y, len, thick, c);
  f.hline(x, y, len, shade(c, lit));
  if (thick > 1) f.hline(x, y + thick - 1, len, shade(c, dk));
  return f;
}

/** Weld beads: the join between two pieces somebody fused by hand. */
function weld(f, x, y, len, horizontal = true) {
  for (let i = 0; i < len; i++) {
    const c = i % 2 ? RUST_HI : RUST_LO;
    if (horizontal) f.px(x + i, y, c);
    else f.px(x, y + i, c);
  }
  return f;
}

/** A row of rivets, one lit pixel each. */
function rivets(f, xs, y, c = MET_HI) {
  for (const x of xs) f.px(x, y, c);
  return f;
}

/* ============================================================== weapons == */
/*
 * All seven share a bore line: the barrel runs left to right at y=7..9, the
 * receiver sits under it, furniture hangs below, optics sit on top. Holding
 * that line constant across the family is what makes the DIFFERENCES the thing
 * you see — composed freely, seven different poses would drown the tier.
 *
 * PROPORTION. The receiver is six or seven rows and the barrel runs to x=22.
 * The first draft gave every weapon a nine-row receiver and a five-column
 * barrel, and every one of them read as a lump of machinery rather than as a
 * gun: what makes a gun-shape is a LONG thin line with a compact mass under
 * the back third of it, and at 24px there is only room for that if the mass
 * gives way.
 *
 * TONE FLOOR. Nothing structural is drawn below MET_LO, rgb(74,81,84). The
 * Armory's rows sit on --concrete-deeper, rgb(35,39,41), and the first draft
 * built these out of IRON, rgb(46,50,52) — eleven points off the background it
 * had to be seen against. Every icon read as a keyline around a hole. The dark
 * tones are still here and still used, as bores, gouges, seams and shadow, but
 * never as a body.
 */

/**
 * T1 Pipe Gun. A tube, a block of scrap and a sawn plank, with the firing pin
 * standing out of the top where a bolt should be. No magazine and no sights,
 * because it has neither: it is one shot, hand-loaded, and the icon should
 * make a player slightly reluctant to issue it.
 */
function wPipeGun(f) {
  f.slab(1, 9, 8, 7, WOOD, 0.28, -0.30);              // the plank
  f.clr(1, 9); f.clr(1, 15); f.clr(8, 15);            // sawn corners
  f.slab(7, 6, 6, 7, MET_LO, 0.30, -0.24);            // breech block
  f.rect(10, 3, 2, 4, MET);                           // the hand-turned pin
  barrel(f, 12, 7, 11, 3, MET, 0.28, -0.34);          // the pipe
  f.slab(19, 6, 4, 5, MET_LO, 0.28, -0.26);           // a collar, brazed on
  f.keyline();
  f.rect(21, 8, 2, 1, IRON_LO);                       // the bore
  f.hline(13, 8, 3, RUST_LO); f.hline(17, 8, 2, RUST_LO);   // corrosion
  f.px(15, 9, RUSTY); f.px(11, 9, RUSTY); f.px(18, 7, RUST_LO);
  f.hline(2, 11, 6, WOOD_HI); f.hline(2, 13, 5, WOOD_LO);   // grain
  f.px(9, 8, MET_HI); f.px(11, 11, MET_LO);
  f.px(10, 3, MET_HI);
  return f;
}

/**
 * T2 Service Rifle. The archetype, and the first weapon here that was drawn
 * before it was built: a shaped butt, a machined receiver, a straight box
 * magazine, a bolt, sights at both ends. Everything above this tier is a
 * variation on this shape; everything below it is not a rifle.
 */
function wServiceRifle(f) {
  f.slab(1, 6, 7, 7, WOOD, 0.28, -0.30);              // butt
  f.clr(1, 6); f.clr(1, 12);
  f.slab(6, 6, 8, 6, MET, 0.28, -0.32);               // receiver
  barrel(f, 13, 7, 10, 3, MET, 0.30, -0.34);
  f.slab(19, 5, 2, 3, MET_LO, 0.26, -0.26);           // front sight
  f.slab(7, 4, 2, 3, MET_LO, 0.26, -0.26);            // rear sight
  f.slab(12, 4, 3, 3, MET_LO, 0.28, -0.26);           // bolt, standing proud
  f.slab(10, 11, 4, 7, MET_LO, 0.28, -0.30);          // box magazine
  f.slab(7, 11, 3, 5, WOOD, 0.28, -0.30);             // pistol grip
  f.keyline();
  f.hline(7, 7, 6, tone('steel', 0.30));              // receiver rail
  f.hline(7, 10, 6, MET_LO);
  f.px(8, 9, MET_HI); f.px(12, 9, MET_LO);
  f.hline(11, 13, 3, MET); f.hline(11, 16, 3, MET);   // magazine ribs
  f.rect(21, 8, 2, 1, IRON_LO);                       // the bore
  f.hline(2, 8, 5, WOOD_HI); f.hline(2, 11, 4, WOOD_LO);
  f.px(19, 5, MET); f.px(13, 4, MET);
  return f;
}

/**
 * T3 Breaching Carbine. Short, and everything about it is thicker: a vented
 * shroud where the others have a bare barrel, a foregrip under it, a curved
 * magazine, a composite cheek panel, and the first optic in the game. The
 * muzzle stops two columns short of every other rifle while the receiver grew
 * three rows deeper, which is what "short and heavy" looks like from across a
 * room.
 */
function wBreachingCarbine(f) {
  f.slab(1, 7, 6, 6, MET_LO, 0.28, -0.28);            // skeleton stock
  f.hole(3, 9, 3, 2);                                 // the daylight through it
  f.slab(6, 5, 9, 8, MET, 0.28, -0.32);               // receiver, deep
  f.slab(8, 2, 8, 3, MET_LO, 0.28, -0.28);            // optic
  barrel(f, 15, 6, 5, 4, MET, 0.26, -0.34);           // the shroud
  f.slab(18, 6, 3, 4, MET_LO, 0.26, -0.28);           // muzzle brake, and it stops there
  f.slab(15, 11, 3, 4, MET_LO, 0.26, -0.28);          // foregrip
  f.slab(7, 13, 3, 5, MET_LO, 0.28, -0.30);           // grip
  for (let j = 0; j < 5; j++) f.slab(10 + (j > 2 ? 1 : 0), 13 + j, 3, 1, MET_LO, 0.28, -0.30);
  f.keyline();
  f.rect(7, 7, 5, 4, COMP);                           // composite cheek panel
  f.hline(7, 7, 5, COMP_HI); f.hline(7, 10, 5, COMP_LO);
  f.px(8, 8, COMP_HI); f.px(11, 9, COMP_LO);
  for (const x of [16, 17] ) { f.vline(x, 7, 3, MET_LO); f.px(x, 6, MET_HI); }   // vents
  f.px(15, 3, GLASS); f.px(15, 4, GLASS_LO);          // the lens
  f.hline(9, 3, 5, MET);
  f.rect(20, 7, 1, 3, IRON_LO);                       // the ports
  f.hline(11, 15, 2, MET); f.hline(12, 17, 2, MET);
  f.px(8, 6, MET_HI); f.px(13, 12, MET_LO);
  return f;
}

/**
 * T4 Magnetic Rifle. Two accelerator coils clamped round the barrel and a
 * power cell lit sodium in the receiver: a silhouette that cannot be mistaken
 * for anything chemical. The longest optic and the longest barrel in the set,
 * everything flush and square-cut — the silo's machine shop working at the top
 * of its ability, which is what tier four means.
 */
function wMagRifle(f) {
  f.slab(1, 6, 6, 7, MET_HI, 0.22, -0.30);            // solid stock
  f.slab(6, 5, 8, 8, MET_HI, 0.22, -0.32);            // receiver
  f.slab(3, 1, 12, 3, MET_LO, 0.28, -0.28);           // optic tube, the longest thing on it
  f.rect(6, 4, 2, 1, MET_LO); f.rect(11, 4, 2, 1, MET_LO);   // its two mounts
  barrel(f, 14, 7, 9, 3, MET_HI, 0.24, -0.34);
  f.slab(15, 4, 3, 8, MET_LO, 0.28, -0.28);           // coil one
  f.slab(19, 4, 3, 8, MET_LO, 0.28, -0.28);           // coil two
  f.slab(7, 13, 3, 5, MET_LO, 0.28, -0.30);           // grip
  f.slab(10, 13, 3, 4, MET_LO, 0.28, -0.30);          // cell magazine
  f.keyline();
  f.rect(8, 7, 5, 4, AMBER_LO);                       // the power cell
  f.hline(8, 7, 5, AMBER);
  f.px(9, 8, AMBER_HI); f.px(12, 10, AMBER_LO);
  f.px(16, 5, AMBER); f.px(20, 5, AMBER);             // windings, live
  f.px(16, 11, AMBER_LO); f.px(20, 11, AMBER_LO);
  f.px(18, 7, AMBER); f.px(18, 8, AMBER_LO);          // the rail between them, charged
  f.px(14, 2, GLASS); f.px(14, 3, GLASS_LO);          // the lens
  f.hline(3, 2, 10, MET);
  f.rect(21, 8, 2, 1, IRON_LO);                       // the bore
  f.px(11, 14, AMBER); f.px(11, 16, AMBER_LO);        // charge state
  f.hline(2, 7, 4, tone('steelLit', 0.22));
  return f;
}

/**
 * T4 loot, off a conquered silo's garrison. Another silo's standard issue:
 * timber from butt to muzzle, a bolt handle out of the top of the receiver,
 * a five-round box, iron sights, and a painted inventory band with somebody
 * else's stencilled number on it.
 *
 * The longest and FLATTEST outline of the seven, on purpose. It is the
 * cheapest thing in the game to keep in ammunition and it should look like a
 * weapon issued by the thousand rather than built by the piece.
 */
function wGarrisonRifle(f) {
  f.slab(1, 7, 8, 6, WOOD, 0.28, -0.30);              // butt
  f.clr(1, 7); f.clr(1, 12);
  f.slab(8, 8, 10, 4, WOOD, 0.26, -0.30);             // forestock, running long
  f.slab(8, 6, 6, 5, MET_LO, 0.30, -0.26);            // receiver
  barrel(f, 17, 8, 6, 2, MET_LO, 0.30, -0.32);
  f.slab(13, 4, 3, 3, MET, 0.28, -0.26);              // bolt handle
  f.slab(19, 6, 2, 3, MET_LO, 0.26, -0.26);           // front sight
  f.slab(10, 11, 3, 4, MET_LO, 0.28, -0.28);          // five-round box
  f.keyline();
  f.rect(2, 8, 4, 4, BLUE);                           // inventory band
  f.hline(2, 8, 4, BLUE_HI); f.hline(2, 11, 4, BLUE_LO);
  f.px(3, 9, PRE_HI); f.px(4, 10, PRE_HI); f.px(3, 10, BLUE_LO);   // the stencil
  f.hline(9, 7, 4, MET);                              // receiver rail
  f.hline(9, 10, 4, MET_LO);
  f.hline(6, 9, 3, WOOD_HI); f.hline(9, 11, 8, WOOD_HI);   // grain
  f.hline(9, 13, 8, WOOD_LO);
  f.rect(21, 9, 2, 1, IRON_LO);                       // the bore
  f.px(14, 4, MET_HI); f.px(11, 12, MET);
  return f;
}

/**
 * T4 loot, cut off the Slag Crews. A drum, a shroud somebody rolled by hand, a
 * carry handle, and a stock welded on at whatever angle it landed. Nothing
 * lines up with anything and every bead is left standing proud.
 *
 * The drum is the whole idea: an 11px circle hung under the receiver, the only
 * circle that size in the eighteen, so this weapon is identifiable from its
 * silhouette alone at any size the panel might shrink to. It hits hardest and
 * eats twice the ammunition, and a drum is exactly what both of those look
 * like.
 */
function wSlagAutogun(f) {
  f.slab(1, 9, 6, 5, RUST_LO, 0.28, -0.32);           // welded stock
  f.slab(6, 5, 9, 7, MET_LO, 0.30, -0.28);            // receiver, over-built
  f.slab(7, 2, 7, 3, MET_LO, 0.28, -0.28);            // carry handle
  f.hole(9, 3, 3, 1);
  barrel(f, 15, 5, 6, 5, RUSTY, 0.26, -0.36);         // the shroud
  f.slab(20, 5, 3, 5, RUST_LO, 0.26, -0.30);          // and a muzzle somebody turned
  f.disc(11, 14, 5, 4, MET_LO);                       // the drum
  f.keyline();
  f.disc(11, 14, 4, 3, MET);                          // its face
  f.disc(11, 14, 2, 1, MET_LO);
  f.px(11, 14, IRON);
  f.hline(7, 11, 8, RUST_LO);                         // where it was fitted
  weld(f, 7, 12, 9);
  weld(f, 6, 5, 9);
  weld(f, 15, 5, 5, false);
  f.hline(15, 5, 6, MET_HI);                          // it is metal, not a board
  for (const x of [16, 18]) { f.rect(x, 7, 1, 2, IRON_LO); f.px(x, 6, RUST_HI); }   // vents
  f.rect(8, 6, 4, 2, AMBER_LO); f.hline(8, 6, 4, AMBER);   // a hazard mark, sprayed on
  f.px(13, 7, MET_HI); f.px(13, 10, MET);
  f.px(3, 10, RUSTY); f.px(5, 12, RUST_HI);
  f.rect(21, 6, 2, 2, IRON_LO);                       // the bore
  f.px(8, 16, RUST_LO); f.px(14, 16, RUST_LO);        // rot on the drum
  return f;
}

/**
 * T5, the Scar only. Pre-collapse: a bone shell with not one fastener on it, a
 * light-pipe down the spine, a thumbhole through the body, and a ring emitter
 * where every other weapon in the game has a hole in a tube.
 *
 * It is the emptiest icon in the set, and that is the argument. Everything the
 * silo builds is busy because the silo bolts things together; this was moulded
 * in one piece by somebody who did not have to.
 */
function wRailCarbine(f) {
  f.slab(2, 5, 19, 7, PRE, 0.16, -0.24);              // the shell, one piece
  f.clr(2, 5); f.clr(2, 11); f.clr(20, 5);            // moulded corners
  f.slab(6, 11, 9, 7, PRE, 0.14, -0.22);              // grip housing
  f.hole(8, 13, 5, 4);                                // the thumbhole
  f.slab(19, 4, 4, 9, PRE_LO, 0.20, -0.24);           // emitter ring
  f.hole(20, 6, 2, 5);
  f.keyline();
  f.hline(3, 6, 17, PRE_HI);                          // the moulded highlight
  f.hline(4, 10, 16, PRE_DK);
  f.rect(4, 7, 14, 2, GLASS_LO);                      // the light-pipe
  f.hline(4, 7, 14, GLASS);
  f.px(5, 7, GLASS_HI); f.px(17, 7, GLASS_HI);
  f.px(20, 7, GLASS_HI); f.px(20, 9, GLASS);          // the emitter, live
  f.hline(7, 12, 7, PRE_HI);
  f.px(7, 16, PRE_DK); f.px(13, 16, PRE_DK);
  return f;
}

/* =============================================================== armour == */
/*
 * A cuirass seen front on: shoulders across the top, chest down the middle,
 * cut off at the waist, no head. That last part is the class tell — an
 * env-suit HAS a head and a piece of armour never does, which separates the
 * two families at a glance even when both of them are grey.
 *
 * Tier is in the SHOULDER LINE, which is the part of a torso the eye reads
 * first: the vest has soft rolls, the harness has bare straps, the rig has
 * capped shoulders, the breacher has pauldrons taller than its own gorget.
 */

/**
 * A torso built from a span per row, so the outline can actually taper.
 * Rectangles were the first draft's mistake: a cuirass that is the same width
 * at the collarbone and the waist reads as a signboard, and the padded vest
 * and the composite rig — genuinely different objects — came within 8 cells of
 * the same silhouette because both were 12x13 blocks.
 */
function torso(f, top, spans, c, lit = 0.26, dk = -0.30) {
  spans.forEach(([x0, x1], j) => {
    const y = top + j;
    f.hline(x0, y, x1 - x0 + 1, c);
    f.px(x0, y, shade(c, lit));
    f.px(x1, y, shade(c, dk));
  });
  const [a0, a1] = spans[0];
  f.hline(a0, top, a1 - a0 + 1, shade(c, lit));
  const [z0, z1] = spans[spans.length - 1];
  f.hline(z0, top + spans.length - 1, z1 - z0 + 1, shade(c, dk));
  return f;
}

/**
 * T1 Padded Vest. Canvas over foam: rolled shoulders, quilted courses, two
 * leather straps and a frayed hem. There is not one hard edge in the
 * silhouette, which is the point — the only armour in the game with no plate
 * in its outline, and it argues with a bullet.
 */
function aPaddedVest(f) {
  torso(f, 3, [
    [8, 15], [7, 16], [5, 18], [5, 18], [5, 18], [5, 18], [6, 17],
    [6, 17], [6, 17], [6, 17], [6, 17], [7, 16], [7, 16], [8, 15],
  ], CANVAS);
  f.hole(10, 3, 4, 3);                                // neck
  f.keyline();
  for (const y of [7, 10, 13]) {                      // quilting courses
    f.hline(7, y, 10, CANVAS_LO);
    f.hline(7, y + 1, 10, CANVAS_HI);
  }
  f.vline(8, 5, 11, WOOD);                            // straps
  f.vline(15, 5, 11, WOOD);
  f.px(8, 5, WOOD_HI); f.px(15, 5, WOOD_HI);
  f.rect(8, 11, 1, 2, MET); f.rect(15, 11, 1, 2, MET);    // buckles
  f.px(6, 7, CANVAS_HI); f.px(17, 9, CANVAS_LO);
  f.px(10, 16, CANVAS_LO); f.px(13, 16, CANVAS_LO);   // a frayed hem
  return f;
}

/**
 * T2 Plate Harness. Salvaged plate strapped over webbing. Hard edges arrive,
 * but only in the middle: the shoulders are still nothing but straps, so this
 * has the narrowest outline of the six and the first raised centre ridge.
 */
function aPlateHarness(f) {
  // Leather over the shoulders, the same hide as the belt at the bottom, so
  // the two read as one harness rather than as two unrelated brown things. The
  // first draft ran these five rows proud of the plate in canvas green and
  // they read as a pair of eyes looking out of the icon.
  f.slab(7, 4, 3, 4, WOOD, 0.26, -0.30);
  f.slab(14, 4, 3, 4, WOOD, 0.26, -0.30);
  torso(f, 6, [
    [7, 16], [6, 17], [5, 18], [5, 18], [5, 18], [5, 18],
    [6, 17], [6, 17], [7, 16], [7, 16],
  ], MET);
  f.slab(5, 16, 14, 2, WOOD, 0.26, -0.30);            // belt
  f.keyline();
  f.vline(11, 7, 9, tone('steel', 0.34));             // the raised centre ridge
  f.vline(12, 7, 9, MET_LO);
  f.hline(8, 7, 8, tone('steel', 0.24));              // its lit brow
  f.hline(6, 14, 12, MET_LO);
  rivets(f, [6, 9, 14, 17], 9, MET_HI);
  rivets(f, [6, 17], 13, MET_HI);
  f.rect(11, 16, 2, 2, MET); f.px(12, 17, IRON);      // buckle
  f.px(8, 10, MET_HI); f.px(15, 11, MET_LO);          // dents
  f.hline(7, 4, 3, WOOD_HI); f.hline(14, 4, 3, WOOD_HI);
  f.px(8, 6, WOOD_LO); f.px(15, 6, WOOD_LO);
  f.vline(6, 8, 6, WOOD); f.vline(17, 8, 6, WOOD);    // and down the sides
  f.px(6, 8, WOOD_HI); f.px(17, 8, WOOD_HI);
  return f;
}

/**
 * T3 Composite Rig. Alloy over the chest, verdigris weave below it, a gorget
 * at the throat and capped shoulders — three materials, one more than anything
 * below it, and the first armour whose outline has shoulders at all.
 */
function aCompositeRig(f) {
  f.slab(9, 1, 6, 4, MET, 0.28, -0.28);               // gorget
  f.hole(10, 1, 4, 2);
  f.slab(2, 5, 6, 5, MET, 0.28, -0.30);               // shoulder caps, wide and low
  f.slab(16, 5, 6, 5, MET, 0.28, -0.30);
  f.clr(2, 5); f.clr(21, 5); f.clr(2, 9); f.clr(21, 9);
  torso(f, 4, [
    [8, 15], [7, 16], [7, 16], [7, 16], [7, 16], [7, 16],
    [7, 16], [7, 16], [7, 16], [7, 16], [8, 15], [8, 15], [9, 14],
  ], MET);
  f.keyline();
  f.rect(8, 10, 8, 6, COMP);                          // the weave, lower half
  for (let y = 10; y <= 15; y++) {
    for (let x = 8; x <= 15; x++) {
      if (f.at(x, y) === null) continue;
      if ((x + y) % 2 === 0) f.px(x, y, COMP_HI);
      else if ((x + y) % 4 === 3) f.px(x, y, COMP_LO);
    }
  }
  f.hline(8, 10, 8, COMP_HI); f.hline(9, 15, 6, COMP_LO);
  f.hline(8, 5, 8, tone('steel', 0.28));              // plate brow
  f.vline(11, 5, 5, tone('steel', 0.30));             // centre seam
  f.vline(12, 5, 5, MET_LO);
  f.rect(10, 11, 4, 2, MET); f.hline(10, 11, 4, MET_HI);   // clasp
  f.px(11, 12, AMBER); f.px(12, 12, AMBER_LO);
  f.hline(3, 6, 4, MET_HI); f.hline(17, 6, 4, MET_HI);
  f.hline(3, 8, 4, MET_LO); f.hline(17, 8, 4, MET_LO);
  return f;
}

/**
 * T4 Breacher Plate. Built for standing in a doorway somebody else is shooting
 * at: pauldrons nine rows tall, a raised gorget, a thick centre rib and a
 * hazard chevron in the silo's own sodium. The widest and squarest outline in
 * the eighteen, and the only one that fills its frame corner to corner.
 */
function aBreacherPlate(f) {
  f.slab(9, 1, 6, 4, MET_HI, 0.22, -0.28);            // gorget
  f.hole(10, 1, 4, 2);
  f.slab(1, 3, 6, 9, MET_HI, 0.22, -0.32);            // pauldrons
  f.slab(17, 3, 6, 9, MET_HI, 0.22, -0.32);
  f.clr(1, 3); f.clr(22, 3); f.clr(1, 11); f.clr(22, 11);
  torso(f, 4, [
    [6, 17], [6, 17], [6, 17], [6, 17], [6, 17], [6, 17], [6, 17],
    [6, 17], [6, 17], [6, 17], [7, 16], [7, 16], [7, 16], [8, 15],
  ], MET_HI, 0.22, -0.32);
  f.keyline();
  f.vline(11, 5, 12, tone('steelLit', 0.26));         // centre rib
  f.vline(12, 5, 12, MET);
  f.hline(7, 5, 10, tone('steelLit', 0.26));
  for (let i = 0; i < 4; i++) {                       // the chevron
    f.px(7 + i, 8 + i, AMBER); f.px(7 + i, 9 + i, AMBER_LO);
    f.px(16 - i, 8 + i, AMBER); f.px(16 - i, 9 + i, AMBER_LO);
  }
  f.px(11, 11, AMBER_HI); f.px(12, 11, AMBER);
  rivets(f, [3, 5], 5); rivets(f, [18, 20], 5);
  rivets(f, [3, 5], 10); rivets(f, [18, 20], 10);
  f.hline(2, 7, 4, MET); f.hline(18, 7, 4, MET);      // pauldron lames
  f.hline(2, 9, 4, MET_LO); f.hline(18, 9, 4, MET_LO);
  f.hline(8, 15, 8, MET);                             // waist lame
  f.hline(8, 16, 8, MET_LO);
  return f;
}

/**
 * T4 loot, off the Slag Crews. It absorbs a wound rather than turning it, and
 * it looks like that: four pieces of somebody else's armour welded onto a
 * frame, one heavy pauldron on the left arm, a bare strap on the right, and
 * every bead left standing where it was laid.
 *
 * The asymmetry is the tell, and it is the ONLY asymmetric icon in the
 * eighteen. Nothing the silo builds is lopsided; nothing the Slag Crews make
 * is anything else.
 */
function aSlagPlate(f) {
  f.slab(1, 2, 8, 10, RUSTY, 0.26, -0.34);            // the one big pauldron
  f.clr(1, 2); f.clr(8, 2); f.clr(1, 11);
  f.slab(15, 5, 3, 4, CANVAS_LO, 0.22, -0.26);        // a strap on the other side
  f.slab(6, 6, 12, 12, MET_LO, 0.26, -0.30);          // the frame
  f.clr(17, 17); f.clr(6, 17); f.clr(16, 17);         // and a ragged bottom edge
  f.keyline();
  f.rect(7, 7, 5, 4, MET);                            // patch: salvaged plate
  f.hline(7, 7, 5, tone('steel', 0.26));
  f.rect(12, 7, 5, 5, RUST_LO);                       // patch: cut from a drum
  f.hline(12, 7, 5, RUSTY);
  f.rect(7, 12, 5, 5, CONC);                          // patch: whatever this was
  f.hline(7, 12, 5, tone('concrete', 0.24));
  f.rect(12, 13, 5, 4, MET_LO);                       // patch: the last one
  f.hline(12, 13, 5, MET);
  weld(f, 7, 11, 5);                                  // beads along every join
  weld(f, 12, 12, 5);
  weld(f, 12, 7, 5, false);
  weld(f, 6, 6, 12);
  f.px(9, 9, MET_LO); f.px(14, 15, IRON);             // gouges
  f.rect(3, 4, 4, 3, RUST_LO); f.hline(3, 4, 4, RUST_HI);   // a plate riveted on
  f.px(4, 8, RUST_HI); f.px(6, 10, RUST_HI); f.px(2, 6, RUST_HI);
  f.hline(13, 14, 3, AMBER_LO); f.px(13, 14, AMBER);  // a stencil somebody sprayed
  f.px(16, 6, MET_HI);
  return f;
}

/**
 * T5, the Scar. A standing gorget, two moulded shoulder caps, a breastplate
 * carrying a verdigris yoke line along the collarbones, and a segmented skirt
 * tapering below the waist. Four pieces, no fastener on any of them.
 *
 * IT WAS A WHITE T-SHIRT, and the best armour in the game read as the least
 * interesting thing in the sheet. Five drafts, and each failure taught the
 * next one something worth writing down, because all of them are traps that
 * look fine in code:
 *
 *   1. A tapering bone rectangle with a green stripe. No structure at all.
 *   2. A wide thin yoke over a narrow chest, waist pinched, tassets flared.
 *      The metric loved it — 24/144 from the Padded Vest — and it read as a
 *      CHESS PIECE. A thin full-width bar on a symmetrical taper is a capital
 *      on a column, and measuring without looking is how it shipped that far.
 *   3. Pectorals as horizontal highlights, abdomen as full-width bands. Every
 *      mark horizontal, on a symmetrical body: architecture, not anatomy.
 *   4. Swells drawn with discs. Lumpy — a melted candle.
 *   5. The three pieces pushed apart onto their own keylines. Fully detached:
 *      three unconnected objects sitting on a shelf.
 *
 * What finally worked is the construction the Breacher Plate already uses, and
 * it is worth stating plainly because it is not obvious: the masses TOUCH and
 * are separated by tone, and the icon earns its read from ONE DIAGONAL
 * COLOURED GRAPHIC. The Breacher's is an amber chevron; this is the same
 * device in the Scar's own verdigris, following the collarbones. On a
 * symmetrical torso at 24px, a mark running at neither 0 nor 90 degrees is the
 * only kind the eye reliably holds.
 *
 * Staying tier 5 and not tier 4 is a width problem. At six-wide caps this came
 * within 10/144 cells of the Breacher Plate — the one icon it must never be
 * confused with, since the player owns both and chooses. Five-wide caps that
 * stop four rows short of the Breacher's pauldrons keep it the second-broadest
 * shoulder in the class and 20 cells clear of it.
 *
 * Against the Padded Vest, the pair a tier 1 and a tier 5 should be furthest
 * apart in: 12/144 before this redraw, exactly on the bar, and 20/144 after.
 * The whole class floor moved from 12 to 14.
 */
function aCompactCuirass(f) {
  // Breastplate, shoulder caps and skirt, all TOUCHING — one silhouette,
  // separated by tone and by a groove, exactly the way the Breacher Plate
  // carries its pauldrons. A draft that pushed them apart onto their own
  // keylines read as three unconnected objects on a shelf.
  torso(f, 1, [
    [10, 13], [10, 13], [9, 14], [8, 15],                   // standing gorget
    [7, 16], [7, 16], [7, 16], [7, 16],                     // chest
    [8, 15], [8, 15], [9, 14],                              // and in to the waist
  ], PRE, 0.16, -0.26);
  // Caps, not pauldrons. Six wide put this within 10/144 cells of the
  // Breacher Plate — the silo's tier 4, the one icon it must NOT be mistaken
  // for. Five wide, and stopping four rows short of the Breacher's, is the
  // width at which it is still the second-broadest shoulder in the class and
  // no longer that shape.
  f.slab(3, 4, 5, 6, PRE_LO, 0.22, -0.24);
  f.slab(16, 4, 5, 6, PRE_LO, 0.22, -0.24);
  for (const [x, y] of [[3, 4], [3, 9], [20, 4], [20, 9]]) f.clr(x, y);
  // The skirt TAPERS IN. Drafts that flared it read as a plinth: stepped
  // horizontal bands getting wider toward the floor is the silhouette of a
  // pedestal, and no amount of shading inside it argues otherwise.
  torso(f, 12, [
    [8, 15], [8, 15], [8, 15], [8, 15], [9, 14], [9, 14],
  ], PRE, 0.16, -0.26);
  f.hole(10, 2, 4, 1);                                  // the collar's opening
  f.keyline();

  // THE GRAPHIC. The one line on the Breacher Plate that survives being 24px
  // tall is its amber chevron, and the reason is that it is the only mark on
  // it running at neither 0 nor 90 degrees: on a symmetrical torso every
  // horizontal moulding reads as architecture, which is precisely what three
  // drafts of this icon read as. So this gets the same device in the Scar's
  // own colour — a verdigris yoke line following the collarbones, which is
  // also the only thing on the piece that is lit from inside.
  for (let i = 0; i < 4; i++) {
    f.px(8 + i, 4 + i, GLASS); f.px(15 - i, 4 + i, GLASS);
    f.px(8 + i, 5 + i, GLASS_LO); f.px(15 - i, 5 + i, GLASS_LO);
  }
  f.px(11, 8, GLASS_HI); f.px(12, 8, GLASS);
  f.vline(11, 9, 3, PRE_DK);                            // the sternum below it
  f.vline(12, 9, 3, PRE_HI);

  f.hline(4, 5, 3, PRE_HI); f.hline(17, 5, 3, PRE_DK);  // the caps' faces
  f.hline(4, 8, 3, PRE_DK); f.hline(17, 8, 3, PRE_DK);
  f.hline(8, 12, 8, PRE_DK);                            // the skirt articulates here
  f.hline(8, 13, 8, PRE_HI);
  f.hline(9, 15, 6, PRE_DK);                            // one more segment, and no more
  f.hline(9, 16, 6, PRE_HI);
  return f;
}

/* ============================================================= env-suits == */
/*
 * A standing figure with a helmet, which is the class tell: nothing in the
 * weapons or the armour has a head, so a suit is never mistaken for either,
 * even at a glance and even in the same grey.
 *
 * Tier is bulk and air. T1 is a hood over coveralls with one scrubber can, T4
 * has pauldrons wider than its own helmet and a tank either side, and T5 has
 * no tank at all — the only piece of kit in the game whose tier makes it
 * SMALLER, which is exactly the thing a player who has just spent seventy
 * alloy on suit four should feel before they read a single number.
 */

/** The visor glass, common to four of the five. Lit from the upper left. */
function visor(f, x, y, w, h, c = GLASS) {
  f.rect(x, y, w, h, c);
  f.hline(x, y, w, GLASS_HI);
  if (h > 1) f.hline(x, y + h - 1, w, GLASS_LO);
  f.px(x, y, GLASS_HI);
  return f;
}

/** Legs with real daylight between them: two columns of transparency. */
function legs(f, top, h, x0, w, c) {
  f.slab(x0, top, w, h, c, 0.24, -0.28);
  f.slab(24 - x0 - w, top, w, h, c, 0.24, -0.28);
  return f;
}

/**
 * T1 Env-Suit I. Sealed canvas and a scrubber: a soft hood, a porthole you
 * could not see much through, one small canister and a hose. Everything about
 * the outline is slack, and there is not a hard panel on it.
 */
function sSuit1(f) {
  f.slab(9, 2, 7, 7, CANVAS, 0.26, -0.28);            // the hood
  f.clr(9, 2); f.clr(15, 2);
  torso(f, 9, [[9, 14], [8, 15], [8, 15], [8, 15], [8, 15], [8, 15], [9, 14]], CANVAS);
  f.slab(6, 10, 2, 5, CANVAS_LO, 0.24, -0.26);        // arms
  f.slab(17, 10, 2, 5, CANVAS_LO, 0.24, -0.26);
  legs(f, 16, 3, 8, 3, CANVAS_LO);
  f.slab(3, 10, 3, 6, MET_LO, 0.28, -0.26);           // the scrubber
  f.keyline();
  visor(f, 11, 4, 3, 3, GLASS_LO);                    // a porthole, not a visor
  f.px(6, 9, MET_LO); f.px(7, 9, MET_LO); f.px(5, 9, MET_LO);   // the hose
  f.hline(8, 13, 8, CANVAS_LO);                       // a belt of webbing
  f.hline(8, 14, 8, CANVAS_HI);
  f.hline(3, 12, 3, MET); f.px(4, 11, MET_HI);        // the canister's band
  f.px(10, 11, CANVAS_LO); f.px(14, 12, CANVAS_LO);   // slack in the canvas
  f.px(12, 3, CANVAS_HI);
  return f;
}

/**
 * T2 Env-Suit II. Layered shielding: a hard helmet with a real visor, a plate
 * across the chest, cuffed sleeves, boots and two canisters. The Mid waste
 * becomes survivable and the suit starts looking like equipment rather than
 * like clothes.
 */
function sSuit2(f) {
  f.slab(8, 1, 9, 8, MET, 0.26, -0.28);               // hard helmet
  f.clr(8, 1); f.clr(16, 1);
  torso(f, 9, [[8, 16], [7, 17], [7, 17], [7, 17], [7, 17], [7, 17], [8, 16]], CANVAS);
  f.slab(5, 10, 2, 6, CANVAS_LO, 0.24, -0.26);        // arms
  f.slab(18, 10, 2, 6, CANVAS_LO, 0.24, -0.26);
  legs(f, 16, 2, 7, 4, MET_LO);
  f.slab(2, 8, 4, 7, MET_LO, 0.28, -0.26);            // twin canisters
  f.keyline();
  visor(f, 9, 3, 7, 3);
  f.rect(9, 10, 7, 4, MET);                           // chest plate
  f.hline(9, 10, 7, tone('steel', 0.28)); f.hline(9, 13, 7, MET_LO);
  f.px(10, 11, MET_HI); f.px(14, 12, AMBER);          // a working gauge
  f.hline(5, 13, 2, MET_LO); f.hline(18, 13, 2, MET_LO);   // cuffs
  f.px(6, 9, MET_LO); f.px(7, 9, MET);                // hose
  f.vline(4, 9, 5, MET_LO);                           // the seam between the cans
  f.hline(2, 10, 4, MET); f.hline(2, 13, 4, MET_LO);
  f.hline(9, 7, 7, MET_LO);
  return f;
}

/**
 * T3 Env-Suit III. Deep waste and silo approaches: a brow ridge over a wider
 * visor, a helmet lamp, a woven torso, ribbed limbs and a proper tank standing
 * up beside the shoulder with a valve on top of it. The verdigris weave is the
 * same material as the composite rig, which is deliberate — one tier of
 * technology, two applications of it.
 */
function sSuit3(f) {
  f.slab(8, 3, 10, 7, MET, 0.26, -0.28);              // helmet
  f.slab(6, 1, 13, 3, MET_HI, 0.24, -0.28);           // brow ridge, wider than the helmet
  f.clr(6, 1); f.clr(18, 1);
  torso(f, 10, [[8, 16], [7, 17], [7, 17], [7, 17], [7, 17], [7, 17], [8, 16]], COMP);
  f.slab(4, 10, 3, 7, COMP_LO, 0.24, -0.26);          // ribbed arms
  f.slab(17, 10, 3, 7, COMP_LO, 0.24, -0.26);
  legs(f, 17, 2, 8, 3, MET_LO);
  f.slab(1, 4, 3, 12, MET, 0.28, -0.26);              // the tank, standing above the shoulder
  f.rect(1, 3, 2, 1, MET_HI);                         // its valve
  f.keyline();
  visor(f, 9, 5, 8, 3);
  f.px(8, 5, AMBER); f.px(8, 6, AMBER_LO);            // helmet lamp
  for (let y = 11; y <= 15; y++) {                    // the weave
    for (let x = 8; x <= 16; x++) if ((x + y) % 2 === 0) f.px(x, y, COMP_HI);
  }
  for (const y of [11, 14]) {                         // ribs
    f.hline(4, y, 3, COMP_HI); f.hline(17, y, 3, COMP_HI);
    f.hline(4, y + 1, 3, COMP_LO); f.hline(17, y + 1, 3, COMP_LO);
  }
  f.rect(10, 12, 4, 3, MET_LO);                       // chest gauge
  f.hline(10, 12, 4, MET); f.px(11, 13, AMBER); f.px(12, 13, AMBER_LO);
  f.hline(1, 6, 3, MET_HI); f.hline(1, 10, 3, MET_LO); f.hline(1, 13, 3, MET_LO);
  f.px(4, 9, MET); f.px(5, 9, MET_LO);                // hose
  f.hline(9, 16, 7, COMP_LO);
  return f;
}

/**
 * T4 Env-Suit IV. The Scar, twelve days out and back if the seals hold. A
 * rigid shell: pauldrons that stand higher than the collar, a deep visor with
 * a lamp either side of it, a tank behind each shoulder, thick boots, bright
 * alloy throughout. It should look like it weighs something.
 */
function sSuit4(f) {
  f.slab(8, 1, 9, 9, MET_HI, 0.22, -0.30);            // helmet, big
  f.clr(8, 1); f.clr(16, 1);
  f.slab(2, 6, 5, 9, MET_HI, 0.22, -0.32);            // pauldrons, above the collar
  f.slab(18, 6, 5, 9, MET_HI, 0.22, -0.32);
  f.clr(2, 6); f.clr(22, 6); f.clr(2, 14); f.clr(22, 14);
  torso(f, 10, [[7, 17], [6, 18], [6, 18], [6, 18], [6, 18], [7, 17], [7, 17]], MET_HI, 0.22, -0.32);
  legs(f, 17, 2, 6, 5, MET);
  f.slab(4, 3, 3, 4, MET, 0.28, -0.26);               // a tank behind each shoulder
  f.slab(18, 3, 3, 4, MET, 0.28, -0.26);
  f.keyline();
  visor(f, 9, 4, 7, 4);
  f.px(8, 5, AMBER); f.px(8, 6, AMBER_LO);            // a lamp either side
  f.px(16, 5, AMBER); f.px(16, 6, AMBER_LO);
  f.hline(9, 3, 7, tone('steelLit', 0.26));           // the brow
  f.rect(9, 12, 6, 4, MET);                           // chest module
  f.hline(9, 12, 6, tone('steel', 0.30)); f.hline(9, 15, 6, MET_LO);
  f.px(10, 13, AMBER); f.px(13, 14, GLASS);
  f.hline(3, 7, 4, tone('steelLit', 0.26));           // pauldron lames
  f.hline(19, 7, 4, tone('steelLit', 0.26));
  f.hline(3, 10, 4, MET); f.hline(19, 10, 4, MET);
  f.hline(3, 12, 4, MET_LO); f.hline(19, 12, 4, MET_LO);
  f.hline(4, 4, 3, MET_HI); f.hline(18, 4, 3, MET_HI);
  f.px(7, 5, MET); f.px(17, 5, MET);                  // the hoses in
  f.hline(8, 16, 9, MET_LO);
  return f;
}

/**
 * T5 loot, the Scar. Pre-collapse, and it barely wears at all: a skin with a
 * wraparound visor band, seam lights down the limbs, and no tank anywhere —
 * whatever it breathes, it is not carrying it.
 *
 * The slimmest outline of the five by a wide margin, which is the tell, and
 * the only figure in the set with a neck.
 */
function sRegistrySkin(f) {
  f.slab(9, 2, 6, 6, PRE, 0.16, -0.24);               // the head
  f.clr(9, 2); f.clr(14, 2);
  f.rect(11, 8, 2, 1, PRE_LO);                        // a neck, which nothing else has
  torso(f, 9, [[10, 13], [9, 14], [9, 14], [9, 14], [9, 14], [10, 13], [10, 13]], PRE, 0.16, -0.24);
  f.slab(7, 9, 2, 6, PRE_LO, 0.16, -0.22);            // arms
  f.slab(15, 9, 2, 6, PRE_LO, 0.16, -0.22);
  legs(f, 16, 3, 9, 2, PRE_LO);
  f.keyline();
  f.rect(9, 4, 6, 2, GLASS_LO);                       // the wraparound band
  f.hline(9, 4, 6, GLASS);
  f.px(10, 4, GLASS_HI);
  f.vline(11, 10, 5, GLASS_LO);                       // the seam lights
  f.px(11, 10, GLASS); f.px(11, 14, GLASS);
  f.px(7, 11, GLASS_LO); f.px(16, 11, GLASS_LO);
  f.px(9, 17, GLASS_LO); f.px(14, 17, GLASS_LO);
  f.px(12, 9, PRE_HI); f.px(12, 3, PRE_HI);
  return f;
}

/* ================================================================ table == */

/**
 * The eighteen, with the tier and the provenance the icon has to communicate.
 * `tier` and `kind` are duplicated from src/data/items.js on purpose — this
 * module must not import the game's data layer — and the self-test imports
 * items.js and fails if the two ever disagree.
 */
export const GEAR_ITEMS = {
  // weapons
  pipe_gun: { kind: 'weapon', tier: 1, origin: 'silo', draw: wPipeGun },
  service_rifle: { kind: 'weapon', tier: 2, origin: 'silo', draw: wServiceRifle },
  breaching_carbine: { kind: 'weapon', tier: 3, origin: 'silo', draw: wBreachingCarbine },
  mag_rifle: { kind: 'weapon', tier: 4, origin: 'silo', draw: wMagRifle },
  garrison_rifle: { kind: 'weapon', tier: 4, origin: 'garrison', draw: wGarrisonRifle },
  slag_autogun: { kind: 'weapon', tier: 4, origin: 'slag', draw: wSlagAutogun },
  rail_carbine: { kind: 'weapon', tier: 5, origin: 'scar', draw: wRailCarbine },
  // armour
  padded_vest: { kind: 'armor', tier: 1, origin: 'silo', draw: aPaddedVest },
  plate_harness: { kind: 'armor', tier: 2, origin: 'silo', draw: aPlateHarness },
  composite_rig: { kind: 'armor', tier: 3, origin: 'silo', draw: aCompositeRig },
  breacher_plate: { kind: 'armor', tier: 4, origin: 'silo', draw: aBreacherPlate },
  slag_plate: { kind: 'armor', tier: 4, origin: 'slag', draw: aSlagPlate },
  compact_cuirass: { kind: 'armor', tier: 5, origin: 'scar', draw: aCompactCuirass },
  // env-suits
  suit_1: { kind: 'suit', tier: 1, origin: 'silo', draw: sSuit1 },
  suit_2: { kind: 'suit', tier: 2, origin: 'silo', draw: sSuit2 },
  suit_3: { kind: 'suit', tier: 3, origin: 'silo', draw: sSuit3 },
  suit_4: { kind: 'suit', tier: 4, origin: 'silo', draw: sSuit4 },
  registry_skin: { kind: 'suit', tier: 5, origin: 'scar', draw: sRegistrySkin },
};

/**
 * `GEAR[id](painter)` — what gen-atlas.mjs calls. The pip strip is applied
 * here rather than inside each draw function so no icon can forget it, get it
 * wrong, or put it somewhere else.
 */
export const GEAR = Object.fromEntries(
  Object.entries(GEAR_ITEMS).map(([id, spec]) => [
    id,
    (p) => {
      const f = form(GEAR_SIZE, GEAR_SIZE);
      spec.draw(f);
      pips(f, spec.tier, spec.origin);
      f.blit(p);
      return p;
    },
  ])
);

export default { GEAR, GEAR_ITEMS, GEAR_SIZE, PIP_Y, PIP_SLOTS, ART_BOTTOM };

/* ============================================================= self-test == */
/*
 * Runs from `node tools/art/gear.mjs`. It proves the claims the header makes,
 * and it is measurement rather than eyeballing, because every one of these is
 * a thing that breaks silently.
 *
 * COVERAGE IS DERIVED, NOT COUNTED. The check is not "there are eighteen
 * frames": it imports src/data/items.js — the list the Military panel actually
 * iterates — and requires a frame for every id in it, with a matching tier and
 * kind. Add an item to the game and this fails until it has an icon; change an
 * item's tier and this fails until the pips agree.
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

/** A 1-bit silhouette on a 12x12 grid — what the shape reads as at a glance. */
function silhouette(px, size, at) {
  const G = 12, cell = at.w / G;
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

/**
 * Outline complexity: how many times the silhouette's boundary turns on and
 * off, scanned in both axes. A busier object has more runs. This is the
 * measurable version of "tier adds a feature", and it is scale-free, so a
 * merely bigger sprite does not pass it.
 */
function outlineRuns(px, size, at) {
  let runs = 0;
  const on = (x, y) => readPixel(px, size, at, x, y)[3] > 127;
  for (let y = 0; y < ART_BOTTOM + 2; y++) {
    let prev = false;
    for (let x = 0; x < at.w; x++) { const v = on(x, y); if (v && !prev) runs++; prev = v; }
  }
  for (let x = 0; x < at.w; x++) {
    let prev = false;
    for (let y = 0; y < ART_BOTTOM + 2; y++) { const v = on(x, y); if (v && !prev) runs++; prev = v; }
  }
  return runs;
}

/** Ink fraction, over the painted pixels only. Outlined lace is not art. */
function inkFraction(px, size, at) {
  let ink = 0, painted = 0;
  for (let y = 0; y < at.h; y++) {
    for (let x = 0; x < at.w; x++) {
      const c = readPixel(px, size, at, x, y);
      if (c[3] === 0) continue;
      painted++;
      if (c[0] === INK[0] && c[1] === INK[1] && c[2] === INK[2]) ink++;
    }
  }
  return ink / Math.max(1, painted);
}

/** The pips, read back off the pixels rather than trusted. */
function readPips(px, size, at) {
  let filled = 0, empty = 0;
  const slotColour = [];
  for (let i = 0; i < PIP_SLOTS; i++) {
    const x = PIP_X + i * PIP_PITCH;
    const c = readPixel(px, size, at, x, PIP_Y + 1);   // the bar's middle row
    const key = c.slice(0, 3).join(',');
    slotColour.push(key);
    if (key === SLOT.join(',')) empty++;
    else filled++;
  }
  return { filled, empty, slotColour };
}

async function runSelfTest() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  }));

  const sheet = atlas(512);
  const problems = [];
  const built = [];
  for (const [id, spec] of Object.entries(GEAR_ITEMS)) {
    const p = sheet.sprite(`gear_${id}`, GEAR_SIZE, GEAR_SIZE);
    GEAR[id](p);
    built.push({ id, spec, at: sheet.frames[`gear_${id}`] });
  }

  // --- coverage, derived from the game's own item list ---------------------
  // The chain that has to hold is: the Military panel asks frameCanvas() for
  // `gear_<id>` for every item in itemsOfKind(); this module draws GEAR[id];
  // gen-atlas.mjs packs it under that name. Any one of those three drifting
  // shows the player an empty box, and only the ends of the chain are checked
  // by anything else — so all three links are checked here, against the real
  // items.js and the real assets/atlas.json rather than against a count.
  let itemsSeen = 0;
  try {
    const items = await import('../../src/data/items.js');
    for (const item of items.ITEM_LIST) {
      itemsSeen++;
      const spec = GEAR_ITEMS[item.id];
      if (!spec) { problems.push(`items.js has "${item.id}" (${item.kind} T${item.tier}) with no icon`); continue; }
      if (spec.tier !== item.tier) problems.push(`${item.id}: icon draws T${spec.tier}, items.js says T${item.tier}`);
      if (spec.kind !== item.kind) problems.push(`${item.id}: icon is a ${spec.kind}, items.js says ${item.kind}`);
    }
    const orphans = Object.keys(GEAR_ITEMS).filter((id) => !items.ITEMS[id]);
    console.log(`  [coverage]     ${itemsSeen} items in src/data/items.js, all with an icon` +
      (orphans.length ? `; ${orphans.length} icon(s) drawn ahead of the data: ${orphans.join(', ')}` : ''));

    // And the shipped sheet. Absent, this is a build that has not been run —
    // not a failure. Present and short of a frame, the panel is broken now.
    const { readFile } = await import('node:fs/promises');
    const here = new URL('.', import.meta.url);
    try {
      const table = JSON.parse(await readFile(new URL('../../assets/atlas.json', here), 'utf8'));
      const gone = items.ITEM_LIST.filter((i) => !table.frames[`gear_${i.id}`]).map((i) => i.id);
      if (gone.length) {
        problems.push(`assets/atlas.json has no gear_ frame for ${gone.join(', ')} — run node tools/gen-atlas.mjs`);
      }
      const sized = items.ITEM_LIST
        .map((i) => table.frames[`gear_${i.id}`])
        .filter((f) => f && (f.w !== GEAR_SIZE || f.h !== GEAR_SIZE));
      if (sized.length) problems.push(`${sized.length} packed gear frame(s) are not ${GEAR_SIZE}x${GEAR_SIZE}`);
      console.log(`  [atlas]        assets/atlas.json carries all ${itemsSeen} at ${GEAR_SIZE}x${GEAR_SIZE}`);
    } catch {
      console.log('  [atlas]        assets/atlas.json not built yet — skipped');
    }
  } catch (err) {
    problems.push(`could not read src/data/items.js to check coverage: ${err.message}`);
  }

  // --- per frame -----------------------------------------------------------
  const rows = [];
  for (const b of built) {
    const st = frameStats(sheet.px, sheet.size, b.at);
    const cover = st.painted / st.total;
    const ink = inkFraction(sheet.px, sheet.size, b.at);
    const runs = outlineRuns(sheet.px, sheet.size, b.at);

    if (!st.painted) problems.push(`gear_${b.id}: nothing drawn`);
    if (st.partial) problems.push(`gear_${b.id}: ${st.partial}px partially transparent — no alpha blending allowed`);
    if (st.illegal) {
      const f = st.firstBad;
      problems.push(`gear_${b.id}: ${st.illegal}px off palette, first at ${f.x},${f.y} = rgb(${f.c.slice(0, 3)})`);
    }
    if (cover < 0.16) problems.push(`gear_${b.id}: ${(cover * 100) | 0}% covered — too little to read in a list`);
    if (cover > 0.80) problems.push(`gear_${b.id}: ${(cover * 100) | 0}% covered — no air around the silhouette`);
    // The bar is measured, not invented: the sixteen shipped 16x16 props run
    // 29% to 63% ink and the threats 27% to 53%. A 24x24 icon has a better
    // perimeter-to-area ratio than either, so it is held tighter than the
    // whole of that range — but not so tight that a legitimately thin object
    // like the garrison rifle is illegal for being thin.
    if (ink > 0.45) problems.push(`gear_${b.id}: ${(ink * 100) | 0}% ink — outlined lace, use fewer and bigger shapes`);

    // The layout contract, in three bands:
    //   0..ART_BOTTOM   art and its keyline
    //   ART_BOTTOM+1    keyline only, so the pips have a clear row above them
    //   PIP_Y..         the pip strip, and only as far right as the strip goes
    const isInk = (c) => c[0] === INK[0] && c[1] === INK[1] && c[2] === INK[2];
    for (let x = 0; x < GEAR_SIZE; x++) {
      const c = readPixel(sheet.px, sheet.size, b.at, x, ART_BOTTOM + 1);
      if (c[3] > 0 && !isInk(c)) {
        problems.push(`gear_${b.id}: body colour at ${x},${ART_BOTTOM + 1} — row ${ART_BOTTOM + 1} is the keyline's, art stops at ${ART_BOTTOM}`);
        break;
      }
    }
    const stripRight = PIP_X + PIP_SLOTS * PIP_PITCH;   // last column the strip owns
    for (let y = PIP_Y; y < GEAR_SIZE; y++) {
      for (let x = 0; x < GEAR_SIZE; x++) {
        if (x <= stripRight) continue;
        if (readPixel(sheet.px, sheet.size, b.at, x, y)[3] > 0) {
          problems.push(`gear_${b.id}: something painted at ${x},${y} — right of the pip strip, which owns rows ${PIP_Y}..${GEAR_SIZE - 1}`);
          y = GEAR_SIZE; break;
        }
      }
    }
    // Body colour must not touch the frame border on any of the four sides:
    // that ring is the keyline's, and a body pixel there means the outline ran
    // off the edge and the icon will read as cut off against the row.
    let leaked = null;
    for (let i = 0; i < GEAR_SIZE && !leaked; i++) {
      for (const [x, y] of [[i, 0], [i, GEAR_SIZE - 1], [0, i], [GEAR_SIZE - 1, i]]) {
        const c = readPixel(sheet.px, sheet.size, b.at, x, y);
        if (c[3] > 0 && !isInk(c)) { leaked = `${x},${y}`; break; }
      }
    }
    if (leaked) problems.push(`gear_${b.id}: body colour on the border at ${leaked} — the keyline ran off the edge`);

    const pip = readPips(sheet.px, sheet.size, b.at);
    if (pip.filled !== b.spec.tier) {
      problems.push(`gear_${b.id}: ${pip.filled} pips lit for a T${b.spec.tier} item`);
    }
    const want = (PIP_INK[b.spec.origin] || PIP_INK.silo)[0].join(',');
    for (let i = 0; i < b.spec.tier; i++) {
      if (pip.slotColour[i] !== want) {
        problems.push(`gear_${b.id}: pip ${i + 1} is rgb(${pip.slotColour[i]}), not the ${b.spec.origin} colour rgb(${want})`);
        break;
      }
    }

    rows.push({ id: b.id, ...b.spec, cover, ink, runs, sig: silhouette(sheet.px, sheet.size, b.at), tones: st.tones.size });
  }

  // --- the tier ladder ------------------------------------------------------
  // The header claims tier reads from the shape. That is two claims, and both
  // are checked here on the crafted line T1..T4 of each class:
  //
  //   MASS CLIMBS. Better kit is bigger and denser, every step, without
  //   exception. This is the thing a player perceives before they perceive
  //   anything else, and it is the one that silently rots when an icon is
  //   redrawn — so it is a gate, not a printed number.
  //   NEIGHBOURS DIFFER. Adjacent tiers must clear the same silhouette bar as
  //   any other pair, because adjacent tiers are the pair a player is actually
  //   choosing between.
  //
  // The loot items are deliberately NOT on this ladder: the garrison rifle is
  // meant to be plainer than the silo's tier 4 and the Scar kit is meant to be
  // emptier than everything. They are held to the separation tests instead.
  //
  // `runs` is reported but not gated. It counts silhouette run-starts down
  // both axes, which is a fair description of busyness and a bad gate: it
  // rewards holes and speckle as much as features, and a test that can be
  // satisfied by adding noise is a test that will be.
  const SIL_MIN = 12;
  const ladder = [];
  for (const kind of ['weapon', 'armor', 'suit']) {
    const line = rows.filter((r) => r.kind === kind && r.origin === 'silo').sort((a, b) => a.tier - b.tier);
    ladder.push({ kind, line });
    for (let i = 1; i < line.length; i++) {
      const lo = line[i - 1], hi = line[i];
      if (hi.cover <= lo.cover) {
        problems.push(`${kind} ladder: ${hi.id} (T${hi.tier}, ${Math.round(hi.cover * 100)}%) is not bigger ` +
          `than ${lo.id} (T${lo.tier}, ${Math.round(lo.cover * 100)}%) — tier does not read as mass`);
      }
      const d = hamming(lo.sig, hi.sig);
      if (d < SIL_MIN) {
        problems.push(`${kind} ladder: T${lo.tier} and T${hi.tier} differ by only ${d}/144 cells — ` +
          `adjacent tiers are the pair the player is choosing between`);
      }
    }
  }

  // --- silhouette separation ------------------------------------------------
  // Within a class, because a rifle is never in the same list position as a
  // cuirass. 144 cells; the props are held to 12 bits at 16x16 on a 12x12
  // grid, so the same bar applies here.
  //
  // EVERY ICON gets its nearest neighbour recorded, not just the one closest
  // pair per class. Reporting only the class minimum hides the second-closest
  // pair completely: redraw the icon that was in the tightest pair, the
  // headline number improves, and a different pair that quietly got worse
  // never appears in the output at all. The per-icon column is what makes a
  // regression somewhere else in the class visible in the same glance.
  const closest = {};
  for (const kind of ['weapon', 'armor', 'suit']) {
    const group = built.filter((b) => b.spec.kind === kind);
    const sigs = group.map((b) => ({ id: b.id, sig: silhouette(sheet.px, sheet.size, b.at) }));
    let worst = { d: 999, a: '', b: '' };
    for (let i = 0; i < sigs.length; i++) {
      const row = rows.find((r) => r.id === sigs[i].id);
      row.near = { d: 999, id: '' };
      for (let j = 0; j < sigs.length; j++) {
        if (i === j) continue;
        const d = hamming(sigs[i].sig, sigs[j].sig);
        if (d < row.near.d) row.near = { d, id: sigs[j].id };
        if (j > i && d < worst.d) worst = { d, a: sigs[i].id, b: sigs[j].id };
      }
    }
    closest[kind] = worst;
    if (worst.d < SIL_MIN) {
      problems.push(`${kind}s: ${worst.a} and ${worst.b} share a silhouette (${worst.d}/144 cells differ, need ${SIL_MIN})`);
    }
  }

  // --- the three T4s must not read alike ------------------------------------
  // The whole point of the loot items is that the player picks between them,
  // so the crafted / garrison / slag trio at tier 4 is held to a HIGHER bar
  // than two arbitrary weapons: they sit next to each other in the list.
  const T4_MIN = 18;
  {
    const t4 = built.filter((b) => b.spec.kind === 'weapon' && b.spec.tier === 4);
    const sigs = t4.map((b) => ({ id: b.id, sig: silhouette(sheet.px, sheet.size, b.at) }));
    for (let i = 0; i < sigs.length; i++) {
      for (let j = i + 1; j < sigs.length; j++) {
        const d = hamming(sigs[i].sig, sigs[j].sig);
        if (d < T4_MIN) {
          problems.push(`tier 4 weapons: ${sigs[i].id} and ${sigs[j].id} differ by only ${d}/144 cells (need ${T4_MIN}) ` +
            `— the player chooses between these`);
        }
      }
    }
  }

  // --- report ---------------------------------------------------------------
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\ngear.mjs — ${built.length} frames at ${GEAR_SIZE}x${GEAR_SIZE}\n`);
  let kind = null;
  for (const r of rows.slice().sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.tier - b.tier))) {
    if (r.kind !== kind) { kind = r.kind; console.log(`  [${kind}]`); }
    console.log(`    ${pad(r.id, 20)} T${r.tier} ${pad(r.origin, 9)} cover ${pad(`${Math.round(r.cover * 100)}%`, 5)}` +
      ` ink ${pad(`${Math.round(r.ink * 100)}%`, 5)} runs ${pad(r.runs, 4)} tones ${pad(r.tones, 4)}` +
      ` nearest ${pad(r.near.id, 20)} ${r.near.d}`);
  }
  console.log('\n  [ladder]  crafted T1->T4: mass (gated) and outline runs (reported)');
  for (const { kind: k, line } of ladder) {
    console.log(`    ${pad(k, 8)} ${line.map((r) => `T${r.tier} ${Math.round(r.cover * 100)}%/${r.runs}r`).join('  ->  ')}` +
      `   neighbours differ by ${line.slice(1).map((r, i) => hamming(line[i].sig, r.sig)).join(', ')} cells`);
  }
  console.log('\n  [silhouettes]  closest pair within each class (of 144 cells)');
  for (const k of Object.keys(closest)) {
    console.log(`    ${pad(k, 8)} ${closest[k].a} / ${closest[k].b} at ${closest[k].d}`);
  }

  if (args.out) await contactSheet(sheet, built, String(args.out), Number(args.zoom ?? 8));

  if (problems.length) {
    console.log(`\n  ${problems.length} PROBLEM(S):`);
    for (const m of problems) console.log(`    - ${m}`);
    process.exitCode = 1;
  } else {
    console.log(`\n  ok — ${built.length} icons, palette law upheld, tier reads three ways, every class separated`);
  }
}

/* ---------------------------------------------------- contact sheet PNG -- */

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

/** One row per class, tier ascending, on the panel's own background colour. */
async function contactSheet(sheet, built, out, zoom) {
  const PAD = 6;
  const order = ['weapon', 'armor', 'suit'];
  const bands = order.map((k) => built.filter((b) => b.spec.kind === k)
    .sort((a, b) => a.spec.tier - b.spec.tier || a.id.localeCompare(b.id)));
  const cols = Math.max(...bands.map((b) => b.length));
  const cell = GEAR_SIZE * zoom + PAD;
  const W = cols * cell + PAD, H = bands.length * cell + PAD;
  const buf = new Uint8Array(W * H * 4);
  const bg = [0x23, 0x27, 0x29];
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = bg[0]; buf[i * 4 + 1] = bg[1]; buf[i * 4 + 2] = bg[2]; buf[i * 4 + 3] = 255;
  }
  bands.forEach((band, row) => {
    band.forEach((b, col) => {
      const ox = PAD + col * cell, oy = PAD + row * cell;
      for (let y = 0; y < GEAR_SIZE; y++) {
        for (let x = 0; x < GEAR_SIZE; x++) {
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
  await writePng(out, W, H, buf);
  console.log(`\n  contact sheet -> ${out} (${W}x${H}) at ${zoom}x`);
  bands.forEach((band, i) => console.log(`    row ${i + 1}: ${band.map((b) => b.id).join('  ')}`));
}

if (import.meta.url === `file://${process.argv[1]}`) await runSelfTest();
