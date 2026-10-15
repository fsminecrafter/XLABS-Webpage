/*
 * mcc — the Minimal-OS Studio C compiler, front end.
 *
 * Preprocessor, parser and type checker for the subset of C11 that
 * Minimal-OS programs are written in. The result is a typed syntax tree
 * that two back ends consume: mcc-js.js (runs the program in the browser
 * preview) and mcc-x64.js (writes a real x86_64 main.elf for a .run).
 *
 * Types follow the x86_64 LP64 model used by the SDK: char is signed,
 * int is 32 bits, long and pointers are 64 bits.
 */
(function (G) {
'use strict';
const MCC = G.MCC || (G.MCC = {});

class CompileError extends Error {
  constructor(msg, tok) {
    super(msg);
    this.file = tok ? tok.file : null;
    this.line = tok ? tok.line : 0;
    this.col = tok ? tok.col : 0;
  }
}
MCC.CompileError = CompileError;
function fail(tok, msg) { throw new CompileError(msg, tok); }

// =====================================================================
//  Lexer
// =====================================================================
const PUNCTS = ['<<=', '>>=', '...', '->', '::', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##'];
const SINGLE = '+-*/%=<>!&|^~?:;,.()[]{}#';

function isIdStart(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$'; }
function isIdChar(c) { return isIdStart(c) || (c >= '0' && c <= '9'); }
function isDigit(c) { return c >= '0' && c <= '9'; }

function lex(src, file) {
  const toks = [];
  let i = 0, line = 1, lineStart = 0, bol = true, space = false;
  const n = src.length;
  const mk = (k, v, start) => {
    toks.push({ k, v, file, line: tline, col: start - tlineStart + 1, bol, space, hide: null });
    bol = false; space = false;
  };
  let tline = 1, tlineStart = 0;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { i++; line++; lineStart = i; bol = true; space = false; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; space = true; continue; }
    if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
      i += src[i + 1] === '\n' ? 2 : 3; line++; lineStart = i; space = true; continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      space = true; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const startTok = { file, line, col: i - lineStart + 1 };
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') { line++; lineStart = i + 1; }
        i++;
      }
      if (i >= n) fail(startTok, 'unterminated comment');
      i += 2; space = true; continue;
    }
    tline = line; tlineStart = lineStart;
    const start = i;
    // string / char literal, with optional prefix
    let pre = '';
    if (c === 'L' || c === 'U' || c === 'u') {
      if (src.startsWith('u8"', i)) pre = 'u8';
      else if (src[i + 1] === '"' || src[i + 1] === "'") pre = c;
    }
    const q = src[i + pre.length];
    if (q === '"' || q === "'") {
      if (pre && pre !== 'u8') fail({ file, line, col: i - lineStart + 1 }, 'wide character and string literals are not supported');
      let j = i + pre.length + 1;
      while (j < n && src[j] !== q) {
        if (src[j] === '\\') j++;
        if (src[j] === '\n') fail({ file, line, col: i - lineStart + 1 }, 'unterminated ' + (q === '"' ? 'string' : 'character') + ' literal');
        j++;
      }
      if (j >= n) fail({ file, line, col: i - lineStart + 1 }, 'unterminated literal');
      i = j + 1;
      mk(q === '"' ? 'str' : 'char', src.slice(start + pre.length, i), start);
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
      let j = i + 1;
      for (;;) {
        const d = src[j];
        if (d === undefined) break;
        if ((d === '+' || d === '-') && 'eEpP'.includes(src[j - 1])) { j++; continue; }
        if (isIdChar(d) || d === '.') { j++; continue; }
        break;
      }
      i = j;
      mk('num', src.slice(start, i), start);
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdChar(src[j])) j++;
      i = j;
      mk('id', src.slice(start, i), start);
      continue;
    }
    let p = null;
    for (const s of PUNCTS) if (src.startsWith(s, i)) { p = s; break; }
    if (!p && SINGLE.includes(c)) p = c;
    if (!p) fail({ file, line, col: i - lineStart + 1 }, 'unexpected character ' + JSON.stringify(c));
    i += p.length;
    mk('punct', p, start);
  }
  toks.push({ k: 'eof', v: '', file, line, col: i - lineStart + 1, bol: true, space: false, hide: null });
  return toks;
}
MCC.lex = lex;

// =====================================================================
//  Preprocessor
// =====================================================================
function dirname(p) { const k = p.lastIndexOf('/'); return k < 0 ? '' : p.slice(0, k); }
function normPath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (out.length) out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

function copyTok(t, extra) { const r = Object.assign({}, t); if (extra) Object.assign(r, extra); return r; }

