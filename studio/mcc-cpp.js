/*
 * mcc — C++ front end.
 *
 * CppParser extends the C parser for .cpp files. Everything C++ adds is
 * lowered to the same typed syntax tree the C back ends already compile:
 * methods are functions with an explicit `this` pointer, references are
 * pointers that are dereferenced where they are used, constructors and
 * destructors are calls inserted at the right places, virtual calls go
 * through a vtable array, and templates are instantiated by parsing their
 * tokens again with the template parameters bound.
 *
 * Supported: classes and structs with member functions, constructors
 * (with initializer lists and default member initializers), destructors,
 * copy construction and assignment, static members, single inheritance,
 * virtual functions; references; function, method and operator
 * overloading with default arguments; new/delete (also arrays);
 * namespaces and using; enum class; auto; range-based for; nullptr;
 * C++ casts; function and class templates (type and integer parameters).
 * Not supported: exceptions, RTTI, lambdas, rvalue references, multiple
 * inheritance, member templates and template specialisation.
 */
(function (G) {
'use strict';
const MCC = G.MCC;
const { T, typeName } = MCC;
const { ptrTo, arrayOf, funcType, isInt, isFlo, isNum, isPtr, isScalar, isAgg } = MCC.types;
const { KEYWORDS, TYPE_WORDS, sameType, promote, usualArith } = MCC.internal;
const fail = (tok, msg) => { throw new MCC.CompileError(msg, tok); };

const CPP_KEYWORDS = new Set(['class', 'namespace', 'new', 'delete', 'this', 'true', 'false', 'nullptr', 'operator', 'template',
  'typename', 'public', 'private', 'protected', 'virtual', 'friend', 'using', 'bool', 'explicit', 'mutable', 'constexpr',
  'static_cast', 'reinterpret_cast', 'const_cast', 'dynamic_cast', 'noexcept', 'decltype', 'static_assert', 'throw', 'try',
  'catch', 'alignof', 'alignas', 'thread_local', 'typeid', 'export', 'wchar_t', 'char16_t', 'char32_t', 'consteval']);
const SPEC_WORDS = new Set(['class', 'bool', 'typename', 'auto', 'decltype', 'virtual', 'explicit', 'constexpr', 'friend',
  'mutable', 'inline', 'wchar_t', 'thread_local']);
const OPERATORS = ['+', '-', '*', '/', '%', '^', '&', '|', '~', '!', '=', '<', '>', '+=', '-=', '*=', '/=', '%=', '^=', '&=',
  '|=', '<<', '>>', '>>=', '<<=', '==', '!=', '<=', '>=', '&&', '||', '++', '--', ',', '->'];

function refTo(t) { return { kind: 'ptr', size: 8, align: 8, base: t, unsigned: true, ref: true }; }
const AUTO = { kind: 'auto', size: 0, align: 1 };
const isClass = (t) => !!(t && (t.kind === 'struct' || t.kind === 'union') && t.cls);
const isRef = (t) => !!(t && t.kind === 'ptr' && t.ref);
const hasAuto = (t) => !!t && (t.kind === 'auto' || ((t.kind === 'ptr' || t.kind === 'array') && hasAuto(t.base)));
const isDependent = (t) => !!t && (t.kind === 'tparam' || t.kind === 'tdep' ||
  ((t.kind === 'ptr' || t.kind === 'array') && isDependent(t.base)) ||
  (t.kind === 'func' && (isDependent(t.ret) || t.params.some(isDependent))));

function typeKey(t) {
  switch (t.kind) {
    case 'void': return 'v';
    case 'bool': return 'b';
    case 'char': return t.unsigned ? 'h' : 'c';
    case 'short': return t.unsigned ? 't' : 's';
    case 'int': return t.isEnum ? 'E' + (t.enumName || '') : t.unsigned ? 'j' : 'i';
    case 'long': return t.unsigned ? 'm' : 'l';
    case 'float': return 'f';
    case 'double': return 'd';
    case 'ptr': return (t.ref ? 'R' : 'P') + typeKey(t.base);
    case 'array': return 'A' + t.len + '_' + typeKey(t.base);
    case 'func': return 'F' + typeKey(t.ret) + '(' + t.params.map(typeKey).join(',') + ')';
    case 'struct': case 'union': return 'N' + (t.cls ? t.cls.qname : (t.tag || '') + '#' + (t.uid || 0));
    case 'tparam': return 'T' + t.name;
    case 'tdep': return 'D' + t.tmpl.name + '<' + t.args.map(argKey).join(',') + '>';
  }
  return t.kind;
}
function argKey(a) { return a.type && a.value === undefined ? typeKey(a.type) : String(a.value); }
function argText(a) { return a.value !== undefined ? String(a.value) : typeName(a.type); }

class CppParser extends MCC.Parser {
  constructor(toks) {
    super(toks);
    this.cpp = true;
    const root = this.scopes[0];
    this.rootNs = { isNs: true, name: '', qname: '', vars: root.vars, tags: root.tags, usings: [], parent: null };
    root.kind = 'ns';
    root.ns = this.rootNs;
    this.temps = null;
    this.thisObj = null;
    this.fnFrame = -1;
    this.breakFrames = [];
    this.contFrames = [];
    this.noGT = false;
    this.splitGT = -1;
    this.linkC = false;
    this.initFn = null;
    this.rt = {
      alloc: this.runtimeFunc('__mcc_alloc', ptrTo(T.void), [T.ulong]),
      free: this.runtimeFunc('__mcc_free', T.void, [ptrTo(T.void)]),
      arrayCtor: this.runtimeFunc('__mcc_array_ctor', T.void, [ptrTo(T.void), T.ulong, T.ulong, ptrTo(funcType(T.void, [ptrTo(T.void)]))]),
      arrayDtor: this.runtimeFunc('__mcc_array_dtor', T.void, [ptrTo(T.void), T.ulong, T.ulong, ptrTo(funcType(T.void, [ptrTo(T.void)]))]),
    };
  }

  runtimeFunc(name, ret, params) {
    const ft = funcType(ret, params, false);
    ft.paramNames = params.map(() => ({ name: null }));
    const f = { name, qname: name, uname: name, type: ft, defined: false, params: [], locals: [], body: null, id: this.uid++, linkC: true };
    this.funcs.set(name, f);
    return f;
  }

  boolTy() { return T.bool; }
  charTy() { return T.char; }

  ident() {
    const t = this.tok;
    if (t.k !== 'id' || KEYWORDS.has(t.v) || CPP_KEYWORDS.has(t.v)) fail(t, 'expected an identifier' + (t.k === 'eof' ? '' : " before '" + t.v + "'"));
    this.p++;
    return t;
  }

  // =================================================================
  //  Scopes and lookup
  // =================================================================
  push() { this.scopes.push({ kind: 'block', vars: new Map(), tags: new Map(), cleanups: [] }); }
  top() { return this.scopes[this.scopes.length - 1]; }

  currentNs() {
    for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].kind === 'ns') return this.scopes[i].ns;
    return this.rootNs;
  }
  currentClass() {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const f = this.scopes[i];
      if (f.kind === 'class') return f.cls;
      if (f.kind === 'ns' || f.kind === 'fn') return null;
    }
    return null;
  }

  nsLookup(ns, name, seen) {
    if (seen.has(ns)) return null;
    seen.add(ns);
    const v = ns.vars.get(name);
    if (v) return v;
    for (const u of ns.usings) { const r = this.nsLookup(u, name, seen); if (r) return r; }
    return null;
  }

  classMember(ty, name) {
    for (let c = ty; c; c = c.cls.base) {
      const k = c.cls;
      if (k.fieldMap) { const f = k.fieldMap.get(name); if (f) return { field: f, cls: c }; }
      const m = k.methods.get(name); if (m) return { methods: m, cls: c };
      const s = k.statics.get(name); if (s) return s;
      const n = k.nested.get(name); if (n) return n;
    }
    return null;
  }

  findVar(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const f = this.scopes[i];
      if (f.kind === 'class') { const r = this.classMember(f.cls, name); if (r) return r; continue; }
      const v = f.vars.get(name);
      if (v) return v;
      const us = f.ns ? f.ns.usings : f.usings;
      if (us) for (const ns of us) { const r = this.nsLookup(ns, name, new Set()); if (r) return r; }
    }
    return null;
  }

  findTag(name) {
    const v = this.findVar(name);
    return v && v.typedef ? v.type : null;
  }

  declare(name, entry) {
    const f = this.top();
    if (f.kind === 'class') f.cls.cls.nested.set(name, entry);
    else f.vars.set(name, entry);
  }
  declareType(name, ty) { this.declare(name, { typedef: true, type: ty }); }

  lookupIn(owner, name) {
    if (owner.isNs) return this.nsLookup(owner, name, new Set());
    if (isClass(owner)) return this.classMember(owner, name);
    if (owner.enumScope) return owner.enumScope.get(name) || null;
    if (owner.kind === 'tdep' || owner.kind === 'tparam') return { typedef: true, type: { kind: 'tparam', name: name, index: -1, size: 8, align: 8, dep: true } };
    return null;
  }

  // ---- qualified names: [::] a::b<...>::c ----
  qualifiedName(declMode) {
    let owner = null, global = false;
    const first = this.tok;
    if (this.is('::')) { this.next(); owner = this.rootNs; global = true; }
    for (;;) {
      const tok = this.tok;
      if (tok.k === 'id' && tok.v === 'operator') {
        const op = this.operatorName();
        return { entry: owner ? this.lookupIn(owner, op.name) : this.findVar(op.name), name: op.name, owner, tok, global, convType: op.convType };
      }
      if (tok.k === 'punct' && tok.v === '~' && owner && (isClass(owner) || owner.kind === 'tdep') && this.peek(1).k === 'id') {
        this.next(); const id = this.next();
        return { entry: null, name: '~' + id.v, owner, tok: id, dtor: true, global };
      }
      if (tok.k === 'id' && tok.v === 'template' && owner) { this.next(); continue; }
      if (tok.k !== 'id' || KEYWORDS.has(tok.v) || (CPP_KEYWORDS.has(tok.v) && tok.v !== 'operator')) {
        if (owner || global) fail(tok, 'expected a name after ::');
        return null;
      }
      this.next();
      const name = tok.v;
      let entry = owner ? this.lookupIn(owner, name) : this.findVar(name);
      if (entry && entry.template && entry.template.kind === 'class' && this.is('<')) {
        const args = this.templateArgs();
        entry = { typedef: true, type: this.instantiateClass(entry.template, args, tok) };
      } else if (entry && entry.templates && entry.templates.length && this.is('<') && !declMode) {
        entry = Object.assign({}, entry, { explicitArgs: this.templateArgs() });
      }
      if (this.is('::') && entry && (entry.ns || (entry.typedef && (isClass(entry.type) || entry.type.enumScope || entry.type.kind === 'tdep' || entry.type.kind === 'tparam')))) {
        this.next();
        owner = entry.ns || entry.type;
        continue;
      }
      return { entry, name, owner, tok, global, first };
    }
  }

  operatorName() {
    const tok = this.next();     // 'operator'
    const t = this.tok;
    if (t.k === 'punct') {
      if (t.v === '(' && this.is(')', 1)) { this.next(); this.next(); return { name: 'operator()' }; }
      if (t.v === '[' && this.is(']', 1)) { this.next(); this.next(); return { name: 'operator[]' }; }
      if (OPERATORS.includes(t.v)) { this.next(); return { name: 'operator' + t.v }; }
    }
    if (t.k === 'id' && (t.v === 'new' || t.v === 'delete')) fail(t, 'overloading operator ' + t.v + ' is not supported');
    // conversion operator: operator T()
    const ty = this.pointers(this.declspec(null));
    return { name: 'operator ' + typeKey(ty), convType: ty, tok };
  }

  // enum [class|struct] [Name] [: type] [{ ... }]
  enumSpec() {
    this.skipAttributes();
    const scoped = this.is('class') || this.is('struct');
    if (scoped) this.next();
    let tagTok = null;
    if (this.tok.k === 'id' && !CPP_KEYWORDS.has(this.tok.v)) tagTok = this.ident();
    let base = T.int;
    if (this.is(':')) {
      this.next();
      base = this.declspec(null);
      if (!isInt(base)) fail(this.tok, 'an enum needs an integer underlying type');
    }
    if (tagTok && !this.is('{')) {
      const found = this.findTag(tagTok.v);
      if (found && found.isEnum) return found;
    }
    const ty = Object.assign({}, base, { isEnum: true, enumName: tagTok ? tagTok.v + '#' + (this.uid++) : '#' + (this.uid++), displayName: tagTok && tagTok.v });
    if (scoped) ty.enumScope = new Map();
    if (tagTok) this.declareType(tagTok.v, ty);
    if (!this.accept('{')) return ty;
    let val = 0n;
    while (!this.accept('}')) {
      const name = this.ident();
      if (this.accept('=')) val = this.constInt(this.cond());
      const ent = { enumConst: true, value: val, type: scoped ? ty : T.int };
      if (scoped) ty.enumScope.set(name.v, ent); else this.declare(name.v, ent);
      val++;
      if (!this.accept(',')) { this.expect('}'); break; }
    }
    return ty;
  }

  // a type name at the current position (consumed), or null (nothing consumed)
  typeHere() {
    const save = this.p;
    let r;
    try { r = this.qualifiedName(); }
    catch (e) { this.p = save; throw e; }
    if (r && r.entry && r.entry.typedef && !(r.owner && isClass(r.owner) && r.entry.type === r.owner && this.is('('))) return r.entry.type;
    if (r && r.entry && r.entry.template && r.entry.template.kind === 'class') {
      // the injected name of a class template inside its own definition is handled by the bound frame;
      // anywhere else a class template needs arguments
      fail(r.tok, "use of class template '" + r.name + "' requires template arguments");
    }
    this.p = save;
    return null;
  }

  // does a type start at token index i? returns {type, end} or null
  typeAt(i) {
    const save = this.p, saveSplit = this.splitGT;
    this.p = i;
    try {
      const tok = this.tok;
      if (tok.k === 'id' && (TYPE_WORDS.has(tok.v) || SPEC_WORDS.has(tok.v))) return { builtin: true, end: i + 1 };
      const ty = this.typeHere();
      return ty ? { type: ty, end: this.p } : null;
    } catch (e) {
      if (e instanceof MCC.CompileError && !e.fatal) return null;
      throw e;
    } finally { this.p = save; this.splitGT = saveSplit; }
  }

  isTypename(t) {
    const i = t === undefined ? this.p : t === this.t[this.p] ? this.p : t === this.t[this.p + 1] ? this.p + 1 : this.t.indexOf(t);
    const tok = this.t[i];
    if (!tok || tok.k === 'str' || tok.k === 'char' || tok.k === 'num') return false;
    if (tok.k === 'punct') return tok.v === '::' && !!this.typeAt(i);
    if (tok.k !== 'id') return false;
    if (TYPE_WORDS.has(tok.v) || SPEC_WORDS.has(tok.v)) return true;
    if (KEYWORDS.has(tok.v) || CPP_KEYWORDS.has(tok.v)) return false;
    return !!this.typeAt(i);
  }

  // a declaration starts here (not a functional cast like  Foo(1);)
  isDeclStart() {
    const tok = this.tok;
    if (tok.k === 'id' && (tok.v === 'using' || tok.v === 'typedef' || tok.v === 'static_assert')) return true;
    if (!this.isTypename()) return false;
    if (tok.k === 'id' && (TYPE_WORDS.has(tok.v) || SPEC_WORDS.has(tok.v))) return !(this.is('(', 1) && (tok.v === 'int' || tok.v === 'bool' || tok.v === 'char' || tok.v === 'float' || tok.v === 'double' || tok.v === 'long' || tok.v === 'short' || tok.v === 'unsigned'));
    const r = this.typeAt(this.p);
    if (!r) return false;
    const nx = this.t[r.end];
    if (nx && nx.k === 'punct' && (nx.v === '(' || nx.v === '{' || nx.v === '::' || nx.v === '.' || nx.v === '->' || nx.v === ';' || nx.v === ')' || nx.v === ',' || nx.v === '=')) return false;
    if (this.is(':', 1)) return false;
    return true;
  }

  // ---- template arguments ----
  closeAngle() {
    if (this.splitGT === this.p) { this.splitGT = -1; this.p++; return true; }
    if (this.is('>')) { this.next(); return true; }
    if (this.is('>>')) { this.splitGT = this.p; return true; }
    return false;
  }

  templateArgs() {
    this.expect('<');
    const args = [];
    if (this.closeAngle()) return args;
    for (;;) {
      if (this.isTypename()) args.push({ type: this.typename() });
      else {
        const saved = this.noGT;
        this.noGT = true;
        const e = this.cond();
        this.noGT = saved;
        args.push({ value: this.constInt(e), type: e.ty });
      }
      if (this.closeAngle()) return args;
      this.expect(',');
    }
  }

  relational() {
    let e = this.shift();
    for (;;) {
      if (this.noGT && (this.is('>') || this.is('>>') || this.is('>=') || this.splitGT === this.p)) return e;
      if (this.is('<') || this.is('<=') || this.is('>') || this.is('>=')) { const tok = this.next(); e = this.compare(tok.v, e, this.shift(), tok); continue; }
      return e;
    }
  }

  shift() {
    let e = this.additive();
    for (;;) {
      if (this.noGT && (this.is('>>') || this.splitGT === this.p)) return e;
      if (this.is('<<') || this.is('>>')) {
        const tok = this.next();
        const rhs = this.additive();
        const hooked = this.binHook(tok.v, e, rhs, tok);
        if (hooked) { e = hooked; continue; }
        const a = this.rv(e), b = this.rv(rhs);
        if (!isInt(a.ty) || !isInt(b.ty)) fail(tok, 'invalid operands to ' + tok.v + ' (' + typeName(a.ty) + ' and ' + typeName(b.ty) + ')');
        const ty = promote(a.ty);
        e = this.fold(this.node('bin', ty, tok, { op: tok.v, a: this.cast(a, ty), b: this.cast(b, T.int) }));
        continue;
      }
      return e;
    }
  }

  // =================================================================
  //  Declaration specifiers and declarators
  // =================================================================
  declspec(attr) {
    const C = { VOID: 1, BOOL: 1 << 2, CHAR: 1 << 4, SHORT: 1 << 6, INT: 1 << 8, LONG: 1 << 10, FLOAT: 1 << 12, DOUBLE: 1 << 14, OTHER: 1 << 16, SIGNED: 1 << 17, UNSIGNED: 1 << 18 };
    let ty = T.int, counter = 0;
    const start = this.p;
    const storage = { typedef: 'typedef', static: 'static', extern: 'extern', inline: 'inline', __inline: 'inline', __inline__: 'inline',
      _Noreturn: null, _Thread_local: null, thread_local: null, register: null, virtual: 'virtual', explicit: 'explicit',
      friend: 'friend', constexpr: 'constexpr', mutable: null };
    for (;;) {
      const t = this.tok;
      if (t.k === 'punct' && t.v === '[' && this.is('[', 1)) {   // [[attributes]]
        let depth = 0;
        do { const x = this.next(); if (x.v === '[') depth++; else if (x.v === ']') depth--; } while (depth > 0);
        continue;
      }
      if (t.k === 'punct' && t.v === '::') {
        if (counter) break;
        const nt = this.typeHere();
        if (!nt) break;
        ty = nt; counter += C.OTHER;
        continue;
      }
      if (t.k !== 'id') break;
      const v = t.v;
      if (Object.prototype.hasOwnProperty.call(storage, v)) {
        if (!attr) {
          if (v === 'register' || v === 'constexpr' || v === 'mutable') { this.next(); continue; }
          fail(t, "'" + v + "' is not allowed here");
        }
        if (storage[v]) attr[storage[v]] = true;
        this.next();
        continue;
      }
      if (v === 'const' || v === 'volatile' || v === 'restrict' || v === '__restrict' || v === '__restrict__' || v === '__volatile__' || v === '__const' || v === '_Atomic') { this.next(); continue; }
      if (v === '__attribute__' || v === '__extension__') { this.skipAttributes(); continue; }
      if (v === '_Alignas' || v === 'alignas') {
        this.next(); this.expect('(');
        let depth = 0;
        while (!(depth === 0 && this.is(')'))) { const x = this.next(); if (x.v === '(') depth++; if (x.v === ')') depth--; }
        this.expect(')');
        continue;
      }
      if (v === 'typename') { this.next(); continue; }
      if (v === 'auto') {
        if (counter) break;
        this.next(); ty = AUTO; counter += C.OTHER; continue;
      }
      if (v === 'struct' || v === 'class' || v === 'union') {
        if (counter) break;
        this.next(); ty = this.classSpec(v); counter += C.OTHER; continue;
      }
      if (v === 'enum') {
        if (counter) break;
        this.next(); ty = this.enumSpec(); counter += C.OTHER; continue;
      }
      if (v === '__builtin_va_list') {
        if (counter) break;
        this.next(); ty = Object.assign({}, ptrTo(T.char), { vaList: true }); counter += C.OTHER; continue;
      }
      if (v === 'decltype' || v === '__typeof__' || v === 'typeof') {
        if (counter) break;
        this.next(); this.expect('(');
        if (this.isTypename()) ty = this.typename();
        else { const e = this.expr(); ty = e.ty; }
        this.expect(')');
        counter += C.OTHER;
        continue;
      }
      let add = 0;
      switch (v) {
        case 'void': add = C.VOID; break; case '_Bool': case 'bool': add = C.BOOL; break; case 'char': add = C.CHAR; break;
        case 'short': add = C.SHORT; break; case 'int': add = C.INT; break; case 'long': add = C.LONG; break;
        case 'float': add = C.FLOAT; break; case 'double': add = C.DOUBLE; break;
        case 'signed': case '__signed__': add = C.SIGNED; break; case 'unsigned': add = C.UNSIGNED; break;
        case 'wchar_t': case 'char32_t': add = C.INT; break; case 'char16_t': add = C.SHORT; break;
      }
      if (add) {
        this.next();
        counter += add;
        const S = C.SIGNED, U = C.UNSIGNED;
        switch (counter) {
          case C.VOID: ty = T.void; break;
          case C.BOOL: ty = T.bool; break;
          case C.CHAR: case S + C.CHAR: ty = T.char; break;
          case U + C.CHAR: ty = T.uchar; break;
          case C.SHORT: case C.SHORT + C.INT: case S + C.SHORT: case S + C.SHORT + C.INT: ty = T.short; break;
          case U + C.SHORT: case U + C.SHORT + C.INT: ty = T.ushort; break;
          case C.INT: case S: case S + C.INT: ty = T.int; break;
          case U: case U + C.INT: ty = T.uint; break;
          case C.LONG: case C.LONG + C.INT: case C.LONG + C.LONG: case C.LONG + C.LONG + C.INT:
          case S + C.LONG: case S + C.LONG + C.INT: case S + C.LONG + C.LONG: case S + C.LONG + C.LONG + C.INT: ty = T.long; break;
          case U + C.LONG: case U + C.LONG + C.INT: case U + C.LONG + C.LONG: case U + C.LONG + C.LONG + C.INT: ty = T.ulong; break;
          case C.FLOAT: ty = T.float; break;
          case C.DOUBLE: case C.LONG + C.DOUBLE: ty = T.double; break;
          default: fail(t, 'invalid type specifier combination');
        }
        continue;
      }
      if (counter) break;
      if (KEYWORDS.has(v) || CPP_KEYWORDS.has(v)) break;
      const nt = this.typeHere();
      if (!nt) break;
      ty = nt; counter += C.OTHER;
    }
    if (counter === 0 && this.p === start) fail(this.tok, 'expected a type' + (this.tok.k === 'eof' ? '' : " before '" + this.tok.v + "'"));
    return ty;
  }

  pointers(ty) {
    for (;;) {
      if (this.accept('*')) { ty = ptrTo(ty); this.skipCv(); continue; }
      if (this.is('&')) { this.next(); if (isRef(ty)) fail(this.tok, 'reference to a reference'); ty = refTo(ty); this.skipCv(); continue; }
      if (this.is('&&')) fail(this.tok, 'rvalue references (&&) are not supported');
      return ty;
    }
  }
  skipCv() {
    while (this.tok.k === 'id' && ['const', 'volatile', 'restrict', '__restrict', '__restrict__', '__const', '_Atomic'].includes(this.tok.v)) this.next();
    this.skipAttributes();
  }

  declarator(ty, abstract) {
    ty = this.pointers(ty);
    this.skipAttributes();
    if (this.is('(') && !(abstract && (this.isTypename(this.peek(1)) || this.is(')', 1))) && (this.is('*', 1) || this.is('&', 1) || this.is('(', 1) || this.is('^', 1))) {
      const start = this.p;
      this.next();
      this.declarator(T.int, abstract);
      this.expect(')');
      const outer = this.typeSuffix(ty);
      const end = this.p;
      this.p = start + 1;
      const d = this.declarator(outer, abstract);
      this.p = end;
      return d;
    }
    let name = null, tok = this.tok, owner = null, dtor = false, convType = null;
    const named = this.tok.k === 'id' && !KEYWORDS.has(this.tok.v) && (!CPP_KEYWORDS.has(this.tok.v) || this.tok.v === 'operator');
    if (named || this.is('::') || (this.is('~') && this.peek(1).k === 'id')) {
      if (!(abstract && named && this.isTypename())) {
        const r = this.qualifiedName(true);
        if (!r) fail(this.tok, 'expected a name');
        name = r.name; tok = r.tok; owner = r.owner && r.owner !== this.rootNs ? r.owner : (r.global ? this.rootNs : null);
        dtor = !!r.dtor; convType = r.convType || null;
      }
    } else if (!abstract) fail(this.tok, 'expected an identifier' + (this.tok.k === 'eof' ? '' : " before '" + this.tok.v + "'"));
    // `T name(args)` is a direct initialization unless a parameter list follows
    if (name && !abstract && this.is('(') && !(this.is(')', 1) || this.is('...', 1) || this.isTypename(this.peek(1)))) return { type: ty, name, tok, owner, dtor, convType };
    ty = this.typeSuffix(ty);
    if (this.is('asm') || this.is('__asm__') || this.is('__asm')) { this.next(); this.expect('('); while (!this.is(')')) this.next(); this.expect(')'); }
    this.skipAttributes();
    return { type: ty, name, tok, owner, dtor, convType };
  }

  typeSuffix(ty) {
    if (this.is('(')) {
      const tok = this.next();
      const params = [], names = [], defaults = [];
      let variadic = false;
      if (this.is('void') && this.is(')', 1)) { this.next(); this.next(); }
      else if (!this.accept(')')) {
        for (;;) {
          if (this.accept('...')) { variadic = true; this.expect(')'); break; }
          let pt = this.declspec({});
          const d = this.declarator(pt, true);
          pt = d.type;
          if (pt.kind === 'array') pt = ptrTo(pt.base);
          else if (pt.kind === 'func') pt = ptrTo(pt);
          if (pt.kind === 'void') fail(d.tok, "parameter has type 'void'");
          params.push(pt);
          names.push({ name: d.name, tok: d.tok });
          if (this.accept('=')) {
            const saved = this.temps;
            this.temps = null;
            defaults.push(this.assign());
            this.temps = saved;
          } else defaults.push(null);
          if (this.accept(')')) break;
          this.expect(',');
        }
      }
      if (ty.kind === 'array' || ty.kind === 'func') fail(tok, 'function cannot return ' + (ty.kind === 'array' ? 'an array' : 'a function'));
      const ft = funcType(ty, params, variadic, false);
      ft.paramNames = names;
      ft.defaults = defaults;
      for (;;) {
        if (this.is('const')) { this.next(); ft.isConst = true; continue; }
        if (this.is('volatile') || this.is('override') || this.is('final')) { this.next(); continue; }
        if (this.is('&') && !this.is('(', 1)) { this.next(); continue; }
        if (this.is('noexcept') || this.is('throw')) {
          this.next();
          if (this.is('(')) { let depth = 0; do { const x = this.next(); if (x.v === '(') depth++; else if (x.v === ')') depth--; } while (depth > 0); }
          continue;
        }
        if (this.is('->')) { this.next(); ft.ret = this.typename(); continue; }
        break;
      }
      return ft;
    }
    return super.typeSuffix(ty);
  }

  typename() {
    const base = this.declspec(null);
    return this.declarator(base, true).type;
  }

  // =================================================================
  //  Classes
  // =================================================================
  newClassType(kw, name, ownerNs, outer) {
    const ty = { kind: kw === 'union' ? 'union' : 'struct', size: 0, align: 1, members: [], tag: name, complete: false, uid: this.uid++ };
    const ns = ownerNs || this.currentNs();
    const qname = outer ? outer.cls.qname + '::' + name : (ns.qname ? ns.qname + '::' : '') + name;
    ty.cls = {
      name, qname, ns, outer: outer || null, kw, base: null, fields: [], fieldMap: null, methods: new Map(), statics: new Map(),
      nested: new Map(), ctors: [], dtor: null, vslots: [], vptrOffset: -1, hasVptr: false, vtable: null, synth: {}, packed: false,
    };
    ty.cls.nested.set(name.replace(/<.*$/, ''), { typedef: true, type: ty });
    return ty;
  }

  classSpec(kw) {
    const tok = this.tok;
    const attrs = this.skipAttributes();
    let name = null, nameTok = null;
    if (this.tok.k === 'id' && !CPP_KEYWORDS.has(this.tok.v) && !KEYWORDS.has(this.tok.v)) { nameTok = this.next(); name = nameTok.v; }
    if (this.is('final')) this.next();
    const defines = this.is('{') || (this.is(':') && !this.is(':', 1));
    if (!defines) {
      if (!name) fail(this.tok, 'expected a class name');
      const found = this.findVar(name);
      if (found && found.typedef && isClass(found.type)) return found.type;
      const ty = this.newClassType(kw, name, null, this.currentClass());
      this.declareType(name, ty);
      return ty;
    }
    let ty = null;
    if (name) {
      const fr = this.top();
      const cur = fr.kind === 'class' ? fr.cls.cls.nested.get(name) : fr.vars.get(name);
      if (cur && cur.typedef && isClass(cur.type)) {
        if (cur.type.complete) fail(nameTok, "redefinition of '" + name + "'");
        ty = cur.type;
      }
    }
    if (!ty) {
      ty = this.newClassType(kw, name || ('<anonymous ' + kw + ' ' + this.uid + '>'), null, this.currentClass());
      if (!name) ty.cls.anonymous = true;
      if (name) this.declareType(name, ty);
    }
    if (attrs.includes('packed')) ty.cls.packed = true;
    this.classBody(ty, kw, tok);
    return ty;
  }

  classBody(ty, kw, tok) {
    const k = ty.cls;
    if (this.accept(':')) {
      do {
        while (this.is('public') || this.is('private') || this.is('protected') || this.is('virtual')) this.next();
        const bt = this.typeHere();
        if (!bt || !isClass(bt)) fail(this.tok, 'expected a base class name');
        if (!bt.complete) fail(this.tok, "base class '" + typeName(bt) + "' is incomplete");
        if (k.base) fail(this.tok, 'multiple inheritance is not supported');
        k.base = bt;
      } while (this.accept(','));
    }
    this.expect('{');
    this.scopes.push({ kind: 'class', cls: ty, vars: new Map(), tags: new Map() });
    const deferred = [];
    try {
      while (!this.accept('}')) {
        if (this.tok.k === 'eof') fail(tok, "expected '}' at end of class");
        this.memberDecl(ty, deferred);
      }
      const attrs = this.skipAttributes();
      if (attrs.includes('packed')) k.packed = true;
      this.layoutClass(ty, tok);
      for (const d of deferred) this.parseDeferred(d);
    } finally {
      this.scopes.pop();
    }
    return ty;
  }

  skipBalanced(open, close) {
    let depth = 0;
    do {
      const x = this.next();
      if (x.k === 'eof') fail(x, "unbalanced '" + open + "'");
      if (x.k === 'punct' && x.v === open) depth++;
      else if (x.k === 'punct' && x.v === close) depth--;
    } while (depth > 0);
  }

  // skip a constructor's member initializer list and body; returns the start index
  skipFunctionBody() {
    const start = this.p;
    if (this.accept(':')) {
      for (;;) {
        while (!this.is('(') && !this.is('{')) { if (this.tok.k === 'eof') fail(this.tok, 'bad initializer list'); this.next(); }
        if (this.is('(')) this.skipBalanced('(', ')'); else this.skipBalanced('{', '}');
        if (this.accept(',')) continue;
        break;
      }
    }
    if (!this.is('{')) fail(this.tok, "expected a function body");
    this.skipBalanced('{', '}');
    return start;
  }

  memberDecl(ty, deferred) {
    const k = ty.cls;
    const tok = this.tok;
    if (this.accept(';')) return;
    if ((this.is('public') || this.is('private') || this.is('protected')) && this.is(':', 1)) { this.next(); this.next(); return; }
    if (this.is('static_assert') || this.is('_Static_assert')) { this.staticAssert(); return; }
    if (this.is('template')) fail(tok, 'member templates are not supported');
    if (this.is('using')) {
      this.next();
      if (this.tok.k === 'id' && this.is('=', 1)) {
        const name = this.next().v; this.next();
        const t = this.typename(); this.expect(';');
        this.declareType(name, t);
        return;
      }
      while (!this.accept(';')) this.next();     // using Base::name;  (members are found through the base anyway)
      return;
    }
    if (this.is('friend')) {
      this.next();
      if (this.is('class') || this.is('struct')) { while (!this.accept(';')) this.next(); return; }
      const attr = { friend: true };
      const base = this.declspec(attr);
      const d = this.declarator(base);
      if (d.type.kind !== 'func') fail(d.tok, 'friend declarations must declare a function or class');
      const f = this.declareFree(d, attr, k.ns, {});
      if (this.is('{')) { const start = this.skipFunctionBody(); f.isInline = true; deferred.push({ f, start, friend: true }); }
      else this.expect(';');
      return;
    }
    const flags = {};
    for (;;) {
      if (this.is('virtual')) { this.next(); flags.virtual = true; continue; }
      if (this.is('explicit')) { this.next(); flags.explicit = true; continue; }
      if (this.is('inline') || this.is('constexpr')) { this.next(); continue; }
      break;
    }
    const plainName = k.name.replace(/<.*$/, '');
    // destructor
    if (this.is('~') && this.peek(1).v === plainName && this.is('(', 2)) {
      this.next(); this.next(); this.expect('(');
      if (this.is('void')) this.next();
      this.expect(')');
      while (this.is('override') || this.is('final') || this.is('noexcept')) { this.next(); if (this.is('(')) this.skipBalanced('(', ')'); }
      const ft = funcType(T.void, []); ft.paramNames = []; ft.defaults = [];
      const f = this.makeMethod(ty, '~' + plainName, ft, { dtor: true, virtual: flags.virtual }, tok);
      k.dtor = f;
      this.methodTail(f, deferred);
      return;
    }
    // constructor
    if (this.tok.v === plainName && this.tok.k === 'id' && this.is('(', 1)) {
      this.next();
      const ft = this.typeSuffix(T.void);
      const f = this.makeMethod(ty, plainName, ft, { ctor: true, explicit: flags.explicit }, tok);
      k.ctors.push(f);
      this.methodTail(f, deferred);
      return;
    }
    // conversion operator: operator T() const
    if (this.is('operator') && !(this.peek(1).k === 'punct' && this.peek(1).v !== '(')) {
      const d = this.declarator(T.void);
      if (d.type.kind !== 'func' || !d.convType) fail(d.tok, 'expected a conversion operator');
      d.type.ret = d.convType;
      const f = this.makeMethod(ty, d.name, d.type, { virtual: flags.virtual, convType: d.convType }, d.tok);
      this.methodTail(f, deferred);
      return;
    }
    const attr = {};
    if (flags.virtual) attr.virtual = true;
    const base = this.declspec(attr);
    if (attr.virtual) flags.virtual = true;
    if (this.accept(';')) {
      if (isClass(base) && base.cls.anonymous) k.fields.push({ name: null, type: base, tok });
      return;
    }
    for (;;) {
      const d = this.declarator(base);
      if (attr.typedef) { this.declareType(d.name, d.type); if (this.accept(',')) continue; break; }
      if (d.type.kind === 'func') {
        const f = this.makeMethod(ty, d.name, d.type, { static: attr.static, virtual: flags.virtual, convType: d.convType }, d.tok);
        this.methodTail(f, deferred);
        return;
      }
      if (this.is(':') && !this.is(':', 1)) fail(this.tok, 'bit-fields are not supported');
      if (attr.static) this.staticMember(ty, d, attr);
      else {
        let defaultInit = null;
        if (this.accept('=')) defaultInit = this.assign();
        else if (this.is('{')) { this.next(); defaultInit = this.is('}') ? this.num(0, T.int, this.tok) : this.assign(); this.expect('}'); }
        if (d.type.kind === 'auto') fail(d.tok, "member '" + d.name + "' cannot have type auto");
        k.fields.push({ name: d.name, type: d.type, tok: d.tok, defaultInit });
      }
      if (this.accept(',')) continue;
      break;
    }
    this.expect(';');
  }

  methodTail(f, deferred) {
    if (this.accept('=')) {
      const t = this.next();
      if (t.v === '0') { f.isPure = true; f.isVirtual = true; }
      else if (t.v === 'default') f.isDefaulted = true;
      else if (t.v === 'delete') f.isDeleted = true;
      else fail(t, "expected '0', 'default' or 'delete'");
      this.expect(';');
      return;
    }
    if (this.is('{') || this.is(':')) {
      const start = this.skipFunctionBody();
      f.isInline = true;
      deferred.push({ f, start });
      return;
    }
    this.expect(';');
  }

  staticMember(ty, d, attr) {
    const k = ty.cls;
    if (this.accept('=') || this.is('{')) {
      const braced = this.is('{');
      if (braced) this.next();
      const e = this.assign();
      if (braced) this.expect('}');
      if (isInt(d.type) || d.type.isEnum) {
        let v;
        try { v = this.constInt(e); } catch (x) { v = null; }
        if (v !== null) { k.statics.set(d.name, { enumConst: true, value: MCC.wrapInt(v, d.type), type: d.type }); return; }
      }
      const o = this.staticObj(ty, d);
      o.init = { type: d.type, entries: [{ off: 0, ty: d.type, expr: this.assignConv(e, d.type, d.tok, 'initializing') }], isGlobal: true };
      return;
    }
    this.staticObj(ty, d);
  }

  staticObj(ty, d) {
    const k = ty.cls;
    const ex = k.statics.get(d.name);
    if (ex && ex.obj) return ex.obj;
    const o = this.newGlobal(k.qname + '::' + d.name, d.type, { defined: true, tok: d.tok, displayName: d.name });
    k.statics.set(d.name, { obj: o, type: d.type });
    return o;
  }

  makeMethod(ty, name, ft, flags, tok) {
    const k = ty.cls;
    const isStatic = !!flags.static;
    const params = isStatic ? ft.params.slice() : [ptrTo(ty)].concat(ft.params);
    const names = isStatic ? ft.paramNames.slice() : [{ name: 'this' }].concat(ft.paramNames);
    const mt = funcType(flags.ctor || flags.dtor ? T.void : ft.ret, params, ft.variadic, false);
    mt.paramNames = names;
    const key = k.qname + '::' + name + '(' + ft.params.map(typeKey).join(',') + ')' + (ft.isConst ? 'K' : '');
    let f = this.funcs.get(key);
    if (f && f.cls === ty) return f;
    f = {
      name, qname: k.qname + '::' + name, uname: key, type: mt, cls: ty, isMethod: true, isStatic, isVirtual: !!flags.virtual,
      isCtor: !!flags.ctor, isDtor: !!flags.dtor, isConst: !!ft.isConst, explicit: !!flags.explicit, convType: flags.convType || null,
      defaults: ft.defaults || [], tok, defined: false, params: [], locals: [], body: null, id: this.uid++,
    };
    this.funcs.set(key, f);
    if (!flags.ctor && !flags.dtor) {
      if (!k.methods.has(name)) k.methods.set(name, []);
      k.methods.get(name).push(f);
    }
    return f;
  }

  layoutClass(ty, tok) {
    const k = ty.cls;
    const base = k.base;
    // virtual table slots: inherited, overridden, new
    k.vslots = base ? base.cls.vslots.slice() : [];
    const sig = (f) => f.name + '(' + f.type.params.slice(1).map(typeKey).join(',') + ')';
    const all = [];
    for (const list of k.methods.values()) for (const f of list) if (!f.isStatic) all.push(f);
    if (k.dtor) all.push(k.dtor);
    for (const f of all) {
      const key = f.isDtor ? '~' : sig(f);
      const i = k.vslots.findIndex(s => s.key === key);
      if (i >= 0) { f.isVirtual = true; f.vslot = i; k.vslots[i] = { key, f }; }
      else if (f.isVirtual) { f.vslot = k.vslots.length; k.vslots.push({ key, f }); }
    }
    k.hasVptr = k.vslots.length > 0;
    // fields
    const members = [];
    let off = 0, align = 1;
    if (base) {
      for (const m of base.members) members.push(m);
      off = base.size; align = base.align;
      k.vptrOffset = base.cls.vptrOffset;
    }
    if (k.hasVptr && k.vptrOffset < 0) {
      off = Math.ceil(off / 8) * 8;
      k.vptrOffset = off;
      members.push({ name: '$vptr', type: ptrTo(ptrTo(T.void)), offset: off });
      off += 8; align = Math.max(align, 8);
    }
    k.fieldMap = new Map();
    let size = off;
    for (const fd of k.fields) {
      const st = isRef(fd.type) ? fd.type : fd.type;
      if (st.kind === 'array' && st.len < 0) fail(fd.tok, 'flexible array members are not supported in classes');
      if (isClass(st) && !st.complete) fail(fd.tok, "field '" + fd.name + "' has incomplete type");
      if (st.kind === 'void' || st.kind === 'func') fail(fd.tok, "field '" + fd.name + "' has an invalid type");
      const a = k.packed ? 1 : st.align;
      let o;
      if (k.kw === 'union') o = 0;
      else { off = Math.ceil(off / a) * a; o = off; off += st.size; }
      size = Math.max(size, o + st.size, off);
      align = Math.max(align, a);
      if (fd.name === null && isClass(st)) {
        for (const sub of st.members) { const m = { name: sub.name, type: sub.type, offset: o + sub.offset }; members.push(m); k.fieldMap.set(sub.name, m); }
        continue;
      }
      fd.offset = o;
      const m = { name: fd.name, type: st, offset: o, isRef: isRef(fd.type) };
      fd.mem = m;
      members.push(m);
      k.fieldMap.set(fd.name, m);
    }
    if (k.kw !== 'union') size = Math.max(size, off);
    size = Math.ceil(size / align) * align;
    if (size === 0) size = 1;      // an empty class still has a distinct address
    ty.members = members;
    ty.size = size;
    ty.align = align;
    ty.complete = true;
    if (k.hasVptr) {
      // a destructor slot inherited from a base needs a function here too
      const vt = arrayOf(ptrTo(T.void), k.vslots.length);
      const o = this.newGlobal('vtable for ' + k.qname + '$' + this.uid, vt, { isStatic: true, defined: true, tok, readonly: true });
      k.vtable = o;
      const di = k.vslots.findIndex(s => s.key === '~');
      if (di >= 0 && k.vslots[di].f.cls !== ty) { const d = this.dtorOf(ty, tok); d.isVirtual = true; d.vslot = di; k.vslots[di] = { key: '~', f: d }; }
      o.init = {
        type: vt, isGlobal: true,
        entries: k.vslots.map((s, i) => ({ off: i * 8, ty: ptrTo(T.void), expr: s.f.isPure ? this.cast(this.num(0, T.long, tok), ptrTo(T.void)) : this.cast(this.node('addr', ptrTo(s.f.type), tok, { e: this.node('func', s.f.type, tok, { fn: s.f }) }), ptrTo(T.void)) })),
      };
      k.vtable = o;
    }
  }

  parseDeferred(d) {
    const save = this.p;
    this.p = d.start;
    if (d.friend) this.defineBody(d.f, d.f.tok, { noClassFrame: true });
    else this.defineBody(d.f, d.f.tok);
    this.p = save;
  }

  // =================================================================
  //  Special members
  // =================================================================
  derivesFrom(a, b) {
    for (let c = a; c; c = c.cls ? c.cls.base : null) if (c === b) return true;
    return false;
  }
  trivialDtor(ty) {
    if (ty.kind === 'array') return this.trivialDtor(ty.base);
    if (!isClass(ty)) return true;
    const k = ty.cls;
    if (k.trivialDtorCache !== undefined) return k.trivialDtorCache;
    const r = !k.dtor && !k.vslots.some(s => s.key === '~') && (!k.base || this.trivialDtor(k.base)) && k.fields.every(f => isRef(f.type) || this.trivialDtor(f.type));
    if (ty.complete) k.trivialDtorCache = r;
    return r;
  }
  userCopyCtor(ty) { return ty.cls.ctors.find(c => this.isCopyCtor(c, ty)) || null; }
  isCopyCtor(c, ty) {
    const ps = c.type.params.slice(1);
    return ps.length >= 1 && isRef(ps[0]) && ps[0].base === ty && ps.slice(1).every((_, i) => c.defaults[i + 1]);
  }
  trivialCopy(ty) {
    if (ty.kind === 'array') return this.trivialCopy(ty.base);
    if (!isClass(ty)) return true;
    const k = ty.cls;
    return !this.userCopyCtor(ty) && !k.hasVptr && (!k.base || this.trivialCopy(k.base)) && k.fields.every(f => isRef(f.type) || this.trivialCopy(f.type));
  }
  needsDefaultInit(ty) {
    if (ty.kind === 'array') return this.needsDefaultInit(ty.base);
    if (!isClass(ty)) return false;
    const k = ty.cls;
    return k.ctors.length > 0 || k.hasVptr || (!!k.base && this.needsDefaultInit(k.base)) || k.fields.some(f => f.defaultInit || (!isRef(f.type) && this.needsDefaultInit(f.type)));
  }
  nontrivialPass(ty) { return isClass(ty) && (!this.trivialCopy(ty) || !this.trivialDtor(ty)); }

  // an internal member function built directly as a syntax tree
  synthMethod(ty, name, userParams, ret, build, tok, flags) {
    const ft = funcType(ret, userParams, false);
    ft.paramNames = userParams.map(() => ({ name: null }));
    ft.defaults = [];
    const k = ty.cls;
    const f = {
      name, qname: k.qname + '::' + name, uname: k.qname + '::' + name + '$synth(' + userParams.map(typeKey).join(',') + ')',
      type: funcType(ret, [ptrTo(ty)].concat(userParams), false), cls: ty, isMethod: true, isStatic: false,
      isCtor: !!(flags && flags.ctor), isDtor: !!(flags && flags.dtor), defaults: [], tok, defined: true, isInline: true,
      params: [], locals: [], body: null, id: this.uid++, synth: true,
    };
    f.type.paramNames = [{ name: 'this' }].concat(ft.paramNames);
    this.funcs.set(f.uname, f);
    const saved = { fn: this.fn, thisObj: this.thisObj, temps: this.temps };
    this.fn = f; this.temps = null;
    const self = { name: 'this', type: ptrTo(ty), local: true, isParam: true, id: this.uid++, tok };
    f.params.push(self); f.locals.push(self);
    this.thisObj = self;
    const ps = userParams.map(pt => {
      const o = { name: null, type: pt, local: true, isParam: true, id: this.uid++, tok };
      if (this.nontrivialPass(pt)) o.noCopy = true;
      f.params.push(o); f.locals.push(o);
      return o;
    });
    try { f.body = { k: 'block', items: build(ps), tok }; }
    finally { Object.assign(this, saved); }
    return f;
  }

  defaultCtorOf(ty, tok) {
    const k = ty.cls;
    if (k.ctors.length) {
      const c = k.ctors.find(f => f.type.params.length === 1 || f.defaults.slice(0, f.type.params.length - 1).every(Boolean));
      return c || null;
    }
    if (!this.needsDefaultInit(ty)) return null;
    if (!k.synth.ctor) k.synth.ctor = this.synthMethod(ty, k.name, [], T.void, () => this.ctorPrologue(ty, new Map(), tok), tok, { ctor: true });
    return k.synth.ctor;
  }

  dtorOf(ty, tok) {
    const k = ty.cls;
    if (k.dtor) return k.dtor;
    if (this.trivialDtor(ty) && !k.vslots.some(s => s.key === '~')) return null;
    if (!k.synth.dtor) k.synth.dtor = this.synthMethod(ty, '~' + k.name, [], T.void, () => this.dtorPrologue(ty, tok).concat(this.dtorEpilogue(ty, tok)), tok, { dtor: true });
    return k.synth.dtor;
  }

  copyCtorOf(ty, tok) {
    const u = this.userCopyCtor(ty);
    if (u) return u;
    if (this.trivialCopy(ty)) return null;
    const k = ty.cls;
    if (!k.synth.copy) {
      k.synth.copy = this.synthMethod(ty, k.name, [refTo(ty)], T.void, (ps) => {
        const self = this.thisDeref(tok);
        const other = this.node('deref', ty, tok, { e: this.node('var', ps[0].type, tok, { obj: ps[0] }) });
        const out = [];
        if (k.base) out.push(this.exprStmt(this.copyConstruct(this.sliceTo(self, k.base), this.sliceTo(other, k.base), k.base, tok)));
        if (k.hasVptr) out.push(this.setVptrStmt(ty, tok));
        for (const fd of k.fields) {
          if (!fd.mem) continue;
          const dst = this.rawMember(self, fd.mem), src = this.rawMember(other, fd.mem);
          if (isClass(fd.type)) out.push(this.exprStmt(this.copyConstruct(dst, src, fd.type, tok)));
          else out.push(this.exprStmt(this.blobCopy(dst, src, fd.type, tok)));
        }
        return out;
      }, tok, { ctor: true });
    }
    return k.synth.copy;
  }

  assignOpOf(ty, tok) {
    const k = ty.cls;
    const user = (k.methods.get('operator=') || []).find(f => { const p = f.type.params[1]; return p && ((isRef(p) && p.base === ty) || p === ty); });
    if (user) return user;
    if (this.trivialCopy(ty)) return null;
    if (!k.synth.assign) {
      k.synth.assign = this.synthMethod(ty, 'operator=', [refTo(ty)], refTo(ty), (ps) => {
        const self = this.thisDeref(tok);
        const other = this.node('deref', ty, tok, { e: this.node('var', ps[0].type, tok, { obj: ps[0] }) });
        const out = [];
        if (k.base) out.push(this.exprStmt(this.assignObject(this.sliceTo(self, k.base), this.sliceTo(other, k.base), k.base, tok)));
        for (const fd of k.fields) {
          if (!fd.mem) continue;
          const dst = this.rawMember(self, fd.mem), src = this.rawMember(other, fd.mem);
          if (isClass(fd.type)) out.push(this.exprStmt(this.assignObject(dst, src, fd.type, tok)));
          else out.push(this.exprStmt(this.blobCopy(dst, src, fd.type, tok)));
        }
        out.push({ k: 'return', e: this.node('var', ptrTo(ty), tok, { obj: this.thisObj }), tok });
        return out;
      }, tok);
    }
    return k.synth.assign;
  }

  assignObject(dst, src, ty, tok) {
    const op = this.assignOpOf(ty, tok);
    if (op) return this.callFunc(op, [src], dst, tok, { nonVirtual: true });
    return this.blobCopy(dst, src, ty, tok);
  }

  // copy bytes from one lvalue to another, whatever their type
  blobCopy(dst, src, ty, tok) {
    if (isScalar(ty) && !isRef(ty)) return this.node('assign', ty, tok, { lhs: dst, rhs: src });
    const blob = { kind: 'struct', size: ty.size, align: ty.align, members: [], complete: true, tag: '<bytes>' };
    const view = (e) => this.node('deref', blob, tok, { e: this.cast(this.addrOf(e, tok), ptrTo(blob)) });
    return this.node('assign', blob, tok, { lhs: view(dst), rhs: view(src) });
  }

  thisDeref(tok) {
    if (!this.thisObj) fail(tok, "'this' is only available in non-static member functions");
    return this.node('deref', this.thisObj.type.base, tok, { e: this.node('var', this.thisObj.type, tok, { obj: this.thisObj }) });
  }
  rawMember(base, mem, tok) { return this.node('member', mem.type, tok || base.tok, { e: base, mem }); }
  memberRef(base, mem, tok) {
    const m = this.rawMember(base, mem, tok);
    return mem.isRef ? this.node('deref', mem.type.base, tok, { e: m }) : m;
  }
  sliceTo(e, ty) {
    if (e.ty === ty) return e;
    return this.node('deref', ty, e.tok, { e: this.cast(this.addrOf(e, e.tok), ptrTo(ty)) });
  }
  vptrMember(self, ty) {
    const m = ty.members.find(x => x.name === '$vptr');
    return this.rawMember(self, m);
  }
  setVptrStmt(ty, tok) {
    const self = this.thisDeref(tok);
    const vt = ty.cls.vtable;
    return this.exprStmt(this.node('assign', ptrTo(ptrTo(T.void)), tok, { lhs: this.vptrMember(self, ty), rhs: this.rv(this.node('var', vt.type, tok, { obj: vt })) }));
  }
  exprStmt(e) { return { k: 'expr', e, tok: e.tok }; }
  nop(tok) { return this.node('cast', T.void, tok, { e: this.num(0, T.int, tok) }); }

  ctorPrologue(ty, init, tok) {
    const k = ty.cls;
    const out = [];
    const self = this.thisDeref(tok);
    const deleg = init.get('$base');
    if (deleg && deleg.self) {
      // delegating constructor: the target constructor does all the initialization
      if (init.size > 1) fail(deleg.tok, 'a delegating constructor cannot initialize anything else');
      const saved = this.temps;
      this.temps = deleg.temps || [];
      try { out.push(this.exprStmt(this.wrapTemps(this.construct(self, ty, deleg.args, deleg.tok, deleg.braced), this.temps, true))); } finally { this.temps = saved; }
      return out;
    }
    const run = (it, mk) => {
      const saved = this.temps;
      this.temps = it && it.temps ? it.temps : [];
      try { out.push(this.exprStmt(this.wrapTemps(mk(), this.temps, true))); } finally { this.temps = saved; }
    };
    if (k.base) {
      const it = init.get('$base');
      run(it, () => this.construct(this.sliceTo(self, k.base), k.base, it ? it.args : [], it ? it.tok : tok, it && it.braced));
    }
    if (k.hasVptr) out.push(this.setVptrStmt(ty, tok));
    for (const fd of k.fields) {
      if (!fd.mem) continue;
      const it = init.get(fd.name);
      if (fd.mem.isRef) {
        if (!it || it.args.length !== 1) fail(it ? it.tok : fd.tok, "reference member '" + fd.name + "' must be initialized in the constructor");
        run(it, () => this.node('assign', fd.mem.type, it.tok, { lhs: this.rawMember(self, fd.mem), rhs: this.bindRef(it.args[0], fd.type.base, it.tok) }));
        continue;
      }
      if (it) { run(it, () => this.initObject(this.rawMember(self, fd.mem), fd.type, it.args, it.tok, it.braced)); continue; }
      if (fd.defaultInit) { run(null, () => this.initObject(this.rawMember(self, fd.mem), fd.type, [fd.defaultInit], fd.tok)); continue; }
      if (this.needsDefaultInit(fd.type)) run(null, () => this.defaultInit(this.rawMember(self, fd.mem), fd.type, fd.tok));
    }
    for (const key of init.keys()) {
      if (key !== '$base' && !k.fields.some(f => f.name === key)) fail(init.get(key).tok, "'" + key + "' is not a member or base of " + k.name);
    }
    return out.filter(s => !(s.e.k === 'cast' && s.e.ty.kind === 'void' && s.e.e.k === 'num'));
  }

  dtorPrologue(ty, tok) { return ty.cls.hasVptr ? [this.setVptrStmt(ty, tok)] : []; }

  dtorEpilogue(ty, tok) {
    const k = ty.cls;
    const out = [];
    const self = this.thisDeref(tok);
    for (let i = k.fields.length - 1; i >= 0; i--) {
      const fd = k.fields[i];
      if (!fd.mem || fd.mem.isRef || this.trivialDtor(fd.type)) continue;
      out.push(this.exprStmt(this.destroy(this.rawMember(self, fd.mem), fd.type, tok)));
    }
    if (k.base && !this.trivialDtor(k.base)) out.push(this.exprStmt(this.callFunc(this.dtorOf(k.base, tok), [], this.sliceTo(self, k.base), tok, { nonVirtual: true })));
    return out;
  }

  ctorInitList(cls) {
    this.expect(':');
    const init = new Map();
    for (;;) {
      const tok = this.tok;
      let key;
      const save = this.p;
      const ty = this.isTypename() ? this.typeHere() : null;
      if (ty && isClass(ty)) key = '$base';
      else { this.p = save; key = this.ident().v; }
      const saved = this.temps;
      this.temps = [];
      let args, braced = false;
      if (this.accept('(')) args = this.argList();
      else if (this.is('{')) { braced = true; args = this.braceArgs(); }
      else fail(this.tok, "expected '(' or '{' in member initializer");
      init.set(key, { args, tok, braced, temps: this.temps, self: key === '$base' && ty === cls });
      this.temps = saved;
      if (!this.accept(',')) break;
    }
    return init;
  }

  // =================================================================
  //  Construction, destruction, temporaries
  // =================================================================
  newTemp(ty, tok) {
    const o = this.newLocal(null, ty, tok);
    o.addrTaken = true;
    o.isTemp = true;
    if (isClass(ty) && !this.trivialDtor(ty)) {
      if (this.temps) this.temps.push(o);
      else {
        // no full-expression in progress: the temporary lives until the end of the block
        for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].cleanups) { this.scopes[i].cleanups.push({ obj: o, type: ty }); break; }
      }
    }
    return o;
  }

  dropTemp(o) {
    if (this.temps) { const i = this.temps.indexOf(o); if (i >= 0) this.temps.splice(i, 1); }
  }

  // runs `parse` for an operand that is evaluated only sometimes (?:, &&, ||):
  // the temporaries it creates are destroyed only if it ran
  guarded(parse) {
    const temps = this.temps;
    const before = temps ? temps.length : 0;
    const e = parse();
    if (!temps || temps.length === before) return e;
    const tok = e.tok;
    const g = this.newLocal(null, T.int, tok);
    for (let i = before; i < temps.length; i++) if (!temps[i].guard) temps[i].guard = g;
    (temps.guards || (temps.guards = [])).push(g);
    const set = this.node('assign', T.int, tok, { lhs: this.node('var', T.int, tok, { obj: g }), rhs: this.num(1, T.int, tok) });
    return this.node('comma', e.ty, tok, { a: set, b: e, guardSet: true });
  }

  logor() {
    let e = this.logand();
    while (this.is('||')) { const tok = this.next(); const a = this.toCond(e); e = this.node('logor', T.bool, tok, { a, b: this.toCond(this.guarded(() => this.logand())) }); }
    return e;
  }
  logand() {
    let e = this.bitor();
    while (this.is('&&')) { const tok = this.next(); const a = this.toCond(e); e = this.node('logand', T.bool, tok, { a, b: this.toCond(this.guarded(() => this.bitor())) }); }
    return e;
  }

  wrapTemps(e, temps, discard) {
    if (!temps || (!temps.length && !(temps.guards && temps.guards.length))) return e;
    const tok = e.tok;
    if (temps.guards && temps.guards.length) {
      // every guard starts out clear
      let resets = null;
      for (const g of temps.guards) {
        const r = this.node('assign', T.int, tok, { lhs: this.node('var', T.int, tok, { obj: g }), rhs: this.num(0, T.int, tok) });
        resets = resets ? this.node('comma', T.void, tok, { a: resets, b: r }) : r;
      }
      e = this.node('comma', e.ty, tok, { a: resets, b: e });
      if (!temps.length) return e;
    }
    let chain = null;
    for (let i = temps.length - 1; i >= 0; i--) {
      let d = this.destroy(this.node('var', temps[i].type, tok, { obj: temps[i] }), temps[i].type, tok);
      if (temps[i].guard) d = this.node('cond', T.void, tok, { c: this.node('var', T.int, tok, { obj: temps[i].guard }), a: d, b: this.nop(tok) });
      chain = chain ? this.node('comma', T.void, tok, { a: chain, b: d }) : d;
    }
    if (discard || e.ty.kind === 'void' || isAgg(e.ty)) return this.node('comma', T.void, tok, { a: e, b: chain });
    const v = this.rv(e);
    const t = this.newLocal(null, v.ty, tok);
    return this.node('comma', v.ty, tok, {
      a: this.node('comma', T.void, tok, { a: this.node('assign', v.ty, tok, { lhs: this.node('var', v.ty, tok, { obj: t }), rhs: v }), b: chain }),
      b: this.node('var', v.ty, tok, { obj: t }),
    });
  }

  fullExpr(parse) {
    const saved = this.temps;
    this.temps = [];
    let e, temps;
    try { e = parse(); } finally { temps = this.temps; this.temps = saved; }
    return { e, temps };
  }

  destroy(lv, ty, tok) {
    if (ty.kind === 'array') {
      let n = 1, el = ty;
      while (el.kind === 'array') { n *= el.len; el = el.base; }
      const d = this.dtorOf(el, tok);
      if (!d) return this.nop(tok);
      return this.callFunc(this.rt.arrayDtor, [this.cast(this.addrOf(lv, tok), ptrTo(T.void)), this.num(n, T.ulong, tok), this.num(el.size, T.ulong, tok), this.funcAddr(d, tok)], null, tok);
    }
    const d = this.dtorOf(ty, tok);
    if (!d) return this.nop(tok);
    return this.callFunc(d, [], lv, tok);
  }

  funcAddr(f, tok) {
    return this.cast(this.node('addr', ptrTo(f.type), tok, { e: this.node('func', f.type, tok, { fn: f }) }), ptrTo(funcType(T.void, [ptrTo(T.void)])));
  }

  // a this-only function that default-constructs one array element
  elementCtor(ty, tok) {
    const c = this.defaultCtorOf(ty, tok);
    if (!c) fail(tok, 'no default constructor for ' + typeName(ty));
    if (c.type.params.length === 1) return c;
    const k = ty.cls;
    if (!k.synth.element) k.synth.element = this.synthMethod(ty, k.name + '$element', [], T.void, () => [this.exprStmt(this.construct(this.thisDeref(tok), ty, [], tok))], tok);
    return k.synth.element;
  }

  defaultInit(lv, ty, tok) {
    if (ty.kind === 'array') {
      let n = 1, el = ty;
      while (el.kind === 'array') { n *= el.len; el = el.base; }
      if (!isClass(el) || !this.needsDefaultInit(el)) return this.nop(tok);
      const c = this.elementCtor(el, tok);
      return this.callFunc(this.rt.arrayCtor, [this.cast(this.addrOf(lv, tok), ptrTo(T.void)), this.num(n, T.ulong, tok), this.num(el.size, T.ulong, tok), this.funcAddr(c, tok)], null, tok);
    }
    if (!isClass(ty)) return this.nop(tok);
    return this.construct(lv, ty, [], tok);
  }

  initObject(lv, ty, args, tok, braced) {
    if (isClass(ty)) return this.construct(lv, ty, args, tok, braced);
    if (ty.kind === 'array') {
      if (args.length) fail(tok, 'array members cannot be initialized here');
      return this.defaultInit(lv, ty, tok);
    }
    if (!args.length) return this.node('assign', ty, tok, { lhs: lv, rhs: isFlo(ty) ? { k: 'fnum', ty, val: 0, tok } : this.cast(this.num(0, T.long, tok), ty) });
    if (args.length > 1) fail(tok, 'too many initializers for ' + typeName(ty));
    return this.node('assign', ty, tok, { lhs: lv, rhs: this.assignConv(args[0], ty, tok, 'initializing') });
  }

  construct(lv, ty, args, tok, braced) {
    const k = ty.cls;
    const ctors = k.ctors.filter(c => !c.isDeleted);
    const copyFrom = args.length === 1 && isClass(args[0].ty) && this.derivesFrom(args[0].ty, ty);
    if (ctors.length) {
      if (copyFrom && !this.userCopyCtor(ty)) return this.copyConstruct(lv, args[0], ty, tok);
      const best = this.resolve(ctors.map(f => ({ f })), args, tok, k.name);
      if (best.f.isDefaulted) return this.defaultInitPrologueCall(lv, ty, tok);
      return this.callFunc(best.f, args, lv, tok, { nonVirtual: true });
    }
    if (!args.length) {
      const dc = this.defaultCtorOf(ty, tok);
      return dc ? this.callFunc(dc, [], lv, tok, { nonVirtual: true }) : this.nop(tok);
    }
    if (copyFrom) return this.copyConstruct(lv, args[0], ty, tok);
    // aggregate initialization
    if (k.base || k.hasVptr) fail(tok, 'no matching constructor for ' + typeName(ty));
    const fields = k.fields.filter(f => f.mem);
    if (args.length > fields.length) fail(tok, 'too many initializers for ' + typeName(ty));
    let chain = null;
    const add = (e) => { chain = chain ? this.node('comma', T.void, tok, { a: chain, b: e }) : e; };
    fields.forEach((fd, i) => {
      const dst = this.rawMember(lv, fd.mem);
      if (fd.mem.isRef) { if (i >= args.length) fail(tok, 'reference member needs an initializer'); add(this.node('assign', fd.mem.type, tok, { lhs: dst, rhs: this.bindRef(args[i], fd.type.base, tok) })); }
      else if (i < args.length) add(this.initObject(dst, fd.type, [args[i]], tok));
      else if (fd.defaultInit) add(this.initObject(dst, fd.type, [fd.defaultInit], tok));
      else if (isClass(fd.type) || fd.type.kind === 'array') add(this.defaultInit(dst, fd.type, tok));
      else add(this.initObject(dst, fd.type, [], tok));
    });
    return chain || this.nop(tok);
  }

  defaultInitPrologueCall(lv, ty, tok) {
    const k = ty.cls;
    if (!k.synth.ctor) k.synth.ctor = this.synthMethod(ty, k.name, [], T.void, () => this.ctorPrologue(ty, new Map(), tok), tok, { ctor: true });
    return this.callFunc(k.synth.ctor, [], lv, tok, { nonVirtual: true });
  }

  copyConstruct(lv, src, ty, tok) {
    const cc = this.copyCtorOf(ty, tok);
    if (cc) return this.callFunc(cc, [src], lv, tok, { nonVirtual: true });
    return this.blobCopy(lv, this.sliceTo(src, ty), ty, tok);
  }

  // =================================================================
  //  Conversions
  // =================================================================
  // in C++ `c ? x : y` with two lvalues of one type is itself an lvalue
  cond() {
    const c = this.logor();
    if (!this.is('?')) return c;
    const tok = this.next();
    const cc = this.toCond(c);
    let a = this.guarded(() => this.expr());
    this.expect(':');
    let b = this.guarded(() => this.assign());
    if (a.k !== 'ovl' && b.k !== 'ovl' && a.ty.kind !== 'array' && a.ty.kind !== 'func' && a.ty.kind !== 'void' &&
        this.isLvalue(a) && this.isLvalue(b) && typeKey(a.ty) === typeKey(b.ty) &&
        !this.isPrvalueTemp(a.guardSet ? a.b : a) && !this.isPrvalueTemp(b.guardSet ? b.b : b)) {
      const pa = this.addrOf(a, tok), pb = this.addrOf(b, tok);
      return this.node('deref', a.ty, tok, { e: this.node('cond', pa.ty, tok, { c: cc, a: pa, b: pb }) });
    }
    a = this.rv(a); b = this.rv(b);
    let ty;
    if (isNum(a.ty) && isNum(b.ty)) { ty = usualArith(a.ty, b.ty); a = this.cast(a, ty); b = this.cast(b, ty); }
    else if (a.ty.kind === 'void' || b.ty.kind === 'void') ty = T.void;
    else if (isPtr(a.ty) && isPtr(b.ty)) ty = a.ty.base.kind === 'void' ? b.ty : a.ty;
    else if (isPtr(a.ty) && isInt(b.ty)) { ty = a.ty; b = this.cast(b, ty); }
    else if (isInt(a.ty) && isPtr(b.ty)) { ty = b.ty; a = this.cast(a, ty); }
    else if (isAgg(a.ty) && typeKey(a.ty) === typeKey(b.ty)) ty = a.ty;
    else if (isClass(a.ty) && !isClass(b.ty)) { ty = a.ty; b = this.toClass(b, ty, tok); }
    else if (isClass(b.ty) && !isClass(a.ty)) { ty = b.ty; a = this.toClass(a, ty, tok); }
    else fail(tok, 'incompatible operand types (' + typeName(a.ty) + ' and ' + typeName(b.ty) + ')');
    return this.node('cond', ty, tok, { c: cc, a, b });
  }

  isLvalue(e) {
    if (e.k === 'var' || e.k === 'deref' || e.k === 'compound') return true;
    if (e.k === 'member') return this.isLvalue(e.e) || isAgg(e.e.ty);
    if (e.k === 'comma' && isAgg(e.ty)) return true;
    if (e.k === 'call' && isAgg(e.ty)) return true;
    return false;
  }

  addrOf(e, tok) {
    if (e.k === 'deref') return this.rv(e.e).ty.kind === 'ptr' ? Object.assign({}, this.rv(e.e), { ty: ptrTo(e.ty) }) : e.e;
    if (e.k === 'call' || e.k === 'comma' || e.k === 'cond') return this.node('addr', ptrTo(e.ty), tok || e.tok, { e });
    if (!this.isLvalue(e)) fail(tok || e.tok, 'cannot take the address of an rvalue of type ' + typeName(e.ty));
    this.markAddr(e);
    return this.node('addr', ptrTo(e.ty), tok || e.tok, { e });
  }

  bindRef(e, B, tok) {
    if (e.k === 'ovl' || e.k === 'mset') e = this.rv(e);
    if (B.kind === 'auto') B = e.ty;
    if (isClass(B)) {
      if (isClass(e.ty) && this.derivesFrom(e.ty, B) && this.isLvalue(e)) return this.cast(this.addrOf(e, tok), refTo(B));
      if (isClass(e.ty) && this.derivesFrom(e.ty, B) && e.k === 'cond') {
        // c ? T(a) : T(b): materialize whichever branch runs in one temporary
        const t = this.newTemp(e.ty, tok);
        const tv = this.node('var', e.ty, tok, { obj: t });
        return this.node('comma', refTo(B), tok, { a: this.initFromExpr(t, tv, e.ty, e, tok), b: this.cast(this.addrOf(tv, tok), refTo(B)) });
      }
      const o = this.newTemp(B, tok);
      const v = this.node('var', B, tok, { obj: o });
      return this.node('comma', refTo(B), tok, { a: this.construct(v, B, [e], tok), b: this.cast(this.addrOf(v, tok), refTo(B)) });
    }
    if (this.isLvalue(e) && e.ty.kind !== 'array' && sameType(e.ty, B) && e.ty.kind === B.kind && !!e.ty.unsigned === !!B.unsigned) return this.cast(this.addrOf(e, tok), refTo(B));
    if (B.kind === 'array' && e.ty.kind === 'array' && this.isLvalue(e)) return this.cast(this.addrOf(e, tok), refTo(B));
    const o = this.newLocal(null, B, tok);
    o.addrTaken = true;
    const v = this.node('var', B, tok, { obj: o });
    return this.node('comma', refTo(B), tok, { a: this.node('assign', B, tok, { lhs: v, rhs: this.assignConv(e, B, tok, 'binding') }), b: this.cast(this.addrOf(v, tok), refTo(B)) });
  }

  isPrvalueTemp(e) {
    return (e.k === 'call' && e.retTemp && e.ret === e.retTemp) || (e.k === 'comma' && e.elide);
  }

  // a class value of type ty built from e (a temporary when a conversion is needed)
  toClass(e, ty, tok) {
    if (isClass(e.ty) && this.derivesFrom(e.ty, ty)) return e.ty === ty ? e : this.sliceTo(e, ty);
    const o = this.newTemp(ty, tok);
    const v = this.node('var', ty, tok, { obj: o });
    const conv = this.convertingCtor(ty, e);
    if (!conv) fail(tok, 'cannot convert ' + typeName(e.ty) + ' to ' + typeName(ty));
    return this.node('comma', ty, tok, { a: this.callFunc(conv, [e], v, tok, { nonVirtual: true }), b: v });
  }

  convertingCtor(ty, e) {
    const cands = ty.cls.ctors.filter(c => !c.explicit && !c.isDeleted && c.type.params.length >= 2 && c.defaults.slice(1).every((d, i) => i + 2 >= c.type.params.length || d) && !this.isCopyCtor(c, ty));
    let best = null, bestRank = -1;
    for (const c of cands) {
      const r = this.convRank(e, c.type.params[1], true);
      if (r > bestRank) { best = c; bestRank = r; }
    }
    return bestRank >= 0 ? best : null;
  }

  convOp(ty, target) {
    for (let c = ty; c; c = c.cls.base) {
      for (const [name, list] of c.cls.methods) {
        if (!name.startsWith('operator ')) continue;
        for (const f of list) {
          const ct = f.convType;
          if (!ct) continue;
          if (target === null) return f;
          if (target.kind === 'bool' && (isScalar(ct))) return f;
          if (sameType(ct, target) && ct.kind === target.kind) return f;
        }
      }
    }
    if (target !== null) {
      for (let c = ty; c; c = c.cls.base) for (const [name, list] of c.cls.methods) if (name.startsWith('operator ')) for (const f of list) if (f.convType && isNum(f.convType) && isNum(target)) return f;
    }
    return null;
  }

  assignConv(e, ty, tok, what) {
    if (e.k === 'ovl') e = this.pickFunction(e, ty, tok);
    else if (e.k === 'mset') e = this.rv(e);
    if (isRef(ty)) return this.bindRef(e, ty.base, tok);
    if (isClass(ty)) return this.toClass(this.rv(e), ty, tok);
    if (isClass(e.ty)) {
      const op = this.convOp(e.ty, ty);
      if (!op) fail(tok, what + ' ' + typeName(e.ty) + ' to incompatible type ' + typeName(ty));
      return super.assignConv(this.callFunc(op, [], e, tok), ty, tok, what);
    }
    return super.assignConv(e, ty, tok, what);
  }

  pickFunction(e, ty, tok) {
    const want = ty && ty.kind === 'ptr' && ty.base.kind === 'func' ? ty.base : null;
    let f = null;
    if (want) f = e.fns.find(x => x.type.params.length === want.params.length && x.type.params.every((p, i) => typeKey(p) === typeKey(want.params[i])));
    if (!f && e.fns.length === 1) f = e.fns[0];
    if (!f) fail(tok, 'cannot resolve the address of overloaded function ' + (e.fns[0] ? e.fns[0].name : ''));
    return this.node('func', f.type, tok, { fn: f });
  }

  rv(e) {
    if (e.k === 'ovl') {
      if (e.fns.length !== 1) fail(e.tok, 'reference to overloaded function could not be resolved; call it or cast it');
      return super.rv(this.node('func', e.fns[0].type, e.tok, { fn: e.fns[0] }));
    }
    if (e.k === 'mset') {
      const st = e.fns.filter(f => f.isStatic);
      if (st.length === 1) return super.rv(this.node('func', st[0].type, e.tok, { fn: st[0] }));
      fail(e.tok, 'pointers to member functions are not supported; call the member function instead');
    }
    return super.rv(e);
  }

  toCond(e) {
    if (isClass(e.ty)) {
      const op = this.convOp(e.ty, T.bool);
      if (!op) fail(e.tok, 'value of type ' + typeName(e.ty) + ' is not contextually convertible to bool');
      return this.cast(this.callFunc(op, [], e, e.tok), T.bool);
    }
    return super.toCond(e);
  }

  // =================================================================
  //  Overload resolution
  // =================================================================
  scalarRank(e, pt) {
    let v = e.ty;
    if (v.kind === 'array') v = ptrTo(v.base);
    else if (v.kind === 'func') v = ptrTo(v);
    if (v.kind === 'void' || isClass(v)) return -1;
    const isNull = (e.k === 'num' && e.val === 0n && isInt(e.ty)) || (e.k === 'num' && isPtr(e.ty) && e.val === 0n);
    if (isPtr(pt)) {
      if (isPtr(v)) {
        if (isPtr(e.ty) && e.k === 'num') return 5;     // nullptr
        if (typeKey(v.base) === typeKey(pt.base)) return 5;
        if (v.base.kind === 'func' && pt.base.kind === 'func') return 4;
        if (pt.base.kind === 'void') return 3;
        if (isClass(v.base) && isClass(pt.base) && this.derivesFrom(v.base, pt.base)) return 3;
        if (v.base.kind === 'void') return 1;
        if (sameType(v.base, pt.base)) return 4;
        return -1;
      }
      if (isNull) return 3;
      return -1;
    }
    if (pt.kind === 'bool') return v.kind === 'bool' ? 5 : (isNum(v) || isPtr(v)) ? 2 : -1;
    if (isNum(pt)) {
      if (!isNum(v)) return -1;
      if (v.kind === pt.kind && v.size === pt.size && !!v.unsigned === !!pt.unsigned && !v.isEnum === !pt.isEnum) return 5;
      if (v.isEnum && pt.kind === 'int' && !pt.unsigned && !pt.isEnum) return 4;
      if (isInt(v) && v.size < 4 && pt.kind === 'int' && !pt.unsigned && !pt.isEnum) return 4;
      if (v.kind === 'float' && pt.kind === 'double') return 4;
      if (pt.isEnum) return -1;
      return 3;
    }
    return -1;
  }

  convRank(e, pt, noUser) {
    if (e.k === 'ovl') return pt.kind === 'ptr' && pt.base.kind === 'func' ? 4 : -1;
    if (e.k === 'mset') return -1;
    if (isRef(pt)) {
      const B = pt.base;
      if (isClass(B)) {
        if (isClass(e.ty) && this.derivesFrom(e.ty, B)) return e.ty === B ? 5 : 4;
        if (noUser) return -1;
        return this.convertingCtor(B, e) ? 1.5 : -1;
      }
      if (isClass(e.ty)) return !noUser && this.convOp(e.ty, B) ? 1.5 : -1;
      if (this.isLvalue(e) && sameType(e.ty, B) && e.ty.kind === B.kind && !!e.ty.unsigned === !!B.unsigned) return 5;
      const r = this.scalarRank(e, B);
      return r >= 0 ? r - 0.5 : -1;
    }
    if (isClass(pt)) {
      if (isClass(e.ty) && this.derivesFrom(e.ty, pt)) return e.ty === pt ? 5 : 4;
      if (noUser) return -1;
      return this.convertingCtor(pt, e) ? 1.5 : -1;
    }
    if (isClass(e.ty)) return !noUser && this.convOp(e.ty, pt) ? 1.5 : -1;
    return this.scalarRank(e, pt);
  }

  scoreCall(f, args, hasObj) {
    const params = f.type.params.slice(f.isMethod && !f.isStatic ? 1 : 0);
    if (args.length > params.length && !f.type.variadic) return null;
    for (let i = args.length; i < params.length; i++) if (!f.defaults || !f.defaults[i]) return null;
    const ranks = [];
    for (let i = 0; i < args.length; i++) {
      const r = i < params.length ? this.convRank(args[i], params[i]) : (isClass(args[i].ty) ? -1 : 1);
      if (r < 0) return null;
      ranks.push(r);
    }
    void hasObj;
    return ranks;
  }

  resolve(cands, args, tok, name, objArg) {
    let best = null, bestRanks = null, tie = false;
    const better = (a, b) => {
      let gt = false, lt = false;
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0, y = b[i] || 0;
        if (x > y) gt = true; else if (x < y) lt = true;
      }
      if (gt && !lt) return 1;
      if (lt && !gt) return -1;
      const sa = a.reduce((s, x) => s + x, 0), sb = b.reduce((s, x) => s + x, 0);
      return sa > sb ? 1 : sa < sb ? -1 : 0;
    };
    for (const c of cands) {
      if (c.f.isDeleted) continue;
      if (objArg && c.f.isMethod && !c.f.isStatic && !(isClass(objArg.ty) && this.derivesFrom(objArg.ty, c.f.cls))) continue;
      const r = this.scoreCall(c.f, args, !!objArg);
      if (!r) continue;
      if (!best) { best = c; bestRanks = r; tie = false; continue; }
      let cmp = better(r, bestRanks);
      if (cmp === 0 && !!c.f.templateOf !== !!best.f.templateOf) cmp = c.f.templateOf ? -1 : 1;
      if (cmp === 0 && c.f.isConst !== best.f.isConst) cmp = c.f.isConst ? -1 : 1;
      if (cmp > 0) { best = c; bestRanks = r; tie = false; }
      else if (cmp === 0) tie = true;
    }
    if (!best) {
      const sig = name + '(' + args.map(a => a.k === 'ovl' ? '<function>' : typeName(a.ty)).join(', ') + ')';
      const list = cands.slice(0, 4).map(c => '  candidate: ' + (c.f.qname || c.f.name) + '(' + c.f.type.params.slice(c.f.isMethod && !c.f.isStatic ? 1 : 0).map(typeName).join(', ') + ')').join('\n');
      fail(tok, 'no matching function for call to ' + sig + (list ? '\n' + list : ''));
    }
    if (tie) fail(tok, "call to '" + name + "' is ambiguous");
    return best;
  }

  // =================================================================
  //  Calls
  // =================================================================
  argList() {
    const args = [];
    if (this.accept(')')) return args;
    for (;;) {
      const saved = this.noGT;
      this.noGT = false;
      args.push(this.assign());
      this.noGT = saved;
      if (this.accept(')')) return args;
      this.expect(',');
    }
  }

  braceArgs() {
    this.expect('{');
    const args = [];
    if (this.accept('}')) return args;
    for (;;) {
      args.push(this.is('{') ? this.braceTemp() : this.assign());
      if (this.accept('}')) return args;
      this.expect(',');
      if (this.accept('}')) return args;
    }
  }

  braceTemp() { fail(this.tok, 'nested brace initializers are not supported here'); }

  promoteVarArg(a) {
    let v = this.rv(a);
    if (isClass(v.ty)) fail(a.tok, 'cannot pass an object of type ' + typeName(v.ty) + ' through ...');
    if (isFlo(v.ty)) return this.cast(v, T.double);
    if (isInt(v.ty)) return this.cast(v, promote(v.ty));
    return v;
  }

  convertArg(e, pt, tok) {
    if (isRef(pt)) return this.bindRef(e, pt.base, tok);
    if (isClass(pt)) {
      if (!this.nontrivialPass(pt)) return this.toClass(this.rv(e), pt, tok);
      if (isClass(e.ty) && e.ty === pt && this.isPrvalueTemp(e)) return e;
      const o = this.newTemp(pt, tok);
      const v = this.node('var', pt, tok, { obj: o });
      const init = isClass(e.ty) && this.derivesFrom(e.ty, pt) ? this.copyConstruct(v, e, pt, tok) : this.construct(v, pt, [e], tok);
      return this.node('comma', pt, tok, { a: init, b: v });
    }
    return this.assignConv(e, pt, tok, 'passing');
  }

  callFunc(f, args, objLv, tok, opts) {
    opts = opts || {};
    const fty = f.type;
    const inst = f.isMethod && !f.isStatic;
    const params = fty.params.slice(inst ? 1 : 0);
    const full = args.slice();
    for (let i = args.length; i < params.length; i++) {
      const d = f.defaults && f.defaults[i];
      if (!d) fail(tok, "too few arguments to '" + (f.qname || f.name) + "'");
      full.push(d);
    }
    if (full.length > params.length && !fty.variadic) fail(tok, "too many arguments to '" + (f.qname || f.name) + "'");
    const conv = full.map((a, i) => i < params.length ? this.convertArg(a, params[i], a.tok || tok) : this.promoteVarArg(a));
    let thisArg = null;
    if (inst) {
      if (!objLv) fail(tok, "calling non-static member function '" + f.qname + "' requires an object");
      thisArg = this.cast(this.addrOf(objLv, tok), ptrTo(f.cls));
    }
    if (inst && f.isVirtual && !opts.nonVirtual && this.isDynamic(objLv)) return this.virtualCall(f, thisArg, conv, tok);
    const n = this.node('call', fty.ret, tok, { f: this.node('func', fty, tok, { fn: f }), args: thisArg ? [thisArg].concat(conv) : conv, fty, nfixed: fty.params.length });
    return this.finishCall(n, fty, tok);
  }

  finishCall(n, fty, tok) {
    if (isAgg(fty.ret)) {
      if (!fty.ret.complete) fail(tok, 'calling a function with incomplete return type');
      const o = this.newTemp(fty.ret, tok);
      n.ret = o; n.retTemp = o;
    }
    if (isRef(fty.ret)) { n.ty = fty.ret; return this.node('deref', fty.ret.base, tok, { e: n }); }
    return n;
  }

  isDynamic(lv) {
    if (lv.k === 'var') return isRef(lv.obj.type);
    if (lv.k === 'member') return false;
    if (lv.k === 'comma' || lv.k === 'call') return false;
    return true;
  }

  virtualCall(f, thisArg, conv, tok) {
    const tp = this.newLocal(null, ptrTo(f.cls), tok);
    const tv = () => this.node('var', tp.type, tok, { obj: tp });
    const set = this.node('assign', tp.type, tok, { lhs: tv(), rhs: thisArg });
    const obj = this.node('deref', f.cls, tok, { e: tv() });
    const vp = this.vptrMember(obj, f.cls);
    const slot = this.node('deref', ptrTo(T.void), tok, { e: this.node('padd', vp.ty, tok, { a: vp, b: this.num(f.vslot, T.long, tok), size: 8 }) });
    const callee = this.cast(slot, ptrTo(f.type));
    const n = this.node('call', f.type.ret, tok, { f: callee, args: [tv()].concat(conv), fty: f.type, nfixed: f.type.params.length });
    const r = this.finishCall(n, f.type, tok);
    return this.node('comma', r.ty, tok, { a: set, b: r });
  }

  call(fe, tok) {
    const args = this.argList();
    return this.applyCall(fe, args, tok);
  }

  applyCall(fe, args, tok) {
    if (fe.k === 'ovl') {
      const cands = fe.fns.map(f => ({ f }));
      for (const t of fe.templates || []) {
        const f = this.deduceAndInstantiate(t, args, fe.explicitArgs || [], tok);
        if (f) cands.push({ f });
      }
      const name = (fe.fns[0] || (fe.templates && fe.templates[0]) || { name: '?' }).name;
      const best = this.resolve(cands, args, tok, name);
      return this.callFunc(best.f, args, null, tok);
    }
    if (fe.k === 'mset') {
      const cands = fe.fns.filter(f => fe.obj || f.isStatic).map(f => ({ f }));
      if (!cands.length) fail(tok, "calling non-static member function '" + fe.fns[0].name + "' requires an object");
      const best = this.resolve(cands, args, tok, fe.fns[0].name, fe.obj);
      return this.callFunc(best.f, args, best.f.isStatic ? null : fe.obj, tok, { nonVirtual: fe.qualified });
    }
    if (isClass(fe.ty)) {
      const r = this.callOperator('operator()', [fe].concat(args), tok, true);
      if (r) return r;
      fail(tok, 'object of type ' + typeName(fe.ty) + ' is not callable');
    }
    let fty, target = fe;
    if (fe.ty.kind === 'func') fty = fe.ty;
    else {
      const v = this.rv(fe);
      if (isPtr(v.ty) && v.ty.base.kind === 'func') { fty = v.ty.base; target = v; }
      else fail(tok, 'called object type ' + typeName(fe.ty) + ' is not a function or function pointer');
    }
    if (fe.k === 'func') return this.callFunc(fe.fn, args, null, tok);
    if (args.length < fty.params.length || (!fty.variadic && args.length > fty.params.length)) fail(tok, 'wrong number of arguments to function pointer');
    const conv = args.map((a, i) => i < fty.params.length ? this.convertArg(a, fty.params[i], a.tok || tok) : this.promoteVarArg(a));
    const n = this.node('call', fty.ret, tok, { f: target, args: conv, fty, nfixed: fty.params.length });
    return this.finishCall(n, fty, tok);
  }

  // operator lookup: members of the left operand's class, then free functions (incl. the operands' namespaces)
  callOperator(opName, args, tok, memberOnly) {
    const cands = [];
    const a = args[0];
    if (isClass(a.ty)) {
      const m = this.classMember(a.ty, opName);
      if (m && m.methods) for (const f of m.methods) if (!f.isStatic) cands.push({ f, member: true });
    }
    if (!memberOnly) {
      const seen = new Set();
      const addFree = (entry) => {
        if (!entry || !entry.ovl) return;
        for (const f of entry.ovl) if (!seen.has(f) && !f.isMethod) { seen.add(f); cands.push({ f }); }
        for (const t of entry.templates || []) {
          const f = this.deduceAndInstantiate(t, args, [], tok, true);
          if (f && !seen.has(f)) { seen.add(f); cands.push({ f }); }
        }
      };
      addFree(this.findVar(opName));
      for (const x of args) if (isClass(x.ty)) addFree(this.nsLookup(x.ty.cls.ns, opName, new Set()));
    }
    if (!cands.length) return null;
    // members take the left operand as the object, so compare them on the remaining arguments
    let best = null, bestScore = null;
    const scored = [];
    for (const c of cands) {
      const r = c.member ? (isClass(a.ty) && this.derivesFrom(a.ty, c.f.cls) ? this.scoreCall(c.f, args.slice(1)) : null) : this.scoreCall(c.f, args);
      if (!r) continue;
      const full = c.member ? [5].concat(r) : r;
      scored.push({ c, full });
    }
    for (const s of scored) {
      if (!best) { best = s.c; bestScore = s.full; continue; }
      const sum = (x) => x.reduce((p, q) => p + q, 0);
      if (sum(s.full) > sum(bestScore) || (sum(s.full) === sum(bestScore) && best.f.isConst && !s.c.f.isConst)) { best = s.c; bestScore = s.full; }
    }
    if (!best) return null;
    if (best.member) return this.callFunc(best.f, args.slice(1), a, tok);
    return this.callFunc(best.f, args, null, tok);
  }

  binHook(op, a, b, tok) {
    if (!isClass(a.ty) && !isClass(b.ty)) return null;
    const r = this.callOperator('operator' + op, [a, b], tok);
    if (r) return r;
    // a class with a conversion to a scalar (operator bool, operator int, ...)
    const conv = (x) => isClass(x.ty) ? (() => { const f = this.convOp(x.ty, null); return f ? this.callFunc(f, [], x, tok) : null; })() : x;
    const ca = conv(a), cb = conv(b);
    if (ca && cb && !isClass(ca.ty) && !isClass(cb.ty)) {
      if (op === '+') return this.add(ca, cb, tok);
      if (op === '-') return this.sub(ca, cb, tok);
      if (['==', '!=', '<', '<=', '>', '>='].includes(op)) return this.compare(op, ca, cb, tok);
      return this.arith(op, ca, cb, tok);
    }
    fail(tok, 'no operator' + op + ' matching operands of type ' + typeName(a.ty) + ' and ' + typeName(b.ty));
  }

  assignHook(op, lhs, rhs, tok) {
    if (!isClass(lhs.ty)) {
      if (isClass(rhs.ty) && op === '=') {
        const f = this.convOp(rhs.ty, lhs.ty);
        if (f) return this.node('assign', lhs.ty, tok, { lhs, rhs: this.assignConv(this.callFunc(f, [], rhs, tok), lhs.ty, tok, 'assigning') });
      }
      if (lhs.k === 'mset' || lhs.k === 'ovl') fail(tok, 'expression is not assignable');
      return null;
    }
    const opName = 'operator' + op;
    const r = this.callOperator(opName, [lhs, rhs], tok, op === '=');
    if (r) return r;
    if (op === '=') {
      const src = isClass(rhs.ty) && this.derivesFrom(rhs.ty, lhs.ty) ? rhs : this.toClass(this.rv(rhs), lhs.ty, tok);
      return this.assignObject(lhs, src, lhs.ty, tok);
    }
    fail(tok, 'no ' + opName + ' for ' + typeName(lhs.ty));
  }

  incdec(e, pre, inc, tok) {
    if (isClass(e.ty)) {
      const name = inc ? 'operator++' : 'operator--';
      const r = pre ? this.callOperator(name, [e], tok) : this.callOperator(name, [e, this.num(0, T.int, tok)], tok);
      if (r) return r;
      fail(tok, 'no ' + name + (pre ? '()' : '(int)') + ' for ' + typeName(e.ty));
    }
    return super.incdec(e, pre, inc, tok);
  }

  // =================================================================
  //  Expressions
  // =================================================================
  unary() {
    const tok = this.tok;
    if (tok.k === 'id' && tok.v === 'new') return this.newExpr();
    if (tok.k === 'id' && tok.v === 'delete') return this.deleteExpr();
    if (tok.k === 'id' && (tok.v === 'throw')) fail(tok, 'exceptions are not supported (the Minimal-OS SDK builds with -fno-exceptions)');
    if (tok.k === 'punct' && ['-', '+', '!', '~', '*', '&'].includes(tok.v)) {
      this.next();
      const e = this.castExpr();
      if (isClass(e.ty) && tok.v !== '&') {
        const r = this.callOperator('operator' + tok.v, [e], tok);
        if (r) return r;
        if (tok.v === '!') return this.node('not', T.bool, tok, { e: this.toCond(e) });
        fail(tok, 'no operator' + tok.v + ' for ' + typeName(e.ty));
      }
      return this.builtinUnary(tok, e);
    }
    if (tok.k === 'punct' && (tok.v === '++' || tok.v === '--')) {
      this.next();
      const e = this.unary();
      return this.incdec(e, true, tok.v === '++', tok);
    }
    return super.unary();
  }

  builtinUnary(tok, operand) {
    const MCCwrap = MCC.wrapInt;
    switch (tok.v) {
      case '+': { const e = this.rv(operand); if (!isNum(e.ty)) fail(tok, 'invalid argument to unary +'); return this.cast(e, promote(e.ty)); }
      case '-': {
        const e = this.rv(operand);
        if (!isNum(e.ty)) fail(tok, 'invalid argument to unary -');
        const ty = promote(e.ty);
        if (e.k === 'num') return { k: 'num', ty, val: MCCwrap(-e.val, ty), tok };
        if (e.k === 'fnum') return { k: 'fnum', ty, val: -e.val, tok };
        return this.node('neg', ty, tok, { e: this.cast(e, ty) });
      }
      case '!': { const e = this.toCond(operand); if (e.k === 'num') return this.num(e.val === 0n ? 1 : 0, T.bool, tok); return this.node('not', T.bool, tok, { e }); }
      case '~': {
        const e = this.rv(operand);
        if (!isInt(e.ty)) fail(tok, 'invalid argument to unary ~');
        const ty = promote(e.ty);
        if (e.k === 'num') return { k: 'num', ty, val: MCCwrap(~e.val, ty), tok };
        return this.node('bitnot', ty, tok, { e: this.cast(e, ty) });
      }
      case '&': {
        const e = operand;
        if (e.k === 'ovl') return this.rv(e);
        if (e.k === 'deref') return this.rv(e.e).ty.kind === 'ptr' ? Object.assign({}, this.rv(e.e), { ty: ptrTo(e.ty) }) : e.e;
        if (e.ty.kind === 'func') return this.node('addr', ptrTo(e.ty), tok, { e });
        return this.addrOf(e, tok);
      }
      case '*': {
        const e = this.rv(operand);
        if (!isPtr(e.ty)) fail(tok, 'indirection requires pointer operand (' + typeName(e.ty) + ' invalid)');
        if (e.ty.base.kind === 'func') return e;
        if (e.ty.base.kind === 'void') fail(tok, "dereferencing a 'void *' pointer");
        return this.node('deref', e.ty.base, tok, { e });
      }
    }
  }

  castExpr() {
    if (this.is('(') && this.isTypename(this.peek(1))) {
      const save = this.p;
      const tok = this.next();
      const ty = this.typename();
      this.expect(')');
      if (this.is('{') && !isClass(ty)) { this.p = save; return super.castExpr(); }
      return this.cppCast(ty, this.castExpr(), tok, 'c');
    }
    return super.castExpr();
  }

  cppCast(ty, e, tok, kind) {
    if (ty.kind === 'void') return this.node('cast', T.void, tok, { e: this.rv(e) });
    if (isRef(ty)) {
      const B = ty.base;
      if (isClass(e.ty) && isClass(B)) return this.node('deref', B, tok, { e: this.cast(this.addrOf(e, tok), ptrTo(B)) });
      if (this.isLvalue(e)) return this.node('deref', B, tok, { e: this.cast(this.addrOf(e, tok), ptrTo(B)) });
      return this.node('deref', B, tok, { e: this.bindRef(e, B, tok) });
    }
    if (isClass(ty)) {
      const o = this.newTemp(ty, tok);
      const v = this.node('var', ty, tok, { obj: o });
      const r = this.node('comma', ty, tok, { a: this.construct(v, ty, [e], tok), b: v });
      r.elide = { obj: o, args: [e] };
      return r;
    }
    if (isClass(e.ty)) {
      const f = this.convOp(e.ty, ty);
      if (!f) fail(tok, 'cannot convert ' + typeName(e.ty) + ' to ' + typeName(ty));
      return this.cast(this.callFunc(f, [], e, tok), ty);
    }
    const v = e.k === 'ovl' ? this.pickFunction(e, ty, tok) : e;
    const r = this.rv(v);
    if (!isScalar(ty)) fail(tok, 'cannot cast to ' + typeName(ty));
    if (!isScalar(r.ty)) fail(tok, 'cannot cast ' + typeName(r.ty) + ' to ' + typeName(ty));
    void kind;
    const c = this.cast(r, ty);
    return c === r && c.k !== 'num' ? this.node('cast', ty, tok, { e: r }) : c;
  }

  newExpr() {
    const tok = this.next();
    if (this.is('(')) fail(tok, 'placement new is not supported');
    const base = this.declspec(null);
    const ty = this.pointers(base);
    if (ty.kind === 'auto') fail(tok, "'new auto' is not supported");
    let count = null;
    if (this.accept('[')) { count = this.expr(); this.expect(']'); }
    let args = null, braced = false;
    if (this.accept('(')) args = this.argList();
    else if (this.is('{')) { braced = true; args = this.braceArgs(); }
    if (count) return this.newArray(ty, count, args, tok);
    if (isClass(ty) && !ty.complete) fail(tok, 'allocation of incomplete type ' + typeName(ty));
    const p = this.newLocal(null, ptrTo(ty), tok);
    const pv = () => this.node('var', p.type, tok, { obj: p });
    const alloc = this.cast(this.callFunc(this.rt.alloc, [this.num(ty.size, T.ulong, tok)], null, tok), ptrTo(ty));
    const set = this.node('assign', p.type, tok, { lhs: pv(), rhs: alloc });
    const target = this.node('deref', ty, tok, { e: pv() });
    let init;
    if (isClass(ty)) init = this.construct(target, ty, args || [], tok, braced);
    else if (args && args.length) init = this.node('assign', ty, tok, { lhs: target, rhs: this.assignConv(args[0], ty, tok, 'initializing') });
    else init = this.nop(tok);
    return this.node('comma', p.type, tok, { a: this.node('comma', T.void, tok, { a: set, b: init }), b: pv() });
  }

  newArray(ty, count, args, tok) {
    if (args && args.length) fail(tok, 'array new with initializers is not supported');
    const cookie = isClass(ty) && !this.trivialDtor(ty);
    const n = this.newLocal(null, T.ulong, tok), raw = this.newLocal(null, ptrTo(T.char), tok);
    const nv = () => this.node('var', T.ulong, tok, { obj: n }), rawv = () => this.node('var', raw.type, tok, { obj: raw });
    const parts = [];
    parts.push(this.node('assign', T.ulong, tok, { lhs: nv(), rhs: this.assignConv(count, T.ulong, tok, 'sizing') }));
    let bytes = this.arith('*', nv(), this.num(ty.size, T.ulong, tok), tok);
    if (cookie) bytes = this.arith('+', bytes, this.num(8, T.ulong, tok), tok);
    parts.push(this.node('assign', raw.type, tok, { lhs: rawv(), rhs: this.cast(this.callFunc(this.rt.alloc, [bytes], null, tok), raw.type) }));
    let p = rawv();
    if (cookie) {
      parts.push(this.node('assign', T.ulong, tok, { lhs: this.node('deref', T.ulong, tok, { e: this.cast(rawv(), ptrTo(T.ulong)) }), rhs: nv() }));
      p = this.add(rawv(), this.num(8, T.long, tok), tok);
    }
    const pt = this.cast(p, ptrTo(ty));
    if (isClass(ty) && this.needsDefaultInit(ty)) {
      const c = this.elementCtor(ty, tok);
      parts.push(this.callFunc(this.rt.arrayCtor, [this.cast(pt, ptrTo(T.void)), nv(), this.num(ty.size, T.ulong, tok), this.funcAddr(c, tok)], null, tok));
    }
    let chain = parts[0];
    for (const x of parts.slice(1)) chain = this.node('comma', T.void, tok, { a: chain, b: x });
    return this.node('comma', ptrTo(ty), tok, { a: chain, b: this.cast(p, ptrTo(ty)) });
  }

  deleteExpr() {
    const tok = this.next();
    let array = false;
    if (this.is('[')) { this.next(); this.expect(']'); array = true; }
    const e = this.rv(this.castExpr());
    if (!isPtr(e.ty)) fail(tok, 'cannot delete expression of type ' + typeName(e.ty));
    const ty = e.ty.base;
    const p = this.newLocal(null, e.ty, tok);
    const pv = () => this.node('var', p.type, tok, { obj: p });
    const set = this.node('assign', p.type, tok, { lhs: pv(), rhs: e });
    const free = (x) => this.callFunc(this.rt.free, [this.cast(x, ptrTo(T.void))], null, tok);
    let body;
    if (!array) {
      if (isClass(ty) && !this.trivialDtor(ty)) {
        const d = this.dtorOf(ty, tok);
        body = this.node('comma', T.void, tok, { a: this.callFunc(d, [], this.node('deref', ty, tok, { e: pv() }), tok), b: free(pv()) });
      } else body = free(pv());
    } else if (isClass(ty) && !this.trivialDtor(ty)) {
      const raw = this.sub(this.cast(pv(), ptrTo(T.char)), this.num(8, T.long, tok), tok);
      const n = this.node('deref', T.ulong, tok, { e: this.cast(raw, ptrTo(T.ulong)) });
      const d = this.dtorOf(ty, tok);
      body = this.node('comma', T.void, tok, {
        a: this.callFunc(this.rt.arrayDtor, [this.cast(pv(), ptrTo(T.void)), n, this.num(ty.size, T.ulong, tok), this.funcAddr(d, tok)], null, tok),
        b: free(this.sub(this.cast(pv(), ptrTo(T.char)), this.num(8, T.long, tok), tok)),
      });
    } else body = free(pv());
    return this.node('comma', T.void, tok, { a: set, b: this.node('cond', T.void, tok, { c: this.toCond(pv()), a: body, b: this.nop(tok) }) });
  }

  primary() {
    const tok = this.tok;
    if (tok.k === 'punct' && tok.v === '(') {
      const saved = this.noGT;
      this.noGT = false;
      try { return super.primary(); } finally { this.noGT = saved; }
    }
    if (tok.k === 'punct' && tok.v === '[') fail(tok, 'lambda expressions are not supported');
    if (tok.k === 'id') {
      switch (tok.v) {
        case 'this': this.next(); if (!this.thisObj) fail(tok, "invalid use of 'this' outside of a non-static member function"); return this.node('var', this.thisObj.type, tok, { obj: this.thisObj });
        case 'true': case 'false': this.next(); return this.num(tok.v === 'true' ? 1 : 0, T.bool, tok);
        case 'nullptr': this.next(); return { k: 'num', ty: ptrTo(T.void), val: 0n, tok };
        case 'static_cast': case 'reinterpret_cast': case 'const_cast': case 'dynamic_cast': {
          if (tok.v === 'dynamic_cast') fail(tok, 'dynamic_cast needs RTTI, which Minimal-OS programs are built without');
          this.next(); this.expect('<');
          const saved = this.noGT; this.noGT = true;
          const ty = this.typename();
          this.noGT = saved;
          if (!this.closeAngle()) fail(this.tok, "expected '>'");
          this.expect('(');
          const e = this.expr();
          this.expect(')');
          return this.cppCast(ty, e, tok, tok.v);
        }
        case 'typeid': fail(tok, 'typeid needs RTTI, which Minimal-OS programs are built without'); break;
        case 'sizeof': case 'alignof': return super.unary();
      }
      if (!/^(__func__|__FUNCTION__|__PRETTY_FUNCTION__|__builtin_\w+|__syscall)$/.test(tok.v)) return this.idExpr();
    }
    if (tok.k === 'punct' && tok.v === '::') return this.idExpr();
    return super.primary();
  }

  idExpr() {
    const start = this.tok;
    // builtin type used as a functional cast: int(x), bool(y)
    if (start.k === 'id' && (TYPE_WORDS.has(start.v) || start.v === 'bool') && !KEYWORDS.has(start.v) === false) {
      const ty = this.declspec(null);
      if (this.accept('(')) { const args = this.argList(); return args.length ? this.cppCast(ty, args[0], start, 'f') : this.cast(this.num(0, T.int, start), ty); }
      fail(start, "unexpected type name");
    }
    const r = this.qualifiedName();
    if (!r) fail(start, "expected an expression before '" + start.v + "'");
    const e = r.entry, tok = r.tok;
    if (!e) {
      if (this.is('(')) fail(tok, "use of undeclared function '" + r.name + "' (include the header that declares it)");
      fail(tok, "use of undeclared identifier '" + r.name + "'");
    }
    if (e.typedef) {
      if (this.is('(') || this.is('{')) return this.functionalCast(e.type, tok);
      fail(tok, "unexpected type name '" + r.name + "'");
    }
    if (e.enumConst) return this.num(e.value, e.type && e.type.isEnum ? T.int : (e.type || T.int), tok);
    if (e.obj) return this.varRef(e.obj, tok);
    if (e.field) {
      if (!this.thisObj) fail(tok, "invalid use of member '" + r.name + "' outside a member function");
      return this.memberRef(this.thisDeref(tok), e.field, tok);
    }
    if (e.methods) {
      const obj = this.thisObj && this.thisObj.type.base && this.derivesFrom(this.thisObj.type.base, e.cls) ? this.thisDeref(tok) : null;
      return this.node('mset', T.void, tok, { fns: e.methods, obj, qualified: !!r.owner });
    }
    if (e.ovl || e.templates) return this.node('ovl', T.void, tok, { fns: e.ovl || [], templates: e.templates || [], explicitArgs: e.explicitArgs });
    if (e.template) {
      if (e.template.kind === 'func') return this.node('ovl', T.void, tok, { fns: [], templates: [e.template], explicitArgs: e.explicitArgs });
      fail(tok, "class template '" + r.name + "' used without template arguments");
    }
    if (e.func) return this.node('func', e.func.type, tok, { fn: e.func });
    if (e.ns) fail(tok, "namespace '" + r.name + "' used as a value");
    fail(tok, "cannot use '" + r.name + "' here");
  }

  varRef(o, tok) {
    const n = this.node('var', o.type, tok, { obj: o });
    return isRef(o.type) ? this.node('deref', o.type.base, tok, { e: n }) : n;
  }

  functionalCast(ty, tok) {
    let args, braced = false;
    if (this.accept('(')) args = this.argList();
    else { braced = true; args = this.braceArgs(); }
    if (!isClass(ty)) {
      if (args.length === 0) return isFlo(ty) ? { k: 'fnum', ty, val: 0, tok } : this.cast(this.num(0, T.int, tok), ty);
      if (args.length > 1) fail(tok, 'too many arguments to a functional cast');
      return this.cppCast(ty, args[0], tok, 'f');
    }
    if (!ty.complete) fail(tok, 'incomplete type ' + typeName(ty));
    const o = this.newTemp(ty, tok);
    const v = this.node('var', ty, tok, { obj: o });
    const r = this.node('comma', ty, tok, { a: this.construct(v, ty, args, tok, braced), b: v });
    r.elide = { obj: o, args, braced };
    return r;
  }

  postfixFrom(e) {
    for (;;) {
      const tok = this.tok;
      if (tok.k !== 'punct') return e;
      if (this.noGT && (tok.v === '>' || tok.v === '>>')) return e;
      if (tok.v === '[') {
        this.next();
        const saved = this.noGT; this.noGT = false;
        const idx = this.expr();
        this.noGT = saved;
        this.expect(']');
        if (isClass(e.ty)) {
          const r = this.callOperator('operator[]', [e, idx], tok, true);
          if (!r) fail(tok, 'no operator[] for ' + typeName(e.ty));
          e = r;
          continue;
        }
        const p = this.add(e, idx, tok);
        if (!isPtr(p.ty)) fail(tok, 'subscripted value is not an array or pointer');
        if (p.ty.base.kind === 'void') fail(tok, "subscript of a 'void *' pointer");
        e = this.node('deref', p.ty.base, tok, { e: p });
        continue;
      }
      if (tok.v === '(') { this.next(); e = this.call(e, tok); continue; }
      if (tok.v === '.' || tok.v === '->') {
        this.next();
        let base = e;
        if (tok.v === '->') {
          if (isClass(e.ty)) {
            const r = this.callOperator('operator->', [e], tok, true);
            if (!r) fail(tok, 'no operator-> for ' + typeName(e.ty));
            base = this.rv(r);
          } else base = this.rv(e);
          if (!isPtr(base.ty) || !isAgg(base.ty.base)) fail(tok, 'member reference type ' + typeName(base.ty) + ' is not a pointer to a class');
          base = this.node('deref', base.ty.base, tok, { e: base });
        } else if (!isAgg(e.ty)) fail(tok, 'member reference base type ' + typeName(e.ty) + ' is not a class');
        if (!base.ty.complete) fail(tok, 'incomplete type ' + typeName(base.ty));
        e = this.memberAccess(base, tok);
        continue;
      }
      if (tok.v === '++' || tok.v === '--') { this.next(); e = this.incdec(e, false, tok.v === '++', tok); continue; }
      return e;
    }
  }

  memberAccess(base, tok) {
    if (this.is('template')) this.next();
    if (this.is('~')) {
      this.next();
      this.ident();
      this.expect('('); this.expect(')');
      return isClass(base.ty) ? this.destroy(base, base.ty, tok) : this.nop(tok);
    }
    let owner = base.ty, qualified = false;
    // obj.Base::member
    if (this.tok.k === 'id' && this.is('::', 1)) {
      const q = this.qualifiedName();
      if (!q || !q.owner || !isClass(q.owner)) fail(tok, 'expected a member name');
      owner = q.owner; qualified = true;
      return this.memberFrom(base, owner, q.name, q.tok, qualified);
    }
    let name;
    if (this.is('operator')) name = this.operatorName().name;
    else name = this.ident().v;
    return this.memberFrom(base, owner, name, this.t[this.p - 1], qualified);
  }

  memberFrom(base, owner, name, ntok, qualified) {
    if (!isClass(owner)) {
      const m = owner.members.find(x => x.name === name);
      if (!m) fail(ntok, "no member named '" + name + "' in " + typeName(owner));
      return this.node('member', m.type, ntok, { e: base, mem: m });
    }
    const r = this.classMember(owner, name);
    if (!r) fail(ntok, "no member named '" + name + "' in " + typeName(base.ty));
    if (r.field) return this.memberRef(base, r.field, ntok);
    if (r.methods) return this.node('mset', T.void, ntok, { fns: r.methods, obj: base, qualified });
    if (r.obj) return this.varRef(r.obj, ntok);
    if (r.enumConst) return this.num(r.value, T.int, ntok);
    fail(ntok, "'" + name + "' is not a data member or member function");
  }

  // =================================================================
  //  Statements
  // =================================================================
  compound(isFuncBody) {
    const tok = this.expect('{');
    if (!isFuncBody) this.push();
    this.blockLevel++;
    const items = [];
    try {
      while (!this.accept('}')) {
        if (this.tok.k === 'eof') fail(tok, 'expected } at end of input');
        this.blockItem(items);
      }
      const fr = this.top();
      if (fr.cleanups && fr.cleanups.length && !this.endsWithJump(items)) items.push(...this.frameCleanups(fr));
    } finally {
      this.blockLevel--;
      if (!isFuncBody) this.pop();
    }
    return { k: 'block', items, tok };
  }

  blockItem(items) {
    if (this.is('_Static_assert') || this.is('static_assert')) { this.staticAssert(); return; }
    if (this.is('using')) { this.usingDecl(); return; }
    if (this.is('namespace')) fail(this.tok, 'namespaces cannot be declared inside a function');
    if (this.is('template')) fail(this.tok, 'templates cannot be declared inside a function');
    if (this.isDeclStart() && !this.is(':', 1)) { this.localDecl(items); return; }
    items.push(this.stmt());
  }

  endsWithJump(items) {
    const last = items[items.length - 1];
    if (!last) return false;
    if (last.k === 'return' || last.k === 'break' || last.k === 'continue') return true;
    if (last.k === 'block' && last.noScope) return this.endsWithJump(last.items);
    return false;
  }

  frameCleanups(fr, except) {
    const out = [];
    for (let j = fr.cleanups.length - 1; j >= 0; j--) {
      const c = fr.cleanups[j];
      if (c.obj === except) continue;
      const lv = c.obj.nrvo ? this.node('deref', c.type, c.obj.tok, { e: this.node('var', c.obj.type, c.obj.tok, { obj: c.obj }) }) : this.node('var', c.type, c.obj.tok, { obj: c.obj });
      const d = c.guard ? this.node('cond', T.void, c.obj.tok, { c: this.node('var', c.guard.type, c.obj.tok, { obj: c.guard }), a: this.destroy(lv, c.type, c.obj.tok), b: this.nop(c.obj.tok) }) : this.destroy(lv, c.type, c.obj.tok);
      out.push(this.exprStmt(d));
    }
    return out;
  }

  cleanupsFrom(idx, except) {
    const out = [];
    for (let i = this.scopes.length - 1; i >= idx && i >= 0; i--) if (this.scopes[i].cleanups) out.push(...this.frameCleanups(this.scopes[i], except));
    return out;
  }

  condition() {
    const { e, temps } = this.fullExpr(() => this.expr());
    return this.wrapTemps(this.toCond(e), temps);
  }

  stmt() {
    const tok = this.tok;
    if (tok.k === 'id') {
      switch (tok.v) {
        case 'if': {
          this.next();
          if (this.is('constexpr')) this.next();
          this.expect('(');
          const c = this.condition();
          this.expect(')');
          const a = this.scopedStmt();
          const b = this.accept('else') ? this.scopedStmt() : null;
          return { k: 'if', c, a, b, tok };
        }
        case 'while': {
          this.next(); this.expect('(');
          const c = this.condition();
          this.expect(')');
          const body = this.loopBody();
          return { k: 'while', c, body, tok };
        }
        case 'do': {
          this.next();
          const body = this.loopBody();
          this.expect('while'); this.expect('(');
          const c = this.condition();
          this.expect(')'); this.expect(';');
          return { k: 'dowhile', c, body, tok };
        }
        case 'for': return this.forStmt();
        case 'switch': {
          this.next(); this.expect('(');
          const full = this.fullExpr(() => this.expr());
          let e = this.rv(full.e);
          if (isClass(e.ty)) { const f = this.convOp(e.ty, T.int); if (!f) fail(tok, 'switch quantity is not an integer'); e = this.rv(this.callFunc(f, [], e, tok)); }
          if (!isInt(e.ty)) fail(tok, 'switch quantity is not an integer');
          e = this.wrapTemps(this.cast(e, promote(e.ty)), full.temps);
          this.expect(')');
          const sw = { k: 'switch', e, cases: [], hasDefault: false, tok, level: this.blockLevel + 1 };
          const saved = this.sw;
          this.sw = sw;
          this.breakable++;
          this.breakFrames.push(this.scopes.length);
          try { sw.body = this.stmt(); }
          finally { this.breakFrames.pop(); this.breakable--; this.sw = saved; }
          return sw;
        }
        case 'break': {
          this.next(); this.expect(';');
          if (!this.breakable) fail(tok, "'break' statement not in loop or switch statement");
          const cl = this.cleanupsFrom(this.breakFrames[this.breakFrames.length - 1]);
          return cl.length ? { k: 'block', items: cl.concat([{ k: 'break', tok }]), tok, noScope: true } : { k: 'break', tok };
        }
        case 'continue': {
          this.next(); this.expect(';');
          if (!this.continuable) fail(tok, "'continue' statement not in loop statement");
          const cl = this.cleanupsFrom(this.contFrames[this.contFrames.length - 1]);
          return cl.length ? { k: 'block', items: cl.concat([{ k: 'continue', tok }]), tok, noScope: true } : { k: 'continue', tok };
        }
        case 'return': return this.returnStmt();
        case 'try': case 'throw': fail(tok, 'exceptions are not supported (the Minimal-OS SDK builds with -fno-exceptions)'); break;
        case 'goto': fail(tok, "'goto' is not supported by the Studio compiler"); break;
        case 'case': case 'default': return super.stmt();
      }
    }
    if (this.is('{')) return this.compound(false);
    if (this.accept(';')) return { k: 'empty', tok };
    const { e, temps } = this.fullExpr(() => this.expr());
    this.expect(';');
    if (e.k === 'ovl' || e.k === 'mset') fail(tok, 'expression has no effect (did you forget the parentheses of a call?)');
    return { k: 'expr', e: this.wrapTemps(e, temps, true), tok };
  }

  // a statement that gets its own scope (if/else branches, loop bodies)
  scopedStmt() {
    if (this.is('{')) return this.compound(false);
    this.push();
    try {
      const items = [];
      this.blockItem(items);
      const fr = this.top();
      if (fr.cleanups.length && !this.endsWithJump(items)) items.push(...this.frameCleanups(fr));
      return items.length === 1 ? items[0] : { k: 'block', items, tok: this.tok, noScope: true };
    } finally { this.pop(); }
  }

  loopBody() {
    this.breakable++; this.continuable++;
    this.breakFrames.push(this.scopes.length);
    this.contFrames.push(this.scopes.length);
    try { return this.scopedStmt(); }
    finally { this.breakFrames.pop(); this.contFrames.pop(); this.breakable--; this.continuable--; }
  }

  isRangeFor() {
    // a ':' at parenthesis depth 0 before the closing ')'
    let depth = 0;
    for (let i = this.p; i < this.t.length; i++) {
      const t = this.t[i];
      if (t.k !== 'punct') continue;
      if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') { if (depth === 0) return false; depth--; }
      else if (t.v === ';' && depth === 0) return false;
      else if (t.v === '?' && depth === 0) return false;
      else if (t.v === ':' && depth === 0) return true;
    }
    return false;
  }

  forStmt() {
    const tok = this.next();
    this.expect('(');
    this.push();
    try {
      if (this.isRangeFor()) return this.rangeFor(tok);
      const pre = [];
      if (this.isDeclStart()) this.localDecl(pre);
      else if (!this.accept(';')) { const { e, temps } = this.fullExpr(() => this.expr()); pre.push({ k: 'expr', e: this.wrapTemps(e, temps, true), tok }); this.expect(';'); }
      const c = this.is(';') ? null : this.condition();
      this.expect(';');
      let step = null;
      if (!this.is(')')) { const { e, temps } = this.fullExpr(() => this.expr()); step = this.wrapTemps(e, temps, true); }
      this.expect(')');
      const body = this.loopBody();
      const loop = { k: 'for', init: null, c, step, body, tok };
      const fr = this.top();
      const items = pre.concat([loop], fr.cleanups.length ? this.frameCleanups(fr) : []);
      return { k: 'block', items, tok, noScope: true };
    } finally { this.pop(); }
  }

  rangeFor(tok) {
    const attr = {};
    const base = this.declspec(attr);
    const d = this.declarator(base);
    this.expect(':');
    const range = this.expr();
    this.expect(')');
    const items = [];
    let begin, end;
    if (range.ty.kind === 'array') {
      begin = this.rv(range);
      end = this.add(this.rv(range), this.num(range.ty.len, T.long, tok), tok);
    } else if (isClass(range.ty)) {
      const call = (name) => { const m = this.memberFrom(range, range.ty, name, tok); return this.applyCall(m, [], tok); };
      begin = call('begin'); end = call('end');
    } else fail(tok, 'cannot iterate over a value of type ' + typeName(range.ty));
    const declare = (name, e) => {
      const ty = isClass(e.ty) ? e.ty : this.rv(e).ty;
      const o = this.newLocal(name, ty, tok);
      if (isClass(ty)) { o.addrTaken = true; items.push(this.exprStmt(this.copyConstruct(this.node('var', ty, tok, { obj: o }), e, ty, tok))); this.registerCleanup(o, ty); }
      else items.push(this.exprStmt(this.node('assign', ty, tok, { lhs: this.node('var', ty, tok, { obj: o }), rhs: this.rv(e) })));
      return o;
    };
    const it = declare('$it' + this.uid, begin), en = declare('$end' + this.uid, end);
    const itv = () => this.node('var', it.type, tok, { obj: it }), env = () => this.node('var', en.type, tok, { obj: en });
    const c = this.toCond(this.compare('!=', itv(), env(), tok));
    const step = this.incdec(itv(), true, true, tok);
    // body: the loop variable, then the user's statement
    this.breakable++; this.continuable++;
    this.push();
    this.breakFrames.push(this.scopes.length - 1);
    this.contFrames.push(this.scopes.length - 1);
    let body;
    try {
      const bitems = [];
      const elem = isClass(it.type) ? this.callOperator('operator*', [itv()], tok) : this.node('deref', it.type.base, tok, { e: itv() });
      if (!elem) fail(tok, 'the iterator has no operator*');
      this.declareInit(d, attr, elem, bitems, tok);
      bitems.push(this.stmt());
      const fr = this.top();
      if (fr.cleanups.length && !this.endsWithJump(bitems)) bitems.push(...this.frameCleanups(fr));
      body = { k: 'block', items: bitems, tok, noScope: true };
    } finally { this.breakFrames.pop(); this.contFrames.pop(); this.pop(); this.breakable--; this.continuable--; }
    items.push({ k: 'for', init: null, c, step, body, tok });
    const fr = this.top();
    if (fr.cleanups.length) items.push(...this.frameCleanups(fr));
    return { k: 'block', items, tok, noScope: true };
  }

  returnStmt() {
    const tok = this.next();
    const f = this.fn;
    const rt = f.type.ret;
    const cleanups = this.cleanupsFrom(this.fnFrame);
    if (this.accept(';')) {
      const r = rt.kind !== 'void' && !f.isCtor && !f.isDtor ? { k: 'return', e: null, tok, missing: !isAgg(rt), agg: isAgg(rt) } : { k: 'return', e: null, tok };
      return cleanups.length ? { k: 'block', items: cleanups.concat([r]), tok, noScope: true } : r;
    }
    const { e, temps } = this.fullExpr(() => this.is('{') ? this.braceInitExpr(rt, tok) : this.expr());
    this.expect(';');
    if (e.k === 'deref' && e.e.k === 'var' && e.e.obj.nrvo && !temps.length) {
      // the named return value already lives in the caller's result slot
      return { k: 'block', items: this.cleanupsFrom(this.fnFrame, e.e.obj).concat([{ k: 'return', e: null, tok, agg: true }]), tok, noScope: true };
    }
    if (rt.kind === 'void') {
      if (e.ty.kind !== 'void') fail(tok, 'void function should not return a value');
      return { k: 'block', items: [this.exprStmt(this.wrapTemps(e, temps, true))].concat(cleanups, [{ k: 'return', e: null, tok }]), tok, noScope: true };
    }
    if (isAgg(rt)) {
      const slot = this.node('deref', rt, tok, { e: this.node('retslot', ptrTo(rt), tok, {}) });
      let init;
      if (isClass(rt)) {
        if (e.k === 'call' && e.ty === rt && e.retTemp && e.ret === e.retTemp) {
          // the callee constructs straight into our own result slot
          temps.splice(temps.indexOf(e.retTemp) >>> 0, 1);
          e.ret = null; e.retTemp = null;
          e.retExpr = this.node('retslot', ptrTo(rt), tok, {});
          init = e;
        } else if (e.elide && e.ty === rt) {
          temps.splice(temps.indexOf(e.elide.obj) >>> 0, 1);
          init = this.construct(slot, rt, e.elide.args, tok, e.elide.braced);
        } else if (isClass(e.ty) && this.derivesFrom(e.ty, rt)) init = this.copyConstruct(slot, e, rt, tok);
        else init = this.construct(slot, rt, [e], tok);
      } else {
        if (!sameType(this.rv(e).ty, rt)) fail(tok, 'returning ' + typeName(e.ty) + ' from a function with result type ' + typeName(rt));
        init = this.node('assign', rt, tok, { lhs: slot, rhs: e });
      }
      return { k: 'block', items: [this.exprStmt(this.wrapTemps(init, temps, true))].concat(cleanups, [{ k: 'return', e: null, tok, agg: true }]), tok, noScope: true };
    }
    const v = isRef(rt) ? this.cast(this.addrOf(e, tok), rt) : this.assignConv(e, rt, tok, 'returning');
    if (!temps.length && !cleanups.length) return { k: 'return', e: v, tok };
    const t = this.newLocal(null, rt, tok);
    const set = this.node('assign', rt, tok, { lhs: this.node('var', rt, tok, { obj: t }), rhs: v });
    return { k: 'block', items: [this.exprStmt(this.wrapTemps(set, temps, true))].concat(cleanups, [{ k: 'return', e: this.node('var', rt, tok, { obj: t }), tok }]), tok, noScope: true };
  }

  braceInitExpr(ty, tok) {
    if (!isClass(ty)) fail(tok, 'braced return values are only supported for classes');
    const args = this.braceArgs();
    const o = this.newTemp(ty, tok);
    const v = this.node('var', ty, tok, { obj: o });
    const r = this.node('comma', ty, tok, { a: this.construct(v, ty, args, tok, true), b: v });
    r.elide = { obj: o, args, braced: true };
    return r;
  }

  usingDecl() {
    const tok = this.next();
    if (this.accept('namespace')) {
      const r = this.qualifiedName();
      if (!r || !r.entry || !r.entry.ns) fail(tok, 'expected a namespace name');
      this.expect(';');
      const fr = this.top();
      if (fr.kind === 'ns') fr.ns.usings.push(r.entry.ns);
      else (fr.usings || (fr.usings = [])).push(r.entry.ns);
      return;
    }
    if (this.tok.k === 'id' && this.is('=', 1)) {
      const name = this.next().v; this.next();
      const ty = this.typename();
      this.expect(';');
      this.declareType(name, ty);
      return;
    }
    const r = this.qualifiedName(true);
    if (!r || !r.entry) fail(tok, 'expected a qualified name');
    this.expect(';');
    this.declare(r.name, r.entry);
  }

  // ---- declarations inside functions ----
  registerCleanup(o, ty, guard) {
    if (this.trivialDtor(ty)) return;
    for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].cleanups) { this.scopes[i].cleanups.push({ obj: o, type: ty, guard }); return; }
  }

  localDecl(items) {
    if (this.is('using')) { this.usingDecl(); return; }
    const attr = {};
    const base = this.declspec(attr);
    if (this.accept(';')) return;
    for (;;) {
      const d = this.declarator(base);
      if (attr.typedef) this.declareType(d.name, d.type);
      else if (d.type.kind === 'func') {
        const f = this.declareFree(d, attr, this.currentNs(), { local: true });
        void f;
      } else if (attr.extern) {
        const g = this.currentNs().vars.get(d.name);
        if (g && g.obj) this.declare(d.name, g);
        else {
          const o = this.newGlobal(d.name, d.type, { tok: d.tok });
          this.currentNs().vars.set(d.name, { obj: o, type: d.type });
          this.declare(d.name, { obj: o, type: d.type });
        }
      } else if (attr.static) this.staticLocal(d, items);
      else this.declareInit(d, attr, undefined, items, d.tok);
      if (!this.accept(',')) break;
    }
    this.expect(';');
  }

  // parse (or use) the initializer of a local and emit its initialization
  declareInit(d, attr, given, items, tok) {
    let ty = d.type;
    let init = null;            // {kind: 'expr'|'args'|'braced'|'brace-agg', e, args}
    const temps = [];
    const saved = this.temps;
    this.temps = temps;
    try {
      if (given !== undefined) init = { kind: 'expr', e: given };
      else if (this.accept('=')) {
        if (this.is('{') && !(isClass(ty) && ty.cls.ctors.length)) init = { kind: 'brace-agg' };
        else if (this.is('{')) init = { kind: 'braced', args: this.braceArgs() };
        else init = { kind: 'expr', e: this.assign() };
      } else if (this.is('(') && !hasAuto(ty) && !(this.is(')', 1))) {
        this.next();
        init = { kind: 'args', args: this.argList() };
      } else if (this.is('{')) {
        if (isClass(ty) && !ty.cls.ctors.length && !ty.cls.base && !ty.cls.hasVptr) init = { kind: 'brace-agg' };
        else if (!isClass(ty) && !hasAuto(ty)) init = { kind: 'brace-agg' };
        else init = { kind: 'braced', args: this.braceArgs() };
      }
      if (hasAuto(ty)) {
        if (!init || (init.kind !== 'expr' && !(init.kind === 'braced' && init.args.length === 1) && !(init.kind === 'args' && init.args.length === 1))) fail(d.tok, "declaration of '" + d.name + "' with type auto needs an initializer");
        const e = init.kind === 'expr' ? init.e : init.args[0];
        init = { kind: 'expr', e };
        ty = this.deduceAuto(ty, e, d.tok);
      }
      if (ty.kind === 'void') fail(d.tok, "variable '" + d.name + "' has type void");
      if (isRef(ty)) {
        if (!init || init.kind === 'brace-agg') fail(d.tok, "reference '" + d.name + "' needs an initializer");
        const e = init.kind === 'expr' ? init.e : init.args[0];
        const o = this.newLocal(d.name, ty, d.tok);
        items.push(this.exprStmt(this.wrapTemps(this.node('assign', ty, d.tok, { lhs: this.node('var', ty, d.tok, { obj: o }), rhs: this.bindRef(e, ty.base, d.tok) }), this.liftTemps(temps), true)));
        return o;
      }
      if (isClass(ty)) {
        if (!ty.complete) fail(d.tok, "variable '" + d.name + "' has incomplete type " + typeName(ty));
        let o, v;
        if (this.nrvo && this.nrvo.name === d.name && !this.nrvo.used && this.fn && this.fn.type.ret === ty && !(init && init.kind === 'brace-agg')) {
          // named return value: construct it straight into the result slot
          this.nrvo.used = true;
          o = this.newLocal(d.name, refTo(ty), d.tok);
          o.nrvo = true;
          items.push(this.exprStmt(this.node('assign', o.type, d.tok, { lhs: this.node('var', o.type, d.tok, { obj: o }), rhs: this.node('retslot', o.type, d.tok, {}) })));
          v = this.node('deref', ty, d.tok, { e: this.node('var', o.type, d.tok, { obj: o }) });
        } else {
          o = this.newLocal(d.name, ty, d.tok);
          o.addrTaken = true;
          v = this.node('var', ty, d.tok, { obj: o });
        }
        let e;
        if (!init) e = this.defaultInit(v, ty, d.tok);
        else if (init.kind === 'brace-agg') { this.temps = saved; const ini = this.initializer(ty, o, false); this.temps = temps; items.push({ k: 'init', obj: o, init: ini, tok: d.tok }); this.registerCleanup(o, ty); return o; }
        else if (init.kind === 'args' || init.kind === 'braced') e = this.construct(v, ty, init.args, d.tok, init.kind === 'braced');
        else e = this.initFromExpr(o, v, ty, init.e, d.tok);
        if (e) items.push(this.exprStmt(this.wrapTemps(e, temps, true)));
        this.registerCleanup(o, ty);
        return o;
      }
      // scalars, arrays, C structs
      const o = this.newLocal(d.name, ty, d.tok);
      if (!init) {
        if (ty.kind === 'array' && ty.len < 0) fail(d.tok, "array '" + d.name + "' needs an explicit size or an initializer");
        if (ty.kind === 'array' && isClass(ty.base)) {
          if (this.needsDefaultInit(ty)) { o.addrTaken = true; items.push(this.exprStmt(this.defaultInit(this.node('var', ty, d.tok, { obj: o }), ty, d.tok))); }
          this.registerCleanup(o, ty);
          return o;
        }
        items.push({ k: 'decl', obj: o, tok: d.tok });
        return o;
      }
      if (init.kind === 'brace-agg') {
        this.temps = temps;
        const ini = this.initializer(ty, o, false);
        o.type = ini.type;
        this.findVar(d.name).type = o.type;
        if (temps.length) fail(d.tok, 'temporaries in this initializer are not supported');
        items.push({ k: 'init', obj: o, init: ini, tok: d.tok });
        if (ty.kind === 'array' && isClass(ty.base)) this.registerCleanup(o, o.type);
        return o;
      }
      const e = init.kind === 'expr' ? init.e : (init.args.length === 1 ? init.args[0] : fail(d.tok, 'too many initializers'));
      if (ty.kind === 'array') {
        // char s[] = "..." goes through the C initializer
        fail(d.tok, 'arrays must be initialized with = { ... } or a string literal');
      }
      const v = this.assignConv(e, ty, d.tok, 'initializing');
      items.push(this.exprStmt(this.wrapTemps(this.node('assign', ty, d.tok, { lhs: this.node('var', ty, d.tok, { obj: o }), rhs: v }), temps, true)));
      return o;
    } finally { this.temps = saved; }
  }

  liftTemps(temps) {
    // temporaries bound to a reference live as long as the reference
    for (const o of temps) this.registerCleanup(o, o.type, o.guard);
    const rest = [];
    rest.guards = temps.guards;
    return rest;
  }

  initFromExpr(o, v, ty, e, tok) {
    // T x = c ? T(a) : T(b);  builds x in whichever branch runs
    if (e.k === 'cond' && e.ty === ty) return this.node('cond', T.void, tok, { c: e.c, a: this.initFromExpr(o, v, ty, e.a, tok), b: this.initFromExpr(o, v, ty, e.b, tok) });
    if (e.k === 'comma' && e.guardSet && e.ty === ty) return this.node('comma', T.void, tok, { a: e.a, b: this.initFromExpr(o, v, ty, e.b, tok) });
    if (isClass(e.ty) && e.ty === ty && e.k === 'call' && e.retTemp && e.ret === e.retTemp) {
      // construct the result of the call directly in the variable
      this.dropTemp(e.retTemp);
      e.ret = o;
      return e;
    }
    if (e.elide && e.ty === ty) {
      this.dropTemp(e.elide.obj);
      return this.construct(v, ty, e.elide.args, tok, e.elide.braced);
    }
    if (isClass(e.ty) && this.derivesFrom(e.ty, ty)) return this.copyConstruct(v, e, ty, tok);
    const conv = this.convertingCtor(ty, e);
    if (!conv) fail(tok, 'no viable conversion from ' + typeName(e.ty) + ' to ' + typeName(ty));
    return this.callFunc(conv, [e], v, tok, { nonVirtual: true });
  }

  deduceAuto(ty, e, tok) {
    if (ty.kind === 'auto') {
      if (e.k === 'ovl' || e.k === 'mset') e = this.rv(e);
      let t = e.ty;
      if (t.kind === 'array') t = ptrTo(t.base);
      if (t.kind === 'func') t = ptrTo(t);
      if (t.kind === 'void') fail(tok, 'cannot deduce auto from a void expression');
      return t;
    }
    if (isRef(ty) && ty.base.kind === 'auto') return refTo(e.ty);
    if (ty.kind === 'ptr' && ty.base.kind === 'auto') { const t = this.rv(e).ty; if (!isPtr(t)) fail(tok, 'auto* needs a pointer initializer'); return ptrTo(t.base); }
    fail(tok, 'unsupported use of auto');
  }

  staticLocal(d, items) {
    const ty = d.type;
    const o = this.newGlobal(this.fn.qname + '::' + d.name + '$' + this.uid, ty, { isStatic: true, defined: true, tok: d.tok, displayName: d.name });
    this.declare(d.name, { obj: o, type: ty });
    const dynamic = isClass(ty) && (this.needsDefaultInit(ty) || this.is('(') || this.is('{') || this.is('='));
    if (!dynamic) {
      if (this.accept('=')) {
        const savedFn = this.fn;
        const ini = this.initializer(ty, o, true);
        this.fn = savedFn;
        o.init = ini; o.type = ini.type;
        if (!this.isConstantInit(ini)) {
          // initialize once, the first time control passes here
          o.init = null;
          const guard = this.newGlobal(o.name + '$guard', T.bool, { isStatic: true, defined: true, tok: d.tok });
          const gv = () => this.node('var', T.bool, d.tok, { obj: guard });
          const set = ini.entries.map(en => en.expr && !en.bytes && !isAgg(en.ty) ? this.node('assign', en.ty, d.tok, { lhs: this.node('var', ty, d.tok, { obj: o }), rhs: en.expr }) : null).filter(Boolean);
          if (set.length !== 1 || ini.entries.length !== 1) fail(d.tok, 'static local needs a constant initializer');
          items.push({ k: 'if', c: this.node('not', T.bool, d.tok, { e: gv() }), a: { k: 'block', items: [this.exprStmt(this.node('assign', T.bool, d.tok, { lhs: gv(), rhs: this.num(1, T.bool, d.tok) })), this.exprStmt(set[0])], tok: d.tok }, b: null, tok: d.tok });
        }
      }
      return;
    }
    const guard = this.newGlobal(o.name + '$guard', T.bool, { isStatic: true, defined: true, tok: d.tok });
    const gv = () => this.node('var', T.bool, d.tok, { obj: guard });
    const tmp = [];
    // parse the initializer as a local declaration and move its statements under the guard
    const fake = this.newLocal(null, ty, d.tok);
    void fake;
    const lv = this.node('var', ty, d.tok, { obj: o });
    const { e, temps } = this.fullExpr(() => {
      if (this.accept('(')) return this.construct(lv, ty, this.argList(), d.tok);
      if (this.is('{')) return this.construct(lv, ty, this.braceArgs(), d.tok, true);
      if (this.accept('=')) { const x = this.assign(); return isClass(x.ty) ? this.copyConstruct(lv, x, ty, d.tok) : this.construct(lv, ty, [x], d.tok); }
      return this.defaultInit(lv, ty, d.tok);
    });
    tmp.push(this.exprStmt(this.node('assign', T.bool, d.tok, { lhs: gv(), rhs: this.num(1, T.bool, d.tok) })));
    tmp.push(this.exprStmt(this.wrapTemps(e, temps, true)));
    items.push({ k: 'if', c: this.node('not', T.bool, d.tok, { e: gv() }), a: { k: 'block', items: tmp, tok: d.tok }, b: null, tok: d.tok });
  }

  isConstantInit(ini) {
    for (const en of ini.entries) {
      if (en.bytes) continue;
      if (isAgg(en.ty)) return false;
      try { MCC.evalInitConst(en.expr); } catch (e) { return false; }
    }
    return true;
  }

  // =================================================================
  //  Functions
  // =================================================================
  declareFree(d, attr, ns, opts) {
    const ft = d.type;
    const name = d.name;
    const tmplArgs = opts.templateInstance ? '<' + opts.templateInstance.args.map(argText).join(', ') + '>' : '';
    const qname = (ns && ns.qname ? ns.qname + '::' : '') + name + tmplArgs;
    // the SDK's C headers have no extern "C" blocks: everything they declare has C linkage
    const sdkC = !!(d.tok && d.tok.file && d.tok.file.startsWith('<sdk>/') && d.tok.file.endsWith('.h'));
    const linkC = this.linkC || sdkC || (name === 'main' && (!ns || ns === this.rootNs));
    const uname = linkC ? name : qname + '(' + ft.params.map(typeKey).join(',') + ')';
    let f = this.funcs.get(uname);
    if (!f || (opts.templateInstance && f.templateOf !== opts.templateInstance.rec)) {
      f = { name: name + tmplArgs, qname, uname, type: ft, tok: d.tok, defined: false, isStatic: !!attr.static, isInline: !!attr.inline || !!opts.templateInstance,
        params: [], locals: [], body: null, id: this.uid++, defaults: ft.defaults || [], linkC, ns };
      if (opts.templateInstance) f.templateOf = opts.templateInstance.rec;
      this.funcs.set(uname, f);
    } else {
      if (ft.defaults && ft.defaults.some(Boolean)) f.defaults = ft.defaults;
      if (!f.defined) f.type = ft;
    }
    if (!opts.templateInstance) {
      const scope = opts.local ? this.top().vars : (ns || this.currentNs()).vars;
      let entry = scope.get(name);
      if (!entry || !entry.ovl) { entry = { ovl: [], templates: (entry && entry.templates) || [] }; scope.set(name, entry); }
      if (!entry.ovl.includes(f)) entry.ovl.push(f);
    }
    return f;
  }

  // the frames a definition outside its class/namespace needs for name lookup
  contextFrames(ns, cls) {
    const frames = this.scopes.slice();
    const chain = [];
    for (let n = ns; n && n !== this.rootNs; n = n.parent) chain.unshift(n);
    for (const n of chain) if (!frames.some(fr => fr.ns === n)) frames.push({ kind: 'ns', ns: n, vars: n.vars, tags: n.tags });
    const cls_ = [];
    for (let c = cls; c; c = c.cls.outer) cls_.unshift(c);
    for (const c of cls_) frames.push({ kind: 'class', cls: c, vars: new Map(), tags: new Map() });
    return frames;
  }

  // `T x ...; return x;` - when every return in the body returns the same
  // local, declared once, that local is built in the result slot (as GCC does)
  nrvoCandidate() {
    const t = this.t;
    let i = this.p, depth = 0;
    const names = [];
    for (; i < t.length; i++) {
      const x = t[i];
      if (x.k === 'eof') return null;
      if (x.k === 'punct' && x.v === '{') depth++;
      else if (x.k === 'punct' && x.v === '}') { if (--depth === 0) break; }
      else if (x.k === 'id' && x.v === 'return') {
        const a = t[i + 1], b = t[i + 2];
        if (!(a && a.k === 'id' && b && b.k === 'punct' && b.v === ';')) return null;
        names.push(a.v);
      }
    }
    if (!names.length || names.some(n => n !== names[0])) return null;
    const name = names[0];
    let decls = 0;
    for (let j = this.p; j < i; j++) {
      const x = t[j], prev = t[j - 1], nx = t[j + 1];
      if (x.k === 'id' && x.v === name && prev && (prev.k === 'id' || (prev.k === 'punct' && (prev.v === '>' || prev.v === '*' || prev.v === '&'))) &&
          nx && nx.k === 'punct' && ['(', '{', '=', ';', ','].includes(nx.v) && !(prev.k === 'id' && prev.v === 'return')) decls++;
    }
    return decls === 1 ? { name, used: false } : null;
  }

  defineBody(f, tok, opts) {
    opts = opts || {};
    if (f.defined) fail(tok, "redefinition of '" + (f.qname || f.name) + "'");
    const saved = { scopes: this.scopes, fn: this.fn, thisObj: this.thisObj, fnFrame: this.fnFrame, temps: this.temps, breakFrames: this.breakFrames, contFrames: this.contFrames, breakable: this.breakable, continuable: this.continuable, sw: this.sw, blockLevel: this.blockLevel, nrvo: this.nrvo };
    const needCtx = f.cls && !opts.noClassFrame && !this.scopes.some(fr => fr.kind === 'class' && fr.cls === f.cls);
    if (needCtx) this.scopes = this.contextFrames(f.cls.cls.ns, f.cls);
    else if (f.ns && !f.cls && !this.scopes.some(fr => fr.ns === f.ns)) this.scopes = this.contextFrames(f.ns, null);
    f.defined = true;
    f.params = []; f.locals = [];
    f.file = tok.file;
    this.fn = f; this.temps = null; this.thisObj = null;
    this.breakFrames = []; this.contFrames = []; this.breakable = 0; this.continuable = 0; this.sw = null;
    this.scopes = this.scopes.concat([{ kind: 'fn', vars: new Map(), tags: new Map(), cleanups: [] }]);
    this.fnFrame = this.scopes.length - 1;
    try {
      const names = f.type.paramNames || [];
      f.type.params.forEach((pt, i) => {
        const n = names[i] || {};
        const isThis = i === 0 && f.isMethod && !f.isStatic;
        const o = this.newLocal(isThis ? null : n.name, pt, n.tok || f.tok);
        o.isParam = true;
        if (isThis) { o.name = 'this'; this.thisObj = o; }
        if (isClass(pt) && this.nontrivialPass(pt)) o.noCopy = true;
        f.params.push(o);
      });
      if (f.type.variadic) f.vaArea = true;
      let pre = [];
      if (f.isCtor) {
        const init = this.is(':') ? this.ctorInitList(f.cls) : new Map();
        pre = this.ctorPrologue(f.cls, init, tok);
      } else if (this.is(':')) fail(this.tok, 'only constructors have member initializer lists');
      this.nrvo = isClass(f.type.ret) && this.is('{') ? this.nrvoCandidate() : null;
      const body = this.compound(true);
      if (f.isDtor) body.items = this.dtorPrologue(f.cls, tok).concat(body.items, this.dtorEpilogue(f.cls, tok));
      if (pre.length) body.items = pre.concat(body.items);
      f.body = body;
      return f;
    } finally { Object.assign(this, saved); }
  }

  // =================================================================
  //  Templates
  // =================================================================
  templateHeader() {
    this.expect('<');
    const params = [];
    if (this.closeAngle()) return params;
    for (;;) {
      if (this.is('typename') || this.is('class')) {
        this.next();
        const name = this.tok.k === 'id' ? this.next().v : null;
        let def = null;
        if (this.accept('=')) def = this.skipTemplateDefault();
        params.push({ kind: 'type', name, def, index: params.length });
      } else {
        const ty = this.declspec(null);
        const d = this.declarator(ty, true);
        let def = null;
        if (this.accept('=')) def = this.skipTemplateDefault();
        params.push({ kind: 'value', name: d.name, type: d.type, def, index: params.length });
      }
      if (this.closeAngle()) return params;
      this.expect(',');
    }
  }

  skipTemplateDefault() {
    const start = this.p;
    let depth = 0;
    for (;;) {
      const t = this.tok;
      if (t.k === 'eof') fail(t, 'unterminated template parameter list');
      if (depth === 0 && t.k === 'punct' && (t.v === ',' || t.v === '>' || t.v === '>>')) break;
      if (t.v === '<' || t.v === '(') depth++;
      if (t.v === '>' || t.v === ')') depth--;
      this.next();
    }
    return { start, end: this.p };
  }

  placeholderFrame(params) {
    const vars = new Map();
    for (const p of params) {
      if (!p.name) continue;
      if (p.kind === 'type') vars.set(p.name, { typedef: true, type: { kind: 'tparam', name: p.name, index: p.index, size: 8, align: 8 } });
      else vars.set(p.name, { enumConst: true, value: 0n, type: p.type, placeholder: p.index });
    }
    return { kind: 'tparams', vars, tags: new Map() };
  }

  boundFrame(params, args, injectName, injectType) {
    const vars = new Map();
    params.forEach((p, i) => {
      if (!p.name) return;
      const a = args[i];
      if (p.kind === 'type') vars.set(p.name, { typedef: true, type: a.type });
      else vars.set(p.name, { enumConst: true, value: BigInt(a.value), type: p.type });
    });
    if (injectName) vars.set(injectName, { typedef: true, type: injectType });
    return { kind: 'tparams', vars, tags: new Map() };
  }

  withState(fn) {
    const keys = ['p', 'scopes', 'fn', 'thisObj', 'sw', 'blockLevel', 'breakable', 'continuable', 'temps', 'noGT', 'splitGT', 'breakFrames', 'contFrames', 'fnFrame', 'linkC'];
    const saved = {};
    for (const k of keys) saved[k] = this[k];
    this.fn = null; this.thisObj = null; this.sw = null; this.temps = null; this.noGT = false; this.splitGT = -1; this.linkC = false;
    this.breakFrames = []; this.contFrames = [];
    try { return fn(); } finally { for (const k of keys) this[k] = saved[k]; }
  }

  fillDefaults(rec, args, tok) {
    const full = args.slice();
    for (let i = args.length; i < rec.params.length; i++) {
      const p = rec.params[i];
      if (!p.def) return null;
      const v = this.withState(() => {
        this.scopes = rec.frames.concat([this.boundFrame(rec.params.slice(0, i), full)]);
        this.p = p.def.start;
        if (p.kind === 'type') return { type: this.typename() };
        const saved = this.noGT; this.noGT = true;
        const e = this.cond();
        this.noGT = saved;
        return { value: this.constInt(e), type: e.ty };
      });
      full.push(v);
    }
    if (full.length > rec.params.length) fail(tok, "too many template arguments for '" + rec.name + "'");
    full.forEach((a, i) => {
      const p = rec.params[i];
      if (p.kind === 'type' && !a.type) fail(tok, "template argument " + (i + 1) + " of '" + rec.name + "' must be a type");
      if (p.kind === 'value' && a.value === undefined) fail(tok, "template argument " + (i + 1) + " of '" + rec.name + "' must be a constant");
    });
    return full;
  }

  // errors inside a template are reported as they are, never mistaken for "not a type here"
  inInstantiation(e, name, tok) {
    if (e instanceof MCC.CompileError && !e.fatal) {
      e.fatal = true;
      if (tok && tok.line) e.message += ' (in ' + name + ', used at line ' + tok.line + ')';
    }
    return e;
  }

  instantiateClass(rec, args, tok) {
    if (args.some(a => a.type && isDependent(a.type)) || args.some(a => a.value !== undefined && a.dep)) return { kind: 'tdep', size: 8, align: 8, tmpl: rec, args };
    const full = this.fillDefaults(rec, args, tok);
    if (!full) fail(tok, "too few template arguments for '" + rec.name + "'");
    const key = full.map(argKey).join(',');
    let ty = rec.instances.get(key);
    if (ty) return ty;
    if (rec.start === undefined) fail(tok, "template '" + rec.name + "' is declared but not defined");
    const name = rec.name + '<' + full.map(argText).join(', ') + '>';
    ty = this.newClassType(rec.kw, name, rec.ns, rec.outer);
    ty.cls.template = { rec, args: full };
    ty.cls.nested.set(rec.name, { typedef: true, type: ty });
    rec.instances.set(key, ty);
    try {
      this.withState(() => {
        this.scopes = rec.frames.concat([this.boundFrame(rec.params, full, rec.name, ty)]);
        this.p = rec.start;
        this.next();               // class / struct
        this.next();               // name
        if (this.is('final')) this.next();
        this.classBody(ty, rec.kw, tok);
      });
      for (const def of rec.outOfLine) this.instantiateMemberDef(rec, ty, def);
    } catch (e) { throw this.inInstantiation(e, name, tok); }
    return ty;
  }

  instantiateMemberDef(rec, inst, def) {
    this.withState(() => {
      this.scopes = def.frames.concat([this.boundFrame(def.params, inst.cls.template.args)]);
      this.p = def.start;
      this.topDeclaration({ memberOf: inst });
    });
  }

  deduceAndInstantiate(rec, args, explicit, tok, quiet) {
    const binds = rec.params.map((_, i) => explicit[i] || null);
    const pts = rec.pattern.params;
    let ok = true;
    const unify = (p, a) => {
      if (!ok || !p || !a) return;
      if (p.kind === 'tparam') {
        if (p.index < 0 || explicit[p.index]) return;     // explicit arguments are not deduced
        const prev = binds[p.index];
        if (!prev) binds[p.index] = { type: a };
        else if (prev.type && typeKey(prev.type) !== typeKey(a)) ok = false;
        return;
      }
      if (isRef(p)) return unify(p.base, a);
      if (p.kind === 'ptr') {
        const ad = a.kind === 'array' ? ptrTo(a.base) : a.kind === 'func' ? ptrTo(a) : a;
        if (ad.kind === 'ptr') unify(p.base, ad.base); else if (isDependent(p)) ok = false;
        return;
      }
      if (p.kind === 'tdep') {
        if (isClass(a) && a.cls.template && a.cls.template.rec === p.tmpl) p.args.forEach((x, i) => { if (x.type) unify(x.type, a.cls.template.args[i].type); });
        else ok = false;
      }
    };
    for (let i = 0; i < Math.min(pts.length, args.length); i++) {
      const a = args[i];
      if (a.k === 'ovl' || a.k === 'mset') continue;
      let at = a.ty;
      if (!isRef(pts[i])) { if (at.kind === 'array') at = ptrTo(at.base); else if (at.kind === 'func') at = ptrTo(at); }
      unify(pts[i], at);
    }
    if (!ok) return null;
    for (let i = 0; i < binds.length; i++) if (!binds[i]) {
      if (!rec.params[i].def) return null;
      const full = this.fillDefaults(rec, binds.slice(0, i), tok);
      if (!full) return null;
      binds[i] = full[i];
    }
    try { return this.instantiateFunc(rec, binds, tok); }
    catch (e) { if (quiet && e instanceof MCC.CompileError && !e.fatal) return null; throw e; }
  }

  instantiateFunc(rec, args, tok) {
    const key = args.map(argKey).join(',');
    let f = rec.instances.get(key);
    if (f) return f;
    try {
      f = this.withState(() => {
        this.scopes = rec.frames.concat([this.boundFrame(rec.params, args)]);
        this.p = rec.start;
        return this.topDeclaration({ templateInstance: { rec, args } });
      });
    } catch (e) { throw this.inInstantiation(e, rec.name + '<' + args.map(argText).join(', ') + '>', tok); }
    if (!f) fail(tok, "could not instantiate '" + rec.name + "'");
    rec.instances.set(key, f);
    return f;
  }

  templateDecl() {
    const tok = this.next();       // template
    if (this.is('<') && this.is('>', 1)) { this.next(); this.next(); return this.explicitSpecialization(tok); }
    const params = this.templateHeader();
    const start = this.p;
    const frames = this.scopes.slice();
    if ((this.is('class') || this.is('struct') || this.is('union')) && this.peek(1).k === 'id' && (this.is('{', 2) || this.is(':', 2) || this.is(';', 2) || this.is('final', 2))) {
      const kw = this.next().v;
      const nameTok = this.next();
      const name = nameTok.v;
      const fr = this.top();
      const existing = fr.vars.get(name);
      let rec = existing && existing.template;
      if (!rec) {
        rec = { kind: 'class', name, kw, params, frames, instances: new Map(), outOfLine: [], ns: this.currentNs(), outer: this.currentClass() };
        this.declare(name, { template: rec });
      }
      if (this.accept(';')) return;
      if (rec.start !== undefined) fail(nameTok, "redefinition of template '" + name + "'");
      rec.start = start; rec.params = params; rec.frames = frames; rec.kw = kw;
      while (!this.is('{')) { if (this.tok.k === 'eof') fail(tok, 'expected a class body'); this.next(); }
      this.skipBalanced('{', '}');
      this.expect(';');
      return;
    }
    // a function template, or a member of a class template defined outside the class
    let d, pattern;
    this.scopes = this.scopes.concat([this.placeholderFrame(params)]);
    try {
      const ctor = this.peekSpecialDef();
      if (ctor) d = { name: ctor.name, owner: ctor.owner, tok: ctor.tok, type: this.typeSuffix(T.void) };
      else {
        const attr = {};
        const base = this.declspec(attr);
        d = this.declarator(base);
      }
      pattern = d.type;
    } finally { this.scopes = frames; }
    if (d.owner && d.owner.kind === 'tdep') {
      const rec = d.owner.tmpl;
      const def = { start, params, frames };
      if (this.is('{') || this.is(':')) this.skipFunctionBody(); else if (this.accept('=')) { this.next(); this.expect(';'); } else this.expect(';');
      rec.outOfLine.push(def);
      for (const inst of rec.instances.values()) this.instantiateMemberDef(rec, inst, def);
      return;
    }
    if (d.owner) fail(d.tok, 'member templates are not supported');
    if (pattern.kind !== 'func') fail(d.tok, 'variable templates are not supported');
    const defined = this.is('{');
    if (defined) this.skipFunctionBody(); else this.expect(';');
    const ns = this.currentNs();
    const scope = this.top().vars;
    let entry = scope.get(d.name);
    if (!entry || !entry.templates) { entry = { ovl: (entry && entry.ovl) || [], templates: [] }; scope.set(d.name, entry); }
    let rec = entry.templates.find(r => r.pattern && typeKey(r.pattern) === typeKey(pattern));
    if (!rec) { rec = { kind: 'func', name: d.name, params, frames, pattern, instances: new Map(), ns }; entry.templates.push(rec); }
    if (defined) { rec.start = start; rec.params = params; rec.frames = frames; rec.pattern = pattern; }
    else if (rec.start === undefined) rec.start = start;
  }

  // template <> R name<args>(params) { ... }  - a function template specialization
  explicitSpecialization(tok) {
    if (this.is('class') || this.is('struct') || this.is('union')) fail(tok, 'class template specialization is not supported');
    const attr = {};
    const base = this.pointers(this.declspec(attr));
    const nameTok = this.ident();
    const entry = this.findVar(nameTok.v);
    const rec = entry && entry.templates && entry.templates[0];
    if (!rec) fail(nameTok, "'" + nameTok.v + "' is not a function template");
    if (!this.is('<')) fail(this.tok, 'a specialization needs explicit template arguments');
    const args = this.fillDefaults(rec, this.templateArgs(), nameTok) || fail(nameTok, 'too few template arguments');
    const key = args.map(argKey).join(',');
    if (rec.instances.has(key)) fail(nameTok, "'" + nameTok.v + "' is already instantiated or specialized for these arguments");
    const ft = this.typeSuffix(base);
    if (ft.kind !== 'func') fail(nameTok, 'only function templates can be specialized');
    const f = this.declareFree({ name: nameTok.v, type: ft, tok: nameTok }, attr, rec.ns, { templateInstance: { rec, args } });
    rec.instances.set(key, f);
    if (this.accept(';')) return f;
    this.defineBody(f, nameTok);
    return f;
  }

  // X::X( or X::~X( at namespace scope: an out-of-line constructor or destructor
  peekSpecialDef() {
    const save = this.p;
    if (!(this.tok.k === 'id' || this.is('::'))) return null;
    let r;
    try { r = this.qualifiedName(true); } catch (e) { this.p = save; if (e instanceof MCC.CompileError && !e.fatal) return null; throw e; }
    if (r && r.owner && (isClass(r.owner) || r.owner.kind === 'tdep') && this.is('(')) {
      const cname = isClass(r.owner) ? (r.owner.cls.template ? r.owner.cls.template.rec.name : r.owner.cls.name) : r.owner.tmpl.name;
      if (r.dtor || r.name === cname) return r;
    }
    this.p = save;
    return null;
  }

  // =================================================================
  //  Top level
  // =================================================================
  program() {
    while (this.tok.k !== 'eof') this.topItem();
    return this.finish();
  }

  topItem() {
    const tok = this.tok;
    if (this.accept(';')) return;
    if (this.is('_Static_assert') || this.is('static_assert')) { this.staticAssert(); return; }
    if (this.is('namespace')) { this.namespaceDecl(); return; }
    if (this.is('using')) { this.usingDecl(); return; }
    if (this.is('template')) { this.templateDecl(); return; }
    if (this.is('extern') && this.peek(1).k === 'str') {
      this.next();
      const lang = this.next().v;
      const saved = this.linkC;
      this.linkC = lang === '"C"';
      try {
        if (this.accept('{')) { while (!this.accept('}')) { if (this.tok.k === 'eof') fail(tok, "expected '}'"); this.topItem(); } }
        else this.topItem();
      } finally { this.linkC = saved; }
      return;
    }
    this.topDeclaration({});
  }

  namespaceDecl() {
    const tok = this.next();
    let name = null;
    if (this.tok.k === 'id') name = this.next().v;
    if (name && this.accept('=')) {
      const r = this.qualifiedName();
      if (!r || !r.entry || !r.entry.ns) fail(tok, 'expected a namespace');
      this.expect(';');
      this.declare(name, { ns: r.entry.ns });
      return;
    }
    const parent = this.currentNs();
    let ns;
    if (name) {
      const ex = parent.vars.get(name);
      if (ex && ex.ns) ns = ex.ns;
      else if (ex) fail(tok, "'" + name + "' is already declared and is not a namespace");
      else {
        ns = { isNs: true, name, qname: (parent.qname ? parent.qname + '::' : '') + name, vars: new Map(), tags: new Map(), usings: [], parent };
        parent.vars.set(name, { ns });
      }
    } else {
      // an unnamed namespace: its names are visible in the enclosing one
      ns = { isNs: true, name: '', qname: parent.qname, vars: new Map(), tags: new Map(), usings: [], parent, anonymous: true };
      parent.usings.push(ns);
    }
    this.expect('{');
    this.scopes.push({ kind: 'ns', ns, vars: ns.vars, tags: ns.tags });
    try {
      while (!this.accept('}')) { if (this.tok.k === 'eof') fail(tok, "expected '}' at end of namespace"); this.topItem(); }
    } finally { this.scopes.pop(); }
  }

  topDeclaration(opts) {
    opts = opts || {};
    const special = this.peekSpecialDef();
    if (special) return this.specialDef(special, opts);
    const attr = {};
    const base = this.declspec(attr);
    if (this.accept(';')) return null;
    let first = true, result = null;
    for (;;) {
      const d = this.declarator(base);
      if (attr.typedef) this.declareType(d.name, d.type);
      else if (d.type.kind === 'func') {
        const f = this.functionDecl(d, attr, opts);
        result = f;
        if (first && (this.is('{') || this.is(':'))) { this.defineBody(f, d.tok); return f; }
        if (this.accept('=')) { const t = this.next(); if (t.v === 'delete') f.isDeleted = true; else if (t.v !== 'default') fail(t, "expected 'delete' or 'default'"); }
      } else this.globalVar(d, attr);
      first = false;
      if (!this.accept(',')) break;
    }
    this.expect(';');
    return result;
  }

  functionDecl(d, attr, opts) {
    if (d.owner && isClass(d.owner)) {
      // out-of-line member function: find its declaration in the class
      const cls = d.owner;
      const list = cls.cls.methods.get(d.name) || [];
      const want = d.type.params.map(typeKey).join(',');
      const f = list.find(m => m.type.params.slice(m.isStatic ? 0 : 1).map(typeKey).join(',') === want && !!m.isConst === !!d.type.isConst);
      if (!f) fail(d.tok, "no member function '" + d.name + "' with these parameters in " + typeName(cls));
      if (attr.inline) f.isInline = true;
      if (f.cls.cls.template) f.isInline = true;
      return f;
    }
    const ns = d.owner && d.owner.isNs ? d.owner : this.currentNs();
    return this.declareFree(d, attr, ns, opts);
  }

  specialDef(r, opts) {
    void opts;
    const cls = r.owner;
    if (!isClass(cls)) fail(r.tok, 'unexpected qualified name');
    const ft = this.typeSuffix(T.void);
    let f;
    if (r.dtor) f = cls.cls.dtor;
    else {
      const want = ft.params.map(typeKey).join(',');
      f = cls.cls.ctors.find(c => c.type.params.slice(1).map(typeKey).join(',') === want);
    }
    if (!f) fail(r.tok, 'no matching ' + (r.dtor ? 'destructor' : 'constructor') + ' declared in ' + typeName(cls));
    if (cls.cls.template) f.isInline = true;
    if (this.accept('=')) { this.next(); this.expect(';'); return f; }
    if (this.accept(';')) return f;
    this.defineBody(f, r.tok);
    return f;
  }

  getInitFn(tok) {
    if (!this.initFn) {
      const ft = funcType(T.void, []);
      ft.paramNames = [];
      this.initFn = { name: '__mcc_init', qname: '__mcc_init', uname: '__mcc_init', type: ft, params: [], locals: [], body: { k: 'block', items: [], tok }, defined: true, isStatic: true, id: this.uid++, tok, file: tok.file };
      this.funcs.set('__mcc_init', this.initFn);
    }
    return this.initFn;
  }

  globalVar(d, attr) {
    let ty = d.type;
    const tok = d.tok;
    // static data member defined outside its class
    if (d.owner && isClass(d.owner)) {
      const k = d.owner.cls;
      const ent = k.statics.get(d.name);
      if (!ent) fail(tok, "no static member '" + d.name + "' in " + typeName(d.owner));
      if (ent.enumConst) { if (this.accept('=')) this.assign(); return; }
      return this.globalInit(ent.obj, ent.obj.type, tok);
    }
    const ns = d.owner && d.owner.isNs ? d.owner : this.currentNs();
    if (hasAuto(ty)) {
      if (!this.accept('=')) fail(tok, 'auto needs an initializer');
      this.p--;
    }
    let entry = ns.vars.get(d.name);
    let o = entry && entry.obj;
    const qname = (ns.qname ? ns.qname + '::' : '') + d.name;
    if (!o) {
      o = this.newGlobal(this.linkC || !ns.qname ? d.name : qname, ty, { isStatic: !!attr.static || !!ns.anonymous, tok, displayName: d.name });
      ns.vars.set(d.name, { obj: o, type: ty });
    }
    if (attr.extern && !this.is('=')) return;
    o.defined = true;
    this.globalInit(o, ty, tok);
  }

  globalInit(o, ty, tok) {
    const initFn = this.getInitFn(tok);
    const saved = { fn: this.fn, temps: this.temps, fnFrame: this.fnFrame };
    this.fn = initFn;
    this.fnFrame = this.scopes.length;
    try {
      if (hasAuto(ty)) {
        this.expect('=');
        const { e, temps } = this.fullExpr(() => this.assign());
        ty = this.deduceAuto(ty, e, tok);
        o.type = ty;
        const ent = this.findVar(o.displayName || o.name);
        if (ent && ent.obj === o) ent.type = ty;
        initFn.body.items.push(this.exprStmt(this.wrapTemps(this.initGlobalFrom(o, ty, e, tok), temps, true)));
        return;
      }
      if (isClass(ty)) {
        const lv = this.node('var', ty, tok, { obj: o });
        let e = null, temps = [];
        if (this.is('=') && this.is('{', 1) && !ty.cls.ctors.length && !ty.cls.hasVptr && !ty.cls.base) {
          this.next();
          o.init = this.initializer(ty, o, true);
          if (this.isConstantInit(o.init)) return;
          fail(tok, 'this global needs a constant initializer');
        }
        if (this.accept('(')) ({ e, temps } = this.fullExpr(() => this.construct(lv, ty, this.argList(), tok)));
        else if (this.is('{')) ({ e, temps } = this.fullExpr(() => this.construct(lv, ty, this.braceArgs(), tok, true)));
        else if (this.accept('=')) ({ e, temps } = this.fullExpr(() => this.initGlobalFrom(o, ty, this.assign(), tok)));
        else e = this.defaultInit(lv, ty, tok);
        if (e && !(e.k === 'cast' && e.ty.kind === 'void' && e.e.k === 'num')) initFn.body.items.push(this.exprStmt(this.wrapTemps(e, temps, true)));
        return;
      }
      if (isRef(ty)) {
        this.expect('=');
        const { e, temps } = this.fullExpr(() => this.assign());
        initFn.body.items.push(this.exprStmt(this.wrapTemps(this.node('assign', ty, tok, { lhs: this.node('var', ty, tok, { obj: o }), rhs: this.bindRef(e, ty.base, tok) }), temps, true)));
        return;
      }
      if (!this.is('=') && !this.is('{')) return;
      if (this.is('{')) { /* int x{5}; */ } else this.next();
      const start = this.p;
      const ini = this.initializer(ty, o, true);
      if (this.isConstantInit(ini)) { o.init = ini; o.type = ini.type; return; }
      // dynamic initialization at startup
      if (ini.entries.length === 1 && ini.entries[0].expr && !isAgg(ini.entries[0].ty) && ini.entries[0].off === 0 && ini.type.kind !== 'array') {
        initFn.body.items.push(this.exprStmt(this.node('assign', ty, tok, { lhs: this.node('var', ty, tok, { obj: o }), rhs: ini.entries[0].expr })));
        return;
      }
      void start;
      fail(tok, 'initializer element is not a compile-time constant');
    } finally { Object.assign(this, saved); }
  }

  initGlobalFrom(o, ty, e, tok) {
    const lv = this.node('var', ty, tok, { obj: o });
    if (isClass(ty)) {
      if (e.elide && e.ty === ty) { this.dropTemp(e.elide.obj); return this.construct(lv, ty, e.elide.args, tok, e.elide.braced); }
      if (isClass(e.ty) && this.derivesFrom(e.ty, ty)) return this.copyConstruct(lv, e, ty, tok);
      return this.construct(lv, ty, [e], tok);
    }
    return this.node('assign', ty, tok, { lhs: lv, rhs: this.assignConv(e, ty, tok, 'initializing') });
  }

  finish() {
    for (const f of this.funcs.values()) if (f.isMethod && f.isVirtual && !f.isPure && !f.defined && f.cls && f.cls.complete) f.needsDefinition = true;
    const main = this.funcs.get('main');
    const init = this.initFn && this.initFn.body.items.length ? this.initFn : null;
    if (this.initFn && !init) this.funcs.delete('__mcc_init');
    return { globals: this.globals, funcs: this.funcs, main, init };
  }
}

MCC.CppParser = CppParser;
MCC.cppTypes = { refTo, isClass, isRef, typeKey };
})(typeof self !== 'undefined' ? self : globalThis);
