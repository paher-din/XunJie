import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { fixture, reply, until } from '../apps/server/tests/support/teaching-input-control.mjs';

// One production CLI/Chrome journey for ordinary Web and a complete independent candidate.
// Only the external model transport is controlled; the application and owners are never replaced.
const run = promisify(execFile);
const packageIndex = process.argv.indexOf('--package');
const candidate = packageIndex < 0 ? null : resolve(process.argv[packageIndex + 1]);
const evidence = resolve(process.env.XUNJIE_RECOVERY_EVIDENCE_DIR ?? '.verification/wp07-204/chrome');
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'xj-conversation-probe-'));
const sourceRoot = join(directory, 'source'), targetRoot = join(directory, 'target');
const node = candidate ? join(candidate, 'resources/node', process.platform === 'win32' ? 'node.exe' : 'bin/node') : process.execPath;
const cli = candidate ? join(candidate, 'app/cli.js') : resolve('apps/local-runtime/dist/cli.js');
const resourceFile = candidate ? join(candidate, 'resources.json') : join(directory, 'resources.json');
if (!candidate) await writeFile(resourceFile, JSON.stringify({ nodePath: node, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: resolve(process.env.XUNJIE_PRODUCT_WEB_ROOT ?? 'apps/web/dist'),
  windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') }));
const resources = JSON.parse(await readFile(resourceFile, 'utf8'));
const postgresBin = resolve(dirname(resourceFile), resources.postgresBin);
const report = { formatVersion: 1, platform: process.platform, osRelease: release(),
  source: candidate ? 'independent-full-package' : 'ordinary-web', stages: [], modelCalls: 0, cleanup: 'pending' };
let browser, f, failed, sequence = 0;
const exists = path => access(path).then(() => true, () => false);
async function command(root, operation, input) {
  const args = [cli, operation, '--root', root, '--json'];
  if (['install', 'restore'].includes(operation)) args.push('--resources', resourceFile);
  if (operation === 'install') args.push('--profile', 'local');
  if (input) {
    const file = join(directory, 'input-' + sequence++ + '.json');
    await writeFile(file, JSON.stringify(input), { mode: 0o600 }); args.push('--file', file);
  }
  try {
    const result = await run(node, args, { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
  } catch (error) { throw new Error('Product CLI failed: ' + operation + ' (' + (error.code ?? 'unknown') + ')'); }
}
const record = (name, fact) => report.stages.push({ name, passed: true, fact });
try {
  report.nodeVersion = (await run(node, ['--version'], { windowsHide: true })).stdout.trim();
  report.postgresVersion = (await run(join(postgresBin, process.platform === 'win32' ? 'postgres.exe' : 'postgres'), ['--version'], { windowsHide: true })).stdout.trim();
  await command(sourceRoot, 'install');
  const started = await command(sourceRoot, 'start'); assert.equal(started.state, 'ready');
  record('bundled-or-source-cli-start', { state: started.state });
  process.env.XUNJIE_INPUT_CONTROL_ENDPOINT = started.endpoint;
  process.env.XUNJIE_PRODUCT_POSTGRES_BIN = postgresBin;
  f = await fixture((_payload, response, index) => index === 1 ? reply(response, { calls: [{ id: 'restore-prediction', name: 'student_ask',
    arguments: { question: '恢复后仍回答这个原问题。', source: '固定学习依据', options: [], allowText: true, skippable: true } }] })
    : reply(response, { text: '接管后按原回应与修订继续解释。' }));
  await f.configure();
  const activity = await f.activity('恢复学习对话与原始依据'), base = `agent/${activity.activityId}`;
  const first = await f.send(activity, '请先提问，并保留这次依据。');
  await until(async () => (await f.api(base + '/conversation')).questions[0]?.state === 'pending', 'The source saves its original question.');
  const queued = await f.send(activity, '排队原文。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } });
  await f.api(`${base}/inputs/${queued.inputId}/control`, { version: 1, requestId: randomUUID(), expectedVersion: 1,
    operation: 'revise', text: '恢复时保留的排队修订。' });
  const old = await f.api('context'), original = await f.api(base + '/conversation');
  const keyFile = join(directory, 'recovery-key'); await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  const backups = join(directory, 'backups');
  const backup = await command(sourceRoot, 'backup', { directory: backups, keyFile, leaveClosed: true });
  assert.ok(backup.boundary.services.some(service => service.kind === 'xunjie.teaching-agent.boundary'));
  await command(targetRoot, 'restore', { backupDirectory: join(backups, backup.backupId), keyFile });
  const isolated = await command(targetRoot, 'start'); assert.equal(isolated.state, 'maintenance');
  const api = async (route, body, namespace) => {
    const response = await fetch(isolated.endpoint + '/api/learning/' + route, {
      headers: { 'content-type': 'application/json', 'x-xj-space': 'personal', ...(namespace ? { 'x-xj-namespace': namespace } : {}) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const read = async route => { const value = await api(route); assert.equal(value.status, 200); return value.body; };
  const restored = await read(base + '/conversation');
  for (const name of ['messages', 'inputs', 'questions', 'tools']) assert.deepEqual(restored[name], original[name]);
  record('isolated-history', { runId: first.runId, inputId: queued.inputId, calls: f.payloads.length });
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  report.chromeVersion = browser.version();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(isolated.endpoint + '/?activity=' + activity.activityId);
  await expect(page.locator('#activity-title')).toHaveText('恢复学习对话与原始依据');
  await page.getByRole('button', { name: '打开对话', exact: true }).click();
  const conversation = page.getByRole('region', { name: '与 Agent 的对话', exact: true });
  await expect(conversation).toContainText('请先提问，并保留这次依据。');
  await expect(conversation.getByText('恢复后仍回答这个原问题。', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, `restore-${process.env.XUNJIE_RECOVERY_CAPTURE_BEFORE === '1' ? 'before' : 'readonly'}-${process.platform}.png`), fullPage: true });
  await expect(conversation).toContainText('维护者完成接管');
  await expect(page.getByRole('button', { name: '跳过这次提问', exact: true })).toBeDisabled();
  assert.equal(f.payloads.length, 1);
  record('chrome-readonly', { calls: f.payloads.length, noResponseSubmitted: true });
  const takeover = { sourceRoot, receivers: [] };
  assert.equal((await command(targetRoot, 'takeover', takeover)).phase, 'active');
  assert.equal((await command(targetRoot, 'takeover', takeover)).phase, 'active');
  const next = await read('context'); assert.notEqual(next.clientNamespace, old.clientNamespace);
  const rejected = await api(`${base}/runs/${first.runId}/stop`, { requestId: randomUUID() }, old.clientNamespace);
  assert.equal(rejected.status, 403);
  record('takeover-and-old-client-rejection', { oldClientRejected: true });
  await page.reload();
  await page.getByRole('button', { name: '打开对话', exact: true }).click();
  const question = page.getByRole('group', { name: 'Agent 的提问', exact: true });
  await question.getByLabel('你的回应', { exact: true }).fill('这是接管后对原问题的明确回应。');
  await question.getByRole('button', { name: '提交回应', exact: true }).click();
  const final = await until(async () => { const value = await read(base + '/conversation');
    return value.runs.length === 2 && value.runs.every(run => run.state === 'completed') ? value : null;
  }, 'The original question and revised FIFO input complete through the restored product.', 60000);
  assert.equal(final.runs[0].runId, first.runId); assert.equal(f.payloads.length, 3);
  await expect(page.getByRole('region', { name: '与 Agent 的对话', exact: true })).toContainText('这是接管后对原问题的明确回应。');
  const queuedRecord = page.locator('[data-input-id="' + queued.inputId + '"]');
  await expect(queuedRecord).toHaveAttribute('data-state', 'adopted');
  await expect(queuedRecord).toContainText('恢复时保留的排队修订。');
  await page.screenshot({ path: join(evidence, `restore-active-${process.platform}.png`), fullPage: true });
  record('chrome-active-original-response-and-fifo', { calls: f.payloads.length, revisedQueueVisibleAsAdopted: true,
    runs: final.runs.map(run => ({ runId: run.runId, state: run.state })) });
} catch (error) { failed = error; report.failure = error.message; }
finally {
  report.modelCalls = f?.payloads.length ?? 0;
  await browser?.close(); await f?.close();
  let stopped = true;
  for (const root of [targetRoot, sourceRoot]) if (await exists(join(root, 'installation.json'))) {
    try { await command(root, 'stop'); } catch { stopped = false; }
  }
  if (stopped) {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('xj-conversation-probe-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    report.cleanup = 'completed';
  } else { report.cleanup = 'stop-failed'; failed ??= new Error('Product stop requires follow-up'); }
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: !failed, stages: report.stages.length, modelCalls: report.modelCalls, cleanup: report.cleanup }));
if (failed) { console.error(failed.message); process.exitCode = 1; }
