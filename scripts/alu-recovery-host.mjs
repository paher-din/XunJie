#!/usr/bin/env node
// #195 maintenance driver. Uses only the candidate's public product/owner APIs.
// Configuration and credentials stay in a private file outside Git. Student traffic never uses SSH.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function openAluRecoveryHost(configPath) {
  const path = resolve(configPath), config = JSON.parse(await readFile(path, 'utf8'));
  const product = resolve(config.product), root = resolve(config.root);
  const runtime = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
  const resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
  for (const key of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper'])
    if (resources[key]) resources[key] = resolve(product, resources[key]);
  const sourceRoot = join(root, 'source'), targetRoot = join(root, 'target');
  const source = runtime.openProductRuntime({ root: sourceRoot, resources });
  const target = runtime.openProductRuntime({ root: targetRoot, resources });
  const save = () => writeFile(path, JSON.stringify(config) + '\n', { mode: 0o600 });
  const admin = async (endpoint, route, input, ownerRoot = sourceRoot) => {
    const response = await fetch(new URL('/api/learning/manage/' + route, endpoint), { method: 'POST',
      headers: { authorization: `Bearer ${await runtime.resolveCredential(ownerRoot, 'control')}`, 'content-type': 'application/json' },
      body: JSON.stringify(input) });
    assert.equal(response.status, 200, `manage ${route}: ${response.status}`);
    return response.json();
  };
  const backup = () => source.recovery.backup({ directory: join(root, 'backups'), recoveryKeyRef: 'alu-recovery-key', leaveClosed: true });
  return async function action(operation, input = {}) {
    assert.match(input.probeId ?? '', /^[0-9a-f-]{36}$/i, 'the current probe invocation must identify itself');
    if (operation !== 'setup') assert.equal(config.probeId, input.probeId, 'this invocation has not claimed the probe root');
    if (operation === 'setup') {
      await mkdir(root, { mode: 0o700 });
      config.probeId = input.probeId;
      await writeFile(join(root, '.alu-recovery-probe'), config.probeId, { mode: 0o600, flag: 'wx' });
      await save();
      await source.install(config.installation ?? { profile: 'local' });
      const started = await source.start();
      config.sourceEndpoint = started.endpoint;
      const packages = JSON.parse(await readFile(config.packages, 'utf8'));
      const definition = await admin(config.seedEndpoint ?? started.endpoint, 'component-import', packages.component);
      packages.course.release.components[0].definition = definition;
      await admin(config.seedEndpoint ?? started.endpoint, 'course-import', packages.course);
      config.loginName = 'alu195-' + randomUUID().slice(0, 8); config.password = randomUUID();
      config.releaseId = packages.course.release.releaseId;
      const member = await admin(config.seedEndpoint ?? started.endpoint, 'members', {
        requestId: randomUUID(), loginName: config.loginName, password: config.password });
      await admin(config.seedEndpoint ?? started.endpoint, 'course-access', { requestId: randomUUID(),
        courseId: packages.course.course.courseId, principalId: member.principalId, active: true });
      config.recoveryKey = randomBytes(32).toString('base64');
      await source.setCredential('alu-recovery-key', config.recoveryKey);
      await save();
      return { endpoint: config.publicEndpoint ?? started.endpoint, loginName: config.loginName, password: config.password,
        releaseId: config.releaseId, spki: config.spki, environment: started.environment,
        platform: process.platform, arch: process.arch, node: process.version, postgresVersion: resources.postgresVersion,
        expected: { materials: packages.course.release.materials.filter(item => item.access === 'student')
          .map(({ materialId, sha256, byteLength }) => ({ materialId, sha256, byteLength })),
          componentManifest: packages.component.manifest },
        distributionSha256: hash(await readFile(join(product, 'distribution.json'))) };
    }
    if (operation === 'blocked-backup') {
      await assert.rejects(backup());
      const catalog = await source.recovery.catalog(join(root, 'backups'));
      assert.equal(catalog.backups.length, 0, 'unconfirmed ALU operations cannot publish a complete backup');
      const status = await source.status();
      assert.match(status.reason, /原浏览器执行.*核对或停止/);
      return { completeBackups: 0, failure: catalog.latest, reason: status.reason };
    }
    if (operation === 'resume-source') return source.recovery.resume();
    if (operation === 'disable-runtime' || operation === 'enable-runtime') {
      const packages = JSON.parse(await readFile(config.packages, 'utf8'));
      const { componentId, version } = packages.component.manifest;
      return admin(config.seedEndpoint ?? config.targetEndpoint, 'component-status',
        { requestId: randomUUID(), componentId, version, enabled: operation === 'enable-runtime' }, targetRoot);
    }
    if (operation === 'backup') {
      const manifest = await backup(); config.backupId = manifest.backupId; await save();
      return manifest;
    }
    if (operation === 'negative') {
      const original = join(root, 'backups', config.backupId);
      const manifestBytes = await readFile(join(original, 'manifest.json'));
      const cases = [];
      for (const ownerUnit of ['learning-data', 'space-course']) for (const kind of ['missing', 'corrupt']) {
        const suffix = ownerUnit + '-' + kind;
        const copy = join(root, 'negative-' + suffix), badTarget = join(root, 'negative-target-' + suffix);
        await cp(original, copy, { recursive: true });
        const manifest = JSON.parse(manifestBytes);
        const ownerId = manifest.source.services.find(item => item.unit === ownerUnit).serviceId;
        const packages = JSON.parse(await readFile(config.packages, 'utf8'));
        const runtimeId = packages.component.manifest.runtime.resources[0].resourceId;
        const retained = manifest.artifacts.find(item => item.path.startsWith(ownerId + '/') && item.path.endsWith('.blob')
          && (ownerUnit !== 'space-course' || item.path.endsWith('/' + runtimeId + '.blob')));
        assert.ok(retained, 'negative recovery must target an ALU owner resource');
        const artifact = join(copy, 'artifacts', retained.path);
        if (kind === 'missing') await rm(artifact);
        else { const bytes = await readFile(artifact); bytes[Math.floor(bytes.length / 2)] ^= 1; await writeFile(artifact, bytes); }
        let failure;
        try { await runtime.restoreProductRecovery({ root: badTarget, backupDirectory: copy,
          resources, key: Buffer.from(config.recoveryKey, 'base64') }); }
        catch (error) { failure = { code: error.code ?? error.name, message: error.message }; }
        assert.ok(failure, kind + ' must refuse recovery');
        assert.deepEqual(await readFile(join(original, 'manifest.json')), manifestBytes, 'original backup preserved');
        cases.push({ ownerUnit, kind, artifact: retained.path, ...failure });
        await rm(copy, { recursive: true, force: true });
        await rm(badTarget, { recursive: true, force: true });
      }
      return { cases };
    }
    if (operation === 'restore') {
      const restored = await runtime.restoreProductRecovery({ root: targetRoot,
        backupDirectory: join(root, 'backups', config.backupId), key: Buffer.from(config.recoveryKey, 'base64'), resources,
        ...(config.targetInstallation ? { installation: config.targetInstallation } : {}) });
      try { assert.equal(JSON.parse(await readFile(join(targetRoot, 'recovery-state.json'), 'utf8')).phase, 'isolated'); }
      finally { for (const owner of restored.owners) await owner.close?.(); }
      if (config.samePublicEndpoint) {
        const environment = JSON.parse(await readFile(join(targetRoot, 'environment.json'), 'utf8'));
        await source.recovery.retire({ backupId: config.backupId, targetInstallationId: environment.installationId });
        await source.stop();
      }
      const started = await target.start();
      assert.equal(started.state, 'maintenance');
      config.targetEndpoint = started.endpoint; await save();
      return { endpoint: config.targetPublicEndpoint ?? started.endpoint, environment: started.environment, state: started.state };
    }
    if (operation === 'takeover') {
      const originalFetch = globalThis.fetch; let lost = false;
      globalThis.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (!lost && typeof args[1]?.body === 'string' && args[1].body.includes('"action":"takeover"') && response.ok) {
          await response.arrayBuffer(); lost = true; throw new TypeError('lost completed takeover confirmation');
        }
        return response;
      };
      try { await assert.rejects(target.recovery.takeover({ sourceRoot, receivers: [] })); }
      finally { globalThis.fetch = originalFetch; }
      assert.equal(lost, true);
      const result = await target.recovery.takeover({ sourceRoot, receivers: [] });
      assert.equal(result.phase, 'active');
      if (config.samePublicEndpoint) await assert.rejects(source.start());
      else await assert.rejects(source.recovery.resume(), { code: 'source-retired' });
      return { result, lostConfirmation: lost, sourceRetired: true };
    }
    if (operation === 'cleanup') {
      assert.equal(await readFile(join(root, '.alu-recovery-probe'), 'utf8'), config.probeId,
        'cleanup must belong to this exact probe configuration');
      const existing = await readdir(root);
      const stopped = await Promise.allSettled([...(existing.includes('source') ? [source.stop()] : []),
        ...(existing.includes('target') ? [target.stop()] : [])]);
      assert.ok(stopped.every(item => item.status === 'fulfilled'), 'all owned environments must stop before cleanup');
      const entries = await readdir(root);
      assert.ok(entries.every(name => ['.alu-recovery-probe', 'source', 'target', 'backups'].includes(name)), 'only this probe owns the temporary root');
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
      return { stopped: true, temporaryRootRemoved: true };
    }
    throw new Error('Unknown ALU recovery operation: ' + operation);
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const driver = await openAluRecoveryHost(process.argv[2]);
  let input = '';
  for await (const bytes of process.stdin) input += bytes.toString();
  const result = await driver(process.argv[3], JSON.parse(input || '{}'));
  // setup contains private credentials; caller captures stdout directly into a private channel/file.
  process.stdout.write(JSON.stringify(result) + '\n');
}
