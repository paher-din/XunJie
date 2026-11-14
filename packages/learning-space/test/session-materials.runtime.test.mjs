import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createLearningData, learningMigrations } from '../dist/learning-data/index.js';
import { agentSessionMigration, createAgentSessions } from '../dist/learning-data/agent-sessions.js';
import { createSessionMaterials, sessionMaterialMigration } from '../dist/learning-data/session-materials.js';
import { createPersonalMaterials } from '../dist/learning-data/personal-materials.js';
import { createPdfMaterials } from '../dist/learning-data/pdf-materials.js';
import { fixedPdf } from '../../../apps/server/tests/fixtures/pdf-material.mjs';

const save = (text, extra = {}) => ({ requestId: randomUUID(), materialId: randomUUID(), name: '笔记.md',
  mediaType: 'text/markdown', dataBase64: Buffer.from(text).toString('base64'), ...extra });
async function fixture(t, actorOverride) {
  const pg = await nativeFixture(), handles = [];
  t.after(async () => { try { for (const storage of handles.reverse()) await storage.close(); } finally { await pg.close(); } });
  const migrations = [...learningMigrations.filter(m => m.version < 31), agentSessionMigration, sessionMaterialMigration];
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations });
  const backend = createFileBackend({ id: 'files', root: pg.root + '/objects' });
  const actor = actorOverride ?? { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  let allowed = true;
  const authorize = async () => { if (!allowed) throw new StorageError('forbidden'); };
  async function open() {
    const storage = await openStorage({ binding, migrations, backend }); handles.push(storage);
    const data = createLearningData(storage, { resolveBinding: async () => { await authorize(); return { ...owner, version: 1 }; } });
    const sessions = createAgentSessions(storage, { authorize, openActivity: data.open,
      resolveOwner: async () => ({ version: 1, installationId: randomUUID(), connectionId: randomUUID(),
        target: { environmentId: randomUUID(), serviceId: randomUUID(), unit: 'teaching-agent',
          endpoint: 'https://agent.example.test', protocolVersion: 1, capabilities: [] } }) });
    const options = { openScope: (identity, scope) => scope.kind === 'session'
      ? sessions.read(identity, scope.sessionId) : data.open(identity, scope.activityId) };
    return { storage, data, sessions, materials: createSessionMaterials(storage, options), options };
  }
  const first = await open();
  const session = await first.sessions.create(actor, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  return { ...first, actor, session, scope: { kind: 'session', sessionId: session.sessionId }, open, deny: () => { allowed = false; } };
}

test('session text originals keep versions and ranges without creating an activity', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = save('第一版：37 V\n后续范围');
  const first = await f.materials.personal.receive(f.actor, f.scope, input);
  assert.equal(first.activityId, undefined); assert.deepEqual(first.scope, f.scope);
  assert.deepEqual(await f.data.list(f.actor), []);
  assert.deepEqual(await f.materials.personal.receive(f.actor, f.scope, input), first);
  const update = { requestId: randomUUID(), materialId: input.materialId, expectedVersion: 1, dataBase64: Buffer.from('第二版：42 V').toString('base64') };
  const second = await f.materials.personal.update(f.actor, f.scope, input.materialId, update);
  assert.deepEqual(await f.materials.personal.update(f.actor, f.scope, input.materialId, update), second);
  assert.equal(second.currentVersion, 2);
  assert.equal((await f.materials.personal.original(f.actor, f.scope, input.materialId, 1)).text, '第一版：37 V\n后续范围');
  const range = await f.materials.personal.readRange(f.actor, f.scope, input.materialId, 1, { start: 4, length: 4 });
  assert.equal(range.text, '37 V');
  const reopened = await f.open();
  assert.equal((await reopened.materials.personal.versionContent(f.actor, f.scope, input.materialId, 2)).text, '第二版：42 V');
  assert.equal((await reopened.materials.personal.list(f.actor, f.scope)).length, 1);
  assert.deepEqual(await f.data.list(f.actor), []);
});

