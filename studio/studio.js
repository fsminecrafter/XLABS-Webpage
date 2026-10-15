/* Run Studio: editor, preview and in-browser builds for Minimal-OS .run apps. */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const STORE = 'xlabs.studio.project.v1';
const TEMPLATES = window.STUDIO_TEMPLATES || [];
const isSource = (p) => /\.(c|h|cpp|cc|cxx|hpp|hh)$/i.test(p);
const isCppFile = (p) => /\.(cpp|cc|cxx|hpp|hh)$/i.test(p);
// the program's entry file: main.cpp for a C++ project, main.c otherwise
const mainOf = (files) => (files['main.cpp'] ? 'main.cpp' : 'main.c');

// ---------------------------------------------------------------------
//  Project
// ---------------------------------------------------------------------
let project = null;

function fromTemplate(t) {
  const files = {};
  for (const [p, text] of Object.entries(t.files)) files[p] = { text };
  return { name: t.name, files, active: mainOf(files), args: '' };
}

function loadProject() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) { const p = JSON.parse(raw); if (p && p.files && Object.keys(p.files).length) return p; }
  } catch (e) { /* private mode or cleared storage: start fresh */ }
  return fromTemplate(TEMPLATES[0]);
}

let saveTimer = 0;
function save(now) {
  clearTimeout(saveTimer);
  const write = () => {
    syncEditor();
    try { localStorage.setItem(STORE, JSON.stringify(project)); } catch (e) { /* storage full or blocked */ }
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
let cm = null, textarea = null, binaryNote = null;
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
    cm.on('change', () => { clearMarks(); save(); });
  } else {
    textarea = document.createElement('textarea');
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', 'Source code');
    codeHost.appendChild(textarea);
    textarea.addEventListener('input', () => save());
  }
  binaryNote = document.createElement('div');
  binaryNote.className = 'binary';
  binaryNote.hidden = true;
  codeHost.appendChild(binaryNote);
}

function syncEditor() {
  const f = project.files[project.active];
  if (!f || f.b64 !== undefined) return;
  if (cm) { const d = docs.get(project.active); if (d) f.text = d.getValue(); }
  else if (textarea) f.text = textarea.value;
}

function openFile(path) {
  syncEditor();
  project.active = path;
  const f = project.files[path];
  const binary = f.b64 !== undefined;
  binaryNote.hidden = !binary;
  if (cm) cm.getWrapperElement().style.visibility = binary ? 'hidden' : 'visible';
  if (textarea) textarea.hidden = binary;
  if (binary) {
    binaryNote.textContent = path + ' — binary resource, ' + b64size(f.b64).toLocaleString() + ' bytes. It is packed into the .run and appears in the preview under 0:/programs/' + project.name + '/.';
  } else if (cm) {
    let d = docs.get(path);
    if (!d) {
      // headers follow the project: C++ highlighting once it has a .cpp file
      const cpp = isCppFile(path) || (/\.h$/i.test(path) && Object.keys(project.files).some(isCppFile));
      d = window.CodeMirror.Doc(f.text, !isSource(path) ? 'text/plain' : cpp ? 'text/x-c++src' : 'text/x-csrc');
      docs.set(path, d);
    }
    cm.swapDoc(d);
    cm.refresh();
  } else textarea.value = f.text;
  renderTabs();
  save();
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.textContent = '';
  const main = mainOf(project.files);
  const paths = Object.keys(project.files).sort((a, b) => (a === main ? -1 : b === main ? 1 : a.localeCompare(b)));
  for (const p of paths) {
    const b = document.createElement('button');
    b.className = 'tab'; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', p === project.active ? 'true' : 'false');
    b.title = p + ' (double-click to rename)';
    b.textContent = p;
    const x = document.createElement('span');
    x.className = 'x'; x.textContent = '✕'; x.title = 'Delete ' + p; x.setAttribute('role', 'button');
    x.addEventListener('click', (e) => { e.stopPropagation(); removeFile(p); });
    b.appendChild(x);
    b.addEventListener('click', () => openFile(p));
    b.addEventListener('dblclick', () => renameFile(p));
    tabs.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'tab add'; add.textContent = '+'; add.title = 'New file';
  add.addEventListener('click', newFile);
  tabs.appendChild(add);
  const up = document.createElement('button');
  up.className = 'tab add'; up.textContent = '⇪'; up.title = 'Add files from your computer (sources or resources)';
  up.addEventListener('click', () => $('upload').click());
  tabs.appendChild(up);
}

function validPath(p) { return /^[A-Za-z0-9_.\-/]+$/.test(p) && !p.split('/').some(s => !s || s === '.' || s === '..'); }

function newFile() {
  const p = prompt('New file name (for example util.c, util.cpp, util.h or Resources/notes.txt):', 'util.h');
  if (!p) return;
  if (!validPath(p)) { alert('Use letters, digits, _ . - and / only.'); return; }
  if (project.files[p]) { openFile(p); return; }
  const guard = p.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  project.files[p] = { text: /\.h$/.test(p) ? '#ifndef ' + guard + '\n#define ' + guard + '\n\n\n#endif\n' : '' };
  openFile(p);
}

function renameFile(p) {
  const n = prompt('Rename ' + p + ' to:', p);
  if (!n || n === p) return;
  if (!validPath(n) || project.files[n]) { alert('That name is not valid or already used.'); return; }
  syncEditor();
  project.files[n] = project.files[p];
  delete project.files[p];
  if (docs.has(p)) { docs.set(n, docs.get(p)); docs.delete(p); }
  if (project.active === p) project.active = n;
  openFile(project.active);
}

function removeFile(p) {
  if (Object.keys(project.files).length === 1) return;
  if (!confirm('Delete ' + p + '?')) return;
  delete project.files[p];
  docs.delete(p);
  if (project.active === p) project.active = Object.keys(project.files)[0];
  openFile(project.active);
}

function b64size(b64) { return Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0); }
function toB64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

