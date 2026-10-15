import { createServer, connect } from 'node:net';
import { readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DockerExecutor } from './docker.ts';
import { EditorDiagnosticsNode } from './editor-diagnostics.ts';
import { validateSnapshot, RunnerError } from './snapshot.ts';
import { readEnvelope } from './node-files.ts';
import type { EditorDiagnosticsPacket } from '../contracts/workspace/editor-diagnostics.ts';

// An independent, root-only analysis service keeps the accepted C/HDL engine source and course versions immutable.
const [configPath, socketPath] = process.argv.slice(2);
if (!configPath || !socketPath) throw new Error('Explicit prepared node config and private diagnostic socket required');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const executor = new DockerExecutor(config.dockerBinary, config.dockerSocket, config.cliConfig);
const diagnostics = new EditorDiagnosticsNode(executor, { c: config.profile.compilerImage, hdl: config.hdl?.buildImage });
let admitting = false;
let preemptionEpoch = 0;
function originalReadiness(language: 'c' | 'hdl'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(config.socket); let text = ''; socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('Original execution readiness timed out')));
    socket.once('connect', () => socket.write(JSON.stringify({ peer: 'application', request: { op: language === 'c' ? 'readiness' : 'hdl_readiness' } }) + '\n'));
    socket.on('data', chunk => { text += chunk; if (text.length > 1048576) socket.destroy(new Error('Original readiness too large')); });
    socket.once('error', reject);
    socket.once('end', () => { try { resolve(JSON.parse(text).data ?? {}); } catch { reject(new Error('Original readiness unavailable')); } });
  });
}
function executionBusy() {
  const facts = new Map<string, { reserved?: boolean; state?: string }>();
  const ledger = join(config.state, 'ledger.jsonl');
  for (const line of readFileSync(ledger, 'utf8').split('\n').filter(Boolean)) {
    const fact = JSON.parse(line).payload;
    if (fact.identity?.runId) facts.set(fact.identity.runId, fact);
  }
  if ([...facts.values()].some(fact => fact.reserved || fact.state === 'queued')) return true;
  const builds = join(config.state, 'hdl', 'builds');
  return existsSync(builds) && readdirSync(builds).some(name => {
    const outcome = join(builds, name, 'outcome.json'), barrier = join(builds, name, 'termination.json');
    const terminated = (path: string, field: string) => existsSync(path) && readEnvelope(path)?.[field] === true;
    return !terminated(outcome, 'terminationConfirmed') && !terminated(barrier, 'unitTerminated');
  });
}
async function dispatch(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('INVALID_REQUEST', 'Diagnostic request required');
  const request = value as { op: unknown; packet?: EditorDiagnosticsPacket };
  if (request.op === 'preempt' && Object.keys(request).length === 1) { preemptionEpoch++; await diagnostics.preempt(); return { preempted: true }; }
  if (request.op !== 'editor_diagnostics' || Object.keys(request).sort().join(',') !== 'op,packet') throw new RunnerError('FORBIDDEN', 'Fixed analysis operation required');
  const packet = request.packet;
  if (!packet || Object.keys(packet).sort().join(',') !== 'fileId,language,recoveryGeneration,scope,snapshot' ||
    !['c', 'hdl'].includes(packet.language) || typeof packet.fileId !== 'string' || !packet.fileId || packet.fileId.length > 128 ||
    !packet.scope || Object.keys(packet.scope).sort().join(',') !== 'attemptId,courseId,userId' ||
    Object.values(packet.scope).some(value => typeof value !== 'string' || !value || value.length > 128)) throw new RunnerError('FORBIDDEN', 'Authorized analysis scope required');
  validateSnapshot(packet.snapshot);
  const empty = { sourceHash: packet.snapshot.hash, diagnostics: [] };
  if (admitting) return { ...empty, status: 'busy' };
  admitting = true;
  const epoch = preemptionEpoch;
  try {
    const readiness = await originalReadiness(packet.language);
    if (readiness.ready !== true) return { ...empty, status: 'unavailable' };
    if (packet.recoveryGeneration !== readiness.recoveryGeneration) throw new RunnerError('RECOVERY_REQUIRED', 'Current diagnostic generation required');
    if (epoch !== preemptionEpoch || executionBusy()) return { ...empty, status: 'busy' };
    return await diagnostics.analyze(packet);
  } finally { admitting = false; }
}
const server = createServer(socket => {
  socket.setEncoding('utf8');
  let text = '', done = false;
  socket.setTimeout(25000, () => socket.destroy());
  socket.on('data', chunk => {
    if (done) return; text += chunk;
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) { done = true; socket.end(JSON.stringify({ error: { code: 'CONTENT_LIMIT' } }) + '\n'); return; }
    if (!text.includes('\n')) return;
    done = true;
    void (async () => {
      try { socket.end(JSON.stringify({ data: await dispatch(JSON.parse(text)) }) + '\n'); }
      catch (error) { socket.end(JSON.stringify({ error: { code: error instanceof RunnerError ? error.code : 'DEPENDENCY_UNAVAILABLE' } }) + '\n'); }
    })();
  });
});
if (process.env.LISTEN_FDS === '1') server.listen({ fd: 3 });
else server.listen(socketPath, () => chmodSync(socketPath, 0o600));
process.once('SIGTERM', () => { void diagnostics.preempt().finally(() => server.close()); });
