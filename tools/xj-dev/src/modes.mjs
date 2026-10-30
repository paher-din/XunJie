import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureCertificateAuthority, ensureEnvironmentCertificate } from './certificates.mjs';
import { connectionError, loadConnection } from './connection.mjs';
import { CliError } from './envelope.mjs';
import { environmentPaths } from './paths.mjs';
import { enrollmentSelection } from './enrollment-routes.mjs';
import { allocatePorts, portFree } from './ports.mjs';
import { componentRunning, spawnComponent, stopComponent } from './processes.mjs';
import { ensureDependencies, locatePinnedRuntime } from './runtime.mjs';
import { acquireLock, loadState, saveState, writeJsonAtomic } from './state.mjs';

export const MODES = ['local', 'cloud-api', 'cloud'];
export const selectionFile = context => join(context.env.root, 'selection.json');
export function loadSelection(context) {
  if (!existsSync(selectionFile(context))) return { mode: 'local', targets: {} };
  return JSON.parse(readFileSync(selectionFile(context), 'utf8'));
}
function modeContext(context, mode, c) {
  const id = createHash('sha256').update(`${context.id}:${mode}:${c.id}`).digest('hex').slice(0, 12);
  return { ...context, id, env: environmentPaths(context.home, id) };
}
function readStatus(ctx, kind = 'page') {
  try { return JSON.parse(readFileSync(join(ctx.env.root, `${kind}-connection-status.json`), 'utf8')); } catch { return { state: 'disconnected' }; }
}
function gatewayResponds(context, port, path) {
  return new Promise(done => {
    let request;
    try {
      request = httpsGet(`https://127.0.0.1:${port}${path}`, {
        ca: readFileSync(join(context.home, 'ca', 'ca-cert.pem')), rejectUnauthorized: true, agent: false,
      }, response => { response.resume(); done(response.statusCode === 200); });
    } catch { done(false); return; }
    request.on('error', () => done(false));
    request.setTimeout(1500, () => request.destroy());
  });
}
async function freePort(context, name, port) {
  if (componentRunning(context.env, name).running || await portFree(port)) return;
  const { portConflictError } = await import('./commands.mjs');
  throw await portConflictError(context, name, port);
}

async function startConnection(context, c, runtime, localPort, kind = 'page') {
  const name = kind === 'node' ? 'node-connection' : 'connection';
  const statusFile = join(context.env.root, `${kind}-connection-status.json`);
  const current = componentRunning(context.env, name);
  if (current.running && readStatus(context, kind).state === 'stopped') await stopComponent(context.env, name);
  if (!componentRunning(context.env, name).running) {
    rmSync(statusFile, { force: true });
    const configFile = join(context.env.root, `${kind}-connection-config.json`);
    writeJsonAtomic(configFile, { connectionFile: c.file, identityFile: c.identityFile, localPort, kind, statusFile, stopFile: join(context.env.root, `.stop-${name}`) });
    spawnComponent(context.env, name, runtime.path, join(context.worktree, 'tools/xj-dev/src/connection-host.mjs'), ['--config', configFile], { envId: context.id, cooperativeStop: true });
  }
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const status = readStatus(context, kind);
    if (status.state === 'ready' && Date.now() - Date.parse(status.checkedAt) < 45000) return status;
    if (status.state === 'stopped' || !componentRunning(context.env, name).running) {
      // A terminal SSH failure may be published between the first read and the
      // process check. Read its final reason instead of losing it to a generic error.
      const finalStatus = readStatus(context, kind);
      throw connectionError(finalStatus.failure?.code ?? 'CLOUD_UNREACHABLE', finalStatus.failure?.retryable ?? false);
    }
    await delay(200);
  }
  const lastStatus = readStatus(context, kind);
  throw connectionError(lastStatus.failure?.code ?? 'CLOUD_UNREACHABLE', lastStatus.failure?.retryable ?? true);
}

