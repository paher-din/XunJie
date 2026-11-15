import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { chunkChannelMigrationSql } from '@xunjie/storage/chunk-channel';
import { canonicalDigest, operationId as deriveId } from '@xunjie/storage/identity';
import { nativeFixture } from '../packages/storage/test/native-fixture.mjs';
import { agentRuntimeMigrations, validateAgentRuntime } from '@xunjie/agent-runtime';
import { agentServiceMigrations } from '@xunjie/agents/transport/session-storage';
import { createLearningData, learningMigrations } from '@xunjie/learning-space/learning-data';
import { createAgentSessions, validateAgentSessions } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createSessionMaterials } from '@xunjie/learning-space/learning-data/session-materials';
import { createPersonalProjects, personalProjectOperationId, validatePersonalProjects } from '@xunjie/learning-space/learning-data/personal-projects';
import { modelMigrations } from '@xunjie/model-gateway';
import { fixedPdf } from '../apps/server/tests/fixtures/pdf-material.mjs';
import { parseSwitchArguments, switchAgentRuntimeData } from './switch-agent-runtime-data.mjs';

const digest = value => canonicalDigest(value);
/** The published service layout an installed owner really has: runtime 1..8 plus transport as 9. */
const publishedAgentMigrations = [...agentRuntimeMigrations.slice(0, 8),
  { version: 9, name: 'agent-session-transport-v2', sql: chunkChannelMigrationSql }];

test('the switch requires an explicit root and never combines apply with dry-run', () => {
  assert.equal(parseSwitchArguments(['--root', '/environment']).apply, false);
  assert.equal(parseSwitchArguments(['--root', '/environment', '--dry-run']).apply, false);
  assert.equal(parseSwitchArguments(['--root', '/environment', '--apply']).apply, true);
  assert.equal(parseSwitchArguments(['--help']).help, true);
  for (const args of [[], ['--apply'], ['--root', '/environment', '--apply', '--dry-run'], ['--root', '/environment', '--aply']])
    assert.throws(() => parseSwitchArguments(args), /invalid-switch-arguments/);
});

