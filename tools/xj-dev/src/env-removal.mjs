import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError } from './envelope.mjs';
import { environmentId, environmentPaths } from './paths.mjs';
import { componentRunning, stopComponent } from './processes.mjs';
import { acquireLock, writeJsonAtomic } from './state.mjs';

const RECEIPT = 'deletion.json';
const FORMAT = 'xj-dev/environment-deletion-v1';
const components = { gateway: 'gateway.mjs', vite: 'vite.js', backend: 'backend-host.mjs', connection: 'connection-host.mjs', 'node-connection': 'connection-host.mjs' };
const retained = new Set(['lock', 'selection.lock', 'selection.json', 'enrollment.json', 'repro', RECEIPT]);
const directories = new Set(['data', 'personal-agent', 'logs', 'pids', 'tls', 'browser-profile', 'vite-cache', 'secrets', 'repro', 'lock', 'selection.lock']);
const files = new Set(['environment.json', 'backend-config.json', 'gateway-config.json', 'page-connection-config.json', 'node-connection-config.json', 'page-connection-status.json', 'node-connection-status.json', 'selection.json', 'enrollment.json', 'repro-receipt.json', RECEIPT]);
for (const name of Object.keys(components)) files.add(`.stop-${name}`);
for (const name of [...files]) if (name.endsWith('.json')) files.add(name + '.tmp');
const children = {
  data: new Set(['xunjie.sqlite', 'xunjie.sqlite-wal', 'xunjie.sqlite-shm', 'xunjie.sqlite-journal', 'baseline.json', 'baseline.json.tmp']),
  secrets: new Set(['signing-secret', 'baseline-accounts.json']),
  tls: new Set(['key.pem', 'cert.pem', 'request.csr', 'extensions.txt']),
  pids: new Set(Object.keys(components).map(name => name + '.json')),
  logs: new Set(Object.keys(components).map(name => name + '.log')),
};

