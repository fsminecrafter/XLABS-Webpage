/*
 * Minimal-OS Studio preview worker.
 *
 * Compiles the project with mcc's JavaScript back end and runs it against a
 * small emulation of the Minimal-OS kernel: the syscall numbers, request
 * structures and window-manager rules are the ones in the SDK's syscall.h
 * and the kernel's window_manager.c. The page (desktop.js) plays mosWM: it
 * draws the windows and turns mouse and keyboard input into window events.
 */
/* global MCC */
'use strict';
importScripts('mcc-front.js', 'mcc-cpp.js', 'sdk.js', 'mcc-js.js', 'fgpu.js');

const MEM_SIZE = 96 * 1024 * 1024;
const STACK_SIZE = 2 * 1024 * 1024;
const SUSPEND = Symbol('suspend');
const U64 = (v) => BigInt.asUintN(64, BigInt(v));
const OK = 0n;
const ERR = { GENERIC: U64(-1), BADFD: U64(-2), NOTFOUND: U64(-3), INVAL: U64(-4), PERM: U64(-5), BUSY: U64(-6), AGAIN: U64(-7) };
const FONT = Uint8Array.from(atob('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGDw8GBgAGAA2NgAAAAAAADY2fzZ/NjYADD4DHjAfDAAAYzMYDGZjABw2HG47M24ABgYDAAAAAAAYDAYGBgwYAAYMGBgYDAYAAGY8/zxmAAAADAw/DAwAAAAAAAAADAwGAAAAPwAAAAAAAAAAAAwMAGAwGAwGAwEAPmNze29nPgAMDgwMDAw/AB4zMBwGMz8AHjMwHDAzHgA4PDYzfzB4AD8DHzAwMx4AHAYDHzMzHgA/MzAYDAwMAB4zMx4zMx4AHjMzPjAYDgAADAwAAAwMAAAMDAAADAwGGAwGAwYMGAAAAD8AAD8AAAYMGDAYDAYAHjMwGAwADAA+Y3t7ewMeAAweMzM/MzMAP2ZmPmZmPwA8ZgMDA2Y8AB82ZmZmNh8Af0YWHhZGfwB/RhYeFgYPADxmAwNzZnwAMzMzPzMzMwAeDAwMDAweAHgwMDAzMx4AZ2Y2HjZmZwAPBgYGRmZ/AGN3f39rY2MAY2dve3NjYwAcNmNjYzYcAD9mZj4GBg8AHjMzMzseOAA/ZmY+NmZnAB4zBw44Mx4APy0MDAwMHgAzMzMzMzM/ADMzMzMzHgwAY2Nja393YwBjYzYcHDZjADMzMx4MDB4Af2MxGExmfwAeBgYGBgYeAAMGDBgwYEAAHhgYGBgYHgAIHDZjAAAAAAAAAAAAAAD/DAwYAAAAAAAAAB4wPjNuAAcGBj5mZjsAAAAeMwMzHgA4MDA+MzNuAAAAHjM/Ax4AHDYGDwYGDwAAAG4zMz4wHwcGNm5mZmcADAAODAwMHgAwADAwMDMzHgcGZjYeNmcADgwMDAwMHgAAADN/f2tjAAAAHzMzMzMAAAAeMzMzHgAAADtmZj4GDwAAbjMzPjB4AAA7bmYGDwAAAD4DHjAfAAgMPgwMLBgAAAAzMzMzbgAAADMzMx4MAAAAY2t/fzYAAABjNhw2YwAAADMzMz4wHwAAPxkMJj8AOAwMBwwMOAAYGBgAGBgYAAcMDDgMDAcAbjsAAAAAAAAAAAAAAAAAAA=='), c => c.charCodeAt(0));

// ---------------------------------------------------------------------
//  Memory
// ---------------------------------------------------------------------
let buffer, I8, U8, I16, U16, I32, U32, BI64, BU64, F32, F64;
function newMemory() {
  buffer = new ArrayBuffer(MEM_SIZE);
  I8 = new Int8Array(buffer); U8 = new Uint8Array(buffer);
  I16 = new Int16Array(buffer); U16 = new Uint16Array(buffer);
  I32 = new Int32Array(buffer); U32 = new Uint32Array(buffer);
  BI64 = new BigInt64Array(buffer); BU64 = new BigUint64Array(buffer);
  F32 = new Float32Array(buffer); F64 = new Float64Array(buffer);
}
const $lp = (a) => { const i = a >>> 2; return U32[i] + U32[i + 1] * 4294967296; };
const $sp = (a, v) => { const i = a >>> 2; U32[i] = v >>> 0; U32[i + 1] = Math.floor(v / 4294967296) >>> 0; return v; };

class Trap extends Error { constructor(msg) { super(msg); this.trap = true; } }
class Exit { constructor(code) { this.code = code; } }
const $trap = (msg) => { throw new Trap(msg); };
function checkRange(a, n) {
  if (!(a >= 0x1000 && a + n <= MEM_SIZE)) throw new Trap('Memory page fault (address 0x' + Math.max(0, a).toString(16) + ')');
}
const $memcpy = (d, s, n) => { n = Number(n); if (n) { checkRange(d, n); checkRange(s, n); U8.copyWithin(d, s, s + n); } return d; };
const $memmove = $memcpy;
const $memset = (d, v, n) => { n = Number(n); if (n) { checkRange(d, n); U8.fill(v & 255, d, d + n); } return d; };
const $memcmp = (a, b, n) => { for (let i = 0; i < n; i++) { const x = U8[a + i], y = U8[b + i]; if (x !== y) return x - y; } return 0; };
const divz = () => { throw new Trap('Divide error (division by zero)'); };
const rt = {
  $lp, $sp, $memcpy, $memset, $memmove, $memcmp, $trap, $SUSPEND: SUSPEND,
  $f2l: (x) => Number.isFinite(x) ? BigInt.asIntN(64, BigInt(Math.trunc(x))) : -9223372036854775808n,
  $f2ul: (x) => Number.isFinite(x) ? BigInt.asUintN(64, BigInt(Math.trunc(x))) : 9223372036854775808n,
  $i2p: (x) => typeof x === 'bigint' ? Number(BigInt.asUintN(64, x)) : (x < 0 ? x + 18446744073709551616 : x),
  $divi: (a, b) => b === 0 ? divz() : (a / b) | 0,
  $divu: (a, b) => b === 0 ? divz() : (a / b) >>> 0,
  $modi: (a, b) => b === 0 ? divz() : (a % b) | 0,
  $modu: (a, b) => b === 0 ? divz() : (a % b) >>> 0,
  $divl: (a, b) => b === 0n ? divz() : BigInt.asIntN(64, a / b),
  $modl: (a, b) => b === 0n ? divz() : a % b,
  $call: (i) => { const f = rt.$F[i]; if (typeof f !== 'function') throw new Trap('Call through an invalid function pointer (' + i + ')'); return f; },
  $sys: (n, a, b, c) => kernel.syscall(Number(n), a, b, c),
};

