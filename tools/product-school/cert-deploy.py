#!/usr/bin/env python3
"""Certbot deploy hook: validate, reload, and observe the loaded leaf."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from school import atomic_json, disk_certificate, now, read_config, served_certificate


def deploy(config, run=subprocess.run, observe=served_certificate):
    expected = str(Path(config['fullchainFile']).parent)
    if os.environ.get('RENEWED_LINEAGE') != expected:
        raise ValueError('unexpected-renewal-lineage')
    disk, _ = disk_certificate(config['fullchainFile'])
    for command, timeout in ((['/usr/sbin/nginx', '-t'], 15), (['/usr/bin/systemctl', 'reload', 'nginx'], 30)):
        completed = run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        if completed.returncode != 0:
            raise ValueError('nginx-validation-or-reload-failed')
    served = None
    for _ in range(20):
        try:
            served = observe(config['publicIp'], verified=False)
        except OSError:
            pass
        if served == disk:
            return {'at': now(), 'state': 'loaded', 'diskFingerprint': disk, 'servedFingerprint': served}
        time.sleep(0.5)
    raise ValueError('loaded-certificate-mismatch')


def main():
    config_path = '/etc/xunjie/product-school.json'
    try:
        config = read_config(config_path)
        result = deploy(config)
        atomic_json(config['reloadFile'], result)
        print('{"state":"loaded"}')
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        if 'config' in locals():
            try:
                atomic_json(config['reloadFile'], {'at': now(), 'state': 'failed',
                                                    'action': 'check nginx -t, reload, and served certificate fingerprint'})
            except OSError:
                pass
        print('{"state":"failed","action":"check nginx -t, reload, and served certificate fingerprint"}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
