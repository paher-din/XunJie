import { appendFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = '/opt/xunjie-ui-local';
const args = process.argv.slice(2);
const values = new Map();
let modelEnabled = false;
let personalModelsDisabled = false;
let reviewEnabled = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--model-enabled') { modelEnabled = true; continue; }
  if (args[index] === '--personal-models-disabled') { personalModelsDisabled = true; continue; }
  if (args[index] === '--review-enabled') { reviewEnabled = true; continue; }
  if (!['--config', '--teaching-root'].includes(args[index]) || !args[index + 1]) throw new Error('Unsupported local host argument');
  values.set(args[index], args[++index]);
}
if (process.platform !== 'linux' || process.version !== 'v24.21.0') throw new Error('Prepared local Linux Node24.21.0 required');
const configFile = resolve(values.get('--config') ?? `${root}/application-config.json`);
const teachingRoot = resolve(values.get('--teaching-root') ?? `${root}/source/apps/teaching`);
if (configFile !== `${root}/application-config.json` || teachingRoot !== `${root}/source/apps/teaching`) throw new Error('Owned local host paths required');
if (lstatSync(root).isSymbolicLink()) throw new Error('Ordinary owned local directory required');
const load = relative => import(pathToFileURL(`${teachingRoot}/${relative}`).href);
const { readApplicationConfig, readI0SigningSecret } = await load('server/app/config.ts');
const { openSyntheticDatabase } = await load('server/db/transaction.ts');
const { executionTransports } = await load('server/app/execution-transport.ts');
const { createDigitalLogicApplication } = await load('server/app/digital-logic.ts');
const config = readApplicationConfig(configFile);
if (config.origin !== 'https://127.0.0.1:3444' || !config.databaseFile.startsWith(`${root}/retained-tmp/`) ||
    config.ssh.host !== '127.0.0.1' || config.ssh.port !== 2222 || config.tutoring?.apiKeyFile !== undefined) throw new Error('Exact owned local synthetic configuration required');
process.env.TMPDIR = `${root}/retained-tmp`;
const db = openSyntheticDatabase(config.databaseFile);
const controls = db.withTransaction(tx => ({
  generation: tx.get('SELECT recovery_generation FROM application_control WHERE singleton=1')?.recovery_generation,
  users: tx.all('SELECT id FROM users').map(row => row.id),
  courses: tx.all('SELECT id FROM courses').map(row => row.id),
}));
if (controls.generation !== config.recoveryGeneration || controls.users.length !== 3 || controls.courses.length !== 2 ||
    !controls.users.every(id => /^synthetic-robert-(teacher|student-[ab])$/.test(id)) ||
    !controls.courses.every(id => /^synthetic-robert-course-(c|hdl)$/.test(id))) { db.close(); throw new Error('Owned synthetic database identity mismatch'); }

const journal = event => appendFileSync(`${root}/evidence/model-transport.jsonl`, JSON.stringify({ observedAtUtc: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
const localKey = process.env.DEEPSEEK_API_KEY?.trim();
const callsAuthorized = modelEnabled && Boolean(localKey);
let tutoringProvider;
if (callsAuthorized) {
  const { createAiSdkDeepSeekProvider } = await load('server/tutoring/deepseek-sdk.ts');
  const provider = createAiSdkDeepSeekProvider({ apiKey: localKey, fetch: async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== 'https://api.deepseek.com' || !['/chat/completions', '/v1/chat/completions'].includes(url.pathname)) throw new Error('Original DeepSeek model endpoint required');
    const id = randomUUID(), start = performance.now();
    journal({ kind: 'http-start', id, provider: 'DeepSeek' });
    try {
      const response = await fetch(input, init);
      journal({ kind: 'http-response', id, status: response.status, elapsedMs: Math.round(performance.now() - start) });
      return response;
    } catch { journal({ kind: 'http-failed', id, elapsedMs: Math.round(performance.now() - start) }); throw new Error('Local model transport failed'); }
  }});
  tutoringProvider = { generate: async request => {
    if (request.purpose !== 'student_help') throw new Error('Only approved synthetic student help is enabled');
    const response = await provider.generate(request);
    journal({ kind: 'model-result', purpose: request.purpose, ...(response.usage ? { usage: response.usage } : {}) });
    return response;
  }};
}
let service, closing = false, startupCompleted = false, closePromise;
async function close() {
  closing = true;
  if (!startupCompleted) return;
  closePromise ??= (async () => { try { if (service) await service.shutdown(); } finally { db.close(); } })();
  return closePromise;
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
try {
  service = await createDigitalLogicApplication({
    db, origin: config.origin, signingSecret: readI0SigningSecret(config.signingSecretFile),
    https: { key: (await import('node:fs')).readFileSync(config.tls.keyFile), cert: (await import('node:fs')).readFileSync(config.tls.certFile) },
    ...executionTransports(config.ssh), approvedHdlRuntimes: config.approvedHdlRuntimes,
    staticDirectory: config.staticDirectory, consumerIntervalMs: config.consumerIntervalMs,
    personalModels: {directory: `${root}/personal-agent`, callsEnabled: !personalModelsDisabled},
    ...(reviewEnabled ? { review: { versions: { modelConfigVersion: 'disabled', promptVersion: 'disabled', schemaVersion: 'learner-analysis-v1', analysisVersion: 'learner-analysis-v1' } } } : {}),
    studentHelp: { versions: config.tutoring?.versions ?? { modelConfig: 'deepseek-flash-v1', prompt: 'student-help-v1', schema: 'student-help-v1', policy: 'activity-policy' }, budgetAvailable: () => callsAuthorized },
    ...(tutoringProvider ? { tutoringProvider } : {}),
    teacherAgent: { versions: { modelConfig: 'disabled', prompt: 'disabled', schema: 'disabled', policy: 'disabled' }, budgetAvailable: () => false, provider: { generate: async () => { throw new Error('Teacher model is disabled'); } } },
  });
  if (!closing) await service.app.listen({ host: '127.0.0.1', port: 3444 });
  startupCompleted = true;
  if (closing) await close();
  else {
    service.startConsumer(config.consumerIntervalMs);
    console.log(JSON.stringify({ origin: config.origin, source: 'owned local reviewed application', recoveryGeneration: config.recoveryGeneration, modelCallsAuthorized: callsAuthorized, personalModelsEnabled: !personalModelsDisabled, keySource: 'per-account encrypted storage; no fallback' }));
  }
} catch {
  startupCompleted = true;
  await close();
  process.stderr.write('Local application startup failed; inspect exact local readiness and controlled configuration.\n');
  process.exitCode = 1;
}