function stringifyTokens(toks) {
  let s = '';
  toks.forEach((t, i) => {
    if (i && t.space) s += ' ';
    s += t.v;
  });
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

class Preprocessor {
  constructor(files, sdk, defines) {
    this.files = files;     // project files: path -> source
    this.sdk = sdk;         // SDK headers: path -> source
    this.macros = new Map();
    this.once = new Set();
    this.depth = 0;
    this.counter = 0;
    const pre = Object.assign({
      __STDC__: '1', __STDC_VERSION__: '201112L', __STDC_HOSTED__: '0', __x86_64__: '1', __x86_64: '1',
      __LP64__: '1', _LP64: '1', __MINIMAL_OS__: '1', __MCC__: '1', __SIZEOF_POINTER__: '8',
      __SIZEOF_LONG__: '8', __SIZEOF_INT__: '4', __CHAR_BIT__: '8', __BYTE_ORDER__: '1234',
      __ORDER_LITTLE_ENDIAN__: '1234'
    }, defines || {});
    for (const k in pre) this.macros.set(k, { name: k, fn: false, body: lex(pre[k], '<built-in>').slice(0, -1) });
  }

  source(path) {
    if (Object.prototype.hasOwnProperty.call(this.files, path)) return { path, src: this.files[path] };
    if (Object.prototype.hasOwnProperty.call(this.sdk, path)) return { path: '<sdk>/' + path, src: this.sdk[path] };
    return null;
  }

  resolve(name, angled, cur) {
    if (!angled) {
      const rel = normPath((cur.startsWith('<sdk>/') ? '' : dirname(cur) + '/') + name);
      if (cur.startsWith('<sdk>/')) {
        const sd = normPath(dirname(cur.slice(6)) + '/' + name);
        if (Object.prototype.hasOwnProperty.call(this.sdk, sd)) return { path: '<sdk>/' + sd, src: this.sdk[sd] };
      } else if (Object.prototype.hasOwnProperty.call(this.files, rel)) return { path: rel, src: this.files[rel] };
      const r = normPath(name);
      if (Object.prototype.hasOwnProperty.call(this.files, r)) return { path: r, src: this.files[r] };
      if (Object.prototype.hasOwnProperty.call(this.sdk, r)) return { path: '<sdk>/' + r, src: this.sdk[r] };
      return null;
    }
    const r = normPath(name);
    if (Object.prototype.hasOwnProperty.call(this.sdk, r)) return { path: '<sdk>/' + r, src: this.sdk[r] };
    if (Object.prototype.hasOwnProperty.call(this.files, r)) return { path: r, src: this.files[r] };
    return null;
  }

  run(path) {
    const s = this.source(path);
    if (!s) fail(null, 'file not found: ' + path);
    const out = [];
    this.processFile(s.path, s.src, out);
    out.push({ k: 'eof', v: '', file: s.path, line: 0, col: 0 });
    return out;
  }

  processFile(path, src, out) {
    if (this.once.has(path)) return;
    if (++this.depth > 64) fail(null, '#include nested too deeply (' + path + ')');
    const toks = lex(src, path);
    const cond = [];       // {active, taken, outer}
    let pending = [];
    const active = () => cond.length === 0 || cond[cond.length - 1].active;
    const flush = () => { if (pending.length) { for (const t of this.expand(pending)) out.push(t); pending = []; } };
    let i = 0;
    while (toks[i].k !== 'eof') {
      const t = toks[i];
      if (!(t.bol && t.k === 'punct' && t.v === '#')) {
        if (active()) pending.push(t);
        i++;
        continue;
      }
      // directive: collect the rest of the line
      const hash = t;
      i++;
      const line = [];
      while (toks[i].k !== 'eof' && !toks[i].bol) line.push(toks[i++]);
      if (!line.length) continue;
      const d = line[0].v;
      const args = line.slice(1);
      if (d === 'ifdef' || d === 'ifndef') {
        const on = active() && (this.macros.has(args[0] && args[0].v) === (d === 'ifdef'));
        cond.push({ active: on, taken: on, outer: active(), tok: hash });
        continue;
      }
      if (d === 'if') {
        const outer = active();
        const on = outer && this.evalIf(args, hash);
        cond.push({ active: on, taken: on, outer, tok: hash });
        continue;
      }
      if (d === 'elif') {
        const c = cond[cond.length - 1];
        if (!c) fail(hash, '#elif without #if');
        if (c.taken || !c.outer) c.active = false;
        else { c.active = this.evalIf(args, hash); c.taken = c.active; }
        continue;
      }
      if (d === 'else') {
        const c = cond[cond.length - 1];
        if (!c) fail(hash, '#else without #if');
        c.active = c.outer && !c.taken; c.taken = true;
        continue;
      }
      if (d === 'endif') {
        if (!cond.length) fail(hash, '#endif without #if');
        cond.pop();
        continue;
      }
      if (!active()) continue;
      flush();
      if (d === 'define') this.define(args, hash);
      else if (d === 'undef') { if (args[0]) this.macros.delete(args[0].v); }
      else if (d === 'include') {
        let name, angled;
        let a = args;
        if (a.length && a[0].k === 'id') a = this.expand(a);
        if (a.length && a[0].k === 'str') { name = a[0].v.slice(1, -1); angled = false; }
        else if (a.length && a[0].v === '<') {
          name = ''; let k = 1;
          while (k < a.length && a[k].v !== '>') { name += (k > 1 && a[k].space ? ' ' : '') + a[k].v; k++; }
          angled = true;
        } else fail(hash, 'bad #include');
        const r = this.resolve(name, angled, path);
        if (!r) fail(line[0], "'" + name + "' file not found");
        this.processFile(r.path, r.src, out);
      } else if (d === 'pragma') {
        if (args[0] && args[0].v === 'once') this.once.add(path);
      } else if (d === 'error') {
        fail(hash, '#error ' + args.map(x => x.v).join(' '));
      } else if (d === 'warning' || d === 'line' || d === 'ident') {
        // ignored
      } else fail(line[0], 'unknown directive #' + d);
    }
    flush();
    if (cond.length) fail(cond[cond.length - 1].tok, 'unterminated #if');
    this.depth--;
  }

  define(args, hash) {
    const nameTok = args[0];
    if (!nameTok || nameTok.k !== 'id') fail(hash, 'macro name missing');
    const m = { name: nameTok.v, fn: false, params: [], va: null, body: null };
    let k = 1;
    if (args[1] && args[1].v === '(' && !args[1].space) {
      m.fn = true; k = 2;
      if (args[k] && args[k].v === ')') k++;
      else {
        for (;;) {
          const p = args[k];
          if (!p) fail(nameTok, 'bad macro parameter list');
          if (p.v === '...') { m.va = '__VA_ARGS__'; k++; }
          else if (p.k === 'id' && args[k + 1] && args[k + 1].v === '...') { m.va = p.v; k += 2; }
          else if (p.k === 'id') { m.params.push(p.v); k++; }
          else fail(p, 'bad macro parameter');
          if (args[k] && args[k].v === ',') { k++; continue; }
          if (args[k] && args[k].v === ')') { k++; break; }
          fail(args[k] || nameTok, 'expected ) in macro parameters');
        }
      }
    }
    m.body = args.slice(k);
    if (m.body.length) m.body[0] = copyTok(m.body[0], { space: false });
    this.macros.set(m.name, m);
  }

  evalIf(args, hash) {
    const toks = [];
    for (let k = 0; k < args.length; k++) {
      const t = args[k];
      if (t.k === 'id' && t.v === 'defined') {
        let name;
        if (args[k + 1] && args[k + 1].v === '(') { name = args[k + 2]; k += 3; }
        else { name = args[k + 1]; k += 1; }
        if (!name) fail(t, 'bad defined()');
        toks.push({ k: 'num', v: this.macros.has(name.v) ? '1' : '0', file: t.file, line: t.line, col: t.col });
      } else toks.push(t);
    }
    const ex = this.expand(toks).map(t => t.k === 'id' ? copyTok(t, { k: 'num', v: t.v === 'true' ? '1' : '0' }) : t);
    let p = 0;
    const peek = () => ex[p] || { v: '', k: 'eof' };
    const num = (t) => {
      if (t.k === 'char') return BigInt(decodeChar(t));
      const s = t.v.replace(/[uUlL]+$/, '');
      if (/^0[xX]/.test(s)) return BigInt(s);
      if (/^0[bB]/.test(s)) return BigInt(s);
      if (/^0[0-7]+$/.test(s)) return BigInt('0o' + s.slice(1));
      if (!/^\d+$/.test(s)) fail(t, 'bad number in #if');
      return BigInt(s);
    };
    const B = (b) => b ? 1n : 0n;
    const prim = () => {
      const t = ex[p++];
      if (!t) fail(hash, 'bad #if expression');
      if (t.v === '(') { const v = cond(); if (peek().v !== ')') fail(t, 'expected )'); p++; return v; }
      if (t.v === '!') return B(!prim());
      if (t.v === '-') return -prim();
      if (t.v === '+') return prim();
      if (t.v === '~') return ~prim();
      if (t.k === 'num' || t.k === 'char') return num(t);
      fail(t, 'bad token in #if: ' + t.v);
    };
    const levels = [['*', '/', '%'], ['+', '-'], ['<<', '>>'], ['<', '>', '<=', '>='], ['==', '!='], ['&'], ['^'], ['|'], ['&&'], ['||']];
    const bin = (lv) => {
      if (lv < 0) return prim();
      let a = bin(lv - 1);
      while (levels[lv].includes(peek().v) && peek().k === 'punct') {
        const op = ex[p++].v;
        const b = bin(lv - 1);
        switch (op) {
          case '*': a = a * b; break; case '/': if (!b) fail(hash, 'division by zero in #if'); a = a / b; break;
          case '%': if (!b) fail(hash, 'division by zero in #if'); a = a % b; break;
          case '+': a = a + b; break; case '-': a = a - b; break;
          case '<<': a = a << b; break; case '>>': a = a >> b; break;
          case '<': a = B(a < b); break; case '>': a = B(a > b); break; case '<=': a = B(a <= b); break; case '>=': a = B(a >= b); break;
          case '==': a = B(a === b); break; case '!=': a = B(a !== b); break;
          case '&': a = a & b; break; case '^': a = a ^ b; break; case '|': a = a | b; break;
          case '&&': a = B(a && b); break; case '||': a = B(a || b); break;
        }
      }
      return a;
    };
    const cond = () => {
      const c = bin(levels.length - 1);
      if (peek().v === '?') {
        p++;
        const a = cond();
        if (peek().v !== ':') fail(hash, 'expected : in #if');
        p++;
        const b = cond();
        return c ? a : b;
      }
      return c;
    };
    const v = cond();
    if (p < ex.length) fail(ex[p], 'extra tokens in #if');
    return v !== 0n;
  }

  // Expands macros in a token list (C11 6.10.3, with GNU , ## __VA_ARGS__).
  expand(list) {
    const input = list.slice();
    const out = [];
    let pos = 0;
    while (pos < input.length) {
      const t = input[pos];
      if (t.k !== 'id') { out.push(t); pos++; continue; }
      if (t.v === '__LINE__') { out.push(copyTok(t, { k: 'num', v: String(t.line) })); pos++; continue; }
      if (t.v === '__FILE__') { out.push(copyTok(t, { k: 'str', v: JSON.stringify(t.file) })); pos++; continue; }
      if (t.v === '__COUNTER__') { out.push(copyTok(t, { k: 'num', v: String(this.counter++) })); pos++; continue; }
      const m = this.macros.get(t.v);
      if (!m || (t.hide && t.hide.has(t.v))) { out.push(t); pos++; continue; }
      const hide = new Set(t.hide || []); hide.add(m.name);
      if (!m.fn) {
        const body = m.body.map((b, i) => copyTok(b, { hide, file: t.file, line: t.line, col: t.col, space: i === 0 ? t.space : b.space }));
        input.splice(pos, 1, ...body);
        continue;
      }
      if (!(input[pos + 1] && input[pos + 1].k === 'punct' && input[pos + 1].v === '(')) { out.push(t); pos++; continue; }
      // collect arguments
      let k = pos + 2, depth = 0;
      const argsRaw = [[]];
      for (;;) {
        const a = input[k];
        if (!a) fail(t, "unterminated call to macro '" + m.name + "'");
        if (a.k === 'punct' && (a.v === '(' || a.v === '[' || a.v === '{')) depth++;
        else if (a.k === 'punct' && (a.v === ']' || a.v === '}')) depth--;
        else if (a.k === 'punct' && a.v === ')') { if (depth === 0) break; depth--; }
        else if (a.k === 'punct' && a.v === ',' && depth === 0 &&
          !(m.va && argsRaw.length > m.params.length)) { argsRaw.push([]); k++; continue; }
        argsRaw[argsRaw.length - 1].push(a);
        k++;
      }
      // k points at closing paren
      let args = argsRaw;
      if (m.params.length === 0 && !m.va && args.length === 1 && args[0].length === 0) args = [];
      const want = m.params.length;
      if (m.va) { while (args.length < want + 1) args.push([]); }
      if (args.length !== want + (m.va ? 1 : 0)) fail(t, "macro '" + m.name + "' expects " + want + ' argument(s), got ' + args.length);
      const body = this.substitute(m, args, t, hide);
      input.splice(pos, k - pos + 1, ...body);
    }
    return out;
  }

  substitute(m, args, nameTok, hide) {
    const params = m.params.slice();
    if (m.va) params.push(m.va);
    const idx = (t) => t.k === 'id' ? params.indexOf(t.v) : -1;
    const expanded = new Map();
    const exp = (i) => { if (!expanded.has(i)) expanded.set(i, this.expand(args[i])); return expanded.get(i); };
    const res = [];
    const body = m.body;
    for (let i = 0; i < body.length; i++) {
      const t = body[i];
      if (t.k === 'punct' && t.v === '#' && body[i + 1] && idx(body[i + 1]) >= 0) {
        res.push(copyTok(t, { k: 'str', v: stringifyTokens(args[idx(body[i + 1])]) }));
        i++;
        continue;
      }
      if (t.k === 'punct' && t.v === '##') {
        const next = body[i + 1];
        if (!next) fail(t, "'##' at end of macro");
        let rhs;
        if (idx(next) >= 0) rhs = args[idx(next)].map(x => x);
        else rhs = [next];
        i++;
        // GNU: , ## __VA_ARGS__ drops the comma when the variadic part is empty
        if (m.va && next.v === m.va && res.length && res[res.length - 1].v === ',') {
          if (rhs.length === 0) res.pop();
          res.push(...rhs);
          continue;
        }
        if (!res.length) { res.push(...rhs); continue; }
        if (!rhs.length) continue;
        const lhs = res.pop();
        const pasted = lex(lhs.v + rhs[0].v, lhs.file);
        if (pasted.length !== 2) fail(t, "pasting '" + lhs.v + "' and '" + rhs[0].v + "' does not give a valid token");
        res.push(copyTok(lhs, { k: pasted[0].k, v: pasted[0].v }));
        res.push(...rhs.slice(1));
        continue;
      }
      const pi = idx(t);
      if (pi >= 0) {
        const nextIsPaste = body[i + 1] && body[i + 1].v === '##';
        const toks = nextIsPaste ? args[pi] : exp(pi);
        toks.forEach((x, j) => res.push(j === 0 ? copyTok(x, { space: t.space }) : x));
        continue;
      }
      res.push(t);
    }
    return res.map((r, i) => copyTok(r, {
      hide: new Set([...(r.hide || []), ...hide]),
      file: nameTok.file, line: nameTok.line, col: nameTok.col,
      space: i === 0 ? nameTok.space : r.space
    }));
  }
}
MCC.Preprocessor = Preprocessor;

// =====================================================================
//  Literals
// =====================================================================
function utf8(str) {
  const out = [];
  for (const ch of str) {
    let c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

// Decodes the body of a quoted literal (without quotes) to bytes.
function decodeEscapes(s, tok) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== '\\') {
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      out.push(...utf8(ch));
      i += ch.length;
      continue;
    }
    const e = s[i + 1];
    i += 2;
    switch (e) {
      case 'n': out.push(10); break; case 't': out.push(9); break; case 'r': out.push(13); break;
      case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': {
        let v = e.charCodeAt(0) - 48, k = 0;
        while (k < 2 && /[0-7]/.test(s[i] || '')) { v = v * 8 + (s.charCodeAt(i) - 48); i++; k++; }
        out.push(v & 255); break;
      }
      case 'x': {
        let v = 0, k = 0;
        while (/[0-9a-fA-F]/.test(s[i] || '')) { v = (v * 16 + parseInt(s[i], 16)) & 0xff; i++; k++; }
        if (!k) fail(tok, '\\x used with no following hex digits');
        out.push(v); break;
      }
      case 'a': out.push(7); break; case 'b': out.push(8); break; case 'f': out.push(12); break;
      case 'v': out.push(11); break; case 'e': out.push(27); break;
      case '\\': out.push(92); break; case "'": out.push(39); break; case '"': out.push(34); break; case '?': out.push(63); break;
      default: fail(tok, 'unknown escape sequence \\' + e);
    }
  }
  return out;
}

function decodeChar(tok) {
  const bytes = decodeEscapes(tok.v.slice(1, -1), tok);
  if (!bytes.length) fail(tok, 'empty character constant');
  if (bytes.length === 1) return (bytes[0] << 24) >> 24;
  let v = 0;
  for (const b of bytes) v = (v << 8) | b;
  return v | 0;
}

// =====================================================================
//  Types
// =====================================================================
function prim(kind, size, unsigned) { return { kind, size, align: size, unsigned: !!unsigned }; }
const T = {
  void: { kind: 'void', size: 1, align: 1 },
  bool: prim('bool', 1, true),
  char: prim('char', 1), uchar: prim('char', 1, true),
  short: prim('short', 2), ushort: prim('short', 2, true),
  int: prim('int', 4), uint: prim('int', 4, true),
  long: prim('long', 8), ulong: prim('long', 8, true),
  float: prim('float', 4), double: prim('double', 8),
};
MCC.T = T;
function ptrTo(base) { return { kind: 'ptr', size: 8, align: 8, base, unsigned: true }; }
function arrayOf(base, len) { return { kind: 'array', size: len < 0 ? 0 : base.size * len, align: base.align, base, len }; }
function funcType(ret, params, variadic, oldStyle) { return { kind: 'func', size: 1, align: 1, ret, params, variadic: !!variadic, oldStyle: !!oldStyle }; }
const isInt = (t) => t.kind === 'bool' || t.kind === 'char' || t.kind === 'short' || t.kind === 'int' || t.kind === 'long';
const isFlo = (t) => t.kind === 'float' || t.kind === 'double';
const isNum = (t) => isInt(t) || isFlo(t);
const isPtr = (t) => t.kind === 'ptr';
const isScalar = (t) => isNum(t) || isPtr(t);
const isAgg = (t) => t.kind === 'struct' || t.kind === 'union';
MCC.types = { ptrTo, arrayOf, funcType, isInt, isFlo, isNum, isPtr, isScalar, isAgg };

function typeName(t) {
  switch (t.kind) {
    case 'void': return 'void';
    case 'bool': return '_Bool';
    case 'char': return t.unsigned ? 'unsigned char' : 'char';
    case 'short': return t.unsigned ? 'unsigned short' : 'short';
    case 'int': return t.isEnum ? 'enum' : t.unsigned ? 'unsigned int' : 'int';
    case 'long': return t.unsigned ? 'unsigned long' : 'long';
    case 'float': return 'float';
    case 'double': return 'double';
    case 'ptr': return t.base.kind === 'func' ? typeName(t.base.ret) + ' (*)(...)' : typeName(t.base) + ' *';
    case 'array': return typeName(t.base) + '[' + (t.len < 0 ? '' : t.len) + ']';
    case 'func': return typeName(t.ret) + ' (' + t.params.map(typeName).join(', ') + ')';
    case 'struct': case 'union': return t.kind + ' ' + (t.tag || '<anonymous>');
  }
  return t.kind;
}
MCC.typeName = typeName;

function sameType(a, b) {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'ptr': return sameType(a.base, b.base) || a.base.kind === 'void' || b.base.kind === 'void';
    case 'array': return sameType(a.base, b.base);
    case 'struct': case 'union': return a === b || (a.def && a.def === b.def);
    case 'func': return true;
    default: return a.unsigned === b.unsigned && a.size === b.size;
  }
}

function promote(t) {
  if (isInt(t) && t.size < 4) return T.int;
  if (t.kind === 'int' && t.isEnum) return T.int;
  return t;
}
function usualArith(a, b) {
  if (a.kind === 'double' || b.kind === 'double') return T.double;
  if (a.kind === 'float' || b.kind === 'float') return T.float;
  a = promote(a); b = promote(b);
  if (a.size !== b.size) return a.size > b.size ? a : b;
  return a.unsigned ? a : b.unsigned ? b : a;
}
const alignTo = (n, a) => Math.ceil(n / a) * a;

