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
  const record = JSON.parse(readFileSync(envPaths.baselineFile, 'utf8'));
  if (!Array.isArray(record.accounts) || record.accounts.some(a => typeof a.loginName !== 'string' || !['teacher', 'student'].includes(a.role))) {
    throw new CliError('baseline', 'BASELINE_MARKER_INVALID', '基线账号标记无效。', { recovery: '检查 data/baseline.json，不覆盖已有数据。' });
  }
  return record.accounts;
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
    if (!existsSync(envPaths.baselineFile)) {
      throw new CliError('baseline', 'BASELINE_MARKER_MISSING',
        '数据库已存在但缺少基线标记（data/baseline.json），无法确认该数据的基线版本与归属。',
        { recovery: '保留现场；有有效环境登记时显式 xj-dev delete 后 up 重新建立基线，无有效登记时先检查归属，不手工删除环境根或永久锁。' });
    }
    const record = JSON.parse(readFileSync(envPaths.baselineFile, 'utf8'));
    return { created: false, version: record.version };
  }
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
  const credentials = baselineAccounts.map(account => ({ ...account, password: randomBytes(12).toString('hex') }));
  const versions = { modelConfig: 'unconfigured', prompt: 'unconfigured', schema: 'unconfigured', policy: 'unconfigured' };
  const node = support.syntheticNode();
  const cNode = support.controlledRunner();
  let db;
  try {
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
    writeJsonAtomic(envPaths.baselineCredentials,
      credentials.map(({ loginName, role, password }) => ({ loginName, role, password })));
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
