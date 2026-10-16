/* Run Studio: the docs pane, and the draggable gutters between the panes. */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const DATA = window.STUDIO_DOCS || { categories: [], functions: {} };
const STORE = 'xlabs.studio.layout.v1';
const MIN = { editor: 260, docs: 240, preview: 260 };

const main = document.querySelector('main');
const editor = document.querySelector('.pane.editor');
const preview = document.querySelector('.pane.preview');
const pane = $('docsPane'), side = $('docsSide'), content = $('docsContent'), list = $('docsList'), search = $('docsSearch');
const gutterA = $('gutterA'), gutterB = $('gutterB');

const pages = new Map();
for (const c of DATA.categories) for (const p of c.pages) pages.set(p.id, Object.assign({ category: c.name }, p));
const fnNames = Object.keys(DATA.functions).sort((a, b) => a.replace(/^mos_/, '').localeCompare(b.replace(/^mos_/, '')));

// ---------------------------------------------------------------------
//  Layout state: pane widths as fractions of <main>, kept in this browser
// ---------------------------------------------------------------------
let state = { open: false, editor: 0.465, docs: 0.3, side: true, page: 'sdk-functions', anchor: '' };
try { Object.assign(state, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) { /* storage blocked */ }
function persist() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* storage blocked */ } }

let onResize = () => {};
const stacked = () => window.matchMedia('(max-width: 980px)').matches;

function apply() {
  pane.hidden = !state.open;
  gutterB.hidden = !state.open;
  $('docsToggle').setAttribute('aria-pressed', String(state.open));
  side.hidden = !state.side;
  pane.classList.toggle('noside', !state.side);
  const t = $('docsSideToggle');
  t.setAttribute('aria-expanded', String(state.side));
  t.title = state.side ? 'Hide the page list' : 'Show the page list';
  if (stacked()) {
    editor.style.flexBasis = pane.style.flexBasis = '';
  } else {
    clamp();
    editor.style.flexBasis = (state.editor * 100) + '%';
    pane.style.flexBasis = (state.docs * 100) + '%';
  }
  for (const g of [gutterA, gutterB]) {
    const left = g === gutterA ? editor : pane;
    g.setAttribute('aria-valuenow', String(Math.round((left.getBoundingClientRect().width / Math.max(1, main.clientWidth)) * 100)));
  }
  onResize();
}

// Keep every visible pane at least its minimum width.
const lim = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
function mins() { const W = Math.max(1, main.clientWidth); return { e: MIN.editor / W, d: MIN.docs / W, p: MIN.preview / W }; }
function clamp() {
  const m = mins();
  if (state.open) {
    state.docs = lim(state.docs, m.d, 1 - m.e - m.p);
    state.editor = lim(state.editor, m.e, 1 - state.docs - m.p);
  } else state.editor = lim(state.editor, m.e, 1 - m.p);
}

// A gutter trades width between the two panes on either side of it.
function drag(gutter) {
  const move = (d) => {
    const m = mins();
    if (gutter === gutterB) state.docs = lim(state.docs + d, m.d, 1 - state.editor - m.p);
    else if (state.open) {
      const pair = state.editor + state.docs;
      state.editor = lim(state.editor + d, m.e, pair - m.d);
      state.docs = pair - state.editor;
    } else state.editor = lim(state.editor + d, m.e, 1 - m.p);
    apply();
  };
  gutter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    gutter.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    let last = e.clientX;
    const mv = (ev) => { const d = ev.clientX - last; last = ev.clientX; if (d) move(d / Math.max(1, main.clientWidth)); };
    const up = () => {
      gutter.removeEventListener('pointermove', mv); gutter.removeEventListener('pointerup', up); gutter.removeEventListener('pointercancel', up);
      document.body.classList.remove('dragging');
      persist();
    };
    gutter.addEventListener('pointermove', mv); gutter.addEventListener('pointerup', up); gutter.addEventListener('pointercancel', up);
  });
  gutter.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 64 : 16) / Math.max(1, main.clientWidth);
    if (e.key === 'ArrowLeft') { e.preventDefault(); move(-step); persist(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); move(step); persist(); }
  });
  gutter.addEventListener('dblclick', () => {
    if (gutter === gutterA) state.editor = state.open ? 0.38 : 0.465; else state.docs = 0.3;
    apply(); persist();
  });
}

// ---------------------------------------------------------------------
//  Page list
// ---------------------------------------------------------------------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

