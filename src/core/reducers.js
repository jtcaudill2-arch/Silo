/**
 * reducers.js — the only code allowed to write to `state`.
 *
 * Sim modules are pure and emit actions; these apply them. Two invariants are
 * enforced here rather than by convention, because convention wouldn't hold:
 *
 *   - A citizen cannot die silently. CITIZEN_DIE writes the log entry itself,
 *     with the name and the cause, so no caller can forget (spec §18).
 *   - Resources are clamped to caps on every write, so nothing else has to
 *     remember to.
 */

import { BAL } from '../config/balance.js';
import { registerReducers } from './store.js';
import { fullName } from '../sim/population.js';
import { getRoom } from '../data/rooms.js';
import { emit } from './events.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Push a log entry, trimming the tail. Used by several reducers. */
export function pushLog(state, entry) {
  const e = {
    day: entry.day ?? state.clock.day,
    cycle: entry.cycle ?? state.clock.cycle,
    kind: entry.kind || 'plain',
    text: entry.text,
    data: entry.data,
  };
  state.log.push(e);
  if (state.log.length > BAL.meta.logMaxEntries) {
    state.log.splice(0, state.log.length - BAL.meta.logMaxEntries);
  }
  return e;
}

// ---------------------------------------------------------------- clock ---

const clockReducers = {
  CLOCK_SET(state, a) {
    Object.assign(state.clock, a.clock);
  },
  PLAYED_MS(state, a) {
    state.meta.playedMs += a.ms;
  },
};

// ------------------------------------------------------------ resources ---

const resourceReducers = {
  RESOURCE_DELTA(state, a) {
    if (a.caps) state.caps = a.caps;
    const caps = state.caps || BAL.resources.baseCaps;
    for (const [k, v] of Object.entries(a.deltas || {})) {
      if (!Number.isFinite(v)) continue;
      const cap = caps[k] ?? Infinity;
      state.resources[k] = clamp((state.resources[k] || 0) + v, 0, cap);
    }
  },

  /** Direct set, used by trade, loot and the debug console. */
  RESOURCE_SET(state, a) {
    const caps = state.caps || BAL.resources.baseCaps;
    for (const [k, v] of Object.entries(a.values || {})) {
      state.resources[k] = clamp(v, 0, caps[k] ?? Infinity);
    }
  },

  FLOWS_SET(state, a) {
    state.flows = a.flows;
  },

  POWER_STATE(state, a) {
    for (const [id, on] of Object.entries(a.powered)) {
      const room = state.silo.rooms[id];
      if (room) room.powered = on;
    }
    const was = state.flags.brownout;
    state.flags.brownout = a.brownout;
    state.power = { generation: a.generation, demand: a.demand };
    if (a.brownout && !was) {
      pushLog(state, {
        kind: 'alert',
        text: 'Power demand exceeded generation. Rooms are browning out from the bottom of the priority list.',
      });
      emit('alert', { kind: 'warn', glyph: '⚡', text: 'Brownout — check power priority' });
    }
  },

  AIR_DELTA(state, a) {
    state.air.quality = clamp(state.air.quality + a.delta, BAL.air.min, BAL.air.max);
    state.air.capacity = a.capacity;
    state.air.load = a.load;
  },

  SET_POWER_PRIORITY(state, a) {
    state.silo.powerPriority = a.order.filter((id) => state.silo.rooms[id]);
  },
};

// ----------------------------------------------------------------- silo ---

