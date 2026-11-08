// One actual generated ALU page -> normal editor -> original button -> real Icarus/owner.
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

const { values: args } = parseArgs({ options: {
  product: { type: 'string', default: 'dist/wp09-macos-r2' }, root: { type: 'string', default: '/private/tmp/xj-wp09-real-models-20261108' },
  'source-report': { type: 'string', default: 'docs/student-agent-implementation/evidence/wp09/real-models-product-r2.json' },
  out: { type: 'string', default: 'docs/student-agent-implementation/evidence/wp09/real-alu.json' },
  resume: { type: 'string' }, 'read-only': { type: 'boolean' }, 'ui-checks': { type: 'boolean' }, help: { type: 'boolean' },
} });
if (args.help) { console.log('NODE24 scripts/probe-wp09-real-alu.mjs [--product DIR] [--root ORIGINAL_PRIVATE_ROOT] [--resume JSON] [--read-only] [--ui-checks] [--out JSON]. Reopens the real model page, never publishes a controlled payload; normal Monaco engineering fixture only. --read-only requires the existing adopted page/fixture/execution, without editing code or running again. --ui-checks types ordinary explanation text and verifies narrow desktop keyboard/navigation recovery. Always stops host/PG and retains the root. Provider generations are denied.'); process.exit(0); }
const root = resolve(args.root), product = resolve(args.product), output = resolve(args.out);
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(), { code }); };
const safe = error => error?.name === 'TimeoutError' ? 'browser-timeout' : /^[A-Za-z][A-Za-z0-9_-]{0,120}$/.test(error?.code ?? '') ? error.code : 'probe-operation-failed';
const originalFetch = globalThis.fetch;
const sourceBytes = await readFile(resolve(args['source-report'])), source = JSON.parse(sourceBytes);
let report;
try { report = JSON.parse(await readFile(resolve(args.resume ?? args.out), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
report ??= { formatVersion: 1, startedAt: new Date().toISOString(), sourceReportSha256: hash(sourceBytes), originalArtifact: source.alu.artifact,
  activityId: source.alu.activityId, originalRunId: source.alu.runId, originalRequestId: source.alu.requestId,
  generationBudget: { cap: 24, prior: source.generationCount, new: 0, total: source.generationCount }, stages: [] };
check(report.formatVersion === 1 && report.generationBudget.total <= 24 && report.activityId === source.alu.activityId, 'original-report-identity-mismatch');
if (report.reason) {
  const failure = { stage: report.failedStage, reason: report.reason, assertion: report.failedAssertion,
    frameStatusSha256: report.frameStatusSha256, frameStatusClasses: report.frameStatusClasses };
  report.failures ??= [];
  if (!report.failures.some(item => digest(item) === digest(failure))) report.failures.push(failure);
}
for (const key of ['reason', 'failedStage', 'failedAssertion', 'frameStatusSha256', 'frameStatusClasses']) delete report[key];
delete report.finishedAt; delete report.cleanupFailure; report.cleanup = 'running';
report.status = 'running'; report.package = { distributionSha256: hash(await readFile(join(product, 'distribution.json'))),
  runtimeSha256: hash(await readFile(join(product, 'app/product-runtime.js'))) };
(report.invocations ??= []).push({ at: new Date().toISOString(), probeSha256: hash(await readFile(new URL(import.meta.url))), readOnly: !!args['read-only'], uiChecks: !!args['ui-checks'], distributionSha256: report.package.distributionSha256 });
report.http = []; report.providerAttempts = 0;
const module = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
const resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
for (const name of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper']) if (resources[name]) resources[name] = resolve(product, resources[name]);
const handoff = JSON.parse(await readFile(join(root, 'wp09-real-models-handoff.private.json'), 'utf8'));
check(handoff.activityId === report.activityId, 'private-handoff-activity-mismatch');
const artifact = report.artifact ?? report.originalArtifact, activityId = report.activityId;
const baseExplanation = '验收中文解释：原页面输入恢复。';
const narrowExplanation = baseExplanation + '窄桌面键盘与导航验收。';
const expectedExplanation = () => report.explanationSha256 === hash(narrowExplanation) ? narrowExplanation : baseExplanation;
let host, browser, page, context, runtime, cookie, phase = 'setup', installationSha256;
const facts = new Set();
const persist = async () => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
async function stage(name, operation) {
  phase = name; const entry = { name, status: 'running' }; report.stages.push(entry); await persist();
  try { const value = await operation(); entry.status = 'passed'; await persist(); return value; }
  catch (error) { entry.status = 'failed'; entry.reason = safe(error); await persist(); throw error; }
}
async function api(route, body) {
  const response = await originalFetch(host.endpoint + '/api/learning/' + route, { redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', 'x-xj-space': 'school', cookie }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  check(response.status === 200, 'http-' + response.status);
  return response.json();
}
const history = () => api('executions/' + activityId + '/history');
async function createHost() {
  const result = await module.createProductRuntimeHost({ root, createApplication: context => {
    context.configuration.resources.webRoot = resources.webRoot;
    return module.createProductLearningApplication(context);
  } });
  const response = await originalFetch(result.endpoint + '/'), bytes = Buffer.from(await response.arrayBuffer());
  check(response.status === 200 && hash(bytes) === hash(await readFile(join(resources.webRoot, 'index.html'))), 'not-serving-packaged-web');
  report.package.servedIndexSha256 = hash(bytes);
  report.package.webRuntime = [];
  for (const file of (await readdir(join(resources.webRoot, 'assets'))).filter(name => /^runtime-[A-Za-z0-9_-]+\.js$/.test(name))) {
    const expected = hash(await readFile(join(resources.webRoot, 'assets', file)));
    const served = await originalFetch(result.endpoint + '/assets/' + file);
    check(served.status === 200 && hash(Buffer.from(await served.arrayBuffer())) === expected, 'not-serving-packaged-web-runtime');
    report.package.webRuntime.push({ file, sha256: expected });
  }
  check(report.package.webRuntime.length > 0, 'packaged-web-runtime-not-found');
  return result;
}
async function openActivity() {
  await page.bringToFront(); await page.goto(host.endpoint + '/?space=school&activity=' + activityId);
  await expect(page.locator('#activity-title')).toBeVisible({ timeout: 20000 });
  const toggle = page.getByRole('button', { name: /^(打开对话|问题与引用)$/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
const card = () => page.locator('.teaching-artifact-card[data-artifact-id="' + artifact.artifactId + '"]').first();
const frame = () => card().frameLocator('iframe');
async function originalSource() {
  const base = `artifacts/${activityId}`;
  const revision = await api(`${base}/${artifact.artifactId}/revisions/${artifact.revisionId}`), resource = await api(`${base}/${artifact.artifactId}/revisions/${artifact.revisionId}/resource`);
  check(revision.sha256 === artifact.sha256 && hash(Buffer.from(resource.contentBase64, 'base64')) === artifact.sha256, 'original-generated-resource-changed');
  check(digest(revision.origin) === digest(artifact.origin), 'original-generated-origin-changed');
  const conversation = await api(`agent/${activityId}/conversation`);
  const runIds = conversation.runs.map(run => run.runId).sort();
  report.originalConversationRunIds ??= runIds;
  check(digest(runIds) === digest(report.originalConversationRunIds), 'interaction-created-another-model-run');
  check(conversation.runs.some(run => run.runId === report.originalRunId && run.requestId === report.originalRequestId && run.state === 'completed')
    && conversation.tools.some(tool => tool.commandId === artifact.origin.commandId && tool.outcome === 'completed'
      && tool.result?.artifact?.revisionId === artifact.revisionId), 'original-generation-run-or-command-mismatch');
  const snapshot = await api(`agent/${activityId}/snapshots/${artifact.origin.snapshotId}`);
  check(snapshot.attemptId === artifact.origin.attemptId, 'original-snapshot-attempt-mismatch');
  report.source = { artifactId: artifact.artifactId, revisionId: artifact.revisionId, candidateId: artifact.candidateId, sha256: revision.sha256,
    runId: report.originalRunId, requestId: report.originalRequestId, origin: revision.origin, payloadSha256: snapshot.payloadSha256 };
  return revision;
}
async function screenshot(name) {
  const file = name.replace(/^real-alu/, basename(output, '.json'));
  const target = join(dirname(output), file);
  await page.screenshot({ path: target, fullPage: false, animations: 'disabled' });
  (report.screenshots ??= []).push({ file, sha256: hash(await readFile(target)), viewport: { width: 1440, height: 1000 } });
}
async function login() {
  const logged = await context.request.post(host.endpoint + '/api/learning/login', { data: { loginName: handoff.loginName, password: handoff.password } });
  check(logged.status() === 200, 'original-school-login-failed'); cookie = logged.headers()['set-cookie'].split(';')[0];
}
async function waitHistory(predicate, timeout = 90000) {
  let result;
  await expect.poll(async () => { result = await history(); return predicate(result.entries); }, { timeout, intervals: [200, 500, 1000] }).toBeTruthy();
  return result;
}
async function validateExecution(entry, fixtureSha256) {
  const action = entry.action, query = entry.query, fixed = action.execution.basis.works;
  check(query.state === 'succeeded' && query.statusKnowledge === 'confirmed' && query.output?.output?.f === '0000' && query.output.output.cout === '1', 'actual-icarus-output-mismatch');
  check(action.protocolVersion === 3 && action.execution.basis.runtime.adapterId === 'icarus-alu' && action.execution.operation.operationId === 'run-single', 'actual-executor-not-original-icarus');
  check(digest(action.execution.parameters) === digest({ A: 15, B: 1, M: 1, S: 0, Cin: 0 }), 'actual-page-parameters-mismatch');
  const code = fixed.find(file => file.name === 'alu.sv'), pageState = fixed.find(file => file.name === 'components/artifact-' + artifact.artifactId + '.json');
  check(code && hash(code.value) === fixtureSha256 && pageState, 'execution-does-not-cite-click-time-fixture-and-page');
  const state = JSON.parse(pageState.value);
  check(state.componentId === artifact.artifactId && state.version === artifact.version && state.definitionDigest === report.bindingDigest, 'execution-page-version-source-mismatch');
  check(action.execution.initiator.kind === 'student', 'page-click-is-not-student-initiated');
  const retained = await api(`executions/${activityId}/${query.requestId}/artifact`);
  check(retained.requestId === query.requestId && retained.executionRef === query.executionRef
    && entry.action.requestId === query.requestId && entry.acceptance.receipt.inputDigest === query.inputDigest
    && entry.acceptance.execution.executionRef === query.executionRef && retained.sha256 === query.output.artifact.sha256
    && hash(retained.text) === retained.sha256, 'retained-result-is-not-original-execution');
  report.execution = { requestId: query.requestId, executionRef: query.executionRef, inputDigest: query.inputDigest, state: query.state,
    statusKnowledge: query.statusKnowledge, output: { f: query.output.output.f, cout: query.output.output.cout }, outputContentId: query.output.contentId,
    adapterId: action.execution.basis.runtime.adapterId, bundleIdentity: action.execution.basis.runtime.bundleIdentity,
    componentKey: action.execution.instance.key, operationId: action.execution.operation.operationId, parameters: action.execution.parameters,
    code: { objectId: code.objectId, contentId: code.contentId, sha256: fixtureSha256 },
    page: { objectId: pageState.objectId, contentId: pageState.contentId, sha256: hash(pageState.value), artifactId: artifact.artifactId, revisionId: artifact.revisionId },
    retainedArtifact: { executionRef: retained.executionRef, requestId: retained.requestId, inputDigest: query.inputDigest, textSha256: hash(retained.text) } };
}
try {
  check(process.version === 'v24.21.0', 'requires-fixed-node-24-21');
  const installation = await readFile(join(root, 'installation.json')); installationSha256 = hash(installation);
  const saved = JSON.parse(installation).resources;
  check(hash(await readFile(saved.nodePath)) === hash(await readFile(resources.nodePath))
    && hash(await readFile(join(saved.postgresBin, 'postgres'))) === hash(await readFile(join(resources.postgresBin, 'postgres'))), 'native-resources-differ-from-package');
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) { report.providerAttempts++; throw Object.assign(new Error(), { code: 'provider-generation-disabled' }); }
    return originalFetch(input, init);
  };
  runtime = module.openProductRuntime({ root, resources }); host = await createHost();
  browser = await chromium.launch({ channel: 'chrome', headless: false }); report.chrome = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await login(); page = await context.newPage();
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith('/api/learning/')) return;
    const pending = (async () => {
      const row = { method: response.request().method(), path, status: response.status() };
      if (row.method === 'POST' && /\/executions\//.test(path)) {
        const data = response.request().postDataJSON(), action = data.action;
        if (action?.kind === 'execution') Object.assign(row, { requestId: action.requestId, actionSha256: digest(action), operationId: action.execution.operation.operationId });
      }
      if (response.status() >= 400) { const body = await response.json().catch(() => null); row.error = /^[A-Za-z0-9_-]{1,100}$/.test(body?.error ?? '') ? body.error : 'unclassified'; }
      if (report.http.length < 400) report.http.push(row);
    })().catch(() => {}); facts.add(pending); void pending.finally(() => facts.delete(pending));
  });
  const revision = await stage('same-real-generation-and-original-source', originalSource); report.bindingDigest = revision.binding.definition.digest;
  const initial = await history(); report.initialExecutionIds ??= initial.entries.map(entry => entry.query.requestId);
  await stage('formal-chrome-check-and-adopt-original-page', async () => {
    if (args['read-only']) check((await api(`artifacts/${activityId}/${artifact.artifactId}`)).activeRevisionId === artifact.revisionId, 'read-only-requires-adopted-page');
    await openActivity();
    await expect.poll(async () => (await api(`artifacts/${activityId}/${artifact.artifactId}`)).activeRevisionId, { timeout: 30000 }).toBe(artifact.revisionId);
    const candidate = await api(`artifacts/${activityId}/candidates/${artifact.candidateId}`);
    check(candidate.status === 'adopted' && candidate.checks.every(check => check.passed), 'independent-chrome-check-not-passed');
    report.adoption = { candidateId: candidate.candidateId, revisionId: artifact.revisionId, checks: candidate.checks.map(item => ({ code: item.code, passed: item.passed })) };
  });
  const fixtureProbe = await readFile('scripts/probe-wp09-alu.mjs', 'utf8');
  const literal = /const\s+(?:CORRECT|source)\s*=\s*("(?:[^"\\]|\\.)*")\s*;/.exec(fixtureProbe)?.[1];
  check(literal, 'declared-engineering-fixture-not-found'); const fixture = JSON.parse(literal), fixtureSha256 = hash(fixture);
  report.fixture = { source: 'scripts/probe-wp09-alu.mjs engineering fixture', sha256: fixtureSha256, entry: 'alu.sv', method: 'normal Monaco editor; not a student starter or Agent change' };
  await stage('ordinary-page-interaction-without-model-or-execution', async () => {
    const input = frame().getByRole('textbox', { name: '我的解释', exact: true });
    await expect(input).toBeEditable({ timeout: 15000 });
    if (!args['read-only']) {
      await input.fill(expectedExplanation()); await page.locator('#activity-title').click();
      await expect.poll(async () => { const work = await api('workspaces/' + activityId); const file = work.files.find(file => file.name === 'components/artifact-' + artifact.artifactId + '.json'); return file && JSON.parse(file.value).content.explanation; }).toBe(expectedExplanation());
    } else await expect(input).toHaveValue(expectedExplanation());
    check((await history()).entries.length === initial.entries.length, 'ordinary-interaction-executed-an-experiment');
  });
  await stage('engineering-fixture-in-normal-monaco', async () => {
    if (!args['read-only']) await expect(page.getByRole('button', { name: '运行', exact: true })).toBeEnabled({ timeout: 180000 });
    let work = await api('workspaces/' + activityId), file = work.files.find(file => file.name === 'alu.sv');
    if (!args['read-only'] && (!file || hash(file.value) !== fixtureSha256)) {
      const editor = page.locator('.monaco-editor textarea').first(); await expect(editor).toBeVisible();
      await editor.focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(fixture);
      await page.locator('#activity-title').click();
    }
    await expect.poll(async () => { work = await api('workspaces/' + activityId); file = work.files.find(file => file.name === 'alu.sv'); return file && hash(file.value); }, { timeout: 15000 }).toBe(fixtureSha256);
    report.fixture.contentId = file.contentId; report.fixture.objectId = file.objectId;
  });
  await stage('real-generated-button-to-icarus-and-original-owner', async () => {
    let entries = (await history()).entries;
    let original = report.execution?.requestId ? entries.find(entry => entry.query.requestId === report.execution.requestId) : null;
    if (!original) {
      check(!args['read-only'], 'read-only-requires-original-execution');
      const before = new Set(entries.map(entry => entry.query.requestId));
      const run = frame().getByRole('button', { name: /运行单次实验/ }); await expect(run).toBeEnabled(); await run.click();
      const settled = await waitHistory(items => items.some(entry => !before.has(entry.query.requestId) && ['succeeded', 'failed', 'stopped'].includes(entry.query.state)));
      const fresh = settled.entries.filter(entry => !before.has(entry.query.requestId));
      check(fresh.length === 1, 'explicit-page-click-did-not-produce-one-original-request'); original = fresh[0];
      report.execution = { requestId: original.query.requestId }; await persist();
    }
    await validateExecution(original, fixtureSha256);
    const trusted = card().locator('.teaching-artifact-results');
    await expect(trusted.getByText('F：0000　Cout：1', { exact: false })).toBeVisible({ timeout: 15000 });
    await trusted.scrollIntoViewIfNeeded(); await screenshot('real-alu-actual-icarus.png');
  });
  await stage('refresh-retains-page-state-and-original-result-without-rerun', async () => {
    const before = await history(), requestId = report.execution.requestId;
    const body = await api(`executions/${activityId}/${requestId}`), fixed = await api(`executions/${activityId}/${requestId}/artifact`);
    await openActivity();
    await expect(frame().getByRole('textbox', { name: '我的解释', exact: true })).toHaveValue(expectedExplanation(), { timeout: 15000 });
    await expect(card().locator('.teaching-artifact-results').getByText('F：0000　Cout：1', { exact: false })).toBeVisible({ timeout: 15000 });
    check(digest(await history()) === digest(before) && digest(await api(`executions/${activityId}/${requestId}`)) === digest(body)
      && digest(await api(`executions/${activityId}/${requestId}/artifact`)) === digest(fixed), 'refresh-reexecuted-or-replaced-original-result');
    report.refresh = { originalRequestId: requestId, querySha256: digest(body), retainedResultSha256: digest(fixed), newExecutionRequests: 0 };
    await originalSource();
    await card().locator('.teaching-artifact-results').scrollIntoViewIfNeeded();
    await screenshot('real-alu-restored.png');
  });
  if (args['ui-checks']) await stage('narrow-desktop-tab-and-navigation-retain-input-without-rerun', async () => {
    const before = await history(), requestId = report.execution.requestId;
    const query = await api(`executions/${activityId}/${requestId}`), retained = await api(`executions/${activityId}/${requestId}/artifact`);
    const activityUrl = host.endpoint + '/?space=school&activity=' + activityId;
    await page.setViewportSize({ width: 1024, height: 800 });
    // Explicit list -> activity entries let browser Back/Forward exercise both routes.
    await page.goto(host.endpoint + '/?space=school');
    await expect(page.locator('#activity-title')).toHaveCount(0);
    await page.goto(activityUrl);
    const center = () => page.locator('.teaching-artifact-center[data-artifact-id="' + artifact.artifactId + '"]').first();
    const centeredFrame = () => center().frameLocator('iframe');
    const centeredInput = () => centeredFrame().getByRole('textbox', { name: '我的解释', exact: true });
    async function restoreCenter() {
      await expect(page.locator('#activity-title')).toBeVisible({ timeout: 20000 });
      if (!await center().isVisible()) {
        const toggle = page.getByRole('button', { name: /^(打开对话|问题与引用)$/ });
        if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
        await card().getByRole('button', { name: '在工具区打开', exact: true }).click();
      }
      await expect(center()).toBeVisible({ timeout: 15000 });
      const conversation = page.getByRole('button', { name: /^(打开对话|问题与引用)$/ });
      if (await conversation.getAttribute('aria-expanded') === 'true') await conversation.click();
      const materials = page.getByRole('button', { name: '目标与材料', exact: true });
      if (await materials.getAttribute('aria-expanded') === 'true') await materials.click();
      await expect(centeredInput()).toHaveValue(expectedExplanation(), { timeout: 15000 });
      await expect(center().locator('.teaching-artifact-results').getByText('F：0000　Cout：1', { exact: false })).toBeVisible();
    }
    await restoreCenter();
    await centeredInput().fill(narrowExplanation);
    report.explanationSha256 = hash(narrowExplanation);
    await expect.poll(async () => { const work = await api('workspaces/' + activityId); const state = work.files.find(file => file.name === 'components/artifact-' + artifact.artifactId + '.json'); return state && hash(JSON.parse(state.value).content.explanation); }).toBe(report.explanationSha256);
    await persist();
    await centeredInput().click(); await page.keyboard.press('Tab');
    const run = centeredFrame().getByRole('button', { name: /运行单次实验/ });
    await expect(run).toBeFocused();
    const focus = await run.evaluate(element => ({ visible: element.matches(':focus-visible'), outlineStyle: getComputedStyle(element).outlineStyle, outlineWidth: getComputedStyle(element).outlineWidth, boxShadow: getComputedStyle(element).boxShadow }));
    check(focus.visible && (focus.outlineStyle !== 'none' && parseFloat(focus.outlineWidth) > 0 || focus.boxShadow !== 'none'), 'tab-focus-indicator-not-visible');
    await screenshot('real-alu-narrow-tab.png');
    await page.keyboard.press('Shift+Tab'); await expect(centeredInput()).toBeFocused();
    await page.goBack(); await expect(page.locator('#activity-title')).toHaveCount(0, { timeout: 15000 });
    await page.goForward(); await restoreCenter();
    await page.getByRole('button', { name: '返回活动列表', exact: true }).click();
    await expect(page.locator('#activity-title')).toHaveCount(0, { timeout: 15000 });
    await page.goBack(); await restoreCenter();
    await centeredInput().scrollIntoViewIfNeeded(); await screenshot('real-alu-narrow-restored.png');
    check(digest(await history()) === digest(before) && digest(await api(`executions/${activityId}/${requestId}`)) === digest(query)
      && digest(await api(`executions/${activityId}/${requestId}/artifact`)) === digest(retained), 'narrow-navigation-reexecuted-or-replaced-original-result');
    await originalSource();
    report.ui = { viewport: { width: 1024, height: 800 }, mode: 'original-artifact-in-center', inputSha256: report.explanationSha256,
      tabToOriginalRunButton: true, shiftTabReturnsToExplanation: true, focus, browserBackForward: 'activity-list-activity',
      appLeaveAndBack: 'activity-list-activity', originalRequestId: requestId, newExecutionRequests: 0, newModelRuns: 0 };
  });
  const finalIds = (await history()).entries.map(entry => entry.query.requestId).sort();
  const initialIds = initial.entries.map(entry => entry.query.requestId).sort();
  report.invocationExecutions = { before: initialIds, after: finalIds, newRequestIds: finalIds.filter(id => !initialIds.includes(id)) };
  if (args['read-only']) check(digest(initialIds) === digest(finalIds), 'read-only-created-or-removed-an-execution');
  check(report.providerAttempts === 0, 'unexpected-provider-attempt');
  report.status = 'passed'; report.generationBudget.new = 0; report.generationBudget.total = report.generationBudget.prior;
} catch (error) {
  report.status = 'failed'; report.reason = safe(error); report.failedStage = phase;
  if (page && !page.isClosed()) {
    await screenshot('real-alu-failure.png').catch(() => {});
    const statuses = await Promise.all(page.frames().slice(1).map(frame => frame.locator('[role="status"], [role="alert"], [data-xunjie-error]').allTextContents().catch(() => [])));
    report.frameStatusSha256 = digest(statuses);
    report.frameStatusClasses = [...new Set(statuses.flat().flatMap(text => ['forbidden', 'invalid-input', 'outcome-unknown', 'capability-unavailable', 'resource-unavailable'].filter(code => text.includes(code))))];
    report.failedAssertion = String(error?.message ?? '').match(/(?:expect|locator|page)\([^\n]*?\)\.[A-Za-z]+|page\.[A-Za-z]+/)?.[0]?.slice(0, 100) ?? 'operation';
  }
} finally {
  await Promise.allSettled([...facts]); await browser?.close().catch(() => {});
  await host?.stop().catch(error => { report.cleanupFailure = safe(error); }); await runtime?.stop().catch(error => { report.cleanupFailure = safe(error); });
  globalThis.fetch = originalFetch;
  report.installationUnchanged = !installationSha256 || hash(await readFile(join(root, 'installation.json'))) === installationSha256;
  report.cleanup = report.cleanupFailure ? 'stop-failed-root-retained' : 'host-and-PG-stopped-root-retained'; report.finishedAt = new Date().toISOString();
  if (report.cleanupFailure || !report.installationUnchanged) report.status = 'failed';
  await persist();
}
console.log(JSON.stringify({ status: report.status, report: output, newGenerations: report.generationBudget.new, totalGenerations: report.generationBudget.total,
  ...(report.reason ? { reason: report.reason, stage: report.failedStage } : {}) }));
if (report.status !== 'passed') process.exitCode = 1;
