import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { learningMigrations } from '@xunjie/learning-space';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { canonicalValue, courseExecutionPlanBasis, executionActionV3Schema } from '@xunjie/contracts/execution';
import { ALU_REFLECTION_MEDIA_TYPE, aluCaseFromAction, aluReflectionName, newAluCaseDraft } from '@xunjie/contracts/alu-learning';
import { aluReferenceCopy } from '@xunjie/contracts/alu-references';
import { createWorks, validateWorks } from '../../../packages/learning-space/dist/learning-data/works.js';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { aluCoursePackage } from '../../../components/alu-experiment/package.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonicalHash = value => hash(JSON.stringify(canonicalValue(value)));

async function fixture(t) {
  const pg = await nativeFixture();
  let storage;
  t.after(async () => { try { await storage?.close(); } finally { await pg.close(); } });
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomBytes(32).toString('base64url'),
    migrations: learningMigrations });
  const options = { binding, migrations: learningMigrations,
    backend: createFileBackend({ id: owner.serviceId, root: join(pg.root, 'reflections') }) };
  storage = await openStorage(options);
  const course = await aluCoursePackage();
  // An owner-contract fixture, not a toolchain run or a replacement for the published component.
  const component = course.release.components[0];
  const manifest = component.definition.manifest;
  manifest.version = 3; manifest.stateVersion = 3;
  manifest.stateShape.properties.caseDraft = { type: 'string', maxLength: 16000 };
  manifest.stateShape.properties.caseRequestId = { type: 'string', maxLength: 64 };
  manifest.initialState.caseDraft = ''; manifest.initialState.caseRequestId = '';
  component.definition.digest = hash(JSON.stringify(manifest));
  const plan = course.release.executionPlan;
  plan.components[0].definitionDigest = component.definition.digest;
  plan.planDigest = canonicalHash(courseExecutionPlanBasis(plan));
  const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'ALU student' };
  async function transaction(effect) {
    await storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, async tx => { await effect(tx); return null; });
  }
  async function activity(who = identity) {
    const value = activitySchema.parse({ activityId: randomUUID(), identity: who, target: { ...owner, version: 1 },
      goal: 'Explain a fixed ALU case', question: '', references: [], status: 'open', createdAt: new Date().toISOString(),
      course: { associationId: randomUUID(), courseId: course.course.courseId, courseName: course.course.name,
        taskId: course.task.taskId, taskTitle: course.task.title, ...course.release, materials: [], contentDigest: 'a'.repeat(64) } });
    await transaction(tx => tx.query('INSERT INTO activities VALUES($1,$2,$3,$4,$5)', [value.activityId,
      who.environmentId, who.spaceId, who.principalId, JSON.stringify(value)]));
    return value;
  }
  const current = await activity();
  const authorize = async (who, id) => {
    const { rows: [row] } = await storage.read('SELECT body FROM activities WHERE id=$1', [id]);
    if (!row || ['environmentId', 'spaceId', 'principalId'].some(key => row.body.identity[key] !== who[key])) throw new StorageError('missing');
    return activitySchema.parse(row.body);
  };
  const works = createWorks(storage, authorize);
  function caseOf(target = current) {
    const requestId = randomUUID(), executionRef = randomUUID();
    const enabledBy = { requestId: randomUUID(), inputDigest: 'b'.repeat(64), executionRef: randomUUID() };
    const draft = { ...newAluCaseDraft(randomUUID(), randomUUID()), predictedF: '0101', predictedCout: '0', reason: 'My frozen prediction' };
    const parameters = { A: 2, B: 3, M: 0, S: 0, Cin: 0 };
    const state = { formatVersion: 1, instanceId: `${target.activityId}:alu`, componentId: manifest.componentId,
      version: manifest.version, definitionDigest: component.definition.digest, stateVersion: 3, operationId: randomUUID(),
      content: { ...manifest.initialState, ...parameters, feedbackPolicy: 'hold', caseRequestId: requestId,
        caseDraft: JSON.stringify(draft), enabledBasis: JSON.stringify({ ...enabledBy, definitionDigest: component.definition.digest }) } };
    const stateFile = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/alu.json', kind: 'state', encoding: 'json',
      mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify(state) };
    const codeFile = { objectId: randomUUID(), contentId: randomUUID(), name: 'alu.sv', kind: 'code', encoding: 'utf8',
      mediaType: 'text/plain', value: 'module alu; endmodule\n' };
    const operation = manifest.runtime.operations.find(item => item.operationId === 'observe-enabled');
    const { operations: _operations, ...runtime } = manifest.runtime;
    const action = executionActionV3Schema.parse({ protocolVersion: 3, kind: 'execution', requestId,
      scope: { environmentId: target.identity.environmentId, spaceId: target.identity.spaceId,
        principalId: target.identity.principalId, activityId: target.activityId },
      receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' },
      execution: { instance: { instanceId: state.instanceId, key: 'alu', componentId: manifest.componentId,
        componentVersion: manifest.version, definitionDigest: component.definition.digest, hostApiVersion: 1, stateVersion: 3 },
        operation: { operationId: 'observe-enabled', effect: 'execute' }, parameters,
        basis: { enabledBy, works: [codeFile, stateFile], runtime, compile: operation.compile, observation: operation.observation,
          course: { releaseId: target.course.releaseId, behaviorRuleDigest: canonicalHash(target.course.requirements), planDigest: plan.planDigest },
          expected: { stateContentId: stateFile.contentId } },
        limits: { ...operation.budgets, concurrentJobs: 1, queuedJobs: 1 },
        plan: { planId: plan.planId, planVersion: plan.planVersion, planDigest: plan.planDigest, location: 'browser', kind: 'job' },
        initiator: { kind: 'student', principalId: target.identity.principalId } } });
    const inputDigest = hash(JSON.stringify(action));
    const acceptance = { receipt: { requestId, inputDigest, receiver: action.receiver, state: 'accepted',
      receiptId: 'browser:' + requestId, detail: 'Owner fixture received the fixed action' }, execution: { executionRef, acceptedSeq: 1 } };
    return { action, inputDigest, executionRef, acceptance };
  }
  function observationOf(operationId) {
    const source = caseOf();
    source.action.execution.operation.operationId = operationId;
    if (operationId === 'run-single') delete source.action.execution.basis.enabledBy;
    const file = source.action.execution.basis.works.find(item => item.kind === 'state');
    const state = JSON.parse(file.value);
    state.content.caseRequestId = ''; state.content.caseDraft = ''; state.content.feedbackPolicy = 'live';
    if (operationId === 'run-single') state.content.enabledBasis = '';
    file.value = JSON.stringify(state);
    source.action = executionActionV3Schema.parse(source.action);
    source.inputDigest = hash(JSON.stringify(source.action)); source.acceptance.receipt.inputDigest = source.inputDigest;
    return source;
  }
  async function receive(source) {
    // These are legal fixed commands and receiver facts in this owner's real PG tables. No WASM simulation is claimed.
    const { rows: [row] } = await storage.read('SELECT body FROM activities WHERE id=$1', [source.action.scope.activityId]);
    for (const file of source.action.execution.basis.works) await works.registerBasis(row.body.identity, source.action.scope.activityId, file);
    await transaction(tx => tx.query(`INSERT INTO execution_commands(request_id,activity_id,input_digest,execution_ref,body,
      acceptance,state,status_knowledge,confirmed_seq,action_text) VALUES($1,$2,$3,$4,$5,$6,'queued','confirmed',1,$7)`,
    [source.action.requestId, source.action.scope.activityId, source.inputDigest, source.executionRef,
      JSON.stringify(source.action), JSON.stringify(source.acceptance), JSON.stringify(source.action)]));
  }
  function reflection(source, overrides = {}) {
    const note = { formatVersion: 1, kind: 'alu-reflection', noteId: randomUUID(), activityId: source.action.scope.activityId,
      bindingKey: source.action.execution.instance.key, instanceId: source.action.execution.instance.instanceId,
      definitionDigest: source.action.execution.instance.definitionDigest, requestId: source.action.requestId,
      inputDigest: source.inputDigest, executionRef: source.executionRef, parentNoteId: null, text: 'I will revise my explanation.', ...overrides };
    return { objectId: note.noteId, contentId: note.noteId, name: aluReflectionName(note.bindingKey, note.noteId), kind: 'state',
      encoding: 'json', mediaType: ALU_REFLECTION_MEDIA_TYPE, value: JSON.stringify(note) };
  }
  return { get storage() { return storage; }, resourceRoot: join(pg.root, 'reflections'), current, identity, works, activity, caseOf, observationOf, receive, reflection, transaction,
    async reopen() { await storage.close(); storage = await openStorage(options); return createWorks(storage, authorize); } };
}

