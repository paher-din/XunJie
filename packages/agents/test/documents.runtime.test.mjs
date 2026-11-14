import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createLearningData, learningMigrations } from '@xunjie/learning-space/learning-data';
import { createAgentSessions, agentSessionMigration } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createSessionMaterials, sessionMaterialMigration } from '@xunjie/learning-space/learning-data/session-materials';
import { createDocumentTools } from '../dist/capabilities/documents/index.js';
import { fixedPdf } from '../../../apps/server/tests/fixtures/pdf-material.mjs';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { personalProjectContentSchema } from '@xunjie/contracts/student-learning';

const textInput = text => ({ requestId: randomUUID(), materialId: randomUUID(), name: 'notes.md',
  mediaType: 'text/markdown', dataBase64: Buffer.from(text).toString('base64') });
async function fixture(t) {
  const pg = await nativeFixture(), handles = [], gateways = [];
  t.after(async () => { try {
    for (const gateway of gateways) { gateway.closeWrites(); await gateway.checks.drain(); }
    for (const storage of handles.reverse()) await storage.close();
  } finally { await pg.close(); } });
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const migrations = [...learningMigrations.filter(m => m.version < 31), agentSessionMigration, sessionMaterialMigration,
    ...learningMigrations.filter(m => m.version > 32)];
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations });
  const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: 'files', root: pg.root + '/objects' }) }); handles.push(storage);
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  let allowed = true;
  const authorize = async () => { if (!allowed) throw new StorageError('forbidden'); };
  const data = createLearningData(storage, { resolveBinding: async () => { await authorize(); return { ...owner, version: 1 }; } });
  const sessions = createAgentSessions(storage, { authorize, openActivity: data.open,
    resolveOwner: async () => ({ version: 1, connectionId: randomUUID(), installationId: randomUUID(),
      target: { environmentId: randomUUID(), serviceId: randomUUID(), unit: 'teaching-agent', endpoint: 'https://agent.example.test', protocolVersion: 1, capabilities: [] } }) });
  const materials = createSessionMaterials(storage, { openScope: async (actor, scope) => {
    await authorize(); return scope.kind === 'session' ? sessions.read(actor, scope.sessionId) : data.open(actor, scope.activityId);
  } });
  // The Agent receives only the cross-owner document port; setup and adoption keep the management library.
  const documentMaterials = {
    personal: { list: materials.personal.list, original: materials.personal.original, readRange: materials.personal.readRange },
    pdf: { list: materials.pdf.list, document: materials.pdf.document, reading: materials.pdf.reading, read: materials.pdf.read },
    search: materials.search,
  };
  async function modelRoute(ctx, imageInput) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: owner.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: modelMigrations });
    const modelStorage = await openStorage({ binding, migrations: modelMigrations,
      backend: createFileBackend({ id: 'models', root: pg.root + '/models-' + binding.owner.serviceId }) }); handles.push(modelStorage);
    const gateway = await createModelGateway(modelStorage, { authorize, holder: 'device', supplierFetch: async () => { throw new Error('documents must not start a model request'); } });
    gateways.push(gateway);
    async function select(images) {
      const connectionId = randomUUID(), grantId = randomUUID();
      await gateway.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'fixed documents route',
        protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:9/v1', path: '/chat/completions', modelId: 'documents-fixture',
        dialect: 'standard', parameterMode: 'plain', enabled: true, imageInput: images, contextWindow: 65536, maxOutputTokens: 2048,
        credential: { action: 'replace', value: 'synthetic-document-test-key' } });
      await gateway.selection.createGrant(identity, identity, { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
      const current = await gateway.selection.read(identity);
      await gateway.selection.save(identity, { requestId: randomUUID(), expectedVersion: current.version, source: { kind: 'personal', connectionId, grantId } });
    }
    await select(imageInput);
    const selected = await gateway.selection.read(identity), pinId = randomUUID(), segmentId = randomUUID();
    await gateway.selection.pin(identity, pinId, selected.version);
    await gateway.segments.create(identity, { requestId: randomUUID(), segmentId, sessionId: ctx.snapshot.session.sessionId,
      purpose: 'learning', source: { selected: true, selectionVersion: selected.version, pinId }, prefix: { system: '', tools: [] }, portable: [] });
    const fixed = await gateway.segments.read(identity, segmentId);
    ctx.snapshot.steps[0].operation.input.segmentId = segmentId;
    ctx.snapshot.steps[0].snapshot.model = fixed.connection;
    return { gateway, select, segmentId };
  }
  async function context(activity) {
    const session = await sessions.create(identity, { requestId: randomUUID(), sessionId: randomUUID(),
      scenario: activity ? 'workspace-assistant' : 'student-assistant',
      ...(activity ? { workspace: { activityId: activity.activityId, target: activity.target } } : {}) });
    const inputId = randomUUID(), runId = randomUUID();
    const ctx = { basisStepId: randomUUID(), inputIds: [inputId], context: { system: '', facts: activity ? { workspace: activity } : {}, sources: [] },
      snapshot: { session: { sessionId: session.sessionId, identity, scenario: session.scenario, restartPolicy: 'explicit', createdAt: session.createdAt },
        run: { runId, sessionId: session.sessionId, inputId, generation: 1 }, steps: [], inputs: [], waits: [], state: {}, sessionState: {} } };
    ctx.snapshot.steps.push({ stepId: ctx.basisStepId, operation: { kind: 'model.call', operationId: randomUUID(), input: { segmentId: randomUUID() } },
      snapshot: { context: ctx.context, inputIds: ctx.inputIds }, state: 'completed', result: null });
    return ctx;
  }
  return { pg, storage, handles, identity, owner, data, sessions, materials, documentMaterials, context, modelRoute, deny: () => { allowed = false; } };
}
async function prepare(tools, ctx, name, args, commandId = randomUUID()) {
  const offer = (await tools.list(ctx)).find(offer => offer.definition.name === name);
  assert.ok(offer, name + ' must be installed');
  return tools.prepare(ctx, offer, { callId: 'native-tool', name, arguments: args }, commandId);
}
async function dispatch(tools, ctx, command, assertDispatch = async () => {}) {
  const stepId = randomUUID();
  ctx.snapshot.steps.push({ stepId, operation: { kind: 'tool.call', operationId: command.commandId, input: { command } } });
  return tools.dispatch(ctx, command, { sessionId: ctx.snapshot.session.sessionId, runId: ctx.snapshot.run.runId,
    operationId: command.commandId, stepId, generation: 1 }, assertDispatch);
}

