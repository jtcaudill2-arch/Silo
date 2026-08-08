/**
 * audio.js — WebAudio, synthesised rather than sampled.
 *
 * Every sound in Deepwater is generated at runtime from oscillators and
 * filtered noise. That is not a shortcut: this game is an offline-first PWA
 * where every byte has to be precached, and a silo's soundscape is machinery
 * — hum, relays, filtered air, alarms — which synthesis renders better and
 * for free than a folder of 128kbps loops would.
 *
 * Muted until the first user gesture (browsers require it, and so does
 * taste). The ambient bed is a continuous graph that responds to state: it
 * detunes and dims during a brownout, and picks up a Geiger tick when the
 * silo is contaminated.
 */

import { BAL } from '../config/balance.js';

let ctx = null;
let master = null;
let ambientGain = null;
let sfxGain = null;
let started = false;
let muted = true;
let volume = 0.6;

const nodes = {};

// --------------------------------------------------------------- lifecycle ---

export function isReady() {
  return started && !!ctx;
}

/** Must be called from a user gesture. Safe to call repeatedly. */
export async function start() {
  if (started) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try {
    ctx = new AC();
    if (ctx.state === 'suspended') await ctx.resume();

    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(ctx.destination);

    ambientGain = ctx.createGain();
    ambientGain.gain.value = 0.35;
    ambientGain.connect(master);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.9;
    sfxGain.connect(master);

    buildAmbient();
    started = true;
    return true;
  } catch (err) {
    console.warn('[audio] could not start:', err);
    return false;
  }
}

export function setMuted(next) {
  muted = next;
  if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.05);
}

export function setVolume(v) {
  volume = Math.max(0, Math.min(1, v));
  if (master && !muted) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.05);
}

export function isMuted() {
  return muted;
}

// ---------------------------------------------------------------- ambient ---

/**
 * The bed: a low generator hum, a band of filtered air, and a faint mains
 * buzz. Three layers, all continuous, all modulated by silo state.
 */
function buildAmbient() {
  // ---- generator hum: two detuned saws through a low-pass ----------------
  const humFilter = ctx.createBiquadFilter();
  humFilter.type = 'lowpass';
  humFilter.frequency.value = 180;
  humFilter.Q.value = 2;
  humFilter.connect(ambientGain);

  const humGain = ctx.createGain();
  humGain.gain.value = 0.5;
  humGain.connect(humFilter);

  const hum1 = ctx.createOscillator();
  hum1.type = 'sawtooth';
  hum1.frequency.value = 47;
  const hum2 = ctx.createOscillator();
  hum2.type = 'sawtooth';
  hum2.frequency.value = 47.6; // slight beat, so it never sounds static
  hum1.connect(humGain);
  hum2.connect(humGain);
  hum1.start();
  hum2.start();

  // ---- air handling: pink-ish noise through a band-pass ------------------
  const airSource = ctx.createBufferSource();
  airSource.buffer = noiseBuffer(4);
  airSource.loop = true;
  const airFilter = ctx.createBiquadFilter();
  airFilter.type = 'bandpass';
  airFilter.frequency.value = 620;
  airFilter.Q.value = 0.8;
  const airGain = ctx.createGain();
  airGain.gain.value = 0.11;
  airSource.connect(airFilter);
  airFilter.connect(airGain);
  airGain.connect(ambientGain);
  airSource.start();

  // ---- mains buzz --------------------------------------------------------
  const buzz = ctx.createOscillator();
  buzz.type = 'sine';
  buzz.frequency.value = 100;
  const buzzGain = ctx.createGain();
  buzzGain.gain.value = 0.035;
  buzz.connect(buzzGain);
  buzzGain.connect(ambientGain);
  buzz.start();

  nodes.hum1 = hum1;
  nodes.hum2 = hum2;
  nodes.humGain = humGain;
  nodes.humFilter = humFilter;
  nodes.airGain = airGain;
  nodes.airFilter = airFilter;
  nodes.buzzGain = buzzGain;
}

/**
 * Push silo state into the ambient bed once a cycle. The soundscape is a
 * readout: a browned-out silo sags in pitch and loses its air handling, and
 * a contaminated one ticks.
 */
export function updateAmbient(state) {
  if (!started || !ctx) return;
  const t = ctx.currentTime;
  const gen = state.power?.generation || 0;
  const demand = state.power?.demand || 0;
  const load = gen > 0 ? Math.min(1.4, demand / gen) : 0;

  // Generators labour under load, and sag when they're failing.
  const humFreq = 44 + load * 7;
  nodes.hum1?.frequency.setTargetAtTime(humFreq, t, 1.5);
  nodes.hum2?.frequency.setTargetAtTime(humFreq * 1.013, t, 1.5);
  nodes.humGain?.gain.setTargetAtTime(gen > 0 ? 0.5 : 0.08, t, 1.2);
  nodes.humFilter?.frequency.setTargetAtTime(state.flags.brownout ? 90 : 180, t, 1.0);

  // Air handling follows filtration quality, so bad air is audible.
  const air = state.air?.quality ?? 100;
  nodes.airGain?.gain.setTargetAtTime(0.03 + (air / 100) * 0.1, t, 1.5);
  nodes.airFilter?.frequency.setTargetAtTime(380 + (air / 100) * 340, t, 1.5);

  // The silo's average dose drives a Geiger tick.
  let rad = 0;
  const ids = state.citizenIds;
  for (const id of ids) rad += state.citizens[id]?.radiation || 0;
  const avgRad = ids.length ? rad / ids.length : 0;
  setGeiger(avgRad);
}

// ---------------------------------------------------------------- geiger ---

