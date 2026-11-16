import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { agentServiceMigrations } from '@xunjie/agents/transport/session-storage';
import { personalProjectOperationId } from '@xunjie/learning-space/learning-data/personal-projects';

const quote = value => '"' + value.replaceAll('"', '""') + '"';
const hash = value => createHash('sha256').update(value).digest('hex');
const checksum = migration => hash(`${migration.version}\n${migration.name}\n${migration.sql}`);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const uuidPattern = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a, b) => canonical(a) === canonical(b);
const mentions = (value, ids) => typeof value === 'string' ? ids.some(id => value.includes(id))
  : !!value && typeof value === 'object' && Object.values(value).some(item => mentions(item, ids));

/** Kernel tables only, in foreign-key order. The business directory lives in the learning owner and is never listed here. */
const runtimeTables = ['agent_progress', 'agent_questions', 'agent_tool_calls', 'agent_attempts', 'agent_steps',
  'agent_inputs', 'agent_notifications', 'agent_controls', 'agent_events', 'agent_turns'];
const requiredAgentTables = [...runtimeTables, 'agent_runtime_sessions'];
const requiredAgentColumns = [['agent_turns', 'state'], ['agent_attempts', 'attempt_id'], ['agent_tool_calls', 'execution_mode'],
  ['agent_notifications', 'origin_turn_id'], ['agent_runtime_sessions', 'automatic_wake_blocked']];
const legacyAgentTables = `agent_runs agent_waits teaching_sessions teaching_requests teaching_runs teaching_events teaching_snapshots
  teaching_model_switches teaching_agent_definitions teaching_resolved_agents teaching_compactions teaching_inputs teaching_input_revisions
  teaching_controls teaching_run_input_selections teaching_dependency_bindings teaching_segment_transitions teaching_student_facts
  teaching_student_questions teaching_student_responses teaching_student_presentations teaching_budgets teaching_steps teaching_commands
  teaching_waits teaching_skill_loads`.split(/\s+/);
/** Loop-only receipts. `agent-session:` keeps the original Session identity receipt and is preserved. */
const runtimeReceiptPrefixes = ['agent-input:', 'agent-transition:', 'agent-continue:', 'agent-control:', 'agent-answer:',
  'agent-stop:', 'agent-notification:', 'agent-cancel-ack:', 'agent-recover:'];
const gatewayLoopReceiptPrefixes = ['model-segment:', 'model-boundary:', 'model-tool-results:', 'model-progress:',
  'model-dispatch-ended:', 'model-learning-ready:', 'model-origin:', 'model-route-provenance:', 'model-current-permit:',
  'model-device-current-permit:', 'paired-model-current-permit:', 'paired-model-request:', 'paired-grant:', 'paired-session:',
  'paired-recipient-recovery:'];
/** Model configuration and authorization ownership; never scanned as runtime history and never cleared. */
const gatewayBusinessTables = ['model_vault', 'model_credentials', 'model_connections', 'model_versions', 'model_selections',
  'model_use_grants', 'model_selection_pins', 'model_providers', 'model_learning_policies', 'model_member_devices',
  'model_device_choices', 'model_device_connection_choices', 'model_device_grant_creations', 'model_device_grant_revocations',
  'model_images', 'model_directory_cache'];
const preservedLearningTables = ['activities', 'personal_learning_projects', 'personal_materials', 'personal_material_versions',
  'pdf_documents', 'pdf_readings', 'session_material_adoptions', 'session_material_releases', 'work_heads', 'work_contents',
  'work_objects', 'work_versions', 'execution_records', 'channel_executions', 'native_sessions', 'teaching_artifacts',
  'agent_execution_commands', 'agent_execution_origins', 'agent_execution_authorities', 'conversation_labels', 'conversation_archives'];

export function parseSwitchArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  let root, apply = false, dryRun = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--root' && !root && args[index + 1] && !args[index + 1].startsWith('--')) root = resolve(args[++index]);
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--dry-run' && !dryRun) dryRun = true;
    else throw new Error('invalid-switch-arguments');
  }
  if (!root || apply && dryRun) throw new Error('invalid-switch-arguments');
  return { root, apply };
}

const usage = 'Usage: node scripts/switch-agent-runtime-data.mjs --root <stopped local or school environment> [--dry-run | --apply]';

