/**
 * radio.js — the world board.
 *
 * Twenty silos including yours, what you know about each, and what you can
 * say to them. The memory list is shown in full on a silo's card, because
 * "they remember" is only a real mechanic if the player can see the ledger
 * they are being judged against.
 */

import { BAL } from '../../config/balance.js';
import { siloDef, ARCHETYPES, PLAYER_SILO_ID } from '../../data/silos.js';
import {
  availableActions, evaluate, perform, bundleValue, hasTreaty,
  conquestState, canAdvance, CONQUEST_STAGES,
} from '../../sim/diplomacy.js';
import { canLaunchRun } from '../../sim/conquest.js';
import { launchConquest, canLaunch } from '../../sim/expedition.js';
import { squadMembers } from '../../sim/military.js';
import { inRange, playerPower } from '../../sim/world.js';
import { lockReason } from '../../sim/unlocks.js';
import { el, button, row, sectionLabel, emptyState, meter, chip, toast, modal, humanise, fmt } from '../dom.js';

let tab = 'board';

const CONTACT_LABEL = {
  none: 'no contact', radio: 'in contact', trade: 'trading',
  allied: 'allied', hostile: 'hostile', war: 'AT WAR', satellite: 'satellite',
};

export const radioPanel = {
  id: 'radio',
  title: 'Radio',
  nav: 'World',
  glyph: '((•))',
  subtitle: (s) => {
    const known = Object.values(s.world.silos).filter((x) => x.known).length;
    return `${known}/19 known`;
  },

  badge(state) {
    return (state.world.pending || []).filter((e) => e.kind === 'call_to_arms_pending').length;
  },

  // Second of the gated systems: Radio Range I is the cheapest root that
  // opens a panel and needs nothing from outside, which is what puts it ahead
  // of the surface. The condition and the sentence live in sim/unlocks.js.
  locked(state) {
    return lockReason(state, 'radio');
  },

  render(state, shell) {
    const body = el('div.panel-body');
    const tabs = el(
      'div.tabs',
      tabBtn('board', 'The board', shell),
      tabBtn('traffic', 'Traffic', shell)
    );

    if (tab === 'traffic') {
      renderTraffic(state, body);
      return el('div', { style: { display: 'contents' } }, tabs, body);
    }

    // Anything the world is waiting on an answer for goes first.
    const pending = (state.world.pending || []).filter((e) => e.kind === 'call_to_arms_pending');
    for (const event of pending) {
      body.appendChild(callToArms(state, shell, event));
    }

    const mine = playerPower(state);
    body.appendChild(
      el(
        'div.grid-3',
        tile('Radio range', `T${state.world.radioTier}`),
        tile('Allies', Object.values(state.world.silos).filter((s) => hasTreaty(s, 'alliance')).length, 'good'),
        tile('At war', Object.values(state.world.silos).filter((s) => hasTreaty(s, 'war')).length, 'bad')
      )
    );

    const silos = Object.values(state.world.silos).sort((a, b) => a.id - b.id);
    const known = silos.filter((s) => s.known);
    const unknown = silos.filter((s) => !s.known);

    body.appendChild(sectionLabel('Known'));
    if (!known.length) body.appendChild(emptyState('Nothing but static so far. Try hailing.'));
    for (const silo of known) body.appendChild(siloRow(state, shell, silo));

    if (unknown.length) {
      body.appendChild(sectionLabel(`Unlisted — ${unknown.length} silos`));
      body.appendChild(
        el(
          'div.note',
          'Nineteen were built alongside yours. Expeditions and better radio range find the rest.'
        )
      );
      body.appendChild(
        el(
          'div.pad',
          button('Sweep the band', {
            class: 'wide',
            onclick: () => sweep(state, shell, unknown),
          })
        )
      );
    }

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

function siloRow(state, shell, silo) {
  const def = siloDef(silo.id);
  const reach = inRange(state, silo);
  const rep = silo.reputation;
  const repCls = rep > 25 ? 'good' : rep < -25 ? 'bad' : '';

  return el(
    'button.silo-row' + (silo.status === 'collapsed' ? '.collapsed' : '') + (hasTreaty(silo, 'war') ? '.war' : ''),
    { type: 'button', onclick: () => openSilo(state, shell, silo) },
    el('div.silo-n.mono', String(silo.id)),
    el(
      'div.silo-main',
      el('div.silo-name', silo.name, silo.id === PLAYER_SILO_ID ? el('span.silo-you', ' — you') : null),
      el(
        'div.silo-sub',
        silo.status === 'collapsed'
          ? 'Collapsed. Nobody is answering.'
          : `${ARCHETYPES[silo.archetype]?.name || 'Unknown'} · ${silo.mayorName || 'no known mayor'}`
      ),
      el(
        'div.silo-meta',
        chip(CONTACT_LABEL[silo.contact] || silo.contact, contactClass(silo)),
        silo.status !== 'collapsed' ? chip(silo.status) : null,
        !reach && silo.contact === 'none' ? chip('out of range', 'warn') : null,
        def?.specialty ? chip(def.specialty) : null
      )
    ),
    el(
      'div.silo-right',
      el('div.silo-rep.mono' + (repCls ? '.' + repCls : ''), rep > 0 ? `+${Math.round(rep)}` : Math.round(rep)),
      el('div.silo-rep-k', 'rep')
    )
  );
}

function contactClass(silo) {
  if (hasTreaty(silo, 'war')) return 'bad';
  if (silo.contact === 'allied' || silo.contact === 'trade') return 'good';
  if (silo.contact === 'hostile') return 'bad';
  return '';
}

// ------------------------------------------------------------- silo card ---

function openSilo(state, shell, silo) {
  const def = siloDef(silo.id);
  const body = el('div');

  if (silo.id === PLAYER_SILO_ID) {
    const mine = playerPower(state);
    body.appendChild(el('div.note', 'Yours. This is how the rest of the board reads you.'));
    body.appendChild(powerBars(mine));
    const h0 = modal({ title: silo.name, body, actions: [button('Close', { onclick: () => h0.close() })] });
    return;
  }

  body.appendChild(el('div.note', def?.hook || ''));

  if (silo.status === 'collapsed') {
    body.appendChild(el('div.note.warn', 'Nothing on their frequency but the carrier. Salvage only.'));
    if (def?.salvageTier) {
      body.appendChild(
        row({
          title: 'Salvage value',
          sub: `Reward tier ${def.salvageTier}. Send an approach expedition.`,
          value: `T${def.salvageTier}`,
        })
      );
    }
  } else {
    body.appendChild(powerBars(silo.power));
    body.appendChild(sectionLabel('Disposition'));
    body.appendChild(dispositionBars(silo.disposition));
  }

  // ---- reputation and memory ---------------------------------------------
  body.appendChild(sectionLabel('Standing'));
  body.appendChild(
    el(
      'div.pad',
      meter(silo.reputation + 100, 200, silo.reputation > 0 ? 'good' : 'bad'),
      el('div.note', reputationProse(silo))
    )
  );

  if ((silo.memory || []).length) {
    body.appendChild(sectionLabel('What they remember'));
    for (const m of [...silo.memory].reverse().slice(0, 10)) {
      body.appendChild(
        el(
          'div.memory' + (m.weight >= 0 ? '.good' : '.bad'),
          el('span.memory-day.mono', `D${m.day}`),
          el('span.memory-text', m.text),
          el('span.memory-w.mono', m.weight > 0 ? `+${m.weight.toFixed(1)}` : m.weight.toFixed(1))
        )
      );
    }
    body.appendChild(
      el('div.note', 'Memories fade but never clear. A broken deal is on this list for good.')
    );
  }

  // ---- treaties -----------------------------------------------------------
  if ((silo.treaties || []).length) {
    body.appendChild(sectionLabel('Treaties'));
    for (const t of silo.treaties) {
      body.appendChild(
        row({
          title: humanise(t.kind),
          sub: t.with === PLAYER_SILO_ID ? `Signed day ${t.since}.` : `With Silo ${t.with}.`,
        })
      );
    }
  }

  // ---- actions ------------------------------------------------------------
  const actions = availableActions(state, silo);
  body.appendChild(sectionLabel('Transmit'));
  if (!inRange(state, silo) && silo.contact === 'none') {
    body.appendChild(el('div.note.warn', 'Out of radio range. Research a longer range, or find them on foot.'));
  }
  const grid = el('div.diplo-grid');
  for (const action of actions) {
    const verdict = silo.contact !== 'none' || action.id === 'hail'
      ? evaluate(state, silo, { action: action.id, give: {}, want: {} })
      : null;
    grid.appendChild(
      el(
        'button.diplo-btn' + (action.hostile ? '.hostile' : ''),
        {
          type: 'button',
          disabled: !inRange(state, silo) && silo.contact === 'none',
          title: action.desc,
          onclick: () => {
            if (action.give || action.want) openOffer(state, shell, silo, action, h);
            else {
              shell.store.dispatchAll(perform(shell.store.state, silo.id, action.id));
              h.close();
              shell.renderPanel(true);
            }
          },
        },
        el('span.diplo-label', action.label),
        verdict
          ? el(
              'span.diplo-odds.mono' + (verdict.accepted ? '.good' : '.bad'),
              verdict.accepted ? 'likely' : 'unlikely'
            )
          : null
      )
    );
  }
  body.appendChild(grid);

  // ---- conquest -----------------------------------------------------------
  if (silo.status !== 'collapsed' && silo.contact !== 'satellite') {
    body.appendChild(sectionLabel('Taking it'));
    const c = conquestState(state, silo.id);
    const check = canAdvance(state, silo.id);
    for (const stage of CONQUEST_STAGES) {
      const done = stageIndex(c.stage) > stageIndex(stage.id);
      const current = (c.stage || 'scout') === stage.id;
      body.appendChild(
        el(
          'div.conquest-stage' + (done ? '.done' : current ? '.current' : ''),
          el('div.conquest-name', `${stage.name}${done ? ' ✓' : ''}`),
          el('div.conquest-desc', stage.desc),
          current && !check.ok ? el('div.conquest-why', check.reason) : null
        )
      );
    }
    // The button this panel spent six phases describing and never had. Until
    // it existed the four stages above were a status readout of a ladder with
    // no rungs: `CONQUEST_PATCH` was dispatched from nowhere in src/, so no
    // amount of playing could move a conquest off 'scout'.
    body.appendChild(conquestLaunch(state, shell, silo));
    body.appendChild(
      el(
        'div.note',
        // "contribute at 40%" reads as 40% of a silo whose economy bar shows
        // 97. It is 40% of a flat daily figure, scaled again by economy and
        // again by the holding's own order — so the honest thing to show is
        // what actually arrives.
        'Four stages, each a separate expedition on the Silo approach band. A held silo sends back ' +
          `about ${satelliteYieldEstimate(silo)} crates a day once it settles, needs a garrison squad ` +
          `standing on it, and costs ${Math.abs(BAL.conquest.satelliteOrderPerDay)} Order a day. ` +
          'Two is comfortable. Five will break you.'
      )
    );
  }

  const h = modal({
    title: `${silo.name} · Silo ${silo.id}`,
    body,
    wide: true,
    actions: [button('Close', { onclick: () => h.close() })],
  });
}

/**
 * Send a squad on the current stage, or say exactly why not.
 *
 * Two gates have to pass and they fail for different reasons, so both are
 * reported rather than collapsed into one "cannot": `canLaunchRun` knows
 * about the conquest ladder (charges unresearched, defences unmapped), and
 * `canLaunch` knows about going outside at all (no suits, no supplies, the
 * airlock is too small). A player told only "you cannot do this" goes looking
 * in the wrong panel.
 */
function conquestLaunch(state, shell, silo) {
  const gate = canLaunchRun(state, silo.id);
  const stage = CONQUEST_STAGES.find((s) => s.id === gate.stage);
  const label = stage ? `Send a squad — ${stage.name}` : 'Send a squad';

  if (!gate.ok) return el('div.conquest-why', gate.reason);

  const squads = state.military.squadIds
    .map((id) => state.military.squads[id])
    .filter((sq) => !sq.deployed && squadMembers(state, sq.id).length >= BAL.military.squadMin);

  if (!squads.length) return el('div.conquest-why', 'No squad of ' + BAL.military.squadMin + '+ is standing by.');

  // Every standing squad fails `canLaunch` for the same reason far more often
  // than not — suits and supplies are silo-wide — so the first refusal is a
  // fair thing to show, and it is the one the player has to fix.
  const ready = squads.find((sq) => canLaunch(state, sq.id, BAL.conquest.band).ok);
  if (!ready) {
    return el('div.conquest-why', canLaunch(state, squads[0].id, BAL.conquest.band).reason);
  }

  return button(`${label} (${ready.name})`, {
    onclick: () => {
      // Report what happened, not what was attempted.
      //
      // `launchConquest` returns [] on the in-flight guard and on any
      // `canLaunch` failure, and this toasted regardless. The modal is a
      // one-shot DOM tree — `renderPanel` redraws the panel behind it, not
      // this — so the button and its captured squad stay on screen after the
      // first launch, and pressing it again said "Second is on its way" while
      // dispatching nothing at all.
      const acts = launchConquest(shell.store.state, ready.id, silo.id);
      if (!acts.length) {
        // Three things can refuse it — the ladder, the supplies, or a run
        // already in flight — and only the first two carry a reason.
        const now = shell.store.state;
        const why = canLaunchRun(now, silo.id).reason
          || canLaunch(now, ready.id, BAL.conquest.band).reason
          || `${ready.name} is already out.`;
        toast(why);
        shell.renderPanel(true);
        return;
      }
      shell.store.dispatchAll(acts);
      toast(`${ready.name} is on its way to ${silo.name}.`);
      shell.renderPanel(true);
    },
  });
}

/**
 * What a holding would actually send home, per day, once its order has warmed.
 *
 * Shown rather than the efficiency percentage because the percentage is not
 * the number the player gets: it is one of three multipliers on a flat base.
 */
function satelliteYieldEstimate(silo) {
  const Q = BAL.conquest;
  const scale = ((silo?.power?.economy ?? 50) / 100) * Q.satelliteEfficiency;
  return Math.round((Q.satelliteYieldPerDay + Q.satelliteChitsPerDay) * scale);
}

function stageIndex(id) {
  const i = CONQUEST_STAGES.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
}

function powerBars(power) {
  const wrap = el('div.power-bars');
  for (const [k, v] of Object.entries(power)) {
    wrap.appendChild(
      el(
        'div.power-bar',
        el('span.power-k', humanise(k)),
        meter(v, 100, v > 66 ? 'good' : v < 33 ? 'bad' : ''),
        el('span.power-v.mono', Math.round(v))
      )
    );
  }
  return wrap;
}

function dispositionBars(d) {
  const wrap = el('div.power-bars');
  for (const [k, v] of Object.entries(d)) {
    wrap.appendChild(
      el(
        'div.power-bar',
        el('span.power-k', humanise(k)),
        meter(v * 100, 100, k === 'honesty' ? (v > 0.7 ? 'good' : '') : v > 0.7 ? 'bad' : ''),
        el('span.power-v.mono', Math.round(v * 100))
      )
    );
  }
  return wrap;
}

function reputationProse(silo) {
  const r = silo.reputation;
  if (r > 60) return 'They would take your call at any hour.';
  if (r > 25) return 'Warm. They think Silo 12 is worth knowing.';
  if (r > -10) return 'Neutral. You are a frequency to them, not a friend.';
  if (r > -50) return 'Cold. They have reasons, and they are on the list below.';
  return 'They would like to see Silo 12 stop transmitting.';
}

// ----------------------------------------------------------------- offers ---

function openOffer(state, shell, silo, action, parent) {
  const give = {};
  const want = {};
  const OFFERABLE = ['food', 'water', 'scrap', 'parts', 'alloy', 'meds', 'ammo', 'fuel', 'filters', 'chits'];

  const body = el('div');
  const render = () => {
    body.replaceChildren();
    body.appendChild(el('div.note', action.desc));

    if (action.give) {
      body.appendChild(sectionLabel('You send'));
      for (const k of OFFERABLE) {
        const have = Math.floor(state.resources[k] || 0);
        if (have <= 0) continue;
        body.appendChild(stepper(k, give, have, render));
      }
    }
    if (action.want) {
      body.appendChild(sectionLabel('You ask for'));
      for (const k of OFFERABLE) {
        body.appendChild(stepper(k, want, 400, render));
      }
    }

    const verdict = evaluate(state, silo, { action: action.id, give, want });
    body.appendChild(
      el(
        'div.offer-verdict' + (verdict.accepted ? '.good' : '.bad'),
        el('div.offer-headline', verdict.accepted ? 'They would take this.' : 'They would refuse this.'),
        el(
          'div.offer-terms',
          ...Object.entries(verdict.terms)
            .filter(([, v]) => Math.abs(v) > 0.5)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) =>
              el('span.offer-term' + (v > 0 ? '.up' : '.down'), `${humanise(k)} ${v > 0 ? '+' : ''}${Math.round(v)}`)
            )
        ),
        el('div.offer-score.mono', `${Math.round(verdict.score)} vs threshold ${verdict.threshold}`)
      )
    );

    body.appendChild(
      el(
        'div.pad',
        button('Transmit', {
          class: 'primary wide',
          disabled: (action.give && bundleValue(give) <= 0) && action.id !== 'trade',
          onclick: () => {
            shell.store.dispatchAll(perform(shell.store.state, silo.id, action.id, { give, want }));
            h.close();
            parent?.close();
            shell.renderPanel(true);
          },
        })
      )
    );
  };

  render();
  const h = modal({ title: `${action.label} — ${silo.name}`, body, actions: [button('Cancel', { onclick: () => h.close() })] });
}

