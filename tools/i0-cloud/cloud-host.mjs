import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// This entry composes the original application; it never initializes or migrates a database.
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1];
  if (!['--config', '--server-root', '--port', '--account-control'].includes(name) || !value || values.has(name)) {
    throw new Error('Use --config <controlled-file>, --server-root <release/apps/server>, and optional --port <loopback-port>, --account-control <private-file>.');
  }
  values.set(name, value);
}

let db, service, accessControl;
let closing;
const shutdown = () => closing ??= (async () => {
  try { await accessControl?.close(); }
  finally { try { await service?.shutdown(); } finally { db?.close(); } }
})();

try {
  if (process.platform !== 'linux' || process.version !== 'v24.21.0') {
    throw new Error('Linux Node24.21.0 required.');
  }
  const serverRoot = realpathSync(resolve(values.get('--server-root') ?? '/opt/xunjie/current/apps/server'));
  const configFile = resolve(values.get('--config') ?? '/etc/xunjie/application-config.json');
  const port = Number(values.get('--port') ?? 3444);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Valid loopback port required.');
  const load = relative => import(pathToFileURL(`${serverRoot}/${relative}`).href);
  const { readApplicationConfig, readI0SigningSecret } = await load('dist/server/app/config.js');
  const { openSyntheticDatabase } = await load('dist/server/db/transaction.js');
  const { executionTransports } = await load('dist/server/app/execution-transport.js');
  const { createDigitalLogicApplication } = await load('dist/server/app/digital-logic.js');
  const { registerDeploymentIdentity } = await load('dist/server/app/deployment-identity.js');
  const config = readApplicationConfig(configFile);
  const browserOrigin = new URL(config.origin);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(browserOrigin.hostname) || config.tutoring?.callsAuthorized ||
      config.tutoring?.apiKeyFile || !config.executionNodes || config.ssh) {
    throw new Error('Cloud shared configuration with registered execution nodes and disabled legacy model calls required.');
  }
  if (config.teacherDesign && !config.personalModels) {
    throw new Error('Teacher design approval requires the personal model store.');
  }
  const retained = dirname(dirname(config.databaseFile));
  if (retained !== '/var/lib/xunjie/retained-tmp') throw new Error('Cloud retained database path required.');
  process.env.TMPDIR = retained;
  db = openSyntheticDatabase(config.databaseFile);
  const generation = db.withTransaction(tx => tx.get('SELECT recovery_generation FROM application_control WHERE singleton=1'))?.recovery_generation;
  if (generation !== config.recoveryGeneration) throw new Error('Application recovery control mismatch.');
  const versions = { modelConfig: 'disabled', prompt: 'disabled', schema: 'disabled', policy: 'disabled' };
  const executionNodes = config.executionNodes.map(({ ssh, ...node }) => ({ ...node, ...executionTransports(ssh) }));
  if (values.has('--account-control')) {
    const { createLocalAccountControl } = await load('dist/server/access/account-control.js');
    accessControl = await createLocalAccountControl(resolve(values.get('--account-control')), { db, staticAllowed: config.allowedLoginUserIds });
  }
  service = await createDigitalLogicApplication({
    db, origin: config.origin, signingSecret: readI0SigningSecret(config.signingSecretFile),
    ...(config.allowedLoginUserIds ? { allowedLoginUserIds: config.allowedLoginUserIds } : {}),
    ...(accessControl ? { loginAuthorization: accessControl.loginAuthorization } : {}),
    https: { key: readFileSync(config.tls.keyFile), cert: readFileSync(config.tls.certFile) },
    executionNodes, ...(config.legacyExecutionNodeId ? { legacyExecutionNodeId: config.legacyExecutionNodeId } : {}),
    approvedHdlRuntimes: config.approvedHdlRuntimes,
    ...(config.staticDirectory ? { staticDirectory: config.staticDirectory } : {}),
    consumerIntervalMs: config.consumerIntervalMs, logDestination: process.stdout,
    ...(config.personalModels ? { personalModels: config.personalModels } : {}),
    ...(config.teacherDesign ? { teacherDesign: config.teacherDesign } : {}),
    // The original factory checks the exact 35/41-table scope; this entry performs no migration.
    ...(config.review ? { review: { versions: {
      modelConfigVersion: versions.modelConfig, promptVersion: versions.prompt,
      schemaVersion: versions.schema, analysisVersion: 'learner-analysis-v1',
    } } } : {}),
    studentHelp: { versions, budgetAvailable: () => false },
    teacherAgent: { versions, budgetAvailable: () => false, provider: { generate: async () => { throw new Error('Model unavailable.'); } } },
  });
  const manifestFile = resolve(serverRoot, '../../deployment.json');
  if (accessControl) await accessControl.listen(service);
  if (existsSync(manifestFile)) registerDeploymentIdentity(service.app, JSON.parse(readFileSync(manifestFile, 'utf8')));
  process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  await service.app.listen({ host: '127.0.0.1', port });
  service.startConsumer(config.consumerIntervalMs);
  process.stdout.write(JSON.stringify({ kind: 'cloud-shared-ready', origin: config.origin, databaseTables: config.review ? 41 : 35, executionNodes: executionNodes.map(node => node.nodeId) }) + '\n');
} catch {
  process.stderr.write('Cloud shared application startup failed. Check controlled configuration and retained state.\n');
  await shutdown().catch(() => {});
  process.exitCode = 1;
}
