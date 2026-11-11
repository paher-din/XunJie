import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { createLearningEntry, teachingAgentHttpCall, teachingAgentMigrations, validateTeachingSkillLoads } from '../../../packages/learning-space/dist/index.js';
import { createTeachingSkills, validateTeachingSkills } from '../../../packages/learning-space/dist/teaching-agent/skills.js';
import { parseTeachingSkillPackage, validateTeachingSkillVersion } from '../../../packages/learning-space/dist/teaching-agent/skills-package.js';
import { createTeachingAgentClient, createTeachingAgentService } from '../../../packages/learning-space/dist/teaching-agent/service.js';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

const identity = () => ({ environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' });
const ownerKey = who => [who.environmentId, who.spaceId, who.principalId].join('/');
const packageInput = (body = '原始指导正文', extra = {}) => ({ requestId: randomUUID(), source: 'student:settings', packageVersion: '1',
  files: [{ path: 'SKILL.md', encoding: 'utf8', content: `---\nname: settings-guidance\ndescription: 固定指导\n---\n${body}` },
    { path: 'references/check.md', encoding: 'utf8', content: '原始附件' }], ...extra });

test('skill packages accept extension frontmatter and preserve original bytes through validation', () => {
  const content = '---\nname: custom-guidance\ndescription: 按实际问题提供指导\nwhen_to_use:\n  - 需要解释问题时\ndispatch_intent:\n  mode: explain\nallowed-tools: skill_load skill_read\n---\n# 指导\n先读取原始依据。\n';
  const input = packageInput('', { files: [{ path: 'SKILL.md', encoding: 'utf8', content }] });
  const parsed = parseTeachingSkillPackage(input);
  assert.deepEqual(parsed.metadata, { name: 'custom-guidance', description: '按实际问题提供指导',
    dependencies: [], conflicts: [], 'allowed-tools': ['skill_load', 'skill_read'] });
  assert.equal(parsed.files[0].content, content);
  const fixed = { ...parsed, skillId: randomUUID(), version: 1 };
  assert.deepEqual(validateTeachingSkillVersion(fixed), fixed);
  const changed = parseTeachingSkillPackage({ ...input, files: [{ ...input.files[0], content: content.replace('mode: explain', 'mode: review') }] });
  assert.notEqual(changed.digest, parsed.digest, 'Extension fields remain part of the original fixed package');
});

async function storageFixture(t, migrations = teachingAgentMigrations) {
  const postgres = await nativeFixture();
  let storage;
  t.after(async () => { await storage?.close(); await postgres.close(); });
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, password = randomUUID();
  let binding = await provisionStorage({ admin: postgres.admin, owner, password, migrations });
  const backend = createFileBackend({ id: 'files', root: join(postgres.root, 'objects') });
  storage = await openStorage({ binding, backend, migrations });
  return { get storage() { return storage; }, async reopen() {
    await storage.participant().closeWrites(); await storage.participant().closeDispatch(); await storage.participant().drain();
    await storage.close();
    binding = await provisionStorage({ admin: postgres.admin, owner, password, migrations: teachingAgentMigrations });
    storage = await openStorage({ binding, backend, migrations: teachingAgentMigrations });
    await storage.participant().resume();
  } };
}

// Exercise production HTTP -> remote client -> service -> real PostgreSQL owner without an activity.
async function settingsServer(t, library, initialIdentity) {
  let current = initialIdentity, entry;
  const calls = [];
  const service = createTeachingAgentService({ skills: library }, async (_who, activityId) => {
    assert.equal(activityId, undefined, 'Settings operations must not need an activity');
  });
  const server = createServer((req, res) => { void entry(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  entry = createLearningEntry({ environment: { environmentId: initialIdentity.environmentId, profile: 'local', clientNamespace: 'test', services: [{ endpoint }] },
    target: {}, spaces: { personal: async () => current, bindMember: async () => {} }, learning: {}, administratorToken: 'unused',
    teachingSettingsFor: async who => createTeachingAgentClient('settings-test', who, undefined, async call => {
      calls.push(call); return service(call);
    }),
    client: { forward: async (_connection, route, body, expected, search) => {
      if (expected && expected !== [current.environmentId, current.spaceId, current.principalId].join('.')) throw new StorageError('forbidden');
      const call = teachingAgentHttpCall(current, route, body === undefined ? 'GET' : 'POST', body, search);
      calls.push(call); return service(call);
    } } });
  return { calls, as(who) { current = who; }, async raw(route, body, headers = {}) {
    const response = await fetch(endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json',
      'x-xj-space': 'personal', 'x-xj-namespace': 'test', ...headers },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  } };
}

test('skill format failures reach the settings client with a specific reason', async t => {
  const api = await settingsServer(t, { async import(_identity, input) { return parseTeachingSkillPackage(input); } }, identity());
  for (const [header, reason] of [
    ['name: invalid_name\ndescription: 说明', 'name'],
    ['name: valid-name', 'description'],
    ['name: valid-name\ndescription: [未闭合', 'frontmatter'],
  ]) {
    const input = packageInput('', { files: [{ path: 'SKILL.md', encoding: 'utf8', content: `---\n${header}\n---\n正文` }] });
    assert.deepEqual(await api.raw('skills/import', input), { status: 400, body: { error: 'invalid-skill', reason } });
  }
});

test('settings document and removal cross HTTP and remote service with ownership, tombstones and historical reads intact', { timeout: 180000 }, async t => {
  const f = await storageFixture(t), owner = identity(), samePerson = { ...owner, spaceId: randomUUID() };
  const linkedSchool = { ...identity(), kind: 'school' };
  const another = { ...owner, principalId: randomUUID() }, anotherEnvironment = { ...owner, environmentId: randomUUID() };
  const activity = { activityId: randomUUID(), identity: owner, status: 'open' };
  const courseId = randomUUID(), courseInput = packageInput('课程正文');
  activity.course = { skills: [{ skillId: courseId, version: 1, source: courseInput.source,
    packageVersion: courseInput.packageVersion, files: courseInput.files, required: true }] };
  const library = createTeachingSkills(f.storage, { authorize: async () => {}, assertWritable() {}, activity: async () => activity,
    personalOwners: async who => [owner, samePerson, linkedSchool].some(item => ownerKey(item) === ownerKey(who)) ? [owner, linkedSchool] : [who] });
  const api = await settingsServer(t, library, owner);
  const ok = async (route, input) => { const result = await api.raw(route, input); assert.equal(result.status, 200, JSON.stringify(result)); return result.body; };
  const original = packageInput();
  original.files[0].content = original.files[0].content.replace('\n---\n', '\nwhen_to_use: student question\ndispatch_intent: explain\n---\n');
  const imported = await ok('skills/import', original);
  const ref = { skillId: imported.skillId, version: imported.version };
  const document = { ...ref, content: original.files[0].content };
  assert.deepEqual(await ok('skills/document', ref), document);
  await ok('skills/import', packageInput('第二版正文', { skillId: ref.skillId, packageVersion: '2' }));
  assert.deepEqual(await ok('skills/document', ref), document, 'Document reads the requested immutable version');
  assert.equal((await api.raw('skills/document', { ...ref, version: 99 })).status, 404);
  assert.equal((await api.raw('skills/document', { ...ref, path: 'references/check.md' })).status, 400);
  assert.equal((await api.raw('skills/document', ref, { 'x-xj-expected-subject': 'other' })).status, 403);
  for (const who of [another, anotherEnvironment]) {
    api.as(who);
    assert.equal((await api.raw('skills/document', ref)).status, 404);
    assert.equal((await api.raw('skills/remove', { requestId: randomUUID(), skillId: ref.skillId })).status, 404);
  }
  api.as(samePerson);
  assert.deepEqual(await ok('skills/document', ref), document, 'The same person may read across spaces');
  api.as(linkedSchool);
  assert.deepEqual(await ok('skills/document', ref), document, 'A trusted device association keeps the same personal library');
  const schoolHeaders = { 'x-xj-space': 'school:' + randomUUID() };
  assert.deepEqual(await api.raw('skills/document', ref, schoolHeaders), { status: 200, body: document },
    'School forwarding maps document reads to the remote operation without an activity');
  await ok('skills/disable', { requestId: randomUUID(), skillId: ref.skillId, disabled: true });
  assert.deepEqual(await ok('skills/document', ref), document, 'Disabled packages remain readable');
  await ok('skills/disable', { requestId: randomUUID(), skillId: ref.skillId, disabled: false });
  api.as(owner);
  const loadInput = { ...ref, runId: randomUUID(), stepId: randomUUID(), commandId: randomUUID(), path: 'references/check.md' };
  const loaded = await library.load(owner, activity.activityId, loadInput, { references: [ref] });
  await ok('skills/select', { requestId: randomUUID(), range: { kind: 'all' }, skills: [ref] });
  const remove = { requestId: randomUUID(), skillId: ref.skillId };
  const results = await Promise.all([ok('skills/remove', remove), ok('skills/remove', remove)]);
  assert.deepEqual(results, [{ skillId: ref.skillId }, { skillId: ref.skillId }]);
  const before = (await f.storage.read('SELECT xmin::text AS revision FROM teaching_skills WHERE skill_id=$1', [ref.skillId])).rows;
  assert.deepEqual(await ok('skills/remove', remove), { skillId: ref.skillId });
  assert.deepEqual((await f.storage.read('SELECT xmin::text AS revision FROM teaching_skills WHERE skill_id=$1', [ref.skillId])).rows, before,
    'Receipt replay must not run the update again');
  assert.deepEqual(await ok('skills/remove', { ...remove, requestId: randomUUID() }), { skillId: ref.skillId });
  assert.deepEqual((await ok('skills')).skills, []);
  assert.equal((await api.raw('skills/document', ref)).status, 404);
  assert.equal((await api.raw('skills/select', { requestId: randomUUID(), range: { kind: 'all' }, skills: [ref] })).status, 404);
  assert.equal((await api.raw('skills/disable', { requestId: randomUUID(), skillId: ref.skillId, disabled: false })).status, 404);
  assert.equal((await api.raw('skills/import', packageInput('更新', { skillId: ref.skillId, packageVersion: '3' }))).status, 404);
  assert.equal((await api.raw('skills/remove', { ...remove, skillId: randomUUID() })).status, 409, 'A receipt cannot be reused for different input');
  const state = await library.resolve({ identity: owner, activity });
  assert.ok(!state.catalog.some(item => item.skillId === ref.skillId));
  assert.ok(state.catalog.some(item => item.skillId === courseId && item.origin === 'course'), 'Removing a personal package leaves course packages available');
  await assert.rejects(library.read(owner, activity.activityId, ref.skillId, ref.version, 'SKILL.md', { references: [ref] }));
  await assert.rejects(library.freeze(owner, [ref]), { code: 'missing' });
  assert.deepEqual(await library.reconcile(owner, activity.activityId, loadInput.commandId), loaded);
  assert.deepEqual(await library.loaded(owner, activity.activityId, loadInput.runId), [loaded]);
  assert.equal((await api.raw('skills/document', { skillId: courseId, version: 1 })).status, 404);
  assert.equal((await api.raw('skills/remove', { requestId: randomUUID(), skillId: courseId })).status, 404);
  await validateTeachingSkills(f.storage); await validateTeachingSkillLoads(f.storage);
  const again = await ok('skills/import', { ...original, requestId: randomUUID() });
  assert.notEqual(again.skillId, ref.skillId);
  assert.equal((await ok('skills')).skills.length, 1);
  assert.deepEqual(await ok('skills/document', { skillId: again.skillId, version: 1 }), { skillId: again.skillId, version: 1, content: document.content });
  api.as(linkedSchool);
  assert.deepEqual(await api.raw('skills/remove', { requestId: randomUUID(), skillId: again.skillId }, schoolHeaders),
    { status: 200, body: { skillId: again.skillId } }, 'School forwarding maps removal to the same personal owner');
  api.as(owner);
  assert.deepEqual((await ok('skills')).skills, [], 'Removal through an associated identity affects the same device library');
  assert.ok(api.calls.some(call => call.operation === 'skills.document'));
  assert.ok(api.calls.some(call => call.operation === 'skills.remove'));
});

test('reimporting identical skill files across associated spaces returns the current disabled entry', { timeout: 60000 }, async t => {
  const f = await storageFixture(t), owner = identity(), linked = { ...identity(), kind: 'school' };
  const options = { authorize: async () => {}, assertWritable() {},
    activity: async () => { throw new StorageError('missing'); }, personalOwners: async () => [owner, linked] };
  const library = createTeachingSkills(f.storage, options);
  const api = await settingsServer(t, library, owner);
  const ok = async (route, input) => { const result = await api.raw(route, input); assert.equal(result.status, 200, JSON.stringify(result)); return result.body; };
  const input = packageInput('重复导入指导', { packageVersion: '2026-11-11T01:00:00.000Z' });
  const original = await ok('skills/import', input);
  const disabled = await ok('skills/disable', { requestId: randomUUID(), skillId: original.skillId, disabled: true });
  api.as(linked);
  const repeated = { ...input, requestId: randomUUID(), packageVersion: '2026-11-11T01:00:01.000Z', files: [...input.files].reverse() };
  assert.deepEqual(await ok('skills/import', repeated), disabled, 'A new request and timestamp must reuse the existing disabled entry');
  assert.deepEqual(await ok('skills/import', repeated), disabled, 'The duplicate import has a replayable receipt');
  assert.deepEqual((await ok('skills')).skills, [disabled]);
  assert.equal((await api.raw('skills/import', { ...repeated, source: 'another:source' })).status, 409,
    'A duplicate receipt still rejects changed input');
  await f.reopen();
  const reopened = await settingsServer(t, createTeachingSkills(f.storage, options), linked);
  assert.deepEqual(await reopened.raw('skills/import', { ...repeated, requestId: randomUUID(), packageVersion: 'after-reopen' }), { status: 200, body: disabled });
});

test('skill import compares exact paths and bytes within the same source and current personal owner', { timeout: 60000 }, async t => {
  const f = await storageFixture(t), owner = identity();
  const library = createTeachingSkills(f.storage, { authorize: async () => {}, assertWritable() {},
    activity: async () => { throw new StorageError('missing'); } });
  const api = await settingsServer(t, library, owner);
  const ok = async (route, input) => { const result = await api.raw(route, input); assert.equal(result.status, 200, JSON.stringify(result)); return result.body; };
  const input = packageInput();
  input.files.push({ path: 'assets/sample.bin', encoding: 'base64', content: 'AAEC/w==' });
  const original = await ok('skills/import', input);
  const reimport = (extra = {}) => ok('skills/import', { ...input, requestId: randomUUID(), ...extra });
  assert.deepEqual(await reimport({ files: input.files.map(file => file.path === 'references/check.md'
    ? { ...file, encoding: 'base64', content: Buffer.from(file.content).toString('base64'), mediaType: 'application/octet-stream' }
    : file).reverse() }), original, 'File order, transport encoding and media type do not change paths or bytes');
  for (const extra of [
    { files: input.files.map(file => file.path === 'references/check.md' ? { ...file, content: '不同附件' } : file) },
    { files: input.files.map(file => file.path === 'assets/sample.bin' ? { ...file, content: 'AAED/w==' } : file) },
    { files: input.files.map(file => file.path === 'references/check.md' ? { ...file, path: 'references/renamed.md' } : file) },
    { files: input.files.filter(file => file.path !== 'assets/sample.bin') },
    { source: 'another:source' },
  ]) assert.notEqual((await reimport(extra)).skillId, original.skillId, 'Different bytes, file paths, file sets or sources remain separate imports');
  assert.equal((await ok('skills')).skills.length, 6);
  api.as({ ...owner, spaceId: randomUUID() });
  assert.deepEqual(await reimport(), original, 'The same person shares a library across spaces');
  for (const who of [{ ...owner, principalId: randomUUID() }, { ...owner, environmentId: randomUUID() }]) {
    api.as(who);
    assert.notEqual((await reimport()).skillId, original.skillId, 'Unassociated owners keep independent libraries');
    assert.equal((await ok('skills')).skills.length, 1);
  }
  api.as(owner);
  await ok('skills/disable', { requestId: randomUUID(), skillId: original.skillId, disabled: true });
  const updated = await reimport({ skillId: original.skillId, packageVersion: '2' });
  assert.equal(updated.skillId, original.skillId);
  assert.equal(updated.version, 2, 'Explicit updates still publish a version even when bytes match');
  assert.equal(updated.disabled, true, 'Explicit updates preserve the disabled state');
  assert.equal(updated.selected, false);
  assert.deepEqual(await reimport({ packageVersion: 'fresh-timestamp' }), updated, 'Implicit import returns the current published version');
  assert.deepEqual(await reimport({ skillId: original.skillId, packageVersion: '2' }), updated);
  assert.equal((await api.raw('skills/import', packageInput('改变正文', { skillId: original.skillId, packageVersion: '2' }))).status, 409);
  assert.equal((await api.raw('skills/import', { ...input, requestId: randomUUID(), skillId: original.skillId, source: 'different', packageVersion: '3' })).status, 409);
  assert.equal((await api.raw('skills/import', { ...input, requestId: randomUUID(), skillId: randomUUID() })).status, 404);
  const newest = await ok('skills/import', packageInput('新的当前正文', { skillId: original.skillId, packageVersion: '3' }));
  assert.equal(newest.version, 3);
  const historical = await reimport({ packageVersion: 'historical-content' });
  assert.notEqual(historical.skillId, original.skillId, 'Historical versions do not block a fresh import of their old contents');
  await ok('skills/remove', { requestId: randomUUID(), skillId: historical.skillId });
  assert.notEqual((await reimport()).skillId, historical.skillId, 'Removed entries do not block a fresh import');
  await validateTeachingSkills(f.storage);
});

test('explicit skill updates preserve state, recover after conflicts and make historical packages current', { timeout: 60000 }, async t => {
  const f = await storageFixture(t), owner = identity();
  const options = { authorize: async () => {}, assertWritable() {}, activity: async () => { throw new StorageError('missing'); } };
  const api = await settingsServer(t, createTeachingSkills(f.storage, options), owner);
  const ok = async (route, input) => { const result = await api.raw(route, input); assert.equal(result.status, 200, JSON.stringify(result)); return result.body; };
  const source = `https://github.com/example/skills/tree/${'a'.repeat(40)}/skills/demo`;
  const originalInput = packageInput('GitHub 原始正文', { source, packageVersion: 'a'.repeat(40) });
  const original = await ok('skills/import', originalInput);
  await ok('skills/disable', { requestId: randomUUID(), skillId: original.skillId, disabled: true });
  const update = packageInput('GitHub 最新正文', { skillId: original.skillId, source, packageVersion: 'b'.repeat(40) });
  const updated = await ok('skills/import', update);
  assert.equal(updated.version, 2);
  assert.equal(updated.source, source, 'The library source identity stays pinned while packageVersion changes');
  assert.equal(updated.packageVersion, 'b'.repeat(40));
  assert.equal(updated.disabled, true); assert.equal(updated.selected, false);
  const before = (await f.storage.read('SELECT xmin::text AS revision FROM teaching_skills WHERE skill_id=$1', [original.skillId])).rows;
  assert.deepEqual(await ok('skills/import', update), updated, 'Receipt replay preserves the update result');
  assert.deepEqual(await ok('skills/import', { ...update, requestId: randomUUID() }), updated, 'The current package is a no-op');
  assert.deepEqual((await f.storage.read('SELECT xmin::text AS revision FROM teaching_skills WHERE skill_id=$1', [original.skillId])).rows, before);
  const retryId = randomUUID();
  assert.equal((await api.raw('skills/import', { ...update, requestId: retryId,
    files: packageInput('冲突正文').files })).status, 409);
  assert.deepEqual((await ok('skills')).skills, [updated], 'Failed updates preserve the current package and disabled state');
  assert.deepEqual(await ok('skills/import', { ...update, requestId: retryId }), updated, 'A failed request can be corrected and retried');
  const historicalInput = { ...originalInput, requestId: randomUUID(), skillId: original.skillId };
  const restored = await ok('skills/import', historicalInput);
  assert.equal(restored.version, 3, 'A historical match publishes a new monotonic internal version');
  assert.equal(restored.packageVersion, original.packageVersion);
  assert.equal(restored.digest, original.digest);
  assert.equal(restored.disabled, true); assert.equal(restored.selected, false);
  assert.deepEqual((await ok('skills')).skills, [restored], 'The returned version must really be current');
  assert.deepEqual(await ok('skills/import', { ...historicalInput, requestId: randomUUID() }), restored);
  assert.equal((await f.storage.read('SELECT version FROM teaching_skill_versions WHERE skill_id=$1 ORDER BY version', [original.skillId])).rows.length, 3);
  await ok('skills/disable', { requestId: randomUUID(), skillId: original.skillId, disabled: false });
  const next = await ok('skills/import', { ...update, requestId: randomUUID() });
  assert.equal(next.version, 4); assert.equal(next.disabled, false); assert.equal(next.selected, true);
  await f.reopen();
  const reopened = await settingsServer(t, createTeachingSkills(f.storage, options), owner);
  assert.deepEqual(await reopened.raw('skills/import', { ...update, requestId: randomUUID() }), { status: 200, body: next });
  await validateTeachingSkills(f.storage);
});

test('concurrent duplicate imports across associated owners publish one skill and preserve receipts', { timeout: 60000 }, async t => {
  const f = await storageFixture(t), owner = identity(), linked = { ...identity(), kind: 'school' };
  const options = { authorize: async () => {}, assertWritable() {},
    activity: async () => { throw new StorageError('missing'); }, personalOwners: async () => [owner, linked] };
  const apis = await Promise.all([owner, linked].map(who => settingsServer(t, createTeachingSkills(f.storage, options), who)));
  const inputs = Array.from({ length: 8 }, (_, index) => packageInput('并发重复导入', { packageVersion: `timestamp-${index}` }));
  const results = await Promise.all(inputs.map((input, index) => apis[index % 2].raw('skills/import', input)));
  assert.ok(results.every(result => result.status === 200), JSON.stringify(results));
  const imported = results[0].body;
  for (const result of results) assert.deepEqual(result.body, imported);
  for (const api of apis) assert.deepEqual((await api.raw('skills')).body.skills, [imported]);
  for (const [index, input] of inputs.entries()) assert.deepEqual(await apis[index % 2].raw('skills/import', input), results[index]);
  await validateTeachingSkills(f.storage);
});

test('skill capacity reports an actionable failure and still permits existing files and a fresh retry', { timeout: 60000 }, async t => {
  const f = await storageFixture(t), owner = identity();
  const api = await settingsServer(t, createTeachingSkills(f.storage, { authorize: async () => {}, assertWritable() {},
    activity: async () => { throw new StorageError('missing'); } }), owner);
  const inputFor = index => {
    const input = packageInput(`容量样本 ${index}`);
    input.files[0].content = input.files[0].content.replace('settings-guidance', `capacity-${index}`);
    return input;
  };
  const inputs = Array.from({ length: 32 }, (_, index) => inputFor(index));
  const imported = [];
  for (const input of inputs) {
    const result = await api.raw('skills/import', input);
    assert.equal(result.status, 200); imported.push(result.body);
  }
  const pending = inputFor(32);
  assert.deepEqual(await api.raw('skills/import', pending), { status: 400, body: { error: 'invalid-skill', reason: 'skill-limit' } });
  assert.deepEqual(await api.raw('skills/import', { ...inputs[0], requestId: randomUUID(), packageVersion: 'existing' }),
    { status: 200, body: imported[0] });
  assert.equal((await api.raw('skills/remove', { requestId: randomUUID(), skillId: imported[0].skillId })).status, 200);
  assert.equal((await api.raw('skills/import', { ...pending, requestId: randomUUID() })).status, 200);
  assert.equal((await api.raw('skills')).body.skills.length, 32);
});

test('removal migration upgrades existing versions and retains removed history across reopening', { timeout: 60000 }, async t => {
  const previous = teachingAgentMigrations.filter(item => item.version < 15), f = await storageFixture(t, previous), who = identity();
  const input = packageInput(), ref = { skillId: randomUUID(), version: 1 };
  const fixed = { ...parseTeachingSkillPackage(input), ...ref };
  await f.storage.request({ requestId: randomUUID(), fingerprint: 'legacy-skill' }, async tx => {
    await tx.query('INSERT INTO teaching_skills(owner_key,skill_id,version) VALUES($1,$2,1)', [ownerKey(who), ref.skillId]);
    await tx.query('INSERT INTO teaching_skill_versions(owner_key,skill_id,version,body) VALUES($1,$2,1,$3)', [ownerKey(who), ref.skillId, JSON.stringify(fixed)]);
    return null;
  });
  await f.reopen();
  const make = () => createTeachingSkills(f.storage, { authorize: async () => {}, assertWritable() {},
    activity: async () => { throw new StorageError('missing'); } });
  assert.deepEqual(await make().document(who, ref), { ...ref, content: input.files[0].content });
  const remove = { requestId: randomUUID(), skillId: ref.skillId };
  await make().remove(who, remove); await f.reopen();
  assert.deepEqual(await make().remove(who, remove), { skillId: ref.skillId });
  assert.deepEqual((await make().list(who)).skills, []);
  await assert.rejects(make().document(who, ref), { code: 'missing' });
  assert.deepEqual((await f.storage.read('SELECT body FROM teaching_skill_versions WHERE skill_id=$1', [ref.skillId])).rows[0].body, fixed);
  await validateTeachingSkills(f.storage);
});

test('removing a personal skill preserves real run snapshots and completed tool results after restart', { timeout: 180000 }, async () => {
  let ref;
  const f = await fixture((_payload, response, index) => index === 1
    ? reply(response, { calls: [{ id: 'load-settings-skill', name: 'skill_load', arguments: ref }] })
    : reply(response, { text: '已依据固定指导完成。' }));
  try {
    await f.configure(); const activity = await f.activity();
    const input = packageInput('历史运行固定正文'), imported = await f.api('skills/import', input);
    ref = { skillId: imported.skillId, version: imported.version };
    const sent = await f.send(activity, '读取指导并解释。');
    await until(async () => (await f.api(`agent/${activity.activityId}/runs/${sent.runId}`)).state === 'completed', 'The skill run must complete');
    const events = await f.api(`agent/${activity.activityId}/events`);
    const snapshots = await Promise.all(events.filter(event => event.kind === 'context-assembled')
      .map(event => f.api(`agent/${activity.activityId}/snapshots/${event.body.snapshotId}`)));
    assert.ok(snapshots.some(snapshot => snapshot.contextManifest.items.some(item => item.selection.access === 'fixed-skill-content'
      && item.content.content === input.files[0].content)));
    const conversation = await f.api(`agent/${activity.activityId}/conversation`);
    assert.equal(conversation.tools[0].outcome, 'completed');
    const remove = { requestId: randomUUID(), skillId: ref.skillId };
    await f.api('skills/remove', remove); await f.restart();
    assert.deepEqual(await f.api('skills/remove', remove), { skillId: ref.skillId });
    assert.deepEqual((await f.api('skills')).skills, []);
    for (const snapshot of snapshots) assert.deepEqual(await f.api(`agent/${activity.activityId}/snapshots/${snapshot.snapshotId}`), snapshot);
    assert.deepEqual(await f.api(`agent/${activity.activityId}/conversation`), conversation);
    assert.equal(f.payloads.length, 2, 'Historical reads do not replay the model or tools');
    const next = await f.send(activity, '新的无关问题');
    await until(async () => (await f.api(`agent/${activity.activityId}/runs/${next.runId}`)).state === 'completed', 'Removal must not block future runs');
    assert.ok(!f.payloads.at(-1).tools?.some(tool => tool.function?.name === 'skill_load'));
    assert.doesNotMatch(JSON.stringify(f.payloads.at(-1).messages.filter(item => item.role === 'system')), /历史运行固定正文/);
  } finally { await f.close(); }
});
