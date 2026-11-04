/* Run Studio: the project and its files, the editor, the preview (through
 * system.js), the Files tab, the Minimal-OS apps and in-browser builds. */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const STORE = 'xlabs.studio.project.v1';
const EXPLORER = 'xlabs.studio.explorer.v1';
const HTTP_PROXY = new URLSearchParams(location.search).get('httpProxy') || '';
const TEMPLATES = window.STUDIO_TEMPLATES || [];
const { PreviewSystem, iconSvg, ICON_COLORS, DB, HOME } = window.StudioSystem;
const isSource = (p) => /\.(c|h|cpp|cc|cxx|hpp|hh)$/i.test(p);
const isCppFile = (p) => /\.(cpp|cc|cxx|hpp|hh)$/i.test(p);
const TEXT_EXT = /\.(c|h|cpp|cc|cxx|hpp|hh|txt|md|ini|service|cfg|conf|json|csv|html?|css|js|xml|svg|pkg|log|sh|py)$/i;
// the program's entry file: main.cpp for a C++ project, main.c otherwise
const mainOf = (files) => (files['main.cpp'] ? 'main.cpp' : 'main.c');
const enc = new TextEncoder();

// ---------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
}
function fmtDate(t) {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const time = p(d.getHours()) + ':' + p(d.getMinutes());
  return d.toDateString() === now.toDateString() ? 'Today ' + time : d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + time;
}
function b64size(b64) { return Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0); }
function toB64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
function fileBytes(f) { return f.b64 !== undefined ? fromB64(f.b64) : enc.encode(f.text); }
function fileSize(f) { return f.b64 !== undefined ? b64size(f.b64) : enc.encode(f.text).length; }
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
// a file name segment as MinimaFS and the SDK accept it
const cleanSeg = (s) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+$/, '_');
function validPath(p) { return /^[A-Za-z0-9_.\-/]+$/.test(p) && !p.split('/').some(s => !s || s === '.' || s === '..'); }

// text if the name says so, or if it decodes as UTF-8 without NUL bytes
function asProjectFile(name, bytes) {
  if (TEXT_EXT.test(name) || (bytes.length < 1048576 && !/\.(bmp|ico|png|jpe?g|gif|img|adi|vid|run|mpkg|elf|otf|ttf|qoi|zip)$/i.test(name))) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.includes('\0')) return { text };
    } catch (e) { /* binary */ }
  }
  return { b64: toB64(bytes) };
}

function download(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------------------------------------------------------------
//  Zip: write (stored) and read (stored or deflated)
// ---------------------------------------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip(list) {
  const entries = list.map(({ name, data }) => ({ name: enc.encode(name), data }));
  let size = 22;
  for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  let off = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const e of entries) {
    e.crc = crc32(e.data); e.off = off;
    dv.setUint32(off, 0x04034b50, true); dv.setUint16(off + 4, 20, true); dv.setUint16(off + 6, 0x0800, true); dv.setUint16(off + 8, 0, true);
    dv.setUint16(off + 10, time, true); dv.setUint16(off + 12, date, true); dv.setUint32(off + 14, e.crc, true);
    dv.setUint32(off + 18, e.data.length, true); dv.setUint32(off + 22, e.data.length, true); dv.setUint16(off + 26, e.name.length, true); dv.setUint16(off + 28, 0, true);
    out.set(e.name, off + 30); out.set(e.data, off + 30 + e.name.length);
    off += 30 + e.name.length + e.data.length;
  }
  const cd = off;
  for (const e of entries) {
    dv.setUint32(off, 0x02014b50, true); dv.setUint16(off + 4, 20, true); dv.setUint16(off + 6, 20, true); dv.setUint16(off + 8, 0x0800, true); dv.setUint16(off + 10, 0, true);
    dv.setUint16(off + 12, time, true); dv.setUint16(off + 14, date, true); dv.setUint32(off + 16, e.crc, true);
    dv.setUint32(off + 20, e.data.length, true); dv.setUint32(off + 24, e.data.length, true); dv.setUint16(off + 28, e.name.length, true);
    dv.setUint32(off + 42, e.off, true);
    out.set(e.name, off + 46);
    off += 46 + e.name.length;
  }
  dv.setUint32(off, 0x06054b50, true); dv.setUint16(off + 8, entries.length, true); dv.setUint16(off + 10, entries.length, true);
  dv.setUint32(off + 12, off - cd, true); dv.setUint32(off + 16, cd, true);
  return out;
}
async function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = bytes.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('this is not a zip file');
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('the zip file is damaged');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || /(^|\/)(__MACOSX|\.DS_Store)/.test(name)) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) {
      if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot unpack compressed zip files');
      const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(s).arrayBuffer());
    } else throw new Error(name + ' uses a zip compression method this page does not know (' + method + ')');
    out.push({ name, data });
  }
  return out;
}
// drop the folder every path starts with (a zipped or uploaded folder)
function stripTop(list) {
  const firsts = new Set(list.map((f) => (f.name.includes('/') ? f.name.split('/')[0] : '')));
  if (firsts.size === 1 && !firsts.has('')) { const top = [...firsts][0] + '/'; return list.map((f) => Object.assign({}, f, { name: f.name.slice(top.length) })); }
  return list;
}

