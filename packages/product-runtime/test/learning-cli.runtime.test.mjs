import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: '课程恢复.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: '课程与作品在同一完整备份边界\n' };
    const workRequest = { requestId: randomUUID(), baseRevision: 0, files: [work] };
    const savedWork = await fetch(new URL('/api/learning/workspaces/' + pinned.activityId, started.endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(workRequest) });
    assert.equal(savedWork.status, 200);
    const keyFile = join(directory, 'recovery-key');
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    const backupDirectory = join(directory, 'backups');
    const backup = await run('backup', source, '--file', await input('backup', { keyFile, directory: backupDirectory, leaveClosed: true }));
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
    for (const suffix of ['', '/receipts/' + workRequest.requestId]) {
      const restoredWork = await fetch(new URL('/api/learning/workspaces/' + pinned.activityId + suffix, isolated.endpoint), { headers: { cookie: restoredCookie } });
      assert.equal(restoredWork.status, 200);
      assert.deepEqual(await restoredWork.json(), { revision: 1, files: [work] });
    }
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
