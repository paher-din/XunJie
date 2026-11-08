// Capture the current formal ActivityPage in a temporary, isolated shipped product.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';

const { values } = parseArgs({ options: {
  product: { type: 'string' }, out: { type: 'string' },
  'web-root': { type: 'string' }, 'source-commit': { type: 'string' },
} });
assert.ok(values.product && values.out, 'Requires --product DIR and --out FILE');
assert.ok(!values['web-root'] || values['source-commit'], '--web-root requires --source-commit');
const product = resolve(values.product), output = resolve(values.out);
const { openProductRuntime } = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
const resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
for (const field of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper'])
  if (resources[field]) resources[field] = resolve(product, resources[field]);
const bundledNodeVersion = resources.nodeVersion;
const postgresVersion = resources.postgresVersion;
if (values['web-root']) resources.webRoot = resolve(values['web-root']);
const webRoot = resources.webRoot;
const webIndexSha256 = createHash('sha256').update(await readFile(join(webRoot, 'index.html'))).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'xj-wp09-before-'));
const runtime = openProductRuntime({ root, resources });
await mkdir(dirname(output), { recursive: true });
let browser, environmentId, endpoint;
try {
  environmentId = (await runtime.install({ profile: 'local' })).environment.environmentId;
  endpoint = (await runtime.start()).endpoint;
  const pageApi = async (route, body) => {
    const response = await fetch(endpoint + '/api/learning/' + route, {
      headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`);
    return value;
  };
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  assert.equal(process.version, 'v24.21.0', 'Run this probe with Node 24.21.0');
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(endpoint + '/');
  await expect(page.getByLabel('学习目标', { exact: true })).toBeVisible();
  await page.getByLabel('学习目标', { exact: true }).fill('WP09 基线：独立学习活动');
  await page.getByRole('button', { name: '建立学习活动', exact: true }).click();
  await expect(page.locator('#activity-title')).toHaveText('WP09 基线：独立学习活动');
  const activityId = new URL(page.url()).searchParams.get('activity');
  assert.ok(activityId, 'The created independent activity must have an activity ID');
  const activity = await pageApi('activities/' + activityId);
  assert.equal(activity.course, undefined, 'The before activity must not be linked to a course');
  await expect(page.getByRole('navigation', { name: '作品文件', exact: true })).toBeVisible();
  await page.screenshot({ path: output, fullPage: true });
  const evidence = { status: 'captured', sourceCommit: values['source-commit'] ?? null,
    entry: values['web-root'] ? 'supplied production webRoot/index.html' : 'product package webRoot', webRoot,
    screenshot: output, activityId, courseLinked: false, chrome: browser.version(), node: process.version,
    packagedNode: bundledNodeVersion, postgres: postgresVersion, product,
    viewport: { width: 1440, height: 1000 } };
  const metadata = join(dirname(output), parse(output).name + '.json');
  await writeFile(metadata, JSON.stringify({ ...evidence, webIndexSha256,
    buildEntrypoint: webRoot.endsWith('dist-runtime') ? 'scripts/build.mjs web:runtime' : 'scripts/build.mjs web' }, null, 2) + '\n');
  console.log(JSON.stringify({ ...evidence, metadata }));
} finally {
  await browser?.close();
  if (endpoint) await runtime.stop();
  if (environmentId) await runtime.deleteEnvironment({ environmentId });
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
