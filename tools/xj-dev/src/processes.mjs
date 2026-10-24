import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processAlive } from './state.mjs';

export function commandLineOf(pid) {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

export function readComponentRecord(envPaths, name) {
  const file = join(envPaths.pids, `${name}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return { file, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { file };
  }
}

export function componentRunning(envPaths, name) {
  const record = readComponentRecord(envPaths, name);
  if (!record || !Number.isInteger(record.pid)) return { running: false, record };
  if (!processAlive(record.pid)) return { running: false, record };
  const commandLine = commandLineOf(record.pid);
  const owned = typeof commandLine === 'string'
    && commandLine.includes(record.envId) && commandLine.includes(record.scriptMarker);
  return { running: owned, foreign: !owned, commandLine, record };
}

export function spawnComponent(envPaths, name, nodePath, script, args, options = {}) {
  mkdirSync(envPaths.logs, { recursive: true });
  mkdirSync(envPaths.pids, { recursive: true });
  const logFd = openSync(join(envPaths.logs, `${name}.log`), 'a');
  if (options.cooperativeStop) rmSync(join(envPaths.root, `.stop-${name}`), { force: true });
  const child = spawn(nodePath, [script, ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
  });
  closeSync(logFd);
  child.unref();
  const record = {
    pid: child.pid,
    envId: options.envId,
    component: name,
    scriptMarker: script.split(/[\\/]/).pop(),
    startedAtMs: Date.now(),
    startedAt: new Date().toISOString(),
    ...(options.cooperativeStop ? { cooperativeStop: true } : {}),
  };
  writeFileSync(join(envPaths.pids, `${name}.json`), JSON.stringify(record, null, 2) + '\n');
  child.once('exit', code => {
    if (code) {
      try {
        writeFileSync(join(envPaths.logs, `${name}.log`),
          `\n[xj-dev] ${name} exited early with code ${code}\n`, { flag: 'a' });
      } catch { /* log directory removed */ }
    }
  });
  return record;
}

export async function stopComponent(envPaths, name) {
  const status = componentRunning(envPaths, name);
  const record = status.record;
  if (!record) return { component: name, result: 'not-registered' };
  if (status.foreign) {
    return { component: name, result: 'skipped-foreign', pid: record.pid };
  }
  if (!status.running) {
    rmSync(record.file, { force: true });
    return { component: name, result: 'not-running' };
  }
  // Windows SIGTERM terminates Node immediately, skipping its signal handlers.
  // A cooperative request lets connection supervisors first reap their SSH child.
  if (record.cooperativeStop) writeFileSync(join(envPaths.root, `.stop-${name}`), 'stop');
  else process.kill(record.pid, 'SIGTERM');
  for (let waited = 0; waited < 50 && processAlive(record.pid); waited++) await delay(100);
  if (processAlive(record.pid)) {
    process.kill(record.pid, 'SIGKILL');
    for (let waited = 0; waited < 20 && processAlive(record.pid); waited++) await delay(100);
  }
  rmSync(record.file, { force: true });
  return { component: name, result: processAlive(record.pid) ? 'stop-failed' : 'stopped', pid: record.pid };
}