test('catalogue and reads supply host-owned references directly accepted by project creation', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), scope = { kind: 'session', sessionId: ctx.snapshot.session.sessionId };
  const source = { sourceId: 'local-personal', owner: { ...f.owner, version: 1 } };
  const material = await f.materials.personal.receive(f.identity, scope, textInput('项目依据 37 volts'));
  const doc = await f.materials.pdf.upload(f.identity, scope, { requestId: randomUUID(), documentId: randomUUID(),
    name: 'project.pdf', dataBase64: fixedPdf().toString('base64') });
  const tools = createDocumentTools({ materials: f.documentMaterials, source });
  const catalogue = await dispatch(tools, ctx, await prepare(tools, ctx, 'list_materials', {}));
  const references = catalogue.result.items.map(item => item.reference);
  const content = { title: '测量电压', goal: '依据附件建立项目', stages: [{ title: '测量', goal: '验证电压' }], materialRefs: references };
  assert.deepEqual(personalProjectContentSchema.parse(content), content);
  const { name, ...identity } = f.identity;
  const textRef = { ...source, identity, scope, kind: 'personal-material', objectId: material.materialId,
    version: '1', sha256: material.versions[0].sha256 };
  const pdfRef = { ...source, identity, scope, kind: 'pdf', objectId: doc.documentId, version: doc.sha256, sha256: doc.sha256 };
  assert.deepEqual(references, [textRef, pdfRef]);
  const text = await dispatch(tools, ctx, await prepare(tools, ctx, 'read_personal_material', {
    materialId: material.materialId, version: 1, sha256: textRef.sha256, start: 0, length: 100 }));
  assert.deepEqual(text.result.reference, textRef);
  const pdf = await dispatch(tools, ctx, await prepare(tools, ctx, 'read_pdf', { documentId: doc.documentId, sha256: doc.sha256, pages: [2] }));
  assert.deepEqual(pdf.result.reference, pdfRef);
  assert.deepEqual((await tools.reconcile(ctx, await prepare(tools, ctx, 'list_materials', {}))).result.items.map(item => item.reference), references);
  assert.deepEqual(await f.data.list(f.identity), []);
});

