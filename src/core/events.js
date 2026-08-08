/**
 * events.js — tiny pub/sub used to decouple sim from UI.
 *
 * The sim never touches the DOM. It emits; the UI listens. Channel names are
 * plain strings; '*' receives everything (used by the debug overlay).
 */

const listeners = new Map();

export function on(channel, fn) {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel).add(fn);
  return () => off(channel, fn);
}

export function once(channel, fn) {
  const unsub = on(channel, (...args) => {
    unsub();
    fn(...args);
  });
  return unsub;
}

export function off(channel, fn) {
  const set = listeners.get(channel);
  if (set) set.delete(fn);
}

export function emit(channel, payload) {
  const set = listeners.get(channel);
  if (set) {
    for (const fn of Array.from(set)) {
      try {
        fn(payload, channel);
      } catch (err) {
        console.error(`[events] listener for "${channel}" threw:`, err);
      }
    }
  }
  const wild = listeners.get('*');
  if (wild) {
    for (const fn of Array.from(wild)) {
      try {
        fn(payload, channel);
      } catch (err) {
        console.error('[events] wildcard listener threw:', err);
      }
    }
  }
}

export function clearAll() {
  listeners.clear();
}

export default { on, once, off, emit, clearAll };
