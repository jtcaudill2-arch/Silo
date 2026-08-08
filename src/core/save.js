/**
 * save.js — IndexedDB persistence, schema migration, autosave.
 *
 * IndexedDB stores structured clones, not JSON, which matters: `Infinity` is
 * a legitimate resource cap (chits are uncapped) and survives a structured
 * clone intact where JSON would silently turn it into null. The export/import
 * path does have to go through JSON, so it encodes those explicitly.
 *
 * Three slots plus one rolling backup per slot (spec §3.1). The backup is
 * written *before* each save overwrites the primary, so a save that corrupts
 * mid-write still leaves the previous state recoverable.
 */

import { BAL } from '../config/balance.js';
import { MIGRATIONS, latestVersion } from './migrations.js';
import { rehydrate } from './newgame.js';

const DB_NAME = 'deepwater';
const DB_VERSION = 1;
const STORE = 'saves';
const META = 'meta';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ------------------------------------------------------------------ keys ---

const primaryKey = (slot) => `slot:${slot}`;
const backupKey = (slot) => `slot:${slot}:backup`;

// ------------------------------------------------------------------ save ---

/**
 * Write a save. Rolls the previous primary into the backup slot first, so a
 * failed or corrupt write never costs the player both copies.
 */
export async function saveGame(state, slot = state.meta.slot ?? 0, opts = {}) {
  const db = await openDB();
  const now = opts.now ?? Date.now();

  state.meta.lastSaveTs = now;
  state.meta.slot = slot;
  state.meta.schemaVersion = latestVersion();

  const record = {
    key: primaryKey(slot),
    slot,
    savedAt: now,
    schemaVersion: state.meta.schemaVersion,
    summary: summarise(state),
    state: strip(state),
  };

  // Roll the previous save into the backup.
  const store = tx(db, STORE, 'readwrite');
  const prev = await wrap(store.get(primaryKey(slot))).catch(() => null);
  if (prev) {
    await wrap(tx(db, STORE, 'readwrite').put({ ...prev, key: backupKey(slot) }));
  }
  await wrap(tx(db, STORE, 'readwrite').put(record));
  return record.summary;
}

/**
 * Load a slot, migrating forward if it was written by an older build. Falls
 * back to the rolling backup if the primary is unreadable.
 */
export async function loadGame(slot = 0) {
  const db = await openDB();
  let record = await wrap(tx(db, STORE, 'readonly').get(primaryKey(slot))).catch(() => null);
  let usedBackup = false;

  if (!record || !record.state) {
    record = await wrap(tx(db, STORE, 'readonly').get(backupKey(slot))).catch(() => null);
    usedBackup = !!record;
  }
  if (!record || !record.state) return null;

  let state;
  try {
    state = migrate(record.state, record.schemaVersion ?? 0);
  } catch (err) {
    console.error('[save] migration failed, trying the backup:', err);
    const backup = await wrap(tx(db, STORE, 'readonly').get(backupKey(slot))).catch(() => null);
    if (!backup?.state) throw err;
    state = migrate(backup.state, backup.schemaVersion ?? 0);
    usedBackup = true;
  }

  return { state: rehydrate(state), savedAt: record.savedAt, usedBackup, summary: record.summary };
}

export async function listSlots() {
  const db = await openDB().catch(() => null);
  if (!db) return [];
  const out = [];
  for (let slot = 0; slot < BAL.meta.saveSlots; slot++) {
    const rec = await wrap(tx(db, STORE, 'readonly').get(primaryKey(slot))).catch(() => null);
    out.push(
      rec
        ? { slot, savedAt: rec.savedAt, schemaVersion: rec.schemaVersion, summary: rec.summary, empty: false }
        : { slot, empty: true }
    );
  }
  return out;
}

export async function deleteSlot(slot) {
  const db = await openDB();
  await wrap(tx(db, STORE, 'readwrite').delete(primaryKey(slot)));
  await wrap(tx(db, STORE, 'readwrite').delete(backupKey(slot)));
}

