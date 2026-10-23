import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError } from './envelope.mjs';
import { PINNED_NODE, TOOL_VERSION, environmentId, environmentPaths, findWorktreeRoot, repoPaths, toolHome } from './paths.mjs';
import { dependenciesFresh, ensureDependencies, locatePinnedRuntime } from './runtime.mjs';
import { acquireLock, loadState, saveState } from './state.mjs';
import { allocatePorts, portFree } from './ports.mjs';
import { componentRunning, spawnComponent, stopComponent } from './processes.mjs';
import { certificateTrustHint, ensureCertificateAuthority, ensureEnvironmentCertificate, opensslAvailable } from './certificates.mjs';
import { BASELINE_VERSION, baselineAccounts, ensureBaseline } from './baseline.mjs';

const COMPONENTS = ['gateway', 'backend', 'vite'];

export function resolveContext(options = {}) {
  const worktree = findWorktreeRoot(options.worktree ?? process.cwd());
  const instance = options.instance ?? '';
  const home = toolHome();
  const id = environmentId(worktree, instance);
  return { worktree, instance, home, id, env: environmentPaths(home, id), repo: repoPaths(worktree) };
}

function capabilitiesBlock() {
  return {
    frontend: { available: true, hmr: true, source: 'worktree apps/student via Vite' },
    api: { available: true, source: 'worktree apps/teaching（源码直接运行）' },
    execution: { available: false, reason: '本地闭环未接入执行节点；运行/仿真请求返回 RUNTIME_NOT_READY' },
    models: { available: false, reason: '未配置模型凭据，个人模型调用已停用' },
  };
}

function environmentBlock(context, state) {
  return {
    id: context.id,
    ...(context.instance ? { instance: context.instance } : {}),
    worktree: context.worktree,
    root: context.env.root,
    mode: 'local',
    baselineVersion: state?.baselineVersion ?? 'not-initialized',
  };
}

function dataBlock(context) {
  return {
    database: context.env.database,
    personalModels: context.env.personalModels,
    browserProfile: context.env.browserProfile,
    ownership: '本工作树独立副本；其他工作树的环境各自独立',
  };
}

function accountsBlock(context) {
  return {
    list: baselineAccounts.map(({ loginName, role }) => ({ loginName, role })),
    credentials: {
      file: context.env.baselineCredentials,
      note: '密码只写在该文件（0600）中，不进入 JSON 输出与日志；首次 up 构造基线时随机生成。',
    },
  };
}

function probe(url, tls = false) {
  return new Promise(resolvePromise => {
    const request = (tls ? httpsGet : httpGet)(url, tls ? { rejectUnauthorized: false } : {}, response => {
      response.resume();
      resolvePromise({ ok: true, status: response.statusCode });
    });
    request.setTimeout(5000, () => request.destroy(new Error('probe timeout')));
    request.on('error', () => resolvePromise({ ok: false }));
  });
}

async function waitFor(label, check, timeoutMs, diagnose) {
  const deadline = Date.now() + timeoutMs;
  let last = '尚未响应';
  while (Date.now() < deadline) {
    const result = await check();
    if (result.ok) return result;
    last = result.status ? `HTTP ${result.status}` : '连接失败';
    await delay(250);
  }
  const diagnosis = diagnose ? `；诊断：${diagnose()}` : '';
  throw new CliError('health', 'HEALTH_TIMEOUT',
    `${label} 在 ${Math.round(timeoutMs / 1000)} 秒内未就绪（最后状态：${last}${diagnosis}）。`,
    { retryable: true, recovery: '查看环境 logs/ 下对应组件日志定位原因后重试 xj-dev up。' });
}

function componentDiagnosis(context, name) {
  return () => {
    const current = componentRunning(context.env, name);
    return current.running
      ? `进程 pid ${current.record?.pid} 仍在运行，但健康检查未通过`
      : `进程已退出（退出码见 ${join(context.env.logs, `${name}.log`)} 末尾）`;
  };
}

function newestSourceMtimeMs(teachingDir) {
  let newest = 0;
  for (const scope of ['server', 'contracts']) {
    const walk = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) newest = Math.max(newest, statSync(path).mtimeMs);
      }
    };
    walk(join(teachingDir, scope));
  }
  return newest;
}

function ensureSigningSecret(envPaths) {
  if (existsSync(envPaths.signingSecret)) return;
  mkdirSync(envPaths.secrets, { recursive: true, mode: 0o700 });
  writeFileSync(envPaths.signingSecret, randomBytes(48).toString('hex') + '\n', { mode: 0o600 });
}