test('session PDFs retain originals, render native text and page images, and reopen fixed readings', { timeout: 60000 }, async t => {
  const f = await fixture(t), bytes = fixedPdf(), input = { requestId: randomUUID(), documentId: randomUUID(), name: 'evidence.pdf', dataBase64: bytes.toString('base64') };
  const doc = await f.materials.pdf.upload(f.actor, f.scope, input);
  assert.equal(doc.state, 'ready'); assert.equal(doc.pageCount, 2);
  assert.equal(doc.activityId, undefined); assert.deepEqual(doc.scope, f.scope);
  const read = { requestId: randomUUID(), documentId: doc.documentId, pages: [2], region: null };
  const reading = await f.materials.pdf.read(f.actor, f.scope, read);
  assert.equal(reading.activityId, undefined); assert.deepEqual(reading.scope, f.scope);
  assert.match(reading.pages[0].text, /37 volts/);
  assert.equal(reading.pages[0].image.mediaType, 'image/png');
  const reopened = await f.open();
  assert.deepEqual(await reopened.materials.pdf.read(f.actor, f.scope, read), reading);
  assert.deepEqual(await reopened.materials.pdf.reading(f.actor, f.scope, reading.readingId), reading);
  assert.deepEqual(Buffer.from((await reopened.materials.pdf.original(f.actor, f.scope, doc.documentId)).bytes), bytes);
  const found = await f.materials.pdf.find(f.actor, f.scope, { requestId: randomUUID(), documentId: doc.documentId, pages: [2], query: '37 volts' });
  assert.equal(found.matches.length, 1); assert.deepEqual(found.source.scope, f.scope);
  assert.equal((await f.materials.pdf.list(f.actor, f.scope)).length, 1);
  assert.deepEqual(await f.data.list(f.actor), []);
});

test('workspace adoption retains a fixed text version and PDF original under independent identities', { timeout: 60000 }, async t => {
  const f = await fixture(t), note = save('采用的版本：37 V');
  const text = await f.materials.personal.receive(f.actor, f.scope, note);
  const doc = await f.materials.pdf.upload(f.actor, f.scope, { requestId: randomUUID(), documentId: randomUUID(), name: 'fixed.pdf', dataBase64: fixedPdf().toString('base64') });
  await f.materials.personal.update(f.actor, f.scope, note.materialId,
    { requestId: randomUUID(), materialId: note.materialId, expectedVersion: 1, dataBase64: Buffer.from('后来的版本：42 V').toString('base64') });
  const workspace = await f.data.create(f.actor, { requestId: randomUUID(), goal: '开始实践', question: '', references: [] });
  const adoptText = { requestId: randomUUID(), kind: 'personal-material', materialId: randomUUID(),
    source: { scope: f.scope, materialId: note.materialId, version: 1, sha256: text.versions[0].sha256 } };
  await assert.rejects(f.materials.adopt(f.actor, workspace.activityId, { ...adoptText, source: { ...adoptText.source, sha256: '0'.repeat(64) } }), { code: 'identity-conflict' });
  const copied = await f.materials.adopt(f.actor, workspace.activityId, { ...adoptText, requestId: randomUUID() });
  assert.equal(copied.activityId, workspace.activityId); assert.equal(copied.scope, undefined);
  assert.equal(copied.currentVersion, 1); assert.equal(copied.versions[0].sha256, text.versions[0].sha256);
  const adoptPdf = { requestId: randomUUID(), kind: 'pdf', documentId: randomUUID(), source: { scope: f.scope, documentId: doc.documentId, sha256: doc.sha256 } };
  const pdf = await f.materials.adopt(f.actor, { kind: 'workspace', activityId: workspace.activityId }, adoptPdf);
  assert.equal(pdf.activityId, workspace.activityId); assert.equal(pdf.sha256, doc.sha256);
  assert.deepEqual(await f.materials.adopt(f.actor, workspace.activityId, adoptPdf), pdf);
  const legacy = createPersonalMaterials(f.storage, f.data.open);
  assert.equal((await legacy.original(f.actor, workspace.activityId, copied.materialId, 1)).text, '采用的版本：37 V');
  const page = await f.materials.pdf.read(f.actor, workspace.activityId, { requestId: randomUUID(), documentId: pdf.documentId, pages: [2], region: null });
  assert.match(page.pages[0].text, /37 volts/);
  await assert.rejects(f.materials.adopt(f.actor, workspace.activityId, { ...adoptPdf, source: { ...adoptPdf.source, scope: { kind: 'workspace', activityId: f.session.sessionId } } }));
});

