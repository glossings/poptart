#!/bin/sh
# Builds the poptart-midi CoreMIDI helper as a universal (arm64 + x86_64) binary.
#
# The OUTPUT IS COMMITTED, like poptart-audio's (see build.sh): installing poptart needs no Swift
# toolchain. Run this after editing poptart-midi.swift and commit `bin/poptart-midi` with it.
set -eu

dir=$(cd "$(dirname "$0")" && pwd)
out="$dir/bin/poptart-midi"
mkdir -p "$dir/bin"

echo "building $out (arm64 + x86_64)"
swiftc -O \
  -target arm64-apple-macos11 \
  -framework CoreMIDI -framework Foundation \
  -o "$dir/.poptart-midi-arm64" "$dir/poptart-midi.swift"
swiftc -O \
  -target x86_64-apple-macos11 \
  -framework CoreMIDI -framework Foundation \
  -o "$dir/.poptart-midi-x86_64" "$dir/poptart-midi.swift"

lipo -create -output "$out" "$dir/.poptart-midi-arm64" "$dir/.poptart-midi-x86_64"
rm -f "$dir/.poptart-midi-arm64" "$dir/.poptart-midi-x86_64"
chmod +x "$out"

echo "built:"
lipo -info "$out"
printf 'list\nquit\n' | "$out" | grep -q '^devices' && echo "smoke test: list ok"
