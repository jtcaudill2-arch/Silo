/**
 * returnReport.js — "here is what happened while you were gone."
 *
 * Presented on resume as a scrollable log, newest last, with one Continue
 * button (spec §3.4). The structure is deliberate: a headline you can read in
 * one glance, then the numbers that changed, then the names. Deaths are never
 * summarised into a count alone — if somebody died, the player reads who.
 */

import { el, fmt, fmtDelta, button, clear, humanise } from './dom.js';
import { describeAbsence } from '../core/catchup.js';

const RESOURCE_LABEL = {
  power: 'Power', water: 'Water', food: 'Food', meds: 'Meds', scrap: 'Scrap',
  alloy: 'Alloy', ammo: 'Ammunition', chits: 'Chits', filters: 'Filters',
  parts: 'Parts', fuel: 'Fuel', ore: 'Ore', coolant: 'Coolant',
};

/**
 * Show the report full-screen. Resolves when the player hits Continue, so the
 * caller can hold the game paused until they've read it.
 */
export function showReturnReport(report, { onContinue } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const scrim = el('div.modal-scrim', { style: { pointerEvents: 'auto' } });

    const body = el('div.report-body');
    buildReport(report, body);

    const continueBtn = button('Continue', {
      class: 'primary',
      onclick: () => {
        wrap.remove();
        onContinue?.();
        resolve();
      },
    });

    const panel = el(
      'div.report',
      el(
        'div.report-head',
        el('div.report-eyebrow', `Away ${describeAbsence(report.elapsedMs)}`),
        el('div.report-title', 'While you were gone'),
        el('div.report-headline', report.headline)
      ),
      body,
      el('div.report-foot', continueBtn)
    );

    const wrap = el('div.report-wrap', scrim, panel);
    root.appendChild(wrap);
    // Land at the newest entry, the way you'd read a logbook you'd missed.
    requestAnimationFrame(() => {
      // Top, not bottom. This used to land at the newest entry "the way you'd
      // read a logbook you'd missed", which was right when the report was
      // purely a record and is wrong now that it opens with what finished and
      // what is waiting: those are the two things a returning player is here
      // for, and they were being scrolled past on arrival.
      body.scrollTop = 0;
      continueBtn.focus();
    });

    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        document.removeEventListener('keydown', onKey);
        continueBtn.click();
      }
    };
    document.addEventListener('keydown', onKey);
  });
}

