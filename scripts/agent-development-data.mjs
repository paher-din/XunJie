import { createHash } from 'node:crypto';
import pg from 'pg';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { agentServiceMigrations } from '@xunjie/agents/transport/session-storage';
import { learningMigrations } from '@xunjie/learning-space/learning-data';
import { modelMigrations } from '@xunjie/model-gateway';
import { openStorage } from '@xunjie/storage';
import { acquireLock, ownsProcess } from '../packages/product-runtime/dist/io.js';

const quote = value => '"' + value.replaceAll('"', '""') + '"';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a, b) => canonical(a) === canonical(b);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const libraryTables = ['teaching_skills', 'teaching_skill_versions', 'teaching_skill_selections'];
const legacyTables = new Set(`teaching_sessions teaching_requests teaching_runs teaching_events teaching_snapshots teaching_model_switches
  teaching_agent_definitions teaching_resolved_agents teaching_compactions teaching_inputs teaching_input_revisions teaching_controls
  teaching_run_input_selections teaching_dependency_bindings teaching_segment_transitions teaching_student_facts teaching_student_questions
  teaching_student_responses teaching_student_presentations teaching_budgets teaching_steps teaching_commands teaching_waits
  teaching_skills teaching_skill_versions teaching_skill_selections teaching_skill_loads agent_chunk_transfers agent_chunk_parts`.split(/\s+/));
const oldCapabilities = new Set(['teaching.agent', 'teaching.dependencies', 'teaching.data']);
function mentions(value, ids) {
  if (typeof value === 'string') return ids.has(value);
  return !!value && typeof value === 'object' && Object.values(value).some(item => mentions(item, ids));
}
const containsId = (value, ids) => typeof value === 'string' && [...ids].some(id => value.includes(id));
const frozenKey = transfer => JSON.stringify([transfer.source_key, transfer.input_sha, transfer.input_bytes]);
async function privateTransfers(root) {
  const directory = join(root, 'private', 'agent-transfers');
  let entries;
  try { entries = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const name of entries) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(directory, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) fail('invalid-transfer-file');
    const bytes = await readFile(path), value = JSON.parse(bytes);
    if (oldCapabilities.has(value.capability) && value.payload?.version === 1) files.push({ path, name, sha256: hash(bytes), transferId: value.transferId });
  }
  return files;
}

