import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, prepareStorageRestore, finalizeStorageRestore } from '@xunjie/storage';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createLearningData, learningMigrations } from '../dist/learning-data/index.js';
import { createAgentSessions, validateAgentSessions } from '../dist/learning-data/agent-sessions.js';
import { createSessionMaterials } from '../dist/learning-data/session-materials.js';
import { createPersonalProjects } from '../dist/learning-data/personal-projects.js';
import { collectLearningSources, validateLearningSources } from '../dist/learning-data/source-closure.js';
import { fixedPdf } from '../../../apps/server/tests/fixtures/pdf-material.mjs';

const exec = promisify(execFile);
async function pgTool(fixture, name, args) {
  const connection = fixture.admin;
  try { return await exec(fixture.tool(name), ['-h', connection.host, '-p', String(connection.port), '-U', connection.user,
    '-d', connection.database, ...args], { env: { ...process.env, PGPASSWORD: connection.password }, timeout: 30000 }); }
  catch { throw new Error(name + ' failed'); }
}

async function fixture(t) {
  const pg = await nativeFixture(), handles = [];
  t.after(async () => { try { for (const handle of handles.reverse()) await handle.close(); } finally { await pg.close(); } });
  const options = { admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID() };
  const binding = await provisionStorage({ ...options, migrations: learningMigrations });
  const backend = createFileBackend({ id: 'files', root: pg.root + '/objects' });
  const storage = await openStorage({ binding, migrations: learningMigrations, backend }); handles.push(storage);
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '恢复学生' };
  function services(ownerStorage) {
    const data = createLearningData(ownerStorage, { resolveBinding: async () => ({ ...options.owner, version: 1 }) });
    const sessions = createAgentSessions(ownerStorage, { authorize: async () => {}, openActivity: data.open,
      resolveOwner: async () => ({ version: 1, connectionId: randomUUID(), installationId: randomUUID(),
        target: { environmentId: randomUUID(), serviceId: randomUUID(), unit: 'teaching-agent', endpoint: 'https://agent.example.test', protocolVersion: 1, capabilities: [] } }) });
    const materials = createSessionMaterials(ownerStorage, { openScope: (actor, scope) => scope.kind === 'session'
      ? sessions.read(actor, scope.sessionId) : data.open(actor, scope.activityId) });
    const projects = createPersonalProjects(ownerStorage, { authorize: async () => {}, learning: data });
    return { data, sessions, materials, projects };
  }
  const api = services(storage), home = await api.sessions.create(identity,
    { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  const scope = { kind: 'session', sessionId: home.sessionId };
  const textInput = { requestId: randomUUID(), materialId: randomUUID(), name: 'notes.md', mediaType: 'text/markdown',
    dataBase64: Buffer.from('恢复后的独立原件：37 V').toString('base64') };
  const sourceText = await api.materials.personal.receive(identity, scope, textInput);
  const sourcePdf = await api.materials.pdf.upload(identity, scope, { requestId: randomUUID(), documentId: randomUUID(),
    name: 'source.pdf', dataBase64: fixedPdf().toString('base64') });
  const sourceReading = await api.materials.pdf.read(identity, scope, { requestId: randomUUID(), documentId: sourcePdf.documentId, pages: [2], region: null });
  const project = await api.projects.create(identity, { operationId: randomUUID(), sourceSessionId: home.sessionId,
    inputId: randomUUID(), content: { title: '独立恢复项目', goal: '保留固定资料', stages: [{ title: '实践', goal: '验证原件' }], materialRefs: [] } });
  const workspace = await api.sessions.create(identity, { requestId: randomUUID(), sessionId: project.workspaceSessionId,
    scenario: 'workspace-assistant', workspace: { activityId: project.activityId, target: project.target } });
  const adoptedText = await api.materials.adopt(identity, project.activityId, { requestId: randomUUID(), kind: 'personal-material', materialId: randomUUID(),
    source: { scope, materialId: sourceText.materialId, version: 1, sha256: sourceText.versions[0].sha256 } });
  const adoptedPdf = await api.materials.adopt(identity, project.activityId, { requestId: randomUUID(), kind: 'pdf', documentId: randomUUID(),
    source: { scope, documentId: sourcePdf.documentId, sha256: sourcePdf.sha256 } });
  const workspaceReading = await api.materials.pdf.read(identity, project.activityId,
    { requestId: randomUUID(), documentId: adoptedPdf.documentId, pages: [2], region: null });
  return { ...api, pg, handles, options, binding, backend, storage, identity, services, home, scope, project, workspace,
    sourceText, sourcePdf, sourceReading, adoptedText, adoptedPdf, workspaceReading };
}

test('the owner source closure includes session directory, adoption, release and project provenance', { timeout: 60000 }, async t => {
  const f = await fixture(t), empty = await f.sessions.create(f.identity,
    { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  await f.sessions.update(f.identity, { requestId: randomUUID(), sessionId: empty.sessionId, deleted: true });
  await f.materials.releaseDeleted(f.identity, { requestId: randomUUID(), sessionId: empty.sessionId });
  const closure = await collectLearningSources(f.storage);
  const ofKind = kind => closure.entries.filter(entry => entry.kind === kind);
  assert.equal(ofKind('agent_session_directory').length, 3);
  assert.equal(ofKind('session_material_adoptions').length, 2);
  assert.equal(ofKind('session_material_releases').length, 1);
  assert.equal(ofKind('personal_learning_projects').length, 1);
  assert.equal(ofKind('personal_learning_projects')[0].fixedId, f.project.projectId);
  assert.deepEqual(await collectLearningSources(f.storage), closure);
  await validateLearningSources(f.storage, closure);
});

test('released session bytes are optional while adopted workspace originals survive independent PostgreSQL restore', { timeout: 60000 }, async t => {
  const f = await fixture(t), target = await nativeFixture(); let restored;
  t.after(async () => { try { await restored?.close(); } finally { await target.close(); } });
  await f.sessions.update(f.identity, { requestId: randomUUID(), sessionId: f.home.sessionId, deleted: true });
  await f.materials.releaseDeleted(f.identity, { requestId: randomUUID(), sessionId: f.home.sessionId });
  await f.storage.collect({ olderThan: new Date(Date.now() + 60000) });
  const closure = await collectLearningSources(f.storage);
  const released = closure.entries.filter(entry => entry.kind === 'personal_material_versions' && entry.fixedId === f.sourceText.materialId + ':1'
    || entry.kind === 'pdf_documents' && entry.fixedId === f.sourcePdf.documentId
    || entry.kind === 'pdf_readings' && entry.fixedId === f.sourceReading.readingId);
  assert.equal(released.length, 3); assert.ok(released.every(entry => entry.resources.length === 0));
  const adopted = closure.entries.find(entry => entry.kind === 'personal_material_versions' && entry.fixedId === f.adoptedText.materialId + ':1');
  assert.equal(adopted.resources.length, 1);
  await f.materials.validate(); await validateAgentSessions(f.storage);
  await validateLearningSources(f.storage, closure);
  await f.storage.participant().closeWrites(); await f.storage.participant().closeDispatch();
  const dump = f.pg.root + '/learning-owner.dump', backend = createFileBackend({ id: 'files', root: target.root + '/objects' });
  let manifest;
  await f.storage.snapshot(randomUUID(), async snapshot => {
    manifest = snapshot.manifest;
    await pgTool(f.pg, 'pg_dump', ['-Fc', '-n', f.binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump]);
    for (const resource of manifest.resources) await backend.put(resource.locator.key, await f.storage.readResourceObject(resource.resourceId));
  });
  const binding = await prepareStorageRestore({ admin: target.admin, owner: f.options.owner, password: f.options.password });
  await pgTool(target, 'pg_restore', ['--exit-on-error', '--role', binding.migratorRole, '--no-owner', '--no-acl', dump]);
  restored = await finalizeStorageRestore({ admin: target.admin, binding, migrations: learningMigrations, manifest, backend });
  const api = f.services(restored);
  await validateLearningSources(restored, closure); await validateAgentSessions(restored); await api.materials.validate(); await api.projects.validate();
  assert.deepEqual(await collectLearningSources(restored), closure);
  assert.equal((await api.materials.personal.original(f.identity, f.project.activityId, f.adoptedText.materialId, 1)).text, '恢复后的独立原件：37 V');
  assert.deepEqual(await api.materials.pdf.reading(f.identity, f.project.activityId, f.workspaceReading.readingId), f.workspaceReading);
  await assert.rejects(api.materials.personal.original(f.identity, f.scope, f.sourceText.materialId, 1), { code: 'forbidden' });
  const original = await restored.resource(adopted.resources[0].resourceId);
  await backend.remove(original.locator.key);
  await assert.rejects(collectLearningSources(restored), { code: 'corrupt' });
  await assert.rejects(validateLearningSources(restored, closure), { code: 'corrupt' });
});