/**
 * One-time scoped switch from the old Operation/Wait runtime to the Turn/Step kernel.
 * Owners share one database and must be stopped. Business identity, directory rows, project receipts,
 * materials, works, execution results, model configuration and credentials are preserved; only runtime
 * history and its native continuation chains are cleared. Never a database drop.
 */
export async function switchAgentRuntimeData({ root, admin, owners, apply = false, prepareDatabase }) {
  root = resolve(root);
  if (typeof apply !== 'boolean') fail('invalid-apply');
  const { acquireLock, ownsProcess } = await import(new URL('../packages/product-runtime/dist/io.js', import.meta.url).href);
  const unlockDaemon = await acquireLock(root, 'daemon', 0);
  let unlockRecovery, client, stopPreparedDatabase, phase = 'offline-check';
  async function useOwner(kind) {
    phase = kind + '.assume-role';
    await client.query('RESET ROLE');
    await client.query(`SET LOCAL ROLE ${quote(owners[kind].binding.migratorRole)}`);
    await client.query(`SET LOCAL search_path TO ${quote(owners[kind].binding.schema)},pg_catalog`);
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
    client = new pg.Client({ ...admin, connectionTimeoutMillis: 5000, application_name: 'xunjie-agent-runtime-data-switch' });
    await client.connect();
    if ((await client.query('SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND usename=ANY($1::text[]) LIMIT 1',
      [Object.values(owners).map(item => item.binding.connection.user)])).rowCount) fail('owner-connections-must-be-closed');
    await client.query('RESET ROLE'); phase = 'switch.begin';
    await client.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const schemas = {}, known = {}, report = {
      formatVersion: 1, mode: apply ? 'applied' : 'dry-run', changed: false,
      schema: { runtimeMigration: 'agent-turn-loop', runtimeTables: [], legacyTables: [] },
      preserved: { sessions: 0, directorySessions: 0, projects: 0, gatewaySegments: 0, gatewayAttempts: 0, gatewayImages: 0,
        learning: {}, resources: {}, receipts: {}, transport: 0 },
      cleared: { turns: 0, inputs: 0, steps: 0, attempts: 0, toolCalls: 0, questions: 0, notifications: 0, events: 0,
        controls: 0, progress: 0, agentReceipts: 0, pendingNotifications: 0, pendingCancellations: 0, wakeBlockedSessions: 0,
        gatewaySegments: 0, gatewayAttempts: 0, gatewayToolResults: 0, gatewayObservations: 0, gatewayProgress: 0,
        gatewayAdmissions: 0, gatewayOrigins: 0, gatewayAuthorizations: 0, gatewayPaired: 0, gatewayDeviceTasks: 0,
        gatewayReceipts: 0, gatewayReferences: 0 },
      repaired: { runtimeSessions: 0, brokenChains: 0 },
      verified: { projects: 0, workspaceSessionDerivations: 0, projectReceipts: 0, directoryReceipts: 0 },
      blocking: [],
    };
    const block = (code, detail) => report.blocking.push({ code, ...(detail === undefined ? {} : { detail }) });
    for (const [kind, { binding }] of Object.entries(owners)) {
      await useOwner(kind); phase = kind + '.inspect-identity';
      const schema = quote(binding.schema); schemas[kind] = schema;
      const state = (await client.query(`SELECT * FROM ${schema}._storage_identity${apply ? ' FOR UPDATE' : ''}`)).rows[0];
      if (state?.environment_id !== binding.owner.environmentId || state?.service_id !== binding.owner.serviceId || state?.core_version !== 1) fail('storage-identity-conflict');
      if (apply) await client.query(`LOCK TABLE ${schema}._storage_identity IN ACCESS EXCLUSIVE MODE`);
      known[kind] = new Set((await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [binding.schema])).rows.map(row => row.tablename));
    }
    async function rows(kind, table) {
      if (!known[kind].has(table)) return [];
      await useOwner(kind); phase = kind + '.inspect.' + table;
      return (await client.query(`SELECT to_jsonb(t) AS data FROM ${schemas[kind]}.${quote(table)} t`)).rows.map(row => row.data);
    }
    async function count(kind, table, where, values) {
      if (!known[kind].has(table)) return 0;
      await useOwner(kind);
      return Number((await client.query(`SELECT count(*) AS total FROM ${schemas[kind]}.${quote(table)}${where ? ' WHERE ' + where : ''}`, values)).rows[0].total);
    }
    async function remove(kind, table, where, values) {
      if (!known[kind].has(table)) return 0;
      await useOwner(kind); phase = kind + '.clear.' + table;
      const result = await client.query(`DELETE FROM ${schemas[kind]}.${quote(table)}${where ? ' WHERE ' + where : ''}`, values);
      return result.rowCount ?? 0;
    }

    // ---- 1. the new kernel schema must already be present; the old layout is never silently reused ----
    await useOwner('agent'); phase = 'agent.verify-schema';
    const journal = (await client.query(`SELECT version,name,checksum FROM ${schemas.agent}._storage_migrations ORDER BY version`)).rows;
    for (const [index, recorded] of journal.entries()) {
      const migration = agentServiceMigrations[recorded.version - 1];
      if (recorded.version !== index + 1 || !migration || migration.name !== recorded.name || checksum(migration) !== recorded.checksum) {
        block('agent-migration-conflict', recorded.version);
      }
    }
    const turnLoop = journal.find(recorded => recorded.name === 'agent-turn-loop');
    if (!turnLoop || turnLoop.version !== 9) block('runtime-migration-required');
    for (const table of requiredAgentTables) if (!known.agent.has(table)) block('runtime-table-missing', table);
    for (const [table, column] of requiredAgentColumns) {
      if (!known.agent.has(table)) continue;
      if (!(await client.query('SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3',
        [owners.agent.binding.schema, table, column])).rowCount) block('runtime-column-missing', table + '.' + column);
    }
    report.schema.runtimeTables = requiredAgentTables.filter(table => known.agent.has(table)).sort();
    report.schema.legacyTables = [...known.agent].filter(table => legacyAgentTables.includes(table)).sort();
    for (const table of report.schema.legacyTables) block('legacy-agent-table', table);
    for (const table of ['agent_session_directory', 'personal_learning_projects', 'activities']) if (!known.learning.has(table)) block('business-table-missing', table);
    for (const table of ['model_segments', 'model_attempts']) if (!known.model.has(table)) block('gateway-table-missing', table);
    if (report.blocking.length) { await client.query('ROLLBACK'); return report; }

    // ---- 2. business identity: the directory is the source of truth, runtime Sessions are re-initialized under it ----
    const directory = await rows('learning', 'agent_session_directory');
    const directoryBySession = new Map(directory.map(row => [row.session_id, row]));
    const sessions = await rows('agent', 'agent_runtime_sessions');
    const sessionIds = new Set([...directory.map(row => row.session_id), ...sessions.map(row => row.session_id)]);
    report.preserved.directorySessions = directory.length;
    report.preserved.sessions = sessions.length;
    const runtimeBodies = new Map();
    for (const row of sessions) {
      const body = row.body ?? {};
      if (!uuid.test(String(row.session_id)) || !body.identity || !body.scenario || !body.createdAt) { block('runtime-session-identity-missing', row.session_id); continue; }
      runtimeBodies.set(row.session_id, body);
    }
    const fixedBodies = new Map();
    for (const sessionId of sessionIds) {
      const entry = directoryBySession.get(sessionId), existing = runtimeBodies.get(sessionId);
      const source = entry?.body ?? existing;
      if (!source?.identity || !source?.scenario || !source?.createdAt) { block('session-identity-missing', sessionId); continue; }
      // Only the four kernel identity fields survive; the original Session ID, identity and scenario are never replaced.
      fixedBodies.set(sessionId, { sessionId, identity: source.identity, scenario: source.scenario,
        createdAt: entry?.body?.createdAt ?? existing?.createdAt ?? source.createdAt });
      if (!existing) report.repaired.runtimeSessions++;
    }
    if (report.blocking.length) { await client.query('ROLLBACK'); return report; }

    // ---- 3. project receipts and the operationId-derived workspace Session ----
    const projects = await rows('learning', 'personal_learning_projects');
    const learningReceipts = await rows('learning', '_storage_requests');
    const receiptById = new Map(learningReceipts.map(row => [row.request_id, row]));
    report.preserved.projects = projects.length;
    for (const row of projects) {
      const project = row.body ?? {}, operationId = project.operationId;
      const derived = personalProjectOperationId(operationId, 'session');
      if (project.workspaceSessionId !== derived || project.projectId !== personalProjectOperationId(operationId, 'project')) {
        block('project-session-derivation-conflict', row.project_id); continue;
      }
      report.verified.workspaceSessionDerivations++;
      const workspace = directoryBySession.get(project.workspaceSessionId), home = directoryBySession.get(project.sourceSessionId);
      if (!workspace || workspace.workspace_activity_id !== project.activityId || workspace.space_environment_id !== project.identity?.environmentId
        || workspace.space_id !== project.identity?.spaceId || workspace.principal_id !== project.identity?.principalId) {
        block('project-workspace-association-missing', row.project_id); continue;
      }
      if (!home) { block('project-source-session-missing', row.project_id); continue; }
      const committed = receiptById.get('personal-project:' + operationId), reserved = receiptById.get('personal-project:' + operationId + ':reserve');
      if (!committed || !same(committed.result, project) || !reserved?.result?.input
        || reserved.result.input.operationId !== operationId || !same(reserved.result.identity, project.identity)) {
        block('project-receipt-conflict', row.project_id); continue;
      }
      report.verified.projectReceipts++;
      for (const sessionId of [project.workspaceSessionId, project.sourceSessionId]) {
        const entry = directoryBySession.get(sessionId);
        const subject = hash(JSON.stringify([entry.body.identity.environmentId, entry.body.identity.spaceId, entry.body.identity.principalId, entry.body.identity.kind]));
        const creation = receiptById.get(`agent-session:${subject}:${entry.body.requestId}`);
        if (!creation || creation.fingerprint !== entry.create_digest) block('session-receipt-conflict', sessionId);
        else report.verified.directoryReceipts++;
      }
      report.verified.projects++;
    }
    for (const table of preservedLearningTables) report.preserved.learning[table] = await count('learning', table);
    if (report.blocking.length) { await client.query('ROLLBACK'); return report; }

    // ---- 4. runtime history inventory (cleared) versus business content (preserved) ----
    const clearedByTable = { agent_turns: 'turns', agent_inputs: 'inputs', agent_steps: 'steps', agent_attempts: 'attempts',
      agent_tool_calls: 'toolCalls', agent_questions: 'questions', agent_notifications: 'notifications', agent_events: 'events',
      agent_controls: 'controls', agent_progress: 'progress' };
    for (const [table, key] of Object.entries(clearedByTable)) report.cleared[key] = await count('agent', table);
    report.cleared.pendingNotifications = await count('agent', 'agent_notifications', "state='pending'");
    report.cleared.pendingCancellations = await count('agent', 'agent_controls', "operation='cancel-turn' AND body->>'state'='pending'");
    report.cleared.wakeBlockedSessions = sessions.filter(row => row.automatic_wake_blocked !== null && row.automatic_wake_blocked !== undefined).length;
    const agentReceipts = await rows('agent', '_storage_requests');
    // Only runtime record identities retire a receipt; the preserved Session ID is business identity, never a clearing key.
    const runtimeIdColumns = { agent_turns: ['turn_id', 'request_id', 'origin_notification_id'], agent_inputs: ['input_id', 'request_id'],
      agent_steps: ['step_id'], agent_attempts: ['attempt_id', 'request_ref', 'response_ref'], agent_tool_calls: ['tool_call_id', 'task_id'],
      agent_questions: ['question_id', 'answer_request_id'], agent_notifications: ['notification_id', 'task_id'],
      agent_events: ['event_id'], agent_controls: ['request_id'], agent_progress: ['event_id'] };
    const runtimeIds = new Set();
    for (const [table, columns] of Object.entries(runtimeIdColumns)) {
      for (const row of await rows('agent', table)) for (const column of columns) {
        const value = row[column];
        if (typeof value === 'string' && uuid.test(value)) runtimeIds.add(value);
      }
    }
    const retiredAgentReceipts = agentReceipts.filter(row => !row.request_id.startsWith('agent-session:') && row.fingerprint !== 'chunk-channel/1'
      && (runtimeReceiptPrefixes.some(prefix => row.request_id.startsWith(prefix)) || mentions(row.result, [...runtimeIds])));
    report.cleared.agentReceipts = retiredAgentReceipts.length;
    report.preserved.receipts.agent = agentReceipts.length - retiredAgentReceipts.length;
    report.preserved.transport = await count('agent', 'agent_chunk_transfers');
    report.preserved.resources.agent = await count('agent', '_storage_resources');

    // ---- 5. gateway native history: business-referenced responses survive, the continuation chain is broken ----
    const clearedSessions = [...sessionIds];
    const segments = (await rows('model', 'model_segments')).filter(row => row.body?.purpose === 'learning'
      && (row.body.sessionId === undefined || clearedSessions.includes(row.body.sessionId)));
    const segmentIds = segments.map(row => row.id);
    const attempts = (await rows('model', 'model_attempts')).filter(row => row.body?.purpose === 'learning'
      && (segmentIds.includes(row.body.segment?.segmentId) || clearedSessions.includes(row.body.authority?.permit?.sessionId)
        || row.body.segment === undefined && row.body.authority?.permit?.sessionId === undefined));
    const businessIds = new Set();
    const collect = text => { for (const found of String(text).match(uuidPattern) ?? []) businessIds.add(found.toLowerCase()); };
    for (const kind of ['learning', 'model', 'agent']) {
      const tables = kind === 'learning' ? [...known.learning].filter(table => !table.startsWith('_storage_'))
        : kind === 'model' ? gatewayBusinessTables : ['agent_chunk_transfers', 'agent_chunk_parts'];
      for (const table of tables) for (const row of await rows(kind, table)) collect(JSON.stringify(row));
      const receipts = await rows(kind, '_storage_requests');
      for (const row of receipts) {
        if (kind === 'model' && gatewayLoopReceiptPrefixes.some(prefix => row.request_id.startsWith(prefix))) continue;
        if (kind === 'agent' && (runtimeReceiptPrefixes.some(prefix => row.request_id.startsWith(prefix)) || row.request_id.startsWith('agent-session:'))) continue;
        collect(row.request_id); collect(row.fingerprint); collect(JSON.stringify(row.result));
      }
    }
    report.preserved.receipts.learning = learningReceipts.length;
    report.preserved.receipts.model = (await rows('model', '_storage_requests')).length;
    const referenced = id => businessIds.has(String(id).toLowerCase());
    const keptAttempts = new Set(attempts.filter(row => referenced(row.id) || referenced(row.body?.resultRef)).map(row => row.id));
    const keptSegments = new Set(segments.filter(row => referenced(row.id)
      || keptAttempts.has(row.body?.headAttemptId) || keptAttempts.has(row.body?.pendingAttemptId)).map(row => row.id));
    for (const row of attempts) if (keptAttempts.has(row.id) && row.body?.segment?.segmentId) keptSegments.add(row.body.segment.segmentId);
    const droppedAttempts = attempts.filter(row => !keptAttempts.has(row.id)).map(row => row.id);
    const droppedSegments = segments.filter(row => !keptSegments.has(row.id)).map(row => row.id);
    for (const row of attempts) if (droppedAttempts.includes(row.id) && row.body?.segment?.segmentId && !keptSegments.has(row.body.segment.segmentId)
      && !droppedSegments.includes(row.body.segment.segmentId)) droppedSegments.push(row.body.segment.segmentId);
    report.cleared.gatewaySegments = droppedSegments.length;
    report.cleared.gatewayAttempts = droppedAttempts.length;
    report.preserved.gatewaySegments = keptSegments.size;
    report.preserved.gatewayAttempts = keptAttempts.size;
    report.preserved.gatewayImages = await count('model', 'model_images');
    report.preserved.resources.model = await count('model', '_storage_resources');
    report.preserved.resources.learning = await count('learning', '_storage_resources');
    report.repaired.brokenChains = segments.filter(row => keptSegments.has(row.id) && row.body?.previousSegmentId !== undefined).length;
    const droppedIds = [...droppedSegments, ...droppedAttempts];
    const gatewayReceipts = await rows('model', '_storage_requests');
    const retiredGatewayReceipts = gatewayReceipts.filter(row => gatewayLoopReceiptPrefixes.some(prefix => row.request_id.startsWith(prefix))
      && (mentions(row.request_id, droppedIds) || mentions(row.fingerprint, droppedIds) || mentions(row.result, droppedIds)));
    report.cleared.gatewayReceipts = retiredGatewayReceipts.length;
    const gatewayReferences = (await rows('model', '_storage_references')).filter(row => droppedAttempts.some(id =>
      row.reference_id === 'model-segment-result:' + id || row.reference_id === 'model-request:' + id || row.reference_id === 'model-result:' + id
      || row.reference_id.startsWith('model-attempt-image:' + id + ':'))
      || droppedSegments.some(id => row.reference_id.startsWith('model-segment-source:' + id + ':')));
    report.cleared.gatewayReferences = gatewayReferences.length;
    for (const [table, key] of [['model_tool_results', 'gatewayToolResults'], ['model_attempt_progress', 'gatewayProgress'],
      ['model_learning_admissions', 'gatewayAdmissions']]) {
      report.cleared[key] = await count('model', table, 'attempt_id = ANY($1::uuid[])', [droppedAttempts]);
    }
    report.cleared.gatewayObservations = (await rows('model', 'model_observations')).filter(row => mentions(row.body, droppedAttempts)).length;
    report.cleared.gatewayOrigins = await count('model', 'model_origin_journals', 'association_id = ANY($1::uuid[])', [droppedIds]);
    report.cleared.gatewayAuthorizations = await count('model', 'model_origin_authorizations', 'association_id = ANY($1::uuid[])', [droppedIds]);
    report.cleared.gatewayPaired = await count('model', 'model_paired_grants', "kind IN ('segment','attempt') AND id = ANY($1::uuid[])", [droppedIds])
      + await count('model', 'model_paired_routes', "kind IN ('segment','attempt') AND id = ANY($1::uuid[])", [droppedIds])
      + await count('model', 'model_paired_sessions', "kind IN ('segment','attempt') AND id = ANY($1::uuid[])", [droppedIds]);
    report.cleared.gatewayDeviceTasks = await count('model', 'model_device_tasks', 'task->>\'attemptId\' = ANY($1::text[])', [droppedAttempts]);
    report.changed = Object.values(report.cleared).some(value => value > 0) || report.repaired.runtimeSessions > 0 || report.repaired.brokenChains > 0;
    if (!apply || !report.changed) { await client.query('ROLLBACK'); return report; }

    // ---- 6. apply: business references first, then runtime records, inside one fenced transaction ----
    phase = 'model.break-chains';
    await useOwner('model');
    if (keptSegments.size) await client.query(`UPDATE ${schemas.model}.model_segments SET body=body-'previousSegmentId'
      WHERE id = ANY($1::uuid[]) AND body ? 'previousSegmentId'`, [[...keptSegments]]);
    const retiredGatewayIds = retiredGatewayReceipts.map(row => row.request_id);
    if (retiredGatewayIds.length) {
      await client.query(`DELETE FROM ${schemas.model}._storage_outbox WHERE request_id = ANY($1::text[])`, [retiredGatewayIds]);
      await client.query(`DELETE FROM ${schemas.model}._storage_requests WHERE request_id = ANY($1::text[])`, [retiredGatewayIds]);
    }
    if (gatewayReferences.length) await client.query(`DELETE FROM ${schemas.model}._storage_references WHERE reference_id = ANY($1::text[])`,
      [gatewayReferences.map(row => row.reference_id)]);
    // Admissions and origin authorizations hold foreign keys into the history being cleared.
    await remove('model', 'model_learning_admissions', 'attempt_id = ANY($1::uuid[])', [droppedAttempts]);
    await remove('model', 'model_attempt_progress', 'attempt_id = ANY($1::uuid[])', [droppedAttempts]);
    await remove('model', 'model_tool_results', 'attempt_id = ANY($1::uuid[])', [droppedAttempts]);
    for (const row of (await rows('model', 'model_observations')).filter(row => mentions(row.body, droppedAttempts)))
      await remove('model', 'model_observations', 'id=$1 AND version=$2 AND scope=$3', [row.id, row.version, row.scope]);
    await remove('model', 'model_origin_authorizations', 'association_id = ANY($1::uuid[])', [droppedIds]);
    await remove('model', 'model_origin_journals', 'association_id = ANY($1::uuid[])', [droppedIds]);
    for (const table of ['model_paired_grants', 'model_paired_routes', 'model_paired_sessions'])
      await remove('model', table, "kind IN ('segment','attempt') AND id = ANY($1::uuid[])", [droppedIds]);
    await remove('model', 'model_paired_requests', "body->'origin'->>'segmentId' = ANY($1::text[]) OR body->'origin'->>'attemptId' = ANY($1::text[])", [droppedIds]);
    await remove('model', 'model_device_tasks', 'task->>\'attemptId\' = ANY($1::text[])', [droppedAttempts]);
    await remove('model', 'model_attempts', 'id = ANY($1::uuid[])', [droppedAttempts]);
    await remove('model', 'model_segments', 'id = ANY($1::uuid[])', [droppedSegments]);

    phase = 'agent.clear-runtime';
    await useOwner('agent');
    const retiredAgentIds = retiredAgentReceipts.map(row => row.request_id);
    if (retiredAgentIds.length) {
      await client.query(`DELETE FROM ${schemas.agent}._storage_outbox WHERE request_id = ANY($1::text[])`, [retiredAgentIds]);
      await client.query(`DELETE FROM ${schemas.agent}._storage_requests WHERE request_id = ANY($1::text[])`, [retiredAgentIds]);
    }
    for (const table of runtimeTables) await remove('agent', table);
    for (const [sessionId, body] of fixedBodies) {
      await client.query(`INSERT INTO ${schemas.agent}.agent_runtime_sessions(session_id,body,state,next_seq,automatic_wake_blocked)
        VALUES($1,$2,'{}',1,NULL) ON CONFLICT(session_id) DO UPDATE SET body=EXCLUDED.body,state='{}',next_seq=1,automatic_wake_blocked=NULL`,
        [sessionId, body]);
    }
    // Sessions without a directory row keep their original identity and an empty history.
    for (const row of sessions) if (!fixedBodies.has(row.session_id)) await client.query(
      `UPDATE ${schemas.agent}.agent_runtime_sessions SET state='{}',next_seq=1,automatic_wake_blocked=NULL WHERE session_id=$1`, [row.session_id]);

    phase = 'switch.fence';
    for (const kind of Object.keys(schemas)) {
      await useOwner(kind);
      await client.query(`UPDATE ${schemas[kind]}._storage_identity SET writes_open=false,dispatch_open=false,generation=generation+1`);
    }
    phase = 'switch.commit'; await client.query('COMMIT');
    return report;
  } catch (error) { error.switchPhase = phase; await client?.query('ROLLBACK').catch(() => {}); throw error; }
  finally {
    try { await client?.end(); await stopPreparedDatabase?.(); }
    finally { await unlockRecovery?.(); await unlockDaemon(); }
  }
}

