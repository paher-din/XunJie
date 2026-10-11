// Exact seven additional objects approved for the fresh A1/A2 completion synthetic factory only.
export const completionSchema = `
CREATE TABLE help_policy_versions (
 id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id), created_by TEXT NOT NULL REFERENCES users(id),
 created_at_ms INTEGER NOT NULL, policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), content_hash TEXT NOT NULL CHECK(length(content_hash)=64));
CREATE TABLE check_rule_versions (
 id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id), created_by TEXT NOT NULL REFERENCES users(id),
 created_at_ms INTEGER NOT NULL, rules_json TEXT NOT NULL CHECK(json_valid(rules_json)), content_hash TEXT NOT NULL CHECK(length(content_hash)=64));
CREATE TABLE activity_versions (
 id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id), blueprint_id TEXT NOT NULL REFERENCES blueprint_drafts(id),
 source_revision INTEGER NOT NULL CHECK(source_revision>0), created_by TEXT NOT NULL REFERENCES users(id), created_at_ms INTEGER NOT NULL,
 activity_json TEXT NOT NULL CHECK(json_valid(activity_json)), content_hash TEXT NOT NULL CHECK(length(content_hash)=64));
CREATE TABLE activity_controls (
 activity_id TEXT PRIMARY KEY NOT NULL REFERENCES activity_versions(id), control_revision INTEGER NOT NULL CHECK(control_revision>0),
 status TEXT NOT NULL CHECK(status IN ('active','paused')), reason TEXT NOT NULL, controlled_by TEXT NOT NULL REFERENCES users(id), controlled_at_ms INTEGER NOT NULL);
CREATE TABLE assignments (
 id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id), student_id TEXT NOT NULL REFERENCES users(id),
 activity_id TEXT NOT NULL REFERENCES activity_versions(id), assignment_revision INTEGER NOT NULL CHECK(assignment_revision>0),
 status TEXT NOT NULL CHECK(status IN ('active','paused')), individual_paused INTEGER NOT NULL CHECK(individual_paused IN (0,1)),
 paused_by_activity INTEGER NOT NULL CHECK(paused_by_activity IN (0,1)), individual_reason TEXT NOT NULL, activity_reason TEXT NOT NULL,
 controlled_by TEXT NOT NULL REFERENCES users(id), controlled_at_ms INTEGER NOT NULL,
 CHECK((status='active')=(individual_paused=0 AND paused_by_activity=0)), UNIQUE(activity_id,student_id));
CREATE TABLE attempts (
 attempt_id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id), student_id TEXT NOT NULL REFERENCES users(id),
 assignment_id TEXT NOT NULL REFERENCES assignments(id), activity_id TEXT NOT NULL REFERENCES activity_versions(id),
 attempt_revision INTEGER NOT NULL CHECK(attempt_revision>0), decision_epoch INTEGER NOT NULL CHECK(decision_epoch>=0),
 attempt_json TEXT NOT NULL CHECK(json_valid(attempt_json)));
CREATE INDEX attempts_assignment ON attempts(assignment_id);
CREATE TABLE jobs (
 job_id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id), student_id TEXT REFERENCES users(id),
 attempt_id TEXT REFERENCES attempts(attempt_id), request_receipt_id TEXT NOT NULL REFERENCES command_receipts(receipt_id),
 purpose TEXT NOT NULL CHECK(purpose IN ('teacher_design','student_help','reminder','explicit_analysis','passive_analysis','student_run','teacher_sample')),
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelling','cancelled','stale','timed_out','outcome_unknown')),
 stop_requested INTEGER NOT NULL CHECK(stop_requested IN (0,1)), recovery_generation TEXT NOT NULL,
 job_json TEXT NOT NULL CHECK(json_valid(job_json)));
CREATE INDEX jobs_scope ON jobs(course_id,student_id,attempt_id);
`;
