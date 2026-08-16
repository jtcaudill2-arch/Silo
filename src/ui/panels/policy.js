/**
 * policy.js — Order, policies, crime, and the investigation.
 *
 * The investigation is the interesting screen. The Sheriff produces evidence,
 * not truth; the player convicts on a number that points the right way *on
 * average*. The panel is careful never to say who did it, and the log after a
 * verdict is deliberately ambiguous — "people are still talking" is the only
 * feedback you get for being wrong.
 */

import { BAL } from '../../config/balance.js';
import { POLICY_LIST, POLICIES } from '../../data/policies.js';
import { policyCapacity, canTogglePolicy, deliverVerdict } from '../../sim/order.js';
import { lockReason } from '../../sim/unlocks.js';
import { fullName, isDissident } from '../../sim/population.js';
import { facePortrait } from '../../render/portraits.js';
import { el, button, row, sectionLabel, emptyState, meter, chip, toast, modal, humanise } from '../dom.js';

export const policyPanel = {
  id: 'policy',
  title: 'Order',
  nav: 'Order',
  glyph: '§',
  subtitle: (s) => `${Math.round(s.order.value)}`,

  badge(state) {
    return (state.order.investigations || []).filter(
      (i) => !i.verdict && state.clock.day >= i.resolvesDay
    ).length;
  },

  /**
   * Last of the gated systems. Politics arrives when there is politics: on a
   * first morning of a silo that is fed, housed and calm there is nothing
   * here to decide, and a panel with nothing in it is one more thing to work
   * out before you can start playing. The condition and the sentence live in
   * sim/unlocks.js with the other four.
   */
  locked(state) {
    return lockReason(state, 'policy');
  },

  render(state, shell) {
    const body = el('div.panel-body');
    const order = state.order.value;
    const cls = order < BAL.order.uprisingThreshold ? 'bad' : order < BAL.order.warnBelow ? 'warn' : 'good';

    body.appendChild(
      el(
        'div.order-head',
        el('div.order-value.mono' + (cls ? '.' + cls : ''), Math.round(order)),
        el(
          'div.order-main',
          el('div.order-label', 'Order'),
          meter(order, 100, cls),
          el('div.order-prose', orderProse(state))
        )
      )
    );

    if (state.order.daysBelowThreshold > 0) {
      body.appendChild(
        el(
          'div.note.bad',
          `Order has been below ${BAL.order.uprisingThreshold} for ` +
            `${state.order.daysBelowThreshold} day${state.order.daysBelowThreshold === 1 ? '' : 's'}. ` +
            `At ${BAL.order.uprisingConsecutiveDays} it starts rolling for an uprising.`
        )
      );
    }

    // ---- investigations awaiting a verdict --------------------------------
    const open = (state.order.investigations || []).filter((i) => !i.verdict);
    for (const inv of open) body.appendChild(investigationCard(state, shell, inv));

    // ---- policies ---------------------------------------------------------
    const cap = policyCapacity(state);
    body.appendChild(sectionLabel(`Policies — ${state.order.policies.length}/${cap} active`));
    body.appendChild(
      el(
        'div.note',
        `Your administration can hold ${cap} at once. That number is set by the best ` +
          'administrator on the payroll — put a better one in the Sheriff’s Office and you get another lever.'
      )
    );

    for (const p of POLICY_LIST) {
      const active = state.order.policies.includes(p.id);
      const check = canTogglePolicy(state, p.id);
      body.appendChild(
        el(
          'button.policy' + (active ? '.active' : '') + (check.ok ? '' : '.locked'),
          {
            type: 'button',
            disabled: !check.ok,
            onclick: () => {
              shell.store.dispatch({ type: 'POLICY_TOGGLE', id: p.id });
              toast(active ? `${p.name} rescinded.` : `${p.name} is in force.`);
              shell.renderPanel(true);
            },
          },
          el('div.policy-switch', active ? '■' : '□'),
          el(
            'div.policy-main',
            el('div.policy-name', p.name),
            el('div.policy-desc', p.desc),
            el(
              'div.policy-trade',
              el('span.policy-benefit', p.benefit),
              el('span.policy-cost', p.cost)
            ),
            !check.ok ? el('div.policy-why', check.reason) : null
          )
        )
      );
    }

    // ---- crime ------------------------------------------------------------
    body.appendChild(sectionLabel('Crime reports'));
    if (!state.order.crimes.length) {
      body.appendChild(emptyState('Nothing reported. That is not the same as nothing happening.'));
    }
    for (const c of state.order.crimes.slice(0, 10)) {
      body.appendChild(
        el(
          'div.crime',
          el('span.crime-day.mono', `D${c.day}`),
          el('span.crime-text', c.text)
        )
      );
    }

    // ---- dissidents (only with the Informant Network) ---------------------
    if (state.order.policies.includes('informants')) {
      const dissidents = state.citizenIds
        .map((id) => state.citizens[id])
        .filter((c) => c && c.status !== 'dead' && isDissident(c));
      body.appendChild(sectionLabel(`Informant reports — ${dissidents.length} names`));
      if (!dissidents.length) body.appendChild(emptyState('Nobody on the list. This week.'));
      for (const c of dissidents.slice(0, 20)) {
        body.appendChild(
          row({
            title: fullName(c),
            sub: `morale ${Math.round(c.morale)} · ${c.job ? 'posted' : 'unassigned'}`,
            value: Math.round(c.morale),
            class: 'bond-bad',
          })
        );
      }
      body.appendChild(
        el('div.note', 'They do not know you know. That is the only advantage this policy buys.')
      );
    }

    return body;
  },
};

