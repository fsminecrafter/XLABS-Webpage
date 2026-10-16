/* Run Studio: the panes (editor, docs, preview), their order, sizes and
 * gutters, docking by dragging a pane's top bar, and minimising, hiding and
 * full-screening them. */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const STORE = 'xlabs.studio.panes.v1';
const MIN = { editor: 260, docs: 240, preview: 260 };
const MIN_STRIP = 38;   // a minimised pane
const NAMES = { editor: 'Editor', docs: 'Docs', preview: 'Preview' };

const main = document.querySelector('main');
const panes = {};
for (const el of main.querySelectorAll('[data-pane]')) panes[el.dataset.pane] = el;

// ---------------------------------------------------------------------
//  State, kept in this browser
// ---------------------------------------------------------------------
let state = {
  order: ['editor', 'docs', 'preview'],
  size: { editor: 0.465, docs: 0.3, preview: 0.5 },
  open: { editor: true, docs: false, preview: true },
  min: { editor: false, docs: false, preview: false },
};
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved && Array.isArray(saved.order) && saved.order.length === 3 && saved.order.every((p) => panes[p])) {
    state.order = saved.order;
    for (const k of ['size', 'open', 'min']) Object.assign(state[k], saved[k] || {});
  } else {
    // the layout before panes could move
    const old = JSON.parse(localStorage.getItem('xlabs.studio.layout.v1') || 'null');
    if (old) { state.open.docs = !!old.open; if (old.editor) state.size.editor = old.editor; if (old.docs) state.size.docs = old.docs; }
  }
} catch (e) { /* storage blocked */ }
state.open.editor = true;
function persist() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* storage blocked */ } }

const listeners = [];
const stacked = () => window.matchMedia('(max-width: 980px)').matches;
const lim = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const visible = () => state.order.filter((p) => state.open[p]);
const full = () => visible().filter((p) => !state.min[p]);

// ---------------------------------------------------------------------
//  Applying the layout
// ---------------------------------------------------------------------
// The last full-size pane takes whatever width is left; the others have a
// fraction of <main>.
function clamp() {
  const W = Math.max(1, main.clientWidth);
  const f = full(), flex = f[f.length - 1], fixed = f.filter((p) => p !== flex);
  const reserved = (visible().length - f.length) * MIN_STRIP + (f.length - 1) * 6;
  let used = 0;
  fixed.forEach((p, i) => {
    const after = fixed.slice(i + 1).reduce((s, q) => s + MIN[q], MIN[flex] + reserved);
    state.size[p] = lim(state.size[p], MIN[p] / W, 1 - used - after / W);
    used += state.size[p];
  });
}

function apply(keepGutters) {
  const f = full(), flex = f[f.length - 1], stack = stacked();
  if (!stack) clamp();
  state.order.forEach((p, i) => {
    const el = panes[p];
    el.hidden = !state.open[p];
    el.style.order = String(i * 2);
    el.classList.toggle('min', !!state.min[p]);
    if (stack) el.style.flex = '';
    else if (state.min[p]) el.style.flex = '0 0 ' + MIN_STRIP + 'px';
    else el.style.flex = p === flex ? '1 1 0' : '0 0 ' + (state.size[p] * 100) + '%';
    const m = el.querySelector('[data-act="min"]');
    if (m) { m.textContent = state.min[p] ? '▢' : '–'; m.title = state.min[p] ? 'Restore' : 'Minimise'; m.setAttribute('aria-label', m.title); }
  });
  for (const id of ['docs', 'preview']) {
    const b = $(id + 'Toggle');
    if (b) b.setAttribute('aria-pressed', String(state.open[id] && !state.min[id]));
  }
  // gutters between neighbouring full-size panes
  if (keepGutters) { for (const fn of listeners) fn(); return; }
  for (const g of main.querySelectorAll('.gutter')) g.remove();
  if (!stack) for (let i = 0; i + 1 < f.length; i++) main.appendChild(gutter(f[i], f[i + 1]));
  for (const fn of listeners) fn();
}

function gutter(left, right) {
  const g = document.createElement('div');
  g.className = 'gutter';
  g.setAttribute('role', 'separator');
  g.setAttribute('aria-orientation', 'vertical');
  g.setAttribute('aria-label', 'Resize ' + NAMES[left] + ' and ' + NAMES[right]);
  g.tabIndex = 0;
  g.title = 'Drag to resize · double-click to reset';
  g.style.order = String(state.order.indexOf(left) * 2 + 1);
  const move = (d) => {
    const W = Math.max(1, main.clientWidth);
    const f = full(), flex = f[f.length - 1];
    if (right === flex) state.size[left] += d;
    else {
      const pair = state.size[left] + state.size[right];
      state.size[left] = lim(state.size[left] + d, MIN[left] / W, pair - MIN[right] / W);
      state.size[right] = pair - state.size[left];
    }
    apply(true);   // keep this gutter: it holds the pointer capture
  };
  g.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    let last = e.clientX;
    const mv = (ev) => { const d = ev.clientX - last; last = ev.clientX; if (d) move(d / Math.max(1, main.clientWidth)); };
    const up = () => {
      g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      document.body.classList.remove('dragging');
      persist();
      apply();
    };
    g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  });
  g.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 64 : 16) / Math.max(1, main.clientWidth);
    if (e.key === 'ArrowLeft') { e.preventDefault(); move(-step); persist(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); move(step); persist(); }
  });
  g.addEventListener('blur', () => apply());
  g.addEventListener('dblclick', () => {
    state.size = { editor: 0.465, docs: 0.3, preview: 0.5 };
    if (state.open.docs && !state.min.docs) state.size.editor = 0.38;
    apply(); persist();
  });
  return g;
}

