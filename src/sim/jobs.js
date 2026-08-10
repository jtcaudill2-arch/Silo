/**
 * jobs.js — assignment, shift accounting, skill matching.
 *
 * The auto-assign here optimises purely by skill, on purpose. It ignores
 * morale, relationships and who hates whom, so a player who hand-tunes always
 * beats it by a few percent (spec §7). That gap is the reward for caring.
 */

import { BAL } from '../config/balance.js';
import { getRoom, SKILLS } from '../data/rooms.js';
import { staffSlots } from './economy.js';
import { workFactor, topSkill } from './population.js';

/** The skill a citizen's current post trains. */
export function jobSkillFor(state, citizen) {
  if (!citizen.job) return null;
  const room = state.silo.rooms[citizen.job.roomId];
  if (!room) return null;
  const def = getRoom(room.type);
  return def?.staff?.skill || null;
}

/** Every open staff slot in the silo, worst-crewed first. */
export function openSlots(state) {
  const out = [];
  for (const id of Object.keys(state.silo.rooms)) {
    const room = state.silo.rooms[id];
    const def = getRoom(room.type);
    if (!def?.staff) continue;
    const slots = staffSlots(def, room);
    const live = room.staff.filter((cid) => state.citizens[cid]?.status !== 'dead');
    const free = slots - live.length;
    if (free > 0) out.push({ roomId: id, room, def, free, skill: def.staff.skill });
  }
  return out;
}

export function employableCitizens(state) {
  return state.citizenIds
    .map((id) => state.citizens[id])
    .filter(
      (c) =>
        c &&
        c.status !== 'dead' &&
        c.status !== 'expedition' &&
        c.status !== 'imprisoned' &&
        c.status !== 'school' &&
        c.age >= BAL.citizens.workingAgeMin
    );
}

/**
 * Where a room type sits in the crewing order. Types nobody thought to list
 * fall in behind the ones that were, rather than at some invented number.
 */
function staffingRank(type) {
  const i = BAL.jobs.staffingPriority.indexOf(type);
  return i < 0 ? BAL.jobs.staffingPriority.length : i;
}

/**
 * Greedy skill-first assignment. Fills the most important *empty* posts with
 * the best-matched idle citizens. Returns actions; assigns nobody who is
 * already better placed than the candidate we'd move them for.
 *
 * Two things decide the order, and for a long time neither of them was right.
 *
 * The list was `state.silo.powerPriority` — the order rooms shut off in during
 * a brownout. Shed-order and crew-order are not the same question and the
 * conflation had a cost every time either list was touched: the Laboratory's
 * place in the power list had to be argued as a staffing decision, and the
 * answer that suited crewing was a bad answer for shedding. It reads
 * `jobs.staffingPriority` now, which answers only the second question.
 *
 * And the fill was depth-first: every post of a room before the first post of
 * the next one. A room produces the fraction of its posts that are crewed and
 * a room at zero crew produces *nothing*, so the fourth mechanic in the water
 * plant is worth a quarter of a plant and the first scientist in the
 * Laboratory is worth the entire research output of the silo. This silo runs
 * at zero spare labour from about day 30 onward, so depth-first never reached
 * the second half of the list at all. `staffingDepthPenalty` slides a room
 * down the order for each post it has already filled, so the fill spreads.
 */
export function autoAssign(state, opts = {}) {
  const actions = [];
  const slots = openSlots(state);
  if (!slots.length) return actions;

  const pool = employableCitizens(state).filter((c) => (opts.reassignAll ? true : !c.job));
  if (!pool.length) return actions;

  // One entry per empty post, scored by where its room sits in the crewing
  // order plus how deep into that room the post is.
  const posts = [];
  for (const slot of slots) {
    const rank = staffingRank(slot.room.type);
    const crewed = staffSlots(slot.def, slot.room) - slot.free;
    for (let i = 0; i < slot.free; i++) {
      posts.push({ slot, score: rank + (crewed + i) * BAL.jobs.staffingDepthPenalty });
    }
  }
  // Ties break on the room id — two identical rooms crew oldest-first — so
  // the order never depends on how the rooms happen to be keyed.
  posts.sort((a, b) => a.score - b.score || compareRoomIds(a.slot.roomId, b.slot.roomId));

  const taken = new Set();
  for (const post of posts) {
    const { skill, roomId } = post.slot;
    let best = null;
    let bestScore = -1;
    for (const c of pool) {
      if (taken.has(c.id)) continue;
      const score = workFactor(c, skill) * (c.skills[skill] || 0);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) break;
    taken.add(best.id);
    actions.push({ type: 'CITIZEN_ASSIGN', citizenId: best.id, roomId });
  }
  return actions;
}