const siloReducers = {
  CONDITION_DELTA(state, a) {
    for (const w of a.wear) {
      const room = state.silo.rooms[w.id];
      if (!room) continue;
      const before = room.condition;
      room.condition = clamp(room.condition + w.delta, 0, BAL.silo.condition.start);
      if (before >= BAL.silo.condition.penaltyBelow && room.condition < BAL.silo.condition.penaltyBelow) {
        const def = getRoom(room.type);
        pushLog(state, {
          kind: 'alert',
          text: `${def?.name || room.type} on floor ${room.floor} has dropped below safe condition. Output is falling.`,
        });
      }
    }
  },

  ROOM_ADD(state, a) {
    state.silo.rooms[a.room.id] = a.room;
    const floor = state.silo.floors[a.room.floor - 1];
    for (let i = 0; i < a.room.width; i++) floor.slots[a.room.slot + i] = a.room.id;
    if (!state.silo.powerPriority.includes(a.room.id)) state.silo.powerPriority.push(a.room.id);
  },

  ROOM_REMOVE(state, a) {
    const room = state.silo.rooms[a.id];
    if (!room) return;
    const floor = state.silo.floors[room.floor - 1];
    for (let i = 0; i < room.width; i++) {
      if (floor.slots[room.slot + i] === room.id) floor.slots[room.slot + i] = null;
    }
    for (const cid of room.staff) {
      const c = state.citizens[cid];
      if (c) {
        c.job = null;
        c.status = 'idle';
      }
    }
    delete state.silo.rooms[a.id];
    state.silo.powerPriority = state.silo.powerPriority.filter((x) => x !== a.id);
  },

  ROOM_PATCH(state, a) {
    const room = state.silo.rooms[a.id];
    if (room) Object.assign(room, a.patch);
  },

  FLOOR_PATCH(state, a) {
    const floor = state.silo.floors[a.n - 1];
    if (floor) Object.assign(floor, a.patch);
  },

  NEXT_ROOM_ID(state, a) {
    state.silo.nextRoomId = a.value;
  },

  /** Build assigns the id here, so sim code never invents one. */
  ROOM_BUILD(state, a) {
    const id = String(state.silo.nextRoomId++);
    const room = { ...a.room, id };
    state.silo.rooms[id] = room;
    const floor = state.silo.floors[room.floor - 1];
    for (let i = 0; i < room.width; i++) floor.slots[room.slot + i] = id;
    insertByDefaultPriority(state, room);
  },

  /**
   * Absorb an adjacent bay into an existing room. The merged unit keeps the
   * original room's crew and condition — you extended it, you didn't rebuild
   * it — but the new bay comes online on its own construction schedule.
   */
  ROOM_MERGE(state, a) {
    const room = state.silo.rooms[a.id];
    if (!room) return;
    const floor = state.silo.floors[room.floor - 1];
    room.slot = a.slot;
    room.width = a.width;
    floor.slots[a.claimSlot] = room.id;
    for (let i = 0; i < room.width; i++) floor.slots[room.slot + i] = room.id;
    // A wider room wears proportionally; averaging keeps the new bay from
    // arriving pre-damaged.
    room.condition = Math.min(
      BAL.silo.condition.start,
      (room.condition * (room.width - 1) + BAL.silo.condition.start) / room.width
    );
    room.buildingUntilCycle = 0;
  },

  EXCAVATION_START(state, a) {
    state.silo.excavating = { floor: a.floor, untilCycle: a.untilCycle };
  },

  EXCAVATION_COMPLETE(state, a) {
    const floor = state.silo.floors[a.floor - 1];
    if (floor) {
      floor.excavated = true;
      // A floor opens shored. Above the line it never needed it; below the
      // line `excavationCost` charged alloy for it and would not let the dig
      // start without it. This used to read `floor.n < shoringRequiredBelow`,
      // which marked every deep floor unshored the moment it was paid for —
      // the player bought shoring on all 110 of them and got none of it.
      floor.shored = a.shored ?? true;
      floor.integrity = 100;
    }
    state.silo.excavating = null;

    // What the crew found, rolled in sim/dig.js and passed in so this stays
    // pure. Absent for an old save mid-dig, which opens onto bare rock as it
    // always did.
    const o = a.outcome;
    if (o?.resources) {
      for (const [k, v] of Object.entries(o.resources)) {
        const cap = state.caps?.[k] ?? Infinity;
        state.resources[k] = Math.min(cap, (state.resources[k] || 0) + v);
      }
    }
    if (o?.artifact) {
      state.research.artifacts[o.artifact] = (state.research.artifacts[o.artifact] || 0) + 1;
    }
    if (o?.air) {
      state.air.quality = Math.max(BAL.air.min, Math.min(BAL.air.max, state.air.quality + o.air));
    }
    // A level that was built for something arrives with the room still in it,
    // seized. Placed here rather than through placeRoom() so the reducer keeps
    // no import on newgame.js — the floor is empty by definition, having just
    // been opened, so there is nothing to collide with.
    if (o?.found && floor) {
      const width = Math.min(o.found.width, BAL.silo.slotsPerFloor);
      const id = String(state.silo.nextRoomId++);
      state.silo.rooms[id] = {
        id,
        type: o.found.type,
        floor: a.floor,
        slot: 0,
        width,
        level: o.found.level,
        condition: o.found.condition,
        staff: [],
        // Dark, and it stays dark until restored. This is not decoration: the
        // economy skips seized rooms, so nothing ever recomputes this field
        // for them, and a `true` here is a lie that never gets corrected.
        // Three separate systems ask `room.powered` directly — schooling,
        // airlock capacity, and whether the silo can craft a suit — so a
        // found Armory on floor 96 was fitting out squads with no crew, no
        // power and no repairs.
        powered: false,
        // Never commissioned. This is what separates a room that arrived
        // seized from one that decayed to the same number while the silo
        // leaned on it — the first is an opportunity, the second is an
        // emergency, and the standing orders rank them nothing alike.
        found: true,
        buildingUntilCycle: 0,
        upgradingUntilCycle: 0,
      };
      for (let i = 0; i < width; i++) floor.slots[i] = id;
      // Same as ROOM_BUILD does. Without it a found room is never in
      // `powerPriority` at all, and `orderedRoomIds` appends unlisted rooms
      // after every listed one — so a restored Recycling Plant, whose default
      // rank is sixth, browns out before the residences.
      insertByDefaultPriority(state, state.silo.rooms[id]);
    }
    if (o?.condition) {
      // The floor above is the one a seal gives way into. Worst-conditioned
      // room there, so a collapse compounds a problem rather than spreading a
      // scratch across a healthy silo.
      const above = state.silo.floors[a.floor - 2];
      const ids = [...new Set((above?.slots || []).filter((x) => x != null))];
      const room = ids
        .map((id) => state.silo.rooms[id])
        .filter(Boolean)
        .sort((x, y) => x.condition - y.condition)[0];
      if (room) room.condition = Math.max(0, room.condition + o.condition);
    }
    pushLog(state, {
      kind: o?.kind || 'alert',
      text: o?.text || `Floor ${a.floor} is open. Six bays of bare rock and a lighting circuit.`,
      data: { floor: a.floor },
    });
    emit('alert', { kind: 'good', glyph: '⌗', text: `Floor ${a.floor} excavated`, floor: a.floor });
  },
};

