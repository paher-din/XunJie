// Explicit bounded paid probe. Native content travels only in private process memory, never reports/logs.
import assert from 'node:assert/strict';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { deflateSync, crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime';

const target = 'https://api.deepseek.com/anthropic/v1/messages';
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, webRoot: resolve('apps/web/dist-runtime'),
  windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') };
const originalFetch = globalThis.fetch;
const delay = () => new Promise(resolve => setTimeout(resolve, 50));
const sha = value => createHash('sha256').update(value).digest('hex');
if (process.argv[2] === '--witness-child') {
  let count = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== target || request.method !== 'POST') return originalFetch(input, init);
    if (++count > 12) throw new Error('Child probe generation limit reached');
    const id = randomUUID(), payload = JSON.parse(await request.clone().text());
    process.send?.({ type: 'outgoing', id, payload });
    const response = await originalFetch(input, init);
    process.send?.({ type: 'headers', id, status: response.status });
    void response.clone().text().then(raw => process.send?.({ type: 'wire', id, raw }), () => process.send?.({ type: 'wire', id, raw: '' }));
    return response;
  };
  const host = await createProductRuntimeHost({ root: resolve(process.argv[3]), createApplication: createProductLearningApplication });
  process.send?.({ type: 'ready', endpoint: host.endpoint });
  process.on('message', async value => {
    if (value?.type === 'close') { await host.close(); process.disconnect?.(); process.exit(0); }
  });
  process.on('disconnect', () => process.exit(0));
} else {
  await main();
}