export async function runSwitchAgentRuntimeData(args) {
  const options = parseSwitchArguments(args);
  if (options.help) { console.log(usage); return; }
  if (process.versions.node !== '24.21.0') throw new Error('node-24.21.0-required');
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  const environment = await json(join(options.root, 'environment.json'));
  const configuration = await json(join(options.root, 'installation.json'));
  if (!['local', 'school'].includes(environment.profile)) throw new Error('local-or-school-environment-required');
  const { databaseBinding, resolveCredential, runPg, startDatabase, stopDatabase } = await import(new URL('../packages/product-runtime/dist/postgres.js', import.meta.url).href);
  const database = await databaseBinding(options.root, configuration.database);
  if (!database) throw new Error('database-required');
  const { credentialRef, ...connection } = database;
  const admin = { ...connection, password: await resolveCredential(options.root, credentialRef) }, owners = {};
  for (const [kind, unit] of [['agent', 'teaching-agent'], ['learning', 'learning-data'], ['model', 'model-connection']]) {
    const matches = environment.services.filter(service => service.unit === unit);
    if (matches.length !== 1) throw new Error('missing-or-duplicate-owner');
    const binding = await json(join(options.root, 'credentials', 'storage-' + matches[0].serviceId));
    if (binding.owner.environmentId !== environment.environmentId || binding.owner.serviceId !== matches[0].serviceId) throw new Error('owner-identity-conflict');
    owners[kind] = { binding };
  }
  const report = await switchAgentRuntimeData({ ...options, admin, owners, async prepareDatabase() {
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
  try { await runSwitchAgentRuntimeData(process.argv.slice(2)); }
  catch (error) {
    const code = error.code ?? error.message;
    const safeCode = /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : 'switch-failed';
    const phase = typeof error.switchPhase === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(error.switchPhase) ? ' phase=' + error.switchPhase : '';
    console.error(safeCode + phase); process.exitCode = 1;
  }
}
