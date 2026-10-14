import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, requestHash } from '../../apps/teaching/server/records/commands.ts';
import { validateIdentity, validateBoard, validateOperation, hdlLimits } from '../../apps/teaching/runner/hdl-profile.ts';
import { validateSnapshot } from '../../apps/teaching/runner/snapshot.ts';

// Exact original normal35 scope from server/db/transaction.ts, not a new database schema.
const tables = ['activity_controls','activity_versions','application_control','artifact_snapshots','assignments','attempts','audit_events',
  'blueprint_drafts','check_rule_versions','command_receipts','competency_versions','course_memberships','courses','digital_logic_config_versions',
  'hdl_builds','hdl_operations','hdl_sessions','help_policy_versions','jobs','login_attempt_windows','resource_versions','sessions',
  'teacher_design_proposals','teacher_design_requests','teaching_action_receipts','teaching_actions','teaching_deliveries','teaching_messages',
  'users','workspace_command_bindings','workspace_files','workspace_process_records','workspace_reopen_grants','workspace_runs','workspace_submissions'];
const localGeneration = 'synthetic-generation-c6772623-ba28-4c50-a853-337f77382452';
const localSource = '7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852';
const uiCommit = 'bec2e3c250091969f59e233439debd307a6925c2';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => natural(value) && value > 0;
const time = value => typeof value === 'string' && /^\d{1,32}$/.test(value);
const terminal = new Set(['succeeded','failed','cancelled','timed_out','stale']);
function ensure(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
function jsonFile(file) {
  const stat = lstatSync(file);
  ensure(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 * 1024, 'BOUNDED_PUBLIC_JSON_REQUIRED');
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Public export consistency only: never opens a database, authentication file, browser or network. */
export function verifyEvidence(evidence, options = {}) {
  const failures = [], missing = new Set(), facts = { checked: 0, builds: [], sessions: [], teachingChains: [] };
  const check = (name, id, fn) => {
    try { fn(); facts.checked++; }
    catch (error) { failures.push({ check: name, ...(id ? { id } : {}), code: /^[A-Z0-9_]{1,100}$/.test(error.code ?? '') ? error.code : 'INVALID_EXPORTED_STRUCTURE' }); }
  };
  const absent = (name, id) => missing.add(name + (id ? ':' + id : ''));
  const rows = key => {
    if (!Array.isArray(evidence[key])) { absent(key); return []; }
    ensure(evidence[key].length <= 100000, 'EXPORTED_ROWS_LIMIT'); return evidence[key];
  };
  const indexed = (list, key, label) => {
    const map = new Map();
    check(label + '.unique', undefined, () => { for (const row of list) { ensure(typeof row[key] === 'string' && row[key] && !map.has(row[key]), 'DUPLICATE_OR_MISSING_ID'); map.set(row[key], row); } });
    return map;
  };
  const generation = options.expectedGeneration ?? localGeneration;
  check('local.scope', undefined, () => {
    ensure(evidence.origin === 'https://127.0.0.1:3444' && evidence.scope === 'Fresh local synthetic engineering validation; no real learner data', 'OWNED_LOCAL_SCOPE_REQUIRED');
    ensure(evidence.recoveryGeneration === generation && /^synthetic-generation-/.test(generation), 'LOCAL_GENERATION_MISMATCH');
    ensure(Number.isFinite(Date.parse(evidence.observedAtUtc)), 'OBSERVATION_TIME_REQUIRED');
    ensure(Array.isArray(evidence.tableCounts) && canonical(evidence.tableCounts.map(row => row.name).sort()) === canonical(tables), 'ORIGINAL_35_TABLES_REQUIRED');
    ensure(evidence.tableCounts.every(row => natural(row.count)), 'INVALID_TABLE_COUNT');
    const counts = new Map(evidence.tableCounts.map(row => [row.name, row.count]));
    ensure(counts.get('users') === 3 && counts.get('courses') === 2 && counts.get('course_memberships') === 6, 'THREE_USERS_TWO_COURSES_REQUIRED');
  });
  const assignments = indexed(rows('assignments'), 'id', 'assignments');
  const attempts = indexed(rows('attempts'), 'attempt_id', 'attempts');
  const snapshots = indexed(rows('snapshots'), 'snapshot_id', 'snapshots');
  const files = indexed(rows('files'), 'file_id', 'files');
  const receipts = indexed(rows('commandReceipts'), 'command_id', 'commandReceipts');
  const jobs = indexed(rows('jobs'), 'job_id', 'jobs');
  const builds = indexed(rows('builds'), 'build_id', 'builds');
  const sessions = indexed(rows('sessions'), 'session_id', 'sessions');
  const operations = indexed(rows('operations'), 'operation_id', 'operations');
  const actions = indexed(rows('actions'), 'action_id', 'actions');
  const messages = indexed(rows('messages'), 'message_id', 'messages');
  const deliveries = indexed(rows('deliveries'), 'delivery_id', 'deliveries');
  const teachingReceipts = rows('teachingReceipts');
  check('export.completePublicCounts', undefined, () => {
    const counts = new Map((evidence.tableCounts ?? []).map(row => [row.name, row.count]));
    for (const [field, table] of Object.entries({ assignments: 'assignments', attempts: 'attempts', files: 'workspace_files', snapshots: 'artifact_snapshots',
      commandReceipts: 'command_receipts', jobs: 'jobs', builds: 'hdl_builds', sessions: 'hdl_sessions', operations: 'hdl_operations', runs: 'workspace_runs',
      actions: 'teaching_actions', messages: 'teaching_messages', deliveries: 'teaching_deliveries', teachingReceipts: 'teaching_action_receipts' }))
      if (Array.isArray(evidence[field])) ensure(evidence[field].length === counts.get(table), 'PUBLIC_EXPORT_ROW_COUNT_MISMATCH');
  });
  const expectedStudent = course => course === 'synthetic-robert-course-c' ? 'synthetic-robert-student-a'
    : course === 'synthetic-robert-course-hdl' ? 'synthetic-robert-student-b' : undefined;
  for (const assignment of assignments.values()) check('assignment.studentIsolation', assignment.id, () => {
    ensure(expectedStudent(assignment.course_id) === assignment.student_id, 'C_HDL_STUDENT_SCOPE_MISMATCH');
    ensure(typeof assignment.activity_id === 'string' && positive(assignment.assignment_revision), 'ASSIGNMENT_VERSION_REQUIRED');
  });
  for (const attempt of attempts.values()) check('attempt.assignment', attempt.attempt_id, () => {
    const assignment = assignments.get(attempt.assignment_id);
    ensure(assignment && assignment.course_id === attempt.course_id && assignment.student_id === attempt.student_id
      && assignment.activity_id === attempt.activity_id && positive(attempt.attempt_revision) && natural(attempt.decision_epoch), 'ATTEMPT_ASSIGNMENT_MISMATCH');
  });
  for (const file of files.values()) check('file.attempt', file.file_id, () => {
    ensure(attempts.has(file.attempt_id) && positive(file.document_version) && hash(file.content_hash), 'FILE_SCOPE_VERSION_HASH_REQUIRED');
  });
  for (const snapshot of snapshots.values()) check('snapshot.attempt', snapshot.snapshot_id, () => {
    ensure(attempts.has(snapshot.attempt_id) && natural(snapshot.workspace_revision) && hash(snapshot.content_hash), 'SNAPSHOT_SCOPE_HASH_REQUIRED');
  });
  const commandSeq = new Set();
  for (const receipt of receipts.values()) check('command.originalLocalProvenance', receipt.command_id, () => {
    ensure(receipt.recovery_generation === generation && expectedStudent(receipt.course_id) && hash(receipt.request_hash)
      && positive(receipt.server_seq) && !commandSeq.has(receipt.server_seq)
      && (receipt.actor_id === 'synthetic-robert-teacher' || receipt.actor_id === expectedStudent(receipt.course_id)), 'COMMAND_LOCAL_SCOPE_GENERATION_MISMATCH');
    commandSeq.add(receipt.server_seq);
  });
  for (const job of jobs.values()) check('job.scopeGeneration', job.job_id, () => {
    ensure(attempts.has(job.attempt_id) && job.recovery_generation === generation, 'JOB_SCOPE_GENERATION_MISMATCH');
    if (options.requireSettled) ensure(terminal.has(job.status), 'JOB_NOT_SETTLED');
  });
  function identity(value, attemptId, nodeId, command) {
    validateIdentity(value);
    const attempt = attempts.get(attemptId), receipt = receipts.get(value.commandId);
    ensure(attempt && value.id === nodeId && value.recoveryGeneration === generation
      && canonical(value.scope) === canonical({ courseId: attempt.course_id, studentId: attempt.student_id,
        attemptId, activityVersionId: attempt.activity_id }), 'NODE_IDENTITY_SCOPE_MISMATCH');
    ensure(receipt && receipt.actor_id === attempt.student_id && receipt.course_id === attempt.course_id
      && receipt.target === attemptId && receipt.command === 'shared.' + command && receipt.recovery_generation === generation
      && receipt.request_hash === value.requestHash && hash(receipt.request_hash), 'ORIGINAL_COMMAND_PROVENANCE_MISMATCH');
  }
  function raw(row, field, textField, id) {
    const value = row[field];
    if (value === null || value === undefined) return null;
    if (typeof row[textField] !== 'string') { absent(textField, id); return value; }
    const parsed = JSON.parse(row[textField]);
    ensure(canonical(parsed) === canonical(value), 'RAW_JSON_EXPORT_MISMATCH');
    return parsed;
  }
  for (const row of builds.values()) check('build.snapshotProvenanceHashTermination', row.build_id, () => {
    const snapshot = snapshots.get(row.snapshot_id), job = jobs.get(row.job_id);
    ensure(snapshot && snapshot.attempt_id === row.attempt_id && job?.attempt_id === row.attempt_id && row.run_id === row.build_id, 'BUILD_DATABASE_SCOPE_MISMATCH');
    const request = raw(row, 'request_json', 'request_json_text', row.build_id);
    if (!request) absent('build.request_json', row.build_id);
    else {
      identity(request.identity, row.attempt_id, row.build_id, 'hdl.build'); validateBoard(request.board); validateSnapshot(request.snapshot);
      ensure(request.snapshot.snapshotId === row.snapshot_id && request.snapshot.hash === snapshot.content_hash, 'BUILD_SNAPSHOT_SOURCE_MISMATCH');
    }
    const result = raw(row, 'build_json', 'build_json_text', row.build_id);
    if (!result) { if (options.requireSettled) ensure(false, 'BUILD_RESULT_NOT_SETTLED'); return; }
    identity(result.identity, row.attempt_id, row.build_id, 'hdl.build'); validateBoard(result.board);
    ensure(result.buildId === row.build_id && result.snapshotId === row.snapshot_id && result.snapshotHash === snapshot.content_hash
      && result.status === row.status && (result.artifactHash ?? null) === row.artifact_hash, 'BUILD_RESULT_BINDING_MISMATCH');
    ensure(result.configurationHash === sha256(JSON.stringify(result.board)), 'BUILD_BOARD_HASH_MISMATCH');
    if (request) ensure(canonical(result.identity) === canonical(request.identity) && canonical(result.board) === canonical(request.board)
      && result.runtimeProfileVersion === request.runtimeProfileVersion, 'BUILD_REQUEST_RESULT_MISMATCH');
    // server/workspace/hdl.ts hashes the original build_json bytes, not a deleted-field guess.
    if (typeof row.build_json_text === 'string') ensure(sha256(row.build_json_text) === row.result_hash, 'BUILD_RAW_RESULT_HASH_MISMATCH');
    ensure(typeof result.terminationConfirmed === 'boolean', 'BUILD_TERMINATION_REQUIRED');
    if (['succeeded','failed','cancelled'].includes(result.status) || options.requireSettled) ensure(result.terminationConfirmed, 'BUILD_EXIT_UNCONFIRMED');
    if (result.status === 'succeeded') ensure(hash(result.artifactHash), 'BUILD_ARTIFACT_REQUIRED');
    facts.builds.push({ buildId: row.build_id, attemptId: row.attempt_id, snapshotId: row.snapshot_id, status: row.status, terminationConfirmed: result.terminationConfirmed });
  });
  for (const row of sessions.values()) check('session.buildScopeState', row.session_id, () => {
    const result = row.session_json, buildRow = builds.get(row.build_id), build = buildRow?.build_json;
    ensure(build && build.status === 'succeeded' && build.terminationConfirmed && buildRow.attempt_id === row.attempt_id, 'SESSION_SUCCESSFUL_BUILD_REQUIRED');
    identity(result.identity, row.attempt_id, row.session_id, 'hdl.program');
    ensure(result.sessionId === row.session_id && result.buildId === row.build_id && result.snapshotId === build.snapshotId && result.snapshotHash === build.snapshotHash
      && result.boardProfileVersion === build.board.boardProfileVersion && result.mappingVersion === build.board.mappingVersion
      && result.runtimeProfileVersion === build.runtimeProfileVersion && result.engineVersion === build.engineVersion
      && row.generation === generation && result.sessionRevision === row.revision && result.confirmedSequence === row.confirmed_sequence
      && result.status === row.status && Number(result.terminationConfirmed) === row.termination_confirmed
      && Number(result.stopRequested) === row.stop_requested && (result.pendingOperationId ?? null) === row.pending_operation_id
      && positive(result.sessionRevision) && natural(result.confirmedSequence) && time(result.simTimePs), 'SESSION_RESULT_ROW_MISMATCH');
    if (result.terminationConfirmed) ensure(['stopped','failed'].includes(result.status) && !result.pendingOperationId, 'SESSION_CONFIRMED_EXIT_STATE_MISMATCH');
    if (options.requireSettled) ensure(result.terminationConfirmed && !result.pendingOperationId, 'SESSION_NOT_SETTLED');
    facts.sessions.push({ sessionId: row.session_id, buildId: row.build_id, sequence: row.confirmed_sequence,
      revision: row.revision, simTimePs: result.simTimePs, status: row.status, terminationConfirmed: result.terminationConfirmed });
  });
  function frame(value) {
    ensure(time(value?.simTimePs), 'SIM_TIME_DECIMAL_STRING_REQUIRED');
    for (const [signal, width] of [['switches',16],['buttons',5],['resetN',1],['leds',16],['anodes',8],['segments',7],['dp',1]])
      ensure(typeof value[signal] === 'string' && new RegExp(`^[01xz]{${width}}$`).test(value[signal]), 'EXACT_FOUR_STATE_FRAME_REQUIRED');
  }
  const grouped = new Map();
  for (const row of operations.values()) {
    const list = grouped.get(row.session_id) ?? []; list.push(row); grouped.set(row.session_id, list);
    check('operation.identityRawHashScope', row.operation_id, () => {
      const sessionRow = sessions.get(row.session_id), session = sessionRow?.session_json, job = jobs.get(row.job_id);
      ensure(session && job?.attempt_id === sessionRow.attempt_id && natural(row.sequence), 'OPERATION_SESSION_JOB_REQUIRED');
      const request = raw(row, 'request_json', 'request_json_text', row.operation_id);
      ensure(request, 'OPERATION_REQUEST_REQUIRED');
      identity(request.identity, sessionRow.attempt_id, row.operation_id, row.sequence === 0 ? 'hdl.program' : 'hdl.interact');
      ensure(canonical(request.identity.scope) === canonical(session.identity.scope) && requestHash(row.session_id, request) === row.request_hash, 'OPERATION_ORIGINAL_REQUEST_HASH_MISMATCH');
      if (row.sequence === 0) ensure(request.buildId === session.buildId && row.operation_id === row.session_id, 'PROGRAM_INITIAL_OPERATION_MISMATCH');
      else { validateOperation(request); ensure(request.sessionId === row.session_id && request.expectedSequence === row.sequence, 'INTERACTION_SEQUENCE_MISMATCH'); }
      const result = raw(row, 'result_json', 'result_json_text', row.operation_id);
      if (!result) { if (options.requireSettled) ensure(terminal.has(row.status), 'OPERATION_NOT_SETTLED'); return; }
      // Original worker and server use this precise inner body serialization; outer DB hash binds all raw bytes.
      const { resultHash, ...body } = result;
      ensure(sha256(JSON.stringify(body)) === resultHash, 'OPERATION_INNER_RESULT_HASH_MISMATCH');
      if (typeof row.result_json_text === 'string') ensure(sha256(row.result_json_text) === row.result_hash, 'OPERATION_RAW_RESULT_HASH_MISMATCH');
      ensure(result.operationId === row.operation_id && result.sessionId === row.session_id && result.sequence === row.sequence
        && result.buildId === session.buildId && result.snapshotId === session.snapshotId && result.snapshotHash === session.snapshotHash
        && result.boardProfileVersion === session.boardProfileVersion && result.mappingVersion === session.mappingVersion && result.engineVersion === session.engineVersion
        && positive(result.sessionRevision) && result.sessionRevision <= session.sessionRevision, 'OPERATION_RESULT_BINDING_MISMATCH');
      ensure(Array.isArray(result.frames) && result.frames.length >= 1 && result.frames.length <= hdlLimits.frames
        && natural(result.sampleCount) && natural(result.droppedFrames) && result.frames.length <= result.sampleCount
        && ['complete','incomplete'].includes(result.coverage), 'BOUNDED_TRACE_REQUIRED');
      result.frames.forEach(frame); frame(result.finalFrame);
      ensure(canonical(result.frames.at(-1)) === canonical(result.finalFrame), 'FINAL_FRAME_MISMATCH');
      for (let index = 1; index < result.frames.length; index++) ensure(BigInt(result.frames[index].simTimePs) >= BigInt(result.frames[index - 1].simTimePs), 'FRAME_TIME_MOVED_BACKWARD');
      // hdl-bridge.c emits changed/forced frames, not every sample; do not equate frames+dropped to sampleCount.
      ensure(result.coverage === (result.droppedFrames ? 'incomplete' : 'complete'), 'ORIGINAL_TRACE_COVERAGE_MISMATCH');
      if (row.sequence > 0) ensure(result.sessionRevision === request.expectedSessionRevision + 1 && result.sampleCount === request.advanceCycles, 'OPERATION_REVISION_SAMPLE_MISMATCH');
      else ensure(result.sessionRevision === 1 && result.finalFrame.simTimePs === '0', 'INITIAL_SEQUENCE_REVISION_TIME_MISMATCH');
      if (options.requireSettled) ensure(terminal.has(row.status), 'OPERATION_NOT_SETTLED');
    });
  }
  for (const [sessionId, list] of grouped) check('session.sequenceRevisionTimeContinuity', sessionId, () => {
    const session = sessions.get(sessionId)?.session_json;
    ensure(session, 'SEQUENCE_SESSION_REQUIRED'); list.sort((a,b) => a.sequence - b.sequence);
    ensure(list[0]?.sequence === 0 && new Set(list.map(row => row.sequence)).size === list.length, 'DUPLICATE_OR_MISSING_INITIAL_SEQUENCE');
    for (let index = 1; index < list.length; index++) ensure(list[index].sequence === list[index - 1].sequence + 1, 'SESSION_SEQUENCE_GAP');
    const confirmed = list.filter(row => row.result_json && row.status === 'succeeded');
    const last = confirmed.at(-1)?.result_json;
    if (last) ensure(last.sequence === session.confirmedSequence && last.finalFrame.simTimePs === session.simTimePs
      && (session.terminationConfirmed ? last.sessionRevision <= session.sessionRevision : last.sessionRevision === session.sessionRevision), 'SESSION_LAST_CONFIRMED_RESULT_MISMATCH');
    for (let index = 1; index < confirmed.length; index++) {
      const previous = confirmed[index - 1].result_json, current = confirmed[index].result_json, request = confirmed[index].request_json;
      ensure(current.sessionRevision === previous.sessionRevision + 1 && request.expectedSessionRevision === previous.sessionRevision
        && BigInt(current.finalFrame.simTimePs) === BigInt(previous.finalFrame.simTimePs) + BigInt(request.advanceCycles) * 10000n, 'ORIGINAL_SIMULATION_TIME_REVISION_MISMATCH');
    }
  });
  for (const row of sessions.values()) {
    if (!grouped.has(row.session_id)) {
      if (options.requireSettled) failures.push({ check: 'session.initialOperation', id: row.session_id, code: 'SESSION_INITIAL_OPERATION_MISSING' });
      else absent('session.initialOperation', row.session_id);
    }
  }
  for (const message of messages.values()) check('message.jobScopeRequest', message.message_id, () => {
    const attempt = attempts.get(message.attempt_id), job = jobs.get(message.job_id);
    ensure(attempt && job?.attempt_id === message.attempt_id && message.course_id === attempt.course_id && message.student_id === attempt.student_id
      && ['student','model'].includes(message.author_kind) && hash(message.content_hash), 'MESSAGE_SCOPE_JOB_MISMATCH');
    ensure([...receipts.values()].some(receipt => receipt.receipt_id === message.request_receipt_id
      && receipt.target === `/api/attempts/${message.attempt_id}/help` && receipt.command === 'shared.student_help.create'
      && receipt.course_id === attempt.course_id && receipt.actor_id === attempt.student_id
      && receipt.recovery_generation === generation), 'MESSAGE_ORIGINAL_REQUEST_RECEIPT_REQUIRED');
  });
  for (const row of actions.values()) check('action.messageBasisLinkage', row.action_id, () => {
    const action = row.action_json, attempt = attempts.get(row.attempt_id), job = jobs.get(row.job_id), message = messages.get(row.message_id);
    if (!message) absent('action.message', row.action_id);
    else ensure(message.author_kind === 'model' && message.job_id === row.job_id && message.attempt_id === row.attempt_id && message.content_hash === row.content_hash, 'ACTION_MODEL_MESSAGE_MISMATCH');
    ensure(attempt && job?.attempt_id === row.attempt_id && action.actionId === row.action_id && action.jobId === row.job_id
      && action.messageId === row.message_id && action.contentHash === row.content_hash && action.disposition === row.disposition
      && action.generation === generation && canonical(action.scope) === canonical({ courseId: attempt.course_id, studentId: attempt.student_id, attemptId: row.attempt_id })
      && action.targetVersions.activityVersionId === attempt.activity_id, 'ACTION_SCOPE_VERSIONS_MISMATCH');
    const basis = action.basis.hdl;
    if (basis) {
      const build = builds.get(basis.buildId), snapshot = snapshots.get(basis.snapshotId);
      ensure(build?.attempt_id === row.attempt_id && snapshot?.attempt_id === row.attempt_id && snapshot.content_hash === basis.snapshotHash
        && build.snapshot_id === basis.snapshotId && sha256(JSON.stringify(build.build_json)) === basis.buildResultHash, 'TEACHING_FROZEN_BUILD_BASIS_MISMATCH');
      const objectRef = action.basis.objectRef;
      if (objectRef?.kind === 'code') {
        const file = build.request_json?.snapshot.files.find(file => file.fileId === objectRef.fileId);
        if (!file) absent('teaching.snapshotFile', row.action_id);
        else ensure(objectRef.snapshotId === basis.snapshotId && objectRef.attemptId === row.attempt_id && objectRef.path === file.path
          && objectRef.documentVersion === file.documentVersion && objectRef.contentHash === file.contentHash, 'TEACHING_CODE_SNAPSHOT_MISMATCH');
      }
    }
  });
  for (const delivery of deliveries.values()) check('delivery.actionRecipient', delivery.delivery_id, () => {
    const action = actions.get(delivery.action_id)?.action_json;
    ensure(action && delivery.recipient_id === action.scope.studentId && delivery.content_hash === action.contentHash
      && delivery.recovery_generation === generation && positive(delivery.server_seq), 'DELIVERY_SCOPE_CONTENT_MISMATCH');
    if (!delivery.client_id) absent('delivery.client_id', delivery.delivery_id);
  });
  const receiptIds = new Set(), teachingSeq = new Set(), clientReceiptIds = new Set();
  for (const receipt of teachingReceipts) check('teachingReceipt.originalDeliveryMetadata', receipt.receipt_id, () => {
    ensure(!receiptIds.has(receipt.receipt_id) && !teachingSeq.has(receipt.server_seq) && positive(receipt.server_seq), 'DUPLICATE_TEACHING_RECEIPT_SEQUENCE');
    receiptIds.add(receipt.receipt_id); teachingSeq.add(receipt.server_seq);
    const delivery = deliveries.get(receipt.delivery_id), action = actions.get(receipt.action_id)?.action_json;
    ensure(delivery && action && delivery.action_id === receipt.action_id && receipt.content_hash === delivery.content_hash
      && receipt.content_hash === action.contentHash && receipt.server_seq > delivery.server_seq, 'TEACHING_RECEIPT_DELIVERY_MISMATCH');
    const value = receipt.receipt_json;
    if (!value) { absent('teachingReceipt.receipt_json', receipt.receipt_id); return; }
    ensure(value.receiptId === receipt.receipt_id && value.actionId === receipt.action_id && value.deliveryId === receipt.delivery_id
      && value.receiptKind === receipt.receipt_kind && value.contentHash === receipt.content_hash && value.serverSeq === receipt.server_seq
      && value.clientId === receipt.client_id && value.clientId === delivery.client_id && value.clientReceiptId === receipt.client_receipt_id
      && canonical(value.versions) === canonical(action.targetVersions) && Number.isFinite(Date.parse(value.serverReceivedAt)), 'TEACHING_RECEIPT_ORIGINAL_FIELDS_MISMATCH');
    ensure(value.clientReceiptId && !clientReceiptIds.has(value.clientId + ':' + value.clientReceiptId), 'DUPLICATE_CLIENT_RECEIPT');
    clientReceiptIds.add(value.clientId + ':' + value.clientReceiptId);
  });
  for (const delivery of deliveries.values()) {
    const linked = teachingReceipts.filter(receipt => receipt.delivery_id === delivery.delivery_id).sort((a,b) => a.server_seq - b.server_seq);
    const received = linked.find(receipt => receipt.receipt_kind === 'received' && !receipt.receipt_json?.raceReason);
    const displayed = linked.find(receipt => receipt.receipt_kind === 'displayed' && !receipt.receipt_json?.raceReason);
    const acknowledged = linked.find(receipt => receipt.receipt_kind === 'acknowledged' && !receipt.receipt_json?.raceReason);
    if (displayed) check('teaching.displayedAfterReceived', delivery.delivery_id, () => ensure(received && displayed.server_seq > received.server_seq, 'DISPLAYED_WITHOUT_EARLIER_RECEIVED'));
    if (acknowledged) check('teaching.explicitResponseAfterDisplayed', delivery.delivery_id, () => ensure(displayed && acknowledged.server_seq > displayed.server_seq, 'ACK_WITHOUT_EARLIER_DISPLAYED'));
    facts.teachingChains.push({ actionId: delivery.action_id, deliveryId: delivery.delivery_id,
      receivedServerSeq: received?.server_seq ?? null, displayedServerSeq: displayed?.server_seq ?? null,
      syntheticExplicitResponseServerSeq: acknowledged?.server_seq ?? null,
      raceReceipts: linked.filter(receipt => receipt.receipt_json?.raceReason).map(receipt => ({ serverSeq: receipt.server_seq, raceReason: receipt.receipt_json.raceReason })) });
  }
  if (options.requireSettled) {
    check('final.explicitTeachingReceiptChain', undefined, () => ensure(facts.teachingChains.some(chain => chain.receivedServerSeq && chain.displayedServerSeq && chain.syntheticExplicitResponseServerSeq), 'NO_COMPLETE_SYNTHETIC_TEACHING_RECEIPT_CHAIN'));
    for (const field of missing) failures.push({ check: 'final.requiredEvidence', code: 'MISSING_PUBLIC_EVIDENCE', field });
  }
  return { status: failures.length ? 'failed' : options.requireSettled ? 'settled-consistent' : 'in-progress-consistent',
    requireSettled: Boolean(options.requireSettled), origin: evidence.origin, recoveryGeneration: evidence.recoveryGeneration,
    counts: { assignments: assignments.size, attempts: attempts.size, files: files.size, snapshots: snapshots.size, builds: builds.size,
      sessions: sessions.size, operations: operations.size, jobs: jobs.size, messages: messages.size, actions: actions.size, teachingReceipts: teachingReceipts.length },
    facts, missingEvidence: [...missing], failures,
    boundaries: ['Public exported ledger consistency; no live database/auth/browser/model access',
      'Server displayed and acknowledged receipts are linked facts; actual visibility and explicit synthetic browser actions need separate screenshots/operation evidence',
      'Model HTTP/token journal is never used as display proof; no human-learning, teacher semantics, H3/2800/course_check or complete AC/NFR claim'] };
}

/** Compare read-only refresh exports: exact file versions and execution object sets, without requiring unrelated historical counts. */
export function compareRefresh(before, after) {
  const groups = { assignments: ['id','course_id','student_id','activity_id','assignment_revision','status'],
    attempts: ['attempt_id','assignment_id','course_id','student_id','activity_id','attempt_revision','decision_epoch'],
    files: ['file_id','attempt_id','path','document_version','lifecycle','content_hash'], snapshots: ['snapshot_id','attempt_id','workspace_revision','content_hash'],
    builds: ['build_id','attempt_id','job_id','snapshot_id','status','result_hash'], sessions: ['session_id','attempt_id','build_id','generation','revision','confirmed_sequence','status','pending_operation_id'],
    operations: ['operation_id','session_id','job_id','sequence','status','request_hash','result_hash'],
    jobs: ['job_id','attempt_id','purpose','status','stop_requested','recovery_generation'], runs: ['run_id','attempt_id','job_id','snapshot_id','result_hash'] };
  const failures = [];
  if (before.recoveryGeneration !== after.recoveryGeneration || before.origin !== after.origin) failures.push('REFRESH_ORIGIN_GENERATION_CHANGED');
  for (const [key, fields] of Object.entries(groups)) {
    if (!Array.isArray(before[key]) || !Array.isArray(after[key])) { failures.push('REFRESH_MISSING_' + key.toUpperCase()); continue; }
    const project = input => input[key].map(row => Object.fromEntries(fields.map(field => [field, row[field] ?? null]))).sort((a,b) => String(a[fields[0]]).localeCompare(String(b[fields[0]])));
    if (canonical(project(before)) !== canonical(project(after))) failures.push('REFRESH_CHANGED_' + key.toUpperCase());
  }
  return { status: failures.length ? 'failed' : 'unchanged', exactGroups: Object.keys(groups), failures,
    boundary: 'The supplied before/after objects match; this comparison does not operate or independently identify the browser refresh.' };
}

function argumentsFor(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--require-settled') options.requireSettled = true;
    else if (arg === '--help') options.help = true;
    else if (['--file','--manifest','--bundle','--node-receipt','--expected-generation','--refresh-before','--refresh-after'].includes(arg)) {
      ensure(args[index + 1] && !args[index + 1].startsWith('--'), 'ARGUMENT_VALUE_REQUIRED'); options[arg.slice(2)] = args[++index];
    } else ensure(false, 'UNKNOWN_ARGUMENT');
  }
  ensure(options.help || options.file, 'PUBLIC_EVIDENCE_FILE_REQUIRED');
  ensure(!options.bundle || options.manifest, 'BUNDLE_MANIFEST_REQUIRED');
  ensure(Boolean(options['refresh-before']) === Boolean(options['refresh-after']), 'REFRESH_PAIR_REQUIRED');
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = argumentsFor(process.argv.slice(2));
    if (options.help) process.stdout.write('node verify-local-browser-evidence.mjs --file PUBLIC_JSON [--require-settled] [--expected-generation GENERATION] [--manifest PUBLIC_STATIC_MANIFEST] [--bundle PUBLIC_ZIP] [--node-receipt PUBLIC_NODE_RECEIPT] [--refresh-before PUBLIC_JSON --refresh-after PUBLIC_JSON]\nReads public JSON/artifact bytes only. Default permits in-progress jobs/sessions; final requires settled work and linked synthetic receipt chain. No database, auth file, browser or network access.\n');
    else {
      const evidence = jsonFile(options.file), result = verifyEvidence(evidence, { requireSettled: options.requireSettled, expectedGeneration: options['expected-generation'] });
      const extra = (check, fn) => { try { fn(); } catch (error) { result.failures.push({ check, code: error.code ?? 'INVALID_PUBLIC_EVIDENCE' }); result.status = 'failed'; } };
      if (options.manifest) extra('static.fixedManifest', () => {
        const manifest = jsonFile(options.manifest);
        ensure(manifest.sourceCommit === uiCommit && manifest.sourceDirty === false && manifest.normalBuild === true && manifest.staticFiles === 143
          && manifest.containsSourceDatabase === false && manifest.containsCredentials === false && manifest.boundaryScan?.matches === 0
          && hash(manifest.sha256), 'FIXED_NORMAL_STATIC_MANIFEST_REQUIRED');
        if (options.bundle) ensure(sha256(readFileSync(options.bundle)) === manifest.sha256, 'STATIC_BUNDLE_HASH_MISMATCH');
        result.static = { sourceCommit: manifest.sourceCommit, sha256: manifest.sha256, bundleBytesChecked: Boolean(options.bundle) };
      });
      if (options['node-receipt']) extra('node.localIdentity', () => {
        const node = jsonFile(options['node-receipt']);
        ensure(node.sourceHash === localSource && node.recoveryGeneration === evidence.recoveryGeneration, 'LOCAL_NODE_IDENTITY_MISMATCH');
        for (const response of [node.c ?? node.runner, node.hdl]) {
          const ready = response?.data;
          ensure(ready?.ready && ready.recoveryGeneration === evidence.recoveryGeneration && ready.fingerprint.sourceHash === localSource
            && ready.validation.passed && sha256(JSON.stringify(ready.fingerprint)) === ready.validation.fingerprintHash, 'LOCAL_NODE_FINGERPRINT_VALIDATION_MISMATCH');
        }
        result.node = { sourceHash: node.sourceHash, recordConsistency: true, liveReadPerformed: false };
      });
      if (options['refresh-before']) {
        result.refresh = compareRefresh(jsonFile(options['refresh-before']), jsonFile(options['refresh-after']));
        if (result.refresh.failures.length) { result.status = 'failed'; result.failures.push({ check: 'refresh', code: 'REFRESH_EXPORT_CHANGED' }); }
      }
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (result.failures.length) process.exitCode = 1;
    }
  } catch (error) { process.stderr.write(JSON.stringify({ status: 'failed', code: /^[A-Z0-9_]{1,100}$/.test(error.code ?? '') ? error.code : 'PUBLIC_EVIDENCE_READ_FAILED' }) + '\n'); process.exitCode = 1; }
}
