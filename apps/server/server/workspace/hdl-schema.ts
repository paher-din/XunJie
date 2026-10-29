// Authorized only for a new 29-table synthetic database; original factories never migrate.
export const hdlSchema=`
CREATE TABLE hdl_builds (
 build_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
 job_id TEXT UNIQUE NOT NULL REFERENCES jobs(job_id), run_id TEXT UNIQUE NOT NULL,
 snapshot_id TEXT NOT NULL REFERENCES artifact_snapshots(snapshot_id),
 board_profile_version TEXT NOT NULL, mapping_version TEXT NOT NULL, runtime_profile_version TEXT NOT NULL,
 status TEXT NOT NULL, artifact_hash TEXT CHECK(artifact_hash IS NULL OR length(artifact_hash)=64),
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), build_json TEXT CHECK(build_json IS NULL OR json_valid(build_json)),
 result_hash TEXT CHECK(result_hash IS NULL OR length(result_hash)=64),
 CHECK((build_json IS NULL)=(result_hash IS NULL)));
CREATE INDEX hdl_build_attempt ON hdl_builds(attempt_id);
CREATE TABLE hdl_sessions (
 session_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
 build_id TEXT NOT NULL REFERENCES hdl_builds(build_id), request_receipt_id TEXT NOT NULL REFERENCES command_receipts(receipt_id),
 generation TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 status TEXT NOT NULL CHECK(status IN ('starting','active','stopping','stopped','failed','outcome_unknown')),
 confirmed_sequence INTEGER NOT NULL CHECK(confirmed_sequence>=0),
 termination_confirmed INTEGER NOT NULL CHECK(termination_confirmed IN (0,1)), stop_requested INTEGER NOT NULL CHECK(stop_requested IN (0,1)),
 pending_operation_id TEXT REFERENCES hdl_operations(operation_id), session_json TEXT NOT NULL CHECK(json_valid(session_json)));
CREATE UNIQUE INDEX hdl_occupied_attempt ON hdl_sessions(attempt_id) WHERE termination_confirmed=0;
CREATE TABLE hdl_operations (
 operation_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES hdl_sessions(session_id),
 job_id TEXT UNIQUE NOT NULL REFERENCES jobs(job_id), request_receipt_id TEXT UNIQUE NOT NULL REFERENCES command_receipts(receipt_id),
 sequence INTEGER NOT NULL CHECK(sequence>=0), request_hash TEXT NOT NULL CHECK(length(request_hash)=64), status TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 result_hash TEXT CHECK(result_hash IS NULL OR length(result_hash)=64), UNIQUE(session_id,sequence),
 CHECK((result_json IS NULL)=(result_hash IS NULL)));
CREATE INDEX hdl_operation_session ON hdl_operations(session_id,sequence);
`;
