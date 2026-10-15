#!/bin/sh
# Differential tests for mcc: each program is compiled by GCC (native),
# by the preview back end (run under Node) and by the x86_64 back end (run
# natively through loader.c). All three must print the same thing. The C++
# tests (cpp-*.cpp) are compiled natively by g++.
# Needs gcc, g++ and node on an x86_64 Linux machine.
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gcc -O1 -w -o "$tmp/loader" loader.c
status=0
capture() { out=$1; shift; rc=0; "$@" > "$out" 2>&1 || rc=$?; echo "exit $rc" >> "$out"; }
for src in sem1.c sem2.c cpp-*.cpp; do
    case "$src" in
        *.cpp) g++ -w -O0 -fno-exceptions -fno-rtti -o "$tmp/native" "$src" ;;
        *) gcc -w -O0 -o "$tmp/native" "$src" ;;
    esac
    # (the exit status is part of the output)
    capture "$tmp/expected.txt" "$tmp/native" one two
    capture "$tmp/js.txt" node run-js.js "$src"
    node build-x64.js "$src" "$tmp/prog.elf" || true
    capture "$tmp/x64.txt" "$tmp/loader" "$tmp/prog.elf"
    for backend in js x64; do
        if cmp -s "$tmp/expected.txt" "$tmp/$backend.txt"; then
            echo "ok   $src ($backend)"
        else
            echo "FAIL $src ($backend)"; diff "$tmp/expected.txt" "$tmp/$backend.txt" | head -20; status=1
        fi
    done
done
for t in ../templates/*/; do
    name=$(basename "$t"); [ "$name" = _shared ] && continue
    node -e "
      for (const f of ['mcc-front.js','mcc-cpp.js','sdk.js','mcc-js.js','mcc-x64.js']) require('$PWD/../' + f);
      const fs = require('fs');
      const files = { 'font.h': fs.readFileSync('../templates/_shared/font.h', 'utf8') };
      for (const f of fs.readdirSync('$t')) files[f] = fs.readFileSync('$t/' + f, 'utf8');
      MCC.compileJS(files, MCC.SDK); MCC.compileX64(files, MCC.SDK);
    " && echo "ok   template $name" || { echo "FAIL template $name"; status=1; }
done
exit $status