async function addUploads(list) {
  for (const file of list) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let name = file.name.replace(/[^A-Za-z0-9_.-]+/g, '_');
    const text = /\.(c|h|txt|md|ini|service|cfg|json|csv)$/i.test(name);
    if (!isSource(name) && name !== 'icon.bmp' && name !== 'icon.ico' && !name.startsWith('Resources/')) name = 'Resources/' + name;
    project.files[name] = text ? { text: new TextDecoder().decode(buf) } : { b64: toB64(buf) };
    docs.delete(name);
    project.active = name;
  }
  openFile(project.active);
}

// ---------------------------------------------------------------------
//  Console
// ---------------------------------------------------------------------
const out = $('out');
function log(text, cls) {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  out.appendChild(s);
  if (out.childNodes.length > 2000) out.removeChild(out.firstChild);
  out.scrollTop = out.scrollHeight;
}
function status(text, cls) { const s = $('status'); s.textContent = text; s.className = 'status' + (cls ? ' ' + cls : ''); }

function showTab(name) {
  document.querySelectorAll('.ctab').forEach(b => b.setAttribute('aria-selected', b.dataset.ctab === name ? 'true' : 'false'));
  $('out').hidden = name !== 'out'; $('problems').hidden = name !== 'problems'; $('buildPanel').hidden = name !== 'build'; $('help').hidden = name !== 'help';
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
  const b = document.createElement('button');
  b.className = 'problem';
  const tag = document.createElement('b'); tag.textContent = 'error ';
  b.append(tag, document.createTextNode((where ? where + ': ' : '') + err.message));
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
    const d = docs.get(file) || (openFile(file), docs.get(file));
    const line = err.line - 1;
    if (d && line < d.lineCount()) {
      d.addLineClass(line, 'background', 'err-line');
      const mk = document.createElement('span'); mk.className = 'err-mark'; mk.textContent = '●'; mk.title = err.message;
      d.setGutterMarker(line, 'errors', mk);
      marks.push({ doc: d, line });
    }
    jump();
  }
  if (file.startsWith('<sdk>/')) {
    const n = document.createElement('p'); n.className = 'sys'; n.style.margin = '6px 6px 0';
    n.textContent = 'The error is inside an SDK header, usually because of how it was called from your code (or two headers that clash).';
    p.appendChild(n);
  }
  showTab('problems');
}
function clearProblems() { $('problems').textContent = 'No problems.'; $('pcount').hidden = true; clearMarks(); }

// ---------------------------------------------------------------------
//  Preview
// ---------------------------------------------------------------------
let worker = null, alive = false, lastPong = 0, pingTimer = 0, exited = true;
const desktop = new window.Desktop($('screen'), {
  appName: 'app',
  onSend: (m) => { if (worker && !exited) worker.postMessage(m); },
  onLaunch: () => run(),
  onStop: () => stop(),
});

function sources() {
  syncEditor();
  const files = {};
  for (const [p, f] of Object.entries(project.files)) if (f.text !== undefined && isSource(p)) files[p] = f.text;
  return files;
}
function resources() {
  const list = [];
  for (const [p, f] of Object.entries(project.files)) {
    if (isSource(p)) continue;
    list.push({ path: p, data: f.b64 !== undefined ? fromB64(f.b64) : new TextEncoder().encode(f.text) });
  }
  return list;
}

function kill() {
  if (worker) worker.terminate();
  worker = null; alive = false; exited = true;
  clearInterval(pingTimer);
  $('stop').disabled = true;
  desktop.programExited();
}

