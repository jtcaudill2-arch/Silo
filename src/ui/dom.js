/**
 * dom.js — the only DOM helpers. No framework, no virtual DOM.
 *
 * Panels are rebuilt wholesale on state change rather than diffed. At this
 * scale (a few hundred rows worst case) that is faster than any diffing we'd
 * write, and it removes an entire category of stale-view bug.
 */

/** el('div.row.tappable', {onclick}, children...) */
export function el(spec, props, ...children) {
  const [tagPart, ...classes] = String(spec).split('.');
  const tag = tagPart || 'div';
  const node = document.createElement(tag);
  if (classes.length) node.className = classes.join(' ');

  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class' || k === 'className') node.className = [node.className, v].filter(Boolean).join(' ');
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k in node && k !== 'list') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
  } else if (props !== undefined && props !== null) {
    children.unshift(props);
  }

  append(node, children);
  return node;
}

export function append(node, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

// ------------------------------------------------------------ formatting --

/** Resource counters. Compact but never lossy at the scale it matters. */
export function fmt(n) {
  if (n === Infinity) return '∞';
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (a >= 10_000) return Math.round(n / 1000) + 'k';
  if (a >= 1000) return (n / 1000).toFixed(1) + 'k';
  if (a >= 100) return String(Math.round(n));
  if (a >= 10) return n.toFixed(0);
  return n.toFixed(a < 1 && a > 0 ? 1 : 0);
}

/** Signed per-cycle deltas, always with an explicit sign. */
export function fmtDelta(n, digits = 1) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 0.05) return '±0';
  const s = n > 0 ? '+' : '−';
  return s + Math.abs(n).toFixed(digits);
}

export function fmtPct(n) {
  return Math.round(n) + '%';
}

/** Game clock as the silo would write it. */
export function fmtClock(clock) {
  return `Y${clock.year} D${clock.day % 12}`;
}

/** "3 days", "2 shifts" — used for build times and travel. */
export function fmtDuration(cycles) {
  if (cycles < 8) return `${Math.max(1, Math.round(cycles))} shift${cycles === 1 ? '' : 's'}`;
  const days = cycles / 8;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} day${days === 1 ? '' : 's'}`;
}

export function fmtAge(age) {
  return Math.floor(age);
}

/** Title-case a snake_case id for display. */
export function humanise(id) {
  return String(id)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// -------------------------------------------------------------- fragments --

export function meter(value, max, cls = '') {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return el('div.meter' + (cls ? '.' + cls : ''), el('i', { style: { width: pct + '%' } }));
}

export function chip(text, cls = '') {
  return el('span.chip' + (cls ? '.' + cls : ''), text);
}

export function statTile(k, v, cls = '') {
  return el('div.stat-tile', el('div.k', k), el('div.v' + (cls ? '.' + cls : ''), v));
}

export function sectionLabel(text) {
  return el('div.section-label', text);
}

export function emptyState(text) {
  return el('div.empty', text);
}

/** A tappable list row with title / subtitle / value. */
export function row(opts) {
  const node = el(
    opts.onclick ? 'button.row.tappable' : 'div.row',
    { onclick: opts.onclick, type: opts.onclick ? 'button' : undefined, class: opts.class },
    el('div.row-main', el('div.row-title', opts.title), opts.sub ? el('div.row-sub', opts.sub) : null),
    opts.value !== undefined ? el('div.row-value', opts.value) : null,
    opts.onclick ? el('div.row-chevron', '›') : null
  );
  return node;
}

export function button(label, opts = {}) {
  return el('button.btn' + (opts.class ? '.' + opts.class : ''), {
    type: 'button',
    onclick: opts.onclick,
    disabled: opts.disabled,
    title: opts.title,
  }, label);
}

// ------------------------------------------------------------ interaction --

let modalStack = [];

export function modal({ title, body, actions, onClose, wide }) {
  const root = document.getElementById('modal-root');
  const scrim = el('div.modal-scrim', { onclick: () => close() });
  const box = el(
    'div.modal',
    { style: wide ? { width: 'min(760px, calc(100vw - 24px))' } : null },
    el('div.modal-head', el('div.panel-title', title)),
    el('div.modal-body', body),
    actions && actions.length ? el('div.modal-foot', actions) : null
  );
  const wrap = el('div', scrim, box);
  root.appendChild(wrap);
  modalStack.push(wrap);

  function close() {
    wrap.remove();
    modalStack = modalStack.filter((w) => w !== wrap);
    onClose?.();
  }
  // Focus the first control so keyboard users land inside the dialog.
  (box.querySelector('button, [tabindex]') || box).focus?.();
  return { close, node: box };
}

export function closeTopModal() {
  const top = modalStack.pop();
  if (top) top.remove();
  return !!top;
}

let toastTimer = null;
export function toast(text, kind = '') {
  const root = document.getElementById('toast-root');
  const node = el('div.toast' + (kind ? '.' + kind : ''), text);
  root.appendChild(node);
  clearTimeout(toastTimer);
  setTimeout(() => node.remove(), 3200);
  while (root.children.length > 3) root.firstChild.remove();
}

/** Long-press / drag reorder for the power priority list. */
export function makeReorderable(listNode, onReorder) {
  let dragging = null;
  let startY = 0;
  let originIndex = 0;

  const handleDown = (e) => {
    const handle = e.target.closest('[data-reorder-handle]');
    if (!handle) return;
    const item = handle.closest('[data-reorder-item]');
    if (!item) return;
    e.preventDefault();
    dragging = item;
    originIndex = [...listNode.children].indexOf(item);
    startY = pointerY(e);
    item.classList.add('dragging');
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  const handleMove = (e) => {
    if (!dragging) return;
    e.preventDefault();
    const y = pointerY(e);
    const dy = y - startY;
    dragging.style.transform = `translateY(${dy}px)`;
    const siblings = [...listNode.children].filter((n) => n !== dragging);
    for (const sib of siblings) {
      const r = sib.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      if (y > r.top && y < r.bottom) {
        const before = y < mid;
        listNode.insertBefore(dragging, before ? sib : sib.nextSibling);
        dragging.style.transform = '';
        startY = y;
        break;
      }
    }
  };

  const handleUp = () => {
    if (!dragging) return;
    dragging.style.transform = '';
    dragging.classList.remove('dragging');
    const newIndex = [...listNode.children].indexOf(dragging);
    dragging = null;
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    if (newIndex !== originIndex) {
      onReorder([...listNode.children].map((n) => n.dataset.reorderItem));
    }
  };

  listNode.addEventListener('pointerdown', handleDown);
  return () => listNode.removeEventListener('pointerdown', handleDown);
}

function pointerY(e) {
  return e.touches ? e.touches[0].clientY : e.clientY;
}

export default { el, clear, fmt, fmtDelta, row, button, modal, toast };