test('works waits for the original case command and then retries the same immutable reflection', { timeout: 120000 }, async t => {
  const f = await fixture(t), source = f.caseOf(), file = f.reflection(source);
  const input = { requestId: randomUUID(), baseRevision: 0, files: [file] };
  await assert.rejects(f.works.sync(f.identity, f.current.activityId, input), { code: 'unavailable' });
  assert.equal(await f.works.receipt(f.identity, f.current.activityId, input.requestId), null);
  assert.deepEqual(await f.works.read(f.identity, f.current.activityId), { revision: 0, files: [] });
  await f.receive(source);
  const saved = await f.works.sync(f.identity, f.current.activityId, input);
  assert.deepEqual(saved, { revision: 1, files: [file] });
  assert.deepEqual(await f.works.sync(f.identity, f.current.activityId, input), saved);
  await validateWorks(f.storage);
});

test('ALU maintenance refuses a reported observation until its original result bytes are retained', { timeout: 120000 }, async t => {
  const { createExecutions, validateExecutions } = await import('../../../packages/learning-space/dist/learning-data/executions.js');
  const f = await fixture(t), source = f.observationOf('run-single');
  const executions = createExecutions(f.storage, { works: f.works, activity: async () => f.current });
  const accepted = await executions.accept(f.identity, f.current.activityId, { action: source.action, acceptance: source.acceptance });
  const output = { f: '0101', cout: '0', observationState: 'complete' }, text = JSON.stringify(output), contentId = randomUUID();
  const artifact = { name: 'observation.json', mediaType: 'application/json', sha256: hash(text), byteLength: Buffer.byteLength(text) };
  await executions.report(f.identity, f.current.activityId, source.action.requestId, { ...accepted,
    state: 'succeeded', confirmedSeq: accepted.confirmedSeq + 1, output: { contentId, output, artifact } });
  await assert.rejects(validateExecutions(f.storage), { code: 'corrupt' },
    'a terminal HTTP report alone cannot establish a complete backup of the observation');
  await assert.rejects(executions.shutdown(), { code: 'unavailable' },
    'keep the original retention channel open until the reported result has actually arrived');
  const trace = '$timescale 1ns $end\n$scope module alu $end\n$var wire 4 ! F $end\n$upscope $end\n$enddefinitions $end\n#0\nb0101 !\n';
  const wave = { contentId: randomUUID(), name: 'trace.vcd', mediaType: 'text/plain', text: trace,
    sha256: hash(trace), byteLength: Buffer.byteLength(trace) };
  const retained = { contentId, output, text, ...artifact, resources: [wave] };
  await executions.result(f.identity, f.current.activityId, source.action.requestId, retained);
  await validateExecutions(f.storage);
  await executions.shutdown();
  await executions.result(f.identity, f.current.activityId, source.action.requestId, retained);
  const history = await executions.history(f.identity, f.current.activityId);
  assert.equal(history.entries.length, 1);
  assert.deepEqual([history.entries[0].query.requestId, history.entries[0].query.inputDigest, history.entries[0].query.executionRef],
    [source.action.requestId, source.inputDigest, source.executionRef]);
  assert.equal((await executions.artifact(f.identity, f.current.activityId, source.action.requestId)).text, text);
  const path = join(f.resourceRoot, (await f.storage.resource(wave.contentId)).locator.key);
  const original = await readFile(path), corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
  try {
    await writeFile(path, corrupt);
    await assert.rejects(validateExecutions(f.storage), { code: 'corrupt' }, 'the ALU owner validates the actual retained VCD bytes');
    await rm(path);
    await assert.rejects(validateExecutions(f.storage), 'the ALU owner cannot substitute a missing original VCD');
  } finally { await writeFile(path, original); }
  await validateExecutions(f.storage);
});

