import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureCertificateAuthority, ensureEnvironmentCertificate } from '../xj-dev/src/certificates.mjs';
import { environmentPaths } from '../xj-dev/src/paths.mjs';

const serverModule = new URL('./server.mjs', import.meta.url).href;
const controlModule = new URL('../../apps/server/server/access/account-control.ts', import.meta.url).href;
const databaseModule = new URL('../../apps/server/server/db/transaction.ts', import.meta.url).href;
const processes = new Set();
async function start(kind, configFile, skip = false) {
  const code = `
    import { readFileSync } from 'node:fs';
    let service, db;
    try {
      if (${JSON.stringify(kind)} === 'access') {
        const { createAccessService } = await import(${JSON.stringify(serverModule)});
        service = createAccessService(JSON.parse(readFileSync(process.argv[1], 'utf8')));
        if (!${skip}) await service.listen();
      } else {
        const { createLocalAccountControl } = await import(${JSON.stringify(controlModule)});
        const { createDigitalLogicApplicationDatabase } = await import(${JSON.stringify(databaseModule)});
        db = createDigitalLogicApplicationDatabase();
        service = await createLocalAccountControl(process.argv[1], {db, staticAllowed:['original']});
        if (!${skip}) await service.listen({management:{disableUserInTransaction(){throw new Error('unused');}}});
      }
      if (${skip}) { await service.close(); db?.close(); process.send({event:'closed'}); process.disconnect(); }
      else {
        process.send({event:'ready', port:service.publicServer?.address().port});
        process.on('message', async () => { await service.close(); db?.close(); process.send({event:'closed'}); process.disconnect(); });
      }
    } catch(e) { await service?.close(); db?.close(); process.send({event:'rejected',code:e.code??e.message}); process.disconnect(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, configFile], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  processes.add(child);
  let diagnostics = '';
  child.stderr.on('data', bytes => { diagnostics += bytes; });
  const exit = once(child, 'exit');
  const first = await Promise.race([
    once(child, 'message').then(([value]) => value),
    exit.then(() => { throw new Error(`child exited before readiness: ${diagnostics}`); }),
  ]);
  return { child, first, exit, async stop() { child.send('close'); await exit; processes.delete(child); } };
}
const call = (socketPath, path) => new Promise((resolve, reject) => {
  const req = request({ socketPath, method: 'POST', path }, res => {
    let text = ''; res.on('data', bytes => { text += bytes; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
  }); req.on('error', reject); req.end(JSON.stringify({ externalId: 'unused' }));
});

for (const kind of ['access', 'application']) {
  test(`${kind}: real duplicate processes and unused close preserve original control; crash recovery requires its recorded inode`, { skip: process.platform === 'win32' ? 'Unix server endpoints run on Linux/macOS; Windows is an enrollment client' : false, timeout: 20000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'xl-'))), socketPath = join(root, 's'), configFile = join(root, 'config.json');
    try {
      let config;
      if (kind === 'access') {
        const ca = ensureCertificateAuthority(root), cert = ensureEnvironmentCertificate(environmentPaths(root, 'c'), ca);
        const key = join(root, 'key'), pins = join(root, 'pins');
        writeFileSync(key, randomBytes(32), { mode: 0o600 }); writeFileSync(pins, 'approved.test ssh-ed25519 fixture');
        config = { serviceId: 'lifecycle-test', endpoint: 'https://localhost:8443', listenHost: '127.0.0.1', port: 0,
          databaseFile: join(root, 'access.sqlite'), credentialKeyFile: key, adminSocket: socketPath, backupDirectory: root,
          tls: { keyFile: cert.keyFile, certFile: cert.certFile, caFile: ca.certFile }, knownHostsFile: pins, cloudCaFile: ca.certFile,
          courseIds: ['course'], target: { schema: 'xj-dev/connection-v1' } };
      } else config = { socketPath, stateFile: join(root, 'policy.json'), accountPrefix: 'managed-', courseIds: ['course'] };
      writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
      const original = await start(kind, configFile);
      assert.equal(original.first.event, 'ready');
      if (kind === 'access') { config.port = original.first.port; writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 }); }
      const before = lstatSync(socketPath), endpoint = kind === 'access' ? '/inspect' : '/disable';
      assert.equal((await call(socketPath, endpoint)).status, 200);
      const duplicate = await start(kind, configFile);
      assert.equal(duplicate.first.event, 'rejected'); await duplicate.exit; processes.delete(duplicate.child);
      assert.equal(lstatSync(socketPath).ino, before.ino);
      assert.equal((await call(socketPath, endpoint)).status, 200, 'original admin still works after duplicate startup and its close');
      const unused = await start(kind, configFile, true);
      assert.equal(unused.first.event, 'closed'); await unused.exit; processes.delete(unused.child);
      assert.equal((await call(socketPath, endpoint)).status, 200, 'close without successful listen cannot unlink another endpoint');
      original.child.kill('SIGKILL'); await original.exit; processes.delete(original.child);
      assert.equal(lstatSync(socketPath).ino, before.ino, 'abrupt process death leaves the recorded stale socket');
      const recovered = await start(kind, configFile);
      assert.equal(recovered.first.event, 'ready');
      assert.equal((await call(socketPath, endpoint)).status, 200);
      // Replace the public path while this process lives. libuv only owns its
      // unique bound hard link; closing must preserve this foreign replacement.
      rmSync(socketPath);
      const foreign = createServer(); foreign.listen(socketPath); await once(foreign, 'listening');
      const replacement = lstatSync(socketPath);
      try {
        await recovered.stop();
        assert.equal(lstatSync(socketPath).ino, replacement.ino);
        const receipt = JSON.parse(readFileSync(socketPath + '.owner.json', 'utf8'));
        assert.notEqual(receipt.ino, replacement.ino);
      } finally { await new Promise(done => foreign.close(done)); }
    } finally {
      for (const child of processes) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); }
      processes.clear(); rmSync(root, { recursive: true, force: true });
    }
  });
}
