// Approved only for a new synthetic workspace database; existing factories never migrate.
export const workspaceSchema = `
CREATE TABLE workspace_files (
 file_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), path TEXT NOT NULL,
 document_version INTEGER NOT NULL CHECK(document_version>0), lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','recycled')),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64), file_json TEXT NOT NULL CHECK(json_valid(file_json)));
CREATE UNIQUE INDEX workspace_active_path ON workspace_files(attempt_id,path) WHERE lifecycle='active';
CREATE TABLE artifact_snapshots (
 snapshot_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
 workspace_revision INTEGER NOT NULL CHECK(workspace_revision>=0), content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)));
CREATE INDEX snapshots_attempt ON artifact_snapshots(attempt_id);
CREATE TABLE workspace_runs (
 run_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), job_id TEXT UNIQUE NOT NULL REFERENCES jobs(job_id),
 snapshot_id TEXT NOT NULL REFERENCES artifact_snapshots(snapshot_id), submission_json TEXT NOT NULL CHECK(json_valid(submission_json)),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), result_hash TEXT CHECK(result_hash IS NULL OR length(result_hash)=64),
 check_policy_version TEXT, check_state TEXT CHECK(check_state IS NULL OR check_state IN ('active','ended')),
 CHECK((result_json IS NULL)=(result_hash IS NULL)), CHECK((check_policy_version IS NULL)=(check_state IS NULL)));
CREATE INDEX runs_attempt ON workspace_runs(attempt_id);
CREATE TABLE workspace_command_bindings (
 kind TEXT NOT NULL CHECK(kind IN ('public','sync')), key_json TEXT NOT NULL CHECK(json_valid(key_json)),
 receipt_id TEXT NOT NULL REFERENCES command_receipts(receipt_id), identity_json TEXT NOT NULL CHECK(json_valid(identity_json)), PRIMARY KEY(kind,key_json));
CREATE TABLE workspace_process_records (
 receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES command_receipts(receipt_id), attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
 capture_revision INTEGER NOT NULL CHECK(capture_revision>=0), kind TEXT NOT NULL CHECK(kind IN ('sync','coverage')),
 record_json TEXT NOT NULL CHECK(json_valid(record_json)));
CREATE INDEX process_attempt ON workspace_process_records(attempt_id);
`;
