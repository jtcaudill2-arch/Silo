/**
 * names.js — the name pool for Silo 12.
 *
 * Original names only. The register is deliberately narrow: three generations
 * sealed in one building would drift toward a small, shared set of surnames
 * and slightly archaic given names. Repeats across the population are a
 * feature — cousins, not a bug.
 */

export const FIRST_NAMES_F = [
  'Marra', 'Ilse', 'Yeva', 'Adaeze', 'Cass', 'Wren', 'Solveig', 'Nim', 'Orla',
  'Petra', 'Halla', 'Juno', 'Rive', 'Sable', 'Teppa', 'Enid', 'Maud', 'Ceres',
  'Bex', 'Loel', 'Anneke', 'Dell', 'Fenna', 'Greta', 'Hessa', 'Isa', 'Kira',
  'Lune', 'Mirren', 'Nessa', 'Ottilie', 'Perrin', 'Quen', 'Rosalind', 'Sten',
  'Thess', 'Ulla', 'Vika', 'Wyn', 'Yara', 'Zell', 'Aud', 'Brine', 'Corrin',
  'Delve', 'Esker', 'Fane', 'Girt', 'Hallow', 'Ines', 'Jessamyn', 'Kest',
  'Liv', 'Mora', 'Nell', 'Odile', 'Prue', 'Rilla', 'Senna', 'Tam', 'Ursel',
  'Vesper', 'Wilda', 'Yalta', 'Zosia', 'Ardith', 'Bellamy', 'Cordelia',
];

export const FIRST_NAMES_M = [
  'Osric', 'Tomas', 'Guro', 'Bram', 'Idris', 'Karst', 'Sile', 'Vane', 'Holt',
  'Emeric', 'Faro', 'Gideon', 'Hark', 'Ivor', 'Joss', 'Kelder', 'Lonn',
  'Mattias', 'Ness', 'Oren', 'Piet', 'Quill', 'Roald', 'Stellan', 'Torvald',
  'Ulric', 'Verne', 'Wendel', 'Yorick', 'Zev', 'Ansel', 'Barrow', 'Cull',
  'Dorn', 'Efrem', 'Fitch', 'Garrick', 'Hollis', 'Isak', 'Jarl', 'Kip',
  'Lucan', 'Marek', 'Nolan', 'Orrin', 'Pell', 'Ruben', 'Sorren', 'Teodor',
  'Ulf', 'Vidar', 'Wend', 'Yohan', 'Zeb', 'Alder', 'Brant', 'Corvin', 'Dain',
  'Ewan', 'Ferro', 'Gorm', 'Hale', 'Ingo', 'Joren',
];

export const FIRST_NAMES_N = [
  'Ash', 'Bly', 'Cedar', 'Dane', 'Ember', 'Fen', 'Grey', 'Haven', 'Ivy',
  'Jules', 'Kesh', 'Lark', 'Merle', 'Noor', 'Onyx', 'Pax', 'Quarry', 'Reed',
  'Sage', 'Tal', 'Vale', 'Winter', 'Yarrow', 'Zenith', 'Rell', 'Kade',
];

/**
 * Surnames. Heavy on occupational and structural words — a sealed population
 * naming itself after the machinery it maintains.
 */
export const SURNAMES = [
  'Voss', 'Corran', 'Rhee', 'Sayen', 'Fole', 'Verrick', 'Oss', 'Sant', 'Han',
  'Mott', 'Ruun', 'Karst', 'Vane', 'Ashgrove', 'Beckwith', 'Calder',
  'Dunmore', 'Eastley', 'Farrow', 'Gault', 'Halloway', 'Ingram', 'Joss',
  'Kessler', 'Lindqvist', 'Marlowe', 'Nyholm', 'Ormond', 'Prewitt', 'Quist',
  'Rennick', 'Stavros', 'Thorne', 'Ulvaeus', 'Vantry', 'Wexler', 'Ystad',
  'Zaleski', 'Ardmore', 'Blackwood', 'Cordry', 'Delacroix', 'Ellender',
  'Foxwell', 'Grimsby', 'Havelock', 'Ivers', 'Jarrow', 'Keening', 'Lowe',
  'Mercer', 'Nadeau', 'Oakhurst', 'Pyle', 'Quarrier', 'Roswell', 'Sedgwick',
  'Tallow', 'Underhill', 'Vickers', 'Whitlock', 'Yarrow', 'Zorn',
  'Ironside', 'Ladder', 'Bellows', 'Cinder', 'Draper', 'Ferrier', 'Girder',
  'Hobb', 'Keel', 'Lathe', 'Millwright', 'Nail', 'Pitch', 'Rivet', 'Solder',
  'Tinker', 'Vent', 'Wick', 'Anneal', 'Brine', 'Coil', 'Dross',
];

/** The founding surnames — over-represented, because they got here first. */
export const FOUNDER_SURNAMES = ['Voss', 'Halloway', 'Mercer', 'Thorne', 'Rennick', 'Keel', 'Wick'];

/** Squad names the player can pick from. */
export const SQUAD_NAMES = [
  'Bell', 'Ladder', 'Sounding', 'Deadlight', 'Undertow', 'Ninth Hour',
  'Long Shift', 'Cold Iron', 'Ash Detail', 'Hollow Point', 'Sump', 'Reach',
];

/** Deterministic-name helper. Callers pass an Rng so results replay. */
export function makeName(rng, gender) {
  const pool =
    gender === 'f' ? FIRST_NAMES_F : gender === 'm' ? FIRST_NAMES_M : FIRST_NAMES_N;
  const first = rng.pick(pool);
  // Founding families keep showing up. 1-in-4 of the population carries one.
  const last = rng.chance(0.26) ? rng.pick(FOUNDER_SURNAMES) : rng.pick(SURNAMES);
  return { firstName: first, lastName: last };
}

export function pickGender(rng) {
  const r = rng.next();
  if (r < 0.485) return 'f';
  if (r < 0.97) return 'm';
  return 'n';
}

export default { makeName, pickGender, SURNAMES, SQUAD_NAMES };
