import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';
import { aluCoursePackage } from '../../../components/alu-experiment/package.mjs';

const isolated = process.env.XUNJIE_EXECUTION_RECORD_TEST_MODULES;
const load = (name, fallback) => import(isolated ? pathToFileURL(join(isolated, name + '.mjs')).href : fallback);
const { createExecutionRecords, executionRecordMigration, validateExecutionRecords } = await load('records', '../../../packages/learning-space/dist/learning-data/execution-records.js');
const { readExecutionSource } = await load('source', '../../../packages/learning-space/dist/learning-data/execution-source.js');
const { verifySemanticReference } = await load('semantic', '../../../packages/learning-space/dist/learning-data/semantic-references.js');
const { createWorks, workMigration } = await load('works', '../../../packages/learning-space/dist/learning-data/works.js');
const { createQuestionDrafts, questionDraftMigration } = await load('drafts', '../../../packages/learning-space/dist/learning-data/drafts.js');
const { createActionIntents, actionIntentMigration } = await load('intents', '../../../packages/learning-space/dist/learning-data/intents.js');
const { executionMigration } = await load('executions', '../../../packages/learning-space/dist/learning-data/executions.js');
const { anyExecutionActionSchema, courseExecutionPlanBasis } = await load('execution', '../../../packages/contracts/dist/execution.js');
const { executionRecordSessionIdentitySchema } = await load('contracts', '../../../packages/contracts/dist/execution-records.js');
const { activitySchema } = await load('learning', '../../../packages/contracts/dist/learning-data.js');
const { semanticReferenceCopy } = await load('questions', '../../../packages/contracts/dist/question-drafts.js');
const hash = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const output = { groups: [{ key: 'A', count: 2, value: 3, sum: 6, mean: 3, min: 2, max: 4 }] };

