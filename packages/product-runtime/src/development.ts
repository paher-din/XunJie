import { join } from 'node:path';
import { runtimeEnvironmentSchema, type RuntimeStatus } from '@xunjie/contracts/product-runtime';
import { readJson } from './io.js';
import { resolveDeployment } from './deployment.js';
import { openProductRuntime, type InstalledConfiguration } from './runtime.js';

/** Promote a stopped legacy development environment through the normal lifecycle. */
export async function prepareProductDevelopment(root: string) {
  const environment = runtimeEnvironmentSchema.parse(await readJson(join(root, 'environment.json')));
  const configuration = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
  if (environment.profile !== 'local' || !['127.0.0.1', '::1'].includes(configuration.host)) {
    throw new Error('Product development requires an existing local loopback environment.');
  }
  if (!configuration.installed) throw new Error('Install the product before starting development.');
  if (configuration.deployment !== undefined) return { upgraded: false };
  const runtime = openProductRuntime({ root });
  const deployment = resolveDeployment(environment, configuration);
  await runtime.configureDeployment(deployment, { dryRun: true });
  await runtime.configureDeployment(deployment);
  return { upgraded: true };
}

/** A module declaration alone cannot establish that its service was started. */
export function assertProductDevelopmentServices(status: RuntimeStatus) {
  if (!status.deployment) throw new Error('无法读取开发环境部署状态，请检查产品启动结果。');
  const services = new Set(status.environment.services.map(service => service.unit));
  const missing = status.deployment.configuration.modules.filter(unit => !services.has(unit));
  if (missing.length) throw new Error(`开发环境尚未就绪，缺少实际服务：${missing.join('、')}。请检查部署配置与启动日志。`);
}