test('host provenance is frozen through offer, prepare, dispatch and reconcile', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), scope = { kind: 'session', sessionId: ctx.snapshot.session.sessionId };
  await f.materials.personal.receive(f.identity, scope, textInput('固定来源'));
  const original = { sourceId: 'local-personal', owner: { ...f.owner, version: 1 } };
  let source = structuredClone(original);
  const tools = createDocumentTools({ materials: f.documentMaterials, source: async actual => { assert.deepEqual(actual, scope); return source; } });
  assert.deepEqual(await createDocumentTools({ materials: f.documentMaterials }).list(ctx), []);
  const offer = (await tools.list(ctx)).find(item => item.definition.name === 'list_materials');
  assert.deepEqual(offer.scope.source, original);
  const intent = { callId: 'catalogue', name: 'list_materials', arguments: {} };
  const command = await tools.prepare(ctx, offer, intent, randomUUID());
  assert.deepEqual(command.input.source, original);
  const result = await dispatch(tools, ctx, command);
  assert.deepEqual(result.result.items[0].reference.owner, original.owner);
  for (const changed of [{ ...original, sourceId: 'other-source' },
    { ...original, owner: { ...original.owner, serviceId: randomUUID() } },
    { ...original, owner: { ...original.owner, environmentId: randomUUID() } }]) {
    source = changed;
    await assert.rejects(tools.prepare(ctx, offer, intent, randomUUID()), { code: 'forbidden' });
    await assert.rejects(dispatch(tools, ctx, command), { code: 'forbidden' });
    await assert.rejects(tools.reconcile(ctx, command), { code: 'forbidden' });
  }
  source = original;
  assert.deepEqual(await tools.reconcile(ctx, command), result);
  let checks = 0;
  await assert.rejects(dispatch(tools, ctx, command, async () => {
    if (++checks === 2) source = { ...original, sourceId: 'changed-during-read' };
  }), { code: 'forbidden' });
  source = original; f.deny();
  await assert.rejects(dispatch(tools, ctx, command), { code: 'forbidden' });
  await assert.rejects(tools.reconcile(ctx, command), { code: 'forbidden' });
});

test('home document tools list and read an authorized fixed text version without creating an activity', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), scope = { kind: 'session', sessionId: ctx.snapshot.session.sessionId };
  const input = textInput('第一版：37 V'), material = await f.materials.personal.receive(f.identity, scope, input);
  const tools = createDocumentTools({ source: { sourceId: 'local-personal', owner: { ...f.owner, version: 1 } }, materials: f.documentMaterials });
  assert.ok(!(await tools.list(ctx)).some(offer => offer.definition.name === 'read_pdf_images'));
  const catalogue = await dispatch(tools, ctx, await prepare(tools, ctx, 'list_materials', {}));
  assert.equal(catalogue.result.items[0].source.materialId, input.materialId);
  const args = { materialId: input.materialId, version: 1, sha256: material.versions[0].sha256, start: 0, length: 100 };
  const command = await prepare(tools, ctx, 'read_personal_material', args);
  await f.materials.personal.update(f.identity, scope, input.materialId, { requestId: randomUUID(), materialId: input.materialId,
    expectedVersion: 1, dataBase64: Buffer.from('第二版：42 V').toString('base64') });
  const result = await dispatch(tools, ctx, command);
  assert.equal(result.result.text, '第一版：37 V');
  assert.deepEqual(result.result.source.scope, scope);
  assert.deepEqual(await tools.reconcile(ctx, command), result);
  await assert.rejects(prepare(tools, ctx, 'read_personal_material', { ...args, sessionId: randomUUID() }));
  await assert.rejects(prepare(tools, ctx, 'read_personal_material', { ...args, owner: f.owner }));
  assert.deepEqual(await f.data.list(f.identity), []);
});