test('original runs and free observations retain explanations without creating a prediction or rerunning', { timeout: 120000 }, async t => {
  const { readAluReflectionSource } = await import('../../../packages/learning-space/dist/learning-data/alu-reflections.js');
  const f = await fixture(t), saved = [];
  for (const operationId of ['run-single', 'observe-enabled']) {
    const source = f.observationOf(operationId);
    assert.equal(aluCaseFromAction(source.action), null);
    await f.receive(source);
    const file = f.reflection(source, { text: 'I explained the original observation after seeing it.' });
    await f.works.sync(f.identity, f.current.activityId, { requestId: randomUUID(), baseRevision: saved.length, files: [...saved.map(item => item.file), file] });
    const reference = { objectId: file.objectId, contentId: file.contentId };
    const read = await readAluReflectionSource(f.storage, f.current, reference);
    assert.deepEqual(read.action, source.action);
    assert.match(aluReferenceCopy('alu-reflection', {}, read), /原预测：F 未填写，Cout 未填写/);
    saved.push({ file, reference, action: source.action });
  }
  await f.reopen();
  for (const item of saved) {
    const read = await readAluReflectionSource(f.storage, f.current, item.reference);
    assert.deepEqual(read.action, item.action);
    assert.equal(aluCaseFromAction(read.action), null);
    assert.match(aluReferenceCopy('alu-reflection', {}, read), /原预测：F 未填写，Cout 未填写/);
  }
  await validateWorks(f.storage);
});