/** Default power rank for a newly built room. */
function insertByDefaultPriority(state, room) {
  const list = state.silo.powerPriority;
  const rank = (t) => {
    const i = BAL.power.defaultPriority.indexOf(t);
    return i < 0 ? 999 : i;
  };
  const mine = rank(room.type);
  let at = list.length;
  for (let i = 0; i < list.length; i++) {
    const other = state.silo.rooms[list[i]];
    if (other && rank(other.type) > mine) {
      at = i;
      break;
    }
  }
  list.splice(at, 0, room.id);
}

// ------------------------------------------------------------- citizens ---

const citizenReducers = {
  CITIZENS_PATCH(state, a) {
    for (const p of a.patches) {
      const c = state.citizens[p.id];
      if (!c) continue;
      for (const [k, v] of Object.entries(p)) {
        if (k === 'id') continue;
        c[k] = v;
      }
    }
  },

  CITIZEN_ADD(state, a) {
    const c = a.citizen;
    state.citizens[c.id] = c;
    state.citizenIds.push(c.id);
    state.stats.births++;
    state.stats.peakPopulation = Math.max(state.stats.peakPopulation, state.citizenIds.length);
  },

  /**
   * How a citizen dies. Writes the log entry itself so a death can never go
   * unrecorded, applies the grief hit to everyone who cared, and frees
   * whatever they were holding. `CITIZEN_EXILE` below is the one other way a
   * name leaves the roster, and it deliberately does not come through here:
   * exile is a verdict, not a death, and it writes its own log line.
   */
  CITIZEN_DIE(state, a) {
    const c = state.citizens[a.id];
    if (!c || c.status === 'dead') return;

    c.status = 'dead';
    c.causeOfDeath = a.cause;
    c.deathDay = a.day ?? state.clock.day;
    c.history.push({ day: c.deathDay, text: `Died: ${a.cause}.` });

    // Free the job slot.
    if (c.job) {
      const room = state.silo.rooms[c.job.roomId];
      if (room) room.staff = room.staff.filter((x) => x !== c.id);
      c.job = null;
    }
    // Free the squad slot.
    if (c.squadId != null) {
      const sq = state.military.squads[c.squadId];
      if (sq) {
        sq.members = sq.members.filter((x) => x !== c.id);
        if (sq.leaderId === c.id) sq.leaderId = sq.members[0] ?? null;
      }
      c.squadId = null;
    }

    state.citizenIds = state.citizenIds.filter((x) => x !== c.id);
    state.stats.deaths++;
    state.stats.causes[a.cause] = (state.stats.causes[a.cause] || 0) + 1;

    // Grief. Everyone who was close to them takes it.
    const R = BAL.citizens.relationships;
    const M = BAL.citizens.morale;
    for (const [otherId, val] of Object.entries(c.relationships || {})) {
      const other = state.citizens[otherId];
      if (!other || other.status === 'dead') continue;
      if (val >= R.friendThreshold) {
        other.morale = clamp(other.morale + M.friendDeathHit, M.min, M.max);
        if (!other.traits.includes('bereaved')) other.traits = [...other.traits, 'bereaved'];
        other.history.push({ day: c.deathDay, text: `Lost ${fullName(c)}.` });
      } else if (val > 0) {
        other.morale = clamp(other.morale + M.acquaintanceDeathHit, M.min, M.max);
      }
      delete other.relationships[c.id];
    }

    pushLog(state, {
      kind: a.kind || 'death',
      day: c.deathDay,
      text: a.text || `${fullName(c)}, ${Math.floor(c.age)}, died of ${a.cause}.`,
      data: { citizenId: c.id, cause: a.cause },
    });
    emit('death', { citizen: c, cause: a.cause });
  },

  RELATIONSHIP_DELTA(state, a) {
    const R = BAL.citizens.relationships;
    for (const [aId, bId, delta] of a.edges) {
      const ca = state.citizens[aId];
      const cb = state.citizens[bId];
      if (!ca || !cb || ca.status === 'dead' || cb.status === 'dead') continue;
      const cur = ca.relationships[bId] || 0;
      const next = clamp(cur + delta, R.min, R.max);
      ca.relationships[bId] = next;
      cb.relationships[aId] = next;
    }
    // Everything drifts back toward indifference a little each day, and an
    // edge that has arrived at indifference is deleted rather than stored as
    // a zero. Two people who once passed each other in a corridor and now
    // feel nothing are not a fact worth persisting: at five hundred
    // residents the roster was carrying twelve thousand edges, a good share
    // of them exactly zero, into every autosave and every birth scan.
    if (a.decay) {
      for (const id of state.citizenIds) {
        const c = state.citizens[id];
        if (!c) continue;
        for (const k of Object.keys(c.relationships)) {
          const v = c.relationships[k];
          if (v > 0) c.relationships[k] = Math.max(0, v - a.decay);
          else if (v < 0) c.relationships[k] = Math.min(0, v + a.decay);
          if (c.relationships[k] === 0) delete c.relationships[k];
        }
      }
    }
  },

  CITIZEN_ASSIGN(state, a) {
    const c = state.citizens[a.citizenId];
    if (!c || c.status === 'dead') return;
    // Leave the old post first.
    if (c.job) {
      const old = state.silo.rooms[c.job.roomId];
      if (old) old.staff = old.staff.filter((x) => x !== c.id);
    }
    if (a.roomId == null) {
      c.job = null;
      c.status = a.status || 'idle';
      return;
    }
    const room = state.silo.rooms[a.roomId];
    if (!room) return;
    if (!room.staff.includes(c.id)) room.staff.push(c.id);
    c.job = { roomId: a.roomId };
    c.status = 'working';
  },

  CITIZEN_STATUS(state, a) {
    const c = state.citizens[a.id];
    if (c && c.status !== 'dead') c.status = a.status;
  },

  CITIZEN_HISTORY(state, a) {
    const c = state.citizens[a.id];
    if (!c) return;
    c.history.push({ day: a.day ?? state.clock.day, text: a.text });
    if (c.history.length > 40) c.history.shift();
  },

  CITIZEN_TRAIT(state, a) {
    const c = state.citizens[a.id];
    if (!c) return;
    if (a.remove) c.traits = c.traits.filter((t) => t !== a.trait);
    else if (!c.traits.includes(a.trait)) c.traits = [...c.traits, a.trait];
  },
};