function renderList() {
  list.textContent = '';
  const q = search.value.trim().toLowerCase();
  if (q) {
    const hits = fnNames.filter(n => n.toLowerCase().includes(q)).slice(0, 80);
    const pageHits = [...pages.values()].filter(p => p.label.toLowerCase().includes(q));
    if (!hits.length && !pageHits.length) list.appendChild(el('p', 'dempty', 'Nothing matches “' + search.value.trim() + '”.'));
    for (const p of pageHits) list.appendChild(pageButton(p));
    if (hits.length) {
      list.appendChild(el('span', 'dcat', 'Functions'));
      for (const n of hits) {
        const [pg, anchor] = DATA.functions[n].split('/');
        const b = el('button', 'dfn');
        b.appendChild(el('code', '', n));
        const sub = pages.get(pg);
        if (sub) b.appendChild(el('small', '', sub.label));
        b.addEventListener('click', () => go(pg, anchor));
        list.appendChild(b);
      }
    }
    return;
  }
  for (const c of DATA.categories) {
    list.appendChild(el('span', 'dcat', c.name));
    for (const p of c.pages) {
      const id = pages.get(p.id);
      list.appendChild(pageButton(id));
      if (p.id === state.page) {
        const fns = (p.sections || []).filter(s => s.fn);
        if (fns.length) {
          const box = el('div', 'dsub');
          for (const s of fns) {
            const b = el('button', 'dfn' + (s.id === state.anchor ? ' cur' : ''));
            b.appendChild(el('code', '', s.name));
            b.addEventListener('click', () => go(p.id, s.id));
            box.appendChild(b);
          }
          list.appendChild(box);
        }
      }
    }
  }
}

function pageButton(p) {
  const b = el('button', 'dpage', p.label);
  if (p.id === state.page) b.setAttribute('aria-current', 'page');
  b.addEventListener('click', () => go(p.id, ''));
  return b;
}

// ---------------------------------------------------------------------
//  Content
// ---------------------------------------------------------------------
const back = [];

function show(pageId, anchor) {
  const p = pages.get(pageId) || pages.get('sdk-functions') || pages.values().next().value;
  if (!p) { content.textContent = 'No documentation was bundled with this page.'; return; }
  if (content.dataset.page !== p.id) {
    content.innerHTML = p.html;
    content.dataset.page = p.id;
    for (const pre of content.querySelectorAll('pre')) {
      const c = el('button', 'dcopy', 'Copy');
      c.type = 'button';
      c.addEventListener('click', () => {
        const text = pre.querySelector('code') ? pre.querySelector('code').textContent : pre.textContent;
        const done = () => { c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy'; }, 1200); };
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {}); else done();
      });
      pre.appendChild(c);
    }
  }
  state.page = p.id; state.anchor = anchor || '';
  $('docsTitle').textContent = p.label;
  $('docsTitle').title = p.category + ' › ' + p.label;
  $('docsExternal').href = '../#/docs/' + p.id + (anchor ? '/' + anchor : '');
  const target = anchor && content.querySelector('[id="' + p.id + '--' + anchor + '"]');
  if (target) {
    content.scrollTop = target.offsetTop - 8;
    target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
  } else content.scrollTop = 0;
  $('docsBack').disabled = !back.length;
  renderList();
  const cur = list.querySelector('.dfn.cur') || list.querySelector('[aria-current]');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  persist();
}

function go(pageId, anchor) {
  if (pageId !== state.page || (anchor || '') !== state.anchor) back.push([state.page, state.anchor]);
  if (back.length > 50) back.shift();
  show(pageId, anchor);
}

content.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const h = a.getAttribute('href');
  const m = h.match(/^#\/docs\/([\w-]+)(?:\/([\w-]+))?$/);
  e.preventDefault();
  if (m && pages.has(m[1])) { go(m[1], m[2] || ''); return; }
  window.open(/^[a-z]+:/i.test(h) ? h : new URL('../' + h, location.href).href, '_blank', 'noopener');
});

// ---------------------------------------------------------------------
//  Public
// ---------------------------------------------------------------------
function setOpen(open) {
  if (open && !state.open) {
    // make room: the docs pane takes its width from the editor and the preview
    const W = Math.max(1, main.clientWidth);
    if (state.editor + state.docs > 1 - MIN.preview / W) state.editor = Math.max(MIN.editor / W, 1 - MIN.preview / W - state.docs);
  }
  state.open = open;
  apply();
  persist();
  if (open && content.dataset.page !== state.page) show(state.page, state.anchor);
}

window.DocsView = {
  // open('mos_window_create') or open('sdk-files', 'mos_open') or open()
  open(name, anchor) {
    setOpen(true);
    if (name && DATA.functions[name] && anchor === undefined) { const [p, a] = DATA.functions[name].split('/'); go(p, a); }
    else if (name && pages.has(name)) go(name, anchor || '');
  },
  toggle() { setOpen(!state.open); },
  isOpen: () => state.open,
  has: (name) => !!DATA.functions[name],
  set onResize(fn) { onResize = fn || (() => {}); },
};

$('docsToggle').addEventListener('click', () => window.DocsView.toggle());
$('docsClose').addEventListener('click', () => setOpen(false));
$('docsSideToggle').addEventListener('click', () => { state.side = !state.side; apply(); persist(); if (state.side) search.focus(); });
$('docsBack').addEventListener('click', () => { const b = back.pop(); if (b) show(b[0], b[1]); });
search.addEventListener('input', renderList);
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = list.querySelector('button'); if (first) first.click(); }
  else if (e.key === 'Escape') { search.value = ''; renderList(); }
});
drag(gutterA); drag(gutterB);
window.addEventListener('resize', apply);
apply();
if (state.open) show(state.page, state.anchor); else renderList();
})();
