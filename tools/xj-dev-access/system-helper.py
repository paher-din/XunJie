#!/usr/bin/python3
"""Fixed candidate-device operations. No caller-selected paths, users or commands."""
import base64
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import subprocess
import sys
import time

CONFIG = Path('/etc/xunjie-dev-access-candidate129/system.json')
KEYS = Path('/etc/ssh/xunjie-dev-access-candidate129/keys')
FRAGMENT = Path('/etc/ssh/sshd_config.d/62-xunjie-dev-access-candidate129.conf')
STATE = Path('/var/lib/xunjie-dev-access-candidate129-system')
PAGE_GROUP = 'xjd-c129-page'
NODE_GROUP = 'xjd-c129-node'


def ensure(condition, code):
    if not condition:
        raise ValueError(code)


def run(*args):
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)


def atomic(path, value, mode=0o600):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as handle:
        os.fchmod(handle.fileno(), mode)
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def install(config):
    for group in (PAGE_GROUP, NODE_GROUP):
        try:
            grp.getgrnam(group)
        except KeyError:
            run('/usr/sbin/groupadd', '--system', group)
    KEYS.mkdir(parents=True, exist_ok=True, mode=0o755)
    KEYS.parent.chmod(0o755)
    opens = '    PermitOpen ' + ' '.join('127.0.0.1:' + str(port) for port in config['applicationPorts'])
    common = f'''    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    GatewayPorts no
    MaxSessions 0
    AuthorizedKeysFile {KEYS}/%u
{opens}
'''
    content = f'Match Group {NODE_GROUP}\n    AllowTcpForwarding yes\n' + common
    listens = config.get('nodes', {})
    content += '    PermitListen ' + ' '.join('127.0.0.1:' + str(node['remoteRunnerPort']) for node in listens.values()) + '\n' if listens else '    PermitListen none\n'
    content += f'Match Group {PAGE_GROUP}\n    AllowTcpForwarding local\n    PermitListen none\n' + common + 'Match all\n'
    old = FRAGMENT.read_text() if FRAGMENT.exists() else None
    try:
        atomic(FRAGMENT, content, 0o644)
        run('/usr/sbin/sshd', '-t')
    except Exception:
        if old is None:
            FRAGMENT.unlink(missing_ok=True)
        else:
            atomic(FRAGMENT, old, 0o644)
        raise
    run('/usr/bin/systemctl', 'reload', 'ssh.service')
    return {'installed': True}


def authorized_key_line(fields, application_ports, nodes):
    options = ['restrict', 'port-forwarding']
    options += ['permitopen="127.0.0.1:' + str(port) + '"' for port in application_ports]
    options += ['permitlisten="127.0.0.1:' + str(node['remoteRunnerPort']) + '"' for node in nodes]
    return ','.join(options) + ' ' + ' '.join(fields) + '\n'


