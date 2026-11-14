import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { skillFixture, packageInput } from './support/session-skills.mjs';
import { createCourses, spaceCourseMigrations } from '../dist/courses/index.js';
import { createSpaces } from '../dist/spaces/index.js';
import { createLearningData, learningMigrations, validateLearningData } from '../dist/learning-data/index.js';
import { collectLearningSources, validateLearningSources } from '../dist/learning-data/source-closure.js';
import { createAgentSessions } from '../dist/learning-data/agent-sessions.js';
import { createSkills, validateSkills, collectSkillSources, validateSkillSources } from '../dist/learning-data/skills.js';

test('ordinary sessions discover personal skill metadata and choose fixed versions without manufacturing an activity', { timeout: 60000 }, async t => {
  const f = await skillFixture(t), input = packageInput('sorting'), imported = await f.skills.import(f.identity, input);
  const state = await f.skills.resolveSession(f.identity, f.session.sessionId);
  assert.equal(state.catalog[0].skillId, imported.skillId);
  assert.equal(state.catalog[0].selected, true);
  assert.equal('files' in state.catalog[0], false);
  assert.deepEqual(state.loaded, []);
  await f.skills.selectSession(f.identity, f.session.sessionId, { requestId: randomUUID(), skills: [] });
  assert.equal((await f.skills.resolveSession(f.identity, f.session.sessionId)).catalog[0].selected, false);
  assert.deepEqual(await f.data.list(f.identity), []);
});

test('session loads pin selection, module, package and exact original bytes; recovery never falls back to a same-name skill', { timeout: 60000 }, async t => {
  const f = await skillFixture(t), input = packageInput('sorting'), imported = await f.skills.import(f.identity, input);
  const state = await f.skills.resolveSession(f.identity, f.session.sessionId);
  const command = { skillId: imported.skillId, version: 1, commandId: randomUUID(), runId: randomUUID(), stepId: randomUUID(),
    selectionDigest: state.selectionDigest, packageDigest: imported.digest, moduleId: 'skills', moduleVersion: 1 };
  const loaded = await f.skills.loadSession(f.identity, f.session.sessionId, command);
  assert.equal(loaded.content, input.files[0].content);
  assert.equal(loaded.complete, true);
  await f.skills.remove(f.identity, { requestId: randomUUID(), skillId: imported.skillId });
  await f.skills.import(f.identity, packageInput('sorting', { source: 'local:replacement' }));
  assert.deepEqual(await f.skills.reconcileSession(f.identity, f.session.sessionId, command), loaded);
  await assert.rejects(f.skills.reconcileSession(f.identity, f.session.sessionId, { ...command, moduleVersion: 2 }), { code: 'identity-conflict' });
  await assert.rejects(f.skills.reconcileSession(f.identity, f.session.sessionId, { ...command, path: 'references/example.md' }), { code: 'identity-conflict' });
  await assert.rejects(f.skills.loadSession(f.identity, f.session.sessionId, { ...command, commandId: randomUUID() }));
  assert.deepEqual(await f.data.list(f.identity), []);
  f.deny();
  await assert.rejects(f.skills.reconcileSession(f.identity, f.session.sessionId, command), { code: 'forbidden' });
});

