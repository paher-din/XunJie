// Bounded acceptance of the installed school/device model-owner boundary. This is
// model transport acceptance, separate from Teaching RunDriver/Chrome acceptance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'node:http';
import https from 'node:https';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';

const { values } = parseArgs({ options: { 'credentials-file': { type: 'string' }, out: { type: 'string' },
  synthetic: { type: 'boolean', default: false } } });
if (!values.out || !process.env.XUNJIE_PRODUCT_POSTGRES_BIN || (!values.synthetic && !values['credentials-file']))
  throw new Error('Requires --out, native PostgreSQL and an authorized private credentials file.');
const key = values.synthetic ? 'synthetic-owner-key' : JSON.parse((await readFile(resolve(values['credentials-file']), 'utf8')).replace(/^\uFEFF/, ''))
  .providers?.find(provider => /deepseek/i.test(provider.name ?? provider.preset ?? '') && provider.key)?.key;
if (!key) throw new Error('Missing DeepSeek private entry.');
const protocols = ['chat-completions', 'responses', 'messages'];
const paths = ['/v1/chat/completions', '/v1/responses', '/anthropic/v1/messages'];
const report = { measuredAt: new Date().toISOString(), realProvider: !values.synthetic, model: 'deepseek-flash',
  scope: 'installed school/device model owners and portable boundaries; not Teaching RunDriver',
  limits: { maxGenerations: 6, perProtocol: 2, maxOutputTokens: 2048, timeoutMs: 30000, retries: 0 }, requests: [], results: [] };
let generations = 0;
const relay = createServer(async (request, response) => {
  const index = paths.indexOf(request.url);
  if (request.method !== 'POST' || index < 0 || generations >= 6 || report.requests.filter(item => item.path === request.url).length >= 2) {
    response.writeHead(429); response.end(); return;
  }
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const bytes = Buffer.concat(chunks), body = JSON.parse(bytes);
  const output = body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens;
  if (!Number.isInteger(output) || output > 2048 || output < 1) { response.writeHead(400); response.end(); return; }
  const item = { path: request.url, status: null, elapsedMs: null }; report.requests.push(item); generations++;
  const started = Date.now();
  if (values.synthetic) {
    item.status = 200; response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = event => response.write((event.type ? 'event: ' + event.type + '\n' : '') + 'data: ' + JSON.stringify(event) + '\n\n');
    if (index === 0) {
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: '25' }, finish_reason: 'stop' }] });
      send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } }); response.write('data: [DONE]\n\n');
    } else if (index === 1) send({ type: 'response.completed', response: { id: 'resp-' + generations, object: 'response', status: 'completed',
      output: [{ id: 'msg-' + generations, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '25', annotations: [] }] }],
      usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } } });
    else {
      send({ type: 'message_start', message: { id: 'msg-' + generations, type: 'message', role: 'assistant', model: report.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '25' } });
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
      send({ type: 'message_stop' });
    }
    item.elapsedMs = Date.now() - started; response.end(); return;
  }
  const upstream = https.request({ hostname: 'api.deepseek.com', servername: 'api.deepseek.com', path: request.url, method: 'POST',
    headers: { ...request.headers, host: 'api.deepseek.com' }, timeout: 30000 }, result => {
    item.status = result.statusCode; response.writeHead(result.statusCode, result.headers); result.pipe(response);
    result.on('end', () => { item.elapsedMs = Date.now() - started; });
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { item.elapsedMs = Date.now() - started; item.networkFailure = true;
    if (!response.headersSent) response.writeHead(502); response.end(); });
  response.on('close', () => upstream.destroy()); upstream.end(bytes);
});
await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
const roots = [await mkdtemp(join(tmpdir(), 'xj201-school-')), await mkdtemp(join(tmpdir(), 'xj201-device-'))];
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, webRoot: resolve('apps/web/dist-runtime'),
  windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') };
