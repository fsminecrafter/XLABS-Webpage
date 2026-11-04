#!/usr/bin/env node
// Regenerates studio/apps/, the Minimal-OS apps the Studio preview can
// run, from a MOSdesk checkout:
//
//   node studio/tools/build-apps.mjs path/to/MOSdesk
//
// Each app is packed the way the SDK's build.sh sees it: a single-file app
// (mosdesk/apps/<name>.c) becomes main.c, a folder app (Mxplorer) keeps its
// tree. Headers it includes from outside its folder (../settings.h, mosWM's
// wm_text.h, ...) are added at the paths the includes resolve to. Binary
// resources are base64.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
if (!root) { console.error('usage: build-apps.mjs <MOSdesk>'); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));

// What the launcher shows. `src` is relative to the MOSdesk checkout; the
// run name is what mosdesk/build.sh installs (0:/programs/<run>.run).
const APPS = [
  // `seed`: files the preview creates when they do not exist yet (Mxplorer
  // starts on its own start page: most sites refuse browser requests from
  // another origin, see the README's networking notes)
  { id: 'mxplorer', run: 'Mxplorer', title: 'Mxplorer', icon: 'globe', src: 'Mxplorer', mem: 256,
    seed: { '0:/data/mxplorer-homepage.txt': '1\n' },
    description: 'The Minimal-OS web browser: its own HTML, CSS and JavaScript engines, tabs and developer tools (F12).' },
  { id: 'terminal', run: 'mos_terminal', title: 'Terminal', icon: 'terminal', src: 'mosdesk/apps/terminal.c',
    description: 'The MOSdesk command line: ls, cat, cd, ps, run and more, all through user-mode system calls.' },
  { id: 'edit', run: 'mos_edit', title: 'Text Editor', icon: 'edit', src: 'mosdesk/apps/edit.c',
    description: 'Open, edit and save text files, with undo, find and replace.' },
  { id: 'calc', run: 'mos_calc', title: 'Calculator', icon: 'calc', src: 'mosdesk/apps/calc.c',
    description: 'A desktop calculator built with easyui.' },
  { id: 'clock', run: 'mos_clock', title: 'Clock', icon: 'clock', src: 'mosdesk/apps/clock.c',
    description: 'An analogue clock driven by the kernel’s real-time clock.' },
  { id: 'paint', run: 'mos_paint', title: 'Paint', icon: 'paint', src: 'mosdesk/apps/paint.c',
    description: 'Draw with the mouse: palette, brush sizes on the wheel, C clears.' },
  { id: 'photos', run: 'mos_photos', title: 'Photos', icon: 'photo', src: 'mosdesk/apps/photos.c',
    description: 'Shows .img pictures, Minimal-OS’s image format.' },
  { id: 'player', run: 'mos_player', title: 'Player', icon: 'music', src: 'mosdesk/apps/player.c',
    description: 'Plays .adi audio files (the preview has no sound card, so it stays silent).' },
  { id: 'video', run: 'mos_video', title: 'Video', icon: 'video', src: 'mosdesk/apps/video.c',
    description: 'Plays .vid videos, decoded on the CPU.' },
  { id: 'golf', run: 'mos_golf', title: 'Greenline Golf', icon: 'golf', src: 'mosdesk/apps/golf.c', mem: 192,
    description: 'Mini golf in the style of KDE’s Kolf: aim with the mouse, hold to charge.' },
  { id: 'snake', run: 'mos_snake', title: 'Snake', icon: 'snake', src: 'mosdesk/apps/snake.c',
    description: 'The classic, with the arrow keys.' },
  { id: 'cube', run: 'mos_cube', title: '3D Cube', icon: 'cube', src: 'mosdesk/apps/cube.c',
    description: 'A lit, textured FarcadeGL cube. L, S and W switch the modes.' },
];

// mcc has no inline assembler. Where an app uses it behind
// `#if defined(__x86_64__)` with a C fallback, take the fallback under mcc
// (__MCC__). In the preview (__MCC_PREVIEW__) the program stack is 2 MiB,
// so Mxplorer's scripts can use it instead of switching to their own.
const PATCHES = {
  mxplorer: [
    ['gfx.c', '#if defined(__x86_64__)\n    double result;', '#if defined(__x86_64__) && !defined(__MCC__)\n    double result;'],
    ['js_dom.c', '#if defined(__x86_64__)\n    char* top', '#if defined(__x86_64__) && !defined(__MCC__)\n    char* top'],
    ['js_dom.c', '    on_js_stack = 0;\n#else\n    fn(arg);\n#endif',
      '    on_js_stack = 0;\n#elif defined(__MCC_PREVIEW__)\n    on_js_stack = 1;\n    fn(arg);\n    on_js_stack = 0;\n#else\n    fn(arg);\n#endif'],
    // mcc has no GNU statement expressions either: the same code as plain C
    ['js_dom.c', 'case G_OPTIONS: return js_obj_val(({ js_obj* list = node_list();\n        for (mx_node_t* o = n; o; o = mx_dom_next(n, o))\n            if (mx_dom_is(o, "option")) js_array_push(list, js_wrap_node(o));\n        list; }));',
      'case G_OPTIONS: { js_obj* list = node_list();\n        for (mx_node_t* o = n; o; o = mx_dom_next(n, o))\n            if (mx_dom_is(o, "option")) js_array_push(list, js_wrap_node(o));\n        return js_obj_val(list); }'],
    ['js_runtime.c', 'MATH1(clz32, (double)({ uint32_t v = (uint32_t)js_to_int32(js_num(x)); int n = 0; if (!v) n = 32; else while (!(v & 0x80000000u)) { v <<= 1; n++; } n; }))',
      'static double mx_clz32(double x) { uint32_t v = (uint32_t)js_to_int32(js_num(x)); int n = 0; if (!v) n = 32; else while (!(v & 0x80000000u)) { v <<= 1; n++; } return n; }\nMATH1(clz32, mx_clz32(x))'],
    ['js_runtime.c', '        return iterate_to_array(self.u.obj->cls == CLS_SET\n            ? ({ js_obj* out = js_new_array(c->length);\n                 for (uint32_t i = 0; i < c->length; i++) {\n                     js_obj* pair = js_new_array(2);\n                     js_array_push(pair, c->items[i]);\n                     js_array_push(pair, c->items[i]);\n                     js_array_push(out, js_obj_val(pair));\n                 }\n                 js_obj_val(out); })\n            : self);',
      '        if (self.u.obj->cls == CLS_SET) {\n            js_obj* out = js_new_array(c->length);\n            for (uint32_t i = 0; i < c->length; i++) {\n                js_obj* pair = js_new_array(2);\n                js_array_push(pair, c->items[i]);\n                js_array_push(pair, c->items[i]);\n                js_array_push(out, js_obj_val(pair));\n            }\n            return iterate_to_array(js_obj_val(out));\n        }\n        return iterate_to_array(self);'],
  ],
};

