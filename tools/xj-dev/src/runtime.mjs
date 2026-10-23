import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, normalize } from 'node:path';
import { CliError } from './envelope.mjs';
import { PINNED_NODE, toolHome } from './paths.mjs';

function nodeVersion(binary) {
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

export function locatePinnedRuntime(env = process.env, home = toolHome(env)) {
  const candidates = [];
  if (env.XJ_DEV_NODE_24) candidates.push(env.XJ_DEV_NODE_24);
  if (home) {
    const suffix = process.platform === 'win32' ? 'node.exe' : join('bin', 'node');
    candidates.push(join(home, 'runtime', `node-${PINNED_NODE}-${process.platform}-${process.arch}`, suffix));
  }
  candidates.push(process.execPath);
  candidates.push('node');
  for (const candidate of candidates) {
    const version = nodeVersion(candidate);
    if (version === PINNED_NODE) {
      try {
        const path = isAbsolute(candidate) ? candidate
          : execFileSync(candidate, ['-p', 'process.execPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (isAbsolute(path) && existsSync(path)) return { path: normalize(path), version };
      } catch { continue; }
    }
  }
  throw new CliError('runtime', 'NODE_VERSION_MISMATCH',
    `需要精确的 Node ${PINNED_NODE}（当前进程 ${process.version}，PATH 与受管目录均未找到）。`,
    { recovery: `安装 Node ${PINNED_NODE} 后重试：可从 https://nodejs.org/dist/${PINNED_NODE}/ 下载并放到受管目录 `
        + 'runtime/node-${PINNED_NODE}-<platform>-<arch>/，或设置 XJ_DEV_NODE_24 指向其 node 可执行文件。' });
}

export function npmCliJs(nodePath) {
  const dir = dirname(nodePath);
  const candidates = [
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find(existsSync);
  if (!cli) throw new CliError('dependencies', 'NPM_MISSING', `选定运行时缺少 npm：${nodePath}`,
    { recovery: '安装包含 npm 的完整 Node 发行版，不要只复制 node 可执行文件。' });
  return cli;
}

export function runNode(nodePath, args, options = {}) {
  const env = { ...process.env, ...options.env };
  const pathKey = Object.keys(options.env ?? {}).find(key => key.toLowerCase() === 'path')
    ?? Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const searchPath = env[pathKey] ?? '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env[pathKey] = [dirname(nodePath), searchPath].filter(Boolean).join(delimiter);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(nodePath, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => resolvePromise({ code, stdout, stderr }));
  });
}

export function dependenciesFresh(appDir) {
  const marker = join(appDir, 'node_modules', '.package-lock.json');
  const lockfile = join(appDir, 'package-lock.json');
  if (!existsSync(marker) || !existsSync(lockfile)) return false;
  return statSync(lockfile).mtimeMs <= statSync(marker).mtimeMs;
}

export async function ensureDependencies(nodePath, appDir, log) {
  if (dependenciesFresh(appDir)) return { installed: false };
  log(`安装依赖：${appDir}（npm ci）`);
  const result = await runNode(nodePath, [npmCliJs(nodePath), 'ci'], { cwd: appDir });
  if (result.code !== 0) {
    throw new CliError('dependencies', 'DEPENDENCY_INSTALL_FAILED',
      `npm ci 失败：${appDir}。${result.stderr.trim().split('\n').pop() || ''}`.trim(),
      { retryable: true, recovery: '核对锁文件与网络后重试 xj-dev up；完整输出见环境日志。' });
  }
  return { installed: true };
}
