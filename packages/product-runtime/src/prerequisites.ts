import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { DatabaseConfiguration, RuntimeResources } from './postgres.js';

type Report = Record<string, unknown>;
export interface ProductPrerequisiteResult {
  status: 'ready' | 'installation-required';
  runtime?: Report;
  installer?: { path: string; version: string; sha256: string; arguments: string[] };
  nextAction?: { instruction: string; command: string; retry: string };
}
export class ProductInstallationRequiredError extends Error {
  readonly code = 'PRODUCT_INSTALLATION_REQUIRED';
  constructor(readonly result: ProductPrerequisiteResult) {
    super('Microsoft 运行库需要由用户完成安装。');
    this.name = 'ProductInstallationRequiredError';
  }
}
export class ProductPrerequisitePreparationError extends Error {
  readonly code: string;
  readonly cachePath?: string;
  readonly recovery: string;
  constructor(detail: { code: string; message: string; cachePath?: string; recovery: string }) {
    super([detail.message, detail.cachePath ? `缓存文件：${detail.cachePath}` : '', detail.recovery].filter(Boolean).join(' '));
    this.name = 'ProductPrerequisitePreparationError';
    this.code = detail.code; this.cachePath = detail.cachePath; this.recovery = detail.recovery;
  }
}
interface PrerequisiteHost {
  platform: string;
  run(script: string, mode: 'Check' | 'Prepare'): Promise<Report>;
}
const exec = promisify(execFile);
const nativeHost: PrerequisiteHost = {
  platform: process.platform,
  async run(script, mode) {
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Invoke product-owned commands inline; no execution-policy, trust-store or
    // privilege setting is changed, and no unsigned-script policy is configured.
    const source = await readFile(script, 'utf8');
    const encoded = Buffer.from(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n& {\n${source}\n} -Mode ${mode}`, 'utf16le').toString('base64');
    let stdout: string;
    try {
      ({ stdout } = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true, timeout: mode === 'Check' ? 15_000 : 150_000, maxBuffer: 256 * 1024,
      }));
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      // The helper returns a bounded JSON error; never parse/echo CLIXML or
      // raw PowerShell exceptions, which can contain private command inputs.
      if (!failure.stdout) {
        throw new Error('Windows 运行库准备失败；请检查网络、产品文件及 Microsoft 签名验证结果后重试。未运行安装器。');
      }
      stdout = failure.stdout;
      let failed: Report;
      try { failed = JSON.parse(stdout.replace(/^\uFEFF/, '')) as Report; }
      catch { throw new Error('Windows 运行库准备器返回无效结果；未运行安装器。'); }
      if (failed.status === 'preparation-failed') throwPreparationFailure(failed);
      if (mode !== 'Check' || failure.code !== 3) throw new Error('Windows 运行库准备失败；未运行安装器。');
    }
    try {
      const report = JSON.parse(stdout.replace(/^\uFEFF/, '')) as Report;
      if (report.status === 'preparation-failed') throwPreparationFailure(report);
      return report;
    }
    catch (error) { if (error instanceof ProductPrerequisitePreparationError) throw error;
      throw new Error('Windows 运行库准备器返回无效结果；未运行安装器。'); }
  },
};
function throwPreparationFailure(report: Report): never {
  const detail = report.error as Report | undefined;
  if (!detail || typeof detail.code !== 'string' || typeof detail.message !== 'string' || typeof detail.recovery !== 'string'
    || (detail.cachePath !== undefined && typeof detail.cachePath !== 'string')) throw new Error('Windows 运行库准备器返回无效错误；未运行安装器。');
  throw new ProductPrerequisitePreparationError({ code: detail.code, message: detail.message, recovery: detail.recovery, cachePath: detail.cachePath as string | undefined });
}

// The host seam lets tests exercise orchestration without installing anything.
export function createPrerequisitePreparer(host: PrerequisiteHost = nativeHost) {
  return async (resources: RuntimeResources, database: DatabaseConfiguration): Promise<ProductPrerequisiteResult> => {
    if (host.platform !== 'win32' || database.mode !== 'managed') return { status: 'ready' };
    if (!resources.windowsPrerequisitePath) throw new Error('Windows 产品包缺少运行库准备器；请使用包含先决条件资源的完整产品包。');
    const check = await host.run(resources.windowsPrerequisitePath, 'Check');
    const runtime = check.runtime as Report | undefined;
    if (check.status === 'ready' && runtime?.ready === true) return { status: 'ready', runtime };
    if (check.status !== 'preparation-required' || runtime?.ready !== false) throw new Error('Windows 运行库检查结果无效；准备已停止。');
    const prepared = await host.run(resources.windowsPrerequisitePath, 'Prepare');
    if (prepared.status === 'ready' && (prepared.runtime as Report | undefined)?.ready === true) return { status: 'ready', runtime: prepared.runtime as Report };
    if (prepared.status !== 'downloaded-and-verified-not-installed'
      || (prepared.signature as Report | undefined)?.status !== 'Valid'
      || typeof prepared.installer !== 'string' || typeof prepared.fileVersion !== 'string'
      || prepared.fileVersion !== runtime.productAcceptedMinimum
      || typeof prepared.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(prepared.sha256)) {
      throw new Error('Microsoft 安装器尚未通过完整校验；未运行安装器。');
    }
    return {
      status: 'installation-required', runtime,
      installer: { path: prepared.installer, version: prepared.fileVersion, sha256: prepared.sha256, arguments: ['/install', '/norestart'] },
      nextAction: {
        instruction: '请打开已验证的 Microsoft 安装器，在其窗口中完成许可条款和 Windows 权限操作。循阶不会自动接受或提权。',
        command: `& '${prepared.installer.replaceAll("'", "''")}' /install /norestart`,
        retry: '安装完成后重新运行原命令；循阶会重新检查版本和 DLL。若 Microsoft 要求重启，请先自行完成。',
      },
    };
  };
}
export const prepareProductPrerequisites = createPrerequisitePreparer();
