// Formal Chrome acceptance against an isolated, shipped product. The only controlled boundary is the upstream model.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';

const { values } = parseArgs({ options: { product: { type: 'string' }, out: { type: 'string' } } });
assert.ok(values.product && values.out, 'Requires --product DIR and --out DIR');
const candidate = resolve(values.product), output = resolve(values.out);
await mkdir(output, { recursive: true });
const distribution = await readFile(join(candidate, 'distribution.json'));
const bundle = await readFile(join(candidate, 'app/product-runtime.js'));
const { openProductRuntime } = await import(pathToFileURL(join(candidate, 'app/product-runtime.js')).href);
const resources = JSON.parse(await readFile(join(candidate, 'resources.json')));
for (const field of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper'])
  if (resources[field]) resources[field] = resolve(candidate, resources[field]);
const root = await mkdtemp(join(tmpdir(), 'xj-wp08-217-ui-'));
const runtime = openProductRuntime({ root, resources });
let browser, endpoint, ref, environmentId;
const payloads = [], report = { issue: 217, platform: process.platform, arch: process.arch, node: process.version,
  startedAt: new Date().toISOString(), headed: true, model: 'controlled external transport; production Gateway and owners',
  distributionSha256: createHash('sha256').update(distribution).digest('hex'),
  applicationSha256: createHash('sha256').update(bundle).digest('hex'), cases: [], status: 'running' };
const passed = (name, detail) => { report.cases.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); console.log('PASS ' + name); };
const upstream = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  payloads.push(JSON.parse(Buffer.concat(chunks)));
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const first = payloads.length === 1;
  const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'ui-fixed-skill-read', type: 'function',
    function: { name: 'skill_read', arguments: JSON.stringify({ ...ref, path: 'references/checklist.md' }) } }] }
    : { role: 'assistant', content: '固定检查表 UI-SKILL-217：先对照原预测，再检查输入和实际观察。' };
  for (const value of [{ id: 'skill-ui', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'skill-ui', choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }])
    response.write('data: ' + JSON.stringify(value) + '\n\n');
  response.end('data: [DONE]\n\n');
});
await new Promise(done => upstream.listen(0, '127.0.0.1', done));
try {
  environmentId = (await runtime.install({ profile: 'local' })).environment.environmentId;
  endpoint = (await runtime.start()).endpoint;
  const api = async (route, body) => {
    const response = await fetch(endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, 200, route + ': ' + JSON.stringify(value)); return value;
  };
  const connectionId = randomUUID(), grantId = randomUUID();
  await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Skill UI acceptance',
    protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions',
    modelId: 'fixture-skills-ui', dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144,
    maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-skills-ui-key' } });
  await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
  await api('models/selection', { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
  const packageDir = join(root, 'evidence-diagnosis'); await mkdir(join(packageDir, 'references'), { recursive: true });
  await mkdir(join(packageDir, 'scripts'));
  await writeFile(join(packageDir, 'SKILL.md'), '---\nname: evidence-diagnosis\ndescription: 按证据定位电路问题\n---\nUI 指导正文：先对照学生自己的预测，再按需要读取 references/checklist.md。不代写、不自动执行脚本。');
  await writeFile(join(packageDir, 'references/checklist.md'), 'UI-SKILL-217：先检查输入，再比较预期与实际。');
  await writeFile(join(packageDir, 'scripts/inspect.sh'), 'This script must remain inert.');
  browser = await chromium.launch({ channel: 'chrome', headless: false }); report.chrome = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(endpoint + '/?settings=models');
  const settings = page.locator('.personal-skills'); await expect(settings).toBeVisible();
  await settings.getByLabel('来源', { exact: true }).fill('student:ui-diagnosis');
  await settings.getByLabel('包版本', { exact: true }).fill('1.0.0');
  await settings.getByLabel('选择 Skill 包目录', { exact: true }).setInputFiles(packageDir);
  await settings.getByRole('button', { name: '导入 Skill', exact: true }).click();
  await expect(settings.locator('.skill-entry')).toHaveCount(1);
  const imported = (await api('skills')).skills[0]; ref = { skillId: imported.skillId, version: imported.version };
  assert.deepEqual(imported.attachments.map(file => file.path).sort(), ['SKILL.md', 'references/checklist.md', 'scripts/inspect.sh']);
  passed('Formal settings import preserves package paths and metadata');
  await settings.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, `${process.platform}-settings-after.png`) });
  await page.getByRole('button', { name: '返回学习空间', exact: true }).click();
  await page.getByLabel('学习目标', { exact: true }).fill('按证据定位 ALU 问题');
  const create = page.getByRole('button', { name: '建立学习活动', exact: true });
  if (await create.count()) await create.click(); else await page.getByRole('button', { name: '建立并开始对话', exact: true }).click();
  await expect(page.locator('#activity-title')).toHaveText('按证据定位 ALU 问题');
  const activityId = new URL(page.url()).searchParams.get('activity'); assert.ok(activityId);
  if (await page.getByRole('button', { name: '打开对话', exact: true }).count()) await page.getByRole('button', { name: '打开对话', exact: true }).click();
  const textarea = page.getByPlaceholder('写下想讨论的问题…');
  await textarea.fill('请帮我核对原观察与预测的差异。');
  await textarea.evaluate(input => { input.focus(); input.setSelectionRange(3, 7); });
  await page.locator('.wr-skills > summary').click();
  await page.locator('.wr-skills').getByRole('checkbox', { name: /evidence-diagnosis/ }).check();
  await expect(textarea).toBeFocused();
  const caret = await textarea.evaluate(input => [input.selectionStart, input.selectionEnd]); assert.deepEqual(caret, [3, 7]);
  passed('Explicit Skill selection retains draft focus and selected text');
  await page.screenshot({ path: join(output, `${process.platform}-draft-after.png`) });
  await page.getByRole('button', { name: '切换模型', exact: true }).click();
  await expect(page.getByRole('heading', { name: '个人设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回学习空间', exact: true }).click();
  await expect(textarea).toHaveValue('请帮我核对原观察与预测的差异。');
  await expect(textarea).toBeFocused();
  assert.deepEqual(await textarea.evaluate(input => [input.selectionStart, input.selectionEnd]), [3, 7]);
  await page.goBack(); await expect(page.getByRole('heading', { name: '个人设置', exact: true })).toBeVisible();
  await page.goForward(); await expect(textarea).toHaveValue('请帮我核对原观察与预测的差异。');
  passed('Settings and browser back-forward retain the original draft and caret');
  await textarea.focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '中文输入', selectionStart: 4, selectionEnd: 4 });
  await page.keyboard.press('Enter'); assert.equal(payloads.length, 0, 'IME Enter must not submit');
  await cdp.send('Input.insertText', { text: '中文输入' }); await cdp.detach();
  await expect(textarea).toHaveValue(/中文输入/);
  await expect.poll(async () => (await api(`drafts/${activityId}`)).question, { timeout: 15000 }).toMatch(/中文输入/);
  passed('Chrome composition Enter keeps Chinese input in the same draft', 'CDP IME composition path; no OS candidate-window claim');
  await page.reload();
  await expect(page.locator('#activity-title')).toHaveText('按证据定位 ALU 问题');
  if (await page.getByRole('button', { name: '打开对话', exact: true }).count()) await page.getByRole('button', { name: '打开对话', exact: true }).click();
  await expect(textarea).toHaveValue(/中文输入/);
  await textarea.fill('请按已选 Skill 读取检查表，并解释排查顺序。');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.locator('.teaching-message.assistant').filter({ hasText: 'UI-SKILL-217' })).toBeVisible({ timeout: 30000 });
  assert.equal(payloads.length, 2);
  assert.match(JSON.stringify(payloads[0]), /UI 指导正文/); assert.doesNotMatch(JSON.stringify(payloads[0]), /UI-SKILL-217/);
  assert.match(JSON.stringify(payloads[1]), /UI-SKILL-217/); assert.doesNotMatch(JSON.stringify(payloads), /This script must remain inert/);
  const events = await api(`agent/${activityId}/events`);
  const snapshots = await Promise.all(events.filter(event => event.kind === 'context-assembled').map(event => api(`agent/${activityId}/snapshots/${event.body.snapshotId}`)));
  assert.equal(snapshots.length, 2);
  const tool = page.locator('.teaching-tool-record').filter({ hasText: '读取 Skill 文件' });
  await tool.locator(':scope > summary').click();
  await tool.getByRole('button', { name: '查看固定 Skill 来源', exact: true }).click();
  await expect(tool).toContainText('UI-SKILL-217');
  passed('Formal draft sends the fixed Skill through the production model and tool loop');
  await page.screenshot({ path: join(output, `${process.platform}-skill-source.png`) });
  await page.getByRole('button', { name: '切换模型', exact: true }).click();
  await settings.getByRole('button', { name: '更新版本', exact: true }).click();
  await settings.getByLabel('包版本', { exact: true }).fill('2.0.0');
  await writeFile(join(packageDir, 'SKILL.md'), '---\nname: evidence-diagnosis\ndescription: 按证据定位电路问题\n---\n更新后正文 V2；不能改写过去回答。');
  await settings.getByLabel('选择 Skill 包目录', { exact: true }).setInputFiles(packageDir);
  await settings.getByRole('button', { name: '导入新版本', exact: true }).click();
  await expect(settings.locator('.skill-entry')).toContainText('2.0.0');
  await settings.getByRole('button', { name: '停用', exact: true }).click();
  await expect(settings.locator('.skill-entry')).toContainText('已停用');
  await page.getByRole('button', { name: '返回学习空间', exact: true }).click();
  await runtime.stop(); endpoint = (await runtime.start()).endpoint;
  for (const snapshot of snapshots) assert.deepEqual(await api(`agent/${activityId}/snapshots/${snapshot.snapshotId}`), snapshot);
  await page.reload(); await expect(page.locator('#activity-title')).toHaveText('按证据定位 ALU 问题');
  if (await page.getByRole('button', { name: '打开对话', exact: true }).count()) await page.getByRole('button', { name: '打开对话', exact: true }).click();
  await expect(page.locator('.teaching-message.assistant').filter({ hasText: 'UI-SKILL-217' })).toBeVisible();
  assert.equal(payloads.length, 2);
  passed('Settings update and disable plus a real process restart preserve the original source and answer');
  // Establish an old default and an unrelated candidate through the real pinned owner.
  // Only the subsequent setting change is the trigger: returning must not reload the page.
  const skillRoute = `agent/${activityId}/skills`;
  await api(skillRoute + '/disable', { requestId: randomUUID(), skillId: ref.skillId, disabled: false });
  const extra = await api(skillRoute + '/import', { requestId: randomUUID(), source: 'student:ui-catalog-refresh', packageVersion: '1.0.0',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: catalog-extra\ndescription: 目录刷新补充指导\n---\n只用于目录刷新核对。' }] });
  await api(skillRoute + '/select', { requestId: randomUUID(), range: { kind: 'all' }, skills: [ref] });
  await page.reload(); await expect(page.locator('#activity-title')).toHaveText('按证据定位 ALU 问题');
  if (await page.getByRole('button', { name: '打开对话', exact: true }).count()) await page.getByRole('button', { name: '打开对话', exact: true }).click();
  await textarea.fill('同窗口默认版本更新后，保留原问题及选区。');
  const draftSkills = page.locator('.wr-skills');
  if (!await draftSkills.evaluate(details => details.open)) await draftSkills.locator(':scope > summary').click();
  const resetSkills = draftSkills.getByRole('button', { name: '使用范围设置', exact: true });
  if (await resetSkills.count()) await resetSkills.click();
  await expect(draftSkills.getByRole('checkbox', { name: /evidence-diagnosis.*v1/ })).toBeChecked();
  await expect.poll(async () => (await api(`drafts/${activityId}`)).skills, { timeout: 15000 }).toBeUndefined();
  await textarea.evaluate(input => { input.focus(); input.setSelectionRange(3, 7); });
  await page.getByRole('button', { name: '切换模型', exact: true }).click();
  const version2 = settings.locator('.skill-entry').filter({ has: page.getByText('evidence-diagnosis', { exact: true }) }).filter({ hasText: '2.0.0' });
  await version2.getByRole('checkbox').check();
  await settings.getByRole('button', { name: '应用到所选范围', exact: true }).click();
  await expect(settings.getByRole('status').filter({ hasText: '范围选择已确认' })).toBeVisible();
  await page.getByRole('button', { name: '返回学习空间', exact: true }).click();
  const extraChoice = draftSkills.getByRole('checkbox', { name: /catalog-extra/ });
  await expect(extraChoice).toBeEnabled(); await extraChoice.check();
  const updatedRef = { skillId: ref.skillId, version: ref.version + 1 }, extraRef = { skillId: extra.skillId, version: extra.version };
  await expect.poll(async () => (await api(`drafts/${activityId}`)).skills, { timeout: 15000 }).toEqual([updatedRef, extraRef]);
  await expect(textarea).toHaveValue('同窗口默认版本更新后，保留原问题及选区。');
  await expect(textarea).toBeFocused();
  assert.deepEqual(await textarea.evaluate(input => [input.selectionStart, input.selectionEnd]), [3, 7]);
  assert.equal(payloads.length, 2, 'Changing defaults and draft choices must not start another model request');
  passed('Same-window settings refresh fixes the new default version when adding another Skill', { selected: [updatedRef, extraRef] });
  await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 1000, height: 900 });
  await page.screenshot({ path: join(output, `${process.platform}-dark-narrow.png`) });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  passed('Dark narrow desktop remains usable'); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error instanceof Error ? error.message : 'acceptance-failed'; process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); report.modelRequests = payloads.length;
  await browser?.close(); await runtime.stop();
  if (environmentId) await runtime.deleteEnvironment({ environmentId });
  upstream.closeAllConnections(); await new Promise(done => upstream.close(done));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await writeFile(join(output, 'chrome-skills.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
