#!/bin/sh
set -eu
base=/opt/xunjie-runner
config="${1:?approved non-secret config required}"
source="$base/source-dlc/runner"
case "$config" in "$base"/config.dlc*.json) ;; *) echo 'Prepared dedicated node config required' >&2; exit 1 ;; esac
override=/etc/systemd/system/xunjie-c1.service.d/dlc.conf
[ ! -e "$override" ] || { echo 'Existing override: inspect instead of overwriting' >&2; exit 1; }
[ -f "$config" ] && [ ! -L "$config" ]
apparmor_parser -r -W "$source/hdl.apparmor"
mkdir -p /etc/systemd/system/xunjie-c1.service.d
cp -n "$base/source/runner/ssh-control.ts" "$base/hdl-input/ssh-control.before-dlc.ts"
cp "$source/ssh-control.ts" "$base/source/runner/ssh-control.ts"
cat > "$override" <<UNIT
[Service]
ExecStart=
ExecStart=/usr/bin/flock --no-fork --nonblock $base/state/controller.lock $base/node/bin/node $source/controller.ts $config
UNIT
systemctl daemon-reload
systemctl restart xunjie-c1.service
echo 'Same authenticated C1 control entry extended; no credentials changed. HDL readiness requires current validation.'