const str = (a, max) => {
  if (!a) return null;
  let e = a; const lim = a + (max || 4096);
  while (e < lim && U8[e]) e++;
  return new TextDecoder().decode(U8.subarray(a, e));
};
const writeStr = (a, s, size) => {
  const b = new TextEncoder().encode(s);
  const n = Math.min(b.length, size - 1);
  U8.set(b.subarray(0, n), a); U8[a + n] = 0;
};

// ---------------------------------------------------------------------
//  Structure layouts, taken from the SDK's syscall.h by mcc itself
// ---------------------------------------------------------------------
const L = (function () {
  const out = {};
  // x86_64/syscall.h carries the input-event structures; syscall.h wins for
  // the rest; fgpu_abi.h has the SYS_GPU ones
  for (const header of ['x86_64/syscall.h', 'syscall.h', 'fgpu_abi.h']) {
    const src = new MCC.Preprocessor({ 'layout.c': '#include "' + header + '"\n' }, MCC.SDK).run('layout.c');
    const p = new MCC.Parser(src);
    p.program();
    for (const [name, v] of p.scopes[0].vars) {
      if (!v.typedef || !v.type.members) continue;
      const m = {};
      for (const mem of v.type.members) m[mem.name] = { off: mem.offset, ty: mem.type };
      m.$size = v.type.size;
      out[name] = m;
    }
  }
  return out;
})();
function rd(base, f) {
  const a = base + f.off, t = f.ty;
  if (t.kind === 'ptr') return $lp(a);
  if (t.kind === 'array') return a;
  switch (t.size) {
    case 1: return t.unsigned ? U8[a] : I8[a];
    case 2: return t.unsigned ? U16[a >> 1] : I16[a >> 1];
    case 4: return t.unsigned ? U32[a >> 2] : I32[a >> 2];
    case 8: return Number(t.unsigned ? BU64[a >> 3] : BI64[a >> 3]);
  }
}
function wr(base, f, v) {
  const a = base + f.off, t = f.ty;
  if (t.kind === 'ptr') { $sp(a, v); return; }
  switch (t.size) {
    case 1: U8[a] = v; return;
    case 2: U16[a >> 1] = v; return;
    case 4: U32[a >> 2] = v >>> 0; return;
    case 8: BU64[a >> 3] = U64(v); return;
  }
}

// ---------------------------------------------------------------------
//  Heap (SYS_HEAP)
// ---------------------------------------------------------------------
class Heap {
  constructor(start, end) {
    this.free = [[start, end - start]];   // sorted [addr, size]
    this.used = new Map();
    this.bytes = 0;
  }
  alloc(n) {
    n = Math.max(16, Math.ceil(n / 16) * 16);
    for (let i = 0; i < this.free.length; i++) {
      const [a, s] = this.free[i];
      if (s < n) continue;
      if (s === n) this.free.splice(i, 1); else this.free[i] = [a + n, s - n];
      this.used.set(a, n);
      this.bytes += n;
      U8.fill(0, a, a + n);
      return a;
    }
    return 0;
  }
  release(a) {
    const n = this.used.get(a);
    if (n === undefined) return false;
    this.used.delete(a);
    this.bytes -= n;
    let lo = 0, hi = this.free.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.free[mid][0] < a) lo = mid + 1; else hi = mid; }
    this.free.splice(lo, 0, [a, n]);
    if (lo + 1 < this.free.length && this.free[lo][0] + this.free[lo][1] === this.free[lo + 1][0]) {
      this.free[lo][1] += this.free[lo + 1][1]; this.free.splice(lo + 1, 1);
    }
    if (lo > 0 && this.free[lo - 1][0] + this.free[lo - 1][1] === this.free[lo][0]) {
      this.free[lo - 1][1] += this.free[lo][1]; this.free.splice(lo, 1);
    }
    return true;
  }
  size(a) { return this.used.get(a); }
}

// ---------------------------------------------------------------------
//  MinimaFS (in memory)
// ---------------------------------------------------------------------
class FS {
  constructor() { this.nodes = new Map(); this.mkdir('0:/'); }
  norm(p) {
    p = String(p || '').replace(/\\/g, '/');
    if (!/^\d+:/.test(p)) p = '0:/programs/' + p;
    const m = /^(\d+):\/?(.*)$/.exec(p);
    const parts = [];
    for (const s of m[2].split('/')) { if (!s || s === '.') continue; if (s === '..') parts.pop(); else parts.push(s); }
    return m[1] + ':/' + parts.join('/');
  }
  parent(p) { const i = p.lastIndexOf('/'); return i <= 2 ? p.slice(0, 3) : p.slice(0, i); }
  mkdir(p) { p = this.norm(p); if (!this.nodes.has(p)) this.nodes.set(p, { dir: true, created: new Date() }); return p; }
  mkdirs(p) { p = this.norm(p); const segs = p.slice(3).split('/').filter(Boolean); let cur = p.slice(0, 3); this.mkdir(cur); for (const s of segs) { cur = cur.length > 3 ? cur + '/' + s : cur + s; this.mkdir(cur); } }
  write(p, data) {
    p = this.norm(p);
    this.mkdirs(this.parent(p));
    this.nodes.set(p, { dir: false, data: data instanceof Uint8Array ? data : new TextEncoder().encode(data), created: new Date(), changed: new Date(), runnable: /\.run$/.test(p) });
  }
  get(p) { return this.nodes.get(this.norm(p)); }
  list(p) {
    p = this.norm(p);
    const pre = p.length > 3 ? p + '/' : p;
    const out = [];
    for (const [k, v] of this.nodes) {
      if (k === p || !k.startsWith(pre)) continue;
      const rest = k.slice(pre.length);
      if (rest && !rest.includes('/')) out.push({ name: rest, node: v });
    }
    return out.sort((a, b) => (b.node.dir - a.node.dir) || a.name.localeCompare(b.name));
  }
}

// ---------------------------------------------------------------------
//  HID usage codes -> ASCII (US layout, as the kernel's default layout)
// ---------------------------------------------------------------------
const HID_PLAIN = { 30: '1', 31: '2', 32: '3', 33: '4', 34: '5', 35: '6', 36: '7', 37: '8', 38: '9', 39: '0', 40: '\n', 42: '\b', 43: '\t', 44: ' ', 45: '-', 46: '=', 47: '[', 48: ']', 49: '\\', 51: ';', 52: "'", 53: '`', 54: ',', 55: '.', 56: '/' };
const HID_SHIFT = { 30: '!', 31: '@', 32: '#', 33: '$', 34: '%', 35: '^', 36: '&', 37: '*', 38: '(', 39: ')', 45: '_', 46: '+', 47: '{', 48: '}', 49: '|', 51: ':', 52: '"', 53: '~', 54: '<', 55: '>', 56: '?' };
function hidToAscii(key, usbMods) {
  const shift = (usbMods & (2 | 32)) !== 0;
  if (key >= 4 && key <= 29) return (shift ? 65 : 97) + key - 4;
  const ch = (shift && HID_SHIFT[key]) || HID_PLAIN[key];
  return ch ? ch.charCodeAt(0) : 0;
}

