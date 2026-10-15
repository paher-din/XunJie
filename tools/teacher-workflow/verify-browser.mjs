import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'https://127.0.0.1:3444';
const teacherId = 'synthetic-robert-teacher';
const args = process.argv.slice(2);
const allowed = new Set(['--run', '--output', '--resume', '--course', '--help']);
const parsed = {};
for (let index = 0; index < args.length; index++) {
  const key = args[index];
  if (!allowed.has(key) || parsed[key] !== undefined) throw new Error('Use --run, --output ABSOLUTE_D_DIRECTORY, and optional --resume CHECKPOINT_JSON.');
  if (key === '--output' || key === '--resume' || key === '--course') {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('A path argument is missing.');
    parsed[key] = value;
  } else parsed[key] = true;
}
const courseKind = parsed['--course'] ?? 'c';
if (!['c', 'hdl'].includes(courseKind)) throw new Error('--course must be c or hdl.');
const courseId = `synthetic-robert-course-${courseKind}`;
const studentId = `synthetic-robert-student-${courseKind === 'c' ? 'a' : 'b'}`;
const sourceFile = courseKind === 'c' ? 'main.c' : 'main.v';
const plan = {
  mode: parsed['--run'] ? 'run' : 'plan', origin, strictTLS: true,
  accounts: [teacherId, studentId], courseId,
  steps: ['For a new draft only: import a synthetic private_answer through Materials, assert student/tutor disabled and false, allow teacher design, then attach its fixed version.',
    `Teacher UI: edit confirmed ${courseKind} preset, save, run design checks, inspect student/tutor/teacher projections including private-material redaction, release and assign the matching synthetic student.`,
    `Student UI: explicitly create Attempt, create ${sourceFile}, edit, confirm save, freeze and explicitly submit.`,
    'Teacher UI: inspect fixed source, save formal feedback with selected snapshot evidence, revise the same feedback thread, grant permission.',
    'Student UI: read real feedback, explicitly consume permission, edit, confirm and freeze a new version, submit again.',
    'Read-only GETs: verify original snapshot hash and first submission remain, second submission targets new snapshot, feedback history persists.',
    'Teacher review UI: explicitly copy the source into an independent follow-up draft, verify exact source ancestry and unchanged fixed activity.',
    'Chrome screenshots and overflow reads at widths 1440, 720 and 390 for design, review list/detail and student submission panel.'],
  boundaries: ['All business writes use visible UI controls and keyboard events.', 'No model calls, runs, migrations, browser tracing, cookie export or credentials in output.',
    'Only owned local synthetic accounts; --resume reuses exact public IDs/title and never silently replaces an unknown command.'],
};
if (!parsed['--run'] || parsed['--help']) { process.stdout.write(JSON.stringify(plan, null, 2) + '\n'); process.exit(0); }
if (process.platform !== 'win32') throw new Error('This runner requires local Windows Node and installed Chrome.');
if (!parsed['--output'] || !isAbsolute(parsed['--output']) || !/^D:\\/i.test(parsed['--output'])) throw new Error('--output must be an absolute D: directory.');
const output = resolve(parsed['--output']);
mkdirSync(output, { recursive: true });
const checkpointFile = resolve(output, 'checkpoint.json');
const publicFile = resolve(output, 'public-result.json');
let checkpoint = parsed['--resume'] ? JSON.parse(readFileSync(resolve(parsed['--resume']), 'utf8')) : {
  version: 1, origin, courseId, teacherId, studentId, title: `教师真实流程验证 ${courseKind} ${new Date().toISOString().replace(/[:.]/g, '-')}`,
  startedAtUtc: new Date().toISOString(), stage: 'new',
};
if (checkpoint.version !== 1 || checkpoint.origin !== origin || checkpoint.courseId !== courseId || checkpoint.teacherId !== teacherId ||
  checkpoint.studentId !== studentId || typeof checkpoint.title !== 'string' || !checkpoint.title.startsWith('教师真实流程验证 ')) throw new Error('Checkpoint is outside the exact owned synthetic scope.');
const secrets = [];
const redact = value => secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, String(value))
  .replace(/(x-csrf-token|password|set-cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
const result = { ...plan, mode: 'run', startedAtUtc: new Date().toISOString(), status: 'running',
  title: checkpoint.title, checks: [], layouts: [], screenshots: [], network: [], pageErrors: [], failures: [], notExecuted: [] };
const persist = () => {
  writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2) + '\n');
  writeFileSync(publicFile, JSON.stringify(result, null, 2) + '\n');
};
const check = (name, condition, details = undefined) => {
  if (!condition) throw new Error(`CHECK_FAILED:${name}`);
  result.checks.push({ name, passed: true, ...(details ? { details } : {}) });
  persist();
};
const resolvedAt = { 'draft-saved': 'save-blueprint', 'activity-released': 'release-activity', assigned: 'assign-activity',
  'attempt-created': 'create-attempt', 'first-save-confirmed': 'save-revision-one', 'second-save-confirmed': 'save-revision-two',
  'first-snapshot-fixed': 'freeze-revision-one', 'second-snapshot-fixed': 'freeze-revision-two', 'first-submitted': 'first-submission',
  'second-submitted': 'second-submission', 'feedback-saved': 'save-feedback', 'feedback-revised': 'revise-feedback',
  'permission-granted': 'grant-revision', 'student-revision-active': 'resume-revision',
  'private-resource-imported': 'import-private-resource', 'followup-copied': 'copy-followup' };
