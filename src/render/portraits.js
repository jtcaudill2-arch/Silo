/**
 * portraits.js — procedural citizen portraits from a seed.
 *
 * 16×16 logical pixels, integer-scaled, drawn entirely from the game palette.
 * Keeping them on-palette isn't a purity exercise: skin tones mixed out of
 * bone, rust and concrete make the whole roster read as ID photographs on
 * cheap paper, which is exactly what a silo personnel file would look like.
 *
 * Deterministic from (portraitSeed, age, traits) — the same person always has
 * the same face, and they grey as they age. Results are cached; a population
 * panel scrolling 400 people must not regenerate anything.
 */

import { PALETTE } from './canvas.js';
import { mulberry32, mixSeed } from '../core/rng.js';
import { mix, withAlpha, channels } from './floors.js';
import { getRoom } from '../data/rooms.js';
import * as sprites from './sprites.js';

const SIZE = 16;
const cache = new Map();
const MAX_CACHE = 600;

/**
 * Skin, lightest to darkest. Ordered by luminance and interpolated between
 * neighbours — see `alongRamp` — so the stops are landmarks rather than the
 * whole set. The one neutral tone sits fourth, where its luminance puts it,
 * and blends warm on both sides.
 */
function skinRamp() {
  return [
    mix(PALETTE.bone, PALETTE.rust, 0.18),
    mix(PALETTE.bone, PALETTE.rust, 0.34),
    mix(PALETTE.bone, PALETTE.rust, 0.5),
    mix(PALETTE.bone, PALETTE.concrete, 0.42),
    mix(PALETTE.rust, PALETTE.concrete, 0.42),
    mix(PALETTE.rust, PALETTE.concrete, 0.62),
  ];
}

/**
 * Hair, dark to light. The order is load-bearing, not cosmetic: `alongRamp`
 * interpolates between neighbours, so a stop out of sequence is a person whose
 * hair is the average of blond and black.
 */
function hairRamp() {
  return [
    mix(PALETTE.concreteDeeper, PALETTE.concrete, 0.25), // near-black
    mix(PALETTE.concrete, PALETTE.concreteDeeper, 0.4), // dark brown
    mix(PALETTE.rust, PALETTE.concreteDeeper, 0.45), // dark auburn
    mix(PALETTE.rust, PALETTE.sodium, 0.35), // ginger
    mix(PALETTE.bone, PALETTE.sodium, 0.45), // fair
  ];
}

/**
 * A colour anywhere along a ramp, not only at one of its stops.
 *
 * Six skin tones and five hair colours are thirty people, and the silo holds
 * six hundred: at the stops alone, twenty citizens share every face. Between
 * them there is no such ceiling, and nothing leaves the palette — every point
 * on the line between two palette-derived colours is one too.
 *
 * This only became possible when `mix` learned to read its own output; before
 * that, a ramp stop fed back into a mix came out as noise.
 */
function alongRamp(ramp, rnd) {
  const t = rnd() * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(t));
  return mix(ramp[i], ramp[i + 1], t - i);
}

/**
 * Returns a canvas (not an <img>) so callers can size it however they like.
 * @param {object} citizen
 * @param {number} scale integer pixel scale
 */