async function componentStatuses(context) {
  const result = {};
  for (const name of COMPONENTS) result[name] = componentRunning(context.env, name);
  return result;
}

export async function doctor(context) {
  const checks = [];
  let runtime;
  try {
    runtime = locatePinnedRuntime(process.env, context.home);
    checks.push({ name: 'runtime', ok: true, detail: `${runtime.version} @ ${runtime.path}` });
  } catch (error) {
    checks.push({ name: 'runtime', ok: false, detail: error.message, recovery: error.recovery });
  }
  const repository = ['apps/student/package.json', 'apps/student/package-lock.json', 'apps/teaching/package.json', 'apps/teaching/package-lock.json']
    .every(relative => existsSync(join(context.worktree, relative)));
  checks.push(repository
    ? { name: 'repository', ok: true, detail: context.worktree }
    : { name: 'repository', ok: false, detail: 'apps/student 或 apps/teaching 的清单/锁文件缺失', recovery: '确认在完整 XunJie 工作树中运行。' });
  for (const [name, dir] of [['student', context.repo.student], ['teaching', context.repo.teaching]]) {
    checks.push(dependenciesFresh(dir)
      ? { name: `dependencies:${name}`, ok: true, detail: '已安装且与锁文件一致' }
      : { name: `dependencies:${name}`, ok: true, detail: '未安装或锁文件较新，首次 up 将自动 npm ci' });
  }
  checks.push(opensslAvailable()
    ? { name: 'openssl', ok: true, detail: '可用于本地开发证书' }
    : { name: 'openssl', ok: false, detail: 'PATH 中未找到 openssl', recovery: 'macOS 自带 LibreSSL；Windows 安装 Git for Windows 或 OpenSSL。' });
  try {
    mkdirSync(context.home, { recursive: true });
    const probeFile = join(context.home, '.write-probe');
    writeFileSync(probeFile, 'ok');
    checks.push({ name: 'toolHome', ok: true, detail: context.home });
    rmSync(probeFile, { force: true });
  } catch (error) {
    checks.push({ name: 'toolHome', ok: false, detail: `工具目录不可写：${error.message}`, recovery: '检查目录权限或设置 XJ_DEV_HOME 到可写位置。' });
  }
  const caExists = existsSync(join(context.home, 'ca', 'ca-cert.pem'));
  checks.push({
    name: 'certificateAuthority', ok: true,
    detail: caExists ? `已创建：${join(context.home, 'ca', 'ca-cert.pem')}；${certificateTrustHint(context.home)}` : '首次 up 自动创建本地开发 CA',
  });
  const state = loadState(context.env);
  const statuses = await componentStatuses(context);
  const running = COMPONENTS.filter(name => statuses[name].running);
  checks.push({
    name: 'environment', ok: true,
    detail: state
      ? `环境 ${context.id}（${running.length ? '运行中：' + running.join(',') : '未运行'}，基线 ${state.baselineVersion}）`
      : `环境 ${context.id} 尚未初始化，首次 up 自动建立`,
  });
  const ok = checks.every(check => check.ok);
  return {
    ok,
    environment: environmentBlock(context, state),
    checks,
    capabilities: capabilitiesBlock(),
    pinnedRuntime: PINNED_NODE,
    next: ok ? ['xj-dev up --json'] : ['按 recovery 修复失败检查后重试 doctor'],
  };
}

async function spawnBackend(context, runtime, ports) {
  const configFile = join(context.env.root, 'backend-config.json');
  mkdirSync(context.env.root, { recursive: true });
  writeFileSync(configFile, JSON.stringify({
    teachingDir: context.repo.teaching,
    databaseFile: context.env.database,
    personalModelsDirectory: context.env.personalModels,
    signingSecretFile: context.env.signingSecret,
    origin: `https://127.0.0.1:${ports.gateway}`,
    port: ports.backend,
  }, null, 2));
  return spawnComponent(context.env, 'backend', runtime.path, context.repo.backendHostScript, ['--config', configFile], { envId: context.id });
}

async function spawnVite(context, runtime, ports) {
  const viteBin = join(context.repo.student, 'node_modules', 'vite', 'bin', 'vite.js');
  return spawnComponent(context.env, 'vite', runtime.path,
    viteBin, ['--host', '127.0.0.1', '--port', String(ports.vite), '--strictPort', '--clearScreen', 'false', '--mode', `xjdev${context.id}`],
    { envId: context.id, cwd: context.repo.student, env: { XUNJIE_VITE_CACHE_DIR: context.env.viteCache } });
}

