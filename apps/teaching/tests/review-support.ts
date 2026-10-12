import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createReviewDatabase, openSyntheticDatabase, type SyntheticDatabase } from '../server/db/transaction.ts';
import { createPasswordRecord } from '../server/access/password.ts';
import { createReviewApp } from '../server/review/application.ts';
import type { RunnerTransport } from '../server/records/runner.ts';
import { ApiError } from '../server/app/errors.ts';
import type { ModelProvider } from '../server/tutoring/providers.ts';
import { syntheticProfile } from '../server/workspace/test-support.ts';

export const origin = 'https://synthetic.example';
export const versions = { modelConfigVersion: 'synthetic-model-v1', promptVersion: 'review-prompt-v1',
  schemaVersion: 'review-schema-v1', analysisVersion: 'synthetic-analysis-v1' };
export async function fixture() {
  let db = createReviewDatabase(), now = Date.now(), generation = 'generation', failure = '', readFailure = '';
  const analysisVersions = {...versions};
  let provider: ModelProvider|undefined,beforeTeachingComplete: (() => void)|undefined,transport: RunnerTransport|undefined;
  const password = randomBytes(32).toString('base64url'), signingSecret = randomBytes(48).toString('hex');
  const record = await createPasswordRecord(password);
  db.withTransaction(tx => {
    for (const id of ['teacher','student','other','foreign']) tx.run(
      'INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES (?,?,?,?,?,?,?,?,?)',
      id,id,record.hash,record.salt,'scrypt',131072,8,1,64);
    for (const id of ['course','foreign-course']) tx.run('INSERT INTO courses(id) VALUES (?)',id);
    for (const [course,user,role] of [['course','teacher','teacher'],['course','student','student'],
      ['course','other','student'],['foreign-course','foreign','teacher']])
      tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,1)',course!,user!,role!);
  });
  const wrapped: SyntheticDatabase = { get file() { return db.file; },get diagnostics() { return db.diagnostics; },close() { db.close(); },
    withTransaction(work) { return db.withTransaction(tx => work({ ...tx,run(sql,...values) {
      if (failure && sql.includes(failure)) throw new Error('Synthetic late transaction failure');
      return tx.run(sql,...values);
    },get(sql,...values) {
      if (readFailure && sql.includes(readFailure)) throw new ApiError('PERSISTENCE_UNAVAILABLE');
      return tx.get(sql,...values);
    },all(sql,...values) {
      if (readFailure && sql.includes(readFailure)) throw new ApiError('PERSISTENCE_UNAVAILABLE');
      return tx.all(sql,...values);
    } })); } };
  const options = () => ({ db: wrapped,origin,signingSecret,now: () => now,currentGeneration: () => generation,
    runner: async (command: Parameters<RunnerTransport>[0]) => {
      if (command.op !== 'readiness') {if (!transport) throw new Error('Synthetic runner unavailable');return transport(command);}
      const fingerprint = { profile: syntheticProfile,sourceHash: 'd'.repeat(64) };
      return { data: { ready: true,...syntheticProfile,recoveryGeneration: generation,fingerprint,
        validation: { passed: true,fingerprintHash: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'),validatedAt: new Date(now).toISOString() } } }; },
    studentHelp: { versions: { modelConfig: versions.modelConfigVersion,prompt: versions.promptVersion,schema: versions.schemaVersion,policy: 'help-v1' },budgetAvailable: () => true },
    review: { versions: analysisVersions } });
  let service = await createReviewApp(options());
  function register() {
    const complete = service.workspace.teaching.completeTeaching!;
    service.workspace.teaching.completeTeaching = (request,attemptId,raw) => {beforeTeachingComplete?.();return complete(request,attemptId,raw);};
    service.app.post('/fixture/execute/:id/:jobId',async request => {
      const p = request.params as {id:string;jobId:string},preparation = {};
      const initial = service.tutoring.authorizeStudentHelp(request,p.id,p.jobId,preparation);
      const externalCurrent = {...initial.current,helpAllowed: initial.activity.helpPolicy.helpAllowed,learnerStateRevision: initial.learnerStateRevision,
        objectAvailable: true,jobStatus: initial.job.status,stopRequested: initial.job.stopRequested};
      const synthetic: ModelProvider = {async generate() {return {body: helpBody(),usage: {status: 'actual',inputTokens: 17,outputTokens: 9}};}};
      return {data: await service.tutoring.executeStudentHelp(request,p.id,p.jobId,preparation,{provider: provider ?? synthetic,
        leaseToken: 'lease-'+p.jobId,now: () => now,readCurrent: () => externalCurrent})};
    });
    service.app.post('/fixture/policy',request => ({ data: service.design.configurePolicy(request,'course',request.body) }));
    service.app.post('/fixture/analysis/:id',request => ({ data: service.review.queueAnalysis(request,(request.params as {id:string}).id,request.body) }));
    service.app.get('/fixture/analysis/:id/:jobId',request => {const p=request.params as {id:string;jobId:string};return { data: service.review.readAnalysis(request,p.id,p.jobId) };});
    service.app.post('/fixture/complete/:id',request => ({data: service.workspace.teaching.completeTeaching!(request,(request.params as {id:string}).id,request.body)}));
    service.app.post('/fixture/prepare/:id/:jobId',request => { const p = request.params as {id:string;jobId:string};
      return {data: service.tutoring.prepareStudentHelp(request,p.id,p.jobId,request.body as Parameters<typeof service.tutoring.prepareStudentHelp>[3])}; });
    service.app.post('/fixture/rule',request => ({ data: service.design.configureRule(request,'course',request.body) }));
  }
  register();
  return { get app() { return service.app; },get review() { return service.review; },get tutoring() { return service.tutoring; },
    get workspace() { return service.workspace; },get db() { return db; },generation: () => generation,timestamp: () => now,
    setTransport(value: RunnerTransport) {transport = value;},profile: syntheticProfile,
    setAnalysisVersion(value: string) {analysisVersions.analysisVersion = value;},
    setProvider(value: ModelProvider) {provider = value;},beforeTeachingComplete(work?: () => void) {beforeTeachingComplete = work;},
    advance(ms: number) { now += ms; },restoreGeneration() { generation = 'generation-after-recovery'; },
    injectFailure(statement: string) { failure = statement; },
    injectReadFailure(statement: string) {readFailure = statement;},
    async login(id = 'student') {
      const response = await service.app.inject({ method: 'POST',url: '/api/sessions',headers: { origin },payload: { loginName: id,password } });
      assert.equal(response.statusCode,200,response.body);
      return { origin,cookie: response.cookies.filter(c => c.value).map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; '),
        'x-csrf-token': String(response.json().data.csrfToken) };
    },
    async reopen() { const file = db.file; await service.app.close();db.close();db = openSyntheticDatabase(file);service = await createReviewApp(options());register(); },
    async close() { await service.app.close();db.close(); } };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export type Headers = Awaited<ReturnType<Fixture['login']>>;
export function command(f: Fixture,headers: Headers,url: string,payload: object,key: string = randomUUID(),method: 'POST'|'PATCH' = 'POST') {
  return f.app.inject({ method,url,headers: { ...headers,'idempotency-key': key },payload: { recoveryGeneration: f.generation(),...payload } });
}

export async function setup(options: {process?: boolean} = {}) {
  const f = await fixture(),student = await f.login(),teacher = await f.login('teacher');
  await f.app.inject({ method: 'POST',url: '/fixture/policy',headers: teacher,payload: { versionId: 'help-v1',helpAllowed: true,
    wholeSolutionAllowed: false,limitedCheckHelpAllowed: false,description: 'Synthetic policy' } });
  await f.app.inject({ method: 'POST',url: '/fixture/rule',headers: teacher,payload: { versionId: 'textscope-core-v1',validatorVersion: 'textscope-validator-v2',
    limitedHelp: true,description: 'Synthetic rule' } });
  const material = await command(f,teacher,'/api/courses/course/resources',{ teacherDesignAllowed: true,
    material: { format: 'txt',title: 'Reading',content: 'ASCII words',visibility: {student: true,tutor: true} } });assert.equal(material.statusCode,200,material.body);
  const privateMaterial = await command(f,teacher,'/api/courses/course/resources',{teacherDesignAllowed: true,
    material: {format: 'txt',title: 'PRIVATE_TITLE',content: 'PRIVATE_BODY',kind: 'private_answer',visibility: {student: false,tutor: false}}});
  assert.equal(privateMaterial.statusCode,200,privateMaterial.body);
  const goals = [{ competencyId: 'k',competencyVersion: 1,domain: 'domain',title: 'Explain pointers' },
    { competencyId: 'p',competencyVersion: 1,domain: 'project',title: 'Compare routes' },
    { competencyId: 'a',competencyVersion: 1,domain: 'ai_collaboration',title: 'Check AI' }];
  const refs = goals.map(({competencyId,competencyVersion}) => ({competencyId,competencyVersion}));
  const draft = await command(f,teacher,'/api/courses/course/blueprints',{ mode: 'manual',content: {
    projectTitle: 'TextScope',problem: 'Explore text',audience: 'Peers',artifact: 'C source',routes: ['array','tree'],goals,
    tasks: [{taskId: 't',title: 'Compare',goalRefs: refs}],observations: [{observationId: 'o',description: 'Explain decisions',goalRefs: refs,taskIds: ['t']}],
    rubricCriteria: [{criterionId: 'r',description: 'Reasoning',goalRefs: refs,observationIds: ['o']}],milestones: [{milestoneId: 'm',title: 'Review',taskIds: ['t']}],
    resources: [material,privateMaterial].map(value => ({resourceVersionId: value.json().data.result.resourceVersion.resourceVersionId})),helpPolicyVersionId: 'help-v1',
    checkRuleVersionId: 'textscope-core-v1',runtimeProfileVersionId: syntheticProfile.runtimeProfileVersion } });assert.equal(draft.statusCode,200,draft.body);
  const blueprintId = draft.json().data.result.draft.blueprintId;
  const check = await command(f,teacher,`/api/blueprints/${blueprintId}/checks`,{expectedRevision: 1});assert.equal(check.statusCode,200,check.body);
  const release = await command(f,teacher,`/api/blueprints/${blueprintId}/releases`,{expectedRevision: 1,confirmed: true});assert.equal(release.statusCode,200,release.body);
  const activityId = release.json().data.result.activityVersionId as string;
  const allocated = await command(f,teacher,`/api/activities/${activityId}/assignments`,{expectedActivityControlRevision: 1,studentIds: ['student']});assert.equal(allocated.statusCode,200,allocated.body);
  const allocationId = allocated.json().data.result.assignments[0].assignmentId as string;
  const opened = await command(f,student,`/api/assignments/${allocationId}/attempts`,{});assert.equal(opened.statusCode,200,opened.body);
  const attemptId = opened.json().data.result.attemptId as string;
  const saved = await command(f,student,`/api/attempts/${attemptId}/sync`,{expectedWorkspaceRevision: 0,clientId: 'page',clientSeq: 1,
    operations: [{kind: 'create',clientFileKey: 'source',path: 'main.c',text: 'int main(void){return 0;}\n'}],...(options.process ? {process: {captureRevision: 0}} : {}) });assert.equal(saved.statusCode,200,saved.body);
  const snapshot = await command(f,student,`/api/attempts/${attemptId}/snapshots`,{expectedWorkspaceRevision: 1});assert.equal(snapshot.statusCode,200,snapshot.body);
  const snapshotId = snapshot.json().data.result.snapshotId as string;
  const state = async () => { const response = await f.app.inject({url: `/api/attempts/${attemptId}/learner-state`,headers: student});
    assert.equal(response.statusCode,200,response.body);return response.json().data; };
  const attempt = async () => { const response = await f.app.inject({url: `/api/attempts/${attemptId}`,headers: student});
    assert.equal(response.statusCode,200,response.body);return response.json().data; };
  const queue = async (inputRefs: object[] = [{kind: 'snapshot',id: snapshotId,attemptId}],extra: object = {},key: string = randomUUID()) => {
    const response = await command(f,student,`/fixture/analysis/${attemptId}`,{expectedAttemptRevision: (await attempt()).attempt.attemptRevision,
      expectedStateRevision: (await state()).learnerStateRevision,purpose: 'explicit_analysis',inputRefs,assistanceRefs: [],coverageRefs: [],...extra},key);
    assert.equal(response.statusCode,200,response.body);return response.json().data.result;
  };
  return {f,student,teacher,attemptId,snapshotId,activityId,allocationId,state,attempt,queue,content: draft.json().data.result.draft.content,material: material.json().data.result.resourceVersion,privateMaterial: privateMaterial.json().data.result.resourceVersion};
}
export function candidate(snapshotId: string,activityVersionId: string,overrides: object = {}) {
  return {kind: 'learner_analysis',claims: [{competencyId: 'k',competencyVersion: 1,domain: 'domain',scope: {kind: 'activity',activityVersionId},
    statement: 'Synthetic candidate: explanation is still needed',state: 'insufficient',assistanceStatus: 'unknown',
    evidenceIds: [snapshotId],counterEvidenceIds: [],unresolved: true,unknown: ['No independent check yet'],...overrides}]};
}

export function helpBody(content = 'Synthetic hint: explain the approach') {
  return {kind: 'student_help',actionType: 'hint',content,rationale: 'Invite the student to explain',expectedStudentAction: 'Explain the approach',
    evidenceIds: [],resourceRefs: [],assistanceContext: 'Unknown assistance',unresolved: ['Missing evidence'],
    policyChecks: {containsWholeSolution: false,writesStudentWork: false,runsCode: false,makesFormalEvaluation: false}};
}

export function syntheticNode(outcome: 'plain_pass'|'forged_check'|'compile_error'|'trusted_check'): RunnerTransport {
  const values = new Map<string,{record: Record<string,unknown>;fact: Record<string,unknown>}>();
  return async command => {
    if (command.op === 'readiness') throw new Error('Readiness is provided by the fixture');
    const id = command.op === 'submit' ? command.submission.identity.runId : command.identity.runId;
    if (command.op === 'submit') {
      const submission = command.submission,identity = submission.identity;
      const record: Record<string,unknown> = {...identity,unitTerminated: true,phases: [{phase: 'execute',exitCode: 0,stdout: 'passed',stderr: ''}]};
      if (outcome === 'compile_error') {record.failureKind = 'compile_error';record.phases = [{phase: 'compile',exitCode: 1,stdout: '',stderr: 'Synthetic compiler failure'}];
        if (submission.mode === 'check') {record.verdict = 'incomplete';record.checkResults = [];} }
      if (outcome === 'forged_check') record.verdict = 'passed';
      if (outcome === 'trusted_check') {
        record.verdict = 'passed';record.checkResults = Array.from({length: 6},(_,caseIndex) => ({runId: id,snapshotId: identity.snapshotId,
          snapshotHash: identity.snapshotHash,inputHash: identity.inputHash,imageDigest: identity.imageDigest,caseIndex,
          source: 'trusted_validator',checkRuleVersion: submission.checkRuleVersion,validatorVersion: 'textscope-validator-v2',verdict: 'passed'}));
      }
      const fact = {identity,state: 'succeeded',reserved: false,stopRequested: false,units: [],pending: [],
        resultRef: 'synthetic-result-'+id,resultHash: createHash('sha256').update(JSON.stringify(record)).digest('hex')};values.set(id,{record,fact});
    }
    return {data: command.op === 'readResult' ? values.get(id)?.record : values.get(id)?.fact ?? null};
  };
}
export async function run(s: Awaited<ReturnType<typeof setup>>,mode: 'run'|'course_check' = 'run') {
  const before = await s.attempt(),file = before.files[0];
  const accepted = await command(s.f,s.student,`/api/attempts/${s.attemptId}/runs`,{expectedAttemptRevision: before.attempt.attemptRevision,
    snapshotId: s.snapshotId,runtimeProfileVersion: s.f.profile.runtimeProfileVersion,entryFileId: file.fileId,
    input: {operation: 'stats',fileIds: [file.fileId]},mode});
  assert.equal(accepted.statusCode,200,accepted.body);const result = accepted.json().data.result;
  await s.f.workspace.processJob(result.jobId);return result;
}
