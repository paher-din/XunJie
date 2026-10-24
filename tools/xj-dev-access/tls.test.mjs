import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('bootstrap CA and endpoint leaf pass a real Python/OpenSSL strict TLS handshake', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'xj-strict-ca-'));
  try {
    const config = join(root, 'config.json'), output = join(root, 'tls');
    writeFileSync(config, JSON.stringify({ endpoint: 'https://192.0.2.129:8443' }), { mode: 0o600 });
    const prepared = spawnSync('python3', [fileURLToPath(new URL('./prepare-tls.py', import.meta.url)), '--service-config', config, '--output', output], { encoding: 'utf8', timeout: 30000 });
    assert.equal(prepared.status, 0, 'TLS generator must complete');
    const script = `import ssl,socket,threading,sys
from pathlib import Path
p=Path(sys.argv[1]);server=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);server.load_cert_chain(p/'access-tls.crt',p/'access-tls.key')
listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1)
def serve():
 raw,_=listener.accept()
 with server.wrap_socket(raw,server_side=True) as stream: stream.sendall(b'ok')
thread=threading.Thread(target=serve);thread.start()
client=ssl.create_default_context(cafile=str(p/'access-ca.crt'));client.verify_flags|=ssl.VERIFY_X509_STRICT
with socket.create_connection(listener.getsockname(),timeout=5) as raw:
 with client.wrap_socket(raw,server_hostname='192.0.2.129') as stream: assert stream.recv(2)==b'ok'
thread.join(5);listener.close();assert not thread.is_alive();print('strict TLS and endpoint SAN verified')
`;
    const strict = spawnSync('python3', ['-c', script, output], { encoding: 'utf8', timeout: 10000 });
    assert.equal(strict.status, 0, strict.stderr);
    assert.match(strict.stdout, /strict TLS and endpoint SAN verified/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
