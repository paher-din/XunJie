import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCredential, openProductRuntime } from '@xunjie/product-runtime';
import { createLearningEntry } from '@xunjie/product-runtime/learning-http';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fixture, reply, until } from './support/session-product.mjs';

const payload = () => ({ html: '<label>我的解释<textarea></textarea></label>', title: '原解释卡', display: 'card',
  formatVersion: 1, hostApiVersion: 1, css: '', javascript: '', stateVersion: 1,
  stateShape: { type: 'object', properties: { answer: { type: 'string', maxLength: 1000 } } },
  initialState: { answer: '原来的解释继续保留' }, semanticFields: [{ key: 'answer', meaning: '学生对变化的解释' }],
  semanticObjects: [], requiredCapabilities: ['workspace.read', 'workspace.change'] });

async function checked(api, route, published) {
  const revision = await api(`${route}/${published.artifactId}/revisions/${published.revisionId}`);
  await api(`${route}/check`, { requestId: randomUUID(), candidateId: published.candidateId,
    revisionId: published.revisionId, resourceSha256: revision.sha256, load: true, stateRoundtrip: true });
  return revision;
}

function adoption(candidate, activeRevision, work) {
  return { requestId: randomUUID(), candidateId: candidate.candidateId, expectedRevisionId: activeRevision,
    expectedWorkRevision: work.revision, expectedContentId: work.files.find(file =>
      file.name === `components/artifact-${candidate.artifactId}.json`)?.contentId ?? null };
}

async function independentAgent(f, activity) {
  const root = await mkdtemp(join(tmpdir(), 'xj-artifact-stop-agent-'));
  const source = openProductRuntime({ root, resources: f.resources });
  const close = async () => { await source.stop(); await rm(root, { recursive: true, force: true }); };
  try {
    const environment = (await f.runtime.status()).environment;
    const data = environment.services.find(service => service.unit === 'learning-data');
    const dependencyConnectionId = randomUUID(), agentConnectionId = randomUUID();
    await source.install({ profile: 'agent', agent: { dependencyConnectionId } });
    const remote = await source.start(), agent = remote.environment.services.find(service => service.unit === 'teaching-agent');
    const inbound = await source.authorize({ sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
      sourceInstallationId: environment.installationId, capabilities: ['agent.sessions.v2'] }, agent.serviceId);
    await f.runtime.connect({ connectionId: agentConnectionId, sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
      target: agent, requiredCapabilities: ['agent.sessions.v2'], optionalCapabilities: [], credentialRef: 'artifact-stop-agent' }, inbound.token);
    await f.api('manage/agent-binding', { requestId: randomUUID(), identity: activity.identity, connectionId: agentConnectionId,
      target: agent, installationId: remote.environment.installationId }, { authorization: 'Bearer ' + await resolveCredential(f.root, 'control') });
    const grant = await f.runtime.authorize({ sourceEnvironmentId: agent.environmentId, sourceServiceId: agent.serviceId,
      sourceInstallationId: remote.environment.installationId, capabilities: ['agent.dependencies.v2'] }, data.serviceId);
    await source.connect({ connectionId: dependencyConnectionId, sourceEnvironmentId: agent.environmentId, sourceServiceId: agent.serviceId,
      target: data, requiredCapabilities: ['agent.dependencies.v2'], optionalCapabilities: [], credentialRef: 'artifact-stop-dependencies' }, grant.token);
    return { close };
  } catch (error) { await close(); throw error; }
}

