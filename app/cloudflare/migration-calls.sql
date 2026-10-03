CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,caller TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS call_signals(id INTEGER PRIMARY KEY AUTOINCREMENT,call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,actor TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS calls_conversation ON calls(conversation_id,created);
CREATE UNIQUE INDEX IF NOT EXISTS calls_one_active_per_conversation ON calls(conversation_id) WHERE status!='ended';
