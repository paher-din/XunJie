import assert from 'node:assert/strict';
import {readFileSync, lstatSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, basename} from 'node:path';
import {createPrivateKey, X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const source = '/opt/xunjie-runner/tests/i0-entry-source-9fa76ad-lf2-20261013/apps/teaching';
const root = '/opt/xunjie-runner/tests/i0-entry-20261013-01';
const temporaryRoot = root + '/retained-tmp-20261014';
const newConfigFile = root + '/i0-host-recovered-20261014.json';
const metadataFile = root + '/recovery-preparation-20261014.json';
function checkDatabaseTarget(file, parent) {
  assert.equal(basename(file), 'synthetic.sqlite');
  assert.equal(dirname(dirname(file)), parent);
  assert.match(basename(dirname(file)), /^xunjie-a12-completion-[A-Za-z0-9]+$/);
}
if (process.argv[2] === '--self-check') {
  checkDatabaseTarget(temporaryRoot + '/xunjie-a12-completion-Ab1234/synthetic.sqlite', temporaryRoot);
  for (const file of ['/tmp/xunjie-a12-completion-Ab1234/synthetic.sqlite',
    temporaryRoot + '/other/synthetic.sqlite', temporaryRoot + '/xunjie-a12-completion-Ab1234/old.sqlite']) {
    assert.throws(() => checkDatabaseTarget(file, temporaryRoot));
  }
  console.log('Recovery target checks passed; no runtime, configuration or database accessed.');
  process.exit(0);
}
const mode = process.argv[2] ?? '--prepare';
assert(['--prepare', '--apply'].includes(mode));
let phase = 'read-only-preflight';
try {
  assert.equal(process.getuid(), 0);
  assert.equal(process.version, 'v24.21.0');
  const config = JSON.parse(readFileSync(root + '/i0-host.json', 'utf8'));
  const input = JSON.parse(readFileSync(root + '/initializer.json', 'utf8'));
  assert.equal(config.synthetic, true);
  assert.equal(config.origin, 'https://127.0.0.1:3443');
  assert.equal(input.synthetic, true);
  assert.equal(input.users.length, 5);
  assert.equal(input.courses.length, 2);
  assert.equal(new Set(input.users.map(user => user.id)).size, 5);
  for (const name of ['server.key.pem', 'server.cert.pem', 'signing-secret.txt', 'initializer.json', 'i0-host.json']) {
    const stat = lstatSync(root + '/' + name);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o777) === 0o600);
  }
  const certificate = new X509Certificate(readFileSync(config.tls.certFile));
  assert(certificate.checkPrivateKey(createPrivateKey(readFileSync(config.tls.keyFile))));
  assert(certificate.checkIP('127.0.0.1') && Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now());
  assert.equal(certificate.fingerprint256, 'C3:F8:ED:37:E0:7C:34:1B:0F:CC:55:58:D0:FC:12:FA:B4:79:13:EF:71:D1:EC:80:77:A0:E0:84:44:47:51:73');
  const {sshRunner} = await import(source + '/dist/server/records/runner.js');
  const transport = sshRunner(config.ssh);
  for (const [op, fingerprint] of [['readiness', 'b07cddf90498f8d537a24e7ad827d68109544437f30e0147eae715a39982d29a'],
    ['hdl_readiness', 'ea84f8d5a29b5cb1c7609bc0756f72fc58802d103eac6206a2ac6bf74f958386']]) {
    const {data} = await transport({op});
    assert.equal(data?.ready, true);
    assert.equal(data.recoveryGeneration, 'synthetic-generation-5944e790-6182-4807-bf21-52534b16271b');
    assert.equal(data.validation.fingerprintHash, fingerprint);
  }
  assert(!existsSync(config.databaseFile), 'Original database reappeared: stop and inspect rather than replace it.');
  for (const path of [temporaryRoot, newConfigFile, metadataFile]) assert(!existsSync(path), 'Recovery target exists: stop without overwriting.');
  const plan = {checkedAt: new Date().toISOString(), mode, originalDatabaseFile: config.databaseFile,
    temporaryRoot, newConfigFile, metadataFile, sourceCommit: '9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77',
    sameCredentials: true, schemaTables: 24, accounts: 5, courses: 2,
    origin: config.origin, databaseCreated: false, requiresExplicitSchemaApproval: true,
    startup: {cwd: source, node: '/opt/xunjie-runner/node/bin/node', args: ['dist/server/main.js'],
      PORT: '3443', TMPDIR: temporaryRoot, XUNJIE_I0_CONFIG: newConfigFile},
    note: 'New synthetic database and new object IDs; no old evidence replay or identity restoration.'};
  if (mode === '--prepare') {console.log(JSON.stringify(plan)); process.exit(0);}
  phase = 'approved-fresh-only-initialization';
  process.umask(0o077);
  mkdirSync(temporaryRoot, {mode: 0o700});
  const initialized = JSON.parse(execFileSync('/opt/xunjie-runner/node/bin/node', [source + '/dist/server/app/i0-initialize.js'],
    {cwd: source, timeout: 120000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: {PATH: '/opt/xunjie-runner/node/bin:/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8', TZ: 'UTC',
        TMPDIR: temporaryRoot, XUNJIE_I0_INITIALIZE_CONFIG: root + '/initializer.json'}}));
  checkDatabaseTarget(initialized.databaseFile, temporaryRoot);
  const Database = (await import(source + '/node_modules/better-sqlite3/lib/index.js')).default;
  const db = new Database(initialized.databaseFile, {readonly: true, fileMustExist: true});
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n, 24);
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 5);
    assert.equal(db.prepare('SELECT count(*) AS n FROM courses').get().n, 2);
    for (const table of ['assignments', 'attempts', 'jobs']) assert.equal(db.prepare('SELECT count(*) AS n FROM ' + table).get().n, 0);
    assert.equal(db.pragma('integrity_check', {simple: true}), 'ok');
  } finally {db.close();}
  phase = 'exclusive-new-host-reference';
  writeFileSync(newConfigFile, JSON.stringify({...config, databaseFile: initialized.databaseFile}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  const result = {...plan, databaseCreated: true, newDatabaseFile: initialized.databaseFile,
    startupNotYetExecuted: true, requiresExplicitSchemaApproval: false};
  writeFileSync(metadataFile, JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify(result));
} catch {
  console.log(JSON.stringify({phase, failed: true, message: 'Recovery stopped; created artifacts retained. No secrets logged or old files overwritten.'}));
  process.exitCode = 1;
}
