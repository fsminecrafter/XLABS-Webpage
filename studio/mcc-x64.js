/*
 * mcc — x86_64 back end. Produces the main.elf that goes into a .run.
 *
 * The output follows the SDK's link.ld rules: a position-independent ELF64
 * (ET_DYN) linked at address 0, no external symbols, and only
 * R_X86_64_RELATIVE relocations (for pointers stored in initialised data),
 * found through PT_DYNAMIC exactly as Minimal-OS's elfloader.c reads them.
 *
 * Code generation is a straightforward stack machine: every expression
 * leaves its value in rax (integers, pointers, structure addresses) or xmm0
 * (float/double). Integers in rax are always sign- or zero-extended to 64
 * bits according to their type.
 *
 * Calling convention (internal; nothing outside the program calls it
 * except the kernel calling _start and cleanup callbacks, which take no
 * arguments): every argument occupies one 8-byte stack slot, argument 0 at
 * the lowest address; structures are passed by address and copied by the
 * callee; a structure result is written through a hidden first argument.
 * Variadic arguments simply follow the fixed ones, so va_list is a pointer
 * walking the slots — the same layout the browser preview uses.
 */
(function (G) {
'use strict';
const MCC = G.MCC;
const { isInt, isFlo, isPtr, isAgg } = MCC.types;
const fail = (tok, msg) => { throw new MCC.CompileError(msg, tok); };

const RAX = 0, RCX = 1, RDX = 2, RBX = 3, RSP = 4, RBP = 5, RSI = 6, RDI = 7;
const CC = { o: 0, b: 2, ae: 3, e: 4, ne: 5, be: 6, a: 7, s: 8, p: 0xA, np: 0xB, l: 0xC, ge: 0xD, le: 0xE, g: 0xF };

// ---------------------------------------------------------------------
//  Assembler
// ---------------------------------------------------------------------
class Asm {
  constructor() { this.code = []; this.labels = []; this.fix = []; this.symFix = []; }
  get pos() { return this.code.length; }
  b(...xs) { for (const x of xs) this.code.push(x & 255); }
  d32(v) { v = v | 0; this.b(v, v >> 8, v >> 16, v >> 24); }
  d64(v) { v = BigInt.asUintN(64, BigInt(v)); for (let i = 0; i < 8; i++) { this.code.push(Number(v & 255n)); v >>= 8n; } }
  label() { this.labels.push(-1); return this.labels.length - 1; }
  bind(l) { this.labels[l] = this.pos; }
  rel32(l) { this.fix.push({ at: this.pos, label: l }); this.d32(0); }
  symRel(sym, add) { this.symFix.push({ at: this.pos, sym, add: add || 0 }); this.d32(0); }
  // ModRM + optional SIB + disp32 for [base + disp]
  mem(reg, base, disp) {
    this.b(0x80 | ((reg & 7) << 3) | (base & 7));
    if ((base & 7) === RSP) this.b(0x24);
    this.d32(disp);
  }
  rr(reg, rm) { this.b(0xC0 | ((reg & 7) << 3) | (rm & 7)); }

  movImm(r, v) {
    v = BigInt.asIntN(64, BigInt(v));
    if (v >= 0n && v <= 0xffffffffn) { this.b(0xB8 + r); this.d32(Number(v)); }      // mov r32, imm32 (zero-extends)
    else if (v >= -0x80000000n && v < 0n) { this.b(0x48, 0xC7, 0xC0 + r); this.d32(Number(v)); }
    else { this.b(0x48, 0xB8 + r); this.d64(v); }
  }
  mov(dst, src) { this.b(0x48, 0x89); this.rr(src, dst); }
  push(r) { this.b(0x50 + r); }
  pop(r) { this.b(0x58 + r); }
  load64(r, base, d) { this.b(0x48, 0x8B); this.mem(r, base, d); }
  store64(base, d, r) { this.b(0x48, 0x89); this.mem(r, base, d); }
  lea(r, base, d) { this.b(0x48, 0x8D); this.mem(r, base, d); }
  leaRip(r, sym, add) { this.b(0x48, 0x8D, 0x05 | (r << 3)); this.symRel(sym, add); }
  alu(op, dst, src) { this.b(0x48, op); this.rr(src, dst); }   // op: 01 add, 29 sub, 21 and, 09 or, 31 xor, 39 cmp
  addImm(r, v) { if (!v) return; this.b(0x48, 0x81, 0xC0 + r); this.d32(v); }
  subRsp(v) { if (v) { this.b(0x48, 0x81, 0xEC); this.d32(v); } }
  addRsp(v) { if (v) { this.b(0x48, 0x81, 0xC4); this.d32(v); } }
  jmp(l) { this.b(0xE9); this.rel32(l); }
  jcc(cc, l) { this.b(0x0F, 0x80 + cc); this.rel32(l); }
  setcc(cc) { this.b(0x0F, 0x90 + cc, 0xC0); }                   // setcc al
  movzxAl() { this.b(0x0F, 0xB6, 0xC0); }
  test() { this.b(0x48, 0x85, 0xC0); }
  callSym(sym) { this.b(0xE8); this.symRel(sym, 0); }
  ret() { this.b(0xC3); }
  finish() {
    for (const f of this.fix) {
      const target = this.labels[f.label];
      if (target < 0) throw new Error('unbound label');
      const rel = target - (f.at + 4);
      this.code[f.at] = rel & 255; this.code[f.at + 1] = (rel >> 8) & 255; this.code[f.at + 2] = (rel >> 16) & 255; this.code[f.at + 3] = (rel >> 24) & 255;
    }
  }
}

// ---------------------------------------------------------------------
//  Code generator
// ---------------------------------------------------------------------
class X64Gen {
  constructor(prog, opts) {
    this.prog = prog;
    this.opts = opts || {};
    this.a = new Asm();
  }

  compile() {
    const R = MCC.reach(this.prog);
    this.funcs = R.funcs;
    this.globals = R.globals.slice();
    this.fnLabel = new Map();
    for (const f of this.funcs) this.fnLabel.set(f, { kind: 'fn', f });
    const a = this.a;
    // _start(argc, argv): the kernel enters with SysV registers rdi/rsi
    this.startAt = a.pos;
    a.push(RBP); a.mov(RBP, RSP);
    a.b(0x48, 0x83, 0xE4, 0xF0);                 // and rsp, -16
    a.subRsp(16);
    a.store64(RSP, 0, RDI); a.store64(RSP, 8, RSI);
    a.callSym(this.fnLabel.get(MCC.realFunc(this.prog.main)));
    a.mov(RDI, RAX);
    a.movImm(RAX, 2);                            // SYS_EXIT
    this.emitSyscallInsn();
    const spin = a.label(); a.bind(spin); a.jmp(spin);
    this.funcSyms = [];
    for (const f of this.funcs) this.genFunc(f);
    a.finish();
    return this.link();
  }

  emitSyscallInsn() {
    if (this.opts.testHook) { this.a.b(0xFF, 0x15); this.a.symRel({ kind: 'hook' }, 0); }
    else this.a.b(0xCD, 0x80);                   // int 0x80
  }

  // =================================================================
  //  Functions
  // =================================================================
  genFunc(f) {
    const a = this.a;
    this.f = f;
    const sym = this.fnLabel.get(f);
    sym.at = a.pos;
    const ft = f.type;
    this.retAgg = isAgg(ft.ret);
    const hidden = this.retAgg ? 1 : 0;
    // frame layout
    let off = 0;
    f.params.forEach((p, i) => {
      if (p.noCopy) { p.x64ptr = 16 + 8 * (i + hidden); return; }   // caller-owned copy: use in place
      if (isAgg(p.type)) return;
      p.x64 = 16 + 8 * (i + hidden);             // scalars live in their argument slot
    });
    for (const o of f.locals) {
      if (o.isParam && (o.noCopy || !isAgg(o.type))) continue;
      const al = Math.max(1, o.type.align);
      off += Math.max(o.type.size, 1);
      off = Math.ceil(off / al) * al;
      o.x64 = -off;
    }
    const frame = Math.ceil(off / 16) * 16;
    this.vaOffset = 16 + 8 * (f.params.length + hidden);
    a.push(RBP); a.mov(RBP, RSP); a.subRsp(frame);
    f.params.forEach((p, i) => {
      if (!isAgg(p.type) || p.noCopy) return;
      a.load64(RSI, RBP, 16 + 8 * (i + hidden));
      a.lea(RDI, RBP, p.x64);
      this.copy(p.type.size);
    });
    this.breakL = []; this.contL = [];
    this.retL = a.label();
    this.stmt(f.body);
    if (f.isMain) a.movImm(RAX, 0);
    else if (this.retAgg) a.load64(RAX, RBP, 16);
    a.bind(this.retL);
    a.mov(RSP, RBP); a.pop(RBP); a.ret();
    this.funcSyms.push({ name: f.name, at: sym.at, size: a.pos - sym.at });
  }

  // rep movsb with rdi, rsi set; size in bytes
  copy(size) { this.a.movImm(RCX, size); this.a.b(0xF3, 0xA4); }

  // =================================================================
  //  Statements
  // =================================================================
  stmt(s) {
    const a = this.a;
    switch (s.k) {
      case 'block': for (const it of s.items) this.stmt(it); return;
      case 'empty': case 'decl': return;
      case 'expr': this.expr(s.e); return;
      case 'init': this.initLocal(s.obj, s.init); return;
      case 'if': {
        const els = a.label(), end = a.label();
        this.cond(s.c, els);
        this.stmt(s.a);
        if (s.b) { a.jmp(end); a.bind(els); this.stmt(s.b); a.bind(end); }
        else { a.bind(els); a.bind(end); }
        return;
      }
      case 'while': {
        const top = a.label(), end = a.label();
        a.bind(top);
        this.cond(s.c, end);
        this.loop(s.body, end, top);
        a.jmp(top); a.bind(end);
        return;
      }
      case 'dowhile': {
        const top = a.label(), cont = a.label(), end = a.label();
        a.bind(top);
        this.loop(s.body, end, cont);
        a.bind(cont);
        this.cond(s.c, end);
        a.jmp(top); a.bind(end);
        return;
      }
      case 'for': {
        if (s.init) { if (s.init.k === 'expr') this.expr(s.init.e); else this.stmt(s.init); }
        const top = a.label(), cont = a.label(), end = a.label();
        a.bind(top);
        if (s.c) this.cond(s.c, end);
        this.loop(s.body, end, cont);
        a.bind(cont);
        if (s.step) this.expr(s.step);
        a.jmp(top); a.bind(end);
        return;
      }
      case 'switch': {
        const end = a.label();
        const items = s.body.k === 'block' ? s.body.items : [s.body];
        let dflt = end;
        this.expr(s.e);
        for (const it of items) {
          if (it.k === 'case') {
            it.label = a.label();
            for (const v of it.vals) {
              const sv = BigInt.asIntN(64, v);
              if (sv >= -0x80000000n && sv < 0x80000000n) { a.b(0x48, 0x3D); a.d32(Number(sv)); }   // cmp rax, imm32
              else { a.movImm(RDI, sv); a.alu(0x39, RAX, RDI); }
              a.jcc(CC.e, it.label);
            }
          } else if (it.k === 'default') { it.label = a.label(); dflt = it.label; }
        }
        a.jmp(dflt);
        this.breakL.push(end);
        for (const it of items) this.stmt(it);
        this.breakL.pop();
        a.bind(end);
        return;
      }
      case 'case': case 'default': a.bind(s.label); return;
      case 'break': a.jmp(this.breakL[this.breakL.length - 1]); return;
      case 'continue': a.jmp(this.contL[this.contL.length - 1]); return;
      case 'return': {
        if (s.e) {
          this.expr(s.e);
          if (this.retAgg) {
            a.mov(RSI, RAX);
            a.load64(RDI, RBP, 16);
            this.copy(this.f.type.ret.size);
            a.load64(RAX, RBP, 16);
          }
        } else if (s.agg) a.load64(RAX, RBP, 16);
        else if (s.missing) a.movImm(RAX, 0);
        a.jmp(this.retL);
        return;
      }
    }
    throw new Error('stmt ' + s.k);
  }

  loop(body, brk, cont) {
    this.breakL.push(brk); this.contL.push(cont);
    this.stmt(body);
    this.breakL.pop(); this.contL.pop();
  }

  // jump to `falseL` when the scalar expression is zero
  cond(e, falseL) {
    this.expr(e);
    this.toBoolFlags(e.ty);
    this.a.jcc(CC.e, falseL);
  }

  // sets ZF=1 when the value (rax/xmm0) is zero
  toBoolFlags(ty) {
    const a = this.a;
    if (isFlo(ty)) {
      a.b(0x0F, 0x57, 0xC9);                       // xorps xmm1, xmm1
      if (ty.kind === 'double') a.b(0x66);
      a.b(0x0F, 0x2E, 0xC1);                       // ucomis[sd] xmm0, xmm1
      a.setcc(CC.ne); a.b(0x0F, 0x9A, 0xC2);       // setne al; setp dl
      a.b(0x08, 0xD0);                             // or al, dl
      a.b(0x84, 0xC0);                             // test al, al
      return;
    }
    a.test();
  }

  initLocal(o, init) {
    const a = this.a;
    const whole = init.entries.length === 1 && init.entries[0].ty && init.entries[0].ty.size === o.type.size;
    if (!whole) {
      a.lea(RDI, RBP, o.x64);
      a.b(0x31, 0xC0);                             // xor eax, eax
      a.movImm(RCX, o.type.size);
      a.b(0xF3, 0xAA);                             // rep stosb
    }
    for (const en of init.entries) {
      if (en.bytes) {
        const bytes = en.bytes.slice(0, o.type.size - en.off);
        for (let i = 0; i < bytes.length; i += 8) {
          let v = 0n;
          const n = Math.min(8, bytes.length - i);
          for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(bytes[i + k]);
          a.movImm(RAX, v);
          a.lea(RDI, RBP, o.x64 + en.off + i);
          this.storeN(n);
        }
        continue;
      }
      a.lea(RAX, RBP, o.x64 + en.off);
      a.push(RAX);
      this.expr(en.expr);
      a.pop(RDI);
      this.store(en.ty);
    }
  }

  // store the low n bytes of rax to [rdi] (n <= 8)
  storeN(n) {
    const a = this.a;
    let done = 0;
    while (done < n) {
      const left = n - done;
      if (left >= 8) { a.b(0x48, 0x89, 0x87); a.d32(done); done += 8; continue; }
      if (left >= 4) { a.b(0x89, 0x87); a.d32(done); a.b(0x48, 0xC1, 0xE8, 32); done += 4; continue; }  // mov [rdi+d], eax; shr rax, 32
      if (left >= 2) { a.b(0x66, 0x89, 0x87); a.d32(done); a.b(0x48, 0xC1, 0xE8, 16); done += 2; continue; }
      a.b(0x88, 0x87); a.d32(done); a.b(0x48, 0xC1, 0xE8, 8); done += 1;
    }
  }

  // =================================================================
  //  Loads, stores, conversions
  // =================================================================
  load(ty) {
    const a = this.a;
    if (ty.kind === 'array' || isAgg(ty) || ty.kind === 'func') return;
    if (ty.kind === 'float') { a.b(0xF3, 0x0F, 0x10); a.mem(0, RAX, 0); return; }
    if (ty.kind === 'double') { a.b(0xF2, 0x0F, 0x10); a.mem(0, RAX, 0); return; }
    switch (ty.size) {
      case 1: if (ty.unsigned) a.b(0x0F, 0xB6); else a.b(0x48, 0x0F, 0xBE); a.mem(RAX, RAX, 0); return;
      case 2: if (ty.unsigned) a.b(0x0F, 0xB7); else a.b(0x48, 0x0F, 0xBF); a.mem(RAX, RAX, 0); return;
      case 4: if (ty.unsigned) a.b(0x8B); else a.b(0x48, 0x63); a.mem(RAX, RAX, 0); return;
      case 8: a.load64(RAX, RAX, 0); return;
    }
  }

  // store rax/xmm0 to [rdi]
  store(ty) {
    const a = this.a;
    if (isAgg(ty)) { a.mov(RSI, RAX); a.mov(RDX, RDI); this.copy(ty.size); a.mov(RAX, RDX); return; }
    if (ty.kind === 'float') { a.b(0xF3, 0x0F, 0x11); a.mem(0, RDI, 0); return; }
    if (ty.kind === 'double') { a.b(0xF2, 0x0F, 0x11); a.mem(0, RDI, 0); return; }
    switch (ty.size) {
      case 1: a.b(0x88); a.mem(RAX, RDI, 0); return;
      case 2: a.b(0x66, 0x89); a.mem(RAX, RDI, 0); return;
      case 4: a.b(0x89); a.mem(RAX, RDI, 0); return;
      case 8: a.store64(RDI, 0, RAX); return;
    }
  }

  pushVal(ty) {
    const a = this.a;
    if (isFlo(ty)) { a.subRsp(8); a.b(0xF2, 0x0F, 0x11); a.mem(0, RSP, 0); }   // movsd [rsp], xmm0 (bit copy is fine for float too)
    else a.push(RAX);
  }
  popVal(ty, toSecond) {
    // pops into rdi or xmm1 when toSecond, else rax / xmm0
    const a = this.a;
    if (isFlo(ty)) { a.b(0xF2, 0x0F, 0x10); a.mem(toSecond ? 1 : 0, RSP, 0); a.addRsp(8); }
    else a.pop(toSecond ? RDI : RAX);
  }

  // narrow/extend rax to the canonical form of an integer type
  intFix(ty) {
    const a = this.a;
    if (ty.kind === 'bool') { a.test(); a.setcc(CC.ne); a.movzxAl(); return; }
    if (isPtr(ty) || ty.size === 8) return;
    switch (ty.size) {
      case 1: if (ty.unsigned) a.b(0x0F, 0xB6, 0xC0); else a.b(0x48, 0x0F, 0xBE, 0xC0); return;
      case 2: if (ty.unsigned) a.b(0x0F, 0xB7, 0xC0); else a.b(0x48, 0x0F, 0xBF, 0xC0); return;
      case 4: if (ty.unsigned) a.b(0x89, 0xC0); else a.b(0x48, 0x63, 0xC0); return;
    }
  }

  conv(from, to) {
    const a = this.a;
    if (to.kind === 'void') return;
    if (isFlo(from)) {
      const fd = from.kind === 'double';
      if (isFlo(to)) {
        if (from.kind === to.kind) return;
        if (fd) a.b(0xF2, 0x0F, 0x5A, 0xC0); else a.b(0xF3, 0x0F, 0x5A, 0xC0);   // cvtsd2ss / cvtss2sd
        return;
      }
      if (to.kind === 'bool') { this.toBoolFlags(from); a.setcc(CC.ne); a.movzxAl(); return; }
      if (to.size === 8 && to.unsigned) { this.f2u64(fd); return; }
      a.b(fd ? 0xF2 : 0xF3, 0x48, 0x0F, 0x2C, 0xC0);           // cvtts[sd]2si rax, xmm0
      this.intFix(to);
      return;
    }
    if (isFlo(to)) {
      const td = to.kind === 'double';
      if (from.size === 8 && from.unsigned) { this.u64ToF(td); return; }
      a.b(td ? 0xF2 : 0xF3, 0x48, 0x0F, 0x2A, 0xC0);           // cvtsi2s[sd] xmm0, rax
      return;
    }
    if (isAgg(to) || to.kind === 'array') return;
    if (isPtr(to)) return;
    if (to.kind === 'bool') { a.test(); a.setcc(CC.ne); a.movzxAl(); return; }
    if (to.size === 8) return;
    if (!isPtr(from) && from.size < to.size && (from.unsigned || !to.unsigned)) return;
    if (!isPtr(from) && from.size === to.size && !!from.unsigned === !!to.unsigned) return;
    this.intFix(to);
  }

  f2u64(fromDouble) {
    const a = this.a;
    // if x < 2^63 convert directly, else convert x - 2^63 and set the top bit
    const big = a.label(), end = a.label();
    if (fromDouble) { a.movImm(RAX, 0x43E0000000000000n); a.b(0x66, 0x48, 0x0F, 0x6E, 0xC8); a.b(0x66, 0x0F, 0x2E, 0xC1); }
    else { a.movImm(RAX, 0x5F000000); a.b(0x66, 0x0F, 0x6E, 0xC8); a.b(0x0F, 0x2E, 0xC1); }
    a.jcc(CC.ae, big);
    a.b(fromDouble ? 0xF2 : 0xF3, 0x48, 0x0F, 0x2C, 0xC0);
    a.jmp(end);
    a.bind(big);
    a.b(fromDouble ? 0xF2 : 0xF3, 0x0F, 0x5C, 0xC1);           // subs[sd] xmm0, xmm1
    a.b(fromDouble ? 0xF2 : 0xF3, 0x48, 0x0F, 0x2C, 0xC0);
    a.b(0x48, 0x0F, 0xBA, 0xF8, 63);                          // btc rax, 63
    a.bind(end);
  }

  u64ToF(toDouble) {
    const a = this.a;
    const neg = a.label(), end = a.label();
    const p = toDouble ? 0xF2 : 0xF3;
    a.test(); a.jcc(CC.s, neg);
    a.b(p, 0x48, 0x0F, 0x2A, 0xC0); a.jmp(end);
    a.bind(neg);
    a.mov(RDI, RAX); a.b(0x48, 0xD1, 0xEF);                   // shr rdi, 1
    a.b(0x83, 0xE0, 0x01);                                    // and eax, 1
    a.alu(0x09, RDI, RAX);                                    // or rdi, rax
    a.b(p, 0x48, 0x0F, 0x2A, 0xC7);                           // cvtsi2s[sd] xmm0, rdi
    a.b(p, 0x0F, 0x58, 0xC0);                                 // adds[sd] xmm0, xmm0
    a.bind(end);
  }

  // =================================================================
  //  Expressions
  // =================================================================
  addr(e) {
    const a = this.a;
    switch (e.k) {
      case 'var': {
        const o = MCC.realObj(e.obj);
        if (o.x64ptr !== undefined) { a.load64(RAX, RBP, o.x64ptr); return; }
        if (o.local) { a.lea(RAX, RBP, o.x64); return; }
        a.leaRip(RAX, { kind: 'obj', o }, 0);
        return;
      }
      case 'deref': this.expr(e.e); return;
      case 'member': this.addr(e.e); a.addImm(RAX, e.mem.offset); return;
      case 'compound': this.initLocal(e.obj, e.init); a.lea(RAX, RBP, e.obj.x64); return;
      case 'func': a.leaRip(RAX, this.fnLabel.get(MCC.realFunc(e.fn)), 0); return;
      default:
        if (isAgg(e.ty)) { this.expr(e); return; }
    }
    fail(e.tok, 'internal: not an lvalue (' + e.k + ')');
  }

  expr(e) {
    const a = this.a;
    const ty = e.ty;
    switch (e.k) {
      case 'num': a.movImm(RAX, e.val); return;
      case 'fnum': {
        if (ty.kind === 'float') { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, e.val, true); a.movImm(RAX, b.getUint32(0, true)); a.b(0x66, 0x0F, 0x6E, 0xC0); }
        else { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, e.val, true); a.movImm(RAX, b.getBigUint64(0, true)); a.b(0x66, 0x48, 0x0F, 0x6E, 0xC0); }
        return;
      }
      case 'var': case 'deref': case 'member': case 'compound':
        this.addr(e); this.load(ty); return;
      case 'func': this.addr(e); return;
      case 'decay': this.addr(e.e); return;
      case 'addr': this.addr(e.e); return;
      case 'cast': this.expr(e.e); this.conv(e.e.ty, ty); return;
      case 'neg':
        this.expr(e.e);
        if (ty.kind === 'double') { a.b(0x66, 0x48, 0x0F, 0x7E, 0xC0); a.b(0x48, 0x0F, 0xBA, 0xF8, 63); a.b(0x66, 0x48, 0x0F, 0x6E, 0xC0); return; }
        if (ty.kind === 'float') { a.b(0x66, 0x0F, 0x7E, 0xC0); a.b(0x35); a.d32(0x80000000); a.b(0x66, 0x0F, 0x6E, 0xC0); return; }
        a.b(0x48, 0xF7, 0xD8); this.intFix(ty); return;
      case 'bitnot': this.expr(e.e); a.b(0x48, 0xF7, 0xD0); this.intFix(ty); return;
      case 'not': this.expr(e.e); this.toBoolFlags(e.e.ty); a.setcc(CC.e); a.movzxAl(); return;
      case 'logand': case 'logor': {
        const short = a.label(), end = a.label();
        this.expr(e.a); this.toBoolFlags(e.a.ty);
        a.jcc(e.k === 'logand' ? CC.e : CC.ne, short);
        this.expr(e.b); this.toBoolFlags(e.b.ty);
        a.jcc(e.k === 'logand' ? CC.e : CC.ne, short);
        a.movImm(RAX, e.k === 'logand' ? 1 : 0); a.jmp(end);
        a.bind(short); a.movImm(RAX, e.k === 'logand' ? 0 : 1);
        a.bind(end);
        return;
      }
      case 'bin': {
        this.expr(e.a); this.pushVal(e.a.ty);
        this.expr(e.b);
        if (isFlo(ty)) { a.b(0x0F, 0x28, 0xC8); this.popVal(ty, false); }   // movaps xmm1, xmm0; pop a -> xmm0
        else { a.mov(RDI, RAX); a.pop(RAX); }
        this.binop(e.op, ty);
        return;
      }
      case 'cmp': {
        const ct = e.a.ty;
        this.expr(e.a); this.pushVal(ct);
        this.expr(e.b);
        if (isFlo(ct)) {
          a.b(0x0F, 0x28, 0xC8); this.popVal(ct, false);
          const dbl = ct.kind === 'double';
          if (e.op === '==' || e.op === '!=') {
            if (dbl) a.b(0x66); a.b(0x0F, 0x2E, 0xC1);                 // ucomis xmm0, xmm1
            if (e.op === '==') { a.setcc(CC.e); a.b(0x0F, 0x9B, 0xC2); a.b(0x20, 0xD0); }   // sete al; setnp dl; and al, dl
            else { a.setcc(CC.ne); a.b(0x0F, 0x9A, 0xC2); a.b(0x08, 0xD0); }
          } else {
            if (dbl) a.b(0x66); a.b(0x0F, 0x2E, 0xC8);                 // ucomis xmm1, xmm0  (b vs a)
            a.setcc(e.op === '<' ? CC.a : CC.ae);
          }
          a.movzxAl();
          return;
        }
        a.mov(RDI, RAX); a.pop(RAX);
        a.alu(0x39, RAX, RDI);
        const uns = isPtr(ct) || ct.unsigned;
        const cc = e.op === '==' ? CC.e : e.op === '!=' ? CC.ne : e.op === '<' ? (uns ? CC.b : CC.l) : (uns ? CC.be : CC.le);
        a.setcc(cc); a.movzxAl();
        return;
      }
      case 'padd': case 'psub': {
        this.expr(e.a); a.push(RAX);
        this.expr(e.b);
        if (e.size !== 1) { a.b(0x48, 0x69, 0xC0); a.d32(e.size); }    // imul rax, rax, size
        a.mov(RDI, RAX); a.pop(RAX);
        a.alu(e.k === 'padd' ? 0x01 : 0x29, RAX, RDI);
        return;
      }
      case 'pdiff': {
        this.expr(e.a); a.push(RAX);
        this.expr(e.b); a.mov(RDI, RAX); a.pop(RAX);
        a.alu(0x29, RAX, RDI);
        if (e.size !== 1) { a.movImm(RDI, e.size); a.b(0x48, 0x99); a.b(0x48, 0xF7, 0xFF); }  // cqo; idiv rdi
        return;
      }
      case 'assign': {
        this.addr(e.lhs); a.push(RAX);
        this.expr(e.rhs);
        a.pop(RDI);
        this.store(ty);
        return;
      }
      case 'opassign': {
        const L = e.lhs.ty, O = e.opTy;
        this.addr(e.lhs); a.push(RAX);
        this.load(L);
        if (e.op === 'padd' || e.op === 'psub') {
          a.push(RAX);
          this.expr(e.rhs);
          const size = L.base.kind === 'void' ? 1 : L.base.size;
          if (size !== 1) { a.b(0x48, 0x69, 0xC0); a.d32(size); }
          a.mov(RDI, RAX); a.pop(RAX);
          a.alu(e.op === 'padd' ? 0x01 : 0x29, RAX, RDI);
        } else {
          this.conv(L, O); this.pushVal(O);
          this.expr(e.rhs);
          if (isFlo(O)) { a.b(0x0F, 0x28, 0xC8); this.popVal(O, false); }
          else { a.mov(RDI, RAX); a.pop(RAX); }
          this.binop(e.op, O);
          this.conv(O, L);
        }
        a.pop(RDI);
        this.store(L);
        return;
      }
      case 'incdec': {
        this.addr(e.e); a.push(RAX);
        this.load(ty);
        if (isFlo(ty)) {
          a.b(0x0F, 0x28, 0xD0);                                       // movaps xmm2, xmm0
          const dbl = ty.kind === 'double';
          if (dbl) { a.movImm(RAX, 0x3FF0000000000000n); a.b(0x66, 0x48, 0x0F, 0x6E, 0xC8); }
          else { a.movImm(RAX, 0x3F800000); a.b(0x66, 0x0F, 0x6E, 0xC8); }
          a.b(dbl ? 0xF2 : 0xF3, 0x0F, e.inc ? 0x58 : 0x5C, 0xC1);
          a.pop(RDI); this.store(ty);
          if (!e.pre) a.b(0x0F, 0x28, 0xC2);                           // movaps xmm0, xmm2
          return;
        }
        a.mov(RDX, RAX);
        if (ty.kind === 'bool') { if (e.inc) a.movImm(RAX, 1); else { a.test(); a.setcc(CC.e); a.movzxAl(); } }
        else { a.addImm(RAX, e.inc ? e.size : -e.size); this.intFix(ty); }
        a.pop(RDI); this.store(ty);
        if (!e.pre) a.mov(RAX, RDX);
        return;
      }
      case 'cond': {
        const els = a.label(), end = a.label();
        this.cond(e.c, els);
        this.expr(e.a); a.jmp(end);
        a.bind(els); this.expr(e.b);
        a.bind(end);
        return;
      }
      case 'comma': this.expr(e.a); this.expr(e.b); return;
      case 'call': this.call(e); return;
      case 'syscall':
        for (const x of e.args) { this.expr(x); a.push(RAX); }
        a.pop(RDX); a.pop(RSI); a.pop(RDI); a.pop(RAX);
        this.emitSyscallInsn();
        return;
      case 'va_start':
        this.addr(e.ap); a.mov(RDI, RAX);
        a.lea(RAX, RBP, this.vaOffset);
        a.store64(RDI, 0, RAX);
        return;
      case 'va_arg':
        this.addr(e.ap); a.mov(RDI, RAX);
        a.load64(RAX, RDI, 0);                                         // rax = cursor
        a.lea(RSI, RAX, 8); a.store64(RDI, 0, RSI);                   // cursor += 8
        this.load(ty);
        return;
      case 'trap': a.b(0x0F, 0x0B); return;                            // ud2
      case 'retslot': a.load64(RAX, RBP, 16); return;
    }
    throw new Error('expr ' + e.k);
  }

  // rax/xmm0 = a op rdi/xmm1
  binop(op, ty) {
    const a = this.a;
    if (isFlo(ty)) {
      const p = ty.kind === 'double' ? 0xF2 : 0xF3;
      const code = { '+': 0x58, '-': 0x5C, '*': 0x59, '/': 0x5E }[op];
      a.b(p, 0x0F, code, 0xC1);
      return;
    }
    const u = ty.unsigned;
    switch (op) {
      case '+': a.alu(0x01, RAX, RDI); break;
      case '-': a.alu(0x29, RAX, RDI); break;
      case '*': a.b(0x48, 0x0F, 0xAF, 0xC7); break;
      case '&': a.alu(0x21, RAX, RDI); break;
      case '|': a.alu(0x09, RAX, RDI); break;
      case '^': a.alu(0x31, RAX, RDI); break;
      case '/': case '%':
        if (u) { a.b(0x31, 0xD2); a.b(0x48, 0xF7, 0xF7); }              // xor edx, edx; div rdi
        else { a.b(0x48, 0x99); a.b(0x48, 0xF7, 0xFF); }                 // cqo; idiv rdi
        if (op === '%') a.mov(RAX, RDX);
        break;
      case '<<': case '>>': {
        a.mov(RCX, RDI);
        const ext = op === '<<' ? 0xE0 : u ? 0xE8 : 0xF8;
        if (ty.size === 8) a.b(0x48, 0xD3, ext); else a.b(0xD3, ext);
        break;
      }
    }
    this.intFix(ty);
  }

  call(n) {
    const a = this.a;
    const fty = n.fty;
    const hidden = isAgg(fty.ret) ? 1 : 0;
    const slots = n.args.length + hidden;
    const direct = n.f.k === 'func';
    if (!direct) { this.expr(n.f); a.push(RAX); }
    a.subRsp(8 * slots);
    n.args.forEach((arg, i) => {
      this.expr(arg);
      const at = 8 * (i + hidden);
      if (isFlo(arg.ty)) { a.b(arg.ty.kind === 'double' ? 0xF2 : 0xF3, 0x0F, 0x11); a.mem(0, RSP, at); }
      else a.store64(RSP, at, RAX);
    });
    if (hidden) { if (n.retExpr) this.expr(n.retExpr); else a.lea(RAX, RBP, n.ret.x64); a.store64(RSP, 0, RAX); }
    if (direct) a.callSym(this.fnLabel.get(MCC.realFunc(n.f.fn)));
    else { a.load64(RAX, RSP, 8 * slots); a.b(0xFF, 0xD0); }          // call rax
    a.addRsp(8 * slots + (direct ? 0 : 8));
    if (isInt(fty.ret)) this.intFix(fty.ret);
  }

  // =================================================================
  //  Linking: layout, relocations, ELF file
  // =================================================================
  link() {
    const a = this.a;
    const HDR = 0x200;                  // ELF header + program headers live before the code
    const textAt = HDR;
    const textEnd = textAt + a.code.length;
    const dataAt = Math.ceil(textEnd / 0x1000) * 0x1000;
    // data: hook slot (tests), initialised objects, then .dynamic and .rela.dyn; then bss
    let off = dataAt;
    const hookAt = off; off += 8;
    const inited = this.globals.filter(o => o.init);
    const zero = this.globals.filter(o => !o.init);
    for (const o of inited) { const al = Math.max(o.type.align, 1); off = Math.ceil(off / al) * al; o.x64addr = off; off += Math.max(o.type.size, 1); }
    off = Math.ceil(off / 8) * 8;
    const dataBytes = new Uint8Array(off - dataAt);
    const dv = new DataView(dataBytes.buffer);
    const relocs = [];
    const fnAddr = (f) => textAt + this.fnLabel.get(MCC.realFunc(f)).at;
    for (const o of inited) {
      const base = o.x64addr - dataAt;
      for (const en of o.init.entries) {
        if (en.bytes) { dataBytes.set(en.bytes.slice(0, o.type.size - en.off), base + en.off); continue; }
        if (isAgg(en.ty)) fail(en.expr.tok, 'initializer element is not a compile-time constant');
        const v = MCC.evalInitConst(en.expr);
        const at = base + en.off;
        if (v.kind === 'addr') {
          if (en.ty.size !== 8) fail(en.expr.tok, 'initializer element is not a compile-time constant');
          // defer: bss objects get their addresses below
          relocs.push({ at: dataAt + at, v });
          continue;
        }
        if (en.ty.kind === 'float') { dv.setFloat32(at, Number(v.val), true); continue; }
        if (en.ty.kind === 'double') { dv.setFloat64(at, Number(v.val), true); continue; }
        let iv = BigInt.asUintN(64, v.kind === 'float' ? BigInt(Math.trunc(v.val)) : v.val);
        for (let i = 0; i < en.ty.size; i++) { dataBytes[at + i] = Number(iv & 255n); iv >>= 8n; }
      }
    }
    const dynAt = off;
    const relaAt = dynAt + 4 * 16;
    const relaSize = relocs.length * 24;
    const fileEnd = relaAt + relaSize;
    let bss = Math.ceil(fileEnd / 16) * 16;
    for (const o of zero) { const al = Math.max(o.type.align, 1); bss = Math.ceil(bss / al) * al; o.x64addr = bss; bss += Math.max(o.type.size, 1); }
    const imageEnd = Math.ceil(bss / 16) * 16;
    // resolve relocation targets
    const target = (v) => (v.fn ? fnAddr(v.fn) : MCC.realObj(v.obj).x64addr) + v.add;
    for (const r of relocs) { r.value = target(r.v); dv.setBigUint64(r.at - dataAt, BigInt(r.value), true); }
    // patch rip-relative references in the code
    for (const f of a.symFix) {
      let t;
      if (f.sym.kind === 'fn') t = textAt + f.sym.at;
      else if (f.sym.kind === 'obj') t = MCC.realObj(f.sym.o).x64addr;
      else if (f.sym.kind === 'hook') t = hookAt;
      const rel = t + f.add - (textAt + f.at + 4);
      a.code[f.at] = rel & 255; a.code[f.at + 1] = (rel >> 8) & 255; a.code[f.at + 2] = (rel >> 16) & 255; a.code[f.at + 3] = (rel >> 24) & 255;
    }
    // section names and symbols (for readelf/objdump; the loader ignores them)
    const shstr = '\0.text\0.data\0.bss\0.dynamic\0.rela.dyn\0.symtab\0.strtab\0.shstrtab\0';
    const nameOf = (s) => shstr.indexOf('\0' + s + '\0') + 1;
    let strtab = '\0';
    const syms = [];
    for (const s of this.funcSyms) { syms.push({ name: strtab.length, value: textAt + s.at, size: s.size, info: 0x12, shndx: 1 }); strtab += s.name + '\0'; }
    syms.push({ name: strtab.length, value: textAt + this.startAt, size: 0, info: 0x12, shndx: 1 }); strtab += '_start\0';
    for (const o of this.globals) {
      if (o.isString) continue;
      syms.push({ name: strtab.length, value: o.x64addr, size: o.type.size, info: 0x11, shndx: o.init ? 2 : 3 });
      strtab += (o.displayName || o.name).replace(/\$.*$/, '') + '\0';
    }
    const strBytes = new TextEncoder().encode(strtab), shBytes = new TextEncoder().encode(shstr);
    const symAt = fileEnd, symSize = 24 * (syms.length + 1);
    const strAt = symAt + symSize, shstrAt = strAt + strBytes.length;
    const shAt = Math.ceil((shstrAt + shBytes.length) / 8) * 8;
    const shnum = 9;
    const total = shAt + shnum * 64;
    const out = new Uint8Array(total);
    const o = new DataView(out.buffer);
    const u16 = (p, v) => o.setUint16(p, v, true), u32 = (p, v) => o.setUint32(p, v >>> 0, true), u64 = (p, v) => o.setBigUint64(p, BigInt(v), true);
    // ELF header
    out.set([0x7F, 0x45, 0x4C, 0x46, 2, 1, 1, 0], 0);
    u16(16, 3); u16(18, 62); u32(20, 1); u64(24, textAt + this.startAt); u64(32, 64); u64(40, shAt);
    u32(48, 0); u16(52, 64); u16(54, 56); u16(56, 3); u16(58, 64); u16(60, shnum); u16(62, 8);
    // program headers
    const ph = (i, type, flags, offset, vaddr, filesz, memsz, align) => {
      const p = 64 + i * 56;
      u32(p, type); u32(p + 4, flags); u64(p + 8, offset); u64(p + 16, vaddr); u64(p + 24, vaddr); u64(p + 32, filesz); u64(p + 40, memsz); u64(p + 48, align);
    };
    ph(0, 1, 5, 0, 0, textEnd, textEnd, 0x1000);                                       // PT_LOAD R+X: headers + .text
    ph(1, 1, 6, dataAt, dataAt, fileEnd - dataAt, imageEnd - dataAt, 0x1000);           // PT_LOAD RW: .data .dynamic .rela.dyn + .bss
    ph(2, 2, 6, dynAt, dynAt, 64, 64, 8);                                                // PT_DYNAMIC
    out.set(a.code, textAt);
    out.set(dataBytes, dataAt);
    // .dynamic: DT_RELA, DT_RELASZ, DT_RELAENT, DT_NULL
    u64(dynAt, 7); u64(dynAt + 8, relaAt);
    u64(dynAt + 16, 8); u64(dynAt + 24, relaSize);
    u64(dynAt + 32, 9); u64(dynAt + 40, 24);
    relocs.forEach((r, i) => { const p = relaAt + i * 24; u64(p, r.at); u64(p + 8, 8); u64(p + 16, r.value); });   // R_X86_64_RELATIVE
    syms.forEach((s, i) => { const p = symAt + 24 * (i + 1); u32(p, s.name); out[p + 4] = s.info; out[p + 5] = 0; u16(p + 6, s.shndx); u64(p + 8, s.value); u64(p + 16, s.size); });
    out.set(strBytes, strAt); out.set(shBytes, shstrAt);
    const sh = (i, name, type, flags, addr, offset, size, link, info, align, entsize) => {
      const p = shAt + i * 64;
      u32(p, name); u32(p + 4, type); u64(p + 8, flags); u64(p + 16, addr); u64(p + 24, offset); u64(p + 32, size); u32(p + 40, link); u32(p + 44, info); u64(p + 48, align); u64(p + 56, entsize);
    };
    sh(1, nameOf('.text'), 1, 6, textAt, textAt, a.code.length, 0, 0, 16, 0);
    sh(2, nameOf('.data'), 1, 3, dataAt, dataAt, dynAt - dataAt, 0, 0, 16, 0);
    sh(3, nameOf('.bss'), 8, 3, Math.ceil(fileEnd / 16) * 16, fileEnd, imageEnd - Math.ceil(fileEnd / 16) * 16, 0, 0, 16, 0);
    sh(4, nameOf('.dynamic'), 6, 3, dynAt, dynAt, 64, 0, 0, 8, 16);
    sh(5, nameOf('.rela.dyn'), 4, 2, relaAt, relaAt, relaSize, 0, 0, 8, 24);
    sh(6, nameOf('.symtab'), 2, 0, 0, symAt, symSize, 7, 1, 8, 24);
    sh(7, nameOf('.strtab'), 3, 0, 0, strAt, strBytes.length, 0, 0, 1, 0);
    sh(8, nameOf('.shstrtab'), 3, 0, 0, shstrAt, shBytes.length, 0, 0, 1, 0);
    return { elf: out, textSize: a.code.length, dataSize: fileEnd - dataAt, bssSize: imageEnd - Math.ceil(fileEnd / 16) * 16, relocs: relocs.length, hookAt, imageEnd, functions: this.funcSyms.length };
  }
}

