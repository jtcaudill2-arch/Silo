/**
 * resources.js — the ledger, and the power priority list.
 *
 * The priority list is the best decision moment in the early game (spec §5),
 * so it gets the real treatment: drag to reorder, a live cut-line showing
 * exactly where generation runs out, and the rooms below it drawn as already
 * dark. The player should be able to see the consequence before committing.
 *
 * The ledger's job is narrower and was not being done: a stockpile row said
 * what the figure was and which way it was going, and nothing at all about
 * why. A player watching water fall could read "−3.4 per cycle" all day
 * without learning that one of their two reclaimers is unstaffed. So every
 * row opens: what makes it, what spends it, at what rate, on which floor —
 * and every line in that list takes the cross-section to the room it names.
 */

import { BAL } from '../../config/balance.js';
import { el, fmt, fmtDelta, row, sectionLabel, meter, emptyState, makeReorderable, toast } from '../dom.js';
import { getRoom } from '../../data/rooms.js';
import { RES_KEYS, orderedRoomIds, roomCapability, roomDraw } from '../../sim/economy.js';
import { effects as researchEffects } from '../../sim/research.js';
import { liveResourceKeys } from '../../sim/unlocks.js';

const LABELS = {
  power: 'Power', water: 'Water', food: 'Food', meds: 'Meds', scrap: 'Scrap',
  alloy: 'Alloy', ammo: 'Ammunition', chits: 'Chits', filters: 'Filters',
  parts: 'Parts', fuel: 'Fuel', ore: 'Ore', coolant: 'Coolant',
};

/** Research that multiplies a yield, by the resource it multiplies. */
const YIELD_KEY = { food: 'foodYield', water: 'waterYield', alloy: 'alloyYield' };

let tab = 'ledger';
/** Which stockpile is currently opened onto its own causes. */
let opened = null;
/** Are the stockpiles the strip is still hiding folded away? They start so. */
let restOpen = false;

