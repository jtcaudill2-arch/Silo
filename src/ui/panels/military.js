/**
 * military.js — squads, loadouts, training, readiness.
 *
 * The panel leads with what a standing army costs per day, because that cost
 * is the whole strategic tension of the militarist path (spec §10) and it is
 * otherwise invisible until the food runs out.
 */

import { BAL } from '../../config/balance.js';
import { getItem, itemsOfKind } from '../../data/items.js';
import { fullName, topSkill } from '../../sim/population.js';
import {
  readiness, squadMembers, formSquad, craft, canCraft, craftableItems,
  equipBest, militarySummary, unassignedGear, gearStorageCap,
} from '../../sim/military.js';
import { employableCitizens } from '../../sim/jobs.js';
import { portraitCanvas } from '../../render/portraits.js';
import { openCitizen } from '../citizenCard.js';
import { el, button, row, sectionLabel, emptyState, meter, chip, toast, modal, humanise, fmtDelta } from '../dom.js';

const ASSIGNMENTS = [
  { id: 'garrison', label: 'Garrison', desc: 'Adds Order and defends the silo.' },
  { id: 'training', label: 'Training', desc: 'Grows combat skill. Costs ammunition.' },
];

let tab = 'squads';

export const militaryPanel = {
  id: 'military',
  title: 'Military',
  nav: 'Squads',
  glyph: '⚔',
  subtitle: (s) => `${militarySummary(s).soldiers}`,

  locked(state) {
    const hasArmory = Object.values(state.silo.rooms).some((r) => r.type === 'armory' || r.type === 'barracks');
    if (hasArmory || state.military.squadIds.length) return null;
    return 'Build an Armory or Barracks first.';
  },

  render(state, shell) {
    const body = el('div.panel-body');
    const sum = militarySummary(state);

    body.appendChild(
      el(
        'div.grid-3',
        tile('Soldiers', sum.soldiers),
        tile('Squads', `${sum.squads}/${BAL.military.maxSquads}`),
        tile('Ammunition', Math.round(state.resources.ammo), state.resources.ammo < 60 ? 'bad' : '')
      )
    );
    if (sum.soldiers > 0) {
      body.appendChild(
        el(
          'div.note',
          `A standing army eats: ${sum.foodPerDay.toFixed(1)} food and ` +
            `${sum.chitsPerDay.toFixed(1)} chits a day, and ${sum.soldiers} ` +
            `${sum.soldiers === 1 ? 'body is' : 'bodies are'} not in hydroponics.`
        )
      );
    }

    const tabs = el(
      'div.tabs',
      tabBtn('squads', 'Squads', shell),
      tabBtn('armory', 'Armory', shell)
    );

    if (tab === 'squads') renderSquads(state, body, shell);
    else renderArmory(state, body, shell);

    return el('div', { style: { display: 'contents' } }, tabs, body);
  },
};

function tabBtn(id, label, shell) {
  return el(
    'button.tab' + (tab === id ? '.active' : ''),
    { type: 'button', onclick: () => { tab = id; shell.renderPanel(true); } },
    label
  );
}

// ---------------------------------------------------------------- squads ---

function renderSquads(state, body, shell) {
  if (!state.military.squadIds.length) {
    body.appendChild(emptyState('No squads. Nothing leaves the silo without one.'));
  }

  for (const id of state.military.squadIds) {
    const sq = state.military.squads[id];
    const members = squadMembers(state, id);
    const ready = readiness(state, id);
    const cls = ready > 0.6 ? 'good' : ready > 0.35 ? '' : 'bad';

    body.appendChild(
      el(
        'div.squad',
        el(
          'div.squad-head',
          el('div.squad-name', sq.name),
          sq.deployed ? chip('outside', 'warn') : chip(sq.assignment),
          el('div.squad-count.mono', `${members.length}/${BAL.military.squadMax}`)
        ),
        el(
          'div.squad-ready',
          el('span.squad-ready-k', 'Readiness'),
          meter(ready * 100, 100, cls),
          el('span.squad-ready-v.mono', Math.round(ready * 100) + '%')
        ),
        el(
          'div.squad-members',
          ...members.map((c) => {
            const p = portraitCanvas(c, 2);
            p.className = 'portrait-sm';
            return el(
              'button.squad-member',
              { type: 'button', onclick: () => openCitizen(shell.store, c.id, {}) },
              p,
              el('span.squad-member-name', c.firstName),
              el('span.squad-member-gear.mono', gearGlyphs(state, c))
            );
          }),
          members.length < BAL.military.squadMax && !sq.deployed
            ? el(
                'button.squad-add',
                { type: 'button', onclick: () => pickSoldier(state, shell, id) },
                '+'
              )
            : null
        ),
        sq.deployed
          ? el('div.note', 'On the surface. Nothing to do but wait.')
          : el(
              'div.squad-actions',
              ...ASSIGNMENTS.map((a) =>
                button(a.label, {
                  class: sq.assignment === a.id ? 'primary sm' : 'sm',
                  title: a.desc,
                  onclick: () => {
                    shell.store.dispatch({ type: 'SQUAD_PATCH', id, patch: { assignment: a.id } });
                    shell.renderPanel(true);
                  },
                })
              ),
              button('Equip all', {
                class: 'sm',
                onclick: () => {
                  let n = 0;
                  for (const c of members) {
                    const acts = equipBest(shell.store.state, c.id);
                    n += acts.length;
                    shell.store.dispatchAll(acts);
                  }
                  toast(n ? `${n} pieces issued.` : 'Nothing spare in the armoury.');
                  shell.renderPanel(true);
                },
              }),
              button('Disband', {
                class: 'sm danger',
                onclick: () => {
                  shell.store.dispatch({ type: 'SQUAD_DISBAND', id });
                  toast(`${sq.name} disbanded.`);
                  shell.renderPanel(true);
                },
              })
            )
      )
    );
  }

  if (state.military.squadIds.length < BAL.military.maxSquads) {
    body.appendChild(
      el(
        'div.pad',
        button('Form a squad', {
          class: 'primary wide',
          onclick: () => {
            shell.store.dispatchAll(formSquad(shell.store.state));
            shell.renderPanel(true);
          },
        })
      )
    );
  }
}

