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
import { caretakerDay } from '../sim/caretaker.js';
import * as research from '../sim/research.js';
import * as build from '../sim/build.js';
import * as military from '../sim/military.js';
import * as expedition from '../sim/expedition.js';
import * as world from '../sim/world.js';
import * as raid from '../sim/raid.js';
import * as diplomacy from '../sim/diplomacy.js';
import * as order from '../sim/order.js';
import * as events from '../sim/events.js';
import { streamFor } from './rng.js';
import { digOutcome } from '../sim/dig.js';
import { getRoom } from '../data/rooms.js';

/** "water" -> "Water". The UI's own humanise lives in the DOM layer. */
const humanise = (k) => k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');

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
    world.setRefugeeFactory(population.makeCitizen);
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
    store.dispatchAll(research.simulateCycle(this.state));
    store.dispatchAll(military.simulateCycle(this.state));
    this.advanceConstruction(cycleNo);

    emit('cycle', cycleNo);
  }

  // -------------------------------------------------------------- day ----
  day(dayNo) {
    const store = this.store;
    store.dispatchAll(population.simulateDay(this.state, this.ctx));
    store.dispatchAll(jobs.manageSchool(this.state));
    store.dispatchAll(build.simulateDay(this.state, streamFor(this.state.meta.seed, 'structure', dayNo)));
    store.dispatchAll(military.simulateDay(this.state));
    // Expeditions resolve on their scheduled return day from a stream seeded
    // on the expedition id, so the result is identical whether the player
    // watched it or slept through it (spec §3.4).
    store.dispatchAll(expedition.simulateDay(this.state));
    store.dispatchAll(world.simulateDay(this.state));
    // After the world, so a raid queued today gets its grace day before this
    // looks at it, and before events so the day's alert reads in order.
    store.dispatchAll(raid.simulateDay(this.state));
    store.dispatchAll(diplomacy.simulateTick(this.state));
    this.resolveWorldEvents(dayNo);
    this.syncRadioTier();
    this.dailyOrder();
    store.dispatchAll(order.simulateDay(this.state));
    store.dispatchAll(events.simulateDay(this.state));
    this.checkRunway();
    this.checkFailure();
    emit('day', dayNo);
  }

  /**
   * Warn when something people drink or breathe is running out.
   *
   * A stockpile pinned at its cap hides a negative flow completely: the strip
   * reads 800/800 and keeps reading it until the day the tank starts visibly
   * falling, and from there a silo of two hundred has about three days. Played
   * by hand it looks like this — full food, full water, order at fifty on day
   * seventy; a hundred and eighty-five dead of thirst by day eighty-eight,
   * with nothing in the log between the two except flavour text.
   *
   * The information was always on screen. Nobody can be expected to integrate
   * it in their head every shift, so the silo says it out loud instead, once
   * per crossing, in days rather than units.
   */
  checkRunway() {
    const A = BAL.alerts;
    const state = this.state;
    const warned = state.flags.runwayWarned || {};
    const next = { ...warned };
    const actions = [];

    for (const key of A.runwayWatch) {
      const flow = state.flows?.[key];
      const net = flow ? flow.in - flow.out : 0;
      const stock = state.resources[key] ?? 0;
      const days = net < 0 ? stock / (-net * BAL.time.CYCLES_PER_DAY) : Infinity;

      if (days <= A.runwayWarnDays) {
        // Re-warn as it gets worse, not every single day it stays bad.
        const band = days <= A.runwayCriticalDays ? 'critical' : 'low';
        if (warned[key] === band) continue;
        next[key] = band;
        const whole = Math.max(0, Math.floor(days));
        // The arithmetic behind the warning, in one clause. A figure in days
        // is the right thing to shout, but it is derived from two numbers the
        // player never sees together, and "why is it falling" is the next
        // question every time.
        const cause =
          `${flow.in.toFixed(1)} in against ${flow.out.toFixed(1)} out per shift, ` +
          `with ${Math.round(stock)} in store.`;
        actions.push({
          type: 'LOG',
          entry: {
            kind: 'alert',
            text:
              band === 'critical'
                ? `${humanise(key)} runs out in ${whole === 0 ? 'under a day' : `${whole} day${whole === 1 ? '' : 's'}`}. ` +
                  'People start dying after that, and there is no warning shorter than this one. ' +
                  cause
                : `${humanise(key)} is falling. About ${whole} days left at the current rate — ` +
                  `the tank is still full, and that is the problem. ${cause}`,
          },
        });
        emit('alert', {
          kind: band === 'critical' ? 'bad' : 'warn',
          glyph: '⌛',
          text: `${humanise(key)}: ${whole}d left`,
          why: cause,
          resource: key,
        });
      } else if (warned[key]) {
        delete next[key];
        actions.push({
          type: 'LOG',
          entry: { kind: 'plain', text: `${humanise(key)} is back in surplus.` },
        });
      }
    }

    // Rooms wear out on the same silence. A generator hall that fails takes
    // every producing room with it, and the tanks are empty three days later.
    const wornWarned = state.flags.wornWarned || {};
    const nextWorn = { ...wornWarned };
    for (const room of Object.values(state.silo.rooms)) {
      if (room.buildingUntilCycle && state.clock.cycle < room.buildingUntilCycle) continue;
      const def = getRoom(room.type);
      const band =
        room.condition <= A.conditionCriticalAt ? 'critical' :
        room.condition <= A.conditionWarnAt ? 'worn' : null;
      if (!band) {
        if (wornWarned[room.id]) delete nextWorn[room.id];
        continue;
      }
      if (wornWarned[room.id] === band) continue;
      nextWorn[room.id] = band;
      const where = `${def?.name || room.type} on floor ${room.floor}`;
      actions.push({
        type: 'LOG',
        entry: {
          kind: 'alert',
          text:
            band === 'critical'
              ? `${where} is at ${Math.round(room.condition)} and close to failing outright. ` +
                'Repair it or plan to do without it.'
              : `${where} is wearing out — condition ${Math.round(room.condition)}. ` +
                'Maintenance crews slow this down; they do not stop it.',
          // Where it is, carried as data rather than left in the prose for
          // the UI to parse back out. The log makes an entry with a floor on
          // it tappable, and it takes the cross-section there.
          data: { floor: room.floor, roomId: room.id },
        },
      });
      emit('alert', {
        kind: band === 'critical' ? 'bad' : 'warn',
        glyph: '⚙',
        text: `${def?.name || room.type}: ${Math.round(room.condition)}%`,
        why:
          `Every room wears as it runs. This one is on floor ${room.floor} and ` +
          (band === 'critical'
            ? 'stops producing entirely at zero — if it makes power, the rooms below it in the priority list stop too.'
            : 'output starts falling below 40. A Maintenance Bay slows the wear; a repair reverses it.'),
        floor: room.floor,
        roomId: room.id,
      });
    }
    if (Object.keys(nextWorn).length !== Object.keys(wornWarned).length ||
        Object.keys(nextWorn).some((k) => nextWorn[k] !== wornWarned[k])) {
      actions.push({ type: 'FLAG_SET', flags: { wornWarned: nextWorn } });
    }

    // Labs with nothing to work on. Points pile up, no node advances, and the
    // silo looks busy the whole time — the panel badge that says otherwise is
    // one small numeral that reads identically on day one and day two hundred.
    const startable = !state.research.active && research.available(state).length > 0;
    const banked = state.research.points > 0;
    if (startable && banked) {
      const since = state.flags.idleResearchSince;
      if (since == null) {
        actions.push({ type: 'FLAG_SET', flags: { idleResearchSince: state.clock.day } });
      } else if (state.clock.day - since >= A.idleResearchDays && !state.flags.idleResearchWarned) {
        actions.push({ type: 'FLAG_SET', flags: { idleResearchWarned: true } });
        actions.push({
          type: 'LOG',
          entry: {
            kind: 'alert',
            text:
              `The laboratories have been idle for ${state.clock.day - since} days with ` +
              `${Math.floor(state.research.points)} points banked. Nothing is being researched, ` +
              'and nothing will be until somebody picks a project.',
          },
        });
        emit('alert', {
          kind: 'warn',
          glyph: '⌬',
          text: 'Labs idle — pick a project',
          why:
            `${Math.floor(state.research.points)} points banked and nothing being worked on for ` +
            `${state.clock.day - since} days. Points accrue either way; nothing completes until a project is chosen.`,
          panel: 'research',
        });
      }
    } else if (state.flags.idleResearchSince != null) {
      actions.push({ type: 'FLAG_SET', flags: { idleResearchSince: null, idleResearchWarned: false } });
    }

    if (actions.length) {
      actions.push({ type: 'FLAG_SET', flags: { runwayWarned: next } });
      this.store.dispatchAll(actions);
    }
  }

  /**
   * One game day resolved in a single coarse step, for offline catch-up.
   * Deliberately routes through the same day() as live play so the two paths
   * can't drift apart — only the economy is averaged.
   */
  coarseDay() {
    const store = this.store;
    const tick = this.state.clock.tick + TIME.ticksPerDay;
    const clock = Loop.clockFromTick(tick);

    store.dispatch({
      type: 'CLOCK_SET',
      emit: false,
      clock: { tick, cycle: clock.cycle, day: clock.day, year: clock.year, shift: clock.shift },
    });
    this.loop.setTick(tick);

    // Somebody keeps the pumps running while nobody is watching.
    //
    // A game day is twelve real minutes, so a weekend away is sixty game days
    // with no player in them. Measured before this line existed: a silo whose
    // life-support rooms were standing uncrewed when the player closed the app
    // was extinct inside twenty days, all three seeds, cause of death
    // dehydration fifty times over. A silo of forty-eight people does not die
    // of thirst next to a working pump because the mayor is asleep.
    //
    // Deliberately only on the coarse path, which is only ever reached from
    // catch-up: while the player is watching, crewing is their job.
    store.dispatchAll(caretakerDay(this.state));
    store.dispatchAll(economy.simulateDayCoarse(this.state, this.ctx));
    this.advanceConstruction(clock.cycle);
    this.day(clock.day);
  }

  /**
   * The Order drift + the pressures that feed it. This is the economic half,
   * which the economy needs from day one so shortages actually bite; the
   * political half — policies, crime, investigations, uprisings — is in
   * sim/order.js and runs from `day()` eight lines above.
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

  /**
   * Queued world events land on their day: refugees at the airlock, an ally
   * calling you in, a raid arriving. They're queued rather than immediate so
   * a collapse in the world has travel time attached to it.
   */
  resolveWorldEvents(dayNo) {
    const pending = this.state.world.pending || [];
    if (!pending.length) return;
    for (const event of pending.slice()) {
      if (this.state.clock.day < event.day) continue;
      this.store.dispatchAll(world.applyWorldEvent(this.state, event));
      this.store.dispatch({ type: 'WORLD_EVENT_RESOLVE', event });
    }
  }

  /** Radio range follows research; the world tick reads it. */
  syncRadioTier() {
    const tier = research.effects(this.state).radioTier || 0;
    if (tier > (this.state.world.radioTier || 0)) {
      this.store.dispatch({ type: 'RADIO_TIER', tier });
    }
  }

  /** Rooms under construction or upgrade come online here, and digs finish. */
  advanceConstruction(cycleNo) {
    const dig = this.state.silo.excavating;
    if (dig && cycleNo >= dig.untilCycle) {
      // What is behind the door is rolled here, where the seeded streams live,
      // and carried in the action so the reducer stays pure. Keyed on the
      // floor rather than the cycle, so the same save always opens the same
      // level and a catch-up replay agrees with live play.
      const outcome = digOutcome(
        this.state,
        dig.floor,
        streamFor(this.state.meta.seed, 'dig', dig.floor)
      );
      this.store.dispatch({ type: 'EXCAVATION_COMPLETE', floor: dig.floor, outcome });
    }
    for (const id of Object.keys(this.state.silo.rooms)) {
      const room = this.state.silo.rooms[id];
      if (room.buildingUntilCycle && cycleNo >= room.buildingUntilCycle) {
        this.store.dispatch({ type: 'ROOM_PATCH', id, patch: { buildingUntilCycle: 0 } });
        const def = getRoom(room.type);
        this.store.dispatch({
          type: 'LOG',
          entry: {
            kind: 'alert',
            text: `${def?.name || room.type} on floor ${room.floor} is finished and online.`,
            data: { floor: room.floor, roomId: id },
          },
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

  /** The one way a silo simply ends: nobody left to run it. */
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
