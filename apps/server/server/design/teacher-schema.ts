// Only the explicitly approved fresh A3 synthetic factory includes these tables.
export const teacherDesignSchema = `
CREATE TABLE teacher_design_requests (
 job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(job_id),
 course_id TEXT NOT NULL REFERENCES courses(id), actor_id TEXT NOT NULL REFERENCES users(id),
 blueprint_id TEXT REFERENCES blueprint_drafts(id), base_revision INTEGER NOT NULL CHECK(base_revision>=0),
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), usage_json TEXT NOT NULL CHECK(json_valid(usage_json)));
CREATE TABLE teacher_design_proposals (
 proposal_id TEXT PRIMARY KEY NOT NULL, job_id TEXT UNIQUE NOT NULL REFERENCES teacher_design_requests(job_id),
 course_id TEXT NOT NULL REFERENCES courses(id), blueprint_id TEXT REFERENCES blueprint_drafts(id),
 base_revision INTEGER NOT NULL CHECK(base_revision>=0),
 result_hash TEXT NOT NULL CHECK(length(result_hash)=64),
 proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)), raw_result_json TEXT NOT NULL CHECK(json_valid(raw_result_json)),
 created_at_ms INTEGER NOT NULL);
`;
