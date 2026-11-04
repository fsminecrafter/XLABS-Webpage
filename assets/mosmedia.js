// Decoders for Minimal-OS media: .img pictures, .vid videos (tiles and
// motion codecs) and .adi sound.
// A port of tools/media/mosplayer.py in fsminecrafter/Minimal-OS; the
// formats are described in that repo's docs/media.md and docs/audio.md.
// Pixels are 0xAARRGGBB in a Uint32Array, as in mosmedia.h.
(function (root) {
  'use strict';
  var MAX_SIDE = 16384, MAX_PIXELS = 64 * 1024 * 1024, MAX_PCM = 512 * 1024 * 1024;
  var IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
  var IMA_STEP = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37,
    41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173,
    190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
    724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
    6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289,
    16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];

  function fail(msg) { throw new Error(msg); }
  function u32(d, at) { return (d[at] | d[at + 1] << 8 | d[at + 2] << 16 | d[at + 3] << 24) >>> 0; }
  // 64-bit offsets: files over 2^53 bytes are not a concern here
  function u64(d, at) { return u32(d, at) + u32(d, at + 4) * 4294967296; }
  function tag(d) { return String.fromCharCode(d[0], d[1], d[2], d[3]); }

  function checkSize(w, h) {
    if (!(w > 0 && w <= MAX_SIDE && h > 0 && h <= MAX_SIDE)) fail('invalid picture size: ' + w + ' x ' + h);
    if (w * h > MAX_PIXELS) fail('picture is too large to show: ' + w + ' x ' + h);
  }

  function hash(v) { return (((v >>> 16) & 255) * 3 + ((v >>> 8) & 255) * 5 + (v & 255) * 7 + (v >>> 24) * 11) & 63; }
  // per-byte addition modulo 256
  function add(a, b) {
    return ((((a & 0x00FF00FF) + (b & 0x00FF00FF)) & 0x00FF00FF) |
            (((a & 0xFF00FF00) + (b & 0xFF00FF00)) & 0xFF00FF00)) >>> 0;
  }

  // Decodes the tile in d[pos..end) into px (width w, height h) at tile (tx, ty).
  function decodeTile(d, pos, end, w, h, px, tx, ty, hasPrev) {
    var x0 = tx * 64, y0 = ty * 64, tw = Math.min(64, w - x0), th = Math.min(64, h - y0);
    if (tw <= 0 || th <= 0) fail('tile is outside the picture');
    var filters = pos;
    pos += (th + 3) >> 2;
    if (pos > end) fail('truncated tile filters');
    var index = new Uint32Array(64), prev = 0, run = 0;
    for (var y = 0; y < th; y++) {
      var filt = (d[filters + (y >> 2)] >> ((y & 3) * 2)) & 3;
      if (filt > 2 || (filt === 1 && y === 0) || (filt === 2 && !hasPrev)) fail('invalid tile row filter');
      var row = (y0 + y) * w + x0;
      for (var x = 0; x < tw; x++) {
        if (run) run--;
        else {
          if (pos >= end) fail('truncated tile pixels');
          var op = d[pos++], r, g, b;
          if (op === 0xFE) {
            if (pos + 3 > end) fail('truncated RGB pixel');
            prev = ((prev & 0xFF000000) | d[pos] << 16 | d[pos + 1] << 8 | d[pos + 2]) >>> 0;
            pos += 3;
            index[hash(prev)] = prev;
          } else if (op === 0xFF) {
            if (pos + 4 > end) fail('truncated RGBA pixel');
            prev = (d[pos + 3] << 24 | d[pos] << 16 | d[pos + 1] << 8 | d[pos + 2]) >>> 0;
            pos += 4;
            index[hash(prev)] = prev;
          } else if (op < 0x40) {
            prev = index[op];
          } else if (op < 0x80) {
            r = ((prev >>> 16) + ((op >> 4) & 3) - 2) & 255;
            g = ((prev >>> 8) + ((op >> 2) & 3) - 2) & 255;
            b = (prev + (op & 3) - 2) & 255;
            prev = ((prev & 0xFF000000) | r << 16 | g << 8 | b) >>> 0;
            index[hash(prev)] = prev;
          } else if (op < 0xC0) {
            if (pos >= end) fail('truncated luma pixel');
            var op2 = d[pos++], dg = (op & 63) - 32;
            r = ((prev >>> 16) + dg + (op2 >> 4) - 8) & 255;
            g = ((prev >>> 8) + dg) & 255;
            b = (prev + dg + (op2 & 15) - 8) & 255;
            prev = ((prev & 0xFF000000) | r << 16 | g << 8 | b) >>> 0;
            index[hash(prev)] = prev;
          } else {
            run = op & 63;
          }
        }
        var i = row + x;
        px[i] = add(prev, filt === 0 ? 0xFF000000 : filt === 1 ? px[i - w] : px[i]);
      }
    }
    if (run) fail('tile run is longer than the tile');
  }

  // .img -> { kind, width, height, channels, pixels }
  function decodeImg(d) {
    if (d.length < 32 || tag(d) !== 'MIMG' || d[4] !== 1 || (d[5] !== 3 && d[5] !== 4) || d[6] !== 6)
      fail('not a supported .img file');
    var w = u32(d, 8), h = u32(d, 12);
    checkSize(w, h);
    var across = Math.ceil(w / 64), tiles = across * Math.ceil(h / 64);
    if (u32(d, 16) !== tiles || 24 + (tiles + 1) * 4 > d.length) fail('invalid .img tile table');
    var payload = 24 + (tiles + 1) * 4, size = d.length - payload;
    var px = new Uint32Array(w * h);
    for (var t = 0; t < tiles; t++) {
      var start = u32(d, 24 + t * 4), end = u32(d, 28 + t * 4);
      if (start > end || end > size) fail('invalid offsets for .img tile ' + t);
      decodeTile(d, payload + start, payload + end, w, h, px, t % across, (t / across) | 0, false);
    }
    return { kind: 'img', width: w, height: h, channels: d[5], pixels: px };
  }

  // ---- The "motion" .vid codec (Minimal-OS-SDK/include/mosmedia_motion.h)
  // A bit-exact port of the decoder in mosplayer.py: YCbCr 4:2:0, 16x16
  // macroblocks, intra or motion-compensated prediction, H.264's 4x4
  // transform, deblocking and an LZMA-style binary range coder.
  var MMC_ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
  var MMC_V = [[10, 16, 13], [11, 18, 14], [13, 20, 16], [14, 23, 18], [16, 25, 20], [18, 29, 23]];
  var MMC_CLASS = [];
  for (var ci = 0; ci < 16; ci++)
    MMC_CLASS.push(!((ci >> 2) & 1) && !(ci & 1) ? 0 : ((ci >> 2) & 1) && (ci & 1) ? 1 : 2);
  var MMC_CHROMA_QP = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    26, 27, 28, 29, 29, 30, 31, 32, 32, 33, 34, 34, 35, 35, 36, 36, 37, 37, 37, 38, 38, 38, 39, 39, 39, 39];
  var MMC_ALPHA = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 5, 6, 7, 8, 9, 10, 12, 13,
    15, 17, 20, 22, 25, 28, 32, 36, 40, 45, 50, 56, 63, 71, 80, 90, 101, 113, 127, 144, 162, 182, 203, 226, 255, 255];
  var MMC_BETA = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4,
    6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16, 17, 17, 18, 18];
  var MMC_TC0 = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 6, 6, 7, 8, 9, 10, 13];
  var MMC_UBINS = 14, MMC_MV_MAX = 16383;

  function clip(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  function probs(n) { var p = new Uint16Array(n); p.fill(1024); return p; }

  function RangeDecoder(d) {
    this.d = d; this.pos = 0; this.range = 0xFFFFFFFF; this.code = 0; this.over = 0;
    for (var i = 0; i < 5; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
  }
  RangeDecoder.prototype.byte = function () {
    if (this.pos < this.d.length) return this.d[this.pos++];
    this.over++;
    return 0;
  };
  RangeDecoder.prototype.bit = function (p, i) {
    var v = p[i], bound = (this.range >>> 11) * v, b;
    if (this.code < bound) { this.range = bound; p[i] = v + ((2048 - v) >> 5); b = 0; }
    else { this.code -= bound; this.range -= bound; p[i] = v - (v >> 5); b = 1; }
    while (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
    return b;
  };
  RangeDecoder.prototype.direct = function () {
    this.range >>>= 1;
    var b = 0;
    if (this.code >= this.range) { this.code -= this.range; b = 1; }
    while (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
    return b;
  };
  RangeDecoder.prototype.eg = function () {
    var n = 0;
    while (this.direct()) if (++n > 24) { this.over += 1000; return 0; }
    var v = 1;
    for (var i = 0; i < n; i++) v = v * 2 + this.direct();
    return v - 1;
  };
  RangeDecoder.prototype.uint = function (p, at) {
    var i = 0;
    while (i < MMC_UBINS && this.bit(p, at + i)) i++;
    return i < MMC_UBINS ? i : MMC_UBINS + this.eg();
  };

  function MotionDecoder(width, height) {
    this.w = (width + 15) & ~15; this.h = (height + 15) & ~15;
    this.mbw = this.w >> 4; this.mbh = this.h >> 4;
    this.cw = this.w >> 1; this.ch = this.h >> 1;
    var sy = this.w * this.h, sc = this.cw * this.ch, mbs = this.mbw * this.mbh;
    this.cur = [new Uint8Array(sy), new Uint8Array(sc), new Uint8Array(sc)];
    this.ref = [new Uint8Array(sy), new Uint8Array(sc), new Uint8Array(sc)];
    this.nzY = new Uint8Array(sy >> 4);
    this.mode = new Uint8Array(sy >> 4);
    this.nzC = [new Uint8Array(sc >> 4), new Uint8Array(sc >> 4)];
    this.mbIntra = new Uint8Array(mbs);
    this.mbSkip = new Uint8Array(mbs);
    this.mv = new Int32Array(mbs * 2);
    this.qp = 26;
    this.z = new Int32Array(16);
    this.t = new Int32Array(16);
    this.above = new Int32Array(16);
    this.left = new Int32Array(16);
  }

  // Predicts an n x n block from the pixels above and to its left, in place
  MotionDecoder.prototype.intra = function (plane, stride, x, y, n, mode) {
    var ha = y > 0, hl = x > 0, above = this.above, left = this.left, i, j, sa = 0, sl = 0;
    for (i = 0; i < n; i++) {
      above[i] = ha ? plane[(y - 1) * stride + x + i] : 128; sa += above[i];
      left[i] = hl ? plane[(y + i) * stride + x - 1] : 128; sl += left[i];
    }
    var corner = ha && hl ? plane[(y - 1) * stride + x - 1] : 128;
    var shift = n === 4 ? 2 : 3, dc = 128;
    if (ha && hl) dc = (sa + sl + n) >> (shift + 1);
    else if (ha || hl) dc = ((ha ? sa : sl) + (n >> 1)) >> shift;
    for (j = 0; j < n; j++) {
      var at = (y + j) * stride + x;
      for (i = 0; i < n; i++)
        plane[at + i] = mode === 0 ? dc : mode === 1 ? above[i] : mode === 2 ? left[j] : clip(left[j] + above[i] - corner);
    }
  };

  // Copies an n x n block moved by (mvx, mvy) in 1/2^frac pixels from ref into cur (bilinear, edges repeated)
  MotionDecoder.prototype.mc = function (ref, cur, pw, ph, x, y, n, mvx, mvy, frac) {
    var one = 1 << frac, ix0 = x + (mvx >> frac), iy0 = y + (mvy >> frac);
    var fx = mvx & (one - 1), fy = mvy & (one - 1);
    var w00 = (one - fx) * (one - fy), w01 = fx * (one - fy), w10 = (one - fx) * fy, w11 = fx * fy;
    var sh = 2 * frac, rnd = 1 << (sh - 1), maxx = pw - 1, maxy = ph - 1;
    for (var j = 0; j < n; j++) {
      var yy = iy0 + j, r0 = (yy < 0 ? 0 : yy > maxy ? maxy : yy) * pw;
      yy++;
      var r1 = (yy < 0 ? 0 : yy > maxy ? maxy : yy) * pw, out = (y + j) * pw + x;
      for (var i = 0; i < n; i++) {
        var a = ix0 + i, b = a + 1;
        a = a < 0 ? 0 : a > maxx ? maxx : a;
        if (!fx && !fy) { cur[out + i] = ref[r0 + a]; continue; }
        b = b < 0 ? 0 : b > maxx ? maxx : b;
        cur[out + i] = (w00 * ref[r0 + a] + w01 * ref[r0 + b] + w10 * ref[r1 + a] + w11 * ref[r1 + b] + rnd) >> sh;
      }
    }
  };

  // Dequantizes this.z, runs the inverse 4x4 transform and adds it to the plane
  MotionDecoder.prototype.residual = function (qp, plane, at, stride) {
    var z = this.z, t = this.t, scale = 1 << ((qp / 6) | 0), rowV = MMC_V[qp % 6], i, v;
    var d0, d1, d2, d3, e0, e1, e2, e3;
    for (i = 0; i < 16; i++) {
      v = z[i] ? z[i] * rowV[MMC_CLASS[i]] * scale : 0;
      t[i] = v < -1048576 ? -1048576 : v > 1048576 ? 1048576 : v;
    }
    for (i = 0; i < 4; i++) {
      d0 = t[i * 4]; d1 = t[i * 4 + 1]; d2 = t[i * 4 + 2]; d3 = t[i * 4 + 3];
      e0 = d0 + d2; e1 = d0 - d2; e2 = (d1 >> 1) - d3; e3 = d1 + (d3 >> 1);
      t[i * 4] = e0 + e3; t[i * 4 + 1] = e1 + e2; t[i * 4 + 2] = e1 - e2; t[i * 4 + 3] = e0 - e3;
    }
    for (i = 0; i < 4; i++) {
      d0 = t[i]; d1 = t[4 + i]; d2 = t[8 + i]; d3 = t[12 + i];
      e0 = d0 + d2; e1 = d0 - d2; e2 = (d1 >> 1) - d3; e3 = d1 + (d3 >> 1);
      var q = at + i;
      plane[q] = clip(plane[q] + ((e0 + e3 + 32) >> 6)); q += stride;
      plane[q] = clip(plane[q] + ((e1 + e2 + 32) >> 6)); q += stride;
      plane[q] = clip(plane[q] + ((e1 - e2 + 32) >> 6)); q += stride;
      plane[q] = clip(plane[q] + ((e0 - e3 + 32) >> 6));
    }
  };

  // The predicted vector: the median of the left, above and above-right macroblocks'
  MotionDecoder.prototype.mvp = function (mx, my, out) {
    var w = this.mbw, mv = this.mv, intra = this.mbIntra, ax = 0, ay = 0, bx = 0, by = 0, cx = 0, cy = 0;
    if (mx > 0) { var i = my * w + mx - 1; if (!intra[i]) { ax = mv[i * 2]; ay = mv[i * 2 + 1]; } }
    if (my === 0) { out[0] = ax; out[1] = ay; return; }
    var bi = (my - 1) * w + mx;
    if (!intra[bi]) { bx = mv[bi * 2]; by = mv[bi * 2 + 1]; }
    var c = mx + 1 < w ? bi + 1 : mx > 0 ? bi - 1 : bi;
    if (c !== bi && !intra[c]) { cx = mv[c * 2]; cy = mv[c * 2 + 1]; }
    out[0] = median(ax, bx, cx); out[1] = median(ay, by, cy);
  };
  function median(a, b, c) {
    var lo = Math.min(a, b), hi = Math.max(a, b);
    return c < lo ? lo : c > hi ? hi : c;
  }

  // Reads one block's coefficients into this.z; false when the block has none
  MotionDecoder.prototype.coeffs = function (d, c, typ, ctx) {
    if (!d.bit(c.cbf, typ * 3 + ctx)) return false;
    var z = this.z, pos = this.pos || (this.pos = new Int32Array(16)), np = 0, last = 15, i;
    z.fill(0);
    for (i = 0; i < 15; i++) {
      if (d.bit(c.sig, typ * 15 + i)) {
        pos[np++] = i;
        if (d.bit(c.last, typ * 15 + i)) { last = i; break; }
      }
    }
    if (last === 15) pos[np++] = 15;
    var gt1 = 0, eq1 = 0;
    for (var k = np - 1; k >= 0; k--) {
      var inc = gt1 ? 0 : Math.min(eq1 + 1, 4), a = 1;
      if (d.bit(c.gt1, typ * 5 + inc)) { a = Math.min(2 + d.uint(c.lev, typ * MMC_UBINS), 65535); gt1++; }
      else eq1++;
      z[MMC_ZIGZAG[pos[k]]] = d.direct() ? -a : a;
    }
    return true;
  };

  MotionDecoder.prototype.mvd = function (d, c, k) {
    if (!d.bit(c.mvZero, k)) return 0;
    var s = d.direct(), a = Math.min(1 + d.uint(c.mvBins, k * MMC_UBINS), MMC_MV_MAX * 2);
    return s ? -a : a;
  };

  MotionDecoder.prototype.luma = function (d, c, mx, my, k, qp) {
    var bw = this.w >> 2, bx = mx * 4 + (k & 3), by = my * 4 + (k >> 2), nz = this.nzY;
    var ctx = (bx > 0 && nz[by * bw + bx - 1] ? 1 : 0) + (by > 0 && nz[(by - 1) * bw + bx] ? 1 : 0);
    var has = this.coeffs(d, c, 0, ctx);
    nz[by * bw + bx] = has ? 1 : 0;
    if (has) this.residual(qp, this.cur[0], by * 4 * this.w + bx * 4, this.w);
  };

  MotionDecoder.prototype.chroma = function (d, c, mx, my) {
    var qpc = MMC_CHROMA_QP[this.qp], cw = this.cw, cbw = this.w >> 3;
    for (var pl = 0; pl < 2; pl++) {
      var plane = this.cur[1 + pl], nz = this.nzC[pl];
      for (var k = 0; k < 4; k++) {
        var bx = mx * 2 + (k & 1), by = my * 2 + (k >> 1);
        var ctx = (bx > 0 && nz[by * cbw + bx - 1] ? 1 : 0) + (by > 0 && nz[(by - 1) * cbw + bx] ? 1 : 0);
        var has = this.coeffs(d, c, 1, ctx);
        nz[by * cbw + bx] = has ? 1 : 0;
        if (has) this.residual(qpc, plane, by * 4 * cw + bx * 4, cw);
      }
    }
  };

  // Decodes one range-coded frame; the result is in this.ref afterwards
  MotionDecoder.prototype.decode = function (data, key, qp) {
    if (!(qp >= 0 && qp <= 51)) fail('invalid motion frame QP');
    this.qp = qp;
    var d = new RangeDecoder(data);
    var c = { skip: probs(3), intra: probs(3), mpm: probs(1), rem: probs(2), cmode: probs(3), mvZero: probs(2),
      mvBins: probs(2 * MMC_UBINS), cbf: probs(6), sig: probs(30), last: probs(30), gt1: probs(10), lev: probs(2 * MMC_UBINS) };
    var w = this.w, cw = this.cw, bw = w >> 2, cbw = w >> 3, mbw = this.mbw;
    var Y = this.cur[0], U = this.cur[1], V = this.cur[2], ref = this.ref;
    var skipA = this.mbSkip, intraA = this.mbIntra, modeA = this.mode, mv = this.mv;
    var modes = new Uint8Array(16), p = new Int32Array(2), k, i;
    for (var my = 0; my < this.mbh; my++) {
      for (var mx = 0; mx < mbw; mx++) {
        var mb = my * mbw + mx;
        var nskip = (mx > 0 && skipA[mb - 1] ? 1 : 0) + (my > 0 && skipA[mb - mbw] ? 1 : 0);
        var nintra = (mx > 0 && intraA[mb - 1] ? 1 : 0) + (my > 0 && intraA[mb - mbw] ? 1 : 0);
        var skip = !key && d.bit(c.skip, nskip) === 1;
        var intra = key || (!skip && d.bit(c.intra, nintra) === 1);
        skipA[mb] = skip ? 1 : 0; intraA[mb] = intra ? 1 : 0;
        if (intra) {
          mv[mb * 2] = mv[mb * 2 + 1] = 0;
          for (k = 0; k < 16; k++) {
            var bx = mx * 4 + (k & 3), by = my * 4 + (k >> 2);
            var ma = bx > 0 ? modeA[by * bw + bx - 1] : 0, mbm = by > 0 ? modeA[(by - 1) * bw + bx] : 0;
            var mpm = Math.min(ma, mbm), mode = mpm;
            if (d.bit(c.mpm, 0)) {
              var rem = d.bit(c.rem, 0) ? 1 + d.bit(c.rem, 1) : 0;
              mode = rem < mpm ? rem : rem + 1;
            }
            modeA[by * bw + bx] = mode;
            modes[k] = mode;
          }
          var b0 = d.bit(c.cmode, 0), cmode = b0 * 2 + d.bit(c.cmode, 1 + b0);
          for (k = 0; k < 16; k++) {
            this.intra(Y, w, (mx * 4 + (k & 3)) * 4, (my * 4 + (k >> 2)) * 4, 4, modes[k]);
            this.luma(d, c, mx, my, k, qp);
          }
          this.intra(U, cw, mx * 8, my * 8, 8, cmode);
          this.intra(V, cw, mx * 8, my * 8, 8, cmode);
          this.chroma(d, c, mx, my);
        } else {
          this.mvp(mx, my, p);
          var px = p[0], py = p[1];
          if (!skip) {
            px = Math.min(Math.max(px + this.mvd(d, c, 0), -MMC_MV_MAX), MMC_MV_MAX);
            py = Math.min(Math.max(py + this.mvd(d, c, 1), -MMC_MV_MAX), MMC_MV_MAX);
          }
          mv[mb * 2] = px; mv[mb * 2 + 1] = py;
          this.mc(ref[0], Y, w, this.h, mx * 16, my * 16, 16, px, py, 2);
          this.mc(ref[1], U, cw, this.ch, mx * 8, my * 8, 8, px, py, 3);
          this.mc(ref[2], V, cw, this.ch, mx * 8, my * 8, 8, px, py, 3);
          for (k = 0; k < 16; k++) {
            i = (my * 4 + (k >> 2)) * bw + mx * 4 + (k & 3);
            modeA[i] = 0; this.nzY[i] = 0;
          }
          if (skip) {
            for (k = 0; k < 4; k++) {
              i = (my * 2 + (k >> 1)) * cbw + mx * 2 + (k & 1);
              this.nzC[0][i] = this.nzC[1][i] = 0;
            }
          } else {
            for (k = 0; k < 16; k++) this.luma(d, c, mx, my, k, qp);
            this.chroma(d, c, mx, my);
          }
        }
        if (d.over > 16) fail('damaged motion frame');
      }
    }
    this.deblock(Y, w, this.h, this.nzY, 2, qp);
    var qpc = MMC_CHROMA_QP[qp];
    this.deblock(U, cw, this.ch, this.nzC[0], 1, qpc);
    this.deblock(V, cw, this.ch, this.nzC[1], 1, qpc);
    var swap = this.cur; this.cur = this.ref; this.ref = swap;
  };

  MotionDecoder.prototype.deblock = function (plane, pw, ph, nz, mbsh, qp) {
    var alpha = MMC_ALPHA[qp], beta = MMC_BETA[qp];
    if (!alpha) return;
    var bw = pw >> 2, bh = ph >> 2, intra = this.mbIntra, mv = this.mv, mbw = this.mbw;
    for (var dir = 0; dir < 2; dir++) {
      var step = dir ? pw : 1;
      for (var by = dir; by < bh; by++) {
        for (var bx = 1 - dir; bx < bw; bx++) {
          var ax = dir ? bx : bx - 1, ay = dir ? by - 1 : by;
          var mba = (ay >> mbsh) * mbw + (ax >> mbsh), mbb = (by >> mbsh) * mbw + (bx >> mbsh), s;
          if (intra[mba] || intra[mbb]) s = 2;
          else if (nz[ay * bw + ax] || nz[by * bw + bx]) s = 1;
          else if (mba !== mbb && (Math.abs(mv[mba * 2] - mv[mbb * 2]) >= 4 ||
                                   Math.abs(mv[mba * 2 + 1] - mv[mbb * 2 + 1]) >= 4)) s = 1;
          else continue;
          var tc = MMC_TC0[qp] + (s === 2 ? 1 : 0), base = by * 4 * pw + bx * 4;
          for (var k = 0; k < 4; k++) {
            var q = dir ? base + k : base + k * pw;
            var p1 = plane[q - 2 * step], p0 = plane[q - step], q0 = plane[q], q1 = plane[q + step];
            if (Math.abs(p0 - q0) < alpha && Math.abs(p1 - p0) < beta && Math.abs(q1 - q0) < beta) {
              var dl = ((q0 - p0) * 4 + (p1 - q1) + 4) >> 3;
              dl = dl < -tc ? -tc : dl > tc ? tc : dl;
              plane[q - step] = clip(p0 + dl);
              plane[q] = clip(q0 - dl);
            }
          }
        }
      }
    }
  };

  // The last decoded frame as 0xAARRGGBB (colour upsampled 9:3:3:1, BT.601 full range)
  MotionDecoder.prototype.toArgb = function (width, height, out) {
    var Y = this.ref[0], U = this.ref[1], V = this.ref[2], cw = this.cw, ch = this.ch;
    for (var y = 0; y < height; y++) {
      var cy = y >> 1, cy2 = (y & 1) ? cy + 1 : cy - 1;
      cy2 = cy2 < 0 ? 0 : cy2 > ch - 1 ? ch - 1 : cy2;
      var r0 = cy * cw, r1 = cy2 * cw, row = y * this.w, o = y * width;
      for (var x = 0; x < width; x++) {
        var cx = x >> 1, cx2 = (x & 1) ? cx + 1 : cx - 1;
        cx2 = cx2 < 0 ? 0 : cx2 > cw - 1 ? cw - 1 : cx2;
        var cb = ((9 * U[r0 + cx] + 3 * U[r0 + cx2] + 3 * U[r1 + cx] + U[r1 + cx2] + 8) >> 4) - 128;
        var cr = ((9 * V[r0 + cx] + 3 * V[r0 + cx2] + 3 * V[r1 + cx] + V[r1 + cx2] + 8) >> 4) - 128;
        var lum = Y[row + x];
        var r = clip(lum + ((359 * cr + 128) >> 8));
        var g = clip(lum - ((88 * cb + 183 * cr + 128) >> 8));
        var b = clip(lum + ((454 * cb + 128) >> 8));
        out[o + x] = (0xFF000000 | r << 16 | g << 8 | b) >>> 0;
      }
    }
  };

  // .vid -> a video whose frame(n) returns that frame's pixels (one shared buffer)
  function Video(d) {
    if (d.length < 64 || tag(d) !== 'MVID' || (d[4] !== 1 && d[4] !== 2) || (d[5] !== 3 && d[5] !== 4) || d[6] !== 6)
      fail('not a supported .vid file');
    // version 1 is always tiles; version 2 names the codec at offset 60
    var codec = d[4] === 2 ? u32(d, 60) : 0;
    if (codec > 1 || (codec === 1 && d[5] !== 3)) fail('unsupported .vid codec ' + codec);
    this.codec = codec ? 'motion' : 'tiles';
    this.kind = 'vid';
    this.data = d;
    this.channels = d[5];
    this.width = u32(d, 8);
    this.height = u32(d, 12);
    checkSize(this.width, this.height);
    var num = u32(d, 16), den = u32(d, 20);
    this.frameCount = u32(d, 24);
    this.durationMs = u32(d, 28);
    if (!num || !den || !this.frameCount || this.frameCount > 100000) fail('invalid .vid timing or frame count');
    this.fps = num / den;
    if (this.fps > 1000) fail('invalid .vid frame rate');
    this.duration = this.durationMs ? this.durationMs / 1000 : this.frameCount / this.fps;
    this.keyInterval = u32(d, 56);
    var indexAt = u64(d, 32), indexEnd = indexAt + this.frameCount * 16;
    if (indexAt < 64 || indexEnd > d.length) fail('invalid .vid frame index');
    this.offsets = new Float64Array(this.frameCount);
    this.sizes = new Uint32Array(this.frameCount);
    this.keys = new Uint8Array(this.frameCount);
    for (var f = 0; f < this.frameCount; f++) {
      var at = indexAt + f * 16, off = u64(d, at), sz = u32(d, at + 8);
      if (off < 64 || off + sz > indexAt) fail('invalid range for .vid frame ' + f);
      this.offsets[f] = off; this.sizes[f] = sz; this.keys[f] = u32(d, at + 12) & 1;
    }
    var audioAt = u64(d, 40), audioSize = u64(d, 48);
    this.audio = null;
    if (audioSize) {
      if (audioAt < indexEnd || audioAt + audioSize > d.length) fail('invalid soundtrack range');
      this.audio = decodeAdi(d.subarray(audioAt, audioAt + audioSize));
    }
    this.across = Math.ceil(this.width / 64);
    this.tiles = this.across * Math.ceil(this.height / 64);
    this.pixels = new Uint32Array(this.width * this.height);
    this.decoded = -1;
    this.motion = codec ? new MotionDecoder(this.width, this.height) : null;
  }
  Video.prototype.decodeOne = function (n) {
    var d = this.data, at = this.offsets[n], end = at + this.sizes[n];
    if (this.motion) {
      // flags (bit 0: keyframe), QP, 2 zero bytes, then the range-coded frame
      if (this.sizes[n] < 5) fail('truncated .vid frame ' + n);
      if (!(d[at] & 1) && this.decoded !== n - 1) fail('.vid frame ' + n + ' needs the frame before it');
      this.motion.decode(d.subarray(at + 4, end), (d[at] & 1) === 1, d[at + 1]);
      this.motion.toArgb(this.width, this.height, this.pixels);
      this.decoded = n;
      return;
    }
    var bitmapSize = (this.tiles + 7) >> 3, bitmap = at + 4, sizes = bitmap + bitmapSize;
    if (sizes > end) fail('truncated .vid frame ' + n);
    var key = d[at] & 1;
    if (!key && this.decoded !== n - 1) fail('.vid frame ' + n + ' needs the frame before it');
    var coded = 0, t;
    for (t = 0; t < this.tiles; t++) coded += (d[bitmap + (t >> 3)] >> (t & 7)) & 1;
    var pos = sizes + coded * 4, k = 0;
    if (pos > end) fail('truncated tile sizes in .vid frame ' + n);
    for (t = 0; t < this.tiles; t++) {
      if (!((d[bitmap + (t >> 3)] >> (t & 7)) & 1)) {
        if (key) fail('.vid keyframe ' + n + ' leaves out a tile');
        continue;
      }
      var tileEnd = pos + u32(d, sizes + 4 * k++);
      if (tileEnd > end) fail('truncated tile in .vid frame ' + n);
      decodeTile(d, pos, tileEnd, this.width, this.height, this.pixels, t % this.across, (t / this.across) | 0, !key);
      pos = tileEnd;
    }
    this.decoded = n;
  };
  Video.prototype.frame = function (n) {
    if (!(n >= 0 && n < this.frameCount)) fail('frame ' + n + ' is outside the video');
    if (n === this.decoded) return this.pixels;
    var start;
    if (this.decoded >= 0 && n > this.decoded) {
      // carry on from the last frame, unless a keyframe lies in between
      start = this.decoded + 1;
      for (var c = n; c > start; c--) if (this.keys[c]) { start = c; break; }
    } else {
      start = n;
      while (start && !this.keys[start]) start--;
    }
    if (this.keys[start]) this.decoded = -1;
    for (var f = start; f <= n; f++) this.decodeOne(f);
    return this.pixels;
  };
  Video.prototype.frameAt = function (seconds) {
    return Math.max(0, Math.min(this.frameCount - 1, Math.floor(seconds * this.fps + 1e-6)));
  };

  function imaNibble(st, code) {
    var step = IMA_STEP[st.i], delta = step >> 3;
    if (code & 1) delta += step >> 2;
    if (code & 2) delta += step >> 1;
    if (code & 4) delta += step;
    var p = st.p + (code & 8 ? -delta : delta);
    st.p = p < -32768 ? -32768 : p > 32767 ? 32767 : p;
    var i = st.i + IMA_INDEX[code & 7];
    st.i = i < 0 ? 0 : i > 88 ? 88 : i;
    return st.p;
  }

  // .adi -> { kind, format, sampleRate, channels, volume (0-1), frames, duration, pcm (interleaved Int16Array) }
  function decodeAdi(d) {
    var head = '', limit = Math.min(d.length, 2048 + 5);
    for (var c = 0; c < limit; c++) head += String.fromCharCode(d[c]);
    var marker = head.indexOf('#DATA');
    if (marker < 0) marker = head.indexOf('DATA');
    if (marker < 0 || marker > 2048) fail('not an .adi file (no #DATA line)');
    var fields = {};
    head.slice(0, marker).split(/\r?\n/).forEach(function (line) {
      var eq = line.indexOf('=');
      if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    });
    function int(name, def) {
      var v = fields[name] === undefined ? def : fields[name];
      if (!/^\s*-?\d+\s*$/.test(v)) fail('invalid .adi ' + name);
      return parseInt(v, 10);
    }
    var format = (fields.AudioFormat || 'IADPCM').toUpperCase();
    var rate = int('SampleRate', '48000'), ch = int('Channels', '2');
    var volume = Math.max(0, Math.min(100, int('Globalvol', '80')));
    if (!(rate >= 8000 && rate <= 192000) || (ch !== 1 && ch !== 2)) fail('unsupported .adi sample rate or channel count');
    var lineEnd = -1;
    for (c = marker; c < d.length; c++) if (d[c] === 10) { lineEnd = c; break; }
    if (lineEnd < 0) fail('.adi #DATA line has no line ending');
    var payload = d.subarray(lineEnd + 1);
    if (fields.AudioDatalen !== undefined) {
      var want = int('AudioDatalen', '0');
      if (want < 0 || want > payload.length) fail('.adi data is shorter than its AudioDatalen');
      payload = payload.subarray(0, want);
    }
    var pcm, n, k;
    if (format === 'PCM16') {
      n = payload.length - payload.length % (ch * 2);
      if (n > MAX_PCM) fail('.adi sound is over the 512 MiB limit');
      pcm = new Int16Array(n / 2);
      for (k = 0; k < pcm.length; k++) pcm[k] = payload[2 * k] | payload[2 * k + 1] << 8;
    } else if (format.indexOf('IMA') >= 0 || format === 'IADPCM') {
      if (payload.length * 4 > MAX_PCM) fail('.adi sound is over the 512 MiB limit');
      if (ch === 1) {
        var m = { p: 0, i: 0 };
        pcm = new Int16Array(payload.length * 2);
        for (k = 0; k < payload.length; k++) {
          pcm[2 * k] = imaNibble(m, payload[k] & 15);
          pcm[2 * k + 1] = imaNibble(m, payload[k] >> 4);
        }
      } else {
        // stereo: a left byte then a right byte, low nibbles first
        var L = { p: 0, i: 0 }, R = { p: 0, i: 0 }, pairs = payload.length >> 1;
        pcm = new Int16Array(pairs * 4);
        for (k = 0; k < pairs; k++) {
          var l = payload[2 * k], r = payload[2 * k + 1];
          pcm[4 * k] = imaNibble(L, l & 15);
          pcm[4 * k + 1] = imaNibble(R, r & 15);
          pcm[4 * k + 2] = imaNibble(L, l >> 4);
          pcm[4 * k + 3] = imaNibble(R, r >> 4);
        }
      }
      format = 'IMA-ADPCM';
    } else {
      fail('unsupported .adi format: ' + format);
    }
    var frames = pcm.length / ch;
    if (!frames) fail('.adi file has no sound in it');
    return { kind: 'adi', format: format, sampleRate: rate, channels: ch, volume: volume / 100,
      frames: frames, duration: frames / rate, pcm: pcm };
  }

  // Picks the decoder from the file's first bytes, not its name
  function open(bytes) {
    var d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var t = d.length >= 4 ? tag(d) : '';
    if (t === 'MIMG') return decodeImg(d);
    if (t === 'MVID') return new Video(d);
    return decodeAdi(d);
  }

  // A 16-bit WAV file for decoded .adi sound
  function toWav(a) {
    var bytes = a.pcm.length * 2, buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
    function str(at, s) { for (var i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, a.channels, true);
    v.setUint32(24, a.sampleRate, true); v.setUint32(28, a.sampleRate * a.channels * 2, true);
    v.setUint16(32, a.channels * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, bytes, true);
    new Int16Array(buf, 44).set(a.pcm);
    return buf;
  }

  var api = { open: open, decodeImg: decodeImg, decodeAdi: decodeAdi, Video: Video, toWav: toWav };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MOSMedia = api;
})(this);
