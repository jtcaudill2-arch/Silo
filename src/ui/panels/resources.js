/**
 * resources.js — the ledger, and the power priority list.
 *
 * The priority list is the best decision moment in the early game (spec §5),
 * so it gets the real treatment: drag to reorder, a live cut-line showing
 * exactly where generation runs out, and the rooms below it drawn as already
 * dark. The player should be able to see the consequence before committing.
 */

import { BAL } from '../../config/balance.js';
import { el, fmt, fmtDelta, row, sectionLabel, meter, emptyState, makeReorderable, toast } from '../dom.js';
import { getRoom } from '../../data/rooms.js';
import { RES_KEYS, orderedRoomIds, roomCapability, roomDraw } from '../../sim/economy.js';

const LABELS = {
  power: 'Power', water: 'Water', food: 'Food', meds: 'Meds', scrap: 'Scrap',
  alloy: 'Alloy', ammo: 'Ammunition', chits: 'Chits', filters: 'Filters',
  parts: 'Parts', fuel: 'Fuel', ore: 'Ore', coolant: 'Coolant',
};

let tab = 'ledger';

export const resourcesPanel = {
  id: 'resources',
  title: 'Stores',
  nav: 'Stores',
  glyph: '▤',
  subtitle: (s) => `${Math.round(s.power?.generation || 0)} / ${Math.round(s.power?.demand || 0)} PWR`,

  render(state, shell) {
    const body = el('div.panel-body');
    const tabs = el(
      'div.tabs',
      tabBtn('ledger', 'Ledger', shell),
      tabBtn('power', 'Power priority', shell),
      tabBtn('air', 'Atmosphere', shell)
    );

    if (tab === 'ledger') renderLedger(state, body);
    else if (tab === 'power') renderPower(state, body, shell);
    else renderAir(state, body);

    return el('div', { style: { display: 'contents' } }, tabs, body);
  },
};

function tabBtn(id, label, shell) {
  return el(
    'button.tab' + (tab === id ? '.active' : ''),
    {
      type: 'button',
      onclick: () => {
        tab = id;
        shell.renderPanel(true);
      },
    },
    label
  );
}

// ---------------------------------------------------------------- ledger ---

function renderLedger(state, body) {
  body.appendChild(sectionLabel('Stockpiles'));
  for (const key of RES_KEYS) {
    const amount = state.resources[key] || 0;
    const cap = state.caps?.[key] ?? Infinity;
    const flow = state.flows?.[key];
    const net = flow ? flow.in - flow.out : 0;
    // Skip resources the silo has never seen and isn't producing — the
    // ledger shouldn't teach the player about coolant on day one.
    if (amount === 0 && !flow?.in && !flow?.out && key !== 'power') continue;

    const perDay = net * BAL.time.CYCLES_PER_DAY;
    const runway = net < 0 && amount > 0 ? amount / -perDay : null;

    const node = el(
      'div.row',
      el(
        'div.row-main',
        el('div.row-title', LABELS[key] || key),
        el(
          'div.row-sub',
          flow
            ? `+${flow.in.toFixed(1)} / −${flow.out.toFixed(1)} per cycle` +
              (runway != null ? `  ·  ${runway < 1 ? 'under a day' : runway.toFixed(1) + ' days'} left` : '')
            : '—'
        ),
        cap !== Infinity ? meter(amount, cap, amount / cap > 0.95 ? '' : 'good') : null
      ),
      el(
        'div.row-value',
        el('div.mono', fmt(amount) + (cap === Infinity ? '' : ` / ${fmt(cap)}`)),
        el(
          'div.mono',
          { class: net > 0.05 ? 'res-delta up' : net < -0.05 ? 'res-delta down' : 'res-delta flat' },
          fmtDelta(net) + '/c'
        )
      )
    );
    if (runway != null && runway < 2) node.classList.add('critical');
    body.appendChild(node);
  }

  body.appendChild(sectionLabel('Capacity'));
  body.appendChild(
    row({
      title: 'Storage depots',
      sub: 'Each depot raises every stockpile cap. Cheap, and always the right call.',
      value: String(Object.values(state.silo.rooms).filter((r) => r.type === 'storage_depot').length),
    })
  );
}

