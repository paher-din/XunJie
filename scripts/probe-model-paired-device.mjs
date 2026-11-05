// Explicit two-machine acceptance. SSH controls the device; model tasks use direct authenticated HTTPS.
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { config: { type: 'string' } } });
if (!values.config) throw new Error('Requires --config with task-owned product, TLS and remote launcher paths.');
const config = JSON.parse(await readFile(resolve(values.config), 'utf8'));
const { openProductRuntime, resolveCredential } = await import(pathToFileURL(join(config.product, 'app/product-runtime.js')));
const manifest = JSON.parse(await readFile(join(config.product, 'resources.json'), 'utf8'));
const resources = { ...manifest, nodePath: resolve(config.product, manifest.nodePath), postgresBin: resolve(config.product, manifest.postgresBin), webRoot: resolve(config.product, manifest.webRoot) };
const school = openProductRuntime({ root: join(config.lab, 'school'), resources });
const report = { measuredAt: new Date().toISOString(), base: config.commit, status: 'running', scope: config.scope ?? 'all',
  topology: { school: 'macOS school host', device: 'Windows independent model owner', ssh: 'control only; no tunnels' },
  commandCode: 'waived-by-user', paidLimit: 5, stages: [], upstreamRequests: [], paid: [] };
const textSmokeTerminal = item => item.state === 'completed' || item.state === 'incomplete'
  && item.usage?.state === 'final' && item.usage.outputTokens === 128;
