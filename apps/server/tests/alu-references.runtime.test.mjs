import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { learningMigrations } from '@xunjie/learning-space';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { aluReferenceCopy } from '@xunjie/contracts/alu-references';
import { ALU_REFLECTION_MEDIA_TYPE, aluReflectionName } from '@xunjie/contracts/alu-learning';
import { questionReferenceInputSchema } from '@xunjie/contracts/question-drafts';
import { createWorks } from '../../../packages/learning-space/dist/learning-data/works.js';
import { createExecutions } from '../../../packages/learning-space/dist/learning-data/executions.js';
import { verifySemanticReference } from '../../../packages/learning-space/dist/learning-data/semantic-references.js';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { aluReferenceFixture, aluReferenceTrace } from '../../../packages/contracts/test/fixtures/alu-reference.mjs';
import { aluCoursePackage } from '../../../components/alu-experiment/package.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const resource = (name, text) => ({ contentId: randomUUID(), name, mediaType: 'text/plain', text,
  sha256: hash(text), byteLength: Buffer.byteLength(text) });

async function fixture(t) {
  const pg = await nativeFixture();
  let storage;
  t.after(async () => { try { await storage?.close(); } finally { await pg.close(); } });
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomBytes(32).toString('base64url'), migrations: learningMigrations });
  const options = { binding, migrations: learningMigrations, backend: createFileBackend({ id: owner.serviceId, root: join(pg.root, 'references') }) };
  storage = await openStorage(options);
  const course = await aluCoursePackage(), component = course.release.components[0];
  const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'ALU reference student' };
  async function transaction(effect) {
    await storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, async tx => { await effect(tx); return null; });
  }
  async function activity(who = identity) {
    const value = activitySchema.parse({ activityId: randomUUID(), identity: who, target: { ...owner, version: 1 },
      goal: 'Reference original ALU evidence', question: '', references: [], status: 'open', createdAt: new Date().toISOString(),
      course: { associationId: randomUUID(), courseId: course.course.courseId, courseName: course.course.name,
        taskId: course.task.taskId, taskTitle: course.task.title, ...course.release, materials: [], contentDigest: 'a'.repeat(64) } });
    await transaction(tx => tx.query('INSERT INTO activities VALUES($1,$2,$3,$4,$5)', [value.activityId, who.environmentId,
      who.spaceId, who.principalId, JSON.stringify(value)]));
    return value;
  }
  const current = await activity();
  const authorize = async (who, id) => {
    const { rows: [row] } = await storage.read('SELECT body FROM activities WHERE id=$1', [id]);
    if (!row || ['environmentId', 'spaceId', 'principalId'].some(key => row.body.identity[key] !== who[key])) throw new StorageError('missing');
    return activitySchema.parse(row.body);
  };
  const works = createWorks(storage, authorize), executions = createExecutions(storage, { activity: authorize, works });
  function fixed(target = current) { return aluReferenceFixture({ binding: component, activityId: target.activityId, identity: target.identity }); }
  async function receive(f) {
    for (const file of f.action.execution.basis.works) await works.registerBasis(f.identity, f.activityId, file);
    const inputDigest = hash(JSON.stringify(f.action)), executionRef = randomUUID();
    const acceptance = { receipt: { requestId: f.action.requestId, inputDigest, receiver: f.action.receiver, state: 'accepted',
      receiptId: 'browser:' + f.action.requestId, detail: 'Original fixed owner command' }, execution: { executionRef, acceptedSeq: 1 } };
    // Genuine owner DB/resources; these are receiver facts, not a WASM/HDL simulation claim.
    await transaction(tx => tx.query(`INSERT INTO execution_commands(request_id,activity_id,input_digest,execution_ref,body,
      acceptance,state,status_knowledge,confirmed_seq,action_text) VALUES($1,$2,$3,$4,$5,$6,'queued','confirmed',1,$7)`,
    [f.action.requestId, f.activityId, inputDigest, executionRef, JSON.stringify(f.action), JSON.stringify(acceptance), JSON.stringify(f.action)]));
    return { ...f, inputDigest, executionRef };
  }
  async function result(f, { state = 'succeeded', report = true, contentId = randomUUID(), output = { f: '1101', cout: '0', observationState: 'complete' },
    resources = [resource('diagnostics.txt', 'Retained receiver diagnostics'), resource('trace.vcd', aluReferenceTrace)] } = {}) {
    const text = JSON.stringify({ inputs: f.inputs, ...output });
    const query = await executions.result(f.identity, f.activityId, f.action.requestId, { contentId, output, text,
      name: 'observation.json', mediaType: 'application/json', sha256: hash(text), byteLength: Buffer.byteLength(text), resources });
    if (report) await executions.report(f.identity, f.activityId, f.action.requestId, { ...query, state, statusKnowledge: 'confirmed', confirmedSeq: 2 });
    const artifact = await executions.artifact(f.identity, f.activityId, f.action.requestId);
    return { ...f, contentId, artifact, state };
  }
  function reference(f, typeId, target = {}, content) {
    const state = typeId === 'alu-case';
    const source = { kind: 'component', formatVersion: 1, environmentId: f.identity.environmentId,
      spaceId: f.identity.spaceId, principalId: f.identity.principalId, activityId: f.activityId,
      instanceId: f.action.execution.instance.instanceId, componentId: component.definition.manifest.componentId,
      componentVersion: component.definition.manifest.version, definitionDigest: component.definition.digest, bindingKey: component.key,
      objectId: state ? f.stateFile.objectId : f.action.requestId, contentId: state ? f.stateFile.contentId : f.contentId,
      origin: state ? 'state' : 'execution-result', requestId: state ? null : f.action.requestId, executionRef: state ? null : f.executionRef };
    const material = content ?? (state ? JSON.parse(f.stateFile.value).content
      : { action: f.action, output: f.artifact.output, state: f.state, resources: f.artifact.resources ?? [],
        inputDigest: f.inputDigest, executionRef: f.executionRef });
    const copy = aluReferenceCopy(typeId, target, material);
    return questionReferenceInputSchema.parse({ referenceId: randomUUID(), source,
      range: { kind: 'semantic', formatVersion: 1, typeId, version: 1, target, start: 0, end: copy.length }, copy, sourceName: 'Original ALU evidence' });
  }
  return { get storage() { return storage; }, current, identity, component, works, executions, activity, transaction, fixed, receive, result, reference,
    path: async contentId => join(options.backend.location.root, (await storage.resource(contentId)).locator.key),
    async reopen() { await storage.close(); storage = await openStorage(options); } };
}

