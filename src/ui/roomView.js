/**
 * roomView.js — the panel you get when you tap a room.
 *
 * Shows what the room is actually doing right now, not what it could do in
 * theory: real output after staffing, condition and power, with the reason
 * spelled out when it's producing less than its rating.
 */

import { BAL } from '../config/balance.js';
import { getRoom } from '../data/rooms.js';
import { sectionFor, suitsSection, maxWidthOn } from '../data/sections.js';
import { roomCapability, roomDraw, staffSlots, powerPicture } from '../sim/economy.js';
import { workFactor, fullName, topSkill } from '../sim/population.js';
import { employableCitizens, bestCandidateFor } from '../sim/jobs.js';
import { canUpgrade, upgrade, upgradeCost, canDemolish, demolish, describeCost, canRepair, repair } from '../sim/build.js';
import { roomArt, artImage } from './artwork.js';
import * as sprites from '../render/sprites.js';
import { el, modal, row, button, fmt, fmtDelta, meter, chip, emptyState, sectionLabel, toast, humanise } from './dom.js';

export function openRoom(store, roomId, shell) {
  const state = store.state;
  const room = state.silo.rooms[roomId];
  if (!room) return;
  const def = getRoom(room.type);
  if (!def) return;

  store.dispatch({ type: 'UI_SET', ui: { selectedRoom: roomId } });

  let handle = null;
  const rerender = () => {
    handle?.close();
    handle = show();
  };

  function show() {
    const s = store.state;
    const r = s.silo.rooms[roomId];
    if (!r) return null;
    const cap = roomCapability(s, r);
    const slots = staffSlots(def, r);
    const draw = roomDraw(s, r, cap);
    const rating = ratingCapability(r);

    const body = el('div');

    // ---- the room itself --------------------------------------------------
    // A cutaway, when one has been imported for this room type. The silo
    // cross-section draws this room into a 64×40 slot; this is the one place
    // it gets to be looked at. Absent art costs nothing — the panel simply
    // starts at the numbers, as it always did.
    // Imported artwork wins if any has been imported; otherwise the atlas
    // cutaway, which ships with the game. Either way the panel opens on the
    // room rather than on a grid of percentages.
    const imported = roomArt(r.type);
    const art = imported
      ? artImage(imported, def.name)
      : sprites.frameCanvas(`cutaway_${r.type}`, 3);
    if (art) {
      if (art.tagName === 'CANVAS') art.setAttribute('aria-hidden', 'true');
      body.appendChild(el('div.room-art' + (r.powered ? '' : '.dark'), art));
    }

    // ---- what level this is, in the silo's own words ----------------------
    //
    // A room on a level the builders fitted for it can carry a fourth bay and
    // cost a quarter less to put up, and neither of those is legible from a
    // percentage. This is the one place a player can be told why this
    // particular Hydroponics is wider than the one two floors up.
    const section = sectionFor(r.floor);
    if (section) {
      const fitted = suitsSection(r.floor, def);
      body.appendChild(
        el(
          'div.room-section' + (fitted ? '.fitted' : ''),
          el('span.room-section-name', section.name),
          el(
            'span.room-section-note',
            fitted
              ? `Fitted for this. ${section.blurb} Up to ${maxWidthOn(r.floor, def)} bays here.`
              : section.blurb
          )
        )
      );
    }

    // ---- headline numbers -------------------------------------------------
    body.appendChild(
      el(
        'div.grid-3',
        tile('Level', `${r.level}/${BAL.silo.upgrade.maxLevel}`),
        tile('Condition', Math.round(r.condition), r.condition < BAL.silo.condition.penaltyBelow ? 'bad' : ''),
        tile('Output', Math.round((cap / Math.max(rating, 0.0001)) * 100) + '%', outputClass(cap, rating))
      )
    );

    // ---- what the mayor can do about it, before anything else -------------
    //
    // Every verb in this panel already existed — repair, upgrade, crew, strip —
    // and every one of them was below a screen of readout. Tapping a room gave
    // you a report and left the acting to somebody who scrolled, which is most
    // of "it feels like a sit and wait game": the game was mostly read.
    //
    // So the actions come first, as one row, with their price on them. Each is
    // the same call the section further down makes — this is a shortcut to
    // them, not a second implementation — and a disabled one keeps its reason
    // in the title so the row still says why not.
    {
      const acts = [];
      const fixNow = canRepair(s, roomId);
      const upNow = canUpgrade(s, roomId);
      const short = def.staff && r.staff.length < slots;
      const hurt = r.condition < BAL.silo.condition.penaltyBelow;

      if (short) {
        const best = bestCandidateFor(s, roomId);
        acts.push({
          label: best ? 'Crew it' : 'Nobody free',
          primary: r.staff.length === 0,
          disabled: !best,
          title: best ? `Post ${fullName(best)}` : 'Everybody who could do this already has a post',
          run: () => {
            store.dispatch({ type: 'CITIZEN_ASSIGN', citizenId: best.id, roomId });
            toast(`${fullName(best)} posted to the ${def.name}.`);
            rerender();
          },
        });
      }
      if (r.condition < 100) {
        acts.push({
          label: fixNow.partial ? 'Patch' : 'Repair',
          primary: hurt,
          disabled: !fixNow.ok,
          title: fixNow.ok ? describeCost(fixNow.cost) : fixNow.reason,
          run: () => {
            store.dispatchAll(repair(store.state, roomId));
            toast(`${def.name} repaired.`);
            rerender();
          },
        });
      }
      if (r.level < BAL.silo.upgrade.maxLevel && r.upgradingUntilCycle <= s.clock.cycle) {
        acts.push({
          label: `Upgrade to ${r.level + 1}`,
          primary: !hurt && r.staff.length > 0,
          disabled: !upNow.ok,
          title: upNow.ok ? describeCost(upNow.cost || upgradeCost(r)) : upNow.reason,
          run: () => {
            store.dispatchAll(upgrade(store.state, roomId));
            toast(`${def.name} upgrading.`);
            rerender();
          },
        });
      }

      if (acts.length) {
        // Only one may be the loud one, and it is the most urgent thing true of
        // this room: crew an empty one, then fix a failing one, then grow a
        // working one. A row of three primaries is a row of none.
        const lead = acts.find((a) => a.primary && !a.disabled);
        body.appendChild(
          el(
            'div.room-acts',
            ...acts.map((a) =>
              button(a.label, {
                class: (a === lead ? 'primary' : '') + ' room-act',
                disabled: a.disabled,
                title: a.title,
                onclick: a.run,
              })
            )
          )
        );
      }
    }

    // ---- why it isn't at 100% --------------------------------------------
    const reasons = [];
    // A seized room is dark because it has never been commissioned, not because
    // the power list cut it — it is not in the power list at all until it is
    // restored. Saying "no power" there sends the player to the wrong panel.
    if (r.found) {
      reasons.push('Seized. It came with the level and has never run — restoring it is what turns it on.');
    } else if (!r.powered) {
      reasons.push('No power — it is below the cut line in the priority list.');
    }
    if (!r.found && def.staff && r.staff.length === 0) reasons.push('Nobody is assigned to it.');
    else if (def.staff && r.staff.length < slots) {
      reasons.push(`Crewed ${r.staff.length} of ${slots}. Empty seats mean proportionally less output.`);
    }
    if (r.condition < BAL.silo.condition.penaltyBelow) {
      reasons.push(`Condition ${Math.round(r.condition)} is below ${BAL.silo.condition.penaltyBelow}; output scales down from here to zero.`);
    }
    if (r.buildingUntilCycle > s.clock.cycle) {
      reasons.push(`Under construction — online in ${r.buildingUntilCycle - s.clock.cycle} shifts.`);
    }
    if (reasons.length) {
      body.appendChild(el('div.note.warn', reasons.join(' ')));
    }

    // ---- throughput -------------------------------------------------------
    // Priced at `rate × capability × load`, not `rate × capability`. Generator
    // halls throttle to the silo's actual draw, so a hall's plate rate is a
    // ceiling rather than a bill — and this panel is where a player goes to
    // ask what the room in front of them is costing. Without the load it
    // over-reports a part-loaded hall's fuel burn, which is the same defect
    // the Stores ledger had, in the one place a player would go to check it.
    const load = powerPicture(s).load[r.id] ?? 1;
    const flows = [];
    for (const [k, v] of Object.entries(def.produces || {})) {
      flows.push({ k, v: v * cap * load, dir: 1 });
    }
    for (const [k, v] of Object.entries(def.consumes || {})) {
      if (k === 'power') flows.push({ k, v: draw, dir: -1 });
      else flows.push({ k, v: v * cap * load, dir: -1 });
    }
    if (flows.length) {
      body.appendChild(sectionLabel('Per cycle'));
      // A hall running under its rating is not broken, and the Output tile
      // above says 100% — say which it is before the numbers.
      if (load < 0.995) {
        body.appendChild(
          el(
            'div.note',
            `Part-loaded at ${Math.round(load * 100)}% — the silo is not drawing everything ` +
              'this room could make, so it is burning less than its rating.'
          )
        );
      }
      const grid = el('div.flow-grid');
      for (const f of flows) {
        grid.appendChild(
          el(
            'div.flow-cell',
            el('span.flow-k', humanise(f.k)),
            el('span.flow-v.mono' + (f.dir > 0 ? '.up' : '.down'), fmtDelta(f.dir * f.v))
          )
        );
      }
      body.appendChild(grid);
    }

    if (def.provides?.airCapacity) {
      body.appendChild(
        row({
          title: 'Air capacity',
          sub: 'Residents this bay can keep breathing.',
          value: String(Math.round(def.provides.airCapacity * r.level * r.width)),
        })
      );
    }
    if (def.provides?.housing) {
      body.appendChild(
        row({
          title: 'Housing',
          sub: 'Bunks. Counted whether or not the lights are on.',
          value: String(def.provides.housing * r.level * r.width),
        })
      );
    }

    // ---- crew -------------------------------------------------------------
    if (def.staff) {
      body.appendChild(sectionLabel(`Crew — ${humanise(def.staff.skill)} (${r.staff.length}/${slots})`));
      if (!r.staff.length) {
        // Crewing a seized room is a trap: `openSlots` skips it, so auto-assign
        // will never take the person back, and the restore order drops off the
        // board the moment somebody is standing in it. The panel used to offer
        // an Assign button here regardless.
        body.appendChild(emptyState(
          r.found
            ? 'No crew, and none can be posted until it is restored. Nothing works in here yet.'
            : 'Unstaffed. This room is producing nothing.'
        ));
      }
      for (const cid of r.staff) {
        const c = s.citizens[cid];
        if (!c) continue;
        const eff = Math.round(workFactor(c, def.staff.skill) * 100);
        body.appendChild(
          el(
            'div.row',
            el(
              'div.row-main',
              el('div.row-title', fullName(c)),
              el(
                'div.row-sub',
                `${humanise(def.staff.skill)} ${Math.round(c.skills[def.staff.skill] || 0)}` +
                  `  ·  health ${Math.round(c.health)}  ·  morale ${Math.round(c.morale)}`
              )
            ),
            el('div.row-value.mono', eff + '%'),
            button('Remove', {
              class: 'sm ghost',
              onclick: () => {
                store.dispatch({ type: 'CITIZEN_ASSIGN', citizenId: cid, roomId: null });
                rerender();
              },
            })
          )
        );
      }
      // Not while it is seized — see the note above the empty state.
      if (r.staff.length < slots && !r.found) {
        const best = bestCandidateFor(s, roomId);
        body.appendChild(
          el(
            'div.pad',
            button(best ? `Assign ${fullName(best)}` : 'Nobody available', {
              class: 'primary wide',
              disabled: !best,
              onclick: () => {
                if (!best) return;
                store.dispatch({ type: 'CITIZEN_ASSIGN', citizenId: best.id, roomId });
                rerender();
              },
            }),
            button('Choose someone…', {
              class: 'wide',
              onclick: () => pickCrew(store, roomId, def, rerender),
            })
          )
        );
      }
    }

    // ---- condition --------------------------------------------------------
    body.appendChild(sectionLabel('Condition'));
    body.appendChild(el('div.pad', meter(r.condition, 100, r.condition < 40 ? 'bad' : 'good')));
    body.appendChild(
      el(
        'div.note',
        r.condition >= BAL.silo.condition.penaltyBelow
          ? 'Wearing normally. A Maintenance Bay crew restores condition across the silo.'
          : 'Below safe condition. Output is falling and at zero this room can breach.'
      )
    );

    // ---- repair -----------------------------------------------------------
    if (r.condition < BAL.silo.condition.start - 1) {
      const fix = canRepair(s, roomId);
      body.appendChild(
        el(
          'div.pad',
          button(
            fix.ok
              ? fix.partial
                ? `Patch up (+${Math.round(fix.points)} condition, ${describeCost(fix.cost)})`
                : `Repair to full (${describeCost(fix.cost)})`
              : 'Cannot repair',
            {
              class: 'wide' + (r.condition < BAL.silo.condition.penaltyBelow ? ' primary' : ''),
              disabled: !fix.ok,
              title: fix.ok ? '' : fix.reason,
              onclick: () => {
                store.dispatchAll(repair(store.state, roomId));
                toast(`${def.name} repaired.`);
                rerender();
              },
            }
          )
        )
      );
      if (!fix.ok) body.appendChild(el('div.note.warn', fix.reason));
    }

    // ---- upgrade ----------------------------------------------------------
    const up = canUpgrade(s, roomId);
    body.appendChild(sectionLabel('Upgrade'));
    if (r.upgradingUntilCycle > s.clock.cycle) {
      body.appendChild(
        el('div.note.warn', `Being upgraded — offline for ${r.upgradingUntilCycle - s.clock.cycle} more shifts.`)
      );
    } else if (r.level >= BAL.silo.upgrade.maxLevel) {
      body.appendChild(el('div.note', 'At maximum level. Widen it instead: build the same room in the bay beside it.'));
    } else {
      const cost = up.cost || upgradeCost(r);
      body.appendChild(
        el(
          'div.note',
          `Level ${r.level} → ${r.level + 1}: ${describeCost(cost)}, and ` +
            `${BAL.silo.upgrade.downtimeCycles} shifts offline. Adds output and staff slots.`
        )
      );
      if (!up.ok) body.appendChild(el('div.note.warn', up.reason));
      body.appendChild(
        el(
          'div.pad',
          button(`Upgrade to level ${r.level + 1}`, {
            class: 'primary wide',
            disabled: !up.ok,
            onclick: () => {
              store.dispatchAll(upgrade(store.state, roomId));
              toast(`${def.name} upgrading.`);
              rerender();
            },
          })
        )
      );
    }

    const actions = [button('Close', { onclick: () => handle?.close() })];
    const dem = canDemolish(s, roomId);
    actions.unshift(
      button('Strip out', {
        class: 'danger',
        disabled: !dem.ok,
        title: dem.ok ? `Recovers ${describeCost(dem.refund)}` : dem.reason,
        onclick: () => confirmDemolish(store, roomId, def, handle),
      })
    );

    return modal({
      title: `${def.name} · Floor ${r.floor}`,
      body,
      actions,
      onClose: () => store.dispatch({ type: 'UI_SET', ui: { selectedRoom: null } }),
    });
  }

  handle = show();
  return handle;
}

