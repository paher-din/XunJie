import { execFileSync, spawn } from 'node:child_process';
import { existsSync, globSync, lstatSync, readFileSync, statSync } from 'node:fs';
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
  const manifest = join(appDir, 'package.json');
  const workspace = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : {};
  const patterns = workspace.workspaces?.packages ?? workspace.workspaces ?? [];
  const manifests = globSync(patterns.map(pattern => pattern.replace(/\/$/, '') + '/package.json'), { cwd: appDir });
  return [lockfile, ...(existsSync(manifest) ? [manifest] : []), ...manifests.map(path => join(appDir, path))]
    .every(path => statSync(path).mtimeMs <= statSync(marker).mtimeMs);
}

export async function ensureDependencies(nodePath, appDir, log) {
  let installed = false;
  if (!dependenciesFresh(appDir) || !existsSync(join(appDir, 'node_modules/vite/bin/vite.js'))
    || !existsSync(join(appDir, 'node_modules/typescript/bin/tsc'))) {
    if (existsSync(join(appDir, 'node_modules')) && lstatSync(join(appDir, 'node_modules')).isSymbolicLink()) {
      throw new CliError('dependencies', 'LINKED_DEPENDENCIES_STALE',
        '链接的共享依赖与当前 workspace 不匹配，未执行安装。',
        { recovery: '先准备共享依赖来源；或移除本工作树的 node_modules 链接，再在根目录安装依赖。' });
    }
    installed = true;
    log(`安装依赖：${appDir}（npm ci --include=dev）`);
    const result = await runNode(nodePath, [npmCliJs(nodePath), 'ci', '--include=dev'], { cwd: appDir });
    if (result.code !== 0) {
      throw new CliError('dependencies', 'DEPENDENCY_INSTALL_FAILED',
        `npm ci 失败：${appDir}。${result.stderr.trim().split('\n').pop() || ''}`.trim(),
        { retryable: true, recovery: '核对锁文件与网络后重试 xj-dev up；完整输出见环境日志。' });
    }
  }
  // Public contracts export compiled products. Source-based dev hosts still need those exports.
  const built = await runNode(nodePath, [npmCliJs(nodePath), 'run', 'build', '--workspace', '@xunjie/contracts'], { cwd: appDir });
  if (built.code !== 0) throw new CliError('dependencies', 'CONTRACT_BUILD_FAILED',
    '公共契约构建失败。', { recovery: '在仓库根运行 npm run build --workspace @xunjie/contracts，修复错误后重试。' });
  return { installed };
}
