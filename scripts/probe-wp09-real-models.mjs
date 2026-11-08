import { probeEvidenceFile, writeEvidence, captureEvidence, hasProbeEvidence } from './lib/probe-evidence.mjs';
// Bounded real DeepSeek acceptance through ActionIntent -> RunDriver -> ModelGateway -> artifact owner.
// The only transport adaptation is local to this probe. Never log payloads, provider bodies or Errors.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import dns from 'node:dns/promises';
import socketDns from 'node:dns';
import https from 'node:https';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';

const { values: args } = parseArgs({ options: {
  'output': { type: 'string' }, 'evidence-dir': { type: 'string' },
  product: { type: 'string' }, 'product-minimal': { type: 'boolean' }, 'budget-from': { type: 'string' },
  alu: { type: 'boolean' }, screenshots: { type: 'boolean' }, 'browser-only': { type: 'boolean' }, 'keep-root': { type: 'boolean' }, out: { type: 'string' }, root: { type: 'string' }, resume: { type: 'string' },
  'credentials-file': { type: 'string', default: join(homedir(), '.config/magpie/providers.json') },
  'candidates-only': { type: 'boolean' }, 'prepare-only': { type: 'boolean' }, help: { type: 'boolean' },
} });
const zeroModelResume = !!args.product && !!args.resume;
const limits = Object.freeze({ maxGenerations: 24, maxOutputTokens: 8192, providerDeadlineMs: 60000, retries: 0 });
const protocols = args['product-minimal'] ? ['chat-completions'] : ['chat-completions', 'responses', 'messages'];
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const safe = error => error instanceof assert.AssertionError ? 'acceptance-assertion'
  : error?.name === 'TimeoutError' ? 'browser-timeout'
  : typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(error.code) ? error.code : 'probe-operation-failed';
const publicReason = reason => typeof reason === 'string' && /^[A-Za-z0-9_-]{0,200}$/.test(reason) ? reason : 'unclassified';
const delay = ms => new Promise(done => setTimeout(done, ms));
const paths = { 'chat-completions': '/v1/chat/completions', responses: '/v1/responses', messages: '/anthropic/v1/messages' };
const meaning = '学生对二进制位宽的解释';
const sdkReady = payload => {
  const systems = [payload.instructions, payload.system, ...(payload.messages ?? []).filter(item => item.role === 'system').map(item => item.content)];
  const text = JSON.stringify(systems);
  return text.includes('window.xunjie v1:') && text.includes('window.xunjie.read()') && text.includes('semanticFields');
};
if (args.help) {
  console.log(`Usage: NODE_24_21 scripts/probe-wp09-real-models.mjs [--product DIR] [--out JSON]
  [--root PRIVATE_DIR] [--credentials-file PRIVATE_JSON] [--prepare-only | --candidates-only | --resume JSON]
  [--alu] [--keep-root] [--screenshots] [--product-minimal --product DIR --budget-from LATEST_JSON]
Requires built production packages (no build is run here), PG 18.6 and desktop Chrome for full mode.
--product reads app/product-runtime.js and resources.json from the actual package.
--prepare-only checks the output contract and real unauthenticated TLS, using zero generations.
--candidates-only requires --root, keeps that isolated environment for --resume, and does not claim adoption.
--resume requires the same --root and completes Chrome adoption/state/restart plus a cross-route revision.
--product + --resume disables all new model generations, reopens original artifacts (including ALU), and retains the root.
--screenshots captures the actual product center at 1440x1000 in light and dark themes.
--alu reserves at most 3 remaining calls for a real ALU course candidate; it does not execute or fill predictions.
--keep-root retains the stopped private environment for the owning Agent's follow-up.
--product-minimal verifies one real Chat generation, adoption, input and restart, sharing --budget-from's 24-call cap.
All phases share the original evidence's hard 24-request budget; SDK retries remain zero.
No model stub, direct artifact publication, provider response, thinking or credential is written.`);
  process.exit(0);
}
check(!args['product-minimal'] || args.product, 'minimal-requires-product-package');
check(!args.resume || args.root, 'resume-requires-original-private-root');
check(!args['candidates-only'] || args.root, 'candidate-stage-requires-private-root');

