import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StorageError } from '@xunjie/storage';
import { createSkills, validateSkills } from '@xunjie/learning-space/learning-data/skills';
import { ownerStorage, sessionDirectory, openSession, loadCommand } from './support/learning-owner.mjs';

const packageInput = (name, extra = {}) => ({ requestId: randomUUID(), source: 'local:' + name, packageVersion: '1',
  files: [{ path: 'SKILL.md', encoding: 'utf8', content: `---\nname: ${name}\ndescription: Shared student guidance\n---\n${name} fixed body` }], ...extra });

test('one device library shares imports across trusted personal and school sessions and keeps global toggles', { timeout: 180000 }, async t => {
  const f = await ownerStorage(t);
  const primary = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), name: '学生', kind: 'personal' };
  const school = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), name: '学生', kind: 'school' };
  const secondSchool = { ...school, environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const anotherSpace = { ...primary, spaceId: randomUUID() }, otherStudent = { ...school, principalId: randomUUID() };
  const ownerKey = who => [who.environmentId, who.spaceId, who.principalId, who.kind].join('/');
  const own = [primary, anotherSpace, school, secondSchool], admitted = [...own, otherStudent].map(ownerKey);
  const authorize = async who => { if (!admitted.includes(ownerKey(who))) throw new StorageError('forbidden'); };
  const activity = async () => { throw new Error('Ordinary sessions must not fabricate an activity'); };
  const sessions = sessionDirectory(f.storage, authorize, activity);
  const directory = await Promise.all(own.map(async identity => ({ identity, session: await openSession(sessions, identity) })));
  const options = { authorize, activity, session: sessions.read, assertWritable() {} };
  const independent = createSkills(f.storage, options);
  const previous = await independent.import(school, packageInput('previous-school-skill'));
  const shared = () => createSkills(f.storage, { ...options,
    personalOwners: async who => own.some(item => ownerKey(item) === ownerKey(who)) ? own : [who] });
  const library = shared(), input = packageInput('new-global-skill'), imported = await library.import(primary, input);
  assert.equal(imported.selected, true); assert.equal(imported.disabled, false);
  for (const { identity, session } of directory) {
    const state = await shared().resolveSession(identity, session.sessionId);
    assert.deepEqual(new Set(state.catalog.filter(item => item.selected).map(item => item.skillId)), new Set([previous.skillId, imported.skillId]));
    assert.deepEqual(state.loaded, [], 'Discovery does not load a body');
    const command = await loadCommand(library, identity, session.sessionId, imported);
    assert.equal((await library.loadSession(identity, session.sessionId, command)).content, input.files[0].content);
  }
  assert.equal((await library.list(otherStudent)).skills.length, 0);
  await assert.rejects(library.disable(otherStudent, { requestId: randomUUID(), skillId: imported.skillId, disabled: true }), { code: 'missing' });
  await assert.rejects(library.import(otherStudent, packageInput('new-global-skill', { skillId: imported.skillId, packageVersion: 'forged-update' })), { code: 'missing' });
  await assert.rejects(library.document(otherStudent, { skillId: imported.skillId, version: 1 }), { code: 'missing' });
  const foreignSession = await openSession(sessions, otherStudent);
  await assert.rejects(library.selectSession(otherStudent, foreignSession.sessionId, { requestId: randomUUID(), skills: [{ skillId: imported.skillId, version: 1 }] }), { code: 'missing' });
  const foreign = await library.resolveSession(otherStudent, foreignSession.sessionId);
  assert.deepEqual(foreign.catalog, []);
  assert.deepEqual(foreign.loaded, []);
  await assert.rejects(library.loadSession(otherStudent, foreignSession.sessionId, {
    skillId: imported.skillId, version: 1, packageDigest: imported.digest, selectionDigest: foreign.selectionDigest,
    commandId: randomUUID(), runId: randomUUID(), stepId: randomUUID(), moduleId: 'skills', moduleVersion: 1,
  }));
  const { session } = directory[3], command = await loadCommand(library, secondSchool, session.sessionId, imported);
  const loaded = await library.loadSession(secondSchool, session.sessionId, command);
  assert.equal(loaded.complete, true);
  await library.disable(school, { requestId: randomUUID(), skillId: imported.skillId, disabled: true });
  for (const { identity, session } of directory) {
    const state = await shared().resolveSession(identity, session.sessionId), entry = state.catalog.find(item => item.skillId === imported.skillId);
    assert.equal(entry.disabled, true); assert.equal(entry.selected, false);
  }
  await assert.rejects(library.loadSession(secondSchool, session.sessionId, { ...command, commandId: randomUUID() }));
  assert.deepEqual(await library.reconcileSession(secondSchool, session.sessionId, command), loaded, 'An existing receipt is retained as history');
  await library.disable(secondSchool, { requestId: randomUUID(), skillId: imported.skillId, disabled: false });
  assert.equal((await shared().list(primary)).skills.find(item => item.skillId === imported.skillId).selected, true);
  const updated = await library.import(school, packageInput('new-global-skill', { skillId: imported.skillId, packageVersion: '2' }));
  assert.equal(updated.version, 2); assert.equal(updated.selected, true);
  const selected = await library.selectSession(primary, directory[0].session.sessionId, { requestId: randomUUID(), skills: [
    { skillId: previous.skillId, version: 1 }, { skillId: imported.skillId, version: 1 },
  ] });
  assert.deepEqual(new Set(selected.catalog.filter(item => item.selected).map(item => `${item.skillId}:${item.version}`)),
    new Set([`${previous.skillId}:1`, `${imported.skillId}:1`]));
  await validateSkills(f.storage);
});

