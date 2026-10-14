// Approved fresh-only DL-A additions; never applied to an existing database.
export const digitalLogicSchema = `
CREATE TABLE digital_logic_config_versions (
 id TEXT PRIMARY KEY NOT NULL,
 course_id TEXT NOT NULL REFERENCES courses(id),
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 config_json TEXT NOT NULL CHECK(json_valid(config_json)),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64)
);
CREATE INDEX digital_logic_config_course ON digital_logic_config_versions(course_id,id);
CREATE TABLE application_control (
 singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
 recovery_generation TEXT NOT NULL CHECK(length(recovery_generation)>0),
 control_revision INTEGER NOT NULL CHECK(control_revision>0),
 initialized_at_ms INTEGER NOT NULL CHECK(initialized_at_ms>=0)
);
`;