export function portraitCanvas(citizen, scale = 3) {
  const key = `${citizen.portraitSeed}:${Math.floor(citizen.age / 8)}:${citizen.traits.join(',')}:${scale}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const c = document.createElement('canvas');
  c.width = SIZE * scale;
  c.height = SIZE * scale;
  // Decorative. The name is always adjacent, so a screen reader announcing
  // "canvas" — or worse, "portrait of Alder Cordry, Alder Cordry" — is noise.
  c.setAttribute('aria-hidden', 'true');
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  drawPortrait(ctx, citizen, scale);

  if (cache.size > MAX_CACHE) {
    // Cheapest possible eviction; portraits are trivial to regenerate.
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, c);
  return c;
}

export function clearPortraitCache() {
  cache.clear();
  faceCache.clear();
}

// --------------------------------------------------- the face on the sheet ---

const faceCache = new Map();

/**
 * The face to show a player: the role's drawn portrait, in this person's own
 * skin and hair.
 *
 * Two things were wrong, and they were the same thing. The sheet carries
 * eleven portraits — one per role, 32×32, properly drawn, with real eyes and
 * the role's gear — and the citizen card showed whichever one matched your
 * job. Six hundred and forty-seven people, eleven faces. Meanwhile the People,
 * squad and election lists drew the 16×16 procedural portrait, which IS per
 * citizen. So a name in the roster and the same name on their own card were
 * two different people, and the screen dedicated to an individual was the one
 * showing the stereotype.
 *
 * Baking a face per citizen is not available: the population passes a hundred
 * before day 90 and keeps going. Repainting one is. The baked portrait's skin
 * and hair tones are published by the atlas (see `faceTones` in gen-atlas.mjs)
 * along with the shade() step that separates each from its family's base, so
 * this swaps the colouring and leaves the drawing — the linework, the eyes,
 * the deputy's badge, the mechanic's goggles — exactly where the baker put it.
 *
 * The colouring comes from `colouring()`, which is also what the procedural
 * portrait uses, so the two answers agree about a given person and the fallback
 * is a change of resolution rather than a change of face.
 *
 * @param {object} citizen
 * @param {number} px on-screen size; 32 for a list row, 64 for a card
 * @param {object} [state] lets the job resolve to a role. Without it everybody
 *   on shift is drawn in plain coveralls, which is what the card did before.
 */
export function facePortrait(citizen, px = 32, state = null) {
  const role = roleFor(citizen, state);
  const key = `${citizen.portraitSeed}:${Math.floor(citizen.age / 8)}:${role}:${citizen.status}:` +
    `${citizen.health < 40}:${citizen.traits.join(',')}:${px}`;
  const hit = faceCache.get(key);
  if (hit) return hit;

  const drawn = repaintRolePortrait(citizen, role, px);
  if (!drawn) return portraitCanvas(citizen, Math.max(1, Math.round(px / SIZE)));

  if (faceCache.size > MAX_CACHE) faceCache.delete(faceCache.keys().next().value);
  faceCache.set(key, drawn);
  return drawn;
}

/**
 * Which role's portrait to draw them in.
 *
 * `citizenRole` reads the job's skill off the citizen, and only the floor
 * renderer stamps it — it is walking the rooms anyway. A panel is not, so the
 * card drew every farmer, mechanic and medic in the silo as plain `base`: the
 * eight role portraits with gear on them were reachable from the cross-section
 * and from nowhere a player could look at a person. The property is defined
 * non-enumerable for the same reason citizens.js defines it that way — a
 * citizen record is serialised straight into the save.
 */
function roleFor(citizen, state) {
  const room = state && citizen.job ? state.silo.rooms[citizen.job.roomId] : null;
  const skill = room ? getRoom(room.type)?.staff?.skill || null : null;
  if (skill && citizen._jobSkill !== skill) {
    if (!Object.getOwnPropertyDescriptor(citizen, '_jobSkill')) {
      Object.defineProperty(citizen, '_jobSkill', { value: null, writable: true, enumerable: false });
    }
    citizen._jobSkill = skill;
  }
  return sprites.citizenRole(citizen);
}

/**
 * Swap the skin and hair of a baked portrait for one citizen's.
 *
 * Returns null whenever anything is missing — no atlas, an atlas from before
 * the tone key existed, a frame that is not there, or a canvas the browser
 * will not let us read back — so the caller keeps the procedural portrait it
 * had. This is a preference between two real answers, never a repair.
 */
function repaintRolePortrait(citizen, role, px) {
  const tones = sprites.faceTones(role);
  const src = sprites.frameCanvas(`portrait_${role}`, 1);
  if (!tones || !src) return null;

  const { skin, hair } = colouring(citizen);
  const lut = new Map();
  const load = (spec, target) => {
    if (!spec) return;
    for (const [rgb, k] of Object.entries(spec.tones)) lut.set(rgb, channels(shadeBy(target, k)));
  };
  load(tones.skin, skin);
  load(tones.hair, hair);

  const ctx = src.getContext('2d');
  let img;
  try {
    img = ctx.getImageData(0, 0, src.width, src.height);
  } catch {
    return null; // a tainted canvas; the procedural portrait is right here
  }
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const to = lut.get(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    if (to) { d[i] = to[0]; d[i + 1] = to[1]; d[i + 2] = to[2]; }
  }
  ctx.putImageData(img, 0, 0);

  const scale = Math.max(1, Math.round(px / src.width));
  const out = document.createElement('canvas');
  out.width = src.width * scale;
  out.height = src.height * scale;
  out.setAttribute('aria-hidden', 'true');
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = false;
  octx.drawImage(src, 0, 0, out.width, out.height);
  conditionMarks(octx, citizen, scale);
  return out;
}

/**
 * shade(), the art library's, in the renderer's colour space: negative mixes
 * toward black, positive toward bone. The atlas publishes each portrait tone
 * as its distance from its family's base in exactly these terms, so a jaw
 * shadow lands the same distance under a dark skin as under a fair one.
 */
function shadeBy(colour, k) {
  if (!k) return colour;
  return k < 0 ? mix(colour, '#000', -k) : mix(colour, PALETTE.bone, k);
}

/**
 * What a condition does to a drawn face.
 *
 * The same set the 16×16 portrait carries, at the 32×32 head's coordinates —
 * scarred and crippled are read off the roster rather than decorative, and
 * losing them would be a step backwards from the portrait this replaces.
 * Radiation is not here: it is a role, so an irradiated citizen is already
 * drawn in the irradiated portrait, green pallor and all.
 */
function conditionMarks(ctx, citizen, s) {
  const box = (x, y, w, h, colour) => {
    ctx.fillStyle = colour;
    ctx.fillRect(x * s, y * s, w * s, h * s);
  };
  const t = citizen.traits;
  // Right cheek, below the eye, clear of the ear at x=23.
  if (t.includes('scarred')) box(21, 15, 1, 4, PALETTE.rust);
  // Left shoulder, on the collar the SHOULDER_SPANS lay down from row 23.
  if (t.includes('crippled')) box(5, 27, 3, 3, mix(PALETTE.rust, PALETTE.concreteDeeper, 0.35));
  if (citizen.status === 'dead') {
    box(0, 0, 32, 32, withAlpha(PALETTE.concreteDeeper, 0.55));
    box(9, 13, 14, 1, PALETTE.rust);
  } else if (citizen.health < 40) {
    box(0, 0, 32, 32, withAlpha(PALETTE.rust, 0.12));
  }
}

/**
 * This person's skin and hair.
 *
 * Split out of drawPortrait so the drawn portrait and the procedural one pick
 * the same two colours for the same citizen — otherwise swapping between them
 * changes somebody's hair, which is the bug this whole path exists to fix. The
 * caller may pass its own stream: drawPortrait does, because the picks after
 * these two depend on the stream being exactly where they left it.
 */
function colouring(citizen, rnd = mulberry32(mixSeed(citizen.portraitSeed, 'portrait'))) {
  const skin = alongRamp(skinRamp(), rnd);
  let hair = alongRamp(hairRamp(), rnd);
  if (citizen.age > 58) hair = mix(hair, PALETTE.bone, rnd() * 0.55 + 0.25); // grey with age
  return { skin, hair };
}

export function drawPortrait(ctx, citizen, scale = 3) {
  const rnd = mulberry32(mixSeed(citizen.portraitSeed, 'portrait'));

  const px = (x, y, colour, w = 1, h = 1) => {
    ctx.fillStyle = colour;
    ctx.fillRect(x * scale, y * scale, w * scale, h * scale);
  };

  const age = citizen.age;
  const child = age < 14;
  const old = age > 58;

  // ---- background: a flat card, slightly vignetted --------------------
  px(0, 0, PALETTE.concreteDeeper, SIZE, SIZE);
  px(0, 0, mix(PALETTE.concreteDeeper, PALETTE.concrete, 0.35), SIZE, 5);

  // Drawn from this stream, in this order — `colouring` takes it and hands it
  // back where the rest of the face expects to find it.
  const { skin, hair } = colouring(citizen, rnd);
  const skinShade = mix(skin, PALETTE.concreteDeeper, 0.3);

  // ---- shoulders ------------------------------------------------------
  const collar = mix(PALETTE.concrete, PALETTE.concreteDeeper, 0.2);
  px(2, 13, collar, 12, 3);
  px(4, 12, collar, 8, 2);
  // Coverall stripe — sodium for staff, so a portrait carries a little rank.
  px(7, 13, withAlpha(PALETTE.sodium, 0.5), 2, 1);

  // ---- head -----------------------------------------------------------
  const headTop = child ? 4 : 3;
  const headH = child ? 8 : 9;
  const headX = child ? 5 : 4;
  const headW = child ? 6 : 8;
  px(headX, headTop, skin, headW, headH);
  // Rounded corners: knock the four corner pixels out.
  px(headX, headTop, PALETTE.concreteDeeper);
  px(headX + headW - 1, headTop, PALETTE.concreteDeeper);
  px(headX, headTop + headH - 1, PALETTE.concreteDeeper);
  px(headX + headW - 1, headTop + headH - 1, PALETTE.concreteDeeper);
  // Jaw shadow.
  px(headX, headTop + headH - 2, skinShade, headW, 1);
  // Neck.
  px(headX + 2, headTop + headH, skinShade, headW - 4, 1);

  // ---- hair -----------------------------------------------------------
  const style = Math.floor(rnd() * 5);
  const balding = old && rnd() < 0.4;
  if (!balding) {
    px(headX, headTop, hair, headW, 1);
    if (style === 0) {
      px(headX, headTop, hair, headW, 2); // cropped
    } else if (style === 1) {
      px(headX, headTop, hair, headW, 2);
      px(headX, headTop, hair, 1, 5); // side sweep
    } else if (style === 2) {
      px(headX, headTop, hair, headW, 2);
      px(headX, headTop, hair, 1, 6);
      px(headX + headW - 1, headTop, hair, 1, 6); // long
    } else if (style === 3) {
      px(headX + 1, headTop - 1, hair, headW - 2, 1); // tall
      px(headX, headTop, hair, headW, 2);
    }
    // else style 4: shaved, just the one row
  } else {
    px(headX + 1, headTop, mix(skin, hair, 0.25), headW - 2, 1);
  }

  // ---- eyes -----------------------------------------------------------
  const eyeY = headTop + (child ? 4 : 4);
  const eyeColour = mix(PALETTE.concreteDeeper, PALETTE.concrete, 0.15);
  px(headX + 1, eyeY, eyeColour);
  px(headX + headW - 2, eyeY, eyeColour);
  // Brows — heavier brows read as older/harder.
  if (!child && rnd() < 0.7) {
    px(headX + 1, eyeY - 1, mix(hair, PALETTE.concreteDeeper, 0.3));
    px(headX + headW - 2, eyeY - 1, mix(hair, PALETTE.concreteDeeper, 0.3));
  }

  // ---- nose and mouth --------------------------------------------------
  px(headX + Math.floor(headW / 2) - 1, eyeY + 1, skinShade);
  const mouthY = eyeY + 3;
  const mouthW = 2 + Math.floor(rnd() * 2);
  px(headX + Math.floor((headW - mouthW) / 2), mouthY, mix(skinShade, PALETTE.rust, 0.3), mouthW, 1);

  // ---- facial hair -----------------------------------------------------
  if (!child && rnd() < 0.3) {
    px(headX + 1, mouthY, mix(hair, skin, 0.15), headW - 2, 2);
    px(headX + Math.floor((headW - mouthW) / 2), mouthY, mix(skinShade, PALETTE.rust, 0.3), mouthW, 1);
  }

  // ---- age lines -------------------------------------------------------
  if (old) {
    px(headX + 1, eyeY + 1, withAlpha(skinShade, 0.8));
    px(headX + headW - 2, eyeY + 1, withAlpha(skinShade, 0.8));
  }

  // ---- traits that show on the face ------------------------------------
  // These are read, not decoration: the roster should let you spot the
  // irradiated and the scarred without opening a card.
  const t = citizen.traits;
  if (t.includes('scarred')) {
    px(headX + headW - 2, headTop + 2, PALETTE.rust);
    px(headX + headW - 2, headTop + 3, PALETTE.rust);
  }
  if (t.includes('crippled')) {
    px(2, 13, mix(collar, PALETTE.rust, 0.4), 3, 3);
  }
  if (citizen.radiation >= 45 || t.includes('irradiated')) {
    // The one place toxin green is allowed on a face.
    px(headX, headTop + headH - 1, withAlpha(PALETTE.toxin, 0.55), headW, 1);
    px(0, 0, withAlpha(PALETTE.toxin, 0.1), SIZE, SIZE);
  }
  if (citizen.status === 'dead') {
    px(0, 0, withAlpha(PALETTE.concreteDeeper, 0.55), SIZE, SIZE);
    px(headX, headTop + 4, PALETTE.rust, headW, 1);
  }
  if (citizen.health < 40) {
    px(0, 0, withAlpha(PALETTE.rust, 0.12), SIZE, SIZE);
  }

  // ---- frame -----------------------------------------------------------
  ctx.strokeStyle = withAlpha(PALETTE.bone, 0.12);
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, SIZE * scale - 1, SIZE * scale - 1);
}

export default portraitCanvas;
