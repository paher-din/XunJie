#!/bin/bash
# Frozen 9fa76ad material retains apps/teaching; current checkout entrypoints use apps/server.
set -euo pipefail
umask 077

# Authorized Robert-local synthetic C1 only. PAHER disks, keys, databases and
# validation records are never imported. A new local node must earn readiness.
base=/opt/xunjie-runner
retained=/mnt/d/XunJie_Project/i0-ui55-connection/hdl-ui/local-environment
source_hash=7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852

checked_copy() {
  local from="$1" to="$2" expected="$3"
  [ -f "$from" ] && [ ! -L "$from" ]
  [ "$(sha256sum "$from" | cut -d' ' -f1)" = "$expected" ] || { echo 'Public material hash mismatch' >&2; exit 1; }
  if [ -e "$to" ]; then
    [ -f "$to" ] && [ ! -L "$to" ] && [ "$(sha256sum "$to" | cut -d' ' -f1)" = "$expected" ] || exit 1
  else
    cp --update=none "$from" "$to"
  fi
}

case "${1:-}" in
host)
  [ "$(id -u)" = 0 ]
  if [ -e "$base" ]; then
    [ -f "$base/.robert-local-c1" ] && [ ! -L "$base" ] || { echo 'Unowned node prefix exists' >&2; exit 1; }
  else
    mkdir -m 700 "$base"
    printf 'Robert local synthetic C1 2026-10-14\n' > "$base/.robert-local-c1"
  fi
  mkdir -p "$base/downloads" "$base/vm/images" "$base/vm/state" "$base/vm/keys" "$base/logs"
  checked_copy "$retained/downloads/node-v24.21.0-linux-x64.tar.xz" "$base/downloads/node-v24.21.0-linux-x64.tar.xz" fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
  checked_copy "$retained/downloads/docker-29.8.2.tgz" "$base/downloads/docker-29.8.2.tgz" 995d1ef289677f74fd58d8d2c35727b6a4ee389c69db8638a3e42d0487aa5b0f
  checked_copy "$retained/downloads/noble-20260926-amd64.img" "$base/vm/images/noble-20260926-amd64.img" 6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2
  checked_copy "$retained/runner-frozen-9fa76ad.tar" "$base/downloads/runner-frozen-9fa76ad.tar" cfc0ab0c4b931cb012e39888491d138446d4f9bcfd98504949be63fd099a3468
  if [ ! -e "$base/node" ]; then
    mkdir -m 700 "$base/node"
    tar -xJf "$base/downloads/node-v24.21.0-linux-x64.tar.xz" -C "$base/node" --strip-components=1
  fi
  [ "$("$base/node/bin/node" --version)" = v24.21.0 ]
  export DEBIAN_FRONTEND=noninteractive
  apt-get -s --no-remove --no-upgrade --no-install-recommends install qemu-system-x86=1:8.2.2+ds-0ubuntu1.16 qemu-utils=1:8.2.2+ds-0ubuntu1.16 cloud-image-utils=0.33-1
  apt-get -y --no-remove --no-upgrade --no-install-recommends install qemu-system-x86=1:8.2.2+ds-0ubuntu1.16 qemu-utils=1:8.2.2+ds-0ubuntu1.16 cloud-image-utils=0.33-1
  if [ ! -e "$base/frozen-source" ]; then
    mkdir -m 700 "$base/frozen-source"
    tar -xf "$base/downloads/runner-frozen-9fa76ad.tar" -C "$base/frozen-source"
  fi
  "$base/node/bin/node" --input-type=module - "$base/frozen-source/apps/teaching/runner" "$source_hash" <<'NODE'
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const [source,expected]=process.argv.slice(2); const sha=b=>createHash('sha256').update(b).digest('hex');
const files=readdirSync(source).filter(n=>(n.endsWith('.ts')&&!n.endsWith('.test.ts'))||(n.startsWith('hdl-')&&n.endsWith('.c'))||n==='hdl.Dockerfile'||n==='hdl.apparmor').sort();
const pairs=files.map(n=>[n,sha(readFileSync(join(source,n)))]);
for(const n of ['index.ts','hdl.ts'])pairs.push(['contracts/runner/'+n,sha(readFileSync(join(source,'../contracts/runner',n)))]);
const actual=sha(JSON.stringify(pairs));if(pairs.length!==34||actual!==expected)throw Error('Frozen runner mismatch');
console.log(JSON.stringify({sourceFiles:pairs.length,sourceHash:actual,node:process.version}));
NODE
  echo "Host Node ready: $base/node/bin/node"
  ;;
