/**
 * population.js — the roster.
 *
 * Sortable, filterable, and rendered as a windowed list: at 400+ residents,
 * building every row would stall the frame on a mid-range phone. Only the
 * rows near the viewport exist in the DOM at any moment.
 */

import { BAL } from '../../config/balance.js';
import { getRoom, SKILLS } from '../../data/rooms.js';
import { fullName, topSkill } from '../../sim/population.js';
import { employmentSummary, autoAssign } from '../../sim/jobs.js';
import { portraitCanvas } from '../../render/portraits.js';
import { openCitizen } from '../citizenCard.js';
import { el, clear, humanise, button, emptyState, toast, chip } from '../dom.js';

const ROW_H = 56;
const OVERSCAN = 6;

const SORTS = [
  { id: 'name', label: 'Name', fn: (a, b) => fullName(a).localeCompare(fullName(b)) },
  { id: 'age', label: 'Age', fn: (a, b) => b.age - a.age },
  { id: 'skill', label: 'Best skill', fn: (a, b) => topSkill(b).value - topSkill(a).value },
  { id: 'health', label: 'Health', fn: (a, b) => a.health - b.health },
  { id: 'morale', label: 'Morale', fn: (a, b) => a.morale - b.morale },
  { id: 'rad', label: 'Radiation', fn: (a, b) => b.radiation - a.radiation },
];

const FILTERS = [
  { id: 'all', label: 'All', fn: () => true },
  { id: 'idle', label: 'Idle', fn: (c) => c.status === 'idle' && c.age >= BAL.citizens.workingAgeMin },
  { id: 'working', label: 'Posted', fn: (c) => c.status === 'working' },
  { id: 'hurt', label: 'At risk', fn: (c) => c.health < 60 || c.radiation >= 30 || c.morale < 30 },
  { id: 'young', label: 'Children', fn: (c) => c.age < BAL.citizens.workingAgeMin },
  { id: 'old', label: 'Ageing', fn: (c) => c.vitality < 60 },
];

let sort = 'name';
let filter = 'all';
let query = '';

export const populationPanel = {
  id: 'population',
  title: 'Residents',
  nav: 'People',
  glyph: '☖',
  subtitle: (s) => `${s.citizenIds.length}`,

  render(state, shell) {
    const emp = employmentSummary(state);

    const head = el(
      'div.roster-head',
      el(
        'div.roster-stats',
        stat('Residents', state.citizenIds.length),
        stat('Posted', emp.working, emp.working > 0 ? 'good' : ''),
        stat('Idle', emp.idle, emp.idle > 20 ? 'warn' : ''),
        stat('Open posts', emp.open, emp.open > 0 ? 'warn' : 'good')
      ),
      el(
        'div.roster-controls',
        el('input.roster-search', {
          type: 'search',
          // A placeholder is not an accessible name — it disappears the
          // moment anybody types, and screen readers are not required to
          // announce it at all.
          'aria-label': 'Search the roster by name',
          placeholder: 'Find a name…',
          value: query,
          oninput: (e) => {
            query = e.target.value;
            rebuild();
          },
        }),
        button('Auto-assign', {
          class: 'sm',
          title: 'Fills open posts by skill. Ignores morale and who works well together — hand-tuning still beats it.',
          onclick: () => {
            const actions = autoAssign(state);
            if (!actions.length) {
              toast('Nothing to assign.');
              return;
            }
            shell.store.dispatchAll(actions);
            toast(`${actions.length} resident${actions.length === 1 ? '' : 's'} posted.`);
            shell.renderPanel(true);
          },
        })
      ),
      el('div.chip-row', ...FILTERS.map((f) => filterChip(f, shell))),
      el(
        'div.chip-row',
        el('span.chip-label', 'Sort'),
        ...SORTS.map((s) =>
          el(
            'button.chip' + (sort === s.id ? '.warn' : ''),
            {
              type: 'button',
              onclick: () => {
                sort = s.id;
                shell.renderPanel(true);
              },
            },
            s.label
          )
        )
      )
    );

    const body = el('div.panel-body.roster-body');
    const spacer = el('div.roster-spacer');
    const viewport = el('div.roster-viewport');
    body.appendChild(spacer);
    spacer.appendChild(viewport);

    let list = [];
    function rebuild() {
      const f = FILTERS.find((x) => x.id === filter) || FILTERS[0];
      const s = SORTS.find((x) => x.id === sort) || SORTS[0];
      const q = query.trim().toLowerCase();
      list = state.citizenIds
        .map((id) => state.citizens[id])
        .filter((c) => c && c.status !== 'dead' && f.fn(c) && (!q || fullName(c).toLowerCase().includes(q)))
        .sort(s.fn);
      spacer.style.height = `${list.length * ROW_H}px`;
      draw();
    }

    function draw() {
      const top = body.scrollTop;
      const height = body.clientHeight || 600;
      const from = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
      const to = Math.min(list.length, Math.ceil((top + height) / ROW_H) + OVERSCAN);
      clear(viewport);
      viewport.style.transform = `translateY(${from * ROW_H}px)`;
      for (let i = from; i < to; i++) {
        viewport.appendChild(rosterRow(state, list[i], shell));
      }
      if (!list.length) {
        viewport.appendChild(emptyState(query ? `Nobody called "${query}".` : 'Nobody matches that filter.'));
      }
    }

    body.addEventListener('scroll', draw, { passive: true });
    rebuild();
    requestAnimationFrame(draw);

    return el('div', { style: { display: 'contents' } }, head, body);
  },
};