// MINIRUN1: "MINIRUN1", u32 version, u32 count, then count x {char name[64], u32 offset, u32 size}, then data
function bundleRun(entries) {
  const enc = new TextEncoder();
  const header = 16 + entries.length * 72;
  let size = header;
  for (const e of entries) size += e.data.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set(enc.encode('MINIRUN1'), 0);
  dv.setUint32(8, 1, true); dv.setUint32(12, entries.length, true);
  let off = header;
  entries.forEach((e, i) => {
    const name = enc.encode(e.name);
    if (name.length >= 64) throw new Error('Bundle entry name is too long: ' + e.name);
    const p = 16 + i * 72;
    out.set(name, p);
    dv.setUint32(p + 64, off, true); dv.setUint32(p + 68, e.data.length, true);
    out.set(e.data, off);
    off += e.data.length;
  });
  return out;
}

// MPKG0001 (Minimal-OS tools/mkpkg/mkpkg.py, --store): "MPKG0001", u32 version,
// u32 count, then count x {char name[128], u32 flags, u32 method, u32 size,
// u32 stored size, u32 offset}, then the payloads. Directories have flag 1.
function bundleMpkg(entries) {
  const enc = new TextEncoder();
  entries = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const header = 16 + entries.length * 148;
  let size = header;
  for (const e of entries) if (!e.dir) size += e.data.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set(enc.encode('MPKG0001'), 0);
  dv.setUint32(8, 1, true); dv.setUint32(12, entries.length, true);
  let off = header;
  entries.forEach((e, i) => {
    const name = enc.encode(e.name);
    if (name.length >= 128) throw new Error('entry name too long: ' + e.name);
    const p = 16 + i * 148;
    out.set(name, p);
    dv.setUint32(p + 128, e.dir ? 1 : 0, true);
    dv.setUint32(p + 132, 0, true);
    const n = e.dir ? 0 : e.data.length;
    dv.setUint32(p + 136, n, true); dv.setUint32(p + 140, n, true); dv.setUint32(p + 144, e.dir ? 0 : off, true);
    if (!e.dir) { out.set(e.data, off); off += n; }
  });
  return out;
}

function compileX64(files, sdk, opts) {
  const prog = MCC.parseProject(files, sdk, opts);
  return new X64Gen(prog, opts).compile();
}

MCC.compileX64 = compileX64;
MCC.bundleRun = bundleRun;
MCC.bundleMpkg = bundleMpkg;
})(typeof self !== 'undefined' ? self : globalThis);
