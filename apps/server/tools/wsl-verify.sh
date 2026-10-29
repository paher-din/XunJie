#!/usr/bin/env bash
# Verify a fresh Linux copy with an already prepared, approved runtime and exact dependencies.
set -eu
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_dir="${XUNJIE_NODE_HOME:-$HOME/xunjie-node/node-v24.21.0-linux-x64}"
dependencies_dir="${XUNJIE_WSL_DEPENDENCIES:-$HOME/xunjie-c3}"
if [ ! -x "$node_dir/bin/node" ] || [ ! -d "$dependencies_dir/node_modules" ]; then
  echo "Prepare the approved Node runtime and exact lock dependencies before verification." >&2
  exit 1
fi
export PATH="$node_dir/bin:$PATH"
node "$source_dir/tools/check-runtime.mjs"
cmp "$source_dir/package-lock.json" "$dependencies_dir/package-lock.json"
if [ -n "${XUNJIE_WSL_WORKDIR:-}" ]; then
  target_dir="$XUNJIE_WSL_WORKDIR"
  if [ -e "$target_dir" ]; then
    echo "Verification requires a new directory; existing results are preserved." >&2
    exit 1
  fi
  mkdir "$target_dir"
else
  target_dir="$(mktemp -d "${TMPDIR:-/tmp}/xunjie-c3-verify-XXXXXX")"
fi
tar -C "$source_dir" --exclude=node_modules --exclude=dist -cf - . | tar -C "$target_dir" -xf -
cp -a "$dependencies_dir/node_modules" "$target_dir/node_modules"
cd "$target_dir"
node -e 'require("better-sqlite3")'
echo "node $(node --version) cwd $target_dir"
exec "$@"
