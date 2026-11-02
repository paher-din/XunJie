import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { annotationPackage } from '../../../components/material-annotation/package.mjs';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to native PostgreSQL 18.6.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('component import, fixed course binding and typed state use real product owners and resources', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-component169-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  try {
    await runtime.install({ profile: 'local' });
    const started = await runtime.start(), endpoint = started.endpoint;
    const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
    const api = async (route, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, value: await response.json() };
    };
    const input = { requestId: randomUUID(), ...await annotationPackage() };
    assert.equal((await api('manage/component-import', input)).status, 403);
    const imported = await api('manage/component-import', input, admin);
    assert.equal(imported.status, 200, JSON.stringify(imported.value));
    assert.deepEqual((await api('manage/component-import', input, admin)).value, imported.value);
    assert.equal((await api('manage/component-import', { ...input, contentBase64: Buffer.from('tampered replay').toString('base64') }, admin)).status, 400);
    const changed = structuredClone(input); changed.requestId = randomUUID(); changed.manifest.title += ' changed';
    assert.equal((await api('manage/component-import', changed, admin)).status, 409);
    const broken = structuredClone(input); broken.requestId = randomUUID(); broken.manifest.version = 2; broken.contentBase64 = Buffer.from('bad').toString('base64');
    assert.equal((await api('manage/component-import', broken, admin)).status, 400);
    const incompatible = structuredClone(input); incompatible.manifest.hostApiVersion = 2;
    assert.equal((await api('manage/component-import', incompatible, admin)).status, 400);
    const materialId = randomUUID(), hiddenId = randomUUID(), courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const bytes = Buffer.from('公开材料：阅读、观察，并记录自己的理解。'), hidden = Buffer.from('private-canary-169');
    const binding = { key: 'annotation', definition: imported.value, configuration: { title: '材料标注' }, materialIds: [materialId] };
    const course = { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '标注验收样例' }, task: { taskId, title: '阅读与标注', summary: '' },
      release: { releaseId, objectives: ['记录理解'], requirements: '阅读开放材料并标注。', starterWorks: [], capabilities: [], components: [binding],
        materials: [{ materialId, title: '公开材料', path: 'open.txt', mediaType: 'text/plain', access: 'student', sha256: hash(bytes), byteLength: bytes.length },
          { materialId: hiddenId, title: '私有材料', path: 'private.txt', mediaType: 'text/plain', access: 'private', sha256: hash(hidden), byteLength: hidden.length }] },
      resources: [{ path: 'open.txt', contentBase64: bytes.toString('base64') }, { path: 'private.txt', contentBase64: hidden.toString('base64') }] };
    const forged = structuredClone(course); forged.release.components[0].materialIds = [hiddenId];
    assert.equal((await api('manage/course-import', forged, admin)).status, 400);
    assert.equal((await api('manage/course-import', course, admin)).status, 200);
    const password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName: 'annotation-student', password }, admin);
    const login = await api('login', { loginName: 'annotation-student', password });
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true }, admin);
    const path = `releases/${releaseId}/components/annotation`;
    assert.equal((await api(path, undefined, headers)).status, 200);
    assert.equal((await api(`releases/${releaseId}/materials/${hiddenId}`, undefined, headers)).status, 404);
    const created = await api('course-activities', { requestId: randomUUID(), releaseId }, headers);
    assert.equal(created.status, 200, JSON.stringify(created.value));
    const activity = created.value, works = `workspaces/${activity.activityId}`;
    assert.deepEqual(activity.course.components[0], binding);
    const state = { formatVersion: 1, instanceId: `${activity.activityId}:annotation`, componentId: input.manifest.componentId,
      version: 1, definitionDigest: imported.value.digest, stateVersion: 1, operationId: randomUUID(), content: { annotations: [{ id: randomUUID(), quote: '公开材料', note: '我的理解\n第二行' }] } };
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/annotation.json', kind: 'state', encoding: 'json',
      mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify(state) };
    const sync = { requestId: randomUUID(), baseRevision: 0, files: [file] };
    assert.equal((await api(works, sync, headers)).status, 200);
    assert.equal((await api(works, sync, headers)).value.revision, 1);
    const secondPassword = randomUUID();
    const secondMember = await api('manage/members', { requestId: randomUUID(), loginName: 'second-annotation-student', password: secondPassword }, admin);
    const secondLogin = await api('login', { loginName: 'second-annotation-student', password: secondPassword });
    const secondHeaders = { cookie: secondLogin.headers.get('set-cookie').split(';')[0] };
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: secondMember.value.principalId, active: true }, admin);
    assert.equal((await api(works, undefined, secondHeaders)).status, 404);
    assert.equal((await api(works, { ...sync, requestId: randomUUID() }, secondHeaders)).status, 404);
    const personalHeaders = { 'x-xj-space': 'personal' };
    assert.equal((await api(works, undefined, personalHeaders)).status, 404);
    const invalid = { ...sync, requestId: randomUUID(), baseRevision: 1, files: [{ ...file, contentId: randomUUID(), value: JSON.stringify({ ...state, content: { arbitrary: true } }) }] };
    assert.equal((await api(works, invalid, headers)).status, 400);
    assert.equal((await api(works, { ...sync, requestId: randomUUID() }, headers)).status, 409);
    const other = await api('course-activities', { requestId: randomUUID(), releaseId }, headers);
    assert.deepEqual((await api(`workspaces/${other.value.activityId}`, undefined, headers)).value.files, []);
    assert.equal((await api(`workspaces/${other.value.activityId}`, { ...sync, requestId: randomUUID() }, headers)).status, 400);
    const preview = await api('course-activities', { requestId: randomUUID(), releaseId, purpose: 'preview' }, headers);
    assert.equal(preview.status, 200); assert.equal(preview.value.purpose, 'preview');
    assert.notEqual(preview.value.activityId, activity.activityId);
    assert.deepEqual((await api(`workspaces/${preview.value.activityId}`, undefined, headers)).value.files, []);
    assert.ok(!(await api('activities', undefined, headers)).value.some(item => item.activityId === preview.value.activityId));
    const subject = [activity.identity.environmentId, activity.identity.spaceId, activity.identity.principalId].join('.');
    const view = await fetch(new URL(`/api/learning/${path}/view?space=school&subject=${subject}&digest=${imported.value.digest}`, endpoint), { headers });
    assert.equal(view.status, 200); assert.match(view.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.match(view.headers.get('content-security-policy'), /connect-src 'none'/);
    const wrongSubject = subject.replace(activity.identity.principalId, secondMember.value.principalId);
    assert.equal((await fetch(new URL(`/api/learning/${path}/view?space=school&subject=${wrongSubject}&digest=${imported.value.digest}`, endpoint), { headers })).status, 403);
    const newRelease = structuredClone(course); newRelease.requestId = randomUUID(); newRelease.release.releaseId = randomUUID(); newRelease.release.components = [];
    assert.equal((await api('manage/course-import', newRelease, admin)).status, 200);
    assert.deepEqual((await api(`activities/${activity.activityId}`, undefined, headers)).value.course.components, [binding]);
    await runtime.stop(); await runtime.start();
    assert.equal((await api(works, undefined, headers)).value.files[0].value, file.value);
    const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
    const owner = environment.services.find(service => service.unit === 'space-course');
    const resourcePath = join(root, 'learning-resources', 'space-course', environment.environmentId, owner.serviceId, input.manifest.entry.resourceId);
    const original = await readFile(resourcePath);
    await writeFile(resourcePath, 'corrupt');
    assert.equal((await api(path, undefined, headers)).status, 503);
    assert.equal((await api(works, undefined, headers)).value.files[0].value, file.value, 'a missing view cannot discard saved state');
    await writeFile(resourcePath, original);
    const statusInput = { requestId: randomUUID(), componentId: input.manifest.componentId, version: 1, enabled: false };
    assert.equal((await api('manage/component-status', statusInput, admin)).status, 200);
    assert.equal((await api(path, undefined, headers)).status, 503);
    assert.equal((await api(works, undefined, headers)).value.files[0].value, file.value);
    await api('manage/component-status', { ...statusInput, requestId: randomUUID(), enabled: true }, admin);
    assert.equal((await api(path, undefined, headers)).status, 200);
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: false }, admin);
    assert.equal((await api(path, undefined, headers)).status, 403);
    assert.equal((await api(works, undefined, headers)).status, 403);
  } finally { await runtime.stop().catch(() => {}); }
});
