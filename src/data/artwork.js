/**
 * artwork.js — the map from commissioned art to things in the game.
 *
 * The art was generated against a brief using a different working title
 * ("Deep Hold") and its own room vocabulary, so the names do not line up with
 * `data/rooms.js` on their own: living quarters are Residences, the mess hall
 * is the Cafeteria, water reclamation is the Water Reclaimer. That
 * reconciliation lives here rather than in a filename convention, because a
 * filename convention would have to be re-derived by whoever imports the next
 * batch.
 *
 * WHERE THE ART GOES, AND WHERE IT DOESN'T
 *
 * The silo cross-section draws a room into a 64×40 slot and a citizen into
 * about six pixels by nine. A 2K cutaway downscaled to 128×40 is a smudge,
 * and a 2K citizen at 6×9 is three pixels of hair. The procedural atlas
 * exists precisely because it was authored for that size, and it stays.
 *
 * These assets go where there is room to look at them:
 *   - the room detail panel, at roughly 380×260
 *   - the citizen card, at 96 square
 *   - the airlock and expedition screens, which have a full-width backdrop
 *   - encounter reports, which currently describe a Ravager in prose alone
 *
 * Every entry is optional at runtime. If the file is absent the game falls
 * back to what it drew before, which is why this can be committed before the
 * images are.
 */

/** Where imported art is written, relative to the site root. */
export const ART_BASE = './assets/art/';

/**
 * Room cutaways → room type ids.
 *
 * `null` means the batch has no art for that room and the procedural tile
 * stands. Recorded explicitly rather than omitted, so the gaps are countable.
 */
export const ROOM_ART = {
  reactor: 'reactor',
  hydroponics: 'hydroponics',
  water_reclaimer: 'water_reclamation',
  air_filtration: 'air_scrubbers',
  residences: 'living_quarters',
  cafeteria: 'mess_hall',
  clinic: 'medical_bay',
  workshop: 'workshop',
  foundry: 'fabrication',
  laboratory: 'research_lab',
  sheriffs_office: 'sheriff_office',
  holding_cells: 'holding_cells',
  armory: 'armory',
  barracks: 'barracks',
  training_yard: 'barracks', // same room in the brief; shared until it isn't
  radio_room: 'radio_room',
  deep_mine: 'excavation',
  storage_depot: 'storage',
  airlock: 'airlock',

  // No art in this batch. The procedural tile is used.
  generator_hall: null,
  protein_vats: null,
  chem_lab: null,
  recycling: null,
  munitions: null,
  archive: null,
  schoolhouse: null,
  suit_bay: null,
  maintenance_bay: null,
  // Explicitly null rather than absent. `roomArt` treats both the same, but
  // `missingRoomArt()` reports the nulls — so a room type that is simply not
  // in this table drops off the list of art still to draw, which is how this
  // one went unnoticed after it was added.
  heat_exchange: null,
};

/**
 * Citizen figures → the job skill they read as.
 *
 * Chosen by the room a citizen is posted to, so the card shows somebody
 * dressed for the work they actually do. `base` covers the unemployed and
 * anything unmapped.
 */
export const CITIZEN_ART = {
  base: 'citizen_worker_base',
  farming: 'citizen_hydroponics_worker',
  mechanics: 'citizen_mechanic',
  engineering: 'citizen_mechanic',
  medicine: 'citizen_medic',
  admin: 'citizen_deputy',
  combat: 'citizen_militia_soldier',
  science: 'citizen_worker_base',
};

/** Figures chosen by who somebody is rather than what they do. Checked first. */
export const CITIZEN_ART_BY_STATE = {
  child: 'citizen_teenager',
  elder: 'citizen_older_citizen',
  expedition: 'citizen_hazmat',
};

/**
 * Hostiles → the encounter ids that name them, so a combat report can show
 * what came out of the dust instead of only describing it.
 */
export const THREAT_ART = {
  husk: 'threat_husk',
  shambler: 'threat_shambler',
  bloater: 'threat_bloater',
  ravager: 'threat_ravager',
  alpha: 'threat_alpha',
  raider: 'threat_wasteland_raider',
  ash_company: 'threat_ash_company_soldier',
  scrapjaw: 'threat_scrapjaw',
  cultist: 'threat_choir_cultist',
  trader: 'threat_freerider_trader',
};

/** Backdrops and textures. */
export const SCENERY = {
  skyline: 'env_wasteland_skyline',
  ground: 'env_wasteland_ground',
  wall: 'env_concrete_wall',
};

/**
 * Animation strips. Frame counts come from the delivery manifest; the
 * importer slices on those counts rather than guessing from image width.
 *
 * These are the lowest-value part of the batch for this game and the note is
 * worth keeping: the cross-section animates citizens at six pixels wide, so
 * these frames have nowhere to play at full fidelity. They are imported for
 * the citizen card, which can afford one.
 */
export const CITIZEN_STRIPS = {
  walk: { id: 'citizen_walk', frames: 6 },
  idle: { id: 'citizen_idle', frames: 4 },
  working: { id: 'citizen_working', frames: 4 },
  sleeping: { id: 'citizen_sleeping', frames: 2 },
  injured: { id: 'citizen_injured', frames: 4 },
};

/** Rooms with no art in this batch, for the importer's coverage report. */
export function missingRoomArt() {
  return Object.entries(ROOM_ART)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
}

export default { ART_BASE, ROOM_ART, CITIZEN_ART, THREAT_ART, SCENERY, CITIZEN_STRIPS };
