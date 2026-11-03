// Small syntax highlighter for the docs' code blocks, shared by the site and
// Run Studio's docs panel. It reads a <code class="lang-x"> block's text and
// wraps tokens in <span class="hl-...">; the colours live in each page's CSS.
//
//   xlHighlight(codeEl)      colour one block (safe to call twice)
//   xlHighlightAll(rootEl)   colour every <pre><code> inside rootEl
//
// Languages: c, cpp, glsl, sh, ini. "text" is left alone; a block with no
// language is guessed as C or shell.
(function () {
  'use strict';

  function words(s) { var o = Object.create(null); s.split(' ').forEach(function (w) { o[w] = 1; }); return o; }

  var C_KW = words('if else for while do switch case default break continue return goto sizeof typedef struct union enum static extern const volatile inline register restrict _Static_assert asm __asm__ __attribute__');
  var C_TYPES = words('void char short int long float double signed unsigned bool _Bool size_t ssize_t ptrdiff_t intptr_t uintptr_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE va_list');
  var C_ATOMS = words('NULL true false nullptr EOF');
  var CPP_KW = words('class namespace template typename public private protected virtual override final new delete this operator using friend explicit constexpr noexcept try catch throw static_cast dynamic_cast reinterpret_cast const_cast auto decltype mutable');
  var GLSL_KW = words('uniform attribute varying in out inout discard precision highp mediump lowp layout');
  var GLSL_TYPES = words('vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 mat2 mat3 mat4 sampler2D samplerCube');
  var SH_KW = words('if then else elif fi for in do done while until case esac function return export local sudo');

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function span(cls, s) { return cls ? '<span class="hl-' + cls + '">' + esc(s) + '</span>' : esc(s); }

  // Runs a list of [regex, class-or-function] rules over the text. Each regex
  // is sticky (y), so the first rule that matches at the cursor wins.
  function scan(text, rules) {
    var out = '', i = 0, plain = '';
    outer: while (i < text.length) {
      for (var r = 0; r < rules.length; r++) {
        var re = rules[r][0];
        re.lastIndex = i;
        var m = re.exec(text);
        if (m && m[0].length) {
          var cls = rules[r][1];
          if (typeof cls === 'function') cls = cls(m[0], text, i + m[0].length, i);
          if (cls === null) continue;
          out += esc(plain); plain = '';
          out += span(cls, m[0]);
          i += m[0].length;
          continue outer;
        }
      }
      plain += text[i++];
    }
    return out + esc(plain);
  }

  function nextNonSpace(text, j) { while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++; return text[j]; }

  function cLike(kw, types, extraType) {
    return [
      [/\/\/[^\n]*/y, 'comment'],
      [/\/\*[\s\S]*?(?:\*\/|$)/y, 'comment'],
      [/^[ \t]*#[ \t]*\w+(?:[ \t]+<[^>\n]*>)?/my, 'meta'],
      [/"(?:[^"\\\n]|\\.)*"?/y, 'string'],
      [/'(?:[^'\\\n]|\\.)*'?/y, 'string'],
      [/(?:0[xX][\da-fA-F']+|0[bB][01']+|(?:\d[\d']*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[uUlLfF]*\b/y, 'number'],
      [/[A-Za-z_]\w*/y, function (w, text, end, start) {
        if (kw[w]) return 'keyword';
        if (types[w] || (extraType && extraType[w]) || /^\w+_t$/.test(w)) return 'type';
        if (C_ATOMS[w]) return 'atom';
        if (/^f?gl_\w/.test(w)) return 'meta';
        if (text[start - 1] === '.' || (text[start - 1] === '>' && text[start - 2] === '-')) {
          return nextNonSpace(text, end) === '(' ? 'fn' : 'prop';
        }
        if (nextNonSpace(text, end) === '(') return 'fn';
        if (/^[A-Z][A-Z0-9_]{2,}$/.test(w)) return 'atom';
        return '';
      }],
      [/[-+*\/%=!<>&|^~?:]+/y, 'op'],
    ];
  }

  var LANGS = {
    c: cLike(C_KW, C_TYPES),
    cpp: cLike(Object.assign({}, C_KW, CPP_KW), C_TYPES, words('string ostream istream vector')),
    glsl: cLike(Object.assign({}, C_KW, GLSL_KW), Object.assign({}, C_TYPES, GLSL_TYPES)),
    sh: [
      [/(^|(?<=[ \t]))#[^\n]*/my, 'comment'],
      [/"(?:[^"\\]|\\.)*"?/y, 'string'],
      [/'[^']*'?/y, 'string'],
      [/\$(?:\{[^}\n]*\}|\w+|[@#?$!*0-9])/y, 'atom'],
      [/(?<=^|[ \t])--?[A-Za-z][\w-]*(?:=[^\s]*)?/my, 'flag'],
      [/[A-Za-z_][\w.\/-]*|\.{0,2}\/[\w.\/-]+/y, function (w, text, end, start) {
        // the first word on a line, or after | ; && ||, is the command
        var k = start - 1;
        while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
        var first = k < 0 || text[k] === '\n' || text[k] === '|' || text[k] === ';' || text[k] === '&' || text[k] === '(';
        if (first && text[k] === '\n' && text[k - 1] === '\\') first = false;
        if (SH_KW[w] && first) return 'keyword';
        if (first && text[end] !== '=') return 'fn';
        return '';
      }],
      [/\d+[KMGT]?\b/y, 'number'],
      [/[|&;<>]+|\\$/my, 'op'],
    ],
    ini: [
      [/^[ \t]*[;#][^\n]*/my, 'comment'],
      [/^[ \t]*\[[^\]\n]*\]/my, 'keyword'],
      [/^[ \t]*[\w.-]+(?=[ \t]*=)/my, 'fn'],
      [/"(?:[^"\\\n]|\\.)*"?/y, 'string'],
      [/\b\d+(?:\.\d+)?\b/y, 'number'],
      [/\b(?:None|Restart|true|false|yes|no|on|off)\b/y, 'atom'],
      [/=/y, 'op'],
    ],
  };
  LANGS.h = LANGS.c; LANGS.bash = LANGS.shell = LANGS.console = LANGS.sh;

  function guess(text) {
    if (/[;{}]\s*$/m.test(text) && /\w\s*\(/.test(text)) return 'c';
    if (/^\s*\[[\w ]+\]\s*$/m.test(text) && /^\s*\w+\s*=/m.test(text)) return 'ini';
    return 'sh';
  }

  var NAMES = { c: 'C', h: 'C', cpp: 'C++', glsl: 'FGSL', sh: 'Shell', bash: 'Shell', shell: 'Shell', console: 'Shell', ini: 'Config', text: '' };

  function xlHighlight(code) {
    if (!code || code.dataset.hl) return;
    var m = /(?:^|\s)lang-([\w+-]+)/.exec(code.className);
    var lang = m ? m[1].toLowerCase() : '';
    var text = code.textContent;
    if (!lang) lang = guess(text);
    code.dataset.hl = lang;
    var pre = code.parentNode;
    if (pre && pre.tagName === 'PRE' && NAMES[lang]) pre.dataset.lang = NAMES[lang];
    var rules = LANGS[lang];
    if (!rules) return;
    try { code.innerHTML = scan(text, rules); } catch (e) { /* leave it plain */ }
  }

  function xlHighlightAll(root) {
    (root || document).querySelectorAll('pre > code').forEach(xlHighlight);
  }

  window.xlHighlight = xlHighlight;
  window.xlHighlightAll = xlHighlightAll;
})();