export const resourcesPanel = {
  id: 'resources',
  title: 'Stores',
  nav: 'Stores',
  glyph: '▤',
  subtitle: (s) => `${Math.round(s.power?.generation || 0)} / ${Math.round(s.power?.demand || 0)} PWR`,

  /** Tapping a counter in the top strip opens that counter's own answer. */
  focusResource(key) {
    tab = 'ledger';
    opened = key;
  },

  render(state, shell) {
    const body = el('div.panel-body');
    const tabs = el(
      'div.tabs',
      tabBtn('ledger', 'Ledger', shell),
      tabBtn('power', 'Power priority', shell),
      tabBtn('air', 'Atmosphere', shell)
    );

    if (tab === 'ledger') renderLedger(state, body, shell);
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

function renderLedger(state, body, shell) {
  // The same set the top strip is showing, plus whichever row the player has
  // opened. The strip spends the whole early game hiding eight of eleven
  // counters on the grounds that a figure you cannot act on teaches you to
  // stop reading the strip — and then tapping any counter opened this list
  // with all eleven on it, which undid the lot in one tap. A resource the
  // silo has no way to spend or replace is not more interesting one panel
  // deeper; the rest fold in behind a line, the same way the catalogue's
  // locked rooms do.
  const live = liveResourceKeys(state);
  const shown = [];
  const hidden = [];
  for (const key of RES_KEYS) {
    const amount = state.resources[key] || 0;
    const flow = state.flows?.[key];
    // Skip resources the silo has never seen and isn't producing — the
    // ledger shouldn't teach the player about coolant on day one.
    if (amount === 0 && !flow?.in && !flow?.out && key !== 'power' && key !== opened) continue;
    (live.has(key) || key === opened ? shown : hidden).push(key);
  }

  body.appendChild(sectionLabel('Stockpiles — tap one for what moves it'));
  for (const key of shown) body.appendChild(ledgerRow(state, key, shell));
  if (hidden.length) {
    body.appendChild(
      el(
        'button.row.tappable',
        {
          type: 'button',
          'aria-expanded': restOpen ? 'true' : 'false',
          onclick: () => {
            restOpen = !restOpen;
            shell.renderPanel(true);
          },
        },
        el(
          'div.row-main',
          el('div.row-title', `${hidden.length} more the silo is holding`),
          el(
            'div.row-sub',
            'Nothing produces or spends these yet. They appear on the strip when something does.'
          )
        ),
        el('div.row-chevron', restOpen ? '⌄' : '›')
      )
    );
    if (restOpen) for (const key of hidden) body.appendChild(ledgerRow(state, key, shell));
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

/** One stockpile: the figure, the flow, the runway, and what moves it. */
function ledgerRow(state, key, shell) {
  const amount = state.resources[key] || 0;
  const cap = state.caps?.[key] ?? Infinity;
  const flow = state.flows?.[key];
  const net = flow ? flow.in - flow.out : 0;

  const perDay = net * BAL.time.CYCLES_PER_DAY;
  const runway = net < 0 && amount > 0 ? amount / -perDay : null;
  const isOpen = opened === key;

  const node = el(
      'button.row.tappable',
      {
        type: 'button',
        'aria-expanded': isOpen ? 'true' : 'false',
        onclick: () => {
          opened = isOpen ? null : key;
          shell.renderPanel(true);
        },
      },
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
      ),
    el('div.row-chevron', isOpen ? '⌄' : '›')
  );
  if (runway != null && runway < 2) node.classList.add('critical');
  if (!isOpen) return node;
  // The breakdown is a sibling rather than a child: the row is a <button> and
  // the breakdown is full of buttons of its own.
  return el('div', { style: { display: 'contents' } }, node, explainResource(state, key, shell));
}

// ------------------------------------------------------ why a figure moves ---

/**
 * What is making this, what is spending it, and what that leaves.
 *
 * The totals are the economy's own — `state.flows` is what it actually
 * charged last cycle, so the headline is never an estimate. The per-room
 * lines are worked from the same inputs the economy uses (base rate ×
 * capability, which already folds in crew, condition, level and merge width),
 * and anything the rooms do not account for is shown as its own line rather
 * than quietly dropped: for food and water that residue is the population,
 * which is the whole answer most of the time.
 */
function explainResource(state, key, shell) {
  const flow = state.flows?.[key] || { in: 0, out: 0 };
  const net = flow.in - flow.out;
  const amount = state.resources[key] || 0;
  const label = LABELS[key] || key;
  const yieldMult = 1 + (researchEffects(state)[YIELD_KEY[key]] || 0);

  const makes = [];
  const spends = [];
  for (const room of Object.values(state.silo.rooms)) {
    const def = getRoom(room.type);
    if (!def) continue;
    const building = room.buildingUntilCycle > 0;
    const cap = roomCapability(state, room);
    const live = !building && !!room.powered && cap > 0;
    const makesPower = !!def.produces?.power;

    if (def.produces?.[key]) {
      makes.push({
        room,
        def,
        // A generator is throttled to the load, so its plate figure is a
        // ceiling rather than a reading. Everything else runs flat out.
        rate: def.produces[key] * cap * (key === 'power' ? 1 : yieldMult),
        cap: key === 'power',
        live,
        building,
      });
    }
    if (key === 'power') {
      if (makesPower) continue;
      const draw = roomDraw(state, room, cap);
      if (draw > 0) spends.push({ room, def, rate: draw, live: !!room.powered, building });
    } else if (def.consumes?.[key]) {
      // Fuel and coolant in a generator hall are charged against the load,
      // not against capability, but the room is still the thing burning it.
      spends.push({ room, def, rate: def.consumes[key] * cap, live, building });
    }
  }
  makes.sort((a, b) => b.rate - a.rate);
  spends.sort((a, b) => b.rate - a.rate);

  const wrap = el('div.res-why');

  // ---- the arithmetic, in a sentence -------------------------------------
  const days = net < 0 && amount > 0 ? amount / (-net * BAL.time.CYCLES_PER_DAY) : null;
  let verdict;
  if (days != null) {
    verdict =
      ` At that rate the ${Math.round(amount)} in store lasts ` +
      `${days < 1 ? 'less than a day' : `about ${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'}`}.`;
  } else if (net < -0.05) {
    verdict = ' The store is already empty — whatever arrives is spent as it lands.';
  } else if (net > 0.05) {
    verdict = ' The store is growing.';
  } else {
    verdict = ' The store is holding.';
  }
  wrap.appendChild(
    el(
      'div.why-head',
      el('span.k', 'Per shift: '),
      `${flow.in.toFixed(1)} in, ${flow.out.toFixed(1)} out. `,
      el('span', { class: net > 0.05 ? 'res-delta up' : net < -0.05 ? 'res-delta down' : '' }, `Net ${fmtDelta(net)}.`),
      verdict
    )
  );

  // ---- who makes it -------------------------------------------------------
  wrap.appendChild(el('div.why-group', 'Making it'));
  if (!makes.length) {
    wrap.appendChild(
      el(
        'div.why-none',
        key === 'chits'
          ? 'No room makes chits. They come from trade and from what expeditions carry home.'
          : `Nothing in the silo makes ${label.toLowerCase()}. Everything in store came in from outside.`
      )
    );
  } else {
    const shown = makes.slice(0, BAL.legibility.resourceRoomsShown);
    for (const m of shown) wrap.appendChild(whyLine(shell, m, '+'));
    if (makes.length > shown.length) {
      wrap.appendChild(el('div.why-none', `…and ${makes.length - shown.length} more.`));
    }
  }
  const madeBy = makes.reduce((sum, m) => sum + (m.live ? m.rate : 0), 0);
  if (flow.in - madeBy > 0.05 && makes.length) {
    wrap.appendChild(otherLine(`Carried in, traded or salvaged`, flow.in - madeBy, '+'));
  }

  // ---- who spends it ------------------------------------------------------
  wrap.appendChild(el('div.why-group', 'Spending it'));
  const shownSpends = spends.slice(0, BAL.legibility.resourceRoomsShown);
  for (const s of shownSpends) wrap.appendChild(whyLine(shell, s, '−'));
  if (spends.length > shownSpends.length) {
    wrap.appendChild(el('div.why-none', `…and ${spends.length - shownSpends.length} more.`));
  }
  const spentBy = spends.reduce((sum, s) => sum + (s.live ? s.rate : 0), 0);
  const residue = flow.out - spentBy;
  if (residue > 0.05) {
    const pop = state.citizenIds.length;
    wrap.appendChild(
      otherLine(
        key === 'food' || key === 'water'
          ? `${pop} resident${pop === 1 ? '' : 's'}, eating and drinking`
          : 'Everything else drawing on it',
        residue,
        '−'
      )
    );
  } else if (!spends.length) {
    wrap.appendChild(el('div.why-none', 'Nothing is drawing on it.'));
  }

  return wrap;
}

/** One room's contribution, and a way to go and look at it. */
function whyLine(shell, entry, sign) {
  const { room, def, rate, live, building } = entry;
  const state = shell.state;
  const why = building
    ? 'Still under construction.'
    : !room.powered
      ? 'No power — it is below the cut line.'
      : !live
        ? 'Unstaffed, or stopped. It is producing nothing.'
        : null;
  return el(
    'button.why-line',
    {
      type: 'button',
      'aria-label': `${def.name}, floor ${room.floor}`,
      onclick: () => {
        if (state.silo.rooms[room.id]) shell.onOpenRoom?.(room.id);
        else {
          shell.focusFloor(room.floor);
          shell.close();
        }
      },
    },
    el(
      'div.why-main',
      el('div.why-name', def.name),
      el('div.why-sub', `Floor ${room.floor}${why ? ' · ' + why : ''}`)
    ),
    el(
      'span.why-rate.mono' + (live ? (sign === '+' ? '.up' : '.down') : ''),
      live ? `${entry.cap ? 'up to ' : ''}${sign}${rate.toFixed(1)}` : '—'
    )
  );
}

/** A contribution with no room behind it: people, trade, the surface. */
function otherLine(text, rate, sign) {
  return el(
    'div.why-line',
    el('div.why-main', el('div.why-name', text)),
    el('span.why-rate.mono' + (sign === '+' ? '.up' : '.down'), `${sign}${rate.toFixed(1)}`)
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
