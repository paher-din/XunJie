import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureCertificateAuthority, ensureEnvironmentCertificate } from '../src/certificates.mjs';

// Real Node processes, SQLite locks and OpenSSL. Barriers only pause actual
// operations; they do not replace certificate generation or lock acquisition.
const worker = String.raw`
import fs from 'node:fs';
import cp from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
const [moduleUrl, home, id, barrier] = process.argv.slice(1);
function pause() {
  fs.writeFileSync(join(home, id + '.paused'), '');
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(join(home, id + '.continue'))) Atomics.wait(wait, 0, 0, 5);
}
const originalExec = cp.execFileSync;
cp.execFileSync = function(file, args, ...options) {
  if (barrier === 'generation' && file === 'openssl' && args.includes('-x509')) pause();
  return originalExec.call(this, file, args, ...options);
};
const originalLink = fs.linkSync;
fs.linkSync = function(source, destination) {
  const result = originalLink.call(this, source, destination);
  if (barrier === 'key-publication' && resolve(destination) === resolve(home, 'ca', 'ca-key.pem')) pause();
  if (barrier === 'cert-publication' && resolve(destination) === resolve(home, 'ca', 'ca-cert.pem')) pause();
  return result;
};
const sqlite = createRequire(import.meta.url)('node:sqlite');
const OriginalDatabase = sqlite.DatabaseSync;
sqlite.DatabaseSync = class extends OriginalDatabase {
  exec(sql) {
    try { return super.exec(sql); }
    catch (error) {
      if (sql.includes('BEGIN IMMEDIATE') && [5, 6].includes(error.errcode & 0xff)) {
        fs.writeFileSync(join(home, id + '.contended'), '');
      }
      throw error;
    }
  }
};
syncBuiltinESMExports();
const { ensureCertificateAuthority, ensureEnvironmentCertificate } = await import(moduleUrl);
const { acquireLock } = await import(new URL('./state.mjs', moduleUrl));
process.on('message', message => {
  if (message !== 'up') return;
  const root = join(home, 'envs', id);
  const lock = acquireLock({ root, lockFile: join(root, 'lock') });
  try {
    const ca = ensureCertificateAuthority(home);
    const leaf = ensureEnvironmentCertificate({ tls: join(root, 'tls') }, ca);
    fs.writeFileSync(join(home, id + '.completed'), '');
    process.send({ ok: true, caCreated: ca.created, leafCreated: leaf.created });
  } catch (error) {
    process.send({ ok: false, code: error.code, message: error.message });
  } finally { lock.release(); }
});
process.send({ ready: true });
`;
const moduleUrl = new URL('../src/certificates.mjs', import.meta.url).href;

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'xj133-certificates-'));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = new Promise(done => child.once('exit', done));
      child.kill('SIGKILL');
      return stopped;
    }));
    rmSync(home, { recursive: true, force: true });
  });
  return { home, children };
}

async function childFor(f, id, barrier = '') {
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker, moduleUrl, f.home, id, barrier], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  f.children.push(child);
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const messages = [];
  let pending;
  child.on('message', message => {
    if (pending) { const done = pending; pending = undefined; done(message); }
    else messages.push(message);
  });
  child.next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending = undefined; reject(new Error(`certificate child timeout: ${stderr}`)); }, 15000);
    pending = message => { clearTimeout(timer); resolve(message); };
  });
  child.up = () => { child.send('up'); return child.next(); };
  assert.deepEqual(await child.next(), { ready: true });
  return child;
}

async function until(check) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'certificate barrier timed out');
    await new Promise(done => setTimeout(done, 5));
  }
}

