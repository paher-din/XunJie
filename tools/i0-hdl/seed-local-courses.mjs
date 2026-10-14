import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const origin = 'https://127.0.0.1:3444';
const sourceHash = '7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852';
const certificateSha256 = '8d663b4dba93b1fb61df544fe3fe17022e561d88a559576381abf1220b3ac52e';
const teacherId = 'synthetic-robert-teacher';
const coursePlans = [
  { kind: 'textscope', courseId: 'synthetic-robert-course-c', studentId: 'synthetic-robert-student-a',
    title: 'TextScope Core 本机合成工程验证', domain: '解释文本统计规则', artifact: 'C 源码、真实输出与核查记录' },
  { kind: 'hdl_board', courseId: 'synthetic-robert-course-hdl', studentId: 'synthetic-robert-student-b',
    title: 'HDL 板卡本机合成工程验证', domain: '解释输入、四态信号与有限 Trace', artifact: 'HDL 源码、真实输出与核查记录' },
];
const referencePath = 'docs/tasks/evidence/dla-continuation-20261014/real-hdl-final-frozen.json';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const marker = 'xunjie-robert-local-course-seed-v1';
const digest = value => createHash('sha256').update(value).digest('hex');
function requireCondition(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
function selectedPlans(fullInputs) {
  return fullInputs ? coursePlans.filter(item => item.kind === 'hdl_board').map(item => ({ ...item, title: 'HDL 全输入本机合成工程补充验证' })) : coursePlans;
}

/** Extra immutable mapping for an explicit local synthetic supplement; original template remains unchanged. */
export function localHdlConfiguration(template, runtime, fullInputs = false) {
  if (!fullInputs) return { ...template, versionId: 'synthetic-robert-hdl-config-v1', runtime };
  requireCondition(!template.board.bindings.some(binding => binding.signal === 'resetN'), 'FULL_INPUT_TEMPLATE_ALREADY_BOUND');
  const board = structuredClone(template.board);
  board.mappingVersion = 'synthetic-robert-full-input-mapping-v1';
  board.bindings.push({ signal: 'resetN', offset: 0, port: 'rst_n', portOffset: 0, width: 1 });
  return { ...template, versionId: 'synthetic-robert-hdl-full-input-config-v1', board, runtime };
}

function parseArgs(args) {
  const options = { apply: false, createAttempts: false, fullInputs: false, config: '/opt/xunjie-ui-local/course-seed-config.json' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--create-attempts') options.createAttempts = true;
    else if (arg === '--full-inputs') options.fullInputs = true;
    else if (arg === '--help') options.help = true;
    else if (['--teaching-root', '--config', '--output'].includes(arg)) {
      requireCondition(args[index + 1] && !args[index + 1].startsWith('--'), 'MISSING_ARGUMENT');
      options[({ '--teaching-root': 'teachingRoot', '--config': 'config', '--output': 'output' })[arg]] = args[++index];
    } else throw Object.assign(new Error('UNKNOWN_ARGUMENT'), { code: 'UNKNOWN_ARGUMENT' });
  }
  if (!options.help) {
    requireCondition(options.teachingRoot && isAbsolute(options.teachingRoot), 'ABSOLUTE_TEACHING_ROOT_REQUIRED');
    requireCondition(isAbsolute(options.config), 'ABSOLUTE_CONFIG_REQUIRED');
    requireCondition(!options.output || isAbsolute(options.output), 'ABSOLUTE_OUTPUT_REQUIRED');
    requireCondition(!options.apply || options.output, 'APPLY_OUTPUT_REQUIRED');
  }
  return options;
}

/** Default plan deliberately does not open configuration, initializer or network. */
export function dryPlan(teachingRoot, fullInputs = false) {
  return { marker, mode: 'dry-plan', origin, teachingRoot, credentialsRead: false, networkRequests: 0,
    writesPerformed: false, supplement: fullInputs ? 'new-immutable-hdl-full-inputs' : 'none',
    courses: selectedPlans(fullInputs).map(({ kind, courseId, studentId, title }) => ({ kind, courseId, studentId, title })),
    teacherId, hdlReference: referencePath, frozenExecutionSourceHash: sourceHash,
    ...(fullInputs ? { configurationVersionId: 'synthetic-robert-hdl-full-input-config-v1', mappingVersion: 'synthetic-robert-full-input-mapping-v1',
      topModule: 'top', requiredExtraTopInput: 'input rst_n', extraBinding: { signal: 'resetN', offset: 0, port: 'rst_n', portOffset: 0, width: 1 },
      existingActivity: 'retained; no replacement', checkpoint: 'Use a separate --output; the original receipt cannot be reused for this supplement.' } : {}),
    chain: ['normal teacher login', 'explicit public resource', 'HDL configuration registration', 'manual blueprint',
      'current runtime checks', 'confirmed release', 'student assignment', 'normal student bootstrap'],
    optional: '--create-attempts performs one explicit original attempt.create as each assigned synthetic student; does not create files or run programs',
    sampleRun: { status: 'not-executed', reason: 'The original HTTP host has no teacher sample-run route; node acceptance and subsequent browser runs are separate evidence.' },
    limits: ['No teacher model request', 'No direct SQL mutation', 'No PAHER connection', 'No prepared-service fallback',
      fullInputs ? 'Only new immutable synthetic mapping binds rst_n; preserve original activities, runtime and limits'
        : 'Preserve original board mapping, optional unbound reset and runtime limits', 'No claim of ALU behavior, teacher semantics or learning effect'] };
}

function privateJson(path) {
  requireCondition(isAbsolute(path), 'ABSOLUTE_INPUT_REQUIRED');
  const stat = lstatSync(path);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, 'CONTROLLED_FILE_REQUIRED');
  requireCondition(process.platform === 'win32' || (stat.mode & 0o077) === 0, 'PRIVATE_FILE_MODE_REQUIRED');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function checkpointWriter(output, context) {
  const parent = lstatSync(dirname(output));
  requireCondition(parent.isDirectory() && !parent.isSymbolicLink(), 'OUTPUT_DIRECTORY_REQUIRED');
  let checkpoint = { marker, context, status: 'running', startedAt: new Date().toISOString(), commands: {}, reads: [], courses: [] };
  if (existsSync(output)) {
    checkpoint = privateJson(output);
    requireCondition(checkpoint.marker === marker && JSON.stringify(checkpoint.context) === JSON.stringify(context), 'CHECKPOINT_SCOPE_MISMATCH');
    requireCondition(checkpoint.commands && Array.isArray(checkpoint.reads) && Array.isArray(checkpoint.courses), 'INVALID_CHECKPOINT');
  }
  checkpoint.failureHistory ??= [];
  if (checkpoint.status === 'stopped' && checkpoint.failure && !checkpoint.failureHistory.some(item => item.readCount === checkpoint.reads.length)) {
    checkpoint.failureHistory.push({ ...checkpoint.failure, readCount: checkpoint.reads.length, retainedAt: new Date().toISOString(), beforeReplay: true });
  }
  checkpoint.status = 'running';
  const save = () => {
    // Only a previously verified owned checkpoint may be replaced; output contains no authentication material.
    if (existsSync(output)) requireCondition(lstatSync(output).isFile() && !lstatSync(output).isSymbolicLink(), 'OUTPUT_FILE_CHANGED');
    const temporary = output + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(checkpoint, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, output);
  };
  save();
  return { checkpoint, save };
}

/** Validate original normal-host completion identity and hash; no flattened legacy receipt fallback. */
export function verifyCompletionReceipt(receipt, expectedIdentity, fields, original, validateResult) {
  requireCondition(receipt && typeof receipt === 'object' && Object.hasOwn(receipt, 'result'), 'COMMAND_RECEIPT_REQUIRED');
  let identity;
  try { identity = original.readCommandIdentity(receipt.identity); }
  catch { throw Object.assign(new Error('COMMAND_RECEIPT_IDENTITY_REQUIRED'), { code: 'COMMAND_RECEIPT_IDENTITY_REQUIRED' }); }
  requireCondition(original.canonical(identity) === original.canonical(expectedIdentity), 'COMMAND_RECEIPT_SCOPE_MISMATCH');
  requireCondition(receipt.requestHash === original.requestHash(expectedIdentity.target, fields), 'COMMAND_RECEIPT_HASH_MISMATCH');
  requireCondition(typeof receipt.commandId === 'string' && receipt.commandId.length > 0
    && typeof receipt.receiptId === 'string' && receipt.receiptId.length > 0
    && Number.isSafeInteger(receipt.serverSeq) && receipt.serverSeq > 0
    && typeof receipt.committedAt === 'string' && Number.isFinite(Date.parse(receipt.committedAt)), 'COMMAND_RECEIPT_METADATA_REQUIRED');
  return { commandId: receipt.commandId, receiptId: receipt.receiptId, identity, requestHash: receipt.requestHash,
    serverSeq: receipt.serverSeq, committedAt: receipt.committedAt, result: validateResult(receipt.result) };
}
export function publicBlueprint(item, runtimeVersion, resourceVersionId, hdlVersion) {
  const goals = [
    { competencyId: item.courseId + '-domain', competencyVersion: 1, domain: 'domain', title: item.domain },
    { competencyId: item.courseId + '-project', competencyVersion: 1, domain: 'project', title: '比较路径并保存可复现证据' },
    { competencyId: item.courseId + '-ai', competencyVersion: 1, domain: 'ai_collaboration', title: '依据真实诊断核对辅导建议' },
  ];
  const goalRefs = goals.map(({ competencyId, competencyVersion }) => ({ competencyId, competencyVersion }));
  return { projectTitle: item.title, problem: '通过自行编辑、保存、运行和修订，核对真实结果及仍然未知的部分。',
    audience: '隔离合成工程验收账号', artifact: item.artifact, studentBackground: '合成工程验证，不代表真实学生',
    timeConstraints: '工程验收，学习负荷未验证', routes: ['先观察失败诊断再修订', '先核对输入输出再比较'], goals,
    tasks: [{ taskId: 'verify', title: '自行核对真实输入、诊断与输出', goalRefs }],
    observations: [{ observationId: 'explain', description: '用实际保存版本和真实输出解释已知与未知', goalRefs, taskIds: ['verify'] }],
    rubricCriteria: [{ criterionId: 'evidence', description: '解释对应快照的诊断与结果，保留未知和验证边界', goalRefs, observationIds: ['explain'] }],
    milestones: [{ milestoneId: 'review', title: '核对并保存结果', taskIds: ['verify'] }], resources: [{ resourceVersionId }],
    helpPolicyVersionId: item.courseId + '-help', checkRuleVersionId: item.kind === 'hdl_board' ? 'hdl-board-structure-v1' : 'textscope-core-v1',
    runtimeProfileVersionId: runtimeVersion, ...(hdlVersion ? { digitalLogicConfigVersionId: hdlVersion } : {}) };
}
function publicMaterial(item, configuration) {
  const reset = configuration.board.bindings.some(binding => binding.signal === 'resetN')
    ? '本补充配置新增 resetN→rst_n 宽度1，低有效；自己的 top 模块必须声明 input rst_n，并在源码中明确实现复位行为。这里只核绑定结构，不证明源码复位语义或实际浏览器复位通过。'
    : 'resetN 未绑定，应显示不可用。';
  const details = item.kind === 'hdl_board'
    ? `HDL 使用公开 Nexys4 DDR 板卡绑定，topModule=${configuration.board.topModule}。16 SW、5 BTN；LED 高有效，AN/SEG/DP 低有效；四态 X/Z 保留。${reset}ALU 结构域与 SW 映射见活动固定配置；结构校验不证明 ALU 行为。`
    : '使用原 TextScope Core 检查规则；通过 C 文件编辑、保存、快照与正常运行核对实际诊断和结果。';
  return { format: 'markdown', title: item.title + '公开说明', kind: 'learning_material', visibility: { student: true, tutor: true },
    content: `# ${item.title}\n\n本资料仅用于获准的本机合成工程验收，未含教师私有答案。\n\n${details}\n\n先创建自己的源码并保存，显式选择对应快照再构建或运行。HDL 仅装载自己明确选择的成功 Build，输入必须等确认后再修改；停止需核对 terminationConfirmed。求助需显式引用同一快照的真实诊断；建议不代替自己的核查。\n\n本工具未执行教师 sample-run；实际程序执行、模型正文与 displayed/ack、浏览器验收由后续原流程分别记录。\n` };
}

async function apply(options) {
  requireCondition(process.platform === 'linux' && process.getuid?.() === 0 && process.version === 'v24.21.0', 'LOCAL_ROOT_NODE_24_21_REQUIRED');
  const load = path => import(pathToFileURL(join(options.teachingRoot, path)).href);
  const [{ readApplicationConfig, readControlledJson }, { syntheticManifestSchema }, { availableRuntime },
    { availableHdlRuntime }, { hdlConfigurationSchema }, contracts, { canonical, requestHash }, { readCommandIdentity }] = await Promise.all([
    load('server/app/config.ts'), load('server/app/initialize.ts'), load('server/design/readiness.ts'),
    load('server/design/hdl-configurations.ts'), load('contracts/design/hdl.ts'), load('contracts/design/index.ts'), load('server/records/commands.ts'), load('server/db/records-adapter.ts'),
  ]);
  const cli = privateJson(options.config);
  requireCondition(Object.keys(cli).every(key => ['applicationConfigFile', 'initializerFile', 'readinessFile'].includes(key)), 'INVALID_SEED_CONFIG');
  const application = readApplicationConfig(cli.applicationConfigFile);
  requireCondition(application.origin === origin && application.ssh.host === '127.0.0.1' && application.ssh.port === 2222, 'LOCAL_APPLICATION_ONLY');
  const manifest = syntheticManifestSchema.parse(privateJson(cli.initializerFile));
  requireCondition(manifest.accounts.length === 3 && manifest.courses.length === 2
    && manifest.accounts.every(account => [teacherId, ...coursePlans.map(item => item.studentId)].includes(account.id))
    && coursePlans.every(item => manifest.courses.includes(item.courseId)), 'SYNTHETIC_ROBERT_SCOPE_REQUIRED');
  const readiness = readControlledJson(cli.readinessFile);
  const c = await availableRuntime(async () => readiness.runner);
  const h = await availableHdlRuntime(async () => readiness.hdl, application.approvedHdlRuntimes);
  requireCondition(c && h && c.recoveryGeneration === h.recoveryGeneration && manifest.recoveryGeneration === h.recoveryGeneration
    && application.recoveryGeneration === h.recoveryGeneration && readiness.recoveryGeneration === h.recoveryGeneration, 'CURRENT_GENERATION_REQUIRED');
  requireCondition(c.readiness.sourceHash === sourceHash && h.readiness.sourceHash === sourceHash, 'FROZEN_SOURCE_REQUIRED');
  if (readiness.approvedHdlRuntime) requireCondition(canonical(readiness.approvedHdlRuntime) === canonical(h.profile), 'APPROVED_RUNTIME_MISMATCH');
  for (const item of coursePlans) requireCondition(manifest.memberships.some(member => member.courseId === item.courseId && member.userId === teacherId && member.role === 'teacher')
    && manifest.memberships.some(member => member.courseId === item.courseId && member.userId === item.studentId && member.role === 'student'), 'MEMBERSHIP_SCOPE_MISMATCH');
  const publicReference = JSON.parse(readFileSync(join(repository, referencePath), 'utf8'));
  const template = publicReference.http.find(item => item.path.endsWith('/hdl-configurations') && item.status === 200)?.body.data.result.configuration;
  requireCondition(template, 'PUBLIC_HDL_REFERENCE_REQUIRED');
  const plans = selectedPlans(options.fullInputs);
  const configuration = hdlConfigurationSchema.parse(localHdlConfiguration(template, h.profile, options.fullInputs));
  const materials = plans.map(item => publicMaterial(item, configuration));
  const bundleHash = digest(canonical({ configuration, materials, plans }));
  const cert = readFileSync(application.tls.certFile);
  const certificate = new X509Certificate(cert);
  requireCondition(certificate.fingerprint256.replaceAll(':', '').toLowerCase() === certificateSha256 && certificate.checkIP('127.0.0.1'), 'APPROVED_LOCAL_TLS_REQUIRED');
  const { checkpoint, save } = checkpointWriter(options.output, { origin, databaseFile: application.databaseFile,
    recoveryGeneration: h.recoveryGeneration, bundleHash, createAttempts: options.createAttempts, ...(options.fullInputs ? { fullInputs: true } : {}) });
  checkpoint.readiness = { c: { profile: c.profile, ...c.readiness }, hdl: { profile: h.profile, ...h.readiness },
    validationBoundary: 'Local receipt consistency checked; original teacher checks/releases probe current authenticated runtime again.' };
  checkpoint.executionSourceHash = sourceHash;
  checkpoint.boundaries = dryPlan(options.teachingRoot, options.fullInputs).limits;
  checkpoint.teacherSampleRun = dryPlan(options.teachingRoot, options.fullInputs).sampleRun;
  checkpoint.supplement = options.fullInputs ? 'new-immutable-hdl-full-inputs' : 'none';
  const sessions = [];
  async function http(method, path, payload, session, key) {
    requireCondition(path.startsWith('/') && !path.startsWith('//'), 'RELATIVE_LOCAL_PATH_REQUIRED');
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const startedAt = new Date().toISOString();
    return new Promise((resolveResponse, reject) => {
      const req = httpsRequest(new URL(path, origin), { method, ca: cert, rejectUnauthorized: true,
        headers: { origin, ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          ...(key ? { 'idempotency-key': key } : {}) } }, response => {
        let text = ''; const authorized = response.socket.authorized === true;
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 2 * 1024 * 1024) req.destroy(Object.assign(new Error('RESPONSE_LIMIT'), { code: 'RESPONSE_LIMIT' })); });
        response.on('end', () => {
          try {
            requireCondition(authorized, 'STRICT_TLS_REQUIRED');
            const parsed = JSON.parse(text);
            const publicStatus = { method, path, status: response.statusCode, startedAt, endedAt: new Date().toISOString(),
              strictTls: authorized, ...(typeof parsed.requestId === 'string' ? { requestId: parsed.requestId } : {}) };
            if (path !== '/api/sessions' && path !== '/api/logout') { checkpoint.reads.push(publicStatus); save(); }
            if (response.statusCode !== 200) {
              const code = /^[A-Z0-9_]{1,64}$/.test(parsed.error?.code ?? '') ? parsed.error.code : 'HTTP_REJECTED';
              throw Object.assign(new Error(code), { code, status: response.statusCode, method, path });
            }
            resolveResponse({ data: parsed.data, headers: response.headers, publicStatus });
          } catch (error) { reject(error); }
        });
        response.on('error', () => reject(Object.assign(new Error('HTTPS_RESPONSE_FAILED'), { code: 'HTTPS_RESPONSE_FAILED' })));
      });
      req.setTimeout(15000, () => req.destroy(Object.assign(new Error('HTTPS_TIMEOUT'), { code: 'HTTPS_TIMEOUT' })));
      req.on('error', error => reject(Object.assign(new Error('HTTPS_REQUEST_FAILED'), { code: ['HTTPS_TIMEOUT', 'RESPONSE_LIMIT'].includes(error.code) ? error.code : 'HTTPS_REQUEST_FAILED' })));
      req.end(body);
    });
  }
  async function login(userId) {
    const account = manifest.accounts.find(account => account.id === userId);
    requireCondition(account, 'INITIALIZER_ACCOUNT_MISSING');
    const response = await http('POST', '/api/sessions', { loginName: account.loginName, password: account.password });
    const cookie = response.headers['set-cookie']?.map(value => value.split(';', 1)[0]).join('; ');
    requireCondition(cookie && typeof response.data?.csrfToken === 'string', 'SESSION_RESPONSE_REQUIRED');
    const session = { cookie, csrf: response.data.csrfToken, userId }; sessions.push(session); return session;
  }
  async function post(label, path, fields, session, validate, operation) {
    const payload = { recoveryGeneration: h.recoveryGeneration, ...fields };
    const payloadHash = digest(canonical(payload));
    let command = checkpoint.commands[label];
    if (command) requireCondition(command.path === path && command.payloadHash === payloadHash, 'ORIGINAL_COMMAND_MISMATCH');
    else { command = { path, payloadHash, idempotencyKey: randomUUID(), state: 'prepared' }; checkpoint.commands[label] = command; save(); }
    // Replays always use the persisted original key and payload; no blind new operation after a lost acknowledgement.
    const response = await http('POST', path, payload, session, command.idempotencyKey);
    const expectedIdentity = { actorId: session.userId, command: operation.command, target: operation.target,
      scope: { courseId: operation.courseId, ...(operation.studentId ? { studentId: operation.studentId } : {}) },
      idempotencyKey: command.idempotencyKey, recoveryGeneration: h.recoveryGeneration };
    const receipt = verifyCompletionReceipt(response.data, expectedIdentity, payload, { canonical, requestHash, readCommandIdentity }, validate);
    if (command.receipt) requireCondition(canonical(command.receipt) === canonical(receipt), 'ORIGINAL_RECEIPT_CHANGED');
    command.state = 'acknowledged'; command.receipt = receipt; command.executionSourceHash = sourceHash;
    save(); return receipt.result;
  }
  try {
    requireCondition((await http('GET', '/health/ready')).data?.status === 'ready', 'APPLICATION_NOT_READY');
    const teacher = await login(teacherId);
    const teacherCourses = (await http('GET', '/api/courses', undefined, teacher)).data;
    requireCondition(plans.every(item => teacherCourses.some(course => course.courseId === item.courseId && course.role === 'teacher')), 'TEACHER_COURSE_ACCESS_REQUIRED');
    for (let index = 0; index < plans.length; index++) {
      const item = plans[index], prefix = item.courseId, commandPrefix = prefix + (options.fullInputs ? '-full-inputs' : '');
      if (item.kind === 'hdl_board') await post(commandPrefix + '-configuration', `/api/courses/${prefix}/hdl-configurations`, { configuration }, teacher, value => {
        requireCondition(canonical(value.configuration) === canonical(configuration) && value.contentHash === digest(JSON.stringify(configuration)), 'CONFIGURATION_RECEIPT_MISMATCH'); return value;
      }, { command: 'hdl.configuration', target: prefix, courseId: prefix });
      const resource = await post(commandPrefix + '-resource', `/api/courses/${prefix}/resources`,
        { teacherDesignAllowed: true, material: materials[index] }, teacher, value => contracts.resultSchema.parse(value),
        { command: 'material.create', target: prefix, courseId: prefix }).then(value => {
          requireCondition(value.kind === 'material' && value.resourceVersion.courseId === prefix
            && value.resourceVersion.material.visibility.student && value.resourceVersion.material.visibility.tutor, 'PUBLIC_RESOURCE_REQUIRED'); return value.resourceVersion;
        });
      const content = contracts.contentPatchSchema.parse(publicBlueprint(item, item.kind === 'hdl_board' ? h.profile.runtimeProfileVersion : c.profile.runtimeProfileVersion,
        resource.resourceVersionId, item.kind === 'hdl_board' ? configuration.versionId : undefined));
      const draft = await post(commandPrefix + '-draft', `/api/courses/${prefix}/blueprints`, { mode: 'manual', content }, teacher, value => contracts.resultSchema.parse(value),
        { command: 'draft.create', target: prefix, courseId: prefix });
      requireCondition(draft.kind === 'draft' && draft.draft.courseId === prefix, 'DRAFT_SCOPE_REQUIRED');
      const { blueprintId, revision } = draft.draft;
      const checks = await post(commandPrefix + '-checks', `/api/blueprints/${blueprintId}/checks`, { expectedRevision: revision, concerns: [] }, teacher, value => contracts.resultSchema.parse(value),
        { command: 'draft.checks', target: blueprintId, courseId: prefix });
      requireCondition(checks.kind === 'checks' && checks.report.blocking.length === 0 && !checks.report.designConcerns.some(value => value.status === 'requires_teacher'), 'ORIGINAL_CHECKS_BLOCKED');
      if (item.kind === 'hdl_board') requireCondition(checks.report.execution?.kind === 'hdl_board' && checks.report.execution.structural === 'validated'
        && checks.report.execution.behavior === 'unverified', 'HDL_STRUCTURE_ONLY_REQUIRED');
      const released = await post(commandPrefix + '-release', `/api/blueprints/${blueprintId}/releases`,
        contracts.releaseSchema.parse({ expectedRevision: revision, confirmed: true, recoveryGeneration: h.recoveryGeneration, concerns: [] }), teacher,
        value => contracts.activityCommandResults['activity.release'].parse(value), { command: 'activity.release', target: blueprintId, courseId: prefix });
      const assigned = await post(commandPrefix + '-assign', `/api/activities/${released.activityVersionId}/assignments`,
        contracts.assignmentSchema.parse({ studentIds: [item.studentId], expectedActivityControlRevision: released.activityControlRevision, recoveryGeneration: h.recoveryGeneration }), teacher,
        value => contracts.activityCommandResults['assignment.create'].parse(value), { command: 'assignment.create', target: released.activityVersionId, courseId: prefix });
      requireCondition(assigned.assignments.length === 1 && assigned.assignments[0].studentId === item.studentId
        && assigned.assignments[0].activityVersionId === released.activityVersionId && assigned.assignments[0].status === 'active', 'ASSIGNMENT_SCOPE_REQUIRED');
      const assignmentId = assigned.assignments[0].assignmentId;
      const student = await login(item.studentId);
      const bootstrap = (await http('GET', `/api/assignments/${assignmentId}/bootstrap`, undefined, student)).data;
      requireCondition(bootstrap.recoveryGeneration === h.recoveryGeneration && bootstrap.assignment.assignmentId === assignmentId
        && bootstrap.assignment.studentId === item.studentId && bootstrap.assignment.active === true, 'STUDENT_BOOTSTRAP_REQUIRED');
      const record = { courseId: prefix, studentId: item.studentId, kind: item.kind, resourceVersionId: resource.resourceVersionId,
        ...(options.fullInputs ? { supplement: 'full-inputs', configurationVersionId: configuration.versionId, mappingVersion: configuration.board.mappingVersion } : {}),
        blueprintId, activityVersionId: released.activityVersionId, assignmentId, checks: checks.report, unverified: released.unverified,
        bootstrap: 'passed', browser: 'not-executed', programRuns: 'not-executed', modelCalls: 0 };
      if (options.createAttempts) {
        const attempt = await post(commandPrefix + '-attempt', `/api/assignments/${assignmentId}/attempts`, {}, student, value => {
          requireCondition(typeof value.attemptId === 'string' && value.assignmentId === assignmentId && value.activityVersionId === released.activityVersionId, 'ATTEMPT_SCOPE_REQUIRED'); return value;
        }, { command: 'attempt.create', target: assignmentId, courseId: prefix, studentId: item.studentId });
        record.attemptId = attempt.attemptId;
      }
      checkpoint.courses = checkpoint.courses.filter(course => course.courseId !== prefix).concat(record); save();
    }
    checkpoint.status = 'seeded'; checkpoint.completedAt = new Date().toISOString(); checkpoint.succeededAfterFailure = checkpoint.failureHistory.length > 0; save();
    return { status: checkpoint.status, output: options.output, courses: checkpoint.courses.map(({ courseId, kind, studentId, activityVersionId, assignmentId, attemptId }) =>
      ({ courseId, kind, studentId, activityVersionId, assignmentId, ...(attemptId ? { attemptId } : {}) })),
      browser: 'not-executed', teacherSampleRun: 'no-original-route', modelCalls: 0, aluBehavior: 'unverified' };
  } catch (error) {
    // No arbitrary upstream text, payload, initializer, authentication headers or stack enters output.
    checkpoint.status = 'stopped'; checkpoint.failure = { code: /^[A-Z0-9_]{1,64}$/.test(error.code ?? '') ? error.code : 'SEED_FAILED',
      ...(error.status ? { status: error.status } : {}), ...(error.path ? { path: error.path } : {}), failedAt: new Date().toISOString() };
    checkpoint.failureHistory.push({ ...checkpoint.failure, readCount: checkpoint.reads.length }); save();
    throw Object.assign(new Error(checkpoint.failure.code), { code: checkpoint.failure.code });
  } finally {
    for (const session of sessions) {
      try { await http('POST', '/api/logout', {}, session); } catch { /* Secrets remain in this process; no cleanup claim on failure. */ }
      session.cookie = ''; session.csrf = '';
    }
    for (const account of manifest.accounts) account.password = '';
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write('node seed-local-courses.mjs --teaching-root /absolute/apps/teaching [--config /absolute/course-seed-config.json] [--output /absolute/public-receipt.json] [--apply] [--create-attempts] [--full-inputs]\nDefault is a dry plan: no configuration/password reads or HTTP. --apply uses only strict https://127.0.0.1:3444 and original authenticated teacher/student APIs. --full-inputs adds a separate immutable HDL-only configuration/activity/assignment with resetN to rst_n and requires its own output checkpoint; original courses/activities remain. No credentials in arguments or output.\n');
    else process.stdout.write(JSON.stringify(options.apply ? await apply(options) : dryPlan(options.teachingRoot, options.fullInputs), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'stopped', code: /^[A-Z0-9_]{1,64}$/.test(error.code ?? '') ? error.code : 'SEED_FAILED' }) + '\n');
    process.exitCode = 1;
  }
}
