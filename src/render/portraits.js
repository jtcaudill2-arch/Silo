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
import { mix, withAlpha } from './floors.js';

const SIZE = 16;
const cache = new Map();
const MAX_CACHE = 600;

/** Skin ramp, mixed from the palette. Index 0 is lightest. */
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

function hairRamp() {
  return [
    mix(PALETTE.concreteDeeper, PALETTE.concrete, 0.25), // near-black
    mix(PALETTE.rust, PALETTE.concreteDeeper, 0.45), // dark auburn
    mix(PALETTE.rust, PALETTE.sodium, 0.35), // ginger
    mix(PALETTE.bone, PALETTE.sodium, 0.45), // fair
    mix(PALETTE.concrete, PALETTE.concreteDeeper, 0.4), // dark brown
  ];
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
}

export function drawPortrait(ctx, citizen, scale = 3) {
  const rnd = mulberry32(mixSeed(citizen.portraitSeed, 'portrait'));
  const skins = skinRamp();
  const hairs = hairRamp();

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

  const skin = skins[Math.floor(rnd() * skins.length)];
  const skinShade = mix(skin, PALETTE.concreteDeeper, 0.3);
  let hair = hairs[Math.floor(rnd() * hairs.length)];
  if (old) hair = mix(hair, PALETTE.bone, rnd() * 0.55 + 0.25); // grey with age

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