test('PDF commands retain one reading, bound feedback and reconcile without rendering again', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), scope = { kind: 'session', sessionId: ctx.snapshot.session.sessionId };
  const doc = await f.materials.pdf.upload(f.identity, scope, { requestId: randomUUID(), documentId: randomUUID(), name: 'native.pdf',
    dataBase64: fixedPdf(Array.from({ length: 280 }, (_, i) => '37 volts evidence line ' + i).join('\n')).toString('base64') });
  const tools = createDocumentTools({ source: { sourceId: 'local-personal', owner: { ...f.owner, version: 1 } }, materials: f.documentMaterials });
  const command = await prepare(tools, ctx, 'read_pdf', { documentId: doc.documentId, sha256: doc.sha256, pages: [2] });
  assert.equal(await tools.reconcile(ctx, command), null);
  const result = await dispatch(tools, ctx, command);
  assert.match(result.result.reading.pages[0].text, /37 volts/);
  assert.ok(result.result.reading.pages[0].textTruncated);
  assert.ok(Buffer.byteLength(result.feedback.text) <= 8192);
  assert.ok(!JSON.stringify(result).includes('dataBase64'));
  const readOnly = createDocumentTools({ source: { sourceId: 'local-personal', owner: { ...f.owner, version: 1 } }, materials: { ...f.documentMaterials,
    pdf: { ...f.documentMaterials.pdf, read: async () => { throw new Error('reconcile must not render'); } } } });
  assert.deepEqual(await readOnly.reconcile(ctx, command), result);
  const range = await prepare(readOnly, ctx, 'read_pdf_text', { documentId: doc.documentId, sha256: doc.sha256,
    readingId: result.result.reading.readingId, page: 2, start: 2400, length: 2400 });
  const text = await dispatch(readOnly, ctx, range);
  assert.equal(text.result.start, 2400); assert.equal(text.result.end, 4800);
  assert.ok(text.result.nextStart); assert.equal(text.result.ocr, 'not-performed');
  assert.deepEqual(text.feedback.images, []);
  await assert.rejects(prepare(tools, ctx, 'read_pdf', { documentId: doc.documentId, sha256: doc.sha256, pages: [999] }), { code: 'invalid' });
});

test('search fixes authorized text versions and PDF readings at prepare time', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), scope = { kind: 'session', sessionId: ctx.snapshot.session.sessionId };
  const input = textInput('固定事实 37 volts'); await f.materials.personal.receive(f.identity, scope, input);
  const doc = await f.materials.pdf.upload(f.identity, scope, { requestId: randomUUID(), documentId: randomUUID(), name: 'search.pdf', dataBase64: fixedPdf().toString('base64') });
  const reading = await f.materials.pdf.read(f.identity, scope, { requestId: randomUUID(), documentId: doc.documentId, pages: [2], region: null });
  const tools = createDocumentTools({ source: { sourceId: 'local-personal', owner: { ...f.owner, version: 1 } }, materials: f.documentMaterials });
  const command = await prepare(tools, ctx, 'search_materials', { query: '37 volts',
    pdfReferences: [{ documentId: doc.documentId, sha256: doc.sha256, readingId: reading.readingId }] });
  await f.materials.personal.update(f.identity, scope, input.materialId,
    { requestId: randomUUID(), materialId: input.materialId, expectedVersion: 1, dataBase64: Buffer.from('新版本 42 volts').toString('base64') });
  const result = await dispatch(tools, ctx, command);
  assert.equal(result.result.matches.length, 2);
  assert.ok(result.result.matches.every(match => match.excerpt.includes('37 volts')));
  assert.ok(result.result.matches.every(match => match.source.scope.sessionId === scope.sessionId));
  const materialRefs = result.result.matches.map(match => match.reference);
  assert.equal(personalProjectContentSchema.parse({ title: '搜索依据', goal: '固定附件版本',
    stages: [{ title: '验证', goal: '验证附件事实' }], materialRefs }).materialRefs.length, 2);
  assert.equal(materialRefs.find(ref => ref.kind === 'personal-material').version, '1');
  assert.equal(materialRefs.find(ref => ref.kind === 'pdf').version, doc.sha256);
  assert.ok(Buffer.byteLength(result.feedback.text) <= 8192);
  assert.deepEqual(await tools.reconcile(ctx, command), result);
});

