#!/usr/bin/env python3
"""Deploy the verified CI runtime artifact for one exact public origin/main commit.

The shared host never builds: it downloads the published artifact for the
current main commit, verifies every digest against the manifest, backs up the
retained database, assembles the release and switches, rolling back to the
previous release when the candidate fails its health probe.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import platform as platform_module
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
import urllib.error
import urllib.request
import uuid


NODE_VERSION = 'v24.21.0'
PLATFORM = 'linux-x64'
MANIFEST_FORMAT = 'xunjie-runtime-artifact'
MANIFEST_VERSION = 1
MANIFEST_LIMIT = 8 * 1024 * 1024
ARTIFACT_LIMIT = 1024 * 1024 * 1024
API_HOSTS = frozenset({'api.github.com', 'codeload.github.com'})
ASSET_HOSTS = frozenset({'api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'})
RELEASE_PATTERN = re.compile(r'main-[0-9a-f]{40}(?:-[0-9a-f]{12})?')
BACKUP_PATTERN = re.compile(r'main-deploy-\d+-[0-9a-f]{32}\.sqlite')


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


def digest_file(path):
    hasher = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def read_json(path):
    path = Path(path)
    require(path.is_absolute() and path.is_file() and not path.is_symlink(), 'CONTROLLED_JSON_REQUIRED')
    require(path.stat().st_size <= 8 * 1024 * 1024 and (os.name == 'nt' or path.stat().st_mode & 0o022 == 0), 'CONTROLLED_JSON_REQUIRED')
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


class ArtifactDeployment:
    def __init__(self, config):
        self.config = config
        expected = {'repositoryUrl', 'releasesDirectory', 'currentLink', 'workDirectory', 'nodeBinDirectory',
                    'applicationConfigFile', 'applicationService', 'healthUrl', 'statusFile', 'backupDirectory',
                    'artifactTagPrefix', 'minimumFreeBytes', 'warningFreeBytes', 'keepReleases', 'keepBackups'}
        require(set(config) == expected, 'INVALID_DEPLOYMENT_CONFIG')
        source = urlsplit(config['repositoryUrl'])
        require(source.scheme == 'https' and source.hostname and not source.username and not source.password
                and not source.query and not source.fragment, 'PUBLIC_HTTPS_REPOSITORY_REQUIRED')
        for key in expected - {'repositoryUrl', 'applicationService', 'healthUrl', 'artifactTagPrefix',
                                'minimumFreeBytes', 'warningFreeBytes', 'keepReleases', 'keepBackups'}:
            require(isinstance(config[key], str) and Path(config[key]).is_absolute(), 'ABSOLUTE_DEPLOYMENT_PATH_REQUIRED')
        for key in ('minimumFreeBytes', 'warningFreeBytes', 'keepReleases', 'keepBackups'):
            require(isinstance(config[key], int) and not isinstance(config[key], bool) and config[key] > 0, 'INVALID_DEPLOYMENT_CONFIG')
        require(config['keepReleases'] >= 2 and config['warningFreeBytes'] >= config['minimumFreeBytes'], 'INVALID_DEPLOYMENT_CONFIG')
        require(re.fullmatch(r'[a-z][a-z0-9-]{0,31}', config['artifactTagPrefix']) is not None, 'INVALID_ARTIFACT_TAG_PREFIX')
        require(re.fullmatch(r'[A-Za-z0-9_.-]+\.service', config['applicationService']) is not None, 'INVALID_APPLICATION_SERVICE')
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

    def github_repository(self):
        source = urlsplit(self.config['repositoryUrl'])
        match = re.fullmatch(r'/([A-Za-z0-9_-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?', source.path)
        require(source.scheme == 'https' and source.hostname == 'github.com' and source.port in (None, 443)
                and not source.username and not source.password and not source.query and not source.fragment
                and match is not None, 'PUBLIC_GITHUB_REPOSITORY_REQUIRED')
        owner, repository = match.groups()
        require(repository not in ('.', '..'), 'PUBLIC_GITHUB_REPOSITORY_REQUIRED')
        return owner, repository

    def github_open(self, url, accept='application/vnd.github+json', allow_hosts=API_HOSTS, allow_missing=False):
        address = urlsplit(url)
        require(address.scheme == 'https' and address.hostname in allow_hosts
                and address.port in (None, 443) and not address.username and not address.password
                and not address.query and not address.fragment, 'OFFICIAL_GITHUB_HTTPS_REQUIRED')
        request = urllib.request.Request(url, headers={'User-Agent': 'XunJie-artifact-deployment', 'Accept': accept,
                                                     'X-GitHub-Api-Version': '2022-11-28'})
        try:
            response = urllib.request.urlopen(request, timeout=60, context=ssl.create_default_context())
        except urllib.error.HTTPError as error:
            if allow_missing and error.code == 404:
                return None
            self.log_failure('GITHUB_REQUEST_FAILED', '', str(error))
            raise DeploymentError('GITHUB_REQUEST_FAILED') from None
        except (urllib.error.URLError, OSError) as error:
            self.log_failure('GITHUB_REQUEST_FAILED', '', str(error))
            raise DeploymentError('GITHUB_REQUEST_FAILED') from None
        final = urlsplit(response.geturl())
        try:
            require(response.status == 200 and final.scheme == 'https'
                    and final.hostname in allow_hosts and not final.username and not final.password,
                    'GITHUB_RESPONSE_REJECTED')
        except Exception:
            response.close()
            raise
        return response

    def github_json(self, url, limit=1024 * 1024, **kwargs):
        response = self.github_open(url, **kwargs)
        if response is None:
            return None
        with response:
            content = response.read(limit + 1)
        require(len(content) <= limit, 'GITHUB_METADATA_TOO_LARGE')
        try:
            result = json.loads(content)
        except ValueError:
            raise DeploymentError('GITHUB_METADATA_INVALID') from None
        require(isinstance(result, dict), 'GITHUB_METADATA_INVALID')
        return result

    def remote_commit(self):
        owner, repository = self.github_repository()
        reference = self.github_json('https://api.github.com/repos/' + owner + '/' + repository + '/git/ref/heads/main')
        target = reference.get('object')
        require(reference.get('ref') == 'refs/heads/main' and isinstance(target, dict)
                and target.get('type') == 'commit' and isinstance(target.get('sha'), str)
                and re.fullmatch(r'[0-9a-f]{40}', target['sha']) is not None, 'REMOTE_MAIN_REQUIRED')
        return target['sha']

    def remote_tree(self, commit):
        owner, repository = self.github_repository()
        metadata = self.github_json('https://api.github.com/repos/' + owner + '/' + repository + '/git/commits/' + commit)
        tree = metadata.get('tree')
        require(metadata.get('sha') == commit and isinstance(tree, dict) and isinstance(tree.get('sha'), str)
                and re.fullmatch(r'[0-9a-f]{40}', tree['sha']) is not None, 'REMOTE_TREE_REQUIRED')
        return tree['sha']

    def published_release(self, commit):
        owner, repository = self.github_repository()
        tag = self.config['artifactTagPrefix'] + '-' + commit
        release = self.github_json('https://api.github.com/repos/' + owner + '/' + repository + '/releases/tags/' + tag,
                                   limit=1024 * 1024, allow_missing=True)
        if release is None:
            return None
        assets = release.get('assets')
        require(release.get('tag_name') == tag and release.get('draft') is False and isinstance(assets, list)
                and {asset.get('name') for asset in assets} >= {'manifest.json', 'runtime.tar.gz'}, 'INVALID_RELEASE_ASSETS')
        return {name: asset for asset in assets for name in (asset.get('name'),) if name}

    def download_asset(self, asset, destination, limit, code):
        require(isinstance(asset.get('url'), str) and isinstance(asset.get('size'), int)
                and 0 < asset['size'] <= limit, code)
        with self.github_open(asset['url'], accept='application/octet-stream', allow_hosts=ASSET_HOSTS) as response:
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(descriptor, 'wb') as output:
                    total = 0
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        require(total <= limit, code)
                        output.write(chunk)
            except Exception:
                os.unlink(destination)
                raise
        return total

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

    # --- disk, memory and retention -------------------------------------------

    def free_bytes(self, path):
        usage = os.statvfs(path)
        return usage.f_bavail * usage.f_frsize

    def disk_state(self):
        free = min(self.free_bytes(path) for path in (self.releases, self.work))
        return {'freeBytes': free, 'warningFreeBytes': self.config['warningFreeBytes'],
                'minimumFreeBytes': self.config['minimumFreeBytes'],
                'warning': free < self.config['warningFreeBytes'], 'blocked': free < self.config['minimumFreeBytes']}

    def available_memory_bytes(self):
        try:
            for line in Path('/proc/meminfo').read_text(encoding='ascii').splitlines():
                if line.startswith('MemAvailable:'):
                    return int(line.split()[1]) * 1024
        except OSError:
            return None
        return None

    def release_entries(self):
        entries = []
        for child in self.releases.iterdir():
            if child.is_symlink() or not child.is_dir() or not RELEASE_PATTERN.fullmatch(child.name):
                continue
            manifest_path = child / 'deployment.json'
            manifest = read_json(manifest_path) if manifest_path.exists() else {}
            entries.append({'name': child.name, 'path': child, 'commit': manifest.get('commit'),
                            'pinned': (child / '.pinned').is_file(), 'modifiedAt': child.stat().st_mtime})
        return sorted(entries, key=lambda entry: entry['modifiedAt'], reverse=True)

    def prune_releases(self):
        current = self.current_release()
        pruned = []
        entries = self.release_entries()
        keep = 0
        for entry in entries:
            if entry['path'] == current or entry['pinned'] or keep < self.config['keepReleases'] - 1:
                keep = keep + 1 if entry['path'] != current and not entry['pinned'] else keep
                continue
            shutil.rmtree(entry['path'])
            pruned.append(entry['name'])
        return pruned

    def prune_backups(self):
        backups = sorted((path for path in Path(self.config['backupDirectory']).glob('main-deploy-*.sqlite')
                          if path.is_file() and not path.is_symlink() and BACKUP_PATTERN.fullmatch(path.name)),
                         key=lambda path: path.stat().st_mtime, reverse=True)
        pruned = []
        for path in backups[self.config['keepBackups']:]:
            path.unlink()
            pruned.append(path.name)
        return pruned

    def remove_legacy_work_files(self):
        for pattern in ('source-*.tar.gz', 'sync-main.lock'):
            for path in self.work.glob(pattern):
                if path.is_file() and not path.is_symlink():
                    path.unlink()
        legacy_cache = self.work / 'npm-cache'
        if legacy_cache.is_dir() and not legacy_cache.is_symlink():
            shutil.rmtree(legacy_cache)

    def remove_stale_staging(self):
        for path in self.work.glob('staging-*'):
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)

    # --- artifact verification -------------------------------------------------

    def validate_manifest(self, manifest, commit, tree, require_artifact_digest=True):
        require(isinstance(manifest, dict) and manifest.get('format') == MANIFEST_FORMAT
                and manifest.get('version') == MANIFEST_VERSION, 'UNSUPPORTED_MANIFEST')
        require(manifest.get('commit') == commit, 'MANIFEST_COMMIT_MISMATCH')
        require(manifest.get('gitTree') == tree, 'MANIFEST_TREE_MISMATCH')
        require(manifest.get('platform') == PLATFORM and manifest.get('nodeVersion') == NODE_VERSION, 'RUNTIME_PLATFORM_MISMATCH')
        for key in ('runtimeFiles', 'staticFiles'):
            entries = manifest.get(key)
            require(isinstance(entries, list) and entries, 'MANIFEST_FILE_LIST_REQUIRED')
            paths = set()
            for entry in entries:
                require(isinstance(entry, dict) and set(entry) == {'path', 'sha256', 'bytes'}, 'MANIFEST_FILE_LIST_REQUIRED')
                name = PurePosixPath(entry['path'])
                require(not name.is_absolute() and '..' not in name.parts and name.parts
                        and re.fullmatch(r'[0-9a-f]{64}', entry['sha256']) is not None
                        and isinstance(entry['bytes'], int) and entry['bytes'] >= 0, 'MANIFEST_FILE_LIST_REQUIRED')
                require(entry['path'] not in paths, 'MANIFEST_FILE_LIST_REQUIRED')
                paths.add(entry['path'])
        for key in ('indexSha256', 'entryJsSha256', *(('artifactSha256',) if require_artifact_digest else ())):
            require(re.fullmatch(r'[0-9a-f]{64}', str(manifest.get(key, ''))) is not None, 'MANIFEST_DIGEST_REQUIRED')
        require(isinstance(manifest.get('entryJs'), str) and urlsplit(manifest['entryJs']).path == manifest['entryJs'], 'MANIFEST_ENTRY_REQUIRED')
        require(isinstance(manifest.get('staticDigests'), dict), 'MANIFEST_DIGEST_MAP_REQUIRED')
        return manifest

    def extract_artifact(self, archive, staging):
        roots = (PurePosixPath('apps/student'), PurePosixPath('apps/teaching'))
        with tarfile.open(archive, mode='r:gz') as source:
            for member in source.getmembers():
                name = PurePosixPath(member.name)
                require(not name.is_absolute() and '..' not in name.parts and name.parts, 'UNSAFE_ARTIFACT_ARCHIVE')
                if len(name.parts) == 1:
                    require(member.isdir(), 'UNSAFE_ARTIFACT_ARCHIVE')
                    continue
                relative = name
                if relative != PurePosixPath('tools/i0-cloud/cloud-host.mjs') and not any(
                        relative == root or root in relative.parents for root in roots):
                    continue
                destination = staging.joinpath(*relative.parts)
                require(destination.resolve().is_relative_to(staging.resolve()), 'UNSAFE_ARTIFACT_ARCHIVE')
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with source.extractfile(member) as input_file, destination.open('wb') as output_file:
                        shutil.copyfileobj(input_file, output_file)
                    destination.chmod(0o755 if member.mode & 0o111 else 0o644)
                elif member.issym():
                    target = destination.parent / member.linkname
                    require(not Path(member.linkname).is_absolute() and target.resolve().is_relative_to(staging.resolve()), 'UNSAFE_ARTIFACT_ARCHIVE')
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.symlink_to(member.linkname)
                else:
                    raise DeploymentError('UNSAFE_ARTIFACT_ARCHIVE')

    def file_digests(self, root, prefix):
        root = Path(root)
        return {prefix + path.relative_to(root).as_posix(): digest_file(path)
                for path in sorted(root.rglob('*')) if path.is_file() and not path.is_symlink()}

    def file_sizes(self, root, prefix):
        root = Path(root)
        return {prefix + path.relative_to(root).as_posix(): path.stat().st_size
                for path in sorted(root.rglob('*')) if path.is_file() and not path.is_symlink()}

    def static_entry(self, dist):
        index = dist / 'index.html'
        require(index.is_file() and not index.is_symlink(), 'BUILT_INDEX_REQUIRED')
        parser = EntryParser()
        content = index.read_bytes()
        parser.feed(content.decode('utf-8'))
        require(len(parser.entries) == 1, 'SINGLE_BUILT_ENTRY_REQUIRED')
        entry = urlsplit(parser.entries[0])
        require(not entry.scheme and not entry.netloc and not entry.query and not entry.fragment
                and entry.path.startswith('/assets/') and entry.path.endswith('.js')
                and '..' not in PurePosixPath(entry.path).parts, 'LOCAL_BUILT_ENTRY_REQUIRED')
        javascript = dist / entry.path.lstrip('/')
        require(javascript.is_file() and not javascript.is_symlink(), 'BUILT_JAVASCRIPT_REQUIRED')
        return {'indexSha256': digest(content), 'entryJs': entry.path, 'entryJsSha256': digest_file(javascript)}

    def verify_tree(self, release_root, manifest):
        expected_runtime = {entry['path']: entry['sha256'] for entry in manifest['runtimeFiles']}
        expected_static = {entry['path']: entry['sha256'] for entry in manifest['staticFiles']}
        dist = release_root / 'apps/student/dist'
        actual_static = self.file_digests(dist, '')
        require(actual_static == expected_static, 'RUNTIME_FILE_DIGEST_MISMATCH')
        for root, prefix in (('apps/teaching', 'apps/teaching/'), ('tools/i0-cloud', 'tools/i0-cloud/')):
            require((release_root / root).is_dir(), 'RUNTIME_DIRECTORY_REQUIRED')
        actual_runtime = {**self.file_digests(release_root / 'apps/teaching', 'apps/teaching/'),
                          **self.file_digests(release_root / 'tools/i0-cloud', 'tools/i0-cloud/')}
        require(actual_runtime == expected_runtime, 'RUNTIME_FILE_DIGEST_MISMATCH')
        digest_map_path = dist / 'asset-digests.json'
        require(digest_map_path.is_file(), 'STATIC_DIGEST_MAP_REQUIRED')
        try:
            digest_map = json.loads(digest_map_path.read_text(encoding='utf-8'))
        except ValueError:
            raise DeploymentError('STATIC_DIGEST_MAP_REQUIRED') from None
        require(digest_map == manifest['staticDigests'], 'STATIC_DIGEST_MAP_MISMATCH')
        require(all(actual_static.get(name) == value for name, value in manifest['staticDigests'].items()),
                'STATIC_DIGEST_MAP_MISMATCH')
        entry = self.static_entry(dist)
        require(entry == {'indexSha256': manifest['indexSha256'], 'entryJs': manifest['entryJs'],
                          'entryJsSha256': manifest['entryJsSha256']}, 'BUILT_ENTRY_MISMATCH')

    def matches_manifest(self, release, manifest):
        try:
            self.validate_manifest(manifest, manifest['commit'], manifest['gitTree'], require_artifact_digest=False)
            self.verify_tree(release, manifest)
            return True
        except (OSError, ValueError, KeyError, DeploymentError):
            return False

    # Steady-state check for the every-five-minutes timer and --status: a full
    # digest pass over node_modules would compete with the business for CPU and
    # IO, so an already-verified release is only compared by path and size.
    # Truncation, deletions and stray files are caught; in-place same-size
    # damage is left to the publish-time verify and the served-asset probe.
    def tree_shape_matches(self, release, manifest):
        try:
            expected = {entry['path']: entry['bytes']
                        for key in ('runtimeFiles', 'staticFiles') for entry in manifest[key]}
            actual = {**self.file_sizes(release / 'apps/teaching', 'apps/teaching/'),
                      **self.file_sizes(release / 'tools/i0-cloud', 'tools/i0-cloud/'),
                      **self.file_sizes(release / 'apps/student/dist', '')}
            return actual == expected
        except (OSError, ValueError, KeyError, TypeError):
            return False

    # --- release assembly, backup, switch and health ---------------------------

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

    # --- entry points ----------------------------------------------------------

    def status(self):
        self.read_only = True
        remote = self.remote_commit()
        manifest = self.deployed_manifest()
        deployed = manifest.get('commit')
        active = self.service_active()
        aligned = active and self.tree_shape_matches(self.current_release(), manifest)
        health = None
        if aligned:
            try:
                require(self.service_matches_current(), 'RUNNING_RELEASE_MISMATCH')
                self.probe_once(manifest)
                health = {'live': 'alive', 'ready': 'ready', 'servedAssets': 'match'}
            except (OSError, ValueError, DeploymentError, http.client.HTTPException) as error:
                aligned = False
                health = {'failed': error.code if isinstance(error, DeploymentError) else 'HEALTH_HTTP_FAILED'}
        artifact = None
        if remote != deployed or not aligned:
            try:
                artifact = self.published_release(remote) is not None
            except (OSError, ValueError, DeploymentError):
                artifact = None
        disk = self.disk_state()
        releases = self.release_entries()
        try:
            previous = json.loads(Path(self.config['statusFile']).read_text(encoding='utf-8'))
        except (OSError, ValueError):
            previous = None
        actions = []
        if not active:
            actions.append('application service is not active: run systemctl status ' + self.config['applicationService'])
        if active and not aligned:
            if isinstance(health, dict) and health.get('failed'):
                actions.append('health check failed (' + health['failed'] + '): inspect journalctl -u '
                               + self.config['applicationService'] + ' and the last deployment status')
            else:
                actions.append('deployed release does not match its manifest: redeploy with the release tooling or roll back')
        if remote != deployed:
            if artifact:
                actions.append('a published artifact for ' + remote + ' is waiting: run the deploy service or its timer')
            elif artifact is None:
                actions.append('artifact availability for ' + remote + ' could not be checked: inspect GitHub access')
            else:
                actions.append('no artifact published for ' + remote + ' yet: check the cloud-release workflow run')
        if disk['blocked']:
            actions.append('disk is below the deploy floor: run --prune and clear expendable data; business data is never pruned')
        elif disk['warning']:
            actions.append('disk is below the warning line: run --prune to drop superseded releases and deploy backups')
        memory = self.available_memory_bytes()
        if memory is not None and memory < 384 * 1024 * 1024:
            actions.append('available memory is low: inspect the application service before it degrades')
        try:
            load = [round(value, 2) for value in os.getloadavg()]
        except OSError:
            load = None
        cpus = os.cpu_count()
        if load is not None and cpus and load[0] > 2 * cpus:
            actions.append('cpu load is above twice the vCPU count: inspect the application and maintenance units')
        return {'remoteCommit': remote, 'deployedCommit': deployed,
                'upToDate': remote == deployed and aligned, 'serviceActive': active, 'health': health,
                'artifactPublished': artifact, 'disk': disk,
                'memoryAvailableBytes': memory, 'cpuCount': cpus, 'loadAverage': load,
                'releases': [{'name': entry['name'], 'commit': entry['commit'], 'pinned': entry['pinned']}
                             for entry in releases],
                'lastDeployment': previous, 'actions': actions}

    def apply(self):
        self.read_only = False
        previous = self.current_release()
        self.read_application()
        staging = None
        switched = False
        backup = None
        commit = None
        try:
            commit = self.remote_commit()
            current_manifest = self.deployed_manifest()
            if current_manifest.get('commit') == commit and self.service_active() and self.tree_shape_matches(previous, current_manifest):
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
            disk = self.disk_state()
            if disk['blocked']:
                result = {'status': 'blocked', 'code': 'LOW_DISK', 'remoteCommit': commit,
                          'deployedCommit': self.deployed_manifest().get('commit'), 'disk': disk,
                          'note': 'existing business keeps running; no artifact is downloaded or assembled'}
                self.write_status(result)
                return result
            self.remove_stale_staging()
            self.remove_legacy_work_files()
            release_assets = self.published_release(commit)
            if release_assets is None:
                result = {'status': 'blocked', 'code': 'ARTIFACT_PENDING', 'remoteCommit': commit,
                          'deployedCommit': self.deployed_manifest().get('commit'),
                          'note': 'CI has not published the artifact for the current main commit yet'}
                self.write_status(result)
                return result
            tree = self.remote_tree(commit)
            staging = Path(tempfile.mkdtemp(prefix='staging-', dir=self.work))
            manifest_path = self.work / ('manifest-' + uuid.uuid4().hex + '.json')
            try:
                self.download_asset(release_assets['manifest.json'], manifest_path, MANIFEST_LIMIT, 'MANIFEST_DOWNLOAD_FAILED')
                manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            finally:
                if manifest_path.exists():
                    manifest_path.unlink()
            manifest = self.validate_manifest(manifest, commit, tree)
            archive = self.work / ('artifact-' + uuid.uuid4().hex + '.tar.gz')
            try:
                self.download_asset(release_assets['runtime.tar.gz'], archive, ARTIFACT_LIMIT, 'ARTIFACT_DOWNLOAD_FAILED')
                require(digest_file(archive) == manifest['artifactSha256'], 'ARTIFACT_DIGEST_MISMATCH')
                self.extract_artifact(archive, staging)
            finally:
                if archive.exists():
                    archive.unlink()
            self.verify_tree(staging, manifest)
            release = self.releases / ('main-' + commit)
            if release.exists():
                if not self.matches_manifest(release, manifest):
                    release = self.releases / ('main-' + commit + '-' + uuid.uuid4().hex[:12])
            if not release.exists():
                self.publish_release(staging, release, manifest)
                staging = None
            require(self.remote_commit() == commit, 'REMOTE_MAIN_CHANGED')
            backup = self.backup(previous)
            pruned_backups = self.prune_backups()
            self.switch_link(release)
            switched = True
            self.restart_service()
            self.probe(manifest)
            require(self.service_matches_current(), 'RUNNING_RELEASE_MISMATCH')
            pruned_releases = self.prune_releases()
            result = {'status': 'deployed', 'commit': commit, 'gitTree': manifest['gitTree'],
                      'artifactSha256': manifest['artifactSha256'], 'indexSha256': manifest['indexSha256'],
                      'entryJs': manifest['entryJs'], 'entryJsSha256': manifest['entryJsSha256'],
                      'deployedAt': utc_now(), 'remoteCommit': commit, 'deployedCommit': commit,
                      'upToDate': True, 'serviceActive': True, 'backup': backup,
                      'prunedReleases': pruned_releases, 'prunedBackups': pruned_backups}
            self.write_status(result)
            return result
        except Exception as error:
            code = error.code if isinstance(error, DeploymentError) else 'DEPLOYMENT_FAILED'
            rollback = 'not_needed'
            if switched:
                try:
                    self.switch_link(previous)
                    self.restart_service()
                    previous_manifest = self.deployed_manifest()
                    if previous_manifest:
                        self.probe(previous_manifest)
                    rollback = 'previous_release_restarted'
                except Exception:
                    rollback = 'failed'
            actual = self.deployed_manifest().get('commit')
            self.write_status({'status': 'failed', 'code': code, 'attemptedCommit': commit,
                               'deployedCommit': actual, 'rollback': rollback, 'backup': backup, 'at': utc_now()})
            raise DeploymentError(code) from None
        finally:
            self.remove_staging(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--prune', action='store_true')
    arguments = parser.parse_args()
    require(sys.platform == 'linux' and platform_module.machine() in ('x86_64', 'amd64') and os.geteuid() == 0, 'LINUX_ROOT_REQUIRED')
    deployment = ArtifactDeployment(read_json(arguments.config))
    if arguments.status:
        print(json.dumps(deployment.status(), separators=(',', ':')))
        return
    import fcntl
    deployment.work.mkdir(parents=True, exist_ok=True, mode=0o755)
    require(not deployment.work.is_symlink(), 'CONTROLLED_WORK_DIRECTORY_REQUIRED')
    os.chown(deployment.work, 0, 0)
    deployment.work.chmod(0o755)
    lock = deployment.work / 'deploy-artifact.lock'
    require(not lock.is_symlink(), 'CONTROLLED_LOCK_REQUIRED')
    with lock.open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeploymentError('DEPLOYMENT_ALREADY_RUNNING') from None
        if arguments.prune:
            deployment.remove_stale_staging()
            print(json.dumps({'status': 'pruned', 'releases': deployment.prune_releases(),
                              'backups': deployment.prune_backups()}, separators=(',', ':')))
            return
        print(json.dumps(deployment.apply(), separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'code': error.code if isinstance(error, DeploymentError) else 'DEPLOYMENT_FAILED'}), file=sys.stderr)
        sys.exit(1)