function refuse(code, message) {
  throw new CliError('environment-delete', code, message, { recovery: '保留现场及永久锁守卫；核对当前工作树、实例、登记和进程归属后重试。未知对象不由 delete 认领。' });
}
function stat(file) {
  try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
function safeObject(file, directory) {
  const item = stat(file);
  if (!item) return undefined;
  if (item.isSymbolicLink() || !(directory ? item.isDirectory() : item.isFile())
    || (!directory && item.nlink !== 1) || (process.platform !== 'win32' && item.uid !== process.getuid())) {
    refuse('ENVIRONMENT_UNSAFE', '环境路径含符号链接、特殊对象或非当前用户所有的对象。');
  }
  return item;
}
function json(file) {
  const item = safeObject(file, false);
  if (!item) return undefined;
  if (item.size > 1024 * 1024) refuse('ENVIRONMENT_UNREGISTERED', '环境登记大小无效。');
  const text = readFileSync(file, 'utf8');
  try { return { text, value: JSON.parse(text) }; }
  catch { refuse('ENVIRONMENT_UNREGISTERED', '环境登记损坏，无法证明删除归属。'); }
}
function safeRoot(home, root) {
  safeObject(home, true); safeObject(dirname(root), true);
  const item = safeObject(root, true);
  if (!item) return undefined;
  if (realpathSync(root) !== join(realpathSync(home), 'envs', root.split(/[\\/]/).at(-1))) refuse('ENVIRONMENT_UNSAFE', '环境真实路径不在当前工具目录内。');
  return item;
}
function audit(root) {
  const walk = (directory, allowed) => {
    for (const name of readdirSync(directory)) {
      if (name === '.git' || allowed && !allowed.has(name)) refuse('ENVIRONMENT_UNKNOWN_OBJECT', '环境内含未登记的对象，未执行删除。');
      const path = join(directory, name), item = stat(path);
      if (!item) continue; // A still-running owned service may finish a temporary file.
      safeObject(path, item.isDirectory());
      if (allowed && directory !== root && item.isDirectory()) refuse('ENVIRONMENT_UNKNOWN_OBJECT', '登记的环境文件被目录替代，未执行删除。');
      if (directory === root && (item.isDirectory() ? !directories.has(name) : !files.has(name))) refuse('ENVIRONMENT_UNKNOWN_OBJECT', '环境顶层对象的类型或名称不属于工具。');
      if (item.isDirectory()) walk(path, directory === root ? children[name] : undefined);
    }
  };
  walk(root, new Set([...directories, ...files]));
}
function windowsOwner(root) {
  if (process.platform !== 'win32') return;
  const script = "$i=[Security.Principal.WindowsIdentity]::GetCurrent(); $o=(Get-Acl -LiteralPath $env:XJ_DELETE_ROOT).GetOwner([Security.Principal.SecurityIdentifier]).Value; if ($o -ne $i.User.Value -and $o -ne $i.Owner.Value) { exit 1 }";
  try { execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, XJ_DELETE_ROOT: root }, stdio: 'ignore', timeout: 15000 }); }
  catch { refuse('ENVIRONMENT_UNSAFE', '无法确认 Windows 环境目录属于当前用户。'); }
}
function identity(context, selection) {
  const mode = selection?.mode ?? 'local';
  let id = context.id;
  if (mode !== 'local') {
    const entry = selection?.targets?.[mode];
    if (!['cloud', 'cloud-api'].includes(mode) || !entry || entry.mode !== mode || !/^[a-f0-9]{12}$/.test(entry.id)) refuse('ENVIRONMENT_UNREGISTERED', '所选模式没有有效的持久环境登记。');
    id = entry.id;
    if (entry.root !== environmentPaths(context.home, id).root) refuse('ENVIRONMENT_UNREGISTERED', '模式登记路径不属于当前工具目录。');
  }
  return { ...context, id, mode, env: environmentPaths(context.home, id) };
}
function registration(target) {
  const state = json(target.env.stateFile), receipt = json(join(target.env.root, RECEIPT));
  const value = state?.value ?? receipt?.value?.registration;
  const instance = target.instance ?? '';
  if (!value || value.version !== 1 || value.envId !== target.id || value.worktree !== target.worktree) refuse('ENVIRONMENT_UNREGISTERED', '持久登记与当前环境身份不符，未执行删除。');
  if (target.mode === 'local' ? value.instance !== instance || value.mode && value.mode !== 'local'
    : value.mode !== target.mode || createHash('sha256').update(`${environmentId(target.worktree, instance)}:${target.mode}:${value.target}`).digest('hex').slice(0, 12) !== target.id) {
    refuse('ENVIRONMENT_UNREGISTERED', '持久工作树、实例或模式身份不符。');
  }
  if (!state && (receipt?.value?.schema !== FORMAT || !['deleting', 'deleted'].includes(receipt.value.status))) refuse('ENVIRONMENT_UNREGISTERED', '环境缺少有效的删除登记。');
  return { state, receipt, value };
}
function processRecords(target) {
  const records = [];
  for (const [name, marker] of Object.entries(components)) {
    const record = json(join(target.env.pids, name + '.json'));
    if (!record) continue;
    const value = record.value;
    if (!Number.isSafeInteger(value?.pid) || value.pid <= 0 || value.envId !== target.id || value.component !== name || value.scriptMarker !== marker
      || Object.hasOwn(value, 'file') || !Number.isFinite(value.startedAtMs)
      || Boolean(value.cooperativeStop) !== ['connection', 'node-connection'].includes(name)) refuse('ENVIRONMENT_FOREIGN_PROCESS', '进程登记不属于当前环境，未停止任何进程。');
    const status = componentRunning(target.env, name);
    const command = status.commandLine?.replaceAll('\\', '/');
    const expected = name === 'vite' ? join(target.repo.student, 'node_modules/vite/bin/vite.js') : join(target.worktree, 'tools/xj-dev/src', marker);
    if (status.foreign || status.running && (!command?.includes(expected.replaceAll('\\', '/'))
      || !command.includes(name === 'vite' ? `xjdev${target.id}` : target.env.root.replaceAll('\\', '/')))) refuse('ENVIRONMENT_FOREIGN_PROCESS', '登记 PID 已被外来进程使用，未停止任何进程。');
    records.push({ name, text: record.text });
  }
  return records;
}