// =====================================================================
//  Parser
// =====================================================================
const KEYWORDS = new Set(['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed',
  'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', '_Bool', '_Alignas',
  '_Alignof', '_Noreturn', '_Static_assert', '_Thread_local', '__attribute__', '__inline', '__inline__', '__restrict',
  '__restrict__', '__volatile__', '__const', '__extension__', '__signed__', 'asm', '__asm__', '__asm', '_Atomic', '__typeof__', 'typeof']);
const TYPE_WORDS = new Set(['void', '_Bool', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '__signed__',
  'struct', 'union', 'enum', 'typedef', 'static', 'extern', 'inline', '__inline', '__inline__', 'const', 'volatile', 'restrict',
  '__restrict', '__restrict__', '__volatile__', '__const', 'register', 'auto', '_Noreturn', '_Thread_local', '__attribute__',
  '_Alignas', '__extension__', '__builtin_va_list', '_Atomic', '__typeof__', 'typeof']);

class Parser {
  constructor(toks) {
    this.t = toks;
    this.p = 0;
    this.scopes = [{ vars: new Map(), tags: new Map() }];
    this.globals = [];       // global objects (vars incl. strings, statics)
    this.funcs = new Map();  // name -> func
    this.strings = new Map();
    this.fn = null;
    this.uid = 0;
    this.breakable = 0;
    this.continuable = 0;
    this.sw = null;
    this.blockLevel = 0;
    this.cpp = false;
  }

  // ---- hooks the C++ parser fills in (mcc-cpp.js) ----
  binHook() { return null; }
  assignHook() { return null; }
  boolTy() { return T.int; }
  charTy() { return T.int; }

  // ---- token helpers ----
  get tok() { return this.t[this.p]; }
  peek(n) { return this.t[this.p + (n || 0)]; }
  is(v, n) { const t = this.t[this.p + (n || 0)]; return t.k !== 'str' && t.k !== 'char' && t.v === v; }
  next() { return this.t[this.p++]; }
  accept(v) { if (this.is(v)) { this.p++; return true; } return false; }
  expect(v) {
    if (!this.is(v)) fail(this.tok, "expected '" + v + "'" + (this.tok.k === 'eof' ? ' before end of file' : " before '" + this.tok.v + "'"));
    return this.next();
  }
  ident() {
    const t = this.tok;
    if (t.k !== 'id' || KEYWORDS.has(t.v)) fail(t, 'expected an identifier' + (t.k === 'eof' ? '' : " before '" + t.v + "'"));
    this.p++;
    return t;
  }