/** Capability with a perfect crew, for the "% of rating" readout. */
function ratingCapability(room) {
  const level = 1 + (room.level - 1) * BAL.silo.upgrade.outputPerLevel;
  const merge = room.width * (1 + (room.width - 1) * BAL.silo.merge.efficiencyPerStep);
  return level * merge;
}

function outputClass(cap, rating) {
  const pct = cap / Math.max(rating, 0.0001);
  if (pct <= 0.01) return 'bad';
  if (pct < 0.5) return 'warn';
  return 'good';
}

function pickCrew(store, roomId, def, done) {
  const s = store.state;
  const candidates = employableCitizens(s)
    .filter((c) => c.job?.roomId !== roomId)
    .sort((a, b) => (b.skills[def.staff.skill] || 0) - (a.skills[def.staff.skill] || 0))
    .slice(0, 60);

  const body = el('div');
  if (!candidates.length) body.appendChild(emptyState('Everyone is already posted.'));
  for (const c of candidates) {
    const top = topSkill(c);
    body.appendChild(
      row({
        title: fullName(c),
        sub:
          `${humanise(def.staff.skill)} ${Math.round(c.skills[def.staff.skill] || 0)}` +
          `  ·  best: ${humanise(top.skill)} ${Math.round(top.value)}` +
          (c.job ? '  ·  currently posted' : '  ·  idle'),
        value: Math.round(workFactor(c, def.staff.skill) * 100) + '%',
        onclick: () => {
          store.dispatch({ type: 'CITIZEN_ASSIGN', citizenId: c.id, roomId });
          h.close();
          toast(`${fullName(c)} posted.`);
          done?.();
        },
      })
    );
  }
  const h = modal({ title: 'Assign crew', body, actions: [button('Cancel', { onclick: () => h.close() })] });
}

