import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWorkspaceDatabase, openSyntheticDatabase } from '../db/transaction.ts';
import type { SyntheticDatabase } from '../db/transaction.ts';
import { createPasswordRecord } from '../access/password.ts';
import { createWorkspaceApp } from './application.ts';
import { readRuntime } from '../records/runner.ts';
import type { RunnerTransport } from '../records/runner.ts';

export const origin = 'https://synthetic.example';
export const syntheticProfile = { runtimeProfileVersion: 'runtime-v1', imageDigest: 'sha256:' + 'a'.repeat(64),
  compilerImage: 'sha256:' + 'b'.repeat(64), runtimeImage: 'sha256:' + 'c'.repeat(64), approvedResultFiles: ['report.txt'] };
export async function fixture(transport?: RunnerTransport) {
  const runtime = transport ? await readRuntime(transport) : undefined, profile = runtime?.profile ?? syntheticProfile;
  let db = createWorkspaceDatabase(), time = Date.now(), generation = runtime?.recoveryGeneration ?? 'generation', ready = true;
  let failStatement = '';
  const password = randomBytes(32).toString('base64url'), signingSecret = randomBytes(48).toString('hex'), record = await createPasswordRecord(password);
  db.withTransaction(tx => {
    for (const user of ['teacher','student','other','foreign']) tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES (?,?,?,?,?,?,?,?,?)',
      user,user,record.hash,record.salt,'scrypt',131072,8,1,64);
    for (const course of ['course','foreign-course']) tx.run('INSERT INTO courses(id) VALUES (?)',course);
    for (const [course,user,role] of [['course','teacher','teacher'],['course','student','student'],['course','other','student'],['foreign-course','foreign','teacher']])
      tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,1)',course!,user!,role!);
  });
  const runner: RunnerTransport = transport ?? (async command => {
    if (command.op !== 'readiness') throw new Error('Synthetic runner operation unavailable.');
    const fingerprint = { profile, sourceHash: 'd'.repeat(64) };
    return { data: { ready, ...profile, recoveryGeneration: generation, fingerprint,
      validation: { passed: true, fingerprintHash: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'), validatedAt: new Date().toISOString() } } };
  });
  const wrapped: SyntheticDatabase = { get file() { return db.file; }, get diagnostics() { return db.diagnostics; }, close() { db.close(); },
    withTransaction(work) { return db.withTransaction(tx => work({ ...tx, run(sql, ...args) {
      if (failStatement && sql.includes(failStatement)) throw new Error('Synthetic late SQL failure.');
      return tx.run(sql, ...args);
    } })); } };
  const options = () => ({ db: wrapped, origin, signingSecret, currentGeneration: () => generation, runner, now: () => time });
  let service = await createWorkspaceApp(options());
  function register() {
    service.app.post('/fixture/policy', request => ({ data: service.design.configurePolicy(request, 'course', request.body) }));
    service.app.post('/fixture/rule', request => ({ data: service.design.configureRule(request, 'course', request.body) }));
    service.app.get('/fixture/tutor/:id', request => ({ data: service.workspace.readTutorContext(request, (request.params as { id: string }).id) }));
    service.app.get('/fixture/process/:id', request => ({ data: service.workspace.readProcessRecords(request, (request.params as { id: string }).id) }));
  }
  register();
  async function login(user = 'student') {
    const response = await service.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: user, password } });
    assert.equal(response.statusCode,200,response.body);
    return { origin, cookie: response.cookies.filter(c => c.value).map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; '),
      'x-csrf-token': String(response.json().data.csrfToken) };
  }
  return { profile, login, signingSecret, generation: () => generation, timestamp: () => time,
    get db() { return db; }, get app() { return service.app; }, get workspace() { return service.workspace; },
    unavailable() { ready = false; }, restoreGeneration() { generation = 'new-generation'; }, advance(ms: number) { time += ms; },
    injectFailure(statement: string) { failStatement = statement; },
    async reopen() { const file = db.file; await service.app.close(); db.close(); db = openSyntheticDatabase(file); service = await createWorkspaceApp(options()); register(); },
    async close() { await service.app.close(); db.close(); } };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export type Headers = Awaited<ReturnType<Fixture['login']>>;