test('reflection, result references and maintenance agree on the original execution facts', { timeout: 120000 }, async t => {
  const { createExecutions, validateExecutions } = await import('../../../packages/learning-space/dist/learning-data/executions.js');
  const { readAluReflectionSource } = await import('../../../packages/learning-space/dist/learning-data/alu-reflections.js');
  const { verifySemanticReference } = await import('../../../packages/learning-space/dist/learning-data/semantic-references.js');
  const f = await fixture(t), source = f.observationOf('run-single');
  const executions = createExecutions(f.storage, { works: f.works, activity: async (identity, activityId) => {
    assert.deepEqual(identity, f.identity); assert.equal(activityId, f.current.activityId); return f.current;
  } });
  const accepted = await executions.accept(f.identity, f.current.activityId, { action: source.action, acceptance: source.acceptance });
  const output = { f: '0101', cout: '0', observationState: 'complete' }, text = JSON.stringify(output), contentId = randomUUID();
  const produced = await executions.result(f.identity, f.current.activityId, source.action.requestId,
    { contentId, output, text, name: 'observation.json', mediaType: 'application/json', sha256: hash(text), byteLength: Buffer.byteLength(text) });
  await executions.report(f.identity, f.current.activityId, source.action.requestId,
    { ...produced, state: 'succeeded', statusKnowledge: 'confirmed', confirmedSeq: accepted.confirmedSeq + 1 });
  const note = f.reflection(source), noteRef = { objectId: note.objectId, contentId: note.contentId };
  await f.works.registerBasis(f.identity, f.current.activityId, note);
  const instance = source.action.execution.instance;
  const reference = { referenceId: randomUUID(), sourceName: 'Original ALU observation',
    source: { kind: 'component', formatVersion: 1, environmentId: f.identity.environmentId, spaceId: f.identity.spaceId,
      principalId: f.identity.principalId, activityId: f.current.activityId, instanceId: instance.instanceId,
      componentId: instance.componentId, componentVersion: instance.componentVersion, definitionDigest: instance.definitionDigest,
      bindingKey: instance.key, objectId: source.action.requestId, contentId, origin: 'execution-result',
      requestId: source.action.requestId, executionRef: source.executionRef },
    range: { kind: 'semantic', formatVersion: 1, typeId: 'alu-observation', version: 1, target: {}, start: 0, end: 1 },
    copy: aluReferenceCopy('alu-observation', {}, { action: source.action, output, state: 'succeeded', resources: [] }) };
  reference.range.end = reference.copy.length;
  const verify = async () => {
    await readAluReflectionSource(f.storage, f.current, noteRef);
    await verifySemanticReference(f.storage, f.current, reference);
    await validateExecutions(f.storage);
  };
  await verify();
  const damaged = { ...source.acceptance, execution: { ...source.acceptance.execution, acceptedSeq: 3 } };
  await f.transaction(tx => tx.query('UPDATE execution_commands SET acceptance=$2 WHERE request_id=$1',
    [source.action.requestId, JSON.stringify(damaged)]));
  await assert.rejects(readAluReflectionSource(f.storage, f.current, noteRef), { code: 'invalid' });
  await assert.rejects(verifySemanticReference(f.storage, f.current, reference), { code: 'corrupt' });
  await assert.rejects(validateExecutions(f.storage), { code: 'corrupt' });
  await f.transaction(tx => tx.query('UPDATE execution_commands SET acceptance=$2,action_text=NULL WHERE request_id=$1',
    [source.action.requestId, JSON.stringify(source.acceptance)]));
  await verify(); // The schema-projected fallback for rows predating action_text stays readable.
  await f.transaction(tx => tx.query('UPDATE activities SET principal_id=$2 WHERE id=$1', [f.current.activityId, randomUUID()]));
  await assert.rejects(readAluReflectionSource(f.storage, f.current, noteRef), { code: 'invalid' });
  await assert.rejects(verifySemanticReference(f.storage, f.current, reference), { code: 'invalid' });
  await assert.rejects(validateExecutions(f.storage), { code: 'corrupt' });
  await f.transaction(tx => tx.query('UPDATE activities SET principal_id=$2 WHERE id=$1', [f.current.activityId, f.identity.principalId]));
  await f.reopen();
  await verify();
});

