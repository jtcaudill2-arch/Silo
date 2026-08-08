/**
 * ending.js — the last screen.
 *
 * Three endings and one failure state, all presented the same way, because
 * they are the same kind of event: the log stops here and somebody reads back
 * what it said. No score, no stars, no "you achieved 3 of 5 objectives" —
 * the game has been a log the whole time and it finishes as one.
 *
 * The failure ending gets the same care as the three victories. A silo that
 * dies has still been a silo for however many days, and the numbers on this
 * screen are the only obituary the four hundred people in it get.
 */

import { el, button, fmt, chip } from './dom.js';
import { ENDINGS } from '../data/events.js';

/**
 * Show the ending full-screen. Resolves when the player dismisses it.
 * @param {object} state    final game state
 * @param {object} opts     { onNewGame }
 */
export function showEnding(state, { onNewGame } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const ending = ENDINGS.find((e) => e.id === state.meta.ending) || null;
    const won = !!ending;

    const scrim = el('div.modal-scrim', { style: { pointerEvents: 'auto' } });
    const body = el('div.report-body');
    build(state, ending, body);

    const closeBtn = button(won ? 'Close the log' : 'Close the log', {
      class: 'ghost',
      onclick: () => finish(),
    });
    const newBtn = button('Begin again', {
      class: 'primary',
      onclick: () => {
        finish();
        onNewGame?.();
      },
    });

    const panel = el(
      'div.report.ending' + (won ? '.ending-won' : '.ending-lost'),
      el(
        'div.report-head',
        el('div.report-eyebrow', won ? 'Silo 12 — final entry' : 'Silo 12 — the log ends'),
        el('div.report-title', ending ? ending.name : 'The silo is dark'),
        el(
          'div.report-headline',
          ending
            ? `Year ${state.clock.year}, day ${state.clock.day}.`
            : reasonLine(state)
        )
      ),
      body,
      el('div.report-foot', closeBtn, newBtn)
    );

    const wrap = el('div.report-wrap', scrim, panel);
    root.appendChild(wrap);
    requestAnimationFrame(() => newBtn.focus());

    function finish() {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve();
    }
    const onKey = (e) => {
      if (e.key === 'Escape') finish();
    };
    document.addEventListener('keydown', onKey);
  });
}

function reasonLine(state) {
  if (state.meta.gameOver === 'extinction') {
    return 'The last resident of Silo 12 is dead. The lights are still on.';
  }
  if (state.meta.gameOver === 'uprising') {
    return 'You are no longer the mayor. Somebody else is writing in this log now.';
  }
  return 'The administration of Silo 12 has ended.';
}

function build(state, ending, body) {
  // The ending's own prose first. It is the only thing on this screen that
  // was written rather than counted, so it goes above the numbers.
  if (ending) {
    for (const para of paragraphs(ending.text)) {
      body.appendChild(el('div.ending-prose', para));
    }
  }

  const dug = state.silo.floors.filter((f) => f.excavated).length;
  const contacted = Object.values(state.world.silos).filter((s) => s.contact !== 'none').length;

  body.appendChild(el('div.report-section', 'The administration in numbers'));
  const stats = el('div.report-stats');
  for (const [k, v] of [
    ['Days', `${state.clock.day}`],
    ['Living', fmt(state.citizenIds.length)],
    ['Born', fmt(state.stats.births)],
    ['Died', fmt(state.stats.deaths)],
    ['Rooms', fmt(Object.keys(state.silo.rooms).length)],
    ['Floors', `${dug}/${state.silo.floors.length}`],
    ['Research', fmt(state.research.completed.length)],
    ['Silos met', fmt(contacted)],
  ]) {
    stats.appendChild(el('div.report-stat', el('div.k', k), el('div.v.mono', v)));
  }
  body.appendChild(stats);

  // Causes, then names. A count is a statistic; a list is a record, and
  // §18's rule that no death is silent doesn't stop applying at the end.
  const causes = Object.entries(state.stats.causes || {}).sort((a, b) => b[1] - a[1]);
  if (causes.length) {
    body.appendChild(el('div.report-section', 'Causes of death'));
    const tally = el('div.report-tally');
    for (const [cause, n] of causes) tally.appendChild(chip(`${cause} ×${n}`));
    body.appendChild(tally);
  }

  const deaths = (state.log || []).filter((e) => e.kind === 'death').slice(-8);
  if (deaths.length) {
    body.appendChild(el('div.report-section', 'The last of them'));
    for (const e of deaths) {
      body.appendChild(
        el('div.report-line.death', el('span.report-day.mono', `D${e.day % 12}`), el('span', e.text))
      );
    }
  }
}

/**
 * Break the ending prose into paragraphs of three sentences, so a wall of
 * text becomes something you can actually read on a phone.
 */
function paragraphs(text) {
  const sentences = text.split(/(?<=[.?!])\s+(?=[A-Z“"])/);
  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    if (i % 3 === 0) out.push(sentences[i]);
    else out[out.length - 1] += ' ' + sentences[i];
  }
  return out;
}

export default showEnding;
