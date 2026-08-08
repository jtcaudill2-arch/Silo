/**
 * game.js — the sim orchestrator.
 *
 * Owns the order in which sim modules run on each boundary the loop crosses.
 * Knows nothing about the DOM, so the headless harness drives exactly this
 * class and exercises exactly the code the browser does.
 */

import { BAL, TIME } from '../config/balance.js';
import { Loop } from './loop.js';
import { emit } from './events.js';
import * as economy from '../sim/economy.js';
import * as jobs from '../sim/jobs.js';
import * as population from '../sim/population.js';
import { getRoom } from '../data/rooms.js';

export class Game {
  constructor(store) {
    this.store = store;
    this.loop = new Loop({
      onTick: (t) => this.tick(t),
      onCycle: (c) => this.cycle(c),
      onDay: (d) => this.day(d),
      onFrame: (dt) => this.frame(dt),
      onSpill: (n) => this.spill(n),
    });
    this.loop.setTick(store.state.clock.tick);
    this.ctx = { jobSkillFor: jobs.jobSkillFor };
    population.setRoomDefLookup(getRoom);
    this.frameHooks = new Set();
  }

  get state() {
    return this.store.state;
  }

  start() {
    this.loop.start();
  }
  stop() {
    this.loop.stop();
  }
  setSpeed(m) {
    this.loop.setSpeed(m);
    this.store.dispatch({ type: 'SETTING_SET', settings: { speed: m } });
  }

  // ------------------------------------------------------------- tick ----
  tick(t) {
    const c = Loop.clockFromTick(t);
    this.state.clock.tick = t;
    this.state.clock.tickOfCycle = c.tickOfCycle;
  }

  // ------------------------------------------------------------ cycle ----
  cycle(cycleNo) {
    const store = this.store;
    const clock = Loop.clockFromTick(cycleNo * TIME.ticksPerCycle);
    store.dispatch({
      type: 'CLOCK_SET',
      emit: false,
      clock: { cycle: cycleNo, day: clock.day, year: clock.year, shift: clock.shift },
    });

    store.dispatchAll(economy.simulateCycle(this.state, this.ctx));
    store.dispatchAll(jobs.simulateCycle(this.state));
    this.advanceConstruction(cycleNo);

    emit('cycle', cycleNo);
  }

  // -------------------------------------------------------------- day ----
  day(dayNo) {
    const store = this.store;
    store.dispatchAll(population.simulateDay(this.state, this.ctx));
    store.dispatchAll(jobs.manageSchool(this.state));
    this.dailyOrder();
    this.checkFailure();
    emit('day', dayNo);
  }

  /**
   * The Order drift + the pressures that feed it. The full political layer
   * (policies, crime, uprisings) lands in Phase 7; this is the economic half,
   * which the economy needs from day one so shortages actually bite.
   */
  dailyOrder() {
    const state = this.state;
    const O = BAL.order;
    const env = population.readEnvironment(state);
    let delta = (O.driftToward - state.order.value) * O.driftRate;

    if (env.starving) delta += BAL.resources.shortage.starvation.orderPerDay;
    if (env.dehydrated) delta += BAL.resources.shortage.dehydration.orderPerDay;
    if (env.overcrowdedBy > 0) {
      delta -= env.overcrowdedBy * BAL.citizens.housing.overcrowdOrderPerOver;
    }
    if (env.foodSurplus > 0) delta += O.surplusFoodBonus;
    delta -= jobs.idleDissent(state);

    for (const room of Object.values(state.silo.rooms)) {
      const def = getRoom(room.type);
      if (def?.provides.order && room.powered) delta += O.sheriffBonusPerLevel * room.level;
    }

    this.store.dispatch({ type: 'ORDER_DELTA', amount: delta, emit: false });

    const below = state.order.value < O.uprisingThreshold;
    this.store.dispatch({
      type: 'ORDER_STREAK',
      emit: false,
      days: below ? state.order.daysBelowThreshold + 1 : 0,
    });
  }

  /** Rooms under construction or upgrade come online here. */
  advanceConstruction(cycleNo) {
    for (const id of Object.keys(this.state.silo.rooms)) {
      const room = this.state.silo.rooms[id];
      if (room.buildingUntilCycle && cycleNo >= room.buildingUntilCycle) {
        this.store.dispatch({ type: 'ROOM_PATCH', id, patch: { buildingUntilCycle: 0 } });
        const def = getRoom(room.type);
        this.store.dispatch({
          type: 'LOG',
          entry: { kind: 'alert', text: `${def?.name || room.type} on floor ${room.floor} is finished and online.` },
        });
      }
      if (room.upgradingUntilCycle && cycleNo >= room.upgradingUntilCycle) {
        this.store.dispatch({
          type: 'ROOM_PATCH',
          id,
          patch: { upgradingUntilCycle: 0, level: Math.min(BAL.silo.upgrade.maxLevel, room.level + 1) },
        });
      }
    }
  }

  /** The two ways a silo simply ends. */
  checkFailure() {
    const state = this.state;
    if (state.meta.gameOver) return;
    if (state.citizenIds.length === 0) {
      this.store.dispatch({
        type: 'GAME_OVER',
        reason: 'extinction',
        text: 'The last resident of Silo 12 is dead. The lights are still on.',
      });
      this.stop();
    }
  }

  // ------------------------------------------------------------ frame ----
  frame(dt) {
    this.store.dispatch({ type: 'PLAYED_MS', ms: dt, emit: false });
    for (const fn of this.frameHooks) fn(dt);
    this.store.flush();
  }

  onFrame(fn) {
    this.frameHooks.add(fn);
    return () => this.frameHooks.delete(fn);
  }

  spill(cycles) {
    // The loop fell far enough behind that draining inline would lock the
    // frame. Hand it to the coarse path instead.
    emit('spill', cycles);
  }

  // --------------------------------------------------- headless driving --
  /** Run N whole cycles with no rendering. Used by the test harness. */
  runCycles(n) {
    this.loop.runCycles(n);
  }
  runDays(n) {
    this.loop.runCycles(n * TIME.cyclesPerDay);
  }
}

export default Game;
