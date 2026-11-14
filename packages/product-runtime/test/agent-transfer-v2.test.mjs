import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withAgentTransfer, agentTransferEntries } from '../dist/agent-transfer-journal.js';
import { createAgentConnection } from '../dist/agent-connections.js';

async function fixture(t, capability) {
  const root = await mkdtemp(join(tmpdir(), 'agent-v2-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, capability, installationId: randomUUID(), grantId: randomUUID(), connection: {
    connectionId: randomUUID(), sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(),
    target: { environmentId: randomUUID(), serviceId: randomUUID(), endpoint: 'http://127.0.0.1:1', unit: 'teaching-agent', protocolVersion: 1, capabilities: [capability] },
    requiredCapabilities: [capability], optionalCapabilities: [], credentialRef: 'synthetic',
  } };
}
const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'Student' };

test('connection rejects mixed capabilities and malformed v2 calls before configuration or network access', async () => {
  await assert.rejects(async () => createAgentConnection('/absent', randomUUID(), 'teaching.agent')({ version: 1 }), { code: 'incompatible' });
  const client = createAgentConnection('/absent', randomUUID(), 'agent.sessions.v2');
  await assert.rejects(client({ version: 1, operation: 'accept', args: [] }), { code: 'incompatible' });
  await assert.rejects(client({ version: 2, operation: 'accept', args: [] }), { code: 'invalid' });
});

test('v2 object args retain one request journal and reject edits under the original request', async t => {
  const options = await fixture(t, 'agent.sessions.v2');
  const sessionId = randomUUID(), requestId = randomUUID();
  const payload = { version: 2, operation: 'accept', identity, sessionId,
    args: { input: { sessionId, requestId, text: 'fixed', mode: 'steering', context: {} } } };
  let effects = 0;
  const work = async (entry, receive) => {
    if (entry.state !== 'pending') return entry.result;
    effects += 1; await receive({ accepted: true }); return { accepted: true };
  };
  await withAgentTransfer({ ...options, payload }, work);
  await withAgentTransfer({ ...options, payload }, work);
  assert.equal(effects, 1);
  await assert.rejects(withAgentTransfer({ ...options, payload: { ...payload,
    args: { input: { ...payload.args.input, text: 'changed' } } } }, work), { code: 'identity-conflict' });
  assert.equal(effects, 1);
  assert.equal((await agentTransferEntries(options.root)).length, 1);
});

test('v2 permit renewal keeps the original unknown payload and transfer identity', async t => {
  const options = await fixture(t, 'agent.dependencies.v2');
  const sessionId = randomUUID();
  const permit = { sessionId, runId: randomUUID(), stepId: randomUUID(), operationId: randomUUID(), generation: 1 };
  const payload = { version: 2, operation: 'workspace.data', identity, sessionId, permit,
    args: { method: 'artifacts.publish', args: [randomUUID(), { requestId: permit.operationId, text: 'original' }] } };
  let transferId;
  await assert.rejects(withAgentTransfer({ ...options, payload }, async entry => {
    transferId = entry.transferId; throw new Error('lost original response');
  }), /lost original response/);
  const renewed = { ...payload, permit: { ...permit, generation: 2 } };
  await withAgentTransfer({ ...options, payload: renewed }, async (entry, receive) => {
    assert.equal(entry.transferId, transferId);
    assert.equal(entry.payload.permit.generation, 1, 'generation travels as authority, never by mutating original bytes');
    await receive({ completed: true }); return { completed: true };
  });
  await assert.rejects(withAgentTransfer({ ...options, payload: { ...renewed,
    permit: { ...renewed.permit, stepId: randomUUID() } } }, async () => null), { code: 'identity-conflict' });
  assert.equal((await agentTransferEntries(options.root)).length, 1);
});