const output = probeEvidenceFile(args.out, 'real-models.json');
const product = args.product ? resolve(args.product) : null;
const sourceBytes = await readFile(new URL(import.meta.url));
const inheritedBudget = args['budget-from'] ? JSON.parse(await readFile(resolve(args['budget-from']), 'utf8')) : null;
let report = args.resume ? JSON.parse(await readFile(resolve(args.resume), 'utf8')) : {
  formatVersion: 1, startedAt: new Date().toISOString(), status: 'preparing', node: process.version, platform: process.platform,
  probeSha256: hash(sourceBytes), limits, provider: 'api.deepseek.com', modelId: 'deepseek-flash',
  requests: inheritedBudget ? structuredClone(inheritedBudget.requests) : [], refusals: [], http: {}, routes: [], stages: [], browser: { status: 'not-run' }, crossRoute: { status: 'not-run' },
};
check(report.formatVersion === 1 && report.limits.maxGenerations === 24 && report.requests.length <= 24, 'invalid-resume-evidence');
let writes = Promise.resolve();
async function persist() {
  await mkdir(dirname(output), { recursive: true });
  // Reports contain whitelisted facts only. Serialize writes so concurrent transport/HTTP updates cannot truncate each other.
  const bytes = JSON.stringify(report, null, 2) + '\n';
  const pending = writes.then(() => writeEvidence(output, bytes));
  writes = pending.catch(() => {}); await pending;
}
async function stage(name, operation) {
  const entry = { name, status: 'running' }; report.stages.push(entry); await persist();
  try { const value = await operation(); entry.status = 'passed'; await persist(); return value; }
  catch (error) { entry.status = 'failed'; entry.reason = safe(error); await persist(); throw error; }
}
const originalFetch = globalThis.fetch, originalLookup = dns.lookup, nativeSocketLookup = socketDns.lookup;
let key = '', host, runtime, browser, page, root, environmentId, keepRoot = zeroModelResume || !!args['candidates-only'] || !!args['keep-root'] || !!args.alu;
let actorHeaders = { 'x-xj-space': 'personal' };
const invocationStartRequests = report.requests.length;
const latestPhase = row => row.revise?.artifact ? row.revise : row.generate;
let activeStage = null, transportRestore = () => {};
const sockets = new Set(), browserFacts = new Set();
const routeRows = report.routes;
(report.invocations ??= []).push({ at: new Date().toISOString(), probeSha256: hash(sourceBytes), mode: args['prepare-only'] ? 'prepare' : args['candidates-only'] ? 'candidates' : args.resume ? 'resume-browser' : 'full' });
const setExpected = (artifact, text) => {
  Object.defineProperty(artifact, 'expectedExplanation', { value: text, enumerable: false, configurable: true, writable: true });
  if (text !== undefined) artifact.explanationSha256 = hash(text);
};
let runtimeModule, resources, installedConfigurationSha256;
async function api(route, body, headers = {}) {
  const response = await originalFetch(host.endpoint + '/api/learning/' + route, {
    headers: { 'content-type': 'application/json', ...actorHeaders, ...headers }, redirect: 'error', signal: AbortSignal.timeout(30000),
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const method = body === undefined ? 'GET' : 'POST';
  const category = route.replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, ':id');
  const counter = method + ' ' + category + ' ' + response.status;
  report.http[counter] = (report.http[counter] ?? 0) + 1;
  const value = await response.json();
  check(response.status === 200, 'http-' + response.status);
  return value;
}
async function tlsPreflight() {
  return new Promise((done, reject) => {
    const req = https.get('https://api.deepseek.com/v1/models', { rejectUnauthorized: true, lookup: nativeSocketLookup, timeout: 10000 }, incoming => {
      const socket = incoming.socket;
      const info = { httpStatus: incoming.statusCode, authorized: socket.authorized === true, protocol: socket.getProtocol(), servername: 'api.deepseek.com' };
      incoming.resume(); incoming.on('end', () => info.authorized ? done(info) : reject(Object.assign(new Error(), { code: 'tls-not-authorized' })));
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(), { code: 'tls-preflight-deadline' })), 12000);
    req.on('close', () => clearTimeout(timer)); req.on('timeout', () => req.destroy(Object.assign(new Error(), { code: 'tls-preflight-timeout' })));
    req.on('error', reject);
  });
}
function installTransport(classificationShim) {
  // The synthetic DNS result is only replaced for model target classification. The actual socket
  // still resolves api.deepseek.com through the native OS resolver with original SNI and TLS checks.
  if (classificationShim) {
    dns.lookup = async (name, options) => name === 'api.deepseek.com'
      ? options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 }
      : originalLookup(name, options);
    syncBuiltinESMExports();
  }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname !== 'api.deepseek.com') return originalFetch(input, init);
    let item, upstream;
    try {
      check(!zeroModelResume, 'generation-disabled-for-product-resume');
      check(request.method === 'POST' && Object.values(paths).includes(url.pathname) && url.protocol === 'https:', 'unexpected-provider-operation');
      check(report.requests.length < limits.maxGenerations, 'generation-budget-exhausted');
      check(request.headers.get('authorization') === 'Bearer ' + key || request.headers.get('x-api-key') === key, 'provider-credential-mismatch');
      const bytes = Buffer.from(await request.arrayBuffer()); check(bytes.length <= 4_000_000, 'provider-request-too-large');
      const payload = JSON.parse(bytes), outputTokens = payload.max_tokens ?? payload.max_output_tokens;
      check(activeStage !== 'real-alu-course:generate' || report.requests.filter(item => item.phase === activeStage).length < 3, 'alu-generation-reserve-exhausted');
      check(payload.model === report.modelId && payload.stream === true && Number.isInteger(outputTokens) && outputTokens > 0 && outputTokens <= limits.maxOutputTokens, 'provider-output-limit');
      check(sdkReady(payload), 'sdk-contract-not-in-actual-prompt');
      const nativeTools = payload.tools ?? [];
      check(nativeTools.some(tool => (tool.function?.name ?? tool.name) === 'generate_teaching_artifact'), 'generator-not-in-actual-payload');
      check(!nativeTools.some(tool => tool.progress || tool.function?.progress), 'progress-metadata-leaked-to-supplier');
      const started = Date.now();
      item = { index: report.requests.length + 1, phase: activeStage, protocol: Object.keys(paths).find(protocol => paths[protocol] === url.pathname),
        path: url.pathname, payloadSha256: digest(payload), toolSchemaSha256: digest(nativeTools), maxOutputTokens: outputTokens,
        httpStatus: null, sent: false, finished: false, tls: null, responseBytes: 0 };
      report.requests.push(item); await persist(); // Reserve the budget before any supplier write.
      return await new Promise((resolveRequest, reject) => {
        let incoming, resolved = false, timer;
        const fail = error => {
          item.reason ??= safe(error); item.elapsedMs = Date.now() - started;
          if (!resolved) reject(Object.assign(new Error(), { code: item.reason }));
          incoming?.destroy(); upstream?.destroy();
        };
        upstream = https.request(url, { method: 'POST', headers: { ...Object.fromEntries(request.headers), 'accept-encoding': 'identity', 'content-length': bytes.length },
          rejectUnauthorized: true, lookup: nativeSocketLookup, timeout: limits.providerDeadlineMs }, response => {
          incoming = response; item.httpStatus = response.statusCode;
          const socket = response.socket;
          item.tls = { authorized: socket.authorized === true, protocol: socket.getProtocol(), servername: url.hostname };
          if (!item.tls.authorized) { fail(Object.assign(new Error(), { code: 'tls-not-authorized' })); return; }
          response.on('data', chunk => { item.responseBytes += chunk.length; });
          response.on('end', () => { item.finished = true; item.elapsedMs = Date.now() - started; });
          response.on('error', error => { item.reason ??= safe(error); });
          resolved = true;
          resolveRequest(new Response(Readable.toWeb(response), { status: response.statusCode, headers: { 'content-type': response.headers['content-type'] ?? 'text/event-stream' } }));
        });
        sockets.add(upstream);
        const abort = () => fail(Object.assign(new Error(), { code: 'provider-aborted' }));
        timer = setTimeout(() => fail(Object.assign(new Error(), { code: 'provider-deadline' })), limits.providerDeadlineMs);
        upstream.on('timeout', () => fail(Object.assign(new Error(), { code: 'provider-timeout' })));
        upstream.on('error', fail);
        upstream.on('close', () => { clearTimeout(timer); sockets.delete(upstream); request.signal.removeEventListener('abort', abort); });
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
        else { item.sent = true; upstream.end(bytes); }
      });
    } catch (error) {
      report.refusals.push({ phase: activeStage, reason: safe(error) });
      if (item) item.reason ??= safe(error);
      throw Object.assign(new Error(), { code: safe(error) });
    }
  };
  transportRestore = () => { globalThis.fetch = originalFetch; dns.lookup = originalLookup; syncBuiltinESMExports(); };
}
function basePrompt() {
  return `请实际使用当前 generate_teaching_artifact 工具制作一个很小、能操作的中文教学示意卡；不要在对话里粘贴代码。
页面只有一小段二进制位宽说明和一个带 label/aria-label=我的解释 的 textarea。不要额外按钮、输入、网络、外部库或模型请求。
唯一状态固定为 explanation:string(maxLength=1000)，initialState={explanation:''}，stateVersion=1；semanticFields 只有 {key:'explanation',meaning:'${meaning}'}。
requiredCapabilities 只有 workspace.read、workspace.change；semanticObjects=[]。按宿主 SDK 先 await window.xunjie.read() 恢复 textarea，再监听 input 并用 window.xunjie.change({explanation:textarea.value}) 保存整个状态；处理 Promise 失败，不在初始化时覆盖原状态。
html 先写，只含正文；样式写 css，所有脚本写 javascript 的 async IIFE，不用 html 内 script/on*。说明生成值仅为教学示意。
不要 discover/load/ask/执行实验；工具当前已提供。只调用一次生成，成功后一句话确认即可。`;
}
function revisePrompt(fixed, cross = false) {
  return `请${cross ? '在已切换的当前模型路线继续原产物，' : ''}先实际调用 read_teaching_artifact({artifactId:'${fixed.artifactId}',revisionId:'${fixed.revisionId}'})，再调用一次 generate_teaching_artifact 修订该固定版本。
只在原卡片中加一句${cross ? '“跨路线补充：说明仍是教学示意。”' : '“补充：位宽增加一位，可表示的组合数加倍。”'}。artifactId 必须仍为 ${fixed.artifactId}，parentRevisionId 必须为 ${fixed.revisionId}。
保留原 HTML 控件、SDK 恢复/事件逻辑、stateVersion、stateShape、initialState、semanticFields 的字段名、上限、含义；不增加或删除任何状态字段，不覆盖学生 explanation，mapping=[]。不要调用其他工具或提问；生成一次成功后一句话确认。`;
}
async function select(protocol) {
  const version = (await api('models/selection')).version;
  const spaceKind = actorHeaders['x-xj-space'];
  let connection = report.connections?.find(item => item.protocol === protocol && (item.spaceKind ?? 'personal') === spaceKind);
  if (!connection) {
    const connectionId = randomUUID(), grantId = randomUUID();
    const saved = await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'WP09 real ' + protocol,
      protocol, baseUrl: 'https://api.deepseek.com/' + (protocol === 'messages' ? 'anthropic' : 'v1'), path: paths[protocol].slice(protocol === 'messages' ? '/anthropic'.length : '/v1'.length),
      modelId: report.modelId, dialect: 'deepseek', parameterMode: 'thinking', enabled: true, contextWindow: 262144,
      maxOutputTokens: limits.maxOutputTokens, credential: { action: 'replace', value: key } });
    check(saved.adapterState === 'ready', 'model-adapter-unavailable');
    await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
    connection = { protocol, spaceKind, connectionId, grantId, version: saved.version }; (report.connections ??= []).push(connection);
  }
  const selected = await api('models/selection', { requestId: randomUUID(), expectedVersion: version,
    source: { kind: 'personal', connectionId: connection.connectionId, grantId: connection.grantId } });
  return selected.version;
}
async function runIntent(activity, question, record) {
  const base = `agent/${activity.activityId}`, receiver = (await api(base + '/capabilities')).receiver;
  const input = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
    principalId: activity.identity.principalId, activityId: activity.activityId }, receiver,
    draft: { token: randomUUID(), question, references: [], bases: [] }, works: [], evidence: [] };
  input.requestId = record.requestId ?? input.requestId;
  record.requestId = input.requestId; record.promptSha256 ??= hash(question);
  const before = record.requestIndexStart ?? report.requests.filter(item => item.phase !== activeStage).length; record.requestIndexStart = before;
  let runId = record.runId;
  if (!runId) {
    await api(`intents/${activity.activityId}`, input);
    const dispatched = await api(`intents/${activity.activityId}/${input.requestId}/dispatch`, {});
    check(dispatched.state === 'accepted', 'intent-not-accepted');
    runId = JSON.parse(dispatched.receipt.detail).runId; record.runId = runId;
  }
  const deadline = Date.now() + 240000;
  let conversation, run;
  while (Date.now() < deadline) {
    conversation = await api(base + '/conversation'); run = conversation.runs.find(item => item.runId === runId);
    if (run?.state === 'completed') break;
    if (run && ['failed', 'stopped', 'paused', 'waiting'].includes(run.state)) break;
    await delay(200);
  }
  record.state = run?.state ?? 'missing'; record.reason = publicReason(run?.reason); record.usage = run?.usage ?? null;
  const events = await api(base + '/events');
  record.snapshots = [];
  for (const event of events.filter(item => item.body?.runId === runId && item.kind === 'context-assembled')) {
    const snapshot = await api(base + '/snapshots/' + event.body.snapshotId);
    const payloadSha256 = digest(snapshot.payload);
    check(payloadSha256 === snapshot.payloadSha256 && report.requests.some(item => item.payloadSha256 === payloadSha256), 'snapshot-not-matched-to-actual-transport');
    check(snapshot.resolvedAgent.definition.budgetPolicy.retryLimit === 0 && sdkReady(snapshot.payload), 'snapshot-output-contract-not-fixed');
    record.snapshots.push({ snapshotId: snapshot.snapshotId, attemptId: snapshot.attemptId, segmentId: snapshot.segmentId,
      payloadSha256, resolvedId: snapshot.resolvedAgent.resolvedId, definitionVersion: snapshot.resolvedAgent.definition.version,
      contextManifestId: snapshot.contextManifest.manifestId });
  }
  const commands = conversation.tools.filter(item => item.runId === runId);
  record.tools = commands.map(item => ({ commandId: item.commandId, name: item.name, outcome: item.outcome }));
  record.newModelRequests = report.requests.length - before;
  record.transportIndices = record.snapshots.map(snapshot => report.requests.find(item => item.payloadSha256 === snapshot.payloadSha256)?.index);
  record.modelRequests = record.transportIndices.length;
  check(run?.state === 'completed', 'run-' + publicReason(run?.state) + '-' + publicReason(run?.reason));
  for (const snapshot of record.snapshots) {
    const transport = report.requests.find(item => item.payloadSha256 === snapshot.payloadSha256);
    transport.terminalVerifiedBy = 'completed original Run and matching immutable snapshot';
    if (transport.reason === 'ECONNRESET') {
      transport.streamClosure = 'consumer-cancelled-after-protocol-terminal'; delete transport.reason;
    }
  }
  const generated = commands.filter(item => item.name === 'generate_teaching_artifact' && item.outcome === 'completed');
  check(generated.length === 1, 'expected-one-original-artifact-command');
  const receipt = generated[0].result?.artifact; check(receipt?.kind === 'publish' && receipt.outcome === 'candidate', 'missing-original-artifact-receipt');
  const candidate = await api(`artifacts/${activity.activityId}/candidates/${receipt.candidateId}`);
  const fixed = await api(`artifacts/${activity.activityId}/${receipt.artifactId}/revisions/${receipt.revisionId}`);
  const resource = await api(`artifacts/${activity.activityId}/${receipt.artifactId}/revisions/${receipt.revisionId}/resource`);
  const bytes = Buffer.from(resource.contentBase64, 'base64');
  check(resource.sha256 === fixed.sha256 && hash(bytes) === fixed.sha256 && bytes.length === fixed.byteLength, 'fixed-artifact-resource-mismatch');
  const origin = fixed.origin;
  check(origin?.runId === runId && origin.commandId === generated[0].commandId && record.snapshots.some(item => item.snapshotId === origin.snapshotId && item.attemptId === origin.attemptId), 'artifact-original-source-mismatch');
  record.artifact = { artifactId: fixed.artifactId, revisionId: fixed.revisionId, candidateId: candidate.candidateId, version: fixed.version,
    parentRevisionId: fixed.parentRevisionId, resourceId: fixed.resourceId, sha256: fixed.sha256, byteLength: fixed.byteLength,
    payloadSha256: digest(fixed.payload), stateShapeSha256: digest(fixed.payload.stateShape), semanticFieldsSha256: digest(fixed.payload.semanticFields),
    status: candidate.status, checks: candidate.checks.map(item => ({ code: item.code, passed: item.passed })), origin };
  record.publicConversationSha256 = digest(conversation);
  check(candidate.checks.filter(item => item.code !== 'browser-roundtrip').every(item => item.passed), 'candidate-static-check-failed');
  check(digest(fixed.payload.stateShape) === digest({ type: 'object', properties: { explanation: { type: 'string', maxLength: 1000 } } })
    && digest(fixed.payload.semanticFields) === digest([{ key: 'explanation', meaning }]) && fixed.payload.stateVersion === 1, 'explicit-state-meaning-not-preserved');
  return { fixed, commands, record };
}
async function preparePackagedResume() {
  const bytes = await readFile(join(root, 'installation.json'));
  installedConfigurationSha256 = hash(bytes);
  const installed = JSON.parse(bytes).resources;
  const nodeSha256 = hash(await readFile(resources.nodePath));
  const postgresName = process.platform === 'win32' ? 'postgres.exe' : 'postgres';
  const postgresSha256 = hash(await readFile(join(resources.postgresBin, postgresName)));
  check(hash(await readFile(installed.nodePath)) === nodeSha256
    && hash(await readFile(join(installed.postgresBin, postgresName))) === postgresSha256, 'resume-native-resource-bytes-differ');
  check(hash(await readFile(process.execPath)) === nodeSha256, 'probe-not-running-packaged-node-bytes');
  report.productResume = { status: 'running', generationPolicy: 'deny-all-provider-generations', originalEnvironmentId: report.environmentId,
    distributionSha256: report.currentBuild.distributionSha256, runtimeSha256: report.currentBuild.runtimeSha256,
    nodeSha256, postgresSha256, savedNativeResourcesEqualPackage: true, webComposition: 'package webRoot in host memory; saved installation retained' };
}
async function createHost() {
  const created = await runtimeModule.createProductRuntimeHost({ root, createApplication: context => {
    // Resume composes the package's app and Web over the original owner data. Native resources
    // were byte-checked against the package; do not rewrite an installation just to select Web.
    if (zeroModelResume) context.configuration.resources.webRoot = resources.webRoot;
    return runtimeModule.createProductLearningApplication(context);
  } });
  if (zeroModelResume) {
    const response = await originalFetch(created.endpoint + '/');
    check(response.status === 200, 'package-index-unavailable');
    const bytes = Buffer.from(await response.arrayBuffer());
    check(hash(bytes) === report.currentBuild.webIndexSha256, 'actual-web-is-not-package-web');
    const entry = /src="([^"<>]+\.js)"/.exec(bytes.toString('utf8'))?.[1];
    check(entry?.startsWith('/assets/'), 'package-script-entry-missing');
    const actual = await originalFetch(created.endpoint + entry);
    const servedSha256 = hash(Buffer.from(await actual.arrayBuffer()));
    check(actual.status === 200 && servedSha256 === hash(await readFile(join(resources.webRoot, entry))), 'actual-web-entry-is-not-package-entry');
    (report.productResume.hosts ??= []).push({ servedIndexSha256: hash(bytes), entry, servedEntrySha256: servedSha256 });
  }
  return created;
}
async function verifyExistingAlu() {
  if (!report.alu?.artifact) return;
  const previous = actorHeaders;
  try {
    const handoff = JSON.parse(await readFile(join(root, 'wp09-real-models-handoff.private.json'), 'utf8'));
    const logged = await originalFetch(host.endpoint + '/api/learning/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginName: handoff.loginName, password: handoff.password }) });
    check(logged.status === 200, 'original-alu-login-unavailable');
    actorHeaders = { 'x-xj-space': 'school', cookie: logged.headers.get('set-cookie').split(';')[0] };
    const alu = report.alu, artifact = alu.artifact, base = `artifacts/${alu.activityId}`;
    const revision = await api(`${base}/${artifact.artifactId}/revisions/${artifact.revisionId}`);
    const candidate = await api(`${base}/candidates/${artifact.candidateId}`);
    const resource = await api(`${base}/${artifact.artifactId}/revisions/${artifact.revisionId}/resource`);
    const conversation = await api('agent/' + alu.activityId + '/conversation');
    check(revision.sha256 === artifact.sha256 && hash(Buffer.from(resource.contentBase64, 'base64')) === artifact.sha256
      && digest(revision.origin) === digest(artifact.origin), 'original-alu-version-or-source-changed');
    check(conversation.runs.some(run => run.runId === alu.runId && run.requestId === alu.requestId && run.state === 'completed')
      && conversation.tools.some(tool => tool.commandId === artifact.origin.commandId && tool.outcome === 'completed'), 'original-alu-run-or-command-changed');
    alu.productReopen = { status: 'passed', candidateId: candidate.candidateId, candidateStatus: candidate.status,
      revisionId: revision.revisionId, sha256: revision.sha256, originalRunId: alu.runId, originalCommandId: artifact.origin.commandId, newModelRequests: 0 };
  } finally { actorHeaders = previous; }
}
async function captureScreenshots() {
  if (!hasProbeEvidence(output)) return;
  const { expect } = await import('@playwright/test');
  const row = routeRows.find(item => item.protocol === 'responses') ?? routeRows[0];
  const artifact = report.crossRoute.activityId === row.activityId && report.crossRoute.artifact ? report.crossRoute.artifact : latestPhase(row).artifact;
  report.screenshots = [];
  for (const [theme, label] of [['light', '浅色'], ['dark', '深色']]) {
    // The immersive activity hides the global theme controls. Use the formal home menu,
    // then reopen the same fixed artifact; never rewrite DOM colors for a screenshot.
    await page.goto(host.endpoint + '/');
    await page.getByRole('button', { name: /^外观 · / }).filter({ visible: true }).first().click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await openPage(row.activityId); await adoptAndEdit(row.activityId, artifact);
    await page.locator('.teaching-artifact-card[data-artifact-id="' + artifact.artifactId + '"]').first().getByRole('button', { name: '在工具区打开', exact: true }).click();
    const center = page.locator('.teaching-artifact-center[data-artifact-id="' + artifact.artifactId + '"]');
    const input = center.frameLocator('iframe').getByRole('textbox', { name: '我的解释', exact: true });
    await expect(input).toHaveValue(artifact.expectedExplanation);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.evaluate(() => document.fonts.ready); await delay(150);
    const name = 'real-models-product-' + theme + '.png', target = join(dirname(output), name);
    await captureEvidence(page, { path: target, fullPage: false, animations: 'disabled' });
    report.screenshots.push({ file: name, theme, viewport: { width: 1440, height: 1000 }, activityId: row.activityId,
      artifactId: artifact.artifactId, revisionId: artifact.revisionId, resourceSha256: artifact.sha256, sha256: hash(await readFile(target)) });
    await center.getByRole('button', { name: '关闭页面', exact: true }).click();
    await expect(center).toHaveCount(0);
  }
}
async function assertDefinitionContinuity() {
  if (!args.resume || product) return;
  const row = routeRows[0], original = await api(`agent/${row.activityId}/snapshots/${row.generate.artifact.origin.snapshotId}`);
  const { learningAgentDefinition } = await import(pathToFileURL(resolve('packages/learning-space/dist/teaching-agent/assembly.js')).href);
  const fixed = original.resolvedAgent;
  report.definitionContinuity = { originalVersion: fixed.definition.version, originalDigest: fixed.definitionDigest,
    currentVersion: learningAgentDefinition.version, currentDigest: digest(learningAgentDefinition) };
  check(fixed.definition.version !== learningAgentDefinition.version || fixed.definitionDigest === digest(learningAgentDefinition), 'agent-definition-version-reused');
}
async function openPage(activityId) {
  const { expect } = await import('@playwright/test');
  await page.bringToFront();
  await page.goto(host.endpoint + '/?space=' + actorHeaders['x-xj-space'] + '&activity=' + activityId);
  await expect(page.locator('#activity-title')).toBeVisible({ timeout: 15000 });
  const toggle = page.getByRole('button', { name: /^(打开对话|问题与引用)$/ });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(page.getByRole('region', { name: '与 Agent 的对话', exact: true })).toBeVisible();
}
async function adoptAndEdit(activityId, artifact, text) {
  const { expect } = await import('@playwright/test');
  const calls = report.requests.length;
  await page.bringToFront();
  const card = page.locator('.teaching-artifact-card[data-artifact-id="' + artifact.artifactId + '"]').first();
  let retried = false;
  await expect.poll(async () => {
    const current = await api(`artifacts/${activityId}/${artifact.artifactId}`);
    if (current.activeRevisionId === artifact.revisionId) return current.activeRevisionId;
    const candidate = await api(`artifacts/${activityId}/candidates/${artifact.candidateId}`);
    artifact.browserCheck = { status: candidate.status, checks: candidate.checks.map(item => ({ code: item.code, passed: item.passed })) };
    if (candidate.status === 'check-failed') {
      const retry = card.getByRole('button', { name: '重试页面', exact: true });
      if (!retried && await retry.isVisible()) { await retry.click(); retried = true; }
      else if (retried) check(false, 'browser-candidate-check-failed');
    }
    return current.activeRevisionId;
  }, { timeout: 20000, intervals: [200, 500, 1000] }).toBe(artifact.revisionId);
  const candidate = await api(`artifacts/${activityId}/candidates/${artifact.candidateId}`);
  artifact.browserCheck = { status: candidate.status, checks: candidate.checks.map(item => ({ code: item.code, passed: item.passed })) };
  check(candidate.status === 'adopted' && candidate.checks.every(item => item.passed), 'browser-check-and-adopt-not-complete');
  await expect(card).toHaveAttribute('data-revision-id', artifact.revisionId);
  const input = card.frameLocator('iframe[sandbox="allow-scripts"]').getByRole('textbox', { name: '我的解释', exact: true });
  await expect(input).toBeEditable({ timeout: 10000 });
  if (text !== undefined) {
    await input.fill(text); await page.locator('#activity-title').click();
  }
  const expected = text ?? artifact.expectedExplanation;
  if (expected !== undefined) {
    await expect(input).toHaveValue(expected);
    await expect.poll(async () => {
      const workspace = await api('workspaces/' + activityId);
      const content = workspace.files.find(file => file.name === 'components/artifact-' + artifact.artifactId + '.json');
      return content ? JSON.parse(content.value).content?.explanation : null;
    }, { timeout: 10000 }).toBe(expected);
  }
  setExpected(artifact, expected);
  artifact.status = 'adopted'; artifact.browserChecked = true;
  check(report.requests.length === calls, 'local-input-generated-model-request');
  return { card, input };
}
async function verifyBrowserRecovery(row, artifact, writeInput = false) {
  const { expect } = await import('@playwright/test');
  const calls = report.requests.length;
  row.chrome = { adoptedRevisionId: artifact.revisionId, steps: [] };
  const step = async (name, operation) => {
    row.chrome.currentStep = name;
    await operation(); row.chrome.steps.push({ name, status: 'passed' }); await persist();
  };
  const text = writeInput ? '我的解释：重开后沿用同一原产物。' + row.protocol : undefined;
  await step('adopt-and-save-chinese-input', () => adoptAndEdit(row.activityId, artifact, text));
  await step('refresh-restores-input', async () => { await openPage(row.activityId); await adoptAndEdit(row.activityId, artifact); });
  await step('open-center-restores-input', async () => {
    const card = page.locator('.teaching-artifact-card[data-artifact-id="' + artifact.artifactId + '"]').first();
    await card.getByRole('button', { name: '在工具区打开', exact: true }).click();
    const center = page.locator('.teaching-artifact-center[data-artifact-id="' + artifact.artifactId + '"]');
    await expect(center.frameLocator('iframe').getByRole('textbox', { name: '我的解释', exact: true })).toHaveValue(artifact.expectedExplanation, { timeout: 10000 });
  });
  await step('close-center-restores-inline-input', async () => {
    const center = page.locator('.teaching-artifact-center[data-artifact-id="' + artifact.artifactId + '"]');
    await center.getByRole('button', { name: '关闭页面', exact: true }).click();
    await adoptAndEdit(row.activityId, artifact);
  });
  check(report.requests.length === calls, 'page-reopen-generated-model-request');
  Object.assign(row.chrome, { editable: true, chineseInputPersisted: true, refreshRestored: true, centerOpenCloseRestored: true,
    explanationSha256: artifact.explanationSha256, newModelRequests: 0 }); delete row.chrome.currentStep;
}
async function browserDiagnostic() {
  const row = routeRows.find(item => activeStage?.startsWith(item.protocol + ':'));
  const artifact = row && latestPhase(row).artifact;
  if (!row || !artifact || !page || page.isClosed()) return;
  try {
    const workspace = await api('workspaces/' + row.activityId);
    const file = workspace.files.find(item => item.name === 'components/artifact-' + artifact.artifactId + '.json');
    const stored = file ? JSON.parse(file.value).content.explanation : null;
    const fixed = await api(`artifacts/${row.activityId}/${artifact.artifactId}/revisions/${artifact.revisionId}`);
    const originalSnapshot = await api(`agent/${row.activityId}/snapshots/${artifact.origin.snapshotId}`);
    const { learningAgentDefinition } = await import(pathToFileURL(resolve('packages/learning-space/dist/teaching-agent/assembly.js')).href);
    report.definitionContinuity = { originalVersion: originalSnapshot.resolvedAgent.definition.version, originalDigest: originalSnapshot.resolvedAgent.definitionDigest,
      currentVersion: learningAgentDefinition.version, currentDigest: digest(learningAgentDefinition) };
    const ts = (await import(pathToFileURL(resolve('packages/learning-space/node_modules/typescript/lib/typescript.js')).href)).default;
    const source = ts.createSourceFile('generated.js', fixed.payload.javascript, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const readVariables = new Set(), properties = new Set();
    const classify = name => ['content', 'state', 'value', 'explanation'].includes(name) ? name : 'other';
    const visit = (node, find) => { find(node); ts.forEachChild(node, child => visit(child, find)); };
    visit(source, node => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isAwaitExpression(node.initializer)
        && ts.isCallExpression(node.initializer.expression) && ts.isPropertyAccessExpression(node.initializer.expression.expression)
        && node.initializer.expression.expression.name.text === 'read') {
        if (ts.isIdentifier(node.name)) readVariables.add(node.name.text);
        else if (ts.isObjectBindingPattern(node.name)) for (const element of node.name.elements) properties.add(classify((element.propertyName ?? element.name).getText(source)));
      }
    });
    visit(source, node => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && readVariables.has(node.expression.text)) properties.add(classify(node.name.text));
    });
    const input = page.locator('.teaching-artifact-card[data-artifact-id="' + artifact.artifactId + '"]').first().frameLocator('iframe').getByRole('textbox', { name: '我的解释', exact: true });
    const values = await input.evaluate(async element => {
      const result = await window.xunjie.read();
      return { input: element.value, host: result.content.explanation, hostContentId: result.contentId,
        frameError: !!document.querySelector('[data-xunjie-error]'), disabled: element.disabled };
    }, undefined, { timeout: 3000 });
    report.browser.diagnostic = { storedSha256: stored === null ? null : hash(stored), inputSha256: hash(values.input), hostSha256: hash(values.host),
      expectedSha256: artifact.explanationSha256, generatedReadResultProperties: [...properties], hostContentId: values.hostContentId, frameError: values.frameError, disabled: values.disabled };
  } catch { report.browser.diagnostic = { state: 'unavailable' }; }
}
async function generateAluCandidate() {
  if (report.alu?.artifact) { report.alu.resumeStatus = 'original-candidate-retained'; return; }
  const remaining = limits.maxGenerations - report.requests.length;
  if (remaining < 3) { report.alu = { status: 'not-run-budget-insufficient', remaining, requiredReserve: 3 }; return; }
  const before = report.requests.length, previousActor = actorHeaders;
  try {
    const { aluPackage, aluCoursePackage } = await import('../components/alu-experiment/package.mjs');
    const admin = { authorization: 'Bearer ' + await runtimeModule.resolveCredential(root, 'control') };
    const definition = await api('manage/component-import', await aluPackage(), admin);
    const course = await aluCoursePackage(); course.release.components[0].definition = definition;
    await api('manage/course-import', course, admin);
    const loginName = 'wp09-real-alu-' + randomUUID(), password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName, password }, admin);
    await api('manage/course-access', { requestId: randomUUID(), courseId: course.course.courseId, principalId: member.principalId, active: true }, admin);
    const login = await originalFetch(host.endpoint + '/api/learning/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName, password }) });
    check(login.status === 200, 'alu-student-login-failed');
    actorHeaders = { 'x-xj-space': 'school', cookie: login.headers.get('set-cookie').split(';')[0] };
    const activity = await api('course-activities', { requestId: randomUUID(), releaseId: course.release.releaseId });
    report.alu = { status: 'running', activityId: activity.activityId, identity: Object.fromEntries(['environmentId', 'spaceId', 'principalId', 'kind'].map(name => [name, activity.identity[name]])), releaseId: course.release.releaseId,
      courseId: course.course.courseId, componentKey: 'alu', operationId: 'run-single' };
    const privateHandoff = { formatVersion: 1, root, loginName, password, identity: activity.identity, activityId: activity.activityId,
      releaseId: course.release.releaseId, componentKey: 'alu', operationId: 'run-single' };
    await writeFile(join(root, 'wp09-real-models-handoff.private.json'), JSON.stringify(privateHandoff), { mode: 0o600 });
    await select('chat-completions');
    const question = `请使用当前 generate_teaching_artifact 工具生成一张课程 ALU 示意卡。只生成一次，成功后一句话确认，不调用其他工具、不实际执行实验。
卡片是一小段说明、aria-label=我的解释 的 textarea、一个明确标注“运行单次实验”的按钮。只有学生点击该按钮，才通过 window.xunjie.execution.submit({requestId:crypto.randomUUID(),componentKey:'alu',operationId:'run-single',parameters:{A:15,B:1,M:1,S:0,Cin:0}}) 交给课程原执行能力；异步处理失败，结果未知查询同一个 requestId，不重发新执行。显示“等待宿主真实观察”并只展示宿主返回的结果，不计算或伪造实验成功。
唯一状态 explanation:string(maxLength=1000)，initialState={explanation:''}，stateVersion=1，semanticFields=[{key:'explanation',meaning:'${meaning}'}]，semanticObjects=[]。先 await window.xunjie.read() 恢复该状态再监听 textarea input，通过 window.xunjie.change({explanation:textarea.value}) 保存；不自动写入，不代填学生预测，不修改作品源码。
requiredCapabilities=['workspace.read','workspace.change','execution.submit']，html 只含正文且排第一，css 放样式，javascript 为 async IIFE，不含外部依赖。artifactId=null,parentRevisionId=null,mapping=[]。当前 SDK 不支持的扩展不要猜测，生成值仅标为教学示意。`;
    const beforeWorkspace = await api('workspaces/' + activity.activityId);
    const generated = await runIntent(activity, question, report.alu);
    check(generated.fixed.payload.requiredCapabilities.includes('execution.submit')
      && generated.fixed.payload.javascript.includes('run-single') && /<button\b/.test(generated.fixed.payload.html), 'alu-execution-button-not-declared');
    const workspace = await api('workspaces/' + activity.activityId), history = await api('executions/' + activity.activityId + '/history');
    check(digest(workspace) === digest(beforeWorkspace), 'alu-generation-changed-student-work-or-prediction');
    check((history.entries ?? history).length === 0, 'alu-generation-executed-without-student-click');
    report.alu.status = 'real-generated-candidate-not-executed'; report.alu.newModelRequests = report.requests.length - before;
    report.alu.workspaceSha256 = digest(workspace); report.alu.executionsDuringGeneration = 0;
    Object.assign(privateHandoff, { artifact: report.alu.artifact, runId: report.alu.runId, requestId: report.alu.requestId });
    await writeFile(join(root, 'wp09-real-models-handoff.private.json'), JSON.stringify(privateHandoff), { mode: 0o600 });
  } finally { actorHeaders = previousActor; }
}
async function restartAndVerify() {
  const calls = report.requests.length, before = [];
  for (const row of routeRows) {
    const activityId = row.activityId, route = 'agent/' + activityId;
    const conversation = await api(route + '/conversation'), events = await api(route + '/events'), workspace = await api('workspaces/' + activityId);
    const copies = [];
    for (const phase of [row.generate, row.revise, ...(report.crossRoute.activityId === activityId ? [report.crossRoute] : [])]) {
      if (!phase?.artifact) continue;
      const artifact = phase.artifact;
      const candidate = await api(`artifacts/${activityId}/candidates/${artifact.candidateId}`);
      const revision = await api(`artifacts/${activityId}/${artifact.artifactId}/revisions/${artifact.revisionId}`);
      const receipt = await api(`artifacts/${activityId}/receipts/${artifact.origin.commandId}`);
      const request = await api(`${route}/requests/${phase.requestId}`);
      copies.push({ artifact, candidate: digest(candidate), revision: digest(revision), receipt: digest(receipt), request: digest(request) });
    }
    before.push({ row, copies, conversation: digest(conversation), events: digest(events), workspace: digest(workspace) });
  }
  await host.stop(); host = await createHost();
  for (const item of before) {
    const activityId = item.row.activityId, route = 'agent/' + activityId;
    check(digest(await api(route + '/conversation')) === item.conversation && digest(await api(route + '/events')) === item.events
      && digest(await api('workspaces/' + activityId)) === item.workspace, 'restart-changed-original-history-or-state');
    for (const copy of item.copies) {
      const artifact = copy.artifact;
      check(digest(await api(`artifacts/${activityId}/candidates/${artifact.candidateId}`)) === copy.candidate
        && digest(await api(`artifacts/${activityId}/${artifact.artifactId}/revisions/${artifact.revisionId}`)) === copy.revision
        && digest(await api(`artifacts/${activityId}/receipts/${artifact.origin.commandId}`)) === copy.receipt, 'restart-changed-original-candidate-source-or-receipt');
      const resource = await api(`artifacts/${activityId}/${artifact.artifactId}/revisions/${artifact.revisionId}/resource`);
      check(hash(Buffer.from(resource.contentBase64, 'base64')) === artifact.sha256, 'restart-changed-original-bytes');
      const phase = [item.row.generate, item.row.revise, report.crossRoute].find(value => value?.artifact?.revisionId === artifact.revisionId);
      check(digest(await api(`${route}/requests/${phase.requestId}`)) === copy.request, 'restart-changed-original-action-request');
    }
    if (page) {
      await openPage(activityId);
      const latest = report.crossRoute.activityId === activityId && report.crossRoute.artifact ? report.crossRoute.artifact : latestPhase(item.row).artifact;
      await adoptAndEdit(activityId, latest);
    }
    item.row.restart = { originalCandidateAndSource: true, originalRequest: true, conversationSha256: item.conversation,
      workspaceSha256: item.workspace, newModelRequests: report.requests.length - calls, chromeRestored: !!page };
  }
  check(report.requests.length === calls, 'restart-generated-another-request');
}

