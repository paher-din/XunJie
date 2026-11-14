import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseResetArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  let root, apply = false, dryRun = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--root' && !root && args[index + 1] && !args[index + 1].startsWith('--')) root = resolve(args[++index]);
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--dry-run' && !dryRun) dryRun = true;
    else throw new Error('invalid-reset-arguments');
  }
  if (!root || apply && dryRun) throw new Error('invalid-reset-arguments');
  return { root, apply };
}
const usage = 'Usage: node scripts/reset-agent-development-data.mjs --root <stopped local or school development environment> [--dry-run | --apply]';
export async function runResetAgentDevelopmentData(args) {
  const options = parseResetArguments(args);
  if (options.help) { console.log(usage); return; }
  if (process.versions.node !== '24.21.0') throw new Error('node-24.21.0-required');
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  const environment = await json(join(options.root, 'environment.json'));
  const configuration = await json(join(options.root, 'installation.json'));
  if (!['local', 'school'].includes(environment.profile) || !['127.0.0.1', '::1', 'localhost'].includes(configuration.host)) throw new Error('development-environment-required');
  const { resetAgentDevelopmentData } = await import('./agent-development-data.mjs');
  const { createFileBackend } = await import('@xunjie/storage');
  const { databaseBinding, resolveCredential, runPg, startDatabase, stopDatabase } = await import('../packages/product-runtime/dist/postgres.js');
  const database = await databaseBinding(options.root, configuration.database);
  if (!database) throw new Error('database-required');
  const { credentialRef, ...connection } = database;
  const admin = { ...connection, password: await resolveCredential(options.root, credentialRef) }, owners = {};
  for (const [kind, unit] of [['agent', 'teaching-agent'], ['learning', 'learning-data'], ['model', 'model-connection']]) {
    const matches = environment.services.filter(service => service.unit === unit);
    if (matches.length !== 1) throw new Error('missing-or-duplicate-owner');
    const binding = await json(join(options.root, 'credentials', 'storage-' + matches[0].serviceId));
    if (binding.owner.environmentId !== environment.environmentId || binding.owner.serviceId !== matches[0].serviceId) throw new Error('owner-identity-conflict');
    owners[kind] = { binding, backend: createFileBackend({ id: unit, root: join(options.root, 'learning-resources', unit) }) };
  }
  const report = await resetAgentDevelopmentData({ ...options, admin, owners, async prepareDatabase() {
    let started = false;
    if (configuration.database.mode === 'managed') {
      try { await runPg(configuration.resources, 'pg_ctl', ['status', '-D', join(options.root, 'pgdata')]); }
      catch (error) { if (error.code !== 3) throw error; started = true; }
    }
    try { await startDatabase(options.root, configuration.resources, configuration.database); }
    catch (error) { if (started) await stopDatabase(options.root, configuration.resources, configuration.database); throw error; }
    return started ? () => stopDatabase(options.root, configuration.resources, configuration.database) : undefined;
  } });
  console.log(JSON.stringify(report, null, 2));
  if (report.blocking.length) process.exitCode = 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1])).catch(() => '')).href) {
  try { await runResetAgentDevelopmentData(process.argv.slice(2)); }
  catch (error) {
    const code = error.code ?? error.message;
    const safeCode = /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : 'reset-failed';
    const phase = typeof error.resetPhase === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(error.resetPhase) ? ' phase=' + error.resetPhase : '';
    console.error(safeCode + phase); process.exitCode = 1;
  }
}