  // ---- scopes ----
  push() { this.scopes.push({ vars: new Map(), tags: new Map() }); }
  pop() { this.scopes.pop(); }
  findVar(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) { const v = this.scopes[i].vars.get(name); if (v) return v; }
    return null;
  }
  findTag(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) { const v = this.scopes[i].tags.get(name); if (v) return v; }
    return null;
  }
  declare(name, entry) { this.scopes[this.scopes.length - 1].vars.set(name, entry); }
  isTypedef(t) {
    if (t.k !== 'id') return false;
    const v = this.findVar(t.v);
    return !!(v && v.typedef);
  }
  isTypename(t) {
    t = t || this.tok;
    if (t.k !== 'id') return false;
    return TYPE_WORDS.has(t.v) || this.isTypedef(t);
  }

  skipAttributes() {
    const attrs = [];
    for (;;) {
      if (this.is('__attribute__')) {
        this.next(); this.expect('('); this.expect('(');
        let depth = 0;
        while (!(depth === 0 && this.is(')'))) {
          const t = this.next();
          if (t.k === 'eof') fail(t, 'unterminated __attribute__');
          if (t.v === '(') depth++;
          else if (t.v === ')') depth--;
          else if (t.k === 'id' && depth === 0) attrs.push(t.v.replace(/^__|__$/g, ''));
        }
        this.expect(')'); this.expect(')');
        continue;
      }
      if (this.is('__extension__')) { this.next(); continue; }
      return attrs;
    }
  }

  // ---- declaration specifiers ----
  declspec(attr) {
    const C = { VOID: 1, BOOL: 1 << 2, CHAR: 1 << 4, SHORT: 1 << 6, INT: 1 << 8, LONG: 1 << 10, FLOAT: 1 << 12, DOUBLE: 1 << 14, OTHER: 1 << 16, SIGNED: 1 << 17, UNSIGNED: 1 << 18 };
    let ty = T.int, counter = 0, start = this.tok;
    for (;;) {
      const t = this.tok;
      if (t.k !== 'id') break;
      const v = t.v;
      if (v === 'typedef' || v === 'static' || v === 'extern' || v === 'inline' || v === '__inline' || v === '__inline__' ||
          v === '_Noreturn' || v === '_Thread_local' || v === 'register' || v === 'auto') {
        if (!attr) fail(t, "storage class '" + v + "' is not allowed here");
        if (v === 'typedef') attr.typedef = true;
        else if (v === 'static') attr.static = true;
        else if (v === 'extern') attr.extern = true;
        else if (v === 'inline' || v === '__inline' || v === '__inline__') attr.inline = true;
        this.next();
        continue;
      }
      if (v === 'const' || v === 'volatile' || v === 'restrict' || v === '__restrict' || v === '__restrict__' ||
          v === '__volatile__' || v === '__const' || v === '_Atomic') { this.next(); continue; }
      if (v === '__attribute__' || v === '__extension__') { this.skipAttributes(); continue; }
      if (v === '_Alignas') {
        this.next(); this.expect('(');
        let depth = 0;
        while (!(depth === 0 && this.is(')'))) { const x = this.next(); if (x.v === '(') depth++; if (x.v === ')') depth--; }
        this.expect(')');
        continue;
      }
      const isTd = this.isTypedef(t);
      if (v === 'struct' || v === 'union' || v === 'enum' || v === '__builtin_va_list' || v === '__typeof__' || v === 'typeof' || isTd) {
        if (counter) break;
        if (v === 'struct' || v === 'union') { this.next(); ty = this.structDecl(v); }
        else if (v === 'enum') { this.next(); ty = this.enumDecl(); }
        else if (v === '__builtin_va_list') { this.next(); ty = ptrTo(T.char); ty = Object.assign({}, ty, { vaList: true }); }
        else if (v === '__typeof__' || v === 'typeof') {
          this.next(); this.expect('(');
          if (this.isTypename()) ty = this.typename(); else ty = this.expr().ty;
          this.expect(')');
        } else { this.next(); ty = this.findVar(v).type; }
        counter += C.OTHER;
        continue;
      }
      let add = 0;
      switch (v) {
        case 'void': add = C.VOID; break; case '_Bool': add = C.BOOL; break; case 'char': add = C.CHAR; break;
        case 'short': add = C.SHORT; break; case 'int': add = C.INT; break; case 'long': add = C.LONG; break;
        case 'float': add = C.FLOAT; break; case 'double': add = C.DOUBLE; break;
        case 'signed': case '__signed__': add = C.SIGNED; break; case 'unsigned': add = C.UNSIGNED; break;
      }
      if (!add) break;
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
    }
    if (counter === 0 && this.tok === start) fail(this.tok, 'expected a type' + (this.tok.k === 'eof' ? '' : " before '" + this.tok.v + "'"));
    return ty;
  }

  structDecl(kind) {
    const attrsBefore = this.skipAttributes();
    let tagTok = null;
    if (this.tok.k === 'id' && !this.is('{')) tagTok = this.ident();
    if (tagTok && !this.is('{')) {
      const found = this.findTag(tagTok.v);
      if (found) {
        if (found.kind !== kind) fail(tagTok, "'" + tagTok.v + "' defined as wrong kind of tag");
        return found;
      }
      const ty = { kind, size: 0, align: 1, members: [], tag: tagTok.v, complete: false };
      this.scopes[this.scopes.length - 1].tags.set(tagTok.v, ty);
      return ty;
    }
    this.expect('{');
    let ty;
    if (tagTok) {
      const cur = this.scopes[this.scopes.length - 1].tags.get(tagTok.v);
      if (cur && !cur.complete) ty = cur;
      else if (cur) fail(tagTok, "redefinition of '" + kind + ' ' + tagTok.v + "'");
    }
    if (!ty) ty = { kind, size: 0, align: 1, members: [], tag: tagTok ? tagTok.v : null, complete: false };
    if (tagTok) this.scopes[this.scopes.length - 1].tags.set(tagTok.v, ty);
    const members = [];
    while (!this.accept('}')) {
      if (this.is('_Static_assert')) { this.staticAssert(); continue; }
      const base = this.declspec(null);
      let first = true;
      if (this.accept(';')) {
        // anonymous struct/union member
        if (isAgg(base) && !base.tag) { members.push({ name: null, type: base, anon: true }); continue; }
        continue;
      }
      while (!this.accept(';')) {
        if (!first) this.expect(',');
        first = false;
        const d = this.declarator(base);
        if (this.is(':')) fail(this.tok, 'bit-fields are not supported');
        this.skipAttributes();
        members.push({ name: d.name, type: d.type, tok: d.tok });
      }
    }
    const attrs = attrsBefore.concat(this.skipAttributes());
    const packed = attrs.includes('packed');
    // layout
    let off = 0, align = 1, size = 0;
    const flat = [];
    members.forEach((m, i) => {
      if (m.type.kind === 'array' && m.type.len < 0) {
        if (i !== members.length - 1 || kind !== 'struct') fail(m.tok, 'flexible array member must be last');
        m.type = arrayOf(m.type.base, 0);
      }
      if (m.type.kind === 'func') fail(m.tok, "field '" + m.name + "' declared as a function");
      if ((isAgg(m.type) && !m.type.complete)) fail(m.tok, "field '" + m.name + "' has incomplete type");
      const a = packed ? 1 : m.type.align;
      if (kind === 'struct') { off = alignTo(off, a); m.offset = off; off += m.type.size; }
      else { m.offset = 0; size = Math.max(size, m.type.size); }
      align = Math.max(align, a);
      if (m.anon) {
        for (const sub of m.type.members) flat.push({ name: sub.name, type: sub.type, offset: m.offset + sub.offset });
      } else flat.push({ name: m.name, type: m.type, offset: m.offset });
    });
    if (kind === 'struct') size = off;
    ty.size = alignTo(size, align);
    ty.align = align;
    ty.members = flat;
    ty.complete = true;
    return ty;
  }

  enumDecl() {
    this.skipAttributes();
    let tagTok = null;
    if (this.tok.k === 'id' && !this.is('{')) tagTok = this.ident();
    const ty = Object.assign({}, T.int, { isEnum: true });
    if (tagTok && !this.is('{')) {
      const found = this.findTag(tagTok.v);
      if (found) return found;
      this.scopes[this.scopes.length - 1].tags.set(tagTok.v, ty);
      return ty;
    }
    this.expect('{');
    let val = 0n;
    while (!this.accept('}')) {
      const name = this.ident();
      if (this.accept('=')) val = this.constInt(this.cond());
      this.declare(name.v, { enumConst: true, value: val, type: T.int });
      val++;
      if (!this.accept(',')) { this.expect('}'); break; }
    }
    if (tagTok) this.scopes[this.scopes.length - 1].tags.set(tagTok.v, ty);
    return ty;
  }

  // ---- declarators ----
  pointers(ty) {
    while (this.accept('*')) {
      ty = ptrTo(ty);
      while (this.tok.k === 'id' && ['const', 'volatile', 'restrict', '__restrict', '__restrict__', '__const', '_Atomic'].includes(this.tok.v)) this.next();
      this.skipAttributes();
    }
    return ty;
  }

  // Returns {type, name, tok}; name null for abstract declarators.
  declarator(ty, abstract) {
    ty = this.pointers(ty);
    this.skipAttributes();
    if (this.is('(') && !(abstract && (this.isTypename(this.peek(1)) || this.is(')', 1)))) {
      const start = this.p;
      this.next();
      // parse inner declarator with a placeholder to find where it ends
      this.declarator(T.int, abstract);
      this.expect(')');
      const outer = this.typeSuffix(ty);
      const end = this.p;
      this.p = start + 1;
      const d = this.declarator(outer, abstract);
      this.p = end;
      return d;
    }
    let name = null, tok = this.tok;
    if (this.tok.k === 'id' && !KEYWORDS.has(this.tok.v) && !(abstract && this.isTypedef(this.tok))) name = this.next().v;
    else if (!abstract) fail(this.tok, 'expected an identifier' + (this.tok.k === 'eof' ? '' : " before '" + this.tok.v + "'"));
    ty = this.typeSuffix(ty);
    if (this.is('asm') || this.is('__asm__') || this.is('__asm')) {
      this.next(); this.expect('(');
      while (!this.is(')')) this.next();
      this.expect(')');
    }
    this.skipAttributes();
    return { type: ty, name, tok };
  }

  typeSuffix(ty) {
    if (this.is('(')) {
      const tok = this.next();
      const params = [], names = [];
      let variadic = false, oldStyle = false;
      if (this.is('void') && this.is(')', 1)) { this.next(); this.next(); }
      else if (this.accept(')')) { oldStyle = true; }
      else {
        for (;;) {
          if (this.accept('...')) { variadic = true; this.expect(')'); break; }
          const attr = {};
          let pt = this.declspec(attr);
          const d = this.declarator(pt, true);
          pt = d.type;
          if (pt.kind === 'array') pt = ptrTo(pt.base);
          else if (pt.kind === 'func') pt = ptrTo(pt);
          if (pt.kind === 'void') fail(d.tok, "parameter has type 'void'");
          params.push(pt);
          names.push({ name: d.name, tok: d.tok });
          if (this.accept(')')) break;
          this.expect(',');
        }
      }
      if (ty.kind === 'array' || ty.kind === 'func') fail(tok, 'function cannot return ' + (ty.kind === 'array' ? 'an array' : 'a function'));
      const ft = funcType(ty, params, variadic, oldStyle);
      ft.paramNames = names;
      return ft;
    }
    if (this.is('[')) {
      const tok = this.next();
      while (this.is('static') || this.is('const') || this.is('restrict')) this.next();
      let len = -1;
      if (!this.is(']')) {
        const e = this.cond();
        let v;
        try { v = this.constInt(e); } catch (x) { fail(tok, 'variable-length arrays are not supported'); }
        if (v < 0n) fail(tok, 'array has negative size');
        len = Number(v);
      }
      this.expect(']');
      const base = this.typeSuffix(ty);
      if (base.kind === 'void') fail(tok, 'array of void');
      if (base.kind === 'func') fail(tok, 'array of functions');
      return arrayOf(base, len);
    }
    return ty;
  }

  typename() {
    const base = this.declspec(null);
    return this.declarator(base, true).type;
  }

  staticAssert() {
    const tok = this.next();
    this.expect('(');
    const v = this.constInt(this.cond());
    let msg = '';
    if (this.accept(',')) msg = this.next().v;
    this.expect(')');
    this.expect(';');
    if (!v) fail(tok, 'static assertion failed ' + msg);
  }

  // =================================================================
  //  Top level
  // =================================================================
  program() {
    while (this.tok.k !== 'eof') {
      if (this.accept(';')) continue;
      if (this.is('_Static_assert')) { this.staticAssert(); continue; }
      const attr = {};
      const startTok = this.tok;
      const base = this.declspec(attr);
      if (this.accept(';')) continue;
      let first = true, isDef = false;
      for (;;) {
        const d = this.declarator(base);
        if (attr.typedef) this.declare(d.name, { typedef: true, type: d.type });
        else if (d.type.kind === 'func') {
          if (first && this.is('{')) { this.funcDef(d, attr); isDef = true; break; }
          this.funcDecl(d, attr);
        } else this.globalVar(d, attr);
        first = false;
        if (!this.accept(',')) break;
      }
      if (!isDef) this.expect(';');
    }
    return this.finish();
  }

  funcDecl(d, attr) {
    let f = this.funcs.get(d.name);
    if (!f) {
      f = { name: d.name, type: d.type, tok: d.tok, defined: false, isStatic: !!attr.static, params: [], locals: [], body: null, id: this.uid++ };
      this.funcs.set(d.name, f);
    } else if (!f.defined) f.type = d.type;
    this.scopes[0].vars.set(d.name, { func: f, type: f.type });
    return f;
  }

  funcDef(d, attr) {
    const f = this.funcDecl(d, attr);
    if (f.defined) fail(d.tok, "redefinition of '" + d.name + "'");
    f.defined = true;
    f.type = d.type;
    f.tok = d.tok;
    f.file = d.tok.file;
    f.isStatic = !!attr.static;
    f.isInline = !!attr.inline;
    this.fn = f;
    this.push();
    const ft = d.type;
    ft.params.forEach((pt, i) => {
      const n = ft.paramNames[i];
      if (!n.name) fail(n.tok, 'parameter name omitted');
      const o = this.newLocal(n.name, pt, n.tok);
      o.isParam = true;
      f.params.push(o);
    });
    if (ft.variadic) f.vaArea = true;
    f.body = this.compound(true);
    this.pop();
    this.fn = null;
  }

  newLocal(name, type, tok) {
    const o = { name, type, local: true, id: this.uid++, tok, addrTaken: false };
    this.fn.locals.push(o);
    if (name) this.declare(name, { obj: o, type });
    return o;
  }

  newGlobal(name, type, opts) {
    const o = Object.assign({ name, type, local: false, id: this.uid++, init: null, defined: false }, opts || {});
    this.globals.push(o);
    return o;
  }

  globalVar(d, attr) {
    let ty = d.type;
    if (ty.kind === 'void') fail(d.tok, "variable '" + d.name + "' has type void");
    let entry = this.scopes[0].vars.get(d.name);
    let o = entry && entry.obj;
    if (!o) {
      o = this.newGlobal(d.name, ty, { isStatic: !!attr.static, tok: d.tok });
      this.scopes[0].vars.set(d.name, { obj: o, type: ty });
    } else if (ty.kind === 'array' && ty.len >= 0) { o.type = ty; this.scopes[0].vars.get(d.name).type = ty; }
    if (this.accept('=')) {
      if (o.defined) fail(d.tok, "redefinition of '" + d.name + "'");
      o.init = this.initializer(o.type, o, true);
      o.type = o.init.type;
      this.scopes[0].vars.get(d.name).type = o.type;
      o.defined = true;
    } else if (!attr.extern) {
      o.defined = true;
    }
  }

  // =================================================================
  //  Initializers
  // =================================================================
  // Builds a tree of {type, expr | children} and flattens it to entries.
  initializer(ty, obj, isGlobal) {
    const tree = this.newInit(ty, true);
    this.initItem(tree);
    let finalTy = ty;
    if (ty.kind === 'array' && ty.len < 0) {
      finalTy = arrayOf(ty.base, tree.count);
    }
    const entries = [];
    this.flattenInit(tree, finalTy, 0, entries);
    return { type: finalTy, entries, isGlobal };
  }

  newInit(ty, flexible) {
    const n = { type: ty, expr: null, children: null, count: 0, flexible: !!flexible };
    if (ty.kind === 'array') {
      n.children = [];
    } else if (isAgg(ty)) {
      if (!ty.complete) fail(this.tok, 'variable has incomplete type ' + typeName(ty));
      n.children = ty.members.map(m => this.newInit(m.type, false));
    }
    return n;
  }

  arrayChild(n, i) {
    return n.children[i] || (n.children[i] = this.newInit(n.type.base, false));
  }

  isStringInit(n) {
    return n.type.kind === 'array' && isInt(n.type.base) && n.type.base.size === 1 && this.tok.k === 'str';
  }

  initItem(n) {
    if (this.isStringInit(n)) {
      const tok = this.tok;
      const bytes = this.stringBytes();
      n.str = bytes;
      if (n.type.len < 0) n.count = bytes.length + 1;
      void tok;
      return;
    }
    if (n.type.kind === 'array') {
      if (this.is('{')) this.arrayBraced(n); else this.arrayBare(n);
      return;
    }
    if (isAgg(n.type)) {
      if (this.is('{')) { this.structBraced(n); return; }
      const save = this.p;
      const e = this.assign();
      if (isAgg(e.ty) && sameType(e.ty, n.type)) { n.expr = e; n.children = null; return; }
      this.p = save;
      this.structBare(n);
      return;
    }
    if (this.accept('{')) {
      this.initItem(n);
      this.accept(',');
      this.expect('}');
      return;
    }
    n.expr = this.assign();
  }

  designatedArray(n) {
    // at '['
    const tok = this.next();
    const idx = Number(this.constInt(this.cond()));
    this.expect(']');
    if (n.type.len >= 0 && idx >= n.type.len) fail(tok, 'array index ' + idx + ' out of bounds');
    if (idx < 0) fail(tok, 'negative array index');
    return idx;
  }

  designation(n) {
    // continue a designator chain into node n, then initialize it
    if (this.is('[') && n.type.kind === 'array') {
      const idx = this.designatedArray(n);
      const c = this.arrayChild(n, idx);
      n.count = Math.max(n.count, idx + 1);
      this.designation(c);
      return;
    }
    if (this.is('.') && isAgg(n.type)) {
      this.next();
      const name = this.ident();
      const mi = n.type.members.findIndex(m => m.name === name.v);
      if (mi < 0) fail(name, "no member named '" + name.v + "' in " + typeName(n.type));
      if (n.type.kind === 'union') n.unionIndex = mi;
      this.designation(n.children[mi]);
      return;
    }
    this.expect('=');
    this.initItem(n);
  }

  arrayBraced(n) {
    this.expect('{');
    let i = 0;
    let first = true;
    while (!this.accept('}')) {
      if (!first) { this.expect(','); if (this.accept('}')) break; }
      first = false;
      if (this.is('[')) {
        const idx = this.designatedArray(n);
        i = idx;
        const c = this.arrayChild(n, i);
        if (this.is('[') || this.is('.')) this.designation(c); else { this.expect('='); this.initItem(c); }
        i++;
        n.count = Math.max(n.count, i);
        continue;
      }
      if (n.type.len >= 0 && i >= n.type.len) { this.skipExcess(); continue; }
      this.initItem(this.arrayChild(n, i));
      i++;
      n.count = Math.max(n.count, i);
    }
  }

  skipExcess() {
    // GCC warns about excess elements; we accept and drop them.
    if (this.is('{')) {
      let depth = 0;
      do { const t = this.next(); if (t.v === '{') depth++; else if (t.v === '}') depth--; } while (depth > 0);
    } else this.assign();
  }

  arrayBare(n) {
    const len = n.type.len;
    let i = 0;
    for (; len < 0 || i < len; i++) {
      if (i > 0) {
        if (!this.is(',') || this.is('}', 1) || this.is('.', 1) || this.is('[', 1)) break;
        this.next();
      }
      this.initItem(this.arrayChild(n, i));
    }
    n.count = Math.max(n.count, i);
  }

  structBraced(n) {
    this.expect('{');
    let i = 0, first = true;
    while (!this.accept('}')) {
      if (!first) { this.expect(','); if (this.accept('}')) break; }
      first = false;
      if (this.is('.')) {
        this.next();
        const name = this.ident();
        const mi = n.type.members.findIndex(m => m.name === name.v);
        if (mi < 0) fail(name, "no member named '" + name.v + "' in " + typeName(n.type));
        if (n.type.kind === 'union') n.unionIndex = mi;
        this.designation(n.children[mi]);
        i = mi + 1;
        continue;
      }
      if (n.type.kind === 'union') {
        if (i > 0) { this.skipExcess(); continue; }
        n.unionIndex = 0;
      }
      if (i >= n.children.length) { this.skipExcess(); continue; }
      this.initItem(n.children[i]);
      i++;
    }
  }

  structBare(n) {
    const count = n.type.kind === 'union' ? 1 : n.children.length;
    if (n.type.kind === 'union') n.unionIndex = 0;
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        if (!this.is(',') || this.is('}', 1) || this.is('.', 1) || this.is('[', 1)) break;
        this.next();
      }
      this.initItem(n.children[i]);
    }
  }

  flattenInit(n, ty, off, out) {
    if (n.str) {
      const len = ty.len;
      const bytes = n.str.slice(0, len);
      out.push({ off, bytes });
      return;
    }
    if (n.expr) {
      if (isAgg(ty)) { out.push({ off, ty, expr: n.expr }); return; }
      out.push({ off, ty, expr: this.cast(this.rv(n.expr), ty) });
      return;
    }
    if (!n.children) return;
    if (ty.kind === 'array') {
      n.children.forEach((c, i) => this.flattenInit(c, ty.base, off + i * ty.base.size, out));
      return;
    }
    if (ty.kind === 'union') {
      if (n.unionIndex !== undefined) this.flattenInit(n.children[n.unionIndex], ty.members[n.unionIndex].type, off, out);
      return;
    }
    n.children.forEach((c, i) => this.flattenInit(c, ty.members[i].type, off + ty.members[i].offset, out));
  }

  stringBytes() {
    let bytes = [];
    while (this.tok.k === 'str') {
      const t = this.next();
      bytes = bytes.concat(decodeEscapes(t.v.slice(1, -1), t));
    }
    return bytes;
  }

  // =================================================================
  //  Statements
  // =================================================================
  compound(isFuncBody) {
    const tok = this.expect('{');
    if (!isFuncBody) this.push();
    this.blockLevel++;
    const items = [];
    while (!this.accept('}')) {
      if (this.tok.k === 'eof') fail(tok, 'expected } at end of input');
      if (this.is('_Static_assert')) { this.staticAssert(); continue; }
      if (this.isTypename() && !this.is(':', 1)) { this.localDecl(items); continue; }
      items.push(this.stmt());
    }
    this.blockLevel--;
    if (!isFuncBody) this.pop();
    return { k: 'block', items, tok };
  }

  localDecl(items) {
    const attr = {};
    const base = this.declspec(attr);
    if (this.accept(';')) return;
    let first = true;
    while (!this.accept(';')) {
      if (!first) this.expect(',');
      first = false;
      const d = this.declarator(base);
      if (attr.typedef) { this.declare(d.name, { typedef: true, type: d.type }); continue; }
      if (d.type.kind === 'func') { this.funcDecl(d, attr); this.declare(d.name, { func: this.funcs.get(d.name), type: d.type }); continue; }
      if (d.type.kind === 'void') fail(d.tok, "variable '" + d.name + "' has type void");
      if (attr.extern) {
        const g = this.scopes[0].vars.get(d.name);
        if (g && g.obj) { this.declare(d.name, g); continue; }
        const o = this.newGlobal(d.name, d.type, { tok: d.tok });
        this.scopes[0].vars.set(d.name, { obj: o, type: d.type });
        this.declare(d.name, { obj: o, type: d.type });
        continue;
      }
      if (attr.static) {
        const o = this.newGlobal(this.fn.name + '.' + d.name + '.' + this.uid, d.type, { isStatic: true, defined: true, tok: d.tok, displayName: d.name });
        this.declare(d.name, { obj: o, type: d.type });
        if (this.accept('=')) { o.init = this.initializer(d.type, o, true); o.type = o.init.type; this.findVar(d.name).type = o.type; }
        continue;
      }
      const o = this.newLocal(d.name, d.type, d.tok);
      if (this.accept('=')) {
        const init = this.initializer(d.type, o, false);
        o.type = init.type;
        this.findVar(d.name).type = o.type;
        items.push({ k: 'init', obj: o, init, tok: d.tok });
      } else {
        if (d.type.kind === 'array' && d.type.len < 0) fail(d.tok, "array '" + d.name + "' needs an explicit size or an initializer");
        if (isAgg(d.type) && !d.type.complete) fail(d.tok, "variable '" + d.name + "' has incomplete type");
        items.push({ k: 'decl', obj: o, tok: d.tok });
      }
    }
  }

  stmt() {
    const tok = this.tok;
    if (tok.k === 'id') {
      switch (tok.v) {
        case 'if': {
          this.next(); this.expect('(');
          const c = this.toCond(this.expr());
          this.expect(')');
          const a = this.stmt();
          const b = this.accept('else') ? this.stmt() : null;
          return { k: 'if', c, a, b, tok };
        }
        case 'while': {
          this.next(); this.expect('(');
          const c = this.toCond(this.expr());
          this.expect(')');
          this.breakable++; this.continuable++;
          const body = this.stmt();
          this.breakable--; this.continuable--;
          return { k: 'while', c, body, tok };
        }
        case 'do': {
          this.next();
          this.breakable++; this.continuable++;
          const body = this.stmt();
          this.breakable--; this.continuable--;
          this.expect('while'); this.expect('(');
          const c = this.toCond(this.expr());
          this.expect(')'); this.expect(';');
          return { k: 'dowhile', c, body, tok };
        }
        case 'for': {
          this.next(); this.expect('(');
          this.push();
          let init = null;
          if (this.isTypename()) { const items = []; this.localDecl(items); init = { k: 'block', items, tok, noScope: true }; }
          else if (!this.accept(';')) { init = { k: 'expr', e: this.expr(), tok }; this.expect(';'); }
          const c = this.is(';') ? null : this.toCond(this.expr());
          this.expect(';');
          const step = this.is(')') ? null : this.expr();
          this.expect(')');
          this.breakable++; this.continuable++;
          const body = this.stmt();
          this.breakable--; this.continuable--;
          this.pop();
          return { k: 'for', init, c, step, body, tok };
        }
        case 'switch': {
          this.next(); this.expect('(');
          let e = this.rv(this.expr());
          if (!isInt(e.ty)) fail(tok, 'switch quantity is not an integer');
          e = this.cast(e, promote(e.ty));
          this.expect(')');
          const sw = { k: 'switch', e, cases: [], hasDefault: false, tok, level: this.blockLevel + 1 };
          const saved = this.sw;
          this.sw = sw;
          this.breakable++;
          sw.body = this.stmt();
          this.breakable--;
          this.sw = saved;
          return sw;
        }
        case 'case': {
          this.next();
          if (!this.sw) fail(tok, "'case' outside of a switch");
          if (this.sw.level !== this.blockLevel) fail(tok, "'case' labels inside nested blocks are not supported");
          const v = this.constInt(this.cond());
          let hi = null;
          if (this.accept('...')) hi = this.constInt(this.cond());
          this.expect(':');
          const vals = [];
          if (hi === null) vals.push(v);
          else { if (hi - v > 4096n) fail(tok, 'case range too large'); for (let x = v; x <= hi; x++) vals.push(x); }
          const ty = this.sw.e.ty;
          const norm = vals.map(x => ty.size === 8 ? (ty.unsigned ? BigInt.asUintN(64, x) : BigInt.asIntN(64, x)) : (ty.unsigned ? BigInt.asUintN(32, x) : BigInt.asIntN(32, x)));
          for (const x of norm) {
            if (this.sw.cases.some(c => c === x)) fail(tok, 'duplicate case value ' + x);
            this.sw.cases.push(x);
          }
          return { k: 'case', vals: norm, tok, ty };
        }
        case 'default': {
          if (this.is(':', 1)) {
            this.next(); this.next();
            if (!this.sw) fail(tok, "'default' outside of a switch");
            if (this.sw.level !== this.blockLevel) fail(tok, "'default' inside a nested block is not supported");
            if (this.sw.hasDefault) fail(tok, 'multiple default labels in one switch');
            this.sw.hasDefault = true;
            return { k: 'default', tok };
          }
          break;
        }
        case 'break':
          this.next(); this.expect(';');
          if (!this.breakable) fail(tok, "'break' statement not in loop or switch statement");
          return { k: 'break', tok };
        case 'continue':
          this.next(); this.expect(';');
          if (!this.continuable) fail(tok, "'continue' statement not in loop statement");
          return { k: 'continue', tok };
        case 'return': {
          this.next();
          const rt = this.fn.type.ret;
          if (this.accept(';')) {
            if (rt.kind !== 'void') return { k: 'return', e: null, tok, missing: true };
            return { k: 'return', e: null, tok };
          }
          let e = this.expr();
          this.expect(';');
          if (rt.kind === 'void') {
            if (e.ty.kind !== 'void') fail(tok, 'void function should not return a value');
            return { k: 'block', items: [{ k: 'expr', e, tok }, { k: 'return', e: null, tok }], tok, noScope: true };
          }
          e = this.rv(e);
          if (isAgg(rt)) { if (!sameType(e.ty, rt)) fail(tok, 'returning ' + typeName(e.ty) + ' from a function with result type ' + typeName(rt)); }
          else e = this.assignConv(e, rt, tok, 'returning');
          return { k: 'return', e, tok };
        }
        case 'goto':
          fail(tok, "'goto' is not supported by the Studio compiler");
          break;
        case 'asm': case '__asm__': case '__asm':
          fail(tok, 'inline assembly is not supported; use the SDK wrappers (they compile to the right syscalls)');
          break;
      }
      if (this.is(':', 1) && !this.isTypename()) fail(tok, "labels and 'goto' are not supported by the Studio compiler");
    }
    if (this.is('{')) return this.compound(false);
    if (this.accept(';')) return { k: 'empty', tok };
    const e = this.expr();
    this.expect(';');
    return { k: 'expr', e, tok };
  }

  toCond(e) {
    e = this.rv(e);
    if (!isScalar(e.ty)) fail(e.tok, 'used ' + typeName(e.ty) + ' where a scalar is required');
    return e;
  }

  // =================================================================
  //  Expressions
  // =================================================================
  node(k, ty, tok, extra) { return Object.assign({ k, ty, tok }, extra); }
  num(v, ty, tok) { return { k: 'num', ty: ty || T.int, val: BigInt(v), tok }; }

  // value conversion: arrays decay, functions become pointers
  rv(e) {
    if (e.ty.kind === 'array') { this.markAddr(e); return this.node('decay', ptrTo(e.ty.base), e.tok, { e }); }
    if (e.ty.kind === 'func') return this.node('addr', ptrTo(e.ty), e.tok, { e });
    return e;
  }

  markAddr(e) {
    for (;;) {
      if (e.k === 'var') { if (e.obj.local) e.obj.addrTaken = true; return; }
      if (e.k === 'member') { e = e.e; continue; }
      if (e.k === 'compound') { e.obj.addrTaken = true; return; }
      return;
    }
  }

  cast(e, ty) {
    if (sameType(e.ty, ty) && e.ty.kind === ty.kind && !!e.ty.unsigned === !!ty.unsigned && e.ty.size === ty.size && !isAgg(ty) && e.ty.kind !== 'ptr') return e;
    if (ty.kind === 'ptr' && e.ty.kind === 'ptr') return Object.assign({}, e, { ty }); // pointer reinterpretation is free
    if (e.k === 'num' && isInt(ty)) return { k: 'num', ty, val: wrapInt(e.val, ty), tok: e.tok };
    if (e.k === 'num' && isFlo(ty)) return { k: 'fnum', ty, val: ty.kind === 'float' ? Math.fround(Number(e.val)) : Number(e.val), tok: e.tok };
    if (e.k === 'fnum' && isFlo(ty)) return { k: 'fnum', ty, val: ty.kind === 'float' ? Math.fround(e.val) : e.val, tok: e.tok };
    return this.node('cast', ty, e.tok, { e });
  }

  // conversion for assignment, arguments and returns
  assignConv(e, ty, tok, what) {
    e = this.rv(e);
    if (isAgg(ty)) {
      if (!isAgg(e.ty) || !sameType(e.ty, ty)) fail(tok, what + ' ' + typeName(e.ty) + ' to incompatible type ' + typeName(ty));
      return e;
    }
    if (ty.kind === 'ptr') {
      if (isInt(e.ty)) {
        if (!(e.k === 'num' && e.val === 0n) && !(e.k === 'cast' && e.e.k === 'num' && e.e.val === 0n)) {
          // GCC accepts this with a warning; so do we.
        }
        return this.cast(e, ty);
      }
      if (e.ty.kind !== 'ptr') fail(tok, what + ' ' + typeName(e.ty) + ' to incompatible type ' + typeName(ty));
      return this.cast(e, ty);
    }
    if (isNum(ty)) {
      if (!isScalar(e.ty)) fail(tok, what + ' ' + typeName(e.ty) + ' to incompatible type ' + typeName(ty));
      return this.cast(e, ty);
    }
    if (ty.kind === 'void') return e;
    fail(tok, 'cannot convert to ' + typeName(ty));
  }

  expr() {
    let e = this.assign();
    while (this.is(',')) {
      const tok = this.next();
      const b = this.assign();
      e = this.node('comma', b.ty.kind === 'array' ? ptrTo(b.ty.base) : b.ty, tok, { a: e, b: this.rv(b) });
    }
    return e;
  }

  checkLvalue(e, tok) {
    if (e.k === 'var' || e.k === 'deref' || e.k === 'compound') return;
    if (e.k === 'member') return this.checkLvalue(e.e, tok);
    fail(tok, 'expression is not assignable');
  }

  assign() {
    const lhs = this.cond();
    const tok = this.tok;
    if (tok.k !== 'punct') return lhs;
    const ops = { '=': null, '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%', '&=': '&', '|=': '|', '^=': '^', '<<=': '<<', '>>=': '>>' };
    if (!(tok.v in ops)) return lhs;
    this.next();
    const rhs = this.assign();
    const hooked = this.assignHook(tok.v, lhs, rhs, tok);
    if (hooked) return hooked;
    this.checkLvalue(lhs, tok);
    if (lhs.ty.kind === 'array') fail(tok, 'array type ' + typeName(lhs.ty) + ' is not assignable');
    const op = ops[tok.v];
    if (op === null) {
      return this.node('assign', lhs.ty, tok, { lhs, rhs: this.assignConv(rhs, lhs.ty, tok, 'assigning') });
    }
    // compound assignment: compute in the operation type, convert back
    const r = this.rv(rhs);
    if (isPtr(lhs.ty) && (op === '+' || op === '-')) {
      if (!isInt(r.ty)) fail(tok, 'invalid operands to ' + tok.v);
      return this.node('opassign', lhs.ty, tok, { op: op === '+' ? 'padd' : 'psub', lhs, rhs: this.cast(r, T.long), opTy: lhs.ty });
    }
    if (!isNum(lhs.ty) || !isNum(r.ty)) fail(tok, 'invalid operands to ' + tok.v + ' (' + typeName(lhs.ty) + ' and ' + typeName(r.ty) + ')');
    if (op === '<<' || op === '>>') {
      if (!isInt(lhs.ty) || !isInt(r.ty)) fail(tok, 'invalid operands to ' + tok.v);
      const opTy = promote(lhs.ty);
      return this.node('opassign', lhs.ty, tok, { op, lhs, rhs: this.cast(r, T.int), opTy });
    }
    if ((op === '%' || op === '&' || op === '|' || op === '^') && (!isInt(lhs.ty) || !isInt(r.ty))) fail(tok, 'invalid operands to ' + tok.v);
    const opTy = usualArith(lhs.ty, r.ty);
    return this.node('opassign', lhs.ty, tok, { op, lhs, rhs: this.cast(r, opTy), opTy });
  }

  cond() {
    const c = this.logor();
    if (!this.is('?')) return c;
    const tok = this.next();
    let a = this.rv(this.expr());
    this.expect(':');
    let b = this.rv(this.cond());
    const cc = this.toCond(c);
    let ty;
    if (isNum(a.ty) && isNum(b.ty)) { ty = usualArith(a.ty, b.ty); a = this.cast(a, ty); b = this.cast(b, ty); }
    else if (a.ty.kind === 'void' || b.ty.kind === 'void') ty = T.void;
    else if (isPtr(a.ty) && isPtr(b.ty)) ty = a.ty.base.kind === 'void' ? b.ty : a.ty;
    else if (isPtr(a.ty) && isInt(b.ty)) { ty = a.ty; b = this.cast(b, ty); }
    else if (isInt(a.ty) && isPtr(b.ty)) { ty = b.ty; a = this.cast(a, ty); }
    else if (isAgg(a.ty) && sameType(a.ty, b.ty)) ty = a.ty;
    else fail(tok, 'incompatible operand types (' + typeName(a.ty) + ' and ' + typeName(b.ty) + ')');
    return this.node('cond', ty, tok, { c: cc, a, b });
  }

  logor() {
    let e = this.logand();
    while (this.is('||')) { const tok = this.next(); e = this.node('logor', this.boolTy(), tok, { a: this.toCond(e), b: this.toCond(this.logand()) }); }
    return e;
  }
  logand() {
    let e = this.bitor();
    while (this.is('&&')) { const tok = this.next(); e = this.node('logand', this.boolTy(), tok, { a: this.toCond(e), b: this.toCond(this.bitor()) }); }
    return e;
  }
  bitor() { let e = this.bitxor(); while (this.is('|')) { const tok = this.next(); e = this.arith('|', e, this.bitxor(), tok); } return e; }
  bitxor() { let e = this.bitand(); while (this.is('^')) { const tok = this.next(); e = this.arith('^', e, this.bitand(), tok); } return e; }
  bitand() { let e = this.equality(); while (this.is('&')) { const tok = this.next(); e = this.arith('&', e, this.equality(), tok); } return e; }
  equality() {
    let e = this.relational();
    for (;;) {
      if (this.is('==') || this.is('!=')) { const tok = this.next(); e = this.compare(tok.v, e, this.relational(), tok); continue; }
      return e;
    }
  }
  relational() {
    let e = this.shift();
    for (;;) {
      if (this.is('<') || this.is('<=') || this.is('>') || this.is('>=')) { const tok = this.next(); e = this.compare(tok.v, e, this.shift(), tok); continue; }
      return e;
    }
  }
  shift() {
    let e = this.additive();
    for (;;) {
      if (this.is('<<') || this.is('>>')) {
        const tok = this.next();
        const rhs = this.additive();
        const hooked = this.binHook(tok.v, e, rhs, tok);
        if (hooked) { e = hooked; continue; }
        let a = this.rv(e), b = this.rv(rhs);
        if (!isInt(a.ty) || !isInt(b.ty)) fail(tok, 'invalid operands to ' + tok.v);
        const ty = promote(a.ty);
        e = this.fold(this.node('bin', ty, tok, { op: tok.v, a: this.cast(a, ty), b: this.cast(b, T.int) }));
        continue;
      }
      return e;
    }
  }
  additive() {
    let e = this.multiplicative();
    for (;;) {
      if (this.is('+') || this.is('-')) { const tok = this.next(); e = tok.v === '+' ? this.add(e, this.multiplicative(), tok) : this.sub(e, this.multiplicative(), tok); continue; }
      return e;
    }
  }
  multiplicative() {
    let e = this.castExpr();
    for (;;) {
      if (this.is('*') || this.is('/') || this.is('%')) { const tok = this.next(); e = this.arith(tok.v, e, this.castExpr(), tok); continue; }
      return e;
    }
  }

  arith(op, a, b, tok) {
    const hooked = this.binHook(op, a, b, tok);
    if (hooked) return hooked;
    a = this.rv(a); b = this.rv(b);
    const intOnly = op === '%' || op === '&' || op === '|' || op === '^';
    if (!isNum(a.ty) || !isNum(b.ty) || (intOnly && (!isInt(a.ty) || !isInt(b.ty))))
      fail(tok, 'invalid operands to binary ' + op + ' (' + typeName(a.ty) + ' and ' + typeName(b.ty) + ')');
    const ty = usualArith(a.ty, b.ty);
    return this.fold(this.node('bin', ty, tok, { op, a: this.cast(a, ty), b: this.cast(b, ty) }));
  }

  add(a, b, tok) {
    const hooked = this.binHook('+', a, b, tok);
    if (hooked) return hooked;
    a = this.rv(a); b = this.rv(b);
    if (isNum(a.ty) && isNum(b.ty)) return this.arith('+', a, b, tok);
    if (isInt(a.ty) && isPtr(b.ty)) [a, b] = [b, a];
    if (isPtr(a.ty) && isInt(b.ty)) {
      this.checkComplete(a.ty.base, tok);
      return this.node('padd', a.ty, tok, { a, b: this.cast(b, T.long), size: a.ty.base.kind === 'void' ? 1 : a.ty.base.size });
    }
    fail(tok, 'invalid operands to binary + (' + typeName(a.ty) + ' and ' + typeName(b.ty) + ')');
  }

  sub(a, b, tok) {
    const hooked = this.binHook('-', a, b, tok);
    if (hooked) return hooked;
    a = this.rv(a); b = this.rv(b);
    if (isNum(a.ty) && isNum(b.ty)) return this.arith('-', a, b, tok);
    if (isPtr(a.ty) && isInt(b.ty)) {
      this.checkComplete(a.ty.base, tok);
      return this.node('psub', a.ty, tok, { a, b: this.cast(b, T.long), size: a.ty.base.kind === 'void' ? 1 : a.ty.base.size });
    }
    if (isPtr(a.ty) && isPtr(b.ty)) {
      return this.node('pdiff', T.long, tok, { a, b, size: a.ty.base.kind === 'void' ? 1 : a.ty.base.size });
    }
    fail(tok, 'invalid operands to binary - (' + typeName(a.ty) + ' and ' + typeName(b.ty) + ')');
  }

  checkComplete(ty, tok) {
    if (isAgg(ty) && !ty.complete) fail(tok, 'arithmetic on a pointer to an incomplete type ' + typeName(ty));
  }

  compare(op, a, b, tok) {
    const hooked = this.binHook(op, a, b, tok);
    if (hooked) return hooked;
    a = this.rv(a); b = this.rv(b);
    let ty;
    if (isNum(a.ty) && isNum(b.ty)) { ty = usualArith(a.ty, b.ty); a = this.cast(a, ty); b = this.cast(b, ty); }
    else if ((isPtr(a.ty) || isInt(a.ty)) && (isPtr(b.ty) || isInt(b.ty))) {
      ty = isPtr(a.ty) ? a.ty : b.ty;
      if (!isPtr(a.ty)) a = this.cast(a, ty);
      if (!isPtr(b.ty)) b = this.cast(b, ty);
    } else fail(tok, 'invalid operands to ' + op + ' (' + typeName(a.ty) + ' and ' + typeName(b.ty) + ')');
    if (op === '>') { [a, b] = [b, a]; op = '<'; }
    else if (op === '>=') { [a, b] = [b, a]; op = '<='; }
    const n = this.node('cmp', this.boolTy(), tok, { op, a, b, cty: ty });
    return this.fold(n);
  }

  fold(n) {
    // constant folding for integer literals keeps array sizes and case labels simple
    try {
      if (n.a && n.a.k === 'num' && n.b && n.b.k === 'num' && (n.k === 'bin' || n.k === 'cmp')) {
        const v = this.evalInt(n);
        return { k: 'num', ty: n.ty, val: v, tok: n.tok };
      }
    } catch (e) { /* not constant (e.g. division by zero) */ }
    return n;
  }

  castExpr() {
    if (this.is('(') && this.isTypename(this.peek(1))) {
      const tok = this.next();
      const ty = this.typename();
      this.expect(')');
      if (this.is('{')) return this.postfixFrom(this.compoundLiteral(ty, tok));
      const e = this.castExpr();
      if (ty.kind === 'void') return this.node('cast', T.void, tok, { e: this.rv(e) });
      const v = this.rv(e);
      if (!isScalar(ty)) fail(tok, 'cannot cast to ' + typeName(ty));
      if (!isScalar(v.ty)) fail(tok, 'cannot cast ' + typeName(v.ty) + ' to ' + typeName(ty));
      if (isFlo(ty) && isPtr(v.ty)) fail(tok, 'cannot cast a pointer to a floating type');
      if (isPtr(ty) && isFlo(v.ty)) fail(tok, 'cannot cast a floating value to a pointer');
      const c = this.cast(v, ty);
      return c === v && c.k !== 'num' ? this.node('cast', ty, tok, { e: v }) : c;
    }
    return this.unary();
  }

  compoundLiteral(ty, tok) {
    if (!this.fn) {
      const o = this.newGlobal('.compound.' + this.uid, ty, { isStatic: true, defined: true, tok });
      o.init = this.initializer(ty, o, true);
      o.type = o.init.type;
      return this.node('var', o.type, tok, { obj: o });
    }
    const o = this.newLocal(null, ty, tok);
    const init = this.initializer(ty, o, false);
    o.type = init.type;
    o.addrTaken = true;
    return this.node('compound', o.type, tok, { obj: o, init });
  }

  unary() {
    const tok = this.tok;
    if (tok.k === 'punct') {
      switch (tok.v) {
        case '+': { this.next(); const e = this.rv(this.castExpr()); if (!isNum(e.ty)) fail(tok, 'invalid argument to unary +'); return this.cast(e, promote(e.ty)); }
        case '-': {
          this.next();
          const e = this.rv(this.castExpr());
          if (!isNum(e.ty)) fail(tok, 'invalid argument to unary -');
          const ty = promote(e.ty);
          if (e.k === 'num') return { k: 'num', ty, val: wrapInt(-e.val, ty), tok };
          if (e.k === 'fnum') return { k: 'fnum', ty, val: -e.val, tok };
          return this.node('neg', ty, tok, { e: this.cast(e, ty) });
        }
        case '!': { this.next(); const e = this.toCond(this.castExpr()); if (e.k === 'num') return this.num(e.val === 0n ? 1 : 0, this.boolTy(), tok); return this.node('not', this.boolTy(), tok, { e }); }
        case '~': {
          this.next();
          const e = this.rv(this.castExpr());
          if (!isInt(e.ty)) fail(tok, 'invalid argument to unary ~');
          const ty = promote(e.ty);
          if (e.k === 'num') return { k: 'num', ty, val: wrapInt(~e.val, ty), tok };
          return this.node('bitnot', ty, tok, { e: this.cast(e, ty) });
        }
        case '&': {
          this.next();
          const e = this.castExpr();
          if (e.k === 'deref') return this.rv(e.e).ty.kind === 'ptr' ? Object.assign({}, this.rv(e.e), { ty: ptrTo(e.ty) }) : e.e;
          if (e.ty.kind === 'func') return this.node('addr', ptrTo(e.ty), tok, { e });
          this.checkLvalue(e, tok);
          this.markAddr(e);
          return this.node('addr', ptrTo(e.ty), tok, { e });
        }
        case '*': {
          this.next();
          const e = this.rv(this.castExpr());
          if (!isPtr(e.ty)) fail(tok, 'indirection requires pointer operand (' + typeName(e.ty) + ' invalid)');
          if (e.ty.base.kind === 'func') return e;
          if (e.ty.base.kind === 'void') fail(tok, "dereferencing a 'void *' pointer");
          return this.node('deref', e.ty.base, tok, { e });
        }
        case '++': case '--': {
          this.next();
          const e = this.unary();
          return this.incdec(e, true, tok.v === '++', tok);
        }
      }
    }
    if (tok.k === 'id' && (tok.v === 'sizeof' || tok.v === '_Alignof' || tok.v === '__alignof__')) {
      this.next();
      let ty;
      if (this.is('(') && this.isTypename(this.peek(1))) {
        this.next(); ty = this.typename(); this.expect(')');
        if (this.is('{')) { const e = this.postfixFrom(this.compoundLiteral(ty, tok)); ty = e.ty; }
      } else {
        const e = this.unary();
        ty = e.ty;
      }
      if (tok.v === 'sizeof') {
        if (ty.kind === 'array' && ty.len < 0) fail(tok, "invalid application of 'sizeof' to an incomplete type");
        if (isAgg(ty) && !ty.complete) fail(tok, "invalid application of 'sizeof' to an incomplete type " + typeName(ty));
        if (ty.kind === 'func') return this.num(1, T.ulong, tok);
        return this.num(ty.size, T.ulong, tok);
      }
      return this.num(ty.align, T.ulong, tok);
    }
    return this.postfix();
  }

  incdec(e, pre, inc, tok) {
    this.checkLvalue(e, tok);
    if (!isScalar(e.ty)) fail(tok, 'cannot increment value of type ' + typeName(e.ty));
    return this.node('incdec', e.ty, tok, { e, pre, inc, size: isPtr(e.ty) ? (e.ty.base.kind === 'void' ? 1 : e.ty.base.size) : 1 });
  }

  postfix() { return this.postfixFrom(this.primary()); }

  postfixFrom(e) {
    for (;;) {
      const tok = this.tok;
      if (tok.k !== 'punct') return e;
      if (tok.v === '[') {
        this.next();
        const idx = this.expr();
        this.expect(']');
        const p = this.add(e, idx, tok);
        if (!isPtr(p.ty)) fail(tok, 'subscripted value is not an array or pointer');
        if (p.ty.base.kind === 'void') fail(tok, "subscript of a 'void *' pointer");
        e = this.node('deref', p.ty.base, tok, { e: p });
        continue;
      }
      if (tok.v === '(') { this.next(); e = this.call(e, tok); continue; }
      if (tok.v === '.' || tok.v === '->') {
        this.next();
        const name = this.ident();
        let base = e;
        if (tok.v === '->') {
          base = this.rv(e);
          if (!isPtr(base.ty) || !isAgg(base.ty.base)) fail(tok, "member reference type " + typeName(base.ty) + ' is not a pointer to a structure');
          base = this.node('deref', base.ty.base, tok, { e: base });
        } else if (!isAgg(e.ty)) fail(tok, "member reference base type " + typeName(e.ty) + ' is not a structure or union');
        if (!base.ty.complete) fail(tok, 'incomplete type ' + typeName(base.ty));
        const m = base.ty.members.find(x => x.name === name.v);
        if (!m) fail(name, "no member named '" + name.v + "' in " + typeName(base.ty));
        e = this.node('member', m.type, name, { e: base, mem: m });
        continue;
      }
      if (tok.v === '++' || tok.v === '--') { this.next(); e = this.incdec(e, false, tok.v === '++', tok); continue; }
      return e;
    }
  }

  call(fe, tok) {
    let fty;
    let target = fe;
    if (fe.ty.kind === 'func') fty = fe.ty;
    else {
      const v = this.rv(fe);
      if (isPtr(v.ty) && v.ty.base.kind === 'func') { fty = v.ty.base; target = v; }
      else fail(tok, 'called object type ' + typeName(fe.ty) + ' is not a function or function pointer');
    }
    const args = [];
    if (!this.accept(')')) {
      for (;;) {
        args.push(this.assign());
        if (this.accept(')')) break;
        this.expect(',');
      }
    }
    const name = fe.k === 'func' ? fe.fn.name : 'function';
    if (!fty.oldStyle) {
      if (args.length < fty.params.length || (!fty.variadic && args.length > fty.params.length))
        fail(tok, 'too ' + (args.length < fty.params.length ? 'few' : 'many') + " arguments to '" + name + "' (expected " + fty.params.length + ', have ' + args.length + ')');
    }
    const conv = args.map((a, i) => {
      if (!fty.oldStyle && i < fty.params.length) return this.assignConv(a, fty.params[i], a.tok || tok, 'passing');
      let v = this.rv(a);
      if (isFlo(v.ty)) return this.cast(v, T.double);
      if (isInt(v.ty)) return this.cast(v, promote(v.ty));
      return v;
    });
    if (isAgg(fty.ret) && !fty.ret.complete) fail(tok, 'calling a function with incomplete return type');
    const n = this.node('call', fty.ret, tok, { f: target, args: conv, fty, nfixed: fty.oldStyle ? conv.length : fty.params.length });
    if (isAgg(fty.ret) && this.fn) { n.ret = this.newLocal(null, fty.ret, tok); n.ret.addrTaken = true; }
    return n;
  }

  primary() {
    const tok = this.tok;
    if (this.is('(')) {
      this.next();
      if (this.is('{')) fail(tok, 'statement expressions are not supported');
      const e = this.expr();
      this.expect(')');
      return e;
    }
    if (tok.k === 'num') { this.next(); return this.parseNumber(tok); }
    if (tok.k === 'char') { this.next(); return this.num(decodeChar(tok), this.charTy(), tok); }
    if (tok.k === 'str') {
      const bytes = this.stringBytes();
      return this.stringLiteral(bytes, tok);
    }
    if (tok.k === 'id') {
      switch (tok.v) {
        case '__func__': case '__FUNCTION__': case '__PRETTY_FUNCTION__':
          this.next();
          return this.stringLiteral(utf8(this.fn ? this.fn.name : ''), tok);
        case '__builtin_va_start': {
          this.next(); this.expect('(');
          const ap = this.assign(); this.expect(',');
          this.assign(); this.expect(')');
          if (!this.fn || !this.fn.type.variadic) fail(tok, "'va_start' used in a function with fixed arguments");
          this.checkLvalue(ap, tok);
          return this.node('va_start', T.void, tok, { ap });
        }
        case '__builtin_va_end': {
          this.next(); this.expect('('); this.assign(); this.expect(')');
          return this.num(0, T.int, tok);
        }
        case '__builtin_va_copy': {
          this.next(); this.expect('(');
          const dst = this.assign(); this.expect(',');
          const src = this.rv(this.assign()); this.expect(')');
          this.checkLvalue(dst, tok);
          return this.node('assign', dst.ty, tok, { lhs: dst, rhs: this.cast(src, dst.ty) });
        }
        case '__builtin_va_arg': {
          this.next(); this.expect('(');
          const ap = this.assign(); this.expect(',');
          const ty = this.typename(); this.expect(')');
          this.checkLvalue(ap, tok);
          if (!isScalar(ty)) fail(tok, 'va_arg of a structure is not supported');
          return this.node('va_arg', ty, tok, { ap });
        }
        case '__syscall': {
          this.next(); this.expect('(');
          const args = [];
          for (let i = 0; i < 4; i++) {
            if (i) this.expect(',');
            args.push(this.assignConv(this.assign(), T.ulong, tok, 'passing'));
          }
          this.expect(')');
          return this.node('syscall', T.ulong, tok, { args });
        }
        case '__builtin_offsetof': {
          this.next(); this.expect('(');
          const ty = this.typename(); this.expect(',');
          let off = 0, cur = ty;
          for (;;) {
            const name = this.ident();
            if (!isAgg(cur)) fail(name, 'offsetof on a non-structure');
            const m = cur.members.find(x => x.name === name.v);
            if (!m) fail(name, "no member named '" + name.v + "'");
            off += m.offset; cur = m.type;
            if (this.accept('.')) continue;
            if (this.is('[')) {
              this.next();
              const i = Number(this.constInt(this.expr()));
              this.expect(']');
              off += i * cur.base.size; cur = cur.base;
              if (this.accept('.')) continue;
            }
            break;
          }
          this.expect(')');
          return this.num(off, T.ulong, tok);
        }
        case '__builtin_expect': {
          this.next(); this.expect('(');
          const e = this.assign(); this.expect(','); this.assign(); this.expect(')');
          return e;
        }
        case '__builtin_unreachable': case '__builtin_trap': {
          this.next(); this.expect('('); this.expect(')');
          return this.node('trap', T.void, tok, {});
        }
      }
      const v = this.findVar(tok.v);
      if (!v) {
        if (this.is('(', 1)) fail(tok, "implicit declaration of function '" + tok.v + "' (include the SDK header that declares it)");
        fail(tok, "use of undeclared identifier '" + tok.v + "'");
      }
      if (v.typedef) fail(tok, "unexpected type name '" + tok.v + "'");
      this.next();
      if (v.enumConst) return this.num(v.value, T.int, tok);
      if (v.func) return this.node('func', v.func.type, tok, { fn: v.func });
      return this.node('var', v.type, tok, { obj: v.obj });
    }
    fail(tok, tok.k === 'eof' ? 'unexpected end of file' : "expected an expression before '" + tok.v + "'");
  }

  stringLiteral(bytes, tok) {
    const key = bytes.join(',');
    let o = this.strings.get(key);
    if (!o) {
      const ty = arrayOf(T.char, bytes.length + 1);
      o = this.newGlobal('.str.' + this.strings.size, ty, { isStatic: true, defined: true, readonly: true, isString: true });
      o.init = { type: ty, entries: [{ off: 0, bytes: bytes.concat([0]) }], isGlobal: true };
      this.strings.set(key, o);
    }
    return this.node('var', o.type, tok, { obj: o });
  }

  parseNumber(tok) {
    let s = tok.v;
    const isHex = /^0[xX]/.test(s);
    if (/[.]/.test(s) || (!isHex && /[eE]/.test(s)) || (isHex && /[pP]/.test(s))) {
      let ty = T.double;
      if (/[fF]$/.test(s)) { ty = T.float; s = s.slice(0, -1); }
      else if (/[lL]$/.test(s)) s = s.slice(0, -1);
      let v;
      if (isHex) {
        const m = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)$/.exec(s);
        if (!m) fail(tok, 'invalid hexadecimal floating constant');
        const intPart = m[1] || '0', frac = m[2] || '';
        v = parseInt(intPart + frac || '0', 16) / Math.pow(16, frac.length) * Math.pow(2, parseInt(m[3], 10));
      } else {
        if (!/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) fail(tok, "invalid floating constant '" + tok.v + "'");
        v = parseFloat(s);
      }
      return { k: 'fnum', ty, val: ty.kind === 'float' ? Math.fround(v) : v, tok };
    }
    const m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)([uUlL]*)$/.exec(s);
    if (!m) fail(tok, "invalid number '" + tok.v + "'");
    let body = m[1];
    const suf = m[2].toLowerCase();
    let v;
    if (/^0[xXbB]/.test(body)) v = BigInt(body);
    else if (body.length > 1 && body[0] === '0') v = BigInt('0o' + body.slice(1));
    else v = BigInt(body);
    const u = suf.includes('u'), l = suf.includes('l');
    const dec = !/^0/.test(body) || body === '0';
    let ty;
    const fitsInt = v <= 0x7fffffffn, fitsUint = v <= 0xffffffffn, fitsLong = v <= 0x7fffffffffffffffn;
    if (v > 0xffffffffffffffffn) fail(tok, 'integer literal is too large');
    if (u && l) ty = T.ulong;
    else if (u) ty = fitsUint ? T.uint : T.ulong;
    else if (l) ty = fitsLong ? T.long : T.ulong;
    else if (dec) ty = fitsInt ? T.int : fitsLong ? T.long : T.ulong;
    else ty = fitsInt ? T.int : fitsUint ? T.uint : fitsLong ? T.long : T.ulong;
    return { k: 'num', ty, val: v, tok };
  }

  // ---- constant evaluation ----
  constInt(e) {
    const v = this.evalInt(this.rv(e));
    return v;
  }

  evalInt(e) {
    const ty = e.ty;
    const w = (v) => isInt(ty) ? wrapInt(v, ty) : v;
    switch (e.k) {
      case 'num': return e.val;
      case 'fnum': return BigInt(Math.trunc(e.val));
      case 'cast': {
        if (isFlo(e.e.ty)) { const f = this.evalFloat(e.e); return w(BigInt(Math.trunc(f))); }
        if (isPtr(e.e.ty) && !isInt(ty)) fail(e.tok, 'not an integer constant');
        return w(this.evalInt(e.e));
      }
      case 'neg': return w(-this.evalInt(e.e));
      case 'bitnot': return w(~this.evalInt(e.e));
      case 'not': return this.evalInt(e.e) === 0n ? 1n : 0n;
      case 'logand': return (this.evalInt(e.a) !== 0n && this.evalInt(e.b) !== 0n) ? 1n : 0n;
      case 'logor': return (this.evalInt(e.a) !== 0n || this.evalInt(e.b) !== 0n) ? 1n : 0n;
      case 'cond': return this.evalInt(e.c) !== 0n ? this.evalInt(e.a) : this.evalInt(e.b);
      case 'comma': return this.evalInt(e.b);
      case 'cmp': {
        if (isFlo(e.a.ty)) { const a = this.evalFloat(e.a), b = this.evalFloat(e.b); return BigInt(e.op === '==' ? a === b : e.op === '!=' ? a !== b : e.op === '<' ? a < b : a <= b); }
        const a = this.evalInt(e.a), b = this.evalInt(e.b);
        return BigInt(e.op === '==' ? a === b : e.op === '!=' ? a !== b : e.op === '<' ? a < b : a <= b) ? 1n : 0n;
      }
      case 'bin': {
        if (isFlo(ty)) fail(e.tok, 'not an integer constant');
        const a = this.evalInt(e.a), b = this.evalInt(e.b);
        switch (e.op) {
          case '+': return w(a + b); case '-': return w(a - b); case '*': return w(a * b);
          case '/': if (b === 0n) fail(e.tok, 'division by zero in constant expression'); return w(a / b);
          case '%': if (b === 0n) fail(e.tok, 'division by zero in constant expression'); return w(a % b);
          case '&': return w(a & b); case '|': return w(a | b); case '^': return w(a ^ b);
          case '<<': return w(a << (b & 63n));
          case '>>': return w((ty.unsigned ? BigInt.asUintN(ty.size * 8, a) : a) >> (b & 63n));
        }
      }
    }
    fail(e.tok, 'expression is not an integer constant');
  }

  evalFloat(e) {
    if (e.k === 'fnum') return e.val;
    if (e.k === 'num') return Number(e.val);
    if (e.k === 'cast') { const v = isFlo(e.e.ty) ? this.evalFloat(e.e) : Number(this.evalInt(e.e)); return e.ty.kind === 'float' ? Math.fround(v) : v; }
    if (e.k === 'neg') return -this.evalFloat(e.e);
    if (e.k === 'bin' && isFlo(e.ty)) {
      const a = this.evalFloat(e.a), b = this.evalFloat(e.b);
      const r = e.op === '+' ? a + b : e.op === '-' ? a - b : e.op === '*' ? a * b : e.op === '/' ? a / b : NaN;
      return e.ty.kind === 'float' ? Math.fround(r) : r;
    }
    if (e.k === 'cond') return this.evalInt(e.c) !== 0n ? this.evalFloat(e.a) : this.evalFloat(e.b);
    if (isInt(e.ty)) return Number(this.evalInt(e));
    fail(e.tok, 'expression is not a constant');
  }

  finish() {
    const main = this.funcs.get('main');
    return { globals: this.globals, funcs: this.funcs, main };
  }
}