test('real course workspaces retain required/optional selections and reauthorize the course without automatically loading it', { timeout: 60000 }, async t => {
  const f = await skillFixture(t), schoolStorage = await f.open('school', spaceCourseMigrations), spaces = createSpaces(schoolStorage);
  const student = await spaces.createMember({ requestId: randomUUID(), loginName: 'student', password: 'synthetic-school-password' });
  const courses = createCourses(schoolStorage, spaces), courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
  const required = { ...packageInput('required-guidance'), skillId: randomUUID(), version: 1, required: true };
  const optional = { ...packageInput('optional-guidance'), skillId: randomUUID(), version: 1, required: false };
  const packages = [required, optional].map(({ requestId: _requestId, ...fixed }) => fixed);
  await courses.registerRelease({ formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '排序课程' },
    task: { taskId, title: '排序实践', summary: '' }, release: { releaseId, objectives: ['理解稳定性'], requirements: '分析排序',
      materials: [], starterWorks: [], capabilities: [], skills: packages, helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } }, resources: [] });
  await courses.setAccess({ requestId: randomUUID(), courseId, principalId: student.principalId, active: true });
  const data = createLearningData(f.storage, { resolveBinding: async actor => { await spaces.authorize(actor); return f.target; } }, courses);
  const activity = await data.createCourse(student, { requestId: randomUUID(), releaseId });
  const sessions = createAgentSessions(f.storage, { authorize: spaces.authorize, openActivity: data.open, resolveOwner: async () => f.session.owner });
  const session = await sessions.create(student, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'workspace-assistant',
    workspace: { activityId: activity.activityId, target: activity.target } });
  const owner = createSkills(f.storage, { authorize: spaces.authorize, activity: data.open, session: sessions.read,
    personalOwners: async () => [f.identity], assertWritable() {} });
  const first = await owner.resolveSession(student, session.sessionId);
  assert.equal(first.catalog.filter(item => item.origin === 'course').length, 2);
  assert.deepEqual(first.loaded, []);
  await owner.select(student, { requestId: randomUUID(), range: { kind: 'course', courseId }, skills: [] });
  const courseSelection = await owner.resolveSession(student, session.sessionId);
  assert.equal(courseSelection.catalog.find(item => item.skillId === required.skillId).selected, true);
  assert.equal(courseSelection.catalog.find(item => item.skillId === optional.skillId).selected, false);
  await owner.selectSession(student, session.sessionId, { requestId: randomUUID(), skills: [] });
  const selection = await owner.resolveSession(student, session.sessionId);
  assert.equal(selection.catalog.find(item => item.skillId === required.skillId).selected, true);
  assert.equal(selection.catalog.find(item => item.skillId === optional.skillId).selected, false);
  await owner.selectSession(student, session.sessionId, { requestId: randomUUID(), skills: [{ skillId: optional.skillId, version: 1 }] });
  const selected = await owner.resolveSession(student, session.sessionId);
  assert.equal(selected.catalog.filter(item => item.skillId === optional.skillId).length, 1);
  const command = { skillId: optional.skillId, version: 1, packageDigest: selected.catalog.find(item => item.skillId === optional.skillId).digest,
    selectionDigest: selected.selectionDigest, commandId: randomUUID(), runId: randomUUID(), stepId: randomUUID(), moduleId: 'skills', moduleVersion: 1 };
  assert.equal((await owner.loadSession(student, session.sessionId, command)).content, optional.files[0].content);
  await courses.setAccess({ requestId: randomUUID(), courseId, principalId: student.principalId, active: false });
  await assert.rejects(owner.resolveSession(student, session.sessionId), { code: 'forbidden' });
  await assert.rejects(owner.reconcileSession(student, session.sessionId, command), { code: 'forbidden' });
  await validateSkills(f.storage);
});

