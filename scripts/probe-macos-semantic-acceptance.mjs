import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication, resolveCredential } from '@xunjie/product-runtime';
import { controlledActionReceiver } from '../apps/server/tests/support/action-receiver.mjs';
import { annotationPackage } from '../components/material-annotation/package.mjs';
import { aggregationPackage } from '../components/table-aggregation/package.mjs';

/**
 * #185 Apple Silicon acceptance of #172 non-text references.
 *
 * Real desktop Chrome (headed), real PostgreSQL, real Worker/WASM aggregation. Only navigation,
 * clicking, focusing and reading the page go through Playwright; the system Chinese IME pass lives
 * in probe-macos-semantic-ime.mjs and is recorded separately.
 *
 * Checklist coverage: 1) annotation object plus a real aggregation group enter one existing
 * question reference area without sending, running or calling a model; 2) dedup, multi-source
 * order, removal, blur, keyboard locate/focus, light/dark/narrow; 3) IndexedDB, business API and
 * PostgreSQL persistence across reload and owner restart, fixed send, later edits and late replies;
 * 4) modified, deleted and same-name rebuilt sources keep the original copy and refuse a guessed
 * replacement; 6) forged subject/activity/object/range/copy/new id/unknown adapter and old
 * connections are refused or clearly unavailable without losing the draft; 7) the original text
 * interval still works beside the semantic one. Item 5 is covered by
 * probe-semantic-reference-history.mjs, item 8 by probe-macos-semantic-ime.mjs.
 */
const profile = process.env.XUNJIE_SEMANTIC_PROFILE === 'school' ? 'school' : 'local';
const output = resolve(`.verification/wp03-185-${profile}`);
await mkdir(output, { recursive: true });
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Native PostgreSQL required (set XUNJIE_PRODUCT_POSTGRES_BIN).');
const postgresVersion = /(\d+\.\d+)/.exec(execFileSync(join(postgresBin, 'postgres'), ['--version'], { encoding: 'utf8' }))[1];
const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const root = await mkdtemp(join(tmpdir(), 'xj185-'));
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion,
  webRoot: resolve('apps/web/dist-runtime'), windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') };
const runtime = openProductRuntime({ root, resources }), receiver = controlledActionReceiver('semantic-reference-test-receiver');
const report = { kind: 'macos-semantic-reference-acceptance', ticket: '#185', parent: '#172',
  date: new Date().toISOString().slice(0, 10), codeSha, profile, platform: process.platform, arch: process.arch,
  os: release(), node: process.version, postgres: postgresVersion, browser: 'installed Google Chrome (headed)',
  headless: false, teaching: 'not evaluated', receiver: 'controlled receiver; no model invocation',
  status: 'running', checklist: {}, cases: [], screenshots: {}, unexecuted: [] };
