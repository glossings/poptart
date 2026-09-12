#!/bin/sh
# Builds the poptart-link helper (poptart's Ableton Link peer) as a universal (arm64 + x86_64)
# binary.
#
# The OUTPUT IS COMMITTED (bin/poptart-link), so this script is for changing poptart-link.cpp or
# bumping the SDK - not for installing poptart. Same deal as the other two native builds:
# requiring a C++ toolchain on every machine that runs poptart would undo the "clone and npm
# install" story in PACKAGING.md.
#
# Sources it needs and fetches on first run (into .deps/, which is gitignored):
#   - the Ableton Link SDK (dual-licensed GPLv2+ / commercial; poptart is AGPL-3.0, and this is
#     a separate process, so the GPL half applies and the source is available either way)
#   - standalone asio, which Link carries as a git submodule and a source tarball therefore
#     leaves empty
# Point LINK_SRC / ASIO_SRC at existing checkouts to skip the downloads.
set -eu

dir=$(cd "$(dirname "$0")" && pwd)
deps="$dir/.deps"
out="$dir/bin/poptart-link"
LINK_VERSION=${LINK_VERSION:-3.1.5}
ASIO_VERSION=${ASIO_VERSION:-1-30-2}
mkdir -p "$deps" "$dir/bin"

if [ -z "${LINK_SRC:-}" ]; then
  LINK_SRC="$deps/link-Link-$LINK_VERSION"
  if [ ! -f "$LINK_SRC/include/ableton/Link.hpp" ]; then
    echo "fetching Ableton Link $LINK_VERSION"
    curl -sL "https://github.com/Ableton/link/archive/refs/tags/Link-$LINK_VERSION.tar.gz" | tar xz -C "$deps"
  fi
fi
if [ -z "${ASIO_SRC:-}" ]; then
  ASIO_SRC="$deps/asio-asio-$ASIO_VERSION/asio"
  if [ ! -f "$ASIO_SRC/include/asio.hpp" ]; then
    echo "fetching asio $ASIO_VERSION"
    curl -sL "https://github.com/chriskohlhoff/asio/archive/refs/tags/asio-$ASIO_VERSION.tar.gz" | tar xz -C "$deps"
  fi
fi

echo "building $out (arm64 + x86_64) against Link $LINK_VERSION / asio $ASIO_VERSION"
clang++ -O2 -std=c++14 \
  -arch arm64 -arch x86_64 -mmacosx-version-min=11 \
  -DNDEBUG -DASIO_STANDALONE -DLINK_PLATFORM_MACOSX=1 \
  -I"$LINK_SRC/include" -I"$ASIO_SRC/include" \
  -framework CoreFoundation \
  -o "$out" "$dir/poptart-link.cpp"
chmod +x "$out"

echo "built:"
lipo -info "$out"
