/**
 * airlock.js — expeditions.
 *
 * Risk is shown as a range and never as a single percentage: the player
 * should never feel lied to by a number (spec §15). The bands are laid out as
 * a ladder so the gating is obvious — you can see the Scar from day one, and
 * you can see exactly what it will take to get there.
 */

import { BAL } from '../../config/balance.js';
import {
  BANDS, canLaunch, launch, riskPreview, airlockCapacity, supplyCost,
} from '../../sim/expedition.js';
import { squadMembers, readiness } from '../../sim/military.js';
import { fullName } from '../../sim/population.js';
import { effects as researchEffects } from '../../sim/research.js';
import { lockReason } from '../../sim/unlocks.js';
import * as sprites from '../../render/sprites.js';
import { el, button, row, sectionLabel, emptyState, meter, chip, toast, modal, humanise } from '../dom.js';

export const airlockPanel = {
  id: 'airlock',
  title: 'Airlock',
  nav: 'Surface',
  glyph: '☀',
  subtitle: (s) => (s.expeditions.active.length ? `${s.expeditions.active.length} out` : 'sealed'),

  badge(state) {
    return state.pendingDecon ? 1 : 0;
  },

  // Third of the gated systems, and the hinge of the early game: the research
  // tree turns artifact-gated shortly after it. The condition and the
  // sentence live in sim/unlocks.js with the rest of the order.
  locked(state) {
    return lockReason(state, 'airlock');
  },

  render(state, shell) {
    const body = el('div.panel-body');

    // The sky, at the top of the one screen that is about going out into it.
    // This panel is a list of destinations and their doses; the reason anybody
    // walks into that is not conveyed by a table.
    const sky = sprites.frameCanvas('skyline', 2);
    if (sky) {
      sky.setAttribute('aria-hidden', 'true');
      body.appendChild(el('div.sky-banner', sky, el('div.sky-caption', 'The surface, from the outer door')));
    }
    const cap = airlockCapacity(state);
    const suitTier = researchEffects(state).suitTier || 0;

    body.appendChild(
      el(
        'div.grid-3',
        tile('Decon capacity', cap, cap ? '' : 'bad'),
        tile('Best suit', suitTier ? `T${suitTier}` : '—', suitTier ? '' : 'bad'),
        tile('Filters', Math.round(state.resources.filters), state.resources.filters < 20 ? 'bad' : '')
      )
    );

    // ---- decontamination waiting -----------------------------------------
    if (state.pendingDecon) {
      body.appendChild(deconSection(state, shell));
    }

    // ---- what's out there now --------------------------------------------
    if (state.expeditions.active.length) {
      body.appendChild(sectionLabel('Outside'));
      for (const exp of state.expeditions.active) {
        const sq = state.military.squads[exp.squadId];
        const daysLeft = Math.max(0, exp.returnDay - state.clock.day);
        body.appendChild(
          row({
            title: sq?.name || `Expedition ${exp.id}`,
            sub:
              `${humanise(exp.band)} · ${exp.roster.length} out · ` +
              (daysLeft > 0 ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} until they are due` : 'due back now'),
            value: `${daysLeft}`,
          })
        );
      }
    }

    // ---- the ladder -------------------------------------------------------
    body.appendChild(sectionLabel('Destinations'));
    for (const band of BANDS) {
      body.appendChild(bandRow(state, shell, band, suitTier));
    }

    // ---- history ----------------------------------------------------------
    if (state.expeditions.history.length) {
      body.appendChild(sectionLabel('Previous runs'));
      for (const exp of state.expeditions.history.slice(0, 8)) {
        const sq = state.military.squads[exp.squadId];
        body.appendChild(
          row({
            title: `${sq?.name || 'Squad'} — ${humanise(exp.band)}`,
            sub:
              exp.casualties.length === 0
                ? `All ${exp.survivors.length} came back.`
                : `${exp.casualties.length} lost, ${exp.survivors.length} home.`,
            value: `D${exp.returnDay % 12}`,
            class: exp.casualties.length ? 'bond-bad' : '',
            onclick: () => showJournal(exp, sq),
          })
        );
      }
    }

    return body;
  },
};

function bandRow(state, shell, band, suitTier) {
  const locked = suitTier < band.suitTier;
  const squads = state.military.squadIds
    .map((id) => state.military.squads[id])
    .filter((sq) => !sq.deployed && squadMembers(state, sq.id).length >= BAL.military.squadMin);

  return el(
    'button.band-row' + (locked ? '.locked' : ''),
    {
      type: 'button',
      disabled: locked || !squads.length,
      onclick: () => openLaunch(state, shell, band),
    },
    el(
      'div.band-main',
      el('div.band-name', band.name),
      el(
        'div.band-meta',
        chip(`${band.travelDays} days`),
        chip(`suit T${band.suitTier}`, locked ? 'bad' : 'good'),
        chip(`${band.radPerHour} rad/hr`, 'rad'),
        chip(`reward tier ${band.rewardTier}`)
      ),
      locked
        ? el('div.band-why', `Needs a tier-${band.suitTier} env-suit. Research it, then build it in the Suit Bay.`)
        : !squads.length
        ? el('div.band-why', `No squad of ${BAL.military.squadMin}+ is standing by.`)
        : null
    ),
    !locked && squads.length ? el('div.row-chevron', '›') : null
  );
}

function openLaunch(state, shell, band) {
  const squads = state.military.squadIds
    .map((id) => state.military.squads[id])
    .filter((sq) => !sq.deployed && squadMembers(state, sq.id).length >= BAL.military.squadMin);

  const body = el('div');
  let selected = squads[0]?.id;

  const render = () => {
    body.replaceChildren();
    body.appendChild(el('div.note', bandProse(band)));

    body.appendChild(sectionLabel('Squad'));
    for (const sq of squads) {
      const members = squadMembers(state, sq.id);
      body.appendChild(
        row({
          title: sq.name,
          sub: `${members.length} strong · readiness ${Math.round(readiness(state, sq.id) * 100)}%`,
          value: selected === sq.id ? '●' : '○',
          onclick: () => {
            selected = sq.id;
            render();
          },
        })
      );
    }

    if (!selected) return;
    const check = canLaunch(state, selected, band.key);
    const preview = riskPreview(state, selected, band.key);

    if (preview) {
      body.appendChild(sectionLabel('Assessment'));
      body.appendChild(
        el(
          'div.risk',
          el('div.risk-verdict', preview.verdict),
          el(
            'div.risk-bar',
            el('span.risk-k', 'Strength vs the ground'),
            el(
              'div.risk-range',
              el('span.risk-lo.mono', preview.ratioRange[0].toFixed(1) + '×'),
              el('div.risk-track', el('i', {
                style: {
                  left: pct(preview.ratioRange[0]) + '%',
                  width: Math.max(4, pct(preview.ratioRange[1]) - pct(preview.ratioRange[0])) + '%',
                },
              }), el('span.risk-even', { style: { left: pct(1) + '%' } })),
              el('span.risk-hi.mono', preview.ratioRange[1].toFixed(1) + '×')
            )
          ),
          el(
            'div.risk-lines',
            el('div', `Expect ${preview.encounters} encounter${preview.encounters === 1 ? '' : 's'} on the way.`),
            el('div', `Dose on return: roughly ${preview.radRange[0]}–${preview.radRange[1]}, before decontamination.`),
            el(
              'div',
              `Supplies: ${Object.entries(preview.supplies).map(([k, v]) => `${v} ${k}`).join(', ')}.`
            )
          )
        )
      );
      body.appendChild(
        el(
          'div.note',
          'That is a range, not a promise. The wasteland does not read forecasts.'
        )
      );
    }

    if (!check.ok) body.appendChild(el('div.note.warn', check.reason));

    body.appendChild(
      el(
        'div.pad',
        button('Authorize expedition', {
          class: 'primary wide',
          disabled: !check.ok,
          onclick: () => {
            shell.store.dispatchAll(launch(shell.store.state, selected, band.key));
            h.close();
            toast('The airlock is cycling.');
            shell.renderPanel(true);
          },
        })
      )
    );
  };

  render();
  const h = modal({
    title: band.name,
    body,
    actions: [button('Cancel', { onclick: () => h.close() })],
  });
}

function pct(ratio) {
  // 0x .. 3x mapped across the track, so 1.0 (an even fight) sits at a third.
  return Math.max(0, Math.min(100, (ratio / 3) * 100));
}

function bandProse(band) {
  switch (band.key) {
    case 'near': return 'The ruins within a day of the door. Picked over twice already, but safe enough to learn on.';
    case 'mid': return 'Far enough that nobody has stripped it. Raiders work this ground and so do the packs.';
    case 'deep': return 'Days out. This is where the artefacts are, and where suits stop being optional.';
    case 'approach': return 'Close enough to another silo to be seen from their cameras. They will notice.';
    case 'scar': return 'Whatever happened, it happened here. Twelve days out and back, if the seals hold.';
    default: return '';
  }
}

function deconSection(state, shell) {
  const d = state.pendingDecon;
  const cost = BAL.expedition.decon.filtersPerMember * d.members.length;
  const short = state.resources.filters < cost;

  return el(
    'div.decon',
    el('div.decon-title', 'Decontamination pending'),
    el(
      'div.decon-sub',
      `${d.members.length} came back carrying a dose of ${Math.round(d.radiation)}. ` +
        `Decon takes ${BAL.expedition.decon.shiftsPerMember} shift each and ${cost} filters.`
    ),
    short ? el('div.note.warn', `Only ${Math.round(state.resources.filters)} filters left. You do not have enough.`) : null,
    el(
      'div.decon-actions',
      button('Run decontamination', {
        class: 'primary',
        disabled: short,
        onclick: () => {
          shell.store.dispatch({ type: 'DECON', members: d.members });
          toast('Decontamination complete.');
          shell.renderPanel(true);
        },
      }),
      button('Skip it', {
        class: 'danger',
        title: 'The dose goes into the silo instead. Everybody takes a share.',
        onclick: () => confirmSkip(shell, d),
      })
    )
  );
}

function confirmSkip(shell, d) {
  const h = modal({
    title: 'Skip decontamination?',
    body: el(
      'div',
      el(
        'div.note',
        `The squad walks straight in carrying a dose of ${Math.round(d.radiation)}. ` +
          'About a third of it spreads through the silo — thin, but it lands on everybody, ' +
          'including the children.'
      ),
      el('div.note.warn', `Order will fall by ${Math.abs(BAL.expedition.decon.skipOrderPenalty)}. People notice this sort of thing.`)
    ),
    actions: [
      button('Cancel', { onclick: () => h.close() }),
      button('Skip it', {
        class: 'danger',
        onclick: () => {
          shell.store.dispatch({ type: 'DECON', skip: true, radiation: d.radiation, members: d.members });
          h.close();
          toast('They walked straight in.', 'rad');
          shell.renderPanel(true);
        },
      }),
    ],
  });
}

function showJournal(exp, sq) {
  const body = el('div');
  body.appendChild(
    el(
      'div.note',
      `${sq?.name || 'The squad'} — ${humanise(exp.band)}, days ${exp.launchDay} to ${exp.returnDay}.`
    )
  );
  for (const line of exp.journal || []) {
    if (!line) continue;
    const isHeader = /^—/.test(line);
    body.appendChild(el(isHeader ? 'div.journal-day' : 'div.journal-line', line));
  }
  const h = modal({
    title: 'Expedition log',
    body,
    wide: true,
    actions: [button('Close', { onclick: () => h.close() })],
  });
}

function tile(k, v, cls = '') {
  return el('div.stat-tile', el('div.k', k), el('div.v' + (cls ? '.' + cls : ''), String(v)));
}

export default airlockPanel;
