/* Run Studio: the docs pane (its page list, search, content and F1 lookup).
 * Where the pane sits and how big it is belongs to layout.js. */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const DATA = window.STUDIO_DOCS || { categories: [], functions: {} };
const STORE = 'xlabs.studio.docs.v1';
const layout = window.StudioLayout;

const side = $('docsSide'), content = $('docsContent'), list = $('docsList'), search = $('docsSearch');

const pages = new Map();
for (const c of DATA.categories) for (const p of c.pages) pages.set(p.id, Object.assign({ category: c.name }, p));
const fnNames = Object.keys(DATA.functions).sort((a, b) => a.replace(/^mos_/, '').localeCompare(b.replace(/^mos_/, '')));

let state = { side: true, page: 'sdk-functions', anchor: '' };
try {
  const old = JSON.parse(localStorage.getItem(STORE) || localStorage.getItem('xlabs.studio.layout.v1') || '{}');
  for (const k of Object.keys(state)) if (old[k] !== undefined) state[k] = old[k];
} catch (e) { /* storage blocked */ }
function persist() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* storage blocked */ } }

function applySide() {
  side.hidden = !state.side;
  const t = $('docsSideToggle');
  t.setAttribute('aria-expanded', String(state.side));
  t.title = state.side ? 'Hide the page list' : 'Show the page list';
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
    if (window.xlHighlightAll) window.xlHighlightAll(content);
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
  layout.setOpen('docs', open);
  if (open && content.dataset.page !== state.page) show(state.page, state.anchor);
}

window.DocsView = {
  // open('mos_window_create') or open('sdk-files', 'mos_open') or open()
  open(name, anchor) {
    setOpen(true);
    if (name && DATA.functions[name] && anchor === undefined) { const [p, a] = DATA.functions[name].split('/'); go(p, a); }
    else if (name && pages.has(name)) go(name, anchor || '');
  },
  toggle() { setOpen(!layout.isOpen('docs')); },
  isOpen: () => layout.isOpen('docs'),
  has: (name) => !!DATA.functions[name],
  set onResize(fn) { if (fn) layout.onChange(fn); },
};

$('docsToggle').addEventListener('click', () => window.DocsView.toggle());
$('docsSideToggle').addEventListener('click', () => { state.side = !state.side; applySide(); persist(); if (state.side) search.focus(); });
$('docsBack').addEventListener('click', () => { const b = back.pop(); if (b) show(b[0], b[1]); });
search.addEventListener('input', renderList);
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = list.querySelector('button'); if (first) first.click(); }
  else if (e.key === 'Escape') { search.value = ''; renderList(); }
});
// restoring the pane from a minimised strip, or a saved layout, shows its page
layout.onChange(() => { if (layout.isOpen('docs') && content.dataset.page !== state.page) show(state.page, state.anchor); });
applySide();
if (layout.isOpen('docs')) show(state.page, state.anchor); else renderList();
})();