test('releasing a deleted home session and collecting resources preserves adopted workspace originals', { timeout: 60000 }, async t => {
  const f = await fixture(t), note = save('独立保留：37 V'), source = await f.materials.personal.receive(f.actor, f.scope, note);
  const doc = await f.materials.pdf.upload(f.actor, f.scope, { requestId: randomUUID(), documentId: randomUUID(), name: 'retained.pdf', dataBase64: fixedPdf().toString('base64') });
  await f.materials.pdf.read(f.actor, f.scope, { requestId: randomUUID(), documentId: doc.documentId, pages: [2], region: null });
  const workspace = await f.data.create(f.actor, { requestId: randomUUID(), goal: '继续实践', question: '', references: [] });
  const textInput = { requestId: randomUUID(), kind: 'personal-material', materialId: randomUUID(),
    source: { scope: f.scope, materialId: note.materialId, version: 1, sha256: source.versions[0].sha256 } };
  const text = await f.materials.adopt(f.actor, workspace.activityId, textInput);
  const copiedPdf = await f.materials.adopt(f.actor, workspace.activityId, { requestId: randomUUID(), kind: 'pdf', documentId: randomUUID(),
    source: { scope: f.scope, documentId: doc.documentId, sha256: doc.sha256 } });
  const release = { requestId: randomUUID(), sessionId: f.session.sessionId };
  await assert.rejects(f.materials.releaseDeleted(f.actor, release), { code: 'invalid' });
  await f.sessions.update(f.actor, { requestId: randomUUID(), sessionId: f.session.sessionId, deleted: true });
  await f.materials.releaseDeleted(f.actor, release);
  await f.materials.releaseDeleted(f.actor, release);
  await f.storage.collect({ olderThan: new Date(Date.now() + 60000) });
  const reopened = await f.open();
  await assert.rejects(reopened.materials.personal.original(f.actor, f.scope, note.materialId, 1), { code: 'forbidden' });
  assert.equal((await reopened.materials.personal.original(f.actor, workspace.activityId, text.materialId, 1)).text, '独立保留：37 V');
  assert.deepEqual(await reopened.materials.adopt(f.actor, workspace.activityId, textInput), text);
  const page = await reopened.materials.pdf.read(f.actor, workspace.activityId, { requestId: randomUUID(), documentId: copiedPdf.documentId, pages: [2], region: null });
  assert.match(page.pages[0].text, /37 volts/);
  await reopened.materials.validate();
});

test('session search uses fixed authorized sources and rejects references rebound from another scope', { timeout: 60000 }, async t => {
  const f = await fixture(t), note = save('共有事实：37 volts'), text = await f.materials.personal.receive(f.actor, f.scope, note);
  const doc = await f.materials.pdf.upload(f.actor, f.scope, { requestId: randomUUID(), documentId: randomUUID(), name: 'search.pdf', dataBase64: fixedPdf().toString('base64') });
  const page = await f.materials.pdf.read(f.actor, f.scope, { requestId: randomUUID(), documentId: doc.documentId, pages: [2], region: null });
  const personalReference = { source: { kind: 'personal-material', scope: f.scope, materialId: note.materialId, version: 1, sha256: text.versions[0].sha256 } };
  const pdfReference = { source: { kind: 'pdf', scope: f.scope, documentId: doc.documentId, documentSha256: doc.sha256, readingId: page.readingId } };
  const query = { query: '37 volts', scope: { courseMaterials: false, skillAttachments: false } };
  const found = await f.materials.search(f.actor, f.scope, query, { personalReferences: [personalReference], pdfReferences: [pdfReference] });
  assert.equal(found.matches.length, 2); assert.equal(found.coverage.searchedSourceCount, 2);
  assert.ok(found.matches.every(match => match.source.scope.sessionId === f.scope.sessionId));
  const wrongScope = { kind: 'workspace', activityId: f.scope.sessionId };
  const mixed = await f.materials.search(f.actor, f.scope, query, {
    personalReferences: [{ source: { ...personalReference.source, scope: wrongScope } }],
    pdfReferences: [{ source: { ...pdfReference.source, scope: wrongScope } }],
  });
  assert.equal(mixed.matches.length, 0); assert.equal(mixed.coverage.searchedSourceCount, 0);
  assert.ok(mixed.sources.filter(source => source.state === 'no-access').length >= 2);
  assert.deepEqual(await f.data.list(f.actor), []);
});