async function prepareRemote(context, mode, options, log) {
  const c = loadConnection(options.connection, { identity: options.identity });
  const ctx = modeContext(context, mode, c);
  const lock = acquireLock(ctx.env);
  const created = [];
  try {
    const runtime = locatePinnedRuntime(process.env, context.home);
    let state = loadState(ctx.env);
    const ports = state?.ports ?? await allocatePorts(ctx.id);
    if (!ports) throw new CliError('ports', 'PORT_ALLOCATION_FAILED', '无法分配模式端口。');
    for (const [name, port] of [['gateway', ports.gateway], ['connection', ports.backend], ...(mode === 'cloud-api' ? [['vite', ports.vite]] : [])]) await freePort(ctx, name, port);
    const ca = ensureCertificateAuthority(context.home);
    const certificate = ensureEnvironmentCertificate(ctx.env, ca);
    if (certificate.created && componentRunning(ctx.env, 'gateway').running) {
      log('环境证书已更新，重启本环境 gateway（数据与入口保持原样）');
      const stopped = await stopComponent(ctx.env, 'gateway');
      if (['stop-failed', 'skipped-foreign'].includes(stopped.result)) {
        throw new CliError('certificates', 'GATEWAY_RESTART_REQUIRED', '无法安全重启持有旧证书的 gateway。',
          { recovery: '在同一工作树、instance 与模式执行 down 后 up；保留原 CA 和环境数据，不接管外来进程。' });
      }
    }
    for (const name of ['connection', 'vite', 'gateway']) if (!componentRunning(ctx.env, name).running) created.push(name);
    const connection = await startConnection(ctx, c, runtime, ports.backend);
    if (mode === 'cloud-api') {
      await ensureDependencies(runtime.path, ctx.worktree, log);
      if (!componentRunning(ctx.env, 'vite').running) {
        spawnComponent(ctx.env, 'vite', runtime.path, ctx.repo.viteBin, ['--host', '127.0.0.1', '--port', String(ports.vite), '--strictPort', '--clearScreen', 'false', '--mode', `xjdev${ctx.id}`], { envId: ctx.id, cwd: ctx.repo.web, env: { XUNJIE_VITE_CACHE_DIR: ctx.env.viteCache } });
      }
      const { get } = await import('node:http');
      await waitHttp(() => new Promise(done => { const req = get(`http://127.0.0.1:${ports.vite}/`, res => { res.resume(); done(res.statusCode === 200); }); req.on('error', () => done(false)); req.setTimeout(1500, () => req.destroy()); }), 'Vite');
    }
    const configFile = join(ctx.env.root, 'gateway-config.json');
    const cookieName = `__Host-xunjie-${ctx.id}-${mode}`;
    if (!componentRunning(ctx.env, 'gateway').running) {
      writeJsonAtomic(configFile, { mode, port: ports.gateway, backendPort: ports.backend, vitePort: ports.vite, keyFile: certificate.keyFile, certFile: certificate.certFile, cookieName, cloud: { browserOrigin: c.browserOrigin, caFile: c.caFile }, connectionStatusFile: join(ctx.env.root, 'page-connection-status.json') });
      spawnComponent(ctx.env, 'gateway', runtime.path, ctx.repo.gatewayScript, ['--config', configFile], { envId: ctx.id });
    }
    const { get } = await import('node:https');
    await waitHttp(() => new Promise((done, reject) => {
      const req = get(`https://127.0.0.1:${ports.gateway}/health/ready`, { ca: readFileSync(ca.certFile), rejectUnauthorized: true }, res => { res.resume(); done(res.statusCode === 200); });
      req.on('error', error => {
        if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? '')) reject(new CliError('certificates', 'GATEWAY_TLS_INVALID', '运行中的 gateway 未通过本环境 CA 的 HTTPS 校验。',
          { recovery: '在同一工作树、instance 与模式执行 down 后 up，重新加载已修复证书；保留原 CA 和环境数据。' }));
        else done(false);
      });
      req.setTimeout(1500, () => req.destroy());
    }), 'HTTPS gateway');
    mkdirSync(ctx.env.browserProfile, { recursive: true });
    state = { version: 1, mode, envId: ctx.id, ports, worktree: ctx.worktree, connectionFile: c.file, identityFile: c.identityFile, target: c.id, browserOrigin: c.browserOrigin, business: connection.business, createdAt: state?.createdAt ?? new Date().toISOString() };
    saveState(ctx.env, state);
    // Persist an identity override only when the caller explicitly selected it.
    // Otherwise up must reread the approved config, including rotated key paths.
    return { id: ctx.id, root: ctx.env.root, mode, connectionFile: c.file, ...(options.identity ? { identityFile: c.identityFile } : {}) };
  } catch (error) {
    for (const name of created.reverse()) await stopComponent(ctx.env, name);
    throw error;
  } finally { lock.release(); }
}
async function waitHttp(check, name) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await delay(200); }
  throw new CliError('health', 'HEALTH_TIMEOUT', `${name} 未就绪；原入口保持不变。`, { retryable: true });
}
function selectedContext(context, entry) {
  return { ...context, id: entry.id, env: environmentPaths(context.home, entry.id) };
}

