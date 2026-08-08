/**
 * log.js — chronological event history, and the shell for the ReturnReport.
 *
 * Newest last, like a real logbook: the player scrolls to the bottom to catch
 * up, which is also the reading order the catch-up report wants.
 */

import { el, emptyState, sectionLabel, meter } from '../dom.js';
import { endingProgress } from '../../sim/events.js';

const FILTERS = [
  { id: 'all', label: 'All' },
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
          el(
            'div.log-entry' + (e.kind ? '.' + e.kind : ''),
            el('div.log-when.mono', `${String(e.cycle % 8 || 0)}/8`),
            el('div.log-text', e.text)
          )
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

function matches(entry, f) {
  if (f === 'all') return true;
  if (f === 'death') return entry.kind === 'death';
  if (f === 'alert') return entry.kind === 'alert' || entry.kind === 'rad';
  if (f === 'radio') return entry.kind === 'radio' || entry.kind === 'diplomacy';
  return true;
}

export default logPanel;