test('ALU state and V3 result owners validate the same client copies against real retained PG resources', { timeout: 120000 }, async t => {
  const f = await fixture(t), fixed = await f.result(await f.receive(f.fixed()));
  await verifySemanticReference(f.storage, f.current, f.reference(fixed, 'alu-case'));
  await verifySemanticReference(f.storage, f.current, f.reference(fixed, 'alu-observation'));
  const waveform = f.reference(fixed, 'alu-waveform', { signalIds: ['tb.mirror[3:0]'], fromTick: '4', toTick: '9007199254740997' });
  await verifySemanticReference(f.storage, f.current, waveform);
  await f.reopen();
  await verifySemanticReference(f.storage, f.current, waveform);
});

test('result references reject damaged original acceptance instead of trusting an otherwise intact result', { timeout: 120000 }, async t => {
  const f = await fixture(t), fixed = await f.result(await f.receive(f.fixed()));
  const observation = f.reference(fixed, 'alu-observation');
  const waveform = f.reference(fixed, 'alu-waveform', { signalIds: ['tb.mirror[3:0]'], fromTick: '4', toTick: '9007199254740997' });
  const { rows: [row] } = await f.storage.read('SELECT acceptance FROM execution_commands WHERE request_id=$1', [fixed.action.requestId]);
  const original = row.acceptance;
  const variants = [
    ['rejected receipt', { receipt: { ...original.receipt, state: 'rejected' }, execution: null }],
    ['other receiver', { ...original, receipt: { ...original.receipt, receiver: { ...original.receipt.receiver, receiverId: 'other-receiver' } } }],
    ['other request', { ...original, receipt: { ...original.receipt, requestId: randomUUID() } }],
    ['other digest', { ...original, receipt: { ...original.receipt, inputDigest: 'f'.repeat(64) } }],
    ['other execution', { ...original, execution: { ...original.execution, executionRef: randomUUID() } }],
    ['unconfirmed acceptance', { ...original, execution: { ...original.execution, acceptedSeq: 3 } }],
    ['missing execution', { ...original, execution: null }],
  ];
  for (const [name, acceptance] of variants) {
    await f.transaction(tx => tx.query('UPDATE execution_commands SET acceptance=$2 WHERE request_id=$1',
      [fixed.action.requestId, JSON.stringify(acceptance)]));
    await assert.rejects(verifySemanticReference(f.storage, f.current, observation), { code: 'corrupt' }, name);
    await assert.rejects(verifySemanticReference(f.storage, f.current, waveform), { code: 'corrupt' }, name);
  }
  await f.transaction(tx => tx.query('UPDATE execution_commands SET acceptance=$2 WHERE request_id=$1',
    [fixed.action.requestId, JSON.stringify(original)]));
  await verifySemanticReference(f.storage, f.current, observation);
  await verifySemanticReference(f.storage, f.current, waveform);
});

