/**
 * build.js — the construction panel.
 *
 * Two things it has to do well. First, the cost preview must be honest: not
 * just the build price but the ongoing upkeep, because a room you cannot
 * power is worse than no room. Second, when something can't be built the
 * panel says why in a sentence and points at the fix (spec §15).
 */

import { BAL } from '../../config/balance.js';
import { getRoom, CATEGORIES } from '../../data/rooms.js';
import { buildable, placements, canBuild, build, excavationCost, canExcavate, startExcavation, nextFloorToExcavate, describeCost } from '../../sim/build.js';
import { tierForFloor, tierUnlocked } from '../../sim/research.js';
import { el, button, row, sectionLabel, emptyState, toast, modal, fmtDuration, humanise, chip } from '../dom.js';
import { buildCycles } from '../../sim/build.js';

let category = 'all';

export const buildPanel = {
  id: 'build',
  title: 'Construction',
  nav: 'Build',
  glyph: '⌗',
  subtitle: (s) => {
    const dug = s.silo.floors.filter((f) => f.excavated).length;
    return `${dug}/${BAL.silo.totalFloors} floors`;
  },

  render(state, shell) {
    const body = el('div.panel-body');
    const floorN = shell.buildFloor ?? state.ui.cameraFloor ?? 3;

    body.appendChild(excavationSection(state, shell));
    body.appendChild(floorPicker(state, shell, floorN));

    const floor = state.silo.floors[floorN - 1];
    if (!floor?.excavated) {
      body.appendChild(emptyState(`Floor ${floorN} has not been excavated.`));
      return body;
    }

    body.appendChild(baySection(state, shell, floor));

    // ---- catalogue --------------------------------------------------------
    const options = buildable(state, floorN);
    const cats = ['all', ...new Set(options.map((o) => o.def.category))];
    body.appendChild(
      el(
        'div.chip-row',
        ...cats.map((c) =>
          el(
            'button.chip' + (category === c ? '.warn' : ''),
            {
              type: 'button',
              onclick: () => {
                category = c;
                shell.renderPanel(true);
              },
            },
            c === 'all' ? 'All' : CATEGORIES[c] || humanise(c)
          )
        )
      )
    );

    const shown = options.filter((o) => category === 'all' || o.def.category === category);
    // Buildable first, then locked — a wall of greyed-out rooms is not a menu.
    shown.sort((a, b) => Number(b.ok) - Number(a.ok) || a.def.name.localeCompare(b.def.name));

    body.appendChild(sectionLabel(`Build on floor ${floorN}`));
    for (const opt of shown) {
      body.appendChild(catalogueRow(state, shell, opt, floorN));
    }
    return body;
  },
};

function excavationSection(state, shell) {
  const dig = state.silo.excavating;
  const next = nextFloorToExcavate(state);
  const wrap = el('div');

  if (dig) {
    const left = Math.max(0, dig.untilCycle - state.clock.cycle);
    wrap.appendChild(
      row({
        title: `Excavating floor ${dig.floor}`,
        sub: `${fmtDuration(left)} remaining. The crew is down there now.`,
        value: `${left}`,
      })
    );
    return wrap;
  }

  if (next == null) {
    wrap.appendChild(row({ title: 'Every floor is open', sub: 'Ninety-two down to bedrock.' }));
    return wrap;
  }

  const cost = excavationCost(state);
  const check = canExcavate(state);
  const tier = tierForFloor(next);

  wrap.appendChild(
    el(
      'div.excavate',
      el(
        'div.excavate-main',
        el('div.excavate-title', `Excavate floor ${next}`),
        el('div.excavate-sub', `${tier.name} · ${describeCost(cost)}`),
        !check.ok ? el('div.excavate-warn', check.reason) : null
      ),
      button('Dig', {
        class: 'primary',
        disabled: !check.ok,
        onclick: () => {
          shell.store.dispatchAll(startExcavation(state));
          toast(`Excavation of floor ${next} has begun.`);
          shell.renderPanel(true);
        },
      })
    )
  );
  return wrap;
}