// ---------------------------------------------------------------------
//  Dialogs (in the page instead of prompt / confirm / alert)
// ---------------------------------------------------------------------
// ask({ title, text, value, hint, buttons: [{ label, value, primary, danger }],
// validate(value) -> error | '' }) resolves to { button, value } or null.
function ask(o) {
  const d = $('askDialog'), input = $('askInput'), err = $('askErr');
  $('askTitle').textContent = o.title || '';
  $('askText').textContent = o.text || '';
  $('askText').hidden = !o.text;
  const hasInput = o.value !== undefined;
  $('askRow').hidden = !hasInput;
  input.value = hasInput ? o.value : '';
  $('askHint').textContent = o.hint || '';
  $('askHint').hidden = !o.hint;
  err.hidden = true;
  const box = $('askButtons');
  box.textContent = '';
  const buttons = o.buttons || [{ label: 'Cancel', value: 'cancel' }, { label: 'OK', value: 'ok', primary: true }];
  for (const b of buttons) box.append(el('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), value: b.value, type: 'submit' }, b.label));
  return new Promise((resolve) => {
    const form = $('askForm');
    const done = (r) => { form.removeEventListener('submit', submit); d.removeEventListener('cancel', cancel); d.close(); resolve(r); };
    const submit = (e) => {
      e.preventDefault();
      const v = (e.submitter && e.submitter.value) || (buttons.find((b) => b.primary) || buttons[buttons.length - 1]).value;
      if (v === 'cancel') { done(null); return; }
      if (hasInput && o.validate) {
        const msg = o.validate(input.value.trim(), v);
        if (msg) { err.textContent = msg; err.hidden = false; input.focus(); return; }
      }
      done({ button: v, value: input.value.trim() });
    };
    const cancel = (e) => { e.preventDefault(); done(null); };
    form.addEventListener('submit', submit);
    d.addEventListener('cancel', cancel);
    d.showModal();
    if (hasInput) {
      input.focus();
      // select the name without its extension, like a file manager
      const dot = input.value.lastIndexOf('.'), slash = input.value.lastIndexOf('/') + 1;
      input.setSelectionRange(slash, dot > slash ? dot : input.value.length);
    } else { const pb = box.querySelector('.primary') || box.lastChild; if (pb) pb.focus(); }
  });
}
const confirmDialog = (title, text, label, danger) => ask({ title, text, buttons: [{ label: 'Cancel', value: 'cancel' }, { label: label || 'OK', value: 'ok', primary: !danger, danger }] }).then((r) => !!r);
const notice = (title, text) => ask({ title, text, buttons: [{ label: 'OK', value: 'ok', primary: true }] });

// ---------------------------------------------------------------------
//  Pop-up menus
// ---------------------------------------------------------------------
// items: { label, sub, icon (html), kbd, run, disabled, danger } | { sep } |
// { head } | { el } (a ready-made element)
let openPop = null;
function closePop() {
  if (!openPop) return;
  const p = openPop; openPop = null;
  p.node.remove();
  if (p.anchor && p.anchor.setAttribute) { p.anchor.setAttribute('aria-expanded', 'false'); if (p.refocus) p.anchor.focus({ preventScroll: true }); }
}
function popMenu(anchor, items, opts) {
  opts = opts || {};
  const same = openPop && openPop.anchor === anchor && !opts.at;
  closePop();
  if (same) return;
  const node = el('div', { class: 'pop' + (opts.className ? ' ' + opts.className : ''), role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { node.append(el('div', { class: 'msep', role: 'separator' })); continue; }
    if (it.head) { node.append(el('div', { class: 'mhead' }, it.head)); continue; }
    if (it.el) { node.append(it.el); continue; }
    if (it.note) { node.append(el('div', { class: 'mfoot' }, it.note)); continue; }
    node.append(el('button', { class: 'mi' + (it.danger ? ' danger' : ''), role: 'menuitem', type: 'button', disabled: it.disabled, onclick: () => { closePop(); it.run(); } },
      it.icon ? el('span', { html: it.icon, style: 'display:inline-flex' }) : null,
      el('span', { class: 't' }, it.label, it.sub ? el('small', {}, it.sub) : null),
      it.kbd ? el('span', { class: 'k' }, it.kbd) : null));
  }
  document.body.append(node);
  const r = opts.at || anchor.getBoundingClientRect();
  const w = node.offsetWidth, h = node.offsetHeight;
  let x = opts.at ? r.x : (opts.alignRight ? r.right - w : r.left), y = opts.at ? r.y : r.bottom + 6;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  if (y + h > innerHeight - 8) y = Math.max(8, (opts.at ? r.y : r.top - 6) - h);
  node.style.left = x + 'px'; node.style.top = y + 'px';
  openPop = { node, anchor, refocus: !opts.at };
  if (anchor && anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
  const first = node.querySelector('button:not(:disabled)');
  if (first) first.focus({ preventScroll: true });
  node.addEventListener('keydown', (e) => {
    const list = [...node.querySelectorAll('button:not(:disabled)')];
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePop(); }
    else if (e.key === 'Tab') closePop();
  });
}
document.addEventListener('pointerdown', (e) => { if (openPop && !openPop.node.contains(e.target) && !(openPop.anchor && openPop.anchor.contains && openPop.anchor.contains(e.target))) closePop(); }, true);
window.addEventListener('resize', closePop);

const ICON = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V15"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 15v3.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V15"/></svg>',
  sidebar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/></svg>',
};
const tileFor = (icon) => el('span', { class: 'tile', style: 'background:' + (ICON_COLORS[icon] || ICON_COLORS.app), html: iconSvg(icon, { size: 18, color: '#fff' }) });

// ---------------------------------------------------------------------
//  Project, kept in this browser
// ---------------------------------------------------------------------
let project = null;

function fromTemplate(t) {
  const files = {};
  for (const [p, text] of Object.entries(t.files)) files[p] = { text };
  const active = mainOf(files);
  return { name: t.name, files, active, open: [active], expanded: [], args: '' };
}

async function loadProject() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.idb) { const q = await DB.get('kv', 'project'); if (q && q.files && Object.keys(q.files).length) return q; }
      else if (p && p.files && Object.keys(p.files).length) return p;
    }
  } catch (e) { /* private mode or cleared storage: start fresh */ }
  return fromTemplate(TEMPLATES[0]);
}

let saveTimer = 0, saveNote = '';
function save(now) {
  clearTimeout(saveTimer);
  const write = () => {
    syncEditor();
    const json = JSON.stringify(project);
    // big projects (an app's whole source) go to IndexedDB
    if (json.length < 1500000) {
      try { localStorage.setItem(STORE, json); DB.del('kv', 'project').catch(() => {}); saveNote = ''; return; } catch (e) { /* full: IndexedDB */ }
    }
    DB.set('kv', 'project', JSON.parse(json))
      .then(() => { try { localStorage.setItem(STORE, '{"idb":true}'); } catch (e) { /* the flag could not be written */ } saveNote = ''; })
      .catch(() => { saveNote = 'Not saved: browser storage is full'; renderStatusBar(); });
  };
  if (now) write(); else saveTimer = setTimeout(write, 400);
}

