/**
 * store.js — one plain-object state, reducer-style dispatch, subscribe.
 *
 * Not Redux. Reducers mutate in place: this is single-player, there is no
 * time-travel debugger to feed, and structural sharing would cost more than
 * it buys. What we DO keep from the Redux shape is the discipline: nothing
 * outside a reducer is allowed to write to `state`, and every write is a
 * named action, which is what makes the offline catch-up replay trustworthy.
 *
 * Sim modules are pure `(state, ctx) -> actions[]`. The store is the only
 * thing that applies them.
 */

import { emit } from './events.js';

const reducers = new Map();

/** Register one reducer. Throws on duplicate — silent overwrites are bugs. */
export function registerReducer(type, fn) {
  if (reducers.has(type)) {
    throw new Error(`[store] duplicate reducer for action type "${type}"`);
  }
  reducers.set(type, fn);
}

/** Register a { TYPE: fn } map. */
export function registerReducers(map) {
  for (const [type, fn] of Object.entries(map)) registerReducer(type, fn);
}

export function hasReducer(type) {
  return reducers.has(type);
}

export class Store {
  constructor(initialState) {
    this.state = initialState;
    this.subscribers = new Set();
    this.dirty = false;
    this.actionCount = 0;
    this.recentActions = [];
    this.recordActions = false;
    this.silent = false; // set during catch-up: apply without notifying UI
    this.unknownActionTypes = new Set();
  }

  get() {
    return this.state;
  }

  replace(nextState) {
    this.state = nextState;
    this.dirty = true;
    this.flush();
  }

  /**
   * Apply one action. Unknown types are collected rather than thrown so a
   * partially-implemented phase can't hard-crash a running silo; the headless
   * test harness asserts the set is empty.
   */
  dispatch(action) {
    if (!action || !action.type) return;
    const fn = reducers.get(action.type);
    if (!fn) {
      if (!this.unknownActionTypes.has(action.type)) {
        this.unknownActionTypes.add(action.type);
        console.warn(`[store] no reducer for action "${action.type}"`);
      }
      return;
    }
    fn(this.state, action);
    this.actionCount++;
    this.dirty = true;
    if (this.recordActions) {
      this.recentActions.push(action);
      if (this.recentActions.length > 500) this.recentActions.shift();
    }
    if (!this.silent && action.emit !== false) {
      emit(`action:${action.type}`, action);
    }
  }

  /** Apply a list (or nested lists) of actions in order. */
  dispatchAll(actions) {
    if (!actions) return;
    for (const a of actions) {
      if (!a) continue;
      if (Array.isArray(a)) this.dispatchAll(a);
      else this.dispatch(a);
    }
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Notify subscribers once, if anything changed since the last flush. */
  flush() {
    if (!this.dirty || this.silent) return;
    this.dirty = false;
    for (const fn of Array.from(this.subscribers)) {
      try {
        fn(this.state);
      } catch (err) {
        console.error('[store] subscriber threw:', err);
      }
    }
  }

  /** Run fn with UI notifications suppressed (offline catch-up). */
  runSilent(fn) {
    const prev = this.silent;
    this.silent = true;
    try {
      return fn();
    } finally {
      this.silent = prev;
    }
  }
}

/** The live store. Created by bootstrap in main.js; null until then. */
export let store = null;

export function createStore(initialState) {
  store = new Store(initialState);
  return store;
}

export function getState() {
  return store ? store.state : null;
}

export function dispatch(action) {
  if (store) store.dispatch(action);
}

export function dispatchAll(actions) {
  if (store) store.dispatchAll(actions);
}

export default { createStore, getState, dispatch, dispatchAll, registerReducer, registerReducers, Store };
