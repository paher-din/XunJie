import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SupervisedSession } from '../packages/learning-space/dist/index.js';

/**
 * Real Apple Silicon acceptance for #184: the native session must be confined by the OS, must reap
 * its own process group in every exit order, and must stop on its declared budgets. Every control
 * is paired with a positive baseline taken without the sandbox, so an empty result never counts.
 */
const exec = promisify(execFile);
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const packageRoot = value('--package', null);
const output = resolve(value('--out', '.verification/wp03-184-isolation'));
const role = value('--role', 'all');
const statePath = value('--state', null);
const nodePath = value('--node', packageRoot ? join(packageRoot, 'resources/node/bin/node') : process.execPath);

const limits = { operationTimeoutMs: 4000, idleMs: 60_000, maxMs: 120_000, memoryMiB: 48, outputBytes: 65_536 };
const sessionRoot = await mkdtemp(join(tmpdir(), 'xj-isolation-'));
const results = {};
const startedAt = new Date().toISOString();

const probeAdapter = {
  adapterId: 'isolation-probe', adapterVersion: 1,
  source: String.raw`
const fs = await import('node:fs');
const net = await import('node:net');
const { spawn, execFileSync } = await import('node:child_process');
let seq = 0;
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const connect = (host, port) => new Promise(resolve => {
  const socket = net.connect({ host, port });
  const settle = value => { try { socket.destroy() } catch {} resolve(value) };
  socket.once('connect', () => settle({ ok: true }));
  socket.once('error', error => settle({ ok: false, code: error.code, message: error.message }));
  setTimeout(() => settle({ ok: false, code: 'ETIMEDOUT' }), 1500);
});
async function act(parameters) {
  const action = parameters && parameters.action;
  if (action === 'write') {
    try { fs.writeFileSync(parameters.path, parameters.data ?? 'probe'); return { ok: true } }
    catch (error) { return { ok: false, code: error.code, message: error.message } }
  }
  if (action === 'read') {
    try { return { ok: true, bytes: fs.readFileSync(parameters.path).length } }
    catch (error) { return { ok: false, code: error.code, message: error.message } }
  }
  if (action === 'connect') return await connect(parameters.host, parameters.port);
  if (action === 'exec') {
    try { execFileSync(parameters.path, parameters.args ?? [], { stdio: 'ignore' }); return { ok: true } }
    catch (error) { return { ok: false, code: error.code ?? String(error.errno), message: String(error.message).slice(0, 200) } }
  }
  if (action === 'signal') {
    try { process.kill(parameters.pid, parameters.signal ?? 'SIGCONT'); return { ok: true } }
    catch (error) { return { ok: false, code: error.code, message: error.message } }
  }
  if (action === 'spawn') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    return { ok: true, pid: child.pid, pgid: process.pid };
  }
  if (action === 'allocate') {
    const blocks = [];
    for (let index = 0; index < parameters.blocks; index += 1) blocks.push(Buffer.alloc(parameters.mib * 1024 * 1024, 1));
    return { ok: true, allocatedMiB: blocks.length * parameters.mib };
  }
  if (action === 'flood') {
    const chunk = 'x'.repeat(4096);
    for (let index = 0; index < parameters.chunks; index += 1) process.stdout.write(chunk + '\n');
    return { ok: true, wroteBytes: parameters.chunks * 4097 };
  }
  if (action === 'exit') { setTimeout(() => process.exit(0), 120); return { ok: true } }
  if (action === 'ignore-stop') { ignoring = true; return { ok: true } }
  if (action === 'hold') { await sleep(parameters.ms ?? 1000); return { ok: true } }
  return { ok: false, code: 'unknown-action' };
}
let ignoring = false;
async function handle(message) {
  if (message.type === 'ready') {
    write({ type: 'ready', adapterId: 'isolation-probe', adapterVersion: 1,
      instanceId: process.env.XJ_SESSION_INSTANCE || '', observation: { value: 0 } });
    return;
  }
  if (message.type === 'input') {
    const state = await act(message.parameters);
    seq += 1;
    write({ type: 'observation', seq, controlId: message.controlId, state, at: new Date().toISOString() });
    return;
  }
  if (message.type === 'reconcile') { write({ type: 'reconcile', applied: false, controlId: message.controlId }); return }
  if (message.type === 'status') { write({ type: 'status', observation: { value: 0 } }); return }
  if (message.type === 'stop') { if (!ignoring) process.exit(0); return }
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line) } catch { continue }
    void handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));
`,
};

async function sha256(path) {
  try { return createHash('sha256').update(await readFile(path)).digest('hex') } catch { return null }
}

async function open(options = {}) {
  return SupervisedSession.create({ adapter: probeAdapter, limits: { ...limits, ...(options.limits ?? {}) },
    sessionRoot, nodePath, ...(options.macosSandbox === false ? { macosSandbox: false } : {}) });
}

