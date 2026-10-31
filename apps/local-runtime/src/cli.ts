#!/usr/bin/env node
import { open, readFile, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { openProductRuntime, resolveCredential, restoreProductRecovery, upgradeProductRecovery, ProductInstallationRequiredError, ProductPrerequisitePreparationError } from '@xunjie/product-runtime';
import type { BackupPolicy } from '@xunjie/product-runtime';

type Runtime = ReturnType<typeof openProductRuntime>;
type InstallOptions = NonNullable<Parameters<Runtime['install']>[0]>;
type RuntimeResources = NonNullable<Parameters<typeof openProductRuntime>[0]['resources']>;
type Authorization = Parameters<Runtime['authorize']>[0];
type Connection = Parameters<Runtime['connect']>[0];

const commands: Record<string, readonly string[]> = {
  prepare: ['config', 'profile', 'resources'],
  install: ['config', 'profile', 'resources'],
  launch: ['config', 'profile', 'resources'],
  start: ['resources'],
  status: ['resources'],
  stop: ['resources'],
  uninstall: ['resources'],
  delete: ['environment-id', 'resources'],
  database: ['resources'],
  'set-credential': ['ref', 'file', 'resources'],
  authorize: ['file', 'out', 'resources'],
  revoke: ['grant-id', 'resources'],
  connect: ['file', 'resources'],
  'recovery-key': ['out'],
  'backup-policy': ['file', 'resources'],
  backup: ['file', 'resources'],
  'backup-list': ['file', 'resources'],
  restore: ['file', 'resources'],
  upgrade: ['file', 'resources'],
  takeover: ['file', 'resources'],
  'fence-source': ['file', 'resources'],
  'maintenance-resume': ['resources'],
  'school-member': ['file', 'resources'],
  'school-membership': ['file', 'resources'],
  'school-connection': ['file', 'resources'],
  'learning-binding': ['file', 'resources'],
  'course-import': ['file', 'resources'],
  'course-access': ['file', 'resources'],
  'course-result': ['file', 'resources'],
};

// Keep known secret values out of messages even if a downstream error includes them.
const secrets = new Set<string>();
function rememberSecret(value: string): string {
  if (value) secrets.add(value);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

async function jsonFile(path: string, label: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(resolve(path), 'utf8');
  } catch {
    throw new Error(`无法读取${label}文件`);
  }
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    // JSON.parse messages can contain fragments of a private input file.
    throw new Error(`${label}文件不是有效 JSON`);
  }
  return object(value, label);
}

function defaultRoot(): string {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'XunJie', 'environments', 'default');
}

