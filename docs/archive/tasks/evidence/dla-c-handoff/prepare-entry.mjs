import assert from 'node:assert/strict';
import {accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createPrivateKey, randomBytes, X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const source = '/opt/xunjie-runner/tests/i0-entry-source-9fa76ad-lf2-20261013/apps/teaching';
const directory = '/opt/xunjie-runner/tests/i0-entry-20261013-01';
const handoff = '/opt/xunjie-runner/tests/i0-c-revalidation-cde69cc-20261013/handoff';
let phase = 'exclusive-directory';
try {
  assert.equal(process.version, 'v24.21.0');
  assert.equal(process.getuid(), 0);
  assert(!existsSync(directory));
  const proposal = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  assert.equal(proposal.users.length, 5);
  assert.equal(proposal.courses.length, 2);
  const {readI0Config, readI0Generation, readI0SigningSecret} = await import(source + '/dist/server/app/config.js');
  const {sshRunner} = await import(source + '/dist/server/records/runner.js');
  const {availableRuntime} = await import(source + '/dist/server/design/readiness.js');
  const connection = JSON.parse(readFileSync(handoff + '/connection.json', 'utf8'));
  const transport = sshRunner(connection);
  const runtime = await availableRuntime(transport);
  assert(runtime);
  assert.equal(runtime.recoveryGeneration, readI0Generation(handoff + '/current-readiness.json'));
  const originalIdentity = JSON.parse(readFileSync(handoff + '/runtime-evidence.json', 'utf8')).originalIdentity;
  const query = await transport({op: 'query', identity: originalIdentity});
  assert.deepEqual(query.data.identity, originalIdentity);
  assert.equal(query.data.reserved, false);

  process.umask(0o077);
  mkdirSync(directory, {mode: 0o700});
  phase = 'local-demo-tls';
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '30',
    '-keyout', directory + '/server.key.pem', '-out', directory + '/server.cert.pem', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost,IP:::1', '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment', '-addext', 'extendedKeyUsage=serverAuth'],
    {timeout: 30000, stdio: ['ignore', 'ignore', 'pipe']});

  phase = 'controlled-signing-and-accounts';
  writeFileSync(directory + '/signing-secret.txt', randomBytes(32).toString('base64url') + '\n', {flag: 'wx', mode: 0o600});
  const input = {synthetic: true, users: proposal.users.map(({id, loginName}) => ({id, loginName,
    password: randomBytes(24).toString('base64url')})), courses: proposal.courses};
  writeFileSync(directory + '/initializer.json', JSON.stringify(input) + '\n', {flag: 'wx', mode: 0o600});
  phase = 'original-fresh-only-initializer';
  const initialized = JSON.parse(execFileSync('/opt/xunjie-runner/node/bin/node',
    [source + '/dist/server/app/i0-initialize.js'], {cwd: source, timeout: 120000, encoding: 'utf8',
      env: {PATH: '/opt/xunjie-runner/node/bin:/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8', TZ: 'UTC',
        XUNJIE_I0_INITIALIZE_CONFIG: directory + '/initializer.json'}, stdio: ['ignore', 'pipe', 'pipe']}));
  assert.equal(initialized.synthetic, true);
  assert.equal(typeof initialized.databaseFile, 'string');
  phase = 'new-reference-host-configuration';
  const config = {synthetic: true, databaseFile: initialized.databaseFile, origin: 'https://127.0.0.1:3443',
    tls: {keyFile: directory + '/server.key.pem', certFile: directory + '/server.cert.pem'},
    signingSecretFile: directory + '/signing-secret.txt', generationFile: handoff + '/current-readiness.json',
    ssh: connection, staticDirectory: source.replace('/apps/teaching', '/apps/student/dist'), consumerIntervalMs: 250};
  writeFileSync(directory + '/i0-host.json', JSON.stringify(config, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  readI0Config(directory + '/i0-host.json');
  readI0SigningSecret(config.signingSecretFile);
  const certificate = new X509Certificate(readFileSync(config.tls.certFile));
  assert(certificate.checkPrivateKey(createPrivateKey(readFileSync(config.tls.keyFile))));
  assert(certificate.checkIP('127.0.0.1'));
  assert(certificate.checkHost('localhost'));
  assert(certificate.checkIP('::1'));
  assert.equal(certificate.ca, false);
  assert(Date.parse(certificate.validFrom) <= Date.now() && Date.now() <= Date.parse(certificate.validTo));
  const names = ['server.key.pem', 'server.cert.pem', 'signing-secret.txt', 'initializer.json', 'i0-host.json'];
  const files = names.map(name => {
    const stat = lstatSync(directory + '/' + name);
    assert(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.uid, 0);
    assert.equal(stat.mode & 0o777, 0o600);
    accessSync(directory + '/' + name, constants.R_OK);
    return {name, uid: stat.uid, mode: '0600', bytes: stat.size};
  });
  const Database = (await import(source + '/node_modules/better-sqlite3/lib/index.js')).default;
  const db = new Database(config.databaseFile, {readonly: true, fileMustExist: true});
  let database;
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    assert.equal(tables.length, 24);
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 5);
    assert.equal(db.prepare('SELECT count(*) AS n FROM courses').get().n, 2);
    for (const name of ['assignments', 'attempts', 'jobs']) assert.equal(db.prepare('SELECT count(*) AS n FROM ' + name).get().n, 0);
    database = {file: config.databaseFile, sqlite: db.prepare('SELECT sqlite_version() AS v').get().v,
      tables: tables.length, users: 5, courses: 2, assignments: 0, attempts: 0, jobs: 0};
  } finally {db.close();}
  const metadata = {checkedAt: new Date().toISOString(), sourceCommit: '9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77',
    directory, node: process.version, uid: process.getuid(), origin: config.origin, files, database,
    certificate: {fingerprint256: certificate.fingerprint256, subjectAltName: certificate.subjectAltName,
      validFrom: certificate.validFrom, validTo: certificate.validTo, keyMatches: true, ca: false},
    runtime: {runtimeProfileVersion: runtime.profile.runtimeProfileVersion, ...runtime.readiness,
      recoveryGeneration: runtime.recoveryGeneration}, originalIdentityMatches: true,
    scope: 'Authorized new local demo materials/fresh-only database; secrets not printed or persisted to evidence'};
  writeFileSync(directory + '/preparation-metadata.json', JSON.stringify(metadata, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({phase: 'prepared', ...metadata}));
} catch (error) {
  console.log(JSON.stringify({phase, failed: true, code: error.code ?? 'ASSERTION_OR_BOUNDARY',
    message: 'Preparation stopped. Existing created materials retained; no secret values logged.'}));
  process.exitCode = 1;
}