function safeName(s) {
  s = String(s || '').trim().replace(/\.run$/i, '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 40);
  return s || 'app';
}

// ---------------------------------------------------------------------
//  Editor
// ---------------------------------------------------------------------
const codeHost = $('code');
let cm = null, textarea = null, binaryNote = null, emptyNote = null;
const docs = new Map();
const hasCM = typeof window.CodeMirror === 'function';

function setupEditor() {
  if (hasCM) {
    cm = window.CodeMirror(codeHost, {
      theme: 'xlabs', mode: 'text/x-csrc', lineNumbers: true, indentUnit: 4, tabSize: 4,
      matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true,
      gutters: ['CodeMirror-linenumbers', 'errors'],
      extraKeys: { 'Ctrl-/': 'toggleComment', 'Cmd-/': 'toggleComment', Tab: (c) => c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('    ') }
    });
    cm.on('change', () => { clearMarks(); save(); renderStatusBar(); });
    cm.on('cursorActivity', renderStatusBar);
  } else {
    textarea = el('textarea', { spellcheck: 'false', 'aria-label': 'Source code' });
    codeHost.appendChild(textarea);
    textarea.addEventListener('input', () => save());
  }
  binaryNote = el('div', { class: 'binary', hidden: true });
  emptyNote = el('div', { class: 'empty-editor', hidden: true },
    el('div', {}, 'No file is open.'),
    el('div', {}, 'Pick one from the project files on the left.'),
    el('button', { class: 'btn', type: 'button', onclick: () => setExplorer(true) }, 'Show project files'));
  codeHost.append(binaryNote, emptyNote);
}

function syncEditor() {
  const f = project && project.files[project.active];
  if (!f || f.b64 !== undefined) return;
  if (cm) { const d = docs.get(project.active); if (d) f.text = d.getValue(); }
  else if (textarea) f.text = textarea.value;
}

function modeOf(path) {
  if (!isSource(path)) return 'text/plain';
  const cpp = isCppFile(path) || (/\.h$/i.test(path) && Object.keys(project.files).some(isCppFile));
  return cpp ? 'text/x-c++src' : 'text/x-csrc';
}

// show `path` in the editor (null: nothing open)
function showFile(path) {
  syncEditor();
  project.active = path;
  const f = path ? project.files[path] : null;
  const binary = !!f && f.b64 !== undefined;
  binaryNote.hidden = !binary;
  emptyNote.hidden = !!f;
  if (cm) cm.getWrapperElement().style.visibility = f && !binary ? 'visible' : 'hidden';
  if (textarea) textarea.hidden = !f || binary;
  if (binary) {
    binaryNote.textContent = '';
    binaryNote.append(
      el('div', {}, path + ' — binary resource, ' + b64size(f.b64).toLocaleString() + ' bytes.'),
      el('div', {}, 'It is packed into the .run and appears in the preview under 0:/programs/' + project.name + '/.'),
      el('button', { class: 'btn', type: 'button', onclick: () => downloadProjectFile(path) }, '⬇ Download ' + baseName(path)));
  } else if (f && cm) {
    let d = docs.get(path);
    if (!d) { d = window.CodeMirror.Doc(f.text, modeOf(path)); docs.set(path, d); }
    cm.swapDoc(d);
    cm.refresh();
  } else if (f) textarea.value = f.text;
  renderTabs();
  renderTree();
  renderStatusBar();
}

function openFile(path, opts) {
  if (!project.files[path]) return;
  if (!project.open.includes(path)) {
    const at = project.open.indexOf(project.active);
    project.open.splice(at >= 0 ? at + 1 : project.open.length, 0, path);
  }
  // open its folders in the explorer
  for (let d = dirName(path); d; d = dirName(d)) if (!project.expanded.includes(d)) project.expanded.push(d);
  showFile(path);
  save();
  if (opts && opts.focus && cm && project.files[path].b64 === undefined) cm.focus();
}

function closeTab(path) {
  syncEditor();
  const i = project.open.indexOf(path);
  if (i < 0) return;
  project.open.splice(i, 1);
  if (project.active === path) showFile(project.open[Math.min(i, project.open.length - 1)] || null);
  else { renderTabs(); renderTree(); }
  save();
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.textContent = '';
  const tog = el('button', { class: 'tab xtoggle', type: 'button', title: 'Show or hide the project files (Ctrl+B)', 'aria-label': 'Project files', 'aria-pressed': String(explorerOpen), 'aria-controls': 'explorer', html: ICON.sidebar, onclick: () => setExplorer(!explorerOpen) });
  tabs.append(tog);
  const main = mainOf(project.files);
  for (const p of project.open) {
    if (!project.files[p]) continue;
    const b = el('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': p === project.active ? 'true' : 'false', title: p + (p === main ? ' (the program starts here)' : '') + ' · double-click to rename' },
      baseName(p));
    const x = el('span', { class: 'x', role: 'button', title: 'Close ' + baseName(p), 'aria-label': 'Close ' + baseName(p) }, '✕');
    x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(p); });
    b.append(x);
    b.addEventListener('click', () => openFile(p));
    b.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(p); } });
    b.addEventListener('dblclick', () => renameFile(p));
    tabs.append(b);
  }
  tabs.append(el('button', { class: 'tab add', type: 'button', title: 'New file', 'aria-label': 'New file', onclick: () => newFile('') }, '+'));
  const cur = tabs.querySelector('[aria-selected="true"]');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderStatusBar() {
  const s = $('estatus');
  s.textContent = '';
  const p = project.active, f = p && project.files[p];
  if (f) {
    s.append(el('span', {}, p));
    if (f.b64 !== undefined) s.append(el('span', {}, 'Binary · ' + fmtSize(b64size(f.b64))));
    else {
      s.append(el('span', {}, isSource(p) ? (modeOf(p) === 'text/x-c++src' ? 'C++' : 'C') : 'Text'));
      if (cm) { const c = cm.getCursor(); s.append(el('span', {}, 'Ln ' + (c.line + 1) + ', Col ' + (c.ch + 1))); }
    }
    if (p === mainOf(project.files)) s.append(el('span', { title: 'The program starts at main in this file' }, 'Entry file'));
  }
  s.append(el('span', { class: 'grow' }));
  if (saveNote) s.append(el('span', { style: 'color:var(--bad)' }, saveNote));
  const n = Object.keys(project.files).length;
  s.append(el('button', { type: 'button', title: 'Show or hide the project files', onclick: () => setExplorer(!explorerOpen) }, n + (n === 1 ? ' file' : ' files')));
}

// ---------------------------------------------------------------------
//  Explorer: the project's files as a tree
// ---------------------------------------------------------------------
// on a phone the list covers the editor: it starts closed and closes
// again once a file is picked
const narrow = () => matchMedia('(max-width: 640px)').matches;
let explorerOpen = true;
try { explorerOpen = !narrow() && localStorage.getItem(EXPLORER) !== '0'; } catch (e) { explorerOpen = !narrow(); }
function setExplorer(open) {
  explorerOpen = open;
  $('explorer').hidden = !open;
  if (!narrow()) try { localStorage.setItem(EXPLORER, open ? '1' : '0'); } catch (e) { /* blocked */ }
  renderTabs();
  if (cm) cm.refresh();
}

function badge(path) {
  const m = /\.([^./]+)$/.exec(path), ext = m ? m[1].toLowerCase() : '';
  const map = { c: ['C', '#82AAFF'], h: ['H', '#7FD1C7'], cpp: ['C++', '#C792EA'], cc: ['C++', '#C792EA'], cxx: ['C++', '#C792EA'], hpp: ['H++', '#7FD1C7'], hh: ['H++', '#7FD1C7'],
    md: ['MD', '#B9C0CA'], txt: ['TXT', '#B9C0CA'], html: ['HTML', '#F0A27A'], htm: ['HTML', '#F0A27A'], json: ['{}', '#E6C07B'], bmp: ['IMG', '#A6D7A0'], ico: ['IMG', '#A6D7A0'], img: ['IMG', '#A6D7A0'], png: ['IMG', '#A6D7A0'],
    otf: ['FONT', '#D6A8FF'], ttf: ['FONT', '#D6A8FF'], adi: ['AUD', '#F28FB1'], vid: ['VID', '#F28FB1'] };
  const [t, c] = map[ext] || [(ext || '·').slice(0, 4).toUpperCase(), '#8A8F98'];
  return el('span', { class: 'badge', style: 'color:' + c + ';background:' + c + '1f' }, t);
}

function tree() {
  const root = { dirs: new Map(), files: [] };
  for (const p of Object.keys(project.files)) {
    const parts = p.split('/');
    let node = root, path = '';
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? path + '/' + parts[i] : parts[i];
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { path, dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(p);
  }
  return root;
}

function renderTree() {
  const box = $('xtree');
  const scroll = box.scrollTop;
  box.textContent = '';
  const main = mainOf(project.files);
  const expanded = new Set(project.expanded);
  const walk = (node, depth) => {
    const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, d] of dirs) {
      const open = expanded.has(d.path);
      const row = el('button', { class: 'xrow', type: 'button', role: 'treeitem', 'aria-expanded': String(open), style: 'padding-left:' + (6 + depth * 14) + 'px', title: d.path },
        el('span', { class: 'tw' }, open ? '▾' : '▸'),
        el('span', { html: iconSvg('folder', { size: 15, color: '#D9A43A' }), style: 'display:inline-flex' }),
        el('span', { class: 'nm' }, name),
        el('span', { class: 'more', title: 'More', 'aria-hidden': 'true' }, '⋯'));
      row.addEventListener('click', (e) => {
        if (e.target.closest('.more')) { folderMenu(d.path, { x: e.clientX, y: e.clientY }); return; }
        if (open) project.expanded = project.expanded.filter((x) => x !== d.path); else project.expanded.push(d.path);
        renderTree(); save();
      });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu(d.path, { x: e.clientX, y: e.clientY }); });
      dropTarget(row, d.path);
      box.append(row);
      if (open) walk(d, depth + 1);
    }
    for (const p of node.files.sort((a, b) => (a === main ? -1 : b === main ? 1 : baseName(a).localeCompare(baseName(b))))) {
      const row = el('button', { class: 'xrow' + (project.open.includes(p) ? ' open-file' : ''), type: 'button', role: 'treeitem', 'aria-current': p === project.active ? 'true' : 'false', style: 'padding-left:' + (18 + depth * 14) + 'px', title: p + ' · ' + fmtSize(fileSize(project.files[p])) },
        badge(p),
        el('span', { class: 'nm', style: p === main ? 'font-weight:600' : '' }, baseName(p)),
        el('span', { class: 'more', title: 'More', 'aria-hidden': 'true' }, '⋯'));
      row.addEventListener('click', (e) => {
        if (e.target.closest('.more')) { fileMenu(p, { x: e.clientX, y: e.clientY }); return; }
        openFile(p, { focus: !narrow() });
        if (narrow()) setExplorer(false);
      });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); fileMenu(p, { x: e.clientX, y: e.clientY }); });
      row.addEventListener('keydown', (e) => { if (e.key === 'Delete') removeFile(p); else if (e.key === 'F2') renameFile(p); });
      box.append(row);
    }
  };
  walk(tree(), 0);
  box.scrollTop = scroll;
  $('xtitle').textContent = project.name;
  const total = Object.values(project.files).reduce((n, f) => n + fileSize(f), 0);
  const n = Object.keys(project.files).length;
  $('xfoot').textContent = n + (n === 1 ? ' file · ' : ' files · ') + fmtSize(total);
}