function verify(home, id) {
  const ca = join(home, 'ca', 'ca-cert.pem');
  const leaf = join(home, 'envs', id, 'tls', 'cert.pem');
  // macOS LibreSSL lacks verify -verify_ip. Check chain/purpose with the real
  // CLI, and both SANs with Node's certificate API on every platform.
  const output = execFileSync('openssl', ['verify', '-CAfile', ca, '-purpose', 'sslserver', leaf],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(output, /: OK/);
  const cert = new X509Certificate(readFileSync(leaf));
  assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(cert.checkHost('localhost'), 'localhost');
  const publicKey = execFileSync('openssl', ['pkey', '-in', join(home, 'envs', id, 'tls', 'key.pem'), '-pubout'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(cert.publicKey.export({ type: 'spki', format: 'pem' }).toString(), publicKey.toString());
}

test('two environments cold boot concurrently under one CA; repeated up preserves root and leaves', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const first = await childFor(f, 'first', 'generation');
  const second = await childFor(f, 'second');
  const firstUp = first.up();
  await until(() => existsSync(join(f.home, 'first.paused')));
  const secondUp = second.up();
  // Old code completes the contender, then overwrites its root. Fixed code
  // contends on the real home lock until the paused creator is released.
  await until(() => existsSync(join(f.home, 'second.completed')) || existsSync(join(f.home, 'second.contended')));
  writeFileSync(join(f.home, 'first.continue'), '');
  const results = await Promise.all([firstUp, secondUp]);
  for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
  verify(f.home, 'first');
  verify(f.home, 'second');
  assert.equal(results.filter(result => result.caCreated).length, 1);
  const root = readFileSync(join(f.home, 'ca', 'ca-cert.pem'));
  const leaf = readFileSync(join(f.home, 'envs', 'first', 'tls', 'cert.pem'));
  const guard = join(f.home, 'ca', 'initialization.lock', 'mutex.sqlite');
  const inode = lstatSync(guard).ino;
  assert.deepEqual(await Promise.all([first.up(), second.up()]), [
    { ok: true, caCreated: false, leafCreated: false }, { ok: true, caCreated: false, leafCreated: false },
  ]);
  assert.deepEqual(readFileSync(join(f.home, 'ca', 'ca-cert.pem')), root);
  assert.deepEqual(readFileSync(join(f.home, 'envs', 'first', 'tls', 'cert.pem')), leaf);
  assert.equal(lstatSync(guard).ino, inode, 'CA guard inode must remain permanent');
  assert.equal(existsSync(join(f.home, 'ca', 'ca-cert.srl')), false);
});

for (const barrier of ['generation', 'key-publication', 'cert-publication']) {
  test(`creator death at ${barrier}: successor recovers the same published CA generation`, { timeout: 30000 }, async t => {
    const f = fixture(t);
    const creator = await childFor(f, 'creator', barrier);
    creator.send('up');
    await until(() => existsSync(join(f.home, 'creator.paused')));
    const certFile = join(f.home, 'ca', 'ca-cert.pem');
    const keyFile = join(f.home, 'ca', 'ca-key.pem');
    const cert = existsSync(certFile) && readFileSync(certFile);
    const key = existsSync(keyFile) && readFileSync(keyFile);
    const guard = join(f.home, 'ca', 'initialization.lock', 'mutex.sqlite');
    const inode = lstatSync(guard).ino;
    const exited = new Promise(done => creator.once('exit', done));
    creator.kill('SIGKILL');
    await exited;
    const successors = await Promise.all([childFor(f, 'one'), childFor(f, 'two')]);
    for (const result of await Promise.all(successors.map(child => child.up()))) {
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    if (cert) assert.deepEqual(readFileSync(certFile), cert);
    if (key) assert.ok(readFileSync(keyFile).equals(key), 'published CA key changed');
    assert.equal(lstatSync(guard).ino, inode);
    verify(f.home, 'one');
    verify(f.home, 'two');
    assert.equal(existsSync(join(f.home, 'ca', '.pending')), false);
  });
}

test('wrong-root, mismatched-key, missing and corrupt leaves are repaired without rotating the root', t => {
  const f = fixture(t);
  const ca = ensureCertificateAuthority(f.home);
  const other = ensureCertificateAuthority(join(f.home, 'other'));
  const paths = { tls: join(f.home, 'envs', 'repair', 'tls') };
  ensureEnvironmentCertificate(paths, other);
  const root = readFileSync(ca.certFile);
  assert.equal(ensureEnvironmentCertificate(paths, ca).created, true);
  verify(f.home, 'repair');
  const foreignPaths = { tls: join(f.home, 'foreign-tls') };
  const foreign = ensureEnvironmentCertificate(foreignPaths, ca);
  for (const damage of ['wrong-key', 'missing-key', 'missing-cert', 'corrupt-key', 'corrupt-cert']) {
    if (damage === 'wrong-key') writeFileSync(join(paths.tls, 'key.pem'), readFileSync(foreign.keyFile));
    if (damage === 'missing-key') rmSync(join(paths.tls, 'key.pem'));
    if (damage === 'missing-cert') rmSync(join(paths.tls, 'cert.pem'));
    if (damage === 'corrupt-key') writeFileSync(join(paths.tls, 'key.pem'), 'interrupted key');
    if (damage === 'corrupt-cert') writeFileSync(join(paths.tls, 'cert.pem'), 'interrupted certificate');
    assert.equal(ensureEnvironmentCertificate(paths, ca).created, true, damage);
    verify(f.home, 'repair');
    assert.deepEqual(readFileSync(ca.certFile), root);
  }
  assert.equal(ensureEnvironmentCertificate(paths, ca).created, false);
  assert.deepEqual(readdirSync(paths.tls).sort(), ['cert.pem', 'key.pem']);
});

test('an unpublished partial generation can restart; mismatched staged material cannot replace a published root', t => {
  const f = fixture(t);
  const pending = join(f.home, 'ca', '.pending');
  mkdirSync(pending, { recursive: true });
  writeFileSync(join(pending, 'ca-key.pem'), 'interrupted unpublished key');
  const ca = ensureCertificateAuthority(f.home);
  assert.equal(ca.created, true);
  const root = readFileSync(ca.certFile);
  const other = ensureCertificateAuthority(join(f.home, 'other'));
  mkdirSync(pending);
  writeFileSync(join(pending, 'ca-key.pem'), readFileSync(other.keyFile));
  writeFileSync(join(pending, 'ca-cert.pem'), readFileSync(other.certFile));
  rmSync(ca.keyFile);
  assert.throws(() => ensureCertificateAuthority(f.home), { code: 'CA_INCOMPLETE' });
  assert.deepEqual(readFileSync(ca.certFile), root);
  assert.equal(existsSync(ca.keyFile), false);
});

for (const damage of ['missing-key', 'missing-cert', 'wrong-key', 'corrupt-cert']) {
  test(`existing CA ${damage} is preserved and fails explicitly instead of rotating trust`, t => {
    const f = fixture(t);
    const ca = ensureCertificateAuthority(f.home);
    if (damage === 'missing-key') rmSync(ca.keyFile);
    if (damage === 'missing-cert') rmSync(ca.certFile);
    if (damage === 'wrong-key') {
      const other = ensureCertificateAuthority(join(f.home, 'other'));
      writeFileSync(ca.keyFile, readFileSync(other.keyFile));
    }
    if (damage === 'corrupt-cert') writeFileSync(ca.certFile, 'interrupted certificate');
    const before = [ca.keyFile, ca.certFile].map(file => existsSync(file) && readFileSync(file));
    assert.throws(() => ensureCertificateAuthority(f.home), error => error.stage === 'certificates'
      && ['CA_INCOMPLETE', 'CA_INVALID'].includes(error.code));
    for (const [index, file] of [ca.keyFile, ca.certFile].entries()) {
      const after = existsSync(file) && readFileSync(file);
      assert.ok(before[index] === false ? after === false : after && after.equals(before[index]), 'CA material changed');
    }
  });
}
