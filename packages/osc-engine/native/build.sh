#!/bin/sh
# Builds the poptart-audio CoreAudio helper as a universal (arm64 + x86_64) binary.
#
# The OUTPUT IS COMMITTED, so this script is for changing poptart-audio.swift - not for installing
# poptart. That's deliberate: requiring the Swift toolchain on every machine that runs poptart would
# undo the whole "clone and npm install" story in PACKAGING.md. Run this after editing the source,
# and commit `bin/poptart-audio` alongside it.
#
# Deployment target matches what a universal binary needs to run on Intel Macs still on Big Sur.
set -eu

dir=$(cd "$(dirname "$0")" && pwd)
out="$dir/bin/poptart-audio"
mkdir -p "$dir/bin"

echo "building $out (arm64 + x86_64)"
swiftc -O \
  -target arm64-apple-macos11 \
  -framework CoreAudio -framework Foundation \
  -o "$dir/.poptart-audio-arm64" "$dir/poptart-audio.swift"
swiftc -O \
  -target x86_64-apple-macos11 \
  -framework CoreAudio -framework Foundation \
  -o "$dir/.poptart-audio-x86_64" "$dir/poptart-audio.swift"

lipo -create -output "$out" "$dir/.poptart-audio-arm64" "$dir/.poptart-audio-x86_64"
rm -f "$dir/.poptart-audio-arm64" "$dir/.poptart-audio-x86_64"
chmod +x "$out"

echo "built:"
lipo -info "$out"
"$out" list >/dev/null && echo "smoke test: list ok"