function fileMenu(p, at) {
  popMenu(null, [
    { label: 'Open', run: () => openFile(p, { focus: true }) },
    { label: 'Rename…', kbd: 'F2', run: () => renameFile(p) },
    { label: 'Duplicate', run: () => duplicateFile(p) },
    { label: 'Download', run: () => downloadProjectFile(p) },
    { sep: true },
    { label: 'Delete…', kbd: 'Del', danger: true, run: () => removeFile(p), disabled: Object.keys(project.files).length === 1 },
  ], { at });
}
function folderMenu(dir, at) {
  popMenu(null, [
    { label: 'New file here…', run: () => newFile(dir + '/') },
    { label: 'Upload files here…', run: () => pickUpload('files', dir) },
    { label: 'Rename folder…', run: () => renameFolder(dir) },
    { label: 'Download folder (.zip)', run: () => download(baseName(dir) + '.zip', makeZip(Object.keys(project.files).filter((p) => p.startsWith(dir + '/')).map((p) => ({ name: baseName(dir) + '/' + p.slice(dir.length + 1), data: fileBytes(project.files[p]) }))), 'application/zip') },
    { sep: true },
    { label: 'Delete folder…', danger: true, run: () => removeFolder(dir) },
  ], { at });
}

const pathCheck = (taken) => (v) => !v ? 'Type a name.' : !validPath(v) ? 'Use letters, digits, _ . - and / (for folders) only.' : taken(v) ? 'There is already a file called ' + v + '.' : '';