function run() {
  kill();
  save(true);
  clearProblems();
  out.textContent = '';
  showTab('out');
  const name = project.name;
  log('$ run 0:/programs/' + name + '.run' + (project.args ? ' ' + project.args : '') + '\n', 'sys');
  status('Compiling…');
  desktop.setApp(name);
  desktop.programStarted();
  try { worker = new Worker('worker.js'); } catch (e) {
    status('Preview unavailable', 'bad');
    log('The preview needs a web server (Web Workers do not run from file://). Try: python3 -m http.server\n', 'bad');
    return;
  }
  exited = false;
  const [w, h] = $('res').value.split('x').map(Number);
  worker.onmessage = (e) => onWorker(e.data);
  worker.onerror = (e) => { log('Preview error: ' + (e.message || e) + '\n', 'bad'); status('Preview error', 'bad'); kill(); };
  worker.postMessage({ t: 'run', files: sources(), name, args: project.args ? project.args.split(/\s+/).filter(Boolean) : [], screen: { w, h }, resources: resources() });
  lastPong = performance.now();
  pingTimer = setInterval(() => {
    if (!worker) return;
    if (performance.now() - lastPong > 3000 && alive) status('Not responding — Stop ends it', 'bad');
    worker.postMessage({ t: 'ping' });
  }, 1000);
}

function stop() {
  if (!worker || exited) return;
  worker.postMessage({ t: 'stop' });
  status('Stopping…');
  const w = worker;
  setTimeout(() => { if (worker === w && !exited) { log('\nForce-terminated.\n', 'bad'); status('Terminated', 'bad'); kill(); } }, 1500);
}

function onWorker(m) {
  switch (m.t) {
    case 'pong': lastPong = performance.now(); if (alive && /Not responding/.test($('status').textContent)) status('Running', 'ok'); return;
    case 'compileError':
      reportError(m.error);
      if (m.internal) console.warn(m.internal);
      status('Compile error', 'bad');
      log('Compilation failed: ' + (m.error.file ? m.error.file + ':' + m.error.line + ': ' : '') + m.error.message + '\n', 'bad');
      kill();
      return;
    case 'started':
      alive = true;
      $('stop').disabled = false;
      status('Running', 'ok');
      log('compiled in ' + m.compileMs + ' ms\n', 'sys');
      $('screen').focus({ preventScroll: true });
      return;
    case 'out': log(m.text); desktop.message(m); return;
    case 'exit':
      exited = true;
      if (m.crash) { log('\nProgram crashed! Code 0x' + m.code.toString(16) + ': ' + m.crash + '\n', 'bad'); status('Crashed', 'bad'); desktop.write('\nProgram crashed! Code 0x' + m.code.toString(16) + ': ' + m.crash + '\n'); }
      else { log('\n[exited with code ' + m.code + ']\n', m.code ? 'bad' : 'ok'); status('Exited (' + m.code + ')', m.code ? 'bad' : ''); }
      alive = false;
      clearInterval(pingTimer);
      $('stop').disabled = true;
      desktop.programExited();
      setTimeout(() => { if (exited && worker) { worker.terminate(); worker = null; } }, 50);
      return;
    case 'fs': return;
    default: desktop.message(m);
  }
}

// ---------------------------------------------------------------------
//  Build
// ---------------------------------------------------------------------
function download(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

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
  const enc = new TextEncoder();
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
  const h = document.createElement('div'); h.className = 'help';
  const t = document.createElement('table'); t.className = 'report';
  const rows = [
    ['Program', b.name + '.run (' + b.run.length.toLocaleString() + ' bytes)'],
    ['main.elf', b.r.elf.length.toLocaleString() + ' bytes · x86_64 ELF64 PIE (ET_DYN) at base 0'],
    ['Sections', '.text ' + b.r.textSize.toLocaleString() + ' · .data ' + b.r.dataSize.toLocaleString() + ' · .bss ' + b.r.bssSize.toLocaleString() + ' bytes'],
    ['Functions', String(b.r.functions)],
    ['Relocations', b.r.relocs + ' × R_X86_64_RELATIVE'],
    ['Resources', b.res.length ? b.res.map(f => f.path).join(', ') : 'none'],
    ['Package', b.name + '.mpkg (' + b.mpkg.length.toLocaleString() + ' bytes) → 0:/programs/' + b.name + '/' + b.name + '.run'],
    ['Time', b.ms + ' ms'],
  ];
  for (const [k, v] of rows) { const tr = t.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; }
  h.appendChild(t);
  const dl = document.createElement('div'); dl.className = 'dl';
  const mk = (label, fn) => { const x = document.createElement('button'); x.className = 'btn'; x.textContent = label; x.addEventListener('click', fn); dl.appendChild(x); };
  mk('⬇ ' + b.name + '.run', () => download(b.name + '.run', b.run));
  mk('⬇ ' + b.name + '.mpkg', () => download(b.name + '.mpkg', b.mpkg));
  mk('⬇ main.elf', () => download('main.elf', b.r.elf));
  h.appendChild(dl);
  const note = document.createElement('p');
  note.innerHTML = 'Import the .run into MinimaFS and start it with <code>run 0:/programs/' + b.name + '.run</code>, or install the package with <code>pkg unzip 0:/' + b.name + '.mpkg 0:/</code> so mosWM shows it on the desktop.';
  h.appendChild(note);
  p.appendChild(h);
  showTab('build');
}

