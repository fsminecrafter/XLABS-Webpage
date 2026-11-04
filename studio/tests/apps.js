// Compiles every Minimal-OS app in apps/ (tools/build-apps.mjs) with both
// mcc back ends, the preview's and the x86_64 one.
//   node studio/tests/apps.js
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..');
for (const f of ['mcc-front.js', 'mcc-cpp.js', 'sdk.js', 'mcc-js.js', 'mcc-x64.js']) require(path.join(dir, f));
const { apps } = JSON.parse(fs.readFileSync(path.join(dir, 'apps', 'index.json'), 'utf8'));
let status = 0;
for (const a of apps) {
  const { files } = JSON.parse(fs.readFileSync(path.join(dir, 'apps', a.id + '.json'), 'utf8'));
  const src = {};
  for (const [p, f] of Object.entries(files)) if (typeof f === 'string' && /\.(c|h|cpp|hpp)$/.test(p)) src[p] = f;
  for (const [backend, fn] of [['js', MCC.compileJS], ['x64', MCC.compileX64]]) {
    try { fn(src, MCC.SDK, {}); console.log('ok   ' + a.id + ' (' + backend + ')'); }
    catch (e) { console.log('FAIL ' + a.id + ' (' + backend + '): ' + (e.file ? e.file + ':' + e.line + ': ' : '') + e.message); status = 1; }
  }
}
process.exit(status);
