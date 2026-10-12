// Approved A4 factory only: five additional tables in a new retained synthetic database.
export const reviewSchema = `
CREATE TABLE learner_context_revisions (
 course_id TEXT NOT NULL REFERENCES courses(id), student_id TEXT NOT NULL REFERENCES users(id),
 context_revision INTEGER NOT NULL CHECK(context_revision>0), actor_id TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL, context_json TEXT NOT NULL CHECK(json_valid(context_json)),
 CHECK(actor_id=student_id), PRIMARY KEY(course_id,student_id,context_revision));
CREATE TABLE learner_state_revisions (
 course_id TEXT NOT NULL REFERENCES courses(id), student_id TEXT NOT NULL REFERENCES users(id),
 state_revision INTEGER NOT NULL CHECK(state_revision>0), source_kind TEXT NOT NULL,
 source_id TEXT NOT NULL, created_at TEXT NOT NULL, state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 PRIMARY KEY(course_id,student_id,state_revision));
CREATE TABLE teacher_decisions (
 decision_id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id),
 student_id TEXT NOT NULL REFERENCES users(id), attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
 teacher_id TEXT NOT NULL REFERENCES users(id), expected_state_revision INTEGER NOT NULL CHECK(expected_state_revision>=0),
 result_state_revision INTEGER NOT NULL CHECK(result_state_revision>expected_state_revision),
 decision_json TEXT NOT NULL CHECK(json_valid(decision_json)), created_at TEXT NOT NULL,
 FOREIGN KEY(course_id,student_id,result_state_revision) REFERENCES learner_state_revisions(course_id,student_id,state_revision));
CREATE INDEX teacher_decision_scope ON teacher_decisions(course_id,student_id,attempt_id);
CREATE TABLE learner_disputes (
 dispute_id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id),
 student_id TEXT NOT NULL REFERENCES users(id), attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
 target_kind TEXT NOT NULL CHECK(target_kind IN ('claim','feedback')), target_id TEXT NOT NULL,
 target_revision INTEGER NOT NULL CHECK(target_revision>0), dispute_json TEXT NOT NULL CHECK(json_valid(dispute_json)), created_at TEXT NOT NULL);
CREATE INDEX learner_dispute_scope ON learner_disputes(course_id,student_id,attempt_id);
CREATE TABLE analysis_results (
 analysis_id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id),
 course_id TEXT NOT NULL REFERENCES courses(id), student_id TEXT NOT NULL REFERENCES users(id),
 attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), raw_body_text TEXT NOT NULL,
 result_hash TEXT NOT NULL CHECK(length(result_hash)=64), disposition TEXT NOT NULL CHECK(disposition IN ('accepted','rejected')),
 reason TEXT, result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL);
CREATE INDEX analysis_result_scope ON analysis_results(course_id,student_id,attempt_id);
`;
