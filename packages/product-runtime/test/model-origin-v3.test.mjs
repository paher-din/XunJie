import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withModelOriginRecovery } from '../dist/model-origin-authority.js';

test('recipient recovery accepts a verified V3 task and preserves its original source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'model-origin-v3-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = { environmentId: randomUUID(), serviceId: randomUUID() }, installationId = randomUUID();
  const evidence = { authorized: true };
  let authorized = false;
  const paired = { async authorizeTask() { authorized = true; return evidence; } };
  const models = { deviceTasks: { async read() {
    assert.equal(authorized, true);
    return { task: { operation: 'learning', formatVersion: 3, origin: { service: source, installationId } } };
  } } };
  assert.deepEqual(await withModelOriginRecovery(root, paired, models).authorizeTask({}, {}), { ...evidence, successions: [] });
});
