/*
 * The preview desktop: a canvas stand-in for mosWM.
 *
 * Window geometry and chrome follow mosWM/main.c (28 px title bar, 9 px
 * corners, round close / maximise / minimise buttons 24 px apart, a 48 px
 * taskbar, edge and corner tiling). The worker's kernel owns the window
 * state; this side draws it and turns pointer and keyboard input into the
 * window events mosWM would post.
 */
(function () {
'use strict';

const TITLE = 28, RADIUS = 9, TASKBAR = 48, SNAP = 24;
const WF = { VISIBLE: 1, RESIZABLE: 2, FULLSCREEN: 4, MAXIMIZED: 8, MINIMIZED: 16, FOCUSED: 32 };
const EV = { CLOSE_REQUEST: 2, KEY: 8, MOUSE: 9, MOUSE_WHEEL: 10 };
const ACCENT = '#3DAEE9';
const FONT8 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGDw8GBgAGAA2NgAAAAAAADY2fzZ/NjYADD4DHjAfDAAAYzMYDGZjABw2HG47M24ABgYDAAAAAAAYDAYGBgwYAAYMGBgYDAYAAGY8/zxmAAAADAw/DAwAAAAAAAAADAwGAAAAPwAAAAAAAAAAAAwMAGAwGAwGAwEAPmNze29nPgAMDgwMDAw/AB4zMBwGMz8AHjMwHDAzHgA4PDYzfzB4AD8DHzAwMx4AHAYDHzMzHgA/MzAYDAwMAB4zMx4zMx4AHjMzPjAYDgAADAwAAAwMAAAMDAAADAwGGAwGAwYMGAAAAD8AAD8AAAYMGDAYDAYAHjMwGAwADAA+Y3t7ewMeAAweMzM/MzMAP2ZmPmZmPwA8ZgMDA2Y8AB82ZmZmNh8Af0YWHhZGfwB/RhYeFgYPADxmAwNzZnwAMzMzPzMzMwAeDAwMDAweAHgwMDAzMx4AZ2Y2HjZmZwAPBgYGRmZ/AGN3f39rY2MAY2dve3NjYwAcNmNjYzYcAD9mZj4GBg8AHjMzMzseOAA/ZmY+NmZnAB4zBw44Mx4APy0MDAwMHgAzMzMzMzM/ADMzMzMzHgwAY2Nja393YwBjYzYcHDZjADMzMx4MDB4Af2MxGExmfwAeBgYGBgYeAAMGDBgwYEAAHhgYGBgYHgAIHDZjAAAAAAAAAAAAAAD/DAwYAAAAAAAAAB4wPjNuAAcGBj5mZjsAAAAeMwMzHgA4MDA+MzNuAAAAHjM/Ax4AHDYGDwYGDwAAAG4zMz4wHwcGNm5mZmcADAAODAwMHgAwADAwMDMzHgcGZjYeNmcADgwMDAwMHgAAADN/f2tjAAAAHzMzMzMAAAAeMzMzHgAAADtmZj4GDwAAbjMzPjB4AAA7bmYGDwAAAD4DHjAfAAgMPgwMLBgAAAAzMzMzbgAAADMzMx4MAAAAY2t/fzYAAABjNhw2YwAAADMzMz4wHwAAPxkMJj8AOAwMBwwMOAAYGBgAGBgYAAcMDDgMDAcAbjsAAAAAAAAAAAAAAAAAAA==';

// KeyboardEvent.code -> USB HID usage
const HID = (function () {
  const m = {};
  'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c, i) => { m['Key' + c.toUpperCase()] = 4 + i; });
  '1234567890'.split('').forEach((c, i) => { m['Digit' + c] = 30 + i; });
  Object.assign(m, { Enter: 40, NumpadEnter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46,
    BracketLeft: 47, BracketRight: 48, Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55,
    Slash: 56, CapsLock: 57, F1: 58, F2: 59, F3: 60, F4: 61, F5: 62, F6: 63, F7: 64, F8: 65, F9: 66, F10: 67, F11: 68, F12: 69,
    Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
    ShiftLeft: 225, ShiftRight: 229, ControlLeft: 224, ControlRight: 228, AltLeft: 226, AltRight: 230 });
  return m;
})();

const argbToCss = (c) => 'rgba(' + ((c >>> 16) & 255) + ',' + ((c >>> 8) & 255) + ',' + (c & 255) + ',' + (((c >>> 24) & 255) / 255) + ')';
const opaque = (c) => 'rgb(' + ((c >>> 16) & 255) + ',' + ((c >>> 8) & 255) + ',' + (c & 255) + ')';

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
}

class Desktop {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.windows = new Map();      // id -> {info, surface, restore}
    this.order = [];               // bottom .. top
    this.focused = 0;
    this.app = this.opts.appName || 'app';
    this.term = { id: 'term', lines: [''], visible: false, minimized: false, x: 40, y: 60, w: 600, h: 300, title: 'Terminal', restore: null, flags: WF.VISIBLE | WF.RESIZABLE };
    this.gfx = null;
    this.drag = null;
    this.hover = null;
    this.menu = false;
    this.buttons = 0;
    this.running = false;
    this.selectedIcon = -1;
    this.lastClick = { t: 0, x: 0, y: 0, target: null };
    this.font = this.makeFont();
    this.setScreen(this.opts.width || 1280, this.opts.height || 720);
    this.bind();
    this.clockTimer = setInterval(() => this.invalidate(), 15000);
  }

  setScreen(w, h) {
    this.W = w; this.H = h;
    this.canvas.width = w; this.canvas.height = h;
    this.wallpaper = this.makeWallpaper();
    this.term.x = 40; this.term.y = Math.max(40, h - TASKBAR - 360);
    this.invalidate();
  }
  setApp(name) { this.app = name || 'app'; this.invalidate(); }

  makeFont() {
    const bits = Uint8Array.from(atob(FONT8), c => c.charCodeAt(0));
    const c = document.createElement('canvas');
    c.width = 128 * 8; c.height = 8;
    const g = c.getContext('2d');
    const img = g.createImageData(c.width, 8);
    for (let ch = 0; ch < 128; ch++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      if (bits[ch * 8 + y] & (1 << x)) { const p = (y * c.width + ch * 8 + x) * 4; img.data[p] = 214; img.data[p + 1] = 226; img.data[p + 2] = 232; img.data[p + 3] = 255; }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  makeWallpaper() {
    const c = document.createElement('canvas');
    c.width = this.W; c.height = this.H;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, this.W, this.H);
    grad.addColorStop(0, '#0E2A38'); grad.addColorStop(0.55, '#123B4C'); grad.addColorStop(1, '#0B1E29');
    g.fillStyle = grad; g.fillRect(0, 0, this.W, this.H);
    const glow = g.createRadialGradient(this.W * 0.72, this.H * 0.35, 10, this.W * 0.72, this.H * 0.35, this.H * 0.8);
    glow.addColorStop(0, 'rgba(61,174,233,0.32)'); glow.addColorStop(1, 'rgba(61,174,233,0)');
    g.fillStyle = glow; g.fillRect(0, 0, this.W, this.H);
    g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1;
    for (let i = 0; i < 9; i++) {
      g.beginPath();
      for (let x = 0; x <= this.W; x += 16) {
        const y = this.H * (0.42 + i * 0.045) + Math.sin(x / 140 + i * 0.7) * 26 + Math.sin(x / 53 + i) * 6;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    return c;
  }

  invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  // ---------------------------------------------------------------
  //  Messages from the worker kernel
  // ---------------------------------------------------------------
  message(m) {
    switch (m.t) {
      case 'win': {
        let w = this.windows.get(m.info.id);
        const isNew = !w;
        if (isNew) {
          w = { id: m.info.id, info: m.info, surface: document.createElement('canvas'), restore: null, hasFrame: false };
          this.windows.set(w.id, w);
          this.order.push(w.id);
        }
        const before = w.info.flags;
        w.info = m.info;
        if (isNew) this.focus(w.id);
        this.applyFlags(w, before, isNew);
        break;
      }
      case 'winClose': this.removeWindow(m.id); break;
      case 'frame': {
        const w = this.windows.get(m.id);
        if (!w) return;
        if (w.surface.width !== m.w || w.surface.height !== m.h) { w.surface.width = m.w; w.surface.height = m.h; }
        w.surface.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.buf), m.w, m.h), 0, 0);
        w.hasFrame = true;
        break;
      }
      case 'out': this.write(m.text); break;
      case 'termClear': this.term.lines = ['']; break;
      case 'gfx': {
        if (!this.gfx) this.gfx = document.createElement('canvas');
        this.gfx.width = m.w; this.gfx.height = m.h;
        this.gfx.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.buf), m.w, m.h), 0, 0);
        this.gfxActive = true;
        break;
      }
      case 'gfxRelease': this.gfxActive = false; break;
    }
    this.invalidate();
  }

  // the kernel told us about a flag change (from the app or from us)
  applyFlags(w, before, isNew) {
    const f = w.info.flags;
    const work = this.workArea();
    if ((f & WF.FULLSCREEN) && (w.info.x !== 0 || w.info.y !== 0 || w.info.w !== this.W - 2 || w.info.h !== this.H - TITLE - 2)) {
      if (!w.restore) w.restore = { x: w.info.x, y: w.info.y, w: w.info.w, h: w.info.h };
      this.bounds(w, 0, 0, this.W - 2, this.H - TITLE - 2);
    } else if ((f & WF.MAXIMIZED) && !(before & WF.MAXIMIZED) && !isNew) {
      if (!w.restore) w.restore = { x: w.info.x, y: w.info.y, w: w.info.w, h: w.info.h };
      this.bounds(w, work.x, work.y, work.w - 2, work.h - TITLE - 2);
    } else if (!(f & (WF.MAXIMIZED | WF.FULLSCREEN)) && (before & (WF.MAXIMIZED | WF.FULLSCREEN)) && w.restore) {
      const r = w.restore; w.restore = null;
      this.bounds(w, r.x, r.y, r.w, r.h);
    }
    if ((f & WF.MINIMIZED) && this.focused === w.id) this.focusTop();
  }

  removeWindow(id) {
    this.windows.delete(id);
    this.order = this.order.filter(x => x !== id);
    if (this.focused === id) this.focusTop();
    this.invalidate();
  }

  // program ended: the kernel closes everything the process owned
  programExited() {
    for (const id of [...this.windows.keys()]) this.removeWindow(id);
    this.gfxActive = false;
    this.running = false;
    this.invalidate();
  }
  programStarted() {
    for (const id of [...this.windows.keys()]) this.removeWindow(id);
    this.gfxActive = false;
    this.running = true;
    this.term.lines = [''];
    this.term.visible = false;
    this.invalidate();
  }

  write(text) {
    const t = this.term;
    const cols = Math.max(10, Math.floor((t.w - 16) / 8));
    for (const ch of text) {
      if (ch === '\n') { t.lines.push(''); continue; }
      if (ch === '\r') continue;
      if (ch === '\b') { t.lines[t.lines.length - 1] = t.lines[t.lines.length - 1].slice(0, -1); continue; }
      if (ch === '\t') { t.lines[t.lines.length - 1] += '    '; continue; }
      if (t.lines[t.lines.length - 1].length >= cols) t.lines.push('');
      t.lines[t.lines.length - 1] += ch;
    }
    if (t.lines.length > 400) t.lines.splice(0, t.lines.length - 400);
    if (!t.visible) {
      t.visible = true; t.minimized = false;
      if (!this.order.includes('term')) this.order.unshift('term');
    }
    this.invalidate();
  }

  showTerminal() {
    const t = this.term;
    t.visible = true; t.minimized = false;
    if (!this.order.includes('term')) this.order.push('term');
    this.focus('term');
  }

  // ---------------------------------------------------------------
  //  Window management
  // ---------------------------------------------------------------
  workArea() { return { x: 0, y: 0, w: this.W, h: this.H - TASKBAR }; }

  rect(id) {
    if (id === 'term') { const t = this.term; return { x: t.x, y: t.y, w: t.w + 2, h: t.h + TITLE + 2, cw: t.w, ch: t.h, flags: t.flags | (t.minimized ? WF.MINIMIZED : 0) }; }
    const w = this.windows.get(id);
    if (!w) return null;
    const i = w.info;
    return { x: i.x, y: i.y, w: i.w + 2, h: i.h + TITLE + 2, cw: i.w, ch: i.h, flags: i.flags };
  }

  visible(id) {
    if (id === 'term') return this.term.visible && !this.term.minimized;
    const w = this.windows.get(id);
    return w && (w.info.flags & WF.VISIBLE) && !(w.info.flags & WF.MINIMIZED);
  }

  focus(id) {
    if (id !== 0 && id !== 'term' && !this.windows.has(id)) return;
    this.order = this.order.filter(x => x !== id);
    if (id) this.order.push(id);
    this.focused = id;
    if (this.opts.onSend) this.opts.onSend({ t: 'wmFocus', id: typeof id === 'number' ? id : 0 });
    this.invalidate();
  }

  focusTop() {
    for (let i = this.order.length - 1; i >= 0; i--) if (this.visible(this.order[i])) { this.focus(this.order[i]); return; }
    this.focus(0);
  }

  bounds(w, x, y, cw, ch) {
    if (w === this.term || w.id === 'term') { const t = this.term; t.x = x; t.y = y; t.w = Math.max(160, cw); t.h = Math.max(80, ch); this.invalidate(); return; }
    w.info = Object.assign({}, w.info, { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), w: Math.max(64, Math.round(cw)), h: Math.max(48, Math.round(ch)) });
    if (this.opts.onSend) this.opts.onSend({ t: 'wmBounds', id: w.id, x: w.info.x, y: w.info.y, w: w.info.w, h: w.info.h });
    this.invalidate();
  }

  setFlags(w, flags) {
    if (w.id === 'term') return;
    const before = w.info.flags;
    w.info = Object.assign({}, w.info, { flags });
    if (this.opts.onSend) this.opts.onSend({ t: 'wmFlags', id: w.id, flags });
    this.applyFlags(w, before, false);
    this.invalidate();
  }

  toggleMax(id) {
    if (id === 'term') {
      const t = this.term, a = this.workArea();
      if (t.restore) { const r = t.restore; t.restore = null; this.bounds(t, r.x, r.y, r.w, r.h); }
      else { t.restore = { x: t.x, y: t.y, w: t.w, h: t.h }; this.bounds(t, a.x, a.y, a.w - 2, a.h - TITLE - 2); }
      return;
    }
    const w = this.windows.get(id);
    if (!w || !(w.info.flags & WF.RESIZABLE)) return;
    this.setFlags(w, w.info.flags & WF.MAXIMIZED ? w.info.flags & ~WF.MAXIMIZED : (w.info.flags | WF.MAXIMIZED) & ~WF.MINIMIZED);
  }

  minimize(id) {
    if (id === 'term') { this.term.minimized = true; this.focusTop(); this.invalidate(); return; }
    const w = this.windows.get(id);
    if (w) this.setFlags(w, w.info.flags | WF.MINIMIZED);
  }

  restore(id) {
    if (id === 'term') { this.term.minimized = false; this.focus('term'); return; }
    const w = this.windows.get(id);
    if (!w) return;
    if (w.info.flags & WF.MINIMIZED) this.setFlags(w, w.info.flags & ~WF.MINIMIZED);
    this.focus(id);
  }

  closeRequest(id) {
    if (id === 'term') { this.term.visible = false; this.order = this.order.filter(x => x !== 'term'); this.focusTop(); this.invalidate(); return; }
    if (this.opts.onSend) this.opts.onSend({ t: 'wmEvent', id, ev: { type: EV.CLOSE_REQUEST } });
  }

  // ---------------------------------------------------------------
  //  Input
  // ---------------------------------------------------------------
  bind() {
    const c = this.canvas;
    c.tabIndex = 0;
    c.addEventListener('pointerdown', (e) => this.pointerDown(e));
    c.addEventListener('pointermove', (e) => this.pointerMove(e));
    c.addEventListener('pointerup', (e) => this.pointerUp(e));
    c.addEventListener('pointerleave', () => { this.hover = null; this.invalidate(); });
    c.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('keydown', (e) => this.key(e, true));
    c.addEventListener('keyup', (e) => this.key(e, false));
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * this.W / r.width, y: (e.clientY - r.top) * this.H / r.height };
  }

  mods(e) { return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0); }

  hit(x, y) {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const id = this.order[i];
      if (!this.visible(id)) continue;
      const r = this.rect(id);
      if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) continue;
      const right = r.x + r.cw + 1, by = r.y + 5;
      const inCircle = (cx) => (x - (cx + 9)) ** 2 + (y - (by + 9)) ** 2 <= 100;
      if (y < r.y + TITLE + 1) {
        if (inCircle(right - 24)) return { id, part: 'close' };
        if (inCircle(right - 48)) return { id, part: 'max' };
        if (inCircle(right - 72)) return { id, part: 'min' };
        return { id, part: 'title' };
      }
      if ((r.flags & WF.RESIZABLE) && x >= r.x + r.w - 14 && y >= r.y + r.h - 14) return { id, part: 'resize' };
      return { id, part: 'content', cx: Math.floor(x - r.x - 1), cy: Math.floor(y - r.y - TITLE - 1) };
    }
    if (y >= this.H - TASKBAR) return { id: null, part: 'taskbar' };
    return { id: null, part: 'desktop' };
  }

  sendMouse(h, type, extra) {
    if (!h || h.part !== 'content' || h.id === 'term' || !this.opts.onSend) return;
    this.opts.onSend({ t: 'wmEvent', id: h.id, ev: Object.assign({ type, x: h.cx, y: h.cy, buttons: this.buttons }, extra) });
  }

  pointerDown(e) {
    this.canvas.focus();
    const p = this.pos(e);
    this.buttons |= e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 4 : 0;
    if (this.opts.onSend) this.opts.onSend({ t: 'input', ev: { type: 4, buttons: this.buttons } });
    this.canvas.setPointerCapture(e.pointerId);
    if (this.gfxActive) return;
    if (this.menu) {
      const item = this.menuItemAt(p.x, p.y);
      this.menu = false;
      if (item) item.run();
      this.invalidate();
      return;
    }
    const h = this.hit(p.x, p.y);
    const now = performance.now();
    const dbl = now - this.lastClick.t < 400 && Math.abs(p.x - this.lastClick.x) < 6 && Math.abs(p.y - this.lastClick.y) < 6 && this.lastClick.target === (h.id || h.part);
    this.lastClick = { t: now, x: p.x, y: p.y, target: h.id || h.part };
    if (h.part === 'taskbar') { this.taskbarClick(p.x); return; }
    if (h.part === 'desktop') {
      const icon = this.iconAt(p.x, p.y);
      this.selectedIcon = icon ? icon.index : -1;
      if (icon && dbl) icon.open();
      this.invalidate();
      return;
    }
    if (h.id !== this.focused) this.focus(h.id);
    if (e.button !== 0 && h.part !== 'content') return;
    const r = this.rect(h.id);
    switch (h.part) {
      case 'close': this.closeRequest(h.id); break;
      case 'max': this.toggleMax(h.id); break;
      case 'min': this.minimize(h.id); break;
      case 'title':
        if (dbl) { this.toggleMax(h.id); break; }
        this.drag = { mode: 'move', id: h.id, dx: p.x - r.x, dy: p.y - r.y, cw: r.cw, ch: r.ch };
        break;
      case 'resize':
        this.drag = { mode: 'resize', id: h.id, sx: p.x, sy: p.y, cw: r.cw, ch: r.ch, x: r.x, y: r.y, last: 0 };
        break;
      case 'content': this.sendMouse(h, EV.MOUSE); break;
    }
    this.invalidate();
  }

  pointerMove(e) {
    const p = this.pos(e);
    if (this.opts.onSend && (e.movementX || e.movementY)) this.opts.onSend({ t: 'input', ev: { type: 3, dx: Math.round(e.movementX), dy: Math.round(e.movementY), buttons: this.buttons } });
    if (this.gfxActive) return;
    const d = this.drag;
    if (d) {
      const w = d.id === 'term' ? this.term : this.windows.get(d.id);
      if (!w) { this.drag = null; return; }
      if (d.mode === 'move') {
        const x = Math.max(-d.cw + 60, Math.min(this.W - 60, p.x - d.dx));
        const y = Math.max(0, Math.min(this.H - TASKBAR - TITLE, p.y - d.dy));
        if (d.id !== 'term' && (w.info.flags & WF.MAXIMIZED)) {
          // dragging a maximised window restores it under the pointer
          const r = w.restore || { w: d.cw, h: d.ch };
          w.restore = null;
          this.setFlags(w, w.info.flags & ~WF.MAXIMIZED);
          d.cw = r.w; d.ch = r.h; d.dx = Math.min(d.dx, r.w / 2);
          this.bounds(w, p.x - d.dx, y, r.w, r.h);
        } else if (d.id === 'term') { this.term.x = x; this.term.y = y; this.term.restore = null; }
        else this.bounds(w, x, y, w.info.w, w.info.h);
        d.snap = this.snapRect(p.x, p.y);
        this.canvas.style.cursor = 'grabbing';
      } else {
        const cw = Math.max(64, d.cw + (p.x - d.sx)), ch = Math.max(48, d.ch + (p.y - d.sy));
        const now = performance.now();
        d.pending = { cw, ch };
        if (d.id === 'term') this.bounds(this.term, d.x, d.y, cw, ch);
        else if (now - d.last > 40) { d.last = now; this.bounds(w, d.x, d.y, cw, ch); d.pending = null; }
        this.canvas.style.cursor = 'nwse-resize';
      }
      this.invalidate();
      return;
    }
    const h = this.hit(p.x, p.y);
    this.hoverX = p.x;
    const key = h.id + ':' + h.part;
    if (key !== this.hoverKey) { this.hoverKey = key; this.hover = h; this.invalidate(); }
    this.hover = h;
    this.canvas.style.cursor = h.part === 'resize' ? 'nwse-resize' : (h.part === 'close' || h.part === 'max' || h.part === 'min' || h.part === 'taskbar') ? 'pointer' : 'default';
    if (h.part === 'content') this.sendMouse(h, EV.MOUSE);
    if (this.menu || h.part === 'taskbar') this.invalidate();
  }

  pointerUp(e) {
    const p = this.pos(e);
    this.buttons &= ~(e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 4 : 0);
    if (this.opts.onSend) this.opts.onSend({ t: 'input', ev: { type: 4, buttons: this.buttons } });
    if (this.gfxActive) return;
    const d = this.drag;
    this.drag = null;
    if (d) {
      const w = d.id === 'term' ? this.term : this.windows.get(d.id);
      if (d.mode === 'resize' && d.pending && w) this.bounds(w, d.x, d.y, d.pending.cw, d.pending.ch);
      if (d.mode === 'move' && d.snap && w) {
        const s = d.snap;
        if (s.max && d.id !== 'term') this.toggleMax(d.id);
        else if (d.id === 'term' || (w.info.flags & WF.RESIZABLE)) {
          const r = this.rect(d.id);
          if (d.id === 'term') this.term.restore = { x: r.x, y: r.y, w: r.cw, h: r.ch };
          else w.restore = { x: r.x, y: r.y, w: r.cw, h: r.ch };
          this.bounds(w, s.x, s.y, s.w - 2, s.h - TITLE - 2);
        }
      }
      this.canvas.style.cursor = 'default';
      this.invalidate();
      return;
    }
    const h = this.hit(p.x, p.y);
    if (h.part === 'content') this.sendMouse(h, EV.MOUSE);
  }

  snapRect(x, y) {
    const a = this.workArea();
    const left = x < SNAP, right = x > this.W - SNAP, top = y < SNAP, bottom = y > a.h - SNAP;
    if (top && !left && !right) return { max: true, x: 0, y: 0, w: a.w, h: a.h };
    if ((left || right) && top) return { x: left ? 0 : a.w / 2, y: 0, w: a.w / 2, h: a.h / 2 };
    if ((left || right) && bottom) return { x: left ? 0 : a.w / 2, y: a.h / 2, w: a.w / 2, h: a.h / 2 };
    if (left || right) return { x: left ? 0 : a.w / 2, y: 0, w: a.w / 2, h: a.h };
    return null;
  }

  wheel(e) {
    e.preventDefault();
    const p = this.pos(e);
    const wheel = e.deltaY > 0 ? -1 : e.deltaY < 0 ? 1 : 0;
    if (!wheel) return;
    if (this.opts.onSend) this.opts.onSend({ t: 'input', ev: { type: 5, wheel } });
    if (this.gfxActive) return;
    const h = this.hit(p.x, p.y);
    if (h.id === 'term') {
      const t = this.term;
      t.scroll = Math.max(0, Math.min(t.lines.length, (t.scroll || 0) + wheel * 3));
      this.invalidate();
      return;
    }
    this.sendMouse(h, EV.MOUSE_WHEEL, { wheel });
  }

  key(e, down) {
    const code = HID[e.code];
    if (code === undefined) return;
    if (e.ctrlKey && (e.key === 'Enter' || e.key === '.')) return;   // leave Studio shortcuts alone
    e.preventDefault();
    if (this.opts.onSend) {
      this.opts.onSend({ t: 'input', ev: { type: down ? 1 : 2, key: code, mods: this.mods(e) } });
      if (code >= 224) return;                                        // modifiers only travel as raw input
      if (typeof this.focused === 'number' && this.focused)
        this.opts.onSend({ t: 'wmEvent', id: this.focused, ev: { type: EV.KEY, key: code, buttons: down ? 1 : 0, mods: this.mods(e) } });
    }
  }

  // ---------------------------------------------------------------
  //  Taskbar, start menu and desktop icons
  // ---------------------------------------------------------------
  tasks() {
    const list = [];
    for (const id of this.order.slice().sort((a, b) => String(a).localeCompare(String(b)))) {
      if (id === 'term') { if (this.term.visible) list.push({ id, title: 'Terminal', min: this.term.minimized }); continue; }
      const w = this.windows.get(id);
      if (w && (w.info.flags & WF.VISIBLE)) list.push({ id, title: w.info.title || 'Window', min: !!(w.info.flags & WF.MINIMIZED) });
    }
    return list;
  }

  taskbarClick(x) {
    if (x < 48) { this.menu = !this.menu; this.invalidate(); return; }
    const t = this.tasks();
    const i = Math.floor((x - 56) / 176);
    if (i < 0 || i >= t.length || x - 56 - i * 176 > 170) return;
    const task = t[i];
    if (task.min) this.restore(task.id);
    else if (this.focused === task.id) this.minimize(task.id);
    else this.focus(task.id);
  }

  menuItems() {
    const items = [
      { label: 'Run ' + this.app + '.run', run: () => this.opts.onLaunch && this.opts.onLaunch() },
      { label: 'Stop program', run: () => this.opts.onStop && this.opts.onStop(), disabled: !this.running },
      { label: 'Terminal', run: () => this.showTerminal() },
    ];
    return items;
  }

  menuItemAt(x, y) {
    const items = this.menuItems();
    const top = this.H - TASKBAR - 16 - items.length * 30 - 52;
    if (x < 8 || x > 8 + 220 || y < top + 52) return null;
    const i = Math.floor((y - top - 52) / 30);
    const it = items[i];
    return it && !it.disabled ? it : null;
  }

  icons() {
    return [
      { label: 'Home', kind: 'home', open: () => this.showTerminal() },
      { label: 'System', kind: 'computer', open: () => this.showTerminal() },
      { label: this.app, kind: 'app', open: () => this.opts.onLaunch && this.opts.onLaunch() },
    ].map((ic, i) => Object.assign(ic, { index: i, x: 18, y: 18 + i * 96 }));
  }

  iconAt(x, y) {
    return this.icons().find(ic => x >= ic.x && x < ic.x + 76 && y >= ic.y && y < ic.y + 88) || null;
  }

  // ---------------------------------------------------------------
  //  Drawing
  // ---------------------------------------------------------------
  draw() {
    const g = this.ctx;
    g.drawImage(this.wallpaper, 0, 0);
    this.drawIcons(g);
    if (!this.running && !this.windows.size && !this.term.visible) {
      g.fillStyle = 'rgba(234,242,248,0.72)';
      g.font = '500 22px Inter, "Instrument Sans", system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('Press Run to start ' + this.app + '.run', this.W / 2, this.H / 2 - 20);
      g.font = '400 15px Inter, "Instrument Sans", system-ui, sans-serif';
      g.fillStyle = 'rgba(234,242,248,0.5)';
      g.fillText('Ctrl+Enter runs, Ctrl+. stops. Click a window before typing.', this.W / 2, this.H / 2 + 12);
      g.textAlign = 'left';
    }
    for (const id of this.order) if (this.visible(id)) this.drawWindow(g, id);
    const d = this.drag;
    if (d && d.mode === 'move' && d.snap) {
      g.fillStyle = 'rgba(61,174,233,0.18)'; g.strokeStyle = 'rgba(61,174,233,0.8)'; g.lineWidth = 2;
      rr(g, d.snap.x + 6, d.snap.y + 6, d.snap.w - 12, d.snap.h - 12, 10); g.fill(); g.stroke();
    }
    this.drawTaskbar(g);
    if (this.menu) this.drawMenu(g);
    if (this.gfxActive && this.gfx) {
      g.drawImage(this.gfx, 0, 0, this.W, this.H);
    }
  }

  drawIcons(g) {
    for (const ic of this.icons()) {
      if (this.selectedIcon === ic.index) { g.fillStyle = 'rgba(61,174,233,0.25)'; rr(g, ic.x, ic.y, 76, 88, 8); g.fill(); }
      const cx = ic.x + 38, top = ic.y + 8;
      if (ic.kind === 'app') {
        g.fillStyle = '#24343C'; rr(g, cx - 24, top, 48, 48, 10); g.fill();
        g.fillStyle = ACCENT; rr(g, cx - 18, top + 6, 36, 8, 3); g.fill();
        g.fillStyle = '#EAF2F8'; g.font = '600 13px "JetBrains Mono", monospace'; g.textAlign = 'center'; g.fillText('.run', cx, top + 36);
      } else if (ic.kind === 'home') {
        g.fillStyle = '#E8B34C'; rr(g, cx - 24, top + 8, 48, 36, 5); g.fill();
        g.fillStyle = '#F2C66B'; rr(g, cx - 24, top + 4, 22, 10, 3); g.fill();
      } else {
        g.fillStyle = '#9BB0BC'; rr(g, cx - 24, top + 4, 48, 32, 5); g.fill();
        g.fillStyle = '#17232A'; g.fillRect(cx - 20, top + 8, 40, 24);
        g.fillStyle = ACCENT; g.fillRect(cx - 16, top + 12, 18, 3);
        g.fillStyle = '#9BB0BC'; g.fillRect(cx - 10, top + 38, 20, 6);
      }
      g.textAlign = 'center';
      g.font = '500 13px Inter, "Instrument Sans", system-ui, sans-serif';
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillText(ic.label, cx + 1, ic.y + 77);
      g.fillStyle = '#F2F6F8'; g.fillText(ic.label, cx, ic.y + 76);
      g.textAlign = 'left';
    }
  }

  drawWindow(g, id) {
    const r = this.rect(id);
    const isTerm = id === 'term';
    const w = isTerm ? null : this.windows.get(id);
    const style = isTerm
      ? { title_bar: 0xFF24343C, title_text: 0xFFFFFFFF, close_button: 0xFFE35D6A, minimize_button: 0xFFE8B34C, maximize_button: 0xFF4ABF8A, close_icon: 0xFFFFFFFF, minimize_icon: 0xFF17262C, maximize_icon: 0xFF17262C, border: 0xFF49616B, content_background: 0xFF0C1418 }
      : w.info.style;
    const focused = this.focused === id;
    const { x, y } = r;
    const ow = r.w, oh = r.h;
    // shadows
    g.fillStyle = 'rgba(0,0,0,0.09)'; rr(g, x - 4, y - 1, ow + 8, oh + 10, RADIUS + 4); g.fill();
    g.fillStyle = focused ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.14)'; rr(g, x - 1, y + 2, ow + 2, oh + 4, RADIUS + 1); g.fill();
    // frame
    g.fillStyle = argbToCss(style.border); rr(g, x, y, ow, oh, RADIUS); g.fill();
    g.fillStyle = argbToCss(style.content_background); rr(g, x + 1, y + 1, ow - 2, oh - 2, RADIUS - 1); g.fill();
    g.fillStyle = argbToCss(style.title_bar);
    rr(g, x + 1, y + 1, ow - 2, TITLE, RADIUS - 1); g.fill();
    g.fillRect(x + 1, y + 1 + TITLE - (RADIUS - 1), ow - 2, RADIUS - 1);
    g.fillRect(x + 1, y + TITLE, ow - 2, 2);
    g.fillStyle = 'rgba(0,0,0,0.19)'; g.fillRect(x + 1, y + TITLE - 1, ow - 2, 1);
    g.fillStyle = 'rgba(255,255,255,0.11)'; g.fillRect(x + RADIUS, y + 1, ow - RADIUS * 2, 1);
    // content
    g.save();
    g.beginPath();
    if (g.roundRect) g.roundRect(x + 1, y + TITLE + 1, r.cw, r.ch, [0, 0, RADIUS - 1, RADIUS - 1]); else g.rect(x + 1, y + TITLE + 1, r.cw, r.ch);
    g.clip();
    if (isTerm) this.drawTerminal(g, x + 1, y + TITLE + 1, r.cw, r.ch);
    else if (w.hasFrame) g.drawImage(w.surface, 0, 0, Math.min(w.surface.width, r.cw), Math.min(w.surface.height, r.ch), x + 1, y + TITLE + 1, Math.min(w.surface.width, r.cw), Math.min(w.surface.height, r.ch));
    g.restore();
    // title
    const right = x + r.cw + 1, by = y + 5;
    const closeX = right - 24, maxX = right - 48, minX = right - 72;
    const title = isTerm ? 'Terminal' : (w.info.title || '');
    g.font = '500 13px Inter, "Instrument Sans", system-ui, sans-serif';
    const room = minX - 10 - (x + 12);
    let shown = title;
    while (shown.length > 1 && g.measureText(shown).width > room) shown = shown.slice(0, -2) + '…';
    const tw = g.measureText(shown).width;
    g.fillStyle = focused ? opaque(style.title_text) : argbToCss(((style.title_text & 0x00FFFFFF) | 0xA0000000) >>> 0);
    g.fillText(shown, x + 12 + Math.max(0, (room - tw) / 2), y + TITLE / 2 + 5);
    // buttons
    const hov = this.hover && this.hover.id === id ? this.hover.part : null;
    const btn = (bx, color, part) => {
      g.fillStyle = opaque(color); g.beginPath(); g.arc(bx + 9, by + 9, 9, 0, Math.PI * 2); g.fill();
      if (hov === part) { g.fillStyle = 'rgba(255,255,255,0.22)'; g.beginPath(); g.arc(bx + 9, by + 9, 9, 0, Math.PI * 2); g.fill(); }
    };
    btn(closeX, style.close_button, 'close');
    g.strokeStyle = opaque(style.close_icon); g.lineWidth = 2;
    g.beginPath(); g.moveTo(closeX + 6, by + 6); g.lineTo(closeX + 12, by + 12); g.moveTo(closeX + 12, by + 6); g.lineTo(closeX + 6, by + 12); g.stroke();
    btn(maxX, style.maximize_button, 'max');
    g.strokeStyle = opaque(style.maximize_icon); g.lineWidth = 1;
    g.strokeRect(maxX + 5.5, by + 5.5, 7, 7); g.fillStyle = opaque(style.maximize_icon); g.fillRect(maxX + 5, by + 5, 8, 2);
    btn(minX, style.minimize_button, 'min');
    g.fillStyle = opaque(style.minimize_icon); g.fillRect(minX + 5, by + 11, 8, 2);
  }

  drawTerminal(g, x, y, w, h) {
    const t = this.term;
    const rows = Math.max(1, Math.floor((h - 12) / 16));
    const end = Math.max(0, t.lines.length - (t.scroll || 0));
    const start = Math.max(0, end - rows);
    g.imageSmoothingEnabled = false;
    for (let i = start; i < end; i++) {
      const line = t.lines[i];
      const py = y + 8 + (i - start) * 16;
      for (let k = 0; k < line.length; k++) {
        const c = line.charCodeAt(k);
        if (c === 32) continue;
        g.drawImage(this.font, (c < 128 ? c : 63) * 8, 0, 8, 8, x + 8 + k * 8, py, 8, 8);
      }
    }
    if (!t.scroll && this.running) { g.fillStyle = '#D6E2E8'; g.fillRect(x + 8 + t.lines[t.lines.length - 1].length * 8, y + 8 + (end - 1 - start) * 16 + 7, 8, 2); }
  }

  drawTaskbar(g) {
    const y = this.H - TASKBAR;
    g.fillStyle = 'rgba(14,21,26,0.92)'; g.fillRect(0, y, this.W, TASKBAR);
    g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(0, y, this.W, 1);
    // start button: the Minimal-OS mark
    if (this.menu || (this.hover && this.hover.part === 'taskbar' && this.hoverX < 48)) { g.fillStyle = 'rgba(61,174,233,0.4)'; g.fillRect(4, y + 4, 40, 40); }
    g.fillStyle = '#EAF2F8';
    g.fillRect(14, y + 14, 6, 20); g.fillRect(28, y + 14, 6, 20); g.fillRect(20, y + 20, 8, 6);
    if (this.menu) { g.fillStyle = ACCENT; g.fillRect(8, y + 45, 32, 2); }
    // tasks
    const tasks = this.tasks();
    g.font = '500 13px Inter, "Instrument Sans", system-ui, sans-serif';
    tasks.forEach((t, i) => {
      const tx = 56 + i * 176;
      if (tx + 170 > this.W - 140) return;
      const active = this.focused === t.id && !t.min;
      g.fillStyle = active ? 'rgba(61,174,233,0.20)' : 'rgba(255,255,255,0.05)';
      rr(g, tx, y + 6, 170, 36, 6); g.fill();
      if (active) { g.fillStyle = ACCENT; g.fillRect(tx + 6, y + 44, 158, 3); }
      g.fillStyle = t.min ? '#8C9BA6' : '#EAF2F8';
      let s = t.title;
      while (s.length > 1 && g.measureText(s).width > 150) s = s.slice(0, -2) + '…';
      g.fillText(s, tx + 10, y + 29);
    });
    // clock
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    g.textAlign = 'right';
    g.fillStyle = '#EAF2F8'; g.font = '500 15px Inter, "Instrument Sans", system-ui, sans-serif';
    g.fillText(p2(now.getHours()) + ':' + p2(now.getMinutes()), this.W - 16, y + 22);
    g.fillStyle = '#9BAFBC'; g.font = '400 12px Inter, "Instrument Sans", system-ui, sans-serif';
    g.fillText(now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate()), this.W - 16, y + 39);
    g.textAlign = 'left';
  }

  drawMenu(g) {
    const items = this.menuItems();
    const h = 52 + items.length * 30 + 8;
    const top = this.H - TASKBAR - 8 - h;
    g.fillStyle = '#3A4249'; rr(g, 8, top, 220, h, 8); g.fill();
    g.fillStyle = '#1D2125'; rr(g, 9, top + 1, 218, h - 2, 7); g.fill();
    g.fillStyle = ACCENT; g.beginPath(); g.arc(35, top + 27, 15, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#EAF2F8'; g.font = '600 14px Inter, "Instrument Sans", system-ui, sans-serif';
    g.fillText('Minimal-OS', 58, top + 24);
    g.fillStyle = '#9BAFBC'; g.font = '400 12px Inter, "Instrument Sans", system-ui, sans-serif';
    g.fillText('Studio preview', 58, top + 40);
    items.forEach((it, i) => {
      const iy = top + 52 + i * 30;
      g.fillStyle = it.disabled ? '#5C6B74' : '#EAF2F8';
      g.font = '500 13px Inter, "Instrument Sans", system-ui, sans-serif';
      g.fillText(it.label, 22, iy + 20);
    });
  }
}

window.Desktop = Desktop;
})();