/** A plain TCP receiver outside the sandbox; it counts real accepted connections. */
async function receiver() {
  const accepted = [];
  const server = (await import('node:net')).createServer(socket => { accepted.push(Date.now()); socket.destroy() });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { port: server.address().port, accepted, close: () => new Promise(done => server.close(() => done(null))) };
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } };
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!alive(pid)) return true; await new Promise(done => setTimeout(done, 25)) }
  return !alive(pid);
}

async function supervisorDeath() {
  const state = join(sessionRoot, 'supervisor-state.json');
  const child = spawn(nodePath, [import.meta.filename, '--role', 'supervisor-child', '--node', nodePath,
    '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk) });
  const deadline = Date.now() + 20_000;
  let fact = null;
  while (Date.now() < deadline && !fact) {
    try { fact = JSON.parse(await readFile(state, 'utf8')) } catch { await new Promise(done => setTimeout(done, 50)) }
  }
  if (!fact) throw new Error('the supervisor never reported its session: ' + stderr.slice(-400));
  const before = { sessionAlive: alive(fact.sessionPid), descendantAlive: alive(fact.descendantPid) };
  process.kill(child.pid, 'SIGKILL');
  const goneDeadline = Date.now() + 5000;
  let sessionGone = false, descendantGone = false;
  while (Date.now() < goneDeadline && !(sessionGone && descendantGone)) {
    sessionGone = !alive(fact.sessionPid);
    descendantGone = !alive(fact.descendantPid);
    if (!(sessionGone && descendantGone)) await new Promise(done => setTimeout(done, 50));
  }
  return { ...fact, supervisorPid: child.pid, before, sessionGone, descendantGone,
    elapsedMs: 5000 - Math.max(0, goneDeadline - Date.now()) };
}

async function runAll() {
  const report = { ticket: 184, startedAt, platform: process.platform, arch: process.arch, os: release(),
    node: process.version, nodeUsedForSessions: nodePath, isolation: null, cases: [], checks: {} };
  const record = (name, valueOf) => { report.cases.push({ name, ...valueOf }); results[name] = valueOf };

  // Environment and candidate identity.
  const [version, model] = await Promise.all([
    exec('sw_vers', []).then(result => result.stdout.trim()).catch(() => ''),
    exec('sysctl', ['-n', 'hw.model']).then(result => result.stdout.trim()).catch(() => ''),
  ]);
  report.environment = {
    swVers: version, hardwareModel: model, arch: process.arch, osRelease: release(),
    sandboxExec: { path: '/usr/bin/sandbox-exec', sha256: await sha256('/usr/bin/sandbox-exec') },
    node: { path: nodePath, version: (await exec(nodePath, ['-v'])).stdout.trim() },
    devToolchain: { nodeEnvInSession: false },
  };
  if (packageRoot) {
    const distribution = JSON.parse(await readFile(join(packageRoot, 'distribution.json'), 'utf8'));
    report.environment.package = {
      root: packageRoot,
      distributionSha256: await sha256(join(packageRoot, 'distribution.json')),
      resourcesSha256: await sha256(join(packageRoot, 'resources.json')),
      status: distribution.status, signing: distribution.signing, platform: distribution.platform,
      verification: distribution.verification,
    };
    report.environment.package.bundle = await exec('bash', ['-c',
      `ls -d "${packageRoot}"/*.app 2>/dev/null | head -1; test -f "${packageRoot}/Contents/Info.plist" && echo has-Info.plist`])
      .then(result => result.stdout.trim() || 'no .app bundle', () => 'unknown');
    report.environment.package.launcher = await exec('codesign', ['-dv', join(packageRoot, 'xunjie')])
      .then(result => ({ signed: true, output: result.stderr.trim().slice(0, 300) }),
        error => ({ signed: false, output: String(error.stderr ?? error.message).trim().slice(0, 300) }));
  }

  // App Sandbox feasibility: ad-hoc sign a copy of the shipped runtime with the App Sandbox entitlement.
  const sandboxCopy = join(sessionRoot, 'app-sandbox-node');
  const entitlement = join(sessionRoot, 'app-sandbox.plist');
  await copyFile(nodePath, sandboxCopy);
  await chmod(sandboxCopy, 0o755);
  await writeFile(entitlement, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.app-sandbox</key><true/>
</dict></plist>
`);
  const signed = await exec('codesign', ['--force', '--sign', '-', '--entitlements', entitlement, sandboxCopy])
    .then(() => true, error => String(error.stderr ?? error.message).slice(0, 300));
  const sandboxedRun = await exec(sandboxCopy, ['-e', 'console.log("ran")'])
    .then(result => ({ exitCode: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() }),
      error => ({ exitCode: error.code ?? null, signal: error.signal ?? null,
        stderr: String(error.stderr ?? error.message).trim().slice(0, 400) }));
  const sandboxedRead = await exec(sandboxCopy, ['-e', `try { require('node:fs').readFileSync(${JSON.stringify(join(homedir(), '.zshrc'))}); console.log('home-readable') } catch (e) { console.log(e.code) }`])
    .then(result => result.stdout.trim(), error => 'run-failed:' + String(error.stderr ?? error.message).trim().slice(0, 200));
  report.sources = {
    appSandbox: { signing: signed === true ? 'ad-hoc-signed' : signed, run: sandboxedRun, homeRead: sandboxedRead,
      conclusion: 'App Sandbox needs a signed .app bundle with a container; the shipped candidate is an unsigned ' +
        'directory launcher, so the seatbelt profile applied by the fixed system launcher is the shippable candidate.' },
  };
  record('app-sandbox-entitlement-probe', { signed: signed === true, run: sandboxedRun, homeRead: sandboxedRead });

  // Isolation controls, each against a positive baseline without the sandbox.
  const outsideDirectory = await mkdtemp(join(tmpdir(), 'xj-outside-'));
  await writeFile(join(outsideDirectory, 'secret.txt'), 'outside-secret');
  const homeFile = join(homedir(), '.xj-isolation-' + randomUUID() + '.txt');
  await writeFile(homeFile, 'home-secret');
  const productFile = packageRoot ? join(packageRoot, 'resources.json') : join(outsideDirectory, 'secret.txt');
  const control = await receiver();
  const foreign = spawn(nodePath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });

  const controls = async (session) => {
    const input = async (parameters) => (await session.input(randomUUID(), 1, parameters)).state;
    const baseline = session.isolation.kind;
    return {
      kind: baseline,
      writeInside: await input({ action: 'write', path: join(session.sessionDirectoryInput, 'inside.txt'), data: 'inside' }),
      readInside: await input({ action: 'read', path: join(session.sessionDirectoryInput, 'inside.txt') }),
      readHome: await input({ action: 'read', path: homeFile }),
      readProduct: await input({ action: 'read', path: productFile }),
      readOutside: await input({ action: 'read', path: join(outsideDirectory, 'secret.txt') }),
      writeHome: await input({ action: 'write', path: homeFile }),
      writeOutside: await input({ action: 'write', path: join(outsideDirectory, 'written.txt') }),
      loopbackReceiver: await input({ action: 'connect', host: '127.0.0.1', port: control.port }),
      externalConnect: await input({ action: 'connect', host: '1.1.1.1', port: 443 }),
      execForeign: await input({ action: 'exec', path: '/bin/cp', args: ['/etc/hosts', join(session.sessionDirectoryInput, 'hosts')] }),
      signalForeign: await input({ action: 'signal', pid: foreign.pid }),
    };
  };

  const baselineSession = await open({ macosSandbox: false });
  const acceptedBeforeBaseline = control.accepted.length;
  const baselineControls = await controls(baselineSession);
  const baselineAccepted = control.accepted.length - acceptedBeforeBaseline;
  const baselineStop = await baselineSession.stop(4000);
  await baselineSession.dispose();
  record('baseline-without-sandbox', { ...baselineControls, stopConfirmed: baselineStop,
    receiverAccepted: baselineAccepted });

  const guarded = await open();
  report.isolation = guarded.isolation;
  const acceptedBeforeGuarded = control.accepted.length;
  const guardedControls = await controls(guarded);
  const acceptedDuringProbe = control.accepted.length - acceptedBeforeGuarded;
  const guardedStop = await guarded.stop(4000);
  await guarded.dispose();
  record('seatbelt-confined-session', { ...guardedControls, stopConfirmed: guardedStop });

  const denied = (result, expected = 'EPERM') => result.ok === false && result.code === expected;
  report.checks.filesystem = {
    insideWrite: guardedControls.writeInside.ok === true && guardedControls.readInside.ok === true,
    homeRead: denied(guardedControls.readHome), productRead: denied(guardedControls.readProduct),
    outsideRead: denied(guardedControls.readOutside), homeWrite: denied(guardedControls.writeHome),
    outsideWrite: denied(guardedControls.writeOutside),
    baselineAllAllowed: baselineControls.writeInside.ok === true && baselineControls.readHome.ok === true
      && baselineControls.readProduct.ok === true && baselineControls.writeOutside.ok === true,
  };
  report.checks.network = {
    loopback: denied(guardedControls.loopbackReceiver) && acceptedDuringProbe === 0,
    external: denied(guardedControls.externalConnect),
    receiverAccepted: acceptedDuringProbe,
    baselineLoopback: baselineControls.loopbackReceiver.ok === true,
    baselineExternal: baselineControls.externalConnect.ok === true,
  };
  report.checks.execution = {
    foreignBinaryDenied: denied(guardedControls.execForeign),
    foreignSignalDenied: denied(guardedControls.signalForeign),
    baselineExecAllowed: baselineControls.execForeign.ok === true,
    baselineSignalAllowed: baselineControls.signalForeign.ok === true,
    foreignProcessSurvived: alive(foreign.pid),
  };

  // Reaping: the direct child exits first, its descendant must still be collected.
  const exitFirst = await open();
  const spawned = (await exitFirst.input(randomUUID(), 1, { action: 'spawn' })).state;
  assert.equal(spawned.ok, true);
  await exitFirst.input(randomUUID(), 2, { action: 'exit' });
  const exitFact = await exitFirst.settled(8000);
  const exitConfirmed = exitFact?.confirmed === true;
  const descendantGone = await waitGone(spawned.pid, 5000);
  record('direct-child-exits-first', { confirmed: exitConfirmed, descendantPid: spawned.pid, descendantGone,
    exitFact: exitFirst.exitFact });
  await exitFirst.dispose();

  // Reaping: a supervisor killed without any protocol message must not orphan the managed group.
  record('supervisor-killed', await supervisorDeath());

  // Reaping: a stop racing an unresponsive adapter still ends in a confirmed empty group.
  const racing = await open();
  const held = (await racing.input(randomUUID(), 1, { action: 'spawn' })).state;
  await racing.input(randomUUID(), 2, { action: 'ignore-stop' });
  const stopStarted = Date.now();
  const raceConfirmed = await racing.stop(800);
  const raceDescendantGone = await waitGone(held.pid, 5000);
  record('stop-race', { confirmed: raceConfirmed, elapsedMs: Date.now() - stopStarted,
    descendantPid: held.pid, descendantGone: raceDescendantGone, exitFact: racing.exitFact });
  await racing.dispose();

  // Budgets: memory beyond the declared working set, output beyond the declared bytes, time.
  const memorySession = await open({ limits: { memoryMiB: 32 } });
  await memorySession.input(randomUUID(), 1, { action: 'allocate', mib: 16, blocks: 24 }).catch(() => null);
  record('memory-budget', { exitFact: await memorySession.settled(12_000) });
  await memorySession.dispose();

  const outputSession = await open({ limits: { outputBytes: 8192 } });
  await outputSession.input(randomUUID(), 1, { action: 'flood', chunks: 400 }).catch(() => null);
  record('output-budget', { exitFact: await outputSession.settled(12_000) });
  await outputSession.dispose();

  const idleSession = await open({ limits: { idleMs: 1200 } });
  record('idle-budget', { exitFact: await idleSession.settled(12_000) });
  await idleSession.dispose();

  const maxSession = await open({ limits: { maxMs: 1500 } });
  record('max-duration-budget', { exitFact: await maxSession.settled(12_000) });
  await maxSession.dispose();

  report.checks.reaping = {
    directChildFirst: exitConfirmed === true && descendantGone,
    supervisorKilled: results['supervisor-killed'].sessionGone && results['supervisor-killed'].descendantGone,
    stopRace: raceConfirmed === true && raceDescendantGone,
    foreignUnaffected: alive(foreign.pid),
  };
  report.checks.budgets = {
    memory: results['memory-budget'].exitFact?.expired === 'memory',
    output: results['output-budget'].exitFact?.expired === 'output',
    idle: results['idle-budget'].exitFact?.expired === 'idle',
    maxDuration: results['max-duration-budget'].exitFact?.expired === 'max',
  };
  report.checks.isolationApplied = report.isolation?.kind === 'seatbelt'
    && report.isolation?.network === 'denied' && report.isolation?.supervisorDeath === 'session-watchdog';

  process.kill(foreign.pid, 'SIGKILL');
  await control.close();
  await rm(homeFile, { force: true });
  await rm(outsideDirectory, { recursive: true, force: true });
  await rm(sessionRoot, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  const failed = Object.entries(report.checks).filter(([, check]) =>
    Object.values(check).some(item => item === false));
  report.status = failed.length ? 'failed' : 'passed';
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'isolation-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, failed: failed.map(([name]) => name), output }));
  if (report.status !== 'passed') process.exitCode = 1;
}

if (role === 'supervisor-child') {
  const session = await SupervisedSession.create({ adapter: probeAdapter, limits, sessionRoot, nodePath });
  const spawned = (await session.input(randomUUID(), 1, { action: 'spawn' })).state;
  await writeFile(statePath, JSON.stringify({ sessionPid: session.pid, descendantPid: spawned.pid,
    isolation: session.isolation, pgid: spawned.pgid }));
  setInterval(() => {}, 1000);
} else {
  await runAll();
}
