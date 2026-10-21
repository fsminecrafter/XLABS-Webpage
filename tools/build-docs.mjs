#!/usr/bin/env node
// Regenerates the website's Docs pages from a Minimal-OS checkout.
//
//   node tools/build-docs.mjs path/to/Minimal-OS [path/to/Minimal-OS-SDK]
//
// The SDK defaults to the Minimal-OS-SDK submodule inside the Minimal-OS
// checkout. Reads
//   - Minimal-OS/docs/*.md: the system guides (boot, drivers, GPU, ...);
//   - Minimal-OS-SDK/docs/*.md: the function reference, one page per
//     header and one "## `name`" section per function;
// and writes:
//   - both sets of pages and their sidebar links into index.html, between
//     the <!-- os-docs:... --> and <!-- sdk-docs:... --> markers;
//   - studio/docs.js: the same pages and a function index, for Run
//     Studio's docs panel.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const osRoot = process.argv[2];
if (!osRoot) { console.error('usage: build-docs.mjs <Minimal-OS> [<Minimal-OS-SDK>]'); process.exit(2); }
const sdkRoot = process.argv[3] || join(osRoot, 'Minimal-OS-SDK');
const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const osDocs = join(osRoot, 'docs'), sdkDocs = join(sdkRoot, 'docs');
for (const f of [join(osDocs, 'system-overview.md'), join(sdkDocs, 'README.md')])
  if (!existsSync(f)) { console.error(f + ' not found'); process.exit(1); }

// Page order and sidebar labels. OS page ids are the file name; SDK page
// ids are "sdk-" + the file name.
const OS_PAGES = [
  ['system-overview', 'Overview'],
  ['build-and-debugging', 'Build and debugging'],
  ['boot-and-kernel', 'Boot and kernel'],
  ['hardware-and-drivers', 'Hardware and drivers'],
  ['gpu', 'GPU and 3D'],
  ['storage-and-packages', 'Storage and packages'],
  ['installing', 'Installing to a disk'],
  ['networking', 'Networking'],
  ['services', 'Services'],
  ['install-and-services', 'Install and services'],
  ['user-programs', 'User programs'],
  ['user-sdk-syscalls', 'SDK and syscalls'],
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
];
const sdkId = (file) => file === 'README' ? 'sdk-functions' : 'sdk-' + file;
const SETS = {
  os: { dir: osDocs, github: 'https://github.com/fsminecrafter/Minimal-OS/blob/main/docs/', id: (f) => f, files: new Set(OS_PAGES.map(p => p[0])) },
  sdk: { dir: sdkDocs, github: 'https://github.com/fsminecrafter/Minimal-OS-SDK/blob/main/docs/', id: sdkId, files: new Set(SDK_PAGES.map(p => p[0])) },
};

// ---------------------------------------------------------------------
//  Markdown, the subset the docs use
// ---------------------------------------------------------------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (s) => s.toLowerCase().replace(/::/g, '-').replace(/[^a-z0-9_]+/g, '-').replace(/^-|-$/g, '');

// The page being rendered: { id, set } (set is 'os' or 'sdk')
let cur;

// A link to another page of the same set wins; then the other set; then
// the file on GitHub. files.md#mos_fwrite -> #/docs/sdk-files/mos_fwrite
function href(link) {
  if (/^[a-z]+:/.test(link)) return { url: link, ext: true };
  let m = link.match(/^#(.+)$/);
  if (m) return { url: '#/docs/' + cur.id + '/' + slug(m[1]), ext: false };
  m = link.match(/^([\w-]+)\.md(?:#(.*))?$/);
  if (m) {
    const other = cur.set === 'os' ? 'sdk' : 'os';
    const set = SETS[cur.set].files.has(m[1]) ? cur.set : SETS[other].files.has(m[1]) ? other : null;
    if (set) return { url: '#/docs/' + SETS[set].id(m[1]) + (m[2] ? '/' + slug(m[2]) : ''), ext: false };
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
function build(set, list) {
  return list.map(([file, label]) => {
    const id = SETS[set].id(file);
    cur = { id, set };
    const r = render(readFileSync(join(SETS[set].dir, file + '.md'), 'utf8'));
    return { set, file, id, label, title: r.title, html: r.html, sections: r.sections };
  });
}
const osPages = build('os', OS_PAGES), sdkPages = build('sdk', SDK_PAGES);
const allPages = osPages.concat(sdkPages);

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
index = between(index, 'os-docs:pages', '\n' + osPages.map(p => p.article).join('\n') + '\n');
index = between(index, 'sdk-docs:pages', '\n' + sdkPages.map(p => p.article).join('\n') + '\n');
writeFileSync(indexPath, index);

// ---------------------------------------------------------------------
//  studio/docs.js
// ---------------------------------------------------------------------
const forStudio = (p) => ({ id: p.id, label: p.label, html: p.html, sections: p.set === 'sdk' ? p.sections : [] });
const data = {
  categories: [
    { name: 'SDK functions', pages: sdkPages.map(forStudio) },
    { name: 'Minimal-OS docs', pages: osPages.map(forStudio) },
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
  '// Generated by tools/build-docs.mjs from Minimal-OS/docs, Minimal-OS-SDK/docs. Do not edit.\n' +
  'window.STUDIO_DOCS = ' + JSON.stringify(data) + ';\n');
console.log('Docs: ' + osPages.length + ' Minimal-OS pages, ' + sdkPages.length + ' SDK pages, ' + all.length + ' functions');