const SKIP_DIRS =/^(tests|tools|examples|dist|build|\.git)$/;
const isText = (p) => /\.(c|h|cpp|hpp|cc|hh|txt|md|html|htm|css|js|json|ini|cfg|pkg|service|svg)$/i.test(p);

function walk(dir, pre, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.test(name)) walk(p, pre + name + '/', out); }
    else out[pre + name] = p;
  }
  return out;
}

// quoted #includes that resolve outside the app's own files
function addIncludes(files, realOf, virtualPath) {
  const src = files[virtualPath];
  if (typeof src !== 'string') return;
  const vdir = posix.dirname(virtualPath) === '.' ? '' : posix.dirname(virtualPath) + '/';
  for (const m of src.matchAll(/^[ \t]*#[ \t]*(?:include|if[ \t]+__has_include[ \t]*\()[ \t]*"([^"]+)"/gm)) {
    const v = posix.normalize(vdir + m[1]).replace(/^(\.\.\/)+/, '');
    if (files[v] !== undefined) continue;
    const real = resolve(dirname(realOf[virtualPath]), m[1]);
    if (!existsSync(real) || statSync(real).isDirectory()) continue;   // an SDK header
    files[v] = readFileSync(real, 'utf8');
    realOf[v] = real;
    addIncludes(files, realOf, v);
  }
}

const out = [];
for (const app of APPS) {
  const src = join(root, app.src);
  if (!existsSync(src)) { console.warn('skipped ' + app.id + ': ' + app.src + ' not found'); continue; }
  const files = {}, realOf = {};
  const paths = statSync(src).isDirectory() ? walk(src, '', {}) : { 'main.c': src };
  for (const [v, real] of Object.entries(paths)) {
    if (/LICENSE|README/i.test(v) && !v.startsWith('Resources/')) continue;
    files[v] = isText(v) ? readFileSync(real, 'utf8') : { b64: readFileSync(real).toString('base64') };
    realOf[v] = real;
  }
  for (const v of Object.keys(files)) if (/\.(c|cpp|h)$/.test(v)) addIncludes(files, realOf, v);
  for (const [file, find, replace] of PATCHES[app.id] || []) {
    if (typeof files[file] !== 'string' || !files[file].includes(find)) {
      if (typeof files[file] === 'string' && files[file].includes(replace)) continue;   // fixed upstream
      console.warn('WARNING: ' + app.id + ': patch for ' + file + ' no longer applies; check the app still compiles');
      continue;
    }
    files[file] = files[file].replace(find, replace);
  }
  const size = Object.values(files).reduce((n, f) => n + (typeof f === 'string' ? f.length : f.b64.length * 3 / 4), 0);
  out.push(Object.assign({}, app, { src: undefined, files }));
  console.log(app.id.padEnd(9) + String(Object.keys(files).length).padStart(3) + ' files ' + Math.round(size / 1024) + ' KiB');
}

let rev = '';
try { rev = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim(); if (rev.startsWith('ref: ')) rev = readFileSync(join(root, '.git', rev.slice(5)), 'utf8').trim(); } catch (e) { /* not a git checkout */ }
// apps/index.json is what the launcher lists; apps/<id>.json holds an app's
// files and is fetched when it is first launched or opened.
const dir = join(here, '..', 'apps');
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (/\.json$/.test(f)) rmSync(join(dir, f));
const index = out.map(({ files, ...meta }) => Object.assign(meta, {
  bytes: Object.values(files).reduce((n, f) => n + (typeof f === 'string' ? Buffer.byteLength(f) : Math.floor(f.b64.length * 3 / 4)), 0),
}));
for (const app of out) writeFileSync(join(dir, app.id + '.json'), JSON.stringify({ id: app.id, files: app.files }));
writeFileSync(join(dir, 'index.json'), JSON.stringify({ source: 'MOSdesk' + (rev ? ' ' + rev.slice(0, 7) : ''), apps: index }, null, 1) + '\n');
console.log('apps/: ' + out.length + ' apps');
