import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function database(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'astrorani.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, dob TEXT NOT NULL,
      language TEXT NOT NULL, preferences TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'ai',
      version INTEGER NOT NULL DEFAULT 0, free_used INTEGER NOT NULL DEFAULT 0,
      entitlement TEXT NOT NULL DEFAULT 'free', created INTEGER NOT NULL, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent',
      client_id TEXT, created INTEGER NOT NULL, UNIQUE(conversation_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS drafts (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      payment_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'created', created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);
    PRAGMA user_version=1;`);
  return db;
}