test('material owners isolate complete identities and session/workspace scopes even when ids overlap', { timeout: 60000 }, async t => {
  const f = await fixture(t), workspace = await f.data.create(f.actor, { requestId: randomUUID(), goal: '重叠 id', question: '', references: [] });
  const session = await f.sessions.create(f.actor, { requestId: randomUUID(), sessionId: workspace.activityId, scenario: 'student-assistant' });
  const scope = { kind: 'session', sessionId: session.sessionId }, input = save('session 独有原件');
  const material = await f.materials.personal.receive(f.actor, scope, input);
  const doc = await f.materials.pdf.upload(f.actor, scope, { requestId: randomUUID(), documentId: randomUUID(), name: 'private.pdf', dataBase64: fixedPdf().toString('base64') });
  assert.deepEqual(await f.materials.personal.list(f.actor, workspace.activityId), []);
  assert.deepEqual(await f.materials.pdf.list(f.actor, workspace.activityId), []);
  await assert.rejects(f.materials.personal.original(f.actor, workspace.activityId, material.materialId, 1), { code: 'forbidden' });
  await assert.rejects(f.materials.pdf.original(f.actor, workspace.activityId, doc.documentId), { code: 'missing' });
  await assert.rejects(f.materials.personal.receive(f.actor, workspace.activityId, input), { code: 'identity-conflict' });
  for (const field of ['environmentId', 'spaceId', 'principalId', 'kind']) {
    const other = { ...f.actor, [field]: field === 'kind' ? 'school' : randomUUID() };
    for (const current of [scope, workspace.activityId]) {
      await assert.rejects(f.materials.personal.list(other, current), error => ['forbidden', 'missing'].includes(error.code));
      await assert.rejects(f.materials.pdf.list(other, current), error => ['forbidden', 'missing'].includes(error.code));
    }
  }
  const forged = createSessionMaterials(f.storage, { openScope: async () => ({ ...workspace, activityId: session.sessionId,
    target: { ...workspace.target, serviceId: randomUUID() } }) });
  await assert.rejects(forged.personal.list(f.actor, workspace.activityId), { code: 'forbidden' });
  f.deny();
  await assert.rejects(f.materials.personal.original(f.actor, scope, material.materialId, 1), { code: 'forbidden' });
  await assert.rejects(f.materials.pdf.original(f.actor, scope, doc.documentId), { code: 'forbidden' });
});

test('a separate workspace data owner adopts from trusted source ports and retains bytes after source deletion', { timeout: 60000 }, async t => {
  const source = await fixture(t), destination = await fixture(t, source.actor);
  const note = save('跨 owner 固定原件'), material = await source.materials.personal.receive(source.actor, source.scope, note);
  const doc = await source.materials.pdf.upload(source.actor, source.scope, { requestId: randomUUID(), documentId: randomUUID(), name: 'cross-owner.pdf', dataBase64: fixedPdf().toString('base64') });
  const target = { ...source.storage.owner, version: 1 };
  const importer = createSessionMaterials(destination.storage, { ...destination.options, sources: {
    personal: async (actor, scope, id, version) => ({ ...await source.materials.personal.versionContent(actor, scope, id, version), target }),
    pdf: async (actor, scope, id) => ({ ...await source.materials.pdf.original(actor, scope, id), target }),
  } });
  const workspace = await destination.data.create(source.actor, { requestId: randomUUID(), goal: '本机继续', question: '', references: [] });
  const textInput = { requestId: randomUUID(), kind: 'personal-material', materialId: randomUUID(),
    source: { scope: source.scope, materialId: material.materialId, version: 1, sha256: material.versions[0].sha256 } };
  const adopted = await importer.adopt(source.actor, workspace.activityId, textInput);
  const copiedPdf = await importer.adopt(source.actor, workspace.activityId, { requestId: randomUUID(), kind: 'pdf', documentId: randomUUID(),
    source: { scope: source.scope, documentId: doc.documentId, sha256: doc.sha256 } });
  await source.sessions.update(source.actor, { requestId: randomUUID(), sessionId: source.scope.sessionId, deleted: true });
  await source.materials.releaseDeleted(source.actor, { requestId: randomUUID(), sessionId: source.scope.sessionId });
  await source.storage.collect({ olderThan: new Date(Date.now() + 60000) });
  assert.equal((await importer.personal.original(source.actor, workspace.activityId, adopted.materialId, 1)).text, '跨 owner 固定原件');
  assert.deepEqual(await importer.adopt(source.actor, workspace.activityId, textInput), adopted);
  const reading = await importer.pdf.read(source.actor, workspace.activityId, { requestId: randomUUID(), documentId: copiedPdf.documentId, pages: [2], region: null });
  assert.match(reading.pages[0].text, /37 volts/);
  await importer.validate(); await source.materials.validate();
});

