#!/usr/bin/python3
"""Install a verified small source bundle. Product runtime/data are managed separately."""
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys

ROOT = Path('/opt/xunjie-dev-access')
CONFIG = Path('/etc/xunjie-dev-access-candidate129')
DATA = Path('/var/lib/xunjie-dev-access-candidate129')
BACKUPS = Path('/var/backups/xunjie-dev-access-candidate129')
USER = 'xj-access-c129'
FILES = {
    'apps/teaching/server/access/local-socket.ts',
    'tools/xj-dev/src/enrollment-protocol.mjs',
    *('tools/xj-dev-access/' + p for p in ['server.mjs', 'store.mjs', 'identity.mjs', 'adapters.mjs', 'admin.mjs',
       'system-helper.py', 'install.py', 'prepare-tls.py', 'package-store.mjs', 'packages.mjs', 'github-login.mjs', 'oss-storage.mjs',
       'package.json', 'package-lock.json', 'xunjie-dev-access-candidate129.service']),
}


def require(value, code):
    if not value:
        raise ValueError(code)


def run(*args, input=None):
    return subprocess.run(args, input=input, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)


def main(source):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    receipt = json.loads((source / 'deployment.json').read_text())
    require(receipt['format'] == 'xunjie/dev-access-source-v2' and re.fullmatch('[a-f0-9]{40}', receipt['sourceCommit']), 'SOURCE_RECEIPT_INVALID')
    require({f['path'] for f in receipt['files']} == FILES and len(receipt['files']) == len(FILES), 'SOURCE_FILES_INVALID')
    dependency = receipt.get('dependencies', {})
    require(dependency.get('nodeVersion') == 'v24.21.0' and isinstance(dependency.get('files'), list) and dependency['files'], 'LOCKED_DEPENDENCIES_REQUIRED')
    lock_file = source / 'tools/xj-dev-access/package-lock.json'
    require(hashlib.sha256(lock_file.read_bytes()).hexdigest() == dependency.get('lockfileSha256'), 'DEPENDENCY_LOCK_INVALID')
    dependency_paths = set()
    for f in dependency['files']:
        p = f['path']
        require(p.startswith('tools/xj-dev-access/node_modules/') and '\\' not in p and all(x not in ('', '.', '..') for x in p.split('/'))
                and not p.lower().endswith(('.node', '.so', '.dylib', '.dll', '.exe')) and p not in dependency_paths, 'DEPENDENCY_PATH_INVALID')
        dependency_paths.add(p)
    all_files = receipt['files'] + dependency['files']
    for f in all_files:
        file = source / f['path']
        require(file.is_file() and not file.is_symlink() and hashlib.sha256(file.read_bytes()).hexdigest() == f['sha256'], 'SOURCE_DIGEST_INVALID')
    try:
        account = pwd.getpwnam(USER)
    except KeyError:
        run('/usr/sbin/useradd', '--system', '--user-group', '--home-dir', str(DATA), '--no-create-home', '--shell', '/usr/sbin/nologin', USER)
        account = pwd.getpwnam(USER)
    require(account.pw_dir == str(DATA) and account.pw_shell == '/usr/sbin/nologin', 'SERVICE_ACCOUNT_CONFLICT')
    require(grp.getgrnam(USER).gr_gid == account.pw_gid, 'SERVICE_GROUP_CONFLICT')
    for directory in (DATA, BACKUPS):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chown(directory, account.pw_uid, account.pw_gid)
        directory.chmod(0o700)
    CONFIG.mkdir(parents=True, exist_ok=True, mode=0o750)
    os.chown(CONFIG, 0, account.pw_gid)
    CONFIG.chmod(0o750)
    key = DATA / 'credential.key'
    if not key.exists():
        descriptor = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(os.urandom(32)); handle.flush(); os.fsync(handle.fileno())
        os.chown(key, account.pw_uid, account.pw_gid)
    require(key.is_file() and not key.is_symlink() and key.stat().st_size == 32 and key.stat().st_uid == account.pw_uid and stat.S_IMODE(key.stat().st_mode) == 0o600, 'CREDENTIAL_KEY_INVALID')
    # Bootstrap TLS/config are private files provisioned through owner stdin,
    # never placed in this source bundle or command-line values.
    for name in ('service.json', 'system.json'):
        file = CONFIG / name
        require(file.is_file() and not file.is_symlink() and file.stat().st_uid in ({0, account.pw_uid} if name == 'service.json' else {0})
                and not file.stat().st_mode & 0o077, 'ROOT_BOOTSTRAP_REQUIRED')
    service = json.loads((CONFIG / 'service.json').read_text())
    require(service['databaseFile'] == str(DATA / 'access.sqlite') and service['credentialKeyFile'] == str(key)
            and service['backupDirectory'] == str(BACKUPS) and service['adminSocket'] == '/run/xunjie-dev-access-candidate129/admin.sock', 'SERVICE_PATHS_INVALID')
    os.chown(CONFIG / 'service.json', account.pw_uid, account.pw_gid); (CONFIG / 'service.json').chmod(0o600)
    (CONFIG / 'system.json').chmod(0o600)
    # All bootstrap trust files are copied into this service's own directory.
    # Grant only the service UID access; a root-owned 0600 TLS key would make
    # an otherwise valid installation fail at the first non-root start.
    trust_files = [*service['tls'].values(), service['knownHostsFile'], service['cloudCaFile']]
    for name in trust_files:
        file = Path(name)
        require(file.parent == CONFIG and file.is_file() and not file.is_symlink()
                and file.stat().st_uid in {0, account.pw_uid} and file.stat().st_size <= 1024 * 1024
                and not file.stat().st_mode & 0o022, 'TRUST_FILE_INVALID')
        os.chown(file, account.pw_uid, account.pw_gid); file.chmod(0o600)
    system = json.loads((CONFIG / 'system.json').read_text())
    require(service['target']['applicationPort'] in system['applicationPorts'], 'APPLICATION_PORT_NOT_GRANTED')
    release = ROOT / 'releases' / receipt['sourceCommit']
    if release.exists():
        for f in all_files:
            file = release / f['path']
            require(file.is_file() and not file.is_symlink() and file.stat().st_uid == 0 and not file.stat().st_mode & 0o022
                    and hashlib.sha256(file.read_bytes()).hexdigest() == f['sha256'], 'IMMUTABLE_RELEASE_CONFLICT')
    else:
        release.mkdir(parents=True, mode=0o755)
        for f in all_files:
            target = release / f['path']; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / f['path'], target); target.chmod(0o644)
        shutil.copyfile(source / 'deployment.json', release / 'deployment.json')
    # mkdir(parents=True) follows the installer's 0077 umask for intermediate
    # source directories too. Source is public, root-owned and non-writable by
    # the service; every component must explicitly permit traversal/read.
    for directory in (ROOT, ROOT / 'releases', release):
        require(directory.is_dir() and not directory.is_symlink() and directory.stat().st_uid == 0, 'SOURCE_DIRECTORY_INVALID')
        directory.chmod(0o755)
    for f in all_files:
        parent = (release / f['path']).parent
        while parent != release:
            require(parent.is_dir() and not parent.is_symlink() and parent.stat().st_uid == 0, 'SOURCE_DIRECTORY_INVALID')
            parent.chmod(0o755)
            parent = parent.parent
    (release / 'deployment.json').chmod(0o644)
    # Root owns every release and current link. The service can execute only
    # this exact fixed helper, with request data on stdin and no extra args.
    ROOT.mkdir(parents=True, exist_ok=True)
    temporary = ROOT / 'current.new'
    temporary.unlink(missing_ok=True); temporary.symlink_to(release); os.replace(temporary, ROOT / 'current')
    sudoers = Path('/etc/sudoers.d/xunjie-dev-access-candidate129')
    sudoers.write_text(f'{USER} ALL=(root) NOPASSWD: /usr/bin/python3 /opt/xunjie-dev-access/current/tools/xj-dev-access/system-helper.py\n')
    sudoers.chmod(0o440); run('/usr/sbin/visudo', '-cf', str(sudoers))
    run('/usr/bin/python3', str(ROOT / 'current/tools/xj-dev-access/system-helper.py'), input=b'{"operation":"install"}')
    unit = Path('/etc/systemd/system/xunjie-dev-access-candidate129.service')
    shutil.copyfile(release / 'tools/xj-dev-access/xunjie-dev-access-candidate129.service', unit); unit.chmod(0o644)
    run('/usr/bin/systemctl', 'daemon-reload')
    # Explicit start/restart is a separate owner operation after product socket
    # and trusted HTTPS reachability have been checked.
    print(json.dumps({'installed': True, 'sourceCommit': receipt['sourceCommit'], 'release': str(release), 'service': unit.name, 'backupDirectory': str(BACKUPS)}))


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2, 'SOURCE_DIRECTORY_REQUIRED')
        main(Path(sys.argv[1]).resolve())
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]+', str(error)) else 'INSTALL_FAILED'
        print(json.dumps({'installed': False, 'code': code})); sys.exit(1)
