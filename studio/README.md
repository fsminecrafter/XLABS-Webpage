# Run Studio

A web page for writing Minimal-OS `.run` programs: an editor, a live preview
running inside a recreation of the mosWM desktop, and an in-browser build that
writes a real x86_64 `main.elf`, `.run` bundle and `.mpkg` package.

Open `studio/index.html` through a web server (Web Workers do not run from
`file://`), for example `python3 -m http.server` in the repository root.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page: layout and styles |
| `studio.js` | Project storage, editor tabs, run/stop, builds and downloads |
| `docsview.js` | The docs pane: the split-screen gutters, the collapsible page list, search and F1 lookup |
| `desktop.js` | The preview desktop: mosWM-style windows, taskbar, terminal, input |
| `worker.js` | Runs a program: compiles it with the JS back end and emulates the Minimal-OS kernel (syscalls, window manager, MinimaFS, heap, graphics, input) |
| `mcc-front.js` | mcc, the C compiler: preprocessor, parser, type checker |
| `mcc-cpp.js` | mcc's C++ front end: lowers classes, templates and the rest to the C syntax tree |
| `mcc-js.js` | mcc back end for the preview (JavaScript over an emulated LP64 memory) |
| `mcc-x64.js` | mcc back end for builds (x86_64 code, ELF writer, `MINIRUN1` and `MPKG0001` bundlers) |
| `sdk.js` | Generated: the Minimal-OS SDK headers plus freestanding `stdint.h`, `stdarg.h`, … and the crt0 |
| `templates.js` | Generated: the sample projects |
| `docs.js` | Generated: the SDK function reference and the Minimal-OS docs, for the docs pane |
| `vendor/` | CodeMirror 5 (MIT), the editor |

## Regenerating

```sh
node studio/tools/build-sdk.mjs path/to/Minimal-OS-SDK   # after the SDK headers change
node studio/tools/build-templates.mjs                    # after editing studio/templates/
node tools/build-sdk-docs.mjs path/to/Minimal-OS-SDK     # after the SDK's docs/ change
```

`build-sdk.mjs` copies the SDK's `include/` tree (including `iostream`) unchanged
except for the three inline-assembly syscall stubs, whose bodies become mcc's
`__syscall` builtin.
Freestanding headers and the crt0 live in `tools/builtin/`.

`tools/build-sdk-docs.mjs` (at the repository root) renders the SDK's
`docs/*.md` into the website's Docs → SDK functions pages in `index.html`, and
writes `studio/docs.js` with those pages plus the Minimal-OS docs already in
`index.html`.

## Tests

```sh
studio/tests/run.sh
```

Compiles each test program (C, and C++ in `cpp-*.cpp`) with GCC or G++, with the preview back end (run under
Node) and with the x86_64 back end (run on Linux by `loader.c`, which loads the
ELF the way Minimal-OS's `elfloader.c` does and services syscalls through a
test hook). All three outputs must match. It also compiles every template with
both back ends.

## Compiler notes

* LP64 like the SDK: `char` is signed, `int` 32 bits, `long` and pointers 64 bits.
* Not supported: `goto`, bit-fields, variable-length arrays, inline assembly,
  statement expressions, wide strings. `long double` is `double`. `case`
  labels must sit directly inside the switch block.
* Every argument travels in one 8-byte slot (structures by address), so
  `va_list` is a cursor into the argument area in both back ends.
* C++ (`.cpp`, `.cc`, `.cxx`) is parsed by `mcc-cpp.js` and lowered to the C
  tree: methods are functions with a `this` parameter, references are
  pointers dereferenced where used, constructors, destructors and
  temporaries' lifetimes become explicit calls (with guards for
  temporaries in `?:`, `&&` and `||`), virtual calls index a vtable, and
  templates are instantiated by re-parsing their tokens with the arguments
  bound. Copy elision follows GCC: prvalues and a single named return
  value are built in place. Global constructors run from `__mcc_entry`
  before `main`. Not supported: exceptions, RTTI, lambdas, rvalue
  references, multiple inheritance, member templates, class template
  specialization.
