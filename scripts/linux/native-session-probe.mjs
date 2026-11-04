// Isolation self-check for the Linux restricted session entry.
//
// It runs *inside* the service unit, so every answer below is a fact about the unit the product
// will actually use, not about the host. A check passes only when it would fail on an unconfined
// process: a world-writable sentinel in /usr/local must raise EROFS, a socket to a listener the
// host proved reachable must be refused or denied at socket creation, and a sibling session
// directory the host created must be unreadable. A missing fixture is a failed check, never a
// silent pass.
import { accessSync, constants, readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { connect } from 'node:net';

const workdir = process.argv[2] ?? process.cwd();
const ok = [];
const failed = [];
const codes = {};

function check(name, run) {
  try { run(); ok.push(name); } catch (error) { failed.push(name); codes[name] = error?.code ?? String(error?.message ?? error); }
}

function requireFixture(name) {
  const value = readFileSync(join(workdir, name), 'utf8').trim();
  if (!value) throw new Error(`empty ${name}`);
  return value;
}

function expectReadOnly(path, expectedCode) {
  let result = 'wrote';
  try { writeFileSync(path, 'x', { flag: 'r+' }); } catch (error) { result = error.code ?? 'error'; }
  if (result === 'wrote' || result !== expectedCode)
    throw Object.assign(new Error(`write ${path} returned ${result}`), { code: result });
}

function expectWritable(path) {
  writeFileSync(path, 'x', { flag: 'w' });
}

function expectRead(path, expected) {
  let result = 'readable';
  try { accessSync(path, constants.R_OK); } catch (error) { result = error.code ?? 'error'; }
  if (expected) { if (result !== 'readable') throw Object.assign(new Error(`read ${path} returned ${result}`), { code: result }); }
  else if (result === 'readable') throw new Error(`read ${path} unexpectedly succeeded`);
}

function fixturePath(name, root) {
  const value = requireFixture(name);
  if (!isAbsolute(value) || !value.startsWith(root + '/') || value.includes('..')) throw new Error(`invalid ${name}`);
  return value;
}

/** cgroup v2 limits live at the unit's own cgroup path, not necessarily at the namespace root. */
function cgroupLimit(name) {
  const self = readFileSync('/proc/self/cgroup', 'utf8').trim();
  const suffix = self.slice(self.lastIndexOf(':') + 1);
  for (const path of [join('/sys/fs/cgroup', suffix, name), join('/sys/fs/cgroup', name)]) {
    try { return readFileSync(path, 'utf8').trim(); } catch { /* Try the next mount point. */ }
  }
  throw new Error(`cgroup limit ${name} is unreadable`);
}
/** Only an immediate, positive denial counts; a timeout is what an unconfined firewall looks like. */
const deniedCodes = new Set(['EAFNOSUPPORT', 'EPERM', 'EACCES', 'ENETUNREACH', 'EHOSTUNREACH',
  'ECONNREFUSED', 'ENETDOWN', 'EPROTONOSUPPORT', 'ENOTSOCK']);
const tcpDenied = (host, port) => new Promise(resolve => {
  let socket;
  try { socket = connect({ host, port }); }
  catch (error) { resolve({ denied: deniedCodes.has(error.code), code: error.code ?? 'throw' }); return }
  const done = value => { socket.destroy(); resolve(value) };
  socket.setTimeout(1500);
  socket.once('connect', () => done({ denied: false, code: 'connected' }));
  socket.once('timeout', () => done({ denied: false, code: 'timeout' }));
  socket.once('error', error => done({ denied: deniedCodes.has(error.code), code: error.code ?? 'error' }));
});

const stateRoot = process.env.XJ_STATE_ROOT ?? '';
const sentinel = process.env.XJ_RO_SENTINEL ?? '';
const workRoot = process.env.XJ_WORK_ROOT ?? '';
function maybeFixture(name) {
  try { return readFileSync(join(workdir, name), 'utf8').trim(); } catch { return '' }
}
const hostConfirmed = maybeFixture('.probe-host-confirmed');

check('fixtures', () => {
  if (!isAbsolute(stateRoot) || !isAbsolute(sentinel) || !isAbsolute(workRoot)) throw new Error('missing host fixtures');
  if (hostConfirmed !== 'yes') throw new Error('host listener was not confirmed');
  if (readFileSync(join(workdir, '.probe-port'), 'utf8').trim().length === 0) throw new Error('missing loopback port');
});
check('sentinel-visible', () => expectRead(sentinel, true));
check('system-readonly', () => expectReadOnly(sentinel, 'EROFS'));
check('session-writable', () => expectWritable(join(workdir, '.probe-write')));
for (const path of ['/tmp', '/var/tmp', '/dev/shm']) check('temporary-readonly:' + path, () => {
  try { writeFileSync(join(path, 'xj-probe-' + process.pid), 'x', { flag: 'wx' }); }
  catch (error) { if (error.code === 'EROFS') return; throw error; }
  throw new Error('temporary directory is writable');
});
check('school-state-inaccessible', () => expectRead(stateRoot, false));
check('host-process-inaccessible', () => {
  const pid = requireFixture('.probe-host-pid');
  if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('invalid host process fixture');
  let blocked = false;
  try { readFileSync(`/proc/${pid}/environ`); } catch (error) {
    blocked = ['EACCES', 'EPERM', 'ENOENT'].includes(error.code);
  }
  if (!blocked) throw new Error('host process environment is readable');
});
check('sibling-session-inaccessible', () => expectRead(fixturePath('.probe-sibling', workRoot), false));
check('home-inaccessible', () => expectRead('/home', false));
check('system-readable', () => expectRead('/etc/hostname', true));
check('cgroup-memory-limit', () => {
  const value = cgroupLimit('memory.max');
  if (!/^[0-9]+$/.test(value) || BigInt(value) >= BigInt(1) << BigInt(60)) throw new Error('memory.max is unlimited');
  codes['cgroup-memory-limit'] = value;
});
check('cgroup-process-limit', () => {
  const value = cgroupLimit('pids.max');
  if (!/^[0-9]+$/.test(value)) throw new Error('pids.max is unlimited');
  codes['cgroup-process-limit'] = value;
});

let loopback = { denied: false, code: 'fixture-missing' };
let internet = { denied: false, code: 'fixture-missing' };
if (ok.includes('fixtures')) {
  const port = Number(readFileSync(join(workdir, '.probe-port'), 'utf8').trim());
  loopback = await tcpDenied('127.0.0.1', port);
  internet = await tcpDenied('1.1.1.1', 443);
}
check('loopback-denied', () => { if (!loopback.denied) throw Object.assign(new Error(loopback.code), { code: loopback.code }) });
check('internet-denied', () => { if (!internet.denied) throw Object.assign(new Error(internet.code), { code: internet.code }) });

const fact = {
  kind: 'systemd-unit',
  unit: process.env.XJ_SESSION_UNIT ?? null,
  network: ok.includes('loopback-denied') && ok.includes('internet-denied') ? 'denied' : 'unrestricted',
  reads: ['school-state-inaccessible', 'sibling-session-inaccessible', 'home-inaccessible', 'host-process-inaccessible'].every(item => ok.includes(item))
    ? 'system-runtime-and-session' : 'unrestricted',
  writes: ok.includes('system-readonly') && ok.includes('session-writable') ? 'session-directory' : 'unrestricted',
  processes: ok.includes('cgroup-process-limit') ? 'control-group-confirmed' : 'unrestricted',
  memory: ok.includes('cgroup-memory-limit') ? 'cgroup-v2' : 'unrestricted',
  measured: { loopback, internet, hostConfirmed, stateRoot, sentinel, codes },
  checks: { passed: ok, failed },
};

process.stdout.write(JSON.stringify(fact) + '\n');
process.exitCode = fact.network === 'denied' && fact.writes === 'session-directory'
  && fact.reads === 'system-runtime-and-session' && fact.processes === 'control-group-confirmed'
  && fact.memory === 'cgroup-v2' && failed.length === 0 ? 0 : 1;
