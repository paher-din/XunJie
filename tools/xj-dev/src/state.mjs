import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { CliError } from './envelope.mjs';

export function loadState(envPaths) {
  if (!existsSync(envPaths.stateFile)) return undefined;
  try {
    return JSON.parse(readFileSync(envPaths.stateFile, 'utf8'));
  } catch {
    throw new CliError('environment', 'STATE_CORRUPT',
      `环境状态文件无法解析：${envPaths.stateFile}`,
      { recovery: '停止环境后删除该环境目录重建，或修复该 JSON 文件。' });
  }
}

export function writeJsonAtomic(file, value, mode = 0o600) {
  const temporary = file + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode });
  renameSync(temporary, file);
}

export function saveState(envPaths, state) {
  mkdirSync(envPaths.root, { recursive: true });
  writeJsonAtomic(envPaths.stateFile, state);
}

export function acquireLock(envPaths) {
  mkdirSync(envPaths.root, { recursive: true });
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(envPaths.lockFile, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
      closeSync(fd);
      return {
        token,
        release() {
          try {
            const current = JSON.parse(readFileSync(envPaths.lockFile, 'utf8'));
            if (current.token === token) rmSync(envPaths.lockFile, { force: true });
          } catch { /* lock already gone */ }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder;
      try { holder = JSON.parse(readFileSync(envPaths.lockFile, 'utf8')); } catch { holder = undefined; }
      const alive = holder && Number.isInteger(holder.pid) && processAlive(holder.pid);
      if (!alive) {
        rmSync(envPaths.lockFile, { force: true });
        continue;
      }
      throw new CliError('lock', 'LOCK_HELD',
        `另一个进程（pid ${holder.pid}）正在操作该环境。`,
        { retryable: true, recovery: '等待其完成后重试；确认对方已退出可删除环境目录中的 lock 文件。' });
    }
  }
  throw new CliError('lock', 'LOCK_HELD', '环境锁竞争持续存在。', { retryable: true });
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