try {
  check(process.version === 'v24.21.0', 'requires-fixed-node-24-21');
  runtimeModule = await import(product ? pathToFileURL(join(product, 'app/product-runtime.js')).href : '@xunjie/product-runtime');
  resources = product ? JSON.parse(await readFile(join(product, 'resources.json'), 'utf8')) : {
    nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
    webRoot: resolve('apps/web/dist-runtime'), windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1'),
  };
  if (product) for (const name of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper']) if (resources[name]) resources[name] = resolve(product, resources[name]);
  report.currentBuild = { product: !!product, runtimeSha256: hash(await readFile(product ? join(product, 'app/product-runtime.js') : 'packages/product-runtime/dist/index.js')),
    ...(product ? { distributionSha256: hash(await readFile(join(product, 'distribution.json'))) } : {}),
    webIndexSha256: hash(await readFile(join(resources.webRoot, 'index.html'))) };
  (report.builds ??= []).push({ ...report.currentBuild, at: new Date().toISOString() });
  const readinessSource = await readFile(product ? join(product, 'app/product-runtime.js') : 'packages/learning-space/dist/teaching-agent/assembly.js', 'utf8');
  check(readinessSource.includes('window.xunjie.read()') && readinessSource.includes('semanticFields'), 'sdk-contract-build-not-ready');
  const addresses = zeroModelResume ? [] : await originalLookup('api.deepseek.com', { all: true });
  const classificationShim = addresses.some(item => /^198\.(?:18|19)\./.test(item.address));
  const tls = zeroModelResume ? null : await tlsPreflight();
  if (!zeroModelResume) report.transport = { kind: 'probe-streaming-https-preserving-origin', originalHost: 'api.deepseek.com', certificateVerification: true,
    preflight: tls, nativeDns: addresses, classificationShim: classificationShim
      ? { enabled: true, address: '93.184.216.34', scope: 'this probe process only; model-policy classification; actual TLS uses native DNS', reason: 'OS proxy DNS returned benchmark-network address' }
      : { enabled: false }, timeoutMs: limits.providerDeadlineMs, retries: 0 };
  if (args['prepare-only']) { report.status = 'ready-not-run'; await persist(); }
  else {
    if (!zeroModelResume) {
      const provider = JSON.parse(await readFile(args['credentials-file'], 'utf8')).providers.find(p => /deepseek/i.test(p.preset ?? p.name ?? '') && p.key);
      check(typeof provider?.key === 'string' && provider.key.length > 0, 'authorized-deepseek-key-unavailable'); key = provider.key;
    }
    installTransport(classificationShim);
    root = args.root ? resolve(args.root) : await mkdtemp(join(tmpdir(), 'xj-wp09-real-'));
    await mkdir(root, { recursive: true, mode: 0o700 }); root = await realpath(root);
    runtime = runtimeModule.openProductRuntime({ root, resources });
    if (zeroModelResume) await preparePackagedResume();
    if (!args.resume) { environmentId = (await runtime.install({ profile: 'local' })).environment.environmentId; report.environmentId = environmentId; }
    else {
      environmentId = report.environmentId;
      check((await runtime.status()).environment?.environmentId === environmentId, 'resume-environment-identity-mismatch');
    }
    host = await createHost();
    if (!args['candidates-only'] && !args['browser-only']) await assertDefinitionContinuity();
    if (!args['candidates-only']) {
      const { chromium } = await import('@playwright/test');
      browser = await chromium.launch({ channel: 'chrome', headless: false });
      page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); report.browser = { status: 'running', version: browser.version(), http: [] };
      page.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (!path.startsWith('/api/learning/artifacts/')) return;
        const pending = (async () => {
          const request = response.request(), fact = { method: request.method(), path, status: response.status() };
          if (request.method() === 'POST') {
            const input = request.postDataJSON();
            for (const name of ['requestId', 'candidateId', 'revisionId', 'expectedRevisionId', 'expectedWorkRevision', 'expectedContentId'])
              if (Object.hasOwn(input, name)) fact[name] = input[name];
          }
          if (response.status() >= 400) { const body = await response.json().catch(() => null); fact.error = publicReason(body?.error); }
          if (report.browser.http.length < 150) report.browser.http.push(fact);
        })().catch(() => {});
        browserFacts.add(pending); void pending.finally(() => browserFacts.delete(pending));
      });
    }
    report.status = 'running';
    if (!args.resume || args['candidates-only']) for (const protocol of protocols) {
      let row = routeRows.find(item => item.protocol === protocol);
      if (!row) { row = { protocol, status: 'running', generate: {}, revise: {} }; routeRows.push(row); }
      activeStage = protocol + ':generate';
      await stage(activeStage, async () => {
        await select(protocol);
        const activity = row.activityId ? await api('activities/' + row.activityId) : await api('activities', { requestId: randomUUID(), goal: 'WP09 ' + protocol + '：位宽解释', question: '', references: [] });
        row.activityId = activity.activityId;
        if (page) await openPage(activity.activityId);
        const generated = await runIntent(activity, basePrompt() + '\n这是新卡片，artifactId=null,parentRevisionId=null,mapping=[]。', row.generate);
        if (page) await adoptAndEdit(activity.activityId, row.generate.artifact, '我的解释：位宽决定可表示组合数。' + protocol);
        row.generate.status = 'passed';
        if (args['product-minimal']) { row.status = 'product-generated-adopted-and-editable'; return; }
        activeStage = protocol + ':revise';
        const revised = await runIntent(activity, revisePrompt(generated.fixed), row.revise);
        check(revised.fixed.artifactId === generated.fixed.artifactId && revised.fixed.parentRevisionId === generated.fixed.revisionId && revised.fixed.version === 2, 'revision-replaced-original-artifact');
        check(revised.commands.some(item => item.name === 'read_teaching_artifact' && item.outcome === 'completed'), 'revision-did-not-read-original');
        if (page) { setExpected(row.revise.artifact, row.generate.artifact.expectedExplanation); await adoptAndEdit(activity.activityId, row.revise.artifact); }
        row.revise.status = 'passed'; row.status = page ? 'adopted-and-state-retained' : 'candidates-only';
      });
    }
    if (page) {
      if (args.resume) {
        let failures = 0;
        for (const row of routeRows) {
          activeStage = row.protocol + ':chrome-adopt-and-recover';
          try {
            check(row.revise?.artifact, 'resume-requires-original-revision');
            await openPage(row.activityId);
            const latest = report.crossRoute.activityId === row.activityId && report.crossRoute.artifact ? report.crossRoute.artifact : row.revise.artifact;
            if (zeroModelResume) {
              const workspace = await api('workspaces/' + row.activityId);
              const file = workspace.files.find(item => item.name === 'components/artifact-' + latest.artifactId + '.json');
              check(file, 'original-state-file-missing');
              setExpected(latest, JSON.parse(file.value).content.explanation);
            }
            await verifyBrowserRecovery(row, latest, !zeroModelResume);
            row.status = 'latest-candidate-adopted';
          } catch (error) {
            failures++; await browserDiagnostic();
            row.chrome ??= {};
            row.chrome.failure = { reason: safe(error), ...(report.browser.diagnostic ? { diagnostic: report.browser.diagnostic } : {}) };
            row.status = 'browser-verification-failed';
          }
          await persist();
        }
        const bad = routeRows.filter(row => row.status === 'browser-verification-failed');
        const chat = bad[0], diagnostic = chat?.chrome?.failure?.diagnostic;
        const repairable = failures === 1 && chat.protocol === 'chat-completions'
          && diagnostic?.generatedReadResultProperties?.length === 1 && diagnostic.generatedReadResultProperties[0] === 'explanation'
          && diagnostic.storedSha256 === diagnostic.hostSha256 && diagnostic.hostSha256 === diagnostic.expectedSha256 && !diagnostic.frameError;
        check(failures === 0 || repairable && !args['browser-only'], 'chrome-recovery-not-complete');
        if (repairable) report.pendingCrossRouteRepair = { code: 'generated-read-result-needs-content-envelope', originalRevisionId: chat.revise.artifact.revisionId };

      }
      if (!args['product-minimal'] && !args['browser-only'] && !zeroModelResume) {
      activeStage = 'chat-to-responses:continue-original-artifact';
      await stage(activeStage, async () => {
        const row = routeRows.find(item => item.protocol === 'chat-completions');
        const original = row.revise.artifact, activity = await api('activities/' + row.activityId);
        if (report.crossRoute.artifact?.expectedExplanation) setExpected(original, report.crossRoute.artifact.expectedExplanation);
        await openPage(row.activityId); const selectionVersion = await select('responses');
        await api('agent/' + row.activityId + '/model-switches', { requestId: randomUUID(), selectionVersion });
        if (!report.crossRoute.artifact) {
          report.crossRoute = { activityId: row.activityId, from: 'chat-completions', to: 'responses', status: 'running' };
          const correction = report.pendingCrossRouteRepair
            ? '\n原版本脚本直接读取了 SDK 返回对象的 explanation，漏掉 content 层；请在这次同一兼容修订中修正为 const {content}=await window.xunjie.read(); textarea.value=content.explanation。先恢复再注册 input，保留已保存的 explanation，仍用完整状态 change，不改状态结构、含义或已有输入。'
            : '';
          const continued = await runIntent(activity, revisePrompt(original, true) + correction, report.crossRoute);
          check(continued.fixed.artifactId === original.artifactId && continued.fixed.parentRevisionId === original.revisionId && continued.fixed.version === 3, 'cross-route-did-not-retain-original-artifact');
        }
        setExpected(report.crossRoute.artifact, original.expectedExplanation);
        await adoptAndEdit(row.activityId, report.crossRoute.artifact);
        row.originalRevisionBrowser ??= structuredClone(row.chrome);
        await verifyBrowserRecovery(row, report.crossRoute.artifact, false);
        row.status = report.pendingCrossRouteRepair ? 'original-state-retained-after-cross-route-repair' : 'cross-route-state-retained';
        report.crossRoute.status = 'adopted-original-state-retained';
        if (report.pendingCrossRouteRepair) { report.crossRoute.repair = { ...report.pendingCrossRouteRepair, status: 'verified' }; delete report.pendingCrossRouteRepair; }
      });
      }
    }
    activeStage = 'restart-original-candidates-and-sources';
    await stage(activeStage, restartAndVerify);
    if (args.screenshots && page) { activeStage = 'actual-product-light-dark-screenshots'; await stage(activeStage, captureScreenshots); }
    if (zeroModelResume) { await verifyExistingAlu(); check(report.requests.length === invocationStartRequests, 'product-resume-generated-model-request'); }
    if (args.alu && page && !zeroModelResume) { activeStage = 'real-alu-course:generate'; await stage(activeStage, generateAluCandidate); }
    if (zeroModelResume) {
      report.productResume.status = 'passed';
      report.coverage = { ...report.coverage, finalProductPackage: 'macos-package-original-data-reopen-passed', packageNewGenerationCount: 0, alu: 'original-candidate-reopened-not-adopted-or-executed' };
    }
    report.status = page ? 'passed' : 'candidates-verified-not-adopted';
    delete report.reason; delete report.failedPhase;
    if (page) report.browser.status = 'passed';
    else report.crossRoute = { status: 'pending-browser-adoption-and-route-continuation' };
    report.generationCount = report.requests.filter(item => item.sent).length;
    check(report.generationCount <= 24 && report.requests.every(item => item.httpStatus === 200 && (item.finished || item.terminalVerifiedBy) && item.tls?.authorized), 'actual-provider-transport-not-complete');
  }
} catch (error) {
  await browserDiagnostic();
  report.status = 'failed'; report.reason = safe(error);
  if (report.reason === 'probe-operation-failed' && report.browser.status === 'running') report.browser.failedAssertion = String(error?.message ?? '').match(/(?:expect|locator|page)\([^\n]*?\)\.[A-Za-z]+|page\.[A-Za-z]+/)?.[0]?.slice(0, 100) ?? 'browser-operation';
  if (report.reason === 'probe-operation-failed' && activeStage?.endsWith(':chrome-adopt-and-recover') && !routeRows.find(row => activeStage.startsWith(row.protocol + ':'))?.revise?.artifact?.browserChecked && report.browser.http?.some(item => item.method === 'POST' && item.path.endsWith('/adopt') && item.status === 409 && item.expectedRevisionId === null))
    report.reason = 'first-revision-adoption-conflict';
  keepRoot = !!args.root || !!args['keep-root'] || !!args.alu;
  if (activeStage) report.failedPhase = activeStage;
} finally {
  await Promise.allSettled([...browserFacts]);
  await browser?.close().catch(() => {});
  await host?.stop().catch(error => { report.cleanupFailure = safe(error); });
  for (const socket of sockets) socket.destroy();
  await runtime?.stop().catch(error => { report.cleanupFailure = safe(error); });
  transportRestore();
  if (runtime && root && !keepRoot) {
    try { if (environmentId) await runtime.deleteEnvironment({ environmentId }); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); report.cleanup = 'isolated-environment-removed'; }
    catch (error) { report.cleanupFailure = safe(error); }
  } else if (root) report.cleanup = 'isolated-environment-stopped-and-retained-for-resume';
  if (installedConfigurationSha256) {
    report.productResume.installationUnchanged = hash(await readFile(join(root, 'installation.json'))) === installedConfigurationSha256;
    if (!report.productResume.installationUnchanged) { report.status = 'failed'; report.reason = 'installation-config-changed'; }
  }
  report.newGenerationCount = report.requests.length - invocationStartRequests;
  report.finishedAt = new Date().toISOString(); report.generationCount = report.requests.filter(item => item.sent).length;
  if (report.cleanupFailure && report.status === 'passed') report.status = 'failed';
  await persist();
}
console.log(JSON.stringify({ status: report.status, report: hasProbeEvidence(output) ? output : null, modelRequests: report.generationCount, ...(report.reason ? { reason: report.reason } : {}) }));
if (report.status === 'failed') process.exitCode = 1;