test('school retains original external execution facts and resources without becoming an executor', { timeout: 120000 }, async t => {
  const pg = await nativeFixture(); t.after(() => pg.close());
  const aggregate = (await aggregationPackage()).manifest, native = (await accumulatorPackage({ version: 1 })).manifest;
  async function fixture(t, { nativeSession = false, legacy = false } = {}) {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const sourceOwner = { environmentId: randomUUID(), serviceId: randomUUID() }, installationId = randomUUID();
    const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'Record student' };
    const manifest = nativeSession ? native : aggregate, key = nativeSession ? 'accumulator' : 'table';
    const binding = { key, definition: { manifest, digest: digest(manifest) }, configuration: { title: 'Original component' }, materialIds: [] };
    const operationId = nativeSession ? 'advance' : 'aggregate', location = nativeSession ? 'native' : 'browser';
    const plan = { version: 2, planId: 'record-plan', planVersion: 1, planDigest: '0'.repeat(64),
      components: [{ key, definitionDigest: binding.definition.digest, configurationDigest: digest(binding.configuration), operations: [operationId] }],
      capabilities: [nativeSession ? 'native-session' : 'execution.submit'], resources: { browser: nativeSession ? null : { features: ['worker'] },
        native: nativeSession ? { memoryMiB: 64, operationTimeoutMs: 5000, maxMs: 3600000 } : null }, locations: [location], remote: null,
      placements: [{ componentKey: key, operationId, target: nativeSession ? 'student-runtime' : 'student-browser',
        resources: [{ resourceId: manifest.entry.resourceId, sha256: manifest.entry.sha256, byteLength: manifest.entry.byteLength }],
        budgets: nativeSession ? { ...manifest.session.budgets } : { timeMs: 5000, memoryPages: 256, inputBytes: 1048576,
          outputBytes: 65536, concurrentJobs: 1, queuedJobs: 4 } }] };
    plan.planDigest = hash(JSON.stringify(courseExecutionPlanBasis(plan)));
    const activity = activitySchema.parse({ activityId: randomUUID(), identity, target: { ...owner, version: 1 }, goal: 'Cite original execution',
      question: '', references: [], status: 'open', createdAt: new Date().toISOString(),
      course: { associationId: randomUUID(), courseId: randomUUID(), courseName: 'Records', taskId: randomUUID(), taskTitle: 'Original task',
        releaseId: randomUUID(), contentDigest: 'a'.repeat(64), objectives: ['Explain original evidence'], requirements: 'Use the original result', starterWorks: [],
        capabilities: [], components: [binding], materials: [], executionPlan: plan, helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } } });
    const migrations = [{ version: 1, name: 'test-school-activities', sql: `CREATE TABLE activities(id uuid PRIMARY KEY,
      space_environment_id uuid NOT NULL,space_id uuid NOT NULL,principal_id uuid NOT NULL,body jsonb NOT NULL);` },
      workMigration, { ...questionDraftMigration, version: 3 }, { ...actionIntentMigration, version: 4 }, { ...executionRecordMigration, version: 5 },
      ...(legacy ? [{ ...executionMigration, version: 6, sql: executionMigration.sql + '\nALTER TABLE execution_commands ADD COLUMN action_text text;' }] : [])];
    const owned = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations });
    const options = { binding: owned, migrations, backend: createFileBackend({ id: 'files', root: join(pg.root, owner.serviceId) }) };
    let storage = await openStorage(options), authorized = true, sourceActive = true, authCalls = 0;
    t.after(() => storage.close());
    const mutate = effect => storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, effect);
    await mutate(async tx => { await tx.query('INSERT INTO activities VALUES($1,$2,$3,$4,$5)',
      [activity.activityId, identity.environmentId, identity.spaceId, identity.principalId, JSON.stringify(activity)]); return null; });
    async function authorize(actor, id) {
      if (!authorized) throw new StorageError('forbidden');
      if (id !== activity.activityId || ['environmentId', 'spaceId', 'principalId'].some(key => actor[key] !== identity[key])) throw new StorageError('missing');
      return activity;
    }
    let works, records, drafts;
    function assemble() {
      works = createWorks(storage, authorize);
      records = createExecutionRecords(storage, { activity: authorize, works });
      drafts = createQuestionDrafts(storage, { activity: authorize, works, courses: { async verifyComponentReference() {} } });
    }
    assemble();
    const trusted = { sourceOwner, installationId, role: 'tool-execution', async assertAuthorized() {
      authCalls++; if (!sourceActive) throw new StorageError('forbidden');
    } };
    function commandEvent() {
      const requestId = randomUUID(), executionRef = randomUUID();
      const action = anyExecutionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId,
        scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId: activity.activityId },
        receiver: { receiverId: nativeSession ? 'native-session' : 'browser-execution', location: 'local', kind: 'execution' },
        execution: { instance: { instanceId: `${activity.activityId}:${key}`, key, componentId: manifest.componentId,
          componentVersion: manifest.version, definitionDigest: binding.definition.digest, hostApiVersion: 1, stateVersion: manifest.stateVersion },
          operation: { operationId, effect: nativeSession ? 'input' : 'execute' },
          parameters: nativeSession ? {} : { aggregate: 'mean', groupColumn: '小组', valueColumn: '得分' },
          basis: { works: [], state: null, expected: { stateContentId: null }, resources: nativeSession ? [] : [
            { kind: 'entry', ...manifest.entry }, { kind: 'algorithm', ...manifest.algorithm.resource }] },
          limits: { timeMs: 5000, memoryPages: 256, inputBytes: nativeSession ? 1024 : 1048576, outputBytes: 65536,
            concurrentJobs: 1, queuedJobs: nativeSession ? 0 : 4 },
          plan: { planId: nativeSession ? 'native-session' : 'browser-job', planVersion: 1, location,
            kind: nativeSession ? 'session' : 'job', planDigest: digest({ planId: nativeSession ? 'native-session' : 'browser-job', planVersion: 1,
              componentId: manifest.componentId, componentVersion: manifest.version, operationId }) },
          ...(nativeSession ? { session: { adapterId: manifest.session.adapterId, adapterVersion: manifest.session.adapterVersion,
            limits: Object.fromEntries(['operationTimeoutMs', 'idleMs', 'maxMs', 'memoryMiB', 'concurrentSessions', 'queuedSessions'].map(key => [key, manifest.session.budgets[key]])) },
            device: { platform: process.platform === 'darwin' ? 'macos-arm64' : 'linux-x64', browser: { worker: true, webassembly: true, sandboxedFrame: true },
              native: { supported: true, installed: true, authorized: true, prepared: 'ready' } } } : {}),
          initiator: { kind: 'student', principalId: identity.principalId } } });
      const actionText = JSON.stringify(action), inputDigest = hash(actionText);
      const session = { adapterId: manifest.session?.adapterId ?? 'unused', adapterVersion: 1,
        instanceId: action.execution.instance.instanceId, instanceKey: key, nodeId: 'actual-device', installGeneration: installationId,
        supervisorEpoch: randomUUID(), executorInstanceId: randomUUID(), appliedSeq: 0, lastControlId: null, observation: null, observations: [] };
      const query = { requestId, inputDigest, scope: action.scope, executionRef, state: 'queued', statusKnowledge: 'confirmed',
        stopRequested: false, confirmedSeq: 1, reason: null, output: null, ...(nativeSession ? { session } : {}) };
      const reception = nativeSession ? { kind: 'native', requestId, inputDigest, executionRef, scope: action.scope, receiver: action.receiver,
        receivedSeq: 1, session: executionRecordSessionIdentitySchema.parse(session) } : { kind: 'browser', acceptance: {
        receipt: { requestId, inputDigest, receiver: action.receiver, state: 'accepted', receiptId: 'browser:' + requestId, detail: '' },
        execution: { executionRef, acceptedSeq: 1 } } };
      return { version: 1, kind: 'command', sourceOwner, installationId, requestId, inputDigest, executionRef,
        actionText, reception, query, createdAt: new Date().toISOString() };
    }
    const common = event => Object.fromEntries(['version', 'sourceOwner', 'installationId', 'requestId', 'inputDigest', 'executionRef'].map(key => [key, event[key]]));
    function resultEvent(event, extra = {}) {
      const text = JSON.stringify(output);
      return { ...common(event), kind: 'result', result: { contentId: randomUUID(), requestId: event.requestId, executionRef: event.executionRef,
        scope: event.query.scope, name: 'result.json', mediaType: 'application/json', text, sha256: hash(text), byteLength: Buffer.byteLength(text), output, ...extra } };
    }
    function statusEvent(event, extra = {}) { return { ...common(event), kind: 'status', query: { ...event.query, ...extra } }; }
    const run = event => records.sync(identity, activity.activityId, event, trusted);
    async function complete(event) {
      await run(event); const result = resultEvent(event); await run(result);
      await run(statusEvent(event, { state: 'succeeded', confirmedSeq: 2, output: { contentId: result.result.contentId, output,
        artifact: { name: result.result.name, mediaType: result.result.mediaType, sha256: result.result.sha256, byteLength: result.result.byteLength } } }));
      return result;
    }
    return { owner, sourceOwner, installationId, identity, activity, binding, trusted, commandEvent, common, resultEvent, statusEvent, run, complete,
      storage: () => storage, records: () => records, drafts: () => drafts, works: () => works, mutate, authorize,
      sourceOffline() { sourceActive = false; }, revoke() { authorized = false; }, authCalls: () => authCalls,
      async reopen() { await storage.close(); storage = await openStorage(options); assemble(); } };
  }

  await t.test('preserves raw text identity, idempotent admission and source ownership through restart', async t => {
    const f = await fixture(t), event = f.commandEvent();
    // Whitespace is part of the original bytes and must survive JSONB property normalization.
    event.actionText = JSON.stringify(JSON.parse(event.actionText), null, 1); event.inputDigest = hash(event.actionText);
    event.query.inputDigest = event.inputDigest; event.reception.acceptance.receipt.inputDigest = event.inputDigest;
    const record = await f.run(event); assert.equal(record.actionText, event.actionText); assert.deepEqual(record.sourceOwner, f.sourceOwner);
    assert.deepEqual(await f.run(event), record); await f.reopen(); assert.deepEqual(await f.run(event), record);
    assert.deepEqual((await f.records().history(f.identity, f.activity.activityId)).entries, [record]);
    assert.equal((await readExecutionSource(f.storage(), f.activity, { requestId: event.requestId })).record.installationId, f.installationId);
    const { rows } = await f.storage().read("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename IN ('execution_commands','native_sessions')");
    assert.deepEqual(rows, []); await validateExecutionRecords(f.storage());
  });

  await t.test('checks trusted source/role/installation, scope, receiver, digest, ref and fixed course plan rather than payload assertions', async t => {
    const f = await fixture(t);
    for (const change of [{ sourceOwner: { ...f.sourceOwner, serviceId: randomUUID() } }, { installationId: randomUUID() }])
      await assert.rejects(f.run({ ...f.commandEvent(), ...change }), { code: 'forbidden' });
    await assert.rejects(f.records().sync(f.identity, f.activity.activityId, f.commandEvent(), { ...f.trusted, role: 'teaching-agent' }), { code: 'forbidden' });
    for (const change of [e => { e.inputDigest = 'f'.repeat(64); }, e => { e.query.scope.principalId = randomUUID(); },
      e => { e.reception.acceptance.receipt.receiver.receiverId = 'different'; }, e => { e.query.executionRef = randomUUID(); },
      e => { const a = JSON.parse(e.actionText); a.execution.instance.definitionDigest = 'b'.repeat(64); e.actionText = JSON.stringify(a);
        e.inputDigest = hash(e.actionText); e.query.inputDigest = e.inputDigest; e.reception.acceptance.receipt.inputDigest = e.inputDigest; }]) {
      const event = f.commandEvent(); change(event); await assert.rejects(f.run(event));
    }
    const event = f.commandEvent(); await f.run(event);
    const replaced = { ...event, sourceOwner: { ...f.sourceOwner, environmentId: randomUUID() } };
    await assert.rejects(f.records().sync(f.identity, f.activity.activityId, replaced, { ...f.trusted, sourceOwner: replaced.sourceOwner }), { code: 'identity-conflict' });
    f.activity.course.executionPlan.placements[0].target = 'school-runtime';
    f.activity.course.executionPlan.planDigest = hash(JSON.stringify(courseExecutionPlanBasis(f.activity.course.executionPlan)));
    await assert.rejects(f.run(f.commandEvent()));
    assert.equal((await f.storage().read('SELECT count(*)::integer AS n FROM execution_records')).rows[0].n, 1);
  });

  await t.test('out-of-order and duplicate facts cannot regress state, overwrite same-sequence facts or change terminal outcomes', async t => {
    const f = await fixture(t), event = f.commandEvent(); await f.run(event);
    const running = f.statusEvent(event, { state: 'running', confirmedSeq: 2 }); await f.run(running); await f.run(running);
    assert.equal((await f.run(f.statusEvent(event))).query.state, 'running');
    await assert.rejects(f.run(f.statusEvent(event, { state: 'paused', confirmedSeq: 2 })), { code: 'identity-conflict' });
    const unknown = f.statusEvent(event, { state: 'running', confirmedSeq: 2, statusKnowledge: 'unknown', reason: { code: 'resource-unavailable', detail: 'disconnected' } });
    assert.equal((await f.run(unknown)).query.statusKnowledge, 'unknown');
    const done = f.statusEvent(event, { state: 'succeeded', confirmedSeq: 3 }); await f.run(done);
    assert.equal((await f.run(running)).query.state, 'succeeded'); assert.equal((await f.run(unknown)).query.statusKnowledge, 'confirmed');
    await assert.rejects(f.run(f.statusEvent(event, { state: 'failed', confirmedSeq: 4 })), { code: 'identity-conflict' });
    await validateExecutionRecords(f.storage());
  });

  await t.test('original resources are independently checked, retained once and usable in a school question after the source is offline', async t => {
    const f = await fixture(t), event = f.commandEvent(); const result = await f.complete(event);
    const record = await f.run(result); assert.equal(record.query.state, 'succeeded');
    const range = { kind: 'semantic', formatVersion: 1, typeId: 'aggregation-groups', version: 1, target: { groupKeys: ['A'], fields: ['mean'] }, start: 0, end: 1 };
    const copy = semanticReferenceCopy(range, output); range.end = copy.length;
    const instance = JSON.parse(event.actionText).execution.instance;
    const reference = { referenceId: randomUUID(), sourceName: 'Original local result', copy, range, source: {
      kind: 'component', formatVersion: 1, environmentId: f.identity.environmentId, spaceId: f.identity.spaceId,
      principalId: f.identity.principalId, activityId: f.activity.activityId, instanceId: instance.instanceId, componentId: instance.componentId,
      componentVersion: instance.componentVersion, definitionDigest: instance.definitionDigest, bindingKey: instance.key,
      objectId: event.requestId, contentId: result.result.contentId, origin: 'execution-result', requestId: event.requestId, executionRef: event.executionRef } };
    f.sourceOffline(); await f.reopen(); const authCalls = f.authCalls();
    await verifySemanticReference(f.storage(), f.activity, reference);
    const draft = await f.drafts().read(f.identity, f.activity.activityId);
    const saved = await f.drafts().sync(f.identity, f.activity.activityId, { requestId: randomUUID(), draftId: draft.draftId,
      baseRevision: 0, question: 'Why is this mean correct?', references: [reference], bases: [] });
    assert.equal(saved.references[0].copy, copy); assert.equal(f.authCalls(), authCalls);
    const intents = createActionIntents(f.storage(), { activity: f.authorize, works: f.works(), drafts: f.drafts() });
    const question = await intents.prepare(f.identity, f.activity.activityId, { requestId: randomUUID(), scope: event.query.scope,
      receiver: { receiverId: 'original-local-agent', location: 'local', kind: 'question' },
      draft: { token: saved.revisionId, question: saved.question, references: [reference], bases: [] }, works: [], evidence: [] });
    assert.deepEqual(question.input.draft.references, [reference]);
    assert.equal(question.state, 'prepared'); assert.equal(f.authCalls(), authCalls);
    assert.equal((await f.records().artifact(f.identity, f.activity.activityId, event.requestId)).text, result.result.text);
    await verifySemanticReference(f.storage(), f.activity, reference, true);
    for (const change of [{ copy: 'forged copy' }, { source: { ...reference.source, executionRef: randomUUID() } },
      { source: { ...reference.source, contentId: randomUUID() } }]) await assert.rejects(verifySemanticReference(f.storage(), f.activity, { ...reference, ...change }));
    await validateExecutionRecords(f.storage());
  });

  await t.test('result bytes, output metadata, attachments and original result identity cannot be substituted', async t => {
    const f = await fixture(t), event = f.commandEvent(); await f.run(event);
    const original = f.resultEvent(event);
    await assert.rejects(f.run({ ...original, result: { ...original.result, text: 'bad' } }), { code: 'invalid' });
    await assert.rejects(f.run({ ...original, result: { ...original.result, scope: { ...event.query.scope, activityId: randomUUID() } } }), { code: 'identity-conflict' });
    const extra = { contentId: randomUUID(), name: 'details.txt', mediaType: 'text/plain', text: 'original detail', sha256: hash('original detail'), byteLength: 15 };
    original.result.resources = [extra]; await f.run(original);
    await validateExecutionRecords(f.storage()); // result-before-status is recoverable retained data
    await assert.rejects(f.records().artifact(f.identity, f.activity.activityId, event.requestId), { code: 'unavailable' });
    await f.run(f.statusEvent(event, { state: 'succeeded', confirmedSeq: 2, output: { contentId: original.result.contentId, output,
      artifact: { name: original.result.name, mediaType: original.result.mediaType, sha256: original.result.sha256, byteLength: original.result.byteLength } } }));
    const artifact = await f.records().artifact(f.identity, f.activity.activityId, event.requestId);
    assert.deepEqual(artifact.resources, [extra]);
    await assert.rejects(f.run({ ...original, result: { ...original.result, contentId: randomUUID() } }), { code: 'identity-conflict' });
    await assert.rejects(f.run({ ...original, result: { ...original.result, output: { changed: true } } }), { code: 'identity-conflict' });
    await f.mutate(async tx => { await tx.unreference(`execution/${event.requestId}/resource/${extra.contentId}`); return null; });
    await assert.rejects(f.records().artifact(f.identity, f.activity.activityId, event.requestId), { code: 'corrupt' });
  });

  await t.test('native reception is explicit, all synchronized observations survive rolling windows and changed instances are rejected', async t => {
    const f = await fixture(t, { nativeSession: true }), event = f.commandEvent();
    await f.run(event);
    for (let seq = 1; seq <= 66; seq++) {
      const observation = { seq, controlId: randomUUID(), state: { value: seq, total: seq, applied: seq }, at: new Date().toISOString() };
      await f.run(f.statusEvent(event, { state: 'running', confirmedSeq: seq + 1,
        session: { ...event.query.session, appliedSeq: seq, lastControlId: observation.controlId, observation: observation.state, observations: [observation] } }));
    }
    await f.reopen(); const record = await f.records().read(f.identity, f.activity.activityId, event.requestId);
    assert.equal(record.reception.kind, 'native'); assert.equal(record.observations.length, 66);
    const source = await readExecutionSource(f.storage(), f.activity, { requestId: event.requestId, inputDigest: event.inputDigest, executionRef: event.executionRef });
    assert.equal(source.acceptance, null); assert.equal(source.query.session.appliedSeq, 66);
    assert.equal(source.query.session.observations.length, 1); assert.equal(source.record.observations.length, 66);
    const session = { ...record.query.session, executorInstanceId: randomUUID() };
    await assert.rejects(f.run(f.statusEvent(event, { ...record.query, confirmedSeq: 68, session })), { code: 'identity-conflict' });
    const conflicting = structuredClone(record.query); conflicting.session.observations[0].state.total = -1;
    conflicting.session.observation.total = -1;
    await assert.rejects(f.run(f.statusEvent(event, { ...conflicting, confirmedSeq: 68 })), { code: 'identity-conflict' });
    await validateExecutionRecords(f.storage());
  });

  await t.test('revoked sources cannot upload, while authorized readers use stored history without consulting them', async t => {
    const f = await fixture(t), event = f.commandEvent(); await f.complete(event); f.sourceOffline();
    await assert.rejects(f.run(event), { code: 'forbidden' });
    assert.equal((await f.records().history(f.identity, f.activity.activityId)).entries.length, 1);
    assert.ok(await f.records().artifact(f.identity, f.activity.activityId, event.requestId));
    await assert.rejects(f.records().read({ ...f.identity, principalId: randomUUID() }, f.activity.activityId, event.requestId), { code: 'missing' });
    f.revoke(); await assert.rejects(f.records().history(f.identity, f.activity.activityId), { code: 'forbidden' });
  });

  await t.test('parallel command/status/result retries serialize without duplicating source facts', async t => {
    const f = await fixture(t), event = f.commandEvent();
    await Promise.all(Array.from({ length: 4 }, () => f.run(event)));
    const result = f.resultEvent(event); await Promise.all([f.run(result), f.run(result)]);
    const done = f.statusEvent(event, { state: 'succeeded', confirmedSeq: 2, output: { contentId: result.result.contentId, output,
      artifact: { name: result.result.name, mediaType: result.result.mediaType, sha256: result.result.sha256, byteLength: result.result.byteLength } } });
    await Promise.all([f.run(done), f.run(done), f.run(f.statusEvent(event))]);
    assert.equal((await f.records().read(f.identity, f.activity.activityId, event.requestId)).query.state, 'succeeded');
    await validateExecutionRecords(f.storage());
  });

  await t.test('legacy local browser sources and result references remain readable beside the new record store', async t => {
    const f = await fixture(t, { legacy: true }), event = f.commandEvent(), result = f.resultEvent(event);
    const query = { ...event.query, state: 'succeeded', confirmedSeq: 2,
      output: { contentId: result.result.contentId, output, artifact: { name: result.result.name, mediaType: result.result.mediaType,
        sha256: result.result.sha256, byteLength: result.result.byteLength } } };
    await f.mutate(async tx => {
      await tx.query(`INSERT INTO execution_commands(request_id,activity_id,input_digest,execution_ref,body,acceptance,state,status_knowledge,
        confirmed_seq,output,action_text) VALUES($1,$2,$3,$4,$5,$6,'succeeded','confirmed',2,$7,$8)`,
        [event.requestId, f.activity.activityId, event.inputDigest, event.executionRef, event.actionText, JSON.stringify(event.reception.acceptance),
          JSON.stringify(query.output), event.actionText]);
      return null;
    });
    await f.storage().stageResource({ uploadId: result.result.contentId, scope: `execution/${event.requestId}`,
      bytes: Buffer.from(result.result.text), mediaType: result.result.mediaType, contentVersion: 1 });
    await f.mutate(async tx => {
      await tx.query('INSERT INTO execution_results(request_id,activity_id,execution_ref,content_id,sha256,byte_length,artifact,output) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [event.requestId, f.activity.activityId, event.executionRef, result.result.contentId, result.result.sha256, result.result.byteLength,
          JSON.stringify(query.output.artifact), JSON.stringify(output)]);
      await tx.reference(`execution/${event.requestId}/result`, result.result.contentId); return null;
    });
    const source = await readExecutionSource(f.storage(), f.activity, { requestId: event.requestId });
    assert.equal(source.record, undefined); assert.deepEqual(source.acceptance, event.reception.acceptance);
    const action = JSON.parse(event.actionText), range = { kind: 'semantic', formatVersion: 1, typeId: 'aggregation-groups', version: 1,
      target: { groupKeys: ['A'], fields: ['mean'] }, start: 0, end: 1 }, copy = semanticReferenceCopy(range, output); range.end = copy.length;
    await verifySemanticReference(f.storage(), f.activity, { referenceId: randomUUID(), sourceName: 'Legacy source', range, copy,
      source: { kind: 'component', formatVersion: 1, ...action.scope, instanceId: action.execution.instance.instanceId,
        componentId: action.execution.instance.componentId, componentVersion: action.execution.instance.componentVersion,
        definitionDigest: action.execution.instance.definitionDigest, bindingKey: 'table', objectId: event.requestId,
        contentId: result.result.contentId, origin: 'execution-result', requestId: event.requestId, executionRef: event.executionRef } });
  });

  await t.test('format 3 ALU observations cite the synchronized original command, runtime basis and retained result offline', async t => {
    const f = await fixture(t), course = await aluCoursePackage();
    Object.assign(f.activity.course, course.release, { materials: [] });
    await f.mutate(async tx => { await tx.query('UPDATE activities SET body=$2 WHERE id=$1', [f.activity.activityId, JSON.stringify(f.activity)]); return null; });
    const binding = f.activity.course.components[0], m = binding.definition.manifest, op = m.runtime.operations.find(item => item.operationId === 'run-single');
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'alu.sv', kind: 'code', encoding: 'utf8', mediaType: 'text/plain',
      value: 'module experiment(input [3:0] A,B, input Cin,M, input [1:0] S, output [3:0] F, output Cout); endmodule\n' };
    const event = f.commandEvent(), plan = f.activity.course.executionPlan;
    const action = anyExecutionActionSchema.parse({ protocolVersion: 3, kind: 'execution', requestId: event.requestId, scope: event.query.scope,
      receiver: event.reception.acceptance.receipt.receiver, execution: { instance: { instanceId: `${f.activity.activityId}:${binding.key}`,
        key: binding.key, componentId: m.componentId, componentVersion: m.version, definitionDigest: binding.definition.digest,
        hostApiVersion: m.hostApiVersion, stateVersion: m.stateVersion }, operation: { operationId: 'run-single', effect: 'execute' },
        parameters: { A: 2, B: 3, M: 0, S: 0, Cin: 0 }, basis: { works: [file],
          runtime: { adapterId: m.runtime.adapterId, adapterVersion: m.runtime.adapterVersion, bundleIdentity: m.runtime.bundleIdentity, resources: m.runtime.resources },
          compile: op.compile, observation: op.observation, course: { releaseId: f.activity.course.releaseId,
            behaviorRuleDigest: digest(f.activity.course.requirements), planDigest: plan.planDigest }, expected: { stateContentId: null } },
        limits: { ...op.budgets, concurrentJobs: m.budget.concurrentJobs, queuedJobs: m.budget.queuedJobs },
        plan: { planId: plan.planId, planVersion: plan.planVersion, planDigest: plan.planDigest, location: 'browser', kind: 'job' },
        initiator: { kind: 'student', principalId: f.identity.principalId } } });
    event.actionText = JSON.stringify(action); event.inputDigest = hash(event.actionText); event.query.inputDigest = event.inputDigest;
    event.reception.acceptance.receipt.inputDigest = event.inputDigest;
    await f.run(event);
    const aluOutput = { f: '0101', cout: '0', observationState: 'complete' }, text = JSON.stringify(aluOutput);
    const result = f.resultEvent(event, { output: aluOutput, text, name: 'observation.json', sha256: hash(text), byteLength: Buffer.byteLength(text) });
    await f.run(result);
    await f.run(f.statusEvent(event, { state: 'succeeded', confirmedSeq: 2, output: { contentId: result.result.contentId, output: aluOutput,
      artifact: { name: result.result.name, mediaType: result.result.mediaType, sha256: result.result.sha256, byteLength: result.result.byteLength } } }));
    const range = { kind: 'semantic', formatVersion: 1, typeId: 'alu-observation', version: 1, target: {}, start: 0, end: 1 };
    const copy = semanticReferenceCopy(range, { action, output: aluOutput, state: 'succeeded', resources: [], name: result.result.name,
      mediaType: result.result.mediaType, text }); range.end = copy.length;
    const reference = { referenceId: randomUUID(), sourceName: 'Synchronized local ALU record', range, copy,
      source: { kind: 'component', formatVersion: 1, ...action.scope, instanceId: action.execution.instance.instanceId,
        componentId: m.componentId, componentVersion: m.version, definitionDigest: binding.definition.digest, bindingKey: binding.key,
        objectId: event.requestId, contentId: result.result.contentId, origin: 'execution-result', requestId: event.requestId, executionRef: event.executionRef } };
    f.sourceOffline(); await f.reopen(); await verifySemanticReference(f.storage(), f.activity, reference);
    await verifySemanticReference(f.storage(), f.activity, reference, true);
    await validateExecutionRecords(f.storage());
    await f.mutate(async tx => { await tx.unreference(`execution/${event.requestId}/work/${file.contentId}`); return null; });
    await assert.rejects(f.records().read(f.identity, f.activity.activityId, event.requestId), { code: 'corrupt' });
  });

  await t.test('real independent native owner synchronizes its command and observations without relocating the school activity', async t => {
    const f = await fixture(t, { nativeSession: true });
    const { createExecutionOwner, executionOwnerMigrations } = await load('owner', '../../../packages/learning-space/dist/learning-data/execution-owner.js');
    const owned = await provisionStorage({ admin: pg.admin, owner: f.sourceOwner, password: randomUUID(), migrations: executionOwnerMigrations });
    const storage = await openStorage({ binding: owned, migrations: executionOwnerMigrations,
      backend: createFileBackend({ id: 'local', root: join(pg.root, f.sourceOwner.serviceId) }) });
    const local = createExecutionOwner(storage, { activity: f.authorize,
      sourceFile: (...args) => f.works().content(...args), native: { nodePath: process.execPath, sessionRoot: join(pg.root, 'native-' + randomUUID()),
        ...(process.env.XUNJIE_NATIVE_SESSION_HELPER ? { windowsHelper: process.env.XUNJIE_NATIVE_SESSION_HELPER } : {}) } });
    t.after(async () => { try { await local.executions.closeActivity(f.identity, f.activity.activityId); } finally { await storage.close(); } });
    const proposed = f.commandEvent(), action = JSON.parse(proposed.actionText);
    const query = await local.executions.accept(f.identity, f.activity.activityId, { action });
    assert.equal(query.state, 'running'); assert.equal(query.statusKnowledge, 'confirmed');
    const { rows: [original] } = await storage.read('SELECT * FROM native_sessions WHERE request_id=$1', [proposed.requestId]);
    const event = { ...proposed, executionRef: query.executionRef, inputDigest: query.inputDigest, actionText: original.action_text,
      query, createdAt: new Date(original.created_at).toISOString(), reception: { kind: 'native', requestId: query.requestId,
        inputDigest: query.inputDigest, executionRef: query.executionRef, scope: query.scope, receiver: action.receiver, receivedSeq: 1,
        session: executionRecordSessionIdentitySchema.parse(query.session) } };
    await f.run(event);
    const updated = await local.executions.control(f.identity, f.activity.activityId, event.requestId,
      { controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 7 } });
    assert.equal(updated.session.observation.total, 7);
    await f.run(f.statusEvent(event, updated));
    await local.executions.stop(f.identity, f.activity.activityId, event.requestId, { stopId: randomUUID(), reason: 'Test complete' });
    const stopped = await local.executions.read(f.identity, f.activity.activityId, event.requestId);
    await f.run(f.statusEvent(event, stopped));
    f.sourceOffline(); await f.reopen();
    const school = await f.records().read(f.identity, f.activity.activityId, event.requestId);
    assert.deepEqual(school.query, stopped); assert.equal(school.observations[0].state.total, 7);
    assert.deepEqual(school.sourceOwner, f.sourceOwner); assert.equal(school.reception.kind, 'native');
    assert.deepEqual(f.activity.target, { ...f.owner, version: 1 });
    assert.equal((await readExecutionSource(f.storage(), f.activity, { requestId: event.requestId })).acceptance, null);
    await validateExecutionRecords(f.storage());
  });
});
