import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, restoreProductRecovery, resolveCredential } from '@xunjie/product-runtime';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to native PostgreSQL 18.6.');
const payload = () => ({ formatVersion: 1, title: '变化与解释', display: 'card', html: '<label>解释<input id="answer"></label>', css: '', javascript: '',
  hostApiVersion: 1, stateVersion: 1, stateShape: { type: 'object', properties: { answer: { type: 'string', maxLength: 1000 } } },
  initialState: { answer: '' }, semanticFields: [{ key: 'answer', meaning: '学生对变化的解释' }], semanticObjects: [], requiredCapabilities: [] });

test('a course-free artifact has immutable readable content and a stable production HTTP receipt', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-teaching-artifacts-'));
  const directory = await mkdtemp(join(tmpdir(), 'xj-artifact-backup-'));
  let target, restored;
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources });
  try {
    await runtime.install({ profile: 'local' });
    let endpoint = (await runtime.start()).endpoint;
    const api = async (route, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const activity = (await api('activities', { requestId: randomUUID(), goal: '理解变化', question: '', references: [] })).value;
    const route = `artifacts/${activity.activityId}`;
    const input = { requestId: randomUUID(), payload: payload() };
    const created = await api(route, input);
    assert.equal(created.status, 200, JSON.stringify(created.value));
    const { artifactId, revisionId, candidateId } = created.value;
    assert.ok(artifactId && revisionId && candidateId);
    assert.deepEqual((await api(route, input)).value, created.value);
    assert.equal((await api(route, { ...input, payload: { ...input.payload, title: 'changed' } })).status, 409);
    assert.deepEqual((await api(`${route}/receipts/${input.requestId}`)).value, created.value);
    const fixed = await api(`${route}/${artifactId}/revisions/${revisionId}`);
    assert.equal(fixed.status, 200); assert.deepEqual(fixed.value.payload, input.payload);
    assert.equal(fixed.value.version, 1);
    const viewQuery = new URLSearchParams({ space: 'personal', namespace: (await api('context')).value.clientNamespace, digest: fixed.value.sha256,
      subject: [activity.identity.environmentId, activity.identity.spaceId, activity.identity.principalId].join('.') });
    const view = await fetch(`${endpoint}/api/learning/${route}/${artifactId}/revisions/${revisionId}/view?${viewQuery}`);
    assert.equal(view.status, 200, 'fixed artifact has its own opaque view, independent of the parent application CSP');
    assert.match(view.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.match(view.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.match(await view.text(), /host\.bootstrap/);
    viewQuery.set('digest', '0'.repeat(64));
    assert.equal((await fetch(`${endpoint}/api/learning/${route}/${artifactId}/revisions/${revisionId}/view?${viewQuery}`)).status, 409);
    assert.equal((await api(`${route}/candidates/${candidateId}`)).value.status, 'candidate');
    assert.equal((await api(route)).value.length, 1);
    const check = { requestId: randomUUID(), candidateId, revisionId, resourceSha256: fixed.value.sha256, load: true, stateRoundtrip: true };
    const checked = await api(`${route}/check`, check);
    assert.equal(checked.status, 200, JSON.stringify(checked.value));
    const adopt = { requestId: randomUUID(), candidateId, expectedRevisionId: null, expectedWorkRevision: 0, expectedContentId: null };
    const adopted = await api(`${route}/adopt`, adopt);
    assert.equal(adopted.status, 200, JSON.stringify(adopted.value));
    assert.equal(adopted.value.outcome, 'adopted');
    assert.equal((await api(`${route}/checks/${check.requestId}`)).value.status, 'adoptable', 'the original check receipt is immutable after adoption');
    assert.deepEqual((await api(`${route}/adopt`, adopt)).value, adopted.value);
    const works = await api(`workspaces/${activity.activityId}`);
    assert.equal(works.value.revision, 1); assert.equal(works.value.files.length, 1);
    assert.deepEqual(JSON.parse(works.value.files[0].value).content, { answer: '' });
    assert.equal((await api(`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 1, files: [] })).status, 400, 'an omitted artifact state cannot silently delete the adopted answers');
    const edited = structuredClone(works.value.files[0]); edited.contentId = randomUUID();
    const state = JSON.parse(edited.value); state.content.answer = '我写下的中文解释'; state.operationId = randomUUID(); edited.value = JSON.stringify(state);
    assert.equal((await api(`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 1, files: [edited] })).status, 200);
    const revisedPayload = { ...payload(), title: '更清晰的解释', initialState: { answer: '不可覆盖原答案' } };
    const next = await api(route, { requestId: randomUUID(), artifactId, parentRevisionId: revisionId, payload: revisedPayload });
    assert.equal(next.status, 200, JSON.stringify(next.value));
    const nextRevision = (await api(`${route}/${artifactId}/revisions/${next.value.revisionId}`)).value;
    assert.equal(nextRevision.version, 2);
    assert.equal((await api(`${route}/check`, { ...check, requestId: randomUUID(), candidateId: next.value.candidateId,
      revisionId: next.value.revisionId, resourceSha256: nextRevision.sha256 })).status, 200);
    const stale = { requestId: randomUUID(), candidateId: next.value.candidateId, expectedRevisionId: revisionId, expectedWorkRevision: 1, expectedContentId: adopted.value.contentId };
    assert.equal((await api(`${route}/adopt`, stale)).status, 409, 'a candidate cannot replace new student input');
    const replace = await api(`${route}/adopt`, { ...stale, requestId: randomUUID(), expectedWorkRevision: 2, expectedContentId: edited.contentId });
    assert.equal(replace.status, 200, JSON.stringify(replace.value)); assert.equal(replace.value.outcome, 'adopted');
    const after = (await api(`workspaces/${activity.activityId}`)).value;
    assert.equal(after.revision, 3); assert.deepEqual(JSON.parse(after.files[0].value).content, { answer: '我写下的中文解释' });
    assert.equal((await api(`${route}/${artifactId}`)).value.activeRevisionId, next.value.revisionId);
    assert.equal((await api(`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 3, files: [edited] })).status, 400, 'old mounted content is refused after revision adoption');
    const incompatible = { ...payload(), semanticFields: [{ key: 'answer', meaning: '完全不同的新任务答案' }] };
    const forkCandidate = (await api(route, { requestId: randomUUID(), artifactId, parentRevisionId: next.value.revisionId, payload: incompatible })).value;
    const forkFixed = (await api(`${route}/${artifactId}/revisions/${forkCandidate.revisionId}`)).value;
    await api(`${route}/check`, { ...check, requestId: randomUUID(), candidateId: forkCandidate.candidateId, revisionId: forkCandidate.revisionId, resourceSha256: forkFixed.sha256 });
    const fork = await api(`${route}/adopt`, { requestId: randomUUID(), candidateId: forkCandidate.candidateId, expectedRevisionId: next.value.revisionId,
      expectedWorkRevision: 3, expectedContentId: after.files[0].contentId });
    assert.equal(fork.status, 200, JSON.stringify(fork.value)); assert.equal(fork.value.outcome, 'forked'); assert.notEqual(fork.value.artifactId, artifactId);
    const forkWorks = (await api(`workspaces/${activity.activityId}`)).value;
    assert.equal(forkWorks.files.length, 2); assert.ok(forkWorks.files.some(f => JSON.parse(f.value).content.answer === '我写下的中文解释'));
    await runtime.stop(); endpoint = (await runtime.start()).endpoint;
    assert.deepEqual((await api(`${route}/${artifactId}/revisions/${revisionId}`)).value, fixed.value);
    const finalWorks = (await api(`workspaces/${activity.activityId}`)).value;
    const key = randomBytes(32); await runtime.setCredential('artifact-recovery', key.toString('base64'));
    const backup = await runtime.recovery.backup({ directory, recoveryKeyRef: 'artifact-recovery', leaveClosed: true });
    restored = await restoreProductRecovery({ root: join(directory, 'restored'), resources, backupDirectory: join(directory, backup.backupId), key });
    for (const owner of restored.owners) await owner.close?.(); restored = undefined;
    target = openProductRuntime({ root: join(directory, 'restored'), resources });
    const isolated = await target.start(); assert.equal(isolated.state, 'maintenance'); endpoint = isolated.endpoint;
    assert.deepEqual((await api(`workspaces/${activity.activityId}`)).value, finalWorks);
    assert.deepEqual((await api(`${route}/${artifactId}/revisions/${revisionId}`)).value, fixed.value);
    assert.equal((await api(`${route}/adopt`, { ...adopt, requestId: randomUUID() })).status, 503);
    assert.equal((await api(route, { requestId: randomUUID(), payload: payload() })).status, 503);
    assert.equal((await api(`${route}/${artifactId}/revisions/${revisionId}/resource`)).status, 200);

  } finally {
    for (const owner of restored?.owners ?? []) await owner.close?.();
    await target?.stop(); await runtime.stop().catch(() => {});
    await rm(root, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true });
  }
});

test('failed checks, forged origins, competing revisions and semantic references respect fixed activity ownership', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-artifact-boundary-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources });
  try {
    await runtime.install({ profile: 'local' }); const endpoint = (await runtime.start()).endpoint;
    const api = async (route, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const activity = (await api('activities', { requestId: randomUUID(), goal: '独立解释', question: '', references: [] })).value;
    const other = (await api('activities', { requestId: randomUUID(), goal: '另一活动', question: '', references: [] })).value;
    const route = `artifacts/${activity.activityId}`;
    const create = body => api(route, { requestId: randomUUID(), payload: payload(), ...body });
    assert.equal((await create({ origin: { runId: randomUUID(), stepId: randomUUID(), snapshotId: randomUUID(), commandId: randomUUID() } })).status, 400);
    assert.equal((await create({ payload: { ...payload(), initialState: { answer: 99 } } })).status, 400);
    const failed = await create({ payload: { ...payload(), javascript: 'const = broken' } });
    assert.equal(failed.status, 200);
    const failedFixed = (await api(`${route}/${failed.value.artifactId}/revisions/${failed.value.revisionId}`)).value;
    assert.equal((await api(`${route}/candidates/${failed.value.candidateId}`)).value.status, 'check-failed');
    await api(`${route}/check`, { requestId: randomUUID(), candidateId: failed.value.candidateId, revisionId: failed.value.revisionId, resourceSha256: failedFixed.sha256, load: true, stateRoundtrip: true });
    assert.equal((await api(`${route}/adopt`, { requestId: randomUUID(), candidateId: failed.value.candidateId, expectedRevisionId: null, expectedContentId: null, expectedWorkRevision: 0 })).status, 409);
    const p = { ...payload(), semanticObjects: [{ id: 'change', meaning: '变化趋势', summary: '输入增加时观察变化。' }] };
    const first = (await create({ payload: p })).value;
    const check = async published => {
      const fixed = (await api(`${route}/${published.artifactId}/revisions/${published.revisionId}`)).value;
      const checked = await api(`${route}/check`, { requestId: randomUUID(), candidateId: published.candidateId, revisionId: published.revisionId,
        resourceSha256: fixed.sha256, load: true, stateRoundtrip: true });
      assert.equal(checked.status, 200, JSON.stringify(checked.value)); return fixed;
    };
    const fixed = await check(first);
    const adoptInput = { requestId: randomUUID(), candidateId: first.candidateId, expectedRevisionId: null, expectedContentId: null, expectedWorkRevision: 0 };
    const repeat = await Promise.all([api(`${route}/adopt`, adoptInput), api(`${route}/adopt`, adoptInput)]);
    assert.deepEqual(repeat.map(r => r.status), [200, 200]); assert.deepEqual(repeat[0].value, repeat[1].value);
    assert.equal((await api(`artifacts/${other.activityId}/${first.artifactId}`)).status, 404);
    assert.equal((await api(route, undefined, { 'x-xj-expected-subject': `${randomUUID()}.${activity.identity.spaceId}.${activity.identity.principalId}` })).status, 403);
    assert.equal((await api(route, undefined, { 'x-xj-space': 'school' })).status, 403);
    const draft = (await api(`drafts/${activity.activityId}`)).value;
    const work = (await api(`workspaces/${activity.activityId}`)).value.files[0];
    const source = { kind: 'component', formatVersion: 1, environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
      principalId: activity.identity.principalId, activityId: activity.activityId, instanceId: `${activity.activityId}:${fixed.binding.key}`,
      componentId: first.artifactId, componentVersion: 1, definitionDigest: fixed.binding.definition.digest, bindingKey: fixed.binding.key,
      objectId: work.objectId, contentId: work.contentId, origin: 'state', requestId: null, executionRef: null };
    const copy = '变化趋势\n输入增加时观察变化。';
    const ref = { referenceId: randomUUID(), source, sourceName: p.title, copy,
      range: { kind: 'semantic', formatVersion: 1, typeId: 'teaching-artifact-objects', version: 1, target: { objectIds: ['change'] }, start: 0, end: copy.length } };
    const draftInput = { requestId: randomUUID(), draftId: draft.draftId, baseRevision: 0, question: '这是什么意思？', references: [ref], bases: [] };
    const savedDraft = await api(`drafts/${activity.activityId}`, draftInput);
    assert.equal(savedDraft.status, 200, JSON.stringify(savedDraft.value));
    assert.equal((await api(`drafts/${activity.activityId}`, { ...draftInput, requestId: randomUUID(), baseRevision: 1,
      references: [{ ...ref, copy: '伪造', range: { ...ref.range, end: 2 } }] })).status, 400);
    const left = (await create({ artifactId: first.artifactId, parentRevisionId: first.revisionId, payload: { ...p, title: '左修订' } })).value;
    const right = (await create({ artifactId: first.artifactId, parentRevisionId: first.revisionId, payload: { ...p, title: '右修订' } })).value;
    await check(left); await check(right);
    const baseline = { expectedRevisionId: first.revisionId, expectedWorkRevision: 1, expectedContentId: work.contentId };
    const race = await Promise.all([api(`${route}/adopt`, { requestId: randomUUID(), candidateId: left.candidateId, ...baseline }),
      api(`${route}/adopt`, { requestId: randomUUID(), candidateId: right.candidateId, ...baseline })]);
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
    assert.deepEqual((await api(`drafts/${activity.activityId}`)).value.references[0].source, source);
    assert.equal((await api(`drafts/${activity.activityId}`)).value.references[0].copy, copy);
    const active = (await api(`${route}/${first.artifactId}`)).value;
    const beforeMapping = (await api(`workspaces/${activity.activityId}`)).value;
    const mappedPayload = { ...p, stateVersion: 2, stateShape: { type: 'object', properties: { explanation: { type: 'string', maxLength: 1000 } } },
      initialState: { explanation: '新初值不能覆盖原答案' }, semanticFields: [{ key: 'explanation', meaning: '学生对变化的解释' }] };
    const mapped = (await create({ artifactId: first.artifactId, parentRevisionId: active.activeRevisionId, payload: mappedPayload,
      mapping: [{ from: 'answer', to: 'explanation' }] })).value;
    await check(mapped);
    const mappedAdopt = await api(`${route}/adopt`, { requestId: randomUUID(), candidateId: mapped.candidateId, expectedRevisionId: active.activeRevisionId,
      expectedWorkRevision: beforeMapping.revision, expectedContentId: beforeMapping.files[0].contentId });
    assert.equal(mappedAdopt.status, 200, JSON.stringify(mappedAdopt.value)); assert.equal(mappedAdopt.value.outcome, 'adopted');
    const finalWork = (await api(`workspaces/${activity.activityId}`)).value;
    assert.deepEqual(JSON.parse(finalWork.files[0].value).content, { explanation: '' }, 'declarative rename retains the old value rather than the new initial state');
    const shelfInput = { requestId: randomUUID(), artifactId: first.artifactId, shelved: true };
    const shelved = await api(`${route}/shelf`, shelfInput); assert.equal(shelved.status, 200);
    assert.deepEqual((await api(`${route}/shelf`, shelfInput)).value, shelved.value);
    assert.equal((await api(`${route}/shelf`, { ...shelfInput, shelved: false })).status, 409);
    assert.deepEqual((await api(`workspaces/${activity.activityId}`)).value, finalWork);
    const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
    const dataOwner = environment.services.find(service => service.unit === 'learning-data');
    const resourcePath = join(root, 'learning-resources', 'learning-data', environment.environmentId, dataOwner.serviceId, fixed.resourceId);
    const originalBytes = await readFile(resourcePath); await writeFile(resourcePath, 'corrupt retained resource');
    assert.equal((await api(`${route}/${first.artifactId}/revisions/${first.revisionId}/resource`)).status, 503);
    assert.deepEqual((await api(`workspaces/${activity.activityId}`)).value, finalWork, 'missing content cannot discard saved answers');
    await writeFile(resourcePath, originalBytes);
    assert.equal((await api(`${route}/${first.artifactId}/revisions/${first.revisionId}/resource`)).status, 200);
    const unopenedRoute = `artifacts/${other.activityId}`;
    const unopened = (await api(unopenedRoute, { requestId: randomUUID(), payload: payload() })).value;
    const backgroundRevision = (await api(unopenedRoute, { requestId: randomUUID(), artifactId: unopened.artifactId,
      parentRevisionId: unopened.revisionId, payload: { ...payload(), title: '尚未打开时已完成的修订' } })).value;
    const backgroundFixed = (await api(`${unopenedRoute}/${unopened.artifactId}/revisions/${backgroundRevision.revisionId}`)).value;
    await api(`${unopenedRoute}/check`, { requestId: randomUUID(), candidateId: backgroundRevision.candidateId,
      revisionId: backgroundRevision.revisionId, resourceSha256: backgroundFixed.sha256, load: true, stateRoundtrip: true });
    const firstOpen = await api(`${unopenedRoute}/adopt`, { requestId: randomUUID(), candidateId: backgroundRevision.candidateId,
      expectedRevisionId: null, expectedWorkRevision: 0, expectedContentId: null });
    assert.equal(firstOpen.status, 200, 'first use may adopt a checked background revision when no previous state exists');
    assert.equal(firstOpen.value.revisionId, backgroundRevision.revisionId);
    assert.equal((await api(`${unopenedRoute}/candidates/${unopened.candidateId}`)).value.status, 'candidate');
    assert.equal((await api(`${unopenedRoute}/${unopened.artifactId}/revisions/${unopened.revisionId}`)).value.version, 1);
    assert.equal((await api('activity-status', { requestId: randomUUID(), activityId: activity.activityId, status: 'closed' })).status, 200);
    assert.equal((await create()).status, 403);
    assert.equal((await api(`${route}/shelf`, { ...shelfInput, requestId: randomUUID() })).status, 403);
    assert.equal((await api(`${route}/check`, { requestId: randomUUID(), candidateId: first.candidateId, revisionId: first.revisionId, resourceSha256: fixed.sha256, load: true, stateRoundtrip: true })).status, 403);
    assert.equal((await api(`${route}/adopt`, { ...adoptInput, requestId: randomUUID() })).status, 403);
    assert.equal((await api(`${route}/${first.artifactId}/revisions/${first.revisionId}`)).status, 200);
    assert.equal((await api(`${route}/receipts/${adoptInput.requestId}`)).status, 200);

  } finally { await runtime.stop().catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test('school-page and installed-client forwarding retain artifact receipts after a lost adopt reply and reject revoked grants', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-artifact-school-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const school = openProductRuntime({ root: join(root, 'school'), resources }), client = openProductRuntime({ root: join(root, 'client'), resources });
  let proxy;
  try {
    await school.install({ profile: 'school' }); await client.install({ profile: 'local' });
    const schoolEndpoint = (await school.start()).endpoint, clientEndpoint = (await client.start()).endpoint;
    const api = async (endpoint, route, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, value: await response.json() };
    };
    let loseReply = true;
    proxy = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const upstream = await fetch(new URL(request.url, schoolEndpoint), { method: request.method,
        headers: { 'content-type': 'application/json', ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) },
        ...(body.length ? { body } : {}) });
      const text = await upstream.text();
      if (loseReply && request.method === 'POST' && request.url.endsWith('/adopt') && upstream.ok) {
        loseReply = false; response.writeHead(409, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'commit-unknown' }));
      } else { response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(text); }
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const password = randomUUID();
    assert.equal((await api(schoolEndpoint, 'manage/members', { requestId: randomUUID(), loginName: 'artifact-student', password },
      { authorization: `Bearer ${await resolveCredential(join(root, 'school'), 'control')}` })).status, 200);
    const login = await api(schoolEndpoint, 'login', { loginName: 'artifact-student', password });
    const schoolHeaders = { cookie: login.headers.get('set-cookie').split(';')[0] };
    const start = await api(clientEndpoint, 'client/start', { requestId: randomUUID(), schoolEndpoint: `http://127.0.0.1:${proxy.address().port}` });
    assert.equal((await api(schoolEndpoint, 'connections/approve', { requestId: start.value.requestId }, schoolHeaders)).status, 200);
    const complete = await api(clientEndpoint, 'client/complete', { requestId: start.value.requestId }); assert.equal(complete.status, 200);
    const headers = { 'x-xj-space': `school:${complete.value.connectionId}` };
    const activity = (await api(clientEndpoint, 'activities', { requestId: randomUUID(), goal: '学校解释卡', question: '', references: [] }, headers)).value;
    const route = `artifacts/${activity.activityId}`, input = { requestId: randomUUID(), payload: payload() };
    const published = await api(clientEndpoint, route, input, headers); assert.equal(published.status, 200, JSON.stringify(published.value));
    assert.deepEqual((await api(schoolEndpoint, `${route}/receipts/${input.requestId}`, undefined, schoolHeaders)).value, published.value);
    const fixedPath = `${route}/${published.value.artifactId}/revisions/${published.value.revisionId}`;
    const fixed = await api(clientEndpoint, fixedPath, undefined, headers); assert.equal(fixed.status, 200);
    assert.deepEqual((await api(schoolEndpoint, fixedPath, undefined, schoolHeaders)).value, fixed.value);
    assert.equal((await api(clientEndpoint, fixedPath + '/resource', undefined, headers)).status, 200);
    assert.equal((await api(clientEndpoint, `${route}/check`, { requestId: randomUUID(), candidateId: published.value.candidateId,
      revisionId: published.value.revisionId, resourceSha256: fixed.value.sha256, load: true, stateRoundtrip: true }, headers)).status, 200);
    const adopt = { requestId: randomUUID(), candidateId: published.value.candidateId, expectedRevisionId: null, expectedWorkRevision: 0, expectedContentId: null };
    assert.equal((await api(clientEndpoint, `${route}/adopt`, adopt, headers)).status, 409);
    const receipt = await api(clientEndpoint, `${route}/receipts/${adopt.requestId}`, undefined, headers);
    assert.equal(receipt.status, 200); assert.equal(receipt.value.outcome, 'adopted');
    assert.deepEqual((await api(clientEndpoint, `${route}/adopt`, adopt, headers)).value, receipt.value);
    assert.equal((await api(clientEndpoint, `workspaces/${activity.activityId}`, undefined, headers)).value.revision, 1);
    const wrong = { ...headers, 'x-xj-expected-subject': `${randomUUID()}.${activity.identity.spaceId}.${activity.identity.principalId}` };
    assert.equal((await api(clientEndpoint, route, undefined, wrong)).status, 403);
    assert.equal((await api(clientEndpoint, 'connections/revoke', { connectionId: complete.value.connectionId }, headers)).status, 200);
    assert.equal((await api(clientEndpoint, route, undefined, headers)).status, 403);
    assert.equal((await api(clientEndpoint, `${route}/adopt`, adopt, headers)).status, 403);
  } finally {
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    await client.stop().catch(() => {}); await school.stop().catch(() => {}); await rm(root, { recursive: true, force: true });
  }
});