/** Offline developer operation; owners share one database. Returns counts and identities, never credentials. */
export async function resetAgentDevelopmentData({ root, admin, owners, apply = false, prepareDatabase }) {
  root = resolve(root);
  if (typeof apply !== 'boolean') fail('invalid-apply');
  const unlockDaemon = await acquireLock(root, 'daemon', 0);
  let unlockRecovery, client, stopPreparedDatabase, phase = 'offline-check';
  async function useOwner(kind, local = true) {
    phase = kind + '.assume-role';
    await client.query('RESET ROLE');
    await client.query(`SET ${local ? 'LOCAL ' : ''}ROLE ${quote(owners[kind].binding.migratorRole)}`);
    await client.query(`SET ${local ? 'LOCAL ' : ''}search_path TO ${quote(owners[kind].binding.schema)},pg_catalog`);
  }
  try {
    unlockRecovery = await acquireLock(root, 'recovery', 0);
    try { if (await ownsProcess(JSON.parse(await readFile(join(root, 'instance.json'), 'utf8')))) fail('product-must-be-stopped'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const kind of ['agent', 'learning', 'model']) {
      const binding = owners[kind]?.binding;
      if (!binding || !uuid.test(binding.owner?.environmentId) || !uuid.test(binding.owner?.serviceId)) fail('missing-owner');
      if (['host', 'port', 'database'].some(key => binding.connection[key] !== admin[key])) fail('owners-must-share-database');
    }
    if (new Set(Object.values(owners).map(item => item.binding.owner.environmentId)).size !== 1) fail('owner-environment-conflict');
    stopPreparedDatabase = await prepareDatabase?.();
    const files = await privateTransfers(root);
    client = new pg.Client({ ...admin, connectionTimeoutMillis: 5000, application_name: 'xunjie-development-agent-reset' });
    await client.connect();
    if ((await client.query('SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND usename=ANY($1::text[]) LIMIT 1',
      [Object.values(owners).map(item => item.binding.connection.user)])).rowCount) fail('owner-connections-must-be-closed');
    // Blob backends store storage envelopes. Read original chunk bytes through the actual owner before taking DDL locks.
    const originals = new Map(), frozenOriginals = new Map(), learningSchema = quote(owners.learning.binding.schema);
    if ((await client.query('SELECT 1 FROM pg_tables WHERE schemaname=$1 AND tablename=$2', [owners.learning.binding.schema, 'agent_chunk_parts'])).rowCount) {
      await useOwner('learning', false); phase = 'learning.read-originals';
      const journal = (await client.query(`SELECT version,name,checksum FROM ${learningSchema}._storage_migrations ORDER BY version`)).rows;
      const sourceMigrations = journal.map((recorded, index) => {
        const valid = migration => migration?.name === recorded.name && hash(`${recorded.version}\n${migration.name}\n${migration.sql}`) === recorded.checksum;
        const migration = valid(learningMigrations[recorded.version - 1]) ? learningMigrations[recorded.version - 1]
          : index === journal.length - 1 ? learningMigrations.find(item => item.formerVersion === recorded.version && valid(item)) : undefined;
        if (!migration || recorded.version !== index + 1) fail('migration-prefix-conflict');
        return { version: recorded.version, name: migration.name, sql: migration.sql };
      });
      const inputParts = (await client.query(`SELECT DISTINCT resource_id FROM ${learningSchema}.agent_chunk_parts WHERE direction='input' AND resource_id IS NOT NULL`)).rows;
      // Acknowledgement releases part references, and older channels also pruned the part rows.
      // The immutable request object can still prove the protocol, but only within this exact source scope.
      const frozen = (await client.query(`SELECT DISTINCT ON (t.source_key,t.input_sha,t.input_bytes)
          t.source_key,t.input_sha,t.input_bytes,r.resource_id
        FROM (SELECT DISTINCT source_key,input_sha,input_bytes FROM ${learningSchema}.agent_chunk_transfers) t
        JOIN ${learningSchema}._storage_resources r ON r.reference->>'scope'='agent-chunk:'||t.source_key
          AND r.reference->>'sha256'=t.input_sha AND (r.reference->>'byteLength')::bigint=t.input_bytes
        WHERE r.state='ready' ORDER BY t.source_key,t.input_sha,t.input_bytes,r.resource_id`)).rows;
      if (inputParts.length || frozen.length) {
        const storage = await openStorage({ ...owners.learning, migrations: sourceMigrations });
        try {
          for (const id of new Set([...inputParts, ...frozen].map(row => row.resource_id))) originals.set(id, Buffer.from(await storage.readResource(id)));
          for (const item of frozen) {
            const bytes = originals.get(item.resource_id);
            if (bytes.length !== item.input_bytes || hash(bytes) !== item.input_sha) fail('corrupt-transport-resource');
            frozenOriginals.set(frozenKey(item), bytes);
          }
        }
        finally { await storage.close(); }
      }
    }
    await client.query('RESET ROLE'); phase = 'reset.begin';
    await client.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const schemas = {}, known = {}, cache = new Map(), actions = [], report = {
      formatVersion: 1, mode: apply ? 'applied' : 'dry-run', agent: { rebuild: false, tables: [] },
      skills: { versions: 0, libraries: 0, selections: 0 }, learning: {}, model: {}, privateTransfers: files.map(file => file.name), blocking: [],
      learningTransport: { parts: 0, frozenRequests: 0, privateRecords: 0, preservedV2: 0, preservedStudyCopyV1: 0, removedV1: 0 },
      learningPreservedStudyCopy: {},
    };
    for (const [kind, { binding }] of Object.entries(owners)) {
      await useOwner(kind); phase = kind + '.inspect-identity';
      const schema = quote(binding.schema); schemas[kind] = schema;
      const state = (await client.query(`SELECT * FROM ${schema}._storage_identity${apply ? ' FOR UPDATE' : ''}`)).rows[0];
      if (state?.environment_id !== binding.owner.environmentId || state?.service_id !== binding.owner.serviceId || state?.core_version !== 1) fail('storage-identity-conflict');
      if (apply) await client.query(`LOCK TABLE ${schema}._storage_identity IN ACCESS EXCLUSIVE MODE`);
      known[kind] = new Set((await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [binding.schema])).rows.map(row => row.tablename));
    }
    async function rows(kind, table) {
      const key = kind + '/' + table;
      if (!cache.has(key)) {
        await useOwner(kind); phase = kind + '.inspect.' + table;
        cache.set(key, known[kind].has(table)
          ? (await client.query(`SELECT to_jsonb(t) AS data FROM ${schemas[kind]}.${quote(table)} t`)).rows.map(row => row.data) : []);
      }
      return cache.get(key);
    }
    function remove(kind, table, values) {
      if (values.length) { actions.push({ kind, table, values }); report[kind][table] = values.length; }
    }
    // Study-copy exports are business snapshots. Their guarded transport/labels/routes remain archival facts,
    // even after acknowledgement; deleting them would invalidate the independent source closure.
    const studyExports = await rows('learning', 'study_copy_exports');
    const studyScopes = new Set(studyExports.map(row => row.scope_key));
    const protectedActivities = new Set(studyExports.flatMap(row => row.activity_ids ?? []));
    if (studyExports.length) for (const row of await rows('learning', 'activities')) {
      const identity = row.body?.identity;
      if (identity && studyExports.some(exported => ['environmentId', 'spaceId', 'principalId', 'kind'].every(key => identity[key] === exported.identity?.[key]))) protectedActivities.add(row.id);
    }
    const protectedTransfers = new Set((await rows('learning', 'study_copy_chunk_scopes')).filter(row => studyScopes.has(row.scope_key))
      .map(row => JSON.stringify([row.source_key, row.transfer_id])));
    function unprotectedActivities(table, values) {
      const retained = values.filter(row => protectedActivities.has(row.activity_id));
      if (retained.length) report.learningPreservedStudyCopy[table] = retained.length;
      return values.filter(row => !protectedActivities.has(row.activity_id));
    }
    const oldAgent = [...known.agent].filter(table => !table.startsWith('_storage_'));
    report.agent.rebuild = known.agent.has('teaching_sessions') || known.agent.has('teaching_runs');
    if (report.agent.rebuild) {
      for (const table of oldAgent) if (!legacyTables.has(table)) report.blocking.push({ code: 'unknown-agent-table', table });
      report.agent.tables = oldAgent.sort();
    }
    const oldRuns = new Set((await rows('agent', 'teaching_runs')).map(row => row.run_id));
    const oldActivities = new Set((await rows('agent', 'teaching_sessions')).map(row => row.activity_id));
    for (const row of await rows('agent', 'teaching_runs')) oldActivities.add(row.activity_id);
    const retired = { learning: new Set(), model: new Set() }, libraries = {};
    for (const table of libraryTables) {
      libraries[table] = report.agent.rebuild ? await rows('agent', table) : [];
      const keys = table === 'teaching_skill_selections' ? ['owner_key', 'range_key']
        : table === 'teaching_skill_versions' ? ['owner_key', 'skill_id', 'version'] : ['owner_key', 'skill_id'];
      for (const original of libraries[table]) {
        if (table === 'teaching_skills' && original.removed === undefined) original.removed = false;
        const target = (await rows('learning', table)).find(item => keys.every(key => item[key] === original[key]));
        if (target && !same(target, original)) report.blocking.push({ code: 'skill-library-conflict', table, skillId: original.skill_id ?? null });
      }
    }
    const loadCommands = new Set((await rows('agent', 'teaching_skill_loads')).map(row => 'skills:' + row.command_id));
    const skillReceipts = report.agent.rebuild ? (await rows('agent', '_storage_requests')).filter(row => row.request_id.startsWith('skills:')
      && !loadCommands.has(row.request_id) && !row.result?.runId && !row.result?.commandId) : [];
    for (const original of skillReceipts) {
      const target = (await rows('learning', '_storage_requests')).find(row => row.request_id === original.request_id);
      if (target && (target.fingerprint !== original.fingerprint || !same(target.result, original.result))) report.blocking.push({ code: 'skill-receipt-conflict' });
    }
    report.skills = { versions: libraries.teaching_skill_versions.length, libraries: libraries.teaching_skills.length,
      selections: libraries.teaching_skill_selections.length, receipts: skillReceipts.length };
    if (report.agent.rebuild) {
      for (const table of ['conversation_labels', 'conversation_archives']) remove('learning', table, unprotectedActivities(table, await rows('learning', table)));
      remove('learning', 'activity_agent_routes', unprotectedActivities('activity_agent_routes', (await rows('learning', 'activity_agent_routes')).filter(row =>
        row.body?.target?.serviceId === owners.agent.binding.owner.serviceId || oldActivities.has(row.activity_id))));
      const commands = unprotectedActivities('agent_execution_commands', (await rows('learning', 'agent_execution_commands')).filter(row => oldRuns.has(row.association?.runId)));
      const commandIds = new Set(commands.map(row => row.command_id));
      for (const row of commands) { retired.learning.add(row.command_id); retired.learning.add(row.request_id); }
      for (const table of ['agent_execution_authorities', 'agent_execution_origins']) remove('learning', table, (await rows('learning', table)).filter(row => commandIds.has(row.command_id)));
      remove('learning', 'agent_execution_commands', commands);
      const intents = unprotectedActivities('action_intents', (await rows('learning', 'action_intents')).filter(row => row.body?.receiver?.receiverId === 'teaching-agent:' + owners.agent.binding.owner.serviceId));
      for (const row of intents) retired.learning.add(row.request_id);
      remove('learning', 'action_intents', intents);
      const parts = await rows('learning', 'agent_chunk_parts'), selected = [];
      for (const transfer of await rows('learning', 'agent_chunk_transfers')) {
        const input = parts.filter(part => part.source_key === transfer.source_key && part.transfer_id === transfer.transfer_id && part.direction === 'input')
          .sort((a, b) => a.part_index - b.part_index);
        let payload;
        if (input.length && input.every(part => part.resource_id)) {
          const bytes = [];
          for (const part of input) {
            const data = originals.get(part.resource_id);
            if (!data) fail('missing-transport-resource');
            if (hash(data) !== part.sha256 || data.length !== part.byte_length) fail('corrupt-transport-resource'); bytes.push(data);
          }
          const combined = Buffer.concat(bytes);
          if (combined.length === transfer.input_bytes && hash(combined) === transfer.input_sha) { payload = JSON.parse(combined); report.learningTransport.parts++; }
        }
        if (!payload && frozenOriginals.has(frozenKey(transfer))) {
          const original = frozenOriginals.get(frozenKey(transfer));
          if (original.length !== transfer.input_bytes || hash(original) !== transfer.input_sha) fail('corrupt-transport-resource');
          payload = JSON.parse(original); report.learningTransport.frozenRequests++;
        }
        if (payload?.version === 2) { report.learningTransport.preservedV2++; continue; }
        if (!payload && files.some(file => file.transferId === transfer.transfer_id)) { payload = { version: 1 }; report.learningTransport.privateRecords++; }
        if (!payload) { report.blocking.push({ code: 'unclassified-learning-transfer', transferId: transfer.transfer_id }); continue; }
        if (payload.version !== 1) { report.blocking.push({ code: 'unsupported-transfer-protocol', transferId: transfer.transfer_id }); continue; }
        if (protectedTransfers.has(JSON.stringify([transfer.source_key, transfer.transfer_id]))) { report.learningTransport.preservedStudyCopyV1++; continue; }
        selected.push(transfer); retired.learning.add(transfer.transfer_id); report.learningTransport.removedV1++;
      }
      remove('learning', 'agent_chunk_parts', parts.filter(part => selected.some(row => row.source_key === part.source_key && row.transfer_id === part.transfer_id)));
      remove('learning', 'agent_chunk_transfers', selected);
    }
    const allOrigins = await rows('model', 'model_origin_journals');
    const oldService = service => service?.environmentId === owners.agent.binding.owner.environmentId && service?.serviceId === owners.agent.binding.owner.serviceId;
    const oldOrigins = allOrigins.filter(row => row.body?.formatVersion !== 3 && oldService(row.body?.service));
    const origins = new Set(oldOrigins.map(row => row.association_id));
    const belongsToOldAgent = row => !allOrigins.some(origin => origin.association_id === row.id
      && (origin.body?.formatVersion === 3 || !oldService(origin.body?.service)));
    const segments = (await rows('model', 'model_segments')).filter(row => row.body?.purpose === 'learning' && !row.body.sessionId && belongsToOldAgent(row));
    const attempts = (await rows('model', 'model_attempts')).filter(row => row.body?.purpose === 'learning' && !row.body.authority?.permit?.sessionId && belongsToOldAgent(row));
    const segmentIds = new Set(segments.map(row => row.id)), attemptIds = new Set(attempts.map(row => row.id)), pins = new Set();
    for (const row of await rows('model', 'model_selection_pins')) if (origins.has(row.id)) pins.add(row.id);
    for (const row of segments) if (row.body.source?.pinId) pins.add(row.body.source.pinId);
    for (const row of await rows('agent', 'teaching_segment_transitions')) if (row.create_body?.source?.pinId) pins.add(row.create_body.source.pinId);
    const paired = (await rows('model', 'model_paired_requests')).filter(row => row.body?.origin?.formatVersion !== 3 && oldService(row.body?.origin?.service));
    for (const row of paired) {
      const request = row.body.request, id = request?.args?.[0]?.pinId ?? request?.args?.[0];
      if (request?.operation === 'selection.pin' && typeof id === 'string') pins.add(id);
      if (request?.operation === 'segments.create' && request.args?.[0]?.source?.pinId) pins.add(request.args[0].source.pinId);
    }
    const ids = new Set([...origins, ...segmentIds, ...attemptIds, ...pins, ...paired.map(row => row.id)]); retired.model = ids;
    remove('model', 'model_origin_authorizations', (await rows('model', 'model_origin_authorizations')).filter(row => origins.has(row.association_id)));
    remove('model', 'model_origin_journals', oldOrigins);
    for (const table of ['model_learning_admissions', 'model_attempt_progress', 'model_tool_results']) remove('model', table, (await rows('model', table)).filter(row => attemptIds.has(row.attempt_id)));
    remove('model', 'model_observations', (await rows('model', 'model_observations')).filter(row => mentions(row.body, attemptIds)));
    const tasks = (await rows('model', 'model_device_tasks')).filter(row => row.task?.operation === 'learning' && row.task.formatVersion !== 3
      && oldService(row.task.origin?.service) || ids.has(row.task?.attemptId));
    for (const row of tasks) ids.add(row.id);
    remove('model', 'model_device_tasks', tasks); remove('model', 'model_paired_requests', paired);
    for (const table of ['model_paired_routes', 'model_paired_sessions', 'model_paired_grants', 'model_client_routes']) remove('model', table, (await rows('model', table)).filter(row => ids.has(row.id)));
    remove('model', 'model_selection_pins', (await rows('model', 'model_selection_pins')).filter(row => pins.has(row.id)));
    remove('model', 'model_attempts', attempts); remove('model', 'model_segments', segments);
    for (const kind of ['learning', 'model']) {
      const retiredIds = retired[kind];
      const receipts = (await rows(kind, '_storage_requests')).filter(row => !(kind === 'learning' && (
        [...studyScopes].some(scope => row.request_id.startsWith('conversation-history:' + scope + ':') || row.request_id.startsWith('conversation-archives:' + scope + ':'))
        || [...protectedActivities].some(id => row.request_id === 'activity-agent-route:' + id))) && (containsId(row.request_id, retiredIds)
        || containsId(row.fingerprint, retiredIds) || mentions(row.result, retiredIds)
        || kind === 'learning' && report.agent.rebuild && /^(conversation-history:|conversation-archives:|activity-agent-route:)/.test(row.request_id)));
      const requestIds = new Set(receipts.map(row => row.request_id));
      remove(kind, '_storage_outbox', (await rows(kind, '_storage_outbox')).filter(row => requestIds.has(row.request_id)));
      remove(kind, '_storage_requests', receipts);
      remove(kind, '_storage_references', (await rows(kind, '_storage_references')).filter(row => containsId(row.reference_id, retiredIds)));
    }
    const upgrades = {}, relocations = {};
    for (const [kind, migrations] of [['learning', learningMigrations], ['model', modelMigrations]]) {
      const applied = [...await rows(kind, '_storage_migrations')].sort((a, b) => a.version - b.version), present = new Set();
      for (const [index, recorded] of applied.entries()) {
        if (recorded.version !== index + 1) report.blocking.push({ code: 'migration-prefix-gap', owner: kind });
        const migration = migrations[recorded.version - 1];
        if (migration?.name === recorded.name && hash(`${migration.version}\n${migration.name}\n${migration.sql}`) === recorded.checksum) present.add(recorded.version);
        else {
          const former = index === applied.length - 1 ? migrations.find(item => item.formerVersion === recorded.version && item.name === recorded.name
            && hash(`${recorded.version}\n${item.name}\n${item.sql}`) === recorded.checksum) : undefined;
          if (former) { relocations[kind] = { from: recorded.version, to: former.version, checksum: hash(`${former.version}\n${former.name}\n${former.sql}`) }; present.add(former.version); }
          else report.blocking.push({ code: 'migration-prefix-conflict', owner: kind, version: recorded.version });
        }
      }
      upgrades[kind] = migrations.filter(item => !present.has(item.version)); report[kind].migrations = upgrades[kind].map(item => item.version);
    }
    report.changed = report.agent.rebuild || actions.length > 0 || files.length > 0 || Object.values(upgrades).some(items => items.length > 0);
    if (!apply || !report.changed) { await client.query('ROLLBACK'); return report; }
    if (report.blocking.length) fail('reset-plan-blocked');
    for (const kind of Object.keys(schemas)) {
      await useOwner(kind); phase = kind + '.close-gates';
      await client.query(`UPDATE ${schemas[kind]}._storage_identity SET writes_open=false,dispatch_open=false,generation=generation+1`);
    }
    async function migrate(kind, migrations) {
      const binding = owners[kind].binding;
      await useOwner(kind);
      if (relocations[kind]) { const move = relocations[kind]; await client.query('UPDATE _storage_migrations SET version=$1,checksum=$2 WHERE version=$3', [move.to, move.checksum, move.from]); }
      for (const migration of migrations) {
        phase = kind + '.migration.' + migration.version;
        await client.query(migration.sql);
        await client.query('INSERT INTO _storage_migrations(version,name,checksum) VALUES($1,$2,$3)', [migration.version, migration.name, hash(`${migration.version}\n${migration.name}\n${migration.sql}`)]);
      }
      phase = kind + '.grant-service-access';
      await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schemas[kind]} TO ${quote(binding.connection.user)}`);
      await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schemas[kind]} TO ${quote(binding.connection.user)}`); await client.query('RESET ROLE');
    }
    for (const kind of ['learning', 'model']) await migrate(kind, upgrades[kind]);
    await useOwner('learning'); phase = 'learning.copy-skills';
    for (const table of libraryTables) for (const row of libraries[table]) {
      const columns = Object.keys(row);
      await client.query(`INSERT INTO ${schemas.learning}.${quote(table)}(${columns.map(quote).join(',')}) VALUES(${columns.map((_, i) => '$' + (i + 1)).join(',')}) ON CONFLICT DO NOTHING`,
        columns.map(key => row[key] && typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]));
    }
    for (const row of skillReceipts) await client.query(`INSERT INTO ${schemas.learning}._storage_requests(request_id,fingerprint,result,committed_at)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [row.request_id, row.fingerprint, JSON.stringify(row.result), row.committed_at]);
    for (const { kind, table, values } of actions) {
      await useOwner(kind); phase = kind + '.delete.' + table;
      const keys = (await client.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
        WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY a.attnum`, [schemas[kind] + '.' + quote(table)])).rows.map(row => row.attname);
      if (!keys.length) fail('table-without-primary-key');
      for (const row of values) await client.query(`DELETE FROM ${schemas[kind]}.${quote(table)} WHERE ${keys.map((key, i) => quote(key) + '=$' + (i + 1)).join(' AND ')}`, keys.map(key => row[key]));
    }
    if (report.agent.rebuild) {
      await useOwner('agent'); phase = 'agent.drop-legacy-tables';
      if (oldAgent.length) await client.query(`DROP TABLE ${oldAgent.map(table => schemas.agent + '.' + quote(table)).join(',')}`);
      for (const table of ['_storage_outbox', '_storage_requests', '_storage_references', '_storage_migrations']) {
        phase = 'agent.clear.' + table; await client.query(`DELETE FROM ${schemas.agent}.${quote(table)}`);
      }
      await migrate('agent', agentServiceMigrations);
    }
    phase = 'reset.commit'; await client.query('COMMIT'); phase = 'private.remove-legacy-transfers';
    for (const file of files) { if (hash(await readFile(file.path)) !== file.sha256) fail('transfer-changed-after-plan'); await rm(file.path); }
    return report;
  } catch (error) { error.resetPhase = phase; await client?.query('ROLLBACK').catch(() => {}); throw error; }
  finally {
    try { await client?.end(); await stopPreparedDatabase?.(); }
    finally { await unlockRecovery?.(); await unlockDaemon(); }
  }
}