function filterChip(f, shell) {
  return el(
    'button.chip' + (filter === f.id ? '.warn' : ''),
    {
      type: 'button',
      onclick: () => {
        filter = f.id;
        shell.renderPanel(true);
      },
    },
    f.label
  );
}

function rosterRow(state, c, shell) {
  const room = c.job ? state.silo.rooms[c.job.roomId] : null;
  const def = room ? getRoom(room.type) : null;
  const top = topSkill(c);

  const flags = [];
  if (c.radiation >= BAL.citizens.radiation.sicknessThreshold) flags.push(chip(`rad ${Math.round(c.radiation)}`, 'rad'));
  else if (c.health < 50) flags.push(chip('hurt', 'bad'));
  if (c.morale < 25) flags.push(chip('low morale', 'bad'));
  if (c.status === 'idle' && c.age >= BAL.citizens.workingAgeMin) flags.push(chip('idle', 'warn'));
  if (c.pregnantUntilDay != null) flags.push(chip('expecting', 'good'));

  const portrait = portraitCanvas(c, 2);
  portrait.className = 'portrait-sm';

  return el(
    'button.roster-row',
    {
      type: 'button',
      onclick: () =>
        openCitizen(shell.store, c.id, {
          onOpenRoom: (roomId) => shell.onOpenRoom?.(roomId),
          onAssign: () => shell.open('population'),
        }),
    },
    portrait,
    el(
      'div.roster-main',
      el('div.roster-name', fullName(c)),
      el(
        'div.roster-sub',
        def
          ? `${def.name} · floor ${room.floor}`
          : c.status === 'school'
          ? 'In school'
          : c.age < BAL.citizens.workingAgeMin
          ? 'Child'
          : 'Unassigned'
      ),
      flags.length ? el('div.roster-flags', ...flags) : null
    ),
    el(
      'div.roster-right',
      el('div.roster-age.mono', Math.floor(c.age)),
      el('div.roster-skill', `${humanise(top.skill).slice(0, 4)} ${Math.round(top.value)}`)
    )
  );
}

function stat(k, v, cls = '') {
  return el('div.roster-stat', el('span.k', k), el('span.v.mono' + (cls ? '.' + cls : ''), String(v)));
}

export { SKILLS };
export default populationPanel;
