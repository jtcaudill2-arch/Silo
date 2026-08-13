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
  equipBest, militarySummary, unassignedGear, gearStorageCap, squadCap,
} from '../../sim/military.js';
import { employableCitizens } from '../../sim/jobs.js';
import { lockReason } from '../../sim/unlocks.js';
import { DOCTRINES, NODE_LIST as DOCTRINE_NODES } from '../../data/doctrine.js';
import { ledger, spent as doctrineSpent, has as doctrineHas } from '../../sim/doctrine.js';
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
      tabBtn('armory', 'Armory', shell),
      tabBtn('doctrine', 'Doctrine', shell)
    );

    if (tab === 'squads') renderSquads(state, body, shell);
    else if (tab === 'doctrine') renderDoctrine(state, body, shell);
    else renderArmory(state, body, shell);

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
        // Scroll position persisted across tabs, so switching from a
        // scrolled Armory into Doctrine landed you mid-tree, past the
        // commendation counter and past the only explanation of how they
        // are earned. Every tab change was a random landing.
        const b = document.querySelector('.panel-body');
        if (b) b.scrollTop = 0;
      },
    },
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
          // Spearhead pays a party of four or fewer, and the natural thing a
          // player does — upgrade the airlock, take more people — silently
          // switches off a talent they spent twelve commendations on. The
          // condition is in the node's description; the moment it stops
          // applying is not, and that is the half that matters.
          doctrineHas(state, 'spearhead')
            ? chip(
                members.length <= BAL.combat.spearheadMaxParty ? 'spearhead' : 'over strength',
                members.length <= BAL.combat.spearheadMaxParty ? 'good' : 'warn'
              )
            : null,
          el('div.squad-count.mono', `${members.length}/${squadCap(state)}`)
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
              { type: 'button', onclick: () => openLoadout(shell, c.id) },
              p,
              el('span.squad-member-name', c.firstName),
              el('span.squad-member-gear.mono', gearGlyphs(state, c))
            );
          }),
          members.length < squadCap(state) && !sq.deployed
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
            el('div.gear-meta', ...statChips(item)),
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
/**
 * The stats, on the row.
 *
 * Eighteen items shipped with eight designed stats between them and not one of
 * them reached a screen: the row showed an icon, a name, a tier chip and prose.
 * So the only comparison the Armory offered was the tier digit — and the tier
 * digit is exactly the comparison the loot items are built to break. Slag
 * Autogun and Magnetic Rifle are both T4, and the difference between them is
 * twice the ammunition for a pierce tier. The player was being asked to choose
 * on a difference the game knew and never said.
 *
 * Short labels because this is a phone. `soak` and a suit's `wear` are shown
 * only when they are doing something, so a Padded Vest that soaks nothing does
 * not advertise a zero.
 */
function statChips(item) {
  const st = item.stats || {};
  const out = [];
  if (item.kind === 'weapon') {
    out.push(chip(`POW ${st.power?.toFixed(1)}`));
    out.push(chip(`AMMO x${st.ammo?.toFixed(2)}`, st.ammo > 1.5 ? 'warn' : ''));
    out.push(chip(`PIERCE ${st.pierce}`));
  } else if (item.kind === 'armor') {
    out.push(chip(`DR ${Math.round(st.dr * 100)}%`));
    if (st.soak > 0) out.push(chip(`SOAK ${Math.round(st.soak * 100)}%`, 'good'));
  } else {
    out.push(chip(`BAND ${st.band}`));
    out.push(chip(`WEAR ${st.wear?.toFixed(2)}`, st.wear <= 0.12 ? 'good' : ''));
  }
  return out;
}

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
          el('div.gear-meta', ...statChips(item)),
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

/**
 * Doctrine — the talent tree.
 *
 * It lives here rather than in the navbar because the navbar is full: the
 * mobile suite asserts all eight panels fit 390px at exactly 390px, so a ninth
 * would push the game off the screen it is built for. Military is the right
 * home anyway — this is bought by squads coming back and spent on squads
 * going out.
 *
 * Rows are laid out as pairs, because the pair is the decision. Showing them
 * as a flat list of thirteen would hide the only rule that matters: taking one
 * closes the other, permanently.
 */
