import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordRecoverySuccession, recoveryPredecessors } from '../dist/recovery-successions.js';
import { retireInstallation } from '../dist/retired-installations.js';
import { withModelOriginRecovery } from '../dist/model-origin-authority.js';

const fact = (service, sourceInstallationId, targetInstallationId) => ({ formatVersion: 1, backupId: randomUUID(),
  sourceEnvironmentId: service.environmentId, sourceServiceId: service.serviceId, sourceInstallationId, targetInstallationId });

test('R10 host permit uses real retired predecessors, never a new credential alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-model-origin-host-'));
  try {
    const service = { environmentId: randomUUID(), serviceId: randomUUID() };
    const first = randomUUID(), middle = randomUUID(), last = randomUUID();
    const one = fact(service, first, middle), two = fact(service, middle, last);
    let allowed = true, taskReads = 0;
    const task = { operation: 'learning', formatVersion: 3, origin: { service, installationId: last, grantId: randomUUID() } };
    const host = withModelOriginRecovery(root, { async authorizeTask() {
      if (!allowed) throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
      return { authorized: true };
    } }, { deviceTasks: { async read() { taskReads++; return { task }; } } });
    assert.deepEqual(await host.authorizeTask({}, {}, randomUUID()), { authorized: true, successions: [] },
      'a fresh credential without retirement and succession carries no predecessor authority');
    await assert.rejects(recordRecoverySuccession(root, one), /retired source/);
    await retireInstallation(root, first); await recordRecoverySuccession(root, one);
    assert.deepEqual(await recoveryPredecessors(root, service, last), []);
    await retireInstallation(root, middle); await recordRecoverySuccession(root, two);
    assert.deepEqual((await host.authorizeTask({}, {}, randomUUID())).successions, [one, two]);
    assert.deepEqual(await recoveryPredecessors(root, { ...service, serviceId: randomUUID() }, last), []);
    assert.deepEqual(await recoveryPredecessors(root, { ...service, environmentId: randomUUID() }, last), []);
    const reads = taskReads; allowed = false;
    await assert.rejects(host.authorizeTask({}, {}, randomUUID()), { code: 'forbidden' });
    assert.equal(taskReads, reads, 'failed current task authorization never returns recovery evidence');
    await unlink(join(root, 'private', 'retired-installations', first + '.json'));
    await assert.rejects(recoveryPredecessors(root, service, last), /Invalid recovery succession/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('R10 recovery evidence rejects cycles and ambiguous predecessor histories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-model-origin-cycle-'));
  try {
    const service = { environmentId: randomUUID(), serviceId: randomUUID() };
    const first = randomUUID(), last = randomUUID();
    await retireInstallation(root, first); await retireInstallation(root, last);
    await recordRecoverySuccession(root, fact(service, first, last));
    await recordRecoverySuccession(root, fact(service, last, first));
    await assert.rejects(recoveryPredecessors(root, service, last), /Invalid recovery predecessor/);
    const otherService = { ...service, serviceId: randomUUID() }, another = randomUUID();
    await retireInstallation(root, another);
    await recordRecoverySuccession(root, fact(otherService, first, last));
    await recordRecoverySuccession(root, fact(otherService, another, last));
    await assert.rejects(recoveryPredecessors(root, otherService, last), /Invalid recovery predecessor/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
