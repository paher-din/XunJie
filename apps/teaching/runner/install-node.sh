#!/bin/sh
set -eu
base=/opt/xunjie-runner
for file in "$base/config.json" /etc/systemd/system/xunjie-c1-docker.service /etc/systemd/system/xunjie-c1.socket /etc/systemd/system/xunjie-c1.service; do
  [ ! -e "$file" ] || { echo 'Node configuration already exists; inspect instead of overwriting'; exit 1; }
done
mkdir -p "$base/state" "$base/state/jobs" "$base/cli-config"
chmod 700 "$base/state" "$base/cli-config"
cat > /etc/systemd/system/xunjie-c1-docker.service <<'UNIT'
[Unit]
Description=XunJie dedicated container Engine
After=network.target
[Service]
Environment=PATH=/opt/xunjie-runner/engine:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/opt/xunjie-runner/engine/dockerd --host=unix:///run/xunjie-c1-docker.sock --data-root=/opt/xunjie-runner/data --exec-root=/run/xunjie-c1-docker --pidfile=/run/xunjie-c1-docker.pid --bridge=none --iptables=false --ip6tables=false --ip-forward=false --ip-masq=false --storage-driver=overlay2
Restart=on-failure
TimeoutStopSec=60
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/xunjie-c1.socket <<'UNIT'
[Unit]
Description=XunJie private control socket
[Socket]
ListenStream=/run/xunjie-c1/control.sock
SocketMode=0600
DirectoryMode=0700
[Install]
WantedBy=sockets.target
UNIT
cat > /etc/systemd/system/xunjie-c1.service <<'UNIT'
[Unit]
Description=XunJie single-writer runner control
Requires=xunjie-c1.socket
After=xunjie-c1-docker.service
[Service]
ExecStart=/usr/bin/flock --no-fork --nonblock /opt/xunjie-runner/state/controller.lock /opt/xunjie-runner/node/bin/node /opt/xunjie-runner/source/runner/controller.ts /opt/xunjie-runner/config.json
Restart=on-failure
RestartSec=1
UNIT
chmod 644 /etc/systemd/system/xunjie-c1*.service /etc/systemd/system/xunjie-c1.socket
"$base/node/bin/node" --input-type=module -e '
import {writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
const runtime=execFileSync("/opt/xunjie-runner/engine/docker",["--host=unix:///run/xunjie-c1-docker.sock","image","inspect","--format","{{.Id}}","xunjie-c1/runtime:guest"],{encoding:"utf8"}).trim();
if(!/^sha256:[0-9a-f]{64}$/.test(runtime))throw Error("Runtime image not recorded");
writeFileSync("/opt/xunjie-runner/config.json",JSON.stringify({
node:"/opt/xunjie-runner/node/bin/node",source:"/opt/xunjie-runner/source/runner",
state:"/opt/xunjie-runner/state",socket:"/run/xunjie-c1/control.sock",validation:"/opt/xunjie-runner/state/validation.json",
dockerBinary:"/opt/xunjie-runner/engine/docker",dockerSocket:"/run/xunjie-c1-docker.sock",cliConfig:"/opt/xunjie-runner/cli-config",generation:randomUUID(),
profile:{runtimeProfileVersion:"c17-gcc15.3.0-textscope-v1",imageDigest:"sha256:980e5c2310bee44d11ee46964174cc11dfea822ba60f0d050d2161d63b64b8f5",
compilerImage:"sha256:9f14e671a09bc195b93ca39524b8dcf401bc832b0c520e462327ce94986799aa",runtimeImage:runtime,approvedResultFiles:["report.txt"]}
}),{flag:"wx",mode:0o600});
'
systemctl daemon-reload
systemctl enable xunjie-c1-docker.service xunjie-c1.socket
systemctl start xunjie-c1.socket
echo 'C1 private control installed; readiness remains false until validation.'
