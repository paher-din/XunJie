import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createFileBackend, provisionStorage, openStorage } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { learningMigrations } from '@xunjie/learning-space';
import { createAgentSessions, validateAgentSessions } from '@xunjie/learning-space/learning-data/agent-sessions';
import { agentServiceMigrations, validateAgentServiceStorage } from '@xunjie/agents/transport/session-storage';
import { agentSessionsCapability } from '@xunjie/contracts/agent-service';
import { agentSessionSchema } from '@xunjie/contracts/agent-sessions';
import { importLegacyAgentHistory } from '../packages/product-runtime/dist/legacy-agent-history.js';
import { atomicJson, acquireLock, exists, ownsProcess } from '../packages/product-runtime/dist/io.js';
import { startDatabase, stopDatabase, resolveCredential, storeCredential } from '../packages/product-runtime/dist/postgres.js';
import { legacyTeachingConversation } from './lib/legacy-teaching-history.mjs';

const args = process.argv.slice(2), rootAt = args.indexOf('--root'), backupAt = args.indexOf('--backup');
if (rootAt < 0 || backupAt < 0 || !args[rootAt + 1] || !args[backupAt + 1])
  throw new Error('Usage: node scripts/import-legacy-teaching-history.mjs --root <isolated-copy> --backup <verified-source-backup> [--apply]');
