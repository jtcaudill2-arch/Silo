/**
 * artwork.js — load imported art, and cope when it isn't there.
 *
 * Every call site here has a working procedural fallback behind it, which is
 * the whole design: the art is an enhancement layered onto a game that already
 * draws itself, not a dependency it acquires. A missing file costs a 404 and
 * nothing else, so this module can ship before the images do and the game
 * survives someone deleting assets/art/ entirely.
 *
 * The index is fetched once. If it 404s, `have()` answers false forever and
 * every consumer quietly keeps its old rendering.
 */

import { ART_BASE, ROOM_ART, CITIZEN_ART, CITIZEN_ART_BY_STATE } from '../data/artwork.js';
import { BAL } from '../config/balance.js';

let index = null;
let loaded = false;

/**
 * Read assets/art/index.json if it exists. Safe to call more than once and
 * safe to never call at all — `have()` simply returns false until it lands.
 */
export async function loadArtwork(base = ART_BASE) {
  if (loaded) return index;
  loaded = true;
  try {
    // An empty index.json ships with the repo so this probe always resolves.
    // Letting it 404 works — the catch below handles it — but the browser
    // logs the failed request regardless, and a console error on every boot
    // of a game that is behaving perfectly is a lie told to whoever opens
    // devtools next.
    const res = await fetch(base + 'index.json', { cache: 'force-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const parsed = await res.json();
    index = parsed && Object.keys(parsed).length ? parsed : null;
  } catch {
    // No art imported. Not an error — the game drew itself before this
    // existed and still does.
    index = null;
  }
  return index;
}

/** Is there an imported image under this id? */
export function have(id) {
  return !!(index && id && index[id]);
}

/** URL for an asset, or null. `frame` picks a frame from a sliced strip. */
export function url(id, frame = 0) {
  if (!have(id)) return null;
  const entry = index[id];
  const name = entry.frames[Math.min(frame, entry.frames.length - 1)];
  return ART_BASE + name;
}

/** The cutaway for a room type, or null if this batch had none for it. */
export function roomArt(roomType) {
  const key = ROOM_ART[roomType];
  return key ? url('room_' + key) : null;
}

/**
 * The figure for a citizen: who they are first, then what they do.
 *
 * A child in a jumpsuit reads as a child before it reads as a farmer, and
 * somebody currently outside reads as a hazmat suit regardless of their day
 * job — that is the fact about them that matters while they are out there.
 */
export function citizenArt(citizen, state) {
  if (!citizen) return null;
  if (citizen.status === 'expedition') return url(CITIZEN_ART_BY_STATE.expedition);
  if (citizen.age < BAL.citizens.workingAgeMin) return url(CITIZEN_ART_BY_STATE.child);
  if (citizen.age >= BAL.citizens.vitality.declineSteepAge) return url(CITIZEN_ART_BY_STATE.elder);

  const skill = state && citizen.job ? jobSkill(state, citizen) : null;
  return url(CITIZEN_ART[skill] || CITIZEN_ART.base);
}

function jobSkill(state, citizen) {
  const room = state.silo.rooms[citizen.job?.roomId];
  if (!room) return null;
  // Imported lazily: this module is UI-side and must not pull the room table
  // into the boot path for a lookup most players never trigger.
  return roomSkillCache[room.type] ?? null;
}

/**
 * roomType -> staff skill, filled in by the UI on first use. Kept here rather
 * than importing data/rooms.js so this file stays cheap.
 */
const roomSkillCache = {};
export function primeRoomSkills(rooms) {
  for (const [id, def] of Object.entries(rooms)) {
    if (def.staff?.skill) roomSkillCache[id] = def.staff.skill;
  }
}

/**
 * An <img> for an asset, or null. Always decoding async and never blocking a
 * panel render — a panel that waits on an image is a panel that flickers.
 */
export function artImage(src, alt = '') {
  if (!src) return null;
  const img = new Image();
  img.src = src;
  img.alt = alt;
  img.decoding = 'async';
  img.loading = 'lazy';
  // Pixel art must never be smoothed on the way up or down.
  img.style.imageRendering = 'pixelated';
  return img;
}

export default { loadArtwork, have, url, roomArt, citizenArt, artImage };