function doBuild(kind) {
  if (kind === 'zip') { download(project.name + '.zip', makeZip(), 'application/zip'); return; }
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

// a stored (uncompressed) zip with the project files
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip() {
  syncEditor();
  const enc = new TextEncoder();
  const entries = Object.entries(project.files).map(([p, f]) => ({ name: enc.encode(project.name + '/' + p), data: f.b64 !== undefined ? fromB64(f.b64) : enc.encode(f.text) }));
  const readme = '# ' + project.name + '\n\nBuilt with Xlabs Run Studio. With the Minimal-OS SDK:\n\n    ./build.sh path/to/' + project.name + '\n\nThat produces ' + project.name + '.run from ' + mainOf(project.files) + '.\n';
  if (!project.files['README.md']) entries.push({ name: enc.encode(project.name + '/README.md'), data: enc.encode(readme) });
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

// ---------------------------------------------------------------------
//  Wiring
// ---------------------------------------------------------------------
function applyName() {
  project.name = safeName($('name').value);
  $('name').value = project.name;
  document.querySelectorAll('[data-build]').forEach(b => {
    const label = b.firstChild;
    if (b.dataset.build === 'run') label.textContent = project.name + '.run';
    if (b.dataset.build === 'mpkg') label.textContent = project.name + '.mpkg';
  });
  desktop.setApp(project.name);
  save();
}

function openTemplates() {
  const box = $('tpls');
  box.textContent = '';
  for (const t of TEMPLATES) {
    const b = document.createElement('button');
    b.className = 'tpl';
    const i = document.createElement('i'); i.textContent = t.kind;
    const n = document.createElement('b'); n.textContent = t.title;
    const s = document.createElement('span'); s.textContent = t.description;
    b.append(i, n, s);
    b.addEventListener('click', () => {
      kill();
      project = fromTemplate(t);
      docs.clear();
      $('name').value = project.name; $('args').value = '';
      applyName();
      openFile(mainOf(project.files));
      clearProblems();
      out.textContent = '';
      $('newDialog').close();
      status('Loaded ' + t.title);
    });
    box.appendChild(b);
  }
  $('newDialog').showModal();
}

function init() {
  project = loadProject();
  setupEditor();
  $('name').value = project.name;
  $('args').value = project.args || '';
  applyName();
  if (!project.files[project.active]) project.active = Object.keys(project.files)[0];
  openFile(project.active);
  clearProblems();
  status('Ready');

  $('run').addEventListener('click', run);
  $('stop').addEventListener('click', stop);
  $('new').addEventListener('click', openTemplates);
  $('newCancel').addEventListener('click', () => $('newDialog').close());
  $('name').addEventListener('change', applyName);
  $('args').addEventListener('change', () => { project.args = $('args').value.trim(); save(); });
  $('res').addEventListener('change', () => { const [w, h] = $('res').value.split('x').map(Number); desktop.setScreen(w, h); $('screen').style.aspectRatio = w + '/' + h; if (worker && !exited) run(); });
  $('upload').addEventListener('change', (e) => { addUploads([...e.target.files]); e.target.value = ''; });
  const menuBtn = $('build'), menu = $('buildMenu');
  const closeMenu = () => { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); };
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; menuBtn.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('button').focus(); });
  menu.addEventListener('click', (e) => { const b = e.target.closest('[data-build]'); if (b) { closeMenu(); doBuild(b.dataset.build); } });
  document.addEventListener('click', closeMenu);
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); menuBtn.focus(); } });
  document.querySelectorAll('.ctab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.ctab)));
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); run(); }
    else if (mod && e.key === '.') { e.preventDefault(); stop(); }
    else if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(true); status('Saved in this browser'); }
  });
  const pane = document.querySelector('.editor');
  pane.addEventListener('dragover', (e) => { e.preventDefault(); pane.classList.add('drop'); });
  pane.addEventListener('dragleave', () => pane.classList.remove('drop'));
  pane.addEventListener('drop', (e) => { e.preventDefault(); pane.classList.remove('drop'); if (e.dataTransfer.files.length) addUploads([...e.dataTransfer.files]); });
  window.addEventListener('beforeunload', () => save(true));
  if (location.protocol === 'file:') log('Open this page through a web server to use the preview (Web Workers do not run from file://).\n', 'bad');
}

init();
})();
