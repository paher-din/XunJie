import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseKeyValueArgs } from './args.mjs';

const config = JSON.parse(readFileSync(parseKeyValueArgs(process.argv.slice(2)).config, 'utf8'));
const importFromTeaching = module => import(pathToFileURL(join(config.teachingDir, module)).href);

const { openApplicationDatabase } = await importFromTeaching('server/db/transaction.ts');
const { createDigitalLogicApplication } = await importFromTeaching('server/app/digital-logic.ts');
const { runtime } = await importFromTeaching('tests/dl-a-support.ts');

const versions = { modelConfig: 'unconfigured', prompt: 'unconfigured', schema: 'unconfigured', policy: 'unconfigured' };
const db = openApplicationDatabase(config.databaseFile);
let service;
try {
  service = await createDigitalLogicApplication({
    db,
    origin: config.origin,
    signingSecret: readFileSync(config.signingSecretFile, 'utf8').trim(),
    approvedHdlRuntimes: [runtime],
    executionNodes: [],
    studentHelp: { versions, budgetAvailable: () => false },
    teacherAgent: { versions, budgetAvailable: () => false, provider: { generate: async () => { throw new Error('Model unavailable.'); } } },
    personalModels: { directory: config.personalModelsDirectory, callsEnabled: false },
    review: { versions: { modelConfigVersion: versions.modelConfig, promptVersion: versions.prompt, schemaVersion: versions.schema, analysisVersion: 'learner-analysis-v1' } },
    logDestination: process.stdout,
  });
} catch (error) {
  db.close();
  throw error;
}

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  try { await service.shutdown(); } finally { db.close(); }
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await service.app.listen({ host: '127.0.0.1', port: config.port });
service.startConsumer();
process.stdout.write(JSON.stringify({ ready: true, port: config.port }) + '\n');
