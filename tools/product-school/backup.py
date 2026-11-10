#!/usr/bin/env python3
"""Serialize the product recovery CLI with existing release maintenance."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

from school import atomic_json, now


def validate(config):
    if set(config) != {'root', 'node', 'cli', 'maintenanceLock', 'recoveryKeyRef', 'statusFile', 'directory', 'keep'}:
        raise ValueError('invalid-config')
    for key in ('root', 'node', 'cli', 'maintenanceLock', 'statusFile', 'directory'):
        if not isinstance(config[key], str) or not Path(config[key]).is_absolute() or '__' in config[key]:
            raise ValueError('invalid-path')
    if not isinstance(config['recoveryKeyRef'], str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', config['recoveryKeyRef']):
        raise ValueError('invalid-recovery-key-ref')
    if type(config['keep']) is not int or not 1 <= config['keep'] <= 100:
        raise ValueError('invalid-backup-retention')


def backup(config, runner=subprocess.run):
    validate(config)
    lock = os.open(config['maintenanceLock'], os.O_RDWR | os.O_CREAT, 0o600)
    try:
        deadline = time.monotonic() + 2400
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError('maintenance-lock-timeout')
                time.sleep(1)
        payload = {'directory': config['directory'], 'keep': config['keep'],
                   'recoveryKeyRef': config['recoveryKeyRef'], 'leaveClosed': False}
        with tempfile.TemporaryDirectory(prefix='xunjie-school-backup-') as temp:
            request = Path(temp) / 'request.json'
            request.write_text(json.dumps(payload))
            request.chmod(0o600)
            command = [config['node'], config['cli'], 'backup', '--root', config['root'], '--file', str(request)]
            result = runner(command, capture_output=True, text=True, timeout=4500, check=False)
            if result.returncode != 0:
                raise ValueError('product-recovery-backup-failed')
            manifest = json.loads(result.stdout)
            if not isinstance(manifest, dict) or not isinstance(manifest.get('backupId'), str):
                raise ValueError('invalid-product-recovery-result')
            return {'at': now(), 'state': 'complete', 'backupId': manifest['backupId']}
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    try:
        config = json.loads(Path(args.config).read_text())
        result = backup(config)
        atomic_json(config['statusFile'], result)
        print(json.dumps({'state': 'complete', 'backupId': result['backupId']}))
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        if 'config' in locals() and isinstance(config, dict) and isinstance(config.get('statusFile'), str) and Path(config['statusFile']).is_absolute():
            try:
                atomic_json(config['statusFile'], {'at': now(), 'state': 'failed',
                                                   'action': 'inspect school daemon and product backup-list before retry'})
            except OSError:
                pass
        print(json.dumps({'state': 'failed',
                          'action': 'inspect school daemon and product backup-list before retry'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
