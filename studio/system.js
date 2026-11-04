/*
 * The preview system: what runs in the Studio preview besides the editor.
 *
 *  - MinimaFS: one file system shared by every program in the preview. The
 *    page holds the master copy; each worker gets a snapshot when it starts
 *    and sends back what it changes, which the page passes on to the other
 *    workers. Files that programs write or that you upload are kept in this
 *    browser (IndexedDB); the system files and installed apps are rebuilt on
 *    every visit.
 *  - Processes: the project and any number of Minimal-OS apps, each in its
 *    own worker. Window ids are made unique across them (pid * WIN_PER_PROC
 *    + the worker's id) so the desktop can tell whose window is whose.
 *  - The app catalog: apps/index.json, built from MOSdesk by
 *    tools/build-apps.mjs. An app's files are fetched the first time it runs.
 */
(function () {
'use strict';

const WIN_PER_PROC = 128;
const HOME = '0:/users/user';
const enc = new TextEncoder();

// ---------------------------------------------------------------------
//  Icons: one set for the page and for the preview desktop
// ---------------------------------------------------------------------
const ICON_PATHS = {
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="3.8" ry="9"/><path d="M3.5 9h17M3.5 15h17"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l3 2.5L7 15M12.5 15.5H17"/>',
  edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 00-3-3L5 17v3z"/><path d="M14.5 7.5l2.9 2.9"/>',
  calc: '<rect x="5" y="2.5" width="14" height="19" rx="2.5"/><rect x="8" y="5.5" width="8" height="3.5" rx="1"/><path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 17h.01M12 17h.01M15.5 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  paint: '<path d="M14.5 4.5l5 5-7.5 7.5-5-5z"/><path d="M7 12l-2.6 2.6a2.5 2.5 0 000 3.5l.5.5c-1 1-2.4 1-2.9 1 1.6 1.3 4.9 1.5 6.4 0l2.6-2.6"/>',
  photo: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path d="M21 16l-5-5-9.5 8.5"/>',
  music: '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3z"/>',
  golf: '<path d="M8 21V3l9 4-9 4"/><ellipse cx="11" cy="21" rx="6" ry="1.2"/>',
  snake: '<path d="M3 16c2.2 0 2.2-4 4.5-4S10 16 12 16s2.2-4 4.5-4 2.3 4 4.5 4"/><path d="M18.5 9.5h.01"/>',
  cube: '<path d="M12 2.8l8 4.6v9.2L12 21.2l-8-4.6V7.4z"/><path d="M4 7.4l8 4.6 8-4.6M12 12v9.2"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 015.5 5h3.6l2.2 2.2h7.2A2.5 2.5 0 0121 9.7v7.8a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 17.5z"/>',
  computer: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4"/>',
  app: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M9.5 9l3 3-3 3M13.5 15h2"/>',
  file: '<path d="M6.5 3h7.5l4 4v13.5a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-17a.5.5 0 01.5-.5z"/><path d="M14 3v4h4"/>',
};
const ICON_COLORS = {
  globe: '#2F6FEB', terminal: '#2B3A42', edit: '#3F7CA6', calc: '#6B5CA5', clock: '#D9822B', paint: '#C2416B',
  photo: '#2E9E77', music: '#8E44AD', video: '#C0392B', golf: '#3C9A4A', snake: '#5D8A2F', cube: '#2A9BD6',
  folder: '#E8B34C', computer: '#5B7083', app: '#24343C', file: '#5B7083',
};
function iconSvg(name, opts) {
  opts = opts || {};
  const body = ICON_PATHS[name] || ICON_PATHS.app;
  const size = opts.size || 18;
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="' + (opts.color || 'currentColor') +
    '" stroke-width="' + (opts.stroke || 1.8) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}
// an icon as an image the desktop canvas can draw
const iconImages = new Map();
function iconImage(name, color, onload) {
  const key = name + color;
  let img = iconImages.get(key);
  if (!img) {
    img = new Image();
    img.onload = () => { img.ready = true; if (onload) onload(); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg(name, { size: 48, color, stroke: 1.7 }));
    iconImages.set(key, img);
  }
  return img;
}

// ---------------------------------------------------------------------
//  IndexedDB: a small key/value store
// ---------------------------------------------------------------------
const DB = (function () {
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        if (!self.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
        const r = indexedDB.open('xlabs-studio', 1);
        r.onupgradeneeded = () => { const db = r.result; for (const s of ['fs', 'kv']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('IndexedDB is blocked'));
      });
      dbp.catch(() => {});
    }
    return dbp;
  }
  function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  return {
    get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
    set: (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key)),
    del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
    clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
    entries: (store) => open().then((db) => new Promise((resolve, reject) => {
      const out = [];
      const r = db.transaction(store, 'readonly').objectStore(store).openCursor();
      r.onsuccess = () => { const c = r.result; if (c) { out.push([c.key, c.value]); c.continue(); } else resolve(out); };
      r.onerror = () => reject(r.error);
    })),
  };
})();