test('page images use the original real native model route, not the latest selection, and reconcile by image reference', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), scope = { kind: 'session', sessionId: ctx.snapshot.session.sessionId };
  const doc = await f.materials.pdf.upload(f.identity, scope, { requestId: randomUUID(), documentId: randomUUID(), name: 'images.pdf', dataBase64: fixedPdf().toString('base64') });
  const reading = await f.materials.pdf.read(f.identity, scope, { requestId: randomUUID(), documentId: doc.documentId, pages: [2], region: null });
  const route = await f.modelRoute(ctx, true); await route.select(false);
  const models = { ...route.gateway, selection: { ...route.gateway.selection,
    read: async () => { throw new Error('latest selection is not authority for document images'); } } };
  const tools = createDocumentTools({ source: { sourceId: 'local-personal', owner: { ...f.owner, version: 1 } }, materials: f.documentMaterials, models });
  const command = await prepare(tools, ctx, 'read_pdf_images', { documentId: doc.documentId, sha256: doc.sha256, readingId: reading.readingId });
  assert.equal(await tools.reconcile(ctx, command), null);
  const result = await dispatch(tools, ctx, command);
  assert.equal(result.feedback.images.length, 1);
  const retained = await route.gateway.images.read(f.identity, result.feedback.images[0]);
  assert.equal(retained.sha256, reading.pages[0].image.sha256);
  assert.equal(result.result.modelSegmentId, route.segmentId);
  assert.deepEqual(result.result.source.scope, scope);
  assert.equal(result.result.reference.objectId, doc.documentId);
  assert.equal(result.result.reference.version, doc.sha256);
  assert.ok(!JSON.stringify(result).includes('dataBase64'));
  const readonly = createDocumentTools({ source: { sourceId: 'local-personal', owner: { ...f.owner, version: 1 } }, materials: { ...f.documentMaterials, pdf: { ...f.documentMaterials.pdf,
    read: async () => { throw new Error('image reconcile must not render'); } } }, models: { ...models, images: { ...models.images,
    upload: async () => { throw new Error('image reconcile must not upload'); } } } });
  assert.deepEqual(await readonly.reconcile(ctx, command), result);
  const textCtx = structuredClone(ctx); textCtx.snapshot.steps = [structuredClone(ctx.snapshot.steps[0])];
  textCtx.snapshot.steps[0].stepId = randomUUID();
  textCtx.basisStepId = textCtx.snapshot.steps[0].stepId;
  const textRoute = await f.modelRoute(textCtx, false); await textRoute.select(true);
  await assert.rejects(prepare(createDocumentTools({ source: { sourceId: 'local-personal', owner: { ...f.owner, version: 1 } }, materials: f.documentMaterials, models: textRoute.gateway }), textCtx, 'read_pdf_images',
    { documentId: doc.documentId, sha256: doc.sha256, readingId: reading.readingId }), { code: 'forbidden' });
});

