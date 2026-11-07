#!/usr/bin/env bash
# Two genuinely empty source trees; never deletes a caller's directory.
set -eu
if [ "$#" -ne 4 ]; then
  echo 'usage: rebuild.sh <icarus-git-dir> <emsdk-dir> <new-build-root> <new-output-root>' >&2
  exit 2
fi
scripts=$(cd "$(dirname "$0")" && pwd)
repo=$(realpath "$1")
sdk=$(realpath "$2")
test ! -e "$3"
test ! -e "$4"
mkdir -p "$3" "$4"
work=$(realpath "$3")
out=$(realpath "$4")
LC_ALL=C dpkg-query -W > "$out/ubuntu-packages.actual"
cmp "$scripts/ubuntu-packages.lock" "$out/ubuntu-packages.actual"
commit=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["icarus"]["commit"])' "$scripts/toolchain.lock.json")
test "$(git -C "$repo" rev-parse "$commit")" = "$commit"
for name in a b; do
  mkdir "$work/$name"
  git -C "$repo" archive "$commit" | tar -x -C "$work/$name"
  python3 "$scripts/port.py" "$work/$name"
  bash "$scripts/build-port.sh" "$work/$name" "$sdk" "$out/$name" > "$out/$name.log" 2>&1
done
cmp "$out/a/checksums.txt" "$out/b/checksums.txt"
printf '%s\n' 'Both clean build resource manifests match byte for byte.'