async function resourcesFile(path: string): Promise<RuntimeResources> {
  const absolute = resolve(path);
  const value = await jsonFile(absolute, 'resources（安装需要应用包中的 resources.json，可用 --resources 指定）');
  for (const key of ['nodePath', 'webRoot', 'postgresBin', 'windowsPrerequisitePath'] as const) {
    if ((key === 'postgresBin' || key === 'windowsPrerequisitePath') && value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !value[key].trim()) {
      throw new Error(`resources 缺少有效的 ${key}`);
    }
    value[key] = resolve(dirname(absolute), value[key]);
  }
  for (const key of ['nodeVersion', 'postgresVersion'] as const) {
    if (key === 'postgresVersion' && value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !value[key].trim()) {
      throw new Error(`resources 缺少有效的 ${key}`);
    }
  }
  return value as unknown as RuntimeResources;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value ?? null)}\n`);
  if (value && typeof value === 'object' && 'state' in value && value.state === 'failed') process.exitCode = 1;
}

async function openBrowser(endpoint: string): Promise<void> {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('运行库返回了无效 endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('运行库返回了不支持的 endpoint');
  }
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  await new Promise<void>((done, reject) => {
    const child = spawn(command, [endpoint], { shell: false, stdio: 'ignore', windowsHide: true });
    child.once('error', () => reject(new Error('无法启动系统浏览器；运行状态已输出')));
    child.once('close', (code) => {
      if (code === 0) done();
      else reject(new Error('系统浏览器打开失败；运行状态已输出'));
    });
  });
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      strict: true,
      allowPositionals: true,
      options: {
        root: { type: 'string' }, config: { type: 'string' },
        resources: { type: 'string' }, profile: { type: 'string' },
        file: { type: 'string' }, ref: { type: 'string' },
        out: { type: 'string' }, 'environment-id': { type: 'string' },
        'grant-id': { type: 'string' }, json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
  } catch {
    throw new Error('命令参数无效；使用 --help 查看用法。凭据必须通过文件提供');
  }
  const { values, positionals } = parsed;
  if (values.help) {
    output({
      commands,
      common: ['--root <directory>', '--json', '--help'],
      defaultRoot: defaultRoot(),
      usage: 'xunjie <command> [options]；install 默认 profile=local；私密值仅从 --file 读取',
    });
    return;
  }
  const command = positionals[0];
  if (positionals.length !== 1 || !command || !Object.hasOwn(commands, command)) {
    throw new Error('请指定一个有效命令；使用 --help 查看用法');
  }
  for (const key of Object.keys(values)) {
    if (!['root', 'json'].includes(key) && !commands[command]!.includes(key)) {
      throw new Error('当前命令不支持指定的选项；使用 --help 查看用法');
    }
  }
  const required = (key: string): string => {
    const value = values[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`需要 --${key}`);
    return value;
  };
  if (values.root !== undefined) required('root');
  if (values.resources !== undefined) required('resources');

  // Only install defaults to the bundled manifest. Other actions reuse saved resources.
  const resourcePath = typeof values.resources === 'string' ? values.resources
    : ['install', 'prepare', 'restore', 'upgrade'].includes(command) ? fileURLToPath(new URL('../resources.json', import.meta.url)) : undefined;
  const resources = resourcePath ? await resourcesFile(resourcePath) : undefined;
  const root = resolve(typeof values.root === 'string' ? values.root : defaultRoot());
  const openRuntime = (selected = resources): Runtime => openProductRuntime({
    root,
    ...(selected ? { resources: selected } : {}),
    windowsPrerequisitePath: fileURLToPath(new URL('../resources/prerequisites/windows-vc.ps1', import.meta.url)),
  });
  let runtime = openRuntime();
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProductInstallationRequiredError || error instanceof ProductPrerequisitePreparationError) throw error;
      const detail = error instanceof Error ? error.message : 'Unknown runtime failure';
      // Preserve the actionable diagnostic; the final boundary below redacts
      // credentials read by this invocation and never prints a stack/configuration.
      throw new Error(`运行库操作失败（${command}）：${detail}`);
    }
  };
  const installOptions = async (): Promise<InstallOptions> => {
    const config = values.config === undefined ? {} : await jsonFile(required('config'), '安装配置');
    const profile = values.profile ?? config.profile ?? 'local';
    if (!['local', 'school', 'remote'].includes(String(profile))) {
      throw new Error('profile 必须是 local、school 或 remote');
    }
    return { ...config, profile } as InstallOptions;
  };
  const recoveryTargetConfiguration = async (input: Record<string, unknown>) => {
    type RestoreInput = Parameters<typeof restoreProductRecovery>[0];
    let databaseCredential: string | undefined;
    if (input.databaseCredentialFile !== undefined) {
      if (typeof input.databaseCredentialFile !== 'string') throw new Error('databaseCredentialFile 必须是私密文件路径');
      databaseCredential = (await readFile(resolve(input.databaseCredentialFile), 'utf8')).replace(/\r?\n$/, '');
      if (!databaseCredential || /[\r\n]/.test(databaseCredential)) throw new Error('目标数据库凭据文件必须是单行非空凭据');
      rememberSecret(databaseCredential);
    }
    return { database: input.database as RestoreInput['database'], databaseCredential,
      installation: input.installation as RestoreInput['installation'] };
  };
  const manageCourse = async (action: 'course-import' | 'course-access' | 'course-result', body: unknown, timeout = 15000) => {
    const status = await run(() => runtime.status());
    if (!status.endpoint || !['ready', 'degraded'].includes(status.state)) throw new Error('请先启动本学校产品环境');
    const response = await fetch(new URL(`/api/learning/manage/${action}`, status.endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${rememberSecret(await resolveCredential(root, 'control'))}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`课程管理操作未完成（${response.status}），请核对输入及当前授权`);
    return response.json();
  };

  switch (command) {
    case 'fence-source': {
      const input = await jsonFile(required('file'), '接收方失权核验');
      if (typeof input.expectedReceiver !== 'string' || typeof input.sourceEnvironmentId !== 'string'
        || !Array.isArray(input.sourceServiceIds) || !input.sourceServiceIds.length || input.sourceServiceIds.length > 100
        || !input.sourceServiceIds.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))) throw new Error('接收方核验输入无效');
      const current = (await runtime.status()).environment;
      if (!current.services.some(service => `${current.environmentId}/${service.serviceId}` === input.expectedReceiver)) throw new Error('receiver-identity-conflict');
      for (const serviceId of input.sourceServiceIds as string[]) await runtime.recovery.fenceSource({
        sourceEnvironmentId: input.sourceEnvironmentId, sourceServiceId: serviceId });
      output({ fenced: true, receiverId: input.expectedReceiver, sourceEnvironmentId: input.sourceEnvironmentId, sourceServiceIds: input.sourceServiceIds });
      break;
    }
    case 'recovery-key': {
      const path = resolve(required('out'));
      const destination = await open(path, 'wx', 0o600);
      try { await destination.chmod(0o600); await destination.writeFile(randomBytes(32)); await destination.sync(); }
      finally { await destination.close(); }
      output({ path }); break;
    }
    case 'backup-policy': {
      const input = await jsonFile(required('file'), '备份策略');
      if (typeof input.keyFile !== 'string') throw new Error('备份策略需要 keyFile');
      const key = await readFile(resolve(input.keyFile));
      if (key.length < 32) throw new Error('恢复密钥至少需要 32 字节');
      rememberSecret(key.toString('base64'));
      const recoveryKeyRef = `recovery-${randomUUID()}`;
      await run(() => runtime.setCredential(recoveryKeyRef, key.toString('base64')));
      const { keyFile: _keyFile, ...policy } = input;
      output(await run(() => runtime.recovery.configure({ ...policy, recoveryKeyRef } as unknown as BackupPolicy)));
      break;
    }
    case 'backup': {
      const input = values.file ? await jsonFile(required('file'), '备份') : {};
      if (typeof input.keyFile === 'string') {
        const key = await readFile(resolve(input.keyFile));
        if (key.length < 32) throw new Error('恢复密钥至少需要 32 字节');
        rememberSecret(key.toString('base64'));
        const ref = `recovery-${randomUUID()}`;
        await run(() => runtime.setCredential(ref, key.toString('base64')));
        input.recoveryKeyRef = ref; delete input.keyFile;
      }
      output(await run(() => runtime.recovery.backup(input))); break;
    }
    case 'backup-list': {
      const input = values.file ? await jsonFile(required('file'), '备份目录') : {};
      output(await run(() => runtime.recovery.catalog(typeof input.directory === 'string' ? input.directory : undefined))); break;
    }
    case 'restore': {
      const input = await jsonFile(required('file'), '恢复');
      if (typeof input.backupDirectory !== 'string' || typeof input.keyFile !== 'string' || !resources) throw new Error('恢复需要 backupDirectory、keyFile 和目标 resources');
      const key = await readFile(resolve(input.keyFile)); rememberSecret(key.toString('base64'));
      const backupDirectory = input.backupDirectory;
      const targetConfiguration = await recoveryTargetConfiguration(input);
      const result = await run(() => restoreProductRecovery({ root, backupDirectory, key, resources,
        ...targetConfiguration,
        minimumFreeBytes: typeof input.minimumFreeBytes === 'number' ? input.minimumFreeBytes : undefined }));
      await run(async () => { for (const owner of result.owners) await owner.close?.(); });
      await run(() => runtime.stop());
      output({ phase: 'isolated', root, backupId: result.manifest.backupId }); break;
    }
    case 'upgrade': {
      const input = await jsonFile(required('file'), '升级');
      if (!['schema', 'pg-minor', 'pg-major'].includes(String(input.kind)) || typeof input.targetRoot !== 'string'
        || typeof input.backupDirectory !== 'string' || typeof input.keyFile !== 'string' || !resources) throw new Error('升级需要 kind、targetRoot、backupDirectory、keyFile 和目标 resources');
      const key = await readFile(resolve(input.keyFile)); rememberSecret(key.toString('base64'));
      const ref = `recovery-${randomUUID()}`;
      await run(() => runtime.setCredential(ref, key.toString('base64')));
      const targetRoot = resolve(input.targetRoot), backupDirectory = input.backupDirectory;
      const targetConfiguration = await recoveryTargetConfiguration(input);
      const result = await run(() => upgradeProductRecovery({ kind: input.kind as 'schema' | 'pg-minor' | 'pg-major',
        sourceRoot: root, root: targetRoot, backupDirectory, key, resources,
        ...targetConfiguration,
        backup: () => runtime.recovery.backup({ directory: backupDirectory, recoveryKeyRef: ref, leaveClosed: true }) }));
      await run(async () => { for (const owner of result.owners) await owner.close?.(); });
      await run(() => openProductRuntime({ root: targetRoot }).stop());
      output({ phase: 'isolated', root: targetRoot, backupId: result.manifest.backupId }); break;
    }
    case 'takeover': {
      const input = await jsonFile(required('file'), '接管');
      if (typeof input.sourceRoot !== 'string' || !Array.isArray(input.receivers)) throw new Error('接管需要 sourceRoot 与 receivers');
      const sourceRoot = input.sourceRoot;
      output(await run(() => runtime.recovery.takeover({ sourceRoot, receivers: input.receivers as { id: string; root: string }[] }))); break;
    }
    case 'maintenance-resume': output(await run(() => runtime.recovery.resume())); break;
    case 'prepare': {
      const options = await installOptions();
      const result = await run(() => runtime.prepare(options));
      output(result);
      if (result.status === 'installation-required') process.exitCode = 3;
      break;
    }
    case 'install': {
      const options = await installOptions();
      output(await run(() => runtime.install(options)));
      break;
    }
    case 'launch': {
      const options = await installOptions();
      let current: Awaited<ReturnType<Runtime['status']>> | undefined;
      // Only missing installation metadata means first launch. Never treat a
      // damaged descriptor, permission error or unresponsive service as uninstalled.
      await run(async () => {
        try { current = await runtime.status(); } catch (error) {
          const failure = error as NodeJS.ErrnoException;
          if (failure.code !== 'ENOENT'
            || ![join(root, '.xunjie-root'), join(root, 'installation.json')].includes(failure.path ?? '')) throw error;
        }
      });
      if (!current) {
        const bundled = resources ?? await resourcesFile(fileURLToPath(new URL('../resources.json', import.meta.url)));
        runtime = openRuntime(bundled);
        await run(() => runtime.install(options));
      } else if (current.state === 'uninstalled') {
        await run(() => runtime.install(options));
      }
      const status = await run(() => runtime.start());
      output(status);
      if (!['ready', 'degraded'].includes(status.state) || !status.endpoint) {
        throw new Error('运行环境尚无可打开的就绪 endpoint；运行状态已输出');
      }
      await openBrowser(status.endpoint);
      break;
    }
    case 'start': output(await run(() => runtime.start())); break;
    case 'school-member':
    case 'school-membership':
    case 'school-connection':
    case 'learning-binding': {
      const input = await jsonFile(required('file'), '学校成员操作');
      if (typeof input.password === 'string') rememberSecret(input.password);
      const status = await run(() => runtime.status());
      if (!status.endpoint || !['ready', 'degraded'].includes(status.state)) throw new Error('请先启动本学校产品环境');
      const action = command === 'school-member' ? 'members' : command === 'school-membership' ? 'membership'
        : command === 'learning-binding' ? 'local-binding' : 'connection';
      const response = await fetch(new URL(`/api/learning/manage/${action}`, status.endpoint), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${rememberSecret(await resolveCredential(root, 'control'))}` },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(`学校成员操作未完成（${response.status}），请核对输入及当前授权`);
      output(await response.json()); break;
    }
    case 'course-import': {
      const manifestPath = resolve(required('file'));
      const manifest = await jsonFile(manifestPath, '课程导入清单');
      const release = object(manifest.release, '课程导入清单 release');
      if (!Array.isArray(release.materials)) throw new Error('课程导入清单 release.materials 必须是数组');
      if (manifest.resources !== undefined) throw new Error('课程导入清单不内嵌资源；资源按材料路径从清单所在目录读取');
      const importRoot = await realpath(dirname(manifestPath));
      const embedded: { path: string; contentBase64: string }[] = [];
      for (const value of release.materials) {
        const material = object(value, '课程导入材料');
        if (typeof material.path !== 'string' || !material.path) throw new Error('课程导入材料缺少 path');
        if (typeof material.sha256 !== 'string' || typeof material.byteLength !== 'number'
          || !Number.isSafeInteger(material.byteLength) || material.byteLength < 0) {
          throw new Error(`材料 ${material.path} 缺少有效的 sha256 或 byteLength`);
        }
        let absolute: string;
        try { absolute = await realpath(resolve(importRoot, material.path)); }
        catch { throw new Error(`无法读取材料 ${material.path}`); }
        const confined = relative(importRoot, absolute);
        if (!confined || confined.startsWith('..') || isAbsolute(confined)) throw new Error(`材料 ${material.path} 越出导入目录`);
        let bytes: Buffer;
        try { bytes = await readFile(absolute); } catch { throw new Error(`无法读取材料 ${material.path}`); }
        if (createHash('sha256').update(bytes).digest('hex') !== material.sha256 || bytes.byteLength !== material.byteLength) {
          throw new Error(`材料 ${material.path} 与清单的摘要或长度不一致`);
        }
        embedded.push({ path: material.path, contentBase64: bytes.toString('base64') });
      }
      output(await manageCourse('course-import', { ...manifest, resources: embedded }, 120000)); break;
    }
    case 'course-access': {
      output(await manageCourse('course-access', await jsonFile(required('file'), '课程资格操作'))); break;
    }
    case 'course-result': {
      const input = await jsonFile(required('file'), '课程登记查询');
      if (typeof input.requestId !== 'string') throw new Error('课程登记查询需要 requestId');
      output(await manageCourse('course-result', { requestId: input.requestId })); break;
    }
    case 'status': output(await run(() => runtime.status())); break;
    case 'stop': output(await run(() => runtime.stop())); break;
    case 'uninstall': output(await run(() => runtime.uninstall())); break;
    case 'delete':
      {
        const environmentId = required('environment-id');
        output(await run(() => runtime.deleteEnvironment({ environmentId })));
      }
      break;
    case 'database': output(await run(() => runtime.database())); break;
    case 'set-credential': {
      const ref = required('ref');
      const path = required('file');
      let value: string;
      try {
        value = await readFile(resolve(path), 'utf8');
      } catch {
        throw new Error('无法读取凭据文件');
      }
      // Accept a single terminal newline without stripping meaningful spaces.
      value = value.replace(/\r?\n$/, '');
      if (!value || /[\r\n]/.test(value)) throw new Error('凭据文件必须包含一行非空凭据');
      rememberSecret(value);
      await run(() => runtime.setCredential(ref, value));
      output({ saved: true });
      break;
    }
    case 'connect': {
      const input = await jsonFile(required('file'), '连接');
      if (typeof input.token !== 'string' || !input.token) throw new Error('连接文件需要非空 token');
      rememberSecret(input.token);
      const connection = object(input.connection, 'connection') as unknown as Connection;
      // The library owns validation, credential persistence and transport.
      const token = input.token;
      await run(() => runtime.connect(connection, token));
      output({ registered: true });
      break;
    }
    case 'authorize': {
      const input = await jsonFile(required('file'), '授权');
      if (typeof input.sourceEnvironmentId !== 'string' || !input.sourceEnvironmentId
        || typeof input.sourceServiceId !== 'string' || !input.sourceServiceId
        || !Array.isArray(input.capabilities)
        || !input.capabilities.every((capability) => typeof capability === 'string' && capability.length > 0)) {
        throw new Error('授权文件需要 sourceEnvironmentId、sourceServiceId 和 capabilities 数组');
      }
      const path = resolve(required('out'));
      // Reserve the destination before issuing a grant; never overwrite a private file.
      let destination;
      try {
        destination = await open(path, 'wx', 0o600);
      } catch {
        throw new Error('无法新建授权文件；请提供父目录存在且尚未使用的 --out 路径');
      }
      let grantId: string | undefined;
      try {
        await destination.chmod(0o600);
        const grant = await runtime.authorize({
          sourceEnvironmentId: input.sourceEnvironmentId,
          sourceServiceId: input.sourceServiceId,
          capabilities: input.capabilities,
        } as Authorization);
        grantId = grant.grantId;
        rememberSecret(grant.token);
        await destination.writeFile(`${JSON.stringify(grant, null, 2)}\n`, 'utf8');
        await destination.close();
      } catch {
        await destination.close().catch(() => {});
        await unlink(path).catch(() => {});
        if (grantId) {
          try {
            await runtime.revoke(grantId);
          } catch {
            throw new Error('授权文件写入失败，撤销也失败；请检查目标环境的授权状态');
          }
        }
        throw new Error('无法完成授权或写入私有授权文件');
      }
      output({ path, grantId });
      break;
    }
    case 'revoke': {
      const grantId = required('grant-id');
      output(await run(() => runtime.revoke(grantId)));
      break;
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof ProductInstallationRequiredError) {
    output(error.result); process.exitCode = 3; return;
  }
  let message = error instanceof Error ? error.message : '命令执行失败';
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join('[redacted]');
  }
  const detail = error instanceof ProductPrerequisitePreparationError ? { code: error.code, cachePath: error.cachePath, recovery: error.recovery } : {};
  process.stderr.write(`${JSON.stringify({ message, ...detail })}\n`);
  process.exitCode = 1;
});