test('sync and fixed basis reject forged case identities without changing ordinary works', { timeout: 120000 }, async t => {
  const f = await fixture(t), source = f.caseOf();
  await f.receive(source);
  for (const change of [{ activityId: randomUUID() }, { instanceId: `${f.current.activityId}:other` },
    { bindingKey: 'other' }, { definitionDigest: 'c'.repeat(64) }, { inputDigest: 'c'.repeat(64) }, { executionRef: randomUUID() }]) {
    const file = f.reflection(source, change);
    await assert.rejects(f.works.sync(f.identity, f.current.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] }),
      { code: 'invalid' }, JSON.stringify(change));
    await assert.rejects(f.works.registerBasis(f.identity, f.current.activityId, file), { code: 'invalid' }, JSON.stringify(change));
  }
  const other = await f.activity();
  const relocated = f.reflection(source, { activityId: other.activityId, instanceId: `${other.activityId}:alu` });
  await assert.rejects(f.works.sync(f.identity, other.activityId, { requestId: randomUUID(), baseRevision: 0, files: [relocated] }), { code: 'invalid' });
  const file = f.reflection(source);
  for (const changed of [{ ...file, objectId: randomUUID() }, { ...file, contentId: randomUUID() },
    { ...file, name: 'renamed.json' }, { ...file, kind: 'text' }, { ...file, encoding: 'utf8' },
    { ...file, value: JSON.stringify({ ...JSON.parse(file.value), f: '1111' }) }]) {
    await assert.rejects(f.works.registerBasis(f.identity, f.current.activityId, changed), { code: 'invalid' });
  }
  const ordinary = { objectId: randomUUID(), contentId: randomUUID(), name: 'ordinary.json', kind: 'state', encoding: 'json',
    mediaType: 'application/json', value: '{"ordinary":"state"}' };
  assert.deepEqual((await f.works.sync(f.identity, f.current.activityId, { requestId: randomUUID(), baseRevision: 0, files: [ordinary] })).files, [ordinary]);
});

test('one sync accepts an out-of-order parent chain and rejects loops or another case as its parent', { timeout: 120000 }, async t => {
  const f = await fixture(t), source = f.caseOf(), otherCase = f.caseOf();
  await f.receive(source); await f.receive(otherCase);
  const missing = f.reflection(source, { parentNoteId: randomUUID() });
  await assert.rejects(f.works.sync(f.identity, f.current.activityId,
    { requestId: randomUUID(), baseRevision: 0, files: [missing] }), { code: 'unavailable' });
  const first = f.reflection(source), second = f.reflection(source, { parentNoteId: first.objectId, text: 'Second explanation' });
  const third = f.reflection(source, { parentNoteId: second.objectId, text: 'Third explanation' });
  const saved = await f.works.sync(f.identity, f.current.activityId,
    { requestId: randomUUID(), baseRevision: 0, files: [third, second, first] });
  assert.deepEqual(saved.files, [third, second, first]);
  const selfId = randomUUID(), a = randomUUID(), b = randomUUID();
  for (const files of [[f.reflection(source, { noteId: selfId, parentNoteId: selfId })],
    [f.reflection(source, { noteId: a, parentNoteId: b }), f.reflection(source, { noteId: b, parentNoteId: a })],
    [f.reflection(otherCase, { parentNoteId: first.objectId })]]) {
    await assert.rejects(f.works.sync(f.identity, f.current.activityId,
      { requestId: randomUUID(), baseRevision: saved.revision, files: [...saved.files, ...files] }), { code: 'invalid' });
  }
  const last = f.reflection(source, { parentNoteId: third.objectId });
  await f.works.registerBasis(f.identity, f.current.activityId, last);
  assert.equal((await f.works.read(f.identity, f.current.activityId)).revision, 1, 'retaining a fixed explanation never moves the head');
  await validateWorks(f.storage);
});

