// Runs a FarcadeGL program in the Studio preview, records every SYS_GPU call
// (gpu.log) and every presented frame as the preview drew it (js.raw).
//   node fgpu-record.js program.c outdir "key@ms,..." stopMs
const fs = require('fs'), path = require('path');
const dir = require('path').join(__dirname, '..') + '/';
globalThis.self = globalThis; globalThis.onmessage = null;
globalThis.importScripts = (...f) => f.forEach(x => (0, eval)(fs.readFileSync(dir + x, 'utf8') + '\n//# sourceURL=' + x));
const [, , src, out, keysArg, stopArg] = process.argv;
let winId = 0;
const log = [], frames = [];
const rec = (type, a, b, c, d, data) => {
  const h = Buffer.alloc(24); [type, a, b, c, d, data ? data.length : 0].forEach((v, i) => h.writeUInt32LE(v >>> 0, i * 4));
  log.push(h); if (data) log.push(Buffer.from(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data));
};
globalThis.postMessage = (m) => {
  if (m.t === 'out') process.stdout.write(m.text);
  else if (m.t === 'win') winId = m.info.id;
  else if (m.t === 'exit') { console.log('exit', m.code, m.crash || ''); done(); }
  else if (m.t === 'compileError') { console.log('compile error', JSON.stringify(m.error)); process.exit(1); }
};
(0, eval)(fs.readFileSync(dir + 'worker.js', 'utf8') + '\n//# sourceURL=worker.js');
const orig = FGPU.create;
FGPU.create = (env) => {
  const env2 = Object.assign({}, env, { presentWindow(id, s) { frames.push(Buffer.from(s.mem.slice().buffer)); rec(7, s.id, s.width, s.height, 0); return env.presentWindow(id, s); } });
  const g = orig(env2);
  const { L, rd } = env;
  return { syscall(r) {
    const Q = L.syscall_gpu_request_t, U8 = env.mem().U8;
    const op = rd(r, Q.op), data = rd(r, Q.data), bytes = rd(r, Q.bytes);
    const res = g.syscall(r);
    if (res !== 0n) { console.log('op', op, 'failed', res); return res; }
    const handle = rd(r, Q.handle);
    if (op === 2) rec(1, handle, rd(r, Q.width), rd(r, Q.height), rd(r, Q.format));
    if (op === 4) rec(2, handle, bytes, 0, 0);
    if (op === 5) rec(3, handle, rd(r, Q.offset), 0, 0, U8.slice(data, data + bytes));
    if (op === 11) rec(4, handle, 0, 0, 0, U8.slice(data, data + bytes));
    if (op === 13) { const s = rd(r, Q.pitch); rec(5, handle, s, 0, 0, U8.slice(data, data + s * 64)); }
    if (op === 7) rec(6, 0, 0, 0, 0, U8.slice(data, data + bytes));
    return res;
  } };
};
function done() {
  fs.writeFileSync(out + '/gpu.log', Buffer.concat(log));
  fs.writeFileSync(out + '/js.raw', Buffer.concat(frames));
  console.log('recorded', frames.length, 'frames');
  process.exit(0);
}
onmessage({ data: { t: 'run', files: { ['main' + path.extname(src)]: fs.readFileSync(src, 'utf8') }, name: 'test', args: [] } });
for (const k of (keysArg || '').split(',').filter(Boolean)) {
  const [key, at] = k.split('@').map(Number);
  setTimeout(() => { onmessage({ data: { t: 'wmEvent', id: winId, ev: { type: 8, key, buttons: 1 } } }); }, at);
}
setTimeout(done, Number(stopArg || 3000));