async function spawnGateway(context, runtime, ports, certificate) {
  const configFile = join(context.env.root, 'gateway-config.json');
  mkdirSync(context.env.root, { recursive: true });
  writeFileSync(configFile, JSON.stringify({
    port: ports.gateway, backendPort: ports.backend, vitePort: ports.vite,
    keyFile: certificate.keyFile, certFile: certificate.certFile,
  }, null, 2));
  return spawnComponent(context.env, 'gateway', runtime.path, context.repo.gatewayScript, ['--config', configFile], { envId: context.id });
}

async function portConflictError(context, component, port) {
  let owner = '未知进程';
  try {
    const { execFileSync } = await import('node:child_process');
    const out = process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess`], { encoding: 'utf8' })
      : execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pc'], { encoding: 'utf8' });
    owner = out.trim().split('\n').join(' ') || owner;
  } catch { /* best effort */ }
  return new CliError('ports', 'PORT_IN_USE',
    `端口 ${port}（${component}）已被占用：${owner}`,
    { recovery: '停止占用进程后重试；不要手动改环境端口文件。若占用者竟是本环境残留进程，先运行 xj-dev down。' });
}

export async function up(context, log) {
  const lock = acquireLock(context.env);
  const stages = [];
  const startedNow = [];
  try {
    const runtime = locatePinnedRuntime(process.env, context.home);
    stages.push({ name: 'runtime', ok: true, detail: runtime.path });

    await ensureDependencies(runtime.path, context.repo.student, log);
    await ensureDependencies(runtime.path, context.repo.teaching, log);
    stages.push({ name: 'dependencies', ok: true });

    const ca = ensureCertificateAuthority(context.home);
    const certificate = ensureEnvironmentCertificate(context.env, ca);
    stages.push({ name: 'certificates', ok: true, detail: ca.created ? '已创建开发 CA；' + certificateTrustHint(context.home) : undefined });

    let state = loadState(context.env);
    const statuses = await componentStatuses(context);
    for (const [name, status] of Object.entries(statuses)) {
      if (status.foreign) {
        log(`组件 ${name} 的登记 pid ${status.record.pid} 已被无关进程复用，清除过期登记`);
        rmSync(status.record.file, { force: true });
        statuses[name] = { running: false };
      }
    }
    let ports = state?.ports;
    if (!ports) {
      ports = await allocatePorts(context.id + context.instance);
      if (!ports) throw new CliError('ports', 'PORT_ALLOCATION_FAILED', '无法在本机分配三个连续端口。', { retryable: true });
    }
    for (const name of COMPONENTS) {
      if (!statuses[name].running && !await portFree(ports[name])) {
        throw await portConflictError(context, name, ports[name]);
      }
    }
    stages.push({ name: 'ports', ok: true, detail: `gateway=${ports.gateway} backend=${ports.backend} vite=${ports.vite}` });

    const baseline = await ensureBaseline(context.repo.teaching, context.env, log);
    ensureSigningSecret(context.env);
    mkdirSync(context.env.browserProfile, { recursive: true });
    stages.push({ name: 'baseline', ok: true, detail: baseline.created ? `已构造 ${baseline.version}` : `沿用 ${baseline.version}` });

    const backendStatus = statuses.backend;
    if (backendStatus.running && newestSourceMtimeMs(context.repo.teaching) > (backendStatus.record.startedAtMs ?? 0)) {
      log('后端源码较新，重启 backend');
      await stopComponent(context.env, 'backend');
      backendStatus.running = false;
    }
    if (!backendStatus.running) {
      await spawnBackend(context, runtime, ports);
      startedNow.push('backend');
      log(`启动 backend（127.0.0.1:${ports.backend}）`);
    }
    await waitFor('backend', async () => {
      const probeResult = await probe(`http://127.0.0.1:${ports.backend}/health/ready`);
      return { ok: probeResult.ok && probeResult.status === 200, status: probeResult.status };
    }, 90000, componentDiagnosis(context, 'backend'));
    stages.push({ name: 'health:backend', ok: true });

    if (!statuses.vite.running) {
      await spawnVite(context, runtime, ports);
      startedNow.push('vite');
      log(`启动 vite（127.0.0.1:${ports.vite}）`);
    }
    await waitFor('vite', async () => {
      const probeResult = await probe(`http://127.0.0.1:${ports.vite}/`);
      return { ok: probeResult.ok && probeResult.status === 200, status: probeResult.status };
    }, 60000, componentDiagnosis(context, 'vite'));
    stages.push({ name: 'health:vite', ok: true });

    if (!statuses.gateway.running) {
      await spawnGateway(context, runtime, ports, certificate);
      startedNow.push('gateway');
      log(`启动 gateway（https://127.0.0.1:${ports.gateway}）`);
    }
    await waitFor('gateway', async () => {
      const api = await probe(`https://127.0.0.1:${ports.gateway}/health/ready`, true);
      const page = await probe(`https://127.0.0.1:${ports.gateway}/`, true);
      return { ok: api.ok && api.status === 200 && page.ok && page.status === 200, status: api.status };
    }, 30000, componentDiagnosis(context, 'gateway'));
    stages.push({ name: 'health:gateway', ok: true });

    const now = new Date().toISOString();
    saveState(context.env, {
      version: 1,
      envId: context.id,
      instance: context.instance,
      worktree: context.worktree,
      baselineVersion: baseline.version,
      ports,
      createdAt: state?.createdAt ?? now,
      updatedAt: now,
    });
    const refreshed = await componentStatuses(context);
    return {
      environment: environmentBlock(context, { baselineVersion: baseline.version }),
      runtime: { node: runtime.version, path: runtime.path },
      page: { url: `https://127.0.0.1:${ports.gateway}` },
      data: dataBlock(context),
      processes: Object.fromEntries(COMPONENTS.map(name => [name, {
        running: refreshed[name].running,
        ...(refreshed[name].record?.pid ? { pid: refreshed[name].record.pid } : {}),
        port: ports[name],
      }])),
      capabilities: capabilitiesBlock(),
      accounts: accountsBlock(context),
      stages,
      next: [`浏览器打开 https://127.0.0.1:${ports.gateway}（首次需信任开发 CA 或临时继续）`, 'xj-dev status --json 查看状态'],
    };
  } catch (error) {
    for (const name of startedNow.reverse()) {
      await stopComponent(context.env, name);
    }
    if (error instanceof CliError) error.stages = stages;
    throw error;
  } finally {
    lock.release();
  }
}

