import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// This entry composes the original application; it never initializes or migrates a database.
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1];
  if (!['--config', '--teaching-root'].includes(name) || !value || values.has(name)) {
    throw new Error('Use --config <controlled-file> and --teaching-root <release/apps/teaching>.');
  }
  values.set(name, value);
}

let db, service;
let closing;
const shutdown = () => closing ??= (async () => {
  try { await service?.shutdown(); }
  finally { db?.close(); }
})();

try {
  if (process.platform !== 'linux' || process.version !== 'v24.21.0') {
    throw new Error('Linux Node24.21.0 required.');
  }
  const teachingRoot = resolve(values.get('--teaching-root') ?? '/opt/xunjie/current/apps/teaching');
  const configFile = resolve(values.get('--config') ?? '/etc/xunjie/application-config.json');
  const load = relative => import(pathToFileURL(`${teachingRoot}/${relative}`).href);
  const { readApplicationConfig, readI0SigningSecret } = await load('server/app/config.ts');
  const { openSyntheticDatabase } = await load('server/db/transaction.ts');
  const { executionTransports } = await load('server/app/execution-transport.ts');
  const { createDigitalLogicApplication } = await load('server/app/digital-logic.ts');
  const config = readApplicationConfig(configFile);
  const browserOrigin = new URL(config.origin);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(browserOrigin.hostname) || config.tutoring?.callsAuthorized ||
      config.tutoring?.apiKeyFile || !config.executionNodes?.length || config.ssh) {
    throw new Error('Cloud shared configuration with registered execution nodes and disabled legacy model calls required.');
  }
  const retained = dirname(dirname(config.databaseFile));
  if (retained !== '/var/lib/xunjie/retained-tmp') throw new Error('Cloud retained database path required.');
  process.env.TMPDIR = retained;
  db = openSyntheticDatabase(config.databaseFile);
  const generation = db.withTransaction(tx => tx.get('SELECT recovery_generation FROM application_control WHERE singleton=1'))?.recovery_generation;
  if (generation !== config.recoveryGeneration) throw new Error('Application recovery control mismatch.');
  const versions = { modelConfig: 'disabled', prompt: 'disabled', schema: 'disabled', policy: 'disabled' };
  const executionNodes = config.executionNodes.map(({ ssh, ...node }) => ({ ...node, ...executionTransports(ssh) }));
  service = await createDigitalLogicApplication({
    db, origin: config.origin, signingSecret: readI0SigningSecret(config.signingSecretFile),
    ...(config.allowedLoginUserIds ? { allowedLoginUserIds: config.allowedLoginUserIds } : {}),
    https: { key: readFileSync(config.tls.keyFile), cert: readFileSync(config.tls.certFile) },
    executionNodes, ...(config.legacyExecutionNodeId ? { legacyExecutionNodeId: config.legacyExecutionNodeId } : {}),
    approvedHdlRuntimes: config.approvedHdlRuntimes,
    ...(config.staticDirectory ? { staticDirectory: config.staticDirectory } : {}),
    consumerIntervalMs: config.consumerIntervalMs, logDestination: process.stdout,
    ...(config.personalModels ? { personalModels: config.personalModels } : {}),
    // The original factory checks the exact 35/41-table scope; this entry performs no migration.
    ...(config.review ? { review: { versions: {
      modelConfigVersion: versions.modelConfig, promptVersion: versions.prompt,
      schemaVersion: versions.schema, analysisVersion: 'learner-analysis-v1',
    } } } : {}),
    studentHelp: { versions, budgetAvailable: () => false },
    teacherAgent: { versions, budgetAvailable: () => false, provider: { generate: async () => { throw new Error('Model unavailable.'); } } },
  });
  process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  await service.app.listen({ host: '127.0.0.1', port: 3444 });
  service.startConsumer(config.consumerIntervalMs);
  process.stdout.write(JSON.stringify({ kind: 'cloud-shared-ready', origin: config.origin, databaseTables: config.review ? 41 : 35, executionNodes: executionNodes.map(node => node.nodeId) }) + '\n');
} catch {
  process.stderr.write('Cloud shared application startup failed. Check controlled configuration and retained state.\n');
  await shutdown().catch(() => {});
  process.exitCode = 1;
}
