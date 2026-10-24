// 端到端集成测试：真实 up/down、经 HTTPS 网关的完整教学闭环、双环境隔离、幂等与端口冲突边界。
// 运行环境数据全部隔离在临时 XJ_DEV_HOME 内，不触碰开发者真实的 ~/.xunjie/xj-dev。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PINNED_NODE } from '../src/paths.mjs';

assert.equal(process.version, PINNED_NODE,
  `xj-dev 测试必须由受管 Node ${PINNED_NODE} 运行（当前 ${process.version}）；先 node tools/xj-dev/xj-dev.mjs doctor 确认定位。`);

const worktree = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = join(worktree, 'tools', 'xj-dev', 'xj-dev.mjs');
const home = mkdtempSync(join(tmpdir(), 'xj-dev-it-home-'));
const suffix = `${process.pid}`;
const instanceA = `it-a-${suffix}`;
const instanceB = `it-b-${suffix}`;

function runCli(args, { expectFailure = false } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: worktree,
    env: { ...process.env, XJ_DEV_HOME: home },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
  });
  assert.ok(result.stdout, `CLI 无输出：${result.stderr?.slice(-500) ?? ''}`);
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    assert.fail(`CLI 输出不是 JSON：${result.stdout.slice(-500)}\n${result.stderr?.slice(-500) ?? ''}`);
  }
  assert.equal(envelope.schema, 'xj-dev/result-v1');
  if (expectFailure) {
    assert.equal(envelope.ok, false, JSON.stringify(envelope).slice(0, 500));
    assert.notEqual(result.status, 0, '失败命令退出码非零');
  } else {
    assert.equal(envelope.ok, true, `失败：${JSON.stringify(envelope.failure ?? envelope).slice(0, 800)}\n${result.stderr?.slice(-500) ?? ''}`);
    assert.equal(result.status, 0, '成功命令退出码为零');
  }
  return envelope;
}

async function api(base, method, path, { cookie, csrf, body, origin = base, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      // 测试进程会 down/up 同一端口的环境；关掉 keep-alive，避免复用到已死的连接（ECONNRESET）。
      connection: 'close',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() } : {}),
      origin,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (raw) return { status: res.status, text, headers: res.headers };
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') || '' };
}

async function login(base, loginName, password) {
  const res = await api(base, 'POST', '/api/sessions', { body: { loginName, password } });
  assert.equal(res.status, 200, `login ${loginName}: ${JSON.stringify(res.json)}`);
  assert.ok(res.setCookie.includes('__Host-xunjie') && /secure/i.test(res.setCookie) && /httponly/i.test(res.setCookie),
    `安全 Cookie 属性：${res.setCookie}`);
  return { cookie: res.setCookie.split(';')[0], csrf: res.json.data.csrfToken };
}

// 基线密码只在环境 secrets/baseline-accounts.json（仓库外、0600），不进入代码与 CLI 输出。
function baselinePasswords(envelope) {
  const file = join(envelope.environment.root, 'secrets', 'baseline-accounts.json');
  return new Map(JSON.parse(readFileSync(file, 'utf8')).map(account => [account.loginName, account.password]));
}

const upArgs = instance => ['up', '--worktree', worktree, '--instance', instance];
const downArgs = instance => ['down', '--worktree', worktree, '--instance', instance];

let envA;
let envB;

