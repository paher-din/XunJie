import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureBuild } from './build.mjs';
import { createProductDevFrontend } from './product-dev-frontend.mjs';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/dev-product.mjs [--root <existing product environment>]');
  process.exit(0);
}
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--root' || !args[1])) {
  throw new Error('Usage: node scripts/dev-product.mjs [--root <existing product environment>]');
}
if (process.versions.node !== '24.21.0') throw new Error('Product development requires Node.js 24.21.0.');
const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
const root = resolve(args[1] ?? join(base, 'XunJie', 'environments', 'default'));
const cache = join(repository, '.cache', 'xunjie-build');
await mkdir(cache, { recursive: true });
const runtimeOutput = await mkdtemp(join(cache, 'product-dev-'));
process.once('exit', () => rmSync(runtimeOutput, { recursive: true, force: true }));
let frontend;
let host;
try {
  const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
  const configuration = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'));
  if (environment.profile !== 'local' || !['127.0.0.1', '::1'].includes(configuration.host)) {
    throw new Error('Product development requires an existing local loopback environment.');
  }
  // The build entry prepares workspace dependencies before emitting the temporary host.
  await ensureBuild('product-runtime', { args: ['--outDir', runtimeOutput, '--declaration', 'false'] });
  const { prepareProductDevelopment, assertProductDevelopmentServices } = await import(pathToFileURL(join(runtimeOutput, 'development.js')).href);
  const prepared = await prepareProductDevelopment(root);
  if (prepared.upgraded) console.log('已迁接旧版开发环境，将按部署配置创建实际服务。');
  const { createProductRuntimeHost } = await import(pathToFileURL(join(runtimeOutput, 'host.js')).href);
  const { createProductLearningApplication } = await import(pathToFileURL(join(runtimeOutput, 'learning-entry.js')).href);
  frontend = await createProductDevFrontend({ webRoot: join(repository, 'apps/web'),
    cacheDir: join(cache, 'vite-product-dev') });
  host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication, frontend });
  const status = await host.status();
  assertProductDevelopmentServices(status);
  console.log(`Product development: ${status.endpoint} (${status.state})`);
} catch (error) {
  await host?.stop().catch(() => {});
  await frontend?.close().catch(() => {});
  await rm(runtimeOutput, { recursive: true, force: true });
  throw error;
}
