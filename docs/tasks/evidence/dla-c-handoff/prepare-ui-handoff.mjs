import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, createWriteStream} from 'node:fs';
import https from 'node:https';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const source = '/opt/xunjie-runner/tests/i0-entry-source-9fa76ad-lf2-20261013/apps/teaching';
const root = '/opt/xunjie-runner/tests/i0-entry-20261013-01';
const recoveryRun = process.argv[2] === '--recovery-run';
const configFile = root + (recoveryRun ? '/i0-host-recovered-20261014.json' : '/i0-host.json');
const outputPrefix = root + (recoveryRun ? '/ui-handoff-recovered-20261014' : '/ui-handoff-final');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const users = JSON.parse(readFileSync(root + '/initializer.json', 'utf8')).users;
const prior = JSON.parse(readFileSync(root + (recoveryRun ? '/https-evidence-recovery-20261014' : '/https-evidence-public-material') + '/verification.json', 'utf8'));
assert.equal(prior.passed, 20); assert.equal(prior.failed, 0); assert(prior.shutdownObserved);
const generation = JSON.parse(readFileSync(config.generationFile, 'utf8')).data.recoveryGeneration;
const agent = new https.Agent({ca: readFileSync(config.tls.certFile), rejectUnauthorized: true});
const log = createWriteStream(outputPrefix + '-server-log.ndjson', {flags: 'wx', mode: 0o600});
const child = spawn('/opt/xunjie-runner/node/bin/node', [source + '/dist/server/main.js'], {cwd: source,
  env: {PATH: '/opt/xunjie-runner/node/bin:/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8', TZ: 'UTC',
    ...(recoveryRun ? {TMPDIR: root + '/retained-tmp-20261014'} : {}),
    XUNJIE_I0_CONFIG: configFile, PORT: '3443'}, stdio: ['ignore', 'pipe', 'pipe']});
child.stdout.pipe(log, {end: false}); child.stderr.pipe(log, {end: false});
const teacher = {user: users.find(u => u.id === 'synthetic-i0-teacher-a'), cookie: '', csrf: ''};
const student = {user: users.find(u => u.id === 'synthetic-i0-student-a'), cookie: '', csrf: ''};
async function request(client, method, path, body, key) {
  const text = body === undefined ? undefined : JSON.stringify(body), headers = {};
  if (client.cookie) headers.cookie = client.cookie;
  if (method === 'POST') {headers.origin = config.origin; headers['content-type'] = 'application/json';
    if (client.csrf) headers['x-csrf-token'] = client.csrf;
    if (key) headers['idempotency-key'] = key;
    headers['content-length'] = Buffer.byteLength(text);}
  return new Promise((resolve, reject) => {
    const req = https.request({hostname: '127.0.0.1', port: 3443, path, method, headers, agent}, res => {
      assert.equal(res.socket.authorized, true); let raw = '';
      res.on('data', b => {raw += b;}); res.on('end', () => {
        assert.equal(res.statusCode, 200); if (res.headers['set-cookie']) client.cookie = res.headers['set-cookie'].map(c => c.split(';', 1)[0]).join('; ');
        resolve(JSON.parse(raw).data);
      });
    }); req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('Deadline'))); req.end(text);
  });
}
let metadata, failed = false;
try {
  let online = false;
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {await request(teacher, 'GET', '/health/live'); online = true; break;}
    catch (error) {if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error; await delay(200);}
  }
  assert(online);
  for (const client of [teacher, student]) {const login = await request(client, 'POST', '/api/sessions',
    {loginName: client.user.loginName, password: client.user.password}); client.csrf = login.csrfToken; assert(client.csrf && client.cookie);}
  const assignmentId = prior.references.assignmentId;
  const before = await request(teacher, 'GET', '/api/assignments/' + assignmentId);
  assert.equal(before.status, 'paused'); assert.equal(before.active, false);
  const receipt = await request(teacher, 'POST', '/api/assignments/' + assignmentId + '/controls',
    {recoveryGeneration: generation, expectedAssignmentRevision: before.assignmentRevision,
      action: 'resume', reason: 'Synthetic UI handoff after recorded pause acceptance'}, 'c-entry-20261014-ui-resume');
  const bootstrap = await request(student, 'GET', '/api/assignments/' + assignmentId + '/bootstrap');
  assert.equal(bootstrap.assignment.active, true); assert.equal(bootstrap.assignment.studentId, student.user.id);
  metadata = {checkedAt: new Date().toISOString(), origin: config.origin, assignmentId, before,
    current: bootstrap.assignment, recoveryGeneration: bootstrap.recoveryGeneration, receiptId: receipt.receiptId,
    studentLoginName: student.user.loginName, credentialReference: root + '/initializer.json',
    access: 'PAHER same machine only; original authorized WSL/root process consumes selected controlled credential in memory',
    bootstrapUrl: config.origin + '/api/assignments/' + assignmentId + '/bootstrap',
    frontendRoute: 'UI-owned route/bootstrap wiring still pending; no fabricated hash route',
    browserTrust: 'Not authorized or tested; strict Node client result is not browser acceptance',
    startup: {cwd: source, node: '/opt/xunjie-runner/node/bin/node', args: ['dist/server/main.js'],
      PORT: '3443', XUNJIE_I0_CONFIG: configFile,
      ...(recoveryRun ? {TMPDIR: root + '/retained-tmp-20261014'} : {})},
    scope: 'Explicit normal teacher resume of same synthetic assignment for handoff; old pause evidence retained'};
} catch (error) {failed = true; metadata = {failed: true, code: error.code ?? 'ASSERTION_OR_BOUNDARY',
  message: 'Handoff preparation stopped, original records retained; no secret values logged.'};}
finally {
  agent.destroy(); if (child.exitCode === null) child.kill('SIGTERM');
  const stopped = await new Promise(resolve => {if (child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), 180000); child.once('exit', () => {clearTimeout(timer); resolve(true);});});
  await new Promise(resolve => log.end(resolve));
  metadata.serviceRunning = false; metadata.stopConfirmed = stopped; metadata.serverExitCode = child.exitCode;
  writeFileSync(outputPrefix + '.json', JSON.stringify(metadata, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify(metadata)); if (failed || !stopped || child.exitCode !== 0) process.exitCode = 1;
}
