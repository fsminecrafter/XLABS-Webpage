#!/usr/bin/env node
// Regenerates the "SDK functions" docs from a Minimal-OS-SDK checkout.
//
//   node tools/build-sdk-docs.mjs path/to/Minimal-OS-SDK
//
// Reads the SDK's docs/*.md (one page per header, one "## `name`" section
// per function) and writes:
//   - the SDK pages and their sidebar links into index.html, between the
//     <!-- sdk-docs:... --> markers;
//   - studio/docs.js: every docs page (the Minimal-OS ones already in
//     index.html plus the SDK ones) and a function index, for Run
//     Studio's docs panel.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = process.argv[2];
if (!sdkRoot) { console.error('usage: build-sdk-docs.mjs <Minimal-OS-SDK>'); process.exit(2); }
const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(sdkRoot, 'docs');
if (!existsSync(join(docsDir, 'README.md'))) { console.error(docsDir + '/README.md not found'); process.exit(1); }

// Page order and sidebar labels. The page id is "sdk-" + the file name.
const PAGES = [
  ['README', 'Overview'],
  ['conventions', 'Conventions and errors'],
  ['process', 'Process and terminal'],
  ['files', 'Files'],
  ['memory', 'Memory and randomness'],
  ['strings', 'Strings and memory'],
  ['output', 'Formatted output'],
  ['windows', 'Windows'],
  ['easyui', 'easyui widgets'],
  ['graphics', 'Graphics'],
  ['input', 'Input'],
  ['network', 'Networking'],
  ['sysinfo', 'System information'],
  ['packages', 'Packages'],
  ['managers', 'Device managers'],
];
const pageId = (file) => file === 'README' ? 'sdk-functions' : 'sdk-' + file;
const GITHUB = 'https://github.com/fsminecrafter/Minimal-OS-SDK/blob/main/docs/';

// ---------------------------------------------------------------------
//  Markdown, the subset the SDK docs use
// ---------------------------------------------------------------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (s) => s.toLowerCase().replace(/::/g, '-').replace(/[^a-z0-9_]+/g, '-').replace(/^-|-$/g, '');

// files.md#mos_fwrite -> #/docs/sdk-files/mos_fwrite ; #x -> same page
function href(link, page) {
  if (/^[a-z]+:/.test(link)) return { url: link, ext: true };
  const m = link.match(/^([\w-]*)(?:\.md)?(?:#(.*))?$/);
  if (!m) return { url: link, ext: false };
  const target = m[1] ? pageId(m[1]) : page;
  return { url: '#/docs/' + target + (m[2] ? '/' + slug(m[2]) : ''), ext: false };
}

function inline(text, page) {
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
      if (j > i) { out.push('<strong>' + inline(text.slice(i + 2, j), page) + '</strong>'); i = j + 2; continue; }
    }
    if (c === '[') {
      const m = text.slice(i).match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
      if (m) {
        const h = href(m[2], page);
        out.push('<a href="' + esc(h.url) + '"' + (h.ext ? ' target="_blank" rel="noopener"' : '') + '>' + inline(m[1], page) + '</a>');
        i += m[0].length; continue;
      }
    }
    out.push(esc(c)); i++;
  }
  return out.join('');
}

function cells(line) { return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(s => s.trim()); }