test('a child-only question draft retries its original request after the parent work reaches PostgreSQL', { timeout: 120000 }, async t => {
  const { createQuestionDrafts, draftIdFor } = await import('../../../packages/learning-space/dist/learning-data/drafts.js');
  const f = await fixture(t), source = f.caseOf();
  await f.receive(source);
  const parent = f.reflection(source), child = f.reflection(source, { parentNoteId: parent.objectId, text: 'A legitimate second revision.' });
  const instance = source.action.execution.instance;
  const copy = aluReferenceCopy('alu-reflection', {}, { note: JSON.parse(child.value), action: source.action });
  const reference = { referenceId: randomUUID(), sourceName: 'ALU explanation',
    source: { kind: 'component', formatVersion: 1, environmentId: f.identity.environmentId, spaceId: f.identity.spaceId,
      principalId: f.identity.principalId, activityId: f.current.activityId, instanceId: instance.instanceId,
      componentId: instance.componentId, componentVersion: instance.componentVersion, definitionDigest: instance.definitionDigest,
      bindingKey: instance.key, objectId: child.objectId, contentId: child.contentId, origin: 'state', requestId: null, executionRef: null },
    range: { kind: 'semantic', formatVersion: 1, typeId: 'alu-reflection', version: 1, target: {}, start: 0, end: copy.length }, copy };
  const drafts = createQuestionDrafts(f.storage, { activity: async () => f.current, works: f.works,
    courses: { verifyComponentReference: async () => {} } });
  const input = { requestId: randomUUID(), draftId: draftIdFor(f.current.activityId), baseRevision: 0,
    question: 'Keep this question and both original identities.', references: [reference], bases: [child] };
  const original = structuredClone(input);
  await assert.rejects(drafts.sync(f.identity, f.current.activityId, input), { code: 'unavailable' });
  assert.equal(await drafts.receipt(f.identity, f.current.activityId, input.requestId), null);
  await f.works.sync(f.identity, f.current.activityId, { requestId: randomUUID(), baseRevision: 0, files: [child, parent] });
  const saved = await drafts.sync(f.identity, f.current.activityId, input);
  assert.equal(saved.revision, 1);
  assert.equal(saved.question, input.question);
  assert.equal(saved.references[0].copy, copy);
  assert.deepEqual(await drafts.receipt(f.identity, f.current.activityId, input.requestId), saved);
  assert.deepEqual(await drafts.sync(f.identity, f.current.activityId, input), saved);
  assert.deepEqual(input, original);
});

test('a note cannot be replaced through new content identities or a different media type', { timeout: 120000 }, async t => {
  const f = await fixture(t), source = f.caseOf();
  await f.receive(source);
  const file = f.reflection(source);
  const saved = await f.works.sync(f.identity, f.current.activityId,
    { requestId: randomUUID(), baseRevision: 0, files: [file] });
  for (const changed of [{ ...file, value: JSON.stringify({ ...JSON.parse(file.value), text: 'rewritten old note' }) },
    { ...file, contentId: randomUUID(), mediaType: 'application/json', value: '{"replacement":true}' }]) {
    await assert.rejects(f.works.sync(f.identity, f.current.activityId,
      { requestId: randomUUID(), baseRevision: 1, files: [changed] }), { code: 'identity-conflict' });
    await assert.rejects(f.works.registerBasis(f.identity, f.current.activityId, changed), { code: 'identity-conflict' });
  }
  assert.deepEqual(await f.works.read(f.identity, f.current.activityId), saved);
  assert.deepEqual(await f.works.registerBasis(f.identity, f.current.activityId, file), { objectId: file.objectId, contentId: file.contentId });
  await f.works.sync(f.identity, f.current.activityId, { requestId: randomUUID(), baseRevision: 1, files: [] });
  assert.deepEqual(await f.works.registerBasis(f.identity, f.current.activityId, file), { objectId: file.objectId, contentId: file.contentId },
    'a deleted note retains its original bytes without clearing its tombstone');
  await assert.rejects(f.works.sync(f.identity, f.current.activityId,
    { requestId: randomUUID(), baseRevision: 2, files: [file] }), { code: 'identity-conflict' });
});

test('trusted reads retain original explanations and actions after deletion and owner reopen', { timeout: 120000 }, async t => {
  const { readAluReflectionSource } = await import('../../../packages/learning-space/dist/learning-data/alu-reflections.js');
  const f = await fixture(t), source = f.caseOf();
  await f.receive(source);
  const parent = f.reflection(source), file = f.reflection(source, { parentNoteId: parent.objectId, text: 'My revised explanation' });
  await f.works.sync(f.identity, f.current.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file, parent] });
  const reference = { objectId: file.objectId, contentId: file.contentId };
  const expected = { note: JSON.parse(file.value), action: source.action, file };
  assert.deepEqual(await readAluReflectionSource(f.storage, f.current, reference), expected);
  await assert.rejects(readAluReflectionSource(f.storage, f.current, { ...reference, objectId: randomUUID() }), { code: 'invalid' });
  const other = await f.activity();
  await assert.rejects(readAluReflectionSource(f.storage, other, reference), { code: 'invalid' });
  await f.works.sync(f.identity, f.current.activityId, { requestId: randomUUID(), baseRevision: 1, files: [] });
  const reopened = await f.reopen();
  assert.deepEqual(await reopened.read(f.identity, f.current.activityId), { revision: 2, files: [] });
  assert.deepEqual(await readAluReflectionSource(f.storage, f.current, reference), expected);
  await validateWorks(f.storage);
  await f.transaction(tx => tx.query('UPDATE work_contents SET media_type=$2 WHERE content_id=$1', [file.contentId, 'application/json']));
  await assert.rejects(readAluReflectionSource(f.storage, f.current, reference), { code: 'invalid' });
});

