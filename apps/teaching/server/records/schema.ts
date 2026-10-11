// Approved only for a new synthetic teaching database; existing factories never migrate.
export const teachingSchema = `
CREATE TABLE teaching_messages (
 message_id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id), student_id TEXT NOT NULL REFERENCES users(id),
 attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), job_id TEXT NOT NULL REFERENCES jobs(job_id),
 request_receipt_id TEXT REFERENCES command_receipts(receipt_id), author_kind TEXT NOT NULL CHECK(author_kind IN ('student','model')),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64), result_hash TEXT CHECK(result_hash IS NULL OR length(result_hash)=64),
 message_json TEXT NOT NULL CHECK(json_valid(message_json)));
CREATE UNIQUE INDEX teaching_message_job_author ON teaching_messages(job_id,author_kind);
CREATE INDEX teaching_message_attempt ON teaching_messages(attempt_id);
CREATE TABLE teaching_actions (
 action_id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id), student_id TEXT NOT NULL REFERENCES users(id),
 attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id),
 message_id TEXT NOT NULL UNIQUE REFERENCES teaching_messages(message_id), content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 disposition TEXT NOT NULL CHECK(disposition IN ('pending','cancelled','stale','failed')),
 action_json TEXT NOT NULL CHECK(json_valid(action_json)));
CREATE INDEX teaching_action_attempt ON teaching_actions(attempt_id,disposition);
CREATE TABLE teaching_deliveries (
 delivery_id TEXT PRIMARY KEY NOT NULL, action_id TEXT NOT NULL REFERENCES teaching_actions(action_id),
 recipient_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 recovery_generation TEXT NOT NULL, server_seq INTEGER NOT NULL REFERENCES audit_events(server_seq),
 delivery_json TEXT NOT NULL CHECK(json_valid(delivery_json)));
CREATE INDEX teaching_delivery_action ON teaching_deliveries(action_id,client_id);
CREATE INDEX teaching_delivery_client ON teaching_deliveries(recipient_id,client_id);
CREATE TABLE teaching_action_receipts (
 receipt_id TEXT PRIMARY KEY NOT NULL, action_id TEXT NOT NULL REFERENCES teaching_actions(action_id),
 delivery_id TEXT REFERENCES teaching_deliveries(delivery_id), content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 receipt_kind TEXT NOT NULL CHECK(receipt_kind IN ('received','displayed','acknowledged','cancelled','stale','failed')),
 client_receipt_id TEXT NOT NULL, client_id TEXT NOT NULL, server_seq INTEGER NOT NULL REFERENCES audit_events(server_seq),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 UNIQUE(action_id,content_hash,receipt_kind,client_receipt_id));
CREATE INDEX teaching_receipt_action ON teaching_action_receipts(action_id,server_seq);
`;
