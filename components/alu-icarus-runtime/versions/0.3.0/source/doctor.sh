#!/usr/bin/env bash
# Check only: never installs packages, changes sudo policy, or activates a global SDK.
set -eu
missing=0
for tool in gcc g++ make autoconf automake gperf bison flex cmake ninja pkg-config git python3 curl unzip; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf 'OK %s\n' "$tool"
  else
    printf 'MISSING %s\n' "$tool"
    missing=1
  fi
done
for package in zlib1g-dev libbz2-dev; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -qx 'install ok installed'; then
    printf 'OK %s\n' "$package"
  else
    printf 'MISSING %s\n' "$package"
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  printf '%s\n' 'Install missing dependencies in Ubuntu; rerun this check before building.' >&2
  exit 1
fi
printf '%s\n' 'Host prerequisites ready. This does not verify Emscripten or a WASM release.'