def matching_processes(user, uid):
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if (entry / 'comm').read_text().strip() not in ('sshd', 'sshd-session'):
                continue
            owner = int(re.search(r'^Uid:\s+(\d+)', (entry / 'status').read_text(), re.M)[1])
            command = (entry / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace').strip()
            if owner == uid or owner == 0 and re.match(r'^sshd(?:-session)?: ' + re.escape(user) + r'(?:\s|$|@)', command):
                found.append(int(entry.name))
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    return found


def operate(request, config):
    operation = request.get('operation')
    if operation == 'install':
        return install(config)
    ensure(operation in ('ensure', 'revoke'), 'OPERATION_INVALID')
    device = request.get('deviceId', '')
    ensure(re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', device), 'DEVICE_ID_INVALID')
    user = 'xjd_' + device.replace('-', '')[:28]
    receipt_file = STATE / (device + '.json')
    receipt = json.loads(receipt_file.read_text()) if receipt_file.exists() else None
    if operation == 'ensure':
        fields = request.get('publicKey', '').split()
        ensure(len(fields) == 2 and fields[0] == 'ssh-ed25519', 'PUBLIC_KEY_INVALID')
        raw = base64.b64decode(fields[1], validate=True)
        ensure(len(raw) == 51 and raw[:19] == b'\0\0\0\x0bssh-ed25519\0\0\0\x20', 'PUBLIC_KEY_INVALID')
        capabilities = request.get('capabilities', [])
        ensure(isinstance(capabilities, list) and 'page' in capabilities, 'CAPABILITY_INVALID')
        nodes = []
        for cap in capabilities:
            if cap == 'page':
                continue
            ensure(isinstance(cap, str) and cap.startswith('node:') and cap[5:] in config.get('nodes', {}), 'NODE_NOT_GRANTED')
            nodes.append(config['nodes'][cap[5:]])
        ensure(len(nodes) <= 1, 'NODE_NOT_GRANTED')
        group = NODE_GROUP if nodes else PAGE_GROUP
        fingerprint = hashlib.sha256(raw).hexdigest()
        if receipt:
            ensure(not receipt.get('denied') and receipt['fingerprint'] == fingerprint and receipt['group'] == group, 'DEVICE_REVOKED_OR_CONFLICT')
        else:
            receipt = {'deviceId': device, 'username': user, 'fingerprint': fingerprint, 'group': group, 'denied': False}
            atomic(receipt_file, json.dumps(receipt))
        home = str(STATE / 'homes' / user)
        try:
            account = pwd.getpwnam(user)
        except KeyError:
            run('/usr/sbin/useradd', '--system', '--no-create-home', '--home-dir', home, '--shell', '/usr/sbin/nologin', '--gid', group, '--password', '*', user)
            account = pwd.getpwnam(user)
        ensure(account.pw_dir == home and account.pw_shell == '/usr/sbin/nologin' and account.pw_gid == grp.getgrnam(group).gr_gid, 'ACCOUNT_OWNERSHIP_CONFLICT')
        atomic(KEYS / user, authorized_key_line(fields, config['applicationPorts'], nodes), 0o644)
        receipt['uid'] = account.pw_uid
        atomic(receipt_file, json.dumps(receipt))
        return {'username': user, 'sshReady': True}
    if not receipt:
        # A deny receipt also prevents a delayed ensure from creating this device.
        atomic(receipt_file, json.dumps({'deviceId': device, 'username': user, 'denied': True}))
        return {'denied': True, 'connectionsClosed': True}
    receipt['denied'] = True
    atomic(receipt_file, json.dumps(receipt))
    (KEYS / user).unlink(missing_ok=True)
    try:
        account = pwd.getpwnam(user)
    except KeyError:
        return {'denied': True, 'connectionsClosed': True}
    ensure(account.pw_dir == str(STATE / 'homes' / user) and account.pw_uid == receipt.get('uid', account.pw_uid), 'ACCOUNT_OWNERSHIP_CONFLICT')
    for attempt in range(20):
        processes = matching_processes(user, account.pw_uid)
        if not processes:
            return {'denied': True, 'connectionsClosed': True}
        for pid in processes:
            try:
                if pid in matching_processes(user, account.pw_uid):
                    os.kill(pid, signal.SIGTERM if attempt < 10 else signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.1)
    ensure(not matching_processes(user, account.pw_uid), 'DEVICE_CLOSE_INCOMPLETE')
    return {'denied': True, 'connectionsClosed': True}


if __name__ == '__main__':
    try:
        ensure(os.geteuid() == 0, 'ROOT_REQUIRED')
        stat = CONFIG.lstat()
        ensure(CONFIG.is_file() and not CONFIG.is_symlink() and stat.st_uid == 0 and stat.st_mode & 0o022 == 0, 'ROOT_CONFIGURATION_REQUIRED')
        config = json.loads(CONFIG.read_text())
        ensure(isinstance(config['applicationPorts'], list) and config['applicationPorts'] and all(type(p) is int and 1 <= p <= 65535 for p in config['applicationPorts']), 'CONFIGURATION_INVALID')
        STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (STATE / 'operation.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            value = sys.stdin.buffer.read(8193)
            ensure(len(value) <= 8192, 'REQUEST_TOO_LARGE')
            result = operate(json.loads(value), config)
        print(json.dumps({'ok': True, 'data': result}))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[A-Z_]+', str(error)) else 'SYSTEM_OPERATION_FAILED'
        print(json.dumps({'ok': False, 'code': code}))
        sys.exit(1)