test('recovery checks historical and fixed-only explanations against the real execution rows', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  for (const published of [false, true]) {
    const source = f.caseOf(), file = f.reflection(source);
    await f.receive(source);
    if (published) {
      await f.works.sync(f.identity, f.current.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] });
      await f.works.sync(f.identity, f.current.activityId, { requestId: randomUUID(), baseRevision: 1, files: [] });
    } else await f.works.registerBasis(f.identity, f.current.activityId, file);
    await validateWorks(f.storage);
    await f.transaction(tx => tx.query('UPDATE execution_commands SET input_digest=$2 WHERE request_id=$1', [source.action.requestId, 'c'.repeat(64)]));
    await assert.rejects(validateWorks(f.storage), { code: 'corrupt' }, published ? 'historical version' : 'fixed-only basis');
    await f.transaction(tx => tx.query('UPDATE execution_commands SET input_digest=$2 WHERE request_id=$1', [source.action.requestId, source.inputDigest]));
    await validateWorks(f.storage);
    const movedId = randomUUID();
    await f.transaction(tx => tx.query('UPDATE execution_commands SET request_id=$2 WHERE request_id=$1', [source.action.requestId, movedId]));
    await assert.rejects(validateWorks(f.storage), { code: 'corrupt' });
    await f.transaction(tx => tx.query('UPDATE execution_commands SET request_id=$2 WHERE request_id=$1', [movedId, source.action.requestId]));
  }
  await validateWorks(f.storage);
});

test('trusted reads reject rewritten fixed predictions, command text and receiver facts', { timeout: 120000 }, async t => {
  const { readAluReflectionSource } = await import('../../../packages/learning-space/dist/learning-data/alu-reflections.js');
  const f = await fixture(t), source = f.caseOf();
  await f.receive(source);
  const file = f.reflection(source), reference = { objectId: file.objectId, contentId: file.contentId };
  await f.works.registerBasis(f.identity, f.current.activityId, file);
  const changed = structuredClone(source.action);
  const stateFile = changed.execution.basis.works.find(item => item.kind === 'state');
  const state = JSON.parse(stateFile.value), draft = JSON.parse(state.content.caseDraft);
  state.content.caseDraft = JSON.stringify({ ...draft, predictedF: '1111', reason: 'rewritten after the run' });
  stateFile.value = JSON.stringify(state);
  await f.transaction(tx => tx.query('UPDATE execution_commands SET body=$2 WHERE request_id=$1', [source.action.requestId, JSON.stringify(changed)]));
  await assert.rejects(readAluReflectionSource(f.storage, f.current, reference), { code: 'invalid' });
  await f.transaction(tx => tx.query('UPDATE execution_commands SET body=$2,action_text=$3 WHERE request_id=$1',
    [source.action.requestId, JSON.stringify(source.action), JSON.stringify(changed)]));
  await assert.rejects(readAluReflectionSource(f.storage, f.current, reference), { code: 'invalid' });
  await f.transaction(tx => tx.query('UPDATE execution_commands SET action_text=$2,acceptance=$3 WHERE request_id=$1',
    [source.action.requestId, JSON.stringify(source.action), JSON.stringify({ ...source.acceptance, execution: { executionRef: randomUUID(), acceptedSeq: 1 } })]));
  await assert.rejects(readAluReflectionSource(f.storage, f.current, reference), { code: 'invalid' });
});