function renderDoctrine(state, body, shell) {
  const d = state.doctrine || { points: 0, earned: 0, taken: [], frontier: 0 };
  const rows = ledger(state);
  const at = (id) => rows.find((r) => r.node.id === id);
  const bandName = ['nowhere yet', 'the near ruins', 'the mid waste', 'the deep', 'the Scar'][d.frontier] || '—';

  body.appendChild(
    el(
      'div.grid-3',
      tile('Commendations', d.points),
      tile('Earned', d.earned),
      tile('Spent', doctrineSpent(state))
    )
  );
  body.appendChild(
    el(
      'div.note',
      `A party that comes home from ${bandName} or deeper with nobody lost is worth ` +
        'commendations. One that loses somebody is worth none, and neither is a run ' +
        'somewhere you have already outgrown.'
    )
  );

  const nodeRow = (id) => {
    const r = at(id);
    if (!r) return null;
    const { node, taken, closed } = r;
    const cls = taken ? '.gear-row.gear-found' : closed ? '.gear-row.locked' : '.gear-row';
    const affordable = !r.reason;
    return el(
      taken || closed ? ('div' + cls) : ('button' + cls),
      taken || closed ? {} : {
        type: 'button',
        disabled: !affordable,
        onclick: () => confirmDoctrine(node, shell),
      },
      el(
        'div.gear-main',
        el('div.gear-name', `${node.name} `, taken ? chip('adopted', 'good') : chip(`${node.cost}`)),
        el('div.gear-desc', node.desc),
        !taken && r.reason ? el('div.gear-why', r.reason) : null
      ),
      affordable ? el('div.row-chevron', '+') : null
    );
  };

  body.appendChild(sectionLabel('Where it starts'));
  body.appendChild(nodeRow('debrief'));

  for (const doc of DOCTRINES) {
    body.appendChild(sectionLabel(doc.name));
    body.appendChild(el('div.note.quiet', doc.blurb));
    for (const rank of [1, 2]) {
      const pair = DOCTRINE_NODES.filter((n) => n.doctrine === doc.id && n.rank === rank);
      // Drawn as a pair with the word between them, because the pair *is* the
      // decision. Two identical rows in a scrolling list said nothing about the
      // only rule that matters — the exclusivity was announced by "Closed by
      // Cadre", which arrives after it is too late to act on.
      const group = el('div.doctrine-pair');
      pair.forEach((n, i) => {
        if (i) group.appendChild(el('div.doctrine-or', 'or'));
        group.appendChild(nodeRow(n.id));
      });
      body.appendChild(group);
    }
  }
}

/**
 * Confirm before closing a branch for the rest of the run.
 *
 * Adopting a doctrine was one tap on a full-width row in a long scrolling
 * list: twelve to thirty-four commendations gone and the other half of the
 * pair shut permanently, with no dialog and no undo. On a phone a mis-fired
 * tap during a scroll is the commonest input error there is, and this list is
 * nothing but stacked full-width targets. Everything else in this game that
 * cannot be taken back asks first.
 */
function confirmDoctrine(node, shell) {
  const other = node.excludes ? DOCTRINE_NODES.find((n) => n.id === node.excludes) : null;
  const close = modal({
    title: node.name,
    body: el(
      'div',
      el('p', node.desc),
      other
        ? el('p.warn', `Adopting this closes ${other.name} for the rest of this run. That cannot be undone.`)
        : null,
      el('p.quiet', `Costs ${node.cost} commendations.`)
    ),
    actions: [
      button('Cancel', { onclick: () => close() }),
      button(`Adopt ${node.name}`, {
        class: 'primary',
        onclick: () => {
          shell.store.dispatch({ type: 'DOCTRINE_TAKE', id: node.id });
          close();
          shell.renderPanel(true);
        },
      }),
    ],
  });
}

// ------------------------------------------------------------- loadout ---

const SLOTS = [
  { key: 'weapon', label: 'Weapon' },
  { key: 'armor', label: 'Armour' },
  { key: 'suit', label: 'Env-suit' },
];

/**
 * What one soldier is carrying, and the means to change it.
 *
 * Until this existed the player could not issue a single item. `equipBest` was
 * the only thing in the game that dispatched `GEAR_ASSIGN`, so every loadout
 * in every campaign was decided by one sort order, and the only trace of it
 * anywhere on screen was three tier digits on a squad card — "343". Eighteen
 * items with eight designed stats between them, six of them looted from
 * ground the player fought across to reach, and the answer to "who is carrying
 * the Rail-Carbine" was: nobody knows, and you may not choose.
 *
 * Tapping a member used to open the citizen card, which is the right screen
 * for who somebody *is* and the wrong one for what they are holding.
 */