function compareRoomIds(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Enrol eligible children; graduate them when they age out. */
export function manageSchool(state) {
  const actions = [];
  const C = BAL.citizens;
  const hasSchool = Object.values(state.silo.rooms).some(
    (r) => getRoom(r.type)?.provides.school && r.powered
  );
  for (const id of state.citizenIds) {
    const c = state.citizens[id];
    if (!c || c.status === 'dead') continue;
    if (c.status === 'school' && (c.age >= C.schoolMaxAge || !hasSchool)) {
      actions.push({ type: 'CITIZEN_STATUS', id, status: 'idle' });
    } else if (
      hasSchool &&
      c.status === 'idle' &&
      c.age >= C.schoolMinAge &&
      c.age < C.schoolMaxAge
    ) {
      actions.push({ type: 'CITIZEN_STATUS', id, status: 'school' });
    }
  }
  return actions;
}

/**
 * Per-cycle shift bookkeeping. A citizen working consecutive shifts without
 * rest racks up `shiftsWorked`; the population sim turns that into morale and
 * health damage once it passes the threshold.
 */
export function simulateCycle(state) {
  const patches = [];
  const rotating = state.research.completed.includes('shift_scheduling');
  const shift = state.clock.shift;

  for (const id of state.citizenIds) {
    const c = state.citizens[id];
    if (!c || c.status === 'dead') continue;

    if (c.status === 'working') {
      // With shift scheduling researched, a third of the crew is off at any
      // time and nobody accumulates fatigue.
      const offShift = rotating && (id + shift) % 3 === 0;
      if (offShift) {
        patches.push({ id, restShifts: c.restShifts + 1, shiftsWorked: 0 });
      } else {
        patches.push({ id, shiftsWorked: c.shiftsWorked + 1, restShifts: 0 });
      }
    } else if (c.shiftsWorked > 0) {
      const rest = c.restShifts + 1;
      patches.push({
        id,
        restShifts: rest,
        shiftsWorked: rest >= BAL.jobs.restShiftsRequired ? 0 : c.shiftsWorked,
      });
    }
  }

  return patches.length ? [{ type: 'CITIZENS_PATCH', patches, emit: false }] : [];
}

/** Idle adults generate dissent — full employment is a real pressure. */
export function idleDissent(state) {
  let idle = 0;
  for (const id of state.citizenIds) {
    const c = state.citizens[id];
    if (!c || c.status === 'dead') continue;
    if (c.status === 'idle' && c.age >= BAL.citizens.workingAgeMin) idle++;
  }
  return idle * BAL.jobs.idleDissentPerCitizenPerDay;
}

/** Employment summary for the UI. */
export function employmentSummary(state) {
  let working = 0;
  let idle = 0;
  let school = 0;
  let away = 0;
  let children = 0;
  for (const id of state.citizenIds) {
    const c = state.citizens[id];
    if (!c || c.status === 'dead') continue;
    if (c.age < BAL.citizens.workingAgeMin) children++;
    if (c.status === 'working') working++;
    else if (c.status === 'school') school++;
    else if (c.status === 'expedition') away++;
    else if (c.age >= BAL.citizens.workingAgeMin) idle++;
  }
  let openCount = 0;
  for (const s of openSlots(state)) openCount += s.free;
  return { working, idle, school, away, children, open: openCount };
}

/** Best-fit suggestion shown on the room panel. */
export function bestCandidateFor(state, roomId) {
  const room = state.silo.rooms[roomId];
  const def = getRoom(room?.type);
  if (!def?.staff) return null;
  let best = null;
  let bestScore = -1;
  for (const c of employableCitizens(state)) {
    if (c.job?.roomId === roomId) continue;
    const score = workFactor(c, def.staff.skill) * (c.skills[def.staff.skill] || 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

export { SKILLS, topSkill };
export default { autoAssign, jobSkillFor, simulateCycle, employmentSummary, openSlots };
