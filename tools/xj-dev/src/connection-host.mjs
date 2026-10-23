import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { parseKeyValueArgs } from './args.mjs';
import { checkBackend, classifySshFailure, connectionError, loadConnection, sshArguments } from './connection.mjs';
import { portFree } from './ports.mjs';
import { writeJsonAtomic } from './state.mjs';

const config = JSON.parse(readFileSync(parseKeyValueArgs(process.argv.slice(2)).config, 'utf8'));
let stopping = false, child, wake;
const c = loadConnection(config.connectionFile, { identity: config.identityFile });
const publish = value => writeJsonAtomic(config.statusFile, { schema: 'xj-dev/connection-status-v1', kind: config.kind, target: c.id, ...(c.nodeId && config.kind === 'node' ? { nodeId: c.nodeId } : {}), ...value, checkedAt: new Date().toISOString() });
export function tcpReady(port) {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = ok => { socket.destroy(); done(ok); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1500, () => finish(false));
  });
}
async function stopChild() {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const current = child;
  current.kill('SIGTERM');
  await Promise.race([new Promise(done => current.once('exit', done)), delay(2000)]);
  if (current.exitCode === null && current.signalCode === null) {
    current.kill('SIGKILL');
    await Promise.race([new Promise(done => current.once('exit', done)), delay(1000)]);
  }
}
const shutdown = () => { if (stopping) return; stopping = true; wake?.(); void stopChild(); };
const pause = ms => new Promise(done => { const timer = setTimeout(done, ms); wake = () => { clearTimeout(timer); done(); }; });
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
const stopWatcher = setInterval(() => { if (config.stopFile && existsSync(config.stopFile)) shutdown(); }, 200);
let attempts = 0;
try {
  while (!stopping) {
    let failure;
    publish({ state: 'connecting', attempts });
    if (config.kind === 'node' && !await tcpReady(c.localRunnerPort)) failure = connectionError('NODE_OFFLINE', true);
    else if (config.kind !== 'node' && !await portFree(config.localPort)) failure = connectionError('PORT_IN_USE');
    if (!failure) {
      let stderr = '', exited = false;
      child = spawn('ssh', sshArguments(c, config.kind, config.localPort), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
      child.once('error', () => { stderr = 'ssh executable unavailable'; exited = true; });
      child.once('exit', () => { exited = true; });
      const startedAt = Date.now();
      let lastHealthy = 0;
      while (!stopping) {
        if (exited) { failure = classifySshFailure(stderr); break; }
        try {
          if (config.kind === 'node') {
            if (!/remote forward success/i.test(stderr)) throw connectionError('CLOUD_UNREACHABLE', true);
            if (!await tcpReady(c.localRunnerPort)) throw connectionError('NODE_OFFLINE', true);
            // Reverse-forward acceptance is confirmed by SSH; runner authorization
            // and task generation remain the business host's responsibility.
            if (Date.now() - lastHealthy > 5000) publish({ state: 'ready', attempts, transport: 'ssh-reverse', executionVerified: false });
          } else {
            const business = await checkBackend(c, config.localPort);
            publish({ state: 'ready', attempts, business });
          }
          lastHealthy = Date.now();
          attempts = 0;
        } catch (error) {
          const transportFailure = classifySshFailure(stderr);
          if (!transportFailure.retryable) { failure = transportFailure; break; }
          if (!error.retryable) { failure = error; break; }
          // Allow initial SSH handshake, but bound recovery of an unresponsive
          // connection. No requests with business writes are replayed here.
          if (Date.now() - (lastHealthy || startedAt) > 12000) { failure = error; break; }
        }
        await pause(lastHealthy ? 10000 : 1000);
      }
      await stopChild();
      if (stopping) break;
      failure ??= connectionError('CLOUD_UNREACHABLE', true);
    }
    attempts++;
    const terminal = !failure.retryable || attempts >= 6;
    publish({ state: terminal ? 'stopped' : 'recovering', attempts, failure: { code: failure.code, retryable: !terminal && failure.retryable } });
    if (terminal) break;
    await pause(Math.min(1000 * 2 ** (attempts - 1), 16000));
  }
} finally {
  clearInterval(stopWatcher);
  await stopChild();
  if (stopping) publish({ state: 'disconnected', attempts });
}
