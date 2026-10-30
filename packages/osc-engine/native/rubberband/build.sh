#!/bin/sh
# Builds the PoptartPitchShift scsynth extension. The build itself is build.mjs beside this
# (the same on macOS, Windows and Linux); this stays so `native/rubberband/build.sh` keeps working.
set -eu
exec node "$(cd "$(dirname "$0")" && pwd)/build.mjs" "$@"
