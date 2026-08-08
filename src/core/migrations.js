/**
 * migrations.js — forward-only save migrations.
 *
 * The rule (spec §18): no feature ships without a migration path. Bump
 * SCHEMA_VERSION and add the step in the same commit as the state change.
 *
 * Each entry is keyed by the version it migrates *from* and returns state at
 * version key+1. Steps must never assume a field exists — a save can be
 * arbitrarily old — and must be safe to re-run.
 *
 * Version 10 is the baseline: the first build that persisted anything.
 * This file is the authority on the current version, not config/balance.js —
 * schema version is a code fact, not a tuning knob.
 */

export const SCHEMA_VERSION = 11;

export const MIGRATIONS = {
  // 10 -> 11: Phase 2. Persistence added the catch-up bookkeeping, the audio
  // settings, and the stored ReturnReport that survives a reload.
  10: (state) => {
    state.meta.lastSaveTs ??= state.meta.createdAt ?? Date.now();
    state.meta.playedMs ??= 0;
    state.settings ??= {};
    state.settings.muted ??= true;
    state.settings.volume ??= 0.6;
    state.settings.reducedMotion ??= false;
    state.settings.speed ??= 1;
    state.lastReport ??= null;
    state.flows ??= {};
    state.caps ??= {};
    return state;
  },
};

export function latestVersion() {
  return SCHEMA_VERSION;
}

/** True if this save can be opened by this build at all. */
export function canLoad(version) {
  return typeof version === 'number' && version <= SCHEMA_VERSION;
}

export default MIGRATIONS;
