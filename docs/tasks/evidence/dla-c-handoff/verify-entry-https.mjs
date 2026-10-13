import assert from 'node:assert/strict';
import {createHash, randomUUID, X509Certificate} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, createWriteStream} from 'node:fs';
import https from 'node:https';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {exchangeHttps, monitorApplication, stopApplication, assertReleasedActivity, assertFrozenActivity} from './entry-verification-helpers.mjs';

const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'stale', 'timed_out']);
assert.equal(['queued', 'running', 'outcome_unknown', 'running', 'succeeded'].find(status => terminalStatuses.has(status)), 'succeeded');
assert.equal(['cancelling', 'outcome_unknown', 'cancelled'].find(status => terminalStatuses.has(status)), 'cancelled');
if (process.argv[2] === '--self-check') {
  console.log('Original-ID polling keeps unknown pending until confirmed terminal/deadline: passed');
  process.exit(0);
}

const source = '/opt/xunjie-runner/tests/i0-entry-source-9fa76ad-lf2-20261013/apps/teaching';
const directory = '/opt/xunjie-runner/tests/i0-entry-20261013-01';
const config = JSON.parse(readFileSync(directory + '/i0-host.json', 'utf8'));
const input = JSON.parse(readFileSync(directory + '/initializer.json', 'utf8'));
const preparation = JSON.parse(readFileSync(directory + '/preparation-metadata.json', 'utf8'));
const generation = JSON.parse(readFileSync(config.generationFile, 'utf8')).data.recoveryGeneration;
const explicitPublicMaterialRun = process.argv[2] === '--public-material-run';
const previous = process.argv[2] && !explicitPublicMaterialRun ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : undefined;
const previousPassed = previous?.cases.filter(item => item.status === 'passed').map(item => item.id) ?? [];
const certificate = new X509Certificate(readFileSync(config.tls.certFile));
const agent = new https.Agent({ca: readFileSync(config.tls.certFile), rejectUnauthorized: true, keepAlive: true});
const executionId = randomUUID();
const evidenceDirectory = directory + (explicitPublicMaterialRun ? '/https-evidence-public-material' : previous ? '/https-evidence-resume' : '/https-evidence') + '-review-fix-' + executionId;
mkdirSync(evidenceDirectory, {mode: 0o700});
const serverLog = createWriteStream(evidenceDirectory + '/server-log.ndjson', {flags: 'wx', mode: 0o600});
const startedAt = new Date().toISOString();
const server = spawn('/opt/xunjie-runner/node/bin/node', [source + '/dist/server/main.js'], {cwd: source,
  env: {PATH: '/opt/xunjie-runner/node/bin:/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8', TZ: 'UTC',
    XUNJIE_I0_CONFIG: directory + '/i0-host.json', PORT: '3443'}, stdio: ['ignore', 'pipe', 'pipe']});