export async function useMode(context, mode, options = {}, log = () => {}) {
  if (!MODES.includes(mode)) throw new CliError('arguments', 'UNKNOWN_MODE', '模式必须为 local、cloud-api 或 cloud。');
  const lock = acquireLock({ ...context.env, lockFile: join(context.env.root, 'selection.lock') });
  try {
    const selection = loadSelection(context);
    if (mode === 'local') {
      const { upLocal } = await import('./commands.mjs');
      await upLocal(context, log);
    } else {
      options = { ...options, connection: options.connection ?? enrollmentSelection(context)?.connectionFile ?? selection.targets?.[mode]?.connectionFile, identity: options.identity ?? (options.connection ? undefined : selection.targets?.[mode]?.identityFile) };
      if (!options.connection) throw connectionError('CONNECTION_INVALID');
      const entry = await prepareRemote(context, mode, options, log);
      selection.targets ??= {};
      // Keep old target entries so down can stop every owned environment. Existing
      // tabs keep their original routing even after a config points somewhere else.
      selection.retained ??= [];
      if (selection.targets[mode] && selection.targets[mode].id !== entry.id) selection.retained.push(selection.targets[mode]);
      selection.targets[mode] = entry;
    }
    selection.mode = mode;
    writeJsonAtomic(selectionFile(context), selection);
    return await modeStatus(context);
  } finally { lock.release(); }
}

export async function modeUp(context, log) {
  const selection = loadSelection(context);
  if (selection.mode === 'local') { const { upLocal } = await import('./commands.mjs'); return upLocal(context, log); }
  return useMode(context, selection.mode, {}, log);
}

