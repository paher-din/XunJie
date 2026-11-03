import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { annotationPackage, preparedAnnotationPackage } from '../../../components/material-annotation/package.mjs';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to native PostgreSQL 18.6.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** Digest produced by the format-1 contracts before formatVersion=2 existed; a format 1 definition must never move. */
const legacyDefinitionDigest = 'e553551c0213e6bd6fa1e8491de88606414a5a68f60aec0df61eca9ed154caf8';

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

test('prepared component import, fixed dependency resources and preparation reports use real product owners', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-component171-'));
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
    const legacyInput = { requestId: randomUUID(), ...await annotationPackage() };
    const legacy = await api('manage/component-import', legacyInput, admin);
    assert.equal(legacy.status, 200, JSON.stringify(legacy.value));
    assert.equal(legacy.value.manifest.formatVersion, 1);
    assert.equal(legacy.value.digest, legacyDefinitionDigest, 'a format 1 definition digest must not move');

    const preparedInput = { requestId: randomUUID(), ...await preparedAnnotationPackage() };
    const manifest = preparedInput.manifest;
    const dependency = manifest.dependencies[0];
    assert.equal(manifest.formatVersion, 2);
    assert.equal((await api('manage/component-import', preparedInput)).status, 403);
    const imported = await api('manage/component-import', preparedInput, admin);
    assert.equal(imported.status, 200, JSON.stringify(imported.value));
    assert.equal(imported.value.digest, hash(Buffer.from(JSON.stringify(imported.value.manifest))),
      'the client recomputes the same digest from the returned manifest');
    assert.deepEqual((await api('manage/component-import', preparedInput, admin)).value, imported.value, 'a repeated request returns its receipt');

    const withoutResource = structuredClone(preparedInput); withoutResource.requestId = randomUUID(); delete withoutResource.dependencies;
    assert.equal((await api('manage/component-import', withoutResource, admin)).status, 400, 'a prepared component must submit its dependency resources');
    const tampered = structuredClone(preparedInput); tampered.requestId = randomUUID();
    tampered.dependencies = [{ resourceId: dependency.resourceId, contentBase64: Buffer.from('tampered dependency bytes').toString('base64') }];
    assert.equal((await api('manage/component-import', tampered, admin)).status, 400, 'bytes that do not match the declared digest are refused');
    const swapped = structuredClone(preparedInput); swapped.requestId = randomUUID();
    swapped.manifest = { ...swapped.manifest, selfTest: { ...swapped.manifest.selfTest, material: { ...swapped.manifest.selfTest.material, title: '换了样例' } } };
    assert.equal((await api('manage/component-import', swapped, admin)).status, 409, 'the same component version cannot be redefined');
    const unknownFeature = structuredClone(preparedInput); unknownFeature.requestId = randomUUID();
    unknownFeature.manifest.environment.requiredFeatures = ['webgpu'];
    assert.equal((await api('manage/component-import', unknownFeature, admin)).status, 400, 'an unimplemented required feature is refused, not ignored');
    const overBudget = structuredClone(preparedInput); overBudget.requestId = randomUUID();
    overBudget.manifest.budget = { ...overBudget.manifest.budget, totalResourceBytes: 1024 };
    assert.equal((await api('manage/component-import', overBudget, admin)).status, 400, 'declared resources must fit the declared budget');

    const materialId = randomUUID(), courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const bytes = Buffer.from('公开材料：观察与解释\n\n阅读材料时，先区分观察到的事实与自己的解释。');
    const binding = { key: 'annotation', definition: imported.value, configuration: { title: '材料标注' }, materialIds: [materialId] };
    const legacyBinding = { key: 'legacy', definition: legacy.value, configuration: { title: '材料标注（原版）' }, materialIds: [materialId] };
    const course = { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '依赖准备验收样例' }, task: { taskId, title: '阅读与标注', summary: '' },
      release: { releaseId, objectives: ['记录理解'], requirements: '阅读开放材料并标注。', starterWorks: [], capabilities: [], components: [binding, legacyBinding],
        materials: [{ materialId, title: '公开材料', path: 'open.txt', mediaType: 'text/plain', access: 'student', sha256: hash(bytes), byteLength: bytes.length }] },
      resources: [{ path: 'open.txt', contentBase64: bytes.toString('base64') }] };
    assert.equal((await api('manage/course-import', course, admin)).status, 200);
    const password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName: 'prepared-student', password }, admin);
    const login = await api('login', { loginName: 'prepared-student', password });
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true }, admin);
    const created = await api('course-activities', { requestId: randomUUID(), releaseId }, headers);
    assert.equal(created.status, 200, JSON.stringify(created.value));
    const activity = created.value, works = `workspaces/${activity.activityId}`;

    const bundle = await api(`releases/${releaseId}/components/annotation`, undefined, headers);
    assert.equal(bundle.status, 200);
    assert.equal(bundle.value.definition.digest, imported.value.digest);
    const dependencyRoute = `releases/${releaseId}/components/annotation/dependencies/${dependency.dependencyId}`;
    const delivered = await api(dependencyRoute, undefined, headers);
    assert.equal(delivered.status, 200, JSON.stringify(delivered.value));
    assert.equal(delivered.value.sha256, dependency.sha256);
    assert.equal(delivered.value.byteLength, dependency.byteLength);
    const deliveredBytes = Buffer.from(delivered.value.contentBase64, 'base64');
    assert.equal(hash(deliveredBytes), dependency.sha256, 'the served bytes are the registered release file');
    assert.equal(deliveredBytes.length, dependency.byteLength);
    const vendored = await readFile(fileURLToPath(new URL('../../../components/material-annotation/vendor/mark.min.js', import.meta.url)));
    assert.equal(hash(vendored), dependency.sha256, 'the served dependency is the locked vendored release file');
    assert.equal((await api(`releases/${releaseId}/components/annotation/dependencies/not-declared`, undefined, headers)).status, 404);
    assert.equal((await api(`releases/${releaseId}/components/annotation/dependencies/not.declared`, undefined, headers)).status, 404,
      'only a declared dependency identifier reaches a resource; no arbitrary path is proxied');

    const outsiderPassword = randomUUID();
    const outsider = await api('manage/members', { requestId: randomUUID(), loginName: 'outside-student', password: outsiderPassword }, admin);
    const outsiderLogin = await api('login', { loginName: 'outside-student', password: outsiderPassword });
    const outsiderHeaders = { cookie: outsiderLogin.headers.get('set-cookie').split(';')[0] };
    assert.equal((await api(dependencyRoute, undefined, outsiderHeaders)).status, 403, 'dependency bytes follow the same eligibility as the component');

    const report = { formatVersion: 1, componentId: manifest.componentId, version: manifest.version, definitionDigest: imported.value.digest,
      preparationProtocolVersion: 1, selfTestVersion: manifest.selfTest.selfTestVersion, hostVersion: '1',
      device: { platform: 'Win32', browser: 'chrome', browserVersion: '141.0.0.0',
        features: ['message-port', 'crypto-subtle', 'indexeddb', 'sandboxed-iframe'], preparationImplementationVersion: 1 },
      status: 'ready', reason: 'none', stage: 'activate',
      capabilities: manifest.requiredCapabilities.map(capability => ({ capability, availability: 'available', reason: 'none', verification: 'verified' })),
      durationMs: 1200, resourceBytes: dependency.byteLength + manifest.entry.byteLength, cacheHit: false, preview: false,
      memoryNote: '仅统计准备实际取得的依赖字节数；未测量浏览器进程内存。' };
    const reportRoute = `releases/${releaseId}/components/annotation/preparation-report`;
    const submission = { reportId: randomUUID(), requestId: randomUUID(), report };
    assert.equal((await api(reportRoute, submission, outsiderHeaders)).status, 403);
    const submitted = await api(reportRoute, submission, headers);
    assert.equal(submitted.status, 200, JSON.stringify(submitted.value));
    assert.deepEqual((await api(reportRoute, submission, headers)).value, submitted.value, 'a repeated report submission returns its receipt');
    const forged = { ...submission, requestId: randomUUID(), report: { ...report, definitionDigest: 'f'.repeat(64) } };
    assert.equal((await api(reportRoute, forged, headers)).status, 409, 'a report must name the registered definition');
    const wrongVersion = { ...submission, requestId: randomUUID(), report: { ...report, version: 1 } };
    assert.equal((await api(reportRoute, wrongVersion, headers)).status, 400, 'a report must name the bound component version');
    const legacyReport = { reportId: randomUUID(), requestId: randomUUID(),
      report: { ...report, version: 1, definitionDigest: legacy.value.digest, selfTestVersion: 1 } };
    assert.equal((await api(`releases/${releaseId}/components/legacy/preparation-report`, legacyReport, headers)).status, 400,
      'a format 1 component declares no preparation protocol, so it holds no reports');
    const reports = await api(`releases/${releaseId}/components/annotation/preparation-reports`, undefined, headers);
    assert.equal(reports.status, 200);
    assert.equal(reports.value.length, 1);
    assert.deepEqual(reports.value[0], report);
    assert.equal(reports.value[0].device.platform, 'Win32', 'a report records the device that actually observed it');

    const state = { formatVersion: 1, instanceId: `${activity.activityId}:annotation`, componentId: manifest.componentId,
      version: manifest.version, definitionDigest: imported.value.digest, stateVersion: 1, operationId: randomUUID(),
      content: { annotations: [{ id: randomUUID(), quote: '观察到的事实', note: '我的理解\n第二行' }] } };
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/annotation.json', kind: 'state', encoding: 'json',
      mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify(state) };
    assert.equal((await api(works, { requestId: randomUUID(), baseRevision: 0, files: [file] }, headers)).status, 200);

    await runtime.stop(); await runtime.start();
    assert.equal((await api(dependencyRoute, undefined, headers)).status, 200, 'a retained dependency resource survives a restart');
    assert.equal(hash(Buffer.from((await api(dependencyRoute, undefined, headers)).value.contentBase64, 'base64')), dependency.sha256);
    assert.deepEqual((await api(`releases/${releaseId}/components/annotation/preparation-reports`, undefined, headers)).value, [report]);
    assert.equal((await api(works, undefined, headers)).value.files[0].value, file.value);

    const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
    const owner = environment.services.find(service => service.unit === 'space-course');
    const resourcePath = join(root, 'learning-resources', 'space-course', environment.environmentId, owner.serviceId, dependency.resourceId);
    const original = await readFile(resourcePath);
    await writeFile(resourcePath, 'corrupt');
    assert.equal((await api(dependencyRoute, undefined, headers)).status, 503, 'a corrupt retained resource is refused, not served');
    assert.equal((await api(`releases/${releaseId}/components/annotation`, undefined, headers)).status, 503);
    assert.equal((await api(works, undefined, headers)).value.files[0].value, file.value, 'a refused component cannot discard saved state');
    await writeFile(resourcePath, original);
    assert.equal((await api(dependencyRoute, undefined, headers)).status, 200);

    const disabled = { requestId: randomUUID(), componentId: manifest.componentId, version: manifest.version, enabled: false };
    assert.equal((await api('manage/component-status', disabled, admin)).status, 200);
    assert.equal((await api(dependencyRoute, undefined, headers)).status, 503, 'a disabled component stops serving its dependencies');
    assert.equal((await api(works, undefined, headers)).value.files[0].value, file.value);
    await api('manage/component-status', { ...disabled, requestId: randomUUID(), enabled: true }, admin);
    assert.equal((await api(dependencyRoute, undefined, headers)).status, 200);
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: false }, admin);
    assert.equal((await api(dependencyRoute, undefined, headers)).status, 403);
    assert.equal((await api(`releases/${releaseId}/components/annotation/preparation-reports`, undefined, headers)).status, 403);
  } finally { await runtime.stop().catch(() => {}); }
});