test('intact result references wait for the original terminal report and retry the same copy', { timeout: 120000 }, async t => {
  const f = await fixture(t), fixed = await f.result(await f.receive(f.fixed()), { report: false });
  const observation = f.reference(fixed, 'alu-observation');
  const waveform = f.reference(fixed, 'alu-waveform', { signalIds: ['tb.mirror[3:0]'], fromTick: '4', toTick: '9007199254740997' });
  for (const [state, knowledge] of [['queued', 'confirmed'], ['running', 'confirmed'], ['paused', 'confirmed'], ['running', 'unknown']]) {
    const reason = knowledge === 'unknown' ? { code: 'worker-terminated', detail: 'The original receiver status is not confirmed.' } : null;
    await f.transaction(tx => tx.query('UPDATE execution_commands SET state=$2,status_knowledge=$3,reason=$4 WHERE request_id=$1',
      [fixed.action.requestId, state, knowledge, reason && JSON.stringify(reason)]));
    await assert.rejects(verifySemanticReference(f.storage, f.current, observation), { code: 'unavailable' }, state + '/' + knowledge);
    await assert.rejects(verifySemanticReference(f.storage, f.current, waveform), { code: 'unavailable' }, state + '/' + knowledge);
    const pending = f.reference({ ...fixed, state: knowledge === 'unknown' ? 'unknown' : state }, 'alu-observation');
    await verifySemanticReference(f.storage, f.current, pending);
    await assert.rejects(verifySemanticReference(f.storage, f.current,
      { ...waveform, range: { ...waveform.range, target: { ...waveform.range.target, signalIds: ['missing-signal'] } } }), { code: 'invalid' });
  }
  const query = await f.executions.read(f.identity, f.current.activityId, fixed.action.requestId);
  await f.executions.report(f.identity, f.current.activityId, fixed.action.requestId,
    { ...query, state: 'succeeded', statusKnowledge: 'confirmed', confirmedSeq: query.confirmedSeq + 1, reason: null });
  await verifySemanticReference(f.storage, f.current, observation);
  await verifySemanticReference(f.storage, f.current, waveform);
  await assert.rejects(verifySemanticReference(f.storage, f.current,
    { ...observation, copy: observation.copy.replace('实际：F=1101', '实际：F=0000') }), { code: 'invalid' });
});

