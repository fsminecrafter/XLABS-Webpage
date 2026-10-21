// Compares the frames the preview drew (js.raw) with the kernel's (kernel.raw).
//   node fgpu-compare.js dir width height
const fs = require('fs');
const [, , dir, W, H] = process.argv;
const a = new Uint32Array(fs.readFileSync(dir + '/js.raw').buffer.slice(0));
const b = new Uint32Array(fs.readFileSync(dir + '/kernel.raw').buffer.slice(0));
const size = W * H;
if (a.length !== b.length || !a.length || a.length % size) { console.log('FAIL fgpu: frame counts differ'); process.exit(1); }
let worst = 0, total = 0;
for (let f = 0; f < a.length / size; f++) {
  let off = 0;
  for (let i = f * size; i < (f + 1) * size; i++) {
    const x = a[i], y = b[i];
    for (let s = 0; s <= 16; s += 8) if (Math.abs(((x >>> s) & 255) - ((y >>> s) & 255)) > 8) { off++; break; }
  }
  worst = Math.max(worst, off); total++;
}
// float64 (preview) vs float32 (kernel) moves a pixel on a triangle edge now and then
const ok = worst <= 50;
console.log((ok ? 'ok   ' : 'FAIL ') + 'fgpu: ' + total + ' frames, worst frame has ' + worst + ' of ' + size + ' pixels off by more than 8');
process.exit(ok ? 0 : 1);
