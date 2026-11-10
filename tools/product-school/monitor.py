#!/usr/bin/env python3
"""Private status and one CloudMonitor severity sample; no credential output."""
import argparse
import http.client
import json
from pathlib import Path
import sys

from school import assess, atomic_json, disk_certificate, now, read_config, report_cms, runtime_status, served_certificate


def check(config):
    disk, hours, served, chain_ok, status = None, None, None, False, None
    try:
        disk, hours = disk_certificate(config['fullchainFile'])
    except (OSError, ValueError, KeyError):
        pass
    try:
        served = served_certificate(config['publicIp'], verified=True)
        chain_ok = True
    except (OSError, ValueError):
        try:
            served = served_certificate(config['publicIp'], verified=False)
        except (OSError, ValueError):
            pass
    if chain_ok:
        try:
            status = runtime_status(config['publicIp'])
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    result = assess(status, hours, disk, served, chain_ok)
    try:
        reload = json.loads(Path(config['reloadFile']).read_text())
        if reload.get('state') == 'failed':
            result['state'] = 'critical'
            result['actions'].append('inspect certificate deploy hook and nginx reload')
    except (OSError, ValueError):
        pass
    result['at'] = now()
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    try:
        config = read_config(args.config)
        result = check(config)
        atomic_json(config['statusFile'], result)
        try:
            report_cms(config['monitoringFile'], result)
        except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
            result['cms'] = 'failed'
            result['actions'].append('check CMS credentials, endpoint and existing contact group')
            atomic_json(config['statusFile'], result)
        else:
            result['cms'] = 'reported'
            atomic_json(config['statusFile'], result)
        print(json.dumps({'state': result['state'], 'cms': result['cms'], 'actions': result['actions']}))
        return 0 if result['state'] == 'ok' and result['cms'] == 'reported' else 1
    except (OSError, ValueError, KeyError, TypeError):
        print('{"state":"critical","actions":["check product-school configuration and status directory"]}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
