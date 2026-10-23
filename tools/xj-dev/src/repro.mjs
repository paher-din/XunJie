import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, posix, win32 } from 'node:path';
import { REPRO_FORMAT, ARCHIVE_LIMITS, decodeZip, digest, encodeZip, jsonBytes, reproError, safeEntry } from './repro-archive.mjs';
import { assertShareable, collectCode, excludedPath, git, restoreCode, LOCKFILES, LOCK_DIGEST_ALGORITHM, lockfileDigest } from './repro-code.mjs';
import { collectData, restoreData, schemaFingerprint } from './repro-data.mjs';
import { environmentId, environmentPaths, PINNED_NODE, TOOL_VERSION } from './paths.mjs';
import { acquireLock, writeJsonAtomic } from './state.mjs';

export { LOCK_DIGEST_ALGORITHM, lockfileDigest } from './repro-code.mjs';
export function canonicalRestoreTarget(destination, realParent, platform = process.platform) {
  const paths = platform === 'win32' ? win32 : posix;
  return paths.join(realParent, paths.basename(destination));
}
function readJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw reproError('INVALID_MANIFEST', `${label} 不是有效 JSON。`); }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateScenario(scenario, { automated = false, code = 'INVALID_SCENARIO' } = {}) {
  if (!record(scenario) || !['before-trigger', 'after-incident'].includes(scenario.start)
    || typeof scenario.title !== 'string' || !scenario.title.trim() || typeof scenario.expected !== 'string' || typeof scenario.observed !== 'string'
    || !Array.isArray(scenario.steps) || scenario.steps.length === 0) throw reproError(code, '场景需要有效起点、标题、预期/现象及非空步骤。');
  let manual = false;
  for (const step of scenario.steps) {
    if (typeof step === 'string' && step.trim()) { manual = true; continue; }
    if (!record(step) || typeof step.actorId !== 'string' || !step.actorId.trim() || !['GET', 'POST'].includes(step.method)
      || typeof step.path !== 'string' || !/^\/api\/[A-Za-z0-9_/?=&%.-]+$/.test(step.path) || /(?:\.\.|%2e|%2f|%5c)/i.test(step.path)
      || !record(step.expect) || !Number.isInteger(step.expect.status) || step.expect.status < 100 || step.expect.status > 599
      || (step.expect.errorCode !== undefined && (typeof step.expect.errorCode !== 'string' || !step.expect.errorCode.trim()))) {
      throw reproError(code, '步骤必须是非空自然语言，或含角色、同源 /api/ 路径及预期 HTTP 状态的有效步骤。');
    }
  }
  if (automated && manual) throw reproError('UNSUPPORTED_STEPS', '自然语言步骤已保存，需人工执行；自动验证只接受明确的业务 HTTP 步骤。');
}
function requireLocal(context) {
  const selection = join(context.env.root, 'selection.json');
  if (existsSync(selection) && readJson(readFileSync(selection), 'selection').mode !== 'local') {
    throw reproError('LOCAL_DATA_REQUIRED', '本地复现采集只读取本工作树的独立业务库；先显式 use local，不采集或冒充云端现场。');
  }
}
export function loadReproContext(file) {
  if (!existsSync(file)) throw reproError('RESOURCE_MISSING', '采集 context 文件不存在。');
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw reproError('UNSAFE_PATH', 'context 必须是普通文件。');
  if (lstatSync(file).size > 1024 * 1024) throw reproError('PACKAGE_LIMIT', 'context 大小超过 1 MiB。');
  const value = readJson(readFileSync(file), 'context');
  if (!record(value) || value.formatVersion !== 'xj-repro-context/1') {
    throw reproError('INVALID_CONTEXT', 'context 需要 xj-repro-context/1、起点类型、标题、步骤、预期与现象。');
  }
  validateScenario(value.scenario, { code: 'INVALID_CONTEXT' });
  // Claims from the caller are never promoted to a verified reproduction result.
  delete value.scenario.verified; delete value.scenario.verification;
  assertShareable(jsonBytes(value.scenario), '场景说明');
  return value;
}
function packageResult(file, bytes, manifest) {
  return { path: resolve(file), digest: digest(bytes), bytes: bytes.length, formatVersion: REPRO_FORMAT, manifest };
}
function inspect(file, { expectedDigest } = {}) {
  if (!existsSync(file)) throw reproError('RESOURCE_MISSING', '复现 ZIP 不存在。');
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || lstatSync(file).size > ARCHIVE_LIMITS.zip) throw reproError('PACKAGE_LIMIT', '复现 ZIP 不是允许大小的普通文件。');
  const bytes = readFileSync(file);
  if (expectedDigest && digest(bytes) !== expectedDigest) throw reproError('DIGEST_MISMATCH', 'ZIP 完整摘要与预期不符。');
  const entries = decodeZip(bytes);
  if (!entries.has('manifest.json') || !entries.has('checksums.json')) throw reproError('RESOURCE_MISSING', '包缺少清单或摘要表。');
  const manifest = readJson(entries.get('manifest.json'), 'manifest');
  if (!record(manifest)) throw reproError('INVALID_MANIFEST', 'manifest 必须是 JSON 对象。');
  if (manifest.formatVersion !== REPRO_FORMAT) throw reproError('FORMAT_MISMATCH', '不支持的复现包版本。');
  if (!manifest.code?.exportedCommit || !Array.isArray(manifest.code.files) || !manifest.data?.schema || !manifest.conditions?.lockfiles
    || !record(manifest.conditions.capabilities) || !record(manifest.resources) || !Array.isArray(manifest.resources.assets) || !Array.isArray(manifest.resources.evidence)
    || manifest.verification?.reproduction !== 'unverified' || manifest.verification?.restored !== false) throw reproError('INVALID_MANIFEST', '复现清单结构或生成状态无效。');
  const checksums = readJson(entries.get('checksums.json'), 'checksums');
  if (!checksums || typeof checksums !== 'object' || Array.isArray(checksums) || Object.keys(checksums).length !== entries.size - 1) throw reproError('DIGEST_MISMATCH', '摘要表文件数不符。');
  for (const [path, data] of entries) {
    if (path !== 'checksums.json' && checksums[path] !== digest(data)) throw reproError('DIGEST_MISMATCH', '包内文件摘要不符。');
    if (!['manifest.json', 'scenario.json', 'checksums.json', 'code/source.bundle', 'data/shared.sqlite'].includes(path)
      && !/^(?:assets|evidence)\//.test(path)) throw reproError('UNSAFE_PATH', '包内含不支持的文件类别。');
  }
  for (const path of ['code/source.bundle', 'data/shared.sqlite', 'scenario.json']) if (!entries.has(path)) throw reproError('RESOURCE_MISSING', `包缺少 ${path}。`);
  for (const resource of [...(manifest.resources?.assets ?? []), ...(manifest.resources?.evidence ?? [])]) {
    safeEntry(resource.path);
    if (!entries.has(resource.path)) throw reproError('RESOURCE_MISSING', '包缺少清单声明的附件。');
    if (digest(entries.get(resource.path)) !== resource.digest || entries.get(resource.path).length !== resource.bytes) throw reproError('DIGEST_MISMATCH', '附件与资源清单摘要不符。');
  }
  if (digest(entries.get('data/shared.sqlite')) !== manifest.data.digest || digest(entries.get('code/source.bundle')) !== manifest.code.bundleDigest) throw reproError('DIGEST_MISMATCH', '资源与清单摘要不符。');
  const scenario = readJson(entries.get('scenario.json'), 'scenario');
  validateScenario(scenario);
  return { package: packageResult(file, bytes, manifest), entries, scenario };
}
export function inspectRepro(file, options = {}) {
  const result = inspect(file, options);
  return { package: result.package, scenario: result.scenario, verification: result.package.manifest.verification };
}