// Delete only the selected, persistently registered environment payload. Both
// original mutex inodes stay in place, including on Windows while SQLite is open.
export async function deleteEnvironment(context) {
  if (context.worktree !== realpathSync(context.worktree) || context.id !== environmentId(context.worktree, context.instance ?? '')
    || context.env.root !== environmentPaths(context.home, context.id).root) refuse('ENVIRONMENT_UNREGISTERED', '调用环境身份不是规范工作树与实例的派生结果。');
  safeRoot(context.home, context.env.root);
  const selection = json(join(context.env.root, 'selection.json'));
  const target = identity(context, selection?.value), original = safeRoot(context.home, target.env.root);
  const result = (status, stopped = []) => ({ environment: { id: target.id, worktree: target.worktree, instance: target.instance, mode: target.mode, root: target.env.root },
    deletion: { result: status, dataDeleted: status === 'deleted', guardRetained: Boolean(original), retained: [...retained].filter(name => stat(join(target.env.root, name))) }, stopped,
    next: ['xj-dev up --json 重建所选环境；本地模式重新建立固定兼容基线。'] });
  if (!original) return result('not-present');
  audit(target.env.root); windowsOwner(target.env.root);
  const before = registration(target), locks = [];
  try {
    locks.push(acquireLock({ root: context.env.root, lockFile: join(context.env.root, 'selection.lock') }));
    locks.push(acquireLock(target.env));
    const sameScene = () => {
      const current = safeRoot(context.home, target.env.root);
      if (!current || current.dev !== original.dev || current.ino !== original.ino || json(join(context.env.root, 'selection.json'))?.text !== selection?.text
        || json(target.env.stateFile)?.text !== before.state?.text) refuse('ENVIRONMENT_CHANGED', '等待锁或停止进程期间，环境登记已变化；保留当前现场。');
      audit(target.env.root);
    };
    sameScene();
    const records = processRecords(target);
    const payload = () => readdirSync(target.env.root).filter(name => !retained.has(name));
    if (!before.state && before.receipt.value.status === 'deleted') {
      if (payload().length || records.length) refuse('ENVIRONMENT_CHANGED', '已删除回执旁出现新的现场，缺少新环境登记，未执行删除。');
      return result('already-deleted');
    }
    const stopped = [];
    for (const record of records) {
      if (json(join(target.env.pids, record.name + '.json'))?.text !== record.text) refuse('ENVIRONMENT_CHANGED', '停止前进程登记已变化。');
      // stopComponent rechecks command ownership immediately before signalling.
      const stop = await stopComponent(target.env, record.name);
      if (['skipped-foreign', 'stop-failed'].includes(stop.result)) refuse('ENVIRONMENT_FOREIGN_PROCESS', '进程归属变化或未完全停止；数据保持原样。');
      stopped.push(stop);
    }
    sameScene();
    if (processRecords(target).length) refuse('ENVIRONMENT_CHANGED', '停止后出现新的进程登记，未删除数据。');
    const receipt = { schema: FORMAT, registration: before.value, status: 'deleting', requestedAt: new Date().toISOString() };
    writeJsonAtomic(join(target.env.root, RECEIPT), receipt);
    // Keep the original registration until every other payload entry is gone.
    for (const name of payload().filter(name => name !== 'environment.json')) rmSync(join(target.env.root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(target.env.stateFile, { force: true });
    writeJsonAtomic(join(target.env.root, RECEIPT), { ...receipt, status: 'deleted', deletedAt: new Date().toISOString() });
    return result('deleted', stopped);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('environment-delete', 'ENVIRONMENT_DELETE_FAILED', '环境删除未完成；永久锁守卫和登记/回执保留，可关闭占用该环境文件的程序后重试。', { retryable: true });
  } finally { for (const lock of locks.reverse()) lock.release(); }
}