// ---------------------------------------------------------------------
//  Docking: drag a pane's top bar to put the pane somewhere else
// ---------------------------------------------------------------------
const marker = document.createElement('div');
marker.className = 'dock-marker';
marker.hidden = true;
const ghost = document.createElement('div');
ghost.className = 'dock-ghost';
ghost.hidden = true;
document.body.append(marker, ghost);

function dockTarget(id, x, y) {
  const stack = stacked();
  const others = visible().filter((p) => p !== id);
  const pos = stack ? y : x;
  for (const p of others) {
    const r = panes[p].getBoundingClientRect();
    if (pos < (stack ? r.top + r.height / 2 : r.left + r.width / 2)) return p;
  }
  return null;   // after the last one
}

function placeMarker(id, before) {
  const stack = stacked(), m = main.getBoundingClientRect();
  const others = visible().filter((p) => p !== id);
  let at;
  if (before) { const r = panes[before].getBoundingClientRect(); at = stack ? r.top : r.left; }
  else { const r = panes[others[others.length - 1]].getBoundingClientRect(); at = stack ? r.bottom : r.right; }
  marker.hidden = false;
  // keep it inside <main> when the drop point is an outer edge
  if (stack) Object.assign(marker.style, { left: m.left + 'px', top: Math.max(m.top, Math.min(at - 3, m.bottom - 6)) + 'px', width: m.width + 'px', height: '6px' });
  else Object.assign(marker.style, { left: Math.max(m.left, Math.min(at - 3, m.right - 6)) + 'px', top: m.top + 'px', width: '6px', height: m.height + 'px' });
}

function dockable(id, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, a, input, select, textarea') || state.min[id]) return;
    if (visible().length < 2) return;
    const sx = e.clientX, sy = e.clientY;
    let active = false, before;
    handle.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      if (!active) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return;
        active = true;
        document.body.classList.add('docking');
        panes[id].classList.add('lifted');
        ghost.textContent = 'Move ' + NAMES[id];
        ghost.hidden = false;
      }
      ghost.style.left = (ev.clientX + 14) + 'px';
      ghost.style.top = (ev.clientY + 10) + 'px';
      before = dockTarget(id, ev.clientX, ev.clientY);
      placeMarker(id, before);
    };
    const up = () => {
      handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      if (!active) return;
      document.body.classList.remove('docking');
      panes[id].classList.remove('lifted');
      marker.hidden = true; ghost.hidden = true;
      const order = state.order.filter((p) => p !== id);
      const at = before ? order.indexOf(before) : order.length;
      order.splice(at, 0, id);
      if (order.join() !== state.order.join()) { state.order = order; apply(); persist(); }
    };
    handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
}

// ---------------------------------------------------------------------
//  Minimise, hide, full screen
// ---------------------------------------------------------------------
function setOpen(id, open) {
  if (id === 'editor') return;
  state.open[id] = !!open;
  if (open) state.min[id] = false;
  apply(); persist();
}
function setMin(id, min) { state.min[id] = !!min; apply(); persist(); }

const screen = panes.preview.querySelector('.screen');
const canvas = $('screen');
function fullscreen() {
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  if (screen.classList.contains('fakefs')) { screen.classList.remove('fakefs'); return; }
  const fake = () => { screen.classList.add('fakefs'); canvas.focus({ preventScroll: true }); };
  if (screen.requestFullscreen) screen.requestFullscreen().then(() => canvas.focus({ preventScroll: true }), fake);
  else fake();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && screen.classList.contains('fakefs')) screen.classList.remove('fakefs'); });
$('previewExitFs').addEventListener('click', fullscreen);

for (const [id, el] of Object.entries(panes)) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !el.contains(b)) return;
    const act = b.dataset.act;
    if (act === 'min') setMin(id, !state.min[id]);
    else if (act === 'close') setOpen(id, false);
    else if (act === 'full') fullscreen();
  });
  const head = el.querySelector('.phead');
  if (head) {
    dockable(id, head);
    // a click on a minimised strip restores it
    head.addEventListener('click', (e) => { if (state.min[id] && !e.target.closest('[data-act]')) setMin(id, false); });
  }
}
dockable('editor', $('tabs'));   // the empty part of the tab bar

window.StudioLayout = {
  isOpen: (id) => !!state.open[id] && !state.min[id],
  setOpen,
  toggle(id) { if (state.open[id] && !state.min[id]) setOpen(id, false); else setOpen(id, true); },
  // make sure a pane can be seen (Run shows the preview)
  reveal(id) { if (!state.open[id] || state.min[id]) { state.open[id] = true; state.min[id] = false; apply(); persist(); } },
  minimise: setMin,
  fullscreen,
  onChange(fn) { listeners.push(fn); },
};

$('previewToggle').addEventListener('click', () => window.StudioLayout.toggle('preview'));
window.addEventListener('resize', apply);
apply();
})();
