import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash, X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import https from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import {exchangeHttps} from './entry-verification-helpers.mjs';

function assertReady(response) {
  assert.equal(response.status, 200);
  assert.equal(response.body?.data?.status, 'ready');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.body.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(response.headers['x-request-id'], response.body.requestId);
}
if (process.argv[2] === '--self-check') {
  const valid = {status: 200, body: {requestId: '11111111-1111-4111-8111-111111111111', data: {status: 'ready'}},
    headers: {'cache-control': 'no-store', 'x-request-id': '11111111-1111-4111-8111-111111111111'}};
  assertReady(valid);
  for (const invalid of [{...valid, status: 503}, {...valid, headers: {...valid.headers, 'cache-control': null}},
    {...valid, body: {...valid.body, data: {status: 'alive'}}}, {...valid, headers: {...valid.headers, 'x-request-id': 'wrong'}}]) {
    assert.throws(() => assertReady(invalid));
  }
  console.log('Ready response rejects 503, wrong status, cache and requestId: passed');
  process.exit(0);
}
const mode = process.argv[2];
assert(['before', 'after'].includes(mode));
assert.equal(process.version, 'v24.21.0');
assert.equal(process.getuid(), 0);
const root = '/opt/xunjie-runner/tests/i0-entry-20261013-01';
const output = root + '/pr59-adoption-20261014';
const oldSource = '/opt/xunjie-runner/tests/i0-entry-source-9fa76ad-lf2-20261013/apps/teaching';
const source = '/opt/xunjie-runner/tests/i0-entry-source-964abb4-20261014/apps/teaching';
const unit = mode === 'before' ? 'xunjie-i0-entry-recovered-20261014.service' : 'xunjie-i0-entry-pr59-20261014.service';
const configFile = root + '/i0-host-recovered-20261014.json';
const configBytes = readFileSync(configFile), config = JSON.parse(configBytes);
const references = JSON.parse(readFileSync(root + '/current-entry-recovered-20261014.json', 'utf8'));
const user = JSON.parse(readFileSync(root + '/initializer.json', 'utf8')).users.find(value => value.id === references.studentLoginName);
const certificate = new X509Certificate(readFileSync(config.tls.certFile));
const agent = new https.Agent({ca: readFileSync(config.tls.certFile), rejectUnauthorized: true, keepAlive: true, maxCachedSessions: 0});
const samples = [];
let cookie = '', verified = 0, phase = 'service';
async function request(method, path, body) {
  const text = body === undefined ? undefined : JSON.stringify(body), headers = {};
  if (cookie) headers.cookie = cookie;
  if (text) {headers.origin = config.origin; headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(text);}
  const result = await exchangeHttps(https.request, {hostname: '127.0.0.1', port: 3443, path, method, headers, agent}, text,
    response => {assert.equal(response.socket.authorized, true); assert.equal(response.socket.getPeerCertificate().fingerprint256, certificate.fingerprint256); verified++;}, 10000);
  const parsed = JSON.parse(result.raw);
  if (result.headers['set-cookie']) cookie = result.headers['set-cookie'].map(value => value.split(';', 1)[0]).join('; ');
  samples.push({method, path, statusCode: result.status, requestId: parsed.requestId,
    responseRequestId: result.headers['x-request-id'], cacheControl: result.headers['cache-control'] ?? null,
    ...(path.startsWith('/health/') ? {body: parsed} : {authenticationOrWorkspaceBodyOmitted: true})});
  return {...result, body: parsed};
}
function success(response) {assert.equal(response.status, 200); assert(response.body?.data); return response.body.data;}
try {
  const service = Object.fromEntries(execFileSync('/usr/bin/systemctl', ['show', unit, '--property=MainPID,ActiveState,SubState'], {encoding: 'utf8'})
    .trim().split('\n').map(line => {const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];}));
  assert.equal(service.ActiveState, 'active');
  const argv = readFileSync('/proc/' + service.MainPID + '/cmdline', 'utf8').split('\0').filter(Boolean);
  assert.equal(argv[1], (mode === 'before' ? oldSource : source) + '/dist/server/main.js');
  phase = 'live-and-readiness';
  let live;
  for (let i = 0; i < 40; i++) {
    try {live = await request('GET', '/health/live'); break;}
    catch (error) {if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error; await delay(250);}
  }
  success(live);
  let ready;
  const deadline = Date.now() + 25000;
  do {ready = await request('GET', '/health/ready'); if (mode === 'before' || ready.status === 200) break; await delay(250);} while (Date.now() < deadline);
  if (mode === 'after') assertReady(ready);
  else {assert.equal(ready.status, 503); assert.equal(ready.body.error.code, 'DEPENDENCY_UNAVAILABLE');}
  assert.notEqual(ready.body.requestId, live.body.requestId);
  phase = 'same-account-and-objects';
  assert(user);
  success(await request('POST', '/api/sessions', {loginName: user.loginName, password: user.password}));
  assert.equal(success(await request('GET', '/api/session')).userId, user.id);
  const assignment = success(await request('GET', '/api/assignments/' + references.assignmentId + '/bootstrap')).assignment;
  const attempt = success(await request('GET', '/api/attempts/' + references.attempt.attemptId)).attempt;
  assert.equal(assignment.assignmentId, references.assignmentId); assert.equal(assignment.studentId, user.id);
  assert.equal(attempt.assignmentId, assignment.assignmentId); assert.equal(attempt.attemptId, references.attempt.attemptId);
  phase = 'existing-database-and-node';
  const Database = (await import(source + '/node_modules/better-sqlite3/lib/index.js')).default;
  const db = new Database(config.databaseFile, {readonly: true, fileMustExist: true});
  let database;
  try {
    database = {path: config.databaseFile, integrity: db.pragma('integrity_check', {simple: true}),
      tables: db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n,
      assignments: db.prepare('SELECT count(*) AS n FROM assignments').get().n, attempts: db.prepare('SELECT count(*) AS n FROM attempts').get().n,
      jobStates: db.prepare('SELECT status,count(*) AS n FROM jobs GROUP BY status').all(),
      pendingJobs: db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running','cancelling','outcome_unknown')").get().n};
    assert.equal(database.integrity, 'ok'); assert.equal(database.tables, 24); assert.equal(database.pendingJobs, 0);
  } finally {db.close();}
  const {sshRunner} = await import(source + '/dist/server/records/runner.js');
  const transport = sshRunner(config.ssh), readiness = {};
  for (const op of ['readiness', 'hdl_readiness']) {
    const data = (await transport({op})).data; assert.equal(data.ready, true);
    assert.equal(data.recoveryGeneration, references.readiness.readiness.recoveryGeneration);
    assert.equal(data.validation.fingerprintHash, references.readiness[op].fingerprintHash);
    readiness[op] = {ready: true, fingerprintHash: data.validation.fingerprintHash, sourceHash: data.fingerprint.sourceHash, recoveryGeneration: data.recoveryGeneration};
  }
  const result = {checkedAt: new Date().toISOString(), mode, passed: true, unit, service, processArgv: argv,
    sourceCommit: mode === 'before' ? '9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77' : '964abb4277c2cf58e81d6686f6349b6ef0fa2e39',
    origin: config.origin, configFile, configSha256: createHash('sha256').update(configBytes).digest('hex'),
    requiredEnvironment: {PORT: '3443', TMPDIR: root + '/retained-tmp-20261014', XUNJIE_I0_CONFIG: configFile},
    staticDirectory: config.staticDirectory, assignment, attempt, database, readiness, tlsVerifiedResponses: verified, samples,
    credentialReference: root + '/initializer.json', studentLoginName: user.loginName, secretsPersisted: false, browserAcceptance: 'not executed'};
  if (mode === 'after') {
    const before = JSON.parse(readFileSync(output + '/before.json', 'utf8'));
    for (const field of ['configSha256', 'assignment', 'attempt', 'database', 'readiness']) assert.deepEqual(result[field], before[field]);
    result.sameExistingConfigurationDatabaseObjectsAndNode = true;
  }
  writeFileSync(output + '/' + mode + '.json', JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify(result));
} catch (error) {
  const result = {checkedAt: new Date().toISOString(), mode, passed: false, phase, errorCode: error.code ?? 'ASSERTION_OR_BOUNDARY',
    samples, message: 'Check stopped; original objects retained and no secret values logged.'};
  writeFileSync(output + '/' + mode + '-failed.json', JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify(result)); process.exitCode = 1;
} finally {agent.destroy();}
