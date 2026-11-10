"""Small, private operational helpers for the public school endpoint."""
import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
from pathlib import Path
import socket
import ssl
import tempfile
import time
from datetime import datetime, timezone
from urllib.parse import quote, urlencode
from uuid import uuid4


def read_config(path):
    config = json.loads(Path(path).read_text())
    if set(config) != {'publicIp', 'fullchainFile', 'statusFile', 'reloadFile', 'monitoringFile'}:
        raise ValueError('invalid-config')
    if ipaddress.ip_address(config['publicIp']).version != 4:
        raise ValueError('ipv4-required')
    for key in ('fullchainFile', 'statusFile', 'reloadFile', 'monitoringFile'):
        if not isinstance(config[key], str) or not Path(config[key]).is_absolute() or '__' in config[key]:
            raise ValueError('invalid-path')
    return config


def atomic_json(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix='.school-', dir=target.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, separators=(',', ':'), sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)
        directory = os.open(target.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def disk_certificate(path):
    pem = Path(path).read_text()
    first = '-----BEGIN CERTIFICATE-----' + pem.split('-----BEGIN CERTIFICATE-----', 1)[1].split('-----END CERTIFICATE-----', 1)[0] + '-----END CERTIFICATE-----'
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(first)).hexdigest()
    # CPython's OpenSSL decoder reads only the leaf of a fullchain file.
    expiry = ssl._ssl._test_decode_cert(path)['notAfter']
    hours = (ssl.cert_time_to_seconds(expiry) - time.time()) / 3600
    return fingerprint, hours


def served_certificate(ip, verified=True):
    context = ssl.create_default_context() if verified else ssl._create_unverified_context()
    with socket.create_connection((ip, 443), timeout=8) as connection:
        with context.wrap_socket(connection, server_hostname=ip) as tls:
            return hashlib.sha256(tls.getpeercert(binary_form=True)).hexdigest()


def runtime_status(ip):
    connection = http.client.HTTPSConnection(ip, 443, timeout=8, context=ssl.create_default_context())
    try:
        connection.request('GET', '/runtime/status')
        response = connection.getresponse()
        payload = response.read(65537)
        if response.status != 200 or len(payload) > 65536:
            raise ValueError('runtime-status-http')
        return json.loads(payload)
    finally:
        connection.close()


def assess(status, hours, disk_fingerprint, served_fingerprint, chain_ok):
    actions = []
    if not chain_ok:
        actions.append('check HTTPS trust chain and IP SAN')
    if not disk_fingerprint or not served_fingerprint or disk_fingerprint != served_fingerprint:
        actions.append('check nginx certificate reload; disk and served fingerprints differ')
    if hours is None:
        actions.append('check certificate file and expiry')
    elif hours <= 24:
        actions.append('renew certificate now; less than 24 hours remain')
    elif hours <= 48:
        actions.append('investigate certificate renewal; less than 48 hours remain')
    deployment = status.get('deployment') if isinstance(status, dict) else None
    configuration = deployment.get('configuration') if isinstance(deployment, dict) else None
    modules = configuration.get('modules') if isinstance(configuration, dict) else None
    if not isinstance(status, dict) or status.get('state') != 'ready':
        actions.append('check school daemon and /runtime/status')
    modules_ok = isinstance(modules, list) and len(modules) == 2 and all(isinstance(item, str) for item in modules) and sorted(modules) == ['learning-data', 'space-course']
    if not modules_ok:
        actions.append('restore school deployment to space-course and learning-data only')
    critical = hours is None or hours <= 24 or not chain_ok or not disk_fingerprint or disk_fingerprint != served_fingerprint
    return {
        'state': 'critical' if critical or not isinstance(status, dict) or status.get('state') != 'ready' or not modules_ok else 'warning' if hours <= 48 else 'ok',
        'hoursRemaining': round(hours, 2) if hours is not None else None,
        'diskFingerprint': disk_fingerprint,
        'servedFingerprint': served_fingerprint,
        'actions': actions,
    }


def report_cms(monitoring_file, result):
    settings = json.loads(Path(monitoring_file).read_text())
    if set(settings) != {'credentialsFile', 'groupId', 'dimensions', 'statusFile'} or not str(settings['groupId']).isdigit():
        raise ValueError('invalid-monitoring-config')
    credentials_file = Path(settings['credentialsFile'])
    if not credentials_file.is_absolute():
        raise ValueError('invalid-credentials-path')
    credentials = json.loads(credentials_file.read_text())
    if set(credentials) != {'accessKeyId', 'accessKeySecret'} or not all(isinstance(v, str) and v for v in credentials.values()):
        raise ValueError('invalid-monitoring-credentials')
    # One series carries the health level: 3 ready, 2 renewal warning, 1 critical.
    metrics = {'xunjie_school_health': {'ok': 3, 'warning': 2, 'critical': 1}[result['state']]}
    params = {'Action': 'PutCustomMetric', 'Version': '2019-01-01', 'Format': 'JSON',
              'AccessKeyId': credentials['accessKeyId'], 'SignatureMethod': 'HMAC-SHA1',
              'SignatureVersion': '1.0', 'SignatureNonce': uuid4().hex,
              'Timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
    dimensions = json.dumps({'application': 'xunjie-product-school'}, separators=(',', ':'))
    for index, (name, value) in enumerate(metrics.items(), 1):
        for key, item in {'MetricName': name, 'GroupId': settings['groupId'], 'Type': '0',
                          'Dimensions': dimensions, 'Values': json.dumps({'value': value}),
                          'Time': str(int(time.time() * 1000))}.items():
            params[f'MetricList.{index}.{key}'] = item
    canonical = '&'.join(quote(key, safe='~') + '=' + quote(str(value), safe='~') for key, value in sorted(params.items()))
    signing = ('POST&%2F&' + quote(canonical, safe='~')).encode()
    params['Signature'] = base64.b64encode(hmac.new((credentials['accessKeySecret'] + '&').encode(), signing, hashlib.sha1).digest()).decode()
    connection = http.client.HTTPSConnection('metrics.cn-beijing.aliyuncs.com', timeout=20, context=ssl.create_default_context())
    try:
        connection.request('POST', '/', urlencode(params), {'Content-Type': 'application/x-www-form-urlencoded'})
        response = connection.getresponse()
        payload = response.read(65537)
        if response.status != 200 or len(payload) > 65536 or str(json.loads(payload).get('Code')) != '200':
            raise ValueError('cms-report-failed')
    finally:
        connection.close()