let host, browser, page;
const pass = (item, name, detail) => {
  report.cases.push({ item, name, detail });
  (report.checklist[item] ??= []).push(name);
  console.log(`PASS [${item}] ${name}`);
};
const shot = async (name, options = {}) => {
  const file = join(output, `${name}.png`);
  await page.screenshot({ path: file, ...options });
  report.screenshots[name] = file.slice(process.cwd().length + 1);
  return file;
};
try {
  await runtime.install({ profile });
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context, { receivers: [receiver] }) });
  let endpoint = host.endpoint;
  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const api = async (route, body, headers = admin) => {
    const response = await fetch(endpoint + '/api/learning/' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, route + ' ' + (response.status === 200 ? '' : await response.text()));
    return response.json();
  };
  const annotation = await api('manage/component-import', { requestId: randomUUID(), ...await annotationPackage() });
  const aggregation = await api('manage/component-import', { requestId: randomUUID(), ...await aggregationPackage() });
  const materialId = randomUUID(), text = '观察与解释：先记录事实，再核对证据。', bytes = Buffer.from(text);
  const courseId = randomUUID(), releaseId = randomUUID();
  await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '语义引用验收' },
    task: { taskId: randomUUID(), title: '标注和聚合结果引用', summary: '' },
    release: { releaseId, objectives: ['固定真实选中内容'], requirements: '分别选择标注与聚合结果进行讨论。', starterWorks: [], capabilities: [],
      components: [{ key: 'annotation', definition: annotation, configuration: { title: '材料标注' }, materialIds: [materialId] },
        { key: 'table', definition: aggregation, configuration: { title: '表格聚合' }, materialIds: [] }],
      materials: [{ materialId, title: '阅读材料', path: 'material.txt', mediaType: 'text/plain', access: 'student',
        byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] },
    resources: [{ path: 'material.txt', contentBase64: bytes.toString('base64') }] });
  const password = randomUUID(), loginName = 'semantic-reference-student';
  const member = await api('manage/members', { requestId: randomUUID(), loginName, password });
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true });
  const listener = new URL(endpoint);
  report.deployment = { profile, host: listener.hostname, port: listener.port, database: 'managed PostgreSQL',
    clientAndOwner: 'same Mac, loopback listener', crossMachine: false };
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  assert.equal((await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
  const activity = await (await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } })).json();
  const draft = async () => (await context.request.get(endpoint + '/api/learning/drafts/' + activity.activityId)).json();
  const intents = async () => (await context.request.get(endpoint + '/api/learning/intents/' + activity.activityId)).json();
  const records = () => page.locator('ol.execution-records > li').count();
  page = await context.newPage();
  page.on('pageerror', error => console.log('PAGE ERROR ' + error.message));
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  const refs = page.getByRole('region', { name: '上下文引用' });
  const question = page.getByRole('textbox', { name: '你的问题', exact: true });
  const dialog = async () => {
    if (await page.getByRole('region', { name: '上下文引用' }).count()) return;
    const button = page.getByRole('button', { name: '打开对话', exact: true });
    await expect(button).toBeVisible({ timeout: 20000 });
    await button.click();
    await expect(page.getByRole('region', { name: '上下文引用' })).toBeVisible();
  };
  const selectMaterial = () => frame.locator('#materials p').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  const selectOriginalText = () => page.locator('article.learning-material-text .wr-text-source').first()
    .evaluate(element => { const range = document.createRange(); range.setStart(element.firstChild, 0); range.setEnd(element.firstChild, 4);
      getSelection().removeAllRanges(); getSelection().addRange(range); });

  /* 1. Annotation object into the existing question reference area, without sending or running. */
  await page.getByRole('tab', { name: '材料标注', exact: true }).click();
  const frame = page.frameLocator('iframe[title="材料标注"]');
  await expect(frame.getByRole('button', { name: '标注选中文字', exact: true })).toBeEnabled();
  await selectMaterial();
  await frame.getByRole('button', { name: '标注选中文字', exact: true }).click();
  await frame.getByRole('textbox', { name: '标注内容', exact: true }).fill('这是选中时的疑问');
  await frame.getByRole('button', { name: '选择此标注', exact: true }).click();
  await page.getByRole('button', { name: '询问 Agent', exact: true }).last().click();
  await expect(refs.locator('li')).toHaveCount(1);
  assert.deepEqual(await intents(), []);
  assert.equal(receiver.acceptedIds().length, 0);
  assert.equal(await records(), 0);
  assert.equal((await draft()).question, '');
  pass('1', 'annotation object lands in the existing question reference area', 'one reference, no intent, no execution, empty question');
  await question.fill('为什么这段证据与我的解释不同？');
  await expect.poll(async () => (await draft()).references.length).toBe(1);
  const annotationReference = (await draft()).references[0];
  assert.equal(annotationReference.source.kind, 'component');
  assert.equal(annotationReference.range.typeId, 'annotation-objects');
  assert.match(annotationReference.copy, /选中时的疑问/);

  /* 7. The original text path still produces a half-open interval in the same draft. */
  await page.getByRole('button', { name: '收起对话', exact: true }).click();
  await expect(page.locator('article.learning-material-text .wr-text-source').first()).toHaveText(text);
  await selectOriginalText();
  await page.getByRole('button', { name: '询问 Agent', exact: true }).last().click();
  await expect(refs.locator('li')).toHaveCount(2);
  await expect.poll(async () => (await draft()).references.length).toBe(2);
  let saved = await draft();
  const textReference = saved.references[1];
  assert.equal(textReference.range.kind, 'text');
  assert.equal(textReference.range.start, 0);
  assert.equal(textReference.range.end, 4);
  assert.equal(textReference.copy, text.slice(0, 4));
  pass('7', 'the original text reference keeps its half-open interval beside the semantic one',
    `range ${textReference.range.start}-${textReference.range.end} of "${textReference.copy}"`);

  /* 1 (continued) + 2. Real Worker/WASM group output, keyboard selection, order and dedup. */
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  const table = page.frameLocator('iframe[title="表格聚合"]');
  await expect(table.getByRole('button', { name: '运行计算', exact: true })).toBeEnabled();
  await table.getByRole('button', { name: '运行计算', exact: true }).click();
  const panel = page.getByRole('region', { name: '计算记录' });
  await expect(panel.getByText('已完成', { exact: false }).first()).toBeVisible({ timeout: 60000 });
  assert.equal(await records(), 1);
  await panel.locator('summary').click();
  await panel.locator('[data-group-key="A"]').focus();
  await page.keyboard.press('Enter');
  await expect(refs.locator('li')).toHaveCount(3);
  await expect.poll(async () => (await draft()).references.length).toBe(3);
  saved = await draft();
  const groupA = saved.references[2];
  assert.equal(groupA.source.origin, 'execution-result');
  assert.deepEqual(groupA.range.target.groupKeys, ['A']);
  assert.match(groupA.copy, /分组：A/);
  assert.equal(await records(), 1);
  assert.deepEqual(await intents(), []);
  assert.equal(receiver.acceptedIds().length, 0);
  pass('1', 'a real Worker/WASM aggregation group joins the same reference area without running anything',
    'keyboard focus + Enter, one execution only, no intent');
  pass('2', 'multi-source order follows selection order', JSON.stringify(saved.references.map(item => item.range.typeId ?? item.range.kind)));
  await shot('references-light', { fullPage: true });

  await page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(frame.getByRole('button', { name: '选择此标注', exact: true })).toBeEnabled();
  await frame.getByRole('button', { name: '选择此标注', exact: true }).click();
  await expect(refs.locator('li')).toHaveCount(3);
  pass('2', 'repeated semantic selection is deduplicated', 'annotation re-selected, still three');

  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  await expect(panel.getByText('已完成', { exact: false }).first()).toBeVisible({ timeout: 30000 });
  await refs.getByRole('button', { name: /定位引用 3/ }).focus();
  await page.keyboard.press('Enter');
  await expect(panel.locator('[data-group-key="A"]')).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: '已定位引用来源。' })).toBeVisible();
  pass('2', 'keyboard locate focuses the exact fixed group', 'focus moved to [data-group-key="A"]');

  await refs.getByRole('button', { name: '移除引用 2', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(refs.locator('li')).toHaveCount(2);
  await expect.poll(async () => (await draft()).references.length).toBe(2);
  saved = await draft();
  assert.deepEqual(saved.references.map(item => item.range.typeId ?? item.range.kind), ['annotation-objects', 'aggregation-groups']);
  pass('2', 'keyboard removal keeps the remaining order', 'text reference removed, annotation then group remain');

  await page.getByRole('button', { name: '收起对话', exact: true }).click();
  await selectOriginalText();
  await page.getByRole('button', { name: '询问 Agent', exact: true }).last().click();
  await expect(refs.locator('li')).toHaveCount(3);
  await expect.poll(async () => (await draft()).references.length).toBe(3);
  saved = await draft();
  assert.equal(saved.references[2].range.kind, 'text');
  pass('2', 'a removed reference returns at the end when selected again', 'append order preserved');

  await question.focus();
  await question.evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
  await page.keyboard.type('；补充一句');
  await page.locator('#activity-title').click();
  await expect(refs.locator('li')).toHaveCount(3);
  await expect.poll(async () => (await draft()).question).toBe('为什么这段证据与我的解释不同？；补充一句');
  assert.equal((await draft()).references.length, 3);
  pass('2', 'blur keeps the reference area and the question', 'focus left the composer, three references and the text remain');
  await page.locator('html').evaluate(element => { element.dataset.theme = 'dark' });
  await shot('references-dark', { fullPage: true });
  await page.locator('html').evaluate(element => { element.dataset.theme = 'light' });
  await page.setViewportSize({ width: 1000, height: 800 });
  await shot('references-narrow', { fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  pass('2', 'light, dark and narrow desktop are captured', 'three screenshots at the same three-reference state');

  /* 3. IndexedDB, business API and PostgreSQL agree; reload and owner restart keep them. */
  const indexed = await page.evaluate(async () => {
    const db = await new Promise((done, fail) => {
      const request = indexedDB.open('xunjie-reliable-works-v1');
      request.onsuccess = () => done(request.result); request.onerror = () => fail(request.error);
    });
    const rows = await new Promise((done, fail) => {
      const tx = db.transaction('drafts', 'readonly'), all = tx.objectStore('drafts').getAll();
      all.onsuccess = () => done(all.result); all.onerror = () => fail(all.error);
    });
    db.close();
    return rows.map(row => ({ key: row.key, revision: row.localRevision, draftId: row.draftId, question: row.question ?? '',
      references: (row.references ?? []).map(item => ({ kind: item.range.kind, copy: item.copy, source: item.source?.kind ?? null })) }));
  });
  const localDraft = indexed.find(row => row.references.length === 3);
  assert.ok(localDraft, 'IndexedDB holds the three references: ' + JSON.stringify(indexed).slice(0, 1200));
  assert.equal(localDraft.question, '为什么这段证据与我的解释不同？；补充一句');
  assert.deepEqual(localDraft.references.map(item => item.source), ['component', 'component', 'course-material']);
  report.indexedDb = { database: 'xunjie-reliable-works-v1', drafts: indexed.length, localRevision: localDraft.revision, references: localDraft.references.length };
  pass('3', 'IndexedDB carries the same three references before any server read', `local revision ${localDraft.revision}`);

  await page.reload();
  await dialog();
  await expect(refs.locator('li')).toHaveCount(3);
  await expect(refs).toContainText('选中时的疑问');
  await expect(question).toHaveValue('为什么这段证据与我的解释不同？；补充一句');
  pass('3', 'reload restores question and references from the business API', 'three copies readable');

  const fixed = JSON.stringify((await draft()).references.map(({ copyDigest, ...reference }) => reference));
  const releaseAcceptance = receiver.holdAccept();
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.getByText('已保留这次问题，可继续编辑；接收情况见下方记录。', { exact: true })).toBeVisible();
  await question.fill('发送之后的新问题');
  await refs.getByRole('button', { name: '移除引用 2', exact: true }).click();
  await expect.poll(async () => (await draft()).references.length).toBe(2);
  releaseAcceptance();
  await expect.poll(() => receiver.acceptedIds().length, { timeout: 30000 }).toBe(1);
  const acceptedId = receiver.acceptedIds()[0];
  const acceptedInput = receiver.acceptedInput(acceptedId);
  assert.equal(JSON.stringify(acceptedInput.draft.references), fixed);
  assert.equal(acceptedInput.draft.question, '为什么这段证据与我的解释不同？；补充一句');
  await expect.poll(async () => (await draft()).question).toBe('发送之后的新问题');
  assert.equal((await draft()).references.length, 2);
  pass('3', 'an explicit send fixes the three references while later edits stay independent', 'receiver got the original three');

  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  await page.getByRole('button', { name: '用当前表格重新运行', exact: true }).click();
  await expect.poll(() => records(), { timeout: 60000 }).toBe(2);
  const stored = (await intents()).find(item => item.input.requestId === acceptedId);
  assert.ok(stored, 'the accepted action is still readable');
  assert.equal(stored.input.draft.references.length, 3);
  assert.equal(stored.input.draft.references[0].copy, annotationReference.copy);
  pass('3', 'a later result change does not rewrite the fixed action', 'second execution, action references unchanged');

  await page.reload();
  await dialog();
  await expect(question).toHaveValue('发送之后的新问题');
  await expect(refs.locator('li')).toHaveCount(2);
  pass('3', 'a late reply and the second execution never overwrite the later draft', 'reload keeps the later text and two references');

  /* 4. Modified, deleted and same-name rebuilt sources keep the original copy. */
  await page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(frame.getByRole('button', { name: '选择此标注', exact: true })).toBeEnabled();
  await frame.getByRole('textbox', { name: '标注内容', exact: true }).fill('后来的标注修改不能覆盖旧引用');
  await refs.getByRole('button', { name: /定位引用 1/ }).click();
  await expect(page.getByText('来源已变化，选中时的副本仍保留。', { exact: true })).toBeVisible();
  assert.equal((await draft()).references[0].copy, annotationReference.copy);
  pass('4', 'a modified source keeps the copy and refuses relocation', 'copy unchanged');

  await frame.getByRole('button', { name: '移除此标注', exact: true }).click();
  await refs.getByRole('button', { name: /定位引用 1/ }).click();
  await expect(page.getByText('来源已变化，选中时的副本仍保留。', { exact: true })).toBeVisible();
  assert.equal((await draft()).references[0].copy, annotationReference.copy);
  pass('4', 'a deleted source keeps the copy and refuses relocation', 'copy unchanged, no guessed replacement');

  await selectMaterial();
  await frame.getByRole('button', { name: '标注选中文字', exact: true }).click();
  await frame.getByRole('textbox', { name: '标注内容', exact: true }).fill('这是选中时的疑问');
  await refs.getByRole('button', { name: /定位引用 1/ }).click();
  await expect(page.getByText('来源已变化，选中时的副本仍保留。', { exact: true })).toBeVisible();
  assert.equal((await draft()).references[0].copy, annotationReference.copy);
  pass('4', 'a same-name rebuilt source is not treated as the original object', 'still the original copy');

  /* 6. Forged sources are refused without losing the draft. */
  const current = await draft();
  const post = body => context.request.post(endpoint + '/api/learning/drafts/' + activity.activityId, { data: body });
  const attempt = async (name, mutate) => {
    const base = structuredClone(current);
    delete base.revision; delete base.revisionId;
    base.requestId = randomUUID(); base.baseRevision = current.revision; base.bases = [];
    base.references = base.references.map(({ copyDigest, ...reference }) => reference);
    mutate(base.references[0], base);
    const response = await post(base);
    assert.notEqual(response.status, 200, name);
    const after = await draft();
    assert.equal(after.question, current.question, name + ' keeps the question');
    assert.equal(after.references.length, current.references.length, name + ' keeps the references');
  };
  await attempt('principal', reference => { reference.source.principalId = randomUUID() });
  await attempt('activity', reference => { reference.source.activityId = randomUUID() });
  await attempt('object', reference => { reference.source.objectId = randomUUID() });
  await attempt('range', reference => { reference.range.target.objectIds = [randomUUID()] });
  await attempt('copy', reference => { reference.copy = '伪'.repeat(reference.copy.length) });
  await attempt('new-reference-id', reference => { reference.referenceId = randomUUID() });
  await attempt('unknown-adapter', reference => { reference.referenceId = randomUUID(); reference.range.typeId = 'unknown-adapter' });
  pass('6', 'forged subject, activity, object, range, copy and identity are refused without losing the draft',
    'seven negative cases, draft intact');

  /* 4 + 6. Disabled component still shows the fixed copy; a restarted owner retires the old connection. */
  await api('manage/component-status', { requestId: randomUUID(), componentId: annotation.manifest.componentId,
    version: annotation.manifest.version, enabled: false });
  await page.reload();
  await dialog();
  await expect(refs.locator('li')).toHaveCount(2);
  await expect(refs).toContainText('选中时的疑问');
  await page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(page.locator('iframe[title="材料标注"]')).toHaveCount(0);
  pass('4', 'fixed copies render with the executable component disabled', 'no annotation iframe, copies still displayed');
  await shot('references-component-disabled', { fullPage: true });
  await api('manage/component-status', { requestId: randomUUID(), componentId: annotation.manifest.componentId,
    version: annotation.manifest.version, enabled: true });

  await host.stop(); host = undefined;
  const restarted = await runtime.start();
  endpoint = restarted.endpoint ?? endpoint;
  assert.ok(['ready', 'degraded'].includes(restarted.state));
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await dialog();
  await expect(refs.locator('li')).toHaveCount(2);
  await expect(refs).toContainText('选中时的疑问');
  await refs.getByRole('button', { name: /定位引用 1/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /不可用|已变化|无法定位/ })).toBeVisible();
  pass('6', 'an old component connection is not reused after the owner restarts',
    'copies readable, locate reports unavailable instead of guessing');
  pass('3', 'PostgreSQL keeps the draft across a real owner restart', 'two references and the later question readable');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  if (page) {
    report.failureView = await page.locator('body').innerText().catch(() => null);
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await host?.stop().catch(() => {});
  await runtime.stop().catch(() => {});
  report.cleanup = 'owned runtime stopped';
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
