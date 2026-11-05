// Explicit, bounded paid interoperability probe. No credentials or native reasoning are written to its report.
import assert from 'node:assert/strict';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime';
import { createResponsesAssembler } from '../packages/learning-space/dist/model-connections/responses-native.js';

const { values } = parseArgs({ options: { 'credentials-file': { type: 'string' }, out: { type: 'string' }, case: { type: 'string' } } });
if (!values['credentials-file'] || !values.out || !process.env.XUNJIE_PRODUCT_POSTGRES_BIN) throw new Error('Requires --credentials-file, --out and native PostgreSQL.');
if (values.case && !['native', 'schemas'].includes(values.case)) throw new Error('--case must be native or schemas.');
const document = JSON.parse(await readFile(resolve(values['credentials-file']), 'utf8'));
const provider = document.providers?.find(item => /deepseek/i.test(item.preset ?? item.name ?? '') && item.key);
if (!provider) throw new Error('Requires an authorized DeepSeek provider in the private Magpie config.');
const routes = [{ dialect: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-flash', mode: 'thinking' }];
const credentials = new Map([['deepseek', provider.key]]);
const report = { measuredAt: new Date().toISOString(), sdk: 'openai@7.42.0', adapter: 'xunjie-responses-native-v1',
  commandCode: 'waived-by-owner-2026-11-03', maxGenerations: 6,
  limits: { maxOutputTokens: 2048, timeoutMs: 30000, retries: 0 }, results: [] };
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
  if (!routes.some(route => request.url === route.baseUrl + '/responses') || request.method !== 'POST') return originalFetch(input, options);
  if (observed.length >= report.maxGenerations) throw new Error('Explicit probe generation limit reached');
  const item = { payload: JSON.parse(await request.clone().text()), endpoint: request.url, status: null, raw: Promise.resolve('') };
  observed.push(item);
  const response = await originalFetch(input, options); item.status = response.status;
  item.raw = response.clone().text().catch(() => ''); return response;
};
function responseFromWire(raw) {
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') { const value = JSON.parse(data); if (value.type === 'response.completed') return value.response; }
  }
  return null;
}