// Returns { html, title, sections: [{ id, name, fn }] }
function render(md, page) {
  const lines = md.replace(/\r/g, '').split('\n');
  const html = [], sections = [];
  let title = '', i = 0, para = [];
  const flush = () => { if (para.length) { html.push('<p>' + inline(para.join(' '), page) + '</p>'); para = []; } };
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
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flush();
      const level = m[1].length, text = m[2].trim();
      if (level === 1) { title = text.replace(/`/g, ''); html.push('<h1>' + inline(text, page) + '</h1>'); }
      else {
        const fm = text.match(/^`([^`]+)`$/);
        const name = fm ? fm[1] : text;
        const id = slug(name);
        if (level === 2) sections.push({ id, name, fn: !!fm });
        html.push('<h' + level + ' id="' + page + '--' + id + '"' + (fm ? ' class="fn"' : '') + '>' + inline(text, page) + '</h' + level + '>');
      }
      i++; continue;
    }
    if (/^\|/.test(line) && lines[i + 1] && /^\|\s*:?-{3}/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      html.push('<div class="tw"><table><thead><tr>' + head.map(h => '<th>' + inline(h, page) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c, page) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if ((m = line.match(/^(\s*)(-|\d+\.)\s+(.*)$/)) && m[1].length === 0) {
      flush();
      const ordered = m[2] !== '-';
      const items = [];
      while (i < lines.length) {
        const im = lines[i].match(/^(-|\d+\.)\s+(.*)$/);
        if (im) { items.push([im[2]]); i++; continue; }
        if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1].push(lines[i].trim()); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push('<' + tag + '>' + items.map(it => '<li>' + inline(it.join(' '), page) + '</li>').join('') + '</' + tag + '>');
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
const pages = PAGES.map(([file, label]) => {
  const id = pageId(file);
  const r = render(readFileSync(join(docsDir, file + '.md'), 'utf8'), id);
  return { file, id, label, title: r.title, html: r.html, sections: r.sections };
});

// "On this page" for function pages, and an index of every function on the overview
for (const p of pages) {
  const fns = p.sections.filter(s => s.fn);
  if (fns.length) {
    const toc = '<nav class="fn-index" aria-label="Functions on this page"><span>Functions</span>' +
      fns.map(s => '<a href="#/docs/' + p.id + '/' + s.id + '"><code>' + esc(s.name) + '</code></a>').join('') + '</nav>';
    p.html = p.html.replace(/(<\/h1>\n(?:<p>[\s\S]*?<\/p>\n)*)/, '$1' + toc + '\n');
  }
}
const overview = pages[0];
const all = [];
for (const p of pages) for (const s of p.sections) if (s.fn) all.push({ name: s.name, page: p.id, label: p.label, id: s.id });
all.sort((a, b) => a.name.replace(/^mos_/, '').localeCompare(b.name.replace(/^mos_/, '')));
overview.html += '\n<h2 id="' + overview.id + '--all-functions">All functions</h2>\n<p>' + all.length +
  ' functions, alphabetically, ignoring the <code>mos_</code> prefix.</p>\n<div class="tw"><table><thead><tr><th>Function</th><th>Page</th></tr></thead><tbody>' +
  all.map(f => '<tr><td><a href="#/docs/' + f.page + '/' + f.id + '"><code>' + esc(f.name) + '</code></a></td><td>' + esc(f.label) + '</td></tr>').join('') +
  '</tbody></table></div>';
overview.sections.push({ id: 'all-functions', name: 'All functions', fn: false });

for (const p of pages) {
  p.article = '<article class="doc" data-doc="' + p.id + '" hidden>' + p.html +
    '<p class="src"><a href="' + GITHUB + p.file + '.md" target="_blank" rel="noopener">Edit this page on GitHub</a></p></article>';
}

// ---------------------------------------------------------------------
//  index.html
// ---------------------------------------------------------------------
function between(src, name, body) {
  const a = '<!-- sdk-docs:' + name + ' -->', b = '<!-- /sdk-docs:' + name + ' -->';
  const s = src.indexOf(a), e = src.indexOf(b);
  if (s < 0 || e < s) throw new Error('index.html: markers ' + a + ' … ' + b + ' not found');
  return src.slice(0, s + a.length) + body + src.slice(e);
}
const indexPath = join(site, 'index.html');
let index = readFileSync(indexPath, 'utf8');
index = between(index, 'nav', '<span class="h">SDK functions</span>' +
  pages.map(p => '<a href="#/docs/' + p.id + '" data-nav="' + p.id + '">' + esc(p.label) + '</a>').join(''));
index = between(index, 'pages', '\n' + pages.map(p => p.article).join('\n') + '\n');
writeFileSync(indexPath, index);

// ---------------------------------------------------------------------
//  studio/docs.js
// ---------------------------------------------------------------------
const os = [];
const navRe = /<a href="#\/docs\/([\w-]+)" data-nav="\1">([^<]+)<\/a>/g;
const navPart = index.slice(index.indexOf('<nav class="side"'), index.indexOf('<!-- sdk-docs:nav -->'));
for (let m; (m = navRe.exec(navPart));) {
  const art = index.match(new RegExp('<article class="doc" data-doc="' + m[1] + '" hidden>([\\s\\S]*?)</article>'));
  if (art) os.push({ id: m[1], label: m[2], html: art[1] });
}
const data = {
  categories: [
    { name: 'SDK functions', pages: pages.map(p => ({ id: p.id, label: p.label, html: p.html, sections: p.sections })) },
    { name: 'Minimal-OS docs', pages: os.map(p => ({ id: p.id, label: p.label, html: p.html, sections: [] })) },
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
  '// Generated by tools/build-sdk-docs.mjs from Minimal-OS-SDK/docs and index.html. Do not edit.\n' +
  'window.STUDIO_DOCS = ' + JSON.stringify(data) + ';\n');
console.log('SDK docs: ' + pages.length + ' pages, ' + all.length + ' functions; studio/docs.js: ' + (pages.length + os.length) + ' pages');
