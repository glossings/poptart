#!/bin/sh
# Checks the Windows or Linux builds of poptart's two scsynth extensions (devices and keylock) as
# CI made them, before anything tests or ships them: each one is there, exports the entry points
# scsynth calls (load, api_version, server_type), and links no C++ runtime a user's machine may
# not have. Whether scsynth then LOADS it is the engine tests' question, not this script's.
#
# Run from anywhere, on the machine that built them. macOS's builds are committed and checked when
# they are made, so there it does nothing.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) folder=win32-x64; suffix=scx ;;
  Linux) folder=linux-x64; suffix=so ;;
  *) echo "check-plugins.sh: nothing to check on $(uname -s)"; exit 0 ;;
esac

for tool in $([ "$folder" = win32-x64 ] && echo llvm-objdump || echo nm readelf); do
  command -v "$tool" >/dev/null || { echo "::error::check-plugins.sh needs $tool"; exit 1; }
done

status=0
for f in "$here/devices/bin/$folder/PoptartDevices.$suffix" "$here/rubberband/bin/$folder/PoptartPitchShift.$suffix"; do
  if [ ! -f "$f" ]; then
    echo "::error title=Extension not built::$f is not there"
    status=1
    continue
  fi
  # Windows tools write CRLF into a pipe; the names are matched at the end of a line.
  if [ "$folder" = win32-x64 ]; then
    exports=$(llvm-objdump -p "$f" | tr -d '\r')
    needs=$(printf '%s\n' "$exports" | grep -i 'DLL Name' || true)
  else
    exports=$(nm -D --defined-only "$f")
    needs=$(readelf -d "$f" | grep NEEDED || true)
  fi
  for symbol in load api_version server_type; do
    if ! printf '%s\n' "$exports" | grep -Eq "[[:space:]]$symbol\$"; then
      echo "::error title=Extension cannot load::$f does not export $symbol, so scsynth will not load it"
      status=1
    fi
  done
  echo "$f: $(wc -c <"$f" | tr -d ' ') bytes, needs:"
  printf '%s\n' "$needs"
  if printf '%s\n' "$needs" | grep -Eiq 'vcruntime|msvcp|libstdc\+\+|libgcc_s'; then
    echo "::error title=Extension needs a runtime::$f links a C++ runtime dynamically; it is meant to carry its own"
    status=1
  fi
done
exit $status
