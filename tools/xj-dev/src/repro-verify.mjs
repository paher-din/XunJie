import { request } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { inspectRepro, validateScenario } from './repro.mjs';
import { reproError } from './repro-archive.mjs';
import { loadState, writeJsonAtomic } from './state.mjs';
import { componentRunning } from './processes.mjs';

function http(origin, method, path, body, auth) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request(origin + path, { method, agent: false, rejectUnauthorized: false, headers: {
      origin, connection: 'close', ...(encoded ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'idempotency-key': randomUUID() } : {}),
    } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) req.destroy(new Error('response limit')); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(text), cookies: res.headers['set-cookie'] ?? [] }); }
        catch { reject(reproError('REPLAY_FAILED', '业务响应不是 JSON。')); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(reproError('REPLAY_FAILED', '本地业务请求失败，请检查已恢复环境的服务状态。')));
    req.end(encoded);
  });
}

// Explicit command after review/up. Restoring a package never calls this function.
// Only data-driven same-origin HTTP is supported; no shell, JS, package scripts, or migrations.
export async function verifyRepro(context, { file, expectedDigest }) {
  const checked = inspectRepro(file, { expectedDigest });
  const receiptFile = join(context.env.root, 'repro-receipt.json');
  if (!existsSync(receiptFile)) throw reproError('NOT_RESTORED', '当前工作树没有恢复回执。请在新恢复的工作树执行 verify。');
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  if (receipt.packageDigest !== checked.package.digest || receipt.target !== context.worktree) throw reproError('DIGEST_MISMATCH', '当前环境的恢复回执不属于此包。');
  const { scenario } = checked;
  if (scenario.start !== 'before-trigger' || scenario.externalUncertainty
    || Object.values(checked.package.manifest.conditions.capabilities).some(v => !['not-required', false].includes(v))) {
    return { package: checked.package, verification: { generated: true, restored: true, reproduction: 'unverified',
      reason: '只有事后现场、依赖不确定外部响应或需要单独配置执行/模型能力；未执行并且未标记已复现。' } };
  }
  validateScenario(scenario, { automated: true });
  const state = loadState(context.env);
  if (!state?.ports || !componentRunning(context.env, 'backend').running || !componentRunning(context.env, 'gateway').running) throw reproError('ENVIRONMENT_NOT_RUNNING', '先审阅代码并显式 up 恢复环境，再执行 verify。');
  const origin = `https://127.0.0.1:${state.ports.gateway}`;
  const credentials = JSON.parse(readFileSync(context.env.baselineCredentials, 'utf8')), sessions = new Map(), results = [];
  for (const step of scenario.steps) {
    if (!sessions.has(step.actorId)) {
      const account = credentials.find(a => a.id === step.actorId);
      if (!account) throw reproError('RESOURCE_MISSING', '步骤的登录角色不在恢复账号中。');
      const login = await http(origin, 'POST', '/api/sessions', { loginName: account.loginName, password: account.password });
      if (login.status !== 200) throw reproError('REPLAY_FAILED', '恢复账号无法登录。');
      sessions.set(step.actorId, { cookie: login.cookies.map(v => v.split(';')[0]).join('; '), csrf: login.body.data.csrfToken });
    }
    const response = await http(origin, step.method, step.path, step.body, sessions.get(step.actorId));
    const matched = response.status === step.expect.status && (!step.expect.errorCode || response.body.error?.code === step.expect.errorCode);
    results.push({ method: step.method, path: step.path, status: response.status, errorCode: response.body.error?.code ?? null, matched });
    if (!matched) break;
  }
  const reproduced = results.length > 0 && results.length === scenario.steps.length && results.every(result => result.matched);
  const verification = { generated: true, restored: true, reproduction: reproduced ? 'verified' : 'not-reproduced',
    verifiedAt: new Date().toISOString(), evidence: 'real-local-business-https', results };
  writeJsonAtomic(receiptFile, { ...receipt, verification });
  return { ok: reproduced, package: checked.package, verification };
}