test('migration 32 preserves existing workspace originals, fixed readings and request fingerprints', { timeout: 60000 }, async t => {
  const pg = await nativeFixture(), handles = [];
  t.after(async () => { try { for (const handle of handles.reverse()) await handle.close(); } finally { await pg.close(); } });
  const previous = [...learningMigrations.filter(m => m.version < 31), agentSessionMigration];
  const migrations = [...previous, sessionMaterialMigration];
  const options = { admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID() };
  const binding = await provisionStorage({ ...options, migrations: previous });
  const backend = createFileBackend({ id: 'files', root: pg.root + '/objects' });
  const old = await openStorage({ binding, backend, migrations: previous }); handles.push(old);
  const actor = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '旧工作区' };
  const authority = { resolveBinding: async () => ({ ...options.owner, version: 1 }) };
  const before = createLearningData(old, authority), workspace = await before.create(actor, { requestId: randomUUID(), goal: '原有工作', question: '', references: [] });
  const personal = createPersonalMaterials(old, before.open), pdf = createPdfMaterials(old, before.open), input = save('升级前的原始笔记');
  const text = await personal.receive(actor, workspace.activityId, input);
  const pdfInput = { requestId: randomUUID(), documentId: randomUUID(), name: 'old.pdf', dataBase64: fixedPdf().toString('base64') };
  const doc = await pdf.upload(actor, workspace.activityId, pdfInput);
  const read = { requestId: randomUUID(), documentId: doc.documentId, pages: [2], region: null };
  const reading = await pdf.read(actor, workspace.activityId, read);
  await old.participant().closeWrites(); await old.participant().closeDispatch();
  await provisionStorage({ ...options, migrations });
  const current = await openStorage({ binding, backend, migrations }); handles.push(current);
  await current.participant().resume();
  const data = createLearningData(current, authority), owner = createSessionMaterials(current, {
    openScope: (identity, scope) => { assert.equal(scope.kind, 'workspace'); return data.open(identity, scope.activityId); },
  });
  assert.deepEqual(await owner.personal.receive(actor, workspace.activityId, input), text);
  assert.deepEqual(await owner.pdf.upload(actor, workspace.activityId, pdfInput), doc);
  assert.deepEqual(await owner.pdf.read(actor, workspace.activityId, read), reading);
  assert.equal((await owner.personal.original(actor, workspace.activityId, text.materialId, 1)).text, '升级前的原始笔记');
  assert.deepEqual(await data.list(actor), [workspace]);
  await owner.validate();
});

test('an interrupted PDF adoption resumes inspection from retained workspace bytes after source deletion', { timeout: 60000 }, async t => {
  const f = await fixture(t), doc = await f.materials.pdf.upload(f.actor, f.scope,
    { requestId: randomUUID(), documentId: randomUUID(), name: 'recover.pdf', dataBase64: fixedPdf().toString('base64') });
  const workspace = await f.data.create(f.actor, { requestId: randomUUID(), goal: '恢复采用', question: '', references: [] });
  const input = { requestId: randomUUID(), kind: 'pdf', documentId: randomUUID(), source: { scope: f.scope, documentId: doc.documentId, sha256: doc.sha256 } };
  const copied = await f.materials.adopt(f.actor, workspace.activityId, input);
  // Restore the durable prefix after upload committed and before inspection completed.
  await f.storage.request({ requestId: randomUUID(), fingerprint: 'interrupted PDF inspection fixture' }, async tx => {
    await tx.query('UPDATE pdf_documents SET body=$2 WHERE document_id=$1',
      [input.documentId, { ...copied, state: 'received', pageCount: 0, pageLabels: [] }]);
    await tx.query('DELETE FROM _storage_requests WHERE request_id=$1 OR request_id=$2',
      ['pdf-inspect:' + input.requestId, 'session-material-adopt:' + input.requestId + ':complete']);
    await tx.query("UPDATE session_material_adoptions SET state='pending' WHERE request_id=$1", [input.requestId]);
    return null;
  });
  await f.sessions.update(f.actor, { requestId: randomUUID(), sessionId: f.scope.sessionId, deleted: true });
  await f.materials.releaseDeleted(f.actor, { requestId: randomUUID(), sessionId: f.scope.sessionId });
  await f.storage.collect({ olderThan: new Date(Date.now() + 60000) });
  const resumed = await f.materials.adopt(f.actor, workspace.activityId, input);
  assert.equal(resumed.state, 'ready'); assert.equal(resumed.pageCount, 2);
  const reading = await f.materials.pdf.read(f.actor, workspace.activityId,
    { requestId: randomUUID(), documentId: input.documentId, pages: [2], region: null });
  assert.match(reading.pages[0].text, /37 volts/);
});