const root = resolve(args[rootAt + 1]), backup = resolve(args[backupAt + 1]);
const apply = args.includes('--apply');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const opened = [];
let unlock, database, config, phase = 'preflight';
try {
  if (process.versions.node !== '24.21.0') throw new Error('node-24.21.0-required');
  const proof = await json(join(backup, 'manifest.json'));
  if (root === resolve(proof.source) || root !== resolve(proof.target)) throw new Error('isolated-copy-required');
  for (const file of proof.files) {
    if (!['database.dump', 'conversations.json', 'legacy-owner.json'].includes(file.name)) throw new Error('invalid-backup-file');
    const bytes = await readFile(join(backup, file.name));
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('backup-digest-mismatch');
  }
  unlock = await acquireLock(root, 'daemon', 0);
  if (await exists(join(root, 'instance.json')) && await ownsProcess(await json(join(root, 'instance.json')))) throw new Error('product-must-be-stopped');
  config = await json(join(root, 'installation.json'));
  const environment = await json(join(root, 'environment.json'));
  if (environment.profile !== 'local' || environment.environmentId !== proof.environmentId || config.database.mode !== 'managed')
    throw new Error('local-managed-copy-required');
  await startDatabase(root, config.resources, config.database);
  const { credentialRef, ...connection } = (await json(join(root, 'database.json'))).binding;
  const admin = { ...connection, password: await resolveCredential(root, credentialRef) };
  database = new pg.Client(admin); await database.connect();
  const sourceDatabase = (await json(join(proof.source, 'database.json'))).binding;
  if (sourceDatabase.port === connection.port && sourceDatabase.host === connection.host) throw new Error('source-database-must-be-isolated');
  const rows = await json(join(backup, 'conversations.json'));
  const raw = await json(join(backup, 'legacy-owner.json'));
  const previous = await exists(join(root, 'legacy-agent-import.json')) ? await json(join(root, 'legacy-agent-import.json')) : undefined;
  const oldAgent = previous?.oldAgent ?? environment.services.find(service => service.unit === 'teaching-agent');
  const oldBinding = await json(join(root, 'credentials', 'storage-' + oldAgent.serviceId));
  // Shutdown may change owner gates, but every original business row must still match the frozen export.
  for (const [table, values] of Object.entries(raw).filter(([table]) => !table.startsWith('_'))) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('invalid-source-table');
    const actual = (await database.query('SELECT * FROM ' + quote(oldBinding.schema) + '.' + quote(table))).rows;
    const digest = rows => canonicalDigest(rows.map(row => JSON.parse(JSON.stringify(row))).sort((a, b) => canonicalDigest(a).localeCompare(canonicalDigest(b))));
    if (digest(values) !== digest(actual)) throw new Error('legacy-source-changed:' + table);
  }
  const descriptor = { ...oldAgent, serviceId: operationId('legacy-teaching-successor:' + oldAgent.serviceId),
    protocolVersion: 1, capabilities: [agentSessionsCapability] };
  const converted = rows.map(row => ({ row, conversation: legacyTeachingConversation(row.activity.activityId, row.conversation) }));
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', isolated: true, sessions: converted.length,
    messages: converted.reduce((n, item) => n + item.conversation.messages.length, 0),
    tools: converted.reduce((n, item) => n + item.conversation.tools.length, 0),
    thinking: converted.reduce((n, item) => n + item.conversation.thinking.length, 0) }));
  if (apply) {
    const open = async (unit, service, migrations) => {
      phase = unit + '.provision';
      const ref = 'storage-' + service.serviceId;
      let binding;
      if (await exists(join(root, 'credentials', ref))) binding = await json(join(root, 'credentials', ref));
      const password = binding?.connection.password ?? oldBinding.connection.password;
      binding = await provisionStorage({ admin, owner: { environmentId: environment.environmentId, serviceId: service.serviceId }, password, migrations });
      if (await exists(join(root, 'credentials', ref))) {
        if (canonicalDigest(await json(join(root, 'credentials', ref))) !== canonicalDigest(binding)) throw new Error('owner-binding-conflict');
      } else await storeCredential(root, ref, JSON.stringify(binding));
      const storage = await openStorage({ binding, migrations,
        backend: createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) }) });
      opened.push(storage); await storage.participant().resume(); return storage;
    };
    const learningService = environment.services.find(service => service.unit === 'learning-data');
    const learning = await open('learning-data', learningService, learningMigrations);
    const agent = await open('teaching-agent', descriptor, agentServiceMigrations);
    const owner = { version: 1, connectionId: descriptor.serviceId, installationId: environment.installationId, target: descriptor };
    const directory = createAgentSessions(learning, {
      async authorize(identity) {
        if (!rows.some(row => canonicalDigest(row.activity.identity) === canonicalDigest(identity))) throw new Error('unknown-source-subject');
      },
      async openActivity(_identity, activityId) {
        const { rows: [activity] } = await learning.read('SELECT body FROM activities WHERE id=$1', [activityId]);
        if (!activity) throw new Error('source-activity-missing'); return activity.body;
      }, resolveOwner: async () => owner,
    });
    for (const { row, conversation } of converted) {
      phase = 'session.' + conversation.sessionId;
      const activity = row.activity, sessionId = conversation.sessionId;
      const scenario = activity.course ? 'workspace-assistant' : 'student-assistant';
      const title = (row.label?.title ?? activity.question ?? '').trim().slice(0, 200) || null;
      const input = { sessionId, requestId: operationId('legacy-agent-session-create:' + sessionId), scenario, title,
        ...(activity.course ? { workspace: { activityId: activity.activityId, target: activity.target } } : {}) };
      const session = await directory.create(activity.identity, input);
      const source = { activityId: activity.activityId, digest: canonicalDigest(row) };
      await importLegacyAgentHistory(agent, { session: { sessionId, identity: activity.identity, scenario, createdAt: activity.createdAt }, conversation, source });
      const updatedAt = [activity.createdAt, ...row.conversation.runs.map(run => run.updatedAt)].sort().at(-1);
      const metadata = agentSessionSchema.parse({ ...session, state: 'ready', createdAt: activity.createdAt, updatedAt,
        readyAt: activity.createdAt, pinned: row.label?.pinned ?? false, deleted: row.label?.deleted ?? false, archived: row.archive?.archived ?? false });
      await learning.request({ requestId: 'legacy-agent-session-metadata:' + sessionId, fingerprint: canonicalDigest(metadata) }, async tx => {
        await tx.query('UPDATE agent_session_directory SET body=$2 WHERE session_id=$1', [sessionId, metadata]); return null;
      });
    }
    phase = 'validate';
    await validateAgentSessions(learning); await validateAgentServiceStorage(agent);
    await atomicJson(join(root, 'legacy-agent-import.json'), { formatVersion: 1, source: proof.source, backup,
      oldAgent, agent: descriptor, sessions: converted.length, importedAt: previous?.importedAt ?? new Date().toISOString() });
    environment.services = environment.services.map(service => service.unit === 'teaching-agent' ? descriptor : service);
    config.requiredServiceIds = config.requiredServiceIds.map(id => id === oldAgent.serviceId ? descriptor.serviceId : id);
    await atomicJson(join(root, 'environment.json'), environment); await atomicJson(join(root, 'installation.json'), config);
    console.log(JSON.stringify({ imported: true, originalOwnerUnchanged: true, kernelTurns: 0, validated: true }));
  }
} catch (error) {
  const code = error.code ?? error.message;
  console.error(JSON.stringify({ phase, code: /^[a-zA-Z0-9_.:-]{1,150}$/.test(code) ? code : 'legacy-import-failed',
    ...(error.issues ? { issues: error.issues.map(issue => ({ path: issue.path, code: issue.code })) } : {}) })); process.exitCode = 1;
} finally {
  for (const storage of opened.reverse()) { await storage.participant().closeDispatch(); await storage.participant().closeWrites(); await storage.close(); }
  await database?.end();
  if (config) await stopDatabase(root, config.resources, config.database);
  await unlock?.();
}
