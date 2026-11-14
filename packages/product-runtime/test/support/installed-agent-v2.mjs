import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';

export const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
  postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
export const versionHeaders = route => /^agent-(sessions|sources)(\/|$|\?)/.test(route) ? { 'x-xj-agent-contract': '2' } : {};
export function question(activity, session, text, requestId = randomUUID(), extra = {}) {
  return { requestId, sessionId: session.sessionId, text, mode: 'steering', context: { action: {
    requestId, receiver: { receiverId: 'agent-session:' + session.sessionId, kind: 'question', location: 'remote' },
    scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
      principalId: activity.identity.principalId, activityId: activity.activityId },
    draft: { token: randomUUID(), question: text, references: [], bases: [] }, works: [], evidence: [], ...extra,
  } } };
}
export async function until(check, description, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(description);
}
export async function completed(api, sessionId, runId) {
  return until(async () => {
    const conversation = await api(`agent-sessions/${sessionId}/conversation`);
    const run = conversation.runs.find(item => item.runId === runId);
    if (!run || !['completed', 'failed', 'paused', 'stopped'].includes(run.state)) return null;
    assert.equal(run.state, 'completed', JSON.stringify(conversation)); return conversation;
  }, 'The original v2 Run did not finish.');
}
export async function bindIndependent({ school, agent, schoolState, agentState, dependencyConnectionId, agentConnectionId, identity, api, admin }) {
  const data = schoolState.environment.services.find(item => item.unit === 'learning-data');
  const service = agentState.environment.services.find(item => item.unit === 'teaching-agent');
  assert.ok(service.capabilities.includes('agent.sessions.v2'));
  assert.ok(data.capabilities.includes('agent.dependencies.v2'));
  const sessionGrant = await agent.authorize({ sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
    sourceInstallationId: schoolState.environment.installationId, capabilities: ['agent.sessions.v2'] }, service.serviceId);
  await school.connect({ connectionId: agentConnectionId, sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
    target: service, requiredCapabilities: ['agent.sessions.v2'], optionalCapabilities: [], credentialRef: 'remote-agent-v2' }, sessionGrant.token);
  await api('manage/agent-binding', { requestId: randomUUID(), identity, connectionId: agentConnectionId,
    target: service, installationId: agentState.environment.installationId }, admin);
  const dependencyGrant = await school.authorize({ sourceEnvironmentId: service.environmentId, sourceServiceId: service.serviceId,
    sourceInstallationId: agentState.environment.installationId, capabilities: ['agent.dependencies.v2'] }, data.serviceId);
  await agent.connect({ connectionId: dependencyConnectionId, sourceEnvironmentId: service.environmentId, sourceServiceId: service.serviceId,
    target: data, requiredCapabilities: ['agent.dependencies.v2'], optionalCapabilities: [], credentialRef: 'agent-dependencies-v2' }, dependencyGrant.token);
  return { data, service, sessionGrant, dependencyGrant };
}
export async function installedIndependent(t, reply, beforeStop = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'installed-agent-v2-'));
  const school = openProductRuntime({ root: join(root, 'school'), resources }), agent = openProductRuntime({ root: join(root, 'agent'), resources });
  const requests = [], requestTimes = [];
  const upstream = createServer((request, response) => { void (async () => {
    const parts = []; for await (const part of request) parts.push(part);
    const payload = JSON.parse(Buffer.concat(parts)); requests.push(payload); requestTimes.push(Date.now()); await reply(payload, response, requests.length);
  })().catch(error => response.destroy(error)); });
  t.after(async () => { await beforeStop(); await Promise.allSettled([agent.stop(), school.stop()]); upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dependencyConnectionId = randomUUID(), agentConnectionId = randomUUID();
  await school.install({ profile: 'local' });
  await agent.install({ profile: 'agent', agent: { dependencyConnectionId } });
  let schoolState = await school.start(), agentState = await agent.start();
  const api = async (route, body, headers = {}, expected = 200) => {
    const response = await fetch(schoolState.endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json',
      'x-xj-space': 'personal', ...versionHeaders(route), ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expected, route + ': ' + JSON.stringify(value)); return value;
  };
  const admin = { authorization: 'Bearer ' + await resolveCredential(join(root, 'school'), 'control') };
  async function bind(identity) { return bindIndependent({ school, agent, schoolState, agentState, dependencyConnectionId, agentConnectionId, identity, api, admin }); }
  async function model(modelId = 'fixture') {
    const connectionId = randomUUID(), grantId = randomUUID();
    await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Native v2 fixture',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId,
      dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 1024,
      credential: { action: 'replace', value: 'synthetic-v2-key' } });
    await api('models/grants', { requestId: randomUUID(), connectionId, grantId, owner: 'self' });
    await api('models/selection', { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
    return { connectionId, grantId };
  }
  return { root, school, agent, api, bind, model, requests, requestTimes, admin,
    get schoolState() { return schoolState; }, get agentState() { return agentState; },
    async restartAgent() { await agent.stop(); agentState = await agent.start(); },
    async restartSchool() { await school.stop(); schoolState = await school.start(); },
    async recoverAgent() { agentState = await agent.start(); },
  };
}
export function answer(response, text, tool) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: tool ? { content: '', tool_calls: [{ index: 0,
    id: 'call-' + randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content: text },
    finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }) + '\n\ndata: [DONE]\n\n');
}
