/**
 * loop.js — fixed timestep tick scheduler with an accumulator.
 *
 * Ticks are cheap: they only advance the clock and drive animation/progress
 * bars. The expensive work hangs off the cycle and day boundaries the tick
 * counter crosses (spec §3.3). The loop itself owns no game state — it calls
 * out and lets the sim decide what a cycle means.
 *
 * The same class runs headless (no requestAnimationFrame) so the test harness
 * can fast-forward 100 game days without a browser.
 */

import { BAL, TIME } from '../config/balance.js';

export class Loop {
  /**
   * @param {object} opts
   * @param {(tick:number)=>void}  opts.onTick
   * @param {(cycle:number)=>void} opts.onCycle
   * @param {(day:number)=>void}   opts.onDay
   * @param {(dtMs:number)=>void}  opts.onFrame   render hook, not fixed-step
   * @param {(spillCycles:number)=>void} opts.onSpill  accumulator overflow
   */
  constructor(opts = {}) {
    this.onTick = opts.onTick || (() => {});
    this.onCycle = opts.onCycle || (() => {});
    this.onDay = opts.onDay || (() => {});
    this.onFrame = opts.onFrame || (() => {});
    this.onSpill = opts.onSpill || (() => {});

    this.tickMs = BAL.time.TICK_MS;
    this.accumulator = 0;
    this.lastFrameTs = 0;
    this.running = false;
    this.paused = false;
    this.speed = 1; // 0 = paused, 1 = normal, 2/4 = fast-forward
    this.rafId = null;
    this.tick = 0; // absolute tick counter, owned by the caller's state normally
    this.ticksThisFrame = 0;
  }

  /** Absolute tick -> {tick, cycle, day, shift, year} */
  static clockFromTick(tick) {
    const cycle = Math.floor(tick / TIME.ticksPerCycle);
    const day = Math.floor(cycle / TIME.cyclesPerDay);
    const year = Math.floor(day / TIME.daysPerYear);
    return {
      tick,
      cycle,
      day,
      year,
      shift: cycle % TIME.cyclesPerDay,
      dayOfYear: day % TIME.daysPerYear,
      tickOfCycle: tick % TIME.ticksPerCycle,
    };
  }

  setTick(t) {
    this.tick = t;
  }

  setSpeed(mult) {
    this.speed = Math.max(0, mult);
    this.paused = this.speed === 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameTs = now();
    this.accumulator = 0;
    this.schedule();
  }

  stop() {
    this.running = false;
    if (this.rafId != null) {
      cancelFrame(this.rafId);
      this.rafId = null;
    }
  }

  schedule() {
    if (!this.running) return;
    this.rafId = requestFrame((ts) => this.frame(ts));
  }

  frame(ts) {
    if (!this.running) return;
    const t = typeof ts === 'number' ? ts : now();
    let dt = t - this.lastFrameTs;
    this.lastFrameTs = t;
    // A hidden tab can hand us an enormous dt. Clamp it here; the real
    // long-absence path is catchup.js, not this.
    if (dt < 0) dt = 0;
    if (dt > 5000) dt = 5000;

    if (!this.paused) this.advance(dt * this.speed);
    this.onFrame(dt);
    this.schedule();
  }

  /**
   * Drain `ms` of simulated time in whole ticks. Safe to call directly from
   * tests and from the catch-up fine path.
   */
  advance(ms) {
    this.accumulator += ms;
    const maxTicks = BAL.time.maxCyclesPerFrame * TIME.ticksPerCycle;
    let ticksRun = 0;

    while (this.accumulator >= this.tickMs) {
      this.accumulator -= this.tickMs;
      this.stepOneTick();
      ticksRun++;
      if (ticksRun >= maxTicks) {
        // Spill: too far behind to catch up inside one frame.
        const spilledCycles = Math.floor(this.accumulator / this.tickMs / TIME.ticksPerCycle);
        if (spilledCycles > 0) {
          this.accumulator = 0;
          this.onSpill(spilledCycles);
        }
        break;
      }
    }
    this.ticksThisFrame = ticksRun;
    return ticksRun;
  }

  /** Advance exactly one tick and fire whatever boundaries it crosses. */
  stepOneTick() {
    this.tick++;
    const t = this.tick;
    this.onTick(t);
    if (t % TIME.ticksPerCycle === 0) {
      const cycle = t / TIME.ticksPerCycle;
      this.onCycle(cycle);
      if (cycle % TIME.cyclesPerDay === 0) {
        this.onDay(cycle / TIME.cyclesPerDay);
      }
    }
  }

  /** Run N whole cycles immediately (used by tests and coarse replay). */
  runCycles(n) {
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < TIME.ticksPerCycle; k++) this.stepOneTick();
    }
  }
}

// ---- environment shims so the loop works in node and in the browser ----
const hasRaf = typeof requestAnimationFrame === 'function';

function requestFrame(fn) {
  if (hasRaf) return requestAnimationFrame(fn);
  return setTimeout(() => fn(now()), 16);
}

function cancelFrame(id) {
  if (hasRaf) cancelAnimationFrame(id);
  else clearTimeout(id);
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

export default Loop;
