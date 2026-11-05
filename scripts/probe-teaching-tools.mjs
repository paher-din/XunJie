// Explicit, bounded real-provider acceptance of the production learning tool loop.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime';

const { values } = parseArgs({ options: { 'credentials-file': { type: 'string' }, out: { type: 'string' },
  'provider-address': { type: 'string' } } });
if (!values['credentials-file'] || !values.out || !process.env.XUNJIE_PRODUCT_POSTGRES_BIN)
  throw new Error('Requires an authorized private provider file, --out and native PostgreSQL.');
if (values['provider-address'] && !net.isIP(values['provider-address'])) throw new Error('--provider-address must be an IP address.');
const document = JSON.parse(await readFile(resolve(values['credentials-file']), 'utf8'));
const provider = document.providers?.find(item => /deepseek/i.test(item.preset ?? item.name ?? '') && item.key);
if (!provider) throw new Error('Authorized provider not found.');
const report = { measuredAt: new Date().toISOString(), model: 'deepseek-flash',
  limits: { maxGenerations: 6, maxPerProtocol: 2, maxOutputTokens: 2048, timeoutMs: 30000, retries: 0 },
  transport: values['provider-address'] ? 'loopback relay with TLS hostname verification and explicitly resolved provider address' : 'loopback relay with system DNS',
  results: [] };
let generations = 0;
const byPath = new Map(), observed = [];
const relay = createServer(async (request, response) => {
  const path = request.url;
  const allowed = ['/v1/chat/completions', '/v1/responses', '/anthropic/v1/messages'];
  if (!allowed.includes(path) || request.method !== 'POST' || generations >= report.limits.maxGenerations
    || (byPath.get(path) ?? 0) >= report.limits.maxPerProtocol) {
    response.writeHead(429, { 'content-type': 'application/json' }); response.end('{"error":{"message":"probe generation limit"}}'); return;
  }
  generations++; byPath.set(path, (byPath.get(path) ?? 0) + 1);
  const item = { path, status: null, elapsedMs: 0 }; observed.push(item);
  const started = Date.now();
  const upstream = https.request({ hostname: 'api.deepseek.com', servername: 'api.deepseek.com', path, method: 'POST',
    headers: { ...request.headers, host: 'api.deepseek.com' }, timeout: report.limits.timeoutMs,
    ...(values['provider-address'] ? { lookup: (_host, _options, callback) => callback(null,
      [{ address: values['provider-address'], family: net.isIP(values['provider-address']) }]) } : {}),
  }, result => {
    item.status = result.statusCode;
    response.writeHead(result.statusCode, result.headers);
    result.pipe(response); result.on('end', () => { item.elapsedMs = Date.now() - started; });
  });
  upstream.on('timeout', () => upstream.destroy(new Error('probe-timeout')));
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
});
await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
const root = await mkdtemp(join(tmpdir(), 'xj-teaching-real-'));
const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6', webRoot: resolve('apps/web/dist-runtime'),
  windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') } });
let host;
try {
  await runtime.install({ profile: 'local' });
  host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication });
  const api = async (route, body) => {
    const response = await fetch(host.endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json(); if (!response.ok) throw new Error('Production boundary: ' + response.status + ':' + value.error); return value;
  };
  let selectionVersion = 0;
  for (const protocol of ['chat-completions', 'responses', 'messages']) {
    const item = { protocol, sdk: protocol === 'messages' ? '@anthropic-ai/sdk@1.1.0' : 'openai@7.42.0',
      passed: false, state: null, reason: null, modelRequests: 0, tools: [], usage: null, answerSha256: null };
    report.results.push(item);
    const before = generations;
    try {
      const connectionId = randomUUID(), grantId = randomUUID();
      const prefix = protocol === 'messages' ? '/anthropic' : '/v1';
      const path = protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions';
      await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'WP07 real tool acceptance',
        protocol, baseUrl: `http://127.0.0.1:${relay.address().port}${prefix}`, path, modelId: report.model, dialect: 'deepseek',
        parameterMode: 'thinking', enabled: true, contextWindow: 262144, maxOutputTokens: report.limits.maxOutputTokens,
        credential: { action: 'replace', value: provider.key } });
      await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
      const selection = await api('models/selection', { requestId: randomUUID(), expectedVersion: selectionVersion,
        source: { kind: 'personal', connectionId, grantId } }); selectionVersion = selection.version;
      const activity = await api('activities', { requestId: randomUUID(), goal: '核对固定资料与实际工具来源', question: '', references: [] });
      const receiver = (await api(`agent/${activity.activityId}/capabilities`)).receiver;
      const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'observation.txt', kind: 'text', encoding: 'utf8',
        mediaType: 'text/plain', value: '本次实际记录：水位从 12 cm 增加到 37 cm。此文件是固定观测材料，不是学生掌握程度的证明。' };
      const input = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId }, receiver,
        draft: { token: randomUUID(), question: `请先实际调用 read_work 工具读取 objectId=${work.objectId}、contentId=${work.contentId}，
然后根据工具结果简短解释水位变化。必须先读取工具；不要再调用其他工具，不要修改作品。`, references: [], bases: [] }, works: [work], evidence: [] };
      await api('intents/' + activity.activityId, input);
      const receipt = await api(`intents/${activity.activityId}/${input.requestId}/dispatch`, {});
      assert.equal(receipt.state, 'accepted');
      const runId = JSON.parse(receipt.receipt.detail).runId;
      let conversation;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        conversation = await api(`agent/${activity.activityId}/conversation`);
        if (['completed', 'failed', 'paused', 'stopped'].includes(conversation.runs.find(run => run.runId === runId)?.state)) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const run = conversation.runs.find(run => run.runId === runId);
      item.state = run?.state; item.reason = run?.reason; item.usage = run?.usage;
      item.tools = conversation.tools.map(tool => ({ name: tool.name, outcome: tool.outcome }));
      const answer = conversation.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n');
      item.answerSha256 = createHash('sha256').update(answer).digest('hex');
      assert.equal(run?.state, 'completed');
      assert.ok(conversation.tools.some(tool => tool.name === 'read_work' && tool.outcome === 'completed'));
      assert.match(answer, /25|二十五/);
      item.passed = true;
    } catch (error) { item.reason ??= error instanceof assert.AssertionError ? 'acceptance-assertion' : error.message; }
    item.modelRequests = generations - before;
  }
} finally {
  report.generations = generations; report.requests = observed;
  await mkdir(dirname(resolve(values.out)), { recursive: true });
  await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + '\n');
  await host?.stop(); await runtime.stop(); relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(JSON.stringify(report));
if (report.results.length !== 3 || report.results.some(item => !item.passed)) process.exitCode = 1;