// ---------------------------------------------------------------- order ---

const orderReducers = {
  ORDER_DELTA(state, a) {
    state.order.value = clamp(state.order.value + a.amount, BAL.order.min, BAL.order.max);
    if (a.log) pushLog(state, { kind: 'alert', text: a.log });
  },
  ORDER_SET(state, a) {
    state.order.value = clamp(a.value, BAL.order.min, BAL.order.max);
  },
  ORDER_STREAK(state, a) {
    state.order.daysBelowThreshold = a.days;
  },
  DISSENT_SET(state, a) {
    state.order.dissentPressure = a.value;
  },

  MORALE_ALL(state, a) {
    for (const id of state.citizenIds) {
      const c = state.citizens[id];
      if (!c || c.status === 'dead') continue;
      c.morale = clamp(c.morale + a.amount, BAL.citizens.morale.min, BAL.citizens.morale.max);
    }
  },

  CRIME_ADD(state, a) {
    state.order.crimes.unshift({ ...a.crime, day: a.crime.day ?? state.clock.day });
    if (state.order.crimes.length > 30) state.order.crimes.pop();
    pushLog(state, { kind: 'alert', text: a.crime.text });
  },

  INVESTIGATION_OPEN(state, a) {
    state.order.investigations.unshift(a.investigation);
    if (state.order.investigations.length > 10) state.order.investigations.pop();
    pushLog(state, {
      kind: 'alert',
      text: "The Sheriff's office has opened an investigation. Three names are on the list.",
    });
    emit('alert', { kind: 'warn', glyph: '§', text: 'Investigation opened' });
  },

  INVESTIGATION_PATCH(state, a) {
    const inv = state.order.investigations.find((i) => i.id === a.id);
    if (inv) Object.assign(inv, a.patch);
  },

  /**
   * Exile removes somebody without killing them. They are still a person and
   * they still leave a hole — the grief hit applies exactly as a death does.
   */
  CITIZEN_EXILE(state, a) {
    const c = state.citizens[a.id];
    if (!c || c.status === 'dead') return;
    c.status = 'dead'; // gone from the silo's point of view
    c.causeOfDeath = 'exiled';
    c.deathDay = state.clock.day;
    c.history.push({ day: state.clock.day, text: 'Exiled from Silo 12.' });
    if (c.job) {
      const room = state.silo.rooms[c.job.roomId];
      if (room) room.staff = room.staff.filter((x) => x !== c.id);
      c.job = null;
    }
    state.citizenIds = state.citizenIds.filter((x) => x !== c.id);
    state.stats.causes.exiled = (state.stats.causes.exiled || 0) + 1;
    for (const [otherId, val] of Object.entries(c.relationships || {})) {
      const other = state.citizens[otherId];
      if (!other || other.status === 'dead') continue;
      if (val >= BAL.citizens.relationships.friendThreshold) {
        other.morale = clamp(other.morale + BAL.citizens.morale.friendDeathHit, 0, 100);
      }
    }
    pushLog(state, { kind: 'death', text: a.text, data: { citizenId: c.id, cause: 'exiled' } });
  },

  POLICY_TOGGLE(state, a) {
    const cur = state.order.policies;
    if (cur.includes(a.id)) state.order.policies = cur.filter((p) => p !== a.id);
    else state.order.policies = [...cur, a.id];
  },
};

// ------------------------------------------------------------- research ---

