import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { createSpaces, createCourses, spaceCourseMigrations, createLearningData, learningMigrations } from '@xunjie/learning-space';
import { createAgentSessions } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createLearningEntry } from '@xunjie/product-runtime/learning-http';
import { nativeFixture } from '../../../../packages/storage/test/native-fixture.mjs';

// Real owner storage; no TeachingAgent, model gateway, source loader or fake activity.
export async function ownerStorage(t, migrations = learningMigrations) {
  const pg = await nativeFixture(), handles = new Set(), cleanups = [];
  t.after(async () => { try { for (const cleanup of cleanups.reverse()) await cleanup(); for (const handle of handles) await handle.close(); } finally { await pg.close(); } });
  async function open(name, selectedMigrations = migrations) {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, password = randomUUID();
    const backend = createFileBackend({ id: name, root: join(pg.root, name) });
    let storage;
    async function reopen() {
      if (storage) { await storage.close(); handles.delete(storage); }
      const binding = await provisionStorage({ admin: pg.admin, owner, password, migrations: selectedMigrations });
      storage = await openStorage({ binding, backend, migrations: selectedMigrations }); handles.add(storage);
      return storage;
    }
    await reopen();
    return { get storage() { return storage; }, reopen };
  }
  const primary = await open('learning');
  return { get storage() { return primary.storage; }, reopen: primary.reopen, open, beforeClose(cleanup) { cleanups.push(cleanup); } };
}

export async function learningOwner(t) {
  const f = await ownerStorage(t), school = await f.open('spaces', spaceCourseMigrations);
  const spaces = createSpaces(school.storage), courses = createCourses(school.storage, spaces);
  const identity = await spaces.personal(), target = { ...f.storage.owner, version: 1 };
  await spaces.bindMember(identity, target);
  const data = () => createLearningData(f.storage, spaces, courses);
  return { ...f, get storage() { return f.storage; }, identity, target, courseTarget: { ...school.storage.owner, version: 1 }, spaces, courses, get data() { return data(); } };
}

export function sessionDirectory(storage, authorize, openActivity) {
  const owner = { version: 1, connectionId: randomUUID(), installationId: randomUUID(), delivery: 'service', grantId: randomUUID(),
    executionGrantId: randomUUID(), target: { ...storage.owner, unit: 'teaching-agent', endpoint: 'https://fixture.invalid', protocolVersion: 1, capabilities: [] } };
  return createAgentSessions(storage, { authorize, openActivity, resolveOwner: async () => owner });
}
export const openSession = (sessions, identity) => sessions.create(identity, {
  requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant',
});
export async function loadCommand(skills, identity, sessionId, ref, extra = {}) {
  const state = await skills.resolveSession(identity, sessionId);
  const entry = state.catalog.find(item => item.skillId === ref.skillId && item.version === ref.version);
  assert.ok(entry, 'The selected immutable package must be in the session catalog');
  return { skillId: ref.skillId, version: ref.version, packageDigest: entry.digest, selectionDigest: state.selectionDigest,
    commandId: randomUUID(), runId: randomUUID(), stepId: randomUUID(), moduleId: 'skills', moduleVersion: 1, ...extra };
}

// Exercise the production library HTTP boundary, including forwarding through that same public HTTP API.
export async function learningHttp(t, { identity, data = {}, spaces, skills, target = {} }) {
  let current = identity, entry;
  const calls = [], server = createServer((req, res) => { void entry(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json', 'x-xj-space': 'personal', 'x-xj-namespace': 'test' };
  entry = createLearningEntry({ environment: { environmentId: identity.environmentId, profile: 'local', clientNamespace: 'test', services: [{ endpoint }] },
    target, spaces: { bindMember: async () => {}, ...spaces, personal: async () => current }, learning: data, administratorToken: 'unused',
    ...(skills ? { skills: async () => skills } : {}),
    client: { async forward(_connection, route, body, expected, search = '') {
      calls.push(route);
      const response = await fetch(endpoint + '/api/learning/' + route + (search ? '?' + String(search).replace(/^\?/, '') : ''), {
        headers: { ...headers, ...(expected ? { 'x-xj-expected-subject': expected } : {}) },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      });
      const value = await response.json();
      if (!response.ok) throw new StorageError(value.error);
      return value;
    } } });
  async function raw(route, body, extraHeaders = {}) {
    const response = await fetch(endpoint + '/api/learning/' + route, { headers: { ...headers, ...extraHeaders },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  return { raw, calls, as(who) { current = who; }, async api(route, body) {
    const result = await raw(route, body); assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body)); return result.body;
  } };
}
