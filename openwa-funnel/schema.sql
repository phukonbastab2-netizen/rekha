-- Additive: separate namespace from all existing Meta, legacy and app data.
CREATE TABLE IF NOT EXISTS ow_backup (
 source TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,peer TEXT NOT NULL,
 revision INTEGER NOT NULL,stamp INTEGER NOT NULL,payload TEXT NOT NULL,
 PRIMARY KEY(source,key)
);
CREATE INDEX IF NOT EXISTS ow_backup_kind ON ow_backup(source,kind,key);
CREATE INDEX IF NOT EXISTS ow_backup_peer ON ow_backup(source,peer,kind,stamp);
CREATE INDEX IF NOT EXISTS ow_mobile_recent ON ow_backup(source,kind,stamp,key);
CREATE INDEX IF NOT EXISTS ow_mobile_chat_page ON ow_backup(source,peer,kind,stamp,key);
CREATE TABLE IF NOT EXISTS ow_mobile_pairings(hash TEXT PRIMARY KEY,source TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ow_mobile_sessions(hash TEXT PRIMARY KEY,source TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ow_mobile_rate(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ow_gateway_status(source TEXT PRIMARY KEY,payload TEXT NOT NULL,stamp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ow_mobile_commands(source TEXT NOT NULL,id TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'queued',result TEXT,PRIMARY KEY(source,id));
CREATE INDEX IF NOT EXISTS ow_mobile_pending ON ow_mobile_commands(source,state,created);
