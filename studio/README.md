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
| `studio.js` | The project and its file list, editor tabs, uploads and downloads (files, folders, .zip), dialogs and menus, the Apps menu, the Files tab, run/stop and builds |
| `system.js` | The preview system: one MinimaFS shared by every program (kept in IndexedDB), a worker per running program (the project and any Minimal-OS apps), routing between them and the desktop, and the app catalog |
| `layout.js` | The panes: order, docking by dragging a top bar, gutters, minimise / hide, preview full screen |
| `docsview.js` | The docs pane: the collapsible page list, search, content and F1 lookup |
| `fonts/` | Inter (SIL OFL), the fonts mosWM installs; the preview puts them at the same path so smooth text works there |
| `desktop.js` | The preview desktop: mosWM-style windows from every running program, taskbar, start menu with the apps, desktop icons, terminal, input |
| `worker.js` | Runs a program: compiles it with the JS back end and emulates the Minimal-OS kernel (syscalls, window manager, MinimaFS, heap, graphics, input, and outbound HTTP(S)) |
| `fgpu.js` | `SYS_GPU` for the preview: a port of the kernel's FGPU (`fgpu.c`, `fgpu_raster.c`, `fgpu_shader.c`), so FarcadeGL programs run. Shader programs are checked like the kernel checks them, then compiled to JavaScript |
| `mcc-front.js` | mcc, the C compiler: preprocessor, parser, type checker |
| `mcc-cpp.js` | mcc's C++ front end: lowers classes, templates and the rest to the C syntax tree |
| `mcc-js.js` | mcc back end for the preview (JavaScript over an emulated LP64 memory) |
| `mcc-x64.js` | mcc back end for builds (x86_64 code, ELF writer, `MINIRUN1` and `MPKG0001` bundlers) |
| `sdk.js` | Generated: the Minimal-OS SDK headers plus freestanding `stdint.h`, `stdarg.h`, … and the crt0 |
| `templates.js` | Generated: the sample projects |
| `apps/` | Generated: the Minimal-OS apps from MOSdesk (`index.json` lists them, `<id>.json` holds an app's sources and resources) |
| `docs.js` | Generated: the SDK function reference and the Minimal-OS docs, for the docs pane |
| `vendor/` | CodeMirror 5 (MIT), the editor |

## Regenerating

```sh
node studio/tools/build-sdk.mjs path/to/Minimal-OS-SDK   # after the SDK headers change
node studio/tools/build-templates.mjs                    # after editing studio/templates/
node studio/tools/build-apps.mjs path/to/MOSdesk         # after MOSdesk's apps or Mxplorer change
node tools/build-docs.mjs path/to/Minimal-OS               # after Minimal-OS or SDK docs/ change
```

`build-sdk.mjs` copies the SDK's `include/` tree (including `iostream`) unchanged
except for the three inline-assembly syscall stubs, whose bodies become mcc's
`__syscall` builtin.
Freestanding headers and the crt0 live in `tools/builtin/`.

`tools/build-docs.mjs` (at the repository root) renders Minimal-OS's
`docs/*.md` and the SDK's `docs/*.md` (from the `Minimal-OS-SDK` submodule, or
a path given as a second argument) into the website's Docs pages in
`index.html`, and writes `studio/docs.js` with the same pages for the docs pane.

`build-sdk.mjs` also swaps FarcadeGL's one-instruction `fglSqrt` (SSE inline
assembly) for the same square root in plain C.

`build-apps.mjs` packs each app the way the SDK's `build.sh` sees it. Two
things mcc does not have are patched in the packed copy, each with the code
the app would compile to anyway: Mxplorer's two inline-assembly blocks (it
already has C fallbacks for other targets; the preview also lets its scripts
use the 2 MiB program stack) and its three GNU statement expressions. The
tool warns when a patch stops applying.

## Running apps, and files

Every program in the preview runs in its own worker: the project, and the
apps started from Apps, the start menu, the desktop icons, the Files tab or
another program's `SYS_EXEC` (the Terminal app's `run`). Window ids are
`pid * 128 + id` on the page so the desktop can tell them apart; keys and
raw input go to the program that owns the focused window.

The page keeps the master copy of MinimaFS. A worker gets a snapshot when it
starts and posts what it changes (a file when it is closed, and once a second
while it stays open); the page passes changes on to the other workers. Files
under `0:/programs/` that Studio installs (the apps, the project, mosWM's
fonts) are rebuilt on every visit; everything else that is uploaded or saved
is kept in IndexedDB.

The compiler follows `build.sh` for folder projects: every `.c`/`.cpp`
outside `tests/` and `examples/` is a translation unit (except a `.c` file
another file `#include`s), and `include/`, `src/` and
`libraries/ttrend/include/` are searched for includes. Programs compiled for
the preview see `__MCC_PREVIEW__`.

## Networking in the preview

The preview supports outbound HTTP/HTTPS over the SDK's TCP/TLS client calls.
Without a proxy it uses browser `fetch`, so the target must allow the Studio
origin through CORS. To reach hosts that do not allow browser requests, run the
optional self-hosted relay:

```sh
ALLOWED_HOSTS=google.com,www.google.com \
ALLOWED_ORIGINS=https://fsminecrafter.github.io \
HOST=0.0.0.0 PORT=8787 \
node studio/proxy/server.mjs
```

Deploy the relay behind HTTPS, and open Studio with its endpoint configured:

```text
studio/?httpProxy=https%3A%2F%2Fproxy.example.com%2Fv1%2Ffetch
```

The relay requires exact hostnames and exact browser origins; it rejects IP
addresses, nonstandard ports, private/reserved IPv4 destinations, and redirects
to hosts outside the allowlist. Add every intended redirect hostname explicitly.
Only public IPv4 DNS results are used. The relay allows 60 requests per client
IP per minute by default.
Only standard HTTP(S) ports and a small set of non-credential request headers
are forwarded. Credentials are omitted. Request and response bodies are limited
to 16 MiB; chunked requests are not supported. UDP, DHCP, TCP listeners, TLS
server sessions, and non-HTTP protocols are unavailable in the preview. Built
`.run` programs use the full network stack when run on Minimal-OS.

## Tests

```sh
studio/tests/run.sh
```

Compiles each test program (C, and C++ in `cpp-*.cpp`) with GCC or G++, with the preview back end (run under
Node) and with the x86_64 back end (run on Linux by `loader.c`, which loads the
ELF the way Minimal-OS's `elfloader.c` does and services syscalls through a
test hook). All three outputs must match. It also compiles every template with
both back ends.

```sh
node studio/tests/apps.js
```

Compiles every app in `apps/` with both back ends.

```sh
node studio/tests/net-preview.js
```

Exercises the preview's SDK DNS and TCP-to-HTTP bridge against a local proxy
endpoint. Test the relay allowlist and CORS behavior with:

```sh
node --test studio/proxy/server.test.mjs
```

```sh
studio/tests/fgpu-diff.sh path/to/Minimal-OS
```

Checks the preview's GPU (`fgpu.js`) against the kernel: it runs the 3D cube
sample through every mode, records each `SYS_GPU` call, replays them through
the kernel's own `fgpu_raster.c` and `fgpu_shader.c`, and compares the frames.

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