// ---------------------------------------------------------------------
//  The kernel
// ---------------------------------------------------------------------
const WINDOW_MIN_W = 64, WINDOW_MIN_H = 48, MAX_WINDOWS = 64, MAX_EVENTS = 16;
const WF = { VISIBLE: 1, RESIZABLE: 2, FULLSCREEN: 4, MAXIMIZED: 8, MINIMIZED: 16, FOCUSED: 32 };
const EV = { RESIZED: 1, CLOSE_REQUEST: 2, MINIMIZED: 3, MAXIMIZED: 4, RESTORED: 5, FOCUS_GAINED: 6, FOCUS_LOST: 7, KEY: 8, MOUSE: 9, MOUSE_WHEEL: 10 };
const DEFAULT_STYLE = { title_bar: 0xFF24343C, title_text: 0xFFFFFFFF, close_button: 0xFFE35D6A, minimize_button: 0xFFE8B34C, maximize_button: 0xFF4ABF8A, close_icon: 0xFFFFFFFF, minimize_icon: 0xFF17262C, maximize_icon: 0xFF17262C, border: 0xFF49616B, content_background: 0xFF17232A };
const STYLE_KEYS = Object.keys(DEFAULT_STYLE);
const PID = 12;

const kernel = {
  syscall() { return OK; }
};

let state = null;   // per-run state

function post(msg, transfer) { postMessage(msg, transfer || []); }

function resetState(opts) {
  newMemory();
  const fs = new FS();
  for (const d of ['0:/etc', '0:/programs', '0:/services', '0:/users']) fs.mkdir(d);
  fs.write('0:/etc/motd.txt', 'Welcome to Minimal-OS.\n');
  fs.write('0:/etc/minimaSSL.slib', new Uint8Array(16));
  const app = opts.name || 'app';
  fs.write('0:/programs/' + app + '.run', new Uint8Array(64));
  for (const f of opts.resources || []) fs.write('0:/programs/' + app + '/' + f.path, f.data);
  // files the installed system has, such as mosWM's fonts (absolute paths)
  for (const f of opts.system || []) fs.write(f.path, f.data);
  state = {
    fs, app, start: performance.now(), screen: opts.screen || { w: 1280, h: 720 },
    heap: null, windows: new Map(), nextWindowId: 1, focused: 0, handles: new Map(), nextHandle: 3,
    input: [], mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0 }, pressed: new Set(),
    fb: null, fbDirty: false, fbOwned: false, dirty: new Set(), lastFlush: 0, slice: performance.now(),
    resume: undefined, wait: null, cleanup: 0, exited: false, timer: 0, waitingInput: null,
    outBuf: '',
  };
  state.gpu = FGPU.create(gpuEnv);
}

function uptime() { return Math.floor(performance.now() - state.start); }

// ---- GPU (SYS_GPU): fgpu.js, a port of the kernel's FGPU ----
const gpuEnv = {
  mem: () => ({ U8, U32 }), L, rd, wr, writeStr, ERR, OK, memSize: MEM_SIZE,
  screen: () => state.screen,
  log: (m) => console.warn(m),
  // what the kernel does with SYS_WINDOW_PRESENT for the window's owner
  presentWindow(id, s) {
    const w = state.windows.get(id);
    if (!w) return ERR.NOTFOUND;
    if (s.width < w.w || s.height < w.h) return ERR.INVAL;
    for (let y = 0; y < w.h; y++) w.pixels.set(s.mem.subarray(y * s.pitch, y * s.pitch + w.w), y * w.w);
    w.version++;
    state.dirty.add(id);
    return OK;
  },
  // the screen: only after the program acquired the framebuffer
  presentScreen(s, x, y) {
    if (!state.fbOwned) return ERR.PERM;
    const f = fb(), W = state.screen.w, H = state.screen.h;
    for (let r = 0; r < s.height; r++) {
      const sy = y + r;
      if (sy < 0 || sy >= H) continue;
      const x0 = Math.max(0, x), x1 = Math.min(W, x + s.width);
      if (x0 >= x1) continue;
      f.set(s.mem.subarray(r * s.pitch + (x0 - x), r * s.pitch + (x1 - x)), sy * W + x0);
    }
    state.fbDirty = true;
    return OK;
  },
};

// ---- window manager (kernel side) ----
function pushEvent(w, ev) {
  ev.id = w.id;
  const coalesce = [EV.RESIZED, EV.MINIMIZED, EV.MAXIMIZED, EV.RESTORED, EV.FOCUS_GAINED, EV.FOCUS_LOST, EV.CLOSE_REQUEST];
  if (coalesce.includes(ev.type)) {
    const i = w.events.findIndex(e => e.type === ev.type);
    if (i >= 0) { w.events[i] = ev; wake(); return true; }
  }
  if (ev.type === EV.MOUSE && w.events.length) {
    const last = w.events[w.events.length - 1];
    if (last.type === EV.MOUSE && last.buttons === ev.buttons) { w.events[w.events.length - 1] = ev; wake(); return true; }
  }
  if (w.events.length >= MAX_EVENTS) return false;
  w.events.push(ev);
  wake();
  return true;
}

function winInfo(w) {
  return { id: w.id, parent: w.parent, x: w.x, y: w.y, w: w.w, h: w.h, flags: w.flags, title: w.title, style: Object.assign({}, w.style) };
}
function announce(w) { post({ t: 'win', info: winInfo(w) }); }

function resizeWindow(w, width, height) {
  if (width < WINDOW_MIN_W || height < WINDOW_MIN_H || width > 16384 || height > 16384) return ERR.INVAL;
  if (w.events.length >= MAX_EVENTS) return ERR.BUSY;
  const px = new Uint32Array(width * height);
  const cw = Math.min(width, w.w), ch = Math.min(height, w.h);
  for (let y = 0; y < ch; y++) px.set(w.pixels.subarray(y * w.w, y * w.w + cw), y * width);
  w.pixels = px; w.w = width; w.h = height;
  pushEvent(w, { type: EV.RESIZED, width, height });
  state.dirty.add(w.id);
  return OK;
}

function setFocus(w) {
  if (state.focused === w.id) return;
  const old = state.windows.get(state.focused);
  if (old) { pushEvent(old, { type: EV.FOCUS_LOST }); old.flags &= ~WF.FOCUSED; announce(old); }
  pushEvent(w, { type: EV.FOCUS_GAINED });
  w.flags |= WF.FOCUSED;
  state.focused = w.id;
  announce(w);
}

