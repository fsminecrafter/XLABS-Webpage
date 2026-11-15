#!/usr/bin/env node
// Regenerates the website's Docs pages from the upstream project checkouts.
//
//   node tools/build-docs.mjs path/to/Minimal-OS [path/to/Minimal-OS-SDK] [path/to/Farcade-Engine]
//
// The SDK defaults to the Minimal-OS-SDK submodule inside the Minimal-OS
// checkout. Reads
//   - every Markdown file under Minimal-OS/docs;
//   - every Markdown file under Minimal-OS-SDK/docs: the function reference, one page per
//     header and one "## `name`" section per function;
//   - every Markdown file under Farcade-Engine/docs, when supplied;
// and writes:
//   - their pages and sidebar links into index.html;
//   - studio/docs.js: the same pages and a function index, for Run Studio's docs panel.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const osRoot = process.argv[2];
if (!osRoot) { console.error('usage: build-docs.mjs <Minimal-OS> [<Minimal-OS-SDK> [<Farcade-Engine>]]'); process.exit(2); }
const sdkRoot = process.argv[3] || join(osRoot, 'Minimal-OS-SDK');
const farcadeRoot = process.argv[4];
const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const osDocs = join(osRoot, 'docs'), sdkDocs = join(sdkRoot, 'docs');
const farcadeDocs = farcadeRoot && join(farcadeRoot, 'docs');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (s) => s.toLowerCase().replace(/::/g, '-').replace(/[^a-z0-9_]+/g, '-').replace(/^-|-$/g, '');
for (const f of [join(osDocs, 'system-overview.md'), join(sdkDocs, 'README.md')])
  if (!existsSync(f)) { console.error(f + ' not found'); process.exit(1); }
if (farcadeDocs && !existsSync(farcadeDocs)) { console.error(farcadeDocs + ' not found'); process.exit(1); }

