#!/usr/bin/env bash
# Host-only verification entry. The approved Node runtime is not installed on Windows and
# better-sqlite3@13.0.3 has no Windows prebuild, so this syncs the checkout to the WSL Linux
# filesystem (native timestamps, as the README requires), installs the exact lock dependencies
# and runs the command passed to it.
set -eu
NODE_HOME="${XUNJIE_NODE_HOME:-$HOME/xunjie-node/node-v24.21.0-linux-x64}"
if [ ! -x "$NODE_HOME/bin/node" ]; then
  mkdir -p "$HOME/xunjie-node"
  cd "$HOME/xunjie-node"
  curl -sSL -o node.tar.xz https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
  tar -xf node.tar.xz
fi
export PATH="$NODE_HOME/bin:$PATH"
export npm_config_userconfig="$HOME/.npmrc-xunjie-empty"
: > "$npm_config_userconfig"
SOURCE=/mnt/d/XunJie/apps/teaching
TARGET="${XUNJIE_WSL_WORKDIR:-$HOME/xunjie-c3}"
mkdir -p "$TARGET"
tar -C "$SOURCE" --exclude=node_modules --exclude=dist -cf - . | tar -C "$TARGET" -xf -
cd "$TARGET"
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi
BINDING=node_modules/better-sqlite3/build/Release/better_sqlite3.node
if [ ! -f "$BINDING" ]; then
  # better-sqlite3 13.0.3 publishes no prebuild for this Node ABI, and its binding.gyp skips the
  # real target unless force_build is set, so build it explicitly from source.
  NODE_GYP="$NODE_HOME/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
  ( cd node_modules/better-sqlite3 && rm -rf build && node "$NODE_GYP" rebuild --release --force_build=1 )
fi
echo "node $(node --version) npm $(npm --version) cwd $TARGET binding=$([ -f "$BINDING" ] && echo yes || echo no)"
exec "$@"