function windowSyscall(req) {
  const R = L.syscall_window_request_t;
  if (rd(req, R.size) !== R.$size || rd(req, R.version) !== 1) return ERR.INVAL;
  const op = rd(req, R.op);
  if (op === 13) return ERR.PERM;                      // REGISTER_MANAGER: only the installed mosWM
  const titleAt = rd(req, R.title);
  const titleOk = () => { for (let i = 0; i < 64; i++) if (!U8[titleAt + i]) return true; return false; };
  if (op === 1) {                                      // CREATE
    const x = rd(req, R.x), y = rd(req, R.y), w = rd(req, R.width), h = rd(req, R.height), flags = rd(req, R.flags);
    const parent = rd(req, R.parent_id);
    if (x > 32768 || y > 32768 || w < WINDOW_MIN_W || h < WINDOW_MIN_H || w > 16384 || h > 16384 ||
        (flags & ~(WF.VISIBLE | WF.RESIZABLE | WF.FULLSCREEN | WF.MAXIMIZED | WF.MINIMIZED)) ||
        ((flags & WF.FULLSCREEN) && (flags & WF.MAXIMIZED)) || !titleOk()) return ERR.INVAL;
    if (parent && !state.windows.has(parent)) return ERR.NOTFOUND;
    if (state.windows.size >= MAX_WINDOWS) return ERR.GENERIC;
    while (state.windows.has(state.nextWindowId)) state.nextWindowId = (state.nextWindowId % MAX_WINDOWS) + 1;
    const id = state.nextWindowId;
    state.nextWindowId = (state.nextWindowId % MAX_WINDOWS) + 1;
    const title = str(titleAt, 64) || '';
    const win = { id, parent, x, y, w, h, flags, title, style: Object.assign({}, DEFAULT_STYLE), events: [], pixels: new Uint32Array(w * h), version: 0 };
    state.windows.set(id, win);
    announce(win);
    return BigInt(id);
  }
  const id = rd(req, R.id);
  const w = state.windows.get(id);
  if (op !== 9 && !w) return ERR.NOTFOUND;
  switch (op) {
    case 2:                                            // CLOSE
      state.windows.delete(id);
      if (state.focused === id) state.focused = 0;
      state.dirty.delete(id);
      post({ t: 'winClose', id });
      return OK;
    case 3: {                                          // SET_BOUNDS
      if (!(w.flags & WF.RESIZABLE)) return ERR.PERM;
      const x = rd(req, R.x), y = rd(req, R.y), nw = rd(req, R.width), nh = rd(req, R.height);
      if (x > 32768 || y > 32768) return ERR.INVAL;
      if (nw !== w.w || nh !== w.h) { const r = resizeWindow(w, nw, nh); if (r !== OK) return r; }
      w.x = x; w.y = y;
      announce(w);
      return OK;
    }
    case 4:                                            // SET_TITLE
      if (!titleOk()) return ERR.INVAL;
      w.title = str(titleAt, 64) || '';
      announce(w);
      return OK;
    case 5: {                                          // SET_FLAGS
      const flags = rd(req, R.flags);
      if ((flags & ~63) || (flags & WF.FOCUSED) || ((flags & WF.FULLSCREEN) && (flags & WF.MAXIMIZED))) return ERR.INVAL;
      w.flags = flags | (w.flags & WF.FOCUSED);
      announce(w);
      return OK;
    }
    case 6: {                                          // SET_STYLE
      const S = L.syscall_window_style_t, base = req + R.style.off;
      for (const k of STYLE_KEYS) w.style[k] = rd(base, S[k]);
      announce(w);
      return OK;
    }
    case 7: {                                          // PRESENT
      const px = rd(req, R.pixels), pitch = rd(req, R.pitch);
      const x = rd(req, R.x), y = rd(req, R.y), pw = rd(req, R.width), ph = rd(req, R.height);
      if (!px || !pw || !ph || x > w.w || y > w.h || pw > w.w - x || ph > w.h - y || pitch < w.w * 4 || pitch > 64 * 1024 * 1024) return ERR.INVAL;
      if (px + (y + ph - 1) * pitch + (x + pw) * 4 > MEM_SIZE || px < 0x1000) throw new Trap('Memory page fault (mos_window_present pixels)');
      if ((px & 3) === 0 && (pitch & 3) === 0) {
        for (let r = y; r < y + ph; r++) {
          const s = (px + r * pitch) / 4 + x;
          w.pixels.set(U32.subarray(s, s + pw), r * w.w + x);
        }
      } else {
        const dv = new DataView(buffer);
        for (let r = y; r < y + ph; r++) for (let c = x; c < x + pw; c++) w.pixels[r * w.w + c] = dv.getUint32(px + r * pitch + c * 4, true);
      }
      w.version++;
      state.dirty.add(id);
      return OK;
    }
    case 8: {                                          // GET_INFO
      const info = rd(req, R.info);
      if (!info) return ERR.INVAL;
      writeInfo(info, w);
      return OK;
    }
    case 9: {                                          // LIST
      const out = rd(req, R.windows), cap = rd(req, R.capacity);
      let n = 0;
      for (const win of state.windows.values()) {
        if (out && n < cap) writeInfo(out + n * L.syscall_window_info_t.$size, win);
        n++;
      }
      return BigInt(Math.min(n, cap || n));
    }
    case 10: return ERR.PERM;                          // GET_FRAME: window manager only
    case 11: {                                         // NEXT_EVENT
      const evp = rd(req, R.event);
      if (!evp) return ERR.INVAL;
      const ev = w.events.shift();
      if (!ev) return ERR.AGAIN;
      const E = L.syscall_window_event_t;
      U8.fill(0, evp, evp + E.$size);
      wr(evp, E.id, id); wr(evp, E.type, ev.type);
      wr(evp, E.x, ev.x | 0); wr(evp, E.y, ev.y | 0); wr(evp, E.width, ev.width | 0); wr(evp, E.height, ev.height | 0);
      wr(evp, E.key, ev.key | 0); wr(evp, E.buttons, ev.buttons | 0); wr(evp, E.wheel, ev.wheel | 0);
      wr(evp, E.mods, ev.mods | 0); wr(evp, E.time_ms, ev.time | 0);
      return OK;
    }
    case 12: return ERR.PERM;                          // POST_EVENT: window manager only
  }
  return ERR.INVAL;
}

function writeInfo(at, w) {
  const I = L.syscall_window_info_t;
  U8.fill(0, at, at + I.$size);
  wr(at, I.id, w.id); wr(at, I.parent_id, w.parent); wr(at, I.x, w.x); wr(at, I.y, w.y);
  wr(at, I.width, w.w); wr(at, I.height, w.h); wr(at, I.flags, w.flags); wr(at, I.frame_version, w.version);
  wr(at, I.owner_pid, PID);
  writeStr(at + I.title.off, w.title, 64);
  const S = L.syscall_window_style_t, base = at + I.style.off;
  for (const k of STYLE_KEYS) wr(base, S[k], w.style[k]);
}