const researchReducers = {
  RESEARCH_POINTS(state, a) {
    state.research.points += a.amount;
  },
  RESEARCH_SPEND(state, a) {
    state.research.points = Math.max(0, state.research.points - a.amount);
    if (state.research.active) {
      state.research.active.progress = a.progress;
      state.research.active.cycles = a.cycles;
    }
  },
  RESEARCH_SET_ACTIVE(state, a) {
    state.research.active = a.active;
  },
  RESEARCH_COMPLETE(state, a) {
    if (!state.research.completed.includes(a.id)) state.research.completed.push(a.id);
    state.research.active = null;
  },
  RESEARCH_QUEUE(state, a) {
    state.research.queue = a.queue;
  },
  RESEARCH_BONUS(state, a) {
    state.research.bonus = a.value;
  },
  ARTIFACT_ADD(state, a) {
    // Negative counts are how research consumes them; never go below zero.
    const next = (state.research.artifacts[a.id] || 0) + (a.count ?? 1);
    state.research.artifacts[a.id] = Math.max(0, next);
  },
};

// ------------------------------------------------------------------ log ---

const logReducers = {
  LOG(state, a) {
    pushLog(state, a.entry);
  },
  LOG_MANY(state, a) {
    for (const e of a.entries) pushLog(state, e);
  },
  STAT_BUMP(state, a) {
    for (const [k, v] of Object.entries(a.stats)) {
      state.stats[k] = (state.stats[k] || 0) + v;
    }
  },
  FLAG_SET(state, a) {
    for (const [k, v] of Object.entries(a.flags)) state.flags[k] = v;
  },
  SETTING_SET(state, a) {
    Object.assign(state.settings, a.settings);
  },
  UI_SET(state, a) {
    Object.assign(state.ui, a.ui);
  },
  CRISIS_ALERT(state, a) {
    emit('alert', { kind: 'warn', glyph: '!', text: a.name });
    // A scripted crisis is a beat, not a notification. The rail chip stays
    // for the record, but the shell also stops the clock and puts the prose
    // on the screen — these fire five times in a campaign and the player
    // should not be able to scroll past one.
    emit('crisis', { id: a.id, name: a.name });
  },

  GAME_OVER(state, a) {
    state.meta.gameOver = a.reason;
    state.meta.ending = a.ending || null;
    pushLog(state, { kind: 'alert', text: a.text || a.reason });
    emit('game-over', { reason: a.reason, ending: a.ending || null });
  },
};

// ------------------------------------------------------------- military ---

const militaryReducers = {
  GEAR_CRAFT(state, a) {
    const id = String(state.military.nextGearId++);
    state.military.gear[id] = {
      id,
      item: a.item,
      durability: BAL.gear.durabilityMax,
      integrity: BAL.gear.suit.integrityMax,
      assignedTo: null,
    };
  },

  GEAR_ASSIGN(state, a) {
    const gear = state.military.gear[a.gearId];
    const c = state.citizens[a.citizenId];
    if (!gear || !c) return;
    c.gear ??= { weapon: null, armor: null, suit: null };
    // Free whatever they were holding in that slot first.
    const prev = c.gear[a.slot];
    if (prev && state.military.gear[prev]) state.military.gear[prev].assignedTo = null;
    // And take it off whoever had this piece.
    if (gear.assignedTo) {
      const other = state.citizens[gear.assignedTo];
      if (other?.gear) {
        for (const slot of ['weapon', 'armor', 'suit']) {
          if (other.gear[slot] === gear.id) other.gear[slot] = null;
        }
      }
    }
    gear.assignedTo = c.id;
    c.gear[a.slot] = gear.id;
  },

  GEAR_UNASSIGN(state, a) {
    const gear = state.military.gear[a.gearId];
    if (!gear) return;
    const c = gear.assignedTo != null ? state.citizens[gear.assignedTo] : null;
    if (c?.gear) {
      for (const slot of ['weapon', 'armor', 'suit']) {
        if (c.gear[slot] === gear.id) c.gear[slot] = null;
      }
    }
    gear.assignedTo = null;
  },

  GEAR_REPAIR(state, a) {
    for (const r of a.repairs) {
      const g = state.military.gear[r.id];
      if (!g) continue;
      g.durability = Math.min(BAL.gear.durabilityMax, g.durability + r.amount);
      g.integrity = Math.min(BAL.gear.suit.integrityMax, g.integrity + r.amount);
    }
  },

  GEAR_WEAR(state, a) {
    for (const w of a.wear) {
      const g = state.military.gear[w.id];
      if (!g) continue;
      if (w.durability) g.durability = clamp(g.durability - w.durability, 0, BAL.gear.durabilityMax);
      if (w.integrity) g.integrity = clamp(g.integrity - w.integrity, 0, BAL.gear.suit.integrityMax);
    }
  },

  GEAR_DESTROY(state, a) {
    const g = state.military.gear[a.id];
    if (!g) return;
    const c = g.assignedTo != null ? state.citizens[g.assignedTo] : null;
    if (c?.gear) {
      for (const slot of ['weapon', 'armor', 'suit']) {
        if (c.gear[slot] === a.id) c.gear[slot] = null;
      }
    }
    delete state.military.gear[a.id];
  },

  SQUAD_CREATE(state, a) {
    const id = String(state.military.nextSquadId++);
    state.military.squads[id] = {
      id,
      name: a.name,
      members: [],
      leaderId: null,
      assignment: 'garrison',
      deployed: false,
    };
    state.military.squadIds.push(id);
  },

  SQUAD_DISBAND(state, a) {
    const sq = state.military.squads[a.id];
    if (!sq) return;
    for (const cid of sq.members) {
      const c = state.citizens[cid];
      if (c) {
        c.squadId = null;
        if (c.status === 'training') c.status = 'idle';
      }
    }
    delete state.military.squads[a.id];
    state.military.squadIds = state.military.squadIds.filter((x) => x !== a.id);
  },

  SQUAD_PATCH(state, a) {
    const sq = state.military.squads[a.id];
    if (sq) Object.assign(sq, a.patch);
  },

  SQUAD_MEMBER(state, a) {
    const sq = state.military.squads[a.squadId];
    const c = state.citizens[a.citizenId];
    if (!sq || !c) return;
    if (a.remove) {
      sq.members = sq.members.filter((x) => x !== c.id);
      if (sq.leaderId === c.id) sq.leaderId = sq.members[0] ?? null;
      c.squadId = null;
      if (c.status === 'training') c.status = 'idle';
      return;
    }
    if (sq.members.length >= BAL.military.squadMax) return;
    // A soldier leaves whatever post they were on.
    if (c.job) {
      const room = state.silo.rooms[c.job.roomId];
      if (room) room.staff = room.staff.filter((x) => x !== c.id);
      c.job = null;
    }
    if (c.squadId != null) {
      const old = state.military.squads[c.squadId];
      if (old) old.members = old.members.filter((x) => x !== c.id);
    }
    if (!sq.members.includes(c.id)) sq.members.push(c.id);
    if (sq.leaderId == null) sq.leaderId = c.id;
    c.squadId = sq.id;
    c.status = 'training';
  },
};

