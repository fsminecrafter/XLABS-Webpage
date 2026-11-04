// Decoders for Minimal-OS media: .img pictures, .vid videos and .adi sound.
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

  // .vid -> a video whose frame(n) returns that frame's pixels (one shared buffer)
  function Video(d) {
    if (d.length < 64 || tag(d) !== 'MVID' || d[4] !== 1 || (d[5] !== 3 && d[5] !== 4) || d[6] !== 6)
      fail('not a supported .vid file');
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
  }
  Video.prototype.decodeOne = function (n) {
    var d = this.data, at = this.offsets[n], end = at + this.sizes[n];
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
