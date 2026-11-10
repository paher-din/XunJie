import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { test } from 'node:test';
import { provisionStorage, openStorage, createFileBackend, prepareStorageRestore, finalizeStorageRestore, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { learningMigrations, createLearningData, validateLearningData } from '../../../packages/learning-space/dist/learning-data/index.js';
import { createSchoolDeliveries, schoolDeliveryMigration } from '../../../packages/learning-space/dist/learning-data/school-deliveries.js';
import { studyCopyMigration, createStudyCopies, validateStudyCopies } from '../../../packages/learning-space/dist/learning-data/study-copies.js';
import { createChunkChannel } from '../../../packages/learning-space/dist/teaching-agent/chunk-channel.js';
import { executionActionSchema } from '@xunjie/contracts/execution';
import { semanticReferenceCopy } from '@xunjie/contracts/question-drafts';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';
import { readExecutionSource } from '../../../packages/learning-space/dist/learning-data/execution-source.js';

const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
const digest = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const rehash = t => { const { digest: _d, ...body } = t; return { ...t, digest: digest(body) }; };
const identity = () => ({ environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '同一学校' });
const course = () => ({ associationId: randomUUID(), courseId: randomUUID(), courseName: '课程', taskId: randomUUID(), taskTitle: '任务',
  releaseId: randomUUID(), contentDigest: 'a'.repeat(64), objectives: ['目标'], requirements: '要求', materials: [], starterWorks: [],
  capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } });

