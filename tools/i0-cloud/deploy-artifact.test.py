"""Artifact deployment tests; no Git remote or service is contacted."""

from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import time
import unittest
import urllib.error
from unittest import mock


SCRIPT = Path(__file__).with_name("deploy-artifact.py")
SPEC = importlib.util.spec_from_file_location("xunjie_deploy_artifact", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
deploy_artifact = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = deploy_artifact
with mock.patch.object(sys, "dont_write_bytecode", True):
    SPEC.loader.exec_module(deploy_artifact)

OLD_COMMIT = "1" * 40
NEW_COMMIT = "2" * 40
LATER_COMMIT = "3" * 40
TREE = "4" * 40
LATER_TREE = "5" * 40
ENTRY_JS = "/assets/index-test.js"
ARTIFACT_COMMIT = '6' * 40
GIB = 1024 * 1024 * 1024


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class GithubResponse(io.BytesIO):
    status = 200

    def __init__(self, content: bytes, url: str) -> None:
        super().__init__(content)
        self.url = url
        self.headers = {"Content-Length": str(len(content))}

    def geturl(self) -> str:
        return self.url

    def getcode(self) -> int:
        return self.status


def artifact_tree(root: Path, script: bytes, marker: str) -> dict[str, bytes]:
    """A CI-shaped runtime tree with per-file digests."""
    dist = root / "apps/web/dist"
    (dist / "assets").mkdir(parents=True)
    index = ('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>x</title></head>'
             + '<body><div id="root"></div><script type="module" crossorigin src="/assets/index-test.js"></script></body></html>').encode()
    (dist / "index.html").write_bytes(index)
    (dist / ENTRY_JS.removeprefix("/")).write_bytes(script)
    (dist / "assets/site.css").write_bytes(b".rule { color: black; }\n")
    (dist / "assets/index-test.js.br").write_bytes(b"\x0bcompressed-brotli-" + marker.encode())
    (dist / "assets/index-test.js.gz").write_bytes(b"\x1fcompressed-gzip-" + marker.encode())
    teaching = root / "apps/server"
    for name, content in {
        "dist/server/main.js": b"export const runtime = 'teaching';\n",
        "dist/server/app.js": b"export const app = true;\n",
        "dist/contracts/access.js": b"export const authenticated = true;\n",
        "dist/runner/snapshot.js": b"export const snapshot = 'fixed';\n",
        "package.json": b'{"type":"module"}\n',
        "package-lock.json": b'{"lockfileVersion":3}\n',
        "node_modules/zod/index.js": b"export const productionDependency = true;\n",
        "node_modules/better-sqlite3/prebuilds/linux-x64.node": b"fixture-native-production-module",
    }.items():
        path = (root if name.startswith("node_modules/") or name == "package-lock.json" else teaching) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    (root / "package.json").write_bytes(b'{"type":"module"}\n')
    cloud_host = root / "tools/i0-cloud/cloud-host.mjs"
    cloud_host.parent.mkdir(parents=True, exist_ok=True)
    cloud_host.write_bytes(b"export const host = 'original';\n")
    return index


def manifest_for(root: Path, commit: str, tree: str, index: bytes, script: bytes) -> dict:
    dist = root / "apps/web/dist"
    static_files = sorted(path for path in dist.rglob("*") if path.is_file())
    static_digests = {path.relative_to(dist).as_posix(): sha256(path.read_bytes())
                      for path in static_files if path.name != "asset-digests.json"}
    (dist / "asset-digests.json").write_text(json.dumps(static_digests), encoding="utf-8")
    static_files = sorted(path for path in dist.rglob("*") if path.is_file())
    static_entries = [{"path": path.relative_to(dist).as_posix(), "sha256": sha256(path.read_bytes()),
                       "bytes": path.stat().st_size} for path in static_files]
    runtime_entries = []
    for base, prefix in ((root / "apps/server", "apps/server/"), (root / "tools/i0-cloud", "tools/i0-cloud/"), (root / "node_modules", "node_modules/")):
        runtime_entries += [{"path": prefix + path.relative_to(base).as_posix(), "sha256": sha256(path.read_bytes()),
                             "bytes": path.stat().st_size}
                            for path in sorted(base.rglob("*")) if path.is_file()]
    runtime_entries += [{"path": name, "sha256": sha256((root / name).read_bytes()), "bytes": (root / name).stat().st_size} for name in ("package.json", "package-lock.json")]
    return {
        "format": "xunjie-runtime-artifact", "version": 1, "commit": commit, "gitTree": tree,
        "platform": "linux-x64", "nodeVersion": "v24.21.0", "builtAt": "2026-10-23T00:00:00Z",
        "runtimeFiles": runtime_entries, "staticFiles": static_entries,
        "runtimeSha256": "0" * 64, "staticSha256": "0" * 64,
        "indexSha256": sha256(index), "entryJs": ENTRY_JS, "entryJsSha256": sha256(script),
        "staticDigests": static_digests,
    }


def branch_bundle(manifest: bytes, archive: bytes, prefix: str = "xunjie-cloud-artifacts",
                  extra: tuple[str, bytes] | None = None,
                  names: tuple[str, str] = ("manifest.json", "runtime.tar.gz")) -> bytes:
    """A CI-shaped cloud-artifacts branch tarball."""
    output = io.BytesIO()
    contents = [(prefix + "/" + names[0], manifest), (prefix + "/" + names[1], archive)]
    if extra is not None:
        contents.append((prefix + "/" + extra[0], extra[1]))
    with tarfile.open(fileobj=output, mode="w:gz") as bundle:
        for name, content in contents:
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            bundle.addfile(entry, io.BytesIO(content))
    return output.getvalue()


def pack_archive(root: Path) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for path in sorted(root.rglob("*")):
            name = path.relative_to(root).as_posix()
            if path.is_symlink():
                entry = tarfile.TarInfo(name)
                entry.type = tarfile.SYMTYPE
                entry.linkname = os.readlink(path)
                archive.addfile(entry)
            elif path.is_dir():
                entry = tarfile.TarInfo(name)
                entry.type = tarfile.DIRTYPE
                archive.addfile(entry)
            else:
                content = path.read_bytes()
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                archive.addfile(entry, io.BytesIO(content))
    return output.getvalue()


def write_release(release: Path, commit: str, tree: str, script: bytes, marker: str) -> None:
    index = artifact_tree(release, script, marker)
    manifest = manifest_for(release, commit, tree, index, script)
    (release / "deployment.json").write_text(json.dumps(manifest), encoding="utf-8")
    (release / "deployment.json").chmod(0o644)


class ArtifactDeploymentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="xunjie-deploy-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.releases = self.root / "releases"
        self.releases.mkdir()
        self.old_release = self.releases / ("main-" + OLD_COMMIT)
        write_release(self.old_release, OLD_COMMIT, TREE, b"console.log('previous');\n", "previous")
        self.current = self.root / "current"
        try:
            self.current.symlink_to(self.old_release, target_is_directory=True)
        except OSError as error:
            if os.name == "nt" and getattr(error, "winerror", None) == 1314:
                self.skipTest("Windows symlink permission unavailable; run with WSL Python")
            raise
        self.database = self.root / "records.sqlite"
        self.database.write_bytes(b"existing application database")
        self.certificate = self.root / "private-ca.pem"
        self.certificate.write_text("fixture certificate", encoding="utf-8")
        self.application = {
            "staticDirectory": str(self.current / "apps/web/dist"),
            "databaseFile": str(self.database),
            "tls": {"certFile": str(self.certificate)},
        }
        self.application_file = self.root / "application.json"
        self.application_file.write_text(json.dumps(self.application), encoding="utf-8")
        self.status_file = self.root / "deployment-status.json"
        self.backup_directory = self.root / "backups"
        self.backup_directory.mkdir()
        self.work = self.root / "work"
        self.work.mkdir()
        self.node = self.root / "node/bin"
        self.node.mkdir(parents=True)
        self.config = {
            "repositoryUrl": "https://github.com/example-team/xunjie.git",
            "releasesDirectory": str(self.releases),
            "currentLink": str(self.current),
            "workDirectory": str(self.work),
            "nodeBinDirectory": str(self.node),
            "applicationConfigFile": str(self.application_file),
            "applicationService": "fixture-application.service",
            "healthUrl": "https://127.0.0.1:3444",
            "statusFile": str(self.status_file),
            "backupDirectory": str(self.backup_directory),
            "artifactTagPrefix": "cloud",
            "minimumFreeBytes": 5 * GIB,
            "warningFreeBytes": 10 * GIB,
            "keepReleases": 3,
            "keepBackups": 3,
        }
        ownership = mock.patch.object(deploy_artifact.os, "chown", create=True)
        ownership.start()
        self.addCleanup(ownership.stop)
        self.deployment = deploy_artifact.ArtifactDeployment(copy.deepcopy(self.config))
        self.deployment.read_application = mock.Mock(return_value=self.application)
        self.deployment.run = mock.Mock(
            side_effect=lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, "", "")
        )
        self.deployment.remote_commit = mock.Mock(return_value=NEW_COMMIT)
        self.deployment.remote_tree = mock.Mock(return_value=TREE)
        self.deployment.backup = mock.Mock(side_effect=self.backup)
        self.deployment.probe = mock.Mock()
        self.deployment.probe_once = mock.Mock()
        self.deployment.restart_service = mock.Mock()
        self.deployment.service_active = mock.Mock(return_value=True)
        self.deployment.service_matches_current = mock.Mock(return_value=True)
        self.deployment.free_bytes = mock.Mock(return_value=100 * GIB)
        # A fresh CI artifact for NEW_COMMIT, as CI would publish it.
        self.artifact_root = self.root / "ci-artifact"
        self.artifact_script = b"console.log('new build');\n"
        self.artifact_index = artifact_tree(self.artifact_root, self.artifact_script, "candidate")
        self.manifest = manifest_for(self.artifact_root, NEW_COMMIT, TREE, self.artifact_index, self.artifact_script)
        self.tarball = pack_archive(self.artifact_root)
        self.manifest["artifactSha256"] = sha256(self.tarball)
        self.release_assets = {
            "manifest.json": {"name": "manifest.json", "url": "https://api.github.com/repos/example-team/xunjie/releases/assets/1",
                              "size": 1024},
            "runtime.tar.gz": {"name": "runtime.tar.gz", "url": "https://api.github.com/repos/example-team/xunjie/releases/assets/2",
                               "size": len(self.tarball)},
        }
        self.refresh_release_assets()
        self.publication = {'assets': self.release_assets, 'artifactCommit': ARTIFACT_COMMIT}
        self.deployment.published_release = mock.Mock(return_value=self.publication)
        self.deployment.download_artifact_files = mock.Mock(side_effect=self.download_artifact_files)

    def refresh_release_assets(self):
        for name, content in (('manifest.json', json.dumps(self.manifest).encode()), ('runtime.tar.gz', self.tarball)):
            self.release_assets[name].update(size=len(content), digest='sha256:' + sha256(content))

    def download_artifact_files(self, manifest_path: Path, archive_path: Path, artifact_commit: str) -> dict:
        self.assertEqual(artifact_commit, ARTIFACT_COMMIT)
        manifest = json.dumps(self.manifest).encode()
        manifest_path.write_bytes(manifest)
        archive_path.write_bytes(self.tarball)
        return {"manifest.json": len(manifest), "runtime.tar.gz": len(self.tarball)}

    def backup(self, current_release: Path) -> dict:
        self.assertEqual(Path(current_release).resolve(), self.old_release.resolve())
        destination = self.backup_directory / "before-deploy.sqlite"
        contents = self.database.read_bytes()
        destination.write_bytes(contents)
        return {"path": str(destination), "sha256": sha256(contents)}

    def test_upgrade_backs_up_committed_records_with_the_previous_runtime_layout(self) -> None:
        shutil.rmtree(self.old_release / 'apps/server')
        shutil.rmtree(self.old_release / 'node_modules')
        previous_app = self.old_release / 'apps/teaching'
        previous_app.mkdir(parents=True)
        (previous_app / 'package.json').write_text('{"type":"module"}\n', encoding='utf-8')
        (previous_app / 'node_modules').symlink_to(SCRIPT.parents[2] / 'node_modules', target_is_directory=True)
        (self.node / 'node').symlink_to(Path(shutil.which('node')).resolve())
        self.database.unlink()
        with contextlib.closing(sqlite3.connect(self.database)) as database, database:
            database.execute('CREATE TABLE records (body TEXT NOT NULL)')
            database.execute('INSERT INTO records VALUES (?)', ('confirmed before upgrade',))
        self.deployment.run = deploy_artifact.ArtifactDeployment.run.__get__(self.deployment)

        receipt = deploy_artifact.ArtifactDeployment.backup(self.deployment, self.old_release)

        with contextlib.closing(sqlite3.connect(receipt['path'])) as backup:
            self.assertEqual(backup.execute('SELECT body FROM records').fetchall(), [('confirmed before upgrade',)])
        self.assertEqual(receipt['sha256'], sha256(Path(receipt['path']).read_bytes()))
        self.assert_previous_release()

    def release_commit(self) -> str | None:
        release = self.current.resolve()
        manifest = release / "deployment.json"
        return json.loads(manifest.read_text(encoding="utf-8"))["commit"] if manifest.exists() else None

    def assert_previous_release(self) -> None:
        self.assertTrue(self.current.is_symlink())
        self.assertEqual(self.current.resolve(), self.old_release.resolve())

    def assert_failed_with(self, code: str) -> None:
        if code != 'RELEASE_ASSET_DIGEST_MISMATCH':
            self.refresh_release_assets()
        with self.assertRaises(deploy_artifact.DeploymentError) as raised:
            self.deployment.apply()
        self.assertEqual(raised.exception.code, code)
        self.assert_previous_release()
        status = json.loads(self.status_file.read_text(encoding="utf-8"))
        self.assertEqual(status["deployedCommit"], OLD_COMMIT)
        self.assertEqual(status["status"], "failed")

    # --- steady state and blocked paths ---------------------------------------

    def test_unchanged_remote_keeps_current_release_without_downloading(self) -> None:
        self.deployment.remote_commit = mock.Mock(return_value=OLD_COMMIT)
        result = self.deployment.apply()
        self.assertEqual(result["status"], "unchanged")
        self.assertTrue(result["upToDate"])
        self.deployment.published_release.assert_not_called()
        self.deployment.download_artifact_files.assert_not_called()
        self.deployment.restart_service.assert_not_called()
        self.assert_previous_release()

    def test_steady_state_does_not_rehash_the_runtime_tree(self) -> None:
        self.deployment.remote_commit = mock.Mock(return_value=OLD_COMMIT)
        runtime_file = self.old_release / "apps/server/dist/server/main.js"
        original = runtime_file.read_bytes()
        damaged = b"export const runtime = 'damage!!';\n"
        # Same-size in-place damage must stay invisible to the every-five-minutes
        # run: the timer only compares paths and sizes, publish-time verification
        # and the served-asset probe own content integrity.
        self.assertEqual(len(damaged), len(original))
        runtime_file.write_bytes(damaged)
        result = self.deployment.apply()
        self.assertEqual(result["status"], "unchanged")
        self.deployment.download_artifact_files.assert_not_called()
        self.assert_previous_release()

    def test_truncated_release_file_breaks_the_unchanged_shortcut(self) -> None:
        self.deployment.remote_commit = mock.Mock(return_value=OLD_COMMIT)
        (self.old_release / "apps/server/dist/server/main.js").write_bytes(b"truncated")
        # The size-only shape check detects the truncation and the deploy path
        # re-runs; the fixture artifact is for another commit, so verification
        # fails and rolls back without touching the current release.
        self.assert_failed_with("MANIFEST_COMMIT_MISMATCH")

    def test_missing_artifact_blocks_deploy_and_keeps_business_running(self) -> None:
        self.deployment.published_release = mock.Mock(return_value=None)
        result = self.deployment.apply()
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["code"], "ARTIFACT_PENDING")
        self.assert_previous_release()
        self.deployment.download_artifact_files.assert_not_called()
        self.deployment.backup.assert_not_called()
        self.deployment.restart_service.assert_not_called()
        status = json.loads(self.status_file.read_text(encoding="utf-8"))
        self.assertEqual(status["code"], "ARTIFACT_PENDING")

    def test_low_disk_refuses_new_artifacts_and_keeps_business_running(self) -> None:
        self.deployment.free_bytes = mock.Mock(return_value=4 * GIB)
        result = self.deployment.apply()
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["code"], "LOW_DISK")
        self.assertTrue(result["disk"]["blocked"])
        self.assert_previous_release()
        self.deployment.published_release.assert_not_called()
        self.deployment.restart_service.assert_not_called()

    def test_warning_disk_still_deploys(self) -> None:
        self.deployment.free_bytes = mock.Mock(return_value=7 * GIB)
        result = self.deployment.apply()
        self.assertEqual(result["status"], "deployed")

    # --- verification failures -------------------------------------------------

    def test_verified_artifact_deploys_with_backup_and_switch(self) -> None:
        result = self.deployment.apply()
        self.assertEqual(result["status"], "deployed")
        self.assertEqual(result["commit"], NEW_COMMIT)
        self.assertEqual(self.release_commit(), NEW_COMMIT)
        new_release = self.releases / ("main-" + NEW_COMMIT)
        self.assertTrue((new_release / "apps/web/dist/index.html").is_file())
        self.assertEqual(json.loads((new_release / "deployment.json").read_text(encoding="utf-8"))["commit"], NEW_COMMIT)
        self.deployment.backup.assert_called_once()
        self.deployment.restart_service.assert_called_once()
        self.deployment.probe.assert_called_once()
        status = json.loads(self.status_file.read_text(encoding="utf-8"))
        self.assertEqual(status["status"], "deployed")
        self.assertEqual(status["backup"]["path"], str(self.backup_directory / "before-deploy.sqlite"))

    def test_artifact_digest_mismatch_refuses_switch(self) -> None:
        self.manifest["artifactSha256"] = "f" * 64
        self.assert_failed_with("ARTIFACT_DIGEST_MISMATCH")
        self.deployment.backup.assert_not_called()
        self.deployment.restart_service.assert_not_called()
        self.assertFalse((self.releases / ("main-" + NEW_COMMIT)).exists())

    def test_branch_bundle_must_match_published_release_digests(self) -> None:
        self.release_assets['manifest.json']['digest'] = 'sha256:' + '0' * 64
        self.release_assets['runtime.tar.gz']['digest'] = 'sha256:' + '0' * 64
        self.assert_failed_with('RELEASE_ASSET_DIGEST_MISMATCH')
        self.deployment.backup.assert_not_called()
        self.deployment.restart_service.assert_not_called()

    def test_manifest_commit_mismatch_refuses_switch(self) -> None:
        self.deployment.remote_tree = mock.Mock(return_value=LATER_TREE)
        self.assert_failed_with("MANIFEST_TREE_MISMATCH")

    def test_manifest_platform_mismatch_refuses_switch(self) -> None:
        self.manifest["platform"] = "darwin-arm64"
        self.assert_failed_with("RUNTIME_PLATFORM_MISMATCH")

    def test_file_digest_mismatch_refuses_switch(self) -> None:
        # The archive digest is self-consistent, but its contents no longer match the per-file digests.
        module = self.artifact_root / "node_modules/zod/index.js"
        module.write_bytes(b"export const tampered = true;\n")
        self.tarball = pack_archive(self.artifact_root)
        self.manifest["artifactSha256"] = sha256(self.tarball)
        self.release_assets["runtime.tar.gz"]["size"] = len(self.tarball)
        self.assert_failed_with("RUNTIME_FILE_DIGEST_MISMATCH")
        self.deployment.restart_service.assert_not_called()

    def test_unsafe_archive_is_rejected(self) -> None:
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for name, content in [
                ("apps/web/dist/index.html", b"<html>"),
                ("../../../etc/passwd", b"unsafe"),
                ("/absolute/path", b"unsafe"),
            ]:
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                archive.addfile(entry, io.BytesIO(content))
            link = tarfile.TarInfo("apps/web/dist/link")
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/passwd"
            archive.addfile(link)
        self.tarball = output.getvalue()
        self.manifest["artifactSha256"] = sha256(self.tarball)
        self.assert_failed_with("UNSAFE_ARTIFACT_ARCHIVE")

    def test_static_digest_map_mismatch_refuses_switch(self) -> None:
        # A manifest whose cache map disagrees with the packed map file must not reach the switch.
        self.manifest["staticDigests"]["assets/index-test.js"] = "0" * 64
        self.assert_failed_with("STATIC_DIGEST_MAP_MISMATCH")

    # --- rollback and race conditions -----------------------------------------

    def test_health_failure_restores_previous_release_and_records_backup(self) -> None:
        def probe_fails_candidate(manifest):
            if manifest.get("commit") == NEW_COMMIT:
                raise deploy_artifact.DeploymentError("APPLICATION_HEALTH_FAILED")
        self.deployment.probe = mock.Mock(side_effect=probe_fails_candidate)
        result = self.assert_rollback()
        self.assertEqual(result["code"], "APPLICATION_HEALTH_FAILED")
        self.assertEqual(result["rollback"], "previous_release_restarted")
        self.assertEqual(result["backup"]["path"], str(self.backup_directory / "before-deploy.sqlite"))

    def test_rollback_failure_is_reported(self) -> None:
        self.deployment.probe = mock.Mock(side_effect=deploy_artifact.DeploymentError("APPLICATION_HEALTH_FAILED"))
        self.deployment.restart_service = mock.Mock(
            side_effect=[None, deploy_artifact.DeploymentError("APPLICATION_RESTART_FAILED")]
        )
        result = self.assert_rollback()
        self.assertEqual(result["rollback"], "failed")

    def assert_rollback(self) -> dict:
        with self.assertRaises(deploy_artifact.DeploymentError) as raised:
            self.deployment.apply()
        self.assert_previous_release()
        status = json.loads(self.status_file.read_text(encoding="utf-8"))
        self.assertEqual(status["status"], "failed")
        self.assertEqual(status["deployedCommit"], OLD_COMMIT)
        return status

    def test_remote_change_during_verification_does_not_switch(self) -> None:
        self.deployment.remote_commit = mock.Mock(side_effect=[NEW_COMMIT, LATER_COMMIT])
        self.assert_failed_with("REMOTE_MAIN_CHANGED")
        self.deployment.backup.assert_not_called()
        self.deployment.restart_service.assert_not_called()
        self.assertFalse((self.releases / ("main-" + NEW_COMMIT)).exists())

    def test_redeploy_of_same_commit_with_broken_manifest_rebuilds_release(self) -> None:
        # A legacy deployment.json without per-file lists cannot prove alignment; the artifact for the
        # same commit is fetched again and the release is rebuilt from it.
        legacy = {"commit": NEW_COMMIT, "indexSha256": "0" * 64}
        broken_release = self.releases / ("main-" + NEW_COMMIT)
        write_release(broken_release, NEW_COMMIT, TREE, b"console.log('leftover');\n", "leftover")
        (broken_release / "deployment.json").write_text(json.dumps(legacy), encoding="utf-8")
        (broken_release / "deployment.json").chmod(0o644)
        self.deployment.remote_commit = mock.Mock(return_value=NEW_COMMIT)
        result = self.deployment.apply()
        self.assertEqual(result["status"], "deployed")
        self.assertEqual(self.release_commit(), NEW_COMMIT)
        rebuilt = self.releases / ("main-" + NEW_COMMIT + "-" + re.search(r"[0-9a-f]{12}$", self.current.resolve().name).group(0))
        self.assertTrue(rebuilt.is_dir())
        self.assertEqual(json.loads((rebuilt / "deployment.json").read_text(encoding="utf-8"))["commit"], NEW_COMMIT)

    # --- retention and work-directory hygiene ---------------------------------

    def make_release(self, name: str, age: float) -> Path:
        release = self.releases / name
        if not release.exists():
            write_release(release, "a" * 40, TREE, b"console.log('old');\n", name)
        manifest = json.loads((release / 'deployment.json').read_text())
        (release / 'health-verified.json').write_text(json.dumps({'commit': manifest['commit'], 'verifiedAt': '2026-10-23T00:00:00Z'}))
        stamp = time.time() - age
        os.utime(release, (stamp, stamp))
        return release

    def test_prune_keeps_current_recent_and_pinned_releases_only(self) -> None:
        current = self.make_release("main-" + ("6" * 40), 0)
        self.current.unlink()
        self.current.symlink_to(current, target_is_directory=True)
        self.make_release("main-" + OLD_COMMIT, 25)  # the previously deployed release
        self.make_release("main-" + ("5" * 40), 100)
        self.make_release("main-" + ("4" * 40), 200)
        self.make_release("main-" + ("3" * 40), 300)
        pinned = self.make_release("main-" + ("2" * 40), 400)
        (pinned / ".pinned").write_text("", encoding="utf-8")
        os.utime(pinned, (time.time() - 400, time.time() - 400))
        foreign = self.releases / "operator-owned-dir"
        foreign.mkdir()
        pruned = self.deployment.prune_releases()
        self.assertEqual(sorted(pruned), ["main-" + "3" * 40, "main-" + "4" * 40])
        for name in ["main-" + "6" * 40, "main-" + OLD_COMMIT, "main-" + "5" * 40, "main-" + "2" * 40]:
            self.assertTrue((self.releases / name).is_dir(), name)
        self.assertTrue(foreign.is_dir())

    def test_prune_keeps_recent_deploy_backups_only(self) -> None:
        for index in range(5):
            path = self.backup_directory / ("main-deploy-100-%032x.sqlite" % index)
            path.write_bytes(b"backup")
            os.utime(path, (time.time() - index * 100, time.time() - index * 100))
        unrelated = self.backup_directory / "operator-backup.sqlite"
        unrelated.write_bytes(b"keep")
        pruned = self.deployment.prune_backups()
        self.assertEqual(len(pruned), 2)
        remaining = sorted(path.name for path in self.backup_directory.glob("main-deploy-*.sqlite"))
        self.assertEqual(len(remaining), 3)
        self.assertTrue(unrelated.exists())

    def test_failed_candidates_never_displace_successful_rollback_versions(self) -> None:
        good = self.make_release('main-' + '7' * 40, 200)
        (good / 'health-verified.json').write_text(json.dumps({'commit': 'a' * 40, 'verifiedAt': '2026-10-23T00:00:00Z'}))
        os.utime(good, (time.time() - 200, time.time() - 200))
        other_good = self.make_release('main-' + '8' * 40, 100)
        (other_good / 'health-verified.json').write_text(json.dumps({'commit': 'a' * 40, 'verifiedAt': '2026-10-23T00:00:00Z'}))
        os.utime(other_good, (time.time() - 100, time.time() - 100))
        failed = [self.make_release('main-' + char * 40, age) for char, age in [('9', 2), ('b', 1)]]
        for path in failed:
            (path / 'health-verified.json').unlink()
        self.deployment.prune_releases()
        self.assertTrue(good.is_dir())
        self.assertTrue(other_good.is_dir())
        self.assertTrue(all(not candidate.exists() for candidate in failed))

    def test_stale_staging_and_legacy_build_files_are_cleaned_under_lock(self) -> None:
        stale = self.work / "staging-crashed"
        stale.mkdir()
        (stale / "leftover").write_text("x", encoding="utf-8")
        legacy_archive = self.work / "source-deadbeef.tar.gz"
        legacy_archive.write_bytes(b"legacy")
        legacy_lock = self.work / "sync-main.lock"
        legacy_lock.write_text("", encoding="utf-8")
        legacy_cache = self.work / "npm-cache"
        legacy_cache.mkdir()
        self.deployment.remove_stale_staging()
        self.deployment.remove_legacy_work_files()
        self.assertFalse(stale.exists())
        self.assertFalse(legacy_archive.exists())
        self.assertFalse(legacy_lock.exists())
        self.assertFalse(legacy_cache.exists())

    # --- GitHub endpoints ------------------------------------------------------

    def github_responses(self, responses: dict[str, object]):
        def open_response(request, **kwargs):
            url = request.full_url if hasattr(request, "full_url") else request
            self.assertIn(url, responses)
            body = responses[url]
            if body is None:
                raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))
            if isinstance(body, GithubResponse):
                return body
            content = body if isinstance(body, bytes) else json.dumps(body).encode()
            return GithubResponse(content, url)
        return open_response

    def test_github_endpoints_use_exact_commit_and_handle_missing_release(self) -> None:
        prefix = "https://api.github.com/repos/example-team/xunjie/"
        ref = {"ref": "refs/heads/main", "object": {"type": "commit", "sha": NEW_COMMIT}}
        commit = {"sha": NEW_COMMIT, "tree": {"sha": TREE}}
        release = {"tag_name": "cloud-" + NEW_COMMIT, "draft": False, "assets": [
            {"name": "manifest.json", "url": prefix + "releases/assets/1", "size": 10, "digest": 'sha256:' + 'a' * 64},
            {"name": "runtime.tar.gz", "url": prefix + "releases/assets/2", "size": 20, "digest": 'sha256:' + 'b' * 64},
        ]}
        binding = {'commit': NEW_COMMIT, 'artifactCommit': ARTIFACT_COMMIT, 'manifestSha256': 'a' * 64, 'artifactSha256': 'b' * 64}
        release['body'] = '<!-- xunjie-artifact-v1 ' + json.dumps(binding) + ' -->'
        artifact_tag = 'cloud-artifact-' + 'a' * 64
        responses = {
            prefix + "git/ref/heads/main": ref,
            prefix + "git/commits/" + NEW_COMMIT: commit,
            prefix + "releases/tags/cloud-" + NEW_COMMIT: release,
            prefix + "releases/tags/cloud-" + LATER_COMMIT: None,
            prefix + 'git/ref/tags/' + artifact_tag: {'ref': 'refs/tags/' + artifact_tag, 'object': {'type': 'commit', 'sha': ARTIFACT_COMMIT}},
        }
        for name in ("remote_commit", "remote_tree", "published_release"):
            setattr(self.deployment, name, getattr(deploy_artifact.ArtifactDeployment, name).__get__(self.deployment))
        with mock.patch.object(deploy_artifact.urllib.request, "urlopen",
                               side_effect=self.github_responses(responses)) as requests:
            self.assertEqual(self.deployment.remote_commit(), NEW_COMMIT)
            self.assertEqual(self.deployment.remote_tree(NEW_COMMIT), TREE)
            assets = self.deployment.published_release(NEW_COMMIT)
            self.assertEqual(set(assets['assets']), {"manifest.json", "runtime.tar.gz"})
            self.assertEqual(assets['artifactCommit'], ARTIFACT_COMMIT)
            self.assertIsNone(self.deployment.published_release(LATER_COMMIT))
        self.assertEqual(requests.call_count, 5)

    def test_github_downloads_reject_nonofficial_endpoints_and_redirect_targets(self):
        with mock.patch.object(deploy_artifact.urllib.request, 'urlopen') as request:
            for url in ('http://codeload.github.com/repo', 'https://evil.example/repo',
                        'https://user@codeload.github.com/repo', 'https://codeload.github.com/repo?redirect=1'):
                with self.assertRaisesRegex(deploy_artifact.DeploymentError, 'OFFICIAL_GITHUB_HTTPS_REQUIRED'):
                    self.deployment.github_open(url)
            request.assert_not_called()
        response = GithubResponse(b'bytes', 'https://evil.example/archive')
        with mock.patch.object(deploy_artifact.urllib.request, 'urlopen', return_value=response):
            with self.assertRaisesRegex(deploy_artifact.DeploymentError, 'GITHUB_RESPONSE_REJECTED'):
                self.deployment.github_open('https://codeload.github.com/repo')
        self.assertTrue(response.closed)

    def test_download_artifact_files_unpacks_the_branch_bundle(self) -> None:
        method = deploy_artifact.ArtifactDeployment.download_artifact_files.__get__(self.deployment)
        manifest = json.dumps(self.manifest).encode()
        url = "https://codeload.github.com/example-team/xunjie/tar.gz/6666666666666666666666666666666666666666"
        responses = {url: GithubResponse(branch_bundle(manifest, self.tarball), url)}
        manifest_path = self.work / "manifest.json"
        archive_path = self.work / "runtime.tar.gz"
        with mock.patch.object(deploy_artifact.urllib.request, "urlopen",
                               side_effect=self.github_responses(responses)):
            sizes = method(manifest_path, archive_path, ARTIFACT_COMMIT)
        self.assertEqual(manifest_path.read_bytes(), manifest)
        self.assertEqual(archive_path.read_bytes(), self.tarball)
        self.assertEqual(sizes["runtime.tar.gz"], len(self.tarball))
        self.assertEqual(sizes["manifest.json"], len(manifest))
        self.assertFalse(list(self.work.glob("bundle-*.tar.gz")))

    def test_download_artifact_files_rejects_malformed_bundles(self) -> None:
        method = deploy_artifact.ArtifactDeployment.download_artifact_files.__get__(self.deployment)
        manifest = json.dumps(self.manifest).encode()
        url = "https://codeload.github.com/example-team/xunjie/tar.gz/6666666666666666666666666666666666666666"
        mixed = io.BytesIO()
        with tarfile.open(fileobj=mixed, mode="w:gz") as bundle:
            for name, content in (("one/manifest.json", manifest), ("one/runtime.tar.gz", self.tarball),
                                  ("two/stray.txt", b"stray")):
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                bundle.addfile(entry, io.BytesIO(content))
        cases = {
            "stray file": branch_bundle(manifest, self.tarball, extra=("readme.md", b"extra")),
            "wrong names": branch_bundle(manifest, self.tarball, names=("a.json", "b.tar.gz")),
            "two prefixes": mixed.getvalue(),
        }
        for label, bundle in cases.items():
            responses = {url: GithubResponse(bundle, url)}
            with mock.patch.object(deploy_artifact.urllib.request, "urlopen",
                                   side_effect=self.github_responses(responses)):
                with self.assertRaises(deploy_artifact.DeploymentError, msg=label):
                    method(self.work / "m.json", self.work / "a.tar.gz", ARTIFACT_COMMIT)
            self.assertFalse((self.work / "m.json").exists(), label)

    # --- status ----------------------------------------------------------------

    def test_status_reports_alignment_disk_releases_and_actions(self) -> None:
        self.deployment.published_release = mock.Mock(return_value=None)
        self.deployment.free_bytes = mock.Mock(return_value=7 * GIB)
        status = self.deployment.status()
        self.assertEqual(status["remoteCommit"], NEW_COMMIT)
        self.assertEqual(status["deployedCommit"], OLD_COMMIT)
        self.assertFalse(status["upToDate"])
        self.assertTrue(status["serviceActive"])
        self.assertEqual(status["health"], {"live": "alive", "ready": "ready", "servedAssets": "match"})
        self.assertTrue(status["disk"]["warning"])
        self.assertIs(status["artifactPublished"], False)
        self.assertEqual([entry["name"] for entry in status["releases"]], ["main-" + OLD_COMMIT])
        self.assertTrue(any("cloud-release" in action for action in status["actions"]))
        self.assertTrue(any("prune" in action for action in status["actions"]))

    def test_status_actions_cover_inactive_service_and_failed_health(self) -> None:
        self.deployment.service_active = mock.Mock(return_value=False)
        status = self.deployment.status()
        self.assertTrue(any("not active" in action for action in status["actions"]))
        self.deployment.service_active = mock.Mock(return_value=True)
        self.deployment.probe_once = mock.Mock(side_effect=deploy_artifact.DeploymentError("READY_CHECK_FAILED"))
        status = self.deployment.status()
        self.assertEqual(status["health"], {"failed": "READY_CHECK_FAILED"})
        self.assertTrue(any("health check failed" in action for action in status["actions"]))

    def test_github_outage_does_not_hide_local_health_or_watermarks(self) -> None:
        self.deployment.remote_commit = mock.Mock(side_effect=deploy_artifact.DeploymentError('GITHUB_REQUEST_FAILED'))
        status = self.deployment.status()
        self.assertIsNone(status['remoteCommit'])
        self.assertEqual(status['health']['ready'], 'ready')
        self.assertGreater(status['disk']['freeBytes'], 0)
        self.assertTrue(any('GitHub main could not be checked' in action for action in status['actions']))

    def monitor_config(self):
        return {'credentialsFile': str(self.root / 'monitor-credentials.json'), 'groupId': '0',
                'dimensions': {'application': 'xunjie-shared'}, 'statusFile': str(self.root / 'monitor-status.json')}

    def test_monitor_dry_run_reports_watermarks_and_failure_without_credentials_or_writes(self) -> None:
        self.status_file.write_text(json.dumps({'status': 'failed', 'rollback': 'previous_release_restarted'}))
        self.deployment.available_memory_bytes = mock.Mock(return_value=300 * 1024 * 1024)
        self.deployment.free_bytes = mock.Mock(return_value=4 * GIB)
        with mock.patch.object(deploy_artifact.http.client, 'HTTPSConnection') as connection:
            result = self.deployment.monitor(self.monitor_config(), dry_run=True)
        metrics = {entry['MetricName']: entry['Value'] for entry in result['metrics']}
        self.assertEqual(metrics['xunjie_application_healthy'], 1)
        self.assertEqual(metrics['xunjie_deployment_healthy'], 0)
        self.assertEqual(metrics['xunjie_disk_free_bytes'], 4 * GIB)
        self.assertEqual(metrics['xunjie_memory_available_bytes'], 300 * 1024 * 1024)
        self.assertEqual(metrics['xunjie_memory_healthy'], 0)
        self.assertEqual(metrics['xunjie_disk_warning_healthy'], 0)
        self.assertEqual(metrics['xunjie_disk_floor_healthy'], 0)
        connection.assert_not_called()
        self.assertFalse(Path(self.monitor_config()['statusFile']).exists())

    def test_monitor_posts_signed_cms_metrics_and_never_prints_credentials(self) -> None:
        settings = self.monitor_config()
        Path(settings['credentialsFile']).write_text(json.dumps({'accessKeyId': 'invalid-monitor-id', 'accessKeySecret': 'invalid-monitor-secret'}))
        connection = mock.MagicMock()
        connection.getresponse.return_value.status = 200
        connection.getresponse.return_value.read.return_value = b'{"Code":"200"}'
        with mock.patch.object(deploy_artifact.http.client, 'HTTPSConnection', return_value=connection):
            result = self.deployment.monitor(settings)
        self.assertEqual(result['status'], 'reported')
        body = deploy_artifact.urllib.parse.parse_qs(connection.request.call_args.args[2])
        self.assertEqual(body['Action'], ['PutCustomMetric'])
        self.assertIn('Signature', body)
        self.assertIn('MetricList.1.MetricName', body)
        self.assertNotIn('invalid-monitor', json.dumps(result))
        self.assertTrue(Path(settings['statusFile']).is_file())
        connection.close.assert_called_once()

    def test_monitor_cms_rejection_is_a_failure_not_a_successful_sample(self) -> None:
        settings = self.monitor_config()
        Path(settings['credentialsFile']).write_text(json.dumps({'accessKeyId': 'invalid-monitor-id', 'accessKeySecret': 'invalid-monitor-secret'}))
        connection = mock.MagicMock()
        connection.getresponse.return_value.status = 200
        connection.getresponse.return_value.read.return_value = b'{"Code":"InvalidAccessKeyId"}'
        with mock.patch.object(deploy_artifact.http.client, 'HTTPSConnection', return_value=connection):
            with self.assertRaisesRegex(deploy_artifact.DeploymentError, 'CMS_REPORT_FAILED'):
                self.deployment.monitor(settings)
        self.assertFalse(Path(settings['statusFile']).exists())


