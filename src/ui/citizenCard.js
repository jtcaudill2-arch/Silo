/**
 * citizenCard.js — one person's file.
 *
 * The card is what makes a death land, so it leads with the things that make
 * someone a person — name, face, who they're close to, what they've lived
 * through — and puts the numbers underneath.
 */

import { BAL } from '../config/balance.js';
import { getRoom, SKILLS } from '../data/rooms.js';
import { TRAITS } from '../data/traits.js';
import { fullName, topSkill, workFactor } from '../sim/population.js';
import { portraitCanvas } from '../render/portraits.js';
import { citizenArt, artImage } from './artwork.js';
import * as sprites from '../render/sprites.js';
import { el, modal, button, meter, chip, sectionLabel, humanise, emptyState, row } from './dom.js';

const STAT_LABEL = { str: 'Strength', agi: 'Agility', int: 'Intellect', end: 'Endurance', cha: 'Charisma' };

export function openCitizen(store, citizenId, opts = {}) {
  let handle = null;
  const rerender = () => {
    handle?.close();
    handle = show();
  };

  function show() {
    const state = store.state;
    const c = state.citizens[citizenId];
    if (!c) return null;

    const body = el('div');
    body.appendChild(header(state, c));
    body.appendChild(vitals(c));

    // ---- posting ---------------------------------------------------------
    const room = c.job ? state.silo.rooms[c.job.roomId] : null;
    const def = room ? getRoom(room.type) : null;
    body.appendChild(sectionLabel('Posting'));
    body.appendChild(
      row({
        title: def ? def.name : statusLabel(c),
        sub: def
          ? `Floor ${room.floor}  ·  ${humanise(def.staff?.skill || '')} ` +
            `${Math.round(c.skills[def.staff?.skill] || 0)}  ·  working at ` +
            `${Math.round(workFactor(c, def.staff?.skill) * 100)}%`
          : idleReason(c),
        value: def ? `${Math.round(workFactor(c, def.staff?.skill) * 100)}%` : '—',
        onclick: room ? () => opts.onOpenRoom?.(room.id) : undefined,
      })
    );
    if (c.status !== 'dead' && c.age >= BAL.citizens.workingAgeMin) {
      body.appendChild(
        el(
          'div.pad',
          button(room ? 'Take off this post' : 'Assign to a post', {
            class: 'wide',
            onclick: () => {
              if (room) {
                store.dispatch({ type: 'CITIZEN_ASSIGN', citizenId: c.id, roomId: null });
                rerender();
              } else {
                opts.onAssign?.(c.id);
                handle?.close();
              }
            },
          })
        )
      );
    }

    // ---- skills ----------------------------------------------------------
    body.appendChild(sectionLabel('Skills'));
    const skillGrid = el('div.skill-grid');
    const best = topSkill(c).skill;
    for (const k of SKILLS) {
      const v = c.skills[k] || 0;
      skillGrid.appendChild(
        el(
          'div.skill-row' + (k === best ? '.best' : ''),
          el('span.skill-k', humanise(k)),
          meter(v, BAL.citizens.skillMax, v >= 70 ? 'good' : ''),
          el('span.skill-v.mono', Math.round(v))
        )
      );
    }
    body.appendChild(skillGrid);

    // ---- attributes ------------------------------------------------------
    body.appendChild(sectionLabel('Attributes'));
    const statGrid = el('div.stat-row-grid');
    for (const [k, label] of Object.entries(STAT_LABEL)) {
      statGrid.appendChild(
        el('div.stat-pip', el('span.k', label.slice(0, 3).toUpperCase()), el('span.v.mono', c.stats[k]))
      );
    }
    body.appendChild(statGrid);

    // ---- traits ----------------------------------------------------------
    const visible = c.traits.filter((id) => {
      const t = TRAITS[id];
      if (!t) return false;
      // Hidden traits only surface with the Informant Network running.
      if (t.hidden && !state.order.policies.includes('informants')) return false;
      return true;
    });
    body.appendChild(sectionLabel('Traits'));
    if (!visible.length) {
      body.appendChild(el('div.note', 'Nothing on file.'));
    } else {
      const wrap = el('div.trait-list');
      for (const id of visible) {
        const t = TRAITS[id];
        wrap.appendChild(
          el(
            'div.trait' + (t.good ? '.good' : '.bad'),
            el('div.trait-name', t.name),
            el('div.trait-desc', t.desc)
          )
        );
      }
      body.appendChild(wrap);
    }

    // ---- relationships ---------------------------------------------------
    const bonds = Object.entries(c.relationships || {})
      .map(([id, v]) => ({ other: state.citizens[id], v }))
      .filter((b) => b.other && b.other.status !== 'dead')
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
      .slice(0, 8);
    body.appendChild(sectionLabel('Relationships'));
    if (!bonds.length) {
      body.appendChild(el('div.note', 'Keeps to themselves.'));
    } else {
      for (const b of bonds) {
        body.appendChild(
          row({
            title: fullName(b.other),
            sub: bondLabel(b.v),
            value: Math.round(b.v),
            class: b.v >= BAL.citizens.relationships.friendThreshold
              ? 'bond-good'
              : b.v <= BAL.citizens.relationships.rivalThreshold
              ? 'bond-bad'
              : '',
            onclick: () => {
              handle?.close();
              openCitizen(store, b.other.id, opts);
            },
          })
        );
      }
    }

    // ---- history ---------------------------------------------------------
    body.appendChild(sectionLabel('History'));
    if (!c.history.length) {
      body.appendChild(emptyState('Nothing recorded.'));
    } else {
      for (const h of [...c.history].reverse()) {
        body.appendChild(
          el('div.hist-line', el('span.hist-day.mono', `Y${Math.floor(h.day / 12)}D${h.day % 12}`), el('span', h.text))
        );
      }
    }

    return modal({
      title: fullName(c),
      body,
      actions: [button('Close', { onclick: () => handle?.close() })],
    });
  }

  handle = show();
  return handle;
}