MCC.Parser = Parser;
MCC.internal = { KEYWORDS, TYPE_WORDS, sameType, promote, usualArith, decodeChar, utf8, lex, Preprocessor };

function wrapInt(v, ty) {
  const bits = ty.kind === 'bool' ? 1 : ty.size * 8;
  if (ty.kind === 'bool') return v !== 0n ? 1n : 0n;
  return ty.unsigned ? BigInt.asUintN(bits, v) : BigInt.asIntN(bits, v);
}
MCC.wrapInt = wrapInt;

// =====================================================================
//  Global initializer evaluation (shared by both back ends)
// =====================================================================
// Returns {kind:'int',val} | {kind:'float',val} | {kind:'addr', obj|fn, add}
function evalInitConst(e) {
  const bad = () => fail(e.tok, 'initializer element is not a compile-time constant');
  switch (e.k) {
    case 'num': return { kind: 'int', val: e.val };
    case 'fnum': return { kind: 'float', val: e.val };
    case 'decay': case 'addr': {
      const r = addrOf(e.e);
      if (!r) bad();
      return r;
    }
    case 'cast': {
      const inner = evalInitConst(e.e);
      if (inner.kind === 'addr') { if (e.ty.size !== 8 && e.ty.kind !== 'ptr') bad(); return inner; }
      if (inner.kind === 'float') {
        if (isFlo(e.ty)) return { kind: 'float', val: e.ty.kind === 'float' ? Math.fround(inner.val) : inner.val };
        return { kind: 'int', val: wrapInt(BigInt(Math.trunc(inner.val)), e.ty) };
      }
      if (isFlo(e.ty)) return { kind: 'float', val: Number(inner.val) };
      if (isInt(e.ty)) return { kind: 'int', val: wrapInt(inner.val, e.ty) };
      return inner;
    }
    case 'padd': case 'psub': {
      const a = evalInitConst(e.a), b = evalInitConst(e.b);
      if (a.kind !== 'addr' || b.kind !== 'int') bad();
      const d = Number(b.val) * e.size;
      return Object.assign({}, a, { add: a.add + (e.k === 'padd' ? d : -d) });
    }
    case 'var':
      if (e.obj.isString || e.ty.kind === 'array') return { kind: 'addr', obj: e.obj, add: 0 };
      bad();
      break;
    case 'func': return { kind: 'addr', fn: e.fn, add: 0 };
    case 'neg': case 'bitnot': case 'not': case 'bin': case 'cmp': case 'cond': case 'logand': case 'logor': {
      if (isFlo(e.ty)) {
        const p = new Parser([{ k: 'eof', v: '' }]);
        return { kind: 'float', val: p.evalFloat(e) };
      }
      const p = new Parser([{ k: 'eof', v: '' }]);
      return { kind: 'int', val: p.evalInt(e) };
    }
  }
  bad();
}