test('legacy execution references survive study migration without restoring a runnable command', { timeout: 120000 }, async () => {
  const fixture = await nativeFixture(), handles = [];
  let recovery;
  try {
    async function owner() {
      const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
      const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: learningMigrations });
      const options = { binding, migrations: learningMigrations, backend: createFileBackend({ id: 'files', root: join(fixture.root, owner.serviceId) }) };
      const storage = await openStorage(options); handles.push(storage); return { storage, options };
    }
    const source = await owner(), target = await owner(), actor = identity();
    const { manifest } = await aggregationPackage();
    const binding = { key: 'table', definition: { digest: digest(manifest), manifest }, configuration: { title: '表格' }, materialIds: [] };
    const fixed = { ...course(), components: [binding] };
    const authority = storage => ({ resolveBinding: async () => ({ ...storage.owner, version: 1 }) });
    const courses = { authorize: async () => {}, verifyComponentReference: async () => {}, confirm: async () => {},
      prepare: async input => ({ associationId: input.associationId, state: 'prepared', error: null,
        binding: { ...fixed, associationId: input.associationId } }) };
    const remote = createLearningData(source.storage, authority(source.storage), courses);
    const activity = await remote.createCourse(actor, { requestId: randomUUID(), releaseId: fixed.releaseId });
    const state = { formatVersion: 1, instanceId: `${activity.activityId}:table`, componentId: manifest.componentId,
      version: manifest.version, definitionDigest: binding.definition.digest, stateVersion: 1, operationId: randomUUID(),
      content: { table: { columns: ['小组', '得分'], rows: [['A', '2'], ['A', '4']] },
        parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } };
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
      mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify(state) };
    await remote.works.sync(actor, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] });
    const requestId = randomUUID(), executionRef = randomUUID();
    const action = executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId,
      scope: { environmentId: actor.environmentId, spaceId: actor.spaceId, principalId: actor.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' }, execution: {
        instance: { instanceId: state.instanceId, key: 'table', componentId: manifest.componentId, componentVersion: manifest.version,
          definitionDigest: binding.definition.digest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: 'aggregate', effect: 'execute' }, parameters: state.content.parameters,
        basis: { works: [file], state: { name: file.name, contentId: file.contentId, sha256: digest(state) }, expected: { stateContentId: file.contentId },
          resources: [{ kind: 'entry', ...manifest.entry }, { kind: 'algorithm', ...manifest.algorithm.resource }] },
        limits: { timeMs: 5000, memoryPages: 256, inputBytes: 1048576, outputBytes: 65536, concurrentJobs: 1, queuedJobs: 4 },
        plan: { planId: 'browser-job', planVersion: 1, location: 'browser', kind: 'job', planDigest: digest({ planId: 'browser-job', planVersion: 1,
          componentId: manifest.componentId, componentVersion: manifest.version, operationId: 'aggregate' }) },
        initiator: { kind: 'student', principalId: actor.principalId } } });
    const sha = value => createHash('sha256').update(value).digest('hex');
    const acceptance = { receipt: { requestId, inputDigest: sha(JSON.stringify(action)), receiver: action.receiver,
      state: 'accepted', receiptId: `browser:${requestId}`, detail: '原执行' }, execution: { executionRef, acceptedSeq: 1 } };
    const accepted = await remote.executions.accept(actor, activity.activityId, { action, acceptance });
    const running = await remote.executions.report(actor, activity.activityId, requestId, { ...accepted, state: 'running', confirmedSeq: 2 });
    const output = { rows: 2, value: 3, groups: [{ key: 'A', count: 2, sum: 6, mean: 3, min: 2, max: 4, value: 3 }], rejected: [] };
    const text = '\ufeff小组,平均\r\nA,3\r\n';
    const original = { contentId: randomUUID(), output, text, name: '原实验.csv', mediaType: 'text/csv;charset=utf-8',
      sha256: sha(text), byteLength: Buffer.byteLength(text) };
    const result = await remote.executions.result(actor, activity.activityId, requestId, original);
    await remote.executions.report(actor, activity.activityId, requestId, { ...running, output: result.output, state: 'succeeded', confirmedSeq: 3 });
    const range = { kind: 'semantic', formatVersion: 1, typeId: 'aggregation-groups', version: 1,
      target: { groupKeys: ['A'], fields: ['mean'] }, start: 0, end: 1 };
    const copy = semanticReferenceCopy(range, output); range.end = copy.length;
    const reference = { referenceId: randomUUID(), sourceName: original.name, copy, range, source: {
      kind: 'component', formatVersion: 1, ...action.scope, instanceId: state.instanceId, componentId: manifest.componentId,
      componentVersion: manifest.version, definitionDigest: binding.definition.digest, bindingKey: 'table', objectId: requestId,
      contentId: original.contentId, origin: 'execution-result', requestId, executionRef } };
    const draft = await remote.drafts.read(actor, activity.activityId);
    const saved = await remote.drafts.sync(actor, activity.activityId, { requestId: randomUUID(), draftId: draft.draftId,
      baseRevision: 0, question: '为什么平均值是 3？', references: [reference], bases: [] });
    await validateLearningData(source.storage);
    assert.equal((await source.storage.read('SELECT count(*)::int AS n FROM execution_records')).rows[0].n, 0,
      'the regression must start with legacy command/result facts only');
    const from = createStudyCopies(source.storage), to = createStudyCopies(target.storage);
    const transfer = await from.exportScope(actor);
    await to.importScope(actor, transfer);
    await validateLearningData(target.storage);
    const local = createLearningData(target.storage, authority(target.storage), courses);
    const localActivity = await local.open(actor, activity.activityId);
    assert.deepEqual(await local.drafts.read(actor, activity.activityId), saved);
    const historical = await readExecutionSource(target.storage, localActivity, { requestId, executionRef });
    assert.deepEqual(historical.action, action);
    assert.deepEqual(historical.acceptance, acceptance);
    assert.equal(historical.query.state, 'succeeded');
    assert.deepEqual(await to.sourceActivity({ ...actor, name: '重绑显示名' }, activity.activityId), activity);
    assert.equal(await to.sourceActivity(actor, randomUUID()), null);
    await assert.rejects(to.sourceActivity({ ...actor, principalId: randomUUID() }, activity.activityId), { code: 'forbidden' });
    await assert.rejects(readExecutionSource(target.storage, { ...localActivity, identity: { ...actor, principalId: randomUUID() } }, { requestId }), { code: 'invalid' });
    await assert.rejects(readExecutionSource(target.storage, localActivity, { requestId, inputDigest: 'f'.repeat(64) }), { code: 'invalid' });
    const artifact = await local.executions.artifact(actor, activity.activityId, requestId);
    assert.equal(artifact.text, text);
    assert.equal(artifact.sha256, sha(text));
    assert.deepEqual(artifact.output, output);
    assert.deepEqual(artifact.scope, action.scope);
    assert.deepEqual(await local.executions.read(actor, activity.activityId, requestId), historical.query);
    assert.deepEqual((await local.executions.history(actor, activity.activityId)).entries.map(e => e.action), [action]);
    assert.equal((await target.storage.read('SELECT count(*)::int AS n FROM execution_commands')).rows[0].n, 0);
    assert.deepEqual(await target.storage.pendingIntents(), []);
    await from.acknowledgeExport(actor, { digest: transfer.digest });
    await assert.rejects(source.storage.readResource(original.contentId), { code: 'resource-gone' });
    await target.storage.close(); handles.splice(handles.indexOf(target.storage), 1);
    target.storage = await openStorage(target.options); handles.push(target.storage);
    await validateLearningData(target.storage);
    const reopened = createLearningData(target.storage, authority(target.storage), courses);
    assert.deepEqual(await reopened.executions.artifact(actor, activity.activityId, requestId), artifact);

    // Recover the real owner dump and immutable objects into a different PostgreSQL installation.
    recovery = await nativeFixture();
    const backend = createFileBackend({ id: 'files', root: join(recovery.root, 'objects') });
    const execute = promisify(execFile);
    async function pgTool(server, name, args) {
      const connection = server.admin;
      try { await execute(server.tool(name), ['-h', connection.host, '-p', String(connection.port), '-U', connection.user,
        '-d', connection.database, ...args], { env: { ...process.env, PGPASSWORD: connection.password }, timeout: 30000 }); }
      catch { throw new Error(`${name} failed`); }
    }
    await target.storage.participant().closeWrites(); await target.storage.participant().closeDispatch();
    const dump = join(fixture.root, 'study-copy.dump'); let backup;
    await target.storage.snapshot('study-copy-execution', async snapshot => {
      backup = snapshot.manifest;
      await pgTool(fixture, 'pg_dump', ['-Fc', '-n', target.options.binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump]);
      for (const ref of backup.resources) await backend.put(ref.locator.key, await target.storage.readResourceObject(ref.resourceId));
    });
    const restoredBinding = await prepareStorageRestore({ admin: recovery.admin, owner: target.storage.owner, password: randomUUID() });
    await pgTool(recovery, 'pg_restore', ['--exit-on-error', '--role', restoredBinding.migratorRole, '--no-owner', '--no-acl', dump]);
    const restored = await finalizeStorageRestore({ admin: recovery.admin, binding: restoredBinding, migrations: learningMigrations,
      manifest: backup, backend }); handles.push(restored);
    await validateLearningData(restored);
    await restored.participant().resume();
    const recovered = createLearningData(restored, authority(restored), courses);
    assert.deepEqual(await recovered.drafts.read(actor, activity.activityId), saved);
    assert.deepEqual(await recovered.executions.artifact(actor, activity.activityId, requestId), artifact);
    assert.deepEqual(await createStudyCopies(restored).sourceActivity(actor, activity.activityId), activity);
    assert.equal((await restored.read('SELECT count(*)::int AS n FROM execution_commands')).rows[0].n, 0);
    assert.deepEqual(await restored.pendingIntents(), []);
    await restored.request({ requestId: randomUUID(), fingerprint: 'corrupt-source-proof' }, async tx => {
      await tx.query('UPDATE study_copy_sources SET target_owner=$1', [JSON.stringify(source.storage.owner)]); return null;
    });
    await assert.rejects(createStudyCopies(restored).sourceActivity(actor, activity.activityId), { code: 'corrupt' });
    await assert.rejects(validateLearningData(restored), { code: 'corrupt' });
  } finally { await Promise.all(handles.map(storage => storage.close())); await fixture.close(); await recovery?.close(); }
});

