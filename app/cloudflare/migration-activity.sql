-- First-party metadata only; opt-in identifiers never contain form/chat contents.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS activity_events(id TEXT PRIMARY KEY,visitor_id TEXT NOT NULL,session_id TEXT NOT NULL,conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,surface TEXT NOT NULL CHECK(surface IN ('website','customer')),page TEXT NOT NULL,screen TEXT NOT NULL,action TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN ('click','screen','media')),at INTEGER NOT NULL,received INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS activity_received ON activity_events(received,id);
CREATE INDEX IF NOT EXISTS activity_visitor_received ON activity_events(visitor_id,received,id);
CREATE INDEX IF NOT EXISTS activity_conversation_received ON activity_events(conversation_id,received,id);
CREATE INDEX IF NOT EXISTS activity_surface_received ON activity_events(surface,received,id);
CREATE TABLE IF NOT EXISTS activity_daily(day INTEGER PRIMARY KEY,download_requests INTEGER NOT NULL DEFAULT 0 CHECK(download_requests>=0));