test('references reject cross-scope identities, another result, changed copies and out-of-bounds ranges', { timeout: 120000 }, async t => {
  const f = await fixture(t), fixed = await f.result(await f.receive(f.fixed()));
  const original = f.reference(fixed, 'alu-observation');
  for (const change of [{ principalId: randomUUID() }, { activityId: randomUUID() }, { instanceId: 'other' },
    { definitionDigest: '0'.repeat(64) }, { objectId: randomUUID() }, { contentId: randomUUID() }, { executionRef: randomUUID() }]) {
    await assert.rejects(verifySemanticReference(f.storage, f.current, { ...original, source: { ...original.source, ...change } }), { code: 'invalid' });
  }
  const forgedCopy = { ...original, copy: original.copy.replace('实际：F=1101', '实际：F=0000') };
  assert.equal(forgedCopy.copy.length, original.copy.length);
  await assert.rejects(verifySemanticReference(f.storage, f.current, forgedCopy), { code: 'invalid' });
  const waveform = f.reference(fixed, 'alu-waveform', { signalIds: ['tb.mirror[3:0]'], fromTick: '4', toTick: '9007199254740997' });
  for (const change of [{ signalIds: ['unknown'] }, { toTick: '9007199254740999' }, { fromTick: '-1' }]) {
    await assert.rejects(verifySemanticReference(f.storage, f.current,
      { ...waveform, range: { ...waveform.range, target: { ...waveform.range.target, ...change } } }), { code: 'invalid' });
  }
  const other = await f.activity(), second = await f.result(await f.receive(f.fixed(other)));
  await assert.rejects(verifySemanticReference(f.storage, f.current, { ...original, source: {
    ...original.source, requestId: second.action.requestId, objectId: second.action.requestId,
    contentId: second.contentId, executionRef: second.executionRef } }), { code: 'invalid' });
  const crossComponent = structuredClone(f.current);
  crossComponent.course.components.push({ ...f.component, key: 'other' });
  await assert.rejects(verifySemanticReference(f.storage, crossComponent, { ...original, source: {
    ...original.source, bindingKey: 'other', instanceId: `${f.current.activityId}:other` } }), { code: 'invalid' });
  const action = structuredClone(fixed.action);
  action.scope.principalId = randomUUID(); action.execution.initiator.principalId = action.scope.principalId;
  await f.transaction(tx => tx.query(`UPDATE execution_commands SET body=$2,action_text=$3,input_digest=$4,
    acceptance=jsonb_set(acceptance,'{receipt,inputDigest}',to_jsonb($4::text)) WHERE request_id=$1`,
    [action.requestId, JSON.stringify(action), JSON.stringify(action), hash(JSON.stringify(action))]));
  await assert.rejects(verifySemanticReference(f.storage, f.current, original), { code: 'invalid' });
});

test('every original resource is hash checked, including diagnostics unused by an observation copy', { timeout: 120000 }, async t => {
  const f = await fixture(t), fixed = await f.result(await f.receive(f.fixed()));
  const reference = f.reference(fixed, 'alu-observation');
  for (const contentId of [fixed.contentId, ...fixed.artifact.resources.map(item => item.contentId)]) {
    const path = await f.path(contentId), original = await readFile(path), changed = Buffer.from(original);
    changed[changed.length - 1] ^= 1;
    await writeFile(path, changed);
    await assert.rejects(verifySemanticReference(f.storage, f.current, reference), { code: 'corrupt' });
    await writeFile(path, original);
  }
  await verifySemanticReference(f.storage, f.current, reference);
  const { rows: [row] } = await f.storage.read('SELECT artifact FROM execution_results WHERE request_id=$1', [fixed.action.requestId]);
  const artifact = structuredClone(row.artifact); artifact.resources[0].sha256 = 'f'.repeat(64);
  await f.transaction(tx => tx.query('UPDATE execution_results SET artifact=$2 WHERE request_id=$1', [fixed.action.requestId, JSON.stringify(artifact)]));
  await assert.rejects(verifySemanticReference(f.storage, f.current, reference), { code: 'corrupt' });
  await f.transaction(tx => tx.query('UPDATE execution_results SET artifact=$2,output=$3 WHERE request_id=$1',
    [fixed.action.requestId, JSON.stringify(row.artifact), JSON.stringify({ f: '0000', cout: '0', observationState: 'complete' })]));
  await assert.rejects(verifySemanticReference(f.storage, f.current, reference), { code: 'corrupt' });
});

