import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCredential } from '@xunjie/product-runtime';

const execute = promisify(execFile);
const productPackage = process.env.XUNJIE_PRODUCT_TEST_PACKAGE;
const cli = productPackage ? join(productPackage, 'app', 'cli.js') : fileURLToPath(new URL('../../../apps/local-runtime/dist/cli.js', import.meta.url));
const packagedResources = productPackage ? JSON.parse(await readFile(join(productPackage, 'resources.json'), 'utf8')) : null;
if (packagedResources) for (const name of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath']) {
  if (packagedResources[name]) packagedResources[name] = resolve(productPackage, packagedResources[name]);
}
const runtimeNode = packagedResources?.nodePath ?? process.execPath;
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin && !packagedResources) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to the complete native PostgreSQL 18.6 distribution.');

test('the normal CLI restores all learning owners and reaches schema upgrade validation', { timeout: 300000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-learning-cli-'));
  const source = join(directory, 'source'), target = join(directory, 'target');
  const upgradeTarget = join(directory, 'upgrade-target');
  const resources = join(directory, 'resources.json');
  await writeFile(resources, JSON.stringify(packagedResources ?? { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) }));
  const input = async (name, value) => {
    const path = join(directory, name + '.json');
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const run = async (command, root, ...args) => {
    const { stdout } = await execute(runtimeNode, [cli, command, '--root', root, '--resources', resources, ...args],
      { timeout: 180000, windowsHide: true });
    return JSON.parse(stdout);
  };
  try {
    await run('install', source, '--profile', 'local');
    const started = await run('start', source);
    assert.equal(started.state, 'ready');
    const receiverId = started.environment.environmentId + '/' + started.environment.services[0].serviceId;
    const fencedSource = randomUUID(), fencedService = randomUUID();
    await assert.rejects(run('fence-source', source, '--file', await input('wrong-receiver', {
      expectedReceiver: randomUUID() + '/' + randomUUID(), sourceEnvironmentId: fencedSource, sourceServiceIds: [fencedService] })),
    error => { assert.match(error.stderr, /receiver-identity-conflict/); return true; });
    assert.deepEqual(await run('fence-source', source, '--file', await input('fence-source', {
      expectedReceiver: receiverId, sourceEnvironmentId: fencedSource, sourceServiceIds: [fencedService] })), {
      fenced: true, receiverId, sourceEnvironmentId: fencedSource, sourceServiceIds: [fencedService] });
    const body = { requestId: randomUUID(), goal: '通过正式 CLI 恢复活动', question: '', references: [] };
    const created = await fetch(new URL('/api/learning/activities', started.endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' }, body: JSON.stringify(body) });
    assert.equal(created.status, 200);
    const activity = await created.json();
    const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
    const password = randomUUID();
    const member = await run('school-member', source, '--file', await input('member', {
      requestId: randomUUID(), loginName: 'restore-student', password }));
    const login = await fetch(new URL('/api/learning/login', started.endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'restore-student', password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const importRoot = join(directory, 'import');
    await mkdir(join(importRoot, 'materials'), { recursive: true });
    const openText = Buffer.from('# 恢复验收材料\n课程材料必须随备份恢复。');
    const privateText = Buffer.from('# 教师私有测试\n不得出现在学生投影。');
    await writeFile(join(importRoot, 'materials', 'open.md'), openText);
    await writeFile(join(importRoot, 'materials', 'private.md'), privateText);
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const studentMaterialId = randomUUID(), privateMaterialId = randomUUID();
    const manifestFile = join(importRoot, 'release.json');
    await writeFile(manifestFile, JSON.stringify({
      formatVersion: 1, requestId: randomUUID(),
      course: { courseId, name: '恢复验收课程' },
      task: { taskId, title: '恢复验收任务', summary: '验证备份与恢复。' },
      release: { releaseId, objectives: ['验收课程恢复'], requirements: '保持固定版本与材料。',
        materials: [
          { materialId: studentMaterialId, title: '开放材料', path: 'materials/open.md', mediaType: 'text/markdown',
            access: 'student', sha256: sha256(openText), byteLength: openText.byteLength },
          { materialId: privateMaterialId, title: '私有材料', path: 'materials/private.md', mediaType: 'text/markdown',
            access: 'private', sha256: sha256(privateText), byteLength: privateText.byteLength },
        ], starterWorks: [], capabilities: [] },
    }));
    const imported = await run('course-import', source, '--file', manifestFile);
    assert.equal(imported.releaseId, releaseId);
    await run('course-access', source, '--file', await input('access', {
      requestId: randomUUID(), courseId, principalId: member.principalId, active: true }));
    const courseBody = { requestId: randomUUID(), releaseId };
    const courseActivity = await fetch(new URL('/api/learning/course-activities', started.endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(courseBody) });
    assert.equal(courseActivity.status, 200);
    const pinned = await courseActivity.json();
    assert.equal(pinned.course.releaseId, releaseId);
    const draftWork = { objectId: randomUUID(), contentId: randomUUID(), name: 'restore.sv', kind: 'code',
      encoding: 'utf8', mediaType: 'text/plain', value: '\uFEFF// 恢复草稿\r\nmodule restore;\r\nendmodule\r\n' };
    const draftWorkRequest = { requestId: randomUUID(), baseRevision: 0, files: [draftWork] };
    const workSync = await fetch(new URL('/api/learning/workspaces/' + pinned.activityId, started.endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(draftWorkRequest) });
    assert.equal(workSync.status, 200);
    const emptyDraft = await (await fetch(new URL('/api/learning/drafts/' + pinned.activityId, started.endpoint), { headers: { cookie } })).json();
    const materialCopy = '# 恢复验收材料';
    const codeCopy = 'module restore;';
    const draftInput = { requestId: randomUUID(), draftId: emptyDraft.draftId, baseRevision: 0,
      question: '恢复后固定引用仍应可读。', references: [
        { referenceId: randomUUID(), source: { kind: 'course-material', courseId, taskId, releaseId,
          contentDigest: imported.contentDigest, materialId: studentMaterialId, materialSha256: sha256(openText),
          mediaType: 'text/markdown' }, range: { kind: 'text', start: 0, end: materialCopy.length },
          copy: materialCopy, sourceName: '开放材料' },
        { referenceId: randomUUID(), source: { kind: 'work', objectId: draftWork.objectId, contentId: draftWork.contentId },
          range: { kind: 'code', start: draftWork.value.indexOf(codeCopy), end: draftWork.value.indexOf(codeCopy) + codeCopy.length },
          copy: codeCopy, sourceName: 'restore.sv' },
      ], bases: [draftWork] };
    const draftSync = await fetch(new URL('/api/learning/drafts/' + pinned.activityId, started.endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(draftInput) });
    assert.equal(draftSync.status, 200);
    const savedDraft = await draftSync.json();
    assert.equal(savedDraft.revision, 1);
    assert.equal(savedDraft.references.length, 2);
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: '课程恢复.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: '课程与作品在同一完整备份边界\n' };
    const workRequest = { requestId: randomUUID(), baseRevision: 1, files: [work] };
    const savedWork = await fetch(new URL('/api/learning/workspaces/' + pinned.activityId, started.endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(workRequest) });
    assert.equal(savedWork.status, 200);
    const keyFile = join(directory, 'recovery-key');
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    const backupDirectory = join(directory, 'backups');
    let latestWork = { revision: 2, files: [work] }, latestPublished = null;
    let workClosed = false, publicationClosed = false;
    const control = await resolveCredential(source, 'control');
    const publicationBase = JSON.parse(await readFile(manifestFile, 'utf8'));
    const writer = (async () => {
      for (let i = 0; i < 100; i++) {
        const files = [{ ...work, contentId: randomUUID(), value: '备份并发作品 ' + i + '\n' }];
        const response = await fetch(new URL('/api/learning/workspaces/' + pinned.activityId, started.endpoint), { method: 'POST',
          headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), baseRevision: latestWork.revision, files }) });
        if (response.status === 503) { workClosed = true; break; }
        assert.equal(response.status, 200); latestWork = await response.json();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })();
    const publisher = (async () => {
      for (let i = 0; i < 100; i++) {
        const content = Buffer.from('并发发布的课程原材料 ' + i + '\n');
        const materialId = randomUUID(), nextReleaseId = randomUUID();
        const response = await fetch(new URL('/api/learning/manage/course-import', started.endpoint), { method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + control }, body: JSON.stringify({ ...publicationBase,
            requestId: randomUUID(), release: { ...publicationBase.release, releaseId: nextReleaseId,
              materials: [{ materialId, title: '并发原材料', path: 'concurrent.md', mediaType: 'text/plain', access: 'student', sha256: sha256(content), byteLength: content.length }] },
            resources: [{ path: 'concurrent.md', contentBase64: content.toString('base64') }] }) });
        if (response.status === 503) { publicationClosed = true; break; }
        assert.equal(response.status, 200); await response.json(); latestPublished = { materialId, releaseId: nextReleaseId, value: content.toString('utf8') };
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })();
    const backup = await run('backup', source, '--file', await input('backup', { keyFile, directory: backupDirectory, leaveClosed: true }));
    await Promise.all([writer, publisher]);
    assert.ok(latestWork.revision > 2 && latestPublished, 'real work and new resource publications must precede the held boundary');
    assert.ok(workClosed && publicationClosed, 'closing must reject continuing producers instead of waiting for input to stop');
    assert.equal(backup.services.length, 3);
    const damagedBackup = join(directory, 'damaged-backup-copy');
    await cp(join(backupDirectory, backup.backupId), damagedBackup, { recursive: true });
    await unlink(join(damagedBackup, 'artifacts', backup.artifacts[0].path));
    await assert.rejects(run('restore', join(directory, 'missing-artifact-target'), '--file', await input('damaged-restore', {
      keyFile, backupDirectory: damagedBackup })), error => { assert.match(error.stderr, /invalid-recovery|ENOENT|verification/); return true; });
    const restored = await run('restore', target, '--file', await input('restore', {
      keyFile, backupDirectory: join(backupDirectory, backup.backupId) }));
    assert.equal(restored.phase, 'isolated');
    const isolated = await run('start', target);
    assert.equal(isolated.state, 'maintenance');
    await run('takeover', target, '--file', await input('takeover', { sourceRoot: source, receivers: [] }));
    const response = await fetch(new URL('/api/learning/activities/' + activity.activityId, isolated.endpoint), {
      headers: { 'x-xj-space': 'personal' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), activity);
    // Takeover issues a new installation identity, so restored cookie hashes no longer authorize.
    const relogin = await fetch(new URL('/api/learning/login', isolated.endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'restore-student', password }) });
    assert.equal(relogin.status, 200);
    const restoredCookie = relogin.headers.get('set-cookie').split(';')[0];
    const restoredRelease = await fetch(new URL('/api/learning/releases/' + releaseId, isolated.endpoint), { headers: { cookie: restoredCookie } });
    assert.equal(restoredRelease.status, 200);
    assert.equal((await restoredRelease.json()).contentDigest, imported.contentDigest);
    const restoredMaterial = await fetch(new URL(`/api/learning/releases/${releaseId}/materials/${studentMaterialId}`, isolated.endpoint),
      { headers: { cookie: restoredCookie } });
    assert.equal(restoredMaterial.status, 200);
    assert.equal(Buffer.from((await restoredMaterial.json()).contentBase64, 'base64').toString('utf8'), openText.toString('utf8'));
    const hiddenMaterial = await fetch(new URL(`/api/learning/releases/${releaseId}/materials/${privateMaterialId}`, isolated.endpoint),
      { headers: { cookie: restoredCookie } });
    assert.equal(hiddenMaterial.status, 404);
    const restoredActivity = await fetch(new URL('/api/learning/activities/' + pinned.activityId, isolated.endpoint), { headers: { cookie: restoredCookie } });
    assert.equal(restoredActivity.status, 200);
    assert.deepEqual(await restoredActivity.json(), pinned);
    const restoredDraft = await fetch(new URL('/api/learning/drafts/' + pinned.activityId, isolated.endpoint), { headers: { cookie: restoredCookie } });
    assert.equal(restoredDraft.status, 200);
    assert.deepEqual(await restoredDraft.json(), savedDraft);
    const restoredRevision = await fetch(new URL(`/api/learning/drafts/${pinned.activityId}/revisions/${savedDraft.revisionId}`, isolated.endpoint),
      { headers: { cookie: restoredCookie } });
    assert.equal(restoredRevision.status, 200);
    assert.deepEqual(await restoredRevision.json(), savedDraft);
    const restoredDraftReceipt = await fetch(new URL(`/api/learning/drafts/${pinned.activityId}/receipts/${draftInput.requestId}`, isolated.endpoint),
      { headers: { cookie: restoredCookie } });
    assert.equal(restoredDraftReceipt.status, 200);
    assert.deepEqual(await restoredDraftReceipt.json(), savedDraft);
    assert.equal(savedDraft.references[0].copy, materialCopy);
    assert.equal(savedDraft.references[1].copy, codeCopy);
    for (const suffix of ['', '/receipts/' + workRequest.requestId]) {
      const restoredWork = await fetch(new URL('/api/learning/workspaces/' + pinned.activityId + suffix, isolated.endpoint), { headers: { cookie: restoredCookie } });
      assert.equal(restoredWork.status, 200);
      assert.deepEqual(await restoredWork.json(), suffix ? { revision: 2, files: [work] } : latestWork);
    }
    const concurrentMaterial = await fetch(new URL(`/api/learning/releases/${latestPublished.releaseId}/materials/${latestPublished.materialId}`, isolated.endpoint),
      { headers: { cookie: restoredCookie } });
    assert.equal(concurrentMaterial.status, 200);
    assert.equal(Buffer.from((await concurrentMaterial.json()).contentBase64, 'base64').toString('utf8'), latestPublished.value);
    const queried = await run('course-result', target, '--file', await input('course-result', { requestId: imported.requestId }));
    assert.equal(queried.contentDigest, imported.contentDigest);
    // No schema migration was released: the CLI must reach that check, rather than fail assembling owners.
    await assert.rejects(run('upgrade', target, '--file', await input('upgrade', { kind: 'schema', targetRoot: upgradeTarget,
      keyFile, backupDirectory: join(directory, 'upgrade-backups') })), error => {
      assert.match(error.stderr, /no-schema-upgrade-registered/);
      return true;
    });
  } finally {
    for (const root of [upgradeTarget, target, source]) await run('stop', root).catch(() => {});
  }
});