// ----------------------------------------------------------- expeditions ---

const expeditionReducers = {
  EXPEDITION_LAUNCH(state, a) {
    state.expeditions.active.push(a.expedition);
    state.expeditions.nextId++;
  },

  /**
   * Bring an expedition home. Loot, radiation, recruits and the journal all
   * land here so the return is one atomic event in the log — which is what
   * lets the catch-up report show it as a single readable entry.
   */
  EXPEDITION_RESOLVE(state, a) {
    const idx = state.expeditions.active.findIndex((e) => e.id === a.id);
    if (idx < 0) return;
    const exp = state.expeditions.active[idx];
    exp.resolved = true;
    exp.journal = a.journal || [];
    exp.survivors = a.survivors || [];
    exp.casualties = a.casualties || [];

    state.expeditions.active.splice(idx, 1);
    state.expeditions.history.unshift(exp);
    if (state.expeditions.history.length > 30) state.expeditions.history.pop();

    const sq = state.military.squads[exp.squadId];
    if (sq) {
      sq.deployed = false;
      sq.assignment = 'garrison';
    }

    const caps = state.caps || BAL.resources.baseCaps;
    for (const [k, v] of Object.entries(a.loot || {})) {
      state.resources[k] = clamp((state.resources[k] || 0) + v, 0, caps[k] ?? Infinity);
    }
    for (const [k, v] of Object.entries(a.artifacts || {})) {
      state.research.artifacts[k] = (state.research.artifacts[k] || 0) + v;
    }

    // Survivors come back irradiated and exhausted. Decontamination happens
    // separately — skipping it is a real choice, so it isn't automatic.
    for (const id of a.survivors || []) {
      const c = state.citizens[id];
      if (!c || c.status === 'dead') continue;
      c.status = 'idle';
      c.radiation = clamp(c.radiation + (a.radiation || 0), 0, BAL.citizens.radiation.max);
      c.history.push({ day: state.clock.day, text: `Came back from the ${exp.band} run.` });
      if (!c.traits.includes('veteran') && (state.stats.expeditionsReturned || 0) > 0) {
        c.traits = [...c.traits, 'veteran'];
      }
      // Suits wear from the time outside.
      const gid = c.gear?.suit;
      if (gid && state.military.gear[gid]) {
        state.military.gear[gid].integrity = clamp(a.suitIntegrity ?? 100, 0, BAL.gear.suit.integrityMax);
      }
    }

    for (const recruit of a.recruits || []) {
      state.citizens[recruit.id] = recruit;
      state.citizenIds.push(recruit.id);
      state.stats.peakPopulation = Math.max(state.stats.peakPopulation, state.citizenIds.length);
    }

    state.stats.expeditionsReturned = (state.stats.expeditionsReturned || 0) + 1;
    state.pendingDecon = {
      squadId: exp.squadId,
      members: a.survivors || [],
      radiation: a.radiation || 0,
    };

    const name = sq?.name || 'The squad';
    const lost = (a.casualties || []).length;
    pushLog(state, {
      kind: 'expedition',
      text:
        lost === 0
          ? `${name} is back through the airlock. All ${(a.survivors || []).length} of them, carrying a dose of ${Math.round(a.radiation || 0)}.`
          : `${name} is back. ${lost} did not return.`,
      data: { expeditionId: exp.id },
    });
    emit('expedition-return', { expedition: exp, report: a });
  },

  DECON(state, a) {
    const D = BAL.expedition.decon;
    const caps = state.caps || BAL.resources.baseCaps;
    if (a.skip) {
      // Skipping decon pushes the squad's dose into the silo at large.
      const spread = (a.radiation || 0) * D.skipRadSpreadFraction;
      for (const id of state.citizenIds) {
        const c = state.citizens[id];
        if (!c || c.status === 'dead') continue;
        c.radiation = clamp(c.radiation + spread / 12, 0, BAL.citizens.radiation.max);
      }
      state.order.value = clamp(state.order.value + D.skipOrderPenalty, BAL.order.min, BAL.order.max);
      pushLog(state, {
        kind: 'rad',
        text: 'Decontamination was skipped. The dose is in the silo now, spread thin across everybody.',
      });
    } else {
      const cost = D.filtersPerMember * (a.members?.length || 0);
      state.resources.filters = clamp((state.resources.filters || 0) - cost, 0, caps.filters ?? Infinity);
      for (const id of a.members || []) {
        const c = state.citizens[id];
        if (!c) continue;
        c.radiation = clamp(c.radiation * (1 - D.radRemovedFraction), 0, BAL.citizens.radiation.max);
      }
      pushLog(state, {
        kind: 'plain',
        text: `Decontamination complete. ${cost} filters spent.`,
      });
    }
    state.pendingDecon = null;
  },

  MAP_REVEAL(state, a) {
    state.map.discovered = [...new Set([...(state.map.discovered || []), a.band])];
  },

  SILO_DISCOVER(state, a) {
    const silo = state.world.silos[a.siloId];
    if (!silo) return;
    silo.known = true;
    if (a.contact && silo.contact === 'none') silo.contact = a.contact;
    pushLog(state, { kind: 'radio', text: `${silo.name} is on the board.` });
  },

  SILO_REPUTATION(state, a) {
    const silo = state.world.silos[a.siloId];
    if (!silo) return;
    silo.reputation = clamp(silo.reputation + a.amount, -100, 100);
  },
};

