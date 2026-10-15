export const personalAgentSchema = `
CREATE TABLE user_model_configs (
 user_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 config_json TEXT NOT NULL CHECK(json_valid(config_json)), updated_at TEXT NOT NULL);
CREATE TABLE agent_conversations (
 conversation_id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, title TEXT NOT NULL,
 updated_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
 current_message_ids_json TEXT NOT NULL CHECK(json_valid(current_message_ids_json)));
CREATE INDEX agent_conversation_owner ON agent_conversations(user_id,hidden,updated_at);
CREATE TABLE agent_turns (
 turn_id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL REFERENCES agent_conversations(conversation_id),
 user_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 turn_json TEXT NOT NULL CHECK(json_valid(turn_json)), UNIQUE(user_id,request_key));
CREATE INDEX agent_turn_conversation ON agent_turns(conversation_id);
CREATE TABLE agent_messages (
 message_id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL REFERENCES agent_conversations(conversation_id),
 user_id TEXT NOT NULL, turn_id TEXT REFERENCES agent_turns(turn_id),
 message_json TEXT NOT NULL CHECK(json_valid(message_json)));
CREATE INDEX agent_message_conversation ON agent_messages(conversation_id);
`;