function stepper(key, bundle, max, onChange) {
  const value = bundle[key] || 0;
  const step = max > 200 ? 25 : max > 60 ? 10 : 5;
  return el(
    'div.stepper',
    el('span.stepper-k', humanise(key)),
    button('−', {
      class: 'sm',
      disabled: value <= 0,
      onclick: () => {
        bundle[key] = Math.max(0, value - step);
        if (!bundle[key]) delete bundle[key];
        onChange();
      },
    }),
    el('span.stepper-v.mono', String(value)),
    button('+', {
      class: 'sm',
      disabled: value + step > max,
      onclick: () => {
        bundle[key] = value + step;
        onChange();
      },
    }),
    el('span.stepper-max.mono', `/${Math.floor(max)}`)
  );
}

// -------------------------------------------------------------- traffic ---

function renderTraffic(state, body) {
  const t = state.world.transmissions || [];
  if (!t.length) {
    body.appendChild(emptyState('The band is quiet. Or you are not listening hard enough.'));
    return;
  }
  for (const msg of t) {
    const silo = state.world.silos[msg.siloId];
    body.appendChild(
      el(
        'div.transmission' + (msg.kind ? '.' + msg.kind : ''),
        el('div.transmission-head', el('span.transmission-from', silo?.name || 'Unknown'), el('span.transmission-day.mono', `D${msg.day}`)),
        el('div.transmission-text', msg.text)
      )
    );
  }
}