// ---- framebuffer graphics (SYS_GRAPHICS) ----
function fb() {
  if (!state.fb) {
    state.fb = new Uint32Array(state.screen.w * state.screen.h);
    state.fb.fill(0xFF000000);
  }
  state.fbOwned = true;
  state.fbDirty = true;
  return state.fb;
}
function px(x, y, c) {
  const W = state.screen.w, H = state.screen.h;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  state.fb[y * W + x] = c;
}
function hline(x0, x1, y, c) { if (x0 > x1) [x0, x1] = [x1, x0]; for (let x = x0; x <= x1; x++) px(x, y, c); }
function line(x0, y0, x1, y1, c) {
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1, err = dx + dy;
  for (let guard = 0; guard < 100000; guard++) {
    px(x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
function text(s, x, y, c) {
  let cx = x, cy = y;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 10) { cx = x; cy += 16; continue; }
    if (ch === 9) { cx += 32; continue; }
    const g = (ch < 128 ? ch : 0) * 8;
    for (let py = 0; py < 8; py++) { const row = FONT[g + py]; for (let pxx = 0; pxx < 8; pxx++) if (row & (1 << pxx)) px(cx + pxx, cy + py, c); }
    cx += 8;
  }
}
function graphicsSyscall(req) {
  const R = L.syscall_graphics_request_t;
  const op = rd(req, R.op);
  const A = (i) => Number(BI64[(req + R.args.off + i * 8) >> 3]);
  const rgb = (i) => (0xFF000000 | ((A(i) & 255) << 16) | ((A(i + 1) & 255) << 8) | (A(i + 2) & 255)) >>> 0;
  const W = state.screen.w, H = state.screen.h;
  switch (op) {
    case 1: return BigInt(W);
    case 2: return BigInt(H);
    case 3: fb().fill(rgb(0)); return OK;
    case 4: fb(); px(A(0), A(1), rgb(2)); return OK;
    case 5: fb(); line(A(0), A(1), A(2), A(3), rgb(4)); return OK;
    case 6: case 7: {
      fb();
      const cx = A(0), cy = A(1), r = A(2), c = rgb(3);
      if (op === 7) { for (let y = -r; y <= r; y++) { const w = Math.floor(Math.sqrt(r * r - y * y)); hline(cx - w, cx + w, cy + y, c); } }
      else { let x = r, y = 0, e = 1 - r; while (x >= y) { for (const [a, b] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]]) px(cx + a, cy + b, c); y++; if (e < 0) e += 2 * y + 1; else { x--; e += 2 * (y - x) + 1; } } }
      return OK;
    }
    case 8: case 9: {
      fb();
      const x = A(0), y = A(1), w = A(2), h = A(3), c = rgb(4);
      if (op === 9) { const x0 = Math.max(0, x), x1 = Math.min(W, x + w); for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) state.fb.fill(c, yy * W + x0, yy * W + Math.max(x0, x1)); }
      else { hline(x, x + w - 1, y, c); hline(x, x + w - 1, y + h - 1, c); for (let yy = y; yy < y + h; yy++) { px(x, yy, c); px(x + w - 1, yy, c); } }
      return OK;
    }
    case 10: case 11: {
      fb();
      const p = [[A(0), A(1)], [A(2), A(3)], [A(4), A(5)]], c = rgb(6);
      if (op === 10) { line(p[0][0], p[0][1], p[1][0], p[1][1], c); line(p[1][0], p[1][1], p[2][0], p[2][1], c); line(p[2][0], p[2][1], p[0][0], p[0][1], c); return OK; }
      p.sort((a, b) => a[1] - b[1]);
      const edge = (a, b, y) => a[1] === b[1] ? a[0] : Math.round(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]));
      for (let y = p[0][1]; y <= p[2][1]; y++) {
        const xa = edge(p[0], p[2], y), xb = y < p[1][1] ? edge(p[0], p[1], y) : edge(p[1], p[2], y);
        hline(xa, xb, y, c);
      }
      return OK;
    }
    case 12: {
      fb();
      const cx = A(0), cy = A(1), rx = A(2), ry = A(3), c = rgb(4);
      const steps = Math.max(16, (rx + ry) * 4);
      let lx = cx + rx, ly = cy;
      for (let i = 1; i <= steps; i++) { const t = i / steps * Math.PI * 2; const nx = Math.round(cx + rx * Math.cos(t)), ny = Math.round(cy + ry * Math.sin(t)); line(lx, ly, nx, ny, c); lx = nx; ly = ny; }
      return OK;
    }
    case 13: { const t = rd(req, R.text); if (!t) return ERR.INVAL; fb(); text(str(t, 65536), A(0), A(1), rgb(2)); return OK; }
    case 14: {
      const t = rd(req, R.text), ow = rd(req, R.out_width), oh = rd(req, R.out_height);
      if (!t || !ow || !oh) return ERR.INVAL;
      const lines = str(t, 65536).split('\n');
      U32[ow >> 2] = Math.max(...lines.map(l => l.length)) * 8; U32[oh >> 2] = lines.length * 16;
      return OK;
    }
    case 15: return OK;
    case 16: post({ t: 'termClear' }); return OK;
    case 17: fb(); return OK;                          // ACQUIRE
    case 18: state.fbOwned = false; post({ t: 'gfxRelease' }); return OK;
    case 19: return BigInt(state.fbOwned ? PID : 0);
    case 20: {                                         // BLIT
      const B = L.syscall_blit_request_t, b = rd(req, R.blit);
      if (!b) return ERR.INVAL;
      fb();
      const src = rd(b, B.src), sw0 = rd(b, B.src_w), pitch = rd(b, B.src_pitch);
      const sx = rd(b, B.sx), sy = rd(b, B.sy), sw = rd(b, B.sw), sh = rd(b, B.sh), dx = rd(b, B.dx), dy = rd(b, B.dy), flags = rd(b, B.flags);
      void sw0;
      for (let y = 0; y < sh; y++) {
        const ty = dy + y; if (ty < 0 || ty >= H) continue;
        for (let x = 0; x < sw; x++) {
          const tx = dx + x; if (tx < 0 || tx >= W) continue;
          const c = U32[(src + (sy + y) * pitch + (sx + x) * 4) >> 2];
          if (flags === 2) { const a = c >>> 24; if (a === 0) continue; if (a < 255) { const d = state.fb[ty * W + tx]; const m = (s, sh2) => (((s >> sh2) & 255) * a + ((d >> sh2) & 255) * (255 - a)) / 255 | 0; state.fb[ty * W + tx] = (0xFF000000 | (m(c, 16) << 16) | (m(c, 8) << 8) | m(c, 0)) >>> 0; continue; } }
          state.fb[ty * W + tx] = (c | 0xFF000000) >>> 0;
        }
      }
      return OK;
    }
    case 21: state.fbDirty = true; return OK;          // PRESENT
    case 22: {                                         // INFO
      const I = L.syscall_graphics_info_t, at = rd(req, R.info);
      if (!at) return ERR.INVAL;
      wr(at, I.size, I.$size); wr(at, I.version, 1); wr(at, I.width, W); wr(at, I.height, H); wr(at, I.pitch, W * 4);
      wr(at, I.pixel_format, 1); wr(at, I.bytes_per_pixel, 4); wr(at, I.red_position, 16); wr(at, I.red_mask_size, 8);
      wr(at, I.green_position, 8); wr(at, I.green_mask_size, 8); wr(at, I.blue_position, 0); wr(at, I.blue_mask_size, 8);
      return OK;
    }
  }
  return ERR.INVAL;
}

// ---- files ----
function fileMeta(node, path) {
  const ext = (/\.([^./]+)$/.exec(path) || [])[1] || '';
  return { type: node.dir ? 'directory' : ext === 'run' ? 'executable' : ext === 'txt' ? 'text' : 'binary', format: ext || (node.dir ? 'dir' : 'bin') };
}
function fmtDate(d) { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }

