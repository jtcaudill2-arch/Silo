/**
 * research.js — six branch columns and a node graph.
 *
 * The panel's job beyond showing costs: make the "the tree pulls you outside"
 * rule visible. Nodes gated on recovered artifacts say so plainly, name what
 * they need, and show what you have — so a player who has never launched an
 * expedition can see, from this screen, why they're about to have to.
 */

import { BAL } from '../../config/balance.js';
import { BRANCHES, RESEARCH, RESEARCH_LIST, ARTIFACTS, branchNodes, nodeDepth } from '../../data/research.js';
import { canStart, isComplete, missingRequirements, missingArtifacts, effects } from '../../sim/research.js';
import { el, button, sectionLabel, emptyState, meter, chip, toast, fmtDuration, humanise, modal } from '../dom.js';

let branch = 'sustenance';

export const researchPanel = {
  id: 'research',
  title: 'Research',
  nav: 'Research',
  glyph: '⌬',
  subtitle: (s) => `${Math.floor(s.research.points)} RP`,

  badge(state) {
    // Nudge only when there's a project ready to start and nothing running.
    if (state.research.active) return 0;
    return RESEARCH_LIST.some((n) => canStart(state, n.id).ok) ? 1 : 0;
  },

  locked(state) {
    const hasLab = Object.values(state.silo.rooms).some((r) => r.type === 'laboratory');
    if (hasLab || state.research.points > 0 || state.research.completed.length) return null;
    return 'Build a Laboratory first — nothing else in the silo produces research points.';
  },

  render(state, shell) {
    const body = el('div.panel-body');

    body.appendChild(activeSection(state, shell));

    const tabs = el(
      'div.tabs',
      ...Object.values(BRANCHES).map((b) =>
        el(
          'button.tab' + (branch === b.id ? '.active' : ''),
          {
            type: 'button',
            title: b.desc,
            onclick: () => {
              branch = b.id;
              shell.renderPanel(true);
            },
          },
          b.name
        )
      )
    );

    const b = BRANCHES[branch];
    body.appendChild(el('div.note', b.desc));

    const nodes = branchNodes(branch).sort((a, b2) => nodeDepth(a.id) - nodeDepth(b2.id) || a.cost - b2.cost);
    let lastDepth = -1;
    for (const node of nodes) {
      const d = nodeDepth(node.id);
      if (d !== lastDepth) {
        lastDepth = d;
        body.appendChild(sectionLabel(d === 0 ? 'Available now' : `Tier ${d + 1}`));
      }
      body.appendChild(nodeRow(state, shell, node));
    }

    // ---- what the player is carrying -------------------------------------
    const held = Object.entries(state.research.artifacts).filter(([, n]) => n > 0);
    body.appendChild(sectionLabel('Recovered material'));
    if (!held.length) {
      body.appendChild(
        el(
          'div.note',
          'Nothing recovered yet. The deep branches of every tree need material that only exists ' +
            'in the wasteland or in another silo — no amount of research points substitutes.'
        )
      );
    } else {
      const wrap = el('div.artifact-grid');
      for (const [id, n] of held) {
        const a = ARTIFACTS[id];
        wrap.appendChild(
          el(
            'div.artifact',
            el('div.artifact-n.mono', String(n)),
            el('div.artifact-name', a?.name || humanise(id)),
            el('div.artifact-desc', a?.desc || '')
          )
        );
      }
      body.appendChild(wrap);
    }

    return el('div', { style: { display: 'contents' } }, tabs, body);
  },
};

function activeSection(state, shell) {
  const active = state.research.active;
  if (!active) {
    return el(
      'div.active-research.idle',
      el('div.active-title', 'No project running'),
      el('div.active-sub', `${Math.floor(state.research.points)} points banked. Pick something below.`)
    );
  }
  const node = RESEARCH[active.id];
  const pct = node ? active.progress / node.cost : 0;
  const remaining = node ? Math.max(0, node.cost - active.progress) : 0;
  const minLeft = node ? Math.max(0, node.minCycles - active.cycles) : 0;

  return el(
    'div.active-research',
    el('div.active-eyebrow', 'In progress'),
    el('div.active-title', node?.name || active.id),
    meter(active.progress, node?.cost || 1, 'good'),
    el(
      'div.active-sub',
      `${Math.floor(active.progress)} / ${node?.cost || '?'} RP` +
        (remaining > 0 ? `  ·  ${Math.ceil(remaining)} to go` : minLeft > 0 ? `  ·  ${fmtDuration(minLeft)} of lab time left` : '  ·  finishing')
    ),
    button('Abandon', {
      class: 'sm ghost',
      onclick: () => {
        shell.store.dispatch({ type: 'RESEARCH_SET_ACTIVE', active: null });
        toast('Project shelved. Points already spent are not recovered.');
        shell.renderPanel(true);
      },
    })
  );
}

