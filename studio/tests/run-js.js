// Runs a C file through the preview (worker.js) under Node and prints its output.
//   node run-js.js program.c
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..') + '/';
globalThis.self = globalThis; globalThis.onmessage = null;
globalThis.importScripts = (...f) => f.forEach(x => (0, eval)(fs.readFileSync(dir + x, 'utf8') + '\n//# sourceURL=' + x));
globalThis.postMessage = (m) => {
  if (m.t === 'out') process.stdout.write(m.text);
  else if (m.t === 'exit') { if (m.crash) console.error('crash: ' + m.crash); process.exit(m.code); }
  else if (m.t === 'compileError') { console.error(m.error.file + ':' + m.error.line + ':' + m.error.col + ': ' + m.error.message); process.exit(100); }
};
(0, eval)(fs.readFileSync(dir + 'worker.js', 'utf8') + '\n//# sourceURL=worker.js');
globalThis.onmessage({ data: { t: 'run', files: { ['main' + path.extname(process.argv[2])]: fs.readFileSync(process.argv[2], 'utf8') }, name: 'test', args: ['one', 'two'] } });
setTimeout(() => { console.error('timeout'); process.exit(124); }, 10000);