vm)
  [ -f "$base/.robert-local-c1" ] && [ -c /dev/kvm ]
  ! ss -ltnH 'sport = :2222' | grep -q . || { echo 'Local port2222 occupied' >&2; exit 1; }
  [ ! -e "$base/vm/state/guest.qcow2" ] && [ ! -e "$base/vm/state/seed.iso" ]
  for role in maintenance application; do
    [ ! -e "$base/vm/keys/$role" ]
    ssh-keygen -q -t ed25519 -N '' -C "xunjie-robert-local-$role" -f "$base/vm/keys/$role"
    chmod 600 "$base/vm/keys/$role" "$base/vm/keys/$role.pub"
  done
  qemu-img create -f qcow2 -F qcow2 -b "$base/vm/images/noble-20260926-amd64.img" "$base/vm/state/guest.qcow2" 20G
  maintenance=$(cat "$base/vm/keys/maintenance.pub")
  application=$(cat "$base/vm/keys/application.pub")
  cat > "$base/vm/state/user-data" <<CLOUD
#cloud-config
hostname: xunjie-c1-robert
manage_etc_hosts: true
disable_root: false
ssh_pwauth: false
users:
  - name: root
    lock_passwd: true
    ssh_authorized_keys:
      - 'no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $maintenance'
      - 'no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,command="/opt/xunjie-runner/node/bin/node /opt/xunjie-runner/source/runner/ssh-control.ts application" $application'
write_files:
  - path: /etc/ssh/sshd_config.d/10-xunjie-local.conf
    owner: root:root
    permissions: '0600'
    content: |
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      PermitRootLogin prohibit-password
      AllowUsers root
      AllowTcpForwarding no
      X11Forwarding no
      PermitTTY no
runcmd:
  - [systemctl, restart, ssh]
  - [sh, -c, 'echo XUNJIE_LOCAL_HOST_ED25519_BEGIN; cat /etc/ssh/ssh_host_ed25519_key.pub; echo XUNJIE_LOCAL_HOST_ED25519_END']
CLOUD
  printf 'instance-id: xunjie-robert-local-20261014\nlocal-hostname: xunjie-c1-robert\n' > "$base/vm/state/meta-data"
  cloud-localds "$base/vm/state/seed.iso" "$base/vm/state/user-data" "$base/vm/state/meta-data"
  # Original vm.sh requires a pin-file before boot; keep it empty until the
  # guest public host key is obtained through the owned serial channel.
  : > "$base/vm/keys/known_hosts"
  /bin/sh "$base/frozen-source/apps/teaching/runner/vm.sh" start
  ;;
pin)
  [ -f "$base/.robert-local-c1" ]
  "$base/node/bin/node" --input-type=module - "$base/vm/state/serial.log" "$base/vm/keys/known_hosts" <<'NODE'
import {readFileSync,writeFileSync} from 'node:fs';
const [serial,destination]=process.argv.slice(2);const text=readFileSync(serial,'utf8');
const match=text.match(/XUNJIE_LOCAL_HOST_ED25519_BEGIN[\s\S]*?(ssh-ed25519 [A-Za-z0-9+/=]+)[^\n]*[\s\S]*?XUNJIE_LOCAL_HOST_ED25519_END/);
if(!match)throw Error('Owned boot channel has not reported the guest host key');
const line='[127.0.0.1]:2222 '+match[1]+'\n';const previous=readFileSync(destination,'utf8');
if(previous&&previous!==line)throw Error('Guest host identity changed; do not overwrite the pin');
if(!previous)writeFileSync(destination,line,{mode:0o600});console.log('Guest public host identity pinned from owned serial channel');
NODE
  ssh-keygen -lf "$base/vm/keys/known_hosts"
  ;;
