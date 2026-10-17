CREATE TABLE IF NOT EXISTS lead_contacts (
 phone TEXT PRIMARY KEY, last_inbound INTEGER NOT NULL, created_at INTEGER NOT NULL,
 paused INTEGER NOT NULL DEFAULT 0, control_at INTEGER NOT NULL DEFAULT 0,
 lock_until INTEGER NOT NULL DEFAULT 0, lock_token TEXT
);
CREATE TABLE IF NOT EXISTS lead_jobs (
 id TEXT PRIMARY KEY, phone TEXT NOT NULL, body TEXT NOT NULL, inbound_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 reply TEXT, meta_id TEXT, error_code TEXT, delivery_status TEXT, delivery_at INTEGER
);
CREATE INDEX IF NOT EXISTS lead_jobs_pending ON lead_jobs(state,created_at);
CREATE INDEX IF NOT EXISTS lead_jobs_phone ON lead_jobs(phone,created_at);
CREATE INDEX IF NOT EXISTS lead_jobs_meta ON lead_jobs(meta_id);
CREATE TABLE IF NOT EXISTS lead_budget(day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lead_downloads (
 phone TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
 meta_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 delivery_status TEXT, delivery_at INTEGER, error_code TEXT
);
CREATE INDEX IF NOT EXISTS lead_downloads_meta ON lead_downloads(meta_id);
CREATE TABLE IF NOT EXISTS lead_read_receipts (
 id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, error_code TEXT
);
CREATE INDEX IF NOT EXISTS lead_reads_pending ON lead_read_receipts(state,created_at);
