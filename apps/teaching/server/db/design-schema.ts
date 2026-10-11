// Only appended by the explicitly approved, fresh A2 synthetic database factory.
export const designSchema = `
CREATE TABLE resource_versions (
 id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id),
 created_by TEXT NOT NULL REFERENCES users(id), created_at_ms INTEGER NOT NULL,
 format TEXT NOT NULL CHECK(format IN ('txt','markdown','paste')),
 kind TEXT NOT NULL CHECK(kind IN ('learning_material','private_answer','validation_asset')),
 title TEXT NOT NULL, body TEXT NOT NULL,
 byte_length INTEGER NOT NULL CHECK(byte_length>=0 AND byte_length<=262144),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 visibility_json TEXT NOT NULL CHECK(json_valid(visibility_json)),
 teacher_design_allowed INTEGER NOT NULL CHECK(teacher_design_allowed IN (0,1)),
 paragraphs_json TEXT NOT NULL CHECK(json_valid(paragraphs_json)));
CREATE TABLE competency_versions (
 course_id TEXT NOT NULL REFERENCES courses(id), competency_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), domain TEXT NOT NULL CHECK(domain IN ('domain','project','ai_collaboration')),
 title TEXT NOT NULL, PRIMARY KEY(course_id,competency_id,version));
CREATE TABLE blueprint_drafts (
 id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id),
 created_by TEXT NOT NULL REFERENCES users(id), created_at_ms INTEGER NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), draft_json TEXT NOT NULL CHECK(json_valid(draft_json)));
CREATE TABLE audit_events (
 server_seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), course_id TEXT NOT NULL REFERENCES courses(id),
 command_id TEXT NOT NULL, command TEXT NOT NULL, target TEXT NOT NULL,
 object_ref_json TEXT NOT NULL CHECK(json_valid(object_ref_json)),
 recovery_generation TEXT NOT NULL, committed_at_ms INTEGER NOT NULL);
CREATE TABLE command_receipts (
 receipt_id TEXT PRIMARY KEY NOT NULL, command_id TEXT UNIQUE NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), course_id TEXT NOT NULL REFERENCES courses(id),
 command TEXT NOT NULL, target TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64), recovery_generation TEXT NOT NULL,
 server_seq INTEGER UNIQUE NOT NULL REFERENCES audit_events(server_seq),
 result_json TEXT NOT NULL CHECK(json_valid(result_json)),
 UNIQUE(actor_id,command,target,idempotency_key));
`;