export function command(f: Fixture, headers: Headers, url: string, payload: object, key: string = randomUUID()) {
  return f.app.inject({ method: 'POST', url, headers: { ...headers,'idempotency-key': key }, payload: { recoveryGeneration: f.generation(),...payload } });
}
export async function assigned(f: Fixture, teacher: Headers, limitedHelp = true, rule: 'textscope-core-v1'|'textscope-report-v1' = 'textscope-core-v1') {
  assert.equal((await f.app.inject({ method: 'POST', url: '/fixture/policy', headers: teacher, payload: { versionId: 'help-v1',helpAllowed: true,wholeSolutionAllowed: false,limitedCheckHelpAllowed: false,description: 'Synthetic policy' } })).statusCode,200);
  assert.equal((await f.app.inject({ method: 'POST', url: '/fixture/rule', headers: teacher, payload: { versionId: rule,validatorVersion: 'textscope-validator-v2',limitedHelp,description: 'Synthetic checks' } })).statusCode,200);
  const material = await command(f,teacher,'/api/courses/course/resources',{ teacherDesignAllowed: true,material: { format: 'txt',title: 'Reading',content: 'ASCII words' } });
  assert.equal(material.statusCode,200,material.body);
  const privateMaterial = await command(f,teacher,'/api/courses/course/resources',{ teacherDesignAllowed: true,material: { format: 'txt',title: 'PRIVATE_TITLE',content: 'PRIVATE_BODY',kind: 'private_answer',visibility: { student: false,tutor: false } } });
  assert.equal(privateMaterial.statusCode,200,privateMaterial.body);
  const goals = [{ competencyId: 'k',competencyVersion: 1,domain: 'domain',title: 'Explain pointers' },{ competencyId: 'p',competencyVersion: 1,domain: 'project',title: 'Compare routes' },{ competencyId: 'a',competencyVersion: 1,domain: 'ai_collaboration',title: 'Check AI' }];
  const refs = goals.map(({ competencyId,competencyVersion }) => ({ competencyId,competencyVersion }));
  const draft = await command(f,teacher,'/api/courses/course/blueprints',{ mode: 'manual',content: { projectTitle: 'TextScope',problem: 'Explore text',audience: 'Peers',artifact: 'C source',routes: ['array','tree'],goals,
    tasks: [{ taskId: 't',title: 'Compare',goalRefs: refs }],observations: [{ observationId: 'o',description: 'Explain decisions',goalRefs: refs,taskIds: ['t'] }],
    rubricCriteria: [{ criterionId: 'r',description: 'Reasoning',goalRefs: refs,observationIds: ['o'] }],milestones: [{ milestoneId: 'm',title: 'Review',taskIds: ['t'] }],
    resources: [material,privateMaterial].map(res => ({ resourceVersionId: res.json().data.result.resourceVersion.resourceVersionId as string })),
    helpPolicyVersionId: 'help-v1',checkRuleVersionId: rule,runtimeProfileVersionId: f.profile.runtimeProfileVersion } });
  assert.equal(draft.statusCode,200,draft.body);
  const blueprint = String(draft.json().data.result.draft.blueprintId);
  const checks = await command(f,teacher,`/api/blueprints/${blueprint}/checks`,{ expectedRevision: 1 });
  assert.equal(checks.statusCode,200,checks.body); assert.equal(checks.json().data.result.report.blocking.length,0,checks.body);
  const release = await command(f,teacher,`/api/blueprints/${blueprint}/releases`,{ expectedRevision: 1,confirmed: true });
  assert.equal(release.statusCode,200,release.body);
  const activityId = String(release.json().data.result.activityVersionId);
  const allocation = await command(f,teacher,`/api/activities/${activityId}/assignments`,{ expectedActivityControlRevision: 1,studentIds: ['student'] });
  assert.equal(allocation.statusCode,200,allocation.body);
  return { activityId,assignmentId: String(allocation.json().data.result.assignments[0].assignmentId) };
}
export async function opened(f: Fixture, student: Headers, assignmentId: string) {
  const created = await command(f,student,`/api/assignments/${assignmentId}/attempts`,{});
  assert.equal(created.statusCode,200,created.body); return String(created.json().data.result.attemptId);
}
export async function view(f: Fixture, student: Headers, id: string) {
  const response = await f.app.inject({ url: `/api/attempts/${id}`,headers: student });
  assert.equal(response.statusCode,200,response.body); return response.json().data;
}
export async function files(f: Fixture, student: Headers, id: string, source = '#include <stdio.h>\nint main(void){puts("old snapshot");}\n') {
  const response = await command(f,student,`/api/attempts/${id}/sync`,{ expectedWorkspaceRevision: 0,clientId: 'page',clientSeq: 5,
    operations: [{ kind: 'create',clientFileKey: 'source',path: 'main.c',text: source },{ kind: 'create',clientFileKey: 'input',path: 'input.txt',text: 'Alpha beta\n' }],process: { captureRevision: 0 } });
  assert.equal(response.statusCode,200,response.body); return response.json().data.result.created as { source: string;input: string };
}
export async function snapshot(f: Fixture, student: Headers, id: string) {
  const state = await view(f,student,id);
  const response = await command(f,student,`/api/attempts/${id}/snapshots`,{ expectedWorkspaceRevision: state.attempt.workspaceRevision });
  assert.equal(response.statusCode,200,response.body); return String(response.json().data.result.snapshotId);
}
