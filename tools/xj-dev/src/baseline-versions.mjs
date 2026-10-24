import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { captureRepro, checkReproCompatibility, inspectRepro, restoreRepro } from './repro.mjs';
import { decodeZip, digest, reproError } from './repro-archive.mjs';
import { BASELINE_VERSION } from './baseline.mjs';
import { acquireLock, writeJsonAtomic } from './state.mjs';
import { packageFile, registeredDeviceFile, teamBaselineCatalog } from './package-routes.mjs';
import { environmentPaths } from './paths.mjs';
import { restoreData } from './repro-data.mjs';
import { loadSelection } from './modes.mjs';

function versionName(version) {
  if (typeof version !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(version) || version === 'latest') throw reproError('INVALID_VERSION', '基线需显式不可变版本名（小写字母、数字、连字符），不接受 latest。');
  return version;
}
export function listBaselines(context) {
  const directory = join(context.home, 'baselines');
  const published = !existsSync(directory) ? [] : readdirSync(directory).filter(name => existsSync(join(directory, name, 'baseline.json'))).sort().map(name => {
    versionName(name);
    const record = JSON.parse(readFileSync(join(directory, name, 'baseline.json'), 'utf8'));
    const checked = inspectRepro(join(directory, name, 'package.zip'), { expectedDigest: record.digest });
    return { ...record, schema: checked.package.manifest.data.schema, bytes: checked.package.bytes };
  });
  return { scope: 'local', baselines: published, builtin: { version: BASELINE_VERSION, availability: '首次 up 的内置合成基线；现有副本始终复用，不自动切换。' },
    next: ['baseline publish --context FILE --version VERSION', 'baseline use VERSION（另建工作树，保留旧环境）'] };
}
export async function publishBaseline(context, { version, contextFile }) {
  versionName(version);
  if (version === BASELINE_VERSION) throw reproError('BASELINE_EXISTS', '不能覆盖代码内置基线。');
  const root = join(context.home, 'baselines', version), file = join(root, 'package.zip');
  mkdirSync(dirname(root), { recursive: true });
  mkdirSync(root, { recursive: true });
  const lock = acquireLock({ root, lockFile: join(root, 'publish.lock') });
  try {
    if (existsSync(join(root, 'baseline.json'))) throw reproError('BASELINE_EXISTS', '此基线版本已存在；变更应发布新版本。');
    const result = await captureRepro(context, { contextFile, out: file });
    const record = { version, digest: result.package.digest, publishedAt: new Date().toISOString(), description: result.package.manifest.verification.reason };
    writeJsonAtomic(join(root, 'baseline.json'), record);
    return { scope: 'local', baseline: record, package: result.package, verification: result.verification,
      next: [`baseline use ${version}：仅显式采用的成员会建立新副本。`] };
  } finally { lock.release(); }
}
export async function useBaseline(context, { version, target }) {
  versionName(version);
  const root = join(context.home, 'baselines', version);
  if (!existsSync(join(root, 'baseline.json'))) throw reproError('RESOURCE_MISSING', '本地没有此固定基线；请取得发布包或使用 list 查看已发布版本。');
  const record = JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8'));
  const result = await restoreRepro(context, { file: join(root, 'package.zip'), expectedDigest: record.digest, baselineVersion: version,
    target: target ?? join(dirname(context.worktree), `xj-baseline-${version}-${record.digest.slice(7, 15)}`) });
  return { ...result, scope: 'local', baseline: { version, digest: record.digest }, previous: { worktree: context.worktree, environment: context.env.root, preserved: true },
    next: [`在 ${result.environment.worktree} 继续开发；xj-dev up --worktree ${result.environment.worktree}`, '旧工作树、数据库和浏览器现场均保留；其他成员不会自动升级。'] };
}
export async function listTeamBaselines(context, { deviceFile } = {}) {
  return { scope: 'team', baselines: await teamBaselineCatalog(context, deviceFile),
    next: ['baseline use NAME --team --version VERSION [--target DIR | --here]（默认另建工作树；--here 仅首次本地数据）'] };
}
export async function useTeamBaseline(context, { name, version, target, deviceFile, here = false } = {}) {
  if (here && target !== undefined) throw reproError('INVALID_ARGUMENTS', '--here 与 --target 互斥；--here 只初始化当前工作树本地数据。');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name ?? '') || !/^[A-Za-z0-9_.-]{1,64}$/.test(version ?? '') || version === 'latest') {
    throw reproError('INVALID_VERSION', '团队基线需要明确 NAME 与 --version VERSION，不接受 latest。');
  }
  if (here) requireUninitializedLocal(context);
  deviceFile = registeredDeviceFile(context, deviceFile);
  const baselines = await teamBaselineCatalog(context, deviceFile);
  const baseline = baselines.find(entry => entry.name === name && entry.version === version);
  if (!baseline) throw reproError('RESOURCE_MISSING', '团队没有此 name/version 基线；使用 baseline list --team 查看固定版本。');
  const transfer = await packageFile(context, baseline.reproId, deviceFile);
  if (transfer.reproId !== baseline.reproId || transfer.digest !== baseline.digest || transfer.bytes !== baseline.bytes) {
    throw reproError('DIGEST_MISMATCH', '下载包与所选团队基线的不可变编号、摘要或体积不符。');
  }
  const result = here ? await importBaselineHere(context, baseline, transfer) : await restoreRepro(context, {
    file: transfer.file, expectedDigest: baseline.digest, baselineVersion: version,
    target: target ?? join(dirname(context.worktree), `xj-baseline-${name}-${version}-${baseline.digest.slice(7, 15)}`) });
  return { ...result, scope: 'team', baseline, transfer,
    previous: { worktree: context.worktree, environment: context.env.root, preserved: true },
    next: [`xj-dev up --worktree ${result.environment.worktree}${here && context.instance ? ` --instance ${context.instance}` : ''}`, here ? '仅导入当前工作树首次本地数据；源码未替换，尚未启动或验证复现。'
      : '团队基线已恢复为本地隔离副本；审阅源码后显式 up，旧工作树与数据保留。'] };
}

