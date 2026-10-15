/*
 * mcc — JavaScript back end (the browser preview).
 *
 * The program runs against an emulated memory (one ArrayBuffer) with the
 * same LP64 layout as the real x86_64 build, so structures handed to the
 * kernel through syscalls have exactly the bytes the kernel expects.
 *
 * Value representation:
 *   integers up to 32 bits, pointers, floats  -> JS numbers
 *   64-bit integers (long, size_t, uint64_t)  -> BigInt
 *   structures                                -> their address
 * Functions that can reach a syscall are generators: a syscall that has
 * to wait (mos_sleep, an empty event queue) yields to the scheduler, so
 * an app's for(;;) loop never blocks the page.
 */
(function (G) {
'use strict';
const MCC = G.MCC;
const { isInt, isFlo, isPtr, isAgg } = MCC.types;
const fail = (tok, msg) => { throw new MCC.CompileError(msg, tok); };

const MEM_BASE = 0x10000;   // first byte of the program image; below it is a guard area

function rep(t) {
  if (t.kind === 'void') return 'v';
  if (t.kind === 'struct' || t.kind === 'union' || t.kind === 'array' || t.kind === 'func') return 'a';
  if (t.kind === 'long') return 'b';
  return 'n';
}

function lit(v, t) {
  if (rep(t) === 'b') return v < 0n ? '(' + v + 'n)' : v + 'n';
  return v < 0n ? '(' + v + ')' : String(v);
}
function flit(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '(-Infinity)';
  if (Object.is(v, -0)) return '(-0)';
  return v < 0 ? '(' + v + ')' : String(v);
}

// normalise a JS number to an integer type of at most 32 bits
function normN(c, t) {
  if (t.kind === 'bool') return '(' + c + ' !== 0 ? 1 : 0)';
  switch (t.size) {
    case 1: return t.unsigned ? '(' + c + ' & 255)' : '(' + c + ' << 24 >> 24)';
    case 2: return t.unsigned ? '(' + c + ' & 65535)' : '(' + c + ' << 16 >> 16)';
    default: return t.unsigned ? '(' + c + ' >>> 0)' : '(' + c + ' | 0)';
  }
}

function access(t) {
  if (t.kind === 'ptr') return null;
  if (t.kind === 'bool') return ['U8', 0];
  if (t.kind === 'float') return ['F32', 2];
  if (t.kind === 'double') return ['F64', 3];
  switch (t.size) {
    case 1: return [t.unsigned ? 'U8' : 'I8', 0];
    case 2: return [t.unsigned ? 'U16' : 'I16', 1];
    case 4: return [t.unsigned ? 'U32' : 'I32', 2];
    case 8: return [t.unsigned ? 'U64' : 'I64', 3];
  }
  throw new Error('no access for ' + t.kind);
}
function load(t, a) {
  if (t.kind === 'ptr') return '$lp(' + a + ')';
  const [arr, sh] = access(t);
  return arr + '[' + (sh ? '(' + a + ') >> ' + sh : a) + ']';
}
function store(t, a, v) {
  if (t.kind === 'ptr') return '$sp(' + a + ', ' + v + ')';
  const [arr, sh] = access(t);
  return '(' + arr + '[' + (sh ? '(' + a + ') >> ' + sh : a) + '] = ' + v + ')';
}

class JSGen {
  constructor(prog, opts) {
    this.prog = prog;
    this.opts = opts || {};
    this.out = [];
  }

  compile() {
    const R = MCC.reach(this.prog);
    this.funcs = R.funcs;
    this.globals = R.globals;
    this.fnames = new Map();
    this.funcs.forEach((f, i) => this.fnames.set(f, 'f' + i + '_' + f.name.replace(/[^A-Za-z0-9_]/g, '_')));
    this.analyseYields();
    this.layoutGlobals();
    const table = [];   // function pointer table
    this.fidx = new Map();
    const fnIndex = (f) => {
      f = MCC.realFunc(f);
      if (!this.fidx.has(f)) { this.fidx.set(f, table.length + 1); table.push(f); }
      return this.fidx.get(f);
    };
    this.fnIndex = fnIndex;
    const bodies = this.funcs.map(f => this.genFunc(f));
    const image = this.buildImage();
    const lines = [];
    lines.push('"use strict";');
    lines.push('const {I8,U8,I16,U16,I32,U32,I64,U64,F32,F64,$lp,$sp,$memcpy,$memset,$memmove,$memcmp,$trap,$sys,$SUSPEND,$f2l,$f2ul,$i2p,$divi,$divu,$modi,$modu,$divl,$modl,$call} = rt;');
    lines.push('let SP = rt.stackTop; const SPMIN = rt.stackLimit;');
    lines.push(bodies.join('\n'));
    lines.push('const $F = [null' + table.map(f => ', ' + this.fnames.get(f)).join('') + '];');
    lines.push('const $FK = [0' + table.map(f => ', ' + (this.yields.has(f) ? 1 : 0)).join('') + '];');
    lines.push('rt.$F = $F; rt.$FK = $FK;');
    lines.push('return { main: ' + this.fnames.get(MCC.realFunc(this.prog.main)) + ', mainIsGen: ' + this.yields.has(MCC.realFunc(this.prog.main)) +
      ', getSP: () => SP, setSP: (v) => { SP = v; } };');
    return { code: lines.join('\n'), image, imageBase: MEM_BASE, imageEnd: this.dataEnd };
  }

  analyseYields() {
    const ys = new Set();
    const direct = new Map();
    const scan = (f) => {
      const callees = new Set();
      let self = false;
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n.k === 'syscall') self = true;
        if (n.k === 'call') { if (n.f.k === 'func') callees.add(MCC.realFunc(n.f.fn)); else self = true; }
        for (const key in n) {
          if (MCC.SKIP_KEYS.has(key)) continue;
          const v = n[key];
          if (v && typeof v === 'object') walk(v);
        }
        if ((n.k === 'compound' || n.k === 'init') && n.init) n.init.entries.forEach(en => en.expr && walk(en.expr));
      };
      walk(f.body);
      direct.set(f, callees);
      if (self) ys.add(f);
    };
    this.funcs.forEach(scan);
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of this.funcs) {
        if (ys.has(f)) continue;
        for (const c of direct.get(f)) if (ys.has(c)) { ys.add(f); changed = true; break; }
      }
    }
    this.yields = ys;
  }

  layoutGlobals() {
    let off = MEM_BASE;
    for (const o of this.globals) {
      const a = Math.max(o.type.align, o.type.size >= 16 ? 16 : 1);
      off = Math.ceil(off / a) * a;
      o.jsAddr = off;
      off += Math.max(o.type.size, 1);
    }
    this.dataEnd = Math.ceil(off / 16) * 16;
  }

  buildImage() {
    const size = this.dataEnd - MEM_BASE;
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    for (const o of this.globals) {
      if (!o.init) continue;
      const base = o.jsAddr - MEM_BASE;
      for (const en of o.init.entries) {
        if (en.bytes) { u8.set(en.bytes.slice(0, o.type.size - en.off), base + en.off); continue; }
        if (isAgg(en.ty)) fail(en.expr.tok, 'initializer element is not a compile-time constant');
        const v = MCC.evalInitConst(en.expr);
        const at = base + en.off;
        if (v.kind === 'addr') {
          let addr;
          if (v.fn) addr = this.fnIndex(v.fn) + v.add;
          else addr = MCC.realObj(v.obj).jsAddr + v.add;
          if (en.ty.size !== 8) fail(en.expr.tok, 'initializer element is not a compile-time constant');
          dv.setBigUint64(at, BigInt(addr), true);
          continue;
        }
        if (en.ty.kind === 'float') { dv.setFloat32(at, Number(v.val), true); continue; }
        if (en.ty.kind === 'double') { dv.setFloat64(at, Number(v.val), true); continue; }
        let iv = v.kind === 'float' ? BigInt(Math.trunc(v.val)) : v.val;
        iv = BigInt.asUintN(64, iv);
        for (let i = 0; i < en.ty.size; i++) { u8[at + i] = Number(iv & 255n); iv >>= 8n; }
      }
    }
    return u8;
  }

  // =================================================================
  //  Functions
  // =================================================================
  genFunc(f) {
    this.f = f;
    this.tmp = 0;
    this.frame = 0;
    this.jsLocals = [];
    const isGen = this.yields.has(f);
    this.isGen = isGen;
    const name = this.fnames.get(f);
    const params = [];
    const ft = f.type;
    this.retAgg = isAgg(ft.ret);
    if (this.retAgg) params.push('$rp');
    // decide where each local lives
    const memLocals = [];
    for (const o of f.locals) {
      const inMem = o.addrTaken || isAgg(o.type) || o.type.kind === 'array';
      o.jsMem = inMem;
      o.jsIn = !!o.noCopy;     // a class argument the caller already copied: use it in place
      if (inMem && !o.jsIn) memLocals.push(o);
      o.jsName = (o.isParam ? 'p' : 'v') + o.id + (o.name ? '_' + o.name : '');
    }
    for (const o of memLocals) {
      const a = Math.max(o.type.align, 1);
      this.frame = Math.ceil(this.frame / a) * a;
      o.jsOff = this.frame;
      this.frame += Math.max(o.type.size, 1);
    }
    f.params.forEach(p => params.push(p.jsMem ? '$in_' + p.jsName : p.jsName));
    if (ft.variadic) params.push('$va');
    const body = [];
    this.retLabel = null;
    for (const p of f.params) {
      if (!p.jsMem || p.jsIn) continue;
      const addr = this.localAddr(p);
      if (isAgg(p.type)) body.push('$memcpy(' + addr + ', $in_' + p.jsName + ', ' + p.type.size + ');');
      else body.push(store(p.type, addr, '$in_' + p.jsName) + ';');
    }
    const stmts = this.stmt(f.body);
    body.push(stmts);
    const rt = ft.ret;
    if (rt.kind !== 'void') body.push('return ' + (f.isMain ? lit(0n, rt) : this.retAgg ? '$rp' : this.zero(rt)) + ';');
    const decl = [];
    const jsVars = f.locals.filter(o => !o.jsMem && !o.isParam);
    if (jsVars.length) decl.push('let ' + jsVars.map(o => o.jsName + ' = ' + this.zero(o.type)).join(', ') + ';');
    if (this.tmp) decl.push('let ' + Array.from({ length: this.tmp }, (_, i) => '$t' + i).join(', ') + ';');
    const frameSize = Math.ceil(this.frame / 16) * 16;
    let code;
    if (frameSize) {
      code = decl.join('\n') + '\nconst $sp0 = SP; const $fp = SP = SP - ' + frameSize + ';\n' +
        'if ($fp < SPMIN) { SP = $sp0; $trap("stack overflow in ' + f.name + '"); }\n' +
        'try {\n' + body.join('\n') + '\n} finally { SP = $sp0; }';
    } else code = decl.join('\n') + '\n' + body.join('\n');
    return 'function' + (isGen ? '*' : '') + ' ' + name + '(' + params.join(', ') + ') {\n' + code + '\n}';
  }

  zero(t) {
    const r = rep(t);
    return r === 'b' ? '0n' : '0';
  }

  t() { return '$t' + (this.tmp++); }
  localAddr(o) { return o.jsIn ? '$in_' + o.jsName : '($fp + ' + o.jsOff + ')'; }

  // =================================================================
  //  Statements
  // =================================================================
  stmt(s) {
    switch (s.k) {
      case 'block': return '{\n' + s.items.map(x => this.stmt(x)).join('\n') + '\n}';
      case 'empty': return ';';
      case 'expr': return this.expr(s.e, true) + ';';
      case 'decl': return '';
      case 'init': return this.initLocal(s.obj, s.init) + ';';
      case 'if': return 'if (' + this.truth(s.c) + ') ' + this.stmt(s.a) + (s.b ? ' else ' + this.stmt(s.b) : '');
      case 'while': return 'while (' + this.truth(s.c) + ') ' + this.stmt(s.body);
      case 'dowhile': return 'do ' + this.stmt(s.body) + ' while (' + this.truth(s.c) + ');';
      case 'for': {
        const init = s.init ? (s.init.k === 'expr' ? this.expr(s.init.e, true) + ';' : this.stmt(s.init)) : '';
        return '{ ' + init + ' for (; ' + (s.c ? this.truth(s.c) : '') + '; ' + (s.step ? this.expr(s.step, true) : '') + ') ' + this.stmt(s.body) + ' }';
      }
      case 'switch': return 'switch (' + this.expr(s.e) + ') ' + this.stmt(s.body);
      case 'case': return s.vals.map(v => 'case ' + lit(v, s.ty) + ':').join(' ');
      case 'default': return 'default:';
      case 'break': return 'break;';
      case 'continue': return 'continue;';
      case 'return': {
        const isMain = !!this.f.isMain;
        if (!s.e && s.agg) return 'return $rp;';
        if (!s.e) return 'return' + (s.missing ? ' ' + (isMain ? '0' : this.zero(this.f.type.ret)) : '') + ';';
        if (this.retAgg) return 'return $memcpy($rp, ' + this.expr(s.e) + ', ' + this.f.type.ret.size + ');';
        return 'return ' + this.expr(s.e) + ';';
      }
    }
    throw new Error('stmt ' + s.k);
  }

  initLocal(o, init) {
    const parts = [];
    const addr = o.jsMem ? this.localAddr(o) : null;
    if (!o.jsMem) {
      const en = init.entries[0];
      if (!en) return o.jsName + ' = ' + this.zero(o.type);
      return o.jsName + ' = ' + this.expr(en.expr);
    }
    if (!(init.entries.length === 1 && init.entries[0].ty && !isAgg(init.entries[0].ty) && init.entries[0].ty.size === o.type.size))
      if (!(init.entries.length === 1 && init.entries[0].ty && isAgg(init.entries[0].ty) && init.entries[0].ty.size === o.type.size))
        parts.push('$memset(' + addr + ', 0, ' + o.type.size + ')');
    for (const en of init.entries) {
      const at = '(' + addr + ' + ' + en.off + ')';
      if (en.bytes) {
        const b = en.bytes.slice(0, o.type.size - en.off);
        parts.push('U8.set([' + b.join(',') + '], ' + at + ')');
      } else if (isAgg(en.ty)) parts.push('$memcpy(' + at + ', ' + this.expr(en.expr) + ', ' + en.ty.size + ')');
      else parts.push(store(en.ty, at, this.expr(en.expr)));
    }
    return parts.join(', ');
  }

  // =================================================================
  //  Expressions
  // =================================================================
  truth(e) {
    const c = this.expr(e);
    const r = rep(e.ty);
    if (r === 'b') return '(' + c + ' !== 0n)';
    if (isFlo(e.ty)) return '(' + c + ' !== 0)';
    return c;
  }

  // integer-typed expression as a JS number when that is exact and cheap
  numView(e) {
    if (e.k === 'num') return lit(BigInt.asIntN(64, e.val), MCC.T.int);
    if (e.k === 'cast' && isInt(e.e.ty) && rep(e.e.ty) === 'n') return this.expr(e.e);
    if (e.k === 'pdiff') return '(((' + this.expr(e.a) + ') - (' + this.expr(e.b) + ')) / ' + e.size + ')';
    if (rep(e.ty) === 'n') return this.expr(e);
    return null;
  }

  conv(c, from, to, node) {
    if (to.kind === 'void') return c;
    const rf = rep(from), rt = rep(to);
    if (to.kind === 'bool') return rf === 'b' ? '(' + c + ' !== 0n ? 1 : 0)' : '(' + c + ' !== 0 ? 1 : 0)';
    if (isFlo(from)) {
      if (to.kind === 'double') return c;
      if (to.kind === 'float') return from.kind === 'float' ? c : 'Math.fround(' + c + ')';
      if (rt === 'b') return (to.unsigned ? '$f2ul(' : '$f2l(') + c + ')';
      if (isPtr(to)) return '$i2p($f2l(' + c + '))';
      if (to.size === 4 && to.unsigned) return '(' + c + ' >>> 0)';
      return normN('(' + c + ' | 0)', to);
    }
    if (rf === 'n') {
      if (isFlo(to)) return to.kind === 'float' && from.size === 4 && !isPtr(from) ? 'Math.fround(' + c + ')' : c;
      if (rt === 'b') {
        if (!isPtr(from) && !from.unsigned && to.unsigned) return 'BigInt.asUintN(64, BigInt(' + c + '))';
        return 'BigInt(' + c + ')';
      }
      if (isPtr(to)) {
        if (isPtr(from) || from.unsigned) return c;
        return '$i2p(' + c + ')';
      }
      // narrower or equal int
      if (!isPtr(from) && isInt(from)) {
        if (from.size < to.size && (!from.unsigned || to.unsigned || to.size > from.size)) {
          // widening: value already fits, except signed -> unsigned
          if (!from.unsigned && to.unsigned) return normN(c, to);
          return c;
        }
        if (from.size === to.size && !!from.unsigned === !!to.unsigned) return c;
      }
      return normN(c, to);
    }
    if (rf === 'b') {
      if (rt === 'b') {
        if (!!from.unsigned === !!to.unsigned) return c;
        return (to.unsigned ? 'BigInt.asUintN(64, ' : 'BigInt.asIntN(64, ') + c + ')';
      }
      if (isFlo(to)) return to.kind === 'float' ? 'Math.fround(Number(' + c + '))' : 'Number(' + c + ')';
      if (isPtr(to)) return 'Number(BigInt.asUintN(64, ' + c + '))';
      if (node) {
        const nv = this.numView(node);
        if (nv !== null && node.k !== 'num') return normN(nv, to);
      }
      const bits = to.kind === 'bool' ? 1 : to.size * 8;
      return '(Number(BigInt.as' + (to.unsigned ? 'Uint' : 'Int') + 'N(' + bits + ', ' + c + ')))';
    }
    if (rf === 'a') return c;
    throw new Error('conv ' + from.kind + ' -> ' + to.kind);
  }

  // arithmetic on already-converted operands of type t
  arith(op, a, b, t) {
    const r = rep(t);
    if (isFlo(t)) {
      const e = '(' + a + ' ' + op + ' ' + b + ')';
      return t.kind === 'float' ? 'Math.fround' + e : e;
    }
    if (r === 'b') {
      const w = (x) => (t.unsigned ? 'BigInt.asUintN(64, ' : 'BigInt.asIntN(64, ') + x + ')';
      switch (op) {
        case '+': case '-': case '*': return w(a + ' ' + op + ' ' + b);
        case '/': return '$divl(' + a + ', ' + b + ')';
        case '%': return '$modl(' + a + ', ' + b + ')';
        case '&': case '|': case '^': return w(a + ' ' + op + ' ' + b);
        case '<<': return w(a + ' << BigInt((' + b + ') & 63)');
        case '>>': return '(' + a + ' >> BigInt((' + b + ') & 63))';
      }
    }
    // 32-bit ints (operands promoted, so int or unsigned int)
    const u = t.unsigned;
    switch (op) {
      case '+': return u ? '((' + a + ' + ' + b + ') >>> 0)' : '((' + a + ' + ' + b + ') | 0)';
      case '-': return u ? '((' + a + ' - ' + b + ') >>> 0)' : '((' + a + ' - ' + b + ') | 0)';
      case '*': return u ? '(Math.imul(' + a + ', ' + b + ') >>> 0)' : 'Math.imul(' + a + ', ' + b + ')';
      case '/': return (u ? '$divu(' : '$divi(') + a + ', ' + b + ')';
      case '%': return (u ? '$modu(' : '$modi(') + a + ', ' + b + ')';
      case '&': return u ? '((' + a + ' & ' + b + ') >>> 0)' : '(' + a + ' & ' + b + ')';
      case '|': return u ? '((' + a + ' | ' + b + ') >>> 0)' : '(' + a + ' | ' + b + ')';
      case '^': return u ? '((' + a + ' ^ ' + b + ') >>> 0)' : '(' + a + ' ^ ' + b + ')';
      case '<<': return u ? '((' + a + ' << ' + b + ') >>> 0)' : '(' + a + ' << ' + b + ')';
      case '>>': return u ? '(' + a + ' >>> ' + b + ')' : '(' + a + ' >> ' + b + ')';
    }
    throw new Error('op ' + op);
  }

  // lvalue: {get, set(v), setup} with the address evaluated once
  lval(e) {
    if (e.k === 'var' && e.obj.local && !e.obj.jsMem) {
      const n = e.obj.jsName;
      return { setup: '', get: n, set: (v) => '(' + n + ' = ' + v + ')' };
    }
    const a = this.addr(e);
    if (/^[\w$]+$|^\(\$fp \+ \d+\)$|^\d+$/.test(a)) {
      return { setup: '', get: load(e.ty, a), set: (v) => store(e.ty, a, v), addr: a };
    }
    const t = this.t();
    return { setup: t + ' = ' + a + ', ', get: load(e.ty, t), set: (v) => store(e.ty, t, v), addr: t };
  }

  addr(e) {
    switch (e.k) {
      case 'var': {
        const o = MCC.realObj(e.obj);
        if (o.local) {
          if (!o.jsMem) fail(e.tok, 'internal: address of register variable');
          return this.localAddr(o);
        }
        return String(o.jsAddr);
      }
      case 'deref': return this.expr(e.e);
      case 'member': {
        const b = this.addr(e.e);
        return e.mem.offset ? '(' + b + ' + ' + e.mem.offset + ')' : b;
      }
      case 'compound': return '(' + this.initLocal(e.obj, e.init) + ', ' + this.localAddr(e.obj) + ')';
      case 'call': case 'cond': case 'comma': case 'assign': case 'va_arg':
        if (isAgg(e.ty)) return this.expr(e);
        break;
    }
    fail(e.tok, 'internal: not an lvalue (' + e.k + ')');
  }

  callArgs(n) {
    return n.args.map(a => this.expr(a));
  }

  expr(e, discard) {
    const ty = e.ty;
    switch (e.k) {
      case 'num': return lit(e.val, ty);
      case 'fnum': return flit(e.val);
      case 'var': {
        const o = MCC.realObj(e.obj);
        if (ty.kind === 'array' || isAgg(ty)) return this.addr(e);
        if (o.local && !o.jsMem) return o.jsName;
        return load(ty, this.addr(e));
      }
      case 'func': return String(this.fnIndex(e.fn));
      case 'decay': return this.addr(e.e);
      case 'addr':
        if (e.e.k === 'func') return String(this.fnIndex(e.e.fn));
        return this.addr(e.e);
      case 'deref': case 'member':
        if (ty.kind === 'array' || isAgg(ty)) return this.addr(e);
        return load(ty, this.addr(e));
      case 'compound': {
        const a = this.addr(e);
        if (ty.kind === 'array' || isAgg(ty)) return a;
        return load(ty, a);
      }
      case 'cast': {
        if (ty.kind === 'void') return this.expr(e.e, discard);
        if (e.e.k === 'pdiff' && rep(ty) === 'n' && isInt(ty)) return normN('(' + this.numView(e.e) + ')', ty);
        return this.conv(this.expr(e.e), e.e.ty, ty, e.e);
      }
      case 'neg': {
        const a = this.expr(e.e);
        if (isFlo(ty)) return '(-' + a + ')';
        if (rep(ty) === 'b') return (ty.unsigned ? 'BigInt.asUintN(64, -' : 'BigInt.asIntN(64, -') + a + ')';
        return ty.unsigned ? '((-' + a + ') >>> 0)' : '((-' + a + ') | 0)';
      }
      case 'bitnot': {
        const a = this.expr(e.e);
        if (rep(ty) === 'b') return (ty.unsigned ? 'BigInt.asUintN(64, ~' : 'BigInt.asIntN(64, ~') + a + ')';
        return ty.unsigned ? '((~' + a + ') >>> 0)' : '(~' + a + ')';
      }
      case 'not': return '(' + this.truth(e.e) + ' ? 0 : 1)';
      case 'logand': return '(' + this.truth(e.a) + ' && ' + this.truth(e.b) + ' ? 1 : 0)';
      case 'logor': return '(' + this.truth(e.a) + ' || ' + this.truth(e.b) + ' ? 1 : 0)';
      case 'bin': return this.arith(e.op, this.expr(e.a), this.expr(e.b), ty);
      case 'cmp': {
        const op = e.op === '==' ? '===' : e.op === '!=' ? '!==' : e.op;
        return '(' + this.expr(e.a) + ' ' + op + ' ' + this.expr(e.b) + ' ? 1 : 0)';
      }
      case 'padd': case 'psub': {
        const idx = this.numView(e.b);
        const i = idx !== null ? idx : 'Number(' + this.expr(e.b) + ')';
        const a = this.expr(e.a);
        if (e.b.k === 'num') {
          const k = Number(BigInt.asIntN(64, e.b.val)) * e.size * (e.k === 'padd' ? 1 : -1);
          return k === 0 ? a : '(' + a + ' + ' + k + ')';
        }
        return '(' + a + (e.k === 'padd' ? ' + ' : ' - ') + (e.size === 1 ? i : '(' + i + ') * ' + e.size) + ')';
      }
      case 'pdiff': return 'BigInt(Math.trunc((' + this.expr(e.a) + ' - ' + this.expr(e.b) + ') / ' + e.size + '))';
      case 'assign': {
        if (isAgg(ty)) {
          const dst = this.addr(e.lhs);
          return '$memcpy(' + dst + ', ' + this.expr(e.rhs) + ', ' + ty.size + ')';
        }
        const lv = this.lval(e.lhs);
        return '(' + lv.setup + lv.set(this.expr(e.rhs)) + ')';
      }
      case 'opassign': {
        const lv = this.lval(e.lhs);
        const L = e.lhs.ty, O = e.opTy;
        let v;
        if (e.op === 'padd' || e.op === 'psub') {
          const size = L.base.kind === 'void' ? 1 : L.base.size;
          const idx = this.numView(e.rhs);
          const i = idx !== null ? idx : 'Number(' + this.expr(e.rhs) + ')';
          v = '(' + lv.get + (e.op === 'padd' ? ' + ' : ' - ') + '(' + i + ') * ' + size + ')';
        } else {
          v = this.conv(this.arith(e.op, this.conv(lv.get, L, O), this.expr(e.rhs), O), O, L);
        }
        return '(' + lv.setup + lv.set(v) + ')';
      }
      case 'incdec': {
        const lv = this.lval(e.e);
        const L = ty;
        let nv;
        const cur = discard || e.pre ? lv.get : null;
        const make = (x) => {
          if (isPtr(L)) return '(' + x + (e.inc ? ' + ' : ' - ') + e.size + ')';
          if (L.kind === 'bool') return e.inc ? '1' : '(' + x + ' !== 0 ? 0 : 1)';
          if (isFlo(L)) return L.kind === 'float' ? 'Math.fround(' + x + (e.inc ? ' + 1)' : ' - 1)') : '(' + x + (e.inc ? ' + 1)' : ' - 1)');
          if (rep(L) === 'b') return (L.unsigned ? 'BigInt.asUintN(64, ' : 'BigInt.asIntN(64, ') + x + (e.inc ? ' + 1n)' : ' - 1n)');
          return normN('(' + x + (e.inc ? ' + 1)' : ' - 1)'), L);
        };
        if (cur !== null) { nv = make(lv.get); return '(' + lv.setup + lv.set(nv) + ')'; }
        const t = this.t();
        return '(' + lv.setup + t + ' = ' + lv.get + ', ' + lv.set(make(t)) + ', ' + t + ')';
      }
      case 'cond': return '(' + this.truth(e.c) + ' ? ' + this.expr(e.a) + ' : ' + this.expr(e.b) + ')';
      case 'comma': return '(' + this.expr(e.a, true) + ', ' + this.expr(e.b, discard) + ')';
      case 'call': return this.call(e);
      case 'syscall': {
        if (!this.isGen) fail(e.tok, 'internal: syscall outside a generator');
        const t = this.t();
        return '(' + t + ' = $sys(' + e.args.map(a => this.expr(a)).join(', ') + '), ' + t + ' === $SUSPEND ? (yield 0) : ' + t + ')';
      }
      case 'va_start': {
        const lv = this.lval(e.ap);
        return '(' + lv.setup + lv.set('$va') + ', 0)';
      }
      case 'va_arg': {
        const lv = this.lval(e.ap);
        const t = this.t();
        return '(' + lv.setup + t + ' = ' + lv.get + ', ' + lv.set(t + ' + 8') + ', ' + load(ty, t) + ')';
      }
      case 'trap': return '$trap("reached __builtin_unreachable/__builtin_trap")';
      case 'retslot': return '$rp';
    }
    throw new Error('expr ' + e.k);
  }

  call(n) {
    const fty = n.fty;
    const args = this.callArgs(n);
    const pre = [];
    const nfixed = n.nfixed;
    const fixed = args.slice(0, nfixed);
    const extra = args.slice(nfixed);
    let post = '';
    const callArgs = [];
    if (isAgg(fty.ret)) {
      callArgs.push(n.retExpr ? this.expr(n.retExpr) : this.localAddr(n.ret));
    }
    if (fty.variadic) {
      // evaluate everything first, then lay the variadic part out in 8-byte slots
      const tf = fixed.map(a => { const t = this.t(); pre.push(t + ' = ' + a); return t; });
      const te = extra.map(a => { const t = this.t(); pre.push(t + ' = ' + a); return t; });
      const area = this.t();
      const size = Math.max(8, te.length * 8);
      pre.push(area + ' = (SP -= ' + size + ')');
      te.forEach((t, i) => {
        const at = area + ' + ' + (i * 8);
        const aty = n.args[nfixed + i].ty;
        if (isFlo(aty)) pre.push('F64[(' + at + ') >> 3] = ' + t);
        else if (rep(aty) === 'b') pre.push((aty.unsigned ? 'U64' : 'I64') + '[(' + at + ') >> 3] = ' + t);
        else if (isPtr(aty)) pre.push('$sp(' + at + ', ' + t + ')');
        else pre.push('I64[(' + at + ') >> 3] = BigInt(' + t + ')');
      });
      callArgs.push(...tf, area);
      post = 'SP += ' + size;
    } else callArgs.push(...fixed);
    let callee, isGen;
    if (n.f.k === 'func') {
      const f = MCC.realFunc(n.f.fn);
      callee = this.fnames.get(f);
      isGen = this.yields.has(f);
      const c = callee + '(' + callArgs.join(', ') + ')';
      const core = isGen ? '(yield* ' + c + ')' : c;
      if (!pre.length) return core;
      const r = this.t();
      return '(' + pre.join(', ') + ', ' + r + ' = ' + core + ', ' + post + ', ' + r + ')';
    }
    // indirect call through a function pointer
    if (!this.isGen) fail(n.tok, 'internal: indirect call outside a generator');
    const fp = this.t();
    pre.unshift(fp + ' = ' + this.expr(n.f));
    const r = this.t();
    const c = '$call(' + fp + ')(' + callArgs.join(', ') + ')';
    const core = '($FK[' + fp + '] ? (yield* ' + c + ') : ' + c + ')';
    return '(' + pre.join(', ') + ', ' + r + ' = ' + core + (post ? ', ' + post : '') + ', ' + r + ')';
  }
}

function compileJS(files, sdk, opts) {
  const prog = MCC.parseProject(files, sdk, opts);
  return new JSGen(prog, opts).compile();
}

MCC.compileJS = compileJS;
MCC.JS_MEM_BASE = MEM_BASE;
})(typeof self !== 'undefined' ? self : globalThis);
