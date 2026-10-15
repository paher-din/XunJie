#!/usr/bin/env python3
"""Deploy one exact public origin/main snapshot without replacing retained data."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urlsplit
import uuid


class DeploymentError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise DeploymentError(code)


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    path = Path(path)
    require(path.is_absolute() and path.is_file() and not path.is_symlink(), 'CONTROLLED_JSON_REQUIRED')
    require(path.stat().st_size <= 1024 * 1024 and (os.name == 'nt' or path.stat().st_mode & 0o022 == 0), 'CONTROLLED_JSON_REQUIRED')
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(not path.is_symlink(), 'STATUS_SYMLINK_REJECTED')
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
        json.dump(value, output, separators=(',', ':'))
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


class EntryParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.entries = []

    def handle_starttag(self, tag, attributes):
        values = dict(attributes)
        if tag == 'script' and values.get('type') == 'module' and values.get('src'):
            self.entries.append(values['src'])


class DeploymentSynchronizer:
    def __init__(self, config):
        self.config = config
        expected = {'repositoryUrl', 'releasesDirectory', 'currentLink', 'workDirectory', 'buildUser',
                    'nodeBinDirectory', 'applicationConfigFile', 'applicationService', 'healthUrl',
                    'statusFile', 'backupDirectory'}
        require(set(config) == expected, 'INVALID_DEPLOYMENT_CONFIG')
        source = urlsplit(config['repositoryUrl'])
        require(source.scheme == 'https' and source.hostname and not source.username and not source.password
                and not source.query and not source.fragment, 'PUBLIC_HTTPS_REPOSITORY_REQUIRED')
        for key in expected - {'repositoryUrl', 'buildUser', 'applicationService', 'healthUrl'}:
            require(isinstance(config[key], str) and Path(config[key]).is_absolute(), 'ABSOLUTE_DEPLOYMENT_PATH_REQUIRED')
        require(re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', config['buildUser']) is not None, 'INVALID_BUILD_USER')
        require(re.fullmatch(r'[A-Za-z0-9_-]+\.service', config['applicationService']) is not None, 'INVALID_APPLICATION_SERVICE')
        health = urlsplit(config['healthUrl'])
        require(health.scheme == 'https' and health.hostname in ('localhost', '127.0.0.1', '::1')
                and not health.username and not health.password and not health.query and not health.fragment
                and health.path in ('', '/'), 'LOOPBACK_HTTPS_HEALTH_REQUIRED')
        self.current = Path(config['currentLink'])
        self.releases = Path(config['releasesDirectory'])
        self.work = Path(config['workDirectory'])
        self.read_only = False

    def run(self, arguments, **kwargs):
        timeout = kwargs.pop('timeout', 300)
        input_text = kwargs.pop('input', None)
        process = subprocess.Popen(arguments, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                                   start_new_session=os.name == 'posix', **kwargs)
        try:
            output, errors = process.communicate(input=input_text, timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                if os.name == 'posix':
                    os.killpg(process.pid, signal.SIGTERM)
                else:
                    process.terminate()
            except ProcessLookupError:
                pass
            try:
                output, errors = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    if os.name == 'posix':
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                except ProcessLookupError:
                    pass
                output, errors = process.communicate()
            raise subprocess.TimeoutExpired(arguments, timeout, output=output, stderr=errors) from None
        return subprocess.CompletedProcess(arguments, process.returncode, output, errors)

    def checked(self, arguments, code, **kwargs):
        try:
            result = self.run(arguments, **kwargs)
        except (OSError, subprocess.TimeoutExpired) as error:
            self.log_failure(code, getattr(error, 'stdout', '') or '', getattr(error, 'stderr', '') or '')
            raise DeploymentError(code) from None
        if result.returncode != 0:
            self.log_failure(code, result.stdout, result.stderr)
        require(result.returncode == 0, code)
        return result.stdout.strip()

    def log_failure(self, code, output, errors):
        if self.read_only:
            return
        self.work.mkdir(parents=True, exist_ok=True, mode=0o755)
        value = {'at': utc_now(), 'code': code, 'stdout': output.decode(errors='replace') if isinstance(output, bytes) else output,
                 'stderr': errors.decode(errors='replace') if isinstance(errors, bytes) else errors}
        write_json(self.work / 'last-failure.log', value)

    def git(self, *arguments, timeout=120):
        environment = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1',
                           GIT_CONFIG_GLOBAL=os.devnull, GIT_ASKPASS='/bin/false')
        return self.checked(['git', '-c', 'credential.helper=', '-c', 'http.version=HTTP/1.1',
                             '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=20', *arguments],
                            'GIT_COMMAND_FAILED', env=environment, timeout=timeout)

    def remote_commit(self):
        result = self.git('ls-remote', '--exit-code', self.config['repositoryUrl'], 'refs/heads/main', timeout=30).splitlines()
        require(len(result) == 1, 'REMOTE_MAIN_REQUIRED')
        fields = result[0].split()
        require(len(fields) == 2 and re.fullmatch(r'[0-9a-f]{40}', fields[0]) and fields[1] == 'refs/heads/main', 'REMOTE_MAIN_REQUIRED')
        return fields[0]

    def read_application(self):
        application = read_json(self.config['applicationConfigFile'])
        require(application.get('staticDirectory') == str(self.current / 'apps/student/dist'), 'CURRENT_STATIC_DIRECTORY_REQUIRED')
        require(isinstance(application.get('databaseFile'), str) and Path(application['databaseFile']).is_absolute(), 'RETAINED_DATABASE_REQUIRED')
        require(isinstance(application.get('tls', {}).get('certFile'), str), 'TLS_CERTIFICATE_REQUIRED')
        return application

    def current_release(self):
        require(self.current.is_symlink(), 'CURRENT_RELEASE_SYMLINK_REQUIRED')
        release = self.current.resolve(strict=True)
        require(release.parent == self.releases.resolve(strict=True) and release.is_dir(), 'CURRENT_RELEASE_OUTSIDE_DIRECTORY')
        return release

    def deployed_manifest(self):
        release = self.current_release()
        path = release / 'deployment.json'
        return read_json(path) if path.exists() else {}

    def service_active(self):
        return self.run(['systemctl', 'is-active', '--quiet', self.config['applicationService']], timeout=15).returncode == 0

    def service_matches_current(self):
        process = self.checked(['systemctl', 'show', '--property=MainPID', '--value', self.config['applicationService']], 'APPLICATION_PID_FAILED', timeout=15)
        return process.isdigit() and process != '0' and Path('/proc/' + process + '/cwd').resolve() == self.current_release()

    def status(self):
        self.read_only = True
        remote = self.remote_commit()
        manifest = self.deployed_manifest()
        deployed = manifest.get('commit')
        active = self.service_active()
        aligned = active and self.matches_manifest(self.current_release(), manifest)
        if aligned:
            try:
                require(self.service_matches_current(), 'RUNNING_RELEASE_MISMATCH')
                self.probe_once(manifest)
            except (OSError, ValueError, DeploymentError, http.client.HTTPException):
                aligned = False
        return {'remoteCommit': remote, 'deployedCommit': deployed, 'upToDate': remote == deployed and aligned, 'serviceActive': active}

    def fetch_source(self, staging, commit):
        mirror = self.work / 'source.git'
        if not mirror.exists():
            self.git('init', '--bare', str(mirror))
        require(mirror.is_dir() and not mirror.is_symlink(), 'CONTROLLED_GIT_CACHE_REQUIRED')
        self.git('-C', str(mirror), 'fetch', '--no-tags', '--depth=1', self.config['repositoryUrl'], 'refs/heads/main', timeout=600)
        require(self.git('-C', str(mirror), 'rev-parse', 'FETCH_HEAD') == commit, 'REMOTE_MAIN_CHANGED')
        tree = self.git('-C', str(mirror), 'rev-parse', commit + '^{tree}')
        require(re.fullmatch(r'[0-9a-f]{40}', tree), 'GIT_TREE_REQUIRED')
        archive = self.work / ('source-' + uuid.uuid4().hex + '.tar')
        try:
            self.git('-C', str(mirror), 'archive', '--format=tar', '--output=' + str(archive), commit)
            with tarfile.open(archive) as source:
                for member in source.getmembers():
                    name = PurePosixPath(member.name)
                    require(not name.is_absolute() and '..' not in name.parts, 'UNSAFE_SOURCE_ARCHIVE')
                    destination = staging.joinpath(*name.parts)
                    require(destination.resolve().is_relative_to(staging.resolve()), 'UNSAFE_SOURCE_ARCHIVE')
                    if member.isdir():
                        destination.mkdir(parents=True, exist_ok=True)
                    elif member.isfile():
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        with source.extractfile(member) as input_file, destination.open('wb') as output_file:
                            shutil.copyfileobj(input_file, output_file)
                        destination.chmod(0o755 if member.mode & 0o111 else 0o644)
                    elif member.issym():
                        target = destination.parent / member.linkname
                        require(not Path(member.linkname).is_absolute() and target.resolve().is_relative_to(staging.resolve()), 'UNSAFE_SOURCE_ARCHIVE')
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.symlink_to(member.linkname)
                    else:
                        raise DeploymentError('UNSAFE_SOURCE_ARCHIVE')
        finally:
            if archive.exists():
                archive.unlink()
        return tree

    def build(self, staging):
        import pwd
        account = pwd.getpwnam(self.config['buildUser'])
        cache = self.work / 'npm-cache'
        cache.mkdir(exist_ok=True, mode=0o700)
        os.chown(cache, account.pw_uid, account.pw_gid)
        for root, directories, files in os.walk(staging, followlinks=False):
            for path in [Path(root), *(Path(root) / item for item in directories + files)]:
                os.chown(path, account.pw_uid, account.pw_gid, follow_symlinks=False)
        node = Path(self.config['nodeBinDirectory'])
        require(self.checked([str(node / 'node'), '--version'], 'NODE_VERSION_CHECK_FAILED') == 'v24.21.0', 'NODE_24_21_REQUIRED')
        environment = ['HOME=' + account.pw_dir, 'PATH=' + str(node) + ':/usr/bin:/bin', 'NODE_ENV=production',
                       'NODE_OPTIONS=--max-old-space-size=1024', 'npm_config_cache=' + str(cache),
                       'npm_config_nodedir=' + str(node), 'npm_config_devdir=' + str(cache / 'node-gyp')]
        commands = {'student': (['ci', '--include=dev', '--prefer-offline', '--no-audit', '--no-fund'], ['run', 'build']),
                    'teaching': (['ci', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund'],)}
        for application, steps in commands.items():
            directory = staging / 'apps' / application
            require((directory / 'package-lock.json').is_file(), 'APPLICATION_LOCKFILE_REQUIRED')
            for arguments in steps:
                self.checked(['runuser', '-u', account.pw_name, '--', 'env', *environment, str(node / 'npm'), *arguments],
                             'APPLICATION_BUILD_FAILED', cwd=str(directory), timeout=600)

    def prepare_runtime(self, staging):
        runtime = Path(tempfile.mkdtemp(prefix='staging-runtime-', dir=self.work))
        try:
            for name in ('apps/student/dist', 'apps/teaching/node_modules', 'apps/teaching/server',
                         'apps/teaching/contracts', 'apps/teaching/runner'):
                source = staging / name
                require(source.is_dir(), 'RUNTIME_DIRECTORY_REQUIRED')
                ignored = shutil.ignore_patterns('*.test.ts', 'test', 'tests', '__tests__') if name != 'apps/teaching/node_modules' else None
                shutil.copytree(source, runtime / name, symlinks=True, ignore=ignored)
            for name in ('apps/teaching/package.json', 'apps/teaching/package-lock.json',
                         'apps/teaching/tools/check-runtime.mjs', 'tools/i0-cloud/cloud-host.mjs'):
                destination = runtime / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(staging / name, destination)
            return runtime
        except Exception:
            self.remove_staging(runtime)
            raise

    def release_manifest(self, release, commit, tree):
        directory = release / 'apps/student/dist'
        index = directory / 'index.html'
        require(index.is_file() and not index.is_symlink(), 'BUILT_INDEX_REQUIRED')
        parser = EntryParser()
        content = index.read_bytes()
        parser.feed(content.decode('utf-8'))
        require(len(parser.entries) == 1, 'SINGLE_BUILT_ENTRY_REQUIRED')
        entry = urlsplit(parser.entries[0])
        require(not entry.scheme and not entry.netloc and not entry.query and not entry.fragment
                and entry.path.startswith('/assets/') and entry.path.endswith('.js')
                and '..' not in PurePosixPath(entry.path).parts, 'LOCAL_BUILT_ENTRY_REQUIRED')
        javascript = directory / entry.path.lstrip('/')
        require(javascript.is_file() and not javascript.is_symlink(), 'BUILT_JAVASCRIPT_REQUIRED')
        static_files = sorted(path for path in directory.rglob('*') if path.is_file())
        static_hash = digest(json.dumps([(str(path.relative_to(directory)), digest(path.read_bytes())) for path in static_files], separators=(',', ':')).encode())
        return {'commit': commit, 'gitTree': tree, 'runtimeSha256': self.runtime_digest(release), 'staticSha256': static_hash, 'indexSha256': digest(content), 'entryJs': entry.path,
                'entryJsSha256': digest(javascript.read_bytes()), 'deployedAt': utc_now(), 'status': 'deployed'}

    def runtime_digest(self, release):
        paths = []
        for name in ('apps/teaching/server', 'apps/teaching/contracts', 'apps/teaching/runner',
                     'apps/teaching/package.json', 'apps/teaching/package-lock.json',
                     'apps/teaching/tools/check-runtime.mjs', 'tools/i0-cloud/cloud-host.mjs'):
            root = release / name
            paths.extend(path for path in (root.rglob('*') if root.is_dir() else [root]) if path.is_file()
                         and not path.name.endswith('.test.ts')
                         and not {'test', 'tests', '__tests__'}.intersection(path.relative_to(release).parts))
        return digest(json.dumps([(str(path.relative_to(release)), digest(path.read_bytes())) for path in sorted(paths)], separators=(',', ':')).encode())

    def matches_manifest(self, release, manifest):
        try:
            require(re.fullmatch(r'[0-9a-f]{40}', manifest.get('commit', '')) is not None
                    and re.fullmatch(r'[0-9a-f]{40}', manifest.get('gitTree', '')) is not None, 'VERSION_MANIFEST_REQUIRED')
            actual = self.release_manifest(release, manifest['commit'], manifest['gitTree'])
            return all(actual[key] == manifest.get(key) for key in ('runtimeSha256', 'staticSha256', 'indexSha256', 'entryJs', 'entryJsSha256'))
        except (OSError, ValueError, DeploymentError):
            return False

    def publish_release(self, staging, release, manifest):
        require(not release.exists(), 'RELEASE_ALREADY_EXISTS')
        shutil.move(str(staging), str(release))
        for root, directories, files in os.walk(release, followlinks=False):
            for path in [Path(root), *(Path(root) / item for item in directories + files)]:
                os.chown(path, 0, 0, follow_symlinks=False)
                if not path.is_symlink():
                    path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
        write_json(release / 'deployment.json', manifest)
        (release / 'deployment.json').chmod(0o644)

    def backup(self, current_release):
        application = self.read_application()
        directory = Path(self.config['backupDirectory'])
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(not directory.is_symlink(), 'CONTROLLED_BACKUP_DIRECTORY_REQUIRED')
        destination = directory / ('main-deploy-' + str(int(time.time())) + '-' + uuid.uuid4().hex + '.sqlite')
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        program = """
import {readFileSync,chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const input=JSON.parse(readFileSync(0,'utf8'));
const Driver=createRequire(input.packageFile)('better-sqlite3');
const db=new Driver(input.databaseFile,{readonly:true,fileMustExist:true});
try{
 if(db.pragma('integrity_check',{simple:true})!=='ok'||db.pragma('foreign_key_check').length)throw new Error('Integrity');
 await db.backup(input.backupFile);chmodSync(input.backupFile,0o600);
 const copy=new Driver(input.backupFile,{readonly:true,fileMustExist:true});
 try{if(copy.pragma('integrity_check',{simple:true})!=='ok'||copy.pragma('foreign_key_check').length)throw new Error('Backup');}finally{copy.close();}
 console.log(JSON.stringify({path:input.backupFile,sha256:createHash('sha256').update(readFileSync(input.backupFile)).digest('hex')}));
}finally{db.close();}
"""
        result = self.checked([str(Path(self.config['nodeBinDirectory']) / 'node'), '--input-type=module', '-e', program],
                              'CONSISTENT_BACKUP_FAILED', input=json.dumps({'packageFile': str(current_release / 'apps/teaching/package.json'),
                                  'databaseFile': application['databaseFile'], 'backupFile': str(destination)}), timeout=120)
        return json.loads(result)

    def switch_link(self, release):
        temporary = self.current.with_name(self.current.name + '.' + uuid.uuid4().hex + '.tmp')
        temporary.symlink_to(release, target_is_directory=True)
        os.replace(temporary, self.current)

    def restart_service(self):
        self.checked(['systemctl', 'restart', self.config['applicationService']], 'APPLICATION_RESTART_FAILED', timeout=90)

    def http_get(self, path, context):
        address = urlsplit(self.config['healthUrl'])
        connection = http.client.HTTPSConnection(address.hostname, address.port or 443, timeout=8, context=context)
        try:
            connection.request('GET', path)
            response = connection.getresponse()
            body = response.read(16 * 1024 * 1024 + 1)
            require(response.status == 200 and len(body) <= 16 * 1024 * 1024, 'HEALTH_HTTP_FAILED')
            return body
        finally:
            connection.close()

    def probe_once(self, manifest):
        context = ssl.create_default_context(cafile=self.read_application()['tls']['certFile'])
        require(json.loads(self.http_get('/health/live', context)).get('data', {}).get('status') == 'alive', 'LIVE_CHECK_FAILED')
        require(json.loads(self.http_get('/health/ready', context)).get('data', {}).get('status') == 'ready', 'READY_CHECK_FAILED')
        require(digest(self.http_get('/', context)) == manifest['indexSha256'], 'SERVED_INDEX_MISMATCH')
        require(digest(self.http_get(manifest['entryJs'], context)) == manifest['entryJsSha256'], 'SERVED_JAVASCRIPT_MISMATCH')

    def probe(self, manifest):
        deadline = time.monotonic() + 60
        while True:
            try:
                self.probe_once(manifest)
                return
            except (OSError, ValueError, DeploymentError, http.client.HTTPException):
                if time.monotonic() >= deadline:
                    raise DeploymentError('APPLICATION_HEALTH_FAILED')
                time.sleep(2)

    def write_status(self, value):
        write_json(self.config['statusFile'], value)

    def remove_staging(self, staging):
        if staging is not None and staging.exists():
            require(staging.parent.resolve() == self.work.resolve() and staging.name.startswith('staging-')
                    and not staging.is_symlink(), 'OWNED_STAGING_REQUIRED')
            shutil.rmtree(staging)

    def apply(self):
        self.read_only = False
        previous = self.current_release()
        self.read_application()
        staging = None
        runtime = None
        switched = False
        commit = None
        try:
            commit = self.remote_commit()
            current_manifest = self.deployed_manifest()
            if current_manifest.get('commit') == commit and self.service_active() and self.matches_manifest(previous, current_manifest):
                try:
                    require(self.service_matches_current(), 'RUNNING_RELEASE_MISMATCH')
                    self.probe_once(current_manifest)
                    return {'status': 'unchanged', 'remoteCommit': commit, 'deployedCommit': commit, 'upToDate': True, 'serviceActive': True}
                except (OSError, ValueError, DeploymentError, http.client.HTTPException):
                    pass
            self.work.mkdir(parents=True, exist_ok=True, mode=0o755)
            self.work.chmod(0o755)
            self.releases.mkdir(parents=True, exist_ok=True, mode=0o755)
            require(not self.work.is_symlink() and not self.releases.is_symlink(), 'CONTROLLED_DEPLOYMENT_DIRECTORIES_REQUIRED')
            staging = Path(tempfile.mkdtemp(prefix='staging-', dir=self.work))
            tree = self.fetch_source(staging, commit)
            source_runtime_hash = self.runtime_digest(staging)
            self.build(staging)
            runtime = self.prepare_runtime(staging)
            manifest = self.release_manifest(runtime, commit, tree)
            require(manifest['runtimeSha256'] == source_runtime_hash, 'BUILD_CHANGED_RUNTIME_SOURCE')
            require(self.remote_commit() == commit, 'REMOTE_MAIN_CHANGED')
            release = self.releases / ('main-' + commit)
            if release.exists():
                if not self.matches_manifest(release, manifest):
                    release = self.releases / ('main-' + commit + '-' + uuid.uuid4().hex[:12])
            if not release.exists():
                self.publish_release(runtime, release, manifest)
            backup = self.backup(previous)
            self.switch_link(release)
            switched = True
            self.restart_service()
            self.probe(manifest)
            require(self.service_matches_current(), 'RUNNING_RELEASE_MISMATCH')
            result = {**manifest, 'remoteCommit': commit, 'deployedCommit': commit, 'upToDate': True,
                      'serviceActive': True, 'backup': backup}
            self.write_status(result)
            return result
        except Exception as error:
            code = error.code if isinstance(error, DeploymentError) else 'DEPLOYMENT_FAILED'
            rollback = 'not_needed'
            if switched:
                try:
                    self.switch_link(previous)
                    self.restart_service()
                    rollback = 'previous_release_restarted'
                except Exception:
                    rollback = 'failed'
            actual = self.deployed_manifest().get('commit')
            self.write_status({'status': 'failed', 'code': code, 'attemptedCommit': commit,
                               'deployedCommit': actual, 'rollback': rollback, 'at': utc_now()})
            raise DeploymentError(code) from None
        finally:
            self.remove_staging(runtime)
            self.remove_staging(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--status', action='store_true')
    arguments = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() == 0, 'LINUX_ROOT_REQUIRED')
    synchronizer = DeploymentSynchronizer(read_json(arguments.config))
    if arguments.status:
        print(json.dumps(synchronizer.status(), separators=(',', ':')))
        return
    import fcntl
    synchronizer.work.mkdir(parents=True, exist_ok=True, mode=0o755)
    require(not synchronizer.work.is_symlink(), 'CONTROLLED_WORK_DIRECTORY_REQUIRED')
    os.chown(synchronizer.work, 0, 0)
    synchronizer.work.chmod(0o755)
    lock = synchronizer.work / 'sync-main.lock'
    require(not lock.is_symlink(), 'CONTROLLED_LOCK_REQUIRED')
    with lock.open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeploymentError('DEPLOYMENT_ALREADY_RUNNING') from None
        print(json.dumps(synchronizer.apply(), separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'code': error.code if isinstance(error, DeploymentError) else 'DEPLOYMENT_FAILED'}), file=sys.stderr)
        sys.exit(1)
