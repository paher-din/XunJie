import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError } from './envelope.mjs';
import { writeJsonAtomic } from './state.mjs';

export const BASELINE_VERSION = 'local-baseline-1';

// 密码不进入代码与输出：首次构造时随机生成，只落在环境 secrets/baseline-accounts.json（0600）。
export const baselineAccounts = [
  { id: 'synthetic-teacher', loginName: 'synthetic-teacher', displayName: '基线教师', role: 'teacher' },
  { id: 'synthetic-student', loginName: 'synthetic-student', displayName: '基线学生', role: 'student' },
];

export function baselineAccountsFor(envPaths) {
  if (!existsSync(envPaths.baselineFile)) return baselineAccounts;
  return readBaselineRecord(envPaths).accounts;
}

function incompleteBaseline(code, message) {
  return new CliError('baseline', code, message, {
    recovery: '保留数据库与已有凭据，检查 data/baseline.json 和 secrets/baseline-accounts.json；从可信备份恢复缺失材料，不自动重置已有账号或数据。',
  });
}

function validAccounts(accounts) {
  return Array.isArray(accounts) && accounts.length > 0
    && accounts.every(a => a && typeof a.loginName === 'string' && a.loginName.length > 0 && ['teacher', 'student'].includes(a.role))
    && new Set(accounts.map(a => a.loginName)).size === accounts.length;
}

function readBaselineRecord(envPaths) {
  if (!existsSync(envPaths.baselineFile)) {
    throw incompleteBaseline('BASELINE_MARKER_MISSING', '数据库已存在但缺少基线标记（data/baseline.json），无法确认基线版本与归属。');
  }
  let record;
  try { record = JSON.parse(readFileSync(envPaths.baselineFile, 'utf8')); } catch { /* report no file contents */ }
  if (!record || typeof record.version !== 'string' || !record.version || !validAccounts(record.accounts)) {
    throw incompleteBaseline('BASELINE_MARKER_INVALID', '基线版本或账号标记无效。');
  }
  return record;
}

function readCredentials(envPaths, accounts) {
  if (!existsSync(envPaths.baselineCredentials)) {
    throw incompleteBaseline('BASELINE_CREDENTIALS_MISSING', '基线缺少登录凭据，不能将现有数据库视为初始化完成。');
  }
  let credentials;
  try { credentials = JSON.parse(readFileSync(envPaths.baselineCredentials, 'utf8')); } catch { /* never include secret input */ }
  if (!validAccounts(credentials) || credentials.length !== accounts.length
    || credentials.some(a => typeof a.password !== 'string' || !a.password.length
      || !accounts.some(expected => expected.loginName === a.loginName && expected.role === a.role))) {
    throw incompleteBaseline('BASELINE_CREDENTIALS_INVALID', '基线登录凭据无效或与账号标记不一致。');
  }
  return credentials;
}

const manifest = {
  synthetic: true,
  recoveryGeneration: 'generation',
  courses: [
    { id: 'synthetic-textscope-c', name: 'C 程序设计（开发基线）' },
    { id: 'synthetic-digital-logic', name: '数字逻辑与部件设计（开发基线）' },
  ],
  memberships: [
    { courseId: 'synthetic-textscope-c', userId: 'synthetic-teacher', role: 'teacher' },
    { courseId: 'synthetic-textscope-c', userId: 'synthetic-student', role: 'student' },
    { courseId: 'synthetic-digital-logic', userId: 'synthetic-teacher', role: 'teacher' },
    { courseId: 'synthetic-digital-logic', userId: 'synthetic-student', role: 'student' },
  ],
};

const SEED_ORIGIN = 'https://synthetic.example';