test('workspace tools read independently adopted materials and reject replay into another scope or revoked access', { timeout: 60000 }, async t => {
  const f = await fixture(t), home = await f.context(), homeScope = { kind: 'session', sessionId: home.snapshot.session.sessionId };
  const input = textInput('交接保留的 37 V'), source = await f.materials.personal.receive(f.identity, homeScope, input);
  const activity = await f.data.create(f.identity, { requestId: randomUUID(), goal: '实际工作区', question: '', references: [] });
  const copied = await f.materials.adopt(f.identity, activity.activityId, { requestId: randomUUID(), kind: 'personal-material', materialId: randomUUID(),
    source: { scope: homeScope, materialId: input.materialId, version: 1, sha256: source.versions[0].sha256 } });
  const workspace = await f.context(activity), tools = createDocumentTools({ source: { sourceId: 'local-personal', owner: { ...f.owner, version: 1 } }, materials: f.documentMaterials });
  const homeCommand = await prepare(tools, home, 'read_personal_material',
    { materialId: input.materialId, version: 1, sha256: source.versions[0].sha256, start: 0, length: 100 });
  await assert.rejects(dispatch(tools, workspace, homeCommand), { code: 'forbidden' });
  await assert.rejects(tools.reconcile(workspace, homeCommand), { code: 'forbidden' });
  const command = await prepare(tools, workspace, 'read_personal_material',
    { materialId: copied.materialId, version: 1, sha256: copied.versions[0].sha256, start: 0, length: 100 });
  await f.sessions.update(f.identity, { requestId: randomUUID(), sessionId: homeScope.sessionId, deleted: true });
  await f.materials.releaseDeleted(f.identity, { requestId: randomUUID(), sessionId: homeScope.sessionId });
  await f.storage.collect({ olderThan: new Date(Date.now() + 60000) });
  const result = await dispatch(tools, workspace, command);
  assert.equal(result.result.text, '交接保留的 37 V'); assert.equal(result.result.source.activityId, activity.activityId);
  assert.equal(result.result.source.scope, undefined);
  assert.deepEqual(result.result.reference.scope, { kind: 'workspace', activityId: activity.activityId });
  assert.equal(result.result.reference.objectId, copied.materialId);
  assert.deepEqual(result.result.reference.owner, { ...f.owner, version: 1 });
  const foreign = structuredClone(workspace); foreign.context.facts.workspace.identity.kind = 'school';
  await assert.rejects(tools.list(foreign), { code: 'forbidden' });
  f.deny();
  await assert.rejects(dispatch(tools, workspace, command), { code: 'forbidden' });
  await assert.rejects(tools.reconcile(workspace, command), { code: 'forbidden' });
});

test('catalogue pagination and UTF-8 range feedback fit the actual model budget without skipping originals', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), scope = { kind: 'session', sessionId: ctx.snapshot.session.sessionId };
  const tools = createDocumentTools({ source: { sourceId: 'local-personal', owner: { ...f.owner, version: 1 } }, materials: f.documentMaterials }), text = '资料边界😀'.repeat(2000);
  const input = textInput(text), material = await f.materials.personal.receive(f.identity, scope, input);
  for (let i = 0; i < 11; i++) await f.materials.personal.receive(f.identity, scope,
    { ...textInput('固定小原件 ' + i), name: '目录标题'.repeat(55) + i });
  const seen = new Set(); let offset = 0;
  for (;;) {
    const page = await dispatch(tools, ctx, await prepare(tools, ctx, 'list_materials', { offset, limit: 24 }));
    assert.ok(Buffer.byteLength(page.feedback.text) <= 8192);
    for (const item of page.result.items) { assert.ok(!seen.has(item.source.materialId)); seen.add(item.source.materialId); }
    if (page.result.nextOffset === null) break;
    assert.ok(page.result.nextOffset > offset); offset = page.result.nextOffset;
  }
  assert.equal(seen.size, 12);
  const args = { materialId: input.materialId, version: 1, sha256: material.versions[0].sha256, start: 0, length: 6000 };
  const first = await dispatch(tools, ctx, await prepare(tools, ctx, 'read_personal_material', args));
  assert.ok(Buffer.byteLength(first.feedback.text) <= 8192);
  assert.ok(first.result.end < 6000); assert.equal(first.result.text, text.slice(0, first.result.end));
  const next = await dispatch(tools, ctx, await prepare(tools, ctx, 'read_personal_material', { ...args, start: first.result.nextStart }));
  assert.equal(next.result.text, text.slice(next.result.start, next.result.end));
});
