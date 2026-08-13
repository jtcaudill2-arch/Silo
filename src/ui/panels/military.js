/**
 * military.js — squads, loadouts, training, readiness.
 *
 * The panel leads with what a standing army costs per day, because that cost
 * is the whole strategic tension of the militarist path (spec §10) and it is
 * otherwise invisible until the food runs out.
 */

import { BAL } from '../../config/balance.js';
import { getItem, itemsOfKind, allOfKind } from '../../data/items.js';
import { fullName, topSkill } from '../../sim/population.js';
import {
  readiness, squadMembers, formSquad, craft, canCraft, craftableItems,
  equipBest, militarySummary, unassignedGear, gearStorageCap,
} from '../../sim/military.js';
import { employableCitizens } from '../../sim/jobs.js';
import { lockReason } from '../../sim/unlocks.js';
import { portraitCanvas } from '../../render/portraits.js';
import { frameCanvas } from '../../render/sprites.js';
import { openCitizen } from '../citizenCard.js';
import { el, button, row, sectionLabel, emptyState, meter, chip, toast, modal, humanise, fmtDelta } from '../dom.js';

const ASSIGNMENTS = [
  // What this button actually does, which it did not say. `world.js` decides
  // which holdings are held by counting garrison squads that are not
  // deployed and assigning them to satellites in list order, and
  // `military.js` takes the satellite count off the top of the home-presence
  // bonus — so the moment you take your first silo, this stops paying the
  // Order it advertised, silently, with the copy unchanged.
  { id: 'garrison', label: 'Garrison', desc: 'Holds a conquered silo, or adds Order at home if there is none to hold.' },
  { id: 'training', label: 'Training', desc: 'Grows combat skill. Costs ammunition.' },
];

let tab = 'squads';

export const militaryPanel = {
  id: 'military',
  title: 'Military',
  nav: 'Squads',
  glyph: '⚔',
  subtitle: (s) => `${militarySummary(s).soldiers}`,

  // Fourth of the gated systems. It lands after the surface because that is
  // where the standing order sends you — the Armory is only asked for once
  // the Airlock and the Suit Bay are up. See sim/unlocks.js for the sequence.
  locked(state) {
    return lockReason(state, 'military');
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
          gearIcon(item),
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

    lootRows(state, body, kind);
  }
}

/**
 * The looted kit of a kind, listed under the ladder it does not belong to.
 *
 * `itemsOfKind` deliberately excludes anything with `loot: true`, because that
 * list is what the craft rows iterate and a looted piece has no `craft` block
 * to price — so without this, the six pieces a player can only take off a
 * conquered garrison, the Slag Crews or the Scar appeared NOWHERE in the
 * Armory. They were racked, they were issued by `equipBest`, they decided
 * fights, and the only place they were ever named was a tier digit on a squad
 * member's card.
 *
 * Nothing is shown until the player owns one: a row for kit they have never
 * seen is a spoiler and a tease, and the Armory is a list of what is in the
 * room. Once it is in the room it gets the same icon and the same tier strip
 * as everything else, so a Slag Autogun and a Magnetic Rifle can be compared
 * where the player actually chooses between them.
 */
function lootRows(state, body, kind) {
  for (const item of allOfKind(kind)) {
    if (!item.loot) continue;
    const owned = Object.values(state.military.gear).filter((g) => g.item === item.id);
    if (!owned.length) continue;
    const spare = owned.filter((g) => !g.assignedTo).length;

    body.appendChild(
      el(
        'div.gear-row.gear-found',
        gearIcon(item),
        el(
          'div.gear-main',
          el('div.gear-name', `${item.name} `, chip(`T${item.tier}`), chip('found', 'warn')),
          el('div.gear-desc', item.desc),
          el(
            'div.gear-meta',
            chip(`${owned.length} racked, ${spare} spare`, spare ? 'good' : ''),
            chip('not made here')
          )
        )
      )
    );
  }
}

/**
 * The icon for a piece of gear, cut out of the sprite atlas.
 *
 * The Armory is a list of eighteen rows of prose, and prose is the slowest
 * possible way to answer "which of these is better" — which is the only
 * question the screen is asked. tools/art/gear.mjs draws each item at 24x24
 * with its tier as a five-slot pip strip and its provenance as the pips'
 * colour, so the ranking and the "this came off a body in the Scar" both land
 * before a single word is read. See that file's header for the whole scheme.
 *
 * 2x, because the art is authored at 24 and the row is 72px tall: any
 * non-integer scale would resample a 1px keyline and turn every icon to mush.
 *
 * `frameCanvas` returns null when the atlas has not loaded or the frame does
 * not exist — a brand-new item somebody added to items.js without drawing it,
 * for instance — so this always returns SOMETHING of the same size. A missing
 * icon must not shift every row in the list.
 */
function gearIcon(item) {
  const c = frameCanvas(`gear_${item.id}`, 2);
  if (!c) return el('div.gear-icon.gear-icon-missing');
  c.className = 'gear-icon';
  return c;
}

function tile(k, v, cls = '') {
  return el('div.stat-tile', el('div.k', k), el('div.v' + (cls ? '.' + cls : ''), String(v)));
}

export default militaryPanel;