const school = openProductRuntime({ root: roots[0], resources }), device = openProductRuntime({ root: roots[1], resources });
try {
  await school.install({ profile: 'school' }); const ss = await school.start();
  await device.install({ profile: 'local' }); let ds = await device.start();
  const call = async (endpoint, route, body, headers = {}) => {
    const response = await fetch(endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw new Error('Boundary ' + response.status + ': ' + String(value.error));
    return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const admin = { authorization: 'Bearer ' + await resolveCredential(roots[0], 'control') };
  const password = randomUUID(); await call(ss.endpoint, 'manage/members', { requestId: randomUUID(), loginName: 'switch-acceptance', password }, admin);
  const login = await call(ss.endpoint, 'login', { loginName: 'switch-acceptance', password });
  const pending = (await call(ds.endpoint, 'client/start', { requestId: randomUUID(), schoolEndpoint: ss.endpoint })).value;
  await call(ss.endpoint, 'connections/approve', { requestId: pending.requestId }, { cookie: login.cookie });
  const connection = (await call(ds.endpoint, 'client/complete', { requestId: pending.requestId })).value;
  const headers = { 'x-xj-space': 'school:' + pending.requestId, 'x-xj-namespace': ds.environment.clientNamespace,
    'x-xj-expected-subject': [connection.identity.environmentId, connection.identity.spaceId, connection.identity.principalId].join('.') };
  const api = async (route, body) => (await call(ds.endpoint, route, body, headers)).value;
  for (const [index, protocol] of protocols.entries()) {
    const item = { protocol, passed: false, reason: null }; report.results.push(item);
    try {
      const config = () => ({ requestId: randomUUID(), connectionId: randomUUID(), expectedVersion: 0, name: 'WP07 switch acceptance',
        protocol, baseUrl: `http://127.0.0.1:${relay.address().port}${protocol === 'messages' ? '/anthropic' : '/v1'}`,
        path: protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions',
        modelId: report.model, dialect: 'deepseek', parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 2048,
        credential: { action: 'replace', value: key } });
      const sc = config(), pc = config();
      // The previous school default is a single durable configuration head.
      if (index) { const old = (await api('models/selection')).options.find(option => option.kind === 'school');
        sc.connectionId = old.connection.connectionId; sc.expectedVersion = old.connection.version; }
      await call(ss.endpoint, 'manage/model-default', { ...sc, policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 2048, timeoutMs: 30000 } }, admin);
      await call(ds.endpoint, 'models/connections', pc, { 'x-xj-space': 'personal' });
      let selection = await api('models/selection');
      selection = await api('models/selection', { requestId: randomUUID(), expectedVersion: selection.version, source: { kind: 'school', connectionId: sc.connectionId } });
      const prefix = { system: '请只回答数字25，不调用工具。', tools: [] };
      const oldId = randomUUID();
      await api('models/segments', { requestId: randomUUID(), segmentId: oldId, source: { selected: true, selectionVersion: selection.version }, prefix, portable: [] });
      const finish = async segmentId => {
        const input = { attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 0,
          input: { text: '请回答材料中的数值。', images: [], toolResults: [] }, limits: { maxOutputTokens: 2048, timeoutMs: 30000 } };
        await api('models/calls', input); await api(`models/calls/${input.attemptId}/dispatch`, {});
        for (let tries = 0; tries < 180; tries++) {
          const result = await api('models/calls/' + input.attemptId);
          if (result.physicalRequestEnded) { assert.equal(result.state, 'completed'); assert.ok(result.text.includes('25')); return result; }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error('Bounded provider wait elapsed');
      };
      const old = await finish(oldId);
      const grant = await api('models/grants', { requestId: randomUUID(), grantId: randomUUID(), connectionId: pc.connectionId, owner: 'device' });
      selection = await api('models/selection', { requestId: randomUUID(), expectedVersion: selection.version,
        source: { kind: 'personal', connectionId: pc.connectionId, grantId: grant.grantId } });
      const movedInput = { requestId: randomUUID(), segmentId: randomUUID(), previousSegmentId: oldId,
        source: { selected: true, selectionVersion: selection.version }, prefix, portable: [{ text: old.text, resultRef: old.resultRef }] };
      const moved = await api('models/segments', movedInput);
      assert.deepEqual(await api('models/segments', movedInput), moved);
      assert.equal(moved.provenance.boundary.segmentId, oldId);
      assert.equal(moved.provenance.results[0].owner.environmentId, ss.environment.environmentId);
      const current = await finish(movedInput.segmentId);
      assert.equal(old.source.kind, 'school'); assert.equal(current.source.kind, 'personal');
      assert.notEqual(old.source.feeSource, current.source.feeSource);
      selection = await api('models/selection', { requestId: randomUUID(), expectedVersion: selection.version, source: { kind: 'school', connectionId: sc.connectionId } });
      const returned = await api('models/segments', { requestId: randomUUID(), segmentId: randomUUID(), previousSegmentId: movedInput.segmentId,
        source: { selected: true, selectionVersion: selection.version }, prefix, portable: [{ text: current.text, resultRef: current.resultRef }] });
      assert.equal(returned.provenance.results[0].owner.environmentId, ds.environment.environmentId);
      const count = generations;
      await device.stop(); ds = await device.start();
      assert.equal((await api('models/calls/' + current.attemptId)).resultRef, current.resultRef);
      assert.equal((await api('models/calls/' + old.attemptId)).resultRef, old.resultRef);
      assert.equal(generations, count);
      item.passed = true; item.usage = [old.usage, current.usage]; item.modelRequests = 2;
    } catch (error) { item.reason = error instanceof assert.AssertionError ? 'acceptance-assertion: ' + error.operator : String(error.message).slice(0, 180); }
  }
} finally {
  report.generations = generations;
  await mkdir(dirname(resolve(values.out)), { recursive: true }); await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + '\n');
  const stops = await Promise.allSettled([device.stop(), school.stop()]);
  relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve));
  // Only the two exact temporary installations created above are removed.
  for (const [index, root] of roots.entries()) {
    if (stops[index].status !== 'fulfilled') continue; // Preserve installations whose process state could not be checked.
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !/^xj201-(school|device)-/.test(root.slice(dirname(root).length + 1)))
      throw new Error('Temporary installation cleanup boundary mismatch');
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
console.log(JSON.stringify(report));
if (report.results.length !== 3 || report.results.some(item => !item.passed)) process.exitCode = 1;