after(() => {
  for (const instance of [instanceA, instanceB]) {
    spawnSync(process.execPath, [cli, 'down', '--worktree', worktree, '--instance', instance], {
      cwd: worktree, env: { ...process.env, XJ_DEV_HOME: home }, encoding: 'utf8', timeout: 120_000,
    });
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('实例 A up：三进程就绪、单一 HTTPS 入口、基线播种', { timeout: 300_000 }, () => {
  const envelope = runCli(upArgs(instanceA));
  envA = envelope;
  const { environment, processes, page, capabilities, accounts, data } = envelope;
  assert.equal(environment.instance, instanceA);
  assert.equal(environment.baselineVersion, 'local-baseline-1');
  for (const name of ['gateway', 'backend', 'vite']) {
    assert.equal(processes[name].running, true, `${name} running`);
    assert.ok(Number.isInteger(processes[name].pid));
    assert.ok(Number.isInteger(processes[name].port));
  }
  assert.equal(page.url, `https://127.0.0.1:${processes.gateway.port}`);
  assert.equal(capabilities.frontend.available, true);
  assert.equal(capabilities.execution.available, false);
  assert.equal(capabilities.models.available, false);
  assert.deepEqual(accounts.list.map(a => a.loginName).sort(), ['synthetic-student', 'synthetic-teacher']);
  assert.ok(accounts.list.every(a => !('password' in a)), '密码不进入 CLI 输出');
  const passwords = baselinePasswords(envelope);
  assert.equal(passwords.size, 2);
  for (const password of passwords.values()) {
    assert.ok(!JSON.stringify(envelope).includes(password), '输出 JSON 不含任何基线密码');
  }
  assert.ok(existsSync(data.database), '数据库文件已落盘');
  assert.ok(envelope.stages.every(stage => stage.ok), '全部 stage 成功');
});

test('实例 A：登录→课程→保存→提交→教师反馈→学生可见，安全断言与执行未接线', { timeout: 120_000 }, async () => {
  const base = envA.page.url;
  const page = await api(base, 'GET', '/', { raw: true });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);

  const student = await login(base, 'synthetic-student', baselinePasswords(envA).get('synthetic-student'));
  const session = await api(base, 'GET', '/api/session', { cookie: student.cookie });
  assert.equal(session.status, 200);
  assert.equal(session.json.data.courses.length, 2, '两门基线课程');

  const assignments = await api(base, 'GET', '/api/courses/synthetic-textscope-c/assignments', { cookie: student.cookie });
  assert.equal(assignments.status, 200);
  assert.equal(assignments.json.data.length, 1);
  const assignmentId = assignments.json.data[0].assignmentId;

  const boot = await api(base, 'GET', `/api/assignments/${assignmentId}/bootstrap`, { cookie: student.cookie });
  assert.equal(boot.status, 200);
  assert.ok(boot.json.data.currentAttemptId);
  const attemptId = boot.json.data.currentAttemptId;
  const generation = boot.json.data.recoveryGeneration;

  const before = await api(base, 'GET', `/api/attempts/${attemptId}`, { cookie: student.cookie });
  const saved = await api(base, 'POST', `/api/attempts/${attemptId}/sync`, { cookie: student.cookie, csrf: student.csrf, body: {
    recoveryGeneration: generation, expectedWorkspaceRevision: before.json.data.attempt.workspaceRevision,
    clientId: 'it', clientSeq: 100,
    operations: [{ kind: 'create', clientFileKey: 'it', path: 'it.txt', text: 'integration verified' }],
  } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));

  const snap = await api(base, 'POST', `/api/attempts/${attemptId}/snapshots`, { cookie: student.cookie, csrf: student.csrf, body: {
    recoveryGeneration: generation, expectedWorkspaceRevision: before.json.data.attempt.workspaceRevision + 1,
  } });
  assert.equal(snap.status, 200, JSON.stringify(snap.json));
  const snapshotId = snap.json.data.result.snapshotId;

  const attemptNow = await api(base, 'GET', `/api/attempts/${attemptId}`, { cookie: student.cookie });
  const submitted = await api(base, 'POST', `/api/attempts/${attemptId}/submissions`, { cookie: student.cookie, csrf: student.csrf, body: {
    recoveryGeneration: generation, expectedAttemptRevision: attemptNow.json.data.attempt.attemptRevision, snapshotId,
  } });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
  const submissionId = submitted.json.data.result.submissionId;

  const teacher = await login(base, 'synthetic-teacher', baselinePasswords(envA).get('synthetic-teacher'));
  const learnerState = await api(base, 'GET', `/api/attempts/${attemptId}/learner-state`, { cookie: teacher.cookie });
  assert.equal(learnerState.status, 200);
  const feedbackView0 = await api(base, 'GET', `/api/attempts/${attemptId}/feedback`, { cookie: teacher.cookie });
  const attemptForFeedback = await api(base, 'GET', `/api/attempts/${attemptId}`, { cookie: teacher.cookie });
  const fb = await api(base, 'POST', `/api/attempts/${attemptId}/feedback`, { cookie: teacher.cookie, csrf: teacher.csrf, body: {
    recoveryGeneration: generation, kind: 'submission_review', submissionId,
    expectedFeedbackRevision: feedbackView0.json.data.feedbackRevision,
    expectedStateRevision: learnerState.json.data.learnerStateRevision,
    expectedAttemptRevision: attemptForFeedback.json.data.attempt.attemptRevision,
    summary: '集成测试反馈：提交链路完整。', reason: '端到端验收', evidenceRefs: [],
  } });
  assert.equal(fb.status, 200, JSON.stringify(fb.json));

  const studentView = await api(base, 'GET', `/api/attempts/${attemptId}/feedback`, { cookie: student.cookie });
  assert.equal(studentView.status, 200);
  assert.ok(studentView.json.data.entries.some(entry => entry.current), '学生读到当前反馈');

  const noCsrf = await api(base, 'POST', `/api/attempts/${attemptId}/sync`, { cookie: student.cookie, body: {
    recoveryGeneration: generation, expectedWorkspaceRevision: 99, clientId: 'x', clientSeq: 1, operations: [],
  } });
  assert.equal(noCsrf.status, 403, '无 CSRF 的写请求被拒');
  const wrongOrigin = await api(base, 'POST', `/api/attempts/${attemptId}/sync`, { cookie: student.cookie, csrf: student.csrf, origin: 'https://evil.example', body: {
    recoveryGeneration: generation, expectedWorkspaceRevision: 99, clientId: 'x', clientSeq: 1, operations: [],
  } });
  assert.equal(wrongOrigin.status, 403, '错误 Origin 的写请求被拒');
  const anon = await api(base, 'GET', '/api/session', {});
  assert.equal(anon.status, 401, '匿名会话被拒');

  const runAttempt = await api(base, 'GET', `/api/attempts/${attemptId}`, { cookie: student.cookie });
  const files = runAttempt.json.data.files;
  const run = await api(base, 'POST', `/api/attempts/${attemptId}/runs`, { cookie: student.cookie, csrf: student.csrf, body: {
    recoveryGeneration: generation, expectedAttemptRevision: runAttempt.json.data.attempt.attemptRevision,
    snapshotId, runtimeProfileVersion: 'runtime-v1', entryFileId: files[0].fileId, mode: 'run',
    input: { operation: 'stats', fileIds: [files[0].fileId] },
  } });
  assert.equal(run.json?.error?.code, 'RUNTIME_NOT_READY', `执行明确不可用：${JSON.stringify(run.json)}`);

  envA.attemptId = attemptId;
});

test('实例 A 重复 up：幂等，进程与端口不变', { timeout: 180_000 }, () => {
  const again = runCli(upArgs(instanceA));
  for (const name of ['gateway', 'backend', 'vite']) {
    assert.equal(again.processes[name].pid, envA.processes[name].pid, `${name} 未重启`);
    assert.equal(again.processes[name].port, envA.processes[name].port, `${name} 端口不变`);
  }
});

test('status：运行状态、能力开关、基线版本可见', () => {
  const envelope = runCli(['status', '--worktree', worktree, '--instance', instanceA]);
  for (const name of ['gateway', 'backend', 'vite']) assert.equal(envelope.processes[name].running, true);
  assert.equal(envelope.page.serving, true);
  assert.equal(envelope.page.apiReady, true);
  assert.equal(envelope.baseline.current, 'local-baseline-1');
  assert.equal(envelope.baseline.pinned, 'local-baseline-1');
  assert.equal(envelope.capabilities.execution.available, false);
  assert.equal(envelope.capabilities.models.available, false);
  assert.ok(envelope.browser.profile.startsWith(envA.environment.root), '浏览器配置目录在环境根内');
  assert.ok(Array.isArray(envelope.checks) && envelope.checks.every(check => check.ok === true), 'status 携带检查结论');
  assert.ok(Array.isArray(envelope.next) && envelope.next.length > 0, 'status 携带下一步');
  assert.equal(envelope.accounts.list.length, 2);
  assert.ok(envelope.accounts.credentials.file.startsWith(envA.environment.root), '凭据文件在环境根内');
});

test('doctor：检查项、能力状态与下一步齐全', () => {
  const envelope = runCli(['doctor', '--worktree', worktree, '--instance', instanceA]);
  assert.ok(envelope.checks.length >= 6, JSON.stringify(envelope.checks));
  assert.ok(envelope.checks.every(check => typeof check.ok === 'boolean' && check.name));
  assert.equal(envelope.pinnedRuntime, PINNED_NODE);
  assert.ok(envelope.capabilities.frontend.available);
  assert.ok(Array.isArray(envelope.next) && envelope.next.length > 0);
});

test('实例 B：与 A 并行运行，端口、数据、浏览器身份完全独立', { timeout: 300_000 }, async () => {
  envB = runCli(upArgs(instanceB));
  assert.notEqual(envB.environment.id, envA.environment.id);
  assert.notEqual(envB.environment.root, envA.environment.root);
  const portsA = Object.values(envA.processes).map(p => p.port);
  const portsB = Object.values(envB.processes).map(p => p.port);
  for (const port of portsB) assert.ok(!portsA.includes(port), `端口 ${port} 不与 A 冲突`);

  const studentB = await login(envB.page.url, 'synthetic-student', baselinePasswords(envB).get('synthetic-student'));
  const sessionB = await api(envB.page.url, 'GET', '/api/session', { cookie: studentB.cookie });
  assert.equal(sessionB.json.data.courses.length, 2);
  const assignmentsB = await api(envB.page.url, 'GET', '/api/courses/synthetic-textscope-c/assignments', { cookie: studentB.cookie });
  const bootB = await api(envB.page.url, 'GET', `/api/assignments/${assignmentsB.json.data[0].assignmentId}/bootstrap`, { cookie: studentB.cookie });
  assert.ok(bootB.json.data.currentAttemptId);
  assert.notEqual(bootB.json.data.currentAttemptId, envA.attemptId, 'B 的尝试独立于 A 的数据');

  const studentA = await login(envA.page.url, 'synthetic-student', baselinePasswords(envA).get('synthetic-student'));
  const attemptA = await api(envA.page.url, 'GET', `/api/attempts/${envA.attemptId}`, { cookie: studentA.cookie });
  assert.equal(attemptA.status, 200, 'B 启动后 A 仍然健康');
  assert.equal(attemptA.json.data.attempt.status, 'reviewed');
});

test('down：只停自有进程、数据保留；外来占用端口报 PORT_IN_USE 且不受影响', { timeout: 180_000 }, async () => {
  const down = runCli(downArgs(instanceA));
  assert.ok(down.stopped.every(item => item.result === 'stopped'), JSON.stringify(down.stopped));
  assert.ok(existsSync(down.data.database), 'down 不删除数据库');

  const gatewayPort = envA.processes.gateway.port;
  const foreign = createServer();
  await new Promise(done => foreign.listen(gatewayPort, '127.0.0.1', done));
  try {
    const conflict = runCli(upArgs(instanceA), { expectFailure: true });
    assert.equal(conflict.failure.code, 'PORT_IN_USE');
    assert.equal(conflict.failure.stage, 'ports');
    assert.ok(Array.isArray(conflict.stages), '失败信封携带已完成 stage');
    assert.equal(conflict.stages.find(s => s.name === 'ports')?.ok, undefined, 'ports stage 未完成');
    await new Promise(done => {
      const probe = createServer();
      probe.once('error', () => done());
      probe.listen(gatewayPort, '127.0.0.1', () => probe.close(() => done(new Error('外来进程被误杀'))));
    });
  } finally {
    await new Promise(done => foreign.close(done));
  }
});

test('重启后数据完整：反馈与提交记录仍在', { timeout: 300_000 }, async () => {
  const restarted = runCli(upArgs(instanceA));
  assert.equal(restarted.processes.gateway.port, envA.processes.gateway.port, '沿用原端口');
  const student = await login(envA.page.url, 'synthetic-student', baselinePasswords(envA).get('synthetic-student'));
  const attempt = await api(envA.page.url, 'GET', `/api/attempts/${envA.attemptId}`, { cookie: student.cookie });
  assert.equal(attempt.json.data.attempt.status, 'reviewed');
  const feedback = await api(envA.page.url, 'GET', `/api/attempts/${envA.attemptId}/feedback`, { cookie: student.cookie });
  assert.equal(feedback.status, 200);
  assert.equal(feedback.json.data.entries.length, 1);
  assert.equal(feedback.json.data.entries[0].summary, '集成测试反馈：提交链路完整。');
});

test('环境状态文件记录实例与基线版本', () => {
  const stateFile = join(envA.environment.root, 'environment.json');
  assert.ok(existsSync(stateFile));
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.instance, instanceA);
  assert.equal(state.baselineVersion, 'local-baseline-1');
});
