import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../storage/test/native-fixture.mjs';
import { createLearningData, learningMigrations } from '../../dist/learning-data/index.js';
import { createAgentSessions, agentSessionMigration } from '../../dist/learning-data/agent-sessions.js';
import { sessionMaterialMigration } from '../../dist/learning-data/session-materials.js';
import { personalProjectMigration } from '../../dist/learning-data/personal-projects.js';
import { createSkills, learningSkillsMigration } from '../../dist/learning-data/skills.js';

export const packageInput = (name, extra = {}) => ({ requestId: randomUUID(), source: 'local:' + name, packageVersion: '1',
  files: [{ path: 'SKILL.md', encoding: 'utf8', content: `---\nname: ${name}\ndescription: Fixed student guidance\n---\nOriginal ${name} body` },
    { path: 'references/example.md', encoding: 'utf8', content: 'An inert attachment.' }], ...extra });
export async function skillFixture(t) {
  const pg = await nativeFixture(), handles = [], cleanups = [];
  t.after(async () => { try { for (const cleanup of cleanups.reverse()) await cleanup(); for (const storage of handles.reverse()) await storage.close(); } finally { await pg.close(); } });
  const migrations = [...learningMigrations.filter(m => m.version < 31), agentSessionMigration, sessionMaterialMigration, personalProjectMigration, learningSkillsMigration];
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, target = { ...owner, version: 1 };
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations });
  const backend = createFileBackend({ id: 'skills', root: pg.root + '/objects' });
  const storage = await openStorage({ binding, backend, migrations }); handles.push(storage);
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  let allowed = true;
  const authorize = async actor => {
    if (!allowed || actor.environmentId !== identity.environmentId || actor.spaceId !== identity.spaceId
      || actor.principalId !== identity.principalId || actor.kind !== identity.kind) throw new StorageError('forbidden');
  };
  const data = createLearningData(storage, { resolveBinding: async actor => { await authorize(actor); return target; } });
  const agentOwner = { version: 1, connectionId: randomUUID(), installationId: randomUUID(), delivery: 'service', grantId: randomUUID(),
    executionGrantId: randomUUID(), target: { ...owner, unit: 'teaching-agent', endpoint: 'https://fixture.invalid', protocolVersion: 1, capabilities: [] } };
  const sessions = createAgentSessions(storage, { authorize, openActivity: data.open, resolveOwner: async () => agentOwner });
  const session = await sessions.create(identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  const host = { authorize, activity: data.open, session: sessions.read, assertWritable() {} };
  const skills = createSkills(storage, host);
  async function open(name, nextMigrations) {
    const nextBinding = await provisionStorage({ admin: pg.admin, owner: { environmentId: owner.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: nextMigrations });
    const next = await openStorage({ binding: nextBinding, migrations: nextMigrations, backend: createFileBackend({ id: name, root: pg.root + '/' + name }) });
    handles.push(next); return next;
  }
  return { storage, identity, target, data, sessions, session, host, skills, open,
    beforeClose(cleanup) { cleanups.push(cleanup); }, deny() { allowed = false; } };
}
