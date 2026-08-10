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

import { BAL, TIME } from '../config/balance.js';

export const SCHEMA_VERSION = 14;

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

  // 11 -> 12: Phase 9. Scripted crises record the day they fired so they
  // fire once and once only, and a finished campaign records which ending
  // it reached. A save from before this had neither, and an absent
  // `crises` map would re-fire every crisis whose hour had already passed
  // the moment the save was opened.
  11: (state) => {
    state.flags ??= {};
    state.flags.crises ??= {};
    state.flags.firstContact ??= false;
    state.flags.tutorialSeen ??= false;
    state.meta ??= {};
    state.meta.ending ??= null;
    return state;
  },

  // 12 -> 13: the guided first session. It persists which step it is on, so a
  // reload halfway through resumes halfway through rather than starting the
  // silo's induction over. -1 means finished or skipped and is never shown
  // again; null means not started.
  //
  // The important half of this step is the second line. A save that had
  // already read the handover has already had its tutorial, and a silo on day
  // two hundred must not be met with a spotlight telling it to build its first
  // Recycling plant — so those are stamped finished on the way in, rather than
  // being left to the engine to guess about later.
  12: (state) => {
    state.flags ??= {};
    if (state.flags.tutorialStep === undefined) {
      state.flags.tutorialStep = state.flags.tutorialSeen ? -1 : null;
    }

    // A cycle became 90 ticks, up from 60, to make a game day 12 real minutes
    // instead of 8. `clock.tick` is an absolute counter and it is *saved*, and
    // the loop is reseeded from it on load — so a save written under the old
    // length has its age recomputed against the new one and travels backwards.
    // A day-100 silo (tick 48000) reopens on day 66, and every deadline stored
    // in cycles goes with it: a room three shifts from finished had 269 shifts
    // left, pregnancies and expedition returns likewise, and the return report
    // computes a negative day range.
    //
    // `cycle` is stored too, and every *UntilCycle field is already denominated
    // in cycles, so recomputing the tick from the cycle puts the clock and all
    // of those deadlines back in agreement in one line. Ticks within the
    // current cycle are discarded, which costs at most one shift of progress.
    if (state.clock && Number.isFinite(state.clock.cycle)) {
      state.clock.tick = state.clock.cycle * TIME.ticksPerCycle;
    }
    return state;
  },

  // The silo is 144 levels, not 92. A save written before that has a floors
  // array 52 entries short, and every consumer indexes it by floor number —
  // the cross-section, the depth gauge, placement, the camera clamp — so a
  // short array is not a smaller silo, it is out-of-range reads wherever the
  // player looks below 92.
  //
  // The new levels arrive sealed and unshored, which is what they would have
  // been had the save been created today. Nothing already dug is touched, and
  // the descent still stops at `reachableFloors`, so this changes what a
  // returning player can *see* and nothing about what they can do.
  13: (state) => {
    const floors = state.silo?.floors;
    if (!Array.isArray(floors)) return state;
    for (let n = floors.length + 1; n <= BAL.silo.totalFloors; n++) {
      floors.push({
        n,
        excavated: false,
        shored: n < BAL.silo.excavation.shoringRequiredBelowFloor,
        slots: new Array(BAL.silo.slotsPerFloor).fill(null),
        integrity: 100,
      });
    }
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