function addrOf(e) {
  switch (e.k) {
    case 'var': if (e.obj.local) return null; return { kind: 'addr', obj: e.obj, add: 0 };
    case 'func': return { kind: 'addr', fn: e.fn, add: 0 };
    case 'member': { const b = addrOf(e.e); return b && Object.assign({}, b, { add: b.add + e.mem.offset }); }
    case 'deref': { try { const v = evalInitConst(e.e); return v.kind === 'addr' ? v : null; } catch (x) { return null; } }
  }
  return null;
}
MCC.evalInitConst = evalInitConst;

// =====================================================================
//  Whole-program driver
// =====================================================================
// Compiles the project's .c files plus the SDK crt0 into one program.
// Every translation unit is parsed into the same symbol space; static
// functions are renamed so they cannot clash across files.
function parseProject(files, sdk, opts) {
  opts = opts || {};
  const isCpp = (p) => /\.(cpp|cc|cxx)$/.test(p);
  const units = Object.keys(files).filter(p => /\.c$/.test(p) || isCpp(p)).sort();
  if (!units.length) throw new CompileError('the project has no .c or .cpp files', null);
  if (units.some(isCpp) && !MCC.CppParser) throw new CompileError('C++ support (mcc-cpp.js) is not loaded', null);
  const sources = units.map(u => ({ path: u, own: true }));
  sources.push({ path: 'crt0.c', own: false });
  const all = { globals: [], funcs: new Map() };
  const globalsByName = new Map();
  const inits = [];
  for (const s of sources) {
    const cpp = s.own && isCpp(s.path);
    const pp = new Preprocessor(files, sdk, cpp ? Object.assign({ __cplusplus: '201103L' }, opts.defines) : opts.defines);
    const toks = s.own ? pp.run(s.path) : pp.runSdk(s.path);
    const parser = cpp ? new MCC.CppParser(toks) : new Parser(toks);
    const prog = parser.program();
    if (prog.init) {
      // each C++ unit's global constructors run from __mcc_entry, before main
      const name = '__mcc_init_' + inits.length;
      prog.funcs.delete('__mcc_init');
      Object.assign(prog.init, { name, qname: name, isStatic: false });
      prog.funcs.set(name, prog.init);
      inits.push(name);
    }
    for (const g of prog.globals) {
      if (!g.isStatic && g.name) {
        const prev = globalsByName.get(g.name);
        if (prev) {
          // unify: replace references by sharing the object
          if (g.defined && prev.defined && (g.init || prev.init)) throw new CompileError("duplicate definition of '" + g.name + "'", g.tok);
          if (g.defined && g.init) { prev.init = g.init; prev.type = g.type; }
          prev.defined = prev.defined || g.defined;
          g.alias = prev;
          continue;
        }
        globalsByName.set(g.name, g);
      } else if (g.isStatic) {
        g.name = g.name + '$' + all.globals.length;
      }
      all.globals.push(g);
    }
    for (const [name, f] of prog.funcs) {
      if (f.isStatic || f.isInline) {
        if (!f.defined && f.isStatic) {
          // a static declaration without definition is only an error if used
        }
        f.uname = name + (s.own ? '' : '') + '$' + f.id + '_' + all.funcs.size;
        f.local = true;
        all.funcs.set(f.uname, f);
        continue;
      }
      const prev = all.funcs.get(name);
      if (prev) {
        if (f.defined && prev.defined) throw new CompileError("duplicate definition of function '" + name + "'", f.tok);
        if (f.defined) { Object.assign(prev, { defined: true, body: f.body, params: f.params, locals: f.locals, type: f.type, tok: f.tok, file: f.file }); }
        f.alias = prev;
        continue;
      }
      f.uname = name;
      all.funcs.set(name, f);
    }
  }
  // resolve aliases in the trees lazily: back ends call MCC.resolve*
  const main = all.funcs.get('main');
  if (!main || !main.defined) throw new CompileError("no 'main' function found — every .run program needs int main(int argc, char** argv)", null);
  main.isMain = true;
  if (!inits.length) return { globals: all.globals, funcs: all.funcs, main };
  const src = inits.map(n => 'void ' + n + '(void);\n').join('') + 'int main(int, char**);\n' +
    'int __mcc_entry(int argc, char** argv) {\n' + inits.map(n => '    ' + n + '();\n').join('') + '    return main(argc, argv);\n}\n';
  const eprog = new Parser(new Preprocessor({ '<entry>.c': src }, sdk).run('<entry>.c')).program();
  for (const [name, f] of eprog.funcs) {
    const prev = all.funcs.get(name);
    if (prev) f.alias = prev; else { f.uname = name; all.funcs.set(name, f); }
  }
  return { globals: all.globals, funcs: all.funcs, main: all.funcs.get('__mcc_entry') };
}

