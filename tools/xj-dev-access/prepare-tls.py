#!/usr/bin/python3
"""Generate a dedicated strict-verification CA/leaf; private bytes never use argv."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit


def prepare(config_file, output):
    os.umask(0o077)
    file = Path(config_file)
    if not file.is_file() or file.is_symlink() or file.stat().st_uid != os.getuid() or file.stat().st_mode & 0o077:
        raise ValueError('PRIVATE_CONFIGURATION_REQUIRED')
    endpoint = urlsplit(json.loads(file.read_text())['endpoint'])
    if endpoint.scheme != 'https' or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise ValueError('HTTPS_ENDPOINT_REQUIRED')
    host = endpoint.hostname
    try:
        ipaddress.ip_address(host)
        san = 'IP.1 = ' + host
    except ValueError:
        if not host or not re.fullmatch('[A-Za-z0-9.-]+', host):
            raise ValueError('ENDPOINT_HOST_INVALID')
        san = 'DNS.1 = ' + host
    output = Path(output)
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    ca_config = output / 'ca.cnf'
    ca_config.write_text('''[req]
prompt = no
distinguished_name = dn
x509_extensions = ca
[dn]
CN = XunJie Development Access CA
[ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
''')
    leaf_config = output / 'leaf.cnf'
    leaf_config.write_text('''[leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
subjectAltName = @names
[names]
DNS.2 = localhost
IP.2 = 127.0.0.1
''' + san + '\n')

    def openssl(*args):
        subprocess.run(['openssl', *map(str, args)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)

    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', output / 'access-ca.key', '-out', output / 'access-ca.crt', '-days', '30', '-config', ca_config)
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', output / 'access-tls.key', '-out', output / 'access-tls.csr', '-subj', '/CN=XunJie Development Access')
    openssl('x509', '-req', '-in', output / 'access-tls.csr', '-CA', output / 'access-ca.crt', '-CAkey', output / 'access-ca.key', '-CAcreateserial', '-out', output / 'access-tls.crt', '-days', '30', '-sha256', '-extfile', leaf_config, '-extensions', 'leaf')
    for item in output.iterdir():
        item.chmod(0o600)
    return {'prepared': True, 'directory': str(output), 'caSigningKey': str(output / 'access-ca.key'), 'expiresInDays': 30}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--service-config', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.service_config, args.output)))
    except Exception:
        parser.exit(1, 'TLS preparation failed; retain private diagnostics and configuration.\n')