class ArtifactPublicationWorkflowTests(unittest.TestCase):
    def test_cancelled_publication_reuses_verified_content_tag_on_rerun(self):
        # Execute the actual workflow shell against a temporary local bare repo.
        # Only GitHub Release API calls are replaced; no GitHub/network writes.
        workflow = SCRIPT.parents[2] / '.github/workflows/cloud-release.yml'
        step = workflow.read_text().split('      - name: Publish an immutable artifact and its bound release\n', 1)[1]
        script = textwrap.dedent(step.split('        run: |\n', 1)[1].split('      - name:', 1)[0])
        with tempfile.TemporaryDirectory(prefix='xunjie-publication-test-') as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            def git(*args, cwd=source):
                return subprocess.check_output(['git', *args], cwd=cwd, text=True, stderr=subprocess.DEVNULL).strip()
            git('init', '-q', '-b', 'main')
            (source / 'source.txt').write_text('source commit')
            git('add', '.')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'source')
            commit = git('rev-parse', 'HEAD')
            remote = root / 'origin.git'
            git('clone', '--bare', '--quiet', str(source), str(remote))
            runtime = root / 'runner'
            artifact = runtime / 'artifact'
            artifact.mkdir(parents=True)
            (artifact / 'manifest.json').write_text(json.dumps({'commit': commit, 'artifactSha256': sha256(b'archive')}))
            (artifact / 'runtime.tar.gz').write_bytes(b'archive')
            (runtime / 'artifact-summary.json').write_text(json.dumps({'commit': commit, 'artifactSha256': sha256(b'archive')}))
            commands = root / 'bin'
            commands.mkdir()
            gh = commands / 'gh'
            gh.write_text('#!/usr/bin/env python3\n' + textwrap.dedent('''
                import json, os, pathlib, sys
                args=sys.argv[1:]
                state=pathlib.Path(os.environ['GH_TEST_STATE'])
                if args[:1]==['release'] and args[1] in ['delete','create','edit']:
                    with pathlib.Path(os.environ['GH_TEST_MUTATIONS']).open('a') as log:
                        log.write(json.dumps(args)+'\\n')
                if args[0]=='api' and '--include' in args:
                    failure=os.environ.get('QUERY_FAILURE','')
                    if failure=='transport':sys.exit(1)
                    if failure in ['403','503']:
                        print('HTTP/2.0 '+failure+' Error\\r\\n\\r\\n{}');sys.exit(1)
                    if failure=='malformed':
                        print('HTTP/2.0 200 OK\\r\\n\\r\\nnot-json');sys.exit(0)
                    if not state.exists():
                        print('HTTP/2.0 404 Not Found\\n\\n{}');sys.exit(1)
                    value=json.loads(state.read_text())
                    print('HTTP/2.0 200 OK\\n\\n'+json.dumps({'draft':value['isDraft'],'body':value['body']}))
                elif args[:2]==['release','view']:
                    if os.environ.get('QUERY_FAILURE'):sys.exit(1)
                    if not state.exists():sys.exit(1)
                    print(state.read_text())
                elif args[:2]==['release','delete']:
                    state.unlink(missing_ok=True)
                elif args[:2]==['release','create']:
                    body=pathlib.Path(args[args.index('--notes-file')+1]).read_text()
                    state.write_text(json.dumps({'isDraft':True,'body':body}))
                    if os.environ.get('CANCEL_PUBLICATION')=='1':sys.exit(130)
                elif args[:2]==['release','edit']:
                    value=json.loads(state.read_text());value['isDraft']=False
                    state.write_text(json.dumps(value))
                else:sys.exit(2)
            '''))
            gh.chmod(0o755)
            state = root / 'release.json'
            mutations = root / 'release-mutations.jsonl'
            environment = {**os.environ, 'PATH': str(commands) + os.pathsep + os.environ['PATH'],
                           'RUNNER_TEMP': str(runtime), 'GITHUB_SHA': commit, 'TAG': 'cloud-' + commit,
                           'GITHUB_REPOSITORY': 'fixture/runtime',
                           'GH_TEST_STATE': str(state), 'GH_TEST_MUTATIONS': str(mutations)}
            def publish(index, cancel=False, query_failure=''):
                checkout = root / ('checkout-' + str(index))
                git('clone', '--quiet', str(remote), str(checkout))
                env = {**environment, 'CANCEL_PUBLICATION': '1' if cancel else '0', 'QUERY_FAILURE': query_failure,
                       'GIT_AUTHOR_DATE': f'2026-10-23T10:0{index}:00Z', 'GIT_COMMITTER_DATE': f'2026-10-23T10:0{index}:00Z'}
                return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', script], cwd=checkout,
                                      env=env, capture_output=True, text=True)
            first = publish(1, cancel=True)
            self.assertEqual(first.returncode, 130, first.stderr)
            self.assertTrue(json.loads(state.read_text())['isDraft'])
            self.assertEqual([json.loads(line)[1] for line in mutations.read_text().splitlines()], ['create'])
            tag = 'refs/tags/cloud-artifact-' + sha256((artifact / 'manifest.json').read_bytes())
            original = git('--git-dir=' + str(remote), 'rev-parse', tag)
            second = publish(2)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(git('--git-dir=' + str(remote), 'rev-parse', tag), original)
            release = json.loads(state.read_text())
            self.assertFalse(release['isDraft'])
            binding = json.loads(re.search(r'<!-- xunjie-artifact-v1 (\{[^\n]+\}) -->', release['body'])[1])
            self.assertEqual(binding['artifactCommit'], original)
            published = state.read_bytes()
            operations = mutations.read_bytes()
            rerun = publish(0)
            self.assertEqual(rerun.returncode, 0, rerun.stderr)
            self.assertEqual(state.read_bytes(), published)
            self.assertEqual(mutations.read_bytes(), operations, 'published bound Release must be reused without mutations')
            for index, failure in enumerate(['403', '503', 'transport', 'malformed'], 4):
                with self.subTest(query_failure=failure):
                    unknown = publish(index, query_failure=failure)
                    self.assertNotEqual(unknown.returncode, 0, 'unknown query errors must not authorize replacing a Release')
                    self.assertEqual(state.read_bytes(), published)
                    self.assertEqual(mutations.read_bytes(), operations, 'query failure must not mutate Releases')
            # A conflicting archive under the same manifest name must not reuse
            # the tag or make a Release public, even after an interrupted run.
            release['isDraft'] = True
            state.write_text(json.dumps(release))
            (artifact / 'runtime.tar.gz').write_bytes(b'different archive')
            third = publish(3)
            self.assertNotEqual(third.returncode, 0)
            self.assertTrue(json.loads(state.read_text())['isDraft'])
            self.assertEqual(git('--git-dir=' + str(remote), 'rev-parse', tag), original)


if __name__ == "__main__":
    unittest.main()