// ----------------------------------------------------------------- power ---

function renderPower(state, body, shell) {
  const gen = state.power?.generation || 0;
  const ids = orderedRoomIds(state, Object.keys(state.silo.rooms));

  body.appendChild(
    el(
      'div.grid-3',
      tile('Generation', Math.round(gen), gen > 0 ? 'good' : 'bad'),
      tile('Demand', Math.round(state.power?.demand || 0)),
      tile('Battery', Math.round(state.resources.power || 0), state.resources.power > 20 ? '' : 'warn')
    )
  );

  body.appendChild(
    el(
      'div.section-label',
      'Priority — drag to reorder. When generation runs short, rooms shut off from the bottom up.'
    )
  );

  // Walk the list accumulating draw so we can show the exact cut line.
  let budget = gen + Math.min(state.resources.power || 0, BAL.power.batteryDischargePerCycle);
  let cutShown = false;
  const list = el('ul.priority-list');

  for (const id of ids) {
    const room = state.silo.rooms[id];
    const def = getRoom(room.type);
    if (!def) continue;
    const isGen = !!def.produces?.power;
    const cap = roomCapability(state, room);
    const draw = isGen ? 0 : roomDraw(state, room, cap);

    let willRun = true;
    if (!isGen) {
      if (draw <= budget) budget -= draw;
      else willRun = false;
    }

    if (!willRun && !cutShown) {
      cutShown = true;
      list.appendChild(
        el(
          'li.cutline',
          el('span.cutline-label', 'GENERATION RUNS OUT HERE'),
          el('span.cutline-rule')
        )
      );
    }

    list.appendChild(
      el(
        'li.priority-row' + (willRun ? '' : '.dark'),
        { dataset: { reorderItem: id } },
        el('span.grip', { dataset: { reorderHandle: '' }, 'aria-hidden': 'true' }, '⠿'),
        el(
          'span.priority-main',
          el('span.priority-name', def.name),
          el('span.priority-sub', `Floor ${room.floor}` + (isGen ? '  ·  source' : ''))
        ),
        el('span.priority-draw.mono', isGen ? `+${Math.round(def.produces.power * cap)}` : `−${draw.toFixed(1)}`)
      )
    );
  }

  if (!ids.length) body.appendChild(emptyState('Nothing built yet.'));
  else body.appendChild(list);

  makeReorderable(list, (order) => {
    const clean = order.filter(Boolean);
    shell.store.dispatch({ type: 'SET_POWER_PRIORITY', order: clean });
    toast('Power priority updated.');
  });

  body.appendChild(
    el(
      'div.note',
      'Life support first is the safe default. Moving the water reclaimer down is how silos die.'
    )
  );
}

// ------------------------------------------------------------------- air ---

function renderAir(state, body) {
  const q = state.air.quality;
  const cls = q < BAL.air.massCasualtyBelow ? 'bad' : q < BAL.air.healthDecayBelow ? 'warn' : 'good';
  body.appendChild(
    el(
      'div.grid-3',
      tile('Quality', Math.round(q), cls),
      tile('Capacity', Math.round(state.air.capacity)),
      tile('Residents', Math.round(state.air.load))
    )
  );
  body.appendChild(el('div.pad', meter(q, 100, cls)));

  const headroom = Math.floor(state.air.capacity - state.air.load);
  body.appendChild(
    row({
      title: 'Population headroom',
      sub:
        headroom > 0
          ? `Filtration supports ${headroom} more resident${headroom === 1 ? '' : 's'} at full quality.`
          : `Filtration is ${-headroom} short. Build another bay or the air keeps falling.`,
      value: (headroom > 0 ? '+' : '') + headroom,
    })
  );
  if (q < BAL.air.healthDecayBelow) {
    body.appendChild(
      el(
        'div.note.warn',
        `Air quality cannot support ${Math.round(state.air.load)} residents. ` +
          'Build another Filtration bay or reduce population.'
      )
    );
  }
}

function tile(k, v, cls = '') {
  return el('div.stat-tile', el('div.k', k), el('div.v' + (cls ? '.' + cls : ''), String(v)));
}

export default resourcesPanel;
