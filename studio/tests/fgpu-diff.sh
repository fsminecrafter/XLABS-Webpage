#!/bin/sh
# Checks the preview's GPU (fgpu.js) against the Minimal-OS kernel's FGPU.
# Runs the 3D cube sample in the preview through every mode, records each
# SYS_GPU call, replays them through the kernel's fgpu_raster.c and
# fgpu_shader.c, and compares the frames.
#   studio/tests/fgpu-diff.sh path/to/Minimal-OS
set -e
os=${1:?usage: fgpu-diff.sh path/to/Minimal-OS}
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gcc -std=c11 -O2 -w -I "$os/src/intf" fgpu-replay.c "$os/src/modules/GPU/fgpu_raster.c" \
    "$os/src/modules/GPU/fgpu_shader.c" -lm -o "$tmp/replay"
# L three times (per-vertex, flat, shader), then wireframe on and off
node fgpu-record.js ../templates/cube/main.c "$tmp" "15@1500,15@3000,15@4500,26@6000,26@7000" 8000 > /dev/null
"$tmp/replay" "$tmp/gpu.log" "$tmp/kernel.raw" > /dev/null
node fgpu-compare.js "$tmp" 560 420
