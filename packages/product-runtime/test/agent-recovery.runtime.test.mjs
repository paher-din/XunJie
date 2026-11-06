import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createProductLearningApplication, createProductRuntimeHost, openProductRuntime,
  resolveCredential, restoreProductRecovery } from '@xunjie/product-runtime';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to PostgreSQL 18.6.');
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };

for (const application of [false, true]) {
  test(`agent restore preserves profile and dependency reference without restoring connection secrets (${application ? 'production owners' : 'runtime only'})`, { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xj-agent-recovery-'));
    const sourceRoot = join(directory, 'source'), targetRoot = join(directory, 'target');
    const source = openProductRuntime({ root: sourceRoot, resources });
    const target = openProductRuntime({ root: targetRoot, resources });
    const receiver = openProductRuntime({ root: join(directory, 'receiver'), resources });
    let sourceHost, receiverHost, restored;
    try {
      const agent = { dependencyConnectionId: randomUUID() };
      const installed = await source.install({ profile: 'agent', agent });
      const receiverEnvironment = (await receiver.install({ profile: 'remote' })).environment;
      receiverHost = await createProductRuntimeHost({ root: join(directory, 'receiver') });
      sourceHost = await createProductRuntimeHost({ root: sourceRoot,
        ...(application ? { createApplication: createProductLearningApplication } : {}) });
      const environment = (await source.status()).environment;
      if (application) assert.deepEqual(environment.services.map(item => item.unit).sort(), ['client', 'teaching-agent']);
      const grant = await receiver.authorize({ sourceEnvironmentId: environment.environmentId,
        sourceServiceId: environment.services[0].serviceId, sourceInstallationId: environment.installationId,
        capabilities: ['runtime.status'] });
      const connection = { connectionId: agent.dependencyConnectionId,
        sourceEnvironmentId: environment.environmentId, sourceServiceId: environment.services[0].serviceId,
        target: receiverEnvironment.services[0], requiredCapabilities: ['runtime.status'], optionalCapabilities: [], credentialRef: 'old-peer' };
      await source.connect(connection, grant.token);
      assert.equal(await resolveCredential(sourceRoot, connection.credentialRef), grant.token);
      const key = randomBytes(32);
      const manifest = await sourceHost.recovery.backup({ directory: join(directory, 'backups'), key, leaveClosed: true });
      restored = await restoreProductRecovery({ root: targetRoot, resources, key,
        backupDirectory: join(directory, 'backups', manifest.backupId) });
      const config = JSON.parse(await readFile(join(targetRoot, 'installation.json'), 'utf8'));
      const recovered = await target.status();
      assert.equal(recovered.environment.profile, 'agent');
      assert.deepEqual(config.agent, agent);
      assert.deepEqual(config.connections, [connection]);
      assert.equal(recovered.environment.environmentId, installed.environment.environmentId);
      assert.notEqual(recovered.environment.installationId, installed.environment.installationId);
      assert.deepEqual(restored.owners.map(owner => owner.participant.descriptor.serviceId).sort(),
        manifest.services.map(owner => owner.serviceId).sort());
      assert.equal(JSON.parse(await readFile(join(targetRoot, 'recovery-state.json'), 'utf8')).phase, 'isolated');
      await assert.rejects(resolveCredential(targetRoot, connection.credentialRef));
      assert.notEqual(await resolveCredential(targetRoot, 'control'), await resolveCredential(sourceRoot, 'control'));
    } finally {
      for (const owner of restored?.owners ?? []) await owner.close?.();
      await sourceHost?.stop(); await receiverHost?.stop(); await target.stop().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });
}