test('a session can keep an enabled historical package version after a personal library update', { timeout: 60000 }, async t => {
  const f = await skillFixture(t), original = packageInput('historical'), first = await f.skills.import(f.identity, original);
  await f.skills.import(f.identity, packageInput('historical', { skillId: first.skillId, packageVersion: '2',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: historical\ndescription: New version\n---\nNew body' }] }));
  await f.skills.selectSession(f.identity, f.session.sessionId, { requestId: randomUUID(), skills: [{ skillId: first.skillId, version: 1 }] });
  const state = await f.skills.resolveSession(f.identity, f.session.sessionId);
  assert.deepEqual(state.catalog.filter(item => item.selected).map(item => item.version), [1]);
  const loaded = await f.skills.loadSession(f.identity, f.session.sessionId, { skillId: first.skillId, version: 1,
    packageDigest: first.digest, selectionDigest: state.selectionDigest, runId: randomUUID(), stepId: randomUUID(), commandId: randomUUID(), moduleId: 'skills', moduleVersion: 1 });
  assert.equal(loaded.content, original.files[0].content);
});

test('skill maintenance verifies fixed original bytes and session scope without a live member or remote course call', { timeout: 60000 }, async t => {
  const f = await skillFixture(t), imported = await f.skills.import(f.identity, packageInput('maintenance'));
  const state = await f.skills.resolveSession(f.identity, f.session.sessionId);
  const input = { skillId: imported.skillId, version: 1, commandId: randomUUID(), runId: randomUUID(), stepId: randomUUID(),
    selectionDigest: state.selectionDigest, packageDigest: imported.digest, moduleId: 'skills', moduleVersion: 1, offset: 3, length: 17 };
  await f.skills.loadSession(f.identity, f.session.sessionId, input);
  const sources = await collectSkillSources(f.storage);
  assert.ok(sources.entries.some(entry => entry.kind === 'session_skill_loads' && entry.fixedId === input.commandId));
  f.deny();
  await validateSkills(f.storage);
  await validateSkillSources(f.storage, sources);
  await f.storage.request({ requestId: randomUUID(), fingerprint: 'corrupt-skill-load-test' }, async tx => {
    await tx.query("UPDATE session_skill_loads SET body=jsonb_set(body,'{loaded,content}',to_jsonb('changed'::text)) WHERE command_id=$1", [input.commandId]);
    return null;
  });
  await assert.rejects(validateSkills(f.storage), { code: 'corrupt' });
  await assert.rejects(validateSkillSources(f.storage, sources), { code: 'corrupt' });
});

test('a public owner transfer preserves existing library IDs, historical versions and toggles without cross-owner SQL', { timeout: 60000 }, async t => {
  const source = await skillFixture(t), destination = await skillFixture(t);
  const first = await source.skills.import(source.identity, packageInput('transfer'));
  await source.skills.import(source.identity, packageInput('transfer', { skillId: first.skillId, packageVersion: '2', files: [
    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: transfer\ndescription: Second fixed version\n---\nsecond original body' } ] }));
  await source.skills.disable(source.identity, { requestId: randomUUID(), skillId: first.skillId, disabled: true });
  const snapshot = await source.skills.exportLibrary(source.identity), request = { requestId: randomUUID(), library: snapshot };
  await destination.skills.adoptLibrary(destination.identity, request);
  await destination.skills.adoptLibrary(destination.identity, request);
  const catalog = await destination.skills.list(destination.identity);
  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.skills[0].skillId, first.skillId);
  assert.equal(catalog.skills[0].version, 2);
  assert.equal(catalog.skills[0].disabled, true);
  assert.equal((await destination.skills.document(destination.identity, { skillId: first.skillId, version: 1 })).content,
    packageInput('transfer').files[0].content);
  await validateSkills(destination.storage);
  source.deny();
  await assert.rejects(source.skills.exportLibrary(source.identity), { code: 'forbidden' });
});

test('the registered learning owner exposes independent library permissions, maintenance and source closure without a session', { timeout: 60000 }, async t => {
  const f = await skillFixture(t), storage = await f.open('registered-learning', learningMigrations);
  const data = createLearningData(storage, { resolveBinding: async identity => { await f.host.authorize(identity); return { ...storage.owner, version: 1 }; } });
  const owner = createSkills(storage, { authorize: f.host.authorize, activity: data.open, assertWritable() {} });
  const imported = await owner.import(f.identity, packageInput('registered-library'));
  assert.equal((await owner.list(f.identity)).skills[0].skillId, imported.skillId);
  assert.equal((await owner.document(f.identity, { skillId: imported.skillId, version: 1 })).content,
    packageInput('registered-library').files[0].content);
  const selected = await owner.select(f.identity, { requestId: randomUUID(), range: { kind: 'self-study' },
    skills: [{ skillId: imported.skillId, version: 1 }] });
  assert.ok(selected.selections.some(item => item.range.kind === 'self-study'));
  assert.equal((await owner.disable(f.identity, { requestId: randomUUID(), skillId: imported.skillId, disabled: true })).disabled, true);
  assert.deepEqual(await owner.remove(f.identity, { requestId: randomUUID(), skillId: imported.skillId }), { skillId: imported.skillId });
  assert.deepEqual((await owner.list(f.identity)).skills, []);
  assert.deepEqual(await data.list(f.identity), []);
  await assert.rejects(owner.list({ ...f.identity, principalId: randomUUID() }), { code: 'forbidden' });
  await validateLearningData(storage);
  const closure = await collectLearningSources(storage);
  assert.ok(closure.entries.some(entry => entry.kind === 'teaching_skill_versions' && entry.fixedId.includes(imported.skillId)));
  await validateLearningSources(storage, closure);
  await storage.request({ requestId: randomUUID(), fingerprint: 'registered-skill-corruption' }, async tx => {
    await tx.query("UPDATE teaching_skill_versions SET body=jsonb_set(body,'{files,0,content}',to_jsonb('damaged'::text)) WHERE skill_id=$1", [imported.skillId]);
    return null;
  });
  await assert.rejects(validateLearningData(storage), { code: 'corrupt' });
});