kernel.syscall = function (n, a, b, c) {
  const r = sysInner(n, a, b, c);
  // give the page a turn now and then, even if the program never sleeps
  if (r !== SUSPEND && performance.now() - state.slice > 25) { state.resume = r; state.wait = { ms: 0 }; return SUSPEND; }
  return r;
};

function sysInner(n, a, b, c) {
  const s = state;
  switch (n) {
    case 1: {                                          // WRITE
      const fd = Number(a), p = Number(b), len = Number(c);
      if (fd !== 1 && fd !== 2) return ERR.BADFD;
      if (len < 0 || p + len > MEM_SIZE) return ERR.INVAL;
      s.outBuf += new TextDecoder().decode(U8.subarray(p, p + len));
      if (s.outBuf.length > 4096) flushOut();
      return BigInt(len);
    }
    case 2: throw new Exit(Number(BigInt.asUintN(8, a)));
    case 3: return BigInt(PID);
    case 4: return BigInt(uptime());
    case 5: {                                          // SLEEP (milliseconds)
      const ms = Math.min(Number(a), 0x7fffffff);
      s.resume = OK; s.wait = { ms: Math.max(0, ms) };
      return SUSPEND;
    }
    case 6: {                                          // OPEN
      const path = str(Number(a)), node = path && s.fs.get(path);
      if (!node || node.dir) return ERR.NOTFOUND;
      const h = s.nextHandle++;
      s.handles.set(h, { path: s.fs.norm(path), node, pos: 0, write: Number(b) !== 0 });
      return BigInt(h);
    }
    case 7: case 18: {                                 // READ / FWRITE
      const h = s.handles.get(Number(a));
      if (!h) return ERR.BADFD;
      const p = Number(b), len = Number(c);
      if (n === 7) {
        const k = Math.max(0, Math.min(len, h.node.data.length - h.pos));
        U8.set(h.node.data.subarray(h.pos, h.pos + k), p);
        h.pos += k;
        return BigInt(k);
      }
      if (!h.write) return ERR.PERM;
      const need = h.pos + len;
      if (need > h.node.data.length) { const d = new Uint8Array(need); d.set(h.node.data); h.node.data = d; }
      h.node.data.set(U8.subarray(p, p + len), h.pos);
      h.pos += len; h.node.changed = new Date();
      post({ t: 'fs', path: h.path, size: h.node.data.length });
      return BigInt(len);
    }
    case 8: return s.handles.delete(Number(a)) ? OK : ERR.BADFD;
    case 9: return s.fs.get(str(Number(a))) ? 1n : 0n;
    case 10: { const nd = s.fs.get(str(Number(a))); return nd && nd.dir ? 1n : 0n; }
    case 11: {                                         // GETTIME -> datetime_t
      const p = Number(a); if (!p) return ERR.INVAL;
      const d = new Date();
      U16[p >> 1] = d.getFullYear(); U8[p + 2] = d.getMonth() + 1; U8[p + 3] = d.getDate();
      U8[p + 4] = d.getHours(); U8[p + 5] = d.getMinutes(); U8[p + 6] = d.getSeconds();
      return OK;
    }
    case 12: { const h = s.handles.get(Number(a)); if (!h) return ERR.BADFD; h.pos = Math.max(0, Math.min(Number(b), h.node.data.length)); return OK; }
    case 13: { const h = s.handles.get(Number(a)); return h ? BigInt(h.node.data.length) : ERR.BADFD; }
    case 14: { const p = str(Number(a)); if (!p) return ERR.INVAL; if (s.fs.get(p)) return ERR.GENERIC; if (!s.fs.get(s.fs.parent(s.fs.norm(p)))) return ERR.NOTFOUND; s.fs.mkdir(p); return OK; }
    case 15: return graphicsSyscall(Number(a));
    case 16: return OK;                                // MANAGER
    case 17: {                                         // USB
      switch (Number(a)) {
        case 1: case 2: return OK;
        case 3: return 1n;
        case 4: return BigInt(hidToAscii(Number(b) & 255, Number(c) & 255));
        case 5: return s.pressed.has(Number(b) & 255) ? 1n : 0n;
        case 6: {
          const I = L.syscall_usb_keyboard_info_t, at = Number(b); if (!at) return ERR.INVAL;
          wr(at, I.address, 1); wr(at, I.port, 1); wr(at, I.state, 1); wr(at, I.vendor_id, 0x0627); wr(at, I.product_id, 0x0001); wr(at, I.class_code, 3); wr(at, I.is_keyboard, 1);
          return OK;
        }
      }
      return ERR.INVAL;
    }
    case 19: {                                         // LISTDIR
      const path = str(Number(a)), nd = path && s.fs.get(path);
      if (!nd) return ERR.NOTFOUND;
      if (!nd.dir) return ERR.INVAL;
      const D = L.syscall_dirent_t, out = Number(b), max = Number(c);
      const list = s.fs.list(path).slice(0, max);
      list.forEach((e, i) => {
        const at = out + i * D.$size;
        U8.fill(0, at, at + D.$size);
        writeStr(at + D.name.off, e.name, 64);
        wr(at, D.type, e.node.dir ? 1 : /\.run$/.test(e.name) ? 2 : 0);
      });
      return BigInt(list.length);
    }
    case 20: case 21: {                                // DELETE / RMDIR
      const p = s.fs.norm(str(Number(a)) || ''), nd = s.fs.nodes.get(p);
      if (!nd) return ERR.NOTFOUND;
      if (n === 21 && (!nd.dir || s.fs.list(p).length)) return ERR.INVAL;
      if (n === 20 && nd.dir) return ERR.INVAL;
      s.fs.nodes.delete(p);
      return OK;
    }
    case 22: {                                         // GET_METADATA
      const p = str(Number(a)), nd = p && s.fs.get(p), out = Number(b);
      if (!nd) return ERR.NOTFOUND;
      if (!out) return ERR.INVAL;
      const M = L.syscall_file_metadata_t, m = fileMeta(nd, p);
      U8.fill(0, out, out + M.$size);
      writeStr(out + M.filetype.off, m.type, 64); writeStr(out + M.fileformat.off, m.format, 16);
      wr(out, M.data_length, nd.dir ? 0 : nd.data.length); wr(out, M.runnable, nd.runnable ? 1 : 0);
      writeStr(out + M.created_date.off, fmtDate(nd.created), 32); writeStr(out + M.last_changed.off, fmtDate(nd.changed || nd.created), 32);
      return OK;
    }
    case 23: { const h = s.handles.get(Number(a)); return h ? BigInt(h.pos) : ERR.BADFD; }
    case 24: { const h = s.handles.get(Number(a)); return h ? (h.pos >= h.node.data.length ? 1n : 0n) : ERR.BADFD; }
    case 25: return ERR.GENERIC;                       // PKG: not available in the preview
    case 26: {                                         // SYSINFO
      const op = Number(a);
      const used = s.heap ? s.heap.bytes : 0;
      const total = 1024 * 1024 * 1024;
      const vals = { 1: 7 + Math.floor(Math.random() * 6), 2: total, 3: 180 * 1024 * 1024 + used, 4: total - 180 * 1024 * 1024 - used, 5: uptime(), 6: 9, 7: 4, 8: 24 * 1024 * 1024 + used, 9: 40 * 1024 * 1024 - used, 10: 46080, 11: 216064 };
      if (op >= 0x10) return op - 0x10 < 4 ? BigInt(3 + ((op * 7) % 11)) : ERR.INVAL;
      return vals[op] !== undefined ? BigInt(vals[op]) : ERR.INVAL;
    }
    case 27: {                                         // PSLIST
      const P = L.syscall_process_info_t, out = Number(a), max = Number(b);
      const procs = [[1, 'kernel', 1, 0], [2, 'terminal', 2, 0], [3, 'keyboard', 2, 0], [4, 'audio', 2, 0], [5, 'services', 2, 0], [8, 'mosWM', 1, 1], [PID, '0:/programs/' + s.app + '.run', 1, 1]];
      const k = Math.min(max, procs.length);
      for (let i = 0; i < k; i++) {
        const at = out + i * P.$size;
        U8.fill(0, at, at + P.$size);
        wr(at, P.pid, procs[i][0]); writeStr(at + P.name.off, procs[i][1], 128); wr(at, P.state, procs[i][2]); wr(at, P.privilege, procs[i][3]);
        wr(at, P.sched_cpu, i % 4); wr(at, P.sched_level, 1);
      }
      return BigInt(k);
    }
    case 28: s.cleanup = Number(a); return OK;
    case 29: {                                         // MOUSE
      switch (Number(a)) {
        case 1: case 2: return OK;
        case 3: return 1n;
        case 4: {
          const M = L.syscall_mouse_state_t, at = Number(b); if (!at) return ERR.INVAL;
          wr(at, M.dx, s.mouse.dx); wr(at, M.dy, s.mouse.dy); wr(at, M.wheel, s.mouse.wheel); wr(at, M.buttons, s.mouse.buttons);
          s.mouse.dx = s.mouse.dy = s.mouse.wheel = 0;
          return OK;
        }
      }
      return ERR.INVAL;
    }
    case 30: {                                         // NET: no network card in the preview
      const R = L.syscall_net_request_t, req = Number(a);
      const op = rd(req, R.op);
      if (op === 1) { const st = rd(req, R.out_status); if (st) { const S = L.syscall_net_status_t; U8.fill(0, st, st + S.$size); } return OK; }
      if (op === 2) return ERR.PERM;
      if (op === 4) return OK;
      return ERR.NOTFOUND;
    }
    case 31: {                                         // HEAP
      const op = Number(a), ptr = Number(b), size = Number(c);
      if (op === 1 || op === 4) { if (size <= 0 || size > 64 * 1024 * 1024) return ERR.INVAL; const p = s.heap.alloc(size); return p ? BigInt(p) : ERR.GENERIC; }
      if (op === 2) { if (!ptr) return OK; return s.heap.release(ptr) ? OK : ERR.INVAL; }
      if (op === 3) {
        if (!ptr) { const p = s.heap.alloc(size); return p ? BigInt(p) : ERR.GENERIC; }
        const old = s.heap.size(ptr);
        if (old === undefined) return ERR.INVAL;
        const p = s.heap.alloc(size);
        if (!p) return ERR.GENERIC;
        U8.copyWithin(p, ptr, ptr + Math.min(old, size));
        s.heap.release(ptr);
        return BigInt(p);
      }
      return ERR.INVAL;
    }
    case 32: { const p = Number(a), len = Number(b); for (let o = 0; o < len; o += 65536) crypto.getRandomValues(U8.subarray(p + o, p + Math.min(len, o + 65536))); return BigInt(len); }
    case 33: return ERR.NOTFOUND;                      // EXEC: only this program exists in the preview
    case 34: { const p = str(Number(a)); if (!p) return ERR.INVAL; if (s.fs.get(p)) return ERR.GENERIC; s.fs.write(p, new Uint8Array(0)); return OK; }
    case 35: { const p = Number(a), size = Number(b); if (!p || size < 2) return ERR.INVAL; writeStr(p, '0:/programs', size); return OK; }
    case 36: {                                         // INPUT_READ
      const R = L.syscall_input_read_request_t, req = Number(a);
      const evs = rd(req, R.events), cap = rd(req, R.capacity), timeout = rd(req, R.timeout_ms);
      if (!evs || !cap) return ERR.INVAL;
      if (!s.input.length && timeout > 0) {
        s.wait = { ms: Math.min(timeout, 5000), input: true };
        s.waitingInput = () => inputRead(evs, cap);
        return SUSPEND;
      }
      return inputRead(evs, cap);
    }
    case 37: return windowSyscall(Number(a));
    case 40: return state.gpu.syscall(Number(a));      // GPU
  }
  return ERR.INVAL;
}