function nodeRow(state, shell, node) {
  const done = isComplete(state, node.id);
  const check = canStart(state, node.id);
  const active = state.research.active?.id === node.id;
  const queued = (state.research.queue || []).includes(node.id);

  const meta = [chip(`${node.cost} RP`)];
  if (node.minCycles) meta.push(chip(fmtDuration(node.minCycles)));
  for (const [aid, n] of Object.entries(node.artifacts)) {
    const have = state.research.artifacts[aid] || 0;
    meta.push(chip(`${ARTIFACTS[aid]?.name || aid} ${have}/${n}`, have >= n ? 'good' : 'rad'));
  }

  const cls = done ? '.done' : active ? '.active' : check.ok ? '' : '.locked';
  return el(
    'button.node-row' + cls,
    {
      type: 'button',
      disabled: done || active,
      onclick: () => openNode(state, shell, node),
    },
    el(
      'div.node-main',
      el('div.node-name', node.name, done ? el('span.node-tick', ' ✓') : null),
      el('div.node-desc', node.desc),
      el('div.node-meta', ...meta),
      !done && !check.ok ? el('div.node-why' + (check.needsExpedition ? '.rad' : ''), check.reason) : null,
      queued ? el('div.node-why', 'Queued.') : null
    ),
    !done ? el('div.row-chevron', '›') : null
  );
}

function openNode(state, shell, node) {
  const check = canStart(state, node.id);
  const body = el('div');
  body.appendChild(el('div.note', node.desc));

  const effectList = el('div.effect-list');
  for (const [k, v] of Object.entries(node.effects)) {
    effectList.appendChild(
      el('div.effect', el('span.effect-k', describeEffect(k)), el('span.effect-v.mono', describeValue(k, v)))
    );
  }
  if (effectList.children.length) {
    body.appendChild(sectionLabel('Effects'));
    body.appendChild(effectList);
  }

  const missingReq = missingRequirements(state, node.id);
  if (missingReq.length) {
    body.appendChild(sectionLabel('Requires'));
    for (const r of missingReq) {
      body.appendChild(el('div.note', RESEARCH[r]?.name || r));
    }
  }

  const missingArt = missingArtifacts(state, node.id);
  if (missingArt.length) {
    body.appendChild(sectionLabel('Recovered material needed'));
    for (const a of missingArt) {
      const def = ARTIFACTS[a.artifact];
      body.appendChild(
        el(
          'div.note.warn',
          `${def?.name || a.artifact} — ${a.have} of ${a.need}. ` +
            `Found in the ${def?.band === 'scar' ? 'Scar' : def?.band === 'deep' ? 'deep waste' : def?.band === 'approach' ? 'silo approaches' : 'mid waste'}.`
        )
      );
    }
  }

  const actions = [];
  if (check.ok) {
    actions.push(
      button('Begin', {
        class: 'primary',
        onclick: () => {
          h.close();
          shell.store.dispatch({
            type: 'RESEARCH_SET_ACTIVE',
            active: { id: node.id, progress: 0, cycles: 0 },
          });
          toast(`Research started: ${node.name}.`);
          shell.renderPanel(true);
        },
      })
    );
  }
  if (!isComplete(state, node.id) && !(state.research.queue || []).includes(node.id)) {
    actions.push(
      button('Queue', {
        onclick: () => {
          h.close();
          const queue = [...(shell.store.state.research.queue || []), node.id].slice(0, BAL.research.maxQueue);
          shell.store.dispatch({ type: 'RESEARCH_QUEUE', queue });
          toast(`${node.name} queued.`);
          shell.renderPanel(true);
        },
      })
    );
  }
  actions.push(button('Close', { onclick: () => h.close() }));

  const h = modal({ title: node.name, body, actions });
}

const EFFECT_LABEL = {
  foodYield: 'Food output', waterYield: 'Water output', powerEfficiency: 'Power draw',
  researchSpeed: 'Research rate', healRate: 'Healing', radTreatment: 'Radiation treatment',
  blightResist: 'Blight resistance', vitalityDecline: 'Ageing', combatBonus: 'Combat power',
  deconEfficiency: 'Decontamination', orderBonus: 'Order', tradeBonus: 'Trade value',
  weaponTier: 'Weapon tier', armorTier: 'Armour tier', suitTier: 'Env-suit tier',
  radioTier: 'Radio range', foodCap: 'Food storage', batteryCap: 'Battery capacity',
  unlockRoom: 'Unlocks', unlockTier: 'Opens floors', unlockPolicy: 'Unlocks policy',
  shiftRotation: 'Shift rotation', travelSpeed: 'Travel speed', mapRange: 'Map range',
  breaching: 'Breaching charges', explosives: 'Explosives', originRecord: 'The Origin Record',
};

function describeEffect(k) {
  return EFFECT_LABEL[k] || humanise(k);
}

function describeValue(k, v) {
  if (Array.isArray(v)) return v.map((x) => humanise(x)).join(', ');
  if (k === 'powerEfficiency' || k === 'vitalityDecline' || k === 'deconFilters' || k === 'shoringCost') {
    return `${v > 0 ? '−' : '+'}${Math.abs(Math.round(v * 100))}%`;
  }
  if (typeof v === 'number' && Math.abs(v) < 3 && !Number.isInteger(v)) {
    return `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
  }
  return String(v);
}

export default researchPanel;