function entryAt(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
function requireUninitializedLocal(context) {
  const env = context.env;
  for (const path of [env.root, env.data, env.secrets]) {
    const entry = entryAt(path);
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) throw reproError('UNSAFE_PATH', '本地环境路径必须是真实目录。');
  }
  const selection = join(env.root, 'selection.json');
  if (entryAt(selection)?.isSymbolicLink()) throw reproError('UNSAFE_PATH', '模式选择不能是符号链接。');
  if (loadSelection(context).mode !== 'local') throw reproError('LOCAL_DATA_REQUIRED', '--here 仅用于所选 local 模式的首次数据初始化。');
  if ([env.database, env.baselineFile, env.stateFile, env.stateFile + '.tmp', env.database + '-wal', env.database + '-shm', env.database + '-journal']
    .some(path => entryAt(path)) || [env.data, env.secrets].some(path => entryAt(path) && readdirSync(path).length)) {
    throw reproError('TARGET_EXISTS', '--here 拒绝覆盖已有数据库、基线标记、SQLite 现场、凭据或环境状态；它不能升级已有环境。');
  }
}
async function importBaselineHere(context, baseline, transfer) {
  const checked = inspectRepro(transfer.file, { expectedDigest: baseline.digest }), manifest = checked.package.manifest;
  const accounts = manifest.data.accounts;
  if (!Array.isArray(accounts) || !accounts.length || accounts.length !== manifest.data.tables?.users
    || accounts.some(a => !a || typeof a.id !== 'string' || !a.id || typeof a.loginName !== 'string' || !a.loginName || !['teacher', 'student'].includes(a.role))
    || new Set(accounts.map(a => a.id)).size !== accounts.length || new Set(accounts.map(a => a.loginName)).size !== accounts.length) {
    throw reproError('INVALID_DATA', '团队基线账号 metadata 无效，未初始化当前环境。');
  }
  const scratch = mkdtempSync(join(context.home, 'baseline-import-'));
  let selectionLock, lock, publishedSecrets = false, publishedData = false;
  const emptyDirectories = [];
  try {
    await checkReproCompatibility(context, manifest, scratch);
    selectionLock = acquireLock({ ...context.env, lockFile: join(context.env.root, 'selection.lock') });
    lock = acquireLock(context.env);
    requireUninitializedLocal(context); // Recheck after fetch/validation, under both operation locks.
    const bytes = readFileSync(transfer.file);
    if (digest(bytes) !== baseline.digest) throw reproError('DIGEST_MISMATCH', '团队基线缓存在导入前发生变化。');
    const source = join(scratch, 'shared.sqlite'), staged = environmentPaths(join(scratch, 'staged'), context.id);
    writeFileSync(source, decodeZip(bytes).get('data/shared.sqlite'), { mode: 0o600 });
    const restored = await restoreData(context.repo.teaching, source, manifest.data, staged, baseline.version);
    const credentials = JSON.parse(readFileSync(staged.baselineCredentials, 'utf8'));
    if (credentials.length !== accounts.length || credentials.some(c => !accounts.some(a => a.id === c.id && a.loginName === c.loginName && a.role === c.role))) {
      throw reproError('INVALID_DATA', '团队基线账号与包内用户不符，未初始化当前环境。');
    }
    writeJsonAtomic(staged.baselineFile, { ...JSON.parse(readFileSync(staged.baselineFile, 'utf8')), teamBaseline: baseline });
    requireUninitializedLocal(context); // restoreData awaits password hashing; do not trust an earlier observation.
    // Publish synchronously, with credentials ready before the complete data
    // directory becomes visible. No source/Git operation is part of this path.
    for (const path of [context.env.secrets, context.env.data]) if (entryAt(path)) { rmdirSync(path); emptyDirectories.push(path); }
    renameSync(staged.secrets, context.env.secrets); publishedSecrets = true;
    renameSync(staged.data, context.env.data); publishedData = true;
    return { package: checked.package, environment: { id: context.id, root: context.env.root, worktree: context.worktree, mode: 'local', ...(context.instance ? { instance: context.instance } : {}) },
      data: { ...restored, database: context.env.database, credentialsFile: context.env.baselineCredentials },
      code: { source: 'current-worktree', changed: false }, initializedHere: true, started: false,
      verification: { generated: true, restored: true, reproduction: 'unverified' } };
  } catch (error) {
    if (publishedData) rmSync(context.env.data, { recursive: true, force: true });
    if (publishedSecrets) rmSync(context.env.secrets, { recursive: true, force: true });
    for (const path of emptyDirectories) if (!entryAt(path)) mkdirSync(path, { mode: 0o700 });
    throw error;
  } finally {
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); }
    finally { lock?.release(); selectionLock?.release(); }
  }
}