// ---------------------------------------------------------------------
//  MinimaFS (the page's copy)
// ---------------------------------------------------------------------
class PreviewFS {
  constructor() {
    this.nodes = new Map();
    this.listeners = new Set();
    this.mkdirs('0:/');
  }
  norm(p) {
    p = String(p || '').replace(/\\/g, '/');
    if (!/^\d+:/.test(p)) p = '0:/' + p.replace(/^\/+/, '');
    const m = /^(\d+):\/?(.*)$/.exec(p);
    const parts = [];
    for (const s of m[2].split('/')) { if (!s || s === '.') continue; if (s === '..') parts.pop(); else parts.push(s); }
    return m[1] + ':/' + parts.join('/');
  }
  parent(p) { const i = p.lastIndexOf('/'); return i <= 2 ? p.slice(0, 3) : p.slice(0, i); }
  name(p) { return p.length <= 3 ? p : p.slice(p.lastIndexOf('/') + 1); }
  join(dir, name) { return this.norm(dir.length > 3 ? dir + '/' + name : dir + name); }
  get(p) { return this.nodes.get(this.norm(p)); }
  // persisted: changes outside the program folders Studio manages
  keeps(p) { return !this.managed || !this.managed(p); }

  mkdirs(p, opts) {
    p = this.norm(p);
    const segs = p.slice(3).split('/').filter(Boolean);
    let cur = p.slice(0, 3);
    const made = [];
    for (let i = -1; i < segs.length; i++) {
      if (i >= 0) cur = cur.length > 3 ? cur + '/' + segs[i] : cur + segs[i];
      if (!this.nodes.has(cur)) { this.nodes.set(cur, { dir: true, created: Date.now() }); made.push(cur); }
    }
    if (opts && opts.user) for (const d of made) this.persist(d);
    return p;
  }
  write(p, data, opts) {
    p = this.norm(p);
    this.mkdirs(this.parent(p), opts);
    const bytes = data instanceof Uint8Array ? data : enc.encode(String(data));
    const old = this.nodes.get(p);
    const now = Date.now();
    this.nodes.set(p, { dir: false, data: bytes, created: old && !old.dir ? old.created : now, changed: now });
    if (opts && opts.user) this.persist(p);
    return p;
  }
  remove(p, opts) {
    p = this.norm(p);
    const pre = p + '/';
    const gone = [...this.nodes.keys()].filter((k) => k === p || k.startsWith(pre));
    for (const k of gone) { this.nodes.delete(k); if (opts && opts.user) DB.del('fs', k).catch(() => {}); }
    return gone.length > 0;
  }
  list(p) {
    p = this.norm(p);
    const pre = p.length > 3 ? p + '/' : p;
    const out = [];
    for (const [k, v] of this.nodes) {
      if (k === p || !k.startsWith(pre)) continue;
      const rest = k.slice(pre.length);
      if (rest && !rest.includes('/')) out.push({ name: rest, path: k, node: v });
    }
    return out.sort((a, b) => (b.node.dir - a.node.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }
  size(p) {
    p = this.norm(p);
    const n = this.nodes.get(p);
    if (!n) return 0;
    if (!n.dir) return n.data.length;
    let total = 0;
    const pre = p.length > 3 ? p + '/' : p;
    for (const [k, v] of this.nodes) if (!v.dir && k.startsWith(pre)) total += v.data.length;
    return total;
  }
  persist(p) {
    if (!this.keeps(p)) return;
    const n = this.nodes.get(p);
    if (n) DB.set('fs', p, n).catch(() => {});
  }
  async restore() {
    try {
      for (const [k, v] of await DB.entries('fs')) {
        if (!this.keeps(k)) continue;
        if (v.dir) this.mkdirs(k); else { this.mkdirs(this.parent(k)); this.nodes.set(k, v); }
      }
    } catch (e) { /* no IndexedDB: the files last for this visit */ }
  }
  async clearSaved() { try { await DB.clear('fs'); } catch (e) { /* nothing saved */ } }
  snapshot() {
    const out = [];
    for (const [path, n] of this.nodes) out.push(n.dir ? { path, dir: true } : { path, data: n.data, created: n.created, changed: n.changed });
    return out;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(change) { for (const fn of this.listeners) { try { fn(change); } catch (e) { console.error(e); } } }
}

// ---------------------------------------------------------------------
//  The system
// ---------------------------------------------------------------------
class PreviewSystem {
  constructor(opts) {
    this.opts = opts;
    this.fs = new PreviewFS();
    this.fs.managed = (p) => this.isManaged(p);
    this.procs = new Map();          // pid -> proc
    this.nextPid = 12;
    this.project = null;             // the project's proc
    this.projectName = '';
    this.catalog = [];
    this.appFiles = new Map();       // id -> Promise<files>
    this.gfxOwner = 0;
    this.listeners = new Set();
    this.desktop = new window.Desktop(opts.canvas, {
      appName: 'app',
      onSend: (m) => this.fromDesktop(m),
      onLaunch: () => opts.onRunProject && opts.onRunProject(),
      onStop: () => opts.onStopProject && opts.onStopProject(),
      apps: () => this.catalog,
      onLaunchApp: (id) => this.launchApp(id),
      onOpenFiles: (path) => opts.onOpenFiles && opts.onOpenFiles(path),
      iconImage: (name, color) => iconImage(name, color, () => this.desktop.invalidate()),
      iconColor: (name) => ICON_COLORS[name] || ICON_COLORS.app,
      winPerProc: WIN_PER_PROC,
    });
    this.ready = this.boot();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) { try { fn(ev); } catch (e) { console.error(e); } } }

  // Studio manages 0:/programs: the apps it installs and the project
  isManaged(p) {
    if (!p.startsWith('0:/programs')) return false;
    if (/\.run$/.test(p) && p.split('/').length === 3) return true;
    const top = p.split('/')[2];
    if (!top) return false;
    return top === 'mosWM' || top === this.projectName || this.catalog.some((a) => a.run === top);
  }

  async boot() {
    const fs = this.fs;
    for (const d of ['0:/etc', '0:/programs', '0:/services', '0:/data', '0:/users', HOME + '/Documents', HOME + '/Pictures', HOME + '/Desktop']) fs.mkdirs(d);
    fs.write('0:/etc/motd.txt', 'Welcome to Minimal-OS.\n');
    fs.write('0:/etc/minimaSSL.slib', new Uint8Array(16));
    fs.write(HOME + '/Documents/Welcome.txt',
      'This is your home folder in the Studio preview.\n\n' +
      'Upload files in the Files tab (next to Output) and every program in the\n' +
      'preview can open them. What programs save here can be downloaded there.\n' +
      'Files you add are kept in this browser.\n');
    const fonts = await Promise.all(['Inter-Regular.otf', 'Inter-Medium.otf'].map((n) =>
      fetch('fonts/' + n).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => b && { n, b }).catch(() => null)));
    for (const f of fonts) if (f) fs.write('0:/programs/mosWM/assets/fonts/' + f.n, new Uint8Array(f.b));
    try {
      const r = await fetch('apps/index.json');
      if (r.ok) { const j = await r.json(); this.catalog = j.apps || []; this.catalogSource = j.source || ''; }
    } catch (e) { /* file:// or offline: no apps */ }
    for (const a of this.catalog) fs.write(this.appPath(a), runStub(a.title));
    await fs.restore();
    this.desktop.invalidate();
    this.emit({ t: 'catalog' });
    fs.emit({ op: 'reset' });
  }

  appPath(a) { return '0:/programs/' + a.run + '.run'; }
  projectPath() { return '0:/programs/' + this.projectName + '.run'; }
  runnables() { return this.catalog.map((a) => this.appPath(a)).concat(this.projectName ? [this.projectPath()] : []); }
  app(id) { return this.catalog.find((a) => a.id === id); }

  // an app's files (sources and resources), fetched once
  loadApp(id) {
    if (!this.appFiles.has(id)) {
      const p = fetch('apps/' + id + '.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((j) => j.files);
      p.catch(() => this.appFiles.delete(id));
      this.appFiles.set(id, p);
    }
    return this.appFiles.get(id);
  }

  // ---- file changes: from a program, or from the Files tab (from = null) ----
  change(m, from) {
    const fs = this.fs;
    const user = { user: true };
    if (m.op === 'write') fs.write(m.path, m.data, user);
    else if (m.op === 'mkdir') fs.mkdirs(m.path, user);
    else if (m.op === 'delete') fs.remove(m.path, user);
    for (const p of this.procs.values()) if (p !== from && !p.exited) p.worker.postMessage({ t: 'fsw', op: m.op, path: fs.norm(m.path), data: m.data });
    fs.emit({ op: m.op, path: fs.norm(m.path), from: from ? from.name : null });
  }
  writeFile(path, data) { this.change({ op: 'write', path, data: data instanceof Uint8Array ? data : enc.encode(String(data)) }, null); }
  makeDir(path) { this.change({ op: 'mkdir', path }, null); }
  removePath(path) { this.change({ op: 'delete', path }, null); }

  // ---- processes ----
  procList() { return [...this.procs.values()].filter((p) => !p.exited).map((p) => ({ pid: p.pid, path: p.path, name: p.name, kind: p.kind })); }
  announceProcs() {
    const list = this.procList();
    for (const p of this.procs.values()) if (!p.exited) p.worker.postMessage({ t: 'procs', list, nextPid: this.nextPid });
    this.emit({ t: 'procs' });
  }

  spawn(o) {
    let pid = o.pid && !this.procs.has(o.pid) ? o.pid : this.nextPid;
    while (this.procs.has(pid)) pid++;
    this.nextPid = Math.max(this.nextPid, pid + 1);
    let worker;
    try { worker = new Worker('worker.js'); } catch (e) {
      this.log('The preview needs a web server (Web Workers do not run from file://). Try: python3 -m http.server\n', 'bad');
      return null;
    }
    const proc = { pid, name: o.name, title: o.title || o.name, path: o.path, kind: o.kind, appId: o.appId || null, worker, exited: false, started: false, line: '' };
    this.procs.set(pid, proc);
    worker.onmessage = (e) => this.fromWorker(proc, e.data);
    worker.onerror = (e) => {
      if (proc.kind === 'project' && this.opts.onProjectMessage) this.opts.onProjectMessage({ t: 'workerError', message: e.message || String(e) });
      else this.log('[' + proc.name + '] preview error: ' + (e.message || e) + '\n', 'bad');
      this.ended(proc);
    };
    this.desktop.setPending(pid, 'Starting ' + proc.title + '…');
    const s = this.opts.screen();
    worker.postMessage({
      t: 'run', files: o.files, name: o.name, args: o.args || [], screen: s, httpProxy: this.opts.httpProxy || '',
      fs: this.fs.snapshot(), argv0: o.path, pid, mem: o.mem, runnables: this.runnables(), procs: this.procList(), nextPid: this.nextPid,
    });
    this.announceProcs();
    return proc;
  }

  kill(pid) {
    const p = this.procs.get(pid);
    if (!p) return;
    p.worker.terminate();
    this.ended(p);
  }
  // ask a program to stop (its cleanup callback runs), then end it
  stop(pid) {
    const p = this.procs.get(pid);
    if (!p || p.exited) return;
    p.worker.postMessage({ t: 'stop' });
    setTimeout(() => { if (this.procs.get(pid) === p && !p.exited) { this.log('[' + p.name + '] force-terminated\n', 'bad'); this.kill(pid); } }, 1500);
  }
  ended(p) {
    if (p.exited && !this.procs.has(p.pid)) return;
    p.exited = true;
    this.procs.delete(p.pid);
    if (this.project === p) this.project = null;
    if (this.gfxOwner === p.pid) { this.gfxOwner = 0; this.desktop.message({ t: 'gfxRelease' }); }
    this.desktop.setPending(p.pid, null);
    this.desktop.removeProcessWindows(p.pid);
    this.announceProcs();
  }

  // the project: one at a time
  runProject(o) {
    if (this.project) this.kill(this.project.pid);
    const fs = this.fs;
    if (this.projectName && this.projectName !== o.name && !this.catalog.some((a) => a.run === this.projectName)) {
      fs.remove('0:/programs/' + this.projectName);
      fs.remove('0:/programs/' + this.projectName + '.run');
    }
    this.projectName = o.name;
    // the project is installed like mosWM installs a package: NAME.run plus
    // its resources under 0:/programs/NAME/
    if (!this.catalog.some((a) => a.run === o.name)) fs.remove('0:/programs/' + o.name);
    fs.write(this.projectPath(), runStub(o.name));
    for (const r of o.resources || []) fs.write('0:/programs/' + o.name + '/' + r.path, r.data);
    fs.emit({ op: 'reset' });
    const proc = this.spawn({ kind: 'project', name: o.name, path: this.projectPath(), files: o.files, args: o.args, pid: o.pid, mem: o.mem });
    this.project = proc;
    return proc;
  }

  async launchApp(id, args, pid) {
    const a = this.app(id);
    if (!a) return null;
    this.desktop.setPending('load:' + id, 'Loading ' + a.title + '…');
    let files;
    try { files = await this.loadApp(id); }
    catch (e) { this.log('Could not load ' + a.title + ': ' + e.message + '\n', 'bad'); return null; }
    finally { this.desktop.setPending('load:' + id, null); }
    const fs = this.fs;
    const sources = {};
    for (const [p, f] of Object.entries(files)) {
      if (/\.(c|h|cpp|cc|cxx|hpp|hh)$/i.test(p)) sources[p] = f;
      else if (!fs.get('0:/programs/' + a.run + '/' + p)) fs.write('0:/programs/' + a.run + '/' + p, typeof f === 'string' ? enc.encode(f) : b64bytes(f.b64));
    }
    for (const [p, t] of Object.entries(a.seed || {})) if (!fs.get(p)) fs.write(p, t, { user: true });
    fs.emit({ op: 'reset' });
    this.log('$ run ' + this.appPath(a) + (args && args.length ? ' ' + args.join(' ') : '') + '\n', 'sys');
    return this.spawn({ kind: 'app', appId: id, name: a.run, title: a.title, path: this.appPath(a), files: sources, args: args || [], mem: a.mem, pid });
  }

  // a program ran SYS_EXEC
  exec(from, m) {
    const a = this.catalog.find((x) => this.appPath(x) === m.path);
    if (a) { this.launchApp(a.id, m.args, m.pid); return; }
    if (this.projectName && m.path === this.projectPath() && this.opts.onRunProject) { this.opts.onRunProject(m.args); return; }
    this.log('[' + from.name + '] cannot run ' + m.path + ' in the preview\n', 'bad');
  }

  log(text, cls) { if (this.opts.log) this.opts.log(text, cls); }

  // ---- messages ----
  gid(proc, id) { return id ? proc.pid * WIN_PER_PROC + id : 0; }
  owner(gid) { return typeof gid === 'number' && gid ? this.procs.get(Math.floor(gid / WIN_PER_PROC)) : null; }

  fromWorker(proc, m) {
    if (proc.exited) return;
    const d = this.desktop;
    switch (m.t) {
      case 'win': d.message({ t: 'win', info: Object.assign({}, m.info, { id: this.gid(proc, m.info.id), parent: this.gid(proc, m.info.parent) }) }); return;
      case 'winClose': d.message({ t: 'winClose', id: this.gid(proc, m.id) }); return;
      case 'frame': d.message({ t: 'frame', id: this.gid(proc, m.id), w: m.w, h: m.h, buf: m.buf }); return;
      case 'gfx': this.gfxOwner = proc.pid; d.message(m); return;
      case 'gfxRelease': if (this.gfxOwner === proc.pid) { this.gfxOwner = 0; d.message(m); } return;
      case 'fsw': this.change(m, proc); return;
      case 'exec': this.exec(proc, m); return;
      case 'started': d.setPending(proc.pid, null); proc.started = true; break;
      case 'compileError': case 'exit': d.setPending(proc.pid, null); break;
    }
    if (proc.kind === 'project') {
      if (m.t === 'termClear') { d.message(m); return; }
      if (this.opts.onProjectMessage) this.opts.onProjectMessage(m);
      if (m.t === 'exit' || m.t === 'compileError') setTimeout(() => { proc.worker.terminate(); this.ended(proc); }, 50);
      return;
    }
    // an app: its output goes to the Output tab, a line at a time
    const tag = '[' + proc.name + '] ';
    switch (m.t) {
      case 'started': this.log(tag + 'started (compiled in ' + m.compileMs + ' ms)\n', 'sys'); break;
      case 'out': {
        const parts = (proc.line + m.text).split('\n');
        proc.line = parts.pop();
        if (proc.line.length > 2000) { parts.push(proc.line); proc.line = ''; }
        for (const l of parts) this.log(tag + l + '\n');
        break;
      }
      case 'netError': this.log(tag + 'networking error: ' + m.message + '\n', 'bad'); break;
      case 'compileError':
        this.log(tag + 'could not be compiled: ' + (m.error.file ? m.error.file + ':' + m.error.line + ': ' : '') + m.error.message + '\n', 'bad');
        proc.worker.terminate(); this.ended(proc);
        break;
      case 'exit':
        if (proc.line) { this.log(tag + proc.line + '\n'); proc.line = ''; }
        if (m.crash) this.log(tag + 'crashed! Code 0x' + m.code.toString(16) + ': ' + m.crash + '\n', 'bad');
        else this.log(tag + 'exited with code ' + m.code + '\n', m.code ? 'bad' : 'sys');
        setTimeout(() => { proc.worker.terminate(); this.ended(proc); }, 50);
        break;
    }
  }

  fromDesktop(m) {
    switch (m.t) {
      case 'wmFocus':
        for (const p of this.procs.values()) if (!p.exited) p.worker.postMessage({ t: 'wmFocus', id: this.owner(m.id) === p ? m.id % WIN_PER_PROC : 0 });
        return;
      case 'wmBounds': case 'wmFlags': case 'wmEvent': {
        const p = this.owner(m.id);
        if (p && !p.exited) p.worker.postMessage(Object.assign({}, m, { id: m.id % WIN_PER_PROC }));
        return;
      }
      case 'input': {
        // raw input goes to the program on the screen, the one with the
        // focused window, or else the project (a terminal program)
        const p = this.procs.get(this.gfxOwner) || this.owner(this.desktop.focused) || this.project;
        if (p && !p.exited) p.worker.postMessage(m);
        return;
      }
    }
  }

  post(pid, m) { const p = this.procs.get(pid); if (p && !p.exited) p.worker.postMessage(m); }
  setScreen(w, h) { this.desktop.setScreen(w, h); }
}

// a placeholder for a .run file in the preview's file system: programs see
// that it exists; the preview builds the real program from source
function runStub(name) { return enc.encode('MINIRUN1\0Studio preview: ' + name + '\n'); }
function b64bytes(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

window.StudioSystem = { PreviewSystem, iconSvg, ICON_COLORS, DB, HOME };
})();
