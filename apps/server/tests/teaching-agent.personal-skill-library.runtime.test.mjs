import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StorageError } from '@xunjie/storage';
import { validateTeachingSkillLoads } from '@xunjie/learning-space';
import { createTeachingSkills } from '../../../packages/learning-space/dist/teaching-agent/skills.js';
import { fixture } from './support/teaching-input-control.mjs';

const packageInput = (name, extra = {}) => ({ requestId: randomUUID(), source: 'local:' + name, packageVersion: '1',
  files: [{ path: 'SKILL.md', encoding: 'utf8', content: `---\nname: ${name}\ndescription: Shared student guidance\n---\n${name} fixed body` }], ...extra });

test('one device library auto-enables imports across personal, school and course activities and keeps global toggles', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const base = await f.activity(), c = await f.controlled(base), primary = base.identity;
    const school = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), name: '学生', kind: 'school' };
    const secondSchool = { ...school, environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
    const anotherSpace = { ...primary, spaceId: randomUUID() }, otherStudent = { ...school, principalId: randomUUID() };
    const ownerKey = who => [who.environmentId, who.spaceId, who.principalId].join('/');
    const own = [primary, anotherSpace, school, secondSchool], admitted = [...own, otherStudent].map(ownerKey);
    const activities = [base, { ...base, activityId: randomUUID(), identity: anotherSpace },
      { ...base, activityId: randomUUID(), identity: school },
      { ...base, activityId: randomUUID(), identity: secondSchool, course: { courseId: randomUUID(), skills: [] } }];
    const options = {
      async authorize(who) { if (!admitted.includes(ownerKey(who))) throw new StorageError('forbidden'); },
      async activity(_who, id) { const value = activities.find(item => item.activityId === id); if (!value) throw new StorageError('missing'); return value; },
      assertWritable() {},
    };
    // A pre-global package keeps its original owner key and remains usable without reimporting.
    const legacy = createTeachingSkills(c.storage, options);
    const previous = await legacy.import(school, packageInput('previous-school-skill'));
    await legacy.select(school, { requestId: randomUUID(), range: { kind: 'self-study' }, skills: [] });
    const shared = () => createTeachingSkills(c.storage, { ...options,
      personalOwners: async who => own.some(item => ownerKey(item) === ownerKey(who)) ? own : [who] });
    const library = shared(), imported = await library.import(primary, packageInput('new-global-skill'));
    assert.equal(imported.selected, true); assert.equal(imported.disabled, false);
    for (const activity of activities) {
      const state = await shared().resolve({ identity: activity.identity, activity, input: { draft: { skills: [] } } });
      assert.deepEqual(new Set(state.catalog.filter(item => item.selected).map(item => item.skillId)), new Set([previous.skillId, imported.skillId]));
      assert.equal((await shared().read(activity.identity, activity.activityId, imported.skillId, 1, 'SKILL.md')).content, packageInput('new-global-skill').files[0].content);
    }
    assert.equal((await library.list(otherStudent)).skills.length, 0);
    await assert.rejects(library.disable(otherStudent, { requestId: randomUUID(), skillId: imported.skillId, disabled: true }), { code: 'missing' });
    const load = await library.load(secondSchool, activities[3].activityId, { skillId: imported.skillId, version: 1,
      runId: randomUUID(), stepId: randomUUID(), commandId: randomUUID() });
    assert.equal(load.complete, true);
    await validateTeachingSkillLoads(c.storage);
    await library.disable(school, { requestId: randomUUID(), skillId: imported.skillId, disabled: true });
    for (const activity of activities) {
      const state = await shared().resolve({ identity: activity.identity, activity });
      const entry = state.catalog.find(item => item.skillId === imported.skillId);
      assert.equal(entry.disabled, true); assert.equal(entry.selected, false);
      await assert.rejects(shared().read(activity.identity, activity.activityId, imported.skillId, 1, 'SKILL.md'));
    }
    await library.disable(secondSchool, { requestId: randomUUID(), skillId: imported.skillId, disabled: false });
    assert.equal((await shared().list(primary)).skills.find(item => item.skillId === imported.skillId).selected, true);
    const updated = await library.import(school, packageInput('new-global-skill', { skillId: imported.skillId, packageVersion: '2' }));
    assert.equal(updated.version, 2); assert.equal(updated.selected, true);
    const pinned = await library.resolve({ identity: primary, activity: base, input: { draft: { skills: [{ skillId: imported.skillId, version: 1 }] } } });
    assert.deepEqual(new Set(pinned.catalog.filter(item => item.selected).map(item => `${item.skillId}:${item.version}`)),
      new Set([`${previous.skillId}:1`, `${imported.skillId}:1`]));
  } finally { await f.close(); }
});

test('a stable student identity shares historical packages between spaces without a device association', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const activity = await f.activity(), c = await f.controlled(activity), first = activity.identity, second = { ...first, spaceId: randomUUID() };
    const library = createTeachingSkills(c.storage, { authorize: async () => {}, assertWritable() {},
      activity: async () => ({ ...activity, identity: second }) });
    const imported = await library.import(first, packageInput('same-student'));
    assert.equal((await library.list(second)).skills[0].skillId, imported.skillId);
    await library.disable(second, { requestId: randomUUID(), skillId: imported.skillId, disabled: true });
    assert.equal((await library.list(first)).skills[0].disabled, true);
  } finally { await f.close(); }
});