Preprocessor.prototype.runSdk = function (path) {
  const src = this.sdk[path];
  if (src === undefined) fail(null, 'missing SDK file ' + path);
  const out = [];
  this.processFile('<sdk>/' + path, src, out);
  out.push({ k: 'eof', v: '', file: path, line: 0, col: 0 });
  return out;
};

MCC.parseProject = parseProject;
MCC.realFunc = (f) => { while (f.alias) f = f.alias; return f; };
MCC.realObj = (o) => { while (o.alias) o = o.alias; return o; };

MCC.SKIP_KEYS = new Set(['ty', 'tok', 'obj', 'fn', 'mem', 'fty', 'ret', 'type', 'cty', 'cls', 'retTemp', 'elide']);

// Walks reachable functions and globals from main (and the extra roots).
function reach(prog, roots) {
  const funcs = new Set(), globals = new Set();
  const stack = [];
  const addF = (f) => { f = MCC.realFunc(f); if (!funcs.has(f)) { funcs.add(f); stack.push(f); } };
  const addG = (o) => { o = MCC.realObj(o); if (!globals.has(o)) { globals.add(o); if (o.init) scanInit(o.init); } };
  function scanInit(init) { for (const en of init.entries) if (en.expr) walk(en.expr); }
  function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.k === 'func') { addF(n.fn); return; }
    if (n.k === 'var' && n.obj && !n.obj.local) addG(n.obj);
    if (n.k === 'compound' || n.k === 'init') scanInit(n.init);
    for (const key in n) {
      if (MCC.SKIP_KEYS.has(key)) continue;
      const v = n[key];
      if (v && typeof v === 'object') walk(v);
    }
  }
  addF(prog.main);
  (roots || []).forEach(addF);
  while (stack.length) {
    const f = stack.pop();
    if (!f.defined) throw new CompileError("undefined reference to '" + f.name + "'", f.tok);
    walk(f.body);
  }
  return { funcs: [...funcs], globals: [...globals] };
}
MCC.reach = reach;

})(typeof self !== 'undefined' ? self : globalThis);
