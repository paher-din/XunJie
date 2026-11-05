import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
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
  const agents = [];
  let releaseReceive;
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
    const dispatched = [], cancelled = [], receivedIds = [], attempts = new Map();
    let receives = 0;
    const gate = new Promise(resolve => { releaseReceive = resolve; });
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
          receivedIds.push(input.attemptId);
          if (!attempts.has(input.attemptId)) attempts.set(input.attemptId,
            { attemptId: input.attemptId, state: 'accepted', physicalRequestEnded: false,
              text: '', usage: { state: 'unknown' }, reason: '' });
          await gate;
          return attempts.get(input.attemptId);
        },
        requestPayload: async () => ({ model: 'fixture-driver', messages: [] }),
        dispatch: async (_identity, attemptId) => {
          const accepted = attempts.get(attemptId);
          assert.equal(accepted?.state, 'accepted', 'only a received, undispatched attempt can be sent');
          dispatched.push(attemptId);
          const completed = { ...accepted, physicalRequestEnded: true, state: 'completed', resultRef: randomUUID(), text: '单一回答',
            usage: { state: 'final', inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
          attempts.set(attemptId, completed);
          return completed;
        },
        cancel: async (_identity, attemptId) => { cancelled.push(attemptId); },
        read: async (_identity, attemptId) => {
          if (!attempts.has(attemptId)) throw new StorageError('missing');
          return attempts.get(attemptId);
        },
      },
    };
    const activity = { activityId, goal: '单一推进权', question: '', references: [], status: 'open',
      createdAt: new Date().toISOString(), identity };
    const options = { authorize: async () => {}, identityFor: async () => identity, activity: async () => activity,
      models, leaseMs: 250, scanIntervalMs: 60_000, start: false };
    const first = createTeachingAgent(storage, { ...options, driverId: 'driver-a' });
    const second = createTeachingAgent(storage, { ...options, driverId: 'driver-b' });
    agents.push(first, second);
    const input = { requestId: randomUUID(), scope: { environmentId, spaceId: identity.spaceId,
      principalId: identity.principalId, activityId }, receiver: { receiverId: teachingAgentReceiverId(owner.serviceId),
      location: 'remote', kind: 'question' }, draft: { token: randomUUID(), question: '哪一个推进者会真正外发？',
      references: [], bases: [] }, works: [], evidence: [] };
    const receipt = await first.receiver.accept(input, digest(input));
    assert.equal(receipt.state, 'accepted');
    const runId = JSON.parse(receipt.detail).runId;
    first.resume();
    const receiveDeadline = Date.now() + 3000;
    while (!receives && Date.now() < receiveDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(receives, 1, 'the first driver durably receives the original attempt');
    // The first driver holds the lease while blocked before dispatch; an expired lease is what
    // lets another recovery namespace attempt to take over the same run.
    await new Promise(resolve => setTimeout(resolve, 400));
    second.resume();
    const deadline = Date.now() + 3000;
    while (receives < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(receives, 2, 'the second driver takes over after the lease expires');
    assert.equal(new Set(receivedIds).size, 1, 'both generations receive the same durable planned attempt');
    releaseReceive();
    let run;
    for (let count = 0; count < 200; count++) {
      run = await first.run(identity, activityId, runId);
      if (run.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(run.state, 'completed');
    assert.equal(dispatched.length, 1,'only one driver dispatches the prepared attempt');
    assert.deepEqual(dispatched, [receivedIds[0]]);
    assert.equal(cancelled.length, 0,'losing authority cannot cancel the shared original attempt');
    const events = await first.events(identity, activityId);
    assert.equal(events.filter(event => event.kind === 'attempt-dispatched').length, 1);
    assert.equal(events.filter(event => event.kind === 'assistant').length, 1);
    assert.equal(events.filter(event => event.kind === 'run-completed').length, 1);
    first.close(); second.close();
  } finally {
    releaseReceive?.();
    for (const agent of agents) { agent.closeDispatch(); agent.close(); }
    await Promise.allSettled(agents.map(agent => agent.drain()));
    await storage?.close(); await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
