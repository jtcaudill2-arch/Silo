/**
 * build.js — the construction panel.
 *
 * Construction is pick-then-place. The panel opens on the whole catalogue —
 * every room the silo knows about, not the subset that happens to fit on some
 * floor you had to choose first — and tapping one hands the screen over to the
 * cross-section, where every bay it could occupy lights up. That inversion is
 * the point: the player picks *what* they want and the silo answers *where*,
 * rather than being made to guess which floor is the interesting one before
 * the game will tell them anything.
 *
 * Two things it still has to do well. The cost preview must be honest — not
 * just the build price but the ongoing upkeep, because a room you cannot power
 * is worse than no room. And when something can't be built the panel says why
 * in a sentence and points at the fix (spec §15).
 */

import { BAL } from '../../config/balance.js';
import { getRoom, CATEGORIES } from '../../data/rooms.js';
import {
  catalogue,
  excavationCost,
  canExcavate,
  startExcavation,
  nextFloorToExcavate,
  describeCost,
  buildCycles,
} from '../../sim/build.js';
import { tierForFloor } from '../../sim/research.js';
import { el, button, sectionLabel, toast, fmtDuration, humanise, chip } from '../dom.js';

let category = 'all';
/** Are the rooms the silo cannot build yet folded away? They start folded. */
let lockedOpen = false;

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
    body.appendChild(excavationSection(state, shell));

    // ---- the catalogue, floor-independent --------------------------------
    const options = catalogue(state);
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

    const open = shown.filter((o) => o.ok);
    const shut = shown.filter((o) => !o.ok);

    body.appendChild(sectionLabel('Pick a building, then a bay'));
    if (!open.length) body.appendChild(el('div.note', 'Nothing in this category can be built yet.'));
    for (const opt of open) body.appendChild(catalogueRow(shell, opt));

    // ---- the ones that are still shut ------------------------------------
    // Twenty-nine rows with thirteen greyed out is three thousand pixels of
    // scrolling on a phone to reach the sixteen that can actually be built,
    // and the thirteen are not a menu — they are the shape of the game
    // ahead. Worth knowing about, not worth scrolling past. So they fold
    // behind one line that says how many there are and what they are waiting
    // on, and the fold is remembered while the panel is open.
    if (shut.length) body.appendChild(lockedSection(shell, shut));

    // ---- where there is room ---------------------------------------------
    // Secondary now, and deliberately below the catalogue: it is orientation,
    // not a gate. Tapping a floor takes the camera there; tapping a built bay
    // opens that room.
    body.appendChild(floorSection(state, shell));
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
      el(
        'div.excavate',
        el(
          'div.excavate-main',
          el('div.excavate-title', `Excavating floor ${dig.floor}`),
          el('div.excavate-sub', `${fmtDuration(left)} remaining. The crew is down there now.`)
        )
      )
    );
    return wrap;
  }

  if (next == null) {
    wrap.appendChild(
      el(
        'div.excavate',
        el(
          'div.excavate-main',
          el('div.excavate-title', 'Every floor is open'),
          el('div.excavate-sub', 'Ninety-two down to bedrock.')
        )
      )
    );
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

/**
 * Everything the silo cannot build yet, behind one line.
 *
 * The summary names what is actually in the way rather than just counting —
 * "eight need research, four need scrap" is a different instruction from
 * "twelve locked", and the two of them point at different panels.
 */
function lockedSection(shell, shut) {
  if (!BAL.wayfinding.lockedRowsCollapsed) {
    const wrap = el('div', sectionLabel('Not yet'));
    for (const opt of shut) wrap.appendChild(catalogueRow(shell, opt));
    return wrap;
  }

  const needsResearch = shut.filter((o) => /needs research|needs the/i.test(o.reason)).length;
  const cantAfford = shut.filter((o) => /not enough/i.test(o.reason)).length;
  const noRoom = shut.length - needsResearch - cantAfford;
  const parts = [];
  if (needsResearch) parts.push(`${needsResearch} waiting on research`);
  if (cantAfford) parts.push(`${cantAfford} the silo cannot pay for`);
  if (noRoom) parts.push(`${noRoom} with nowhere to go`);

  const wrap = el('div');
  wrap.appendChild(
    el(
      'button.build-row.folded',
      {
        type: 'button',
        'aria-expanded': lockedOpen ? 'true' : 'false',
        onclick: () => {
          lockedOpen = !lockedOpen;
          shell.renderPanel(true);
        },
      },
      el(
        'div.build-main',
        el('div.build-name', `${shut.length} more room${shut.length === 1 ? '' : 's'} the silo knows about`),
        el('div.build-desc', 'Nothing here can be built yet. Tap to read what they are waiting on.'),
        // Same sentence a locked row carries, aggregated: a fold that does not
        // say what is behind it is just a thing to tap twice.
        el('div.build-why', parts.join(', ') + '.')
      ),
      el('div.row-chevron', lockedOpen ? '⌃' : '⌄')
    )
  );
  if (lockedOpen) for (const opt of shut) wrap.appendChild(catalogueRow(shell, opt));
  return wrap;
}

/**
 * One row per room type. Cost, what it makes, what it costs to run, how long
 * it takes — and, when it can't be built anywhere at all, the one sentence
 * saying why. Tapping it enters placement mode.
 */
function catalogueRow(shell, opt) {
  const { def, ok, reason, bays } = opt;

  const upkeep = Object.entries(def.consumes || {})
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  const output = Object.entries(def.produces || {})
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

  return el(
    'button.build-row' + (ok ? '' : '.locked'),
    {
      type: 'button',
      disabled: !ok,
      onclick: () => shell.startPlacement(def.id),
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
        chip(fmtDuration(buildCycles(def))),
        // Room left, but only when running out of it is news.
        //
        // This used to print on every row, and on the first morning every row
        // printed the same number — "24 bays free", on every row of the
        // catalogue, on a silo with six floors dug and five rooms on them. A figure identical across every
        // option cannot inform a choice between them; it is furniture. Below a
        // couple of floors' worth it becomes a real warning that the silo needs
        // digging, and that is the only time it is worth the width.
        ok && bays <= BAL.wayfinding.baysChipBelow
          ? chip(`${bays} bay${bays === 1 ? '' : 's'} left`, bays <= BAL.silo.slotsPerFloor ? 'warn' : '')
          : null
      ),
      !ok ? el('div.build-why', reason) : null
    ),
    ok ? el('div.row-chevron', '›') : null
  );
}

