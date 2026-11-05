// Acceptance RPC over SSH stdin/stdout. Product traffic itself uses the authenticated LAN channel.
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { readFile, open, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, sha } from './model-request-witness.mjs';

const product = resolve(process.argv[2]), root = resolve(process.argv[3]);
const { openProductRuntime, resolveCredential, createOutboundConnection } = await import(pathToFileURL(join(product, 'app/product-runtime.js')));
const files = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
const runtime = openProductRuntime({ root, resources: { ...files, nodePath: resolve(product, files.nodePath),
  postgresBin: resolve(product, files.postgresBin), webRoot: resolve(product, files.webRoot),
  ...(files.windowsPrerequisitePath ? { windowsPrerequisitePath: resolve(product, files.windowsPrerequisitePath) } : {}) } });
let cleaned = false;
async function startWitnessed() {
  // The normal launcher deliberately strips NODE_OPTIONS. Explicitly preload the observer into
  // the unchanged packaged daemon; it records facts while keeping the SDK's direct transport.
  const existing = await runtime.status();
  if (existing.state === 'ready') return existing;
  await mkdir(join(root, 'logs'), { recursive: true });
  const log = await open(join(root, 'logs/witnessed-daemon.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(resolve(product, files.nodePath), ['--import', new URL('./model-request-witness.mjs', import.meta.url).href,
      join(product, 'app/daemon.js'), '--root', root], { cwd: root, detached: true, windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(name))),
      stdio: ['ignore', log.fd, log.fd] });
    await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); }); child.unref();
  } finally { await log.close(); }
  for (let count = 0; count < 240; count++) {
    const state = await runtime.status(); if (state.state === 'ready') return state;
    if (child.exitCode !== null) throw new Error('Witnessed daemon exited');
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('Witnessed daemon startup timed out');
}
async function handle(input) {
  if (input.operation === 'install') return runtime.install({ profile: 'model' });
  if (input.operation === 'start') return startWitnessed();
  if (input.operation === 'stop') return runtime.stop();
  if (input.operation === 'restart') { await runtime.stop(); return startWitnessed(); }
  if (input.operation === 'status') return runtime.status();
  if (input.operation === 'connect') { await runtime.connect(input.connection, input.token); return { connected: true }; }
  if (input.operation === 'diagnose-binding') {
    const config = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'));
    const transport = config.connections.find(item => item.connectionId === input.runtimeConnectionId);
    const paired = JSON.parse(await resolveCredential(root, 'school-client-' + input.connectionId));
    const channel = createOutboundConnection({ connection: transport, credential: () => resolveCredential(root, transport.credentialRef), allowInsecureLoopback: true });
    const check = await channel.check();
    let access;
    try { const result = await channel.request('learning.authority', { token: paired.grant.token, operation: 'access' });
      access = { code: result.error, identityMatches: JSON.stringify(result.identity) === JSON.stringify(paired.grant.identity), targetMatches: JSON.stringify(result.target) === JSON.stringify(input.target) }; }
    catch (error) { access = { code: error.code ?? error.name }; }
    return { check, access, targetMatches: JSON.stringify(paired.grant.target) === JSON.stringify(input.target) };
  }
  if (input.operation === 'bind') {
    const state = await runtime.status();
    const response = await fetch(new URL('/api/learning/manage/local-binding', state.environment.services[0].endpoint), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await resolveCredential(root, 'control') },
      body: JSON.stringify({ connectionId: input.connectionId, runtimeConnectionId: input.runtimeConnectionId, target: input.target }) });
    return { status: response.status, value: await response.json() };
  }
  if (input.operation === 'api') {
    const state = await runtime.status();
    const response = await fetch(new URL('/api/learning/' + input.route, state.environment.services[0].endpoint), {
      headers: { 'content-type': 'application/json', ...(input.headers ?? {}) }, redirect: 'error', signal: AbortSignal.timeout(45000),
      ...(input.body === undefined ? {} : { method: 'POST', body: JSON.stringify(input.body) }) });
    return { status: response.status, value: await response.json() };
  }
  if (input.operation === 'witness') {
    try { return JSON.parse(await readFile(process.env.XUNJIE_ACCEPTANCE_WITNESS_FILE, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { requests: [] }; }
  }
  if (input.operation === 'native-summary') {
    const state = await runtime.status(), owner = state.environment.services.find(item => item.unit === 'model-connection');
    const bytes = await readFile(join(root, 'learning-resources/model-connection', state.environment.environmentId, owner.serviceId, input.resultRef));
    const native = JSON.parse(bytes.subarray(bytes.indexOf(10) + 1).toString());
    return { redacted: native.redacted === true, chunks: native.chunks?.length, events: native.events?.length,
      assistantHash: native.assistant ? sha(canonical(native.assistant)) : null };
  }
  if (input.operation === 'cleanup') {
    const state = await runtime.status(); await runtime.stop(); await runtime.deleteEnvironment({ environmentId: state.environment.environmentId });
    cleaned = true;
    return { stopped: true, environmentDeleted: true };
  }
  throw new Error('Unsupported acceptance operation');
}
async function respond(line, write, token) {
  let input;
  try { input = JSON.parse(line); if (token && input.controlToken !== token) throw new Error('Invalid acceptance control token');
    const result = await handle(input); write(JSON.stringify({ id: input.id, ok: true, result }) + '\n'); }
  catch (error) { write(JSON.stringify({ id: input?.id, ok: false, code: error.code ?? error.name }) + '\n'); }
}
if (process.argv[4] === '--listen') {
  const token = (await readFile(process.argv[6], 'utf8')).trim();
  const server = createServer(socket => {
    const lines = createInterface({ input: socket, crlfDelay: Infinity }); let queue = Promise.resolve();
    lines.on('line', line => { queue = queue.then(() => respond(line, value => socket.write(value), token)); });
    socket.on('close', () => { if (cleaned) server.close(); });
    socket.on('error', () => {});
  });
  server.listen(Number(process.argv[5]), '127.0.0.1');
} else {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) await respond(line, value => process.stdout.write(value));
}
