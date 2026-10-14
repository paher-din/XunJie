#!/bin/bash
set -euo pipefail
umask 077
base=/opt/xunjie-runner
[ "$(id -u)" = 0 ] && [ -f "$base/.robert-local-c1" ]

case "${1:-}" in
runtimes)
  [ ! -e "$base/node" ] && [ ! -e "$base/engine" ] && [ ! -e "$base/source" ]
  mkdir -m 700 "$base/node" "$base/engine" "$base/source" "$base/source-dlc" "$base/state" "$base/cli-config" "$base/hdl-input"
  tar -xJf "$base/downloads/node-v24.21.0-linux-x64.tar.xz" -C "$base/node" --strip-components=1
  tar -xzf "$base/downloads/docker-29.8.2.tgz" -C "$base/engine" --strip-components=1
  mkdir -m 700 "$base/source-import"
  tar -xf "$base/downloads/runner-frozen-9fa76ad.tar" -C "$base/source-import"
  cp -a "$base/source-import/apps/teaching/runner" "$base/source-import/apps/teaching/contracts" "$base/source/"
  cp -a "$base/source-import/apps/teaching/runner" "$base/source-import/apps/teaching/contracts" "$base/source-dlc/"
  [ "$("$base/node/bin/node" --version)" = v24.21.0 ]
  "$base/engine/docker" --version
  command -v apparmor_parser
  [ "$(stat -f -c %T /sys/fs/cgroup)" = cgroup2fs ]
  [ -z "$(swapon --noheadings)" ]
  ! findmnt -rn -t 9p,virtiofs,drvfs | grep -q .
  # Preserve the exact approved policy bytes and make the new guest reload it.
  [ ! -e /etc/apparmor.d/xunjie-dlc-v1 ]
  install -m 644 "$base/source-dlc/runner/hdl.apparmor" /etc/apparmor.d/xunjie-dlc-v1
  apparmor_parser -r -W /etc/apparmor.d/xunjie-dlc-v1
  grep -Fx 'xunjie-dlc-v1 (enforce)' /sys/kernel/security/apparmor/profiles
  systemd-run --unit=xunjie-c1-engine-prepare --property=Restart=no --property=TimeoutStopSec=60 \
    --setenv=PATH=/opt/xunjie-runner/engine:/usr/sbin:/usr/bin:/sbin:/bin \
    "$base/engine/dockerd" --host=unix:///run/xunjie-c1-docker.sock --data-root="$base/data" \
    --exec-root=/run/xunjie-c1-docker --pidfile=/run/xunjie-c1-docker.pid \
    --bridge=none --iptables=false --ip6tables=false --ip-forward=false --ip-masq=false --storage-driver=overlay2
  echo 'Guest runtimes prepared; original OCI imports and current acceptance are still required.'
  ;;
install)
  [ ! -e "$base/config.json" ]
  docker=("$base/engine/docker" --host=unix:///run/xunjie-c1-docker.sock --config="$base/cli-config")
  for image in sha256:9f14e671a09bc195b93ca39524b8dcf401bc832b0c520e462327ce94986799aa \
    sha256:765d51df494104de704bbecfdfdd42945077ea4c8f11fb49f91e9dca27a6fe99 \
    sha256:6a0e6ee8ab6bffc7a4fc999c5dbdcf68f058ed04cb13f053730e7209e3efad0d \
    sha256:6a3c202ccc35152020f156ad4d9665f08cb45ff9893fe5c51b6be9e788243ca5; do
    [ "$("${docker[@]}" image inspect --format '{{.Id}}' "$image")" = "$image" ]
    [ "$("${docker[@]}" image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" = linux/amd64 ]
  done
  "${docker[@]}" tag sha256:765d51df494104de704bbecfdfdd42945077ea4c8f11fb49f91e9dca27a6fe99 xunjie-c1/runtime:guest
  "${docker[@]}" tag sha256:6a0e6ee8ab6bffc7a4fc999c5dbdcf68f058ed04cb13f053730e7209e3efad0d xunjie-dlc/build:approved
  "${docker[@]}" tag sha256:6a3c202ccc35152020f156ad4d9665f08cb45ff9893fe5c51b6be9e788243ca5 xunjie-dlc/runtime:approved
  /bin/sh "$base/source/runner/install-node.sh"
  systemctl stop xunjie-c1-engine-prepare.service
  systemctl start xunjie-c1-docker.service
  systemctl start xunjie-c1.service
  systemctl is-active xunjie-c1-docker.service xunjie-c1.socket xunjie-c1.service
  ;;
hdl-install)
  [ -f "$base/config.json" ]
  mkdir -p "$base/hdl-input"
  chmod 700 "$base/hdl-input"
  if [ ! -e "$base/config.dlc.robert.json" ]; then
    "$base/node/bin/node" "$base/source-dlc/runner/hdl-prepare.ts" "$base/config.json" "$base/config.dlc.robert.json" "$base/source-dlc/runner"
  fi
  "$base/node/bin/node" --input-type=module - "$base/config.dlc.robert.json" <<'NODE'
import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(config.source!=='/opt/xunjie-runner/source-dlc/runner'
  ||config.hdl.sourceHash!=='7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852'
  ||config.hdl.runtimeProfileVersion!=='hdl-iverilog12-nexys4ddr-v1'
  ||config.hdl.engineVersion!=='iverilog-12.0-ubuntu-12.0-2build2'
  ||config.hdl.buildImage!=='sha256:6a0e6ee8ab6bffc7a4fc999c5dbdcf68f058ed04cb13f053730e7209e3efad0d'
  ||config.hdl.runtimeImage!=='sha256:6a3c202ccc35152020f156ad4d9665f08cb45ff9893fe5c51b6be9e788243ca5')throw Error('Original prepared HDL identity changed');
NODE
  /bin/sh "$base/source-dlc/runner/hdl-install.sh" "$base/config.dlc.robert.json"
  systemctl is-active xunjie-c1-docker.service xunjie-c1.socket xunjie-c1.service
  ;;
hdl-acceptance)
  # The original SSH acceptance command uses umask022. Its public synthetic
  # C snapshots are read by UID65534. Do not inherit the secret-preparation
  # umask077 into that fixture; existing private files retain their modes.
  umask 022
  "$base/node/bin/node" "$base/source-dlc/runner/hdl-acceptance.ts" "$base/config.dlc.robert.json"
  ;;
*) echo 'Usage: local-node-setup.guest.sh runtimes|install|hdl-install|hdl-acceptance' >&2; exit 1 ;;
esac