test('a self-consistent received command still must be an ALU observation for this activity and principal', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  function editState(source, change) {
    const file = source.action.execution.basis.works.find(item => item.kind === 'state');
    const state = JSON.parse(file.value); change(state); file.value = JSON.stringify(state);
  }
  const mutations = [
    ['full check', source => { source.action.execution.operation.operationId = 'check-all'; source.action.execution.parameters = {}; }],
    ['wrong instance', source => { source.action.execution.instance.instanceId = `${f.current.activityId}:another`; }],
    ['invalid controls', source => { source.action.execution.parameters.A = 16; }],
    ['old state version', source => { source.action.execution.instance.stateVersion = 2; editState(source, state => { state.stateVersion = 2; }); }],
  ];
  for (const [name, mutate] of mutations) {
    const source = f.caseOf(); mutate(source);
    source.action = executionActionV3Schema.parse(source.action);
    source.inputDigest = hash(JSON.stringify(source.action));
    source.acceptance.receipt.inputDigest = source.inputDigest;
    await f.receive(source);
    const file = f.reflection(source, { instanceId: `${f.current.activityId}:alu` });
    await assert.rejects(f.works.sync(f.identity, f.current.activityId,
      { requestId: randomUUID(), baseRevision: 0, files: [file] }), { code: 'invalid' }, name);
    await assert.rejects(f.works.registerBasis(f.identity, f.current.activityId, file), { code: 'invalid' }, name);
  }
  for (const who of [f.identity, { ...f.identity, principalId: randomUUID(), name: 'Other student' }]) {
    const other = await f.activity(who), source = f.caseOf(other);
    await f.receive(source);
    const relocated = f.reflection(source, { activityId: f.current.activityId, instanceId: `${f.current.activityId}:alu` });
    await assert.rejects(f.works.registerBasis(f.identity, f.current.activityId, relocated), { code: 'invalid' });
  }
});

test('concurrent fixed registrations cannot give a note object another content identity', { timeout: 120000 }, async t => {
  const f = await fixture(t), source = f.caseOf();
  await f.receive(source);
  const note = f.reflection(source);
  const ordinary = { ...note, contentId: randomUUID(), mediaType: 'application/json', value: '{"ordinary":true}' };
  const results = await Promise.allSettled([note, ordinary].map(file => f.works.registerBasis(f.identity, f.current.activityId, file)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'identity-conflict');
  const winner = results[0].status === 'fulfilled' ? note : ordinary;
  assert.equal((await f.works.content(f.identity, f.current.activityId, winner.contentId)).value, winner.value);
  await validateWorks(f.storage);
});

test('ordinary objects still retain multiple contents and fixed references after deletion', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const file = { objectId: randomUUID(), contentId: randomUUID(), kind: 'state', encoding: 'json', name: 'ordinary.json',
    mediaType: 'application/json', value: '{"revision":1}' };
  const later = { ...file, contentId: randomUUID(), value: '{"revision":2}' };
  await f.works.sync(f.identity, f.current.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] });
  await f.works.sync(f.identity, f.current.activityId, { requestId: randomUUID(), baseRevision: 1, files: [later] });
  await f.works.sync(f.identity, f.current.activityId, { requestId: randomUUID(), baseRevision: 2, files: [] });
  const historical = { ...file, contentId: randomUUID(), value: '{"historical":true}' };
  const authorizeOnly = createWorks(f.storage, async (identity, activityId) => {
    assert.deepEqual(identity, f.identity); assert.equal(activityId, f.current.activityId);
  });
  assert.deepEqual(await authorizeOnly.registerBasis(f.identity, f.current.activityId, historical),
    { objectId: historical.objectId, contentId: historical.contentId }, 'ordinary fixed registration keeps its original authorize-only contract');
  for (const retained of [file, later, historical]) {
    assert.deepEqual(await f.works.registerBasis(f.identity, f.current.activityId, retained), { objectId: retained.objectId, contentId: retained.contentId });
    assert.equal((await f.works.content(f.identity, f.current.activityId, retained.contentId)).value, retained.value);
  }
  assert.deepEqual(await f.works.read(f.identity, f.current.activityId), { revision: 3, files: [] });
  await validateWorks(f.storage);
});

test('trusted reads use the owned activity binding and verify its actual principal columns', { timeout: 120000 }, async t => {
  const { readAluReflectionSource } = await import('../../../packages/learning-space/dist/learning-data/alu-reflections.js');
  const f = await fixture(t), source = f.caseOf(), file = f.reflection(source);
  await f.receive(source);
  await f.works.registerBasis(f.identity, f.current.activityId, file);
  const callerCopy = structuredClone(f.current);
  callerCopy.course.components[0].definition.digest = 'c'.repeat(64);
  const reference = { objectId: file.objectId, contentId: file.contentId };
  assert.deepEqual((await readAluReflectionSource(f.storage, callerCopy, reference)).action, source.action,
    'a caller-supplied definition summary cannot replace the stored course binding');
  await f.transaction(tx => tx.query('UPDATE activities SET principal_id=$2 WHERE id=$1', [f.current.activityId, randomUUID()]));
  await assert.rejects(readAluReflectionSource(f.storage, f.current, reference), { code: 'invalid' });
});
