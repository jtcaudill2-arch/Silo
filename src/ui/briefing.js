/**
 * briefing.js — the handover note, presented.
 *
 * One section per screen, Back/Next, and a Skip that is always available and
 * never nags. It reuses the report furniture because it is the same kind of
 * object: a document the player reads at their own pace with the clock
 * stopped. There are no arrows pointing at buttons and nothing is gated
 * behind "tap here to continue" — the game is read, and so is its tutorial.
 *
 * Reopenable from Settings, because nobody remembers a tutorial they saw
 * once at three in the morning.
 */

import { el, button } from './dom.js';
import { BRIEFING, PREDECESSOR } from '../data/briefing.js';

/**
 * Show the handover. Resolves when the player finishes or skips it.
 * @param {object} opts { onDone } — called once, whichever way it ends.
 */
export function showBriefing({ onDone } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    let page = 0;

    const scrim = el('div.modal-scrim', { style: { pointerEvents: 'auto' } });
    const body = el('div.report-body');
    const eyebrow = el('div.report-eyebrow');
    const title = el('div.report-title');
    const headline = el('div.report-headline');

    const backBtn = button('Back', { class: 'ghost', onclick: () => go(page - 1) });
    const nextBtn = button('Next', { class: 'primary', onclick: () => go(page + 1) });
    const skipBtn = button('Skip', { class: 'ghost', onclick: () => finish() });

    const panel = el(
      'div.report.briefing',
      el('div.report-head', eyebrow, title, headline),
      body,
      el('div.report-foot', skipBtn, backBtn, nextBtn)
    );
    const wrap = el('div.report-wrap', scrim, panel);
    root.appendChild(wrap);

    go(0);

    function go(n) {
      if (n < 0) return;
      if (n >= BRIEFING.length) return finish();
      page = n;
      const section = BRIEFING[page];

      eyebrow.textContent = `Handover · ${PREDECESSOR.name} · ${page + 1} of ${BRIEFING.length}`;
      title.textContent = section.heading;
      headline.textContent = page === 0 ? `${PREDECESSOR.title}, ${PREDECESSOR.years}` : '';
      headline.hidden = page !== 0;

      body.replaceChildren();
      for (const para of section.body) body.appendChild(el('div.briefing-para', para));
      body.appendChild(
        el('div.briefing-dots', ...BRIEFING.map((_, i) => el('i' + (i === page ? '.on' : ''))))
      );

      backBtn.disabled = page === 0;
      nextBtn.textContent = page === BRIEFING.length - 1 ? 'Take the desk' : 'Next';
      body.scrollTop = 0;
      nextBtn.focus();
    }

    function finish() {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      onDone?.();
      resolve();
    }

    const onKey = (e) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight') go(page + 1);
      else if (e.key === 'ArrowLeft') go(page - 1);
    };
    document.addEventListener('keydown', onKey);
  });
}

export default showBriefing;