test('an identical resource from another execution cannot replace an owned retained resource', { timeout: 120000 }, async t => {
  const f = await fixture(t), fixed = await f.result(await f.receive(f.fixed()));
  const reference = f.reference(fixed, 'alu-observation'), diagnostics = fixed.artifact.resources.find(item => item.name === 'diagnostics.txt');
  const foreignId = randomUUID();
  await f.storage.stageResource({ uploadId: foreignId, scope: `execution/${randomUUID()}`,
    bytes: Buffer.from(diagnostics.text), mediaType: diagnostics.mediaType, contentVersion: 1 });
  const { rows: [row] } = await f.storage.read('SELECT artifact FROM execution_results WHERE request_id=$1', [fixed.action.requestId]);
  row.artifact.resources.find(item => item.name === 'diagnostics.txt').contentId = foreignId;
  await f.transaction(async tx => {
    await tx.reference(`execution/${fixed.action.requestId}/resource/${foreignId}`, foreignId);
    await tx.query('UPDATE execution_results SET artifact=$2 WHERE request_id=$1', [fixed.action.requestId, JSON.stringify(row.artifact)]);
  });
  await assert.rejects(verifySemanticReference(f.storage, f.current, reference), { code: 'invalid' });
});

test('unreceived results and missing retained resources remain unavailable and retry the same original identity', { timeout: 120000 }, async t => {
  const f = await fixture(t), draft = f.fixed();
  const output = { f: '1101', cout: '0', observationState: 'complete' }, resources = [resource('trace.vcd', aluReferenceTrace)];
  const local = { ...draft, inputDigest: hash(JSON.stringify(draft.action)), executionRef: randomUUID(), contentId: randomUUID(),
    state: 'succeeded', artifact: { output, resources } };
  const reference = f.reference(local, 'alu-observation');
  await assert.rejects(verifySemanticReference(f.storage, f.current, reference), { code: 'unavailable' });
  const received = await f.receive(draft); reference.source.executionRef = received.executionRef;
  await assert.rejects(verifySemanticReference(f.storage, f.current, reference), { code: 'unavailable' });
  const fixed = await f.result(received, { contentId: local.contentId, output, resources });
  await verifySemanticReference(f.storage, f.current, reference);
  const path = await f.path(resources[0].contentId), bytes = await readFile(path);
  await rm(path);
  await assert.rejects(verifySemanticReference(f.storage, f.current, reference), { code: 'unavailable' });
  await writeFile(path, bytes);
  await verifySemanticReference(f.storage, f.current, reference);
  assert.equal(fixed.action.requestId, local.action.requestId);
});

test('ordinary runs and free observations preserve missing predictions and unknown/failed actual values', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  for (const operationId of ['run-single', 'observe-enabled']) {
    const original = f.fixed(); original.action.execution.operation.operationId = operationId;
    const state = JSON.parse(original.stateFile.value); state.content.caseDraft = ''; original.stateFile.value = JSON.stringify(state);
    const basisState = original.action.execution.basis.works.find(file => file.kind === 'state'); basisState.value = original.stateFile.value;
    const fixed = await f.result(await f.receive(original), { state: 'failed' });
    const reference = f.reference(fixed, 'alu-observation');
    assert.match(reference.copy, /原预测：F 未填写，Cout 未填写/);
    assert.match(reference.copy, /实际：未取得/);
    await verifySemanticReference(f.storage, f.current, reference);
    await f.transaction(tx => tx.query("UPDATE execution_commands SET status_knowledge='unknown',reason=$2 WHERE request_id=$1",
      [fixed.action.requestId, JSON.stringify({ code: 'worker-terminated', detail: 'The original receiver status is not confirmed.' })]));
    const unknown = f.reference({ ...fixed, state: 'unknown' }, 'alu-observation');
    assert.match(unknown.copy, /实际：未确认/);
    await verifySemanticReference(f.storage, f.current, unknown);
    await verifySemanticReference(f.storage, f.current, f.reference({ ...fixed, state: 'unknown' }, 'alu-waveform',
      { signalIds: ['tb.mirror[3:0]'], fromTick: '4', toTick: '9007199254740997' }));
  }
});

