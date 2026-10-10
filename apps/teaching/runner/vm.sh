#!/bin/sh
set -eu
base=/opt/xunjie-runner/vm
case "${1:-}" in
stop) systemctl stop xunjie-c1-vm.service; exit ;;
start) ;;
*) echo 'Usage: vm.sh start|stop (prepared dedicated WSL host only)'; exit 1 ;;
esac
if systemctl is-active --quiet xunjie-c1-vm.service; then echo 'C1 VM already active'; exit; fi
[ -c /dev/kvm ] || { echo 'KVM unavailable'; exit 1; }
for file in "$base/state/guest.qcow2" "$base/state/seed.iso" "$base/keys/known_hosts"; do
  [ -f "$file" ] && [ ! -L "$file" ] || { echo 'Approved VM preparation missing'; exit 1; }
done
systemd-run --unit=xunjie-c1-vm --property=Restart=no --property=NoNewPrivileges=yes \
  --property=ProtectSystem=strict --property=ProtectHome=yes --property="ReadWritePaths=$base/state" \
  --property="InaccessiblePaths=/mnt $base/keys" --property=CapabilityBoundingSet= \
  --property=DevicePolicy=closed --property='DeviceAllow=/dev/kvm rw' \
  /usr/bin/qemu-system-x86_64 -name xunjie-c1 -machine q35,accel=kvm -cpu host -smp 2 -m 4096 \
  -display none -serial "file:$base/state/serial.log" \
  -monitor "unix:$base/state/monitor.sock,server=on,wait=off" \
  -drive "file=$base/state/guest.qcow2,if=virtio,format=qcow2" \
  -drive "file=$base/state/seed.iso,media=cdrom,format=raw,readonly=on" \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22 -device virtio-net-pci,netdev=net0 -no-reboot