function inputRead(evs, cap) {
  const E = L.syscall_input_event_t;
  const k = Math.min(cap, state.input.length);
  for (let i = 0; i < k; i++) {
    const ev = state.input.shift(), at = evs + i * E.$size;
    U8.fill(0, at, at + E.$size);
    wr(at, E.type, ev.type); wr(at, E.key, ev.key | 0); wr(at, E.mods, ev.mods | 0); wr(at, E.buttons, ev.buttons | 0);
    wr(at, E.dx, ev.dx | 0); wr(at, E.dy, ev.dy | 0); wr(at, E.wheel, ev.wheel | 0); wr(at, E.time_ms, ev.time | 0);
  }
  return BigInt(k);
}

// ---------------------------------------------------------------------
//  Scheduler
// ---------------------------------------------------------------------
let gen = null, prog = null;

function flushOut() { if (state && state.outBuf) { post({ t: 'out', text: state.outBuf }); state.outBuf = ''; } }

function flushFrames() {
  if (!state) return;
  flushOut();
  for (const id of state.dirty) {
    const w = state.windows.get(id);
    if (!w) continue;
    const out = new Uint32Array(w.w * w.h);
    const src = w.pixels;
    for (let i = 0; i < src.length; i++) { const p = src[i]; out[i] = (p & 0xFF00FF00) | ((p >>> 16) & 0xFF) | ((p & 0xFF) << 16); }
    post({ t: 'frame', id, w: w.w, h: w.h, buf: out.buffer }, [out.buffer]);
  }
  state.dirty.clear();
  if (state.fbDirty && state.fbOwned) {
    const src = state.fb, out = new Uint32Array(src.length);
    for (let i = 0; i < src.length; i++) { const p = src[i]; out[i] = 0xFF000000 | ((p >>> 16) & 0xFF) | (p & 0xFF00) | ((p & 0xFF) << 16); }
    post({ t: 'gfx', w: state.screen.w, h: state.screen.h, buf: out.buffer }, [out.buffer]);
    state.fbDirty = false;
  }
}

function wake() {
  if (state && state.wait && state.wait.wakeOnEvent && state.timer) {
    clearTimeout(state.timer); state.timer = 0;
    schedule(0);
  }
}