test('reflection references read immutable owner notes and history keeps unavailable adapters read-only', { timeout: 120000 }, async t => {
  const f = await fixture(t), fixed = await f.result(await f.receive(f.fixed()));
  const note = { formatVersion: 1, kind: 'alu-reflection', noteId: randomUUID(), activityId: f.current.activityId,
    bindingKey: f.component.key, instanceId: fixed.action.execution.instance.instanceId, definitionDigest: f.component.definition.digest,
    requestId: fixed.action.requestId, inputDigest: fixed.inputDigest, executionRef: fixed.executionRef, parentNoteId: null,
    text: '这是原用例的解释修订，保留我的缺项。' };
  const file = { objectId: note.noteId, contentId: note.noteId, kind: 'state', encoding: 'json', mediaType: ALU_REFLECTION_MEDIA_TYPE,
    name: aluReflectionName(note.bindingKey, note.noteId), value: JSON.stringify(note) };
  await f.works.registerBasis(f.identity, f.current.activityId, file);
  const reference = f.reference(fixed, 'alu-case');
  reference.source.objectId = note.noteId; reference.source.contentId = note.noteId;
  reference.range.typeId = 'alu-reflection'; reference.copy = aluReferenceCopy('alu-reflection', {}, { note, action: fixed.action });
  reference.range.end = reference.copy.length;
  await verifySemanticReference(f.storage, f.current, reference);
  await assert.rejects(verifySemanticReference(f.storage, f.current, { ...reference, copy: reference.copy.replace('保留', '删除') }), { code: 'invalid' });
  const future = { ...reference, range: { ...reference.range, typeId: 'retired-alu-reflection' } };
  await assert.rejects(verifySemanticReference(f.storage, f.current, future));
  await verifySemanticReference(f.storage, f.current, future, true);
  const execution = f.reference(fixed, 'alu-observation'); execution.range.typeId = 'retired-alu-observation';
  await assert.rejects(verifySemanticReference(f.storage, f.current, execution));
  await verifySemanticReference(f.storage, f.current, execution, true);
  await f.reopen();
  await verifySemanticReference(f.storage, f.current, reference);
  await verifySemanticReference(f.storage, f.current, execution, true);
});

test('a previously verified unknown observation remains a read-only snapshot when the original status later becomes confirmed', { timeout: 120000 }, async t => {
  const f = await fixture(t), fixed = await f.result(await f.receive(f.fixed()));
  await f.transaction(tx => tx.query("UPDATE execution_commands SET status_knowledge='unknown',reason=$2 WHERE request_id=$1",
    [fixed.action.requestId, JSON.stringify({ code: 'worker-terminated', detail: 'The original receiver status is not confirmed.' })]));
  const reference = f.reference({ ...fixed, state: 'unknown' }, 'alu-observation');
  await verifySemanticReference(f.storage, f.current, reference);
  await f.transaction(tx => tx.query("UPDATE execution_commands SET status_knowledge='confirmed' WHERE request_id=$1", [fixed.action.requestId]));
  await assert.rejects(verifySemanticReference(f.storage, f.current, reference), { code: 'invalid' });
  await verifySemanticReference(f.storage, f.current, reference, true);
  assert.match(reference.copy, /实际：未确认/);
  await assert.rejects(verifySemanticReference(f.storage, f.current,
    { ...reference, copy: reference.copy.replace('原预测：F=0101', '原预测：F=1111') }, true), { code: 'invalid' });
});