function complete(stage, fields = {}) {
  const pending = checkpoint.pending && resolvedAt[stage] !== checkpoint.pending ? checkpoint.pending : null;
  checkpoint = { ...checkpoint, ...fields, stage, pending }; persist();
}
function intent(name) {
  if (checkpoint.pending && checkpoint.pending !== name) throw new Error('CHECKPOINT_HAS_UNRESOLVED_ORIGINAL_UI_ACTION');
  checkpoint.pending = name; persist();
}
function unresolved(name, found) {
  if (checkpoint.pending === name && !found) throw new Error(`UNKNOWN_ORIGINAL_${name.toUpperCase().replaceAll('-', '_')}_READ_BEFORE_RETRY`);
}
let browser;
let currentStage = 'load-synthetic-credentials';
try {
  // Read credentials only into this process. No credential is printed, put in arguments, written or traced.
  const manifestBytes = execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--exec', 'cat', '/opt/xunjie-ui-local/initializer.json'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const manifest = JSON.parse(manifestBytes);
  if (manifest.synthetic !== true || !Array.isArray(manifest.accounts)) throw new Error('OWNED_SYNTHETIC_INITIALIZER_REQUIRED');
  const teacher = manifest.accounts.find(account => account.id === teacherId && account.loginName === teacherId);
  const student = manifest.accounts.find(account => account.id === studentId && account.loginName === studentId);
  if (!teacher?.password || !student?.password) throw new Error('EXACT_SYNTHETIC_ACCOUNTS_UNAVAILABLE');
  secrets.push(teacher.password, student.password);
  const { chromium, expect } = createRequire(resolve(root, 'apps/student/package.json'))('@playwright/test');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const contexts = await Promise.all([browser.newContext({ ignoreHTTPSErrors: false, viewport: { width: 1440, height: 1000 } }),
    browser.newContext({ ignoreHTTPSErrors: false, viewport: { width: 1440, height: 1000 } })]);
  const [teacherPage, studentPage] = await Promise.all(contexts.map(context => context.newPage()));
  for (const [index, page] of [teacherPage, studentPage].entries()) {
    page.setDefaultTimeout(20_000);
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.startsWith('/api/')) result.network.push({ actor: index === 0 ? 'teacher' : 'student', method: response.request().method(), path: url.pathname, status: response.status() });
    });
    page.on('pageerror', error => result.pageErrors.push({ actor: index === 0 ? 'teacher' : 'student', message: redact(error.message).slice(0, 1000) }));
  }
  async function login(page, account, route) {
    await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('账号', { exact: true })).toBeVisible();
    await page.getByLabel('账号', { exact: true }).fill(account.loginName);
    await page.getByLabel('密码', { exact: true }).fill(account.password);
    await uiWrite(page, '/api/sessions', account.id, () => page.getByRole('button', { name: '登录', exact: true }).click(), true);
    await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
    const entryScripts = await page.locator('script[type="module"][src]').evaluateAll(elements => elements.map(element => new URL(element.src))
      .filter(url => url.origin === location.origin).map(url => url.pathname));
    result.entryJS ??= [];
    result.entryJS.push({ actor: account.id, paths: entryScripts }); persist();
  }
  async function uiWrite(page, path, actorId, click, login = false) {
    const waiting = page.waitForResponse(response => new URL(response.url()).origin === origin && new URL(response.url()).pathname === path && ['POST', 'PATCH'].includes(response.request().method()));
    await click();
    const response = await waiting;
    const payload = await response.json();
    if (!response.ok() || typeof payload?.requestId !== 'string' || !payload.data || typeof payload.data !== 'object') {
      throw new Error(`UI_WRITE_REJECTED:${path}:${response.status()}:${payload?.error?.code ?? 'INVALID_ENVELOPE'}`);
    }
    if (login) return payload.data;
    const receipt = payload.data;
    if (!receipt.identity || receipt.identity.actorId !== actorId || !receipt.identity.idempotencyKey ||
      typeof receipt.identity.recoveryGeneration !== 'string' || !receipt.commandId || !receipt.receiptId ||
      !Number.isSafeInteger(receipt.serverSeq) || !/^[a-f0-9]{64}$/.test(receipt.requestHash) || !receipt.result || typeof receipt.result !== 'object') {
      throw new Error(`UI_WRITE_RECEIPT_MISMATCH:${path}`);
    }
    result.checks.push({ name: `ui-write-confirmed:${path}`, passed: true, status: response.status(), actor: actorId }); persist();
    if (path.endsWith('/sync') && ['save-revision-one', 'save-revision-two'].includes(checkpoint.pending)) {
      const sourceKey = checkpoint.pending === 'save-revision-one' ? 'firstSource' : 'secondSource';
      const source = checkpoint[sourceKey];
      const file = receipt.result.files?.find(file => file.path === sourceFile);
      if (!source || !file || file.contentHash !== source.contentHash) throw new Error('SYNC_RECEIPT_MUST_MATCH_CAPTURED_UI_ORIGINAL');
      checkpoint[sourceKey] = { ...source, receipt: { receiptId: receipt.receiptId, commandId: receipt.commandId,
        requestHash: receipt.requestHash, actorId, attemptId: checkpoint.attemptId, recoveryGeneration: receipt.identity.recoveryGeneration,
        workspaceRevision: receipt.result.workspaceRevision, fileId: file.fileId, documentVersion: file.documentVersion, contentHash: file.contentHash } };
      persist();
    }
    return receipt.result;
  }
  async function get(page, path) {
    if (!path.startsWith('/api/') || path.includes('://')) throw new Error('ONLY_SAME_ORIGIN_APPROVED_GETS');
    const envelope = await page.evaluate(async path => {
      const response = await fetch(path, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      return { status: response.status, body: await response.json() };
    }, path);
    if (envelope.status !== 200 || typeof envelope.body?.requestId !== 'string' || !('data' in envelope.body)) throw new Error(`READ_FAILED:${path}:${envelope.status}`);
    return envelope.body.data;
  }
  const workbench = () => get(teacherPage, `/api/courses/${courseId}/teacher-workbench`);
  const head = () => get(teacherPage, `/api/attempts/${checkpoint.attemptId}`);
  const review = () => get(teacherPage, `/api/attempts/${checkpoint.attemptId}/review-context`);
  async function until(read, predicate, name, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await read();
      if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(`WAIT_FAILED:${name}`);
  }
  const findDraft = w => w.drafts.find(draft => draft.blueprintId === checkpoint.blueprintId || draft.content.projectTitle === checkpoint.title);
  const findActivity = w => w.activities.find(activity => activity.activityVersionId === checkpoint.activityId || activity.sourceBlueprintId === checkpoint.blueprintId);
  const findAssignment = w => w.assignments.find(assignment => assignment.activityVersionId === checkpoint.activityId && assignment.studentId === studentId);
  async function screenshot(page, name) {
    if (await page.locator('input[type="password"]').count()) throw new Error('NEVER_CAPTURE_CREDENTIAL_ENTRY');
    await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
    result.screenshots.push({ file: `${name}.png`, viewport: page.viewportSize(), capturedAtUtc: new Date().toISOString() });
    persist();
  }

  currentStage = 'teacher-login-and-design';
  await login(teacherPage, teacher, `/#/teacher/design/new?course=${courseId}`);
  await expect(teacherPage.getByLabel('项目标题', { exact: true })).toBeVisible();
  let w = await workbench();
  check('teacher-workbench-owned-course', w.courseId === courseId && w.members.some(member => member.userId === studentId));
  let draft = findDraft(w);
  unresolved('save-blueprint', draft);
  const privateTitle = `${checkpoint.title} · 合成私有评价材料`;
  const privateBody = `SYNTHETIC_PRIVATE_SCOPE_${checkpoint.title}\nTeacher-only synthetic answer marker for UI isolation verification. This is not real course material or a learner answer.`;
  if (!draft) {
    currentStage = 'teacher-private-material-isolation';
    let resource = w.resources.find(item => item.resourceVersionId === checkpoint.resourceVersionId || item.material.title === privateTitle);
    unresolved('import-private-resource', resource);
    if (!resource) {
      await teacherPage.goto(`${origin}/#/teacher/materials`, { waitUntil: 'domcontentloaded' });
      await expect(teacherPage.getByRole('button', { name: '导入资料', exact: true })).toBeEnabled();
      await teacherPage.getByRole('button', { name: '导入资料', exact: true }).click();
      const dialog = teacherPage.getByRole('dialog', { name: '导入课程材料', exact: true });
      const studentVisibility = dialog.getByRole('checkbox', { name: /^学生可见/ });
      const tutorVisibility = dialog.getByRole('checkbox', { name: /^辅导 Agent 可用/ });
      const teacherDesign = dialog.getByRole('checkbox', { name: /^教师设计可用/ });
      await expect(studentVisibility).not.toBeChecked(); await expect(tutorVisibility).not.toBeChecked(); await expect(teacherDesign).not.toBeChecked();
      check('new-material-three-purpose-defaults-false', true);
      await dialog.getByLabel(/^资料名称/).fill(privateTitle);
      // A wrapping native label contains the select's option text too. Locate the
      // visible field heading, then its sole combobox, rather than exact label text.
      const materialCourse = dialog.locator('label.t-rm-field').filter({ hasText: /^所属课程/ }).getByRole('combobox');
      const materialKind = dialog.locator('label.t-rm-field').filter({ hasText: /^资料分类/ }).getByRole('combobox');
      await expect(materialCourse).toHaveCount(1); await expect(materialKind).toHaveCount(1);
      await materialCourse.selectOption(courseId); await expect(materialCourse).toHaveValue(courseId);
      await materialKind.selectOption('private_answer'); await expect(materialKind).toHaveValue('private_answer');
      await expect(studentVisibility).toBeDisabled(); await expect(studentVisibility).not.toBeChecked();
      await expect(tutorVisibility).toBeDisabled(); await expect(tutorVisibility).not.toBeChecked();
      check('private-answer-student-and-tutor-disabled', true);
      await teacherDesign.check();
      await dialog.getByRole('button', { name: '粘贴正文', exact: true }).click();
      await dialog.locator('textarea').fill(privateBody);
      intent('import-private-resource');
      const imported = await uiWrite(teacherPage, `/api/courses/${courseId}/resources`, teacherId, () => dialog.getByRole('button', { name: '保存课程材料', exact: true }).click());
      check('private-resource-receipt-exact-permissions', imported.kind === 'material' && imported.resourceVersion?.courseId === courseId &&
        imported.resourceVersion.material.kind === 'private_answer' && imported.resourceVersion.material.text === privateBody &&
        imported.resourceVersion.material.visibility.student === false && imported.resourceVersion.material.visibility.tutor === false && imported.resourceVersion.teacherDesignAllowed === true);
      w = await until(workbench, value => value.resources.some(item => item.material.title === privateTitle), 'private-resource-stored');
      resource = w.resources.find(item => item.material.title === privateTitle);
    }
    check('stored-private-material-scoped-and-isolated', resource.courseId === courseId && resource.material.title === privateTitle &&
      resource.material.text === privateBody && resource.material.kind === 'private_answer' && resource.teacherDesignAllowed === true &&
      resource.material.visibility.student === false && resource.material.visibility.tutor === false);
    complete('private-resource-imported', { resourceVersionId: resource.resourceVersionId, resourceContentHash: resource.material.contentHash,
      privateIsolation: { status: 'imported-and-ready-to-attach', newDraftOnly: true } });
    await teacherPage.goto(`${origin}/#/teacher/design/new?course=${courseId}`, { waitUntil: 'domcontentloaded' });
    await expect(teacherPage.getByLabel('项目标题', { exact: true })).toBeVisible();
  } else if (!checkpoint.resourceVersionId) {
    checkpoint.privateIsolation = { status: 'not_executed', reason: 'Pre-existing saved draft and fixed activity kept unchanged; private material setup runs only before a new draft is created.' };
    result.notExecuted.push({ name: 'new-private-resource-isolation', reason: checkpoint.privateIsolation.reason }); persist();
  }
  if (!draft) {
    await teacherPage.getByLabel('项目标题', { exact: true }).fill(checkpoint.title);
    if (checkpoint.resourceVersionId) {
      await teacherPage.getByRole('button', { name: /帮助与资源/ }).click();
      const option = teacherPage.locator('.td-resource-option').filter({ hasText: checkpoint.resourceVersionId });
      await expect(option.getByRole('checkbox')).toBeEnabled();
      await option.getByRole('checkbox').check();
      await expect(option).toContainText('学生不可见 · 辅导不可见 · 教师设计允许使用');
    }
    intent('save-blueprint');
    const saved = await uiWrite(teacherPage, `/api/courses/${courseId}/blueprints`, teacherId, () => teacherPage.getByRole('button', { name: '保存草稿', exact: true }).click());
    check('blueprint-create-result', saved.kind === 'draft' && saved.draft?.content.projectTitle === checkpoint.title);
    w = await until(workbench, value => !!findDraft(value), 'saved-blueprint'); draft = findDraft(w);
  }
  complete('draft-saved', { blueprintId: draft.blueprintId, blueprintRevision: draft.revision });
  if (checkpoint.resourceVersionId) check('saved-draft-binds-private-fixed-version', draft.content.resources.some(item => item.resourceVersionId === checkpoint.resourceVersionId));
  await teacherPage.goto(`${origin}/#/teacher/design/${checkpoint.blueprintId}`, { waitUntil: 'domcontentloaded' });
  await expect(teacherPage.getByLabel('项目标题', { exact: true })).toHaveValue(checkpoint.title);
  w = await workbench();
  let activity = findActivity(w);
  unresolved('release-activity', activity);
  if (!activity) {
    const checked = await uiWrite(teacherPage, `/api/blueprints/${checkpoint.blueprintId}/checks`, teacherId, () => teacherPage.getByRole('button', { name: '运行设计检查', exact: true }).last().click());
    check('design-check-result-exact-revision', checked.kind === 'checks' && checked.report?.blueprintId === checkpoint.blueprintId && checked.report.revision === checkpoint.blueprintRevision && checked.report.blocking.length === 0);
    await expect(teacherPage.getByRole('heading', { name: '已通过结构检查', exact: true })).toBeVisible();
    await teacherPage.getByRole('button', { name: '预览并确认版本', exact: true }).click();
    const dialog = teacherPage.getByRole('dialog');
    for (const [role, label] of [['student', '学生视角'], ['tutor', '辅导视角'], ['teacher-validator', '教师 / 验证器']]) {
      await dialog.getByRole('button', { name: label, exact: true }).click();
      await expect(dialog.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
      const projected = await get(teacherPage, `/api/blueprints/${checkpoint.blueprintId}/previews?audience=${role}`);
      check(`role-preview-${role}`, projected.blueprintId === checkpoint.blueprintId && projected.revision === checkpoint.blueprintRevision && projected.audience === role);
      if (checkpoint.resourceVersionId) {
        const available = projected.materials.filter(item => item.status === 'available');
        if (role === 'teacher-validator') {
          check('private-material-present-only-teacher-projection', available.some(item => item.resourceVersionId === checkpoint.resourceVersionId && item.text === privateBody));
          const privatePreview = dialog.locator('.td-preview-resource').filter({ hasText: privateTitle });
          await privatePreview.locator('summary').click();
          await expect(privatePreview).toContainText(privateBody);
        } else {
          check(`private-material-redacted-${role}`, !JSON.stringify(projected).includes(privateBody) &&
            !JSON.stringify(projected).includes(privateTitle) && !available.some(item => item.resourceVersionId === checkpoint.resourceVersionId));
          await expect(dialog).not.toContainText(privateBody); await expect(dialog).not.toContainText(privateTitle);
        }
      }
      await screenshot(teacherPage, `role-preview-${role}`);
    }
    await dialog.getByRole('checkbox', { name: /我已核对三个角色/ }).check();
    intent('release-activity');
    const released = await uiWrite(teacherPage, `/api/blueprints/${checkpoint.blueprintId}/releases`, teacherId, () => dialog.getByRole('button', { name: '确认活动版本', exact: true }).click());
    check('release-result-exact-revision', !!released.activityVersionId && released.sourceRevision === checkpoint.blueprintRevision);
    w = await until(workbench, value => !!findActivity(value), 'released-activity'); activity = findActivity(w);
    if (checkpoint.resourceVersionId) {
      checkpoint.privateIsolation = { status: 'verified-through-three-real-role-projections', newDraftOnly: true };
      persist();
    }
  }
  complete('activity-released', { activityId: activity.activityVersionId });
  let assignment = findAssignment(w);
  unresolved('assign-activity', assignment);
  if (!assignment) {
    const dialog = teacherPage.getByRole('dialog');
    if (!await dialog.isVisible()) await teacherPage.getByRole('button', { name: '选择学生并分配', exact: true }).click();
    await dialog.locator('.td-learner-option').filter({ hasText: studentId }).getByRole('checkbox').check();
    intent('assign-activity');
    const assigned = await uiWrite(teacherPage, `/api/activities/${checkpoint.activityId}/assignments`, teacherId, () => dialog.getByRole('button', { name: /^分配活动 · 1 人$/ }).click());
    check('assignment-receipt-single-owned-student', assigned.assignments?.length === 1 && assigned.assignments[0].studentId === studentId && assigned.assignments[0].activityVersionId === checkpoint.activityId);
    w = await until(workbench, value => !!findAssignment(value), 'assigned-student'); assignment = findAssignment(w);
    await expect(dialog.getByText('已分配给 1 位学生', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
  }
  complete('assigned', { assignmentId: assignment.assignmentId });
  check('ui-assignment-exact-student', assignment.studentId === studentId && assignment.activityVersionId === checkpoint.activityId);

  currentStage = 'student-create-and-submit';
  await login(studentPage, student, `/#/task/${checkpoint.assignmentId}`);
  await expect(studentPage.locator('.ts-badge')).toHaveAttribute('data-status', 'ready');
  w = await workbench();
  let attempt = w.attempts.find(value => value.assignmentId === checkpoint.assignmentId && value.studentId === studentId);
  unresolved('create-attempt', attempt);
  if (!attempt) {
    intent('create-attempt');
    const started = await uiWrite(studentPage, `/api/assignments/${checkpoint.assignmentId}/attempts`, studentId, () => studentPage.getByRole('button', { name: '开始 Attempt', exact: true }).click());
    check('attempt-create-receipt', !!started.attemptId && started.assignmentId === checkpoint.assignmentId && started.activityVersionId === checkpoint.activityId);
    w = await until(workbench, value => value.attempts.some(a => a.assignmentId === checkpoint.assignmentId), 'student-attempt');
    attempt = w.attempts.find(value => value.assignmentId === checkpoint.assignmentId);
  } else {
    // A new browser context has no local Attempt reference. The existing public UI command
    // opens the same immutable assignment Attempt; it must never substitute a new one.
    const opened = await uiWrite(studentPage, `/api/assignments/${checkpoint.assignmentId}/attempts`, studentId,
      () => studentPage.getByRole('button', { name: '开始 Attempt', exact: true }).click());
    check('existing-attempt-opened-without-replacement', opened.attemptId === attempt.attemptId && opened.assignmentId === checkpoint.assignmentId);
  }
  complete('attempt-created', { attemptId: attempt.attemptId });
  await expect(studentPage.locator('.cw')).toBeVisible();
  async function showEditor() {
    const back = studentPage.getByRole('button', { name: '返回作品', exact: true });
    if (await back.count()) await back.click();
    if (await studentPage.getByRole('tab', { name: sourceFile, exact: true }).count()) await studentPage.getByRole('tab', { name: sourceFile, exact: true }).click();
    else {
      const open = studentPage.getByRole('button', { name: '打开项目里的文件', exact: true });
      if (await open.count() && await open.isEnabled()) await open.click();
    }
  }
  async function saveAndFreeze(second = false) {
    await showEditor();
    let state = await head();
    const sourceKey = second ? 'secondSource' : 'firstSource';
    const saveIntent = second ? 'save-revision-two' : 'save-revision-one';
    const versionWord = second ? 'two' : 'one';
    const insertedText = courseKind === 'c' ? `#include <stdio.h>\nint main(void) { puts("Synthetic teacher workflow revision ${versionWord}"); return 0; }\n`
      : `// Synthetic teacher workflow revision ${versionWord}\nmodule main(input wire a, output wire y);\n  assign y = ${second ? '~a' : 'a'};\nendmodule\n`;
    let source = checkpoint[sourceKey];
    let text = source?.text;
    const savedAlready = !!source && state.files.some(file => file.path === sourceFile && file.text === text && file.contentHash === source.contentHash &&
      createHash('sha256').update(file.text).digest('hex') === source.contentHash && file.lifecycle === 'active');
    if (checkpoint.pending === saveIntent) unresolved(saveIntent, savedAlready && !!source?.receipt &&
      source.receipt.workspaceRevision === state.attempt.workspaceRevision && state.files.some(file => file.fileId === source.receipt.fileId &&
        file.documentVersion === source.receipt.documentVersion && file.contentHash === source.receipt.contentHash));
    if (!state.files.some(file => file.path === sourceFile && file.lifecycle === 'active')) {
      await studentPage.getByRole('button', { name: '新建文件', exact: true }).first().click();
      await studentPage.getByRole('textbox', { name: '新文件名', exact: true }).fill(sourceFile);
      await studentPage.getByRole('textbox', { name: '新文件名', exact: true }).press('Enter');
    }
    if (!savedAlready) {
      const editor = studentPage.locator('.monaco-editor textarea.inputarea').first();
      await editor.focus(); await studentPage.keyboard.press('Control+A'); await studentPage.keyboard.insertText(insertedText);
      await expect(studentPage.locator('.cw-protect')).toHaveText('本机草稿已保护');
      // Read the full selected native textarea after Monaco's own editing rules.
      // This harness creates short LF-only files; partial/invalid UI reads stop.
      await editor.focus(); await studentPage.keyboard.press('Control+A');
      text = await editor.inputValue();
      const selection = await editor.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, length: element.value.length }));
      check(second ? 'second-ui-original-captured' : 'first-ui-original-captured', selection.start === 0 && selection.end === text.length &&
        selection.length === text.length && text.length > 0 && text.length <= 4096 && !text.includes('\r') && !text.startsWith('\uFEFF') &&
        text.includes(`Synthetic teacher workflow revision ${versionWord}`));
      source = { path: sourceFile, text, contentHash: createHash('sha256').update(text).digest('hex'), capturedFrom: 'monaco-native-textarea-full-selection' };
      checkpoint[sourceKey] = source; persist();
      intent(saveIntent);
      const saved = await uiWrite(studentPage, `/api/attempts/${checkpoint.attemptId}/sync`, studentId, () => studentPage.getByRole('button', { name: '确认保存', exact: true }).click());
      check(second ? 'second-save-receipt' : 'first-save-receipt', Number.isSafeInteger(saved.workspaceRevision) &&
        saved.files.some(file => file.path === sourceFile && file.contentHash === source.contentHash));
      state = await until(head, value => value.files.some(file => file.path === sourceFile && file.text === text && file.contentHash === source.contentHash &&
        createHash('sha256').update(file.text).digest('hex') === source.contentHash), 'confirmed-source');
    }
    complete(second ? 'second-save-confirmed' : 'first-save-confirmed');
    await expect(studentPage.getByRole('button', { name: '冻结确认作品', exact: true })).toBeEnabled();
    let snapshot = state.snapshots.find(snapshot => snapshot.workspaceRevision === state.attempt.workspaceRevision);
    unresolved(second ? 'freeze-revision-two' : 'freeze-revision-one', snapshot);
    if (!snapshot) {
      intent(second ? 'freeze-revision-two' : 'freeze-revision-one');
      const frozen = await uiWrite(studentPage, `/api/attempts/${checkpoint.attemptId}/snapshots`, studentId, () => studentPage.getByRole('button', { name: '冻结确认作品', exact: true }).click());
      check(second ? 'second-snapshot-receipt' : 'first-snapshot-receipt', !!frozen.snapshotId && frozen.workspaceRevision === state.attempt.workspaceRevision);
      state = await until(head, value => value.snapshots.some(snapshot => snapshot.workspaceRevision === state.attempt.workspaceRevision), 'fixed-snapshot');
      snapshot = state.snapshots.find(snapshot => snapshot.workspaceRevision === state.attempt.workspaceRevision);
    }
    complete(second ? 'second-snapshot-fixed' : 'first-snapshot-fixed', second ? { secondSnapshotId: snapshot.snapshotId, secondSnapshotHash: snapshot.hash }
      : { firstSnapshotId: snapshot.snapshotId, firstSnapshotHash: snapshot.hash });
    return snapshot;
  }
  async function submitFixed(snapshotId, second = false) {
    await studentPage.getByRole('button', { name: '提交与反馈', exact: true }).click();
    const panel = studentPage.getByRole('region', { name: '提交与教师反馈', exact: true });
    await expect(panel.getByRole('combobox', { name: '提交快照', exact: true })).toBeEnabled();
    await panel.getByRole('combobox', { name: '提交快照', exact: true }).selectOption(snapshotId);
    await panel.getByLabel('提交反思', { exact: true }).fill(second ? '依据教师反馈明确修订了显示内容；合成工程验证，不作为真实学习证据。' : '本人明确提交这个确认快照；合成工程验证，未声称完成课程检查。');
    await panel.getByRole('button', { name: '提交所选作品', exact: true }).click();
    intent(second ? 'second-submission' : 'first-submission');
    const submitted = await uiWrite(studentPage, `/api/attempts/${checkpoint.attemptId}/submissions`, studentId, () => panel.getByRole('button', { name: '确认提交所选快照', exact: true }).click());
    check(second ? 'second-submission-receipt' : 'first-submission-receipt', submitted.snapshotId === snapshotId && submitted.status === 'submitted' && !!submitted.submissionId);
    const state = await until(head, value => value.submissions.some(item => item.snapshotId === snapshotId), 'fixed-submission');
    const submission = state.submissions.find(item => item.snapshotId === snapshotId);
    complete(second ? 'second-submitted' : 'first-submitted', second ? { secondSubmissionId: submission.submissionId } : { firstSubmissionId: submission.submissionId });
    await expect(panel.getByText('等待教师审阅', { exact: false })).toBeVisible();
    return submission;
  }
  let state = await head();
  if (!checkpoint.firstSnapshotId) {
    const owned = state.snapshots.find(snapshot => snapshot.files.some(file => file.path === sourceFile && file.text.includes('Synthetic teacher workflow revision one')));
    if (owned) complete('first-snapshot-fixed', { firstSnapshotId: owned.snapshotId, firstSnapshotHash: owned.hash });
    else { unresolved('freeze-revision-one', false); await saveAndFreeze(); }
  }
  state = await head();
  let first = state.submissions.find(item => item.snapshotId === checkpoint.firstSnapshotId);
  unresolved('first-submission', first);
  if (!first) first = await submitFixed(checkpoint.firstSnapshotId);
  else complete('first-submitted', { firstSubmissionId: first.submissionId });
  check('first-submission-fixed-selected-snapshot', first.snapshotHash === checkpoint.firstSnapshotHash && first.snapshotId === checkpoint.firstSnapshotId);

  currentStage = 'teacher-feedback-revision-and-permission';
  await teacherPage.goto(`${origin}/#/teacher/review?learner=${checkpoint.attemptId}`, { waitUntil: 'domcontentloaded' });
  await expect(teacherPage.getByRole('heading', { name: '固定作品与运行', exact: true })).toBeVisible();
  const historySelection = teacherPage.getByRole('combobox', { name: '审阅提交', exact: true });
  if (await historySelection.count()) {
    await historySelection.selectOption(checkpoint.firstSubmissionId);
    await expect(teacherPage.locator('.t-rm-snapshot')).toContainText(checkpoint.firstSubmissionId);
  }
  await teacherPage.getByRole('button', { name: '查看固定作品原文', exact: false }).click();
  await expect(teacherPage.getByRole('dialog')).toContainText('Synthetic teacher workflow revision one');
  await teacherPage.getByRole('dialog').getByRole('button', { name: '关闭对话框', exact: true }).click();
  const firstSummary = `${checkpoint.title}：请说明输出内容的取舍，并按建议进行一次明确修订。`;
  const revisedSummary = `${checkpoint.title}：补充反馈，保留旧版；请核对两版输出差异，说明你怎样确认这次修改。`;
  let context = await review();
  let feedback = context.feedback.entries.find(item => item.submissionId === checkpoint.firstSubmissionId && [firstSummary, revisedSummary].includes(item.summary));
  unresolved('save-feedback', feedback);
  if (!feedback) {
    await teacherPage.getByLabel('教师反馈正文', { exact: true }).fill(firstSummary);
    await teacherPage.getByLabel('教师反馈理由', { exact: true }).fill('依据固定作品原文给出下一步建议；不把输出成功推定为独立掌握。');
    await teacherPage.locator('.t-rm-review-side').getByRole('checkbox', { name: /固定作品 v/ }).check();
    intent('save-feedback');
    const saved = await uiWrite(teacherPage, `/api/attempts/${checkpoint.attemptId}/feedback`, teacherId, () => teacherPage.getByRole('button', { name: '保存教师反馈', exact: true }).click());
    check('first-feedback-receipt', !!saved.feedbackId && saved.submissionId === checkpoint.firstSubmissionId && saved.kind === 'submission_review' && saved.reviewed === true);
    context = await until(review, value => value.feedback.entries.some(item => item.summary === firstSummary), 'saved-feedback');
    feedback = context.feedback.entries.find(item => item.summary === firstSummary);
  }
  complete('feedback-saved', { feedbackId: feedback.feedbackId });
  let revised = context.feedback.entries.find(item => item.feedbackId === checkpoint.feedbackId && item.summary === revisedSummary);
  unresolved('revise-feedback', revised);
  if (!revised) {
    await teacherPage.getByRole('button', { name: '重新读取审阅', exact: true }).click();
    await expect(teacherPage.getByLabel('反馈线程', { exact: true })).toBeEnabled();
    await teacherPage.getByLabel('反馈线程', { exact: true }).selectOption(checkpoint.feedbackId);
    await teacherPage.getByLabel('教师反馈正文', { exact: true }).fill(revisedSummary);
    await teacherPage.getByLabel('教师反馈理由', { exact: true }).fill('追加明确的核对办法；原反馈和原固定提交继续保留。');
    await teacherPage.locator('.t-rm-review-side').getByRole('checkbox', { name: /固定作品 v/ }).check();
    intent('revise-feedback');
    const saved = await uiWrite(teacherPage, `/api/attempts/${checkpoint.attemptId}/feedback`, teacherId, () => teacherPage.getByRole('button', { name: '保存反馈修订', exact: true }).click());
    check('feedback-revision-receipt', saved.feedbackId === checkpoint.feedbackId && saved.threadRevision >= 2 && saved.submissionId === checkpoint.firstSubmissionId);
    context = await until(review, value => value.feedback.entries.some(item => item.summary === revisedSummary), 'feedback-revision');
    revised = context.feedback.entries.find(item => item.summary === revisedSummary);
  }
  complete('feedback-revised', { feedbackThreadRevision: revised.threadRevision });
  check('formal-feedback-revision-preserves-history', context.feedback.entries.some(item => item.summary === firstSummary) && revised.threadRevision >= 2);
  if (context.attempt.status === 'reviewed' && !context.reopen.actionable && context.reopen.state !== 'consumed') {
    unresolved('grant-revision', false);
    await teacherPage.getByRole('button', { name: '重新读取审阅', exact: true }).click();
    await expect(teacherPage.getByLabel('允许修订理由', { exact: true })).toBeEnabled();
    await teacherPage.getByLabel('允许修订理由', { exact: true }).fill('允许学生本人依据这版教师反馈修订，旧提交继续保留。');
    intent('grant-revision');
    const granted = await uiWrite(teacherPage, `/api/attempts/${checkpoint.attemptId}/reopen`, teacherId, () => teacherPage.getByRole('button', { name: '允许修订本次提交', exact: true }).click());
    check('reopen-permission-receipt', !!granted.grantId && granted.submissionId === checkpoint.firstSubmissionId && granted.status === 'reviewed');
    context = await until(review, value => value.reopen.actionable === true, 'revision-permission');
  }
  complete('permission-granted', { grantId: context.reopen.grantId ?? checkpoint.grantId });

  currentStage = 'student-explicit-revision-and-second-submission';
  state = await head();
  if (state.attempt.status === 'reviewed') {
    if (!await studentPage.getByTestId('submission-feedback-panel').count()) await studentPage.getByRole('button', { name: '提交与反馈', exact: true }).click();
    await studentPage.getByRole('button', { name: '重新读取反馈', exact: true }).click();
    await expect(studentPage.getByTestId('submission-feedback-panel')).toContainText(revisedSummary);
    await expect(studentPage.getByRole('button', { name: '我来开始修订', exact: true })).toBeEnabled();
    unresolved('resume-revision', false);
    intent('resume-revision');
    const resumed = await uiWrite(studentPage, `/api/attempts/${checkpoint.attemptId}/controls`, studentId, () => studentPage.getByRole('button', { name: '我来开始修订', exact: true }).click());
    check('student-explicit-reopen-receipt', resumed.status === 'active' && resumed.submissionId === checkpoint.firstSubmissionId && resumed.grantId === checkpoint.grantId);
    state = await until(head, value => value.attempt.status === 'active', 'student-consumed-permission');
  }
  if (state.attempt.status === 'active') {
    complete('student-revision-active');
    if (!checkpoint.secondSnapshotId) await saveAndFreeze(true);
    state = await head();
    const second = state.submissions.find(item => item.snapshotId === checkpoint.secondSnapshotId);
    unresolved('second-submission', second);
    if (!second) await submitFixed(checkpoint.secondSnapshotId, true);
    else complete('second-submitted', { secondSubmissionId: second.submissionId });
  }
  state = await head();
  const originalSnapshot = await get(teacherPage, `/api/attempts/${checkpoint.attemptId}/snapshots/${checkpoint.firstSnapshotId}`);
  check('old-snapshot-hash-unchanged', originalSnapshot.hash === checkpoint.firstSnapshotHash);
  check('two-distinct-fixed-submissions', state.submissions.length >= 2 && state.submissions.some(item => item.submissionId === checkpoint.firstSubmissionId) &&
    state.submissions.some(item => item.submissionId === checkpoint.secondSubmissionId) && checkpoint.firstSubmissionId !== checkpoint.secondSubmissionId &&
    checkpoint.firstSnapshotId !== checkpoint.secondSnapshotId && checkpoint.firstSnapshotHash !== checkpoint.secondSnapshotHash);
  check('new-submission-awaits-teacher', state.attempt.status === 'submitted');
  context = await review();
  check('latest-review-bound-to-second-snapshot', context.submission?.submissionId === checkpoint.secondSubmissionId && context.artifactSnapshotId === checkpoint.secondSnapshotId);
  check('feedback-revisions-preserved-after-resubmit', context.feedback.entries.filter(item => item.feedbackId === checkpoint.feedbackId).length >= 2);
  check('three-competency-lines-present-with-explicit-counts', ['domain', 'project', 'ai_collaboration'].every(domain => Array.isArray(context.competencies[domain])), { counts: Object.fromEntries(Object.entries(context.competencies).map(([domain, items]) => [domain, items.length])) });
  result.objects = { blueprintId: checkpoint.blueprintId, activityId: checkpoint.activityId, assignmentId: checkpoint.assignmentId,
    attemptId: checkpoint.attemptId, firstSnapshotId: checkpoint.firstSnapshotId, firstSnapshotHash: checkpoint.firstSnapshotHash,
    firstSubmissionId: checkpoint.firstSubmissionId, secondSnapshotId: checkpoint.secondSnapshotId, secondSnapshotHash: checkpoint.secondSnapshotHash,
    secondSubmissionId: checkpoint.secondSubmissionId, feedbackId: checkpoint.feedbackId, feedbackThreadRevision: checkpoint.feedbackThreadRevision, grantId: checkpoint.grantId,
    ...(checkpoint.resourceVersionId ? { resourceVersionId: checkpoint.resourceVersionId, resourceContentHash: checkpoint.resourceContentHash } : {}) };

  currentStage = 'teacher-explicit-followup-copy';
  w = await workbench();
  const fixedBeforeCopy = w.activities.find(item => item.activityVersionId === checkpoint.activityId);
  const sourceBlueprint = w.drafts.find(item => item.blueprintId === fixedBeforeCopy?.sourceBlueprintId);
  check('followup-original-source-available', !!fixedBeforeCopy && !!sourceBlueprint && sourceBlueprint.blueprintId === checkpoint.blueprintId);
  const serializedActivityHash = item => createHash('sha256').update(JSON.stringify(item)).digest('hex');
  const beforeHash = serializedActivityHash(fixedBeforeCopy);
  if (checkpoint.fixedActivityBeforeCopySha256) check('fixed-activity-preserved-across-copy-resume', beforeHash === checkpoint.fixedActivityBeforeCopySha256);
  else { checkpoint.fixedActivityBeforeCopySha256 = beforeHash; persist(); }
  const findFollowup = value => value.drafts.find(item => item.blueprintId === checkpoint.followupBlueprintId ||
    item.blueprintId !== sourceBlueprint.blueprintId && item.source?.courseId === courseId && item.source.blueprintId === sourceBlueprint.blueprintId &&
    item.source.revision === sourceBlueprint.revision && item.content.projectTitle === sourceBlueprint.content.projectTitle);
  let followup = findFollowup(w);
  unresolved('copy-followup', followup);
  if (!followup) {
    await teacherPage.goto(`${origin}/#/teacher/review?learner=${checkpoint.attemptId}`, { waitUntil: 'domcontentloaded' });
    await expect(teacherPage.getByRole('link', { name: '设计后续项目', exact: true })).toBeVisible();
    await teacherPage.getByRole('link', { name: '设计后续项目', exact: true }).click();
    await expect(teacherPage).toHaveURL(new RegExp(`[?&]from=${checkpoint.activityId}(?:&|$)`));
    await expect(teacherPage.getByRole('button', { name: '复制为后续项目', exact: true })).toBeEnabled();
    intent('copy-followup');
    const copied = await uiWrite(teacherPage, `/api/courses/${courseId}/blueprints`, teacherId, () => teacherPage.getByRole('button', { name: '复制为后续项目', exact: true }).click());
    check('followup-copy-receipt-source-ancestry', copied.kind === 'draft' && copied.draft?.blueprintId !== sourceBlueprint.blueprintId &&
      copied.draft.revision === 1 && copied.draft.source?.courseId === courseId && copied.draft.source.blueprintId === sourceBlueprint.blueprintId &&
      copied.draft.source.revision === sourceBlueprint.revision);
    w = await until(workbench, value => !!findFollowup(value), 'copied-followup-draft'); followup = findFollowup(w);
  }
  complete('followup-copied', { followupBlueprintId: followup.blueprintId, followupSourceBlueprintId: sourceBlueprint.blueprintId, followupSourceRevision: sourceBlueprint.revision });
  check('followup-is-independent-with-exact-source', followup.blueprintId !== sourceBlueprint.blueprintId && followup.source?.courseId === courseId &&
    followup.source.blueprintId === sourceBlueprint.blueprintId && followup.source.revision === sourceBlueprint.revision);
  check('followup-copy-keeps-fixed-activity-byte-identical', serializedActivityHash(w.activities.find(item => item.activityVersionId === checkpoint.activityId)) === beforeHash);
  result.objects.followupBlueprintId = checkpoint.followupBlueprintId;
  result.objects.followupSourceBlueprintId = checkpoint.followupSourceBlueprintId;
  result.objects.followupSourceRevision = checkpoint.followupSourceRevision;
  result.objects.fixedActivityBeforeCopySha256 = checkpoint.fixedActivityBeforeCopySha256;
  result.privateIsolation = checkpoint.privateIsolation;
  persist();

  currentStage = 'responsive-layout-evidence';
  async function layout(page, route, name, width, ready) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
    await ready();
    await page.evaluate(() => document.fonts.ready);
    const measurements = await page.evaluate(() => ({ viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
      region: [...document.querySelectorAll('.t-main, .ws-submission')].map(element => ({ className: String(element.className), width: element.clientWidth, scrollWidth: element.scrollWidth })),
      overflowing: [...document.querySelectorAll('body *')].filter(element => {
        const box = element.getBoundingClientRect(), style = getComputedStyle(element);
        return style.position !== 'fixed' && style.visibility !== 'hidden' && box.width > 0 && box.left < innerWidth && box.right > innerWidth + 1;
      }).slice(0, 12).map(element => ({ tag: element.tagName, className: String(element.className).slice(0, 100), right: Math.round(element.getBoundingClientRect().right) })) }));
    const file = `${name}-${width}.png`;
    await screenshot(page, `${name}-${width}`);
    result.layouts.push({ name, width, ...measurements, screenshot: file, passed: measurements.pageWidth <= width + 1 && measurements.region.every(region => region.scrollWidth <= region.width + 1) });
    persist();
  }
  for (const width of [1440, 720, 390]) {
    await layout(teacherPage, `/#/teacher/design/${checkpoint.blueprintId}`, 'teacher-design', width,
      () => expect(teacherPage.getByLabel('项目标题', { exact: true })).toHaveValue(checkpoint.title));
    await layout(teacherPage, '/#/teacher/review', 'teacher-review-list', width,
      () => expect(teacherPage.getByRole('heading', { name: '学生与证据', exact: true })).toBeVisible());
    await layout(teacherPage, `/#/teacher/review?learner=${checkpoint.attemptId}`, 'teacher-review-detail', width,
      () => expect(teacherPage.getByRole('heading', { name: '固定作品与运行', exact: true })).toBeVisible());
    await layout(studentPage, `/#/task/${checkpoint.assignmentId}`, 'student-submission', width, async () => {
      await expect(studentPage.getByRole('button', { name: '提交与反馈', exact: true })).toBeEnabled();
      await studentPage.getByRole('button', { name: '提交与反馈', exact: true }).click();
      await expect(studentPage.getByRole('heading', { name: '固定提交历史', exact: false })).toBeVisible();
      await expect(studentPage.getByTestId('submission-feedback-panel')).toContainText(revisedSummary);
    });
  }
  check('responsive-document-no-horizontal-overflow', result.layouts.every(layout => layout.passed));
  check('no-browser-pageerrors', result.pageErrors.length === 0);
  check('writes-only-original-ui-endpoints', result.network.filter(entry => entry.method !== 'GET').every(entry =>
    ['POST', 'PATCH'].includes(entry.method) && /^\/api\/(sessions|courses\/[^/]+\/(blueprints|resources)|blueprints\/[^/]+(?:\/checks|\/releases)?|activities\/[^/]+\/assignments|assignments\/[^/]+\/attempts|attempts\/[^/]+\/(sync|snapshots|submissions|feedback|reopen|controls))$/.test(entry.path)));
  complete('complete'); result.status = 'passed'; result.completedAtUtc = new Date().toISOString(); persist();
  process.stdout.write(JSON.stringify({ status: result.status, checks: result.checks.length, screenshots: result.screenshots.length,
    publicResult: publicFile, checkpoint: checkpointFile }, null, 2) + '\n');
} catch (error) {
  result.status = 'failed'; result.failedStage = currentStage; result.failures.push({ stage: currentStage, message: redact(error?.message ?? error).slice(0, 3000) });
  result.completedAtUtc = new Date().toISOString(); persist();
  process.stderr.write(JSON.stringify({ status: 'failed', stage: currentStage, message: result.failures.at(-1).message,
    publicResult: publicFile, checkpoint: checkpointFile }, null, 2) + '\n');
  process.exitCode = 1;
} finally { await browser?.close(); secrets.fill(''); }