function schedule(ms) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => { state.timer = 0; step(); }, ms);
}

function finish(code, crash) {
  if (state.exited) return;
  state.exited = true;
  flushFrames();
  if (state.timer) clearTimeout(state.timer);
  post({ t: 'exit', code, crash: crash || null, windows: [...state.windows.keys()] });
  gen = null;
}

function describe(e) {
  if (e instanceof Trap) return e.message;
  if (e instanceof RangeError && /call stack/i.test(e.message)) return 'Stack overflow (recursion too deep)';
  if (e instanceof RangeError && /BigInt/i.test(e.message)) return 'Invalid conversion: ' + e.message;
  if (e instanceof TypeError) return 'Memory page fault (' + e.message + ')';
  return (e && e.message) || String(e);
}

function step() {
  if (!gen || state.exited) return;
  state.slice = performance.now();
  let resume = state.resume;
  if (state.waitingInput) { resume = state.waitingInput(); state.waitingInput = null; }
  state.resume = undefined;
  state.wait = null;
  let r;
  try {
    r = gen.next(resume);
  } catch (e) {
    if (e instanceof Exit) return finish(e.code);
    return finish(255, describe(e));
  }
  if (r.done) return finish(Number(typeof r.value === 'bigint' ? BigInt.asUintN(8, r.value) : (r.value & 255)));
  flushFrames();
  const w = state.wait || { ms: 0 };
  if (w.input) w.wakeOnEvent = true;
  schedule(w.ms);
}

function writeArgs(top, args) {
  // strings, then the argv array, below the initial stack pointer
  let p = top;
  const ptrs = [];
  for (const a of args) {
    const b = new TextEncoder().encode(a);
    p -= b.length + 1; U8.set(b, p); U8[p + b.length] = 0;
    ptrs.push(p);
  }
  p = (p - 8 * (ptrs.length + 1)) & ~15;
  ptrs.forEach((q, i) => $sp(p + i * 8, q));
  $sp(p + ptrs.length * 8, 0);
  return { argv: p, sp: (p - 64) & ~15 };
}

function start(msg) {
  let compiled;
  const t0 = performance.now();
  try {
    compiled = MCC.compileJS(msg.files, MCC.SDK, {});
  } catch (e) {
    post({ t: 'compileError', error: { message: e.message, file: e.file, line: e.line, col: e.col }, internal: !(e instanceof MCC.CompileError) ? String(e.stack) : null });
    return;
  }
  const t1 = performance.now();
  resetState(msg);
  U8.set(compiled.image, compiled.imageBase);
  const heapStart = Math.ceil(compiled.imageEnd / 4096) * 4096 + 4096;
  const stackTop = MEM_SIZE - 4096;
  rt.stackLimit = stackTop - STACK_SIZE;
  state.heap = new Heap(heapStart, rt.stackLimit - 65536);
  const args = ['0:/programs/' + state.app + '.run'].concat(msg.args || []);
  const a = writeArgs(stackTop, args);
  rt.stackTop = a.sp;
  rt.I8 = I8; rt.U8 = U8; rt.I16 = I16; rt.U16 = U16; rt.I32 = I32; rt.U32 = U32; rt.I64 = BI64; rt.U64 = BU64; rt.F32 = F32; rt.F64 = F64;
  try {
    prog = new Function('rt', compiled.code)(rt);
  } catch (e) {
    post({ t: 'compileError', error: { message: 'internal compiler error: ' + e.message }, internal: compiled.code.slice(0, 2000) });
    return;
  }
  post({ t: 'started', compileMs: Math.round(t1 - t0), imageBytes: compiled.imageEnd - compiled.imageBase });
  const argc = args.length;
  if (prog.mainIsGen) gen = prog.main(argc, a.argv);
  else gen = (function* () { return prog.main(argc, a.argv); })();
  schedule(0);
}

function stop() {
  if (!state || state.exited || !gen) return;
  if (state.cleanup && !state.inCleanup) {
    // Ctrl+C: give the program's cleanup callback a second to save and exit
    state.inCleanup = true;
    const f = rt.$F[state.cleanup];
    if (typeof f === 'function') {
      gen = rt.$FK[state.cleanup] ? f() : (function* () { f(); })();
      schedule(0);
      setTimeout(() => { if (!state.exited) finish(130, 'Terminated: the cleanup callback did not call mos_exit within one second'); }, 1000);
      return;
    }
  }
  finish(130);
}

onmessage = (e) => {
  const m = e.data;
  switch (m.t) {
    case 'run': start(m); break;
    case 'stop': stop(); break;
    case 'ping': post({ t: 'pong', id: m.id }); break;
    case 'wmBounds': {
      if (!state) return;
      const w = state.windows.get(m.id);
      if (!w) return;
      if (m.w !== w.w || m.h !== w.h) resizeWindow(w, Math.max(WINDOW_MIN_W, m.w), Math.max(WINDOW_MIN_H, m.h));
      w.x = Math.max(0, m.x | 0); w.y = Math.max(0, m.y | 0);
      announce(w);
      break;
    }
    case 'wmFlags': {
      if (!state) return;
      const w = state.windows.get(m.id);
      if (!w) return;
      const before = w.flags;
      w.flags = (m.flags & ~WF.FOCUSED) | (w.flags & WF.FOCUSED);
      if ((w.flags & WF.MINIMIZED) && !(before & WF.MINIMIZED)) pushEvent(w, { type: EV.MINIMIZED });
      else if ((w.flags & WF.MAXIMIZED) && !(before & WF.MAXIMIZED)) pushEvent(w, { type: EV.MAXIMIZED });
      else if (!(w.flags & (WF.MAXIMIZED | WF.MINIMIZED | WF.FULLSCREEN)) && (before & (WF.MAXIMIZED | WF.MINIMIZED | WF.FULLSCREEN))) pushEvent(w, { type: EV.RESTORED });
      announce(w);
      break;
    }
    case 'wmFocus': {
      if (!state) return;
      const w = state.windows.get(m.id);
      if (w) setFocus(w);
      else if (m.id === 0 && state.focused) { const old = state.windows.get(state.focused); if (old) { pushEvent(old, { type: EV.FOCUS_LOST }); old.flags &= ~WF.FOCUSED; announce(old); } state.focused = 0; }
      break;
    }
    case 'wmEvent': {
      if (!state) return;
      const w = state.windows.get(m.id);
      if (w) pushEvent(w, Object.assign({ time: uptime() }, m.ev));
      break;
    }
    case 'input': {
      if (!state) return;
      const ev = Object.assign({ time: uptime() }, m.ev);
      if (ev.type === 1) state.pressed.add(ev.key);
      if (ev.type === 2) state.pressed.delete(ev.key);
      if (ev.type === 3) { state.mouse.dx += ev.dx; state.mouse.dy += ev.dy; }
      if (ev.type === 4) state.mouse.buttons = ev.buttons;
      if (ev.type === 5) state.mouse.wheel += ev.wheel;
      if (state.input.length < 256) state.input.push(ev);
      wake();
      break;
    }
  }
};
