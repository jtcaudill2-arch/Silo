/**
 * caretaker.js — what the silo does with nobody at the controls.
 *
 * A game day is twelve real minutes, so closing the app on a Friday and
 * opening it on a Sunday is sixty game days of simulation with no player in
 * it. Measured, that is fatal in a specific and unfair way: a silo whose water
 * reclaimer is standing empty makes no water, nobody re-posts anyone to it,
 * and everybody is dead of thirst inside twenty days. Three seeds, three
 * extinctions, first loss on day eighteen of the absence, cause of death
 * "dehydration" fifty times over.
 *
 * That is not the game being hard. A silo of forty-eight people does not stand
 * around dying of thirst next to a working pump because the mayor is asleep —
 * somebody notices and goes and turns it on. This module is that somebody.
 *
 * The rule it plays by is deliberately narrow: **keep people alive, decide
 * nothing.** It crews the rooms that make water, food, air and power, and it
 * does not touch anything else. It will not build, research, hire into a
 * workshop, launch an expedition, form a squad, or spend a resource. A player
 * who comes back to find their silo alive should not also find it re-planned.
 *
 * Wired into the coarse catch-up path only, so live play is unaffected: while
 * you are watching, crewing is your job.
 */

import { BAL } from '../config/balance.js';
import { employableCitizens, openSlots } from './jobs.js';

/**
 * The rooms a caretaker will crew, identified by what they produce rather than
 * by a list of type ids.
 *
 * A list would go stale the first time somebody adds a room — and the room it
 * missed would be the one nobody notices until a player loses a silo to it.
 * Asking the room definition what it makes cannot go stale, because a new
 * water source has to declare that it is one in order to work at all.
 */
function keepsPeopleAlive(def) {
  if (!def) return false;
  const out = def.produces || {};
  if (LIFE_SUPPORT.some((k) => (out[k] || 0) > 0)) return true;
  // Air is the exception: filtration declares capacity rather than a produced
  // resource, because it raises a ceiling instead of filling a store.
  return (def.provides?.airCapacity || 0) > 0;
}

const LIFE_SUPPORT = ['water', 'food', 'power'];

/**
 * One caretaker pass. Pure: returns actions, writes nothing.
 *
 * Only idle citizens are moved. Somebody already at a post stays there — a
 * caretaker that reshuffled the whole roster every day would undo the player's
 * crewing decisions while they were out, which is exactly the thing this is
 * supposed to protect them from.
 */
export function caretakerDay(state) {
  const actions = [];
  const posts = [];

  for (const slot of openSlots(state)) {
    if (!keepsPeopleAlive(slot.def)) continue;
    for (let i = 0; i < slot.free; i++) {
      posts.push({ roomId: slot.roomId, skill: slot.skill, rank: rankOf(slot.room.type) });
    }
  }
  if (!posts.length) return actions;

  // Water before food before air before power is the wrong order to hardcode,
  // so this reuses the silo's own crewing priority — the same list that
  // decides who gets staffed when the player does it by hand.
  posts.sort((a, b) => a.rank - b.rank);

  const pool = employableCitizens(state).filter((c) => !c.job);
  const taken = new Set();
  for (const post of posts) {
    let best = null;
    let bestScore = -1;
    for (const c of pool) {
      if (taken.has(c.id)) continue;
      const score = (c.skills?.[post.skill] || 0) + 1; // +1 so an unskilled body still beats nobody
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) break;
    taken.add(best.id);
    actions.push({ type: 'CITIZEN_ASSIGN', citizenId: best.id, roomId: post.roomId });
  }
  return actions;
}

function rankOf(type) {
  const i = (BAL.jobs.staffingPriority || []).indexOf(type);
  return i < 0 ? 999 : i;
}

export default { caretakerDay };