let geigerTimer = null;
let geigerRate = 0;

function setGeiger(avgRad) {
  const rate = avgRad < 8 ? 0 : Math.min(9, avgRad / 9);
  if (Math.abs(rate - geigerRate) < 0.2) return;
  geigerRate = rate;
  if (geigerTimer) {
    clearInterval(geigerTimer);
    geigerTimer = null;
  }
  if (rate <= 0) return;
  geigerTimer = setInterval(() => {
    if (muted || !started) return;
    // Clicks are Poisson-ish, not metronomic — a regular tick sounds wrong.
    if (Math.random() < 0.6) click(2400 + Math.random() * 900, 0.02, 0.05);
  }, Math.max(90, 900 / rate));
}

// ------------------------------------------------------------------- sfx ---

/** A short filtered-noise transient — relays, switches, footsteps. */
function click(freq, duration = 0.03, gain = 0.12) {
  if (!started) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(0.1);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(filter);
  filter.connect(g);
  g.connect(sfxGain);
  src.start(t);
  src.stop(t + duration + 0.02);
}

/** A pitched tone with an envelope — alarms, confirmations, the radio. */
function tone(freq, duration, gain = 0.1, type = 'square', slideTo = null) {
  if (!started) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(g);
  g.connect(sfxGain);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

/** A low thud with body — construction, impacts, the airlock. */
function thud(freq = 70, duration = 0.35, gain = 0.22) {
  if (!started) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq * 2.2, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + duration);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(g);
  g.connect(sfxGain);
  osc.start(t);
  osc.stop(t + duration + 0.02);

  // A little grit on top, so it reads as metal rather than as a kick drum.
  click(300, 0.06, gain * 0.5);
}

/**
 * The sound bank. Twenty-odd cues, all synthesised, all named for what they
 * mean rather than what they sound like.
 */
export const SFX = {
  tap: () => click(1800, 0.02, 0.08),
  confirm: () => tone(660, 0.09, 0.07, 'square', 990),
  cancel: () => tone(420, 0.1, 0.06, 'square', 280),
  panel: () => click(900, 0.05, 0.07),

  build: () => thud(80, 0.4, 0.2),
  complete: () => {
    tone(523, 0.1, 0.08, 'triangle');
    setTimeout(() => tone(784, 0.16, 0.08, 'triangle'), 90);
  },
  excavate: () => {
    thud(52, 0.6, 0.22);
    setTimeout(() => click(240, 0.2, 0.1), 120);
  },
  upgrade: () => tone(440, 0.12, 0.07, 'square', 880),

  research: () => {
    tone(880, 0.08, 0.05, 'sine');
    setTimeout(() => tone(1174, 0.14, 0.06, 'sine'), 80);
  },

  alert: () => {
    tone(740, 0.16, 0.11, 'square');
    setTimeout(() => tone(740, 0.16, 0.11, 'square'), 220);
  },
  alarm: () => {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => tone(520, 0.22, 0.13, 'sawtooth', 400), i * 300);
    }
  },
  brownout: () => tone(180, 0.7, 0.12, 'sawtooth', 60),
  breach: () => {
    thud(44, 0.9, 0.28);
    setTimeout(() => tone(300, 0.5, 0.12, 'sawtooth', 90), 60);
  },

  death: () => tone(196, 0.5, 0.08, 'sine', 147),
  birth: () => {
    tone(587, 0.12, 0.06, 'triangle');
    setTimeout(() => tone(880, 0.2, 0.06, 'triangle'), 110);
  },

  airlock: () => {
    thud(60, 0.5, 0.2);
    setTimeout(() => hiss(1.1), 200);
  },
  decon: () => hiss(1.6),
  depart: () => {
    thud(70, 0.45, 0.18);
    setTimeout(() => tone(330, 0.3, 0.07, 'square', 220), 180);
  },
  ret: () => {
    tone(330, 0.14, 0.07, 'square');
    setTimeout(() => tone(494, 0.22, 0.07, 'square'), 130);
  },

  combat: () => {
    for (let i = 0; i < 5; i++) {
      setTimeout(() => click(1100 + Math.random() * 700, 0.04, 0.09), i * 70 + Math.random() * 40);
    }
  },

  radio: () => {
    hiss(0.35, 0.06);
    setTimeout(() => tone(1200, 0.05, 0.04, 'square', 900), 120);
    setTimeout(() => tone(900, 0.05, 0.04, 'square', 1300), 200);
  },
  transmit: () => tone(1400, 0.07, 0.05, 'sine', 700),

  rad: () => {
    for (let i = 0; i < 6; i++) setTimeout(() => click(2600, 0.02, 0.07), i * 55);
  },
};

function hiss(duration = 1, gain = 0.09) {
  if (!started) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(Math.max(0.5, duration));
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 1400;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(filter);
  filter.connect(g);
  g.connect(sfxGain);
  src.start(t);
  src.stop(t + duration + 0.05);
}

/** Play a named cue. Unknown names are ignored, never thrown. */
export function play(name) {
  if (!started || muted) return;
  const fn = SFX[name];
  if (fn) {
    try {
      fn();
    } catch (err) {
      /* a failed sound must never interrupt play */
    }
  }
}

// ---------------------------------------------------------------- helpers ---

let noiseCache = new Map();
function noiseBuffer(seconds) {
  const key = Math.round(seconds * 10);
  if (noiseCache.has(key)) return noiseCache.get(key);
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Slightly pink: a running average of white noise. Machinery, not static.
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  noiseCache.set(key, buf);
  return buf;
}

export default { start, play, setMuted, setVolume, updateAmbient, isReady, isMuted, SFX };