async function login(app, loginName, password) {
  const response = await app.inject({ method: 'POST', url: '/api/sessions', headers: { origin: SEED_ORIGIN }, payload: { loginName, password } });
  if (response.statusCode !== 200) throw new Error(`baseline login failed for ${loginName}: ${response.body}`);
  return {
    origin: SEED_ORIGIN,
    cookie: response.cookies.filter(cookie => cookie.value).map(cookie => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join('; '),
    'x-csrf-token': String(response.json().data.csrfToken),
  };
}

export async function ensureBaseline(teachingDir, envPaths, log) {
  if (existsSync(envPaths.database)) {
    const record = readBaselineRecord(envPaths);
    readCredentials(envPaths, record.accounts);
    return { created: false, version: record.version };
  }
  if (existsSync(envPaths.database + '-wal') || existsSync(envPaths.database + '-shm')) {
    throw incompleteBaseline('BASELINE_INCOMPLETE', '数据库缺失但仍有 SQLite 现场文件，不能自动重建。');
  }
  if (existsSync(envPaths.baselineFile)) {
    const record = readBaselineRecord(envPaths);
    if (record.version !== BASELINE_VERSION || record.source
      || record.accounts.length !== baselineAccounts.length
      || !record.accounts.every(a => baselineAccounts.some(expected => expected.loginName === a.loginName && expected.role === a.role))) {
      throw incompleteBaseline('BASELINE_INCOMPLETE', '已有基线标记不属于待完成的本地初始化，不能自动重建。');
    }
    readCredentials(envPaths, record.accounts);
  }
  const savedCredentials = existsSync(envPaths.baselineCredentials) ? readCredentials(envPaths, baselineAccounts) : undefined;
  const importFromTeaching = module => import(pathToFileURL(join(teachingDir, module)).href);
  const { createApplicationDatabase } = await importFromTeaching('server/db/transaction.ts');
  const { initializeSyntheticApplication } = await importFromTeaching('server/app/initialize.ts');
  const { createDigitalLogicApplication } = await importFromTeaching('server/app/digital-logic.ts');
  const support = await importFromTeaching('tests/dl-a-support.ts');

  const seedingFile = envPaths.database + '.seeding';
  rmSync(seedingFile, { force: true });
  rmSync(seedingFile + '-wal', { force: true });
  rmSync(seedingFile + '-shm', { force: true });
  mkdirSync(envPaths.data, { recursive: true });
  mkdirSync(envPaths.secrets, { recursive: true, mode: 0o700 });
  log('首次启动：构造固定最小基线（账号、课程、任务、作品草稿）');
  const credentials = baselineAccounts.map(account => ({ ...account,
    password: savedCredentials?.find(saved => saved.loginName === account.loginName).password ?? randomBytes(12).toString('hex'),
  }));
  const versions = { modelConfig: 'unconfigured', prompt: 'unconfigured', schema: 'unconfigured', policy: 'unconfigured' };
  const node = support.syntheticNode();
  const cNode = support.controlledRunner();
  let db;
  try {
    // Persist random passwords before seeding. An interrupted retry reuses them;
    // the final DB rename is the publication point for a complete baseline.
    if (!savedCredentials) writeJsonAtomic(envPaths.baselineCredentials,
      credentials.map(({ loginName, role, password }) => ({ loginName, role, password })));
    db = createApplicationDatabase(seedingFile, 'digital-logic-review-application');
    await initializeSyntheticApplication({ ...manifest, accounts: credentials.map(({ role: _role, ...account }) => account) },
      { runner: cNode.transport, hdlTransport: node.transport }, [support.runtime], db);
    const service = await createDigitalLogicApplication({
      db,
      origin: SEED_ORIGIN,
      signingSecret: randomBytes(48).toString('hex'),
      approvedHdlRuntimes: [support.runtime],
      runner: cNode.transport,
      hdlTransport: node.transport,
      studentHelp: { versions, budgetAvailable: () => false },
      review: { versions: { modelConfigVersion: versions.modelConfig, promptVersion: versions.prompt, schemaVersion: versions.schema, analysisVersion: 'learner-analysis-v1' } },
    });
    try {
      const fixture = { app: service.app, db };
      const teacher = await login(service.app, 'synthetic-teacher', credentials[0].password);
      const student = await login(service.app, 'synthetic-student', credentials[1].password);
      const textscope = await support.allocate(fixture, teacher, student, false,
        { course: 'synthetic-textscope-c', studentId: 'synthetic-student' });
      const digitalLogic = await support.allocate(fixture, teacher, student, true,
        { course: 'synthetic-digital-logic', studentId: 'synthetic-student' });
      const record = {
        version: BASELINE_VERSION,
        createdAt: new Date().toISOString(),
        accounts: baselineAccounts.map(({ loginName, role }) => ({ loginName, role })),
        courses: manifest.courses,
        activities: { textscope: textscope.activityId, digitalLogic: digitalLogic.activityId },
      };
      writeJsonAtomic(envPaths.baselineFile, record, 0o644);
    } finally {
      await service.shutdown();
    }
    db.close();
    db = undefined;
    renameSync(seedingFile, envPaths.database);
    return { created: true, version: BASELINE_VERSION };
  } catch (error) {
    if (db) db.close();
    rmSync(seedingFile, { force: true });
    rmSync(seedingFile + '-wal', { force: true });
    rmSync(seedingFile + '-shm', { force: true });
    throw new CliError('baseline', 'BASELINE_FAILED',
      `最小基线构造失败：${error && error.message || error}`,
      { retryable: true, recovery: '重试 xj-dev up；曾成功登记的环境可显式 xj-dev delete 后 up，无有效登记时保留现场检查。' });
  }
}
