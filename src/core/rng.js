/**
 * rng.js — all randomness in Deepwater routes through here.
 *
 * Determinism contract (spec §18):
 *   Combat, encounters and expeditions must be reproducible given
 *   (seed, entityId, tick). We get that by never using a single shared
 *   mutable stream for anything that matters. Instead, callers derive a
 *   named sub-stream:
 *
 *       const r = streamFor(state.meta.seed, 'combat', expeditionId, day);
 *
 *   The same three inputs always produce the same sequence, so a fight
 *   resolves identically whether the player watched it live or it was
 *   replayed during offline catch-up. There is no save-scumming.
 */

/** mulberry32 — small, fast, good enough, and trivially serialisable. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string → uint32. Used to fold labels into seeds. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fold an arbitrary list of seed parts (numbers or strings) into one uint32. */
export function mixSeed(...parts) {
  let h = 0x9e3779b9;
  for (const p of parts) {
    const v = typeof p === 'number' ? (Math.floor(p) | 0) >>> 0 : hashString(String(p));
    h ^= v + 0x9e3779b9 + ((h << 6) >>> 0) + (h >>> 2);
    h = h >>> 0;
  }
  return h >>> 0;
}

/**
 * A small RNG facade. Every helper consumes a deterministic number of raw
 * draws so call-order stays stable across replays.
 */
export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
    this.draws = 0;
  }

  /** Raw float in [0,1). */
  next() {
    this.draws++;
    return this._next();
  }

  /** Float in [min,max). */
  float(min = 0, max = 1) {
    return min + this.next() * (max - min);
  }

  /** Integer in [min,max] inclusive. */
  int(min, max) {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p) {
    return this.next() < p;
  }

  /** Uniform pick. Returns undefined for an empty array. */
  pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.floor(this.next() * arr.length)];
  }

  /**
   * Weighted pick. `weights` may be a parallel array of numbers or a
   * key on each item. Non-positive total falls back to uniform.
   */
  weighted(items, weightFn) {
    if (!items || items.length === 0) return undefined;
    const w = items.map((it, i) =>
      Math.max(0, typeof weightFn === 'function' ? weightFn(it, i) : (it[weightFn] ?? 1))
    );
    let total = 0;
    for (const x of w) total += x;
    if (total <= 0) return this.pick(items);
    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= w[i];
      if (roll <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Box-Muller. Consumes exactly two draws so the stream stays aligned. */
  gaussian(mean = 0, sd = 1) {
    const u1 = Math.max(1e-12, this.next());
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z * sd;
  }

  /** Gaussian clamped to a range — the combat roll uses this. */
  gaussianClamped(mean, sd, lo, hi) {
    return Math.max(lo, Math.min(hi, this.gaussian(mean, sd)));
  }

  /** Fisher-Yates on a copy. */
  shuffle(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = out[i];
      out[i] = out[j];
      out[j] = t;
    }
    return out;
  }

  /** Pick n distinct items. */
  sample(arr, n) {
    return this.shuffle(arr).slice(0, Math.max(0, Math.min(n, arr.length)));
  }

  /** Derive a child stream. Deterministic from this stream's seed + label. */
  derive(...parts) {
    return new Rng(mixSeed(this.seed, ...parts));
  }
}

/**
 * The canonical entry point: build a stream from the world seed plus a
 * purpose label plus whatever identifies this specific roll.
 *
 *   streamFor(seed, 'encounter', expeditionId, dayIndex)
 *   streamFor(seed, 'death', citizenId, day)
 */
export function streamFor(worldSeed, label, ...parts) {
  return new Rng(mixSeed(worldSeed, label, ...parts));
}

/** Convenience for a one-shot roll where building a stream is overkill. */
export function rollChance(worldSeed, p, label, ...parts) {
  return streamFor(worldSeed, label, ...parts).chance(p);
}

/** A seed for a brand-new game, from the clock. Only called on new-game. */
export function freshSeed() {
  return mixSeed(Date.now(), Math.floor(Math.random() * 0xffffffff));
}

export default { Rng, streamFor, mixSeed, hashString, mulberry32, rollChance, freshSeed };