// ---------------------------------------------------------------- world ---

const worldReducers = {
  WORLD_PATCH(state, a) {
    for (const p of a.patches) {
      const silo = state.world.silos[p.id];
      if (!silo) continue;
      for (const [k, v] of Object.entries(p)) {
        if (k === 'id') continue;
        if (k === 'power') silo.power = { ...silo.power, ...v };
        else silo[k] = v;
      }
    }
  },

  SILO_PATCH(state, a) {
    const silo = state.world.silos[a.siloId];
    if (silo) Object.assign(silo, a.patch);
  },

  SILO_TREATY(state, a) {
    const silo = state.world.silos[a.siloId];
    if (!silo) return;
    silo.treaties ??= [];
    if (a.remove) silo.treaties = silo.treaties.filter((t) => t.kind !== a.remove);
    if (a.add && a.treaty) {
      silo.treaties = silo.treaties.filter((t) => t.kind !== a.treaty.kind);
      silo.treaties.push(a.treaty);
    }
  },

  /**
   * Silos remember. Entries decay but never vanish — the floor keeps a
   * fraction of the original weight forever (spec §12.2).
   */
  SILO_MEMORY(state, a) {
    const silo = state.world.silos[a.siloId];
    if (!silo) return;
    silo.memory ??= [];
    silo.memory.push({ ...a.entry, original: a.entry.weight });
    if (silo.memory.length > 40) silo.memory.shift();
  },

  MEMORY_DECAY(state, a) {
    const floor = BAL.diplomacy.memoryFloorFraction;
    for (const silo of Object.values(state.world.silos)) {
      for (const m of silo.memory || []) {
        const min = (m.original ?? m.weight) * floor;
        if (m.weight > 0) m.weight = Math.max(min, m.weight - a.rate);
        else if (m.weight < 0) m.weight = Math.min(min, m.weight + a.rate);
      }
    }
  },

  WORLD_WAR(state, a) {
    const A = state.world.silos[a.a];
    const B = state.world.silos[a.b];
    if (!A || !B) return;
    A.treaties = [...(A.treaties || []), { kind: 'war', with: B.id, since: a.at }];
    B.treaties = [...(B.treaties || []), { kind: 'war', with: A.id, since: a.at }];
  },

  TRANSMISSION(state, a) {
    state.world.transmissions.unshift(a.transmission);
    if (state.world.transmissions.length > 60) state.world.transmissions.pop();
    if (a.transmission.text) {
      pushLog(state, { kind: 'radio', text: a.transmission.text });
    }
  },

  WORLD_EVENT_QUEUE(state, a) {
    state.world.pending ??= [];
    state.world.pending.push(a.event);
  },

  WORLD_EVENT_RESOLVE(state, a) {
    state.world.pending = (state.world.pending || []).filter((e) => e !== a.event);
  },

  DIPLO_TICK(state, a) {
    state.world.lastDiploDay = a.day;
  },

  RADIO_TIER(state, a) {
    state.world.radioTier = Math.max(state.world.radioTier || 0, a.tier);
  },

  /** Everyone hears about it. Used for treaty-breaking and declarations. */
  BROADCAST_REPUTATION(state, a) {
    const except = new Set(a.except || []);
    for (const silo of Object.values(state.world.silos)) {
      if (except.has(silo.id) || !silo.known) continue;
      silo.reputation = clamp(silo.reputation + a.amount, -100, 100);
    }
    if (a.reason) {
      pushLog(state, {
        kind: 'diplomacy',
        text: `Word got round about ${a.reason}. Every silo that can hear you thinks a little less of Silo 12.`,
      });
    }
  },

  SATELLITE_ADD(state, a) {
    // Idempotent. A second entry for the same silo is not a bigger empire: it
    // pays that silo's yield twice, charges Order per array length, breaks the
    // `i < garrisons` assignment in world.js, is never ticked because
    // SATELLITE_TICK `.find()`s only the first — and inflates the count the
    // Dominion ending is decided on.
    if (state.world.satellites.some((x) => x.siloId === a.siloId)) return;
    state.world.satellites.push({ siloId: a.siloId, since: state.clock.day, order: BAL.conquest.conqueredStartOrder });
    const silo = state.world.silos[a.siloId];
    if (silo) {
      silo.contact = 'satellite';
      silo.status = 'satellite';
    }
    pushLog(state, {
      kind: 'diplomacy',
      text: `${silo?.name || 'The silo'} is yours. Its people are not, and will not be for a long time.`,
    });
  },

  SATELLITE_TICK(state, a) {
    // Occupied populations warm up slowly, and only if you keep a garrison —
    // which the caller decides, per satellite. This used to warm every one of
    // them unconditionally by a hardcoded 0.6, so satellite order climbed to
    // a hundred no matter what the player did, SATELLITE_REVOLT was never
    // dispatched by anything, and holding a silo was pure profit forever.
    for (const { siloId, amount } of a.shifts || []) {
      const sat = state.world.satellites.find((s) => s.siloId === siloId);
      if (sat) sat.order = clamp(sat.order + amount, 0, 100);
    }
  },

  SATELLITE_REVOLT(state, a) {
    state.world.satellites = state.world.satellites.filter((s) => s.siloId !== a.siloId);
    const silo = state.world.silos[a.siloId];
    if (silo) {
      silo.contact = 'hostile';
      silo.status = 'struggling';
      silo.reputation = -100;
      // And the conquest ladder goes back to the bottom. Without this the
      // silo keeps `stage: 'held'` for ever: the radio panel reads "Already
      // taken.", the launch gate says a run is fine, and every squad sent
      // spends twelve days and a full supply load resolving a stage that has
      // no branch — a permanent no-op the player can repeat indefinitely.
      // Taking a silo back is a fresh conquest, and it should be.
      silo.conquest = { stage: null, scoutRuns: 0, undermined: false, defenseMult: 1 };
    }
    pushLog(state, {
      kind: 'alert',
      text: `${silo?.name || 'A satellite'} has thrown out your garrison. Everything you spent taking it is gone.`,
    });
  },

  PENDING_RAID(state, a) {
    // Never overwrite a raid that has not landed yet. Two events maturing on
    // the same day used to show the player two alerts and resolve one, which
    // is the exact "the alert went up and nothing happened" failure the raid
    // module exists to remove. The one already at the door keeps its place;
    // the second silo's party is folded into it as extra strength.
    if (state.world.pendingRaid) {
      state.world.pendingRaid.strength = Math.max(state.world.pendingRaid.strength, a.strength);
      return;
    }
    // Written, and — today — never read. `RAID_RESOLVED` below is dispatched
    // from nowhere in src/ or test/, and no sim module looks at
    // `world.pendingRaid`, so a raid announces itself and then nothing
    // happens. Kept rather than deleted because the event and the reducer are
    // the half that already works; what is missing is a resolver.
    state.world.pendingRaid = { siloId: a.siloId, strength: a.strength, day: state.clock.day };
    emit('alert', { kind: 'warn', glyph: '⚑', text: 'Raiders at the airlock' });
  },

  RAID_RESOLVED(state) {
    state.world.pendingRaid = null;
  },

  CONQUEST_PATCH(state, a) {
    const silo = state.world.silos[a.siloId];
    if (!silo) return;
    silo.conquest = { ...(silo.conquest || { stage: 'scout', scoutRuns: 0, undermined: false, defenseMult: 1 }), ...a.patch };
  },
};

let registered = false;

/** Called once at boot. Later phases add their own reducer files. */
export function registerCoreReducers() {
  if (registered) return;
  registered = true;
  registerReducers({
    ...clockReducers,
    ...resourceReducers,
    ...siloReducers,
    ...citizenReducers,
    ...orderReducers,
    ...researchReducers,
    ...militaryReducers,
    ...expeditionReducers,
    ...worldReducers,
    ...logReducers,
  });
}

export default registerCoreReducers;
