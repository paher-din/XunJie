import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createLearningData, learningMigrations } from '../dist/learning-data/index.js';
import { createAgentSessions } from '../dist/learning-data/agent-sessions.js';
import { createSessionMaterials } from '../dist/learning-data/session-materials.js';
import { createProjectMaterials } from '../dist/learning-data/project-materials.js';

test('project material handoff resumes its original copies and survives deletion of the home conversation', async t => {
  const pg = await nativeFixture(); let storage;
  t.after(async () => { await storage?.close(); await pg.close(); });
  const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations: learningMigrations });
  storage = await openStorage({ binding, migrations: learningMigrations, backend: createFileBackend({ id: 'files', root: pg.root + '/files' }) });
  const identity = { ...storage.owner, environmentId: storage.owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  delete identity.serviceId;
  const target = { ...storage.owner, version: 1 };
  const learning = createLearningData(storage, { resolveBinding: async () => target });
  const directory = createAgentSessions(storage, { authorize: async () => {}, openActivity: learning.open, resolveOwner: async () => ({
    version: 1, connectionId: randomUUID(), installationId: randomUUID(), target: { environmentId: randomUUID(), serviceId: randomUUID(),
      unit: 'teaching-agent', endpoint: 'http://127.0.0.1:3444', protocolVersion: 1, capabilities: ['agent.sessions.v2'] } }) });
  const session = await directory.create(identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  const materials = createSessionMaterials(storage, { openScope: (who, scope) => scope.kind === 'session'
    ? directory.read(who, scope.sessionId) : learning.open(who, scope.activityId) });
  const uploaded = await materials.personal.receive(identity, { kind: 'session', sessionId: session.sessionId }, {
    requestId: randomUUID(), materialId: randomUUID(), name: '学习资料.md', mediaType: 'text/markdown', dataBase64: Buffer.from('不可丢失的学习资料').toString('base64') });
  const version = uploaded.versions[0];
  const activity = await learning.create(identity, { requestId: randomUUID(), goal: '练习', question: '', references: [] });
  const reference = { sourceId: 'local-personal', identity: { environmentId: identity.environmentId, spaceId: identity.spaceId,
    principalId: identity.principalId, kind: identity.kind }, owner: target, kind: 'personal-material', objectId: uploaded.materialId,
    version: '1', scope: { kind: 'session', sessionId: session.sessionId }, sha256: version.sha256 };
  const input = { requestId: randomUUID(), activityId: activity.activityId, sourceSessionId: session.sessionId, references: [reference] };
  let loseReply = true;
  const interrupted = createProjectMaterials(storage, { openActivity: learning.open, materials: { ...materials,
    async adopt(...args) { const result = await materials.adopt(...args); if (loseReply) { loseReply = false; throw new Error('lost copy reply'); } return result; } },
    authorizeReference: async () => {}, assertDispatch: async () => {} });
  await assert.rejects(interrupted.adopt(identity, input), /lost copy reply/);
  assert.equal((await materials.personal.list(identity, activity.activityId)).length, 1);
  const owner = createProjectMaterials(storage, { openActivity: learning.open, materials,
    authorizeReference: async () => {}, assertDispatch: async () => {} });
  const receipt = await owner.adopt(identity, input);
  assert.equal(receipt.activityId, activity.activityId);
  assert.deepEqual(await owner.receipt(identity, input.requestId), receipt);
  assert.equal((await materials.personal.list(identity, activity.activityId)).length, 1);
  await assert.rejects(owner.adopt(identity, { ...input, references: [] }), { code: 'identity-conflict' });
  await directory.update(identity, { requestId: randomUUID(), sessionId: session.sessionId, deleted: true });
  await materials.releaseDeleted(identity, { requestId: randomUUID(), sessionId: session.sessionId });
  const retained = (await materials.personal.list(identity, activity.activityId))[0];
  assert.equal((await materials.personal.versionContent(identity, activity.activityId, retained.materialId, 1)).text, '不可丢失的学习资料');
});