// Page order and sidebar labels. OS page ids are the file name; SDK page
// ids are "sdk-" + the file name.
const OS_PAGES = [
  ['system-overview', 'Overview'],
  ['build-and-debugging', 'Build and debugging'],
  ['boot-and-kernel', 'Boot and kernel'],
  ['hardware-and-drivers', 'Hardware and drivers'],
  ['audio', 'Audio'],
  ['media', 'Images and video'],
  ['gpu', 'GPU and 3D'],
  ['storage-and-packages', 'Storage and packages'],
  ['installing', 'Installing to a disk'],
  ['networking', 'Networking'],
  ['services', 'Services'],
  ['install-and-services', 'Install and services'],
  ['user-programs', 'User programs'],
  ['user-sdk-syscalls', 'SDK and syscalls'],
  ['README', 'Documentation index'],
];
const SDK_PAGES = [
  ['README', 'Overview'],
  ['conventions', 'Conventions and errors'],
  ['process', 'Process and terminal'],
  ['files', 'Files'],
  ['memory', 'Memory and randomness'],
  ['strings', 'Strings and memory'],
  ['output', 'Formatted output'],
  ['windows', 'Windows'],
  ['easyui', 'easyui widgets'],
  ['font', 'Text in your own pixels'],
  ['graphics', 'Graphics'],
  ['input', 'Input'],
  ['network', 'Networking'],
  ['sysinfo', 'System information'],
  ['packages', 'Packages'],
  ['managers', 'Device managers'],
  ['farcadegl', 'FarcadeGL 3D'],
  ['fgsl', 'FGSL shading language'],
  ['storage', 'Disks and root commands'],
  ['audio', 'Playing audio'],
];
const sdkId = (file) => file === 'README' ? 'sdk-functions' : 'sdk-' + file;
const pathId = (prefix) => (file) => prefix + slug(file.replace(/\.md$/, '').replace(/\//g, '-'));
function markdownFiles(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const file = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) return markdownFiles(dir, file);
    return entry.isFile() && entry.name.endsWith('.md') ? [file.slice(0, -3)] : [];
  }).sort((a, b) => a.localeCompare(b));
}
function discoverPages(dir, preferred, id, labelFallback) {
  const pages = [...preferred];
  const known = new Set(pages.map(([file]) => file));
  for (const file of markdownFiles(dir)) {
    if (!known.has(file)) {
      const source = readFileSync(join(dir, file + '.md'), 'utf8');
      const title = source.match(/^#\s+(.+)$/m)?.[1]?.replace(/`/g, '').trim();
      pages.push([file, title || labelFallback(file)]);
    }
  }
  return pages.map(([file, label]) => [file, label, id(file)]);
}
const osPageDefs = discoverPages(osDocs, OS_PAGES, (file) => file === 'README' ? 'os-readme' : file, (file) => file);
const sdkPageDefs = discoverPages(sdkDocs, SDK_PAGES, sdkId, (file) => file);
const farcadePageDefs = farcadeDocs
  ? discoverPages(farcadeDocs, [], pathId('farcade-'), (file) => file)
  : [];
const pageFiles = (pages) => new Map(pages.flatMap(([file, , id]) => [
  [file + '.md', id],
  ...(file.includes('/') ? [] : [[file, id]]),
]));
const SETS = {
  os: { dir: osDocs, github: 'https://github.com/fsminecrafter/Minimal-OS/blob/main/docs/', pages: osPageDefs, files: pageFiles(osPageDefs) },
  sdk: { dir: sdkDocs, github: 'https://github.com/fsminecrafter/Minimal-OS-SDK/blob/main/docs/', pages: sdkPageDefs, files: pageFiles(sdkPageDefs) },
  farcade: { dir: farcadeDocs, github: 'https://github.com/fsminecrafter/Farcade-Engine/blob/main/docs/', pages: farcadePageDefs, files: pageFiles(farcadePageDefs) },
};

// ---------------------------------------------------------------------
//  Markdown, the subset the docs use
// ---------------------------------------------------------------------
// The page being rendered: { id, set, file }
let cur;

// A link to another page of the same set wins; then another set; then GitHub.
function href(link) {
  if (/^[a-z]+:/.test(link)) return { url: link, ext: true };
  let m = link.match(/^#(.+)$/);
  if (m) return { url: '#/docs/' + cur.id + '/' + slug(m[1]), ext: false };
  m = link.match(/^(.+?)\.md(?:#(.*))?$/);
  if (m) {
    const target = m[1];
    const currentPath = posix.normalize(posix.join(posix.dirname(cur.file), target + '.md'));
    const candidates = [cur.set, ...Object.keys(SETS).filter((set) => set !== cur.set)];
    for (const set of candidates) {
      const files = SETS[set].files;
      const key = set === cur.set ? currentPath : posix.normalize(target + '.md');
      const id = files.get(key) || (!target.includes('/') && files.get(target));
      if (id) return { url: '#/docs/' + id + (m[2] ? '/' + slug(m[2]) : ''), ext: false };
    }
  }
  return { url: new URL(link, SETS[cur.set].github).href, ext: true };
}

function inline(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '`') {
      const j = text.indexOf('`', i + 1);
      if (j > i) { out.push('<code>' + esc(text.slice(i + 1, j).replace(/\\\|/g, '|')) + '</code>'); i = j + 1; continue; }
    }
    if (c === '*' && text[i + 1] === '*') {
      const j = text.indexOf('**', i + 2);
      if (j > i) { out.push('<strong>' + inline(text.slice(i + 2, j)) + '</strong>'); i = j + 2; continue; }
    }
    if (c === '[') {
      const m = text.slice(i).match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
      if (m) {
        const h = href(m[2]);
        out.push('<a href="' + esc(h.url) + '"' + (h.ext ? ' target="_blank" rel="noopener"' : '') + '>' + inline(m[1]) + '</a>');
        i += m[0].length; continue;
      }
    }
    out.push(esc(c)); i++;
  }
  return out.join('');
}

function cells(line) { return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(s => s.trim()); }
const row = (r, tag) => '<tr>' + r.map(c => '<' + tag + '>' + inline(c) + '</' + tag + '>').join('') + '</tr>';

// Returns { html, title, sections: [{ id, name, fn, level }] }
function render(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const html = [], sections = [], used = new Set();
  let title = '', i = 0, para = [];
  const flush = () => { if (para.length) { html.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (/^```/.test(line)) {
      flush();
      const lang = line.slice(3).trim();
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      html.push('<pre><code' + (lang ? ' class="lang-' + esc(lang) + '"' : '') + '>' + esc(body.join('\n')) + '</code></pre>');
      continue;
    }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flush();
      const level = m[1].length, text = m[2].trim();
      if (level === 1) { title = text.replace(/`/g, ''); html.push('<h1>' + inline(text) + '</h1>'); }
      else {
        const fm = text.match(/^`([^`]+)`$/);
        const name = fm ? fm[1] : text.replace(/`/g, '');
        let id = slug(name) || 'section';
        for (let n = 2; used.has(id); n++) id = slug(name) + '-' + n;
        used.add(id);
        if (level <= 3) sections.push({ id, name, fn: !!fm, level });
        html.push('<h' + level + ' id="' + cur.id + '--' + id + '"' + (fm ? ' class="fn"' : '') + '>' + inline(text) + '</h' + level + '>');
      }
      i++; continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      flush();
      let head = null;
      if (lines[i + 1] && /^\|\s*:?-{3}/.test(lines[i + 1])) { head = cells(line); i += 2; }
      const rows = [];
      for (; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      html.push('<div class="tw"><table>' + (head ? '<thead>' + row(head, 'th') + '</thead>' : '') +
        '<tbody>' + rows.map(r => row(r, 'td')).join('') + '</tbody></table></div>');
      continue;
    }
    if ((m = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)) && m[1].length === 0) {
      flush();
      const ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length) {
        const im = lines[i].match(/^([-*]|\d+\.)\s+(.*)$/);
        if (im) { items.push([im[2]]); i++; continue; }
        if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1].push(lines[i].trim()); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push('<' + tag + '>' + items.map(it => '<li>' + inline(it.join(' ')) + '</li>').join('') + '</' + tag + '>');
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return { html: html.join('\n'), title, sections };
}

