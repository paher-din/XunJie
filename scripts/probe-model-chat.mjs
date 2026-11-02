// Explicit, bounded paid interoperability probe. No credentials or native reasoning are written to its report.
import assert from 'node:assert/strict';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime';

const { values } = parseArgs({ options: { 'credentials-file': { type: 'string' }, out: { type: 'string' }, provider: { type: 'string' } } });
if (!values['credentials-file'] || !values.out || !process.env.XUNJIE_PRODUCT_POSTGRES_BIN) throw new Error('Requires --credentials-file, --out and native PostgreSQL.');
const credentials = new Map();
for (const line of (await readFile(resolve(values['credentials-file']), 'utf8')).split(/\r?\n/).filter(Boolean)) {
  const provider = /command\s*code/i.test(line) ? 'command-code' : /deepseek/i.test(line) ? 'deepseek' : null;
  const tokens = line.replace(/https?:\/\/\S+/g, '').match(/[A-Za-z0-9_-]{20,}/g) ?? [];
  if (provider && tokens.length === 1) credentials.set(provider, tokens[0]);
}
if (credentials.size !== 2) throw new Error('The private file must identify exactly one credential per target provider.');
const routes = [
  { dialect: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-flash', mode: 'thinking' },
  { dialect: 'command-code', baseUrl: 'https://api.commandcode.ai/provider/v1', modelId: 'deepseek/deepseek-v4.1-flash', mode: 'plain' },
].filter(route => !values.provider || values.provider === route.dialect);
if (!routes.length) throw new Error('Unsupported probe provider.');
const report = { measuredAt: new Date().toISOString(), sdk: 'openai@7.42.0', adapter: 'xunjie-chat-native-v2',
  maxGenerations: routes.reduce((sum, route) => sum + (route.dialect === 'deepseek' ? 6 : 5), 0), limits: { maxOutputTokens: 2048, timeoutMs: 30000, retries: 0 }, results: [] };
const sha = value => createHash('sha256').update(value).digest('hex');
function png(swapped) {
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes]))); return Buffer.concat([size, type, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3 + ((x < 32) !== swapped ? 0 : 2)] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const originalFetch = globalThis.fetch, observed = [];
globalThis.fetch = async (input, options) => {
  const request = new Request(input, options);
  if (!routes.some(route => request.url === route.baseUrl + '/chat/completions') || request.method !== 'POST') return originalFetch(input, options);
  if (observed.length >= report.maxGenerations) throw new Error('Explicit probe generation limit reached');
  const item = { payload: JSON.parse(await request.clone().text()), endpoint: request.url, status: null, raw: Promise.resolve('') };
  observed.push(item);
  const response = await originalFetch(input, options); item.status = response.status;
  item.raw = response.clone().text().catch(() => ''); return response;
};
function assistantFromWire(raw) {
  const assistant = { role: 'assistant', content: null }, tools = new Map(), details = new Map();
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    const choice = JSON.parse(data).choices?.find(item => item.index === 0); if (!choice) continue;
    for (const [name, value] of Object.entries(choice.delta ?? {})) {
      if (name === 'role') continue;
      if (name === 'tool_calls') for (const delta of value) {
        const tool = tools.get(delta.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (delta.id) tool.id = delta.id;
        for (const field of ['name', 'arguments']) tool.function[field] += delta.function?.[field] ?? '';
        tools.set(delta.index, tool);
      }
      else if (name === 'reasoning_details' && Array.isArray(value)) for (const delta of value) {
        const previous = details.get(delta.index); details.set(delta.index, { ...delta, text: (previous?.text ?? '') + delta.text });
      }
      else if (typeof value === 'string') assistant[name] = (assistant[name] ?? '') + value;
      else if (!(name in assistant)) assistant[name] = value;
    }
  }
  if (tools.size) assistant.tool_calls = [...tools].sort(([a], [b]) => a - b).map(([, tool]) => tool);
  if (details.size) assistant.reasoning_details = [...details].sort(([a], [b]) => a - b).map(([, detail]) => detail);
  return assistant;
}
try {
  for (const route of routes) {
    const entry = { endpoint: route.baseUrl + '/chat/completions', model: route.modelId, protocol: 'chat-completions',
      nativeMode: route.mode, cases: [] };
    report.results.push(entry);
    const root = await mkdtemp(join(tmpdir(), 'xj-165-real-chat-'));
    const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
      postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, webRoot: resolve('apps/web/dist-runtime'), windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') } });
    let host;
    try {
      await runtime.install({ profile: 'local' }); host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication });
      const api = async (path, body) => {
        const response = await originalFetch(host.endpoint + '/api/learning/models/' + path, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
        const value = await response.json(); if (!response.ok) throw new Error('Gateway ' + response.status + ':' + value.error); return value;
      };
      const connectionId = randomUUID(); let version = 0;
      const configure = async mode => {
        const result = await api('connections', { requestId: randomUUID(), connectionId, expectedVersion: version,
          name: route.dialect, protocol: 'chat-completions', baseUrl: route.baseUrl, modelId: route.modelId, dialect: route.dialect,
          parameterMode: mode, enabled: true, path: '/chat/completions', credential: version ? { action: 'keep' } : { action: 'replace', value: credentials.get(route.dialect) } });
        version = result.version;
      };
      await configure(route.mode);
      const segment = async (system, tools = [], options = {}) => api('segments', { requestId: randomUUID(), segmentId: randomUUID(),
        source: { connectionId, version }, prefix: { system, tools, options: { ...options, capabilityProbe: true } }, portable: [] });
      const finish = async (segmentId, sequence, input) => {
        const attemptId = randomUUID(); await api('calls', { attemptId, purpose: 'chat-probe', segmentId, expectedSequence: sequence,
          input: { text: input.text ?? '', images: input.images ?? [], toolResults: input.toolResults ?? [] }, limits: report.limits.maxOutputTokens
            ? { maxOutputTokens: report.limits.maxOutputTokens, timeoutMs: report.limits.timeoutMs } : {} });
        await api('calls/' + attemptId + '/dispatch', {});
        const deadline = Date.now() + 35000;
        while (Date.now() < deadline) {
          const fact = await api('calls/' + attemptId);
          if (fact.physicalRequestEnded && fact.state !== 'accepted') return fact;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Bounded call did not physically finish');
      };
      const summarize = (name, fact, extra = {}) => {
        const evidence = { name, configVersion: fact.connection.version, state: fact.state, reason: fact.reason, usage: fact.usage,
          resultRef: fact.resultRef, physicalRequestEnded: fact.physicalRequestEnded, ...extra };
        entry.cases.push(evidence); console.log(JSON.stringify({ provider: route.dialect, ...evidence })); return evidence;
      };
      const upload = async bytes => {
        const imageId = randomUUID(); await api('images', { requestId: randomUUID(), imageId, mediaType: 'image/png', dataBase64: bytes.toString('base64') }); return { imageId, version: 1 };
      };
      const image = await upload(png(false)), returnedImage = await upload(png(true));
      const tools = [
        { name: 'read_marker', description: 'Call with the color seen in the left half of the initial image. Returns a private random marker.', inputSchema: {
          type: 'object', properties: { leftColor: { type: 'string', enum: ['red', 'blue'] } }, required: ['leftColor'], additionalProperties: false } },
        { name: 'return_image', description: 'Returns a second synthetic image to inspect after the tool result.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ];
      const active = await segment('First inspect the supplied image, then call BOTH read_marker and return_image in the same response, once each. After both results, inspect the tool image and return JSON only with nonce and leftColor. No more tools.', tools);
      const firstIndex = observed.length;
      const first = await finish(active.segmentId, 0, { text: 'Inspect this image and call both tools.', images: [image] });
      summarize('image-and-multiple-tools', first, { toolCount: first.toolIntents?.length ?? 0,
        inputImageRead: first.toolIntents?.find(tool => tool.name === 'read_marker')?.arguments.leftColor === 'red' });
      if (first.state === 'completed' && first.toolIntents?.length === 2) {
        const native = assistantFromWire(await observed[firstIndex].raw), nonce = 'XJ-' + randomUUID();
        await host.stop(); host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication });
        assert.equal((await api('calls/' + first.attemptId)).resultRef, first.resultRef);
        const secondIndex = observed.length;
        const second = await finish(active.segmentId, 1, { text: 'Use the tool marker and second image. Return JSON {"nonce":"...","leftColor":"..."}.',
          toolResults: first.toolIntents.map(tool => ({ callId: tool.callId, outcome: 'success', text: tool.name === 'read_marker' ? nonce : 'Second image from this exact tool call.', images: tool.name === 'return_image' ? [returnedImage] : [] })) });
        const replayed = observed[secondIndex]?.payload.messages.find(message => message.role === 'assistant');
        const imageTool = observed[secondIndex]?.payload.messages.findIndex(message => message.tool_call_id === first.toolIntents.find(tool => tool.name === 'return_image').callId);
        let answer; try { answer = JSON.parse(second.text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { answer = null; }
        summarize('restart-native-tool-image-replay', second, { nativePreserved: isDeepStrictEqual(native, replayed),
          nativeSha256: sha(JSON.stringify(native)), nativeFields: Object.keys(native), reasoningValue: (native.reasoning_content ?? native.reasoning) === '' ? 'empty'
            : typeof (native.reasoning_content ?? native.reasoning) === 'string' ? 'nonempty' : native.reasoning_content === null || native.reasoning === null ? 'null' : 'absent',
          correctNonce: answer?.nonce === nonce, returnedImageRead: answer?.leftColor === 'blue',
          pairedImageStrategy: observed[secondIndex]?.payload.messages[imageTool + 1]?.role === 'user',
          exactImageResourceReplay: JSON.stringify(observed[secondIndex]?.payload.messages).includes(png(false).toString('base64')) });
      }
      if (first.reason === 'authentication') { entry.stopped = 'credential-rejected'; continue; }
      await configure('plain');
      const validSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
      for (const [name, options] of [
        ['json-mode-and-application-validation', { responseFormat: { kind: 'json-object' }, applicationSchema: validSchema }],
        ['native-schema-positive', { responseFormat: { kind: 'json-schema', name: 'probe', schema: validSchema, strict: true } }],
        ['native-schema-invalid-counterexample', { responseFormat: { kind: 'json-schema', name: 'probe', schema: { type: 'invalid-native-schema-type' }, strict: true } }],
      ]) {
        const current = await segment('Return JSON only: {"ok":true}', [], options), index = observed.length;
        const fact = await finish(current.segmentId, 0, { text: 'Return the JSON object.' });
        summarize(name, fact, { upstreamStatus: observed[index]?.status ?? null });
      }
      if (route.dialect === 'deepseek') {
        await configure('thinking');
        const current = await segment('Call read_marker now.', [tools[0]], { toolChoice: { name: 'read_marker' } }), index = observed.length;
        summarize('thinking-with-forced-tool-counterexample', await finish(current.segmentId, 0, { text: 'The left half is red; call read_marker.' }), { upstreamStatus: observed[index]?.status ?? null });
      }
    } catch (error) {
      // Deliberately omit raw SDK errors, credentials, responses and reasoning from evidence/logs.
      entry.failure = error instanceof Error && /^Gateway \d+:|^Bounded call/.test(error.message) ? error.message : 'probe-assertion-or-runtime-failure';
      console.log(JSON.stringify({ provider: route.dialect, failure: entry.failure }));
    } finally { await host?.stop(); await runtime.stop(); }
  }
} finally {
  globalThis.fetch = originalFetch; report.actualGenerations = observed.length;
  const out = resolve(values.out); await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2) + '\n');
}
if (report.results.some(route => route.failure || !route.cases.some(item => item.name === 'restart-native-tool-image-replay' && item.nativePreserved && item.correctNonce && item.returnedImageRead))) process.exitCode = 1;
