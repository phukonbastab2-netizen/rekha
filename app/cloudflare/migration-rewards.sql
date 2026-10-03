CREATE TABLE IF NOT EXISTS reward_attempts(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,created INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reward_grants(transaction_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reward_grants_conversation ON reward_grants(conversation_id);
CREATE INDEX IF NOT EXISTS reward_attempts_conversation ON reward_attempts(conversation_id,created);
CREATE TABLE IF NOT EXISTS reward_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
