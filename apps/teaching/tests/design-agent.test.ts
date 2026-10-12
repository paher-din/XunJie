import type { Transaction } from '../server/db/transaction.ts';
import { TeacherResultCommitError } from '../server/design/teacher-agent.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTeacherDesignDatabase, openSyntheticDatabase } from '../server/db/transaction.ts';
import { createPasswordRecord } from '../server/access/password.ts';
import { createDesignApp } from '../server/design/application.ts';
import { SyntheticProvider, createDeepSeekProvider, InputLimitError, type ModelProvider, type ProviderResponse, type SyntheticStep } from '../server/tutoring/providers.ts';
import { realModelEnabled, realModelProbe, writeRealModelEvidence } from '../server/tutoring/test/real-model-support.ts';

const origin = 'https://synthetic.example';
const candidate = { kind: 'candidates', candidates: [{ problem: 'Count words', audience: 'CS beginners',
  artifact: 'A tested C program', routes: ['scan', 'tokenize'], goals: ['Compare two routes'],
  constraints: ['One week'], unresolved: ['Teacher must confirm three competency domains'], resourceRefs: [] }] };
const versions = { modelConfig: 'synthetic-v1', prompt: 'teacher-v1', schema: 'teacher-v1', policy: 'teacher-v1' };
async function fixture(steps: SyntheticStep[] = [{ body: candidate }],suppliedProvider?:ModelProvider,liveClock=false) {
  let db = createTeacherDesignDatabase(), time = Date.now(), generation = 'generation',clockStep = 0;
  const password = randomBytes(32).toString('hex'), secret = randomBytes(48).toString('hex');
  const record = await createPasswordRecord(password);
  db.withTransaction(tx => {
    for (const user of ['teacher', 'student', 'foreign', 'colleague'])
      tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES (?,?,?,?,?,?,?,?,?)',
        user,user,record.hash,record.salt,'scrypt',131072,8,1,64);
    for (const course of ['course','foreign-course']) tx.run('INSERT INTO courses(id) VALUES (?)',course);
    for (const [course,user,role] of [['course','teacher','teacher'],['course','student','student'],
      ['course','colleague','teacher'],['foreign-course','foreign','teacher']])
      tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,1)',course!,user!,role!);
  });
  const provider = suppliedProvider ?? new SyntheticProvider(steps);
  let budget = true;
  let failResultWrite = false;
  const database = () => ({...db,withTransaction<T>(work:(tx:Transaction)=>T):T {
    return db.withTransaction(tx => work({...tx,run(sql,...params) {
      if (failResultWrite && sql.startsWith('INSERT INTO teacher_design_proposals')) {
        failResultWrite = false; throw new Error('Synthetic commit failure');
      }
      return tx.run(sql,...params);
    }}));
  }});
  const options = () => ({ db:database(), origin, signingSecret: secret, currentGeneration: () => generation, now: () => { if (liveClock) return Date.now(); const current=time; time+=clockStep; return current; },
    teacherAgent: { provider, versions: liveClock ? { ...versions, modelConfig: 'deepseek-flash-p2-real-v1' } : versions, budgetAvailable: () => budget } });
  let service = await createDesignApp(options());
  async function login(user = 'teacher') {
    const res = await service.app.inject({ method:'POST',url:'/api/sessions',headers:{origin},payload:{loginName:user,password} });
    assert.equal(res.statusCode,200);
    return { origin,cookie:res.cookies.filter(c => c.value).map(c => c.name+'='+encodeURIComponent(c.value)).join('; '),
      'x-csrf-token':res.json().data.csrfToken as string };
  }
  return { login,provider,
    tickingClock() { clockStep = 1; },
    failResult() { failResultWrite = true; },
    revokeTeacher() { db.withTransaction(tx => tx.run("UPDATE course_memberships SET active=0 WHERE course_id='course' AND user_id='teacher'")); },get service() { return service; },get db() { return db; },generation: () => generation,
    advance(ms:number) { time += ms; },restore() { generation = 'new-generation'; },noBudget() { budget = false; },
    async reopen() { const file = db.file; await service.app.close(); db.close(); db = openSyntheticDatabase(file); service = await createDesignApp(options()); },
    async close() { await service.app.close(); db.close(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Headers = Awaited<ReturnType<Fixture['login']>>;
function command(f:Fixture,headers:Headers,url:string,payload:object,key:string = randomUUID(),method:'POST'|'PATCH'='POST') {
  return f.service.app.inject({method,url,headers:{...headers,'idempotency-key':key},payload:{recoveryGeneration:f.generation(),...payload}});
}
async function start(f:Fixture,headers:Headers,payload:object={},key:string = randomUUID()) {
  return command(f,headers,'/api/courses/course/blueprints',{mode:'agent',generationMode:'candidates',request:'Design a small C project',references:[],...payload},key);
}
async function getJob(f:Fixture,headers:Headers,id:string) {
  const res = await f.service.app.inject({url:'/api/jobs/'+id,headers}); assert.equal(res.statusCode,200); return res.json().data;
}
test('teacher selects an asynchronous candidate and the editable draft survives reopening',async () => {
  const f = await fixture();
  try {
    const headers = await f.login(), accepted = await start(f,headers);
    assert.equal(accepted.statusCode,200);
    const jobId = accepted.json().data.result.jobId;
    assert.equal((await getJob(f,headers,jobId)).status,'queued');
    await f.service.teacherAgent!.processJob(jobId);
    const job = await getJob(f,headers,jobId);
    assert.equal(job.status,'succeeded'); assert.equal(job.attemptCount,1);
    const proposal = await f.service.app.inject({url:'/api/design-proposals/'+job.proposalId,headers});
    assert.equal(proposal.statusCode,200); assert.equal(proposal.json().data.body.candidates.length,1);
    assert.deepEqual(proposal.json().data.body.candidates[0].unresolved,['Teacher must confirm three competency domains']);
    const adopted = await command(f,headers,'/api/design-proposals/'+job.proposalId+'/adopt',{candidateIndex:0,content:{projectTitle:'TextScope'}});
    assert.equal(adopted.statusCode,200);
    const draft = adopted.json().data.result.draft;
    assert.equal(draft.revision,1); assert.equal(draft.content.problem,'Count words');
    assert.deepEqual(draft.content.goals,[]);
    await f.reopen();
    const read = await f.service.app.inject({url:'/api/blueprints/'+draft.blueprintId,headers});
    assert.equal(read.statusCode,200); assert.equal(read.json().data.content.projectTitle,'TextScope');
    assert.equal((await getJob(f,headers,jobId)).proposalId,job.proposalId);
  } finally { await f.close(); }
});

const patchBody = { kind:'patch',changes:[{field:'problem',value:'Compare counting algorithms'}],rationale:'Preserve two solution routes',
  resourceRefs:[],affectedLinks:['problem → comparison task'],unresolved:[] };
async function manualDraft(f:Fixture,headers:Headers) {
  const res = await command(f,headers,'/api/courses/course/blueprints',{mode:'manual',content:{problem:'Original problem'}});
  assert.equal(res.statusCode,200); return res.json().data.result.draft;
}
async function propose(f:Fixture,headers:Headers,draft:{blueprintId:string;revision:number},extra:object={}) {
  const res = await command(f,headers,'/api/blueprints/'+draft.blueprintId+'/proposals',
    {expectedRevision:draft.revision,mode:'patch',request:'Improve only the problem',references:[],allowedFields:['problem'],...extra});
  assert.equal(res.statusCode,200); return res.json().data.result.jobId as string;
}
test('local proposal saves its original diff and adoption uses the existing PATCH CAS',async () => {
  const f = await fixture([{body:patchBody}]);
  try {
    const headers = await f.login(),draft = await manualDraft(f,headers),jobId = await propose(f,headers,draft);
    await f.service.teacherAgent!.processJob(jobId);
    const job = await getJob(f,headers,jobId);
    const proposal = (await f.service.app.inject({url:'/api/design-proposals/'+job.proposalId,headers})).json().data;
    assert.equal(proposal.baseRevision,1);
    assert.deepEqual(proposal.diff,[{path:'problem',before:'Original problem',after:'Compare counting algorithms'}]);
    assert.equal(proposal.rationale,'Preserve two solution routes');
    const payload = {expectedRevision:1,proposalId:job.proposalId,patch:{problem:'Compare counting algorithms'}};
    const key = 'adopt-local';
    const adopted = await command(f,headers,'/api/blueprints/'+draft.blueprintId,payload,key,'PATCH');
    assert.equal(adopted.statusCode,200);
    assert.equal(adopted.json().data.result.draft.revision,2);
    const replay = await command(f,headers,'/api/blueprints/'+draft.blueprintId,payload,key,'PATCH');
    assert.equal(replay.statusCode,200); assert.deepEqual(replay.json().data,adopted.json().data);
    assert.equal((await f.service.app.inject({url:'/api/design-proposals/'+job.proposalId,headers})).json().data.applicable,false);
  } finally { await f.close(); }
});

async function material(f:Fixture,headers:Headers,allowed=true,kind:'learning_material'|'private_answer'|'validation_asset'='learning_material') {
  const res = await command(f,headers,'/api/courses/course/resources',{teacherDesignAllowed:allowed,
    material:{format:'txt',kind,title:'Teacher approved sample',content:kind === 'private_answer' ? 'PRIVATE_SAMPLE' : 'Teacher synthetic sample',
      visibility:{student:kind === 'learning_material',tutor:kind === 'learning_material'}}});
  assert.equal(res.statusCode,200); return res.json().data.result.resourceVersion;
}
test('teacher-approved private sample supports rubric trial and only explicit rubric PATCH revises it',async () => {
  const f = await fixture([request => {
    const refs = (request.untrustedInput as {references:{id:string;content:string}[]}).references;
    assert.equal(refs[0]!.content,'PRIVATE_SAMPLE');
    return {body:{kind:'rubric_trial',criterionComments:['Evidence missing in this sample'],ambiguities:['What is a correct explanation?'],
      suggestedChanges:['Require comparison evidence'],sampleRefs:[refs[0]!.id],unresolved:['Teacher judgement required']}};
  }]);
  try {
    const headers = await f.login(),draft = await manualDraft(f,headers),sample = await material(f,headers,true,'private_answer');
    const paragraph = sample.material.paragraphs[0],reference = {resourceVersionId:sample.resourceVersionId,paragraphId:paragraph.paragraphId,contentHash:paragraph.contentHash};
    const res = await command(f,headers,'/api/blueprints/'+draft.blueprintId+'/rubric-trials',
      {expectedRevision:1,request:'Try this rubric on the approved sample',references:[reference],sampleReferenceIds:[paragraph.paragraphId]});
    assert.equal(res.statusCode,200); const jobId = res.json().data.result.jobId;
    await f.service.teacherAgent!.processJob(jobId);
    const job = await getJob(f,headers,jobId),proposal = (await f.service.app.inject({url:'/api/design-proposals/'+job.proposalId,headers})).json().data;
    assert.deepEqual(proposal.body.ambiguities,['What is a correct explanation?']);
    assert.equal((await f.service.app.inject({url:'/api/blueprints/'+draft.blueprintId,headers})).json().data.revision,1);
    const student = await f.login('student');
    assert.equal((await f.service.app.inject({url:'/api/design-proposals/'+job.proposalId,headers:student})).statusCode,403);
    const rubricCriteria = [{criterionId:'comparison',description:'Compare routes with evidence',goalRefs:[],observationIds:[]}];
    const adopted = await command(f,headers,'/api/blueprints/'+draft.blueprintId,{expectedRevision:1,proposalId:job.proposalId,patch:{rubricCriteria}},'rubric-adopt','PATCH');
    assert.equal(adopted.statusCode,200); assert.deepEqual(adopted.json().data.result.draft.content.rubricCriteria,rubricCriteria);
  } finally { await f.close(); }
});

function gate(response:ProviderResponse = {body:patchBody}) {
  let entered!:()=>void,release!:()=>void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  return {started,release,step:async () => { entered(); await waiting; return response; }};
}
test('editing during generation preserves the manual revision and rejects the old result',async () => {
  const g = gate(),f = await fixture([g.step]);
  try {
    const headers = await f.login(),draft = await manualDraft(f,headers),jobId = await propose(f,headers,draft);
    const pending = f.service.teacherAgent!.processJob(jobId); await g.started;
    const edited = await command(f,headers,'/api/blueprints/'+draft.blueprintId,{expectedRevision:1,patch:{problem:'Manual teacher edit'}},'manual-edit','PATCH');
    assert.equal(edited.statusCode,200); g.release(); await pending;
    const job = await getJob(f,headers,jobId); assert.equal(job.status,'stale'); assert.equal(job.proposalId,undefined);
    assert.equal((await f.service.app.inject({url:'/api/blueprints/'+draft.blueprintId,headers})).json().data.content.problem,'Manual teacher edit');
  } finally { g.release(); await f.close(); }
});
test('original request and result replay survive edits, while conflicting keys or result bodies are refused',async () => {
  const f = await fixture([{body:patchBody}]);
  try {
    const headers = await f.login(),draft = await manualDraft(f,headers);
    const payload = {expectedRevision:1,mode:'patch',request:'Improve only the problem',references:[],allowedFields:['problem']};
    const url = '/api/blueprints/'+draft.blueprintId+'/proposals';
    const accepted = await command(f,headers,url,payload,'original-key');
    assert.equal(accepted.statusCode,200);
    const jobId = accepted.json().data.result.jobId,completed = await f.service.teacherAgent!.processJob(jobId);
    assert.ok(completed?.delivery.outcome.outcome === 'success');
    const original = completed.result;
    assert.deepEqual(f.service.teacherAgent!.receiveResult(completed.delivery),original);
    await command(f,headers,'/api/blueprints/'+draft.blueprintId,{expectedRevision:1,patch:{problem:'Manual edit'}},'edit-after','PATCH');
    const replay = await command(f,headers,url,payload,'original-key'); assert.equal(replay.statusCode,200);
    assert.deepEqual(replay.json().data,accepted.json().data);
    assert.equal((await command(f,headers,url,{...payload,request:'Other request'},'original-key')).statusCode,409);
    const proposal = (await f.service.app.inject({url:'/api/design-proposals/'+original!.proposalId,headers})).json().data;
    assert.equal(proposal.applicable,false);
    assert.equal((await command(f,headers,'/api/blueprints/'+draft.blueprintId,{expectedRevision:2,proposalId:original!.proposalId,patch:{problem:'Old AI edit'}},'old-adopt','PATCH')).statusCode,409);
    const changed = structuredClone(completed.delivery);
    if (changed.outcome.outcome === 'success' && changed.outcome.body.kind === 'patch') {
      changed.outcome.body.rationale = 'Different immutable result';
      changed.bodyJson = JSON.stringify(changed.outcome.body);
    }
    assert.throws(() => f.service.teacherAgent!.receiveResult(changed),{code:'IDEMPOTENCY_CONFLICT'});
  } finally { await f.close(); }
});
test('durable cancellation promptly ends a pending round and a late result cannot create a proposal',async () => {
  let entered!:()=>void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture([() => { entered(); return new Promise(() => {}); }]);
  try {
    const headers = await f.login(),accepted = await start(f,headers),jobId = accepted.json().data.result.jobId;
    const pending = f.service.teacherAgent!.processJob(jobId); await started;
    const cancelled = await command(f,headers,'/api/jobs/'+jobId+'/cancel',{},'stop');
    assert.equal(cancelled.statusCode,200);
    const completed = await Promise.race([pending,new Promise<never>((_,reject) => { const timer=setTimeout(() => reject(new Error('Cancellation did not settle')),1500); timer.unref(); })]);
    assert.equal(completed?.delivery.outcome.outcome,'cancelled');
    const job = await getJob(f,headers,jobId);
    assert.equal(job.status,'cancelled'); assert.equal(job.stopRequested,true); assert.equal(job.proposalId,undefined);
    await f.reopen(); assert.equal((await getJob(f,headers,jobId)).stopRequested,true);
  } finally { await f.close(); }
});

test('teacher job ownership, role and course checks reject students, other teachers and forged identity',async () => {
  const f = await fixture();
  try {
    const headers = await f.login(),accepted = await start(f,headers),jobId = accepted.json().data.result.jobId;
    for (const user of ['student','colleague','foreign']) {
      const other = await f.login(user);
      assert.equal((await f.service.app.inject({url:'/api/jobs/'+jobId,headers:other})).statusCode,403);
      assert.equal((await command(f,other,'/api/jobs/'+jobId+'/cancel',{})).statusCode,403);
    }
    assert.equal((await start(f,headers,{role:'teacher',studentId:'student'})).statusCode,400);
    assert.equal((await start(f,await f.login('student'))).statusCode,403);
    const first = await start(f,headers,{},'request-replay');
    assert.equal(first.statusCode,200);
    const replay = await start(f,headers,{},'request-replay'); assert.deepEqual(replay.json().data,first.json().data);
    assert.equal((await start(f,headers,{request:'Changed input'},'request-replay')).statusCode,409);
  } finally { await f.close(); }
});
test('only explicitly approved course paragraphs and matching hashes enter generation or rubric trials',async () => {
  const f = await fixture();
  try {
    const headers = await f.login(),draft = await manualDraft(f,headers),resource = await material(f,headers,false);
    const paragraph = resource.material.paragraphs[0],reference = {resourceVersionId:resource.resourceVersionId,paragraphId:paragraph.paragraphId,contentHash:paragraph.contentHash};
    assert.equal((await start(f,headers,{references:[reference]})).statusCode,422);
    const approved = await material(f,headers,true),p = approved.material.paragraphs[0];
    const good = {resourceVersionId:approved.resourceVersionId,paragraphId:p.paragraphId,contentHash:p.contentHash};
    assert.equal((await start(f,headers,{references:[{...good,contentHash:'0'.repeat(64)}]})).statusCode,422);
    assert.equal((await start(f,headers,{references:[{...good,paragraphId:'unknown'}]})).statusCode,422);
    const foreign = await f.login('foreign');
    const foreignMaterial = await command(f,foreign,'/api/courses/foreign-course/resources',
      {teacherDesignAllowed:true,material:{format:'txt',title:'Foreign',content:'Foreign material'}});
    assert.equal(foreignMaterial.statusCode,200);
    const fm = foreignMaterial.json().data.result.resourceVersion,fp = fm.material.paragraphs[0];
    assert.equal((await start(f,headers,{references:[{resourceVersionId:fm.resourceVersionId,paragraphId:fp.paragraphId,contentHash:fp.contentHash}]})).statusCode,403);
    const trial = {expectedRevision:1,request:'Trial',references:[good],sampleReferenceIds:['unknown']};
    assert.equal((await command(f,headers,'/api/blueprints/'+draft.blueprintId+'/rubric-trials',trial)).statusCode,422);
    assert.equal((await command(f,headers,'/api/blueprints/'+draft.blueprintId+'/rubric-trials',{...trial,sampleReferenceIds:[]})).statusCode,400);
  } finally { await f.close(); }
});
test('a model cannot expand requested fields or smuggle unapproved resources through patch values',async () => {
  for (const change of [{field:'artifact',value:'Unrequested artifact'},{field:'resources',value:[{resourceVersionId:'unapproved'}]}]) {
    const f = await fixture([{body:{...patchBody,changes:[change]}}]);
    try {
      const headers = await f.login(),draft = await manualDraft(f,headers),jobId = await propose(f,headers,draft,{allowedFields:change.field === 'resources' ? ['resources'] : ['problem']});
      await f.service.teacherAgent!.processJob(jobId);
      const job = await getJob(f,headers,jobId);
      assert.equal(job.status,'failed'); assert.equal(job.proposalId,undefined);
      assert.equal((await f.service.app.inject({url:'/api/blueprints/'+draft.blueprintId,headers})).json().data.revision,1);
    } finally { await f.close(); }
  }
});

test('a fresh blueprint proposal retains unresolved structure and teacher confirmation forms a draft',async () => {
  const body = {kind:'blueprint',problem:'Word statistics',audience:'First-year CS',artifact:'TextScope',routes:['scan','tokenize'],
    goals:['Domain: explain arrays','Project: compare routes','AI: verify suggestions'],milestones:['Core','Report'],resources:[],
    helpPolicy:'Hints first',checkpoints:['Compare test evidence'],rubric:['Explain a tradeoff'],goalEvidenceLinks:['Comparison → report'],unresolved:['Teacher must define versioned references']};
  const f = await fixture([{body}]);
  try {
    const headers = await f.login(),res = await start(f,headers,{generationMode:'blueprint'});
    assert.equal(res.statusCode,200); const jobId = res.json().data.result.jobId;
    await f.service.teacherAgent!.processJob(jobId);
    const job = await getJob(f,headers,jobId),proposal = (await f.service.app.inject({url:'/api/design-proposals/'+job.proposalId,headers})).json().data;
    assert.equal(proposal.body.goals.length,3); assert.ok(proposal.diff.some((item:{path:string}) => item.path === 'problem'));
    const goals = [{competencyId:'domain',competencyVersion:1,domain:'domain',title:'Explain arrays'},
      {competencyId:'project',competencyVersion:1,domain:'project',title:'Compare routes'},
      {competencyId:'ai',competencyVersion:1,domain:'ai_collaboration',title:'Verify suggestions'}];
    const adopted = await command(f,headers,'/api/design-proposals/'+job.proposalId+'/adopt',{content:{projectTitle:'TextScope',goals}});
    assert.equal(adopted.statusCode,200); assert.equal(adopted.json().data.result.draft.content.goals.length,3);
    const id = adopted.json().data.result.draft.blueprintId;
    const preview = await f.service.app.inject({url:'/api/blueprints/'+id+'/previews',headers});
    assert.equal(preview.statusCode,200); assert.equal(preview.json().data.content.goals.length,3);
  } finally { await f.close(); }
});
test('three reserved calls and unknown usage remain durable and manual creation works after budget denial',async () => {
  const f = await fixture([{body:candidate,needsAnotherCall:true,usage:{status:'actual',inputTokens:10,outputTokens:4}},
    {body:candidate,needsAnotherCall:true},{body:candidate,needsAnotherCall:true}]);
  try {
    const headers = await f.login(),res = await start(f,headers),jobId = res.json().data.result.jobId;
    await f.service.teacherAgent!.processJob(jobId);
    const job = await getJob(f,headers,jobId); assert.equal(job.status,'failed'); assert.equal(job.attemptCount,3);
    assert.deepEqual(job.usages,[{status:'actual',inputTokens:10,outputTokens:4},{status:'unknown'},{status:'unknown'}]);
    await f.reopen(); await f.service.teacherAgent!.processJob(jobId);
    assert.equal((await getJob(f,headers,jobId)).attemptCount,3);
    f.noBudget(); assert.equal((await start(f,headers)).statusCode,429);
    assert.equal((await command(f,headers,'/api/courses/course/blueprints',{mode:'manual',content:{problem:'Manual'}})).statusCode,200);
  } finally { await f.close(); }
});
test('queueing counts toward the 45-second deadline and expired jobs cannot generate',async () => {
  const f = await fixture();
  try {
    const headers = await f.login(),res = await start(f,headers),jobId = res.json().data.result.jobId;
    f.advance(45001); await f.service.teacherAgent!.processJob(jobId);
    const job = await getJob(f,headers,jobId);
    assert.equal(job.status,'timed_out'); assert.equal(job.attemptCount,0); assert.equal(job.proposalId,undefined);
  } finally { await f.close(); }
});
test('concurrent workers cannot claim the same round and an expired original lease is not retried',async () => {
  const g = gate(),f = await fixture([g.step]);
  try {
    const headers = await f.login(),draft = await manualDraft(f,headers),jobId = await propose(f,headers,draft);
    const pending = f.service.teacherAgent!.processJob(jobId); await g.started;
    assert.equal(await f.service.teacherAgent!.processJob(jobId),undefined);
    assert.equal((await getJob(f,headers,jobId)).attemptCount,1);
    f.advance(45001); await f.service.teacherAgent!.processJob(jobId);
    const unknown = await getJob(f,headers,jobId); assert.equal(unknown.status,'outcome_unknown'); assert.equal(unknown.attemptCount,1);
    g.release(); await assert.rejects(pending,{code:'STATE_CONFLICT'});
    const final = await getJob(f,headers,jobId); assert.equal(final.status,'outcome_unknown'); assert.equal(final.proposalId,undefined);
  } finally { g.release(); await f.close(); }
});
test('restored recovery generation refuses an old round before another model call',async () => {
  const f = await fixture();
  try {
    const headers = await f.login(),res = await start(f,headers),jobId = res.json().data.result.jobId;
    f.restore(); await assert.rejects(f.service.teacherAgent!.processJob(jobId),{code:'RECOVERY_REQUIRED'});
    assert.equal((await f.service.app.inject({url:'/api/jobs/'+jobId,headers})).statusCode,409);
    assert.equal((await command(f,headers,'/api/jobs/'+jobId+'/cancel',{recoveryGeneration:'generation'})).statusCode,409);
  } finally { await f.close(); }
});


test('result commit failure rolls back and the original delivery can be retried without another generation',async () => {
  const f = await fixture();
  try {
    const headers = await f.login(),accepted = await start(f,headers),jobId = accepted.json().data.result.jobId;
    f.failResult();
    let delivery;
    try { await f.service.teacherAgent!.processJob(jobId); assert.fail('Persistence failure was not reported'); }
    catch (error) { assert.ok(error instanceof TeacherResultCommitError); delivery = error.delivery; }
    const rolledBack = await getJob(f,headers,jobId);
    assert.equal(rolledBack.status,'running'); assert.equal(rolledBack.proposalId,undefined); assert.equal(rolledBack.attemptCount,1);
    const saved = f.service.teacherAgent!.receiveResult(delivery!);
    assert.ok(saved?.proposalId); assert.equal((await getJob(f,headers,jobId)).status,'succeeded');
    await f.reopen(); assert.equal((await getJob(f,headers,jobId)).proposalId,saved!.proposalId);
  } finally { await f.close(); }
});
test('revoked teacher access invalidates an in-flight result and stops read or receipt replay',async () => {
  const g = gate(),f = await fixture([g.step]);
  try {
    const headers = await f.login(),draft = await manualDraft(f,headers),jobId = await propose(f,headers,draft);
    const pending = f.service.teacherAgent!.processJob(jobId); await g.started;
    f.revokeTeacher(); g.release(); await pending;
    assert.equal((await f.service.app.inject({url:'/api/jobs/'+jobId,headers})).statusCode,403);
    assert.equal((await command(f,headers,'/api/jobs/'+jobId+'/cancel',{})).statusCode,403);
  } finally { g.release(); await f.close(); }
});
test('durable call reservations stop additional paid attempts when the trusted budget is withdrawn',async () => {
  let f!:Fixture;
  f = await fixture([() => { f.noBudget(); return {body:candidate,needsAnotherCall:true}; }]);
  try {
    const headers = await f.login(),accepted = await start(f,headers),jobId = accepted.json().data.result.jobId;
    await f.service.teacherAgent!.processJob(jobId);
    const job = await getJob(f,headers,jobId);
    assert.equal(job.status,'failed'); assert.equal(job.failure,'BUDGET_EXHAUSTED'); assert.equal(job.attemptCount,1);
    assert.deepEqual(job.usages,[{status:'unknown'}]);
  } finally { await f.close(); }
});
test('provider failure with missing usage keeps unknown reservations and does not affect manual edits',async () => {
  const f = await fixture([new Error('Synthetic provider unavailable')]);
  try {
    const headers = await f.login(),draft = await manualDraft(f,headers),jobId = await propose(f,headers,draft);
    await f.service.teacherAgent!.processJob(jobId);
    const job = await getJob(f,headers,jobId);
    assert.equal(job.status,'failed'); assert.deepEqual(job.usages,[{status:'unknown'}]);
    const res = await command(f,headers,'/api/blueprints/'+draft.blueprintId,{expectedRevision:1,patch:{problem:'Manual fallback'}},'manual-fallback','PATCH');
    assert.equal(res.statusCode,200);
  } finally { await f.close(); }
});


test('a ticking service clock keeps the accepted job window exactly 45 seconds',async () => {
  const f = await fixture();
  try {
    const headers = await f.login(); f.tickingClock();
    const accepted = await start(f,headers); assert.equal(accepted.statusCode,200);
    const job = await getJob(f,headers,accepted.json().data.result.jobId);
    assert.equal(Date.parse(job.deadline)-Date.parse(job.acceptedAt),45000);
  } finally { await f.close(); }
});
test('proposal result hash identifies the exact stored B body bytes and altered bytes conflict',async () => {
  const f = await fixture();
  try {
    const headers = await f.login(),accepted = await start(f,headers),jobId = accepted.json().data.result.jobId;
    const completed = await f.service.teacherAgent!.processJob(jobId);
    assert.ok(completed);
    const expectedJson = '{"kind":"candidates","candidates":[{"problem":"Count words","audience":"CS beginners","artifact":"A tested C program","routes":["scan","tokenize"],"goals":["Compare two routes"],"constraints":["One week"],"unresolved":["Teacher must confirm three competency domains"],"resourceRefs":[]}]}';
    assert.equal(completed.delivery.bodyJson,expectedJson);
    const job = await getJob(f,headers,jobId);
    assert.equal(job.resultHash,'59def8d4fc025c3596cf4865b2e534bb8419392294a9ac7a11029daa83b18f80');
    const altered = {...completed.delivery,bodyJson:expectedJson+'\n'};
    assert.throws(() => f.service.teacherAgent!.receiveResult(altered),{code:'IDEMPOTENCY_CONFLICT'});
    await f.reopen(); assert.equal((await getJob(f,headers,jobId)).resultHash,job.resultHash);
  } finally { await f.close(); }
});

test('actual usage returned after the deadline survives reopening without accepting the late body',async () => {
  let f!:Fixture;
  f = await fixture([() => { f.advance(45001); return {body:candidate,usage:{status:'actual',inputTokens:10,outputTokens:4}}; }]);
  try {
    const headers = await f.login(),accepted = await start(f,headers),jobId = accepted.json().data.result.jobId;
    const completed = await f.service.teacherAgent!.processJob(jobId);
    assert.equal(completed?.delivery.outcome.outcome,'timed_out');
    const job = await getJob(f,headers,jobId);
    assert.equal(job.status,'timed_out'); assert.equal(job.attemptCount,1); assert.equal(job.proposalId,undefined);
    assert.deepEqual(job.usages,[{status:'actual',inputTokens:10,outputTokens:4}]);
    await f.reopen(); assert.deepEqual((await getJob(f,headers,jobId)).usages,job.usages);
  } finally { await f.close(); }
});

test('input preflight rejection records zero outbound calls and no billable reservation',async () => {
  let outbound = 0;
  let rejectedInputTokens = 0;
  const bounded = createDeepSeekProvider({invoke:async () => { outbound++; return {body:candidate}; }});
  const provider:ModelProvider = {generate:async request => {
    try { return await bounded.generate(request); }
    catch (error) { if (error instanceof InputLimitError) rejectedInputTokens = error.inputTokens; throw error; }
  }};
  const f = await fixture([],provider);
  try {
    const headers = await f.login(),accepted = await start(f,headers,{request:'资料'.repeat(10000)}),jobId = accepted.json().data.result.jobId;
    const completed = await f.service.teacherAgent!.processJob(jobId);
    assert.ok(rejectedInputTokens > 16000);
    assert.equal(completed?.delivery.outcome.outcome,'needs_input');
    assert.equal(completed?.delivery.outcome.calls,0); assert.equal(outbound,0);
    const job = await getJob(f,headers,jobId);
    assert.equal(job.status,'failed'); assert.equal(job.failure,'INPUT_LIMIT_EXCEEDED');
    assert.equal(job.attemptCount,0); assert.deepEqual(job.usages,[]); assert.equal(job.proposalId,undefined);
    await f.reopen(); assert.equal((await getJob(f,headers,jobId)).attemptCount,0);
    assert.deepEqual((await getJob(f,headers,jobId)).usages,[]);
    assert.equal((await command(f,headers,'/api/courses/course/blueprints',{mode:'manual',content:{problem:'Manual after preflight'}})).statusCode,200);
  } finally { await f.close(); }
});

test('late actual usage updates a cancelled job without reviving its result',async () => {
  const g = gate({body:candidate,usage:{status:'actual',inputTokens:10,outputTokens:4}}),f = await fixture([g.step]);
  try {
    const headers = await f.login(),accepted = await start(f,headers),jobId = accepted.json().data.result.jobId;
    const pending = f.service.teacherAgent!.processJob(jobId); await g.started;
    assert.equal((await command(f,headers,'/api/jobs/'+jobId+'/cancel',{},'cancel-before-usage')).statusCode,200);
    const completed = await pending; assert.equal(completed?.delivery.outcome.outcome,'cancelled');
    assert.deepEqual((await getJob(f,headers,jobId)).usages,[{status:'unknown'}]);
    g.release(); await new Promise<void>(resolve => setImmediate(resolve));
    const job = await getJob(f,headers,jobId);
    assert.equal(job.status,'cancelled'); assert.equal(job.stopRequested,true); assert.equal(job.attemptCount,1);
    assert.deepEqual(job.usages,[{status:'actual',inputTokens:10,outputTokens:4}]); assert.equal(job.proposalId,undefined);
    await f.reopen(); assert.deepEqual((await getJob(f,headers,jobId)).usages,job.usages);
    assert.equal(await f.service.teacherAgent!.processJob(jobId),undefined);
  } finally { g.release(); await f.close(); }
});
test('a second call rejected by preflight preserves the first sent call and its actual usage',async () => {
  let preflights = 0,outbound = 0;
  // Script only the external provider boundary: the second request is proven unsent.
  const provider:ModelProvider = {generate:async () => {
    if (++preflights === 2) throw new InputLimitError(16001);
    outbound++;
    return {body:candidate,needsAnotherCall:true,usage:{status:'actual',inputTokens:10,outputTokens:4}};
  }};
  const f = await fixture([],provider);
  try {
    const headers = await f.login(),accepted = await start(f,headers),jobId = accepted.json().data.result.jobId;
    const completed = await f.service.teacherAgent!.processJob(jobId);
    assert.equal(completed?.delivery.outcome.outcome,'needs_input'); assert.equal(completed?.delivery.outcome.calls,1);
    assert.equal(preflights,2); assert.equal(outbound,1); const job = await getJob(f,headers,jobId);
    assert.equal(job.attemptCount,1); assert.deepEqual(job.usages,[{status:'actual',inputTokens:10,outputTokens:4}]);
    assert.equal(job.proposalId,undefined); await f.reopen();
    assert.equal((await getJob(f,headers,jobId)).attemptCount,1);
  } finally { await f.close(); }
});
test('a response from an old recovery generation cannot update accounting or deliver a proposal',async () => {
  const g = gate({body:candidate,usage:{status:'actual',inputTokens:10,outputTokens:4}}),f = await fixture([g.step]);
  try {
    const headers = await f.login(),accepted = await start(f,headers),jobId = accepted.json().data.result.jobId;
    const pending = f.service.teacherAgent!.processJob(jobId); await g.started;
    f.restore(); g.release(); await assert.rejects(pending,{code:'RECOVERY_REQUIRED'});
    assert.equal((await f.service.app.inject({url:'/api/jobs/'+jobId,headers})).statusCode,409);
  } finally { g.release(); await f.close(); }
});

test('P2 real-model teacher generation, explicit adoption and local PATCH', { skip: !realModelEnabled }, async t => {
  const probe = realModelProbe(), f = await fixture([], probe.provider, true);
  const evidence: Record<string, unknown> = {};
  try {
    const headers = await f.login();
    const imported = await command(f, headers, '/api/courses/course/resources', { teacherDesignAllowed: true,
      material: { format: 'txt', title: 'Synthetic TextScope brief', content:
        '合成工程样例：高校C课程，先备函数、数组与指针。学生实现公开ASCII文本的统计和完整词检索，比较数组/链表方案，自行核查边界。仅生成供教师审阅的候选，不提供完整代码，不作正式评价。' } });
    assert.equal(imported.statusCode, 200, imported.body);
    const resource = imported.json().data.result.resourceVersion, paragraph = resource.material.paragraphs[0];
    const references = [{ resourceVersionId: resource.resourceVersionId, paragraphId: paragraph.paragraphId, contentHash: paragraph.contentHash }];
    evidence.input = { material: resource.material, references, request: '据获准资料提出一个小项目候选，关键目标保持待教师确认。' };
    const accepted = await start(f, headers, { references, request: '据获准资料提出一个小项目候选，关键目标保持待教师确认。' });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const generated = await f.service.teacherAgent!.processJob(String(accepted.json().data.result.jobId));
    evidence.generation = generated ? { outcome: generated.delivery.outcome, result: generated.result } : null;
    const job = await getJob(f, headers, String(accepted.json().data.result.jobId));
    evidence.generationJob = job;
    assert.equal(job.status, 'succeeded');
    assert.ok(job.attemptCount >= 1 && job.attemptCount <= 3);
    const proposal = await f.service.app.inject({ url: `/api/design-proposals/${job.proposalId}`, headers });
    assert.equal(proposal.statusCode, 200, proposal.body);
    evidence.proposal = proposal.json().data;
    const adopted = await command(f, headers, `/api/design-proposals/${job.proposalId}/adopt`, { candidateIndex: 0,
      content: { projectTitle: 'Synthetic TextScope' } });
    assert.equal(adopted.statusCode, 200, adopted.body);
    const draft = adopted.json().data.result.draft;
    const localJobId = await propose(f, headers, draft, { references,
      request: '只在problem字段补充一句要求学生自行检查ASCII文本边界，不改变其他字段，不提供完整实现。' });
    const local = await f.service.teacherAgent!.processJob(localJobId);
    evidence.local = local ? { outcome: local.delivery.outcome, result: local.result } : null;
    const localJob = await getJob(f, headers, localJobId);
    evidence.localJob = localJob;
    assert.equal(localJob.status, 'succeeded');
    const localProposal = await f.service.app.inject({ url: `/api/design-proposals/${localJob.proposalId}`, headers });
    assert.equal(localProposal.statusCode, 200, localProposal.body);
    evidence.localProposal = localProposal.json().data;
    const body = localProposal.json().data.body;
    assert.equal(body.kind, 'patch');
    const applied = await command(f, headers, `/api/blueprints/${draft.blueprintId}`, {
      expectedRevision: draft.revision, proposalId: localJob.proposalId,
      patch: Object.fromEntries(body.changes.map((item: { field: string; value: unknown }) => [item.field, item.value])),
    }, 'real-model-local-adopt', 'PATCH');
    assert.equal(applied.statusCode, 200, applied.body);
    evidence.adopted = applied.json().data.result.draft;
    assert.equal(applied.json().data.result.draft.revision, draft.revision + 1);
    assert.ok(probe.http.length <= 6);
  } finally {
    try { t.diagnostic(`Synthetic-data model evidence: ${writeRealModelEvidence('teacher_design', evidence, probe.http)}`); }
    finally { await f.close(); }
  }
});