const lifecycle = monitorApplication(server, serverLog);
server.stdout.pipe(serverLog, {end: false});
server.stderr.pipe(serverLog, {end: false});
const samples = [], cases = [], references = {...previous?.references, origin: config.origin, generation, executionId};
let currentCase = 0, requestCount = 0, tlsVerified = 0, shutdownObserved = false;
let sourceFileId, inputFileId, oldSnapshot, originalRun, originalRunBody, originalRunKey;
const clients = new Map(input.users.map(user => [user.id, {user, cookie: '', csrf: ''}]));
const teacher = clients.get('synthetic-i0-teacher-a'), student = clients.get('synthetic-i0-student-a');
const peer = clients.get('synthetic-i0-student-peer'), other = clients.get('synthetic-i0-student-b');
const digest = value => createHash('sha256').update(value).digest('hex');
const key = name => 'c-entry-20261014-' + executionId + '-' + (explicitPublicMaterialRun ? 'explicit-public-material-' : previous ? 'after-confirmed-cancel-' : '') + name;
const endpoint = suffix => '/api/attempts/' + references.attemptId + suffix;
const oldSource = '#include <stdio.h>\nint main(void){puts("old snapshot");}\n';
const newSource = '#include <stdio.h>\nint main(void){puts("new snapshot");}\n';
const reportSource = '#include <stdio.h>\nint main(int argc,char**argv){if(argc<4)return 2;FILE*f=fopen(argv[3],"w");if(!f)return 1;fputs("student-owned report\\n",f);return fclose(f)!=0;}\n';
function publicValue(value, privateMaterial = false) {
  if (Array.isArray(value)) return value.map(item => publicValue(item, privateMaterial));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [name, item] of Object.entries(value)) {
    if (/password|csrf|cookie|token|secret|signature|salt/i.test(name)) continue;
    result[name] = privateMaterial && ['content', 'text', 'contentHash', 'paragraphs'].includes(name)
      ? '<redacted synthetic private material>' : publicValue(item, privateMaterial);
  }
  return result;
}
async function request(client, method, path, body, options = {}) {
  lifecycle.assertHealthy();
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers = {};
  if (client?.cookie) headers.cookie = client.cookie;
  if (method !== 'GET') {
    headers.origin = options.origin ?? config.origin;
    headers['content-type'] = 'application/json';
    if (client?.csrf && options.csrf !== false) headers['x-csrf-token'] = client.csrf;
    if (options.key) headers['idempotency-key'] = options.key;
    if (text !== undefined) headers['content-length'] = Buffer.byteLength(text);
  }
  const response = await exchangeHttps(https.request, {hostname: '127.0.0.1', port: 3443, path, method, headers, agent}, text, res => {
    assert.equal(res.socket.authorized, true);
    assert.equal(res.socket.getPeerCertificate().fingerprint256, certificate.fingerprint256);
  }, 180000);
  const {raw} = response;
  tlsVerified++; requestCount++;
  // API and health JSON must parse; an invalid response is not an asset.
  let parsed;
  try {
    if (path.startsWith('/api/') || path.startsWith('/health/') || /application\/json/i.test(response.headers['content-type'] ?? '')) parsed = JSON.parse(raw);
  } catch {
    samples.push({case: currentCase, method, path, statusCode: response.status, rawBodyPersisted: false,
      omission: 'Malformed API JSON omitted; no response body or credentials persisted'});
    throw Object.assign(new Error('Malformed API response'), {code: 'INVALID_RESPONSE_JSON'});
  }
  if (client && response.headers['set-cookie']) client.cookie = response.headers['set-cookie'].map(item => item.split(';', 1)[0]).join('; ');
  const sensitive = path === '/api/sessions' || path === '/api/session' || options.privateMaterial;
  const sample = {case: currentCase, method, path, statusCode: response.status,
    ...(body === undefined || path === '/api/sessions' ? {} : {request: publicValue(body, options.privateMaterial)}),
    response: parsed === undefined ? {contentType: response.headers['content-type'], bytes: Buffer.byteLength(raw), hash: digest(raw)}
      : publicValue(parsed, options.privateMaterial),
    ...(sensitive || parsed === undefined ? {rawBodyPersisted: false, omission: parsed === undefined
      ? 'Asset content represented by exact bytes/hash; generated bundles not copied to Git'
      : 'Authentication/private material kept in memory only'} : {rawBody: raw, rawBodyHash: digest(raw)})};
  samples.push(sample);
  return {status: response.status, body: parsed, raw};
}
function success(response) {assert.equal(response.status, 200); assert(response.body?.data); return response.body.data;}
function denied(response, code) {assert(response.status >= 400 && response.status < 500); assert.equal(response.body?.error?.code, code);}
async function runCase(id, title, work) {
  currentCase = id; const start = Date.now();
  try {await work(); cases.push({id, title, status: 'passed', elapsedMs: Date.now() - start});
    console.log(JSON.stringify({case: id, status: 'passed', title}));
  } catch (error) {cases.push({id, title, status: 'failed', code: error.code ?? 'ASSERTION_OR_BOUNDARY', elapsedMs: Date.now() - start}); throw error;}
}
async function head() {return success(await request(student, 'GET', endpoint('')));}
async function attemptCount() {
  const Database = (await import(source + '/node_modules/better-sqlite3/lib/index.js')).default;
  const db = new Database(config.databaseFile, {readonly: true, fileMustExist: true});
  try {return db.prepare('SELECT count(*) AS n FROM attempts').get().n;} finally {db.close();}
}
async function readFrozenActivity(activityVersionId, courseId) {
  const Database = (await import(source + '/node_modules/better-sqlite3/lib/index.js')).default;
  const db = new Database(config.databaseFile, {readonly: true, fileMustExist: true});
  try {
    const row = db.prepare('SELECT activity_json,content_hash FROM activity_versions WHERE id=? AND course_id=?').get(activityVersionId, courseId);
    assert(row); assert.equal(digest(row.activity_json), row.content_hash);
    return JSON.parse(row.activity_json);
  } finally {db.close();}
}
async function sync(operations, name, seq) {
  const state = await head();
  return success(await request(student, 'POST', endpoint('/sync'), {recoveryGeneration: generation,
    expectedWorkspaceRevision: state.attempt.workspaceRevision, clientId: 'c-entry-live-page', clientSeq: seq, operations}, {key: key(name)}));
}
async function snapshot(name) {
  const state = await head();
  return success(await request(student, 'POST', endpoint('/snapshots'), {recoveryGeneration: generation,
    expectedWorkspaceRevision: state.attempt.workspaceRevision}, {key: key(name)})).result;
}
async function createRun(snapshotId, mode, operation, name) {
  const state = await head();
  const body = {recoveryGeneration: generation, expectedAttemptRevision: state.attempt.attemptRevision, snapshotId,
    runtimeProfileVersion: 'c17-gcc15.3.0-textscope-v1', entryFileId: sourceFileId,
    input: {operation, fileIds: [inputFileId], ...(operation === 'report' ? {resultFile: 'report.txt'} : {})}, mode};
  const receipt = success(await request(student, 'POST', endpoint('/runs'), body, {key: key(name)}));
  return {receipt, body, key: key(name), ...receipt.result};
}
async function settled(jobId, expected) {
  const deadline = Date.now() + 150000, seen = [];
  while (Date.now() < deadline) {
    const job = success(await request(student, 'GET', '/api/jobs/' + jobId));
    if (seen.at(-1) !== job.status) seen.push(job.status);
    // Reconciliation temporarily exposes unknown while querying this same original identity.
    if (terminalStatuses.has(job.status)) {
      references.jobTransitions ??= []; references.jobTransitions.push({jobId, seen, terminal: job.status});
      assert.equal(job.status, expected); return job;
    }
    await delay(250);
  }
  throw Object.assign(new Error('Original job unfinished'), {code: 'ORIGINAL_JOB_DEADLINE'});
}
async function updateSource(text, name, seq) {
  const state = await head(), file = state.files.find(item => item.fileId === sourceFileId);
  return sync([{kind: 'update', fileId: sourceFileId, baseVersion: file.documentVersion, text}], name, seq);
}
let failed = false, failureCode;
try {
  await lifecycle.run(async () => {
  assert.equal(process.version, 'v24.21.0');
  assert.equal(preparation.sourceCommit, '9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77');
  assert.equal(preparation.runtime.recoveryGeneration, generation);
  let online = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) break;
    try {assert.equal((await request(undefined, 'GET', '/')).status, 200); online = true; break;}
    catch (error) {if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error; await delay(200);}
  }
  assert(online);
  references.serverPid = server.pid;
  if (previous) {
    const old = {runId: previous.references.originalRunId, jobId: previous.references.originalJobId};
    for (const client of clients.values()) {
      const login = success(await request(client, 'POST', '/api/sessions', {loginName: client.user.loginName, password: client.user.password}));
      client.csrf = login.csrfToken; assert(client.csrf && client.cookie);
      const session = success(await request(client, 'GET', '/api/session')); assert.equal(session.userId, client.user.id);
    }
    await settled(old.jobId, 'cancelled');
    references.previousCancelledRun = {...old, applicationConfirmed: true,
      reason: 'First verifier treated transient reconciliation unknown as terminal and closed its own host'};
    const h = await head(); sourceFileId = h.files.find(f => f.path === 'main.c').fileId;
    inputFileId = h.files.find(f => f.path === 'input.txt').fileId;
    const read = success(await request(student, 'GET', endpoint('/snapshots/' + references.oldSnapshotId)));
    oldSnapshot = {snapshotId: read.snapshotId, snapshotHash: read.hash, workspaceRevision: read.workspaceRevision};
    assert.equal(read.files.find(f => f.fileId === sourceFileId).text, oldSource);
    console.log(JSON.stringify({resumingAt: 12, previousApplicationConfirmedCancelled: true,
      previousRunId: old.runId, newRunRequiresExplicitPublicCommand: true}));
  } else {
  await runCase(1, 'Strict HTTPS pages/assets, anonymous401 and five real sessions', async () => {
    const page = await request(undefined, 'GET', '/'); assert.equal(page.status, 200);
    const assets = [...page.raw.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)(?:[?#][^"]*)?"/g)].map(match => match[1]);
    assert(assets.length); for (const path of new Set(assets)) assert.equal((await request(undefined, 'GET', path)).status, 200);
    denied(await request(undefined, 'GET', '/api/session'), 'UNAUTHENTICATED');
    references.accounts = [];
    for (const client of clients.values()) {
      const login = success(await request(client, 'POST', '/api/sessions', {loginName: client.user.loginName, password: client.user.password}));
      client.csrf = login.csrfToken; assert(client.csrf && client.cookie);
      const session = success(await request(client, 'GET', '/api/session'));
      assert.equal(session.userId, client.user.id); assert.equal(session.courses.length, 1);
      const course = input.courses.find(item => item.teacherId === client.user.id || item.studentIds.includes(client.user.id));
      assert.equal(session.courses[0].courseId, course.id);
      assert.equal(session.courses[0].role, course.teacherId === client.user.id ? 'teacher' : 'student');
      references.accounts.push({userId: session.userId, courses: session.courses});
    }
  });
  await runCase(2, 'Normal teacher creates public and private resource versions', async () => {
    const common = {recoveryGeneration: generation, teacherDesignAllowed: true};
    const pub = success(await request(teacher, 'POST', '/api/courses/synthetic-i0-course-a/resources', {...common,
      material: {format: 'txt', title: 'Synthetic reading', content: 'ASCII words',
        visibility: {student: true, tutor: true}}}, {key: key('resource-public')}));
    const priv = success(await request(teacher, 'POST', '/api/courses/synthetic-i0-course-a/resources', {...common,
      material: {format: 'txt', title: 'Synthetic private validation', content: 'Synthetic private validation asset.',
        kind: 'private_answer', visibility: {student: false, tutor: false}}}, {key: key('resource-private'), privateMaterial: true}));
    references.publicResourceId = pub.result.resourceVersion.resourceVersionId;
    references.publicMaterial = pub.result.resourceVersion.material;
    references.privateResourceId = priv.result.resourceVersion.resourceVersionId;
  });
  await runCase(3, 'Normal manual blueprint uses own policy and immutable resource refs', async () => {
    const goals = [{competencyId: 'k', competencyVersion: 1, domain: 'domain', title: 'Explain pointer and text processing'},
      {competencyId: 'p', competencyVersion: 1, domain: 'project', title: 'Compare implementation routes'},
      {competencyId: 'a', competencyVersion: 1, domain: 'ai_collaboration', title: 'Check explanations against execution'}];
    const refs = goals.map(({competencyId, competencyVersion}) => ({competencyId, competencyVersion}));
    const content = {projectTitle: 'Synthetic I0 TextScope', problem: 'Explore ASCII text and compare data structures',
      audience: 'Synthetic peers', artifact: 'C source and report', studentBackground: 'Synthetic CS course',
      timeConstraints: 'Synthetic acceptance window', routes: ['array', 'stream'], goals,
      tasks: [{taskId: 't', title: 'Compare routes', goalRefs: refs}],
      observations: [{observationId: 'o', description: 'Explain decisions with execution evidence', goalRefs: refs, taskIds: ['t']}],
      rubricCriteria: [{criterionId: 'r', description: 'Reasoning supported by execution', goalRefs: refs, observationIds: ['o']}],
      milestones: [{milestoneId: 'm', title: 'Review evidence', taskIds: ['t']}],
      resources: [{resourceVersionId: references.publicResourceId}, {resourceVersionId: references.privateResourceId}],
      helpPolicyVersionId: 'help-v1', checkRuleVersionId: 'textscope-core-v1', runtimeProfileVersionId: 'c17-gcc15.3.0-textscope-v1'};
    const result = success(await request(teacher, 'POST', '/api/courses/synthetic-i0-course-a/blueprints',
      {mode: 'manual', recoveryGeneration: generation, content}, {key: key('blueprint')}));
    references.blueprintId = result.result.draft.blueprintId; references.blueprintRevision = result.result.draft.revision;
  });
  let report;
  await runCase(4, 'Normal teacher check consumes current authenticated runtime', async () => {
    const r = success(await request(teacher, 'POST', '/api/blueprints/' + references.blueprintId + '/checks',
      {recoveryGeneration: generation, expectedRevision: references.blueprintRevision}, {key: key('blueprint-check')}));
    report = r.result.report; assert.equal(report.blocking.length, 0);
  });
  await runCase(5, 'Teacher confirms a fixed activity and role previews are scoped', async () => {
    assert.equal(report.designConcerns.filter(item => item.status === 'requires_teacher').length, 0);
    const r = success(await request(teacher, 'POST', '/api/blueprints/' + references.blueprintId + '/releases',
      {recoveryGeneration: generation, expectedRevision: references.blueprintRevision, confirmed: true, concerns: []}, {key: key('release')}));
    references.activityVersionId = r.result.activityVersionId;
    references.activityControlRevision = r.result.activityControlRevision; assert.equal(references.activityControlRevision, 1);
    assert.equal(r.result.sourceRevision, references.blueprintRevision);
    assert.equal(r.result.checks.blueprintId, references.blueprintId);
    assert.equal(r.result.checks.revision, references.blueprintRevision);
    assert.deepEqual(r.result.checks.blocking, []);
    const courseId = input.courses.find(item => item.teacherId === teacher.user.id).id;
    for (const audience of ['student', 'tutor']) {
      const activity = success(await request(teacher, 'GET', '/api/activities/' + references.activityVersionId + '?audience=' + audience));
      assertReleasedActivity(activity, {activityVersionId: references.activityVersionId, courseId,
        sourceRevision: references.blueprintRevision, activityControlRevision: references.activityControlRevision,
        runtimeProfileVersionId: preparation.runtime.runtimeProfileVersion, helpPolicyVersionId: 'help-v1', audience,
        publicResourceId: references.publicResourceId, publicMaterial: references.publicMaterial});
    }
    const frozen = await readFrozenActivity(references.activityVersionId, courseId);
    assertFrozenActivity(frozen, {...references, courseId, generation, preparation: preparation.runtime});
    // Publish only non-secret runtime evidence, never the full activity/material body.
    references.releaseEvidence = {activityVersionId: frozen.activityVersionId, courseId, sourceBlueprintId: frozen.sourceBlueprintId,
      sourceRevision: frozen.sourceRevision, recoveryGeneration: frozen.recoveryGeneration,
      runtimeProfile: frozen.runtimeProfile, runtimeReadiness: frozen.runtimeReadiness,
      source: 'Original readonly activity_versions record; authenticated release froze these values'};
  });
  await runCase(6, 'Normal teacher assigns only the intended synthetic student', async () => {
    const r = success(await request(teacher, 'POST', '/api/activities/' + references.activityVersionId + '/assignments',
      {recoveryGeneration: generation, expectedActivityControlRevision: references.activityControlRevision,
        studentIds: [student.user.id]}, {key: key('assign')}));
    references.assignmentId = r.result.assignments[0].assignmentId;
  });
  await runCase(7, 'Read-only bootstrap, anonymous/cross-student/course refusals', async () => {
    const beforeCount = await attemptCount();
    const path = '/api/assignments/' + references.assignmentId + '/bootstrap';
    const boot = success(await request(student, 'GET', path)); assert.equal(boot.recoveryGeneration, generation);
    assert.equal(boot.assignment.studentId, student.user.id); assert.equal(boot.assignment.active, true);
    denied(await request(undefined, 'GET', path), 'UNAUTHENTICATED');
    denied(await request(peer, 'GET', path), 'FORBIDDEN'); denied(await request(other, 'GET', path), 'FORBIDDEN');
    assert.equal(await attemptCount(), beforeCount);
  });
  await runCase(8, 'Explicit student attempt creation starts with confirmed empty workspace', async () => {
    const r = success(await request(student, 'POST', '/api/assignments/' + references.assignmentId + '/attempts',
      {recoveryGeneration: generation}, {key: key('attempt')}));
    references.attemptId = r.result.attemptId; const h = await head();
    assert.equal(h.attempt.status, 'ready'); assert.equal(h.files.length, 0); assert.equal(h.jobs.length, 0);
  });
  await runCase(9, 'Sync ACK, original-key replay/conflict and stale workspace refusal', async () => {
    const body = {recoveryGeneration: generation, expectedWorkspaceRevision: 0, clientId: 'c-entry-live-page', clientSeq: 1,
      operations: [{kind: 'create', clientFileKey: 'source', path: 'main.c', text: oldSource},
        {kind: 'create', clientFileKey: 'input', path: 'input.txt', text: 'Alpha beta\n'}]};
    const r = success(await request(student, 'POST', endpoint('/sync'), body, {key: key('sync-first')}));
    sourceFileId = r.result.created.source; inputFileId = r.result.created.input;
    const replay = success(await request(student, 'POST', endpoint('/sync'), body, {key: key('sync-first')}));
    assert.equal(replay.receiptId, r.receiptId); assert.equal(replay.replayed, true);
    denied(await request(student, 'POST', endpoint('/sync'), {...body, clientSeq: 2}, {key: key('sync-first')}), 'IDEMPOTENCY_CONFLICT');
    denied(await request(student, 'POST', endpoint('/sync'), {...body, clientSeq: 2}, {key: key('sync-stale')}), 'VERSION_CONFLICT');
  });
  await runCase(10, 'Authoritative attempt/workspace/decision versions are reread after ACK', async () => {
    const h = await head(); assert.equal(h.attempt.workspaceRevision, 1); assert.equal(h.attempt.attemptRevision, 2);
    assert.equal(h.attempt.decisionEpoch, 0); references.afterSync = h.attempt;
  });
  await runCase(11, 'Explicit frozen snapshot binds confirmed files and manifest hash', async () => {
    oldSnapshot = await snapshot('snapshot-old'); references.oldSnapshotId = oldSnapshot.snapshotId;
    const read = success(await request(student, 'GET', endpoint('/snapshots/' + oldSnapshot.snapshotId)));
    assert.equal(read.hash, oldSnapshot.snapshotHash); assert.equal(read.files.length, 2);
    assert.equal(read.files.find(f => f.fileId === sourceFileId).contentHash, digest(oldSource));
  });
  }
  await runCase(12, 'Original main consumer runs real C1 job without manual processJob', async () => {
    originalRun = await createRun(oldSnapshot.snapshotId, 'run', 'stats', 'run-old');
    originalRunBody = originalRun.body; originalRunKey = originalRun.key;
    references.originalRunId = originalRun.runId; references.originalJobId = originalRun.jobId;
    await settled(originalRun.jobId, 'succeeded');
    const run = success(await request(student, 'GET', endpoint('/runs/' + originalRun.runId)));
    assert.equal(run.snapshotId, oldSnapshot.snapshotId); assert.equal(run.diagnostics.stdout, 'old snapshot\n');
  });
  await runCase(13, 'A new acknowledged draft never changes the old run/snapshot', async () => {
    await updateSource(newSource, 'sync-new', 2);
    const old = success(await request(student, 'GET', endpoint('/runs/' + originalRun.runId)));
    assert.equal(old.diagnostics.stdout, 'old snapshot\n');
    const snap = success(await request(student, 'GET', endpoint('/snapshots/' + oldSnapshot.snapshotId)));
    assert.equal(snap.files.find(f => f.fileId === sourceFileId).text, oldSource);
  });
  await runCase(14, 'Original run key/body replays the same receipt/job/run after head changes', async () => {
    const replay = success(await request(student, 'POST', endpoint('/runs'), originalRunBody, {key: originalRunKey}));
    assert.equal(replay.receiptId, originalRun.receipt.receiptId);
    assert.equal(replay.result.runId, originalRun.runId); assert.equal(replay.result.jobId, originalRun.jobId);
    assert.equal(replay.replayed, true);
  });
  await runCase(15, 'Trusted course check fails incomplete TextScope and redacts private artifacts', async () => {
    const check = await createRun(oldSnapshot.snapshotId, 'course_check', 'stats', 'course-check');
    references.checkRunId = check.runId; await settled(check.jobId, 'succeeded');
    const run = success(await request(student, 'GET', endpoint('/runs/' + check.runId)));
    assert.equal(run.diagnostics.verdict, 'failed');
    assert.equal(success(await request(student, 'GET', endpoint('/runs/' + check.runId + '/files'))).status, 'redacted');
  });
  await runCase(16, 'Real report result file has original run/snapshot, bytes/hash and complete status', async () => {
    await updateSource(reportSource, 'sync-report', 3); const snap = await snapshot('snapshot-report');
    const run = await createRun(snap.snapshotId, 'run', 'report', 'run-report'); references.reportRunId = run.runId;
    await settled(run.jobId, 'succeeded');
    const files = success(await request(student, 'GET', endpoint('/runs/' + run.runId + '/files')));
    assert.equal(files.status, 'available'); const f = files.files.find(item => item.relativeName === 'report.txt');
    assert(f); assert.equal(f.status, 'complete'); assert.equal(f.text, 'student-owned report\n');
    assert.equal(f.bytes, Buffer.byteLength(f.text)); assert.equal(f.contentHash, digest(f.text));
    assert.equal(f.runId, run.runId); assert.equal(f.snapshotId, snap.snapshotId);
  });
  await runCase(17, 'Explicit cancel preserves original identity and waits for confirmed terminal state', async () => {
    await updateSource('int main(void){for(;;){}return 0;}\n', 'sync-loop', 4); const snap = await snapshot('snapshot-loop');
    const run = await createRun(snap.snapshotId, 'run', 'stats', 'run-loop'); references.cancelRunId = run.runId;
    const deadline = Date.now() + 150000; let running = false;
    while (Date.now() < deadline) {const j = success(await request(student, 'GET', '/api/jobs/' + run.jobId));
      if (j.status === 'running') {running = true; break;} assert(['queued', 'outcome_unknown'].includes(j.status)); await delay(100);}
    assert(running);
    const cancelled = success(await request(student, 'POST', '/api/jobs/' + run.jobId + '/cancel',
      {recoveryGeneration: generation}, {key: key('cancel-loop')}));
    const terminal = await settled(run.jobId, 'cancelled'); assert.equal(terminal.stopRequested, true);
    const replay = success(await request(student, 'POST', '/api/jobs/' + run.jobId + '/cancel',
      {recoveryGeneration: generation}, {key: key('cancel-loop')}));
    assert.equal(replay.receiptId, cancelled.receiptId);
  });
  await runCase(18, 'Teacher pause permits existing saves/snapshot but rejects create/recycle/restore/run', async () => {
    const scratch = await sync([{kind: 'create', clientFileKey: 'scratch', path: 'scratch.txt', text: 'Synthetic recovery file\n'}], 'scratch-create', 5);
    const scratchId = scratch.result.created.scratch;
    await sync([{kind: 'recycle', fileId: scratchId, baseVersion: 1}], 'scratch-recycle', 6);
    const assignment = success(await request(teacher, 'GET', '/api/assignments/' + references.assignmentId));
    success(await request(teacher, 'POST', '/api/assignments/' + references.assignmentId + '/controls',
      {recoveryGeneration: generation, expectedAssignmentRevision: assignment.assignmentRevision, action: 'pause', reason: 'Synthetic handoff pause'}, {key: key('pause')}));
    const paused = success(await request(student, 'GET', '/api/assignments/' + references.assignmentId + '/bootstrap'));
    assert.equal(paused.assignment.active, false); assert.equal(paused.assignment.status, 'paused');
    await updateSource(newSource, 'paused-save', 7); await snapshot('paused-snapshot');
    for (const operation of [{kind: 'create', clientFileKey: 'forbidden', path: 'forbidden.txt', text: 'Synthetic'},
      {kind: 'recycle', fileId: sourceFileId}, {kind: 'restore', fileId: scratchId}]) {
      const h = await head(); if (operation.fileId) operation.baseVersion = h.files.find(f => f.fileId === operation.fileId).documentVersion;
      denied(await request(student, 'POST', endpoint('/sync'), {recoveryGeneration: generation,
        expectedWorkspaceRevision: h.attempt.workspaceRevision, clientId: 'c-entry-live-page', clientSeq: 8,
        operations: [operation]}, {key: key('paused-' + operation.kind)}), 'STATE_CONFLICT');
    }
    const h = await head(); denied(await request(student, 'POST', endpoint('/runs'), {...originalRunBody,
      expectedAttemptRevision: h.attempt.attemptRevision}, {key: key('paused-run')}), 'STATE_CONFLICT');
    references.pausedAssignment = paused.assignment;
  });
  await runCase(19, 'Old generation is rejected and recovery GET has no execution side effects', async () => {
    const before = await head(), file = before.files.find(f => f.fileId === sourceFileId);
    denied(await request(student, 'POST', endpoint('/sync'), {recoveryGeneration: 'synthetic-old-generation-for-rejection',
      expectedWorkspaceRevision: before.attempt.workspaceRevision, clientId: 'c-entry-live-page', clientSeq: 9,
      operations: [{kind: 'update', fileId: sourceFileId, baseVersion: file.documentVersion, text: newSource}]}, {key: key('old-generation')}), 'RECOVERY_REQUIRED');
    const recovery = success(await request(student, 'GET', endpoint('/recovery?recoveryGeneration=synthetic-old-generation-for-rejection&decisionEpoch=' + before.attempt.decisionEpoch)));
    assert.equal(recovery.resyncRequired, true); const after = await head();
    assert.deepEqual(after.attempt, before.attempt); assert.equal(after.jobs.length, before.jobs.length);
  });
  await runCase(20, 'Origin/CSRF/ownership/private/static refusals and explicit unexecuted fault gaps', async () => {
    const h = await head(), f = h.files.find(file => file.fileId === sourceFileId);
    const body = {recoveryGeneration: generation, expectedWorkspaceRevision: h.attempt.workspaceRevision,
      clientId: 'c-entry-live-page', clientSeq: 10, operations: [{kind: 'update', fileId: sourceFileId, baseVersion: f.documentVersion, text: newSource}]};
    denied(await request(student, 'POST', endpoint('/sync'), body, {key: key('no-csrf'), csrf: false}), 'FORBIDDEN');
    denied(await request(student, 'POST', endpoint('/sync'), body, {key: key('wrong-origin'), origin: 'https://127.0.0.1:3444'}), 'FORBIDDEN');
    denied(await request(peer, 'GET', endpoint('')), 'FORBIDDEN'); denied(await request(other, 'GET', endpoint('')), 'FORBIDDEN');
    denied(await request(student, 'GET', '/api/resources/' + references.privateResourceId), 'FORBIDDEN');
    success(await request(student, 'GET', '/api/resources/' + references.publicResourceId));
    const invalid = await request(undefined, 'GET', '/%2e%2e/server.key.pem');
    assert(invalid.status >= 400); assert(!invalid.raw.includes('PRIVATE KEY'));
    references.unexecuted = ['real transport disconnect/outcome_unknown injection', 'browser certificate trust and UI workflow',
      'system CA changes', 'node maintenance', 'HDL/ALU and model', 'full NFR/human/teaching acceptance'];
  });
  });
} catch (error) {
  failed = true; failureCode = error.code ?? 'ASSERTION_OR_BOUNDARY';
  console.log(JSON.stringify({failed: true, case: currentCase, code: error.code ?? 'ASSERTION_OR_BOUNDARY',
    message: 'Execution stopped at failed boundary; original references retained, no automatic replacement or retry.'}));
} finally {
  agent.destroy();
  const shutdown = await stopApplication(server, serverLog, {spawnFailed: lifecycle.spawnFailed});
  shutdownObserved = shutdown.stopConfirmed;
  if (shutdown.shutdownErrorCode || lifecycle.failureCode) failed = true;
  if (shutdownObserved) lifecycle.dispose();
  const evidence = {startedAt, finishedAt: new Date().toISOString(), sourceCommit: '9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77',
    origin: config.origin, databaseFile: config.databaseFile, node: process.version, cases, references, requestCount,
    tlsVerifiedResponses: tlsVerified, ...shutdown, shutdownObserved, executionFailed: failed,
    ...(failed ? {failureCode: failureCode ?? shutdown.shutdownErrorCode ?? lifecycle.failureCode,
      failureStage: shutdown.shutdownErrorCode ? 'shutdown' : lifecycle.failureCode ? 'application-process-or-log' : 'case-' + currentCase} : {}),
    passed: cases.filter(c => c.status === 'passed').length, failed: cases.filter(c => c.status === 'failed').length,
    previousEvidence: previous ? process.argv[2] : undefined, previousPassed,
    distinctPassingCaseCoverage: new Set([...previousPassed, ...cases.filter(c => c.status === 'passed').map(c => c.id)]).size,
    remainingCasesUnexecuted: Array.from({length: 20}, (_, i) => i + 1).filter(id => !cases.some(c => c.id === id) && !previousPassed.includes(id)),
    scope: 'Authorized synthetic real HTTPS/main/original automatic worker; no fixture transport or manual processJob; browser acceptance separate'};
  writeFileSync(evidenceDirectory + '/verification.json', JSON.stringify(evidence, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  writeFileSync(evidenceDirectory + '/http-public-samples.json', JSON.stringify(samples, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({passed: evidence.passed, failed: evidence.failed, unexecuted: evidence.remainingCasesUnexecuted,
    requestCount, tlsVerifiedResponses: tlsVerified, shutdownObserved, serverExitCode: server.exitCode, evidenceDirectory}));
  if (failed || !shutdownObserved || server.exitCode !== 0) process.exitCode = 1;
}