function buildReport(r, body) {
  // ---- what moved --------------------------------------------------------
  const stats = el('div.report-stats');
  stats.appendChild(deltaTile('Population', r.population.from, r.population.to, 0));
  stats.appendChild(deltaTile('Order', r.order.from, r.order.to, 0));
  stats.appendChild(deltaTile('Air', r.air.from, r.air.to, 0));
  stats.appendChild(deltaTile('Avg morale', r.morale.from, r.morale.to, 0));
  body.appendChild(stats);

  if (r.capped) {
    // The headline already says the silo held for twelve hours, so this says
    // the part the headline does not: that the rest of the absence was not
    // simulated *against* them. Both lines were printed verbatim before, one
    // under the other.
    body.appendChild(
      el('div.report-note', 'Nothing past that was simulated, and nothing past that counted against you.')
    );
  }

  // ---- what finished, and what is waiting ---------------------------------
  //
  // These lead, and that ordering is the whole change. The report used to open
  // on the casualty list, so two days away read as a funeral notice even when
  // the silo had had a good week — and the things a player actually wants on
  // coming back (a research node done, a floor opened, a decision that has
  // been sitting there the whole time) were either buried under the deaths or,
  // in the case of `unlock`, dropped by the report entirely.
  if (r.finished?.length) {
    body.appendChild(el('div.report-section.good', 'Finished while you were out'));
    for (const f of r.finished) {
      body.appendChild(el('div.report-line', el('span.report-day.mono', `D${f.day % 12}`), el('span', f.text)));
    }
  }

  if (r.waiting?.length) {
    body.appendChild(el('div.report-section', 'Waiting on you'));
    for (const w of r.waiting) {
      body.appendChild(
        el('div.report-line.waiting', el('span.report-where.mono', w.where), el('span', w.text))
      );
    }
  }

  // ---- stores ------------------------------------------------------------
  const keys = Object.keys(r.resourceDelta);
  if (keys.length) {
    body.appendChild(el('div.report-section', 'Stores'));
    const grid = el('div.report-res');
    keys
      .sort((a, b) => Math.abs(r.resourceDelta[b]) - Math.abs(r.resourceDelta[a]))
      .forEach((k) => {
        const d = r.resourceDelta[k];
        grid.appendChild(
          el(
            'div.report-res-cell',
            el('span.k', RESOURCE_LABEL[k] || humanise(k)),
            el('span.v.mono' + (d > 0 ? '.up' : '.down'), fmtDelta(d, 0))
          )
        );
      });
    body.appendChild(grid);
  }

  // ---- the dead ----------------------------------------------------------
  if (r.deaths.length) {
    body.appendChild(
      el(
        'div.report-section.bad',
        r.deaths.length === 1 ? 'One death' : `${r.deaths.length} deaths`
      )
    );
    const tally = Object.entries(r.causeTally).sort((a, b) => b[1] - a[1]);
    if (tally.length > 1 || r.deaths.length > 4) {
      body.appendChild(
        el(
          'div.report-tally',
          ...tally.map(([cause, n]) => el('span.chip.bad', `${cause} ×${n}`))
        )
      );
    }
    for (const d of r.deaths) {
      body.appendChild(el('div.report-line.death', el('span.report-day.mono', `D${d.day % 12}`), el('span', d.text)));
    }
  }

  // ---- the born ----------------------------------------------------------
  if (r.births.length) {
    body.appendChild(el('div.report-section.good', r.births.length === 1 ? 'One birth' : `${r.births.length} births`));
    for (const b of r.births) {
      body.appendChild(el('div.report-line.birth', el('span.report-day.mono', `D${b.day % 12}`), el('span', b.text)));
    }
  }

  // ---- expeditions -------------------------------------------------------
  if (r.expeditions.length) {
    body.appendChild(el('div.report-section', 'Surface'));
    for (const e of r.expeditions) {
      body.appendChild(el('div.report-line', el('span.report-day.mono', `D${e.day % 12}`), el('span', e.text)));
    }
  }

  // ---- radio -------------------------------------------------------------
  if (r.radio.length) {
    body.appendChild(el('div.report-section', 'Radio traffic'));
    for (const e of r.radio) {
      body.appendChild(el('div.report-line.radio', el('span.report-day.mono', `D${e.day % 12}`), el('span', e.text)));
    }
  }

  // ---- everything else ---------------------------------------------------
  if (r.alerts.length) {
    body.appendChild(el('div.report-section', 'Alerts'));
    for (const a of r.alerts) {
      body.appendChild(
        el('div.report-line.' + (a.kind || 'alert'), el('span.report-day.mono', `D${a.day % 12}`), el('span', a.text))
      );
    }
  }

  if (
    !r.deaths.length && !r.births.length && !r.expeditions.length &&
    !r.radio.length && !r.alerts.length && !keys.length &&
    !r.finished?.length && !r.waiting?.length
  ) {
    body.appendChild(el('div.report-note', 'The shift log is empty. Nothing happened worth writing down.'));
  }

  if (r.gameOver) {
    body.appendChild(el('div.report-section.bad', 'The silo is lost'));
    body.appendChild(el('div.report-note', 'There is nobody left to give orders to.'));
  }
}

function deltaTile(label, from, to, digits) {
  const d = to - from;
  const cls = Math.abs(d) < 0.5 ? '' : d > 0 ? 'up' : 'down';
  return el(
    'div.report-stat',
    el('div.k', label),
    el('div.v.mono', fmt(Math.round(to))),
    el('div.d.mono' + (cls ? '.' + cls : ''), Math.abs(d) < 0.5 ? '—' : fmtDelta(d, digits))
  );
}

export default showReturnReport;