async function fixture(t, { legacyAgent = false } = {}) {
  const pg = await nativeFixture(), handles = [];
  t.after(async () => { try { for (const handle of handles.reverse()) await handle.close(); } finally { await pg.close(); } });
  const root = join(pg.root, 'product'), environmentId = randomUUID(), owners = {};
  await mkdir(join(root, 'credentials'), { recursive: true });
  async function open(kind, migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations });
    const unit = { agent: 'teaching-agent', learning: 'learning-data', model: 'model-connection' }[kind];
    const backend = createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) });
    const storage = await openStorage({ binding, backend, migrations }); handles.push(storage);
    owners[kind] = { binding, backend, storage }; return storage;
  }
  const agent = await open('agent', legacyAgent ? publishedAgentMigrations : agentServiceMigrations);
  const learning = await open('learning', learningMigrations), model = await open('model', modelMigrations);
  const identity = { environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '切换学生' };
  const data = createLearningData(learning, { resolveBinding: async () => ({ ...owners.learning.binding.owner, version: 1 }) });
  const sessions = createAgentSessions(learning, { authorize: async () => {}, openActivity: data.open,
    resolveOwner: async () => ({ version: 1, connectionId: randomUUID(), installationId: randomUUID(),
      target: { environmentId, serviceId: owners.agent.binding.owner.serviceId, unit: 'teaching-agent', endpoint: 'https://agent.example.test', protocolVersion: 1, capabilities: [] } }) });
  const materials = createSessionMaterials(learning, { openScope: (actor, scope) => scope.kind === 'session'
    ? sessions.read(actor, scope.sessionId) : data.open(actor, scope.activityId) });
  const projects = createPersonalProjects(learning, { authorize: async () => {}, learning: data });
  const home = await sessions.create(identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  const scope = { kind: 'session', sessionId: home.sessionId };
  const operationId = randomUUID(), inputId = randomUUID(), responseId = randomUUID();
  const project = await projects.create(identity, { operationId, sourceSessionId: home.sessionId, inputId, responseId,
    content: { title: '保留的项目', goal: '保留业务回执', stages: [{ title: '实践', goal: '验证原件' }], materialRefs: [] } });
  const workspace = await sessions.create(identity, { requestId: randomUUID(), sessionId: project.workspaceSessionId,
    scenario: 'workspace-assistant', workspace: { activityId: project.activityId, target: project.target } });
  const sourceText = await materials.personal.receive(identity, scope, { requestId: randomUUID(), materialId: randomUUID(), name: 'notes.md',
    mediaType: 'text/markdown', dataBase64: Buffer.from('切换后仍可读取的原件：37 V').toString('base64') });
  const sourcePdf = await materials.pdf.upload(identity, scope, { requestId: randomUUID(), documentId: randomUUID(), name: 'source.pdf',
    dataBase64: fixedPdf().toString('base64') });
  const adoptedText = await materials.adopt(identity, project.activityId, { requestId: randomUUID(), kind: 'personal-material', materialId: randomUUID(),
    source: { scope, materialId: sourceText.materialId, version: 1, sha256: sourceText.versions[0].sha256 } });
  const adoptedPdf = await materials.adopt(identity, project.activityId, { requestId: randomUUID(), kind: 'pdf', documentId: randomUUID(),
    source: { scope, documentId: sourcePdf.documentId, sha256: sourcePdf.sha256 } });
  const workspaceReading = await materials.pdf.read(identity, project.activityId, { requestId: randomUUID(), documentId: adoptedPdf.documentId, pages: [2], region: null });

  // The published transport is part of the installed layout, so its tables really carry data.
  if (legacyAgent) {
    const transferId = randomUUID();
    await agent.request({ requestId: randomUUID(), fingerprint: 'published-transport' }, async tx => {
      await tx.query(`INSERT INTO agent_chunk_transfers(source_key,transfer_id,input_bytes,input_sha,state,reserved_bytes)
        VALUES('published',$1,4,$2,'completed',4)`, [transferId, digest('chunk')]);
      await tx.query(`INSERT INTO agent_chunk_parts(source_key,transfer_id,direction,part_index,byte_length,sha256)
        VALUES('published',$1,'input',0,4,$2)`, [transferId, digest('part')]);
      return null;
    });
  }

  // Runtime history under the original Session identities, including a pending wake and a pending cancellation.
  const turnId = deriveId('agent-turn:' + inputId), stepId = deriveId('agent-step:' + turnId + ':1'), attemptId = randomUUID();
  const toolCallId = randomUUID(), questionId = randomUUID(), notificationId = deriveId('agent-notification:task-1:v1'), eventId = randomUUID();
  const input = { requestId: inputId, sessionId: home.sessionId, text: '旧聊天原文', context: {} };
  const progressEventId = deriveId('agent-progress:' + attemptId + ':1');
  const keptSegment = randomUUID(), droppedSegment = randomUUID(), keptAttempt = randomUUID(), droppedAttempt = randomUUID();
  if (!legacyAgent) {
  await agent.request({ requestId: randomUUID(), fingerprint: 'fixture-runtime' }, async tx => {
    for (const session of [home, workspace]) await tx.query(`INSERT INTO agent_runtime_sessions(session_id,body,state,next_seq)
      VALUES($1,$2,'{}',3)`, [session.sessionId, { sessionId: session.sessionId, identity, scenario: session.scenario, createdAt: session.createdAt }]);
    await tx.query(`INSERT INTO agent_turns(turn_id,session_id,request_id,trigger,state,reason,owner_instance_id,budget,completed_at)
      VALUES($1,$2,$3,'user','completed','fixture','fixture-host',$4,clock_timestamp())`,
      [turnId, home.sessionId, inputId, { maxSteps: 16, maxToolCalls: 64, maxInputTokens: 1048576, maxOutputTokens: 65536, maxCallMs: 600000, deadline: null }]);
    await tx.query(`INSERT INTO agent_inputs(input_id,request_id,session_id,turn_id,seq,state,body,original_body,input_digest)
      VALUES($1,$2,$3,$4,1,'adopted',$5,$5,$6)`, [deriveId('agent-input:' + inputId), inputId, home.sessionId, turnId, input, digest(input)]);
    await tx.query(`INSERT INTO agent_events(session_id,seq,event_id,kind,body) VALUES($1,1,$2,'input-received',$3),($1,2,$4,'model-progress',$5)`,
      [home.sessionId, eventId, { turnId, inputId, input }, progressEventId, { turnId, stepId, attemptId, revision: 1, text: '进度' }]);
    await tx.query(`INSERT INTO agent_steps(step_id,turn_id,step_no,state,snapshot,completed_at) VALUES($1,$2,1,'completed','{}',clock_timestamp())`, [stepId, turnId]);
    await tx.query(`INSERT INTO agent_attempts(attempt_id,step_id,attempt_no,state,response_ref) VALUES($1,$2,1,'completed',$3)`, [attemptId, stepId, randomUUID()]);
    await tx.query(`INSERT INTO agent_tool_calls(tool_call_id,step_id,call_index,native_call_id,name,input,execution_mode,state,result)
      VALUES($1,$2,0,'call-1','fixture','{}','foreground','closed',$3)`, [toolCallId, stepId, { kind: 'completed', outcome: 'success', summary: '旧结果' }]);
    await tx.query(`INSERT INTO agent_questions(question_id,session_id,turn_id,step_id,tool_call_id,state,presentation,answer)
      VALUES($1,$2,$3,$4,$5,'answered','{}','{}')`, [questionId, home.sessionId, turnId, stepId, toolCallId]);
    await tx.query(`INSERT INTO agent_notifications(notification_id,session_id,origin_turn_id,task_id,task_version,terminal_status,summary,state)
      VALUES($1,$2,$3,'task-1','v1','success','旧任务终态','pending')`, [notificationId, home.sessionId, turnId]);
    await tx.query(`INSERT INTO agent_controls(request_id,session_id,turn_id,operation,input_digest,body)
      VALUES($1,$2,$3,'cancel-turn',$4,$5)`, [deriveId('agent-cancel-turn:' + turnId), home.sessionId, turnId, digest({ turnId }), { turnId, state: 'pending', delivered: [] }]);
    await tx.query('INSERT INTO agent_progress(attempt_id,revision,body,event_id) VALUES($1,1,$2,$3)', [attemptId, { revision: 1, text: '进度' }, progressEventId]);
    return null;
  });
  await agent.request({ requestId: 'agent-input:' + inputId, fingerprint: digest(input) }, async () =>
    ({ requestId: inputId, sessionId: home.sessionId, inputId: deriveId('agent-input:' + inputId), turnId, inputDigest: digest(input) }));
  await agent.request({ requestId: 'agent-session:' + home.sessionId, fingerprint: digest(home.sessionId) }, async () => home);
  await agent.request({ requestId: randomUUID(), fingerprint: 'chunk-channel/1' }, async () => ({ retained: true }));

  // Gateway native history: one chain link is still referenced by a business execution result.
  const segmentBody = (segmentId, headAttemptId, previousSegmentId, sessionId) => ({ segmentId, formatVersion: 1, sequence: 1,
    purpose: 'learning', sessionId, prefix: { system: '', tools: [] }, prefixDigest: digest({ system: '', tools: [] }),
    portable: [], snapshot: {}, headAttemptId, pendingAttemptId: null, closed: false, previousSegmentId });
  const attemptBody = (attemptId, segmentId) => ({ attemptId, purpose: 'learning', segment: { segmentId, sequence: 1 },
    state: 'completed', dispatched: true, cancelRequested: false, physicalRequestEnded: true, upstreamStopped: 'unknown',
    text: '旧响应', usage: { state: 'final', inputTokens: 1, outputTokens: 1 }, requestRef: randomUUID(), resultRef: null,
    createdAt: new Date().toISOString() });
  await model.request({ requestId: randomUUID(), fingerprint: 'fixture-gateway' }, async tx => {
    await tx.query('INSERT INTO model_segments VALUES($1,$2,$3),($4,$2,$5)', [droppedSegment, 'scope', segmentBody(droppedSegment, droppedAttempt, keptSegment, home.sessionId),
      keptSegment, segmentBody(keptSegment, keptAttempt, droppedSegment, home.sessionId)]);
    await tx.query('INSERT INTO model_attempts(id,scope,body,input_digest,credential_ref,state,physical_ended) VALUES($1,$2,$3,$4,$5,$6,true),($7,$2,$8,$4,$5,$6,true)',
      [droppedAttempt, 'scope', attemptBody(droppedAttempt, droppedSegment), digest({}), randomUUID(), 'completed', keptAttempt, attemptBody(keptAttempt, keptSegment)]);
    await tx.query('INSERT INTO model_tool_results VALUES($1,$2,$3)', [droppedAttempt, 'scope', []]);
    await tx.query('INSERT INTO model_attempt_progress(attempt_id,scope,body) VALUES($1,$2,$3)', [droppedAttempt, 'scope', { revision: 1, text: '进度' }]);
    await tx.query(`INSERT INTO model_learning_admissions(attempt_id,fee_source,principal,policy,reserved_units) VALUES($1,'fee','principal','{}',1)`, [droppedAttempt]);
    await tx.query('INSERT INTO model_observations VALUES($1,1,$2,$3)', [randomUUID(), 'scope', { attemptId: droppedAttempt }]);
    await tx.query('INSERT INTO model_origin_journals VALUES($1,$2,$3)', ['scope', droppedAttempt, { formatVersion: 3, service: owners.agent.binding.owner }]);
    await tx.query('INSERT INTO model_origin_authorizations(scope,association_id,grant_id,installation_id,recipient_generation) VALUES($1,$2,$3,$4,$5)',
      ['scope', droppedAttempt, randomUUID(), randomUUID(), randomUUID()]);
    await tx.query(`INSERT INTO model_paired_grants VALUES($1,'attempt',$2,$3,1)`, ['scope', droppedAttempt, randomUUID()]);
    await tx.query(`INSERT INTO model_paired_routes VALUES($1,'attempt',$2,$3)`, ['scope', droppedAttempt, {}]);
    await tx.query(`INSERT INTO model_paired_sessions VALUES($1,'attempt',$2,NULL)`, ['scope', droppedAttempt]);
    await tx.query('INSERT INTO model_device_tasks(id,scope,grant_id,installation_id,task) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), 'scope', randomUUID(), randomUUID(), { taskId: randomUUID(), attemptId: droppedAttempt, operation: 'read' }]);
    return null;
  });
  await model.request({ requestId: 'model-segment:' + randomUUID(), fingerprint: digest(droppedSegment) }, async () => ({ segmentId: droppedSegment }));
  await model.request({ requestId: 'model-tool-results:' + randomUUID(), fingerprint: digest(droppedAttempt) }, async () => ({ attemptId: droppedAttempt }));
  await model.request({ requestId: 'model-selection:' + randomUUID(), fingerprint: 'kept-configuration' }, async () => ({ retained: true }));
  // The business execution result keeps referencing one response: it must survive the history switch.
  await learning.request({ requestId: randomUUID(), fingerprint: 'fixture-business-result' }, async tx => {
    await tx.query(`INSERT INTO execution_records(request_id,activity_id,source_owner,installation_id,target,action_text,input_digest,
      execution_ref,reception,initial_query,query,course_digest,result,created_at) VALUES($1,$2,$3,$4,'browser','{}',$5,$6,'{}','{}','{}',$7,$8,clock_timestamp())`,
      [randomUUID(), project.activityId, owners.learning.binding.owner, randomUUID(), digest({}), randomUUID(), digest({}),
        { modelAttemptId: keptAttempt, modelSegmentId: keptSegment }]);
    return null;
  });
  }

  const units = { agent: 'teaching-agent', learning: 'learning-data', model: 'model-connection' };
  await writeFile(join(root, 'environment.json'), JSON.stringify({ profile: 'local', environmentId, installationId: randomUUID(),
    services: Object.entries(owners).map(([kind, owner]) => ({ ...owner.binding.owner, unit: units[kind] })) }));
  await writeFile(join(root, 'installation.json'), JSON.stringify({ host: '127.0.0.1', resources: { postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN },
    database: { mode: 'external', host: pg.admin.host, port: pg.admin.port, database: pg.admin.database, user: pg.admin.user, credentialRef: 'database-admin' } }));
  await writeFile(join(root, 'credentials', 'database-admin'), pg.admin.password);
  for (const owner of Object.values(owners)) await writeFile(join(root, 'credentials', 'storage-' + owner.binding.owner.serviceId), JSON.stringify(owner.binding));
  const options = { root, admin: pg.admin, owners: { agent: owners.agent, learning: owners.learning, model: owners.model } };
  async function closeOwners() { for (const handle of handles.splice(0).reverse()) await handle.close(); }
  return { pg, root, owners, handles, closeOwners, identity, data, sessions, materials, projects, home, workspace, project, scope, operationId,
    sourceText, adoptedText, adoptedPdf, workspaceReading, options, keptSegment, droppedSegment, keptAttempt, droppedAttempt, turnId };
}

test('the scoped switch preserves business identity and clears only runtime history', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  await f.closeOwners();
  const dry = await switchAgentRuntimeData({ ...f.options, apply: false });
  assert.equal(dry.mode, 'dry-run'); assert.deepEqual(dry.blocking, []); assert.equal(dry.changed, true);
  assert.equal(dry.cleared.turns, 1); assert.equal(dry.cleared.notifications, 1); assert.equal(dry.cleared.pendingNotifications, 1);
  assert.equal(dry.cleared.pendingCancellations, 1); assert.equal(dry.cleared.gatewaySegments, 1); assert.equal(dry.cleared.gatewayAttempts, 1);
  assert.equal(dry.preserved.directorySessions, 2); assert.equal(dry.preserved.projects, 1); assert.equal(dry.verified.projects, 1);
  assert.equal(dry.preserved.gatewaySegments, 1); assert.equal(dry.preserved.gatewayAttempts, 1); assert.equal(dry.repaired.brokenChains, 1);

  const applied = await switchAgentRuntimeData({ ...f.options, apply: true });
  assert.equal(applied.mode, 'applied'); assert.deepEqual(applied.blocking, []);
  for (const key of ['turns', 'inputs', 'steps', 'attempts', 'toolCalls', 'questions', 'notifications', 'controls', 'progress'])
    assert.equal(applied.cleared[key], 1, key);
  assert.equal(applied.cleared.events, 2, 'events');
  assert.equal(applied.cleared.agentReceipts, 1); assert.equal(applied.cleared.gatewayReceipts, 2);
  assert.equal(applied.preserved.sessions, 2); assert.equal(applied.repaired.runtimeSessions, 0);

  const agent = await openStorage({ ...f.owners.agent, migrations: agentServiceMigrations }); f.handles.push(agent);
  const learning = await openStorage({ ...f.owners.learning, migrations: learningMigrations }); f.handles.push(learning);
  const model = await openStorage({ ...f.owners.model, migrations: modelMigrations }); f.handles.push(model);
  await validateAgentRuntime(agent);
  const directory = (await learning.read('SELECT session_id,body FROM agent_session_directory ORDER BY session_id')).rows;
  assert.deepEqual(directory.map(row => row.session_id).sort(), [f.home.sessionId, f.workspace.sessionId].sort());
  const runtimeSessions = (await agent.read('SELECT session_id,body,state,next_seq,automatic_wake_blocked FROM agent_runtime_sessions')).rows;
  assert.equal(runtimeSessions.length, 2);
  for (const row of runtimeSessions) {
    assert.deepEqual(row.state, {}); assert.equal(Number(row.next_seq), 1); assert.equal(row.automatic_wake_blocked, null);
    assert.equal(row.body.sessionId, row.session_id);
  }
  for (const table of ['agent_turns', 'agent_inputs', 'agent_steps', 'agent_attempts', 'agent_tool_calls', 'agent_questions',
    'agent_notifications', 'agent_events', 'agent_controls', 'agent_progress'])
    assert.equal(Number((await agent.read(`SELECT count(*) AS total FROM ${table}`)).rows[0].total), 0, table);
  const receipts = (await agent.read('SELECT request_id FROM _storage_requests')).rows.map(row => row.request_id);
  assert.ok(receipts.includes('agent-session:' + f.home.sessionId));
  assert.ok(!receipts.some(id => id.startsWith('agent-input:')));
  assert.equal(Number((await agent.read("SELECT count(*) AS total FROM _storage_requests WHERE fingerprint='chunk-channel/1'")).rows[0].total), 1);

  // The project receipt and the operationId-derived workspace Session are untouched.
  const projects = createPersonalProjects(learning, { authorize: async () => {}, learning: f.data });
  await validatePersonalProjects(learning); await projects.validate(); await validateAgentSessions(learning);
  const stored = (await learning.read('SELECT body FROM personal_learning_projects WHERE project_id=$1', [f.project.projectId])).rows[0].body;
  assert.deepEqual(stored, f.project);
  assert.equal(stored.workspaceSessionId, personalProjectOperationId(f.operationId, 'session'));
  assert.equal(stored.sourceSessionId, f.home.sessionId); assert.equal(stored.inputId, f.project.inputId); assert.equal(stored.responseId, f.project.responseId);
  assert.equal(Number((await learning.read('SELECT count(*) AS total FROM agent_session_directory WHERE session_id=$1', [stored.workspaceSessionId])).rows[0].total), 1);

  // Attachments and business execution results stay readable under the original identity.
  const nextData = createLearningData(learning, { resolveBinding: async () => ({ ...f.owners.learning.binding.owner, version: 1 }) });
  const nextSessions = createAgentSessions(learning, { authorize: async () => {}, openActivity: nextData.open,
    resolveOwner: async () => { throw new Error('the switch must not resolve a new owner'); } });
  const materials = createSessionMaterials(learning, { openScope: (actor, scope) => scope.kind === 'session'
    ? nextSessions.read(actor, scope.sessionId) : nextData.open(actor, scope.activityId) });
  assert.equal((await materials.personal.original(f.identity, f.project.activityId, f.adoptedText.materialId, 1)).text, '切换后仍可读取的原件：37 V');
  assert.deepEqual(await materials.pdf.reading(f.identity, f.project.activityId, f.workspaceReading.readingId), f.workspaceReading);
  assert.equal(Number((await learning.read('SELECT count(*) AS total FROM execution_records')).rows[0].total), 1);

  // Gateway: the unreferenced chain link is gone, the business-referenced response survives without a native continuation.
  assert.equal(Number((await model.read('SELECT count(*) AS total FROM model_segments WHERE id=$1', [f.droppedSegment])).rows[0].total), 0);
  assert.equal(Number((await model.read('SELECT count(*) AS total FROM model_attempts WHERE id=$1', [f.droppedAttempt])).rows[0].total), 0);
  const kept = (await model.read('SELECT body FROM model_segments WHERE id=$1', [f.keptSegment])).rows[0].body;
  assert.equal(kept.previousSegmentId, undefined); assert.equal(kept.headAttemptId, f.keptAttempt);
  assert.equal(Number((await model.read('SELECT count(*) AS total FROM model_attempts WHERE id=$1', [f.keptAttempt])).rows[0].total), 1);
  for (const table of ['model_tool_results', 'model_attempt_progress', 'model_learning_admissions', 'model_origin_journals',
    'model_origin_authorizations', 'model_paired_grants', 'model_paired_routes', 'model_paired_sessions', 'model_device_tasks'])
    assert.equal(Number((await model.read(`SELECT count(*) AS total FROM ${table}`)).rows[0].total), 0, table);
  assert.equal(Number((await model.read('SELECT count(*) AS total FROM model_observations')).rows[0].total), 0);
  assert.equal(Number((await model.read("SELECT count(*) AS total FROM _storage_requests WHERE request_id LIKE 'model-selection:%'")).rows[0].total), 1);

  // Idempotent: a second pass finds nothing left to clear and preserves the same business facts.
  await f.closeOwners();
  const again = await switchAgentRuntimeData({ ...f.options, apply: true });
  assert.deepEqual(again.blocking, []); assert.equal(again.changed, false);
  for (const value of Object.values(again.cleared)) assert.equal(value, 0);
  assert.equal(again.preserved.projects, 1); assert.equal(again.preserved.directorySessions, 2);
  const agent2 = await openStorage({ ...f.owners.agent, migrations: agentServiceMigrations }); f.handles.push(agent2);
  const learning2 = await openStorage({ ...f.owners.learning, migrations: learningMigrations }); f.handles.push(learning2);
  await validateAgentRuntime(agent2); await validatePersonalProjects(learning2); await validateAgentSessions(learning2);
});

