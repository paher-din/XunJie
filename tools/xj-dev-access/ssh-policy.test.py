#!/usr/bin/python3
"""Real sshd parser acceptance in a disposable config; never reload host SSH."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

source = Path(__file__).with_name('system-helper.py')
spec = importlib.util.spec_from_file_location('device_helper', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

assert os.geteuid() == 0, 'Run through owner sudo: sshd must read its existing host key'
config = {'applicationPorts': [13444, 13446], 'nodes': {
    'one': {'remoteRunnerPort': 22091}, 'two': {'remoteRunnerPort': 22092}}}
results = []
with tempfile.TemporaryDirectory(prefix='xj129-sshd-policy-') as temporary:
    root = Path(temporary)
    helper.KEYS = root / 'keys'
    helper.FRAGMENT = root / 'fragment.conf'
    ssh_config = root / 'sshd.conf'
    ssh_config.write_text('HostKey /etc/ssh/ssh_host_ed25519_key\nUsePAM no\nInclude ' + str(helper.FRAGMENT) + '\n')

    def checked_run(*args):
        if args == ('/usr/sbin/sshd', '-t'):
            subprocess.run(['/usr/sbin/sshd', '-t', '-f', str(ssh_config)], check=True, capture_output=True)
        elif args == ('/usr/bin/systemctl', 'reload', 'ssh.service'):
            pass  # This disposable test must never reload host SSH.
        else:
            raise AssertionError('Unexpected host mutation in policy-only acceptance')

    helper.run = checked_run
    for role in ('node', 'page'):
        # Existing groups only: exercise the actual Match Group behavior for
        # root without creating users/groups or changing real sshd config.
        helper.NODE_GROUP = 'root' if role == 'node' else 'nogroup'
        helper.PAGE_GROUP = 'nogroup' if role == 'node' else 'root'
        helper.install(config)
        output = subprocess.check_output(['/usr/sbin/sshd', '-T', '-f', str(ssh_config), '-C',
                                          'user=root,host=localhost,addr=127.0.0.1'], text=True)
        effective = dict(line.split(' ', 1) for line in output.splitlines() if ' ' in line)
        assert effective['permitopen'].split() == ['127.0.0.1:13444', '127.0.0.1:13446']
        assert effective['permitlisten'].split() == (['127.0.0.1:22091', '127.0.0.1:22092'] if role == 'node' else ['none'])
        assert effective['maxsessions'] == '0'
        results.append({'role': role, 'permitOpenCount': 2, 'permitListenCount': 2 if role == 'node' else 0, 'maxSessions': 0})

line = helper.authorized_key_line(['ssh-ed25519', 'public-fixture'], config['applicationPorts'], [config['nodes']['one']])
assert 'permitlisten="127.0.0.1:22091"' in line and '22092' not in line
assert line.count('permitlisten=') == 1
print(json.dumps({'realSshdParser': 'passed', 'hostSshReloaded': False, 'effective': results, 'deviceKeyOwnNodeOnly': True}))