test('study copies migrate only the current scope, preserve unknown effects and resources, acknowledge once and keep official registration', { timeout: 120000 }, async t => {
  const fixture = await nativeFixture(), handles = [];
  try {
    const migrations = [...learningMigrations.filter(m => m.version !== 29 && m.version !== 30), studyCopyMigration, schoolDeliveryMigration].sort((a, b) => a.version - b.version);
    async function owner() {
      const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
      const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations });
      const options = { binding, migrations, backend: createFileBackend({ id: 'files', root: join(fixture.root, owner.serviceId) }) };
      const storage = await openStorage(options); handles.push(storage); return { storage, options };
    }
    const source = await owner(), target = await owner(), actor = identity(), other = { ...actor, principalId: randomUUID() };
    const authority = s => ({ resolveBinding: async () => ({ ...s.owner, version: 1 }) });
    const remote = createLearningData(source.storage, authority(source.storage), { authorize: async () => {} });
    const local = createLearningData(target.storage, authority(target.storage), { authorize: async () => {} });
    const from = createStudyCopies(source.storage), to = createStudyCopies(target.storage);
    const requestId = randomUUID();
    const activity = await remote.create(actor, { requestId, goal: '旧目标', question: '私有初始问题', references: [{ kind: 'url', url: 'https://example.com/private', label: '引用' }] });
    activity.course = course();
    await source.storage.request({ requestId: randomUUID(), fingerprint: 'course-fixture' }, async tx => {
      await tx.query('UPDATE activities SET body=$2 WHERE id=$1', [activity.activityId, JSON.stringify(activity)]);
      await tx.query('UPDATE _storage_requests SET result=$2 WHERE request_id=$1', [requestId, JSON.stringify(activity)]);
      await tx.query(`INSERT INTO course_activity_requests(request_id,space_environment_id,space_id,principal_id,release_id,association_id,activity_id,input_digest,state,binding,result)
        VALUES($1,$2,$3,$4,$5,$6,$7,'original','accepted',$8,$9)`, [requestId, actor.environmentId, actor.spaceId, actor.principalId,
        activity.course.releaseId, activity.course.associationId, activity.activityId, JSON.stringify(activity.course), JSON.stringify(activity)]);
      return null;
    });
    const outsider = await remote.create(other, { requestId: randomUUID(), goal: '别人的私有活动', question: '', references: [] });
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: '作品.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: '学生私有作品\n版本一' };
    const workRequest = randomUUID();
    await remote.works.sync(actor, activity.activityId, { requestId: workRequest, baseRevision: 0, files: [file] });
    await remote.works.sync(other, outsider.activityId, { requestId: randomUUID(), baseRevision: 0, files: [{ ...file, objectId: randomUUID(), contentId: randomUUID(), value: '别人的作品' }] });
    const fixedReference = { referenceId: randomUUID(), source: { kind: 'work', objectId: file.objectId, contentId: file.contentId },
      range: { kind: 'text', start: 0, end: 2 }, copy: '学生', sourceName: file.name };
    const draft = await remote.drafts.read(actor, activity.activityId);
    await remote.drafts.sync(actor, activity.activityId, { requestId: randomUUID(), draftId: draft.draftId, baseRevision: 0,
      question: '尚未发送的草稿', references: [fixedReference], bases: [] });
    const noteId = randomUUID();
    await remote.materials.receive(actor, activity.activityId, { requestId: randomUUID(), materialId: noteId, name: '私人笔记',
      mediaType: 'text/plain', dataBase64: Buffer.from('旧版笔记').toString('base64') });
    await remote.materials.update(actor, activity.activityId, noteId, { requestId: randomUUID(), materialId: noteId, expectedVersion: 1,
      dataBase64: Buffer.from('当前笔记').toString('base64') });
    const actionId = randomUUID();
    await remote.intents.prepare(actor, activity.activityId, { requestId: actionId,
      scope: { environmentId: actor.environmentId, spaceId: actor.spaceId, principalId: actor.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'local-agent', location: 'local', kind: 'question' },
      draft: { token: 'immutable-question', question: '还没确认的问题', references: [fixedReference], bases: [] }, works: [file], evidence: [] });
    await source.storage.request({ requestId: 'action-state:' + randomUUID(), fingerprint: actionId }, async tx => {
      await tx.query("UPDATE action_intents SET state='dispatched' WHERE request_id=$1", [actionId]);
      await tx.enqueue('original-unknown-effect', { activityId: activity.activityId, requestId: actionId }); return null;
    });
    const deliveries = createSchoolDeliveries(source.storage, { activity: remote.open });
    // A formal request may legally reuse an activity UUID; it must not be mistaken for process history.
    const submission = await deliveries.submit(actor, activity.activityId, { requestId: activity.activityId, works: [file] });
    const unrelatedResource = randomUUID();
    await source.storage.stageResource({ uploadId: unrelatedResource, scope: 'unrelated-owner-work',
      bytes: Buffer.from('another pending upload'), mediaType: 'text/plain', contentVersion: 1 });
    await source.storage.request({ requestId: randomUUID(), fingerprint: 'shared-retention' }, async tx => {
      await tx.reference('school-submission/shared-original', file.contentId); return null;
    });
    await validateLearningData(source.storage);
    let continueLate, signalEntered;
    const beforeWrite = new Promise(resolve => { signalEntered = resolve; });
    const resumeLate = new Promise(resolve => { continueLate = resolve; });
    const lateRequest = randomUUID();
    const oldClient = createLearningData({ ...source.storage, async request(input, effect) {
      return source.storage.request(input, async tx => {
        if (input.requestId === lateRequest) { signalEntered(); await resumeLate; }
        return effect(tx);
      });
    } }, authority(source.storage), { authorize: async () => {} });
    const lateWrite = oldClient.works.sync(actor, activity.activityId, { requestId: lateRequest, baseRevision: 1, files: [file] });
    const lateAssertion = assert.rejects(lateWrite, { code: 'forbidden' });
    await beforeWrite;
    let transfer;
    try { transfer = await from.exportScope(actor); } finally { continueLate(); }
    await lateAssertion;
    assert.deepEqual(transfer.tables.activities.map(a => a.id), [activity.activityId]);
    assert.equal(JSON.stringify(transfer).includes('别人的'), false);
    assert.equal(transfer.resources.length, 3);
    assert.equal(transfer.receipts.some(r => r.requestId === submission.requestId), false);
    await assert.rejects(from.assertWritable(actor), { code: 'forbidden' });
    await from.assertWritable(other);
    await assert.rejects(remote.setStatus(actor, { requestId: randomUUID(), activityId: activity.activityId, status: 'closed' }), { code: 'forbidden' });
    await assert.rejects(remote.create(actor, { requestId: randomUUID(), goal: 'late private request', question: 'late', references: [] }), { code: 'forbidden' });
    await assert.rejects(remote.works.sync(actor, activity.activityId, { requestId: randomUUID(), baseRevision: 1, files: [] }), { code: 'forbidden' });
    assert.equal((await remote.works.read(actor, activity.activityId)).files[0].value, file.value);
    await assert.rejects(to.importScope(other, transfer), { code: 'forbidden' });
    const bad = structuredClone(transfer); bad.resources[0].base64 = Buffer.from('changed').toString('base64');
    await assert.rejects(to.importScope(actor, rehash(bad)), { code: 'corrupt' });
    const extra = structuredClone(transfer); extra.tables._storage_identity = [];
    await assert.rejects(to.importScope(actor, rehash(extra)), { code: 'invalid' });
    const wrong = structuredClone(transfer); wrong.tables.work_heads[0].activity_id = outsider.activityId;
    await assert.rejects(to.importScope(actor, rehash(wrong)), { code: 'forbidden' });
    const invalidRecord = structuredClone(transfer); invalidRecord.tables.question_drafts[0].revision = 0;
    await assert.rejects(to.importScope(actor, rehash(invalidRecord)), { code: 'unavailable' });
    assert.equal((await target.storage.read('SELECT count(*)::int AS n FROM activities')).rows[0].n, 0);
    assert.equal(await to.hasIdentity(actor), false);
    let lostCommit = true;
    const uncertain = createStudyCopies({ ...target.storage, async request(input, effect) {
      const result = await target.storage.request(input, effect);
      if (input.requestId.startsWith('study-copy:import:') && lostCommit) { lostCommit = false; throw new StorageError('commit-unknown', input.requestId); }
      return result;
    } });
    await assert.rejects(uncertain.importScope(actor, transfer), { code: 'commit-unknown' });
    const imported = await to.importScope(actor, transfer);
    assert.deepEqual(imported.activityIds, [activity.activityId]);
    assert.deepEqual(await to.importScope(actor, transfer), imported);
    assert.equal(await to.hasIdentity(actor), true); assert.equal(await to.hasIdentity(other), false);
    const copy = await local.open(actor, activity.activityId);
    assert.deepEqual(copy.target, { ...target.storage.owner, version: 1 });
    assert.equal(copy.question, activity.question);
    assert.equal((await local.drafts.read(actor, activity.activityId)).question, '尚未发送的草稿');
    assert.deepEqual((await local.drafts.read(actor, activity.activityId)).references[0].source, fixedReference.source);
    assert.equal((await local.intents.read(actor, activity.activityId, actionId)).input.draft.references[0].copy, '学生');
    assert.equal((await local.materials.versionContent(actor, activity.activityId, noteId, 1)).text, '旧版笔记');
    assert.equal((await local.materials.versionContent(actor, activity.activityId, noteId, 2)).text, '当前笔记');
    assert.deepEqual(await local.works.read(actor, activity.activityId), await remote.works.read(actor, activity.activityId));
    assert.equal((await local.works.receipt(actor, activity.activityId, workRequest)).revision, 1);
    assert.equal((await local.intents.read(actor, activity.activityId, actionId)).state, 'dispatched');
    assert.equal((await local.intents.read(actor, activity.activityId, actionId)).receipt, null);
    assert.deepEqual(await target.storage.pendingIntents(), []);
    await to.assertCourse(actor, activity.course);
    await assert.rejects(to.assertCourse(other, activity.course), { code: 'forbidden' });
    await to.cache(actor, 'release:' + activity.course.releaseId, { published: true });
    assert.deepEqual(await to.cached(actor, 'release:' + activity.course.releaseId), { published: true });
    assert.equal(await to.cached(other, 'release:' + activity.course.releaseId), null);
    await validateLearningData(target.storage); await validateStudyCopies(target.storage);
    let lostAck = true;
    const uncertainSource = createStudyCopies({ ...source.storage, async request(input, effect) {
      const result = await source.storage.request(input, effect);
      if (input.requestId.startsWith('study-copy:ack:') && lostAck) { lostAck = false; throw new StorageError('commit-unknown', input.requestId); }
      return result;
    } });
    await assert.rejects(uncertainSource.acknowledgeExport(actor, { digest: transfer.digest }), { code: 'commit-unknown' });
    let interruptedCollection = true;
    const recoveringCollector = createStudyCopies({ ...source.storage, async collect(options) {
      assert.ok(options.resourceIds?.length);
      const result = await source.storage.collect(options);
      if (interruptedCollection) { interruptedCollection = false; throw new StorageError('unavailable'); }
      return result;
    } });
    await assert.rejects(recoveringCollector.acknowledgeExport(actor, { digest: transfer.digest }), { code: 'unavailable' });
    const ack = await from.acknowledgeExport({ ...actor, name: '重绑后的账号显示名' }, { digest: transfer.digest });
    assert.equal(Buffer.from(await source.storage.readResource(unrelatedResource)).toString(), 'another pending upload');
    assert.equal(Buffer.from(await source.storage.readResource(file.contentId)).toString(), file.value);
    const releasedNote = transfer.resources.find(r => r.reference.scope.startsWith('personal-material:'));
    await assert.rejects(source.storage.readResource(releasedNote.reference.resourceId), { code: 'resource-gone' });
    assert.deepEqual(await from.acknowledgeExport(actor, { digest: transfer.digest }), ack);
    assert.equal((await remote.open(actor, activity.activityId)).question, '');
    assert.equal((await remote.open(actor, activity.activityId)).status, 'open', 'official registration still accepts local submissions');
    assert.equal((await remote.open(actor, activity.activityId)).references.length, 0);
    assert.deepEqual((await remote.open(actor, activity.activityId)).target, activity.target);
    assert.deepEqual(await remote.works.read(actor, activity.activityId), { revision: 0, files: [] });
    assert.equal((await remote.works.read(other, outsider.activityId)).files[0].value, '别人的作品');
    assert.equal((await source.storage.read('SELECT count(*)::int AS n FROM course_activity_requests')).rows[0].n, 1);
    assert.equal((await source.storage.read('SELECT result FROM course_activity_requests')).rows[0].result.question, '');
    assert.equal((await source.storage.receipt(requestId)).result.question, '');
    assert.deepEqual(await deliveries.receipt(actor, activity.activityId, submission.requestId), submission);
    assert.equal((await deliveries.list(actor, activity.activityId)).submissions.length, 1);
    const laterSubmission = await deliveries.submit(actor, activity.activityId, { requestId: randomUUID(), works: [file] });
    assert.equal(laterSubmission.state, 'accepted');
    await validateLearningData(source.storage); await validateStudyCopies(source.storage);
    const reopened = await openStorage(target.options); handles.push(reopened);
    await validateStudyCopies(reopened); assert.equal(await createStudyCopies(reopened).hasIdentity(actor), true);
    await local.works.sync(actor, activity.activityId, { requestId: randomUUID(), baseRevision: 1, files: [{ ...file, contentId: randomUUID(), value: '本机继续编辑' }] });
    await to.importActivities(actor, [activity]);
    assert.equal((await local.works.read(actor, activity.activityId)).files[0].value, '本机继续编辑');
    const nextBinding = course();
    const courseRegistrar = createLearningData(source.storage, authority(source.storage), {
      authorize: async () => {}, confirm: async () => {},
      prepare: async input => ({ associationId: input.associationId, state: 'prepared',
        binding: { ...nextBinding, associationId: input.associationId }, error: null }),
    });
    const newlyReceived = await courseRegistrar.createCourse(actor, { requestId: randomUUID(), releaseId: nextBinding.releaseId });
    await to.importActivities(actor, [newlyReceived]); await to.importActivities(actor, [newlyReceived]);
    await to.assertCourse(actor, newlyReceived.course);
    const legacy = { ...activity, activityId: randomUUID() }; delete legacy.course;
    await to.importActivities(actor, [legacy]);
    assert.equal((await local.open(actor, legacy.activityId)).question, activity.question);
    await validateStudyCopies(target.storage);
  } finally { await Promise.all(handles.map(s => s.close())); await fixture.close(); }
});

