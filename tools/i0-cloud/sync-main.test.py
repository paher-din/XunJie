"""Isolated deployment transition tests; no Git remote or service is contacted."""

from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("sync-main.py")
SPEC = importlib.util.spec_from_file_location("xunjie_sync_main", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
sync_main = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sync_main
with mock.patch.object(sys, "dont_write_bytecode", True):
    SPEC.loader.exec_module(sync_main)

OLD_COMMIT = "1" * 40
NEW_COMMIT = "2" * 40
LATER_COMMIT = "3" * 40
TREE = "4" * 40
ENTRY_JS = "/assets/index-test.js"


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


def source_archive(entries: list[tuple[str, bytes | None, str | None]]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, content, target in entries:
            entry = tarfile.TarInfo(name)
            if target is not None:
                entry.type = tarfile.SYMTYPE
                entry.linkname = target
                archive.addfile(entry)
            elif content is None:
                entry.type = tarfile.DIRTYPE
                archive.addfile(entry)
            else:
                entry.size = len(content)
                archive.addfile(entry, io.BytesIO(content))
    return output.getvalue()


class DeploymentSynchronizerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="xunjie-sync-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.releases = self.root / "releases"
        self.releases.mkdir()
        self.old_release = self.releases / ("main-" + OLD_COMMIT)
        self.write_dist(self.old_release, b"console.log('previous');\n")
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
            "staticDirectory": str(self.current / "apps/student/dist"),
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
            "buildUser": "fixture-build-user",
            "nodeBinDirectory": str(self.node),
            "applicationConfigFile": str(self.application_file),
            "applicationService": "fixture-application.service",
            "healthUrl": "https://127.0.0.1:3444",
            "statusFile": str(self.status_file),
            "backupDirectory": str(self.backup_directory),
        }
        ownership = mock.patch.object(sync_main.os, "chown", create=True)
        ownership.start()
        self.addCleanup(ownership.stop)
        self.synchronizer = sync_main.DeploymentSynchronizer(copy.deepcopy(self.config))
        old_manifest = self.synchronizer.release_manifest(self.old_release, OLD_COMMIT, TREE)
        (self.old_release / "deployment.json").write_text(
            json.dumps(old_manifest), encoding="utf-8"
        )
        self.synchronizer.read_application = mock.Mock(return_value=self.application)
        self.synchronizer.run = mock.Mock(
            side_effect=lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, "", "")
        )
        self.synchronizer.remote_commit = mock.Mock(return_value=NEW_COMMIT)
        self.expected_source_commit = NEW_COMMIT
        self.synchronizer.fetch_source = mock.Mock(side_effect=self.fetch_source)
        self.synchronizer.build = mock.Mock()
        self.synchronizer.backup = mock.Mock(side_effect=self.backup)
        self.synchronizer.probe = mock.Mock()
        self.synchronizer.probe_once = mock.Mock()
        self.synchronizer.restart_service = mock.Mock()
        self.synchronizer.service_active = mock.Mock(return_value=True)
        self.synchronizer.service_matches_current = mock.Mock(return_value=True)

    @staticmethod
    def write_dist(release: Path, script: bytes) -> None:
        dist = release / "apps/student/dist"
        (dist / "assets").mkdir(parents=True, exist_ok=True)
        (dist / "index.html").write_text(
            '<!doctype html><script type="module" crossorigin src="/assets/index-test.js"></script>',
            encoding="utf-8",
        )
        (dist / ENTRY_JS.removeprefix("/")).write_bytes(script)
        (dist / "assets/site.css").write_bytes(b"body { color: black; }\n")
        source = release / "apps/teaching/server/main.ts"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("export const sourceVersion = 'fixture';\n", encoding="utf-8")

    def fetch_source(self, staging: Path, commit: str) -> str:
        self.assertEqual(commit, self.expected_source_commit)
        self.write_dist(Path(staging), b"console.log('new source');\n")
        runtime_files = {
            "apps/teaching/contracts/access.ts": b"export const authenticated = true;\n",
            "apps/teaching/runner/snapshot.ts": b"export const snapshot = 'fixed';\n",
            "apps/teaching/package.json": b'{"type":"module"}\n',
            "apps/teaching/package-lock.json": b'{"lockfileVersion":3}\n',
            "apps/teaching/tools/check-runtime.mjs": b"export const approved = 'v24.21.0';\n",
            "apps/teaching/node_modules/zod/index.js": b"export const productionDependency = true;\n",
            "apps/teaching/node_modules/better-sqlite3/prebuilds/linux-x64.node": b"fixture-native-production-module",
            "tools/i0-cloud/cloud-host.mjs": b"export const host = 'original';\n",
        }
        for name, content in runtime_files.items():
            path = staging / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        return TREE

    def test_prepare_runtime_keeps_production_inputs_and_excludes_build_and_test_files(self) -> None:
        staging = self.work / "staging-full-source"
        staging.mkdir()
        self.fetch_source(staging, NEW_COMMIT)
        excluded = [
            "README.md", "docs/product/PRD.md", "apps/student/src/main.tsx",
            "apps/student/node_modules/vite/bin/vite.js",
            "apps/teaching/dist/server/main.js", "apps/teaching/tests/access.test.ts",
            "apps/teaching/server/access.test.ts", "apps/teaching/server/tests/fixture.ts",
            "apps/teaching/contracts/__tests__/access.ts", "apps/teaching/runner/test/snapshot.ts",
            "tools/i0-cloud/sync-main.test.py",
        ]
        for name in excluded:
            path = staging / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"development or test input only\n")

        source_digest = self.synchronizer.runtime_digest(staging)
        runtime = self.synchronizer.prepare_runtime(staging)
        self.assertIsInstance(runtime, Path)
        self.assertNotEqual(runtime, staging)
        self.assertEqual(runtime.parent, self.work)
        self.assertTrue(staging.is_dir())
        for name in excluded:
            self.assertFalse((runtime / name).exists(), name)
        self.assertEqual(sorted(path.name for path in runtime.iterdir()), ["apps", "tools"])
        self.assertEqual(sorted(path.name for path in (runtime / "apps/student").iterdir()), ["dist"])
        for name in (
            "apps/student/dist/index.html", "apps/student/dist/assets/index-test.js",
            "apps/student/dist/assets/site.css", "apps/teaching/server/main.ts",
            "apps/teaching/contracts/access.ts", "apps/teaching/runner/snapshot.ts",
            "apps/teaching/package.json", "apps/teaching/package-lock.json",
            "apps/teaching/tools/check-runtime.mjs", "tools/i0-cloud/cloud-host.mjs",
            "apps/teaching/node_modules/zod/index.js",
            "apps/teaching/node_modules/better-sqlite3/prebuilds/linux-x64.node",
        ):
            self.assertEqual((runtime / name).read_bytes(), (staging / name).read_bytes(), name)
        self.assertEqual(self.synchronizer.runtime_digest(runtime), source_digest)
        manifest = self.synchronizer.release_manifest(runtime, NEW_COMMIT, TREE)
        self.assertEqual(manifest["runtimeSha256"], source_digest)
        self.assertEqual(manifest["entryJs"], ENTRY_JS)
        self.assertEqual(manifest["staticSha256"], self.synchronizer.release_manifest(staging, NEW_COMMIT, TREE)["staticSha256"])

    @unittest.skipUnless(os.name == "posix", "the Linux build uses the existing pwd account")
    def test_build_reuses_running_production_dependencies_only_with_matching_lock(self) -> None:
        package = b'{"type":"module","dependencies":{"zod":"fixed"}}\n'
        locked = b'{"lockfileVersion":3,"dependencies":"fixed"}\n'
        previous = self.old_release / "apps/teaching"
        (previous / "package.json").write_bytes(package)
        (previous / "package-lock.json").write_bytes(locked)
        module = previous / "node_modules/zod/index.js"
        module.parent.mkdir(parents=True)
        module.write_bytes(b"export const runningProductionDependency = true;\n")
        account = mock.Mock(pw_uid=1234, pw_gid=1234, pw_name="fixture-build-user", pw_dir=str(self.root))

        for name, lock, reuse in (("matching", locked, True), ("changed", locked + b" ", False)):
            with self.subTest(dependencies=name):
                staging = self.work / ("staging-build-" + name)
                for application in ("student", "teaching"):
                    directory = staging / "apps" / application
                    directory.mkdir(parents=True)
                    (directory / "package.json").write_bytes(package)
                    (directory / "package-lock.json").write_bytes(lock if application == "teaching" else locked)
                calls = []

                def checked(arguments, code, **kwargs):
                    if arguments == [str(self.node / "node"), "--version"]:
                        return "v24.21.0"
                    calls.append((arguments, Path(kwargs["cwd"])))
                    return ""

                with mock.patch("pwd.getpwnam", return_value=account), mock.patch.object(
                    self.synchronizer, "checked", side_effect=checked
                ):
                    sync_main.DeploymentSynchronizer.build(self.synchronizer, staging)
                student_calls = [arguments for arguments, cwd in calls if cwd == staging / "apps/student"]
                teaching_calls = [arguments for arguments, cwd in calls if cwd == staging / "apps/teaching"]
                self.assertEqual(len(student_calls), 2)
                self.assertTrue(any("ci" in arguments and "--include=dev" in arguments for arguments in student_calls))
                self.assertTrue(any(arguments[-2:] == ["run", "build"] for arguments in student_calls))
                copied = staging / "apps/teaching/node_modules/zod/index.js"
                if reuse:
                    self.assertEqual(copied.read_bytes(), module.read_bytes())
                    self.assertEqual(teaching_calls, [])
                else:
                    self.assertFalse(copied.exists())
                    self.assertEqual(len(teaching_calls), 1)
                    self.assertIn("ci", teaching_calls[0])
                    self.assertIn("--omit=dev", teaching_calls[0])

    def backup(self, current_release: Path) -> dict:
        self.assertEqual(Path(current_release).resolve(), self.old_release.resolve())
        destination = self.backup_directory / "before-deploy.sqlite"
        contents = self.database.read_bytes()
        destination.write_bytes(contents)
        return {"path": str(destination), "sha256": sha256(contents)}

    def github_responses(self, ref: dict, commit: dict, archive: bytes):
        prefix = "https://api.github.com/repos/example-team/xunjie/git/"
        responses = {
            prefix + "ref/heads/main": json.dumps(ref).encode(),
            prefix + "commits/" + NEW_COMMIT: json.dumps(commit).encode(),
            "https://codeload.github.com/example-team/xunjie/tar.gz/" + NEW_COMMIT: archive,
        }

        def open_response(request, **kwargs):
            url = request.full_url if hasattr(request, "full_url") else request
            self.assertIn(url, responses)
            return GithubResponse(responses[url], url)

        return open_response

    def test_github_source_uses_exact_commit_and_extracts_only_deployment_inputs(self) -> None:
        root = "xunjie-" + NEW_COMMIT
        selected = {
            "apps/student/src/main.ts": b"export const student = true;\n",
            "apps/student/package-lock.json": b'{"lockfileVersion":3}\n',
            "apps/teaching/server/main.ts": b"export const teaching = true;\n",
            "apps/teaching/package-lock.json": b'{"lockfileVersion":3}\n',
            "tools/i0-cloud/cloud-host.mjs": b"export const host = true;\n",
        }
        excluded = {"README.md": b"outside source", "docs/private.md": b"outside source", "tools/other.mjs": b"outside source"}
        entries = [(root, None, None)] + [
            (root + "/" + name, content, None) for name, content in {**selected, **excluded}.items()
        ]
        ref = {"ref": "refs/heads/main", "object": {"type": "commit", "sha": NEW_COMMIT}}
        commit = {"sha": NEW_COMMIT, "tree": {"sha": TREE}}
        staging = self.work / "staging-github-source"
        staging.mkdir()
        with mock.patch.object(
            sync_main.urllib.request, "urlopen", side_effect=self.github_responses(ref, commit, source_archive(entries))
        ) as requests:
            self.assertEqual(sync_main.DeploymentSynchronizer.remote_commit(self.synchronizer), NEW_COMMIT)
            self.assertEqual(
                sync_main.DeploymentSynchronizer.fetch_source(self.synchronizer, staging, NEW_COMMIT), TREE
            )
        self.assertEqual(requests.call_count, 3)
        for name, content in selected.items():
            self.assertEqual((staging / name).read_bytes(), content)
        for name in excluded:
            self.assertFalse((staging / name).exists())
        self.assertFalse((self.work / "source.git").exists())
        self.assertEqual(list(self.work.glob("source-*.tar.gz")), [])
        self.synchronizer.run.assert_not_called()

    def test_github_source_rejects_wrong_identity_and_unsafe_archives(self) -> None:
        root = "xunjie-" + NEW_COMMIT
        valid_ref = {"ref": "refs/heads/main", "object": {"type": "commit", "sha": NEW_COMMIT}}
        valid_commit = {"sha": NEW_COMMIT, "tree": {"sha": TREE}}
        valid_entries = [(root, None, None), (root + "/apps/student/src/main.ts", b"source", None)]
        cases = [
            ("wrong-ref", {**valid_ref, "ref": "refs/heads/other"}, valid_commit, valid_entries),
            ("invalid-branch-sha", {**valid_ref, "object": {"type": "commit", "sha": "invalid"}}, valid_commit, valid_entries),
            ("wrong-object-type", {**valid_ref, "object": {"type": "tree", "sha": NEW_COMMIT}}, valid_commit, valid_entries),
            ("wrong-commit-sha", valid_ref, {**valid_commit, "sha": LATER_COMMIT}, valid_entries),
            ("invalid-tree-sha", valid_ref, {**valid_commit, "tree": {"sha": "invalid"}}, valid_entries),
            ("wrong-archive-root", valid_ref, valid_commit, [("xunjie-" + OLD_COMMIT + "/apps/student/src/main.ts", b"source", None)]),
            ("directory-traversal", valid_ref, valid_commit, valid_entries + [(root + "/apps/student/../../../../outside.txt", b"unsafe", None)]),
            ("absolute-symlink", valid_ref, valid_commit, valid_entries + [(root + "/apps/student/src/unsafe.ts", None, "/etc/passwd")]),
        ]
        for name, ref, commit, entries in cases:
            with self.subTest(case=name):
                staging = self.work / ("staging-" + name)
                staging.mkdir()
                with mock.patch.object(
                    sync_main.urllib.request, "urlopen", side_effect=self.github_responses(ref, commit, source_archive(entries))
                ):
                    with self.assertRaises(sync_main.DeploymentError):
                        self.assertEqual(sync_main.DeploymentSynchronizer.remote_commit(self.synchronizer), NEW_COMMIT)
                        sync_main.DeploymentSynchronizer.fetch_source(self.synchronizer, staging, NEW_COMMIT)
                self.assertEqual(list(self.work.glob("source-*.tar.gz")), [])
                self.assertFalse((self.work / "outside.txt").exists())

    def assert_previous_release(self) -> None:
        self.assertTrue(self.current.is_symlink())
        self.assertEqual(self.current.resolve(), self.old_release.resolve())
        manifest = json.loads((self.current / "deployment.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["commit"], OLD_COMMIT)

    def assert_failed_with(self, code: str) -> None:
        with self.assertRaises(sync_main.DeploymentError) as raised:
            self.synchronizer.apply()
        self.assertEqual(raised.exception.code, code)
        self.assert_previous_release()
        status = json.loads(self.status_file.read_text(encoding="utf-8"))
        self.assertEqual(status["deployedCommit"], OLD_COMMIT)

    def test_fetch_failure_keeps_current_release_and_does_not_build_or_restart(self) -> None:
        self.synchronizer.fetch_source.side_effect = sync_main.DeploymentError("FETCH_FAILED")
        self.assert_failed_with("FETCH_FAILED")
        self.synchronizer.build.assert_not_called()
        self.synchronizer.restart_service.assert_not_called()
        self.synchronizer.probe.assert_not_called()

    def test_build_failure_keeps_current_release_and_does_not_restart(self) -> None:
        self.synchronizer.build.side_effect = sync_main.DeploymentError("BUILD_FAILED")
        self.assert_failed_with("BUILD_FAILED")
        self.synchronizer.fetch_source.assert_called_once()
        self.synchronizer.restart_service.assert_not_called()
        self.synchronizer.probe.assert_not_called()

    def test_remote_change_during_build_does_not_switch_release(self) -> None:
        self.synchronizer.remote_commit.side_effect = [NEW_COMMIT, LATER_COMMIT]
        self.assert_failed_with("REMOTE_MAIN_CHANGED")
        self.synchronizer.build.assert_called_once()
        self.synchronizer.restart_service.assert_not_called()
        self.synchronizer.probe.assert_not_called()

    def test_health_failure_restores_previous_link_but_does_not_restore_database(self) -> None:
        original_database = self.database.read_bytes()
        live_writes = b"database changed while new version was running"

        def unhealthy(manifest: dict) -> None:
            if manifest["commit"] == OLD_COMMIT:
                self.assert_previous_release()
                return
            self.assertEqual(manifest["commit"], NEW_COMMIT)
            self.assertNotEqual(self.current.resolve(), self.old_release.resolve())
            self.database.write_bytes(live_writes)
            raise sync_main.DeploymentError("HEALTH_FAILED")

        self.synchronizer.probe.side_effect = unhealthy
        self.assert_failed_with("HEALTH_FAILED")
        self.assertEqual(self.database.read_bytes(), live_writes)
        self.assertEqual(
            (self.backup_directory / "before-deploy.sqlite").read_bytes(), original_database
        )
        self.assertEqual(self.synchronizer.restart_service.call_count, 2)

    def test_success_manifest_and_probed_static_version_match_built_release(self) -> None:
        built_script = b"console.log('actual built output');\n"

        def build(staging: Path) -> None:
            self.write_dist(Path(staging), built_script)

        def healthy(manifest: dict) -> None:
            release = self.current.resolve()
            self.assertNotEqual(release, self.old_release.resolve())
            actual = json.loads((release / "deployment.json").read_text(encoding="utf-8"))
            self.assertEqual(actual, manifest)
            self.assertEqual(manifest["commit"], NEW_COMMIT)
            self.assertEqual(manifest["gitTree"], TREE)
            self.assertEqual(manifest["entryJs"], ENTRY_JS)
            self.assertEqual(manifest["entryJsSha256"], sha256(built_script))
            self.assertEqual(
                manifest["indexSha256"],
                sha256((release / "apps/student/dist/index.html").read_bytes()),
            )

        self.synchronizer.build.side_effect = build
        self.synchronizer.probe.side_effect = healthy
        result = self.synchronizer.apply()
        self.assertIsInstance(result, dict)
        self.synchronizer.probe.assert_called_once()
        self.synchronizer.restart_service.assert_called_once()
        status = json.loads(self.status_file.read_text(encoding="utf-8"))
        self.assertEqual(status["deployedCommit"], NEW_COMMIT)
        self.assertEqual(self.database.read_bytes(), b"existing application database")

    def test_status_is_read_only_and_reports_current_manifest(self) -> None:
        files_before = {str(path.relative_to(self.root)) for path in self.root.rglob("*")}
        database_before = self.database.read_bytes()
        result = self.synchronizer.status()
        self.assertIsInstance(result, dict)
        self.assertEqual(result["deployedCommit"], OLD_COMMIT)
        self.assert_previous_release()
        self.assertEqual(self.database.read_bytes(), database_before)
        self.assertEqual(
            {str(path.relative_to(self.root)) for path in self.root.rglob("*")}, files_before
        )
        self.synchronizer.fetch_source.assert_not_called()
        self.synchronizer.build.assert_not_called()
        self.synchronizer.backup.assert_not_called()
        self.synchronizer.restart_service.assert_not_called()
        self.synchronizer.probe.assert_not_called()

    def test_same_commit_with_matching_release_still_probes_before_skipping(self) -> None:
        self.synchronizer.remote_commit.return_value = OLD_COMMIT
        result = self.synchronizer.apply()
        self.assertEqual(result["status"], "unchanged")
        self.assert_previous_release()
        self.synchronizer.probe_once.assert_called_once()
        self.synchronizer.fetch_source.assert_not_called()
        self.synchronizer.build.assert_not_called()
        self.synchronizer.restart_service.assert_not_called()

    def test_same_commit_with_changed_static_files_builds_new_release_and_preserves_old(self) -> None:
        entry = self.old_release / "apps/student/dist" / ENTRY_JS.removeprefix("/")
        changed = b"console.log('local drift');\n"
        entry.write_bytes(changed)
        self.expected_source_commit = OLD_COMMIT
        self.synchronizer.remote_commit.return_value = OLD_COMMIT
        result = self.synchronizer.apply()
        self.assertEqual(result["deployedCommit"], OLD_COMMIT)
        self.assertNotEqual(self.current.resolve(), self.old_release.resolve())
        self.assertTrue(self.old_release.is_dir())
        self.assertEqual(entry.read_bytes(), changed)
        self.synchronizer.fetch_source.assert_called_once()
        self.synchronizer.build.assert_called_once()
        self.synchronizer.restart_service.assert_called_once()

    def test_status_rejects_same_commit_when_runtime_source_changed(self) -> None:
        self.synchronizer.remote_commit.return_value = OLD_COMMIT
        source = self.old_release / "apps/teaching/server/main.ts"
        source.write_text("export const sourceVersion = 'changed';\n", encoding="utf-8")
        result = self.synchronizer.status()
        self.assertEqual(result["deployedCommit"], OLD_COMMIT)
        self.assertFalse(result["upToDate"])
        self.assertFalse(self.status_file.exists())
        self.assert_previous_release()
        self.synchronizer.restart_service.assert_not_called()

    def test_css_drift_is_not_up_to_date_and_rebuilds_same_commit(self) -> None:
        stylesheet = self.old_release / "apps/student/dist/assets/site.css"
        changed = b"body { color: red; }\n"
        stylesheet.write_bytes(changed)
        self.synchronizer.remote_commit.return_value = OLD_COMMIT
        self.assertFalse(self.synchronizer.status()["upToDate"])

        self.expected_source_commit = OLD_COMMIT
        result = self.synchronizer.apply()
        self.assertEqual(result["deployedCommit"], OLD_COMMIT)
        self.assertNotEqual(result["status"], "unchanged")
        self.assertNotEqual(self.current.resolve(), self.old_release.resolve())
        self.assertEqual(stylesheet.read_bytes(), changed)
        self.synchronizer.fetch_source.assert_called_once()
        self.synchronizer.build.assert_called_once()
        self.synchronizer.restart_service.assert_called_once()

    @unittest.skipUnless(os.name == "posix", "process-group timeout is a POSIX deployment behavior")
    def test_run_timeout_kills_grandchild_holding_stdout_pipe(self) -> None:
        program = """
import subprocess, sys, time
child = subprocess.Popen([sys.executable, '-u', '-c', 'import time; time.sleep(30)'])
print('grandchild_pid=' + str(child.pid), flush=True)
print('private timeout stderr', file=sys.stderr, flush=True)
time.sleep(30)
"""
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired) as raised:
            sync_main.DeploymentSynchronizer.run(
                self.synchronizer, [sys.executable, "-u", "-c", program], timeout=0.25
            )
        self.assertLess(time.monotonic() - started, 3)
        output = raised.exception.stdout
        if isinstance(output, bytes):
            output = output.decode()
        pid = int(next(line for line in output.splitlines() if line.startswith("grandchild_pid=")).split("=")[1])
        self.assertIn("private timeout stderr", raised.exception.stderr)
        state = Path("/proc") / str(pid) / "stat"
        if state.exists():
            self.assertIn(state.read_text().split(") ", 1)[1].split()[0], ("Z", "X"))

    @unittest.skipUnless(os.name == "posix", "signal cleanup is a POSIX deployment behavior")
    def test_run_timeout_allows_sigterm_handler_to_remove_its_exact_lock(self) -> None:
        lock = self.work / "source.git/shallow.lock"
        lock.parent.mkdir()
        program = """
import pathlib, signal, sys, time
lock = pathlib.Path(sys.argv[1])
def cleanup(signum, frame):
    lock.unlink()
    print('owned_lock_removed', flush=True)
    raise SystemExit(128 + signum)
signal.signal(signal.SIGTERM, cleanup)
lock.write_text('owned by this child', encoding='utf-8')
print('owned_lock_ready', flush=True)
time.sleep(30)
"""
        arguments = [sys.executable, "-u", "-c", program, str(lock)]
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired) as raised:
            sync_main.DeploymentSynchronizer.run(self.synchronizer, arguments, timeout=0.25)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(raised.exception.timeout, 0.25)
        self.assertEqual(raised.exception.cmd, arguments)
        self.assertIn("owned_lock_ready", raised.exception.stdout)
        self.assertIn("owned_lock_removed", raised.exception.stdout)
        self.assertFalse(lock.exists())

    @unittest.skipUnless(os.name == "posix", "process-group escalation is a POSIX deployment behavior")
    def test_run_timeout_kills_term_ignoring_parent_and_grandchild(self) -> None:
        program = """
import signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-u', '-c',
    "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ignoring_term_ready',flush=True); time.sleep(30)"])
print('grandchild_pid=' + str(child.pid), flush=True)
print('private escalation stderr', file=sys.stderr, flush=True)
time.sleep(30)
"""
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired) as raised:
            sync_main.DeploymentSynchronizer.run(
                self.synchronizer, [sys.executable, "-u", "-c", program], timeout=0.25
            )
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 5)
        self.assertLess(elapsed, 8)
        self.assertEqual(raised.exception.timeout, 0.25)
        self.assertIn("ignoring_term_ready", raised.exception.stdout)
        self.assertIn("private escalation stderr", raised.exception.stderr)
        pid = int(next(line for line in raised.exception.stdout.splitlines()
                       if line.startswith("grandchild_pid=")).split("=")[1])
        state = Path("/proc") / str(pid) / "stat"
        if state.exists():
            self.assertIn(state.read_text().split(") ", 1)[1].split()[0], ("Z", "X"))

    def test_same_commit_with_process_using_other_release_is_not_up_to_date_or_skipped(self) -> None:
        self.synchronizer.remote_commit.return_value = OLD_COMMIT
        self.synchronizer.service_matches_current.return_value = False
        self.assertFalse(self.synchronizer.status()["upToDate"])
        self.synchronizer.probe_once.assert_not_called()

        self.expected_source_commit = OLD_COMMIT
        self.synchronizer.service_matches_current.side_effect = [False, True]
        result = self.synchronizer.apply()
        self.assertNotEqual(result["status"], "unchanged")
        self.synchronizer.fetch_source.assert_called_once()
        self.synchronizer.build.assert_called_once()
        self.synchronizer.restart_service.assert_called_once()

    def test_failed_subprocess_keeps_private_log_silent_and_status_does_not_write_it(self) -> None:
        self.synchronizer.run.side_effect = None
        self.synchronizer.run.return_value = subprocess.CompletedProcess(
            ["fixture-command"], 1, "private command output", "private command diagnostic"
        )
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with self.assertRaises(sync_main.DeploymentError) as raised:
                self.synchronizer.checked(["fixture-command"], "BUILD_COMMAND_FAILED")
        self.assertEqual(raised.exception.code, "BUILD_COMMAND_FAILED")
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(errors.getvalue(), "")
        failure_log = self.work / "last-failure.log"
        content = failure_log.read_bytes()
        logged = json.loads(content)
        self.assertEqual(logged["stdout"], "private command output")
        self.assertEqual(logged["stderr"], "private command diagnostic")
        if os.name != "nt":
            self.assertEqual(failure_log.stat().st_mode & 0o777, 0o600)
        modification_time = failure_log.stat().st_mtime_ns

        self.synchronizer.remote_commit.side_effect = lambda: self.synchronizer.checked(
            ["fixture-status-query"], "STATUS_QUERY_FAILED"
        )
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with self.assertRaises(sync_main.DeploymentError) as raised:
                self.synchronizer.status()
        self.assertEqual(raised.exception.code, "STATUS_QUERY_FAILED")
        self.assertEqual(failure_log.read_bytes(), content)
        self.assertEqual(failure_log.stat().st_mtime_ns, modification_time)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(errors.getvalue(), "")

    def test_http_probe_requires_health_and_matching_served_static_bytes(self) -> None:
        manifest = json.loads((self.old_release / "deployment.json").read_text(encoding="utf-8"))
        dist = self.old_release / "apps/student/dist"
        responses = {
            "/health/live": json.dumps({"data": {"status": "alive"}}).encode(),
            "/health/ready": json.dumps({"data": {"status": "ready"}}).encode(),
            "/": (dist / "index.html").read_bytes(),
            ENTRY_JS: (dist / ENTRY_JS.removeprefix("/")).read_bytes(),
        }
        self.synchronizer.http_get = mock.Mock(side_effect=lambda path, context: responses[path])
        with mock.patch.object(sync_main.ssl, "create_default_context", return_value=object()):
            sync_main.DeploymentSynchronizer.probe_once(self.synchronizer, manifest)
            responses[ENTRY_JS] = b"wrong server version"
            with self.assertRaises(sync_main.DeploymentError) as raised:
                sync_main.DeploymentSynchronizer.probe_once(self.synchronizer, manifest)
        self.assertEqual(raised.exception.code, "SERVED_JAVASCRIPT_MISMATCH")

    def test_cli_status_outputs_json_without_deploying(self) -> None:
        config_file = self.root / "deployment-config.json"
        config_file.write_text(json.dumps(self.config), encoding="utf-8")
        output = io.StringIO()
        with (
            mock.patch.object(sys, "argv", [str(SCRIPT), "--config", str(config_file), "--status"]),
            mock.patch.object(sync_main, "DeploymentSynchronizer", return_value=self.synchronizer),
            mock.patch.object(sys, "platform", "linux"),
            mock.patch.object(sync_main.os, "geteuid", return_value=0, create=True),
            contextlib.redirect_stdout(output),
        ):
            sync_main.main()
        self.assertEqual(json.loads(output.getvalue())["deployedCommit"], OLD_COMMIT)
        self.assertFalse(self.status_file.exists())
        self.assert_previous_release()
        self.synchronizer.fetch_source.assert_not_called()
        self.synchronizer.build.assert_not_called()
        self.synchronizer.backup.assert_not_called()
        self.synchronizer.restart_service.assert_not_called()


if __name__ == "__main__":
    unittest.main()