/** Inspect the original Run; polling never accepts another generation or request identity. */
async function generatedRun(f, sessionId, runId, expectedState, t) {
  const started = Date.now(), deadline = started + 60000;
  let last;
  const transitions = [];
  while (Date.now() < deadline) {
    // Full conversation replay is needed only at the target state, not on every poll.
    const run = await f.api(`agent-sessions/${sessionId}/runs/${runId}`);
    const current = { state: run.state, reason: run.reason, attemptId: run.attemptId, modelCalls: f.payloads.length };
    if (JSON.stringify(current) !== last) { last = JSON.stringify(current); transitions.push({ elapsedMs: Date.now() - started, ...current }); }
    assert.equal(f.failures.length, 0, 'The controlled model must finish its response.');
    assert.ok(!['failed', 'paused', 'stopped'].includes(run.state), 'Unexpected Run terminal: ' + JSON.stringify(transitions));
    assert.ok(f.payloads.length <= 2, 'These fixtures permit exactly two model rounds.');
    if (run.state === expectedState) {
      const conversation = await f.api(`agent-sessions/${sessionId}/conversation`);
      const events = await f.api(`agent-sessions/${sessionId}/events`);
      const generated = events.find(event => event.kind === 'tool-result' && event.body.name === 'generate_teaching_artifact')?.body;
      // A model admission wait is not the student Wait required by these cases.
      if (generated?.outcome.state === 'completed'
        && (expectedState !== 'waiting' || conversation.waits.some(wait => wait.state === 'pending'))) return { ...conversation, publication: generated };
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const snapshot = await f.api(`agent-sessions/${sessionId}/snapshots/${runId}`).catch(() => null);
  t.diagnostic('Operation states: ' + JSON.stringify(snapshot?.steps.map(step => ({ kind: step.operation.kind, state: step.state, result: step.result?.state }))));
  throw new Error('The original Run stopped progressing toward ' + expectedState + ': ' + JSON.stringify(transitions));
}

for (const finalState of ['waiting', 'completed']) test(`a published candidate from a ${finalState} Run can adopt and its receipt survives a later Stop`,
  { timeout: 180000 }, async t => {
    const f = await fixture((_request, response, index) => index === 1
      ? reply(response, { calls: [{ id: 'first-published-card', name: 'generate_teaching_artifact', arguments: {
        ...payload(), artifactId: null, parentRevisionId: null, mapping: [],
      } }] })
      : finalState === 'completed' ? reply(response, { text: '已生成页面。' })
        : reply(response, { calls: [{ id: 'preserved-wait', name: 'student_ask', arguments: {
          question: '如何解释？', source: '当前页面', options: [], allowText: true, skippable: true,
        } }] }));
    let remote;
    try {
      await f.configure();
      const activity = await f.activity('已发布候选的采用资格');
      if (finalState === 'completed') remote = await independentAgent(f, activity);
      const { runId, sessionId } = await f.send(activity, '生成解释卡。');
      const conversation = await generatedRun(f, sessionId, runId, finalState, t);
      const command = conversation.publication;
      assert.equal(command?.outcome.state, 'completed');
      const candidate = command.outcome.result.artifact, route = `artifacts/${activity.activityId}`;
      await checked(f.api, route, candidate);
      const input = adoption(candidate, null, await f.api(`workspaces/${activity.activityId}`));
      const saved = await f.api(`${route}/adopt`, input);
      assert.equal(saved.outcome, 'adopted');
      const work = await f.api(`workspaces/${activity.activityId}`);
      await f.api(`agent-sessions/${sessionId}/runs/${runId}/stop`, { requestId: randomUUID() });
      assert.deepEqual(await f.api(`${route}/adopt`, input), saved);
      assert.deepEqual(await f.api(`${route}/receipts/${input.requestId}`), saved);
      assert.deepEqual(await f.api(`workspaces/${activity.activityId}`), work);
      assert.equal(f.payloads.length, 2);
    } finally { await remote?.close(); await f.close(); }
  });

for (const independent of [false, true]) test(`stopping the original ${independent ? 'independent' : 'local'} Run after its candidate check rejects adoption and preserves original receipts`,
  { timeout: 180000 }, async t => {
    let arguments_;
    const f = await fixture((request, response, index) => {
      if (index === 1) {
        const tool = request.tools.find(tool => tool.function.name === 'generate_teaching_artifact');
        return reply(response, { calls: [{ id: 'revision', name: tool.function.name, arguments: arguments_ }] });
      }
      return reply(response, { calls: [{ id: 'keep-original-run-open', name: 'student_ask', arguments: {
        question: '接下来想比较哪个输入？', source: '当前学习问题', options: [], allowText: true, skippable: true,
      } }] });
    });
    let remote;
    try {
      await f.configure();
      const activity = await f.activity('停止后保留原学习页面'), route = `artifacts/${activity.activityId}`;
      if (independent) remote = await independentAgent(f, activity);
      const original = await f.api(route, { requestId: randomUUID(), payload: payload() });
      await checked(f.api, route, original);
      await f.api(`${route}/adopt`, adoption(original, null, await f.api(`workspaces/${activity.activityId}`)));
      const before = await f.api(`workspaces/${activity.activityId}`);
      arguments_ = { ...payload(), title: '尚未采用的修订', artifactId: original.artifactId,
        parentRevisionId: original.revisionId, mapping: [] };
      const { runId, sessionId } = await f.send(activity, '改善解释卡，然后询问我想比较的输入。');
      const conversation = await generatedRun(f, sessionId, runId, 'waiting', t);
      const command = conversation.publication;
      assert.equal(command?.outcome.state, 'completed');
      const candidate = command.outcome.result.artifact, fixed = await checked(f.api, route, candidate);
      assert.equal(fixed.origin.runId, runId);
      assert.equal(fixed.origin.commandId, command.commandId);
      const input = adoption(candidate, original.revisionId, before);

      const stop = await f.api(`agent-sessions/${sessionId}/runs/${runId}/stop`, { requestId: randomUUID() });
      assert.equal(stop.stopRequested, true);
      const rejected = await f.raw(`${route}/adopt`, input);
      assert.equal(rejected.status, 409, 'A successful earlier check must not authorize adoption after Stop: ' + JSON.stringify(rejected.body));
      assert.equal(rejected.body.error, 'conflict', 'A definitive eligibility conflict lets the browser settle its pending adoption.');
      assert.equal((await f.api(`${route}/${original.artifactId}`)).activeRevisionId, original.revisionId);
      assert.deepEqual(await f.api(`workspaces/${activity.activityId}`), before);
      assert.equal(await f.api(`${route}/receipts/${input.requestId}`), null);
      assert.deepEqual(await f.api(`${route}/receipts/${command.commandId}`), candidate, 'Stop retains the original publication fact.');
      assert.equal((await f.api(`${route}/${candidate.artifactId}/revisions/${candidate.revisionId}`)).origin.runId, runId);
      assert.equal((await f.raw(`${route}/adopt`, { ...input, origin: null })).status, 400, 'The student cannot replace the retained origin.');
      assert.equal((await f.raw(`${route}/adopt`, { ...input, requestId: randomUUID() })).status, 409);
      assert.equal(f.payloads.length, 2, 'Checking and refusing adoption never regenerate the page.');
    } finally { await remote?.close(); await f.close(); }
  });

test('Stop during artifact state upload rejects the later commit through the production HTTP entry',
  { timeout: 180000 }, async () => {
    let arguments_;
    const f = await fixture((_request, response, index) => index === 1
      ? reply(response, { calls: [{ id: 'delayed-revision', name: 'generate_teaching_artifact', arguments: arguments_ }] })
      : reply(response, { calls: [{ id: 'wait-before-adoption', name: 'student_ask', arguments: {
        question: '如何解释变化？', source: '当前页面', options: [], allowText: true, skippable: true,
      } }] }));
    let server, release = () => {}, pending;
    try {
      const activity = await f.activity('保存等待时停止采用');
      const env = JSON.parse(await readFile(join(f.root, 'environment.json'), 'utf8'));
      let armed = false, waiting = false;
      const held = new Promise(done => { release = done; });
      const c = await f.controlled(activity, { async stageResource(input, stage) {
        if (armed && input.scope.startsWith('works/')) { armed = false; waiting = true; await held; }
        return stage(input);
      } });
      const sessionId = c.session.sessionId;
      const entry = createLearningEntry({ environment: env, target: activity.target, spaces: c.spaces, learning: c.learning,
        courses: c.courses, agentSessions: async () => c.sessionHttp, assertAgentCommand: c.authority.assertDispatch, administratorToken: randomUUID() });
      server = createServer((request, response) => { void entry(request, response); });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      const raw = async (route, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/learning/${route}`, {
          headers: { 'content-type': 'application/json', 'x-xj-space': 'personal', 'x-xj-agent-contract': '2' },
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
      };
      const api = async (route, body) => { const result = await raw(route, body);
        assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body)); return result.body; };
      const route = `artifacts/${activity.activityId}`;
      const original = await api(route, { requestId: randomUUID(), payload: payload() });
      await checked(api, route, original);
      await api(`${route}/adopt`, adoption(original, null, await api(`workspaces/${activity.activityId}`)));
      const before = await api(`workspaces/${activity.activityId}`);
      arguments_ = { ...payload(), title: '正在保存的新版', artifactId: original.artifactId,
        parentRevisionId: original.revisionId, mapping: [] };
      const { runId } = await c.send('改善页面并询问我的理解。');
      const conversation = await until(async () => { const value = await api(`agent-sessions/${sessionId}/conversation`);
        if (value.runs.find(run => run.runId === runId)?.state !== 'waiting') return null;
        const events = await api(`agent-sessions/${sessionId}/events`);
        return { ...value, publication: events.find(event => event.kind === 'tool-result' && event.body.name === 'generate_teaching_artifact')?.body };
      }, 'The independent owner must publish and wait.');
      const command = conversation.publication;
      assert.equal(command?.outcome.state, 'completed');
      const candidate = command.outcome.result.artifact;
      await checked(api, route, candidate);
      const input = adoption(candidate, original.revisionId, before);
      armed = true; pending = raw(`${route}/adopt`, input);
      await until(() => waiting, 'The real state resource upload must reach the held boundary.');
      const stopped = await api(`agent-sessions/${sessionId}/runs/${runId}/stop`, { requestId: randomUUID() });
      assert.equal(stopped.stopRequested, true);
      release();
      const rejected = await pending;
      assert.equal(rejected.status, 409, 'The earlier admission cannot survive Stop while state upload waits: ' + JSON.stringify(rejected.body));
      assert.equal(rejected.body.error, 'conflict');
      assert.deepEqual(await api(`workspaces/${activity.activityId}`), before);
      assert.equal((await api(`${route}/${original.artifactId}`)).activeRevisionId, original.revisionId);
      assert.equal(await api(`${route}/receipts/${input.requestId}`), null);
      assert.deepEqual(await api(`${route}/receipts/${command.commandId}`), candidate);
      assert.equal(f.payloads.length, 2);
    } finally {
      release(); await pending?.catch(() => {});
      server?.closeAllConnections(); if (server) await new Promise(done => server.close(done));
      await f.close();
    }
  });
