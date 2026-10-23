import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CliError } from './envelope.mjs';

export const TOOL_VERSION = '0.1.0';
export const PINNED_NODE = 'v24.21.0';

export function toolHome(env = process.env) {
  return env.XJ_DEV_HOME ? resolve(env.XJ_DEV_HOME) : join(homedir(), '.xunjie', 'xj-dev');
}

export function findWorktreeRoot(start) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, '.git'))) return realpathSync(current);
    const parent = dirname(current);
    if (parent === current) {
      throw new CliError('environment', 'NOT_A_WORKTREE',
        `当前目录 ${resolve(start)} 不在 Git 工作树内。`,
        { recovery: '在 XunJie 仓库的工作树内运行，或用 --worktree <path> 指定。' });
    }
    current = parent;
  }
}

export function environmentId(worktreeRoot, instance = '') {
  return createHash('sha256').update(worktreeRoot + '\0' + instance).digest('hex').slice(0, 12);
}

export function environmentPaths(home, id) {
  const root = join(home, 'envs', id);
  return {
    root,
    data: join(root, 'data'),
    database: join(root, 'data', 'xunjie.sqlite'),
    baselineFile: join(root, 'data', 'baseline.json'),
    personalModels: join(root, 'personal-agent'),
    logs: join(root, 'logs'),
    pids: join(root, 'pids'),
    tls: join(root, 'tls'),
    browserProfile: join(root, 'browser-profile'),
    viteCache: join(root, 'vite-cache'),
    stateFile: join(root, 'environment.json'),
    lockFile: join(root, 'lock'),
    secrets: join(root, 'secrets'),
    signingSecret: join(root, 'secrets', 'signing-secret'),
    baselineCredentials: join(root, 'secrets', 'baseline-accounts.json'),
  };
}

export function repoPaths(worktreeRoot) {
  return {
    student: join(worktreeRoot, 'apps', 'student'),
    teaching: join(worktreeRoot, 'apps', 'teaching'),
    studentLockfile: join(worktreeRoot, 'apps', 'student', 'package-lock.json'),
    teachingLockfile: join(worktreeRoot, 'apps', 'teaching', 'package-lock.json'),
    backendHostScript: join(worktreeRoot, 'tools', 'xj-dev', 'src', 'backend-host.mjs'),
    gatewayScript: join(worktreeRoot, 'tools', 'xj-dev', 'src', 'gateway.mjs'),
  };
}
