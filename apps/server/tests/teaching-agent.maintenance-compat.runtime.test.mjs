import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { collectTeachingBoundary, validateTeachingBoundary, createTeachingAgent, teachingAgentMigrations } from '@xunjie/learning-space';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

const skillTables = ['teaching_skills', 'teaching_skill_versions', 'teaching_skill_selections', 'teaching_skill_loads'];
// These four layouts are the public inventories published independently by #215/#216/#217/#220.
const published = [
  { version: 1, skills: false, compactions: false },
  { version: 1, skills: false, compactions: true },
  { version: 2, skills: false, compactions: false },
  { version: 2, skills: true, compactions: false },
];
function oldInventory(current, profile) {
  const value = structuredClone(current);
  value.evidence.formatVersion = profile.version;
  if (!profile.skills) for (const table of skillTables) delete value.evidence.tables[table];
  if (!profile.compactions) delete value.evidence.tables.teaching_compactions;
  return value;
}
async function fixture() {
  const native = await nativeFixture();
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: native.admin, owner, password: randomUUID(), migrations: teachingAgentMigrations });
  const storage = await openStorage({ binding, migrations: teachingAgentMigrations,
    backend: createFileBackend({ id: 'files', root: join(native.root, 'objects') }) });
  return { owner, storage, async close() { await storage.close(); await native.close(); } };
}
async function close(storage) {
  await storage.participant().closeWrites(); await storage.participant().closeDispatch(); await storage.participant().drain();
}

test('each published inventory remains readable when omitted feature domains are empty', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    await close(f.storage);
    const current = await collectTeachingBoundary(f.storage);
    assert.equal(current.evidence.formatVersion, 3);
    await validateTeachingBoundary(f.storage, current);
    for (const profile of published) await validateTeachingBoundary(f.storage, oldInventory(current, profile));
    const corrupt = structuredClone(current);
    delete corrupt.evidence.tables.teaching_events;
    await assert.rejects(validateTeachingBoundary(f.storage, corrupt), { code: 'corrupt' });
    const future = structuredClone(current); future.evidence.formatVersion = 99;
    await assert.rejects(validateTeachingBoundary(f.storage, future), { code: 'incompatible' });
  } finally { await f.close(); }
});

test('an old inventory cannot hide an actual imported Skill after the branches are combined', { timeout: 60000 }, async () => {
  const f = await fixture();
  const agent = createTeachingAgent(f.storage, { start: false, authorize: async () => {}, identityFor: async value => value,
    activity: async () => { throw new Error('Boundary validation must not resolve an activity or execute tools.'); }, models: {} });
  try {
    const identity = { environmentId: f.owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'compatibility' };
    const imported = await agent.skills.import(identity, { requestId: randomUUID(), source: 'student:maintenance', packageVersion: '1.0.0',
      files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: retained-evidence\ndescription: 保存固定观察\n---\n按原观察解释。' }] });
    assert.equal((await agent.skills.list(identity)).skills[0].skillId, imported.skillId);
    agent.close(); await agent.drain(); await close(f.storage);
    const current = await collectTeachingBoundary(f.storage);
    assert.equal(current.evidence.tables.teaching_skills.count, 1);
    await validateTeachingBoundary(f.storage, current);
    await validateTeachingBoundary(f.storage, oldInventory(current, published[3]));
    for (const profile of published.slice(0, 3))
      await assert.rejects(validateTeachingBoundary(f.storage, oldInventory(current, profile)), { code: 'corrupt' });
  } finally { agent.close(); await agent.drain(); await f.close(); }
});