function openLoadout(shell, citizenId) {
  const state = shell.store.state;
  const c = state.citizens[citizenId];
  if (!c) return;

  const body = el('div');
  body.appendChild(
    el('div.note', `${fullName(c)} — combat ${Math.round(c.skills.combat || 0)}, ` +
      `health ${Math.round(c.health)}. Anything issued here comes off whoever had it.`)
  );

  // Commending, on the screen where you are already looking at the soldier.
  const pts = state.doctrine?.points || 0;
  const cost = BAL.combat.commendCost;
  const maxed = (c.skills.combat || 0) >= BAL.citizens.skillMax;
  body.appendChild(
    el(
      maxed || pts < cost ? 'div.gear-row.locked' : 'button.gear-row',
      maxed || pts < cost ? {} : {
        type: 'button',
        onclick: () => {
          shell.store.dispatch({ type: 'DOCTRINE_COMMEND', id: citizenId });
          h.close();
          shell.renderPanel(true);
          openLoadout(shell, citizenId);
        },
      },
      el(
        'div.gear-main',
        el('div.gear-name', 'Commend ', chip(`${cost}`)),
        el('div.gear-desc', `A citation for the runs they have come back from. ` +
          `+${BAL.combat.commendSkill} combat, permanently.`),
        maxed
          ? el('div.gear-why', 'There is nothing left to teach them.')
          : pts < cost ? el('div.gear-why', `You have ${pts} commendation${pts === 1 ? '' : 's'}.`) : null
      ),
      !maxed && pts >= cost ? el('div.row-chevron', '+') : null
    )
  );

  for (const slot of SLOTS) {
    const heldId = c.gear?.[slot.key];
    const held = heldId ? state.military.gear[heldId] : null;
    const item = held ? getItem(held.item) : null;
    body.appendChild(sectionLabel(slot.label));
    body.appendChild(
      el(
        'button.gear-row',
        { type: 'button', onclick: () => { h.close(); pickGear(shell, citizenId, slot); } },
        item ? gearIcon(item) : null,
        el(
          'div.gear-main',
          el('div.gear-name', item ? item.name : 'Nothing', item ? chip(`T${item.tier}`) : null),
          item
            ? el('div.gear-meta', ...statChips(item),
                chip(`${Math.round(slot.key === 'suit' ? held.integrity : held.durability)}%`,
                  (slot.key === 'suit' ? held.integrity : held.durability) < 50 ? 'warn' : ''))
            : el('div.gear-desc', 'Empty. A citizen with no suit cannot leave the airlock.')
        ),
        el('div.row-chevron', '›')
      )
    );
  }

  const h = modal({
    title: 'Loadout',
    body,
    actions: [
      // The citizen card is still the right screen for who somebody *is* —
      // history, traits, family. It was what tapping a squad member used to
      // open, which is why the loadout had nowhere to live. Both are reachable
      // now, one tap apart, and neither is pretending to be the other.
      button('Who they are', { onclick: () => { h.close(); openCitizen(shell.store, citizenId, {}); } }),
      button('Best available', {
        onclick: () => {
          shell.store.dispatchAll(equipBest(shell.store.state, citizenId));
          h.close();
          shell.renderPanel(true);
          openLoadout(shell, citizenId);
        },
      }),
      button('Done', { class: 'primary', onclick: () => h.close() }),
    ],
  });
}

/** The rack, for one slot: what is spare, plus what this person already holds. */
function pickGear(shell, citizenId, slot) {
  const state = shell.store.state;
  const c = state.citizens[citizenId];
  const heldId = c.gear?.[slot.key];
  const pool = unassignedGear(state, slot.key).slice();
  if (heldId && state.military.gear[heldId]) pool.unshift(state.military.gear[heldId]);

  const body = el('div');
  if (!pool.length) {
    body.appendChild(emptyState(`Nothing in the rack. Build one in the Armory, or bring one back.`));
  }
  // Best first, by the same ranking the auto-equipper uses, so the list and
  // the "Best available" button can never disagree about what best means.
  const score = (g) => {
    const st = getItem(g.item)?.stats || {};
    const wear = 0.6 + 0.4 * ((g.durability ?? 100) / BAL.gear.durabilityMax);
    if (slot.key === 'weapon') return (st.power ?? 0) * wear;
    if (slot.key === 'armor') return (st.dr ?? 0) + (st.soak ?? 0) * 0.5;
    return (st.band ?? 0) * 10 - (st.wear ?? 1);
  };
  for (const g of pool.sort((a, b) => score(b) - score(a))) {
    const item = getItem(g.item);
    if (!item) continue;
    const cond = Math.round(slot.key === 'suit' ? g.integrity : g.durability);
    body.appendChild(
      el(
        'button.gear-row' + (g.id === heldId ? '.gear-found' : ''),
        {
          type: 'button',
          onclick: () => {
            if (g.id !== heldId) {
              shell.store.dispatch({ type: 'GEAR_ASSIGN', gearId: g.id, citizenId, slot: slot.key });
            }
            h.close();
            shell.renderPanel(true);
            openLoadout(shell, citizenId);
          },
        },
        gearIcon(item),
        el(
          'div.gear-main',
          el('div.gear-name', item.name, chip(`T${item.tier}`),
            g.id === heldId ? chip('carrying', 'good') : null,
            item.loot ? chip('found', 'warn') : null),
          el('div.gear-meta', ...statChips(item), chip(`${cond}%`, cond < 50 ? 'warn' : ''))
        )
      )
    );
  }

  const h = modal({
    title: slot.label,
    body,
    actions: [button('Back', { onclick: () => { h.close(); openLoadout(shell, citizenId); } })],
  });
}