// ---------------------------------------------------------- call to arms ---

function callToArms(state, shell, event) {
  const silo = state.world.silos[event.siloId];
  return el(
    'div.call-to-arms',
    el('div.call-title', `${silo?.name || 'An ally'} is invoking the alliance`),
    el(
      'div.call-sub',
      'They are under attack and they are asking for the squad you promised. ' +
        `Refusing costs ${Math.abs(BAL.diplomacy.allyCallToArmsRefusalRep)} reputation with them, and ` +
        'every silo that can hear you learns that Silo 12 does not honour pacts.'
    ),
    el(
      'div.call-actions',
      button('Answer the call', {
        class: 'primary',
        onclick: () => {
          shell.store.dispatchAll([
            { type: 'WORLD_EVENT_RESOLVE', event },
            { type: 'SILO_REPUTATION', siloId: silo.id, amount: 22 },
            { type: 'SILO_MEMORY', siloId: silo.id, entry: { day: state.clock.day, kind: 'honored', weight: 20, text: 'Silo 12 came when we called.' } },
            { type: 'ORDER_DELTA', amount: -3, reason: 'sending people to somebody else’s war' },
            { type: 'LOG', entry: { kind: 'diplomacy', text: `Silo 12 answered ${silo.name}'s call. They will not forget it.` } },
          ]);
          toast('The squad is committed.');
          shell.renderPanel(true);
        },
      }),
      button('Refuse', {
        class: 'danger',
        onclick: () => {
          shell.store.dispatchAll([
            { type: 'WORLD_EVENT_RESOLVE', event },
            { type: 'SILO_REPUTATION', siloId: silo.id, amount: BAL.diplomacy.allyCallToArmsRefusalRep },
            { type: 'SILO_TREATY', siloId: silo.id, remove: 'alliance' },
            { type: 'SILO_MEMORY', siloId: silo.id, entry: { day: state.clock.day, kind: 'broken', weight: -35, text: 'We called and Silo 12 did not come.' } },
            { type: 'BROADCAST_REPUTATION', amount: BAL.diplomacy.allyCallToArmsBroadcastRep, except: [silo.id], reason: 'Silo 12 refusing a call to arms' },
            { type: 'LOG', entry: { kind: 'diplomacy', text: `Silo 12 refused ${silo.name}. The alliance is over and everyone heard.` } },
          ]);
          toast('You let them ask twice and then said no.', 'bad');
          shell.renderPanel(true);
        },
      })
    )
  );
}

function sweep(state, shell, unknown) {
  const reachable = unknown.filter((s) => inRange(state, s));
  if (!reachable.length) {
    toast('Nothing in range that you have not already found.');
    return;
  }
  const found = reachable[0];
  shell.store.dispatchAll([
    { type: 'SILO_DISCOVER', siloId: found.id },
    { type: 'RESOURCE_DELTA', deltas: { power: -8 } },
  ]);
  toast(`${found.name} is on the board.`);
  shell.renderPanel(true);
}

function tile(k, v, cls = '') {
  return el('div.stat-tile', el('div.k', k), el('div.v' + (cls ? '.' + cls : ''), String(v)));
}

export default radioPanel;
