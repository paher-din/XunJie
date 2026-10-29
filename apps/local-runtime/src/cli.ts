#!/usr/bin/env node
import { open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { openProductRuntime, ProductInstallationRequiredError, ProductPrerequisitePreparationError } from '@xunjie/product-runtime';

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
    : ['install', 'prepare'].includes(command) ? fileURLToPath(new URL('../resources.json', import.meta.url)) : undefined;
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

  switch (command) {
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
