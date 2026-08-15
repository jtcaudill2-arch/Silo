/**
 * jobs.js — assignment, shift accounting, skill matching.
 *
 * The auto-assign here optimises purely by skill, on purpose. It ignores
 * morale, relationships and who hates whom, so a player who hand-tunes always
 * beats it by a few percent (spec §7). That gap is the reward for caring.
 */

import { BAL } from '../config/balance.js';
import { getRoom, SKILLS } from '../data/rooms.js';
import { staffSlots, inService } from './economy.js';
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
    if (!def?.staff || !inService(room)) continue;
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
    post.filled = true;
  }

  // Nobody spare, and a room the silo ranks higher is still standing short.
  //
  // Until this existed the priority list only ever governed *new* hires: the
  // pool is people with no job, so once somebody is posted they stay posted
  // whatever the silo later builds. That makes build order, not priority, the
  // thing that decides crewing for ever — and it is not a corner case.
  // Measured over 300 days: the Clinic goes up on day 36 and takes the
  // medics; the Chem Lab goes up on day 54 and needs the same skill; and the
  // Chem Lab — the only room in the silo that makes meds, including the meds
  // the Clinic itself burns and the ones an expedition has to carry — ran on 24
  // of the 247 days it existed. Reordering the list did nothing, because the
  // list was never the thing that was wrong.
  // Walk every post that went unfilled, not just the first one.
  //
  // Taking only `posts.find(...)` looked equivalent and was not: the top of
  // that list is always life support, and a Water Reclaimer short of mechanics
  // can rarely be relieved by anything ranked below it. So the search gave up
  // on the highest post every time and the transfer never reached the rooms it
  // was written for — a dark Foundry with two spare engineers standing in a
  // Deep Mine two ranks down was left dark. Still one move per call; this only
  // changes which post gets it.
  for (const post of posts) {
    if (post.filled) continue;
    const move = promoteOne(state, post, actions);
    if (move.length) { actions.push(...move); break; }
  }
  return actions;
}

/**
 * Move one person up: from the least important room holding the right skill
 * into a post the silo needs more.
 *
 * Deliberately the narrowest rule that fixes the measured problem, because a
 * looser one is worse than none. The first version transferred whenever a
 * higher-ranked post outscored a lower-ranked one, which is defensible on
 * paper and churned in practice: `autoAssign` runs several times a day, the
 * silo always has some post standing open, and so people were shuffled
 * continuously and no room ever settled. It moved the Surface panel — the
 * hinge of the early game — from day 50 to day 67.
 *
 * So: only to light a room that is completely dark, and never by taking the
 * last person out of another. A room producing nothing at all is the only
 * case where moving somebody is unambiguously worth more than leaving them,
 * and refusing to empty the source means a transfer can never create the
 * problem it is trying to solve.
 */
function promoteOne(state, post, pending) {
  const { skill } = post.slot;
  const moving = new Set(pending.map((a) => a.citizenId));

  // Only ever to a room standing completely idle.
  const target = state.silo.rooms[post.slot.roomId];
  const live = (room) => room.staff.filter((cid) => {
    const c = state.citizens[cid];
    return c && c.status !== 'dead' && !moving.has(cid);
  });
  if (!target || live(target).length > 0) return [];

  let bestCitizen = null;
  let bestScore = staffingRank(target.type);

  for (const id of Object.keys(state.silo.rooms)) {
    const room = state.silo.rooms[id];
    if (room.id === post.slot.roomId) continue;
    const def = getRoom(room.type);
    // Any skill, not only a matching one.
    //
    // Requiring the donor to use the same skill as the dark room is what left
    // the failure that kills silos. Measured on seed 0xfeed: by day 200 the top
    // four ranks — the water plant, the bays and the generator halls — held all
    // 25 working adults between them, and all three Recycling Plants stood at 0
    // of 8. Recycling is the only source of fuel above the Deeps, and
    // economy.js scales a room's output by its worst-supplied input, so four
    // generator halls at 9 of 14 crew made 27 power against 79 of demand. The
    // silo shed rooms from the bottom of the power list, the hydroponics went
    // dark, and seventy-seven people starved on day 274 with three thousand
    // food in the tanks the day the lights went out.
    //
    // Nothing could relieve it. The plants want engineers, every engineering
    // room in the silo was already dark, and the only crewed room ranked below
    // recycling was the Chem Lab — two medics this rule was not allowed to
    // touch. A medic running a salvage press is worth a fraction of an
    // engineer; a salvage press with nobody in it is worth nothing at all, and
    // `workFactor` already prices the difference.
    if (!def?.staff) continue;
    if (!inService(room)) continue;
    const crew = live(room);
    // Never strip the source: it would just move the dark room somewhere else.
    if (crew.length < 2) continue;
    const score = staffingRank(room.type);
    if (score <= bestScore) continue;
    // Of that room's crew, give up whoever is worst at the job.
    let worst = null;
    let worstScore = Infinity;
    for (const cid of crew) {
      const c = state.citizens[cid];
      const s = workFactor(c, skill) * (c.skills[skill] || 0);
      if (s < worstScore) { worstScore = s; worst = c; }
    }
    if (worst) { bestScore = score; bestCitizen = worst; }
  }

  if (!bestCitizen) return [];
  return [{ type: 'CITIZEN_ASSIGN', citizenId: bestCitizen.id, roomId: post.slot.roomId }];
}

/**
 * Would pressing auto-assign change anything?
 *
 * Asked by the standing order that tells a player to press it, which used to
 * fire only when somebody was unassigned — exactly backwards for the failure
 * above, since a silo whose crew has drifted has nobody spare by definition.
 * The one order naming the one button that fixes it went quiet at the moment it
 * decided the campaign.
 *
 * It runs the real thing rather than a copy of its reasoning, so the order and
 * the button can never disagree about whether there is anything to do.
 */
export function reassignmentAvailable(state) {
  return autoAssign(state).length > 0;
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
      // A graduation is worth a line, and only when it *is* one.
      //
      // This branch also fires when the Schoolhouse stops — a brownout, a
      // collapse, somebody stripping it out — and a child pulled out of class
      // by a power cut has not finished anything. Age is what tells the two
      // apart.
      //
      // `kind: 'good'` on purpose: catchup.js buckets that under "Finished
      // while you were out", so a player coming back after a weekend reads who
      // came out of school alongside the research that landed. Twelve years of
      // a 2.2x multiplier is the best return in the game and it was the one
      // thing the silo never mentioned.
      if (c.age >= C.schoolMaxAge) {
        const top = topSkill(c);
        actions.push({
          type: 'LOG',
          entry: {
            kind: 'good',
            text:
              `${c.firstName} ${c.lastName} finished school at ${Math.floor(c.age)}. ` +
              `Best subject ${top.skill} at ${Math.round(top.value)}.`,
            data: { citizenId: id, skill: top.skill, value: Math.round(top.value), graduated: true },
          },
        });
      }
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