guest)
  [ -f "$base/.robert-local-c1" ] && [ -s "$base/vm/keys/known_hosts" ]
  ssh=(/usr/bin/ssh -i "$base/vm/keys/maintenance" -o "UserKnownHostsFile=$base/vm/keys/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -p 2222 root@127.0.0.1)
  "${ssh[@]}" 'umask 077; test ! -e /opt/xunjie-runner; mkdir -m 700 /opt/xunjie-runner /opt/xunjie-runner/downloads; printf "Robert local synthetic C1 2026-10-14\n" > /opt/xunjie-runner/.robert-local-c1'
  for name in node-v24.21.0-linux-x64.tar.xz docker-29.8.2.tgz; do
    cat "$base/downloads/$name" | "${ssh[@]}" "cat > '$base/downloads/$name'"
  done
  cat "$base/downloads/runner-frozen-9fa76ad.tar" | "${ssh[@]}" "cat > '$base/downloads/runner-frozen-9fa76ad.tar'"
  cat "$(dirname "$0")/local-node-setup.guest.sh" | "${ssh[@]}" "cat > '$base/local-node-setup.guest.sh'; chmod 600 '$base/local-node-setup.guest.sh'"
  "${ssh[@]}" "/bin/bash '$base/local-node-setup.guest.sh' runtimes"
  ;;
fixtures)
  [ -f "$base/.robert-local-c1" ] && [ -s "$base/vm/keys/known_hosts" ]
  fixture="$base/frozen-source/apps/teaching/tests/fixtures/hdl-board.ts"
  [ "$(sha256sum "$fixture" | cut -d' ' -f1)" = e3bd99d5257524453015ca83c1370ba801b5b929af1a89e1b859c78c96426334 ]
  ssh=(/usr/bin/ssh -i "$base/vm/keys/maintenance" -o "UserKnownHostsFile=$base/vm/keys/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -p 2222 root@127.0.0.1)
  "${ssh[@]}" 'umask 077; mkdir -p /opt/xunjie-runner/source/tests/fixtures /opt/xunjie-runner/source-dlc/tests/fixtures'
  for source in source source-dlc; do
    cat "$fixture" | "${ssh[@]}" "cat > '$base/$source/tests/fixtures/hdl-board.ts'; chmod 600 '$base/$source/tests/fixtures/hdl-board.ts'"
  done
  echo 'Original public HDL fixture placed beside both frozen runner copies; source fingerprint unchanged.'
  ;;
install|hdl-install|hdl-acceptance)
  [ -f "$base/.robert-local-c1" ] && [ -s "$base/vm/keys/known_hosts" ]
  ssh=(/usr/bin/ssh -i "$base/vm/keys/maintenance" -o "UserKnownHostsFile=$base/vm/keys/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -p 2222 root@127.0.0.1)
  cat "$(dirname "$0")/local-node-setup.guest.sh" | "${ssh[@]}" "cat > '$base/local-node-setup.guest.sh'; chmod 600 '$base/local-node-setup.guest.sh'"
  "${ssh[@]}" "/bin/bash '$base/local-node-setup.guest.sh' '$1'"
  ;;
c-acceptance)
  [ -f "$base/.robert-local-c1" ]
  cd "$base/frozen-source"
  "$base/node/bin/node" apps/teaching/runner/acceptance.ts
  ;;
status)
  [ -f "$base/.robert-local-c1" ]
  qemu-system-x86_64 --version | sed -n '1p'
  systemctl show xunjie-c1-vm.service --property=ActiveState,SubState,MainPID
  stat -c '%a %n' "$base/vm/keys" "$base/vm/keys/maintenance" "$base/vm/keys/application" "$base/vm/keys/known_hosts"
  /usr/bin/ssh -i "$base/vm/keys/maintenance" -o "UserKnownHostsFile=$base/vm/keys/known_hosts" \
    -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=5 -p 2222 root@127.0.0.1 \
    "uname -r; df -BG /; stat -c '%a %n' /root/.ssh /root/.ssh/authorized_keys /opt/xunjie-runner/config.json /opt/xunjie-runner/config.dlc.robert.json; if findmnt -rn -t 9p,virtiofs,drvfs; then exit 1; fi"
  ;;
retain-logs)
  [ -f "$base/.robert-local-c1" ]
  mkdir -p "$retained/node-logs/original-c" "$retained/node-logs/original-hdl"
  for cache in "$base/frozen-source/node_modules/.cache"/c1-acceptance-*; do
    [ -d "$cache" ] && [ ! -L "$cache" ]
    destination="$retained/node-logs/original-c/$(basename "$cache")"
    mkdir -p "$destination"
    for log in "$cache"/*.txt "$cache"/validation.json; do
      [ ! -f "$log" ] || cp --update=none "$log" "$destination/"
    done
  done
  ssh=(/usr/bin/ssh -i "$base/vm/keys/maintenance" -o "UserKnownHostsFile=$base/vm/keys/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -p 2222 root@127.0.0.1)
  while read -r directory; do
    [[ "$directory" =~ ^acceptance-[0-9]+$ ]] || { echo 'Unexpected acceptance log directory' >&2; exit 1; }
    "${ssh[@]}" "tar -cf - -C /opt/xunjie-runner/state/hdl '$directory'" | tar -xf - -C "$retained/node-logs/original-hdl"
  done < <("${ssh[@]}" "find /opt/xunjie-runner/state/hdl -maxdepth 1 -type d -name 'acceptance-*' -printf '%f\\n'")
  "${ssh[@]}" 'cat /opt/xunjie-runner/state/hdl/validation.jsonl' > "$retained/node-logs/original-hdl/validation.jsonl"
  echo 'Original synthetic acceptance output bytes retained locally; no keys or application data copied.'
  ;;
*) echo 'Usage: local-node-setup.sh host|vm|pin|guest|fixtures|install|c-acceptance|hdl-install|hdl-acceptance|status|retain-logs' >&2; exit 1 ;;
esac