export async function hasAnySave() {
  const slots = await listSlots();
  return slots.some((s) => !s.empty);
}

// ------------------------------------------------------------- migration ---

/** Apply every migration between `from` and the current schema version. */
export function migrate(state, from) {
  let v = from || 0;
  const target = latestVersion();
  if (v > target) {
    throw new Error(`save is from a newer build (schema ${v} > ${target})`);
  }
  while (v < target) {
    const step = MIGRATIONS[v];
    if (!step) {
      // No explicit step: the shape didn't change, just stamp it forward.
      v++;
      continue;
    }
    state = step(state) || state;
    v++;
  }
  state.meta.schemaVersion = target;
  return state;
}

// ------------------------------------------------------------------ misc ---

/** What the slot list shows without deserialising a whole silo. */
export function summarise(state) {
  return {
    siloName: state.meta.siloName,
    day: state.clock.day,
    year: state.clock.year,
    population: state.citizenIds.length,
    deaths: state.stats.deaths,
    order: Math.round(state.order.value),
    playedMs: state.meta.playedMs,
    gameOver: state.meta.gameOver,
  };
}

/**
 * Drop anything derived or transient before writing. Keeps saves small
 * (spec §3.5 budgets 500 KB at 200 population) and stops render-layer scratch
 * from ever reaching disk.
 */
function strip(state) {
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith('__')) continue;
    out[k] = v;
  }
  // `flows` is recomputed on the first cycle after load.
  out.flows = {};
  return out;
}

// -------------------------------------------------------- export / import --

const INF = '__Infinity__';
const NEG_INF = '__-Infinity__';

/** A save as portable JSON text. Infinity is encoded, not lost. */
export function exportSave(state) {
  const payload = {
    format: 'deepwater-save',
    schemaVersion: latestVersion(),
    exportedAt: Date.now(),
    state: strip(state),
  };
  return JSON.stringify(payload, (key, value) => {
    if (value === Infinity) return INF;
    if (value === -Infinity) return NEG_INF;
    if (typeof value === 'number' && Number.isNaN(value)) return 0;
    return value;
  });
}

export function importSave(text) {
  const payload = JSON.parse(text, (key, value) => {
    if (value === INF) return Infinity;
    if (value === NEG_INF) return -Infinity;
    return value;
  });
  if (payload?.format !== 'deepwater-save') {
    throw new Error('That file is not a Deepwater save.');
  }
  return rehydrate(migrate(payload.state, payload.schemaVersion ?? 0));
}

// ---------------------------------------------------------------- autosave --

export class Autosave {
  constructor(store, { intervalMs = BAL.meta.autosaveEveryTicks * BAL.time.TICK_MS } = {}) {
    this.store = store;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.saving = false;
    this.lastError = null;
    this.onSaved = null;
    this._onHide = () => {
      // A backgrounded tab may never get another timer, so save now.
      if (document.visibilityState === 'hidden') this.saveNow('visibility');
    };
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.saveNow('interval'), this.intervalMs);
    document.addEventListener('visibilitychange', this._onHide);
    window.addEventListener('pagehide', this._onHide);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener('visibilitychange', this._onHide);
    window.removeEventListener('pagehide', this._onHide);
  }

  async saveNow(reason = 'manual') {
    if (this.saving) return null;
    this.saving = true;
    try {
      const summary = await saveGame(this.store.state);
      this.lastError = null;
      this.onSaved?.(summary, reason);
      return summary;
    } catch (err) {
      // A failed autosave must never interrupt play. Surface it, keep going.
      this.lastError = err;
      console.error('[save] autosave failed:', err);
      return null;
    } finally {
      this.saving = false;
    }
  }
}

export default { saveGame, loadGame, listSlots, deleteSlot, Autosave, exportSave, importSave };