function gearGlyphs(state, c) {
  const g = c.gear || {};
  const t = (id) => (id ? getItem(state.military.gear[id]?.item)?.tier ?? '?' : '·');
  return `${t(g.weapon)}${t(g.armor)}${t(g.suit)}`;
}

function pickSoldier(state, shell, squadId) {
  const pool = employableCitizens(state)
    .filter((c) => c.squadId == null && c.age >= 16)
    .sort((a, b) => (b.skills.combat || 0) - (a.skills.combat || 0))
    .slice(0, 60);

  const body = el('div');
  body.appendChild(
    el('div.note', 'Anyone posted to a squad leaves their job. A soldier is a body not in hydroponics.')
  );
  if (!pool.length) body.appendChild(emptyState('Nobody available.'));
  for (const c of pool) {
    const top = topSkill(c);
    body.appendChild(
      row({
        title: fullName(c),
        sub:
          `combat ${Math.round(c.skills.combat || 0)}  ·  str ${c.stats.str} agi ${c.stats.agi}  ·  ` +
          `best: ${humanise(top.skill)} ${Math.round(top.value)}`,
        value: Math.round(c.health),
        onclick: () => {
          shell.store.dispatch({ type: 'SQUAD_MEMBER', squadId, citizenId: c.id });
          shell.store.dispatchAll(equipBest(shell.store.state, c.id));
          h.close();
          shell.renderPanel(true);
        },
      })
    );
  }
  const h = modal({ title: 'Post to the squad', body, actions: [button('Cancel', { onclick: () => h.close() })] });
}

// ---------------------------------------------------------------- armory ---

function renderArmory(state, body, shell) {
  const cap = gearStorageCap(state);
  const held = Object.keys(state.military.gear).length;

  body.appendChild(
    el(
      'div.grid-3',
      tile('Racked', `${held}${cap ? `/${cap}` : ''}`, cap && held >= cap ? 'bad' : ''),
      tile('Spare', unassignedGear(state).length),
      tile('Alloy', Math.round(state.resources.alloy))
    )
  );

  for (const kind of ['weapon', 'armor', 'suit']) {
    body.appendChild(sectionLabel(kind === 'armor' ? 'Armour' : kind === 'suit' ? 'Env-suits' : 'Weapons'));
    const craftable = craftableItems(state).filter((i) => i.kind === kind);
    const all = itemsOfKind(kind);

    for (const item of all) {
      const owned = Object.values(state.military.gear).filter((g) => g.item === item.id);
      const spare = owned.filter((g) => !g.assignedTo).length;
      const check = canCraft(state, item.id);
      const unlocked = craftable.some((c) => c.id === item.id);

      body.appendChild(
        el(
          'button.gear-row' + (unlocked ? '' : '.locked'),
          {
            type: 'button',
            disabled: !check.ok,
            onclick: () => {
              shell.store.dispatchAll(craft(shell.store.state, item.id));
              shell.renderPanel(true);
            },
          },
          el(
            'div.gear-main',
            el('div.gear-name', `${item.name} `, chip(`T${item.tier}`)),
            el('div.gear-desc', item.desc),
            el(
              'div.gear-meta',
              chip(Object.entries(item.craft).map(([k, v]) => `${v} ${k}`).join(', ')),
              owned.length ? chip(`${owned.length} racked, ${spare} spare`, spare ? 'good' : '') : null
            ),
            !check.ok ? el('div.gear-why', check.reason) : null
          ),
          check.ok ? el('div.row-chevron', '+') : null
        )
      );
    }
  }
}

function tile(k, v, cls = '') {
  return el('div.stat-tile', el('div.k', k), el('div.v' + (cls ? '.' + cls : ''), String(v)));
}

export default militaryPanel;
