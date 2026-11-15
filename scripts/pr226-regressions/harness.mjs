import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage } from '../../packages/storage/dist/index.js';
import { nativeFixture } from '../../packages/storage/test/native-fixture.mjs';
import { createAgentRuntime, agentRuntimeMigrations } from '../../packages/agent-runtime/dist/index.js';

const connection = { routeId: randomUUID(), version: 1, maxOutputTokens: 4096, contextWindow: 1_000_000,
  protocol: 'openai-chat', parameterMode: 'plain', capabilities: {}, hasCredential: true, adapterState: 'ready' };
/** A scripted Gateway: each dispatch returns the next queued response. */
function mockGateway(responses, faults = {}) {
  const queue = [...responses];
  const segments = new Map();
  const attempts = new Map();
  const settles = [];
  let sequence = 0;
  const segment = (segmentId, seq) => ({ sessionId: undefined, segmentId, formatVersion: 1, sequence: seq,
    connection, prefixDigest: '0'.repeat(64), resultRef: null, pending: false, closed: false, pendingTools: [] });
  return {
    calls: { dispatched: [] }, settles,
    selection: {
      read: async () => ({ selected: true, version: 1 }),
      snapshot: async () => ({ choice: { connection }, source: { kind: 'personal', ownerScope: 's', feeSource: 'f' } }),
      pin: async () => ({ choice: { connection }, source: { kind: 'personal', ownerScope: 's', feeSource: 'f' } }),
      pinSource: async () => ({}), pinned: async () => ({}), resolveChoice: async () => ({}),
    },
    segments: {
      create: async (_identity, input) => { const s = segment(input.segmentId, sequence); segments.set(input.segmentId, s); return s; },
      read: async (_identity, segmentId) => segments.get(segmentId),
      settle: async (_identity, segmentId, input) => { settles.push(input); const s = segments.get(segmentId); s.sequence = input.expectedSequence + 1; s.pendingTools = []; return s; },
      close: async (_identity, segmentId) => { const s = segments.get(segmentId); s.closed = true; return { ...s, boundary: { owner: { environmentId: 'e', serviceId: 's' }, segmentId, sequence: s.sequence, routeId: connection.routeId, resultRef: null } }; },
    },
    checks: {
      receive: async (_identity, input) => { const a = { attemptId: input.attemptId, state: 'accepted', physicalRequestEnded: false, dispatched: false, cancelRequested: false, text: '', usage: { state: 'unknown' }, requestRef: randomUUID(), resultRef: null, reason: '', upstreamStopped: 'unknown', createdAt: new Date().toISOString(), purpose: 'learning', connection, limits: input.limits }; attempts.set(input.attemptId, a); return a; },
      dispatch: async (_identity, attemptId) => { const a = attempts.get(attemptId);
        if (faults.dispatchFailures) { faults.dispatchFailures--; throw new Error('temporarily unavailable'); }
        const r = queue.shift() ?? { text: '完成', toolIntents: [] };
        if (r.unknown) { Object.assign(a, { state: 'unknown', physicalRequestEnded: false, dispatched: true, text: '', toolIntents: [],
          usage: { state: 'unknown' }, resultRef: null }); return a; }
        Object.assign(a, { state: 'completed', physicalRequestEnded: true, dispatched: true, text: r.text, toolIntents: r.toolIntents ?? [], usage: { state: 'final', inputTokens: 10, outputTokens: 5 }, resultRef: randomUUID(), segment: { segmentId: r.segmentId ?? [...segments.keys()][0], sequence: 0 } });
        return a; },
      read: async (_identity, attemptId) => attempts.get(attemptId),
      progress: async () => null, summary: async () => null, requestPayload: async () => ({}),
      cancel: async (_identity, attemptId) => attempts.get(attemptId),
    },
    results: { retain: async () => null },
    images: { upload: async () => ({}), read: async () => ({}) },
  };
}
function echoTool(name = 'echo') {
  return { definition: { name, description: '回显', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
    supportsBackground: false,
    async execute(call) { return { kind: 'completed', outcome: 'success', summary: 'echo:' + (call.input.value ?? '') }; } };
}
function scenario(tools) {
  return { id: 'test', version: 1,
    async context() { return { system: '测试助手', facts: {}, sources: [] }; },
    async tools() { return tools; } };
}
async function harness(responses, tools = [echoTool()], faults = {}, options = {}) {
  const postgres = await nativeFixture();
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: postgres.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
  const backend = createFileBackend({ id: 'agent', root: join(postgres.root, 'res') });
  const storage = await openStorage({ binding, migrations: agentRuntimeMigrations, backend });
  const gateway = mockGateway(responses, faults);
  const runtime = createAgentRuntime(storage, { authorize: async () => {}, scenario: scenario(tools), gateway, ...options });
  const identity = { kind: 'personal', name: '学生', environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID() };
  const session = { sessionId: randomUUID(), identity, scenario: 'test', createdAt: new Date().toISOString() };
  await runtime.initialize(session);
  const settle = async () => { await runtime.drain(); };
  return { postgres, storage, runtime, gateway, identity, session, settle, binding, backend,
    async close() { await runtime.close(); await storage.close(); await postgres.close(); } };
}
const input = (sessionId, text) => ({ requestId: randomUUID(), sessionId, text, context: {} });


export { mockGateway, echoTool, scenario, harness, input, connection };
export async function waitFor(fn, timeoutMs=3000) { const deadline=Date.now()+timeoutMs; do { const result=await fn(); if(result) return result; await new Promise(r=>setTimeout(r,5)); } while(Date.now()<deadline); throw Error('waitFor timed out'); }