/**
 * The floors, as a strip of free-bay counts, and the bays of whichever one is
 * selected. Not a filter on anything any more — just the answer to "where is
 * there still room", and a way to move the camera without closing the panel.
 */
function floorSection(state, shell) {
  const dug = state.silo.floors.filter((f) => f.excavated);
  if (!dug.length) return el('div');

  const wanted = shell.buildFloor ?? state.ui.cameraFloor ?? dug[0].n;
  const floor = dug.find((f) => f.n === wanted) || dug[0];

  const strip = el('div.floor-strip');
  for (const f of dug) {
    const free = f.slots.filter((s) => s == null).length;
    strip.appendChild(
      el(
        'button.floor-pip' + (f.n === floor.n ? '.active' : '') + (free === 0 ? '.full' : ''),
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

  const bays = el('div.bay-row');
  const seen = new Set();
  for (let i = 0; i < BAL.silo.slotsPerFloor; i++) {
    const id = floor.slots[i];
    if (id == null) {
      bays.appendChild(el('div.bay.empty', el('span', '—')));
      continue;
    }
    const room = state.silo.rooms[id];
    const def = getRoom(room?.type);
    const first = !seen.has(id);
    seen.add(id);
    bays.appendChild(
      el(
        'button.bay' + (room?.powered ? '' : '.dark'),
        {
          type: 'button',
          onclick: () => shell.onOpenRoom?.(id),
          title: def?.name,
        },
        el('span.bay-name', first ? def?.name || '?' : '·'),
        first ? el('span.bay-lvl.mono', `L${room.level}`) : null
      )
    );
  }

  return el(
    'div',
    sectionLabel('Where there is room'),
    el('div.floor-strip-wrap', strip),
    bays
  );
}

export default buildPanel;
