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

export const SCHEMA_VERSION = 21;

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

  // 14 -> 15: Phase C. Rooms carry `found`, which marks one that a dig turned
  // up still standing and that has never been put into service.
  //
  // Every room in an existing save was built by the player, so the answer for
  // all of them is false — and an absent field would already read as false
  // everywhere it is used. It is written out anyway: the flag decides whether
  // the standing orders treat a room at fifteen condition as a bargain or as
  // an emergency, and a save where that turns on the difference between
  // `false` and `undefined` is a save whose shape is a guess.
  14: (state) => {
    const rooms = state.silo?.rooms;
    if (!rooms) return state;
    for (const room of Object.values(rooms)) {
      if (room && typeof room === 'object') room.found ??= false;
    }
    return state;
  },

  // 15 -> 16: Phase D. `floor.integrity` and `floor.shored` stop being
  // decoration and start being the thing that decides whether the deep stays
  // the player's.
  //
  // This one gives something back rather than taking it. `excavationCost`
  // has always charged alloy for shoring on every floor below the line, and
  // `EXCAVATION_COMPLETE` has always marked those same floors unshored — so
  // an existing save is carrying a hundred-odd deep floors the player bought
  // supports for and never received. Under the old rules that cost them
  // nothing, because the only thing reading `shored` wrote to a field nothing
  // read. Under the new ones it would quadruple the decay on every deep floor
  // in the silo the moment they reopened the game, for a bill they had already
  // paid.
  //
  // So: every excavated floor is shored, and every floor starts sound. A
  // returning silo is exactly as deep and exactly as safe as it was, and the
  // clock on holding it starts now.
  // The reset is unconditional, and that is the whole point of the step.
  // Writing it only `if (!Number.isFinite(floor.integrity))` did nothing at
  // all: `buildFloors` has always written `integrity: 100` and the old
  // partial-collapse roll always wrote a finite number back, so the guard was
  // never true for any real save. A v15 silo that had taken two of those old
  // collapse rolls on a deep floor therefore loaded at integrity 30 and went
  // straight past the strain warning; one that had taken three loaded at 0,
  // where neither the warning nor the collapse can fire — `before >= line` and
  // `before > 0` are both false — and quietly ate 1.2 condition a day off every
  // room on that floor for the rest of the game.
  15: (state) => {
    const floors = state.silo?.floors;
    if (!Array.isArray(floors)) return state;
    for (const floor of floors) {
      if (!floor || typeof floor !== 'object') continue;
      floor.integrity = BAL.silo.condition.start;
      if (floor.excavated) floor.shored = true;
    }
    return state;
  },

  // 16 -> 17: raids resolve, and conquest advances.
  //
  // Both features are mostly *reading* fields that already existed, so this
  // step is small — but it is not empty, and two of the three parts matter to
  // a save that has been played.
  //
  // 1. `world.pendingRaid`. Any save from before this build can be carrying
  //    one: `PENDING_RAID` has always written it and nothing has ever cleared
  //    it, so a silo that was raided on day 12 of a 400-day campaign still has
  //    that raid pending. Left alone, sim/raid.js would resolve it on the
  //    first day after the load — a day-12 raiding party materialising in a
  //    silo that has since built an army, or, worse, sacking a silo whose
  //    squads are all out. It is stale, the player was never given the chance
  //    to answer it, and the honest thing is to drop it.
  //
  // 2. The conquest counters. `conquestState` already falls back to a default
  //    for a silo with no `conquest` field, so nothing crashes without this —
  //    but `CONQUEST_PATCH` spreads onto whatever is there, and a silo that
  //    somehow acquired a partial record would spread onto holes. Fill them.
  //
  // 3. The two raid counters, so the ending screen's figures do not start at
  //    undefined for a campaign that predates them. `STAT_BUMP` creates keys
  //    on demand, so this is about the *display*, not about the arithmetic.
  16: (state) => {
    if (state.world) state.world.pendingRaid = null;
    for (const silo of Object.values(state.world?.silos || {})) {
      if (!silo || typeof silo !== 'object') continue;
      silo.conquest = {
        stage: null,
        scoutRuns: 0,
        undermined: false,
        defenseMult: 1,
        ...(silo.conquest || {}),
      };
    }
    if (state.stats) {
      state.stats.raidsRepelled ??= 0;
      state.stats.raidsLost ??= 0;
      state.stats.silosTaken ??= 0;
    }
    return state;
  },

  // 17 -> 18: per-item gear stats, a loot tier above the crafted ladder, and
  // the durability that was always declared and never written.
  //
  // The stats themselves need no migration and it is worth saying why: a gear
  // record stores an *item id*, and `power`, `dr`, `ammo`, `pierce`, `soak`,
  // `band`, `shielding` and `wear` are all read off the item definition in
  // code. An old save's Mag Rifle picks up `stats.power: 2.5` — the same 2.5
  // `gearTierMult[3]` handed it yesterday — the moment it is loaded. What
  // does need writing is the shape of the gear records themselves.
  //
  // 1. `loot`. Every piece in an existing save was made at a bench, because
  //    until this build there was no other way to come by one. So the answer
  //    for all of them is false. It is written out rather than left absent for
  //    the reason `found` was on rooms: the Armory now sorts and labels on
  //    this field, and a save where that turns on `false` versus `undefined`
  //    is a save whose shape is a guess.
  //
  // 2. `integrity`. `GEAR_CRAFT` has always written it, so this is belt and
  //    braces for a record from a build that predates suits — but the armoury
  //    repair queue now filters on `integrity < max`, and `undefined < 100` is
  //    false, which would silently exclude such a piece from repair for ever.
  //
  // 3. `durability`. Same, and with a live consequence: `unitPower`'s wear
  //    term is `0.6 + 0.4 * (durability / durabilityMax)`, and an undefined
  //    durability makes that NaN, which propagates through squad power into
  //    the ratio and out into an outcome lookup that finds nothing. Every
  //    weapon in every existing save is at 100 — nothing has ever written this
  //    field — so this is the value they already have, made explicit before
  //    the first thing that reads it starts subtracting from it.
  17: (state) => {
    for (const g of Object.values(state.military?.gear || {})) {
      if (!g || typeof g !== 'object') continue;
      g.loot ??= false;
      if (!Number.isFinite(g.durability)) g.durability = BAL.gear.durabilityMax;
      if (!Number.isFinite(g.integrity)) g.integrity = BAL.gear.suit.integrityMax;
    }
    return state;
  },

  // 18 -> 19: Doctrine. The talent tree needs a ledger, and an existing silo
  // needs to arrive at one without being punished for having played already.
  //
  // `frontier` is the interesting field. Commendations only pay for a run at
  // or beyond the deepest reward tier the silo has ever come back from, and a
  // save from before this feature has no such record — so a day-600 silo that
  // has been to the Scar a dozen times would load with a frontier of 0 and
  // then be paid full doctrine for pottering around the near ruins, which is
  // exactly the farm the rule exists to close.
  //
  // It is recovered instead of defaulted. `expeditions.history` is capped at
  // 30 entries, so it is not a complete record and cannot be treated as one —
  // but it is a *lower bound*, and a lower bound is the safe direction to be
  // wrong in: the worst case is a silo that gets paid for one band it had
  // already outgrown, and the frontier corrects itself on the next real run.
  // Defaulting to 0 has no such ceiling.
  18: (state) => {
    if (!state.doctrine) {
      let frontier = 0;
      for (const exp of state.expeditions?.history || []) {
        const tier = (BAL.expedition.bands || []).find((b) => b.key === exp.band)?.rewardTier || 0;
        if (tier > frontier) frontier = tier;
      }
      state.doctrine = { points: 0, earned: 0, taken: [], frontier };
    }
    state.doctrine.points ??= 0;
    state.doctrine.earned ??= 0;
    state.doctrine.taken ??= [];
    state.doctrine.frontier ??= 0;
    return state;
  },

  // 19 -> 20: the Schoolhouse gave up its roster. Nothing about school ever
  // read one — `manageSchool` teaches off `powered` and the 2.2x growth is
  // charged to the child's status — so the posts were people producing
  // nothing, and `autoAssign` kept them filled.
  //
  // Dropping `staff` from the room definition is not enough on its own,
  // because a save carries the assignment on both sides: the room's roster and
  // the citizen's `job`. With no slots on the definition, `openSlots` stops
  // seeing the room and `autoAssign` never touches anyone standing in it, so a
  // teacher from an older save would keep a job in a room with no posts for
  // the rest of the campaign — off the labour market, doing nothing, and
  // invisible to the one routine that would have moved them.
  //
  // Both sides, then, and only for schoolhouses. Anyone freed goes back to
  // `idle` with no job, which is the state `autoAssign` picks people up from
  // on its next pass. Safe to re-run: a room with an empty roster and citizens
  // with no schoolhouse job are what it leaves behind.
  // Keyed on the map key rather than `room.id`, per the contract at the top of
  // this file: a step may not assume a field exists. A room without one would
  // put `undefined` into the set, and `undefined` matches `c.job?.roomId` for
  // every citizen who has no job at all — which would strip a working citizen
  // out of a post they were correctly holding.
  //
  // And `training` counts alongside `working`. Somebody may hold a schoolhouse
  // post while on the range; leaving them at `training` with no job is a state
  // `autoAssign` never picks anyone up from, which is the same stranding this
  // step exists to undo.
  19: (state) => {
    const schools = new Set();
    for (const [key, room] of Object.entries(state.silo?.rooms || {})) {
      if (room?.type !== 'schoolhouse') continue;
      schools.add(key);
      room.staff = [];
    }
    if (schools.size) {
      for (const c of Object.values(state.citizens || {})) {
        if (!c || c.job?.roomId == null || !schools.has(c.job.roomId)) continue;
        c.job = null;
        if (c.status === 'working' || c.status === 'training') c.status = 'idle';
      }
    }
    return state;
  },

  // Put the stranded back to work.
  //
  // `EXPEDITION_RESOLVE` sent every survivor to `idle` and left their `job` and
  // their room's `staff` roster untouched, so anyone who held a post when they
  // went outside came home still holding it and never worked again:
  // `roomCapability` counts only `working` and `training`, and `autoAssign`'s
  // pool is people with no job, so the seat produced nothing and could not be
  // refilled. Every save from before that fix carries however many of those the
  // silo accumulated — a 400-day campaign had two, in a laboratory and a
  // generator hall.
  //
  // The repair is the state the reducer now writes, applied to what is already
  // there: somebody holding a post is at it. Both sides are checked, because
  // `job` and the roster are two records of one fact and only the pair of them
  // agreeing means the post is really theirs — a job pointing at a room that
  // does not list them is the stale half, and that person goes back in the pool
  // instead. Re-running it changes nothing: after one pass there is no living
  // citizen left who is idle and rostered.
  20: (state) => {
    for (const [key, room] of Object.entries(state.silo?.rooms || {})) {
      for (const cid of room?.staff || []) {
        const c = state.citizens?.[cid];
        if (!c || c.status !== 'idle' || c.job?.roomId !== key) continue;
        c.status = 'working';
      }
    }
    for (const c of Object.values(state.citizens || {})) {
      if (!c || c.status !== 'idle' || c.job?.roomId == null) continue;
      const room = state.silo?.rooms?.[c.job.roomId];
      if (!room || !(room.staff || []).includes(c.id)) c.job = null;
    }
    return state;
  },
};

export function latestVersion() {
  return SCHEMA_VERSION;
}

// There is no `canLoad(version)` helper, and there was one here for a long
// time that nothing ever called. `migrate` in save.js already refuses a record
// from a newer build — migrations only run forward, so there is no step that
// brings a future save back — and a second copy of that rule that no load path
// consults is worse than none: it reads like the guard, and it is not.

export default MIGRATIONS;
