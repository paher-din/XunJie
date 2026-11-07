import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname, release, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

// #212 cross-machine recovery: Windows independent Agent side (source and target co-located).
// The school receiver stays on the Mac; fencing reaches it through the formal SSH adapter while
// student and dependency traffic use direct LAN HTTPS. Only the external model transport is controlled.
const run = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
for (const required of ['phase', 'config', 'out']) assert.ok(args[required], `missing --${required}`);
const config = JSON.parse(await readFile(resolve(args.config), 'utf8'));
const product = resolve(config.product), root = resolve(config.root), targetRoot = resolve(config.targetRoot);
const node = join(product, 'resources/node/node.exe'), cli = join(product, 'app/cli.js');
process.env.NODE_EXTRA_CA_CERTS = resolve(config.caFile);
let sequence = 0;
async function cliCommand(operation, { input, root: selectedRoot = root, out, serviceId, config: isConfig } = {}) {
  const argv = [cli, operation, '--root', selectedRoot, '--json'];
  if (input !== undefined) {
    const file = join(resolve(config.work), `agent-input-${sequence++}.json`);
    await writeFile(file, JSON.stringify(input), { mode: 0o600 });
    argv.push(isConfig ? '--config' : '--file', file);
  }
  if (out !== undefined) argv.push('--out', resolve(out));
  if (serviceId !== undefined) argv.push('--service-id', serviceId);
  const result = await run(node, argv, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}
const report = { kind: 'cross-machine-recovery-agent', phase: args.phase, measuredAt: new Date().toISOString(),
  host: { hostname: hostname(), platform: platform(), arch: arch(), os: release(), node: process.version },
  checks: [], facts: {}, status: 'running' };
const pass = (name, detail) => { report.checks.push({ name, detail }); console.log('PASS ' + name); };
const agentDescriptor = environment => environment.services.find(service => service.unit === 'teaching-agent');
try {
  if (args.phase === 'setup') {
    await cliCommand('install', { config: true, input: { profile: 'agent', host: '0.0.0.0', port: config.sourcePort, publicEndpoint: config.publicEndpoint,
      tls: { certificateFile: resolve(config.tlsCert), keyFile: resolve(config.tlsKey) }, agent: { dependencyConnectionId: config.dependencyConnectionId } } });
    const started = await cliCommand('start'); assert.ok(['ready', 'degraded'].includes(started.state), started.state);
    report.facts.environment = { environmentId: started.environment.environmentId, installationId: started.environment.installationId,
      profile: started.environment.profile, services: started.environment.services.map(s => ({ unit: s.unit, serviceId: s.serviceId })) };
    report.facts.agent = agentDescriptor(started.environment);
    report.facts.endpoint = started.endpoint;
    pass('the Windows independent Agent installed and started with a stable public HTTPS endpoint', report.facts.endpoint);
  } else if (args.phase === 'authorize-inbound') {
    const grant = await cliCommand('authorize', { out: config.inboundTokenFile, serviceId: report.facts.agent?.serviceId ?? config.agentServiceId,
      input: { sourceEnvironmentId: config.school.environmentId, sourceServiceId: config.school.learningDataServiceId,
        sourceInstallationId: config.school.installationId, capabilities: ['teaching.agent'] } });
    report.facts.grantId = grant.grantId;
    pass('the Agent authorized the school learning-data owner for teaching.agent', grant.grantId);
  } else if (args.phase === 'connect-dependency') {
    const grant = JSON.parse(await readFile(resolve(config.dependencyTokenFile), 'utf8'));
    const connection = { connectionId: config.dependencyConnectionId, sourceEnvironmentId: config.agentEnvironmentId,
      sourceServiceId: config.agentServiceId, target: config.school.learningDataDescriptor,
      requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [], credentialRef: 'cross-machine-dependencies' };
    await cliCommand('connect', { input: { token: grant.token, connection } });
    report.facts.connectionId = config.dependencyConnectionId;
    pass('the Agent connected to the Mac school learning-data owner over LAN HTTPS', config.dependencyConnectionId);
  } else if (args.phase === 'backup-restore') {
    const backup = await cliCommand('backup', { input: { directory: resolve(config.backupDirectory), keyFile: resolve(config.keyFile), leaveClosed: true } });
    report.facts.backup = { backupId: backup.backupId, boundaryAt: backup.boundaryAt };
    pass('the Agent produced a held formal backup', backup.backupId);
    const restored = await cliCommand('restore', { root: targetRoot, input: { backupDirectory: join(resolve(config.backupDirectory), backup.backupId),
      keyFile: resolve(config.keyFile), installation: { profile: 'agent', host: '0.0.0.0', port: config.targetPort, publicEndpoint: config.publicEndpoint,
        tls: { certificateFile: resolve(config.tlsCert), keyFile: resolve(config.tlsKey) }, agent: { dependencyConnectionId: config.dependencyConnectionId } } } });
    assert.equal(restored.phase, 'isolated');
    report.facts.target = { root: targetRoot, phase: restored.phase, backupId: restored.backupId };
    pass('the Agent target restores isolated read-only with the same fixed owner', report.facts.target);
  } else if (args.phase === 'takeover') {
    const receivers = [{ id: `${config.school.environmentId}/${config.school.learningDataServiceId}`, ssh: {
      configFile: resolve(config.ssh.configFile), host: config.ssh.host, nodePath: config.ssh.nodePath, cliPath: config.ssh.cliPath, root: config.ssh.root } }];
    const taken = await cliCommand('takeover', { root: targetRoot, input: { sourceRoot: root, receivers } });
    assert.equal(taken.phase, 'active');
    report.facts.takeover = taken;
    pass('the Agent target completed formal takeover with the remote Mac school SSH fence', taken);
    const stopped = await cliCommand('stop', { root }).catch(error => ({ error: error.message }));
    report.facts.sourceStop = stopped.state ?? stopped.error;
    const retired = await cliCommand('start', { root }).then(() => 'unexpected-start', error => error.message);
    report.facts.sourceRetired = retired;
    pass('the retired Agent source can no longer start', retired);
  } else if (args.phase === 'authorize-inbound-target') {
    const grant = await cliCommand('authorize', { root: targetRoot, out: config.targetInboundTokenFile, serviceId: config.agentServiceId,
      input: { sourceEnvironmentId: config.school.environmentId, sourceServiceId: config.school.learningDataServiceId,
        sourceInstallationId: config.school.installationId, capabilities: ['teaching.agent'] } });
    report.facts.grantId = grant.grantId;
    pass('the Agent target re-authorized the school for teaching.agent', grant.grantId);
  } else if (args.phase === 'reconnect-dependency') {
    const grant = JSON.parse(await readFile(resolve(config.freshDependencyTokenFile), 'utf8'));
    const connection = { connectionId: config.dependencyConnectionId, sourceEnvironmentId: config.agentEnvironmentId,
      sourceServiceId: config.agentServiceId, target: config.school.learningDataDescriptor,
      requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [], credentialRef: 'cross-machine-dependencies-restored' };
    await cliCommand('connect', { root: targetRoot, input: { token: grant.token, connection } });
    pass('the Agent target registered its rotated private dependency credential over HTTPS', config.dependencyConnectionId);
  } else throw new Error('unknown phase ' + args.phase);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.message; process.exitCode = 1; }
await writeFile(resolve(args.out), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ phase: args.phase, status: report.status }));