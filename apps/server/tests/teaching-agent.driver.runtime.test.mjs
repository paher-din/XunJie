import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { createTeachingAgent, teachingAgentMigrations } from '@xunjie/learning-space';
import { teachingAgentReceiverId } from '@xunjie/contracts/teaching-agent';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('two drivers racing on one run keep one effective dispatch through generation fencing', { timeout: 180000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-teaching-drivers-'));
  const runtime = openProductRuntime({ root, resources });
  let storage;
  try {
    await runtime.install({ profile: 'local' }); await runtime.start();
    const { credentialRef, ...connection } = await runtime.database();
    const admin = { ...connection, password: await resolveCredential(root, credentialRef) };
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin, owner, password: randomUUID(), migrations: teachingAgentMigrations });
    storage = await openStorage({ binding, migrations: teachingAgentMigrations,
      backend: createFileBackend({ id: 'teaching-driver', root: join(root, 'driver-files') }) });
    const environmentId = storage.owner.environmentId, activityId = randomUUID();
    const identity = { environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '两推进者测试' };
    const connectionFact = { connectionId: randomUUID(), version: 1, name: '驱动测试模型', protocol: 'chat-completions',
      modelId: 'fixture-driver', contextWindow: 262144, maxOutputTokens: 1024 };
    const dispatched = [], cancelled = [];
    let receives = 0, releaseReceive;
    const gate = new Promise(resolve => { releaseReceive = resolve; });
    let firstReceived, bothReceived;
    const receivedOnce = new Promise(resolve => { firstReceived = resolve; });
    const receivedTwice = new Promise(resolve => { bothReceived = resolve; });
    const models = {
      selection: {
        read: async () => ({ version: 1, selected: connectionFact }),
        snapshot: async () => ({ choice: { connection: connectionFact },
          source: { kind: 'personal', ownerScope: 'self', feeSource: 'self' } }),
      },
      segments: {
        read: async () => ({ closed: false, pending: false, sequence: 0 }),
        create: async () => {}, close: async () => {},
      },
      checks: {
        receive: async (_identity, input) => {
          receives++;
          if (receives === 1) firstReceived();
          if (receives === 2) bothReceived();
          await gate;
          return { attemptId: input.attemptId };
        },
        requestPayload: async () => ({ model: 'fixture-driver', messages: [] }),
        dispatch: async (_identity, attemptId) => { dispatched.push(attemptId); },
        cancel: async (_identity, attemptId) => { cancelled.push(attemptId); },
        read: async () => ({ physicalRequestEnded: true, state: 'completed', text: '单一回答',
          usage: { state: 'final', inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reason: '' }),
      },
    };
    const activity = { activityId, goal: '单一推进权', question: '', references: [], status: 'open',
      createdAt: new Date().toISOString(), identity };
    const options = { authorize: async () => {}, identityFor: async () => identity, activity: async () => activity,
      models, leaseMs: 250, scanIntervalMs: 60_000, start: false };
    const first = createTeachingAgent(storage, { ...options, driverId: 'driver-a' });
    const second = createTeachingAgent(storage, { ...options, driverId: 'driver-b' });
    const input = { requestId: randomUUID(), scope: { environmentId, spaceId: identity.spaceId,
      principalId: identity.principalId, activityId }, receiver: { receiverId: teachingAgentReceiverId(owner.serviceId),
      location: 'remote', kind: 'question' }, draft: { token: randomUUID(), question: '哪一个推进者会真正外发？',
      references: [], bases: [] }, works: [], evidence: [] };
    const receipt = await first.receiver.accept(input, digest(input));
    assert.equal(receipt.state, 'accepted');
    const runId = JSON.parse(receipt.detail).runId;
    first.resume();
    await receivedOnce;
    // The first driver holds the lease while blocked before dispatch; an expired lease is what
    // lets another recovery namespace attempt to take over the same run.
    await new Promise(resolve => setTimeout(resolve, 400));
    second.resume();
    const deadline = Date.now() + 3000;
    while (receives < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(receives, 2, 'the second driver takes over after the lease expires');
    releaseReceive();
    let run;
    for (let count = 0; count < 200; count++) {
      run = await first.run(identity, activityId, runId);
      if (run.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(run.state, 'completed');
    assert.equal(dispatched.length, 1,'only one driver dispatches the prepared attempt');
    assert.equal(cancelled.length, 1,'the losing driver releases its own prepared attempt');
    const events = await first.events(identity, activityId);
    assert.equal(events.filter(event => event.kind === 'attempt-dispatched').length, 1);
    assert.equal(events.filter(event => event.kind === 'assistant').length, 1);
    assert.equal(events.filter(event => event.kind === 'run-completed').length, 1);
    first.close(); second.close();
  } finally { await storage?.close(); await runtime.stop(); }
});