function resources(worktree, specs, kind, entries) {
  if (!Array.isArray(specs)) throw reproError('INVALID_CONTEXT', `${kind} 必须是明确选中的文件数组。`);
  return specs.map(item => {
    safeEntry(item.path); safeEntry(item.name ?? item.path);
    if (excludedPath(item.path)) throw reproError('EXCLUDED_RESOURCE', '附件位于禁止共享的位置。');
    let current = worktree;
    for (const part of item.path.split('/')) {
      current = join(current, part);
      if (!existsSync(current)) throw reproError('RESOURCE_MISSING', '选中的附件不存在。');
      if (lstatSync(current).isSymbolicLink()) throw reproError('UNSAFE_PATH', '附件不能使用符号链接。');
    }
    if (!lstatSync(current).isFile()) throw reproError('UNSAFE_PATH', '附件必须是普通文件。');
    const bytes = readFileSync(current); assertShareable(bytes, '选中附件');
    const path = `${kind}/${item.name ?? item.path}`;
    if (entries.has(path)) throw reproError('UNSAFE_PATH', '附件名称冲突。');
    entries.set(path, bytes);
    return { path, digest: digest(bytes), bytes: bytes.length, capturedAt: new Date().toISOString() };
  });
}

export async function captureRepro(context, { contextFile, out }) {
  if (!contextFile || !out) throw reproError('INVALID_ARGUMENTS', '需要 --context FILE 和 --out ZIP。');
  const spec = loadReproContext(contextFile), requestDigest = digest(jsonBytes(spec));
  // A completed artifact is immutable. Retrying after data/code changed must not recollect the scene.
  if (existsSync(out)) {
    const previous = inspectRepro(out);
    if (previous.package.manifest.requestDigest !== requestDigest) throw reproError('PACKAGE_EXISTS', '目标 ZIP 已属于另一采集请求，请使用新文件名。');
    return { ...previous, reused: true };
  }
  requireLocal(context);
  const lock = acquireLock(context.env);
  const scratch = mkdtempSync(join(context.env.root, 'repro-capture-'));
  try {
    const code = collectCode(context.worktree, scratch, spec.code);
    const data = await collectData(context, scratch, spec.data);
    const entries = new Map([['code/source.bundle', code.bytes], ['data/shared.sqlite', data.bytes], ['scenario.json', jsonBytes(spec.scenario)]]);
    const assets = resources(context.worktree, spec.assets ?? [], 'assets', entries);
    const evidence = resources(context.worktree, spec.evidence ?? [], 'evidence', entries);
    const lockfiles = Object.fromEntries(LOCKFILES.map(path => {
      const file = code.manifest.files.find(file => file.path === path);
      if (!file) throw reproError('RESOURCE_MISSING', `代码范围缺少工具条件 ${path}。`);
      return [path, lockfileDigest(code.sourceFiles.get(path))];
    }));
    const manifest = {
      formatVersion: REPRO_FORMAT, tool: { name: 'xj-dev', version: TOOL_VERSION }, createdAt: new Date().toISOString(), requestDigest,
      code: { ...code.manifest, bundleDigest: digest(code.bytes) }, data: { ...data.manifest, digest: digest(data.bytes) },
      conditions: { node: PINNED_NODE, toolVersion: TOOL_VERSION, lockfileDigestAlgorithm: LOCK_DIGEST_ALGORITHM, lockfiles,
        capabilities: spec.scenario.capabilities ?? { execution: 'not-required', models: 'not-required' } },
      resources: { assets, evidence },
      verification: { generated: true, restored: false, reproduction: 'unverified',
        reason: spec.scenario.start === 'after-incident' ? '仅保存事后现场，缺少触发前起点。' : '触发前起点已保存；需在隔离环境实际执行步骤。' },
    };
    entries.set('manifest.json', jsonBytes(manifest));
    entries.set('checksums.json', jsonBytes(Object.fromEntries([...entries].map(([path, bytes]) => [path, digest(bytes)]))));
    const bytes = encodeZip(entries);
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, bytes, { flag: 'wx', mode: 0o600 });
    return { package: packageResult(out, bytes, manifest), verification: manifest.verification, reused: false };
  } finally { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); lock.release(); }
}

