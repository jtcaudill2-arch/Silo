/**
 * briefing.js — the handover note, presented.
 *
 * One section per screen, Back/Next, and a Skip that is always available and
 * never nags. It reuses the report furniture because it is the same kind of
 * object: a document the player reads at their own pace with the clock
 * stopped.
 *
 * It shows two different documents, and which one is a decision made by the
 * caller. A new silo gets `COLD_OPEN` — two screens, and then the guided
 * first session takes over and does the teaching on the real controls.
 * Settings ⚙ reopens the whole note, because nobody remembers a handover they
 * were shown once at three in the morning, and because everything in it is
 * still true.
 */

import { el, button } from './dom.js';
import { BRIEFING, PREDECESSOR } from '../data/briefing.js';

/**
 * Show the handover. Resolves when the player finishes or skips it.
 * @param {object} opts
 * @param {object[]} [opts.sections] which document to show; the full note by
 *        default, so the Settings entry needs to know nothing about this.
 * @param {function} [opts.onDone] called once, whichever way it ends.
 */
export function showBriefing({ sections = BRIEFING, onDone } = {}) {
  const PAGES = sections.length ? sections : BRIEFING;
  return new Promise((resolve) => {
    // document.body, not #modal-root. The wrap asks for z-index 80 so it sits
    // above the toast rail at 70, and inside `.modal-root` — `position: fixed`
    // with `z-index: 60` — it cannot: a stacking context clamps everything in
    // it to its own layer, so 80 only ever meant "80 within 60". Screenshotted
    // on a two-day return: three unlock toasts painted straight across the
    // headline and the first two lines of the log, which is exactly the moment
    // catch-up fires them. Ordinary modals stay in `.modal-root` on purpose;
    // toasts are meant to be visible over those. This one owns the screen.
    const root = document.body;
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
      if (n >= PAGES.length) return finish();
      page = n;
      const section = PAGES[page];

      eyebrow.textContent = `Handover · ${PREDECESSOR.name} · ${page + 1} of ${PAGES.length}`;
      title.textContent = section.heading;
      headline.textContent = page === 0 ? `${PREDECESSOR.title}, ${PREDECESSOR.years}` : '';
      headline.hidden = page !== 0;

      body.replaceChildren();
      for (const para of section.body) body.appendChild(el('div.briefing-para', para));
      body.appendChild(
        el('div.briefing-dots', ...PAGES.map((_, i) => el('i' + (i === page ? '.on' : ''))))
      );

      backBtn.disabled = page === 0;
      nextBtn.textContent = page === PAGES.length - 1 ? 'Take the desk' : 'Next';
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
