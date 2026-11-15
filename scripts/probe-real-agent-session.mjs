// Real external model end-to-end acceptance: a personal local installation runs
// the full v3 agent session loop against the real DeepSeek gateway. Credentials
// come from an authorized private file or DEEPSEEK_API_KEY and never enter the
// report, the repository or any log.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';

const { values } = parseArgs({ options: { 'credentials-file': { type: 'string' }, out: { type: 'string' } } });
if (!values.out || !process.env.XUNJIE_PRODUCT_POSTGRES_BIN) throw new Error('Requires --out and native PostgreSQL.');
let apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey && values['credentials-file']) {
  const text = (await readFile(resolve(values['credentials-file']), 'utf8')).replace(/^\uFEFF/, '');
  apiKey = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(text)?.[1] ?? /sk-[A-Za-z0-9]{20,}/.exec(text)?.[0];
}
if (!apiKey) throw new Error('Missing DeepSeek credential (DEEPSEEK_API_KEY or --credentials-file).');

const model = process.env.XUNJIE_REAL_MODEL ?? 'deepseek-chat';
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
  webRoot: fileURLToPath(new URL('../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
const report = { measuredAt: new Date().toISOString(), realProvider: 'deepseek', model, modelRequests: 0, limits: { maxOutputTokens: 512, timeoutMs: 120000 }, results: [] };
const root = await mkdtemp(join(tmpdir(), 'xj-real-agent-'));
const runtime = openProductRuntime({ root, resources });
try {
  await runtime.install({ profile: 'local' });
  const { endpoint } = await runtime.start();
  const api = async (route, body) => {
    const response = await fetch(endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json',
      'x-xj-space': 'personal', ...( /^agent-sessions/.test(route) ? { 'x-xj-agent-contract': '3' } : {}) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw new Error(route + ' ' + response.status + ': ' + JSON.stringify(value));
    return value;
  };
  // A personal local installation: personal-space identity, no school.
  const connectionId = randomUUID();
  await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'DeepSeek 真实验收',
    protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com/v1', path: '/chat/completions', modelId: model,
    dialect: 'deepseek', parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 2048,
    credential: { action: 'replace', value: apiKey } });
  await api('models/selection', { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, owner: 'self' } });
  // The original upstream request count is observable through the gateway's own attempt facts.
  const attemptsOf = async turnId => (await api(`agent-sessions/${session.sessionId}/snapshots/${turnId}`)).attempts;
  const session = await api('agent-sessions', { requestId: randomUUID(), sessionId: randomUUID(),
    scenario: 'student-assistant', title: '真实模型端到端' });
  const ask = async text => {
    const input = { requestId: randomUUID(), sessionId: session.sessionId, text, context: {} };
    const receipt = await api(`agent-sessions/${session.sessionId}/inputs`, input);
    for (let tries = 0; tries < 240; tries++) {
      const conversation = await api(`agent-sessions/${session.sessionId}/conversation`);
      const turn = conversation.turns.find(item => item.turnId === receipt.turnId);
      if (turn && ['completed', 'failed', 'interrupted', 'stopped'].includes(turn.state)) {
        assert.equal(turn.state, 'completed', JSON.stringify(conversation));
        return { receipt, conversation };
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Real model turn did not finish in the bounded window.');
  };
  const first = await ask('请用一句话介绍递归的基本思想，不超过40个字。');
  const answer1 = first.conversation.messages.filter(item => item.role === 'assistant').at(-1).text;
  report.results.push({ name: 'plain-question-answer', answerLength: answer1.length, answer: answer1.slice(0, 120) });
  const attempts1 = await attemptsOf(first.receipt.turnId);
  assert.equal(attempts1.filter(attempt => attempt.state === 'completed').length, 1);
  report.modelRequests += attempts1.length;
  report.results[0].usage = attempts1.at(-1).usage;
  // A second turn exercises the real segment continuation with the previous native response paired.
  const second = await ask('再用不超过30个字给出一个日常例子。');
  const answer2 = second.conversation.messages.filter(item => item.role === 'assistant').at(-1).text;
  report.results.push({ name: 'segment-continuation', answerLength: answer2.length, answer: answer2.slice(0, 120) });
  const attempts2 = await attemptsOf(second.receipt.turnId);
  report.modelRequests += attempts2.length;
  report.results[1].usage = attempts2.at(-1).usage;
  report.passed = true;
} catch (error) {
  report.error = String(error.message ?? error).slice(0, 400);
  report.passed = false;
} finally {
  await runtime.stop().catch(() => {});
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await mkdir(dirname(resolve(values.out)), { recursive: true });
  await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
