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
  'provider-address': { type: 'string' }, protocol: { type: 'string' }, 'student-ask': { type: 'boolean', default: false } } });
if (!values['credentials-file'] || !values.out || !process.env.XUNJIE_PRODUCT_POSTGRES_BIN)
  throw new Error('Requires an authorized private provider file, --out and native PostgreSQL.');
if (values['provider-address'] && !net.isIP(values['provider-address'])) throw new Error('--provider-address must be an IP address.');
const supportedProtocols = ['chat-completions', 'responses', 'messages'];
if (values.protocol && !supportedProtocols.includes(values.protocol)) throw new Error('Unsupported --protocol.');
const protocols = values.protocol ? [values.protocol] : supportedProtocols;
const privateText = (await readFile(resolve(values['credentials-file']), 'utf8')).replace(/^\uFEFF/, '');
let provider;
try {
  const document = JSON.parse(privateText);
  provider = document.providers?.find(item => /deepseek/i.test(item.preset ?? item.name ?? '') && item.key);
} catch {
  const line = privateText.split(/\r?\n/).find(line => /deepseek/i.test(line));
  const key = line?.match(/\bsk-[A-Za-z0-9_-]{8,}/)?.[0];
  if (key) provider = { key };
}
if (!provider) throw new Error('Authorized provider not found.');
const report = { measuredAt: new Date().toISOString(), model: 'deepseek-flash',
  capability: values['student-ask'] ? 'student.ask' : 'read_work',
  limits: { maxGenerations: protocols.length * 2, maxPerProtocol: 2, maxOutputTokens: 2048, timeoutMs: 30000, retries: 0 },
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
  upstream.on('error', error => {
    item.elapsedMs = Date.now() - started;
    // Record only known network classifications, never upstream error text or credentials.
    item.connectionError = ['SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(error.code) ? error.code : 'upstream-connection';
    if (!response.headersSent) response.writeHead(502); response.end();
  });
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
  for (const protocol of protocols) {
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
      const activity = await api('activities', { requestId: randomUUID(), goal: values['student-ask'] ? '依据明确预测解释四态累加' : '核对固定资料与实际工具来源', question: '', references: [] });
      const receiver = (await api(`agent/${activity.activityId}/capabilities`)).receiver;
      const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'observation.txt', kind: 'text', encoding: 'utf8',
        mediaType: 'text/plain', value: '本次实际记录：水位从 12 cm 增加到 37 cm。此文件是固定观测材料，不是学生掌握程度的证明。' };
      const input = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId }, receiver,
        draft: { token: randomUUID(), question: values['student-ask']
          ? '先实际调用 student_ask 工具，只问一个关于“状态 3 加输入 2 后对 4 取余”的预测问题。给出简明来源，允许自由文字，可提供选项；不要把问题只作为普通文字输出。等我明确回应后，依据那份回应简短解释并结束。只提问一次，不读取作品或调用其他工具，不要求任何内部标识。'
          : `请先实际调用 read_work 工具读取 objectId=${work.objectId}、contentId=${work.contentId}，
然后根据工具结果简短解释水位变化。必须先读取工具；不要再调用其他工具，不要修改作品。`, references: [], bases: [] }, works: values['student-ask'] ? [] : [work], evidence: [] };
      await api('intents/' + activity.activityId, input);
      const receipt = await api(`intents/${activity.activityId}/${input.requestId}/dispatch`, {});
      assert.equal(receipt.state, 'accepted');
      const runId = JSON.parse(receipt.receipt.detail).runId;
      let conversation;
      let explicitResponse;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        conversation = await api(`agent/${activity.activityId}/conversation`);
        if (values['student-ask'] && !explicitResponse) {
          const question = conversation.questions?.find(question => question.runId === runId && question.state === 'pending');
          if (question) {
            item.question = { version: question.version, waitVersion: question.waitVersion, question: question.question,
              source: question.source.detail, presentedAt: question.presentedAt, skippable: question.skippable };
            assert.equal(question.presentedAt, null, 'API-only history must not manufacture a display acknowledgement.');
            const responseInput = { requestId: randomUUID(), questionVersion: question.version, waitVersion: question.waitVersion,
              answer: question.allowText ? { kind: 'text', text: '我预计为 1；先算 3 加 2 得到 5，再对 4 取余。请核对我的推理。' }
                : { kind: 'choice', optionId: question.options[0].id } };
            const route = `agent/${activity.activityId}/questions/${question.questionId}/responses`;
            const accepted = await api(route, responseInput);
            assert.equal(accepted.status, 'accepted');
            assert.deepEqual(await api(route, responseInput), accepted);
            assert.deepEqual(await api(`agent/${activity.activityId}/responses/${responseInput.requestId}`), accepted);
            explicitResponse = responseInput;
          }
        }
        if (['completed', 'failed', 'paused', 'stopped'].includes(conversation.runs.find(run => run.runId === runId)?.state)) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const run = conversation.runs.find(run => run.runId === runId);
      item.state = run?.state; item.reason = run?.reason; item.usage = run?.usage;
      item.tools = conversation.tools.map(tool => ({ name: tool.name, outcome: tool.outcome }));
      const answer = conversation.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n');
      item.answerSha256 = createHash('sha256').update(answer).digest('hex');
      assert.equal(run?.state, 'completed');
      if (values['student-ask']) {
        assert.ok(explicitResponse, 'The real model must actually use student.ask.');
        assert.equal(conversation.questions.filter(question => question.runId === runId).length, 1);
        const events = await api(`agent/${activity.activityId}/events`);
        const snapshots = await Promise.all(events.filter(event => event.kind === 'context-assembled')
          .map(event => api(`agent/${activity.activityId}/snapshots/${event.body.snapshotId}`)));
        item.responseAdopted = snapshots.some(snapshot => snapshot.sources.some(source => source.kind === 'student-response' && source.id === explicitResponse.requestId)
          && JSON.stringify(snapshot.payload).includes('student-response'));
        assert.ok(item.responseAdopted);
        item.snapshotDigests = snapshots.map(snapshot => snapshot.payloadSha256);
        assert.ok(answer.trim());
        const beforeHistory = generations;
        await api(`agent/${activity.activityId}/conversation`); await api(`agent/${activity.activityId}/conversation`);
        assert.equal(generations, beforeHistory);
      } else {
        assert.ok(conversation.tools.some(tool => tool.name === 'read_work' && tool.outcome === 'completed'));
        assert.match(answer, /25|二十五/);
      }
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
if (report.results.length !== protocols.length || report.results.some(item => !item.passed)) process.exitCode = 1;
