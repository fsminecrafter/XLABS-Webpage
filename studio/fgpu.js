/*
 * FGPU for the Studio preview: SYS_GPU (40), the GPU interface FarcadeGL
 * (farcadegl.h) draws through.
 *
 * A JavaScript port of the Minimal-OS kernel's CPU backend
 * (src/modules/GPU/fgpu.c, fgpu_raster.c, fgpu_shader.c): surfaces,
 * buffers and shader programs per run, the command processor, the 3D
 * pipeline (vertex stage, near-plane clipping, perspective-correct
 * rasterization with the top-left rule, depth test, culling, wireframe,
 * fragment stage, blending) and the shader machine. Shader programs are
 * checked like the kernel checks them, then compiled to a JavaScript
 * function per stage.
 *
 *   const gpu = FGPU.create(env);   gpu.syscall(requestAddress) -> BigInt
 *
 * env: { mem() -> { U8, U32 }, L, rd, wr, writeStr, ERR, OK, memSize,
 *        presentWindow(id, surface), presentScreen(surface, x, y),
 *        screen() -> { w, h } }
 */
(function (G) {
  'use strict';

  const FORMAT_XRGB = 1, FORMAT_DEPTH = 2;
  const SURFACE_SCANOUT = 2;
  const CLEAR_COLOR = 1, CLEAR_DEPTH = 2;
  const S_DEPTH_TEST = 1, S_DEPTH_WRITE = 2, S_CULL_BACK = 4, S_CULL_FRONT = 8, S_WIREFRAME = 16, S_BLEND = 32;
  const P_COLOR = 1, P_GOURAUD = 2, P_PHONG = 3;
  const VERTEX_P3N3C4 = 1, VERTEX_LAYOUT = 2;
  const MAX_ATTRIBS = 8, MAX_STRIDE = 64;
  const TEX_LINEAR = 1, TEX_CLAMP = 2, MAX_UNITS = 4;
  const MAX_SURFACE = 4096, MAX_BUFFER = 16 * 1024 * 1024, MAX_COMMAND = 1024 * 1024, MAX_PROGRAM = 64 * 1024;
  const MAX_SURFACES = 64, MAX_BUFFERS = 128, MAX_PROGRAMS = 64;
  const MAGIC = 0x4C534746, SHADER_VERSION = 1;
  const MAX_INSTR = 2048, MAX_TEMPS = 32, MAX_VARYINGS = 8, MAX_UNIFORMS = 64, MAX_CONSTANTS = 256;
  const FLAG_DISCARD = 1;
  const HEADER_WORDS = 16, IW = 5;
  const CAP_SHADERS = 1 << 6;
  const NEAR_EPS = 1e-5;
  const FIXED_VARS = 10;          // built-in programs: world xyz, normal xyz, color rgba
  const UNIFORM_FLOATS = 68;      // fgpu_uniforms_t
  // fgpu_uniforms_t offsets, in floats
  const U_MVP = 0, U_MODEL = 16, U_NORMAL = 32, U_LIGHT_DIR = 48, U_LIGHT_COLOR = 52, U_AMBIENT = 56, U_CAMERA = 60, U_MATERIAL = 64;

  // Shader opcodes (fgpu_abi.h) and which of a, b, c each one reads.
  const OP = { NOP: 0, MOV: 1, ADD: 2, SUB: 3, MUL: 4, DIV: 5, MAD: 6, MIN: 7, MAX: 8, DP2: 9, DP3: 10, DP4: 11, CROSS: 12,
    FLOOR: 13, FRACT: 14, SQRT: 15, RSQ: 16, EXP2: 17, LOG2: 18, POW: 19, SIN: 20, COS: 21, MIX: 22, CLAMP: 23, STEP: 24,
    SSTEP: 25, SLT: 26, SLE: 27, SEQ: 28, SNE: 29, SEL: 30, MOD: 31, SIGN: 32, ATAN2: 33, TEX: 34, KILL: 35, JMP: 36, JZ: 37, COUNT: 38 };
  const SOURCES = [0, 1, 3, 3, 3, 3, 7, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1, 1, 1, 3, 1, 1, 7, 7, 3, 7, 3, 3, 3, 3, 7, 3, 1, 3, 1, 1, 0, 1];
  const F_TEMP = 1, F_INPUT = 2, F_OUTPUT = 3, F_UNIFORM = 4, F_CONST = 5, F_SPECIAL = 6;
  const SRC_NEGATE = 1 << 20, SRC_ABS = 1 << 21;

  const clamp01 = (x) => x < 0 ? 0 : (x > 1 ? 1 : x);

  /* ------------------------------------------------------------ textures */

  const k255 = 1 / 255;
  function texel(t, x, y, out, o) {
    if (t.flags & TEX_CLAMP) {
      if (x < 0) x = 0; if (y < 0) y = 0;
      if (x >= t.width) x = t.width - 1; if (y >= t.height) y = t.height - 1;
    } else {
      x %= t.width; y %= t.height;
      if (x < 0) x += t.width; if (y < 0) y += t.height;
    }
    const p = t.pixels[y * t.pitch + x];
    out[o] = ((p >>> 16) & 255) * k255; out[o + 1] = ((p >>> 8) & 255) * k255;
    out[o + 2] = (p & 255) * k255; out[o + 3] = (p >>> 24) * k255;
  }
  const quad = new Float64Array(16);
  function sample(t, u, v, out) {
    if (!t || !t.pixels || !t.width || !t.height) { out[0] = out[1] = out[2] = 0; out[3] = 1; return; }
    if (!(Math.abs(u) < 65536)) u = 0;
    if (!(Math.abs(v) < 65536)) v = 0;
    let x = u * t.width, y = v * t.height;
    if (!(t.flags & TEX_LINEAR)) { texel(t, Math.floor(x), Math.floor(y), out, 0); return; }
    x -= 0.5; y -= 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), ax = x - x0, ay = y - y0;
    texel(t, x0, y0, quad, 0); texel(t, x0 + 1, y0, quad, 4);
    texel(t, x0, y0 + 1, quad, 8); texel(t, x0 + 1, y0 + 1, quad, 12);
    for (let i = 0; i < 4; i++) {
      const top = quad[i] + (quad[4 + i] - quad[i]) * ax;
      const bottom = quad[8 + i] + (quad[12 + i] - quad[8 + i]) * ax;
      out[i] = top + (bottom - top) * ay;
    }
  }

  /* ------------------------------------------------- shader programs */

  function checkSrc(h, w, fragment) {
    const file = w & 15, index = (w >>> 4) & 255;
    if (w & ~0x3FFFFF) return false;
    switch (file) {
      case F_TEMP: return index < h.temp_count;
      case F_INPUT: return fragment ? index < h.varying_count : index < MAX_ATTRIBS;
      case F_OUTPUT: return fragment ? index < 1 : index < 1 + h.varying_count;
      case F_UNIFORM: return index < MAX_UNIFORMS;
      case F_CONST: return index < h.const_count;
      case F_SPECIAL: return fragment && index < 2;
    }
    return false;
  }

  function checkStage(h, words, start, count, fragment) {
    for (let pc = 0; pc < count; pc++) {
      const at = start + pc * IW, op = words[at] & 255;
      if ((words[at] & ~255) || op >= OP.COUNT) return 'unknown opcode';
      if (op === OP.KILL && !fragment) return 'discard in vertex stage';
      if (op === OP.JMP || op === OP.JZ) {
        if (words[at + 1] <= pc || words[at + 1] > count) return 'bad jump target';
      } else if (op !== OP.NOP && op !== OP.KILL) {
        const d = words[at + 1], file = d & 15, index = (d >>> 4) & 255;
        if ((d & ~0xFFFF) || !((d >>> 12) & 15)) return 'bad destination';
        const ok = (file === F_TEMP && index < h.temp_count) || (file === F_OUTPUT && index < (fragment ? 1 : 1 + h.varying_count));
        if (!ok) return 'bad destination register';
      }
      for (let k = 0; k < 3; k++) if ((SOURCES[op] & (1 << k)) && !checkSrc(h, words[at + 2 + k], fragment)) return 'bad source register';
      if (op === OP.TEX && words[at + 3] >= MAX_UNITS) return 'bad texture unit';
    }
    return '';
  }

  // Turns one stage into a JavaScript function. Registers are Float64Arrays
  // of vec4s: I inputs, O outputs, T temps, U uniforms, C constants, S special.
  // X(unit, u, v, out) samples a texture. Returns false if the fragment is
  // discarded. Jumps only go forward, so a switch with fall-through cases runs it.
  function compileStage(words, start, count) {
    const FILE = { [F_TEMP]: 'T', [F_INPUT]: 'I', [F_OUTPUT]: 'O', [F_UNIFORM]: 'U', [F_CONST]: 'C', [F_SPECIAL]: 'S' };
    const src = (w, c) => {
      const k = ((w >>> 12) >>> (2 * c)) & 3;
      let e = FILE[w & 15] + '[' + (((w >>> 4) & 255) * 4 + k) + ']';
      if (w & SRC_ABS) e = 'Math.abs(' + e + ')';
      if (w & SRC_NEGATE) e = '(-' + e + ')';
      return e;
    };
    const lane = {
      [OP.MOV]: 'A', [OP.ADD]: 'A+B', [OP.SUB]: 'A-B', [OP.MUL]: 'A*B', [OP.DIV]: '(B!==0?A/B:0)', [OP.MAD]: 'A*B+C',
      [OP.MIN]: '(A<B?A:B)', [OP.MAX]: '(A>B?A:B)', [OP.FLOOR]: 'Math.floor(A)', [OP.FRACT]: '(A-Math.floor(A))',
      [OP.SQRT]: '(A>0?Math.sqrt(A):0)', [OP.RSQ]: '(A>0?1/Math.sqrt(A):0)', [OP.EXP2]: '(A>=-126?Math.pow(2,A<127?A:127):0)',
      [OP.LOG2]: '(A>0?Math.log2(A):-126)', [OP.POW]: '(A>0?Math.pow(A,B):(B===0?1:0))',
      [OP.SIN]: '(Math.abs(A)<1e7?Math.sin(A):0)', [OP.COS]: '(Math.abs(A)<1e7?Math.cos(A):1)', [OP.MIX]: '(A+(B-A)*C)',
      [OP.CLAMP]: 'Math.min(Math.max(A,B),C)', [OP.STEP]: '(B<A?0:1)', [OP.SSTEP]: '$smooth(A,B,C)',
      [OP.SLT]: '(A<B?1:0)', [OP.SLE]: '(A<=B?1:0)', [OP.SEQ]: '(A===B?1:0)', [OP.SNE]: '(A!==B?1:0)', [OP.SEL]: '(A!==0?B:C)',
      [OP.MOD]: '(B!==0?A-B*Math.floor(A/B):0)', [OP.SIGN]: '(A>0?1:(A<0?-1:0))', [OP.ATAN2]: 'Math.atan2(A,B)',
    };
    const out = ['let pc=0;for(;;){switch(pc){'];
    for (let pc = 0; pc < count; pc++) {
      const at = start + pc * IW, op = words[at], d = words[at + 1];
      const body = [];
      const used = SOURCES[op];
      for (let k = 0; k < 3; k++) if (used & (1 << k)) for (let c = 0; c < 4; c++) body.push('const ' + 'abc'[k] + c + '=' + src(words[at + 2 + k], c) + ';');
      const jump = (t) => t >= count ? 'return true;' : 'pc=' + t + ';continue;';
      if (op === OP.NOP) { /* nothing */ }
      else if (op === OP.JMP) body.push(jump(d));
      else if (op === OP.JZ) body.push('if(a0===0){' + jump(d) + '}');
      else if (op === OP.KILL) body.push('if(a0!==0)return false;');
      else {
        let r;
        if (op === OP.DP2 || op === OP.DP3 || op === OP.DP4) {
          const n = op === OP.DP2 ? 2 : op === OP.DP3 ? 3 : 4;
          const s = Array.from({ length: n }, (_, c) => 'a' + c + '*b' + c).join('+');
          body.push('const r0=' + s + ';');
          r = ['r0', 'r0', 'r0', 'r0'];
        } else if (op === OP.CROSS) {
          body.push('const r0=a1*b2-a2*b1,r1=a2*b0-a0*b2,r2=a0*b1-a1*b0;');
          r = ['r0', 'r1', 'r2', '0'];
        } else if (op === OP.TEX) {
          body.push('X(' + words[at + 3] + ',a0,a1,$t);');
          r = ['$t[0]', '$t[1]', '$t[2]', '$t[3]'];
        } else {
          const f = lane[op];
          r = [0, 1, 2, 3].map(c => f.replace(/[ABC]/g, (m) => ({ A: 'a', B: 'b', C: 'c' })[m] + c));
        }
        const D = ((d & 15) === F_OUTPUT ? 'O' : 'T'), base = ((d >>> 4) & 255) * 4, mask = (d >>> 12) & 15;
        // every source was read above, so writing in any order is safe
        const vals = [];
        for (let c = 0; c < 4; c++) if (mask & (1 << c)) vals.push('const w' + c + '=' + r[c] + ';');
        body.push(vals.join(''));
        for (let c = 0; c < 4; c++) if (mask & (1 << c)) body.push(D + '[' + (base + c) + ']=w' + c + ';');
      }
      out.push('case ' + pc + ':{' + body.join('') + '}');
    }
    out.push('}return true;}');
    const fn = new Function('$smooth', '$t', 'return function(I,O,T,U,C,S,X){' + out.join('\n') + '}');
    return fn(smooth, new Float64Array(4));
  }

  function smooth(e0, e1, x) {
    const d = e1 - e0;
    const t = d !== 0 ? clamp01((x - e0) / d) : (x < e0 ? 0 : 1);
    return t * t * (3 - 2 * t);
  }

  // Validates a program blob (Uint32Array) and compiles it. Returns
  // { program } or { why }.
  function makeProgram(words, bytes) {
    if (bytes < HEADER_WORDS * 4 || (bytes & 3)) return { why: 'too small' };
    const n = bytes / 4;
    const f = ['magic', 'version', 'size', 'flags', 'vs_offset', 'vs_count', 'fs_offset', 'fs_count', 'const_offset', 'const_count',
      'attrib_mask', 'varying_count', 'uniform_count', 'texture_mask', 'temp_count', 'reserved'];
    const h = {};
    f.forEach((k, i) => { h[k] = words[i]; });
    if (h.magic !== MAGIC || h.version !== SHADER_VERSION) return { why: 'not an FGSL program' };
    if (h.size !== bytes) return { why: 'size mismatch' };
    if (!h.vs_count || !h.fs_count || h.vs_count > MAX_INSTR || h.fs_count > MAX_INSTR) return { why: 'bad instruction count' };
    if (h.temp_count > MAX_TEMPS || h.varying_count > MAX_VARYINGS || h.uniform_count > MAX_UNIFORMS || h.const_count > MAX_CONSTANTS ||
        (h.attrib_mask >>> MAX_ATTRIBS) || (h.texture_mask >>> MAX_UNITS)) return { why: 'limits exceeded' };
    if (h.vs_offset < HEADER_WORDS || h.vs_offset > n || h.vs_count * IW > n - h.vs_offset ||
        h.fs_offset < HEADER_WORDS || h.fs_offset > n || h.fs_count * IW > n - h.fs_offset ||
        h.const_offset < HEADER_WORDS || h.const_offset > n || h.const_count * 4 > n - h.const_offset) return { why: 'section outside the program' };
    const why = checkStage(h, words, h.vs_offset, h.vs_count, false) || checkStage(h, words, h.fs_offset, h.fs_count, true);
    if (why) return { why };
    const consts = new Float64Array(new Float32Array(words.buffer, words.byteOffset + h.const_offset * 4, h.const_count * 4));
    return { program: { h, vs: compileStage(words, h.vs_offset, h.vs_count), fs: compileStage(words, h.fs_offset, h.fs_count), consts } };
  }

  /* ------------------------------------------------------------ raster */

  function defaultLayout() { return { stride: 10, count: 3, attrib: [3 << 16, 3 | (3 << 16), 6 | (4 << 16), 0, 0, 0, 0, 0] }; }
  function layoutValid(l) {
    if (!l || !l.stride || l.stride > MAX_STRIDE || l.count > MAX_ATTRIBS) return false;
    for (let i = 0; i < l.count; i++) { const off = l.attrib[i] & 0xFFFF, n = l.attrib[i] >>> 16; if (n > 4 || (n && off + n > l.stride)) return false; }
    return true;
  }
  function fetch(l, v, base, attr) {
    for (let i = 0; i < MAX_ATTRIBS; i++) {
      attr[i * 4] = attr[i * 4 + 1] = attr[i * 4 + 2] = 0; attr[i * 4 + 3] = 1;
      if (i >= l.count) continue;
      const off = l.attrib[i] & 0xFFFF, n = l.attrib[i] >>> 16;
      for (let k = 0; k < n; k++) attr[i * 4 + k] = v[base + off + k];
    }
  }

  function norm3(v, o) {
    const len = Math.sqrt(v[o] * v[o] + v[o + 1] * v[o + 1] + v[o + 2] * v[o + 2]);
    if (len > 1e-20) { v[o] /= len; v[o + 1] /= len; v[o + 2] /= len; }
  }
  function powi(x, n) { let r = 1; while (n > 0) { if (n & 1) r *= x; x *= x; n >>= 1; } return r; }

  const ln = new Float64Array(12);    // scratch: n, l, v, h
  // Built-in lighting: base * (ambient + light * diffuse) + light * specular.
  function light(u, nv, no, pos, po, base, bo, out, oo) {
    ln[0] = nv[no]; ln[1] = nv[no + 1]; ln[2] = nv[no + 2]; norm3(ln, 0);
    ln[3] = -u[U_LIGHT_DIR]; ln[4] = -u[U_LIGHT_DIR + 1]; ln[5] = -u[U_LIGHT_DIR + 2]; norm3(ln, 3);
    let diff = ln[0] * ln[3] + ln[1] * ln[4] + ln[2] * ln[5];
    if (diff < 0) diff = 0;
    let spec = 0;
    const strength = u[U_MATERIAL];
    if (strength > 0 && diff > 0) {
      ln[6] = u[U_CAMERA] - pos[po]; ln[7] = u[U_CAMERA + 1] - pos[po + 1]; ln[8] = u[U_CAMERA + 2] - pos[po + 2]; norm3(ln, 6);
      ln[9] = ln[3] + ln[6]; ln[10] = ln[4] + ln[7]; ln[11] = ln[5] + ln[8]; norm3(ln, 9);
      const nh = ln[0] * ln[9] + ln[1] * ln[10] + ln[2] * ln[11];
      let shin = Math.trunc(u[U_MATERIAL + 1]);
      if (shin < 1) shin = 1; if (shin > 128) shin = 128;
      if (nh > 0) spec = powi(nh, shin) * strength;
    }
    for (let i = 0; i < 3; i++) out[oo + i] = base[bo + i] * (u[U_AMBIENT + i] + u[U_LIGHT_COLOR + i] * diff) + u[U_LIGHT_COLOR + i] * spec;
    out[oo + 3] = base[bo + 3];
  }

  function mulVec(m, mo, x, y, z, w, out, oo) {
    for (let r = 0; r < 4; r++) out[oo + r] = m[mo + r] * x + m[mo + 4 + r] * y + m[mo + 8 + r] * z + m[mo + 12 + r] * w;
  }

  function packColor(c, o) {
    const r = (clamp01(c[o]) * 255 + 0.5) | 0, g = (clamp01(c[o + 1]) * 255 + 0.5) | 0, b = (clamp01(c[o + 2]) * 255 + 0.5) | 0;
    return (0xFF000000 | (r << 16) | (g << 8) | b) >>> 0;
  }
  const bl = new Float64Array(4);
  function blend(c, o, dst) {
    const a = clamp01(c[o + 3]);
    bl[0] = clamp01(c[o]) * a + ((dst >>> 16) & 255) * k255 * (1 - a);
    bl[1] = clamp01(c[o + 1]) * a + ((dst >>> 8) & 255) * k255 * (1 - a);
    bl[2] = clamp01(c[o + 2]) * a + (dst & 255) * k255 * (1 - a);
    bl[3] = 1;
    return packColor(bl, 0);
  }

  // One draw call's worth of scratch space and the pipeline it runs.
  class Raster {
    constructor() {
      this.attr = new Float64Array(MAX_ATTRIBS * 4);
      this.temps = new Float64Array(MAX_TEMPS * 4);
      this.vout = new Float64Array((1 + MAX_VARYINGS) * 4);
      this.fin = new Float64Array(MAX_VARYINGS * 4);
      this.fout = new Float64Array(4);
      this.special = new Float64Array(8);
      this.color = new Float64Array(4);
      this.var = new Float64Array(MAX_VARYINGS * 4);
      this.world = new Float64Array(4);
      this.wn = new Float64Array(4);
      this.texOut = new Float64Array(4);
    }

    // -> { clip: Float64Array(4), var: Float64Array(nvar) }
    vertex(p, layout, verts, base, nvar) {
      const v = { clip: new Float64Array(4), var: new Float64Array(nvar) };
      const a = this.attr;
      fetch(layout, verts, base, a);
      if (p.shader) {
        const O = this.vout, sh = p.shader;
        O.fill(0); O[3] = 1;
        this.temps.fill(0, 0, sh.h.temp_count * 4);
        sh.vs(a, O, this.temps, p.constants, sh.consts, this.special, this.sampler);
        for (let c = 0; c < 4; c++) v.clip[c] = O[c];
        for (let k = 0; k < nvar; k++) v.var[k] = O[4 + k];
        return v;
      }
      const u = p.u;
      mulVec(u, U_MVP, a[0], a[1], a[2], 1, v.clip, 0);
      mulVec(u, U_MODEL, a[0], a[1], a[2], 1, this.world, 0);
      mulVec(u, U_NORMAL, a[4], a[5], a[6], 0, this.wn, 0);
      v.var[0] = this.world[0]; v.var[1] = this.world[1]; v.var[2] = this.world[2];
      v.var[3] = this.wn[0]; v.var[4] = this.wn[1]; v.var[5] = this.wn[2];
      if (p.program === P_GOURAUD) light(u, this.wn, 0, this.world, 0, a, 8, v.var, 6);
      else { v.var[6] = a[8]; v.var[7] = a[9]; v.var[8] = a[10]; v.var[9] = a[11]; }
      return v;
    }

    // Fragment stage on this.var; result in this.color. False = discarded.
    shade(p, nvar) {
      const sh = p.shader;
      if (sh) {
        const I = this.fin, O = this.fout;
        for (let k = 0; k < nvar; k++) I[k] = this.var[k];
        O[0] = O[1] = O[2] = 0; O[3] = 1;
        this.temps.fill(0, 0, sh.h.temp_count * 4);
        if (!sh.fs(I, O, this.temps, p.constants, sh.consts, this.special, this.sampler)) return false;
        this.color.set(O);
        return true;
      }
      const v = this.var;
      if (p.program === P_PHONG) light(p.u, v, 3, v, 0, v, 6, this.color, 0);
      else { this.color[0] = v[6]; this.color[1] = v[7]; this.color[2] = v[8]; this.color[3] = v[9]; }
      return true;
    }

    triangle(t, p, nvar, a, b, c) {
      const edge = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      let area = edge(a.x, a.y, b.x, b.y, c.x, c.y);
      if (area === 0) return;
      // Screen y points down, so counter-clockwise in GL terms has area < 0.
      const front = area < 0;
      if ((p.state & S_CULL_BACK) && !front) return;
      if ((p.state & S_CULL_FRONT) && front) return;
      if (area < 0) { const tmp = b; b = c; c = tmp; area = -area; }

      const minx = Math.min(a.x, b.x, c.x), maxx = Math.max(a.x, b.x, c.x);
      const miny = Math.min(a.y, b.y, c.y), maxy = Math.max(a.y, b.y, c.y);
      const cx0 = Math.max(0, p.vp_x), cy0 = Math.max(0, p.vp_y);
      const cx1 = Math.min(p.vp_x + p.vp_w, t.width), cy1 = Math.min(p.vp_y + p.vp_h, t.height);
      const fx0 = Math.floor(minx), fx1 = Math.ceil(maxx), fy0 = Math.floor(miny), fy1 = Math.ceil(maxy);
      if (fx1 < cx0 || fy1 < cy0 || fx0 > cx1 || fy0 > cy1) return;
      const x0 = Math.max(fx0, cx0), y0 = Math.max(fy0, cy0), x1 = Math.min(fx1, cx1), y1 = Math.min(fy1, cy1);
      if (x0 >= x1 || y0 >= y1) return;

      const owns = (dx, dy) => dy < 0 || (dy === 0 && dx > 0);
      const own0 = owns(c.x - b.x, c.y - b.y), own1 = owns(a.x - c.x, a.y - c.y), own2 = owns(b.x - a.x, b.y - a.y);
      const inv = 1 / area;
      const depthTest = t.depth && (p.state & S_DEPTH_TEST);
      const depthWrite = t.depth && (p.state & S_DEPTH_WRITE);
      const blending = (p.state & S_BLEND) !== 0;
      const late = p.shader && (p.shader.h.flags & FLAG_DISCARD);
      const sp = this.special;
      sp[4] = sp[5] = sp[6] = sp[7] = front ? 1 : 0;

      const e0dx = -(c.y - b.y), e0dy = c.x - b.x;
      const e1dx = -(a.y - c.y), e1dy = a.x - c.x;
      const e2dx = -(b.y - a.y), e2dy = b.x - a.x;
      const px0 = x0 + 0.5, py0 = y0 + 0.5;
      let row0 = edge(b.x, b.y, c.x, c.y, px0, py0);
      let row1 = edge(c.x, c.y, a.x, a.y, px0, py0);
      let row2 = edge(a.x, a.y, b.x, b.y, px0, py0);
      const color = t.color, depth = t.depth, cp = t.colorPitch, dp = t.depthPitch;
      const av = a.var, bv = b.var, cv = c.var, v = this.var;

      for (let y = y0; y < y1; y++) {
        let w0 = row0, w1 = row1, w2 = row2;
        for (let x = x0; x < x1; x++, w0 += e0dx, w1 += e1dx, w2 += e2dx) {
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          if ((w0 === 0 && !own0) || (w1 === 0 && !own1) || (w2 === 0 && !own2)) continue;
          const l0 = w0 * inv, l1 = w1 * inv, l2 = w2 * inv;
          const z = l0 * a.z + l1 * b.z + l2 * c.z;
          const di = y * dp + x;
          if (depthTest && z >= depth[di]) continue;
          if (depthWrite && !late) depth[di] = z;
          if (!color && !late) continue;
          const iw = l0 * a.iw + l1 * b.iw + l2 * c.iw;
          const wpix = iw !== 0 ? 1 / iw : 0;
          for (let k = 0; k < nvar; k++) v[k] = (l0 * av[k] + l1 * bv[k] + l2 * cv[k]) * wpix;
          sp[0] = x + 0.5; sp[1] = y + 0.5; sp[2] = z; sp[3] = iw;
          if (!this.shade(p, nvar)) continue;
          if (depthWrite && late) depth[di] = z;
          if (!color) continue;
          const ci = y * cp + x;
          color[ci] = blending ? blend(this.color, 0, color[ci]) : packColor(this.color, 0);
        }
        row0 += e0dy; row1 += e1dy; row2 += e2dy;
      }
    }

    line(t, p, nvar, a, b) {
      if (!t.color) return;
      // One color per line: the fragment stage at the first end point.
      const iw = a.iw !== 0 ? 1 / a.iw : 0;
      for (let k = 0; k < nvar; k++) this.var[k] = a.var[k] * iw;
      const sp = this.special;
      sp[0] = a.x; sp[1] = a.y; sp[2] = a.z; sp[3] = a.iw; sp[4] = sp[5] = sp[6] = sp[7] = 1;
      if (!this.shade(p, nvar)) return;
      const blending = (p.state & S_BLEND) !== 0, packed = packColor(this.color, 0);
      let x0 = Math.trunc(a.x), y0 = Math.trunc(a.y);
      const x1 = Math.trunc(b.x), y1 = Math.trunc(b.y);
      const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let guard = 0; guard < 16384; guard++) {
        if (x0 >= p.vp_x && y0 >= p.vp_y && x0 < p.vp_x + p.vp_w && y0 < p.vp_y + p.vp_h && x0 >= 0 && y0 >= 0 && x0 < t.width && y0 < t.height) {
          const i = y0 * t.colorPitch + x0;
          t.color[i] = blending ? blend(this.color, 0, t.color[i]) : packed;
        }
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }

    draw(t, p, layout, verts, firstFloat, vertexCount, indices, firstIndex, count) {
      if (p.vp_w <= 0 || p.vp_h <= 0 || !layoutValid(layout)) return 0;
      const nvar = p.shader ? p.shader.h.varying_count * 4 : FIXED_VARS;
      this.sampler = (unit, u, v, out) => { sample(p.textures[unit], u, v, this.texOut); out[0] = this.texOut[0]; out[1] = this.texOut[1]; out[2] = this.texOut[2]; out[3] = this.texOut[3]; };
      let drawn = 0;
      const tri = [null, null, null];
      for (let i = 0; i + 2 < count; i += 3) {
        let bad = false;
        for (let k = 0; k < 3; k++) {
          const index = indices ? indices[firstIndex + i + k] : i + k;
          if (index >= vertexCount) { bad = true; break; }
          tri[k] = this.vertex(p, layout, verts, firstFloat + index * layout.stride, nvar);
        }
        if (bad) continue;
        const poly = clipNear(tri, nvar);
        if (poly.length < 3) continue;
        const s = poly.map(v => toScreen(p, v, nvar));
        if (p.state & S_WIREFRAME) for (let k = 0; k < s.length; k++) this.line(t, p, nvar, s[k], s[(k + 1) % s.length]);
        else for (let k = 1; k + 1 < s.length; k++) this.triangle(t, p, nvar, s[0], s[k], s[k + 1]);
        drawn++;
      }
      return drawn;
    }
  }

  // Keeps the part with z >= -w (in front of the near plane) and w > eps.
  function clipNear(tri, nvar) {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const a = tri[i], b = tri[(i + 1) % 3];
      const da = a.clip[2] + a.clip[3], db = b.clip[2] + b.clip[3];
      const ina = da >= 0 && a.clip[3] > NEAR_EPS, inb = db >= 0 && b.clip[3] > NEAR_EPS;
      if (ina) out.push(a);
      if (ina !== inb) {
        let t = da / (da - db);
        if (!(t >= 0)) t = 0;
        if (t > 1) t = 1;
        const m = { clip: new Float64Array(4), var: new Float64Array(nvar) };
        for (let k = 0; k < 4; k++) m.clip[k] = a.clip[k] + (b.clip[k] - a.clip[k]) * t;
        for (let k = 0; k < nvar; k++) m.var[k] = a.var[k] + (b.var[k] - a.var[k]) * t;
        if (!(m.clip[3] > NEAR_EPS)) m.clip[3] = NEAR_EPS * 2;
        out.push(m);
      }
    }
    return out;
  }

  function toScreen(p, v, nvar) {
    const iw = 1 / v.clip[3];
    let nx = v.clip[0] * iw, ny = v.clip[1] * iw;
    const nz = v.clip[2] * iw;
    if (!(nx < 1e6)) nx = 1e6; if (!(nx > -1e6)) nx = -1e6;
    if (!(ny < 1e6)) ny = 1e6; if (!(ny > -1e6)) ny = -1e6;
    const s = { x: p.vp_x + (nx * 0.5 + 0.5) * p.vp_w, y: p.vp_y + (1 - (ny * 0.5 + 0.5)) * p.vp_h, z: nz * 0.5 + 0.5, iw, var: new Float64Array(nvar) };
    for (let k = 0; k < nvar; k++) s.var[k] = v.var[k] * iw;
    return s;
  }

  function clear(t, flags, color, depth) {
    if ((flags & CLEAR_COLOR) && t.color) t.color.fill((color | 0xFF000000) >>> 0);
    if ((flags & CLEAR_DEPTH) && t.depth) t.depth.fill(depth);
  }

  /* ------------------------------------------------------- the device */

  function create(env) {
    const { L, rd, wr, ERR, OK } = env;
    const surfaces = new Map(), buffers = new Map(), programs = new Map();
    let nextId = 1;
    const raster = new Raster();
    const R = () => L.syscall_gpu_request_t;

    const inMem = (p, n) => p >= 0x1000 && n >= 0 && p + n <= env.memSize;
    const bytesAt = (p, n) => env.mem().U8.slice(p, p + n);
    const words = (p, n) => new Uint32Array(bytesAt(p, n).buffer);

    function target(st) {
      if (!st.color && !st.depth) return null;
      const w = st.color ? st.color.width : st.depth.width, h = st.color ? st.color.height : st.depth.height;
      if (st.depth && st.color && (st.depth.width < w || st.depth.height < h)) return null;
      return { width: w, height: h, color: st.color ? st.color.mem : null, colorPitch: st.color ? st.color.pitch : 0,
        depth: st.depth ? st.depth.mem : null, depthPitch: st.depth ? st.depth.pitch : 0 };
    }

    function execute(st, cmd) {
      const f32 = new Float32Array(cmd.buffer);
      let pos = 0;
      while (pos < cmd.length) {
        const op = cmd[pos] >>> 16, len = cmd[pos] & 0xFFFF;
        if (!len || pos + len > cmd.length) return ERR.INVAL;
        const a = pos + 1, n = len - 1;
        switch (op) {
          case 1: {                                    // BIND_TARGET
            if (n < 2) return ERR.INVAL;
            const c = cmd[a] ? surfaces.get(cmd[a]) : null, d = cmd[a + 1] ? surfaces.get(cmd[a + 1]) : null;
            if ((cmd[a] && (!c || c.format !== FORMAT_XRGB)) || (cmd[a + 1] && (!d || d.format !== FORMAT_DEPTH))) return ERR.NOTFOUND;
            st.color = c; st.depth = d;
            const any = c || d;
            if (any) { st.pipe.vp_x = 0; st.pipe.vp_y = 0; st.pipe.vp_w = any.width; st.pipe.vp_h = any.height; }
            break;
          }
          case 2:                                      // VIEWPORT
            if (n < 4) return ERR.INVAL;
            st.pipe.vp_x = cmd[a] | 0; st.pipe.vp_y = cmd[a + 1] | 0; st.pipe.vp_w = cmd[a + 2] | 0; st.pipe.vp_h = cmd[a + 3] | 0;
            if (st.pipe.vp_w < 0 || st.pipe.vp_h < 0 || st.pipe.vp_w > 8192 || st.pipe.vp_h > 8192) return ERR.INVAL;
            break;
          case 3: {                                    // CLEAR
            if (n < 3) return ERR.INVAL;
            const t = target(st);
            if (!t) return ERR.INVAL;
            clear(t, cmd[a], cmd[a + 1], f32[a + 2]);
            break;
          }
          case 4: if (n < 1) return ERR.INVAL; st.pipe.state = cmd[a]; break;
          case 5:
            if (n < 1 || cmd[a] < P_COLOR || cmd[a] > P_PHONG) return ERR.INVAL;
            st.pipe.program = cmd[a];
            break;
          case 6:                                      // SET_UNIFORMS
            if (n < UNIFORM_FLOATS) return ERR.INVAL;
            for (let i = 0; i < UNIFORM_FLOATS; i++) st.pipe.u[i] = f32[a + i];
            break;
          case 8: {                                    // SET_SHADER
            if (n < 1) return ERR.INVAL;
            if (!cmd[a]) { st.pipe.shader = null; break; }
            const sp = programs.get(cmd[a]);
            if (!sp) return ERR.NOTFOUND;
            st.pipe.shader = sp;
            break;
          }
          case 9: {                                    // SET_CONSTANTS
            if (n < 2) return ERR.INVAL;
            const first = cmd[a], count = cmd[a + 1];
            if (first > MAX_UNIFORMS || count > MAX_UNIFORMS - first || n - 2 < count * 4) return ERR.INVAL;
            for (let i = 0; i < count * 4; i++) st.pipe.constants[first * 4 + i] = f32[a + 2 + i];
            break;
          }
          case 10: {                                   // SET_VERTEX_LAYOUT
            if (n < 2 || cmd[a + 1] > MAX_ATTRIBS || n - 2 < cmd[a + 1]) return ERR.INVAL;
            const l = { stride: cmd[a], count: cmd[a + 1], attrib: [0, 0, 0, 0, 0, 0, 0, 0] };
            for (let i = 0; i < l.count; i++) l.attrib[i] = cmd[a + 2 + i];
            if (!layoutValid(l)) return ERR.INVAL;
            st.layout = l;
            break;
          }
          case 11: {                                   // BIND_TEXTURE
            if (n < 3 || cmd[a] >= MAX_UNITS) return ERR.INVAL;
            st.pipe.textures[cmd[a]] = null;
            if (!cmd[a + 1]) break;
            const s = surfaces.get(cmd[a + 1]);
            if (!s || s.format !== FORMAT_XRGB) return ERR.NOTFOUND;
            st.pipe.textures[cmd[a]] = { pixels: s.mem, width: s.width, height: s.height, pitch: s.pitch, flags: cmd[a + 2] & (TEX_LINEAR | TEX_CLAMP) };
            break;
          }
          case 7: {                                    // DRAW
            if (n < 7) return ERR.INVAL;
            const vbId = cmd[a], format = cmd[a + 1], firstVertex = cmd[a + 2], vertexCount = cmd[a + 3];
            const ibId = cmd[a + 4], firstIndex = cmd[a + 5], indexCount = cmd[a + 6];
            let layout;
            if (format === VERTEX_P3N3C4) layout = defaultLayout();
            else if (format === VERTEX_LAYOUT) layout = st.layout;
            else return ERR.INVAL;
            const vb = buffers.get(vbId);
            if (!vb) return ERR.NOTFOUND;
            const total = Math.floor(vb.size / (layout.stride * 4));
            if (firstVertex > total) return ERR.INVAL;
            const avail = total - firstVertex;
            const t = target(st);
            if (!t) return ERR.INVAL;
            if (!st.pipe.program) st.pipe.program = P_COLOR;
            if (ibId) {
              const ib = buffers.get(ibId);
              if (!ib) return ERR.NOTFOUND;
              const icount = Math.floor(ib.size / 4);
              if (firstIndex > icount || indexCount > icount - firstIndex) return ERR.INVAL;
              st.triangles += raster.draw(t, st.pipe, layout, vb.f32, firstVertex * layout.stride, avail, ib.u32, firstIndex, indexCount);
            } else {
              st.triangles += raster.draw(t, st.pipe, layout, vb.f32, firstVertex * layout.stride, avail, null, 0, Math.min(vertexCount, avail));
            }
            break;
          }
          default: return ERR.INVAL;
        }
        pos += len;
      }
      return OK;
    }

    function info(r) {
      const I = L.syscall_gpu_info_t, out = rd(r, R().out);
      if (!out || !inMem(out, I.$size) || rd(out, I.size) !== I.$size) return ERR.INVAL;
      env.mem().U8.fill(0, out, out + I.$size);
      wr(out, I.size, I.$size); wr(out, I.version, 2);
      env.writeStr(out + I.name.off, 'Studio preview', 64);
      env.writeStr(out + I.family.off, 'Browser', 40);
      env.writeStr(out + I.driver.off, 'studio', 16);
      env.writeStr(out + I.backend.off, 'cpu (FGPU in JavaScript, shaders)', 32);
      wr(out, I.caps, CAP_SHADERS);
      const sc = env.screen();
      wr(out, I.screen_width, sc.w); wr(out, I.screen_height, sc.h);
      return OK;
    }

    function slot(map, max) { return map.size < max; }

    function syscall(r) {
      const Q = R();
      if (!r || !inMem(r, Q.$size) || rd(r, Q.size) !== Q.$size) return ERR.INVAL;
      const version = rd(r, Q.version);
      if (version < 1 || version > 2) return ERR.INVAL;
      const op = rd(r, Q.op), handle = rd(r, Q.handle);
      switch (op) {
        case 1: return info(r);
        case 2: {                                      // CREATE_SURFACE
          const w = rd(r, Q.width), h = rd(r, Q.height), format = rd(r, Q.format), flags = rd(r, Q.flags);
          if (!w || !h || w > MAX_SURFACE || h > MAX_SURFACE || (format !== FORMAT_XRGB && format !== FORMAT_DEPTH)) return ERR.INVAL;
          if (flags & SURFACE_SCANOUT) return ERR.INVAL;         // no page flipping in the preview
          if (!slot(surfaces, MAX_SURFACES)) return ERR.GENERIC;
          const id = nextId++;
          surfaces.set(id, { id, width: w, height: h, format, flags, pitch: w, mem: format === FORMAT_XRGB ? new Uint32Array(w * h) : new Float32Array(w * h) });
          wr(r, Q.handle, id);
          return OK;
        }
        case 3: return surfaces.delete(handle) ? OK : ERR.NOTFOUND;
        case 4: {                                      // CREATE_BUFFER
          const bytes = rd(r, Q.bytes);
          if (!bytes || bytes > MAX_BUFFER) return ERR.INVAL;
          if (!slot(buffers, MAX_BUFFERS)) return ERR.GENERIC;
          const id = nextId++, ab = new ArrayBuffer(Math.ceil(bytes / 4) * 4);
          buffers.set(id, { id, size: bytes, u8: new Uint8Array(ab), f32: new Float32Array(ab), u32: new Uint32Array(ab) });
          wr(r, Q.handle, id);
          return OK;
        }
        case 5: {                                      // UPLOAD_BUFFER
          const b = buffers.get(handle);
          if (!b) return ERR.NOTFOUND;
          const data = rd(r, Q.data), offset = rd(r, Q.offset), bytes = rd(r, Q.bytes);
          if (!data || offset > b.size || bytes > b.size - offset || !inMem(data, bytes)) return ERR.INVAL;
          b.u8.set(env.mem().U8.subarray(data, data + bytes), offset);
          return OK;
        }
        case 6: return buffers.delete(handle) ? OK : ERR.NOTFOUND;
        case 7: {                                      // SUBMIT
          const data = rd(r, Q.data), bytes = rd(r, Q.bytes);
          if (!data || bytes < 4 || bytes > MAX_COMMAND || (bytes & 3) || !inMem(data, bytes)) return ERR.INVAL;
          const st = {
            color: null, depth: null, layout: defaultLayout(), triangles: 0,
            pipe: { vp_x: 0, vp_y: 0, vp_w: 0, vp_h: 0, state: 0, program: P_COLOR, u: new Float64Array(UNIFORM_FLOATS),
              shader: null, constants: new Float64Array(MAX_UNIFORMS * 4), textures: [null, null, null, null] },
          };
          const res = execute(st, words(data, bytes));
          wr(r, Q.handle, st.triangles);
          return res;
        }
        case 8: {                                      // READBACK
          const s = surfaces.get(handle);
          if (!s) return ERR.NOTFOUND;
          const out = rd(r, Q.out), pitch = rd(r, Q.pitch), row = s.width * 4;
          if (!out || pitch < row || !inMem(out, pitch * (s.height - 1) + row)) return ERR.INVAL;
          const U8 = env.mem().U8, bytes = new Uint8Array(s.mem.buffer);
          for (let y = 0; y < s.height; y++) U8.set(bytes.subarray(y * s.pitch * 4, y * s.pitch * 4 + row), out + y * pitch);
          return OK;
        }
        case 9: {                                      // PRESENT
          const s = surfaces.get(handle);
          if (!s || s.format !== FORMAT_XRGB) return ERR.NOTFOUND;
          const win = rd(r, Q.window_id);
          if (win) return env.presentWindow(win, s);
          return env.presentScreen(s, rd(r, Q.x), rd(r, Q.y));
        }
        case 10: return OK;                            // RELEASE_DISPLAY: nothing is ever flipped
        case 11: {                                     // CREATE_PROGRAM
          if (version < 2) return ERR.INVAL;
          const data = rd(r, Q.data), bytes = rd(r, Q.bytes);
          if (!data || bytes < HEADER_WORDS * 4 || bytes > MAX_PROGRAM || (bytes & 3) || !inMem(data, bytes)) return ERR.INVAL;
          if (!slot(programs, MAX_PROGRAMS)) return ERR.GENERIC;
          const made = makeProgram(words(data, bytes), bytes);
          if (!made.program) { env.log && env.log('fgpu: shader program rejected: ' + made.why); return ERR.INVAL; }
          const id = nextId++;
          programs.set(id, made.program);
          wr(r, Q.handle, id);
          return OK;
        }
        case 12: return programs.delete(handle) ? OK : ERR.NOTFOUND;
        case 13: {                                     // WRITE_SURFACE
          const s = surfaces.get(handle);
          if (!s) return ERR.NOTFOUND;
          const data = rd(r, Q.data), pitch = rd(r, Q.pitch), row = s.width * 4;
          if (!data || pitch < row || !inMem(data, pitch * (s.height - 1) + row)) return ERR.INVAL;
          const U8 = env.mem().U8, bytes = new Uint8Array(s.mem.buffer);
          for (let y = 0; y < s.height; y++) bytes.set(U8.subarray(data + y * pitch, data + y * pitch + row), y * s.pitch * 4);
          return OK;
        }
      }
      return ERR.INVAL;
    }

    return { syscall };
  }

  G.FGPU = { create, makeProgram, Raster };
})(typeof self !== 'undefined' ? self : globalThis);