function header(state, c) {
  // A drawn figure when one has been imported for this citizen's role, the
  // procedural portrait otherwise. The procedural one is not a placeholder —
  // it is per-citizen and always right — so this is a swap, not a repair.
  // Imported art, then the atlas figure for their role, then the procedural
  // portrait. All three are real answers — the procedural one is per-citizen
  // and always correct — so this is preference, not repair.
  const drawn = citizenArt(c, state);
  let figure;
  if (drawn) {
    figure = artImage(drawn, fullName(c));
    figure.className = 'portrait-lg portrait-art';
  } else {
    figure = sprites.frameCanvas(`portrait_${sprites.citizenRole(c)}`, 2) || portraitCanvas(c, 4);
    figure.className = 'portrait-lg';
    figure.setAttribute('aria-hidden', 'true');
  }
  const dead = c.status === 'dead';
  return el(
    'div.card-head',
    figure,
    el(
      'div.card-head-main',
      el('div.card-name', fullName(c)),
      el(
        'div.card-sub',
        dead
          ? `Died at ${Math.floor(c.age)} — ${c.causeOfDeath}`
          : `${Math.floor(c.age)} years old  ·  ${statusLabel(c)}`
      ),
      el(
        'div.card-chips',
        c.origin === 'born' ? chip('born here') : chip(originLabel(c.origin)),
        c.squadId != null ? chip('squad', 'warn') : null,
        c.radiation >= BAL.citizens.radiation.sicknessThreshold
          ? chip(`rad ${Math.round(c.radiation)}`, 'rad')
          : null,
        c.pregnantUntilDay != null ? chip('expecting', 'good') : null
      )
    )
  );
}

function vitals(c) {
  const bars = [
    ['Health', c.health, 100, c.health < 40 ? 'bad' : 'good'],
    ['Vitality', c.vitality, 100, c.vitality < BAL.citizens.death.vitalityThreshold ? 'bad' : ''],
    ['Morale', c.morale, 100, c.morale < 30 ? 'bad' : ''],
    ['Radiation', c.radiation, 100, 'rad'],
  ];
  const wrap = el('div.vitals');
  for (const [label, v, max, cls] of bars) {
    if (label === 'Radiation' && v < 1) continue;
    wrap.appendChild(
      el(
        'div.vital',
        el('span.vital-k', label),
        meter(v, max, cls),
        el('span.vital-v.mono', Math.round(v))
      )
    );
  }
  // The point of separating the two, spelled out where it's felt.
  if (c.vitality < 100 && c.status !== 'dead') {
    wrap.appendChild(
      el(
        'div.note',
        c.vitality < BAL.citizens.death.vitalityThreshold
          ? 'Vitality is below the line where age starts taking people. The clinic can slow this, not stop it.'
          : 'Vitality is falling with age. They will produce less every year from here, long before it kills them.'
      )
    );
  }
  return wrap;
}

function statusLabel(c) {
  switch (c.status) {
    case 'working': return 'on shift';
    case 'idle': return 'unassigned';
    case 'school': return 'in school';
    case 'expedition': return 'on the surface';
    case 'injured': return 'in the clinic';
    case 'imprisoned': return 'in holding';
    case 'training': return 'training';
    case 'dead': return 'deceased';
    default: return c.status;
  }
}

function idleReason(c) {
  if (c.status === 'dead') return `Died on year ${Math.floor((c.deathDay ?? 0) / 12)}, day ${(c.deathDay ?? 0) % 12}.`;
  if (c.age < BAL.citizens.workingAgeMin) return 'Too young to work.';
  if (c.status === 'school') return 'Enrolled. Produces nothing, learns twice as fast.';
  return 'No post. Eats, and adds to the dissent.';
}

function originLabel(origin) {
  switch (origin) {
    case 'survivor': return 'wasteland survivor';
    case 'refugee': return 'refugee';
    case 'defector': return 'defector';
    case 'trade': return 'traded for';
    default: return origin;
  }
}

function bondLabel(v) {
  const R = BAL.citizens.relationships;
  if (v >= 85) return 'inseparable';
  if (v >= R.friendThreshold) return 'close';
  if (v >= 20) return 'friendly';
  if (v > -20) return 'acquainted';
  if (v > R.rivalThreshold) return 'friction';
  return 'bad blood';
}

export default openCitizen;