// ---------------------------------------------------------------------
//  Pages
// ---------------------------------------------------------------------
function build(set) {
  return SETS[set].pages.map(([file, label, id]) => {
    cur = { id, set, file: file + '.md' };
    const r = render(readFileSync(join(SETS[set].dir, file + '.md'), 'utf8'));
    return { set, file, id, label, title: r.title, html: r.html, sections: r.sections };
  });
}
const osPages = build('os'), sdkPages = build('sdk'), farcadePages = build('farcade');
const allPages = osPages.concat(sdkPages, farcadePages);

// A box under the title: the functions on a function page, otherwise the
// page's sections when there are enough of them to need one.
const afterIntro = /(<\/h1>\n(?:<p>[\s\S]*?<\/p>\n)*)/;
for (const p of allPages) {
  const fns = p.sections.filter(s => s.fn);
  const h2 = p.sections.filter(s => !s.fn && s.level === 2);
  let box = '';
  if (fns.length) {
    box = '<nav class="fn-index" aria-label="Functions on this page"><span>Functions</span>' +
      fns.map(s => '<a href="#/docs/' + p.id + '/' + s.id + '"><code>' + esc(s.name) + '</code></a>').join('') + '</nav>';
  } else if (h2.length >= 3) {
    box = '<nav class="fn-index toc" aria-label="On this page"><span>On this page</span>' +
      h2.map(s => '<a href="#/docs/' + p.id + '/' + s.id + '">' + esc(s.name) + '</a>').join('') + '</nav>';
  }
  if (box) p.html = afterIntro.test(p.html) ? p.html.replace(afterIntro, '$1' + box + '\n') : box + '\n' + p.html;
}

const overview = sdkPages[0];
const all = [];
for (const p of sdkPages) for (const s of p.sections) if (s.fn) all.push({ name: s.name, page: p.id, label: p.label, id: s.id });
all.sort((a, b) => a.name.replace(/^mos_/, '').localeCompare(b.name.replace(/^mos_/, '')));
overview.html += '\n<h2 id="' + overview.id + '--all-functions">All functions</h2>\n<p>' + all.length +
  ' functions, alphabetically, ignoring the <code>mos_</code> prefix.</p>\n<div class="tw"><table><thead><tr><th>Function</th><th>Page</th></tr></thead><tbody>' +
  all.map(f => '<tr><td><a href="#/docs/' + f.page + '/' + f.id + '"><code>' + esc(f.name) + '</code></a></td><td>' + esc(f.label) + '</td></tr>').join('') +
  '</tbody></table></div>';
