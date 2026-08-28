#!/bin/sh
# Builds the PoptartPitchShift scsynth extension as a universal (arm64 + x86_64) bundle.
#
# The OUTPUT IS COMMITTED (bin/PoptartPitchShift.scx), so this script is for changing
# PoptartPitchShift.cpp or bumping Rubber Band - not for installing poptart. Same deal as
# ../build.sh: requiring a C++ toolchain on every machine that runs poptart would undo the
# "clone and npm install" story. Run it after editing, and commit bin/ alongside.
#
# Sources it needs and fetches on first run (into .deps/, which is gitignored):
#   - the SuperCollider plugin headers, at the version the app bundle ships (SC_VERSION below)
#   - the Rubber Band Library source (GPL), built from its single-file amalgamation with the
#     vDSP FFT - the only link dependency is the Accelerate framework
# Point SC_SRC / RB_SRC at existing checkouts to skip the downloads.
set -eu

dir=$(cd "$(dirname "$0")" && pwd)
deps="$dir/.deps"
out="$dir/bin/PoptartPitchShift.scx"
SC_VERSION=${SC_VERSION:-3.14.1}
RB_VERSION=${RB_VERSION:-4.0.0}
mkdir -p "$deps" "$dir/bin"

if [ -z "${SC_SRC:-}" ]; then
  SC_SRC="$deps/supercollider-Version-$SC_VERSION"
  if [ ! -d "$SC_SRC/include/plugin_interface" ]; then
    echo "fetching SuperCollider $SC_VERSION headers"
    curl -sL "https://github.com/supercollider/supercollider/archive/refs/tags/Version-$SC_VERSION.tar.gz" \
      | tar xz -C "$deps" --include='*/include/*'
  fi
fi
if [ -z "${RB_SRC:-}" ]; then
  RB_SRC="$deps/rubberband-$RB_VERSION"
  if [ ! -f "$RB_SRC/single/RubberBandSingle.cpp" ]; then
    echo "fetching Rubber Band $RB_VERSION"
    curl -sL "https://github.com/breakfastquay/rubberband/archive/refs/tags/v$RB_VERSION.tar.gz" | tar xz -C "$deps"
  fi
fi

echo "building $out (arm64 + x86_64) against SC $SC_VERSION / Rubber Band $RB_VERSION"
clang++ -O3 -std=c++17 -fPIC \
  -arch arm64 -arch x86_64 -mmacosx-version-min=11 \
  -DSC_DARWIN -DNDEBUG \
  -I"$SC_SRC/include/plugin_interface" -I"$SC_SRC/include/common" -I"$SC_SRC/include/server" \
  -I"$RB_SRC" \
  -bundle -undefined dynamic_lookup -framework Accelerate \
  -o "$out" "$dir/PoptartPitchShift.cpp" "$RB_SRC/single/RubberBandSingle.cpp"

echo "built:"
lipo -info "$out"