test('chunk migration verifies orphan input ownership, freezes exact transfers, preserves unknown effects and collects only accepted bytes', { timeout: 120000 }, async () => {
  const fixture = await nativeFixture(), handles = [];
  try {
    const migrations = [...learningMigrations.filter(m => m.version !== 29 && m.version !== 30), studyCopyMigration, schoolDeliveryMigration].sort((a, b) => a.version - b.version);
    async function owner() {
      const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
      const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations });
      const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: 'files', root: join(fixture.root, owner.serviceId) }) });
      handles.push(storage); return storage;
    }
    const source = await owner(), target = await owner(), actor = identity(), other = { ...actor, principalId: randomUUID() };
    const authority = s => ({ resolveBinding: async () => ({ ...s.owner, version: 1 }) });
    const remote = createLearningData(source, authority(source), { authorize: async () => {} });
    const local = createLearningData(target, authority(target), { authorize: async () => {} });
    const activity = await remote.create(actor, { requestId: randomUUID(), goal: '本人', question: '', references: [] });
    const foreign = await remote.create(other, { requestId: randomUUID(), goal: '另一主体', question: '', references: [] });
    activity.course = course();
    await source.request({ requestId: randomUUID(), fingerprint: 'closed-course' }, async tx => {
      await tx.query('UPDATE activities SET body=$2 WHERE id=$1', [activity.activityId, JSON.stringify({ ...activity, status: 'closed' })]); return null;
    });
    const peer = { grantId: randomUUID(), sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(), sourceInstallationId: randomUUID() };
    const sourceKey = createHash('sha256').update(JSON.stringify([peer.grantId, peer.sourceEnvironmentId, peer.sourceServiceId, peer.sourceInstallationId])).digest('hex');
    const sha = b => createHash('sha256').update(b).digest('hex');
    const resourceId = (id, direction, index = 0) => {
      const h = sha(`chunk:${sourceKey}:${id}:${direction}:${index}`);
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    };
    let effects = 0;
    const channel = createChunkChannel(source);
    const wire = channel.wrap(async input => {
      effects++;
      if (input.args[1] === 'unknown') throw new Error('original response lost');
      return { original: input.args[1], activityId: input.activityId };
    });
    const call = (id, operation, value = {}) => wire({ chunkChannel: 1, transferId: id, operation, ...value }, peer);
    const body = (who, id, label) => ({ version: 1, operation: 'data', identity: who, activityId: id, args: ['open', label] });
    const acknowledged = randomUUID(), completed = randomUUID(), unknown = randomUUID(), outsider = randomUUID(), incomplete = randomUUID();
    const ownInput = body(actor, activity.activityId, '已确认原文🙂');
    await call(acknowledged, 'invoke', { value: ownInput }); await call(acknowledged, 'ack');
    await call(completed, 'invoke', { value: body(actor, activity.activityId, 'completed原文') });
    const uncertain = await call(unknown, 'invoke', { value: body(actor, activity.activityId, 'unknown') });
    assert.equal(uncertain.state, 'unknown');
    await call(outsider, 'invoke', { value: body(other, foreign.activityId, '另一主体原文') }); await call(outsider, 'ack');
    const partial = Buffer.from(JSON.stringify(body(actor, activity.activityId, '不能据首片猜主体'.repeat(30000))));
    await call(incomplete, 'begin', { byteLength: partial.length, sha256: sha(partial) });
    await call(incomplete, 'put', { index: 0, data: partial.subarray(0, 262144).toString('base64') });
    // A delayed publisher reserved its reply metadata but has not staged the immutable bytes yet.
    const lateBytes = Buffer.from('late unknown reply');
    await source.request({ requestId: randomUUID(), fingerprint: 'pending-publication' }, async tx => {
      await tx.query(`INSERT INTO agent_chunk_parts(source_key,transfer_id,direction,part_index,byte_length,sha256)
        VALUES($1,$2,'reply',0,$3,$4)`, [sourceKey, unknown, lateBytes.length, sha(lateBytes)]); return null;
    });
    const orphanId = resourceId(acknowledged, 'input'), foreignId = resourceId(outsider, 'input');
    assert.deepEqual(JSON.parse(Buffer.from(await source.readResource(orphanId)).toString()), ownInput);
    assert.equal((await source.read('SELECT count(*)::int AS n FROM _storage_references WHERE resource_id=$1', [orphanId])).rows[0].n, 0);
    const from = createStudyCopies(source), to = createStudyCopies(target), transfer = await from.exportScope(actor);
    assert.deepEqual(new Set(transfer.tables.agent_chunk_transfers.map(r => r.transfer_id)), new Set([acknowledged, completed, unknown]));
    assert.equal(transfer.tables.agent_chunk_parts.find(r => r.transfer_id === acknowledged && r.direction === 'input').resource_id, null);
    assert.equal(JSON.stringify(transfer).includes(outsider), false);
    assert.equal(transfer.resources.some(r => r.reference.resourceId === foreignId), false);
    assert.equal((await source.read('SELECT count(*)::int AS n FROM study_copy_chunk_scopes')).rows[0].n, 3);
    await assert.rejects(call(completed, 'ack'), { code: 'forbidden' });
    await assert.rejects(source.stageResource({ uploadId: resourceId(unknown, 'reply'), scope: 'agent-chunk:' + sourceKey,
      bytes: lateBytes, mediaType: 'application/octet-stream', contentVersion: 1 }), { code: 'forbidden' });
    // Another member sharing the exact transport source remains writable.
    const outsiderAgain = randomUUID();
    await call(outsiderAgain, 'invoke', { value: body(other, foreign.activityId, 'another foreign request') });
    const beforeImportEffects = effects;
    const forged = structuredClone(transfer); forged.tables.agent_chunk_transfers[0].source_key = 'a'.repeat(64);
    await assert.rejects(to.importScope(actor, rehash(forged)));
    await to.importScope(actor, transfer);
    assert.equal((await target.read('SELECT count(*)::int AS n FROM agent_chunk_transfers')).rows[0].n, 0, 'archives never become executable transfers');
    assert.equal((await local.open(actor, activity.activityId)).status, 'closed');
    await validateStudyCopies(target);
    await from.acknowledgeExport(actor, { digest: transfer.digest });
    assert.equal(effects, beforeImportEffects, 'migration and ack never replay handlers');
    const retained = (await source.read('SELECT * FROM agent_chunk_transfers WHERE transfer_id=$1', [unknown])).rows[0];
    assert.equal(retained.state, 'unknown');
    assert.equal(retained.reserved_bytes, 0);
    assert.equal((await source.read('SELECT count(*)::int AS n FROM agent_chunk_parts WHERE transfer_id=ANY($1::uuid[])', [[acknowledged, completed, unknown]])).rows[0].n, 0);
    await assert.rejects(source.readResource(orphanId), { code: 'resource-gone' });
    assert.deepEqual(JSON.parse(Buffer.from(await target.readResource(orphanId)).toString()), ownInput);
    assert.equal(JSON.parse(Buffer.from(await source.readResource(foreignId)).toString()).identity.principalId, other.principalId);
    assert.equal((await source.readResource(resourceId(incomplete, 'input'))).length, 262144);
    await assert.rejects(call(unknown, 'put', { index: 0, data: Buffer.from(JSON.stringify(body(actor, activity.activityId, 'unknown'))).toString('base64') }));
    await from.acknowledgeExport(actor, { digest: transfer.digest });
    await validateLearningData(source); await validateStudyCopies(source); await validateStudyCopies(target);
    assert.equal((await remote.open(actor, activity.activityId)).status, 'open');
    await local.setStatus(actor, { requestId: randomUUID(), activityId: activity.activityId, status: 'open' });
    const delivery = await createSchoolDeliveries(source, { activity: remote.open }).submit(actor, activity.activityId,
      { requestId: randomUUID(), works: [{ objectId: randomUUID(), contentId: randomUUID(), name: '重开后的作品', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: '提交原件' }] });
    assert.equal(delivery.state, 'accepted');
  } finally { await Promise.all(handles.map(s => s.close())); await fixture.close(); }
});