test('a stable student identity shares historical packages between spaces without a device association', { timeout: 180000 }, async t => {
  const f = await ownerStorage(t);
  const first = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), name: '学生', kind: 'personal' };
  const second = { ...first, spaceId: randomUUID() };
  const library = createSkills(f.storage, { authorize: async () => {}, assertWritable() {},
    activity: async () => { throw new Error('No activity is needed for the library'); } });
  const imported = await library.import(first, packageInput('same-student'));
  assert.equal((await library.list(second)).skills[0].skillId, imported.skillId);
  await library.disable(second, { requestId: randomUUID(), skillId: imported.skillId, disabled: true });
  assert.equal((await library.list(first)).skills[0].disabled, true);
});

test('session dependency and tool declarations constrain availability without granting undeclared executors or loading source bodies', { timeout: 60000 }, async t => {
  const f = await ownerStorage(t), identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), name: '学生', kind: 'personal' };
  const authorize = async () => {}, activity = async () => { throw new Error('No activity is required'); };
  const sessions = sessionDirectory(f.storage, authorize, activity), session = await openSession(sessions, identity);
  const library = createSkills(f.storage, { authorize, activity, session: sessions.read, assertWritable() {} });
  for (const [name, declaration, reason] of [
    ['missing-dependency', 'dependencies: [not-installed]', 'dependency-missing'],
    ['unapproved-tool', 'allowed-tools: shell', 'tool-unavailable'],
  ]) {
    const input = packageInput(name);
    input.files[0].content = input.files[0].content.replace('\n---\n', `\n${declaration}\n---\n`);
    const imported = await library.import(identity, input);
    const state = await library.resolveSession(identity, session.sessionId, ['skill_load', 'skill_read']);
    assert.equal(state.catalog.find(item => item.skillId === imported.skillId).unavailable.reason, reason);
    assert.deepEqual(state.loaded, []);
    await assert.rejects(library.loadSession(identity, session.sessionId, {
      skillId: imported.skillId, version: 1, packageDigest: imported.digest, selectionDigest: state.selectionDigest,
      commandId: randomUUID(), runId: randomUUID(), stepId: randomUUID(), moduleId: 'skills', moduleVersion: 1,
    }, { toolNames: ['skill_load', 'skill_read'] }));
  }
  await validateSkills(f.storage);
});
