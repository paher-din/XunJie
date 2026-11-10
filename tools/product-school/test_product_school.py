import importlib.util
import json
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import school
import backup
import monitor


def load_hook():
    spec = importlib.util.spec_from_file_location('cert_deploy', Path(__file__).with_name('cert-deploy.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class HealthTests(unittest.TestCase):
    status = {'state': 'ready', 'deployment': {'configuration': {'modules': ['space-course', 'learning-data']}}}

    def assess(self, hours, status=None, disk='a', served='a', chain=True):
        return school.assess(self.status if status is None else status, hours, disk, served, chain)

    def test_threshold_boundaries_and_failure_actions(self):
        self.assertEqual(self.assess(48.01)['state'], 'ok')
        warning = self.assess(48)
        self.assertEqual(warning['state'], 'warning')
        self.assertIn('less than 48 hours', warning['actions'][-1])
        critical = self.assess(24)
        self.assertEqual(critical['state'], 'critical')
        self.assertIn('renew certificate now', critical['actions'][-1])
        self.assertEqual(self.assess(None)['state'], 'critical')
        self.assertEqual(self.assess(100, served='b')['state'], 'critical')
        self.assertEqual(self.assess(100, chain=False)['state'], 'critical')

    def test_module_contract_must_be_exact(self):
        for modules in (['space-course'], ['space-course', 'learning-data', 'teaching-agent'],
                        ['space-course', 'space-course'], [1, 'learning-data']):
            status = {'state': 'ready', 'deployment': {'configuration': {'modules': modules}}}
            result = self.assess(100, status=status)
            self.assertEqual(result['state'], 'critical')
            self.assertTrue(any('deployment' in action for action in result['actions']))
        self.assertEqual(self.assess(100, status={'state': 'ready', 'deployment': []})['state'], 'critical')

    def test_health_check_records_tls_failure_without_fetching_runtime(self):
        config = {'publicIp': '192.0.2.4', 'fullchainFile': '/private/fullchain.pem',
                  'reloadFile': '/private/reload.json'}
        with patch.object(monitor, 'disk_certificate', return_value=('disk', 60)), \
             patch.object(monitor, 'served_certificate', side_effect=OSError('connection failed')), \
             patch.object(monitor, 'runtime_status', side_effect=AssertionError('must not fetch')):
            result = monitor.check(config)
        self.assertEqual(result['state'], 'critical')
        self.assertEqual(result['diskFingerprint'], 'disk')
        self.assertIsNone(result['servedFingerprint'])
        self.assertTrue(any('HTTPS trust chain' in action for action in result['actions']))


class HookTests(unittest.TestCase):
    def setUp(self):
        self.hook = load_hook()
        self.config = {'fullchainFile': '/etc/letsencrypt/live/192.0.2.4/fullchain.pem', 'publicIp': '192.0.2.4'}

    def test_validates_before_reload_and_observes_new_leaf(self):
        events = []
        def run(command, **_):
            events.append(command)
            return subprocess.CompletedProcess(command, 0)
        def observe(ip, verified):
            self.assertFalse(verified)
            events.append('observe')
            return 'new'
        with patch.dict('os.environ', {'RENEWED_LINEAGE': '/etc/letsencrypt/live/192.0.2.4'}), \
             patch.object(self.hook, 'disk_certificate', return_value=('new', 100)):
            result = self.hook.deploy(self.config, run=run, observe=observe)
        self.assertEqual(result['state'], 'loaded')
        self.assertEqual(events, [['/usr/sbin/nginx', '-t'], ['/usr/bin/systemctl', 'reload', 'nginx'], 'observe'])

    def test_failed_validation_never_reloads(self):
        events = []
        def run(command, **_):
            events.append(command)
            return subprocess.CompletedProcess(command, 1)
        with patch.dict('os.environ', {'RENEWED_LINEAGE': '/etc/letsencrypt/live/192.0.2.4'}), \
             patch.object(self.hook, 'disk_certificate', return_value=('new', 100)):
            with self.assertRaisesRegex(ValueError, 'nginx-validation'):
                self.hook.deploy(self.config, run=run)
        self.assertEqual(events, [['/usr/sbin/nginx', '-t']])

    def test_unrelated_lineage_never_reloads(self):
        with patch.dict('os.environ', {'RENEWED_LINEAGE': '/etc/letsencrypt/live/192.0.2.9'}):
            with self.assertRaisesRegex(ValueError, 'unexpected-renewal-lineage'):
                self.hook.deploy(self.config, run=lambda *_args, **_kwargs: self.fail('ran nginx'))

    def test_successful_reload_without_served_change_is_failure(self):
        calls = []
        def run(command, **_):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0)
        with patch.dict('os.environ', {'RENEWED_LINEAGE': '/etc/letsencrypt/live/192.0.2.4'}), \
             patch.object(self.hook, 'disk_certificate', return_value=('new', 100)), \
             patch.object(self.hook.time, 'sleep'):
            with self.assertRaisesRegex(ValueError, 'loaded-certificate-mismatch'):
                self.hook.deploy(self.config, run=run, observe=lambda *_args, **_kwargs: 'old')
        self.assertEqual(len(calls), 2)


class CertbotIPv4Tests(unittest.TestCase):
    def test_wrapper_selects_ipv4_before_certbot_main(self):
        urllib3 = types.ModuleType('urllib3')
        urllib3.__path__ = []
        util = types.ModuleType('urllib3.util')
        util.__path__ = []
        connection = types.ModuleType('urllib3.util.connection')
        connection.allowed_gai_family = lambda: socket.AF_UNSPEC
        urllib3.util = util
        util.connection = connection
        certbot = types.ModuleType('certbot')
        certbot.__path__ = []
        internal = types.ModuleType('certbot._internal')
        internal.__path__ = []
        main_module = types.ModuleType('certbot._internal.main')
        observed = []
        def main():
            observed.append(connection.allowed_gai_family())
            return 0
        main_module.main = main
        modules = {'urllib3': urllib3, 'urllib3.util': util, 'urllib3.util.connection': connection,
                   'certbot': certbot, 'certbot._internal': internal, 'certbot._internal.main': main_module}
        with patch.dict(sys.modules, modules):
            with self.assertRaises(SystemExit) as result:
                runpy.run_path(str(Path(__file__).with_name('certbot-ipv4.py')), run_name='__main__')
        self.assertEqual(result.exception.code, 0)
        self.assertEqual(observed, [socket.AF_INET])


class BackupTests(unittest.TestCase):
    def test_product_cli_receives_private_ref_and_releases_maintenance_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = {'root': str(root / 'school'), 'node': '/opt/node/bin/node', 'cli': '/opt/app/cli.js',
                      'maintenanceLock': str(root / 'maintenance.lock'),
                      'recoveryKeyRef': 'recovery-12345678-1234-1234-1234-123456789abc',
                      'statusFile': str(root / 'status.json'),
                      'directory': str(root / 'checkpoints'), 'keep': 3}
            seen = []
            def run(command, **_):
                seen.append((command[:5], json.loads(Path(command[-1]).read_text())))
                return subprocess.CompletedProcess(command, 0, stdout='{"backupId":"id-1"}', stderr='')
            result = backup.backup(config, runner=run)
            self.assertEqual(result['backupId'], 'id-1')
            self.assertEqual(seen[0][0], ['/opt/node/bin/node', '/opt/app/cli.js', 'backup', '--root', str(root / 'school')])
            self.assertEqual(seen[0][1], {'directory': str(root / 'checkpoints'), 'keep': 3,
                                          'recoveryKeyRef': config['recoveryKeyRef'], 'leaveClosed': False})
            with open(config['maintenanceLock']) as lock:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


if __name__ == '__main__':
    unittest.main()