function orderProse(state) {
  const v = state.order.value;
  const d = state.order.dissentPressure || 0;
  if (v > 75) return 'The silo is running the way it is supposed to. Nobody is arguing.';
  if (v > 55) return 'Steady. There is grumbling, and grumbling is fine.';
  if (v > 40) return `Strained. Dissent pressure is running at ${d.toFixed(1)}.`;
  if (v > BAL.order.uprisingThreshold) return 'People are angry and they are organising. You can feel it on the stairwells.';
  return 'This is the part where it stops being a management problem.';
}

// -------------------------------------------------------- investigations ---

function investigationCard(state, shell, inv) {
  const ready = state.clock.day >= inv.resolvesDay;
  const victim = state.citizens[inv.victimId];
  const suspects = inv.suspects
    .map((id) => ({ c: state.citizens[id], evidence: inv.evidence[id] || 0 }))
    .filter((x) => x.c)
    .sort((a, b) => b.evidence - a.evidence);
  const maxEvidence = Math.max(1, ...suspects.map((s) => s.evidence));

  return el(
    'div.investigation',
    el('div.inv-title', `The death of ${victim ? fullName(victim) : 'a resident'}`),
    el(
      'div.inv-sub',
      ready
        ? 'The Sheriff has finished. Three names, and a number against each.'
        : `The Sheriff is still working. ${inv.resolvesDay - state.clock.day} day${inv.resolvesDay - state.clock.day === 1 ? '' : 's'} to go.`
    ),
    ...suspects.map((s) =>
      el(
        'div.suspect',
        (() => {
          const p = facePortrait(s.c, 32, state);
          p.className = 'portrait-sm';
          return p;
        })(),
        el(
          'div.suspect-main',
          el('div.suspect-name', fullName(s.c)),
          meter(s.evidence, maxEvidence, s.evidence > maxEvidence * 0.7 ? 'bad' : '')
        ),
        el('div.suspect-ev.mono', Math.round(s.evidence)),
        ready
          ? button('Charge', {
              class: 'sm',
              onclick: () => openVerdict(state, shell, inv, s.c),
            })
          : null
      )
    ),
    ready
      ? el(
          'div.inv-foot',
          el(
            'div.note',
            'Evidence is not proof. The Sheriff produces a number, and the number is right more often ' +
              'than it is wrong. That is all you get.'
          ),
          button('Close the case unsolved', {
            class: 'sm ghost',
            onclick: () => {
              shell.store.dispatchAll(deliverVerdict(shell.store.state, inv.id, null, 'unsolved'));
              toast('The case is closed. Nobody is satisfied.');
              shell.renderPanel(true);
            },
          })
        )
      : null
  );
}

function openVerdict(state, shell, inv, accused) {
  const body = el(
    'div',
    el(
      'div.note',
      `${fullName(accused)} has the strongest evidence against them. ` +
        'You will not be told whether that is the same as being guilty.'
    )
  );
  const h = modal({
    title: `Verdict on ${fullName(accused)}`,
    body,
    actions: [
      button('Cancel', { onclick: () => h.close() }),
      button('Imprison', {
        onclick: () => {
          shell.store.dispatchAll(deliverVerdict(shell.store.state, inv.id, accused.id, 'imprison'));
          h.close();
          toast(`${fullName(accused)} is in holding.`);
          shell.renderPanel(true);
        },
      }),
      button('Execute', {
        class: 'danger',
        onclick: () => {
          shell.store.dispatchAll(deliverVerdict(shell.store.state, inv.id, accused.id, 'execute'));
          h.close();
          toast(`${fullName(accused)} is dead.`, 'bad');
          shell.renderPanel(true);
        },
      }),
    ],
  });
}

export default policyPanel;