export async function checkReproCompatibility(context, manifest, scratch) {
  if (manifest.conditions.node !== process.version || manifest.conditions.node !== PINNED_NODE) throw reproError('NODE_VERSION_MISMATCH', '复现需要清单声明的精确 Node 运行时。');
  if (manifest.conditions.toolVersion !== TOOL_VERSION) throw reproError('TOOL_VERSION_MISMATCH', '复现包需要不同工具版本。');
  if (manifest.conditions.lockfileDigestAlgorithm !== LOCK_DIGEST_ALGORITHM) throw reproError('FORMAT_MISMATCH', '依赖条件摘要算法不受支持。');
  for (const path of LOCKFILES) {
    if (!existsSync(join(context.worktree, path))) throw reproError('RESOURCE_MISSING', `接收端缺少 ${path}。`);
    if (lockfileDigest(readFileSync(join(context.worktree, path))) !== manifest.conditions.lockfiles[path]) throw reproError('LOCKFILE_MISMATCH', `接收端 ${path} 不匹配；请使用相应代码/依赖条件。`);
  }
  if (await schemaFingerprint(context.repo.teaching, scratch) !== manifest.data.schema) throw reproError('SCHEMA_MISMATCH', '接收端 schema 与包不符，不执行迁移。');
}

export async function restoreRepro(context, { file, target, expectedDigest, baselineVersion }) {
  const checked = inspect(file, { expectedDigest }), manifest = checked.package.manifest;
  const destination = resolve(target ?? join(dirname(context.worktree), 'xj-repro-' + checked.package.digest.slice(7, 19)));
  if (!existsSync(dirname(destination)) || lstatSync(dirname(destination)).isSymbolicLink()) throw reproError('UNSAFE_PATH', '目标父目录必须是已存在的真实目录。');
  const canonicalTarget = canonicalRestoreTarget(destination, realpathSync(dirname(destination)));
  const id = environmentId(canonicalTarget), envPaths = environmentPaths(context.home, id);
  // Reserve the filesystem target, not just one CLI home. Keep the permanent OS
  // mutex inode after release, as required by state.mjs (#139).
  const lockFile = join(dirname(canonicalTarget), `.xj-repro-restore-${environmentId(canonicalTarget.normalize('NFC').toLowerCase())}.lock`);
  // Initialize the owned mutex directory itself: recursive mkdir of a Windows
  // drive root fails with EPERM even when that root already exists.
  const reservation = acquireLock({ root: lockFile, lockFile });
  let scratch, created = false, ownsEnvironment = false;
  try {
    if (existsSync(canonicalTarget)) throw reproError('TARGET_EXISTS', '恢复目标已存在，请选择新的工作树目录。');
    if (existsSync(envPaths.root)) throw reproError('TARGET_EXISTS', '目标已有数据环境，请选择新目录。');
    mkdirSync(context.home, { recursive: true });
    scratch = mkdtempSync(join(context.home, 'repro-restore-'));
    await checkReproCompatibility(context, manifest, scratch);
    const bundleFile = join(scratch, 'source.bundle'), dataFile = join(scratch, 'shared.sqlite');
    writeFileSync(bundleFile, checked.entries.get('code/source.bundle'));
    writeFileSync(dataFile, checked.entries.get('data/shared.sqlite'));
    const stagedEnv = environmentPaths(join(scratch, 'staged'), id);
    const restored = await restoreData(context.repo.teaching, dataFile, manifest.data, stagedEnv, baselineVersion);
    restoreCode(context.worktree, bundleFile, manifest.code, scratch, canonicalTarget, manifest.conditions); created = true;
    mkdirSync(dirname(envPaths.root), { recursive: true });
    try { mkdirSync(envPaths.root, { mode: 0o700 }); ownsEnvironment = true; }
    catch (error) { if (error.code === 'EEXIST') throw reproError('TARGET_EXISTS', '目标数据环境已被其他操作创建，保留其原样。'); throw error; }
    // Copy only fresh data and newly generated secrets, never runtime files or browser state.
    mkdirSync(envPaths.data, { recursive: true }); mkdirSync(envPaths.secrets, { recursive: true, mode: 0o700 });
    for (const key of ['database', 'baselineFile', 'baselineCredentials']) writeFileSync(envPaths[key], readFileSync(stagedEnv[key]), { mode: 0o600, flag: 'wx' });
    for (const [path, bytes] of checked.entries) if (/^(?:assets|evidence)\//.test(path)) {
      const output = join(envPaths.root, 'repro', path); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, bytes, { mode: 0o600, flag: 'wx' });
    }
    const receipt = { packageDigest: checked.package.digest, target: canonicalTarget, restoredAt: new Date().toISOString(),
      verification: { generated: true, restored: true, reproduction: 'unverified' } };
    writeJsonAtomic(join(envPaths.root, 'repro-receipt.json'), receipt);
    return { package: checked.package, environment: { id, root: envPaths.root, worktree: canonicalTarget, mode: 'local' },
      data: { ...restored, database: envPaths.database, credentialsFile: envPaths.baselineCredentials },
      verification: receipt.verification, next: [`xj-dev up --worktree ${canonicalTarget}`, '恢复不会安装依赖、启动服务或执行包内脚本；审阅源码后显式 up。'] };
  } catch (error) {
    if (created) { try { git(context.worktree, ['worktree', 'remove', '--force', canonicalTarget]); } catch { /* retain recovery location */ } }
    if (ownsEnvironment) rmSync(envPaths.root, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  } finally {
    try { if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); }
    finally { reservation.release(); }
  }
}
