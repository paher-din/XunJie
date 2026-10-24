import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { environmentId, environmentPaths } from '../src/paths.mjs';
import { stopComponent } from '../src/processes.mjs';

const worktree = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');
const cli = join(worktree, 'tools/xj-dev/xj-dev.mjs');

test('use local reports healthy first and reused services after ownership checks outlive keep-alive sockets', { timeout: 120_000 }, t => {
  const parent = mkdtempSync(join(tmpdir(), 'xj-readiness-socket-')), home = join(parent, 'home');
  const instance = `socket-${process.pid}`, preload = join(parent, 'socket-boundary.mjs'), trace = join(parent, 'requests.jsonl');
  // Real TLS gateway and business/Vite processes. Shorten the server's idle
  // lifetime and emulate slow OS ownership queries so its idle socket expires
  // while the CLI event loop is blocked, as observed on Windows. Advertise at
  // least two seconds: Node deliberately avoids pooling sub-second lifetimes.
  writeFileSync(preload, `
import cp from 'node:child_process';
import https from 'node:https';
import {appendFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const originalCreate=https.createServer,originalGet=https.get,originalExec=cp.execFileSync;
https.createServer=function(...args){const server=originalCreate.apply(this,args);server.keepAliveTimeout=2000;server.keepAliveTimeoutBuffer=0;return server;};
https.get=function(url,options,callback){
  const req=originalGet.call(this,url,options,callback);
  req.on('error',error=>appendFileSync(process.env.XJ_READINESS_TRACE,JSON.stringify({path:new URL(url).pathname,code:error.code,reused:req.reusedSocket})+'\\n'));
  return req;
};
cp.execFileSync=function(command,...args){
  if(command==='ps'||command==='powershell'&&args[0].join(' ').includes('Get-CimInstance Win32_Process'))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);
  return originalExec.call(this,command,...args);
};
syncBuiltinESMExports();
`);
  const run = (args, instrument = true) => {
    const result = spawnSync(process.execPath, [cli, ...args, '--worktree', worktree, '--instance', instance], {
      env: { ...process.env, XJ_DEV_HOME: home, ...(instrument ? { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, XJ_READINESS_TRACE: trace } : {}) },
      encoding: 'utf8', timeout: 90000,
    });
    assert.equal(result.error, undefined);
    return { exit: result.status, ...JSON.parse(result.stdout) };
  };
  t.after(() => {
    run(['down'], false);
    rmSync(parent, { recursive: true, force: true, maxRetries: 5 });
  });
  const first = run(['use', 'local']), reused = run(['use', 'local']), fresh = run(['status'], false);
  const errors = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  for (const result of [first, reused, fresh]) {
    assert.equal(result.ok, true, JSON.stringify({ page: result.page, failure: result.failure, errors }));
    assert.equal(result.exit, 0); assert.equal(result.page.serving, true); assert.equal(result.page.apiReady, true);
  }
  assert.deepEqual(first.processes, reused.processes); assert.deepEqual(reused.processes, fresh.processes);
  assert.equal(errors.some(error => error.reused && error.code === 'ECONNRESET'), false);
});

test('local status reports selected-entry readiness through real CLI lifecycle', { timeout: 300_000 }, async t => {
  const parent = mkdtempSync(join(tmpdir(), 'xj-status-'));
  const home = join(parent, 'home');
  const instance = `status-${process.pid}`;
  const paths = environmentPaths(home, environmentId(worktree, instance));
  const run = command => {
    const result = spawnSync(process.execPath, [cli, command, '--json', '--worktree', worktree, '--instance', instance], {
      env: { ...process.env, XJ_DEV_HOME: home }, encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(result.error, undefined);
    const body = JSON.parse(result.stdout);
    assert.equal(result.status === 0, body.ok, body.failure?.code);
    return body;
  };
  const unavailable = body => {
    assert.equal(body.ok, false);
    assert.equal(body.capabilities.frontend.available, false);
    assert.equal(body.capabilities.frontend.hmr, false);
    assert.equal(body.capabilities.api.available, false);
  };
  t.after(() => {
    run('down');
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await t.test('never started is unavailable and status creates no home', () => {
    unavailable(run('status'));
    assert.equal(existsSync(home), false);
    const doctor = run('doctor');
    assert.equal(doctor.ok, true, 'doctor checks prerequisites independently of service readiness');
    assert.equal(doctor.capabilities.frontend.available, false);
    assert.equal(doctor.capabilities.api.available, false);
  });
  await t.test('healthy up and status expose both available capabilities', () => {
    assert.equal(run('up').ok, true);
    for (const command of ['status', 'doctor']) {
      const body = run(command);
      assert.equal(body.ok, true);
      assert.equal(body.capabilities.frontend.available, true);
      assert.equal(body.capabilities.frontend.hmr, true);
      assert.equal(body.capabilities.api.available, true);
    }
  });
  await t.test('backend exit leaves frontend available but API unavailable', async () => {
    assert.equal((await stopComponent(paths, 'backend')).result, 'stopped');
    const body = run('status');
    assert.equal(body.ok, false);
    assert.equal(body.capabilities.frontend.available, true);
    assert.equal(body.capabilities.api.available, false);
  });
  await t.test('Vite exit leaves API available but frontend and HMR unavailable', async () => {
    assert.equal(run('up').ok, true);
    assert.equal((await stopComponent(paths, 'vite')).result, 'stopped');
    const body = run('status');
    assert.equal(body.ok, false);
    assert.equal(body.capabilities.frontend.available, false);
    assert.equal(body.capabilities.frontend.hmr, false);
    assert.equal(body.capabilities.api.available, true);
  });
  await t.test('gateway exit makes both selected-entry capabilities unavailable', async () => {
    assert.equal(run('up').ok, true);
    assert.equal((await stopComponent(paths, 'gateway')).result, 'stopped');
    unavailable(run('status'));
  });
  await t.test('down succeeds, preserves data and credentials, then status is unavailable', () => {
    const credentials = readFileSync(paths.baselineCredentials);
    assert.equal(run('down').ok, true);
    unavailable(run('status'));
    assert.ok(existsSync(paths.database));
    assert.ok(readFileSync(paths.baselineCredentials).equals(credentials), 'down preserves credentials');
  });
});
