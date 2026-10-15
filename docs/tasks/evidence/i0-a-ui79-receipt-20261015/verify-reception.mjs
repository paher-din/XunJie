import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyEvidence, compareRefresh } from '../../../../tools/i0-hdl/verify-local-browser-evidence.mjs';
import { assertResourceUse } from '../../../../apps/teaching/server/access/resource.ts';

// Assert-based receiver audit of public archives and pure permission rules; no live services.
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const source = 'docs/tasks/evidence/ui30-hdl-20261015/';
const sha = value => createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('git', args, { cwd: repo });
const blob = (ref, path) => git(['show', `${ref}:${path}`]);
const read = path => JSON.parse(readFileSync(new URL('../ui30-hdl-20261015/' + path, import.meta.url), 'utf8'));
const checks = [];
function check(name, work) { const detail = work(); checks.push({ name, passed: true, ...(detail ? { detail } : {}) }); }
const runtime = '254e938';
const tested = '87edd51';
const latest = 'ac49334218c8cfe1e4aa945355e982ddaf3638f3';
const paths = ['apps/teaching/server/access', 'apps/teaching/server/design', 'apps/teaching/server/app',
  'apps/teaching/server/tutoring', 'apps/teaching/server/records', 'apps/teaching/server/workspace',
  'apps/teaching/server/db', 'apps/teaching/server/app.ts', 'apps/teaching/contracts', 'apps/teaching/common',
  'apps/teaching/package.json', 'apps/teaching/package-lock.json'];