function floorPicker(state, shell, current) {
  const strip = el('div.floor-strip');
  const dug = state.silo.floors.filter((f) => f.excavated);
  for (const f of dug) {
    const free = f.slots.filter((s) => s == null).length;
    strip.appendChild(
      el(
        'button.floor-pip' + (f.n === current ? '.active' : '') + (free === 0 ? '.full' : ''),
        {
          type: 'button',
          onclick: () => {
            shell.buildFloor = f.n;
            shell.onFocusFloor?.(f.n);
            shell.renderPanel(true);
          },
          title: `Floor ${f.n} — ${free} free bay${free === 1 ? '' : 's'}`,
        },
        el('span.floor-n.mono', String(f.n)),
        el('span.floor-free', free ? `${free}` : '·')
      )
    );
  }
  return el('div.floor-strip-wrap', strip);
}

function baySection(state, shell, floor) {
  const wrap = el('div.bay-row');
  const seen = new Set();
  for (let i = 0; i < BAL.silo.slotsPerFloor; i++) {
    const id = floor.slots[i];
    if (id == null) {
      wrap.appendChild(el('div.bay.empty', el('span', '—')));
      continue;
    }
    const room = state.silo.rooms[id];
    const def = getRoom(room?.type);
    const first = !seen.has(id);
    seen.add(id);
    wrap.appendChild(
      el(
        'button.bay' + (room?.powered ? '' : '.dark'),
        {
          type: 'button',
          onclick: () => shell.onOpenRoom?.(id),
          title: def?.name,
        },
        el('span.bay-name', first ? (def?.name || '?') : '·'),
        first ? el('span.bay-lvl.mono', `L${room.level}`) : null
      )
    );
  }
  return el('div', sectionLabel(`Floor ${floor.n} bays`), wrap);
}

function catalogueRow(state, shell, opt, floorN) {
  const { def, ok, reason } = opt;
  const spots = ok ? placements(state, floorN, def.id) : [];
  const noRoom = ok && spots.length === 0;

  const upkeep = Object.entries(def.consumes || {})
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  const output = Object.entries(def.produces || {})
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

  const node = el(
    'button.build-row' + (ok && !noRoom ? '' : '.locked'),
    {
      type: 'button',
      disabled: !ok || noRoom,
      onclick: () => choosePlacement(state, shell, def, floorN, spots),
    },
    el(
      'div.build-main',
      el('div.build-name', def.name),
      el('div.build-desc', def.desc),
      el(
        'div.build-meta',
        chip(describeCost(def.buildCost)),
        output ? chip(`+${output}/cycle`, 'good') : null,
        upkeep ? chip(`−${upkeep}/cycle`, 'bad') : null,
        chip(fmtDuration(buildCycles(def)))
      ),
      !ok ? el('div.build-why', reason) : noRoom ? el('div.build-why', 'No free bay on this floor.') : null
    ),
    ok && !noRoom ? el('div.row-chevron', '›') : null
  );
  return node;
}

function choosePlacement(state, shell, def, floorN, spots) {
  if (spots.length === 1) {
    doBuild(shell, floorN, spots[0].slot, def);
    return;
  }
  const body = el('div');
  body.appendChild(
    el('div.note', `Adjacent identical rooms merge into one wider unit — more output per bay, less power drawn.`)
  );
  for (const spot of spots) {
    body.appendChild(
      row({
        title: `Bay ${spot.slot + 1}`,
        sub: spot.label,
        onclick: () => {
          h.close();
          doBuild(shell, floorN, spot.slot, def);
        },
      })
    );
  }
  const h = modal({
    title: `${def.name} — where?`,
    body,
    actions: [button('Cancel', { onclick: () => h.close() })],
  });
}

function doBuild(shell, floorN, slot, def) {
  const state = shell.store.state;
  const check = canBuild(state, floorN, slot, def.id);
  if (!check.ok) {
    toast(check.reason, 'bad');
    return;
  }
  shell.store.dispatchAll(build(state, floorN, slot, def.id));
  toast(`${def.name}: construction started on floor ${floorN}.`);
  shell.renderPanel(true);
}

export default buildPanel;
