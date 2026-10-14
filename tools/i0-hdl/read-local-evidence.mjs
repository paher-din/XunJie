import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Only the explicitly approved, fresh Robert synthetic database is eligible.
// Authentication rows, credentials, headers and model request bodies are never exported.
const root = '/opt/xunjie-ui-local';
const config = JSON.parse(readFileSync(`${root}/application-config.json`, 'utf8'));
if (process.platform !== 'linux' || !config.databaseFile.startsWith(`${root}/retained-tmp/`)) throw Error('Owned local synthetic database required');
const db = new DatabaseSync(config.databaseFile, { readOnly: true });
try {
  const all = sql => db.prepare(sql).all();
  const users = all('SELECT id FROM users');
  if (users.length !== 3 || users.some(row => !/^synthetic-robert-(teacher|student-[ab])$/.test(row.id))) throw Error('Synthetic identity mismatch');
  const tables = all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const json = (rows, columns) => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, columns.includes(key) && value !== null ? JSON.parse(value) : value])));
  const evidence = {
    observedAtUtc: new Date().toISOString(), scope: 'Fresh local synthetic engineering validation; no real learner data',
    origin: config.origin, recoveryGeneration: config.recoveryGeneration,
    tableCounts: tables.map(({ name }) => ({ name, count: db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n })),
    assignments: all('SELECT id,course_id,student_id,activity_id,assignment_revision,status FROM assignments'),
    attempts: all('SELECT attempt_id,assignment_id,course_id,student_id,activity_id,attempt_revision,decision_epoch FROM attempts'),
    files: all('SELECT file_id,attempt_id,path,document_version,lifecycle,content_hash FROM workspace_files'),
    snapshots: all('SELECT snapshot_id,attempt_id,workspace_revision,content_hash FROM artifact_snapshots ORDER BY workspace_revision'),
    commandReceipts: all('SELECT receipt_id,command_id,actor_id,course_id,command,target,idempotency_key,request_hash,recovery_generation,server_seq FROM command_receipts ORDER BY server_seq'),
    jobs: all('SELECT job_id,attempt_id,purpose,status,stop_requested,recovery_generation FROM jobs'),
    builds: json(all('SELECT build_id,attempt_id,job_id,run_id,snapshot_id,status,artifact_hash,result_hash,request_json,request_json AS request_json_text,build_json,build_json AS build_json_text FROM hdl_builds'), ['request_json', 'build_json']),
    sessions: json(all('SELECT session_id,attempt_id,build_id,generation,revision,status,confirmed_sequence,termination_confirmed,stop_requested,pending_operation_id,session_json FROM hdl_sessions'), ['session_json']),
    operations: json(all('SELECT operation_id,session_id,job_id,sequence,request_hash,status,request_json,request_json AS request_json_text,result_json,result_json AS result_json_text,result_hash FROM hdl_operations ORDER BY session_id,sequence'), ['request_json', 'result_json']),
    runs: json(all('SELECT run_id,attempt_id,job_id,snapshot_id,submission_json,result_json,result_hash,check_state FROM workspace_runs'), ['submission_json', 'result_json']),
    actions: json(all('SELECT action_id,attempt_id,job_id,message_id,content_hash,disposition,action_json FROM teaching_actions'), ['action_json']),
    messages: all('SELECT message_id,course_id,student_id,attempt_id,job_id,request_receipt_id,author_kind,content_hash,result_hash FROM teaching_messages'),
    deliveries: all('SELECT delivery_id,action_id,recipient_id,client_id,content_hash,recovery_generation,server_seq FROM teaching_deliveries'),
    teachingReceipts: json(all('SELECT receipt_id,action_id,delivery_id,content_hash,receipt_kind,client_id,client_receipt_id,server_seq,receipt_json FROM teaching_action_receipts ORDER BY server_seq'), ['receipt_json']),
    exclusions: ['users credentials', 'sessions credentials', 'login windows', 'signing secret', 'API key', 'headers', 'model HTTP request bodies'],
  };
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
} finally { db.close(); }