const changed = (a, b) => git(['diff', '--name-only', a, b, '--', ...paths]).toString('utf8').trim().split(/\r?\n/).filter(Boolean);
check('A.originalApplicationMatchesTestedSource', () => {
  const differences = changed(tested, runtime);
  assert.deepEqual(differences, []);
  return { tested: git(['rev-parse', tested]).toString().trim(), runtime: git(['rev-parse', runtime]).toString().trim(), paths, differences };
});
check('A.currentApplicationChangesAreOnlyH05AndTests', () => {
  const differences = changed(runtime, latest);
  assert.deepEqual(differences, ['apps/teaching/contracts/workspace/index.ts', 'apps/teaching/server/db/records-adapter.ts',
    'apps/teaching/server/workspace/a5-consumption.test.ts', 'apps/teaching/server/workspace/files.ts',
    'apps/teaching/server/workspace/integration.test.ts']);
  return { current: latest, differences, liveDeploymentPerformed: false };
});
check('A.H05FixedProductionMatchesPR73', () => {
  const files = ['apps/teaching/server/db/records-adapter.ts', 'apps/teaching/server/workspace/files.ts'];
  for (const file of files) assert.equal(sha(blob(latest, file)), sha(blob('cf2326f70ed0cec8cc92f51f7402808061c1b6b7', file)));
  const contract = 'apps/teaching/contracts/workspace/index.ts';
  assert.equal(sha(blob(latest, contract)), sha(blob('a49863f', contract)));
  return { fixedSource: 'cf2326f70ed0cec8cc92f51f7402808061c1b6b7', files,
    contractSource: 'a49863f', contract, note: 'PR73 merge also retained two existing A6 feedback CAS comments; no runtime type change' };
});
check('A.archivedTlsManifestAndHealth', () => {
  const artifact = read('ui-current-manifest.json'), http = read('static-http-final.json');
  assert.equal(http.origin, 'https://127.0.0.1:3444');
  assert.equal(http.tls.verificationPassed, true);
  assert.equal(http.tls.protocol, 'Tls13');
  assert.equal(http.tls.leafInCurrentUserRoot, true);
  assert.equal(http.tls.peerLeafSha256, http.tls.approvedLeafSha256);
  assert.equal(http.artifactSha256, artifact.sha256);
  assert.equal(http.entrypointSha256, artifact.entrypointSha256);
  assert.equal(http.sourceCommit, artifact.sourceCommit);
  assert.equal(http.freshDeltaChecks.length, 13);
  assert.ok(http.freshDeltaChecks.every(x => x.passed));
  assert.ok(http.health.every(x => x.status === 200 && x.passed));
  assert.deepEqual(http.failures, []);
  return { source: http.sourceCommit, leafSha256: http.tls.peerLeafSha256, liveTlsPerformed: false, artifactBytesChecked: false };
});
const initial = read('browser-final-public.json'), supplemental = read('browser-completion-after.json');
const initialFacts = verifyEvidence(initial, { requireSettled: true });
const supplementalFacts = verifyEvidence(supplemental, { requireSettled: true });
for (const [name, facts] of [['original', initialFacts], ['supplement', supplementalFacts]]) check(`A_B.${name}.ledgerConsistency`, () => {
  assert.equal(facts.status, 'settled-consistent'); assert.deepEqual(facts.failures, []); assert.deepEqual(facts.missingEvidence, []);
  return { checked: facts.facts.checked, counts: facts.counts };
});
check('A.supplementalStalePeerHasNoStoredSideEffects', () => {
  const before = read('browser-peer-short-before.json'), after = read('browser-peer-short-after.json');
  assert.equal(compareRefresh(before, after).status, 'unchanged');
  assert.deepEqual(before.commandReceipts, after.commandReceipts);
  const op = supplemental.operations.find(x => x.operation_id === '16235ed5-73b7-42e0-b8eb-d4535abaebe0');
  assert.equal(op.result_json.finalFrame.switches, '0000000100000001');
  assert.equal(op.result_json.finalFrame.leds, '0000000100000001');
  return { explicitRetryPreservesOtherInput: true, actualBrowserOperated: false };
});
const student = { userId: 'student-a', courseId: 'course-a', role: 'student' };
const teacher = { userId: 'teacher-a', courseId: 'course-a', role: 'teacher' };
const work = { kind: 'student_work', courseId: 'course-a', studentId: 'student-a', stage: 'active', assignmentActive: true };
const material = { kind: 'material', courseId: 'course-a', studentId: 'student-a', materialKind: 'learning_material', studentVisible: true, tutorVisible: false };
const denied = (actor, scope, use, code = 'FORBIDDEN') => assert.throws(() => assertResourceUse(actor, scope, use), error => error.code === code);
check('A.purePermissionRules', () => {
  assertResourceUse(student, work, 'read');
  denied(student, { ...work, courseId: 'other-course' }, 'read');
  denied(student, { ...work, studentId: 'other-student' }, 'read');
  denied(student, work, 'teacher_sample');
  denied(teacher, work, 'write');
  assertResourceUse(student, material, 'read');
  denied(student, material, 'student_help');
  denied(student, { ...material, materialKind: 'private_answer', tutorVisible: true }, 'student_help');
  denied(student, { ...material, studentVisible: false }, 'read');
  denied(student, { ...work, stage: 'paused' }, 'student_help', 'STATE_CONFLICT');
  denied(student, { ...work, assignmentActive: false }, 'student_help', 'STATE_CONFLICT');
  assertResourceUse(student, { ...work, stage: 'paused', assignmentActive: false }, 'write');
  return { assertions: 12, boundary: 'Pure resource authorization; no authenticated HTTP/session/SQLite test in this run' };
});
check('A.reusedTestLogsRetainActualResults', () => {
  const logs = ['docs/tasks/evidence/dla-pr56-review-20261014/regression-first.txt',
    'docs/tasks/evidence/dla-pr56-review-20261014/main-combination.txt',
    'docs/tasks/evidence/i0-ac-ui-response-20261014/formal-regression.txt'];
  const result = logs.map(path => ({ path, sha256: sha(blob(latest, path)), body: blob(latest, path).toString('utf8') }));
  for (const item of result) {
    assert.ok(item.body.includes('✔ management withdrawal commits stop with permission state; a real rollback keeps permission and session active'));
    assert.ok(item.body.includes('✔ H4 freezes workspace revision at acceptance; edits before dispatch stop the original Job without a provider call'));
    assert.ok(item.body.includes('✔ H4 stop before dispatch and provider failure never prevent confirmed source reads'));
  }
  assert.match(result[0].body, /ℹ pass 70/); assert.match(result[0].body, /ℹ fail 0/);
  assert.match(result[2].body, /ℹ pass 110/); assert.match(result[2].body, /ℹ skipped 5/);
  return result.map(({ body, ...metadata }) => metadata);
});
const result = { status: 'verified', reviewer: 'Codex under explicit user A assignment', runtime: process.version,
  reviewedSource: latest, checks, checkGroups: checks.length, scope: 'A business evidence reception only',
  boundaries: ['No live TLS/session/database/VM/model/browser actions', 'Archived HTTP/transaction results reused by exact scoped source comparison', 'B teaching semantics excluded; complete product and human gates unchanged'] };
writeFileSync(new URL('reception-verification.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({status:result.status,checkGroups:result.checkGroups,originalChecks:initialFacts.facts.checked,supplementalChecks:supplementalFacts.facts.checked},null,2));