if (config.previousPaidReport) {
  const previous = JSON.parse(await readFile(config.previousPaidReport, 'utf8'));
  report.paid = previous.paid;
  const resumable = new Set(['chat-completions-text', 'responses-text', 'messages-text']);
  assert.equal(report.paid.every(item => resumable.has(item.case) && textSmokeTerminal(item) && item.upstream?.httpStatus === 200 && item.resultRef), true);
  assert.equal(new Set(report.paid.map(item => item.case)).size, report.paid.length);
  report.resumedCompletedCases = report.paid.map(item => item.case);
}
const delay = ms => new Promise(done => setTimeout(done, ms));
const sha = value => createHash('sha256').update(value).digest('hex');
async function persist() { await writeFile(config.out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
async function stage(name, action) {
  const result = { name, status: 'running' }; report.stages.push(result); await persist();
  try { Object.assign(result, await action(), { status: 'passed' }); }
  catch (error) { result.status = 'failed'; result.error = error.code ?? error.name; throw error; }
  finally { await persist(); }
}
function remoteDevice(suffix) {
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', config.ssh, config.deviceLauncher + ' ' + suffix], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let failure;
  child.stderr.on('data', () => {}); // Never echo a remote exception/body into the acceptance report.
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const entry = pending.get(value.id); if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    if (value.ok) entry.resolve(value.result); else entry.reject(Object.assign(new Error('Device acceptance operation failed'), { code: value.code }));
  });
  child.once('exit', code => {
    failure = Object.assign(new Error('Device control exited'), { code: 'device-control-' + code });
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure); } pending.clear();
  });
  return { label: suffix, async call(operation, input = {}) {
    if (failure) throw failure;
    const id = randomUUID(); return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('Device control timed out'), { code: 'device-control-timeout' })); }, 120000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, operation, ...input }) + '\n');
    });
  }, close() { child.stdin.end(); } };
}
function png(swapped) {
  const chunk = (name, bytes) => { const type = Buffer.from(name), size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    sum.writeUInt32BE(crc32(Buffer.concat([type, bytes]))); return Buffer.concat([size, type, bytes, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * 193);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3 + ((x < 32) !== swapped ? 0 : 2)] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const syntheticKey = 'synthetic-pr177-device-key';
let heldClosed = false;
const fixture = createServer({ cert: await readFile(config.certificate), key: await readFile(config.key) }, async (request, response) => {
  const parts = []; for await (const part of request) parts.push(part);
  const body = JSON.parse(Buffer.concat(parts)), system = body.messages[0]?.content;
  report.upstreamRequests.push({ peer: request.socket.remoteAddress, mode: system, number: report.upstreamRequests.length + 1 });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (delta, finish_reason) => response.write('data: ' + JSON.stringify({ id: 'paired-fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  if (system === 'hold') { response.once('close', () => { heldClosed = true; }); event({ content: 'partial' }, null); return; }
  const completedTools = body.messages.some(message => message.role === 'tool');
  if (system === 'sensitive') {
    const encoded = [...syntheticKey].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    event({ tool_calls: [{ index: 0, id: 'secret-tool', type: 'function', function: { name: 'read_marker', arguments: '{"nonce":"' + encoded + '"}' } }] }, 'tool_calls');
  } else if (system === 'tools' && !completedTools) event({ reasoning_content: 'synthetic private reasoning', tool_calls: [
    { index: 0, id: 'image-first', type: 'function', function: { name: 'return_image', arguments: '{}' } },
    { index: 1, id: 'marker-second', type: 'function', function: { name: 'read_marker', arguments: '{}' } },
  ] }, 'tool_calls');
  else event({ content: completedTools ? 'cross-machine-tool-ok' : 'cross-machine-reconnected-ok' }, 'stop');
  response.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } }) + '\n\n');
  response.end('data: [DONE]\n\n');
});
let endpoint, admin;
async function schoolApi(route, body, headers = {}) {
  const response = await fetch(endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', ...headers }, redirect: 'error',
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function pair(device, label) {
  await device.call('install'); const state = await device.call('start');
  assert.equal(state.state, 'ready'); assert.equal(state.environment.profile, 'model');
  assert.equal(state.environment.services.some(item => item.unit === 'learning-data'), false);
  const model = state.environment.services.find(item => item.unit === 'model-connection');
  const target = { environmentId: model.environmentId, serviceId: model.serviceId, version: 1 };
  const loginName = 'pr177-' + label + '-' + randomUUID(), password = randomUUID();
  const created = await schoolApi('manage/members', { requestId: randomUUID(), loginName, password, target }, admin); assert.equal(created.status, 200);
  const login = await schoolApi('login', { loginName, password }); assert.equal(login.status, 200);
  const requestId = randomUUID();
  const start = await device.call('api', { route: 'client/start', body: { requestId, schoolEndpoint: endpoint } }); assert.equal(start.status, 200);
  assert.equal((await schoolApi('connections/approve', { requestId }, { cookie: login.cookie })).status, 200);
  const complete = await device.call('api', { route: 'client/complete', body: { requestId } }); assert.equal(complete.status, 200);
  const grant = await school.authorize({ sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId,
    sourceInstallationId: state.environment.installationId, capabilities: ['learning.authority'] });
  const runtimeConnectionId = randomUUID();
  await device.call('connect', { connection: { connectionId: runtimeConnectionId, sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId,
    sourceInstallationId: state.environment.installationId, target: (await school.status()).environment.services[0], requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'acceptance-school' }, token: grant.token });
  // The local device management route requires its own product control credential; keep it in the RPC process.
  const configured = await device.call('bind', { connectionId: requestId, runtimeConnectionId, target });
  if (configured.status !== 200) {
    report.bindingDiagnostic = await device.call('diagnose-binding', { connectionId: requestId, runtimeConnectionId, target });
    throw Object.assign(new Error('Local model binding rejected'), { code: 'local-binding-' + configured.status + '-' + (configured.value?.error?.code ?? configured.value?.error ?? 'unknown') });
  }
  const headers = { 'x-xj-space': 'school:' + requestId };
  const identity = created.value, binding = { grantId: grant.grantId, installationId: state.environment.installationId };
  async function api(route, body) { const result = await device.call('api', { route: 'models/' + route, body, headers });
    assert.equal(result.status, 200, 'device model route ' + route + ': ' + result.status); return result.value; }
  async function configure(protocol, baseUrl, apiKey, modelId = 'fixture-model', dialect = 'standard', parameterMode = 'plain') {
    const connectionId = randomUUID(), grantId = randomUUID();
    await device.call('api', { route: 'models/connections', headers: { 'x-xj-space': 'personal' }, body: { requestId: randomUUID(), connectionId,
      expectedVersion: 0, name: 'Acceptance ' + protocol, protocol, baseUrl, path: protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions',
      modelId, dialect, parameterMode, enabled: true, credential: { action: 'replace', value: apiKey } } }).then(result => assert.equal(result.status, 200));
    await api('grants', { requestId: randomUUID(), connectionId, grantId, owner: 'device' });
    return { connectionId, grantId };
  }
  async function select(connection) { const current = await api('selection'); const next = await api('selection', { requestId: randomUUID(), expectedVersion: current.version,
    source: { kind: 'personal', ...connection } }); return { selected: true, selectionVersion: next.version }; }
  async function segment(source, system, tools = [], options) { const segmentId = randomUUID(); await api('segments', { requestId: randomUUID(), segmentId, source,
    prefix: { system, tools, ...(options ? { options } : {}) }, portable: [] }); return segmentId; }
  const queued = async (operation, attemptId, input) => {
    const task = { taskId: randomUUID(), attemptId, operation, ...(input ? { input } : {}) };
    await school.modelTask({ operation: 'enqueue', identity, binding, task }); return task;
  };
  const query = task => school.modelTask({ operation: 'read', identity, binding, taskId: task.taskId });
  async function submit(operation, attemptId, input) {
    const task = await queued(operation, attemptId, input);
    const deadline = Date.now() + 75000;
    do { const result = await query(task); if (result.receipt) {
      if (!result.receipt.ok) throw Object.assign(new Error('Authenticated task rejected'), { code: 'task-' + operation + '-' + result.receipt.code });
      return result.receipt.value; }
      await delay(250); } while (Date.now() < deadline);
    throw Object.assign(new Error('Task receipt timed out'), { code: 'receipt-timeout-' + operation });
  }
  async function finish(input) {
    assert.equal((await submit('receive', input.attemptId, input)).state, 'accepted'); await submit('dispatch', input.attemptId);
    let result; for (let count = 0; count < 4; count++) { result = await submit('read', input.attemptId); if (result.physicalRequestEnded) return result; }
    throw Object.assign(new Error('Native request did not finish'), { code: 'native-timeout' });
  }
  return { device, state, target, identity, binding, cookie: login.cookie, headers, api, configure, select, segment, queued, query, submit, finish };
}
const call = (segmentId, sequence = 0, input = {}) => ({ attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: sequence,
  input: { text: 'Continue', images: [], toolResults: [], ...input }, limits: { maxOutputTokens: 2048, timeoutMs: 30000 } });
const simpleTool = name => ({ name, description: 'Synthetic read-only caller tool', inputSchema: { type: 'object', properties: {}, additionalProperties: false } });
const devices = [];
let schoolInstalled = false;
await mkdir(config.lab, { recursive: true });
try {
  await new Promise(resolve => fixture.listen(config.fixturePort, '0.0.0.0', resolve));
  await stage('school-start', async () => {
    await school.install({ profile: 'school', host: '0.0.0.0', port: config.schoolPort, publicEndpoint: `https://${config.host}:${config.schoolPort}`,
      tls: { certificateFile: config.certificate, keyFile: config.key } }); schoolInstalled = true;
    const state = await school.start(); endpoint = state.endpoint; admin = { authorization: 'Bearer ' + await resolveCredential(join(config.lab, 'school'), 'control') };
    assert.equal(state.state, 'ready'); return { environmentId: state.environment.environmentId, endpoint };
  });
  if (config.scope !== 'paid') {
    const device = remoteDevice('fixture'); devices.push(device);
    let paired, source, first, firstInput, uploaded;
    await stage('authenticated-mac-windows-pairing', async () => { paired = await pair(device, 'fixture'); return { installationId: paired.state.environment.installationId,
      deviceEnvironment: paired.state.environment.environmentId, modelOnly: true, subject: paired.identity.principalId }; });
    await stage('school-member-target-boundary', async () => {
      for (const baseUrl of ['http://127.0.0.1:19446/v1', 'https://10.0.0.1/v1', 'https://[::1]/v1']) {
        const connectionId = randomUUID(), draft = { connectionId, name: 'Rejected school target', protocol: 'chat-completions', baseUrl, path: '/chat/completions',
          modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true };
        assert.equal((await schoolApi('models/connections', { ...draft, requestId: randomUUID(), expectedVersion: 0, credential: { action: 'replace', value: syntheticKey } }, { cookie: paired.cookie })).status, 403);
        assert.equal((await schoolApi('models/checks', { attemptId: randomUUID(), purpose: 'connection-check', source: { draft, credential: { action: 'replace', value: syntheticKey } },
          limits: { maxOutputTokens: 64, timeoutMs: 10000 } }, { cookie: paired.cookie })).status, 403);
      }
      assert.equal(report.upstreamRequests.length, 0); return { deniedSaved: 3, deniedDraft: 3, upstreamRequests: 0 };
    });
    const connection = await paired.configure('chat-completions', `https://${config.host}:${config.fixturePort}/v1`, syntheticKey);
    source = await paired.select(connection);
    await stage('capability-decision-before-send', async () => {
      const prefix = { system: '', tools: [], options: { requiredCapabilities: ['images', 'nativeReplay'] } };
      const preflight = await paired.api('capabilities', { source, prefix }); assert.equal(preflight.available, false);
      const rejected = await device.call('api', { route: 'models/segments', headers: paired.headers, body: { requestId: randomUUID(), segmentId: randomUUID(), source, prefix, portable: [] } });
      assert.equal(rejected.status, 422); assert.deepEqual(rejected.value.decision, preflight); assert.equal(report.upstreamRequests.length, 0);
      return { missing: preflight.missing.map(item => item.capability), statusCode: rejected.status };
    });
    await stage('fixed-image-and-two-tools', async () => {
      const imageId = randomUUID(); uploaded = { imageId, version: 1 };
      await paired.api('images', { requestId: randomUUID(), imageId, mediaType: 'image/png', dataBase64: png(false).toString('base64') });
      const segmentId = await paired.segment(source, 'tools', [simpleTool('return_image'), simpleTool('read_marker')], { capabilityProbe: true });
      firstInput = call(segmentId, 0, { text: 'Inspect fixed image', images: [uploaded] }); first = await paired.finish(firstInput);
      assert.equal(first.state, 'completed'); assert.equal(first.toolIntents.length, 2);
      assert.equal(report.upstreamRequests[0].peer.replace('::ffff:', ''), config.deviceIp);
      return { attemptId: first.attemptId, resultRef: first.resultRef, toolCalls: first.toolIntents.map(item => item.callId), usage: first.usage };
    });
    await stage('windows-restart-native-replay-and-first-tool-image', async () => {
      const native = await device.call('native-summary', { resultRef: first.resultRef }); await device.call('restart');
      assert.equal((await paired.submit('read', first.attemptId)).resultRef, first.resultRef);
      const next = call(firstInput.segmentId, 1, { text: 'Use both results', toolResults: [
        { callId: 'marker-second', outcome: 'success', text: 'marker-value', images: [] },
        { callId: 'image-first', outcome: 'success', text: 'fixed tool image', images: [uploaded] },
      ] });
      const result = await paired.finish(next); assert.equal(result.state, 'completed');
      const witness = await device.call('witness'), actual = witness.requests.at(-1);
      assert.deepEqual(actual.toolGroupInterruptions, []); assert.deepEqual(actual.toolCalls, ['image-first', 'marker-second']);
      assert.equal(actual.assistantHashes.includes(native.assistantHash), true); assert.equal(actual.images.includes(sha(png(false))), true);
      assert.equal((await paired.submit('dispatch', result.attemptId)).resultRef, result.resultRef); assert.equal(report.upstreamRequests.length, 2);
      return { resultRef: result.resultRef, originalAssistantPreserved: true, completeToolGroup: true, imageSha256: sha(png(false)), repeatedDispatchRequests: [2, 2] };
    });
    await stage('cross-machine-physical-cancellation', async () => {
      const input = call(await paired.segment(source, 'hold'));
      await paired.submit('receive', input.attemptId, input); await paired.submit('dispatch', input.attemptId);
      assert.equal((await paired.submit('cancel', input.attemptId)).cancelRequested, true);
      const result = await paired.submit('read', input.attemptId); assert.equal(result.state, 'cancelled'); assert.equal(result.upstreamStopped, 'unknown');
      assert.equal(result.physicalRequestEnded, true); assert.equal(heldClosed, true);
      assert.equal((await paired.submit('dispatch', input.attemptId)).state, 'cancelled'); assert.equal(report.upstreamRequests.length, 3);
      return { state: result.state, reason: result.reason, upstreamStopped: result.upstreamStopped, physicalRequestEnded: true, repeatedDispatchRequests: [3, 3] };
    });
    await stage('escaped-credential-through-authenticated-device-task', async () => {
      const tool = { name: 'read_marker', description: '', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } };
      const result = await paired.finish(call(await paired.segment(source, 'sensitive', [tool])));
      assert.equal(result.state, 'failed'); assert.deepEqual(result.toolIntents, []); assert.equal(JSON.stringify(result).includes(syntheticKey), false);
      const native = await device.call('native-summary', { resultRef: result.resultRef }); assert.equal(native.redacted, true); assert.equal(native.chunks, 0);
      return { state: result.state, reason: result.reason, nativeWithheld: true, noExecutableTool: true };
    });
    await stage('device-offline-queue-without-school-fallback', async () => {
      const input = call(await paired.segment(source, 'offline'));
      await paired.submit('receive', input.attemptId, input); await device.call('stop');
      const task = await paired.queued('dispatch', input.attemptId); await delay(12000);
      assert.equal((await paired.query(task)).receipt, null); assert.equal(report.upstreamRequests.length, 4);
      await device.call('start'); const limit = Date.now() + 75000; let receipt;
      do { receipt = (await paired.query(task)).receipt; if (!receipt) await delay(250); } while (!receipt && Date.now() < limit);
      assert.equal(receipt?.ok, true); const result = await paired.submit('read', input.attemptId); assert.equal(result.state, 'completed');
      assert.equal(report.upstreamRequests.length, 5); return { offlineRequests: 0, queuedTaskPreserved: true, resultRef: result.resultRef };
    });
    await stage('school-disconnect-reconnect-original-result', async () => {
      await school.stop(); await delay(12000); await school.start();
      const result = await paired.submit('read', first.attemptId); assert.equal(result.resultRef, first.resultRef); assert.equal(report.upstreamRequests.length, 5);
      return { sameResultRef: true, noRegeneration: true };
    });
    for (const request of report.upstreamRequests) assert.equal(request.peer.replace('::ffff:', ''), config.deviceIp);
    await device.call('cleanup'); device.close(); devices.splice(devices.indexOf(device), 1);
  }
  const paidDevice = remoteDevice('paid'); devices.push(paidDevice);
  await stage('bounded-deepseek-real-endpoints', async () => {
    assert.equal((await paidDevice.call('witness')).requests.length, report.paid.length, 'Resume only the recorded generation ledger');
    const providerDocument = JSON.parse(await readFile(config.credentialsFile, 'utf8'));
    const key = providerDocument.providers.find(item => item.key && /deepseek/i.test(item.preset ?? item.name ?? '')).key;
    const p = await pair(paidDevice, 'paid'); let attempts = report.paid.length;
    const paidFinish = async input => { assert.ok(++attempts <= 5); return p.finish(input); };
    for (const protocol of ['chat-completions', 'responses', 'messages']) {
      if (report.paid.some(item => item.case === protocol + '-text')) continue;
      const route = await p.configure(protocol, protocol === 'messages' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com/v1', key, 'deepseek-flash', 'deepseek', 'plain');
      const selected = await p.select(route);
      const input = call(await p.segment(selected, 'Reply exactly with cross-platform-ok.'));
      input.limits.maxOutputTokens = 128;
      const result = await paidFinish(input);
      report.paid.push({ case: protocol + '-text', state: result.state, reason: result.reason, resultRef: result.resultRef,
        usage: result.usage, upstream: result.upstream, nonemptyText: result.text.trim().length > 0,
        textSha256: sha(result.text) }); await persist();
      // The deliberately small smoke budget may produce a valid max-token terminal.
      assert.equal(textSmokeTerminal(result), true); assert.equal(result.text.trim().length > 0, true);
    }
    const chatConnection = await p.configure('chat-completions', 'https://api.deepseek.com/v1', key, 'deepseek-flash', 'deepseek', 'thinking');
    const selected = await p.select(chatConnection), imageId = randomUUID(), resultImageId = randomUUID();
    for (const [uploadedId, swapped] of [[imageId, false], [resultImageId, true]]) await p.api('images', { requestId: randomUUID(), imageId: uploadedId,
      mediaType: 'image/png', dataBase64: png(swapped).toString('base64') });
    const tools = [
      { name: 'return_image', description: 'Returns a second image for you to inspect after the tool reply.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      { name: 'read_marker', description: 'Call with the color in the LEFT half of the initial image. Returns a marker.', inputSchema: { type: 'object', properties: { leftColor: { type: 'string', enum: ['red', 'blue'] } }, required: ['leftColor'], additionalProperties: false } },
    ];
    const segmentId = await p.segment(selected, 'Inspect the initial image. Call BOTH return_image and read_marker once each in the same response. After receiving both tool results, inspect the tool image, then return JSON only with nonce and leftColor. Do not call any more tools.', tools);
    const first = await paidFinish(call(segmentId, 0, { text: 'Inspect the image and call both tools.', images: [{ imageId, version: 1 }] }));
    report.paid.push({ case: 'chat-image-two-tools', state: first.state, reason: first.reason, toolCount: first.toolIntents?.length ?? 0,
      initialImageRead: first.toolIntents?.find(item => item.name === 'read_marker')?.arguments.leftColor === 'red', usage: first.usage, upstream: first.upstream }); await persist();
    assert.equal(first.state, 'completed'); assert.equal(first.toolIntents?.length, 2);
    assert.equal(first.toolIntents.find(item => item.name === 'read_marker').arguments.leftColor, 'red');
    const native = await paidDevice.call('native-summary', { resultRef: first.resultRef }); await paidDevice.call('restart');
    assert.equal((await p.submit('read', first.attemptId)).resultRef, first.resultRef);
    const nonce = 'XJ-' + randomUUID();
    const next = await paidFinish(call(segmentId, 1, { text: 'Use both tool results and return JSON with nonce and the LEFT color of the returned tool image.',
      toolResults: first.toolIntents.toReversed().map(item => ({ callId: item.callId, outcome: 'success',
        text: item.name === 'read_marker' ? nonce : 'The second image is attached.', images: item.name === 'return_image' ? [{ imageId: resultImageId, version: 1 }] : [] })) }));
    let answer; try { answer = JSON.parse(next.text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { answer = null; }
    const witness = await paidDevice.call('witness'), actual = witness.requests.at(-1);
    report.paid.push({ case: 'chat-restart-tool-image-continuation', state: next.state, reason: next.reason, correctNonce: answer?.nonce === nonce,
      toolImageRead: answer?.leftColor === 'blue', nativePreserved: actual.assistantHashes.includes(native.assistantHash),
      completeToolGroup: actual.toolGroupInterruptions.length === 0, exactImageResource: actual.images.includes(sha(png(true))), usage: next.usage, upstream: next.upstream });
    report.paidWitness = witness; await persist();
    assert.equal(next.state, 'completed'); assert.equal(answer?.nonce, nonce); assert.equal(answer?.leftColor, 'blue');
    assert.equal(actual.assistantHashes.includes(native.assistantHash), true); assert.deepEqual(actual.toolGroupInterruptions, []);
    assert.equal(witness.requests.length, 5); assert.equal(witness.requests.every(item => item.status === 200), true);
    return { requests: attempts, retries: 0, deviceGenerationWitnesses: witness.requests.length };
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = { code: error.code ?? error.name,
  frames: error.stack?.split('\n').filter(line => line.trim().startsWith('at ') && line.includes('probe-model-paired-device.mjs')).map(line => line.trim()) }; process.exitCode = 1; }
finally {
  report.cleanup = [];
  report.deviceWitnesses = [];
  for (const device of devices) {
    try { report.deviceWitnesses.push({ label: device.label, witness: await device.call('witness') }); } catch {}
    try { report.cleanup.push(await device.call('cleanup')); } catch (error) { report.cleanup.push({ code: error.code ?? error.name }); } device.close();
  }
  if (schoolInstalled) try { const state = await school.status(); await school.stop(); await school.deleteEnvironment({ environmentId: state.environment.environmentId }); report.cleanup.push({ schoolStopped: true, schoolEnvironmentDeleted: true }); }
  catch (error) { report.cleanup.push({ schoolCleanup: error.code ?? error.name }); }
  fixture.closeAllConnections(); await new Promise(done => fixture.close(done)); await persist();
  console.log(JSON.stringify({ status: report.status, stages: report.stages.map(item => ({ name: item.name, status: item.status })), paidRequests: report.paidWitness?.requests.length ?? report.paid.length, failure: report.failure }));
}