export async function status(context) {
  const state = loadState(context.env);
  const statuses = await componentStatuses(context);
  const ports = state?.ports;
  const processes = {};
  for (const name of COMPONENTS) {
    processes[name] = {
      running: statuses[name].running,
      ...(statuses[name].record?.pid ? { pid: statuses[name].record.pid } : {}),
      ...(ports ? { port: ports[name] } : {}),
    };
  }
  let page;
  if (ports && statuses.gateway.running) {
    const pageProbe = await probe(`https://127.0.0.1:${ports.gateway}/`, true);
    const apiProbe = await probe(`https://127.0.0.1:${ports.gateway}/health/ready`, true);
    page = {
      url: `https://127.0.0.1:${ports.gateway}`,
      serving: pageProbe.ok && pageProbe.status === 200,
      apiReady: apiProbe.ok && apiProbe.status === 200,
    };
  }
  const baselineDrift = state && state.baselineVersion !== BASELINE_VERSION;
  const checks = [
    ...COMPONENTS.map(name => ({ name: `process:${name}`, ok: statuses[name].running === true })),
    ...(page ? [
      { name: 'gateway:serving', ok: page.serving === true },
      { name: 'api:ready', ok: page.apiReady === true },
    ] : []),
  ];
  return {
    environment: environmentBlock(context, state),
    processes,
    ...(page ? { page } : {}),
    data: dataBlock(context),
    baseline: {
      current: state?.baselineVersion ?? 'not-initialized',
      pinned: BASELINE_VERSION,
      ...(baselineDrift ? { note: '环境基线与代码固定版本不同；已有数据保持不变，不会自动重置' } : {}),
    },
    capabilities: capabilitiesBlock(),
    browser: {
      profile: context.env.browserProfile,
      note: '使用该目录作为浏览器用户数据目录（如 --user-data-dir）可得到本环境独立的浏览器身份',
    },
    accounts: accountsBlock(context),
    checks,
    next: statuses.gateway.running && ports
      ? [`浏览器打开 https://127.0.0.1:${ports.gateway}`, 'xj-dev down --json 停止环境']
      : ['xj-dev up --json 启动环境'],
  };
}

export async function down(context) {
  const lock = acquireLock(context.env);
  try {
    const stopped = [];
    for (const name of ['gateway', 'vite', 'backend']) {
      stopped.push(await stopComponent(context.env, name));
    }
    return {
      environment: environmentBlock(context, loadState(context.env)),
      stopped,
      data: { ...dataBlock(context), note: '停止不删除数据；数据库与个人模型目录保持原样' },
      next: ['xj-dev up --json 重新启动并沿用原数据'],
    };
  } finally {
    lock.release();
  }
}
