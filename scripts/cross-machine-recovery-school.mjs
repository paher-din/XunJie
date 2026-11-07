import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname, release, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// #212 cross-machine recovery: Mac school side. Installs the real darwin-arm64 package,
// prepares member/course/model facts, and performs the school-profile backup/restore/takeover.
// Only the external model transport is controlled; student traffic stays on direct LAN HTTPS.
const run = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
for (const required of ['phase', 'product', 'root', 'config', 'out']) assert.ok(args[required], `missing --${required}`);
const product = resolve(args.product), root = resolve(args.root), output = resolve(args.out);
const config = JSON.parse(await readFile(resolve(args.config), 'utf8'));
const node = join(product, 'resources/node/bin/node'), cli = join(product, 'app/cli.js');
const { resolveCredential } = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
process.env.NODE_EXTRA_CA_CERTS = resolve(config.caFile);
let sequence = 0;
async function command(operation, input, extra = []) {
  const argv = [cli, operation, '--root', root, '--json', ...extra];
  if (input !== undefined) {
    const file = join(resolve(args.work ?? root + '-inputs'), `input-${sequence++}.json`);
    await writeFile(file, JSON.stringify(input), { mode: 0o600 }); argv.push(['install', 'prepare'].includes(operation) ? '--config' : '--file', file);
  }
  try {
    const result = await run(node, argv, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  } catch (error) {
    // The CLI exits 1 for a degraded/failed runtime state while still printing valid JSON status.
    if (error.stdout) { try { return JSON.parse(error.stdout); } catch { /* fall through */ } }
    throw error;
  }
}
const report = { kind: 'cross-machine-recovery-school', phase: args.phase, measuredAt: new Date().toISOString(),
  host: { hostname: hostname(), platform: platform(), arch: arch(), os: release() }, checks: [], facts: {} };
const pass = (name, detail) => { report.checks.push({ name, detail }); console.log('PASS ' + name); };
async function request(endpoint, route, body, headers = { 'x-xj-space': 'school' }) {
  const response = await fetch(new URL('/api/learning/' + route, endpoint), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  return { status: response.status, value, headers: response.headers };
}
try {
  if (args.phase === 'setup') {
    const installed = await command('install', { host: '0.0.0.0', port: config.port, publicEndpoint: config.endpoint,
      tls: { certificateFile: resolve(config.tlsCert), keyFile: resolve(config.tlsKey) } }, ['--profile', 'school']);
    const started = await command('start');
    assert.equal(started.state, 'ready');
    report.facts.endpoint = started.endpoint;
    report.facts.environment = { environmentId: started.environment.environmentId, installationId: started.environment.installationId,
      profile: started.environment.profile, services: started.environment.services.map(s => ({ unit: s.unit, serviceId: s.serviceId })) };
    pass('the Mac school installed and started from the real darwin-arm64 package over LAN HTTPS', started.endpoint);
    const token = await resolveCredential(root, 'control');
    const admin = { authorization: `Bearer ${token}`, 'x-xj-space': 'school' };
    const api = async (route, body, headers = admin) => {
      const result = await request(config.endpoint, route, body, headers);
      assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.value)); return result.value;
    };
    const member = await api('manage/members', { requestId: randomUUID(), loginName: config.loginName, password: config.password });
    const connectionId = randomUUID();
    const model = await api('manage/model-default', { requestId: randomUUID(), expectedVersion: 0, connectionId,
      name: '跨机恢复验收', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${config.modelPort}/v1`, path: '/chat/completions',
      modelId: 'fixture-cross-machine-recovery', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-cross-machine-key' },
      policy: { checksAllowed: false, maxChecksPerHour: 1, maxOutputTokens: 2048, timeoutMs: 30000 } });
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
      course: { courseId, name: 'WP07 跨机学习对话恢复' }, task: { taskId, title: '核对跨机备份恢复与原问题回应', summary: '' },
      release: { releaseId, helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
        objectives: ['核对真实跨机恢复'], requirements: '保留原对话事实，按明确回应继续。', starterWorks: [], capabilities: [],
        components: [], materials: [] }, resources: [] });
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true });
    const login = await request(config.endpoint, 'login', { loginName: config.loginName, password: config.password }, {});
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    const activity = await api('course-activities', { requestId: randomUUID(), releaseId }, { cookie, 'x-xj-space': 'school' });
    report.facts.member = { loginName: config.loginName, principalId: member.principalId, spaceId: activity.identity.spaceId };
    report.facts.model = { connectionId, version: model.connection.version };
    report.facts.course = { courseId, releaseId, activityId: activity.activityId };
    report.facts.activity = activity;
    const distribution = JSON.parse(await readFile(join(product, 'distribution.json'), 'utf8'));
    report.facts.package = { distributionSha256: createHash('sha256').update(await readFile(join(product, 'distribution.json'))).digest('hex'),
      createdAt: distribution.createdAt, platform: distribution.platform };
    pass('the school holds the real member, course, activity and controlled model facts', report.facts.course);
  } else if (args.phase === 'backup-restore') {
    const keyFile = resolve(config.keyFile);
    const backup = await command('backup', { directory: resolve(config.backupDirectory), keyFile, leaveClosed: true });
    report.facts.backup = { backupId: backup.backupId, boundaryAt: backup.boundaryAt,
      services: backup.boundary.services.map(s => ({ kind: s.kind, serviceId: s.serviceId })) };
    pass('the school produced a held formal backup with owner boundary material', report.facts.backup);
    const targetRoot = resolve(config.targetRoot);
    const targetCli = async (operation, input, extra = []) => {
      const argv = [cli, operation, '--root', targetRoot, '--json', ...extra];
      if (input !== undefined) {
        const file = join(resolve(args.work ?? root + '-inputs'), `target-input-${sequence++}.json`);
        await writeFile(file, JSON.stringify(input), { mode: 0o600 }); argv.push('--file', file);
      }
      return JSON.parse((await run(node, argv, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 })).stdout);
    };
    const restored = await targetCli('restore', { backupDirectory: join(resolve(config.backupDirectory), backup.backupId), keyFile,
      installation: { profile: 'school', host: '0.0.0.0', port: config.targetPort, publicEndpoint: config.targetEndpoint,
        tls: { certificateFile: resolve(config.tlsCert), keyFile: resolve(config.tlsKey) } } });
    assert.equal(restored.phase, 'isolated');
    const isolated = await targetCli('start'); assert.equal(isolated.state, 'maintenance');
    report.facts.target = { root: targetRoot, endpoint: isolated.endpoint, state: isolated.state,
      installationId: isolated.environment.installationId };
    pass('the isolated school target restores read-only on a separate HTTPS port', report.facts.target);
  } else if (args.phase === 'takeover') {
    const targetRoot = resolve(config.targetRoot);
    const argv = [cli, 'takeover', '--root', targetRoot, '--json', '--file', resolve(config.takeoverInput)];
    const taken = JSON.parse((await run(node, argv, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 })).stdout);
    assert.equal(taken.phase, 'active');
    report.facts.takeover = taken;
    pass('the school target completed formal takeover', taken);
    const sourceStatus = await command('status').catch(error => ({ error: error.message }));
    report.facts.sourceAfter = sourceStatus.error ?? sourceStatus.state;
  } else if (args.phase === 'new-activity') {
    const status = await command('status');
    const learning = status.environment.services.find(service => service.unit === 'learning-data');
    const login = await request(status.endpoint, 'login', { loginName: config.loginName, password: config.password }, {});
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    const context = await (async () => {
      const result = await request(status.endpoint, 'context', undefined, { cookie, 'x-xj-space': 'school' });
      assert.equal(result.status, 200); return result.value;
    })();
    const activity = await (async () => {
      const result = await request(status.endpoint, 'course-activities', { requestId: randomUUID(), releaseId: config.releaseId },
        { cookie, 'x-xj-space': 'school', 'x-xj-namespace': context.clientNamespace });
      assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value;
    })();
    report.facts = { endpoint: status.endpoint, schoolEnvironmentId: status.environment.environmentId,
      schoolInstallationId: status.environment.installationId, learningDataDescriptor: learning, activity };
    pass('the active school prepared a fresh course activity for the independent Agent scenario', activity.activityId);
  } else if (args.phase === 'hybrid-member') {
    const status = await command('status');
    const token = await resolveCredential(root, 'control');
    const admin = { authorization: `Bearer ${token}`, 'x-xj-space': 'school' };
    const api = async (route, body) => {
      const result = await request(status.endpoint, route, body, admin);
      assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.value)); return result.value;
    };
    const member = await api('manage/members', { requestId: randomUUID(), loginName: config.loginName,
      password: config.password, target: config.deviceTarget });
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
      course: { courseId, name: 'WP07 跨机混合学习对话恢复' }, task: { taskId, title: '核对混合跨机备份恢复与原问题回应', summary: '' },
      release: { releaseId, helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
        objectives: ['核对真实混合跨机恢复'], requirements: '保留原对话事实，按明确回应继续。', starterWorks: [], capabilities: [],
        components: [], materials: [] }, resources: [] });
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true });
    report.facts = { endpoint: status.endpoint, member, clientService: status.environment.services[0],
      schoolEnvironmentId: status.environment.environmentId, course: { courseId, releaseId } };
    pass('the school registered a hybrid member bound to the Windows device learning-data owner with a course', member.principalId);
  } else if (args.phase === 'hybrid-approve') {
    const status = await command('status');
    const login = await request(status.endpoint, 'login', { loginName: config.loginName, password: config.password }, {});
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    const approve = await request(status.endpoint, 'connections/approve', { requestId: config.requestId }, { cookie, 'x-xj-space': 'school' });
    assert.equal(approve.status, 200, JSON.stringify(approve.value));
    const grant = await command('authorize', { sourceEnvironmentId: config.deviceTarget.environmentId, sourceServiceId: config.deviceTarget.serviceId,
      sourceInstallationId: config.deviceInstallationId, capabilities: ['learning.authority'] },
      ['--out', resolve(config.authorityTokenOut), '--service-id', status.environment.services[0].serviceId]);
    report.facts = { approved: true, grantId: grant.grantId, clientServiceId: status.environment.services[0].serviceId };
    pass('the school approved the device pairing and authorized learning.authority for the device installation', grant.grantId);
  } else if (args.phase === 'hybrid-rebind') {
    const status = await command('status');
    const grant = await command('authorize', { sourceEnvironmentId: config.deviceTarget.environmentId, sourceServiceId: config.deviceTarget.serviceId,
      sourceInstallationId: config.deviceTargetInstallationId, capabilities: ['learning.authority'] },
      ['--out', resolve(config.authorityTokenOut), '--service-id', status.environment.services[0].serviceId]);
    report.facts = { grantId: grant.grantId, clientServiceId: status.environment.services[0].serviceId };
    pass('the school re-authorized learning.authority for the successor device installation', grant.grantId);
  } else if (args.phase === 'bind-activity') {
    await command('agent-binding', { requestId: randomUUID(), identity: config.activity.identity, connectionId: config.schoolConnectionId,
      target: config.agentDescriptor, installationId: config.agentInstallationId });
    report.facts = { activityId: config.activity.activityId, connectionId: config.schoolConnectionId };
    pass('the school bound a fresh course activity to the existing independent Agent connection', config.activity.activityId);
  } else if (args.phase === 'agent-bind' || args.phase === 'agent-rebind') {
    const rebind = args.phase === 'agent-rebind';
    const status = await command('status');
    const schoolEnv = status.environment.environmentId;
    const learning = status.environment.services.find(service => service.unit === 'learning-data');
    const agentDescriptor = rebind ? config.targetAgentDescriptor : config.agentDescriptor;
    const agentInstallationId = rebind ? config.targetInstallationId : config.agentInstallationId;
    const tokenFile = rebind ? config.freshInboundTokenFile : config.inboundTokenFile;
    const inbound = JSON.parse(await readFile(resolve(tokenFile), 'utf8'));
    const connection = { connectionId: config.schoolConnectionId, sourceEnvironmentId: schoolEnv, sourceServiceId: learning.serviceId,
      target: agentDescriptor, requiredCapabilities: ['teaching.agent'], optionalCapabilities: [],
      credentialRef: rebind ? 'cross-machine-agent-restored' : 'cross-machine-agent' };
    await command(rebind ? 'reconnect' : 'connect', { token: inbound.token, connection });
    pass(rebind ? 'the school reconnected to the Agent target with a rotated credential over HTTPS'
      : 'the school connected to the Windows independent Agent over LAN HTTPS', config.schoolConnectionId);
    if (!rebind) {
      await command('agent-binding', { requestId: randomUUID(), identity: config.activity.identity, connectionId: config.schoolConnectionId,
        target: agentDescriptor, installationId: agentInstallationId });
      pass('the school bound the course activity to the independent Agent connection', config.activity.activityId);
    }
    const grant = await command('authorize', { sourceEnvironmentId: config.agentEnvironmentId, sourceServiceId: config.agentServiceId,
      sourceInstallationId: agentInstallationId, capabilities: ['teaching.dependencies'] },
      ['--out', resolve(config.dependencyTokenOut), '--service-id', learning.serviceId]);
    report.facts = { schoolConnectionId: config.schoolConnectionId, dependencyGrantId: grant.grantId,
      learningDataServiceId: learning.serviceId, schoolEnvironmentId: schoolEnv, agentInstallationId };
    pass('the school authorized the Agent installation for teaching.dependencies', grant.grantId);
  } else throw new Error('unknown phase ' + args.phase);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.message; process.exitCode = 1; }
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ phase: args.phase, status: report.status }));