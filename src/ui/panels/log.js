/**
 * log.js — chronological event history, and the shell for the ReturnReport.
 *
 * Newest last, like a real logbook: the player scrolls to the bottom to catch
 * up, which is also the reading order the catch-up report wants.
 *
 * Two things it does beyond listing. Any entry that names a floor is a button
 * that takes the cross-section there — "the Hydroponics Bay on floor 5" is
 * only useful if you can get to floor 5 from the sentence that mentions it.
 * And the Changes tab is the shell's own account of what moved shift by
 * shift, which is a different document from this one: the log records
 * everything that happened, the account records what changed, and after two
 * hundred entries those stop being the same question.
 */

import { el, emptyState, sectionLabel, meter } from '../dom.js';
import { endingProgress } from '../../sim/events.js';
import { floorOfEntry } from '../shell.js';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'changes', label: 'Changes' },
  { id: 'death', label: 'Deaths' },
  { id: 'alert', label: 'Alerts' },
  { id: 'radio', label: 'Radio' },
  { id: 'ends', label: 'Ends' },
];

let filter = 'all';

export const logPanel = {
  id: 'log',
  title: 'Log',
  nav: 'Log',
  glyph: '☰',
  subtitle: (s) => `Y${s.clock.year} D${s.clock.day % 12}`,

  /** The shift report bar opens straight onto its own tab. */
  focusTab(id) {
    if (FILTERS.some((f) => f.id === id)) filter = id;
  },

  render(state, shell) {
    const body = el('div.panel-body');
    const tabs = el(
      'div.tabs',
      ...FILTERS.map((f) =>
        el(
          'button.tab' + (filter === f.id ? '.active' : ''),
          {
            type: 'button',
            onclick: () => {
              filter = f.id;
              if (f.id === 'changes') shell.unreadChanges = 0;
              shell.renderPanel(true);
            },
          },
          f.label
        )
      )
    );

    // The three ways out. Shown as requirements met, never as a walkthrough:
    // the player can see how far off each one is without being told the
    // route, which is the same thing the log does for everything else.
    if (filter === 'ends') {
      body.appendChild(
        el(
          'div.note',
          'Three ways this ends. None of them is a checklist you can grind — ' +
            'each needs something you can only get by going outside.'
        )
      );
      for (const e of endingProgress(state)) {
        body.appendChild(
          el(
            'div.ending-row',
            el('div.ending-row-head', el('span.k', e.name), el('span.v.mono', `${Math.round(e.progress * 100)}%`)),
            meter(e.progress, 1),
            el('div.ending-row-detail', e.detail)
          )
        );
      }
      return el('div', { style: { display: 'contents' } }, tabs, body);
    }

    if (filter === 'changes') {
      renderChanges(state, shell, body);
      return el('div', { style: { display: 'contents' } }, tabs, body);
    }

    const entries = state.log.filter((e) => matches(e, filter));
    if (!entries.length) {
      body.appendChild(emptyState('Nothing recorded yet.'));
    } else {
      let lastDay = null;
      for (const e of entries) {
        if (e.day !== lastDay) {
          lastDay = e.day;
          body.appendChild(sectionLabel(`Year ${Math.floor(e.day / 12)} · Day ${e.day % 12}`));
        }
        body.appendChild(
          logRow(shell, e, el('div.log-when.mono', `${String(e.cycle % 8 || 0)}/8`))
        );
      }
    }

    // Land at the newest entry, the way you'd open a logbook.
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });

    return el('div', { style: { display: 'contents' } }, tabs, body);
  },
};

/**
 * One entry. A floor in the text — or written onto the entry by whatever
 * logged it — turns the row into a button that goes there, and the room id,
 * where there is one, opens the room itself.
 */
function logRow(shell, entry, when) {
  const floor = floorOfEntry(entry);
  const roomId = entry?.data?.roomId;
  const kind = entry.kind ? '.' + entry.kind : '';
  if (floor == null) {
    return el('div.log-entry' + kind, when, el('div.log-text', entry.text));
  }
  return el(
    'button.log-entry' + kind,
    {
      type: 'button',
      'aria-label': `${entry.text} — go to floor ${floor}`,
      onclick: () => {
        if (roomId && shell.state.silo.rooms[roomId]) shell.onOpenRoom?.(roomId);
        else {
          shell.focusFloor(floor);
          shell.close();
        }
      },
    },
    when,
    el('div.log-text', entry.text),
    el('span.log-where.mono', `FL ${floor}`)
  );
}

/**
 * The shift-by-shift account. Held in the shell rather than in state: it is
 * what happened while you were watching, so it starts empty on a reload and
 * says so, and it never has to be migrated.
 */
function renderChanges(state, shell, body) {
  const changes = shell.changes || [];
  body.appendChild(
    el(
      'div.note',
      'What moved, shift by shift, since this silo was opened. The record ' +
        'proper is on the All tab; this is only what changed.'
    )
  );
  if (!changes.length) {
    body.appendChild(emptyState('Nothing has changed since you opened the silo.'));
    return;
  }
  let lastDay = null;
  for (const c of changes) {
    if (c.day !== lastDay) {
      lastDay = c.day;
      body.appendChild(sectionLabel(`Year ${Math.floor(c.day / 12)} · Day ${c.day % 12}`));
    }
    const when = el('div.log-when.mono', `${String(c.cycle % 8 || 0)}/8`);
    const tone = TONE[c.kind] || 'change';
    if (c.floor != null) {
      body.appendChild(
        el(
          'button.log-entry.' + tone,
          {
            type: 'button',
            'aria-label': `${c.text} — go to floor ${c.floor}`,
            onclick: () => {
              if (c.roomId && shell.state.silo.rooms[c.roomId]) shell.onOpenRoom?.(c.roomId);
              else {
                shell.focusFloor(c.floor);
                shell.close();
              }
            },
          },
          when,
          el('div.log-text', c.text),
          el('span.log-where.mono', `FL ${c.floor}`)
        )
      );
    } else if (c.res || c.panel) {
      body.appendChild(
        el(
          'button.log-entry.' + tone,
          {
            type: 'button',
            onclick: () => {
              if (c.res) shell.openResource(c.res);
              else shell.open(c.panel);
            },
          },
          when,
          el('div.log-text', c.text),
          el('span.log-where.mono', c.res ? 'STORES' : 'OPEN')
        )
      );
    } else {
      body.appendChild(el('div.log-entry.' + tone, when, el('div.log-text', c.text)));
    }
  }
  requestAnimationFrame(() => {
    body.scrollTop = body.scrollHeight;
  });
}

/** Change kinds reuse the log's own left-edge colours. */
const TONE = {
  death: 'death',
  birth: 'birth',
  lost: 'death',
  brownout: 'alert',
  turned_down: 'alert',
  turned_up: 'birth',
  unlock: 'birth',
  online: 'alert',
};

function matches(entry, f) {
  if (f === 'all') return true;
  if (f === 'death') return entry.kind === 'death';
  if (f === 'alert') return entry.kind === 'alert' || entry.kind === 'rad';
  if (f === 'radio') return entry.kind === 'radio' || entry.kind === 'diplomacy';
  return true;
}

export default logPanel;