export async function modeStatus(context) {
  const selection = loadSelection(context);
  if (selection.mode === 'local') { const { statusLocal } = await import('./commands.mjs'); return { ...await statusLocal(context), mode: 'local' }; }
  const entry = selection.targets[selection.mode];
  const ctx = selectedContext(context, entry);
  const state = loadState(ctx.env);
  const connection = readStatus(ctx);
  const gateway = componentRunning(ctx.env, 'gateway');
  const vite = componentRunning(ctx.env, 'vite');
  const supervisor = componentRunning(ctx.env, 'connection');
  const connected = connection.state === 'ready' && supervisor.running && Date.now() - Date.parse(connection.checkedAt) < 45000;
  const [pageReady, apiReady] = gateway.running && state?.ports?.gateway
    ? await Promise.all([gatewayResponds(ctx, state.ports.gateway, '/'), gatewayResponds(ctx, state.ports.gateway, '/health/ready')])
    : [false, false];
  const available = Boolean(connected && apiReady);
  const serving = Boolean(pageReady && (selection.mode === 'cloud' ? connected : vite.running));
  return {
    ok: available && serving,
    mode: selection.mode,
    environment: { id: ctx.id, worktree: context.worktree, root: ctx.env.root, mode: selection.mode },
    page: { url: `https://127.0.0.1:${state.ports.gateway}`, serving, apiReady: available },
    sources: { frontend: selection.mode === 'cloud-api' ? 'worktree apps/web via Vite' : connection.business?.deployedFrontend ?? state.business?.deployedFrontend, backend: connection.business ?? state.business },
    data: { ownership: 'cloud-shared', target: state.target, localDatabase: context.env.database, note: '此入口固定写共享集成库；本地副本保持原样。' },
    browser: { profile: ctx.env.browserProfile, cookieIsolation: 'mode-and-target' },
    connection: { ...connection, supervisorRunning: supervisor.running },
    capabilities: { frontend: { available: serving, hmr: serving && selection.mode === 'cloud-api' }, api: { available }, execution: { available: false, reason: '页面连接不证明节点业务就绪；node status 单独报告。' }, models: { available: false, reason: '未验证云端模型调用。' } },
    next: available && serving ? ['打开 page.url；旧页面保持原数据目标。'] : ['恢复条件后重试 up；不会自动改用本地数据。'],
  };
}

export async function modeDown(context) {
  const lock = acquireLock({ ...context.env, lockFile: join(context.env.root, 'selection.lock') });
  try {
    const selection = loadSelection(context);
    const stopped = [];
    const entries = new Map([...Object.values(selection.targets ?? {}), ...(selection.retained ?? [])].map(entry => [entry.id, entry]));
    for (const entry of entries.values()) {
      const ctx = selectedContext(context, entry);
      const targetLock = acquireLock(ctx.env);
      try {
        for (const name of ['gateway', 'vite', 'node-connection', 'connection']) stopped.push(await stopComponent(ctx.env, name));
      } finally { targetLock.release(); }
    }
    await stopComponent(context.env, 'node-connection');
    const { downLocal } = await import('./commands.mjs');
    const local = await downLocal(context);
    return { ...local, stopped: [...local.stopped, ...stopped], mode: selection.mode };
  } finally { lock.release(); }
}

export async function nodeCommand(context, action, options = {}) {
  if (!['connect', 'status', 'disconnect'].includes(action)) throw new CliError('arguments', 'UNKNOWN_NODE_ACTION', 'node connect|status|disconnect');
  const lock = acquireLock({ ...context.env, lockFile: join(context.env.root, 'selection.lock') });
  let started = false;
  try {
    if (action === 'disconnect') return { stopped: await stopComponent(context.env, 'node-connection'), tasks: '原节点绑定与未知结果不变；不重发或改派。' };
    if (action === 'status') return { connection: readStatus(context, 'node'), supervisorRunning: componentRunning(context.env, 'node-connection').running, executionVerified: false, tasks: '未改变绑定或业务任务。' };
    const file = options.connection ?? enrollmentSelection(context)?.connectionFile;
    if (!file) throw connectionError('CONNECTION_INVALID');
    const c = loadConnection(file, { identity: options.identity });
    if (!c.nodeId) throw connectionError('NODE_OFFLINE');
    const previous = readStatus(context, 'node');
    if (componentRunning(context.env, 'node-connection').running && previous.target !== c.id) throw new CliError('connection', 'NODE_TARGET_IN_USE', '已连接另一登记节点；先显式 node disconnect。');
    const runtime = locatePinnedRuntime(process.env, context.home);
    started = !componentRunning(context.env, 'node-connection').running;
    const connection = await startConnection(context, c, runtime, undefined, 'node');
    return { connection, executionVerified: false, tasks: '仅连接原登记节点；不初始化、重发或改派任务。' };
  } catch (error) {
    if (started) await stopComponent(context.env, 'node-connection');
    throw error;
  } finally { lock.release(); }
}