async function newFile(prefix) {
  const r = await ask({ title: 'New file', text: 'For example util.c, util.cpp, util.h or Resources/notes.txt. Use / for folders.', value: prefix + (prefix ? '' : 'util.h'), validate: pathCheck((v) => !!project.files[v] || Object.keys(project.files).some((p) => p.startsWith(v + '/'))), buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Create', value: 'ok', primary: true }] });
  if (!r) return;
  const p = r.value;
  const guard = p.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  project.files[p] = { text: /\.(h|hpp|hh)$/.test(p) ? '#ifndef ' + guard + '\n#define ' + guard + '\n\n\n#endif\n' : '' };
  openFile(p, { focus: true });
}

function movePath(from, to) {
  project.files[to] = project.files[from];
  delete project.files[from];
  if (docs.has(from)) { docs.set(to, docs.get(from)); docs.delete(from); }
  project.open = project.open.map((x) => (x === from ? to : x));
  if (project.active === from) project.active = to;
}

async function renameFile(p) {
  const r = await ask({ title: 'Rename ' + baseName(p), value: p, validate: pathCheck((v) => v !== p && !!project.files[v]), buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Rename', value: 'ok', primary: true }] });
  if (!r || r.value === p) return;
  syncEditor();
  movePath(p, r.value);
  openFile(r.value);
}

async function renameFolder(dir) {
  const r = await ask({ title: 'Rename folder ' + baseName(dir), value: dir, validate: pathCheck((v) => v !== dir && Object.keys(project.files).some((p) => p === v || p.startsWith(v + '/'))), buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Rename', value: 'ok', primary: true }] });
  if (!r || r.value === dir) return;
  syncEditor();
  for (const p of Object.keys(project.files)) if (p.startsWith(dir + '/')) movePath(p, r.value + p.slice(dir.length));
  project.expanded = project.expanded.map((x) => (x === dir || x.startsWith(dir + '/') ? r.value + x.slice(dir.length) : x));
  showFile(project.active); save();
}

function duplicateFile(p) {
  syncEditor();
  const m = /^(.*?)(\.[^./]*)?$/.exec(p);
  let n = 2, q;
  do q = m[1] + '-' + n++ + (m[2] || ''); while (project.files[q]);
  project.files[q] = Object.assign({}, project.files[p]);
  openFile(q);
}

async function removeFile(p) {
  if (Object.keys(project.files).length === 1) return;
  if (!await confirmDialog('Delete ' + baseName(p) + '?', p + ' is removed from the project. Download it first if you want to keep a copy.', 'Delete', true)) return;
  delete project.files[p];
  docs.delete(p);
  if (project.open.includes(p)) closeTab(p);
  else { renderTree(); renderTabs(); }
  renderStatusBar();
  save();
}

async function removeFolder(dir) {
  const inside = Object.keys(project.files).filter((p) => p.startsWith(dir + '/'));
  if (inside.length === Object.keys(project.files).length) { notice('Cannot delete ' + dir, 'A project needs at least one file outside it.'); return; }
  if (!await confirmDialog('Delete the folder ' + baseName(dir) + '?', 'Its ' + inside.length + ' file' + (inside.length === 1 ? '' : 's') + ' are removed from the project.', 'Delete', true)) return;
  for (const p of inside) { delete project.files[p]; docs.delete(p); }
  project.open = project.open.filter((p) => project.files[p]);
  if (!project.files[project.active]) showFile(project.open[0] || null);
  else { renderTree(); renderTabs(); }
  save();
}

function downloadProjectFile(p) { syncEditor(); download(baseName(p), fileBytes(project.files[p]), project.files[p].b64 !== undefined ? 'application/octet-stream' : 'text/plain'); }

// ---------------------------------------------------------------------
//  Uploads into the project: files, a folder, or a .zip
// ---------------------------------------------------------------------
let uploadInto = '';
function pickUpload(kind, dir) {
  uploadInto = dir || '';
  $(kind === 'folder' ? 'uploadDir' : kind === 'zip' ? 'uploadZip' : 'upload').click();
}

// list: [{ name (relative path), data }]; keepPaths: a folder or zip
async function addToProject(list, keepPaths) {
  let added = 0, last = null, replaced = 0;
  const target = (f) => {
    let name = f.name.split('/').map(cleanSeg).filter(Boolean).join('/');
    if (!name) return '';
    if (uploadInto) return uploadInto + '/' + name;
    // loose resource files go under Resources/, like the SDK expects
    if (!keepPaths && !isSource(name) && name !== 'icon.bmp' && name !== 'icon.ico' && !name.includes('/')) return 'Resources/' + name;
    return name;
  };
  const clash = list.map(target).filter((n) => n && project.files[n]);
  if (clash.length) {
    syncEditor();
    const r = await ask({ title: clash.length === 1 ? 'Replace ' + clash[0] + '?' : 'Replace ' + clash.length + ' files?', text: (clash.length === 1 ? 'The project already has ' + clash[0] : 'The project already has ' + clash.slice(0, 4).join(', ') + (clash.length > 4 ? ' and ' + (clash.length - 4) + ' more' : '')) + '.', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Skip those', value: 'skip' }, { label: 'Replace', value: 'ok', primary: true }] });
    if (!r) { uploadInto = ''; return; }
    if (r.button === 'skip') list = list.filter((f) => !project.files[target(f)]);
  }
  for (const f of list) {
    const name = target(f);
    if (!name) continue;
    if (project.files[name]) replaced++;
    project.files[name] = asProjectFile(name, f.data);
    docs.delete(name);
    added++;
    if (isSource(name) || !last) last = name;
  }
  uploadInto = '';
  if (!added) return;
  status('Added ' + added + ' file' + (added === 1 ? '' : 's') + (replaced ? ' (' + replaced + ' replaced)' : ''), 'ok');
  if (last) openFile(last);
  else { renderTree(); save(); }
}

async function uploadFiles(files, opts) {
  const list = [];
  for (const file of files) list.push({ name: (opts && opts.keepPaths && file.webkitRelativePath) || file.name, data: new Uint8Array(await file.arrayBuffer()) });
  // a single .zip: offer to unpack it
  if (list.length === 1 && /\.zip$/i.test(list[0].name) && !(opts && opts.keepPaths)) {
    const r = await ask({ title: 'Unpack ' + list[0].name + '?', text: 'Its files are added to the project (a folder at the top of the archive is left out), or keep the archive as one resource file.', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Keep as a file', value: 'file' }, { label: 'Unpack', value: 'unpack', primary: true }] });
    if (!r) return;
    if (r.button === 'unpack') { await importZip(list[0].data); return; }
  }
  await addToProject(opts && opts.keepPaths ? stripTop(list) : list, opts && opts.keepPaths);
}

async function importZip(bytes) {
  let list;
  try { list = await readZip(bytes); } catch (e) { notice('Could not open the zip file', 'The ' + e.message + '.'); return; }
  await addToProject(stripTop(list), true);
}

// ---------------------------------------------------------------------
//  Console
// ---------------------------------------------------------------------
const out = $('out');
function log(text, cls) {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  const stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 8;
  out.appendChild(s);
  while (out.childNodes.length > 2000) out.removeChild(out.firstChild);
  if (stick) out.scrollTop = out.scrollHeight;
}
function status(text, cls) { const s = $('status'); s.textContent = text; s.className = 'status' + (cls ? ' ' + cls : ''); }

const PANELS = { out: 'out', problems: 'problems', files: 'filesPanel', build: 'buildPanel', help: 'help' };
let currentTab = 'out';
function showTab(name) {
  currentTab = name;
  document.querySelectorAll('.ctab').forEach(b => b.setAttribute('aria-selected', b.dataset.ctab === name ? 'true' : 'false'));
  for (const [k, id] of Object.entries(PANELS)) $(id).hidden = k !== name;
  if (name === 'files') renderFiles();
}

let marks = [];
function clearMarks() {
  if (!cm || !marks.length) return;
  for (const m of marks) { m.doc.removeLineClass(m.line, 'background', 'err-line'); m.doc.setGutterMarker(m.line, 'errors', null); }
  marks = [];
}

function reportError(err) {
  clearMarks();
  const p = $('problems');
  p.textContent = '';
  const file = err.file || '';
  const where = file ? file + (err.line ? ':' + err.line + (err.col ? ':' + err.col : '') : '') : '';
  const b = el('button', { class: 'problem', type: 'button' }, el('b', {}, 'error '), (where ? where + ': ' : '') + err.message);
  p.appendChild(b);
  $('pcount').hidden = false; $('pcount').textContent = '1';
  const local = file && project.files[file] !== undefined;
  const jump = () => {
    if (!local) return;
    openFile(file);
    if (cm && err.line) { cm.setCursor({ line: err.line - 1, ch: Math.max(0, (err.col || 1) - 1) }); cm.focus(); }
  };
  b.addEventListener('click', jump);
  if (local && cm && err.line) {
    if (!docs.get(file)) openFile(file);
    const d = docs.get(file);
    const line = err.line - 1;
    if (d && line < d.lineCount()) {
      d.addLineClass(line, 'background', 'err-line');
      const mk = el('span', { class: 'err-mark', title: err.message }, '●');
      d.setGutterMarker(line, 'errors', mk);
      marks.push({ doc: d, line });
    }
    jump();
  }
  if (file.startsWith('<sdk>/')) p.appendChild(el('p', { class: 'sys', style: 'margin:6px 6px 0' }, 'The error is inside an SDK header, usually because of how it was called from your code (or two headers that clash).'));
  showTab('problems');
}
function clearProblems() { $('problems').textContent = 'No problems.'; $('pcount').hidden = true; clearMarks(); }

// ---------------------------------------------------------------------
//  Preview: the system (shared MinimaFS, the project and the apps)
// ---------------------------------------------------------------------
let alive = false, lastPong = 0, pingTimer = 0, exited = true, projectPid = 0;
const screenSize = () => { const [w, h] = $('res').value.split('x').map(Number); return { w, h }; };
const sys = new PreviewSystem({
  canvas: $('screen'),
  screen: screenSize,
  httpProxy: HTTP_PROXY,
  log,
  onProjectMessage: (m) => onProject(m),
  onRunProject: (args) => run(args),
  onStopProject: () => stop(),
  onOpenFiles: (path) => openFilesAt(path),
});
const desktop = sys.desktop;
sys.on((ev) => { if (ev.t === 'catalog') renderAppsReady(); if (ev.t === 'procs') updateRunning(); });

function sources() {
  syncEditor();
  const files = {};
  for (const [p, f] of Object.entries(project.files)) if (f.text !== undefined && isSource(p)) files[p] = f.text;
  return files;
}
function resources() {
  const list = [];
  for (const [p, f] of Object.entries(project.files)) if (!isSource(p)) list.push({ path: p, data: fileBytes(f) });
  return list;
}

function projectEnded() {
  alive = false; exited = true;
  clearInterval(pingTimer);
  $('stop').disabled = true;
  desktop.programExited();
}

function kill() {
  if (sys.project) sys.kill(sys.project.pid);
  projectEnded();
}

async function run(args) {
  if (window.StudioLayout) window.StudioLayout.reveal('preview');
  save(true);
  clearProblems();
  out.textContent = '';
  if (currentTab !== 'files') showTab('out');
  const name = project.name;
  const argv = Array.isArray(args) ? args : project.args ? project.args.split(/\s+/).filter(Boolean) : [];
  log('$ run 0:/programs/' + name + '.run' + (argv.length ? ' ' + argv.join(' ') : '') + '\n', 'sys');
  status('Compiling…');
  desktop.setApp(name);
  await sys.ready;
  kill();
  desktop.programStarted();
  for (const [p, t] of Object.entries(project.seed || {})) if (!sys.fs.get(p)) sys.writeFile(p, t);
  const proc = sys.runProject({ name, files: sources(), resources: resources(), args: argv, mem: project.mem });
  if (!proc) { status('Preview unavailable', 'bad'); desktop.programExited(); return; }
  projectPid = proc.pid;
  exited = false;
  lastPong = performance.now();
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (exited) return;
    if (performance.now() - lastPong > 3000 && alive) status('Not responding — Stop ends it', 'bad');
    sys.post(projectPid, { t: 'ping' });
  }, 1000);
}

function stop() {
  if (exited || !sys.project) return;
  sys.post(projectPid, { t: 'stop' });
  status('Stopping…');
  const pid = projectPid;
  setTimeout(() => { if (projectPid === pid && !exited) { log('\nForce-terminated.\n', 'bad'); status('Terminated', 'bad'); kill(); } }, 1500);
}

function onProject(m) {
  switch (m.t) {
    case 'pong': lastPong = performance.now(); if (alive && /Not responding/.test($('status').textContent)) status('Running', 'ok'); return;
    case 'workerError': log('Preview error: ' + m.message + '\n', 'bad'); status('Preview error', 'bad'); projectEnded(); return;
    case 'compileError':
      reportError(m.error);
      if (m.internal) console.warn(m.internal);
      status('Compile error', 'bad');
      log('Compilation failed: ' + (m.error.file ? m.error.file + ':' + m.error.line + ': ' : '') + m.error.message + '\n', 'bad');
      projectEnded();
      return;
    case 'started':
      alive = true;
      $('stop').disabled = false;
      status('Running', 'ok');
      log('compiled in ' + m.compileMs + ' ms\n', 'sys');
      $('screen').focus({ preventScroll: true });
      return;
    case 'netError':
      log('Networking error: ' + m.message + '\n', 'bad');
      desktop.write('Networking error: ' + m.message + '\n');
      return;
    case 'out': log(m.text); desktop.message(m); return;
    case 'exit':
      if (m.crash) { log('\nProgram crashed! Code 0x' + m.code.toString(16) + ': ' + m.crash + '\n', 'bad'); status('Crashed', 'bad'); desktop.write('\nProgram crashed! Code 0x' + m.code.toString(16) + ': ' + m.crash + '\n'); }
      else { log('\n[exited with code ' + m.code + ']\n', m.code ? 'bad' : 'ok'); status('Exited (' + m.code + ')', m.code ? 'bad' : ''); }
      projectEnded();
      return;
  }
}

// ---------------------------------------------------------------------
//  Minimal-OS apps
// ---------------------------------------------------------------------
function launchApp(id, args) {
  if (window.StudioLayout) window.StudioLayout.reveal('preview');
  if (currentTab !== 'files') showTab('out');
  sys.ready.then(() => sys.launchApp(id, args)).then((p) => { if (p) $('screen').focus({ preventScroll: true }); });
}

function runningApps() { return sys.procList().filter((p) => p.kind === 'app'); }
function updateRunning() {
  const n = runningApps().length;
  $('apps').textContent = '▦ Apps' + (n ? ' (' + n + ' running)' : '') + ' ▾';
}

function appsMenu() {
  const items = [{ head: 'Run in the preview' }];
  if (!sys.catalog.length) items.push({ note: location.protocol === 'file:' ? 'Open Studio through a web server to use the apps (python3 -m http.server).' : 'Loading the app list…' });
  for (const a of sys.catalog) {
    const row = el('div', { class: 'approw' },
      el('button', { class: 'mi', role: 'menuitem', type: 'button', title: 'Run ' + a.title + ' in the preview', onclick: () => { closePop(); launchApp(a.id); } },
        tileFor(a.icon), el('span', { class: 't' }, a.title, el('small', {}, a.description))),
      el('button', { class: 'src', type: 'button', title: 'Open the source of ' + a.title + ' as the project, to change and build it', onclick: () => { closePop(); openAppSource(a.id); } }, 'Source'));
    items.push({ el: row });
  }
  const running = runningApps();
  if (running.length) {
    items.push({ sep: true });
    items.push({ label: 'Stop all apps', sub: running.map((p) => p.name).join(', '), run: () => { for (const p of runningApps()) sys.stop(p.pid); } });
  }
  if (sys.catalog.length) items.push({ note: 'Built from source in your browser' + (sys.catalogSource ? ' (' + sys.catalogSource + ')' : '') + '. The first start of a big app takes a moment. Sound, disks and installing are not available in the preview.' });
  popMenu($('apps'), items, { className: 'apps' });
}

async function openAppSource(id) {
  const a = sys.app(id);
  if (!a) return;
  const r = await ask({ title: 'Open the source of ' + a.title + '?', text: 'Its ' + fmtSize(a.bytes || 0) + ' of source replace the files in the editor. Download the current project first if you want to keep it.', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Download current, then open', value: 'save' }, { label: 'Open ' + a.title, value: 'ok', primary: true }] });
  if (!r) return;
  if (r.button === 'save') download(project.name + '.zip', projectZip(), 'application/zip');
  status('Loading ' + a.title + '…');
  let files;
  try { files = await sys.loadApp(id); } catch (e) { status('Could not load ' + a.title, 'bad'); return; }
  const pf = {};
  for (const [p, f] of Object.entries(files)) pf[p] = typeof f === 'string' ? { text: f } : { b64: f.b64 };
  loadProjectInto({ name: a.run, files: pf, active: mainOf(pf), open: [mainOf(pf)], expanded: [], args: '', mem: a.mem, seed: a.seed });
  status('Opened ' + a.title, 'ok');
}

function renderAppsReady() { updateRunning(); renderTemplatesList(); }

// ---------------------------------------------------------------------
//  Files tab: the preview's MinimaFS
// ---------------------------------------------------------------------
let cwd = HOME, filesTimer = 0;
sys.fs.on(() => { if (currentTab === 'files') { clearTimeout(filesTimer); filesTimer = setTimeout(renderFiles, 120); } });

function openFilesAt(path) {
  if (window.StudioLayout) window.StudioLayout.reveal('preview');
  const n = sys.fs.get(path);
  cwd = n && n.dir ? sys.fs.norm(path) : HOME;
  showTab('files');
}

const OPENERS = [
  [/\.(txt|md|c|h|cpp|hpp|ini|cfg|conf|json|csv|html?|css|js|log|service|pkg|xml|sh|py)$/i, 'edit'],
  [/\.img$/i, 'photos'], [/\.adi$/i, 'player'], [/\.vid$/i, 'video'],
];
function openerFor(path) {
  if (/\.run$/i.test(path)) {
    const a = sys.catalog.find((x) => sys.appPath(x) === path);
    if (a) return { label: 'Run', run: () => launchApp(a.id) };
    if (sys.projectName && path === sys.projectPath()) return { label: 'Run', run: () => run() };
    return null;
  }
  for (const [re, id] of OPENERS) if (re.test(path) && sys.app(id)) return { label: 'Open', title: 'Open in ' + sys.app(id).title, run: () => launchApp(id, [path]) };
  return null;
}

function downloadPreviewPath(path) {
  const fs = sys.fs, n = fs.get(path);
  if (!n) return;
  if (!n.dir) { download(fs.name(path), n.data); return; }
  const pre = path.length > 3 ? path + '/' : path, top = path.length > 3 ? fs.name(path) : 'MinimaFS';
  const list = [];
  for (const [k, v] of fs.nodes) if (!v.dir && k.startsWith(pre)) list.push({ name: top + '/' + k.slice(pre.length), data: v.data });
  download(top + '.zip', makeZip(list), 'application/zip');
}

function renderFiles() {
  const fs = sys.fs;
  if (!fs.get(cwd) || !fs.get(cwd).dir) cwd = fs.get(HOME) ? HOME : '0:/';
  const crumbs = $('crumbs');
  crumbs.textContent = '';
  const segs = cwd.slice(3).split('/').filter(Boolean);
  const go = (p) => { cwd = p; renderFiles(); };
  crumbs.append(el('button', { type: 'button', 'aria-current': segs.length ? null : 'page', onclick: () => go('0:/') }, '0:/'));
  let acc = '0:/';
  segs.forEach((s, i) => {
    acc = fs.join(acc, s);
    const p = acc;
    if (i) crumbs.append(el('span', {}, '/'));
    crumbs.append(el('button', { type: 'button', 'aria-current': i === segs.length - 1 ? 'page' : null, onclick: () => go(p) }, s));
  });
  const tbody = $('flist');
  tbody.textContent = '';
  if (cwd !== '0:/') {
    tbody.append(el('tr', {}, el('td', { class: 'n' }, el('button', { class: 'fname dir', type: 'button', onclick: () => go(fs.parent(cwd)), html: iconSvg('folder', { size: 17 }) + '<span>..</span>' })), el('td', { class: 'sz' }), el('td', { class: 'dt' }), el('td', { class: 'act' })));
  }
  const entries = fs.list(cwd);
  for (const e of entries) {
    const isDir = e.node.dir, open = isDir ? null : openerFor(e.path);
    const name = el('button', { class: 'fname' + (isDir ? ' dir' : ''), type: 'button', title: isDir ? 'Open ' + e.path : open ? (open.title || open.label) + ' ' + e.path : 'Download ' + e.name,
      html: iconSvg(isDir ? 'folder' : 'file', { size: 17 }), onclick: () => (isDir ? go(e.path) : open ? open.run() : downloadPreviewPath(e.path)) });
    name.append(el('span', {}, e.name));
    const acts = el('td', { class: 'act' });
    if (open) acts.append(el('button', { type: 'button', title: open.title || open.label, onclick: open.run }, open.label));
    acts.append(el('button', { type: 'button', title: isDir ? 'Download the folder as a .zip' : 'Download to your computer', onclick: () => downloadPreviewPath(e.path) }, isDir ? '⬇ .zip' : '⬇'));
    acts.append(el('button', { class: 'del', type: 'button', title: 'Delete', 'aria-label': 'Delete ' + e.name, onclick: () => deletePreviewPath(e.path, isDir) }, '✕'));
    tbody.append(el('tr', {}, el('td', { class: 'n' }, name), el('td', { class: 'sz' }, isDir ? '' : fmtSize(e.node.data.length)), el('td', { class: 'dt' }, fmtDate(e.node.changed || e.node.created)), acts));
  }
  $('fempty').hidden = entries.length > 0;
  const files = entries.filter((e) => !e.node.dir).length, dirs = entries.length - files;
  $('fsum').textContent = (dirs ? dirs + (dirs === 1 ? ' folder, ' : ' folders, ') : '') + files + (files === 1 ? ' file' : ' files') + ' · ' + fmtSize(fs.size(cwd)) + ' · kept in this browser';
}

async function deletePreviewPath(path, isDir) {
  if (!await confirmDialog('Delete ' + sys.fs.name(path) + '?', isDir ? 'The folder and everything in it are deleted from the preview\'s file system.' : path + ' is deleted from the preview\'s file system.', 'Delete', true)) return;
  sys.removePath(path);
}

async function uploadToPreview(files, keepPaths) {
  let n = 0, bytes = 0;
  for (const f of files) {
    const rel = ((keepPaths && f.webkitRelativePath) || f.name).split('/').map(cleanSeg).filter(Boolean).join('/');
    if (!rel) continue;
    const data = new Uint8Array(await f.arrayBuffer());
    sys.writeFile(sys.fs.join(cwd, rel), data);
    n++; bytes += data.length;
  }
  if (n) status('Uploaded ' + n + ' file' + (n === 1 ? '' : 's') + ' (' + fmtSize(bytes) + ') to ' + cwd, 'ok');
}

async function newFolder() {
  const r = await ask({ title: 'New folder in ' + cwd, value: 'New folder', validate: (v) => !v ? 'Type a name.' : /[/\\:]/.test(v) ? 'A name cannot contain / \\ or :.' : sys.fs.get(sys.fs.join(cwd, cleanSeg(v))) ? 'That name is taken.' : '', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Create', value: 'ok', primary: true }] });
  if (r) sys.makeDir(sys.fs.join(cwd, cleanSeg(r.value)));
}

// ---------------------------------------------------------------------
//  Build
// ---------------------------------------------------------------------
function buildAll() {
  save(true);
  clearProblems();
  const t0 = performance.now();
  let r;
  try { r = window.MCC.compileX64(sources(), window.MCC.SDK, {}); }
  catch (e) {
    if (!(e instanceof window.MCC.CompileError)) { console.error(e); e = { message: 'internal compiler error: ' + e.message }; }
    reportError(e);
    status('Build failed', 'bad');
    return null;
  }
  const name = project.name;
  const res = resources();
  const run = window.MCC.bundleRun([{ name: 'main.elf', data: r.elf }].concat(res.map(f => ({ name: f.path, data: f.data }))));
  const copy = ['programs/' + name + '/' + name + '.run'];
  const manifest = '[Info]\nname=' + name + '\nversion=1.0.0\ndescription=Built with Xlabs Run Studio\narch=x86_64\noperatingsystem=MINIMALOS\n\n[Install.minimalos]\ncopy=' + copy.join(',') + '\ntarget=0:/\n';
  const mpkg = window.MCC.bundleMpkg([
    { name: 'programs', dir: true },
    { name: 'programs/' + name, dir: true },
    { name: 'programs/' + name + '/' + name + '.run', data: run },
    { name: name + '.pkg', data: enc.encode(manifest) },
  ]);
  return { r, run, mpkg, ms: Math.round(performance.now() - t0), name, res };
}

function buildReport(b) {
  const p = $('buildPanel');
  p.textContent = '';
  const h = el('div', { class: 'help' });
  const t = el('table', { class: 'report' });
  const rows = [
    ['Program', b.name + '.run (' + b.run.length.toLocaleString() + ' bytes)'],
    ['main.elf', b.r.elf.length.toLocaleString() + ' bytes · x86_64 ELF64 PIE (ET_DYN) at base 0'],
    ['Sections', '.text ' + b.r.textSize.toLocaleString() + ' · .data ' + b.r.dataSize.toLocaleString() + ' · .bss ' + b.r.bssSize.toLocaleString() + ' bytes'],
    ['Functions', String(b.r.functions)],
    ['Relocations', b.r.relocs + ' × R_X86_64_RELATIVE'],
    ['Resources', b.res.length ? b.res.length + ' file' + (b.res.length === 1 ? '' : 's') + ': ' + b.res.slice(0, 8).map(f => f.path).join(', ') + (b.res.length > 8 ? ', …' : '') : 'none'],
    ['Package', b.name + '.mpkg (' + b.mpkg.length.toLocaleString() + ' bytes) → 0:/programs/' + b.name + '/' + b.name + '.run'],
    ['Time', b.ms + ' ms'],
  ];
  for (const [k, v] of rows) { const tr = t.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; }
  h.appendChild(t);
  const dl = el('div', { class: 'dl' });
  const mk = (label, fn) => dl.append(el('button', { class: 'btn', type: 'button', onclick: fn }, label));
  mk('⬇ ' + b.name + '.run', () => download(b.name + '.run', b.run));
  mk('⬇ ' + b.name + '.mpkg', () => download(b.name + '.mpkg', b.mpkg));
  mk('⬇ main.elf', () => download('main.elf', b.r.elf));
  mk('Copy .run to the preview’s files', () => { sys.writeFile(HOME + '/Desktop/' + b.name + '.run', b.run); status('Saved ' + b.name + '.run in ' + HOME + '/Desktop', 'ok'); });
  h.appendChild(dl);
  h.appendChild(el('p', { html: 'Import the .run into MinimaFS and start it with <code>run 0:/programs/' + b.name + '.run</code>, or install the package with <code>pkg unzip 0:/' + b.name + '.mpkg 0:/</code> so mosWM shows it on the desktop.' }));
  p.appendChild(h);
  showTab('build');
}

function projectZip() {
  syncEditor();
  const entries = Object.entries(project.files).map(([p, f]) => ({ name: project.name + '/' + p, data: fileBytes(f) }));
  const readme = '# ' + project.name + '\n\nBuilt with Xlabs Run Studio. With the Minimal-OS SDK:\n\n    ./build.sh path/to/' + project.name + '\n\nThat produces ' + project.name + '.run from ' + mainOf(project.files) + '.\n';
  if (!project.files['README.md']) entries.push({ name: project.name + '/README.md', data: enc.encode(readme) });
  return makeZip(entries);
}

function doBuild(kind) {
  if (kind !== 'zip' && window.StudioLayout) window.StudioLayout.reveal('preview');
  if (kind === 'zip') { download(project.name + '.zip', projectZip(), 'application/zip'); return; }
  status('Building…');
  setTimeout(() => {
    const b = buildAll();
    if (!b) return;
    status('Built ' + b.name + '.run', 'ok');
    buildReport(b);
    if (kind === 'run') download(b.name + '.run', b.run);
    if (kind === 'mpkg') download(b.name + '.mpkg', b.mpkg);
    if (kind === 'elf') download('main.elf', b.r.elf);
  }, 10);
}

function buildMenu() {
  const n = project.name;
  popMenu($('build'), [
    { label: n + '.run', sub: 'The program bundle: import it and type run 0:/programs/' + n + '.run', run: () => doBuild('run') },
    { label: n + '.mpkg', sub: 'Installable package with a desktop shortcut in mosWM', run: () => doBuild('mpkg') },
    { label: 'main.elf', sub: 'The x86_64 executable inside the .run', run: () => doBuild('elf') },
    { sep: true },
    { label: 'Project source (.zip)', sub: 'All files, ready for the SDK\'s build.sh', run: () => doBuild('zip') },
  ]);
}

// ---------------------------------------------------------------------
//  Projects: templates and app sources
// ---------------------------------------------------------------------
function loadProjectInto(p) {
  kill();
  project = p;
  project.open = (project.open || [project.active]).filter((x) => project.files[x]);
  project.expanded = project.expanded || [];
  docs.clear();
  $('name').value = project.name; $('args').value = project.args || '';
  applyName();
  openFile(project.active && project.files[project.active] ? project.active : Object.keys(project.files)[0]);
  clearProblems();
  out.textContent = '';
  save(true);
}

function renderTemplatesList() {
  const box = $('tpls');
  box.textContent = '';
  box.append(el('h3', {}, 'Samples'));
  for (const t of TEMPLATES) {
    box.append(el('button', { class: 'tpl', type: 'button', onclick: () => { loadProjectInto(fromTemplate(t)); $('newDialog').close(); status('Loaded ' + t.title); } },
      el('i', {}, t.kind), el('b', {}, t.title), el('span', {}, t.description)));
  }
  if (sys.catalog.length) {
    box.append(el('h3', {}, 'Minimal-OS apps (their source)'));
    for (const a of sys.catalog) {
      box.append(el('button', { class: 'tpl', type: 'button', onclick: () => { $('newDialog').close(); openAppSource(a.id); } },
        tileFor(a.icon), el('i', {}, 'MOSdesk · ' + a.run + '.run'), el('b', {}, a.title), el('span', {}, a.description)));
    }
  }
}

function applyName() {
  project.name = safeName($('name').value);
  $('name').value = project.name;
  desktop.setApp(project.name);
  if ($('xtitle')) $('xtitle').textContent = project.name;
  save();
}

// F1: the docs entry for the identifier under the cursor, or show/hide the docs
function docsAtCursor() {
  const dv = window.DocsView;
  if (!dv) return;
  let word = '';
  if (cm && cm.hasFocus()) {
    const r = cm.findWordAt(cm.getCursor());
    word = cm.getRange(r.anchor, r.head);
  } else if (textarea && document.activeElement === textarea) {
    const v = textarea.value, at = textarea.selectionStart;
    word = (v.slice(0, at).match(/\w*$/)[0] + v.slice(at).match(/^\w*/)[0]);
  }
  if (dv.has(word)) dv.open(word); else dv.toggle();
}

// drop files from the computer on a folder row, the editor or the Files tab
function dropTarget(node, dir, onDrop) {
  node.addEventListener('dragover', (e) => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); e.stopPropagation(); node.classList.add(dir !== undefined && !onDrop ? 'drop-into' : 'drop'); });
  node.addEventListener('dragleave', () => node.classList.remove('drop', 'drop-into'));
  node.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault(); e.stopPropagation();
    node.classList.remove('drop', 'drop-into');
    if (onDrop) onDrop([...e.dataTransfer.files]);
    else { uploadInto = dir || ''; uploadFiles([...e.dataTransfer.files]); }
  });
}

async function init() {
  project = await loadProject();
  project.open = Array.isArray(project.open) ? project.open.filter((p) => project.files[p]) : [project.active];
  project.expanded = project.expanded || [];
  if (!project.files[project.active]) project.active = project.open[0] || Object.keys(project.files)[0];
  if (!project.open.length && project.active) project.open = [project.active];
  setupEditor();
  $('xNew').innerHTML = ICON.plus; $('xUpload').innerHTML = ICON.upload; $('xZip').innerHTML = ICON.download;
  $('explorer').hidden = !explorerOpen;
  if (window.DocsView) window.DocsView.onResize = () => { if (cm) cm.refresh(); };
  $('name').value = project.name;
  $('args').value = project.args || '';
  applyName();
  showFile(project.active);
  clearProblems();
  status('Ready');
  renderTemplatesList();

  $('run').addEventListener('click', () => run());
  $('stop').addEventListener('click', stop);
  $('new').addEventListener('click', () => { renderTemplatesList(); $('newDialog').showModal(); });
  $('newCancel').addEventListener('click', () => $('newDialog').close());
  $('name').addEventListener('change', applyName);
  $('args').addEventListener('change', () => { project.args = $('args').value.trim(); save(); });
  $('res').addEventListener('change', () => { const { w, h } = screenSize(); sys.setScreen(w, h); $('screen').style.aspectRatio = w + '/' + h; if (!exited) run(); });
  $('build').addEventListener('click', buildMenu);
  $('apps').addEventListener('click', appsMenu);
  // the explorer's buttons
  $('xNew').addEventListener('click', () => newFile(''));
  $('xZip').addEventListener('click', () => doBuild('zip'));
  $('xUpload').addEventListener('click', () => popMenu($('xUpload'), [
    { label: 'Files…', sub: 'Sources go to the top, other files to Resources/', run: () => pickUpload('files') },
    { label: 'Folder…', sub: 'Everything in it, keeping its sub-folders', run: () => pickUpload('folder') },
    { label: 'Project .zip…', sub: 'Unpacked into the project', run: () => pickUpload('zip') },
  ]));
  $('upload').addEventListener('change', (e) => { uploadFiles([...e.target.files]); e.target.value = ''; });
  $('uploadDir').addEventListener('change', (e) => { uploadFiles([...e.target.files], { keepPaths: true }); e.target.value = ''; });
  $('uploadZip').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importZip(new Uint8Array(await f.arrayBuffer())); });
  // the Files tab
  $('fUpload').addEventListener('click', () => popMenu($('fUpload'), [
    { label: 'Files…', sub: 'Into ' + cwd, run: () => $('filesUpload').click() },
    { label: 'Folder…', sub: 'Into ' + cwd + ', with its sub-folders', run: () => $('filesUploadDir').click() },
  ], { alignRight: true }));
  $('filesUpload').addEventListener('change', (e) => { uploadToPreview([...e.target.files]); e.target.value = ''; });
  $('filesUploadDir').addEventListener('change', (e) => { uploadToPreview([...e.target.files], true); e.target.value = ''; });
  $('fMkdir').addEventListener('click', newFolder);
  $('fReset').addEventListener('click', async () => {
    if (!await confirmDialog('Reset the preview\'s files?', 'Everything you uploaded and every file a program saved (settings included) is deleted. Running programs stop and the page reloads. Your project is not affected.', 'Reset files', true)) return;
    save(true);
    await sys.fs.clearSaved();
    location.reload();
  });
  dropTarget($('filesPanel'), undefined, (files) => uploadToPreview(files));
  document.querySelectorAll('.ctab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.ctab)));
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); run(); }
    else if (mod && e.key === '.') { e.preventDefault(); stop(); }
    // the other keys belong to the program when the preview has focus
    else if (e.target === $('screen')) return;
    else if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(true); status('Saved in this browser'); }
    else if (mod && (e.key === 'b' || e.key === 'B') && !e.shiftKey && !e.altKey) { e.preventDefault(); setExplorer(!explorerOpen); }
    else if (e.key === 'F1' && !mod) { e.preventDefault(); docsAtCursor(); }
  });
  dropTarget(document.querySelector('.editor'), '');
  window.addEventListener('beforeunload', () => save(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(true); });
  if (location.protocol === 'file:') log('Open this page through a web server to use the preview (Web Workers do not run from file://).\n', 'bad');
}

init();
})();
