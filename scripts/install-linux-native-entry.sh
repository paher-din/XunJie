#!/bin/sh
# Install the Linux restricted native-session entry on a school execution node.
#
# Run once as root during deployment (or with sudo). It installs the fixed entry script, the
# isolation probe, a single-prefix sudoers rule and the writable session root, then runs the probe
# inside the real unit and prints the isolation fact. A failed probe leaves nothing to guess about:
# the product will refuse to start native sessions on this host.
set -eu

RUN_USER=xunjie
WORK_ROOT=/var/lib/xunjie-native
NODE_ROOT=/opt/xunjie
STATE_ROOT=/var/lib/xunjie
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENTRY_DIR=$SELF_DIR/linux
[ -d "$ENTRY_DIR" ] || ENTRY_DIR=$SELF_DIR

while [ "$#" -gt 0 ]; do
  case "$1" in
    --user) RUN_USER=${2:?}; shift 2 ;;
    --work-root) WORK_ROOT=${2:?}; shift 2 ;;
    --node-root) NODE_ROOT=${2:?}; shift 2 ;;
    --state-root) STATE_ROOT=${2:?}; shift 2 ;;
    -h|--help)
      printf '%s\n' "usage: $0 [--user NAME] [--work-root DIR] [--node-root DIR] [--state-root DIR]" ; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 64 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { printf 'must run as root (use sudo)\n' >&2; exit 77; }
printf '%s' "$RUN_USER" | grep -Eq '^[a-z_][a-z0-9_-]*[$]?$' || { printf 'invalid run user\n' >&2; exit 64; }
id "$RUN_USER" >/dev/null 2>&1 || { printf 'run user does not exist: %s\n' "$RUN_USER" >&2; exit 64; }
[ "$(id -u "$RUN_USER")" -ne 0 ] || { printf 'session user must not be root\n' >&2; exit 64; }
printf '%s' "$WORK_ROOT" | grep -Eq '^/[A-Za-z0-9/_.-]+$' || { printf 'invalid work root\n' >&2; exit 64; }
printf '%s' "$NODE_ROOT" | grep -Eq '^/[A-Za-z0-9/_.-]+$' || { printf 'invalid node root\n' >&2; exit 64; }
printf '%s' "$STATE_ROOT" | grep -Eq '^/[A-Za-z0-9/_.-]+$' || { printf 'invalid state root\n' >&2; exit 64; }
[ -d "$STATE_ROOT" ] || { printf 'state root does not exist: %s\n' "$STATE_ROOT" >&2; exit 64; }
case "$STATE_ROOT" in "$WORK_ROOT"*) printf 'state root must not live under the work root\n' >&2; exit 64 ;; esac

install -d -m 0755 /usr/local/lib/xunjie /etc/xunjie
install -d -m 0750 -o "$RUN_USER" -g "$RUN_USER" "$WORK_ROOT"
install -m 0755 "$ENTRY_DIR/native-session-entry" /usr/local/lib/xunjie/native-session-entry
install -m 0644 "$ENTRY_DIR/native-session-probe.mjs" /usr/local/lib/xunjie/native-session-probe.mjs
install -m 0644 "$ENTRY_DIR/native-session-listener.mjs" /usr/local/lib/xunjie/native-session-listener.mjs
cat > /etc/xunjie/native-session.conf <<EOF
XJ_RUN_USER=$RUN_USER
XJ_WORK_ROOT=$WORK_ROOT
XJ_NODE_ROOT=$NODE_ROOT
XJ_STATE_ROOT=$STATE_ROOT
EOF
chmod 0644 /etc/xunjie/native-session.conf

SUDOERS=/etc/sudoers.d/xunjie-native-session
printf '%s ALL=(root) NOPASSWD: /usr/local/lib/xunjie/native-session-entry\n' "$RUN_USER" > "$SUDOERS"
chmod 0440 "$SUDOERS"
visudo -cf "$SUDOERS" >/dev/null || { printf 'sudoers rule rejected\n' >&2; rm -f "$SUDOERS"; exit 65; }

NODE=$(find "$NODE_ROOT" -maxdepth 4 -type f -name node -perm -u+x 2>/dev/null | head -1)
[ -n "$NODE" ] || { printf 'no node executable under %s\n' "$NODE_ROOT" >&2; exit 66; }

UNIT=xj-session-$(cat /proc/sys/kernel/random/uuid)
PROBE_WORK=$(mktemp -d "$WORK_ROOT/session-XXXXXXXX")
chown "$RUN_USER:$RUN_USER" "$PROBE_WORK"
trap 'rm -rf "$PROBE_WORK"' EXIT INT TERM

printf 'entry=%s\nnode=%s\nwork=%s\nunit=%s\n' /usr/local/lib/xunjie/native-session-entry "$NODE" "$PROBE_WORK" "$UNIT"
# Run through the same sudoers rule the product uses, so a permissive root shell cannot hide a
# missing NOPASSWD grant.
su -s /bin/sh "$RUN_USER" -c "sudo -n /usr/local/lib/xunjie/native-session-entry selftest '$UNIT' '$PROBE_WORK' '$NODE'"
