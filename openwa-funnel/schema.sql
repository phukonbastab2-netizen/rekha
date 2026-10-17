-- Additive: separate namespace from all existing Meta, legacy and app data.
CREATE TABLE IF NOT EXISTS ow_backup (
 source TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,peer TEXT NOT NULL,
 revision INTEGER NOT NULL,stamp INTEGER NOT NULL,payload TEXT NOT NULL,
 PRIMARY KEY(source,key)
);
CREATE INDEX IF NOT EXISTS ow_backup_kind ON ow_backup(source,kind,key);
CREATE INDEX IF NOT EXISTS ow_backup_peer ON ow_backup(source,peer,kind,stamp);