/**
 * Stripping a room out is cheap to do and expensive to undo, so it asks —
 * and it says exactly what the silo loses, not just "are you sure".
 */
function confirmDemolish(store, roomId, def, parent) {
  const room = store.state.silo.rooms[roomId];
  const check = canDemolish(store.state, roomId);
  const body = el(
    'div',
    el('div.note', `${def.name} on floor ${room.floor}, level ${room.level}, ${room.width} bay${room.width === 1 ? '' : 's'}.`),
    el('div.note', `Salvage recovered: ${describeCost(check.refund)}. The crew is reassigned.`),
    room.staff.length
      ? el('div.note.warn', `${room.staff.length} resident${room.staff.length === 1 ? '' : 's'} posted here will be left idle.`)
      : null
  );
  const h = modal({
    title: `Strip out the ${def.name}?`,
    body,
    actions: [
      button('Cancel', { onclick: () => h.close() }),
      button('Strip it out', {
        class: 'danger',
        onclick: () => {
          store.dispatchAll(demolish(store.state, roomId));
          h.close();
          parent?.close();
          toast(`${def.name} stripped out.`);
        },
      }),
    ],
  });
}

function tile(k, v, cls = '') {
  return el('div.stat-tile', el('div.k', k), el('div.v' + (cls ? '.' + cls : ''), String(v)));
}

export default openRoom;