test('an installed service 1..9 agent owner upgrades instead of failing as incompatible', { timeout: 120000 }, async t => {
  const pg = await nativeFixture(), handles = [];
  t.after(async () => { try { for (const handle of handles.reverse()) await handle.close(); } finally { await pg.close(); } });
  const environmentId = randomUUID(), owner = { environmentId, serviceId: randomUUID() }, password = randomUUID();
  const backend = createFileBackend({ id: 'teaching-agent', root: join(pg.root, 'learning-resources', 'teaching-agent') });
  const binding = await provisionStorage({ admin: pg.admin, owner, password, migrations: publishedAgentMigrations });
  const installed = await openStorage({ binding, backend, migrations: publishedAgentMigrations }); handles.push(installed);
  const transferId = randomUUID();
  await installed.request({ requestId: randomUUID(), fingerprint: 'published-transport' }, async tx => {
    await tx.query(`INSERT INTO agent_chunk_transfers(source_key,transfer_id,input_bytes,input_sha,state,reserved_bytes)
      VALUES('published',$1,4,$2,'completed',4)`, [transferId, digest('chunk')]);
    await tx.query(`INSERT INTO agent_chunk_parts(source_key,transfer_id,direction,part_index,byte_length,sha256)
      VALUES('published',$1,'input',0,4,$2)`, [transferId, digest('part')]);
    return null;
  });
  const before = (await installed.read('SELECT version,name,applied_at FROM _storage_migrations ORDER BY version')).rows;
  assert.deepEqual(before.map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(before[8].name, 'agent-session-transport-v2');

  // An installed owner is upgraded only while quiesced, exactly like the product maintenance path.
  await installed.participant().closeWrites(); await installed.participant().closeDispatch();
  await installed.close(); handles.length = 0;
  const upgradedBinding = await provisionStorage({ admin: pg.admin, owner, password, migrations: agentServiceMigrations });
  const upgraded = await openStorage({ binding: upgradedBinding, backend, migrations: agentServiceMigrations }); handles.push(upgraded);
  const journal = (await upgraded.read('SELECT version,name,applied_at FROM _storage_migrations ORDER BY version')).rows;
  assert.deepEqual(journal.map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(journal[8].name, 'agent-turn-loop');
  assert.equal(journal[9].name, 'agent-session-transport-v2');
  // The published tail keeps its original application time; only its version is displaced.
  assert.equal(new Date(journal[9].applied_at).toISOString(), new Date(before[8].applied_at).toISOString());
  await validateAgentRuntime(upgraded);
  assert.equal(Number((await upgraded.read("SELECT count(*) AS total FROM agent_chunk_transfers WHERE source_key='published'")).rows[0].total), 1);
  assert.equal(Number((await upgraded.read("SELECT count(*) AS total FROM agent_chunk_parts WHERE source_key='published'")).rows[0].total), 1);
});

test('the switch refuses an agent owner that still has the old Operation/Wait layout', { timeout: 120000 }, async t => {
  const f = await fixture(t, { legacyAgent: true });
  await f.closeOwners();
  const report = await switchAgentRuntimeData({ ...f.options, apply: true });
  assert.equal(report.mode, 'applied');
  assert.ok(report.blocking.some(item => item.code === 'runtime-migration-required'));
  assert.ok(report.blocking.some(item => item.code === 'legacy-agent-table' && item.detail === 'agent_runs'));
  assert.ok(report.schema.legacyTables.includes('agent_waits'));
  assert.equal(report.cleared.turns, 0);
  const agent = await openStorage({ ...f.owners.agent, migrations: publishedAgentMigrations }); f.handles.push(agent);
  const learning = await openStorage({ ...f.owners.learning, migrations: learningMigrations }); f.handles.push(learning);
  assert.equal(Number((await agent.read('SELECT count(*) AS total FROM agent_runs')).rows[0].total), 0);
  assert.equal(Number((await agent.read("SELECT count(*) AS total FROM agent_chunk_transfers WHERE source_key='published'")).rows[0].total), 1);
  assert.equal(Number((await learning.read('SELECT count(*) AS total FROM agent_session_directory')).rows[0].total), 2);
});