try {
  for (const route of routes) {
    const entry = { endpoint: route.baseUrl + '/responses', model: route.modelId, protocol: 'responses',
      nativeMode: route.mode, cases: [] };
    report.results.push(entry);
    const root = await mkdtemp(join(tmpdir(), 'xj-166-real-responses-'));
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
          name: route.dialect, protocol: 'responses', baseUrl: route.baseUrl, modelId: route.modelId, dialect: route.dialect,
          parameterMode: mode, enabled: true, path: '/responses', credential: version ? { action: 'keep' } : { action: 'replace', value: credentials.get(route.dialect) } });
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
        const evidence = { name, configVersion: fact.connection.version, parameterMode: fact.connection.parameterMode, state: fact.state, reason: fact.reason, usage: fact.usage,
          resultRef: fact.resultRef, physicalRequestEnded: fact.physicalRequestEnded, ...extra };
        entry.cases.push(evidence); console.log(JSON.stringify({ provider: route.dialect, ...evidence })); return evidence;
      };
      const upload = async bytes => {
        const imageId = randomUUID(); await api('images', { requestId: randomUUID(), imageId, mediaType: 'image/png', dataBase64: bytes.toString('base64') }); return { imageId, version: 1 };
      };
      if (values.case !== 'schemas') {
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
        const native = responseFromWire(await observed[firstIndex].raw), nonce = 'XJ-' + randomUUID();
        await host.stop(); host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication });
        assert.equal((await api('calls/' + first.attemptId)).resultRef, first.resultRef);
        const secondIndex = observed.length;
        const second = await finish(active.segmentId, 1, { text: 'Use the tool marker and second image. Return JSON {"nonce":"...","leftColor":"..."}.',
          toolResults: first.toolIntents.map(tool => ({ callId: tool.callId, outcome: 'success', text: tool.name === 'read_marker' ? nonce : 'Second image from this exact tool call.', images: tool.name === 'return_image' ? [returnedImage] : [] })) });
        const wire = observed[secondIndex]?.payload;
        const replayed = wire?.input.slice(observed[firstIndex].payload.input.length, observed[firstIndex].payload.input.length + native.output.length);
        const imageTool = wire?.input.find(item => item.type === 'function_call_output' && item.call_id === first.toolIntents.find(tool => tool.name === 'return_image').callId);
        let answer; try { answer = JSON.parse(second.text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { answer = null; }
        const reasoning = native.output.filter(item => item.type === 'reasoning');
        summarize('restart-native-tool-image-replay', second, { nativePreserved: isDeepStrictEqual(native.output, replayed),
          nativeSha256: sha(JSON.stringify(native.output)), nativeItemTypes: native.output.map(item => item.type),
          reasoningValue: reasoning.some(item => JSON.stringify([item.content,item.summary]).length > 20) ? 'nonempty' : 'empty-or-absent',
          correctNonce: answer?.nonce === nonce, returnedImageRead: answer?.leftColor === 'blue',
          nativeToolImage: Array.isArray(imageTool?.output) && imageTool.output.some(part => part.type === 'input_image' && part.image_url === 'data:image/png;base64,' + png(true).toString('base64')),
          exactImageResourceReplay: JSON.stringify(wire?.input).includes(png(false).toString('base64')),
          stateless: wire?.store === false && !('previous_response_id' in wire) && !('conversation' in wire) && !('background' in wire) });
      }
      if (first.reason === 'authentication') { entry.stopped = 'credential-rejected'; continue; }
      if (first.reason === 'malformed-response') {
        const assembler = createResponsesAssembler();
        for (const event of (await observed[firstIndex].raw).split(/\r?\n\r?\n/)) {
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          const value = JSON.parse(data);
          try { assembler.add(value); } catch {
            const shape = value => Array.isArray(value) ? value.map(shape) : value && typeof value === 'object'
              ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'type' || key === 'status' || key === 'object' ? item : shape(item)])) : typeof value;
            entry.rejectedEventShape = shape(value); break;
          }
        }
        throw new Error('Native stream validation failed');
      }
      if (values.case === 'native') continue;
      }
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
        const tools = [{ name: 'read_marker', description: 'Return the observed left color.', inputSchema: {
          type: 'object', properties: { leftColor: { type: 'string', enum: ['red', 'blue'] } }, required: ['leftColor'], additionalProperties: false } }];
        const current = await segment('Call read_marker now.', [tools[0]], { toolChoice: { name: 'read_marker' } }), index = observed.length;
        summarize('thinking-with-forced-tool-counterexample', await finish(current.segmentId, 0, { text: 'The left half is red; call read_marker.' }), { upstreamStatus: observed[index]?.status ?? null });
      }
      if (values.case === 'schemas') {
        await configure('plain');
        for (const [name, schema] of [
          ['strict-tool-positive', { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }],
          ['strict-tool-native-schema-counterexample', { type: 'object', properties: { value: { oneOf: [{ type: 'string' }, { type: 'number' }] } }, required: ['value'], additionalProperties: false }],
        ]) {
          const current = await segment('Call read_value once with value hello.', [{ name: 'read_value', description: 'Synthetic, no effects.', inputSchema: schema, strict: true }], { toolChoice: { name: 'read_value' } });
          const index = observed.length, fact = await finish(current.segmentId, 0, { text: 'Call the tool now.' });
          summarize(name, fact, { upstreamStatus: observed[index]?.status ?? null, toolCount: fact.toolIntents?.length ?? 0,
            strictWire: observed[index]?.payload.tools?.[0]?.strict === true });
        }
      }
    } catch (error) {
      // Deliberately omit raw SDK errors, credentials, responses and reasoning from evidence/logs.
      entry.failure = error instanceof Error && /^Gateway \d+:|^Bounded call/.test(error.message) ? error.message : 'probe-assertion-or-runtime-failure';
      console.log(JSON.stringify({ provider: route.dialect, failure: entry.failure }));
    } finally { await host?.stop(); await runtime.stop(); await rm(root, { recursive: true, force: true }); }
  }
} finally {
  globalThis.fetch = originalFetch; report.actualGenerations = observed.length;
  const out = resolve(values.out); await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2) + '\n');
}
if (report.results.some(route => {
  if (route.failure) return true;
  if (values.case !== 'schemas') {
    const first = route.cases.find(item => item.name === 'image-and-multiple-tools');
    const replay = route.cases.find(item => item.name === 'restart-native-tool-image-replay');
    if (!(first?.state === 'completed' && first.toolCount === 2 && first.inputImageRead && replay?.state === 'completed'
      && replay.nativePreserved && replay.correctNonce && replay.returnedImageRead && replay.nativeToolImage
      && replay.exactImageResourceReplay && replay.stateless)) return true;
  }
  return values.case !== 'native' && (
    !['json-mode-and-application-validation', 'native-schema-positive'].every(name => route.cases.some(item => item.name === name && item.state === 'completed'))
    || !route.cases.some(item => item.name === 'native-schema-invalid-counterexample' && item.state === 'failed' && item.upstreamStatus === 400));
})) process.exitCode = 1;