async function main() {
  const { values } = parseArgs({ options: { 'credentials-file': { type: 'string' }, out: { type: 'string' }, case: { type: 'string' } } });
  if (!values['credentials-file'] || !values.out || !resources.postgresBin) throw new Error('Requires an authorized private credentials file, --out and native PostgreSQL.');
  if (!['native', 'schemas', 'controls', 'check', 'cancel'].includes(values.case)) throw new Error('Requires --case native|schemas|controls|check|cancel; each case uses an isolated environment within the Gateway admission limit.');
  const source = await readFile(resolve(values['credentials-file']), 'utf8'), credentials = new Map();
  if (source.trimStart().startsWith('{')) {
    const document = JSON.parse(source);
    for (const provider of document.providers ?? []) if (provider.key && /deepseek/i.test(provider.preset ?? provider.name ?? '')) credentials.set('deepseek', provider.key);
  } else for (const line of source.split(/\r?\n/)) {
    const provider = /command\s*code/i.test(line) ? 'command-code' : /deepseek/i.test(line) ? 'deepseek' : null;
    const tokens = line.replace(/https?:\/\/\S+/g, '').match(/[A-Za-z0-9_-]{20,}/g) ?? [];
    if (provider && tokens.length === 1) credentials.set(provider, tokens[0]);
  }
  if (!credentials.get('deepseek')) throw new Error('Missing authorized DeepSeek credential; no contents displayed.');
  const report = { measuredAt: new Date().toISOString(), endpoint: target, model: 'deepseek-flash', protocol: 'messages',
    sdk: '@anthropic-ai/sdk@1.1.0', adapter: 'xunjie-messages-native-v1', apiVersion: '2023-06-01',
    maxGenerations: { native: 2, schemas: 6, controls: 3, check: 1, cancel: 1 }[values.case], limits: { maxOutputTokens: 2048, timeoutMs: 30000, retries: 0 }, cases: [] };
  const root = await mkdtemp(join(tmpdir(), 'xj-167-real-messages-'));
  const runtime = openProductRuntime({ root, resources });
  const observed = []; let child = null, endpoint = '', version = 0, connectionId = randomUUID();
  async function start() {
    child = fork(fileURLToPath(import.meta.url), ['--witness-child', root], { execPath: process.execPath, execArgv: [], windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Probe child readiness timeout')), 30000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Probe child exited before readiness: ' + code)); });
      child.on('message', value => {
        if (value?.type === 'ready') { endpoint = value.endpoint; clearTimeout(timer); done(); }
        else if (value?.type === 'outgoing') {
          if (observed.length >= report.maxGenerations) { child.send({ type: 'close' }); reject(new Error('Probe generation limit reached')); return; }
          observed.push({ id: value.id, payload: value.payload, status: null, raw: null });
        } else if (value?.id) {
          const fact = observed.find(item => item.id === value.id);
          if (fact && value.type === 'headers') fact.status = value.status;
          if (fact && value.type === 'wire') fact.raw = value.raw;
        }
      });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const owned = child;
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Probe child close timeout')), 30000);
      owned.once('exit', () => { clearTimeout(timer); done(); }); owned.send({ type: 'close' });
    }); child = null;
  }
  const api = async (path, body) => {
    const response = await originalFetch(endpoint + '/api/learning/models/' + path, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(35000) });
    const value = await response.json(); if (!response.ok) throw new Error('Gateway HTTP ' + response.status + ':' + value.error); return value;
  };
  const configure = async mode => { const saved = await api('connections', { connectionId, requestId: randomUUID(), expectedVersion: version,
    name: 'DeepSeek Messages probe', protocol: 'messages', baseUrl: 'https://api.deepseek.com/anthropic', path: '/v1/messages', modelId: 'deepseek-flash',
    dialect: 'deepseek', parameterMode: mode, enabled: true, credential: version ? { action: 'keep' } : { action: 'replace', value: credentials.get('deepseek') } }); version = saved.version; };
  const segment = (system, tools = [], options = {}) => api('segments', { requestId: randomUUID(), segmentId: randomUUID(), source: { connectionId, version },
    prefix: { system, tools, options: { ...options, capabilityProbe: true } }, portable: [] });
  const limits = report.limits;
  const receive = (id, sequence, input) => {
    if (observed.length >= report.maxGenerations) throw new Error('Explicit probe generation budget reached');
    return api('calls', { attemptId: randomUUID(), purpose: 'chat-probe', segmentId: id, expectedSequence: sequence,
      input: { text: input.text ?? '', images: input.images ?? [], toolResults: input.toolResults ?? [] }, limits: { maxOutputTokens: limits.maxOutputTokens, timeoutMs: limits.timeoutMs } });
  };
  async function wait(attemptId, route = 'calls') {
    const until = Date.now() + 35000;
    while (Date.now() < until) { const fact = await api(route + '/' + attemptId); if (fact.physicalRequestEnded) return fact; await delay(); }
    throw new Error('Bounded Messages attempt did not end');
  }
  async function finish(id, sequence = 0, input = {}) {
    const attempt = await receive(id, sequence, input); await api('calls/' + attempt.attemptId + '/dispatch', {}); return wait(attempt.attemptId);
  }
  const publicFact = fact => ({ attemptId: fact.attemptId, state: fact.state, reason: fact.reason, usage: fact.usage, resultReadable: !!fact.resultRef, toolCount: fact.toolIntents?.length ?? 0, physicalRequestEnded: fact.physicalRequestEnded });
  async function wire(index) { const until = Date.now() + 35000; while (Date.now() < until) { if (observed[index] && observed[index].raw !== null) return observed[index]; await delay(); } throw new Error('Missing wire witness'); }
  try {
    await runtime.install({ profile: 'local' }); await start();
    if (!values.case || values.case === 'native') {
      await configure('thinking');
      const firstImage = await api('images', { requestId: randomUUID(), imageId: randomUUID(), mediaType: 'image/png', dataBase64: png(false) });
      const secondImage = await api('images', { requestId: randomUUID(), imageId: randomUUID(), mediaType: 'image/png', dataBase64: png(true), source: { imageId: firstImage.imageId, version: 1, transformation: 'swap red and blue' } });
      const tools = [
        { name: 'read_marker', description: 'Read-only marker lookup. Report the image left-half color in the argument.', inputSchema: { type: 'object', properties: { left: { type: 'string', enum: ['red', 'blue'] } }, required: ['left'], additionalProperties: false } },
        { name: 'get_observation', description: 'Read-only observation lookup.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ];
      const fixed = await segment('Call both read-only tools once before the final answer. After their results, return JSON containing only nonce and left (red or blue). Use the tool-result image for the final color.', tools);
      const at = observed.length;
      const first = await finish(fixed.segmentId, 0, { text: 'Call both tools now. Inspect the attached image for read_marker.left.', images: [{ imageId: firstImage.imageId, version: 1 }] });
      const entry = { name: 'thinking-auto-image-tools-native-restart', first: publicFact(first) }; report.cases.push(entry);
      assert.equal(first.state, 'completed'); assert.equal(first.toolIntents.length, 2);
      assert.equal(first.toolIntents.find(tool => tool.name === 'read_marker')?.arguments.left, 'red');
      assert.equal(first.toolIntents.filter(tool => tool.name === 'get_observation').length, 1);
      const original = rawAssistant((await wire(at)).raw);
      assert.ok(original.content.some(part => part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.length > 0));
      entry.nativeContentSha256 = sha(JSON.stringify(original.content));
      entry.signaturePresent = original.content.some(part => part.type === 'thinking' && Object.hasOwn(part, 'signature'));
      const previousPid = child.pid;
      await stop(); await start(); assert.notEqual(child.pid, previousPid);
      entry.actualProcessRestart = true;
      assert.equal((await api('calls/' + first.attemptId)).resultRef, first.resultRef); entry.sameResultRefAfterRestart = true;
      const nonce = 'nonce-' + randomUUID();
      const second = await finish(fixed.segmentId, 1, { text: 'The tools have finished. Return only the final JSON nonce and tool-result image left color; do not call a tool again.',
        toolResults: first.toolIntents.map(tool => ({ callId: tool.callId, outcome: 'success', text: tool.name === 'read_marker' ? nonce : 'observation available',
          images: tool.name === 'read_marker' ? [{ imageId: secondImage.imageId, version: 1 }] : [] })) });
      entry.second = publicFact(second); assert.equal(second.state, 'completed'); assert.equal(second.toolIntents.length, 0);
      const nextWire = await wire(at + 1);
      entry.nativeContentWireEqual = isDeepStrictEqual(nextWire.payload.messages.find(message => message.role === 'assistant')?.content, original.content);
      assert.equal(entry.nativeContentWireEqual, true);
      const results = nextWire.payload.messages.find(message => message.role === 'user' && Array.isArray(message.content) && message.content[0]?.type === 'tool_result').content;
      assert.deepEqual(results.filter(part => part.type === 'tool_result').map(part => part.tool_use_id), first.toolIntents.map(tool => tool.callId));
      const markerResult = results.find(result => result.tool_use_id === first.toolIntents.find(tool => tool.name === 'read_marker').callId);
      assert.equal(markerResult.content[1].source.data, png(true)); entry.nativeToolImagePairing = true;
      const parsed = JSON.parse(second.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      entry.nonceCorrect = parsed.nonce === nonce; entry.originalImageCorrect = true; entry.toolImageCorrect = parsed.left === 'blue';
      assert.equal(entry.nonceCorrect, true); assert.equal(entry.toolImageCorrect, true);
    }
    if (!values.case || values.case === 'check') {
      await configure('plain');
      const input = { attemptId: randomUUID(), purpose: 'connection-check', source: { connectionId, version }, limits: { maxOutputTokens: 64, timeoutMs: 30000 } };
      await api('checks', input); await api('checks/' + input.attemptId + '/dispatch', {});
      const fact = await wait(input.attemptId, 'checks'); report.cases.push({ name: 'formal-plain-check', ...publicFact(fact) }); assert.equal(fact.state, 'completed');
    }
    if (values.case === 'schemas' || values.case === 'controls') {
      await configure('plain');
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
      const cases = values.case === 'controls' ? [
        { name: 'application-schema-explicit-json', options: { applicationSchema: schema } },
        { name: 'strict-tool-impossible-schema', tools: [{ name: 'record_ok', description: 'Read-only negative control.', inputSchema: { ...schema, not: {} }, strict: true }], options: { toolChoice: { name: 'record_ok' } } },
      ] : [
        { name: 'application-schema', options: { applicationSchema: schema } },
        { name: 'native-format-valid', options: { responseFormat: { kind: 'json-schema', name: 'probe', schema, strict: true } } },
        { name: 'native-format-invalid-schema', options: { responseFormat: { kind: 'json-schema', name: 'probe', schema: { type: 'invalid-type' }, strict: true } } },
        { name: 'strict-tool-valid', tools: [{ name: 'record_ok', description: 'Read-only test.', inputSchema: schema, strict: true }], options: { toolChoice: { name: 'record_ok' } } },
        { name: 'strict-tool-impossible-schema', tools: [{ name: 'record_ok', description: 'Read-only negative control.', inputSchema: { ...schema, not: {} }, strict: true }], options: { toolChoice: { name: 'record_ok' } } },
      ];
      for (const sample of cases) {
        const fixed = await segment(values.case === 'controls'
          ? 'Emit exactly 11 ASCII characters: {"ok":true}. Both double quote characters around the key are required. Do not use single quotes or code fences. If a tool is specified, call it with ok true.'
          : 'Return exactly the JSON object {"ok":true}; if a tool is specified, call it with ok true.', sample.tools ?? [], sample.options);
        const before = observed.length, result = await finish(fixed.segmentId, 0, { text: 'Return the requested JSON or tool call.' });
        report.cases.push({ name: sample.name, mode: 'plain', httpStatus: (await wire(before)).status, ...publicFact(result) });
      }
      await configure('thinking');
      const fixed = await segment('Use the named read-only tool.', [{ name: 'record_ok', description: '', inputSchema: schema }], { toolChoice: { name: 'record_ok' } });
      const before = observed.length, result = await finish(fixed.segmentId, 0, { text: 'Use record_ok now.' });
      report.cases.push({ name: 'thinking-forced-tool', mode: 'thinking', httpStatus: (await wire(before)).status, ...publicFact(result) });
    }
    if (!values.case || values.case === 'cancel') {
      await configure('plain'); const fixed = await segment('Write a long numbered list without finishing early.');
      const before = observed.length, attempt = await receive(fixed.segmentId, 0, { text: 'Count slowly from 1 to 10000, one number on each line.' });
      await api('calls/' + attempt.attemptId + '/dispatch', {});
      const until = Date.now() + 25000;
      while (Date.now() < until && observed[before]?.status == null) await delay();
      await api('calls/' + attempt.attemptId + '/cancel', {}); const result = await wait(attempt.attemptId);
      report.cases.push({ name: 'client-cancel', httpStatus: observed[before]?.status ?? null, cancelRequested: result.cancelRequested, upstreamStopped: 'unknown', ...publicFact(result) });
      assert.equal(result.cancelRequested, true); assert.ok(['cancelled', 'completed'].includes(result.state));
    }
    report.status = 'completed';
  } catch (error) {
    report.status = 'failed'; report.failure = error instanceof assert.AssertionError ? 'probe-assertion' : 'bounded-probe-failure'; process.exitCode = 1;
  } finally {
    report.generationAttempts = observed.length;
    report.httpStatuses = observed.map(item => item.status);
    await stop(); await runtime.stop();
    await mkdir(dirname(resolve(values.out)), { recursive: true }); await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, cases: report.cases.map(sample => ({ name: sample.name, state: sample.state ?? sample.second?.state ?? sample.first?.state })), generationAttempts: report.generationAttempts, report: resolve(values.out) }));
  }
}
function rawAssistant(raw) {
  let message = null, stopped = false; const blocks = [], inputs = new Map();
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue; const event = JSON.parse(data);
    if (event.type === 'message_start') message = event.message;
    if (event.type === 'content_block_start') blocks[event.index] = event.content_block;
    if (event.type === 'content_block_delta') {
      const part = blocks[event.index], delta = event.delta;
      if (delta.type === 'input_json_delta') inputs.set(event.index, (inputs.get(event.index) ?? '') + delta.partial_json);
      else { const field = { text_delta: 'text', thinking_delta: 'thinking', signature_delta: 'signature' }[delta.type]; if (!field) throw new Error('Unknown raw block'); part[field] = (part[field] ?? '') + delta[field]; }
    }
    if (event.type === 'message_stop') stopped = true;
  }
  assert.ok(message && stopped); for (const [index, json] of inputs) blocks[index].input = JSON.parse(json);
  return { ...message, content: blocks };
}
function png(swapped) {
  const chunk = (name, bytes) => { const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes]))); return Buffer.concat([size, type, bytes, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * 193); for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3 + ((x < 32) !== swapped ? 0 : 2)] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