overview.sections.push({ id: 'all-functions', name: 'All functions', fn: false, level: 2 });

// Previous / next follow the sidebar, across both sets
allPages.forEach((p, i) => {
  const prev = allPages[i - 1], next = allPages[i + 1];
  const link = (q, rel, cls) => q ? '<a class="' + cls + '" href="#/docs/' + q.id + '" rel="' + rel + '"><span>' + (rel === 'prev' ? 'Previous' : 'Next') + '</span>' + esc(q.label) + '</a>' : '<span></span>';
  const pager = '<nav class="pager" aria-label="More pages">' + link(prev, 'prev', 'pv') + link(next, 'next', 'nx') + '</nav>';
  p.article = '<article class="doc" data-doc="' + p.id + '" hidden>' + p.html + pager +
    '<p class="src"><a href="' + SETS[p.set].github + p.file + '.md" target="_blank" rel="noopener">Edit this page on GitHub</a></p></article>';
});

// ---------------------------------------------------------------------
//  index.html
// ---------------------------------------------------------------------
function between(src, name, body) {
  const a = '<!-- ' + name + ' -->', b = '<!-- /' + name + ' -->';
  const s = src.indexOf(a), e = src.indexOf(b);
  if (s < 0 || e < s) throw new Error('index.html: markers ' + a + ' … ' + b + ' not found');
  return src.slice(0, s + a.length) + body + src.slice(e);
}
const nav = (head, pages) => '<span class="h">' + head + '</span>' +
  pages.map(p => '<a href="#/docs/' + p.id + '" data-nav="' + p.id + '">' + esc(p.label) + '</a>').join('');
const indexPath = join(site, 'index.html');
let index = readFileSync(indexPath, 'utf8');
index = between(index, 'os-docs:nav', nav('Minimal-OS docs', osPages));
index = between(index, 'sdk-docs:nav', nav('SDK functions', sdkPages));
index = between(index, 'farcade-docs:nav', nav('Farcade Engine docs', farcadePages));
index = between(index, 'os-docs:pages', '\n' + osPages.map(p => p.article).join('\n') + '\n');
index = between(index, 'sdk-docs:pages', '\n' + sdkPages.map(p => p.article).join('\n') + '\n');
index = between(index, 'farcade-docs:pages', '\n' + farcadePages.map(p => p.article).join('\n') + '\n');
writeFileSync(indexPath, index);

// ---------------------------------------------------------------------
//  studio/docs.js
// ---------------------------------------------------------------------
const forStudio = (p) => ({ id: p.id, label: p.label, html: p.html, sections: p.set === 'sdk' ? p.sections : [] });
const data = {
  categories: [
    { name: 'SDK functions', pages: sdkPages.map(forStudio) },
    { name: 'Minimal-OS docs', pages: osPages.map(forStudio) },
    ...(farcadePages.length ? [{ name: 'Farcade Engine docs', pages: farcadePages.map(forStudio) }] : []),
  ],
  functions: Object.fromEntries(all.map(f => [f.name, f.page + '/' + f.id])),
};
// easyui.createbutton is also found as createbutton (F1 on the word after the dot)
for (const name of Object.keys(data.functions)) {
  const m = name.match(/^easyui\.(\w+)$/);
  if (m && !data.functions[m[1]]) data.functions[m[1]] = data.functions[name];
}
// graphics.h short names point at the function they alias
const gfx = readFileSync(join(sdkRoot, 'include', 'graphics.h'), 'utf8');
for (const m of gfx.matchAll(/#define\s+(graphics_\w+)\s+(mos_\w+)/g)) if (data.functions[m[2]]) data.functions[m[1]] = data.functions[m[2]];
writeFileSync(join(site, 'studio', 'docs.js'),
  '// Generated by tools/build-docs.mjs from the Minimal-OS, Minimal-OS-SDK and Farcade-Engine docs. Do not edit.\n' +
  'window.STUDIO_DOCS = ' + JSON.stringify(data) + ';\n');
console.log('Docs: ' + osPages.length + ' Minimal-OS pages, ' + sdkPages.length + ' SDK pages, ' + farcadePages.length + ' Farcade Engine pages, ' + all.length + ' functions');
