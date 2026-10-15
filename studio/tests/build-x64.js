// Compiles a C file with the x86_64 back end into a test ELF whose syscalls
// go through a hook slot instead of int 0x80, so loader.c can run it on Linux.
//   node build-x64.js program.c out.elf
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..') + '/';
for (const f of ['mcc-front.js', 'mcc-cpp.js', 'sdk.js', 'mcc-x64.js']) require(dir + f);
try {
  const r = MCC.compileX64({ ['main' + path.extname(process.argv[2])]: fs.readFileSync(process.argv[2], 'utf8') }, MCC.SDK, { testHook: true });
  fs.writeFileSync(process.argv[3], r.elf);
} catch (e) { console.error((e.file || '') + ':' + (e.line || 0) + ': ' + e.message); process.exit(1); }
