CREATE TABLE IF NOT EXISTS app_settings(
  id INTEGER PRIMARY KEY CHECK(id=1),
  published TEXT NOT NULL,
  draft TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=0),
  updated INTEGER NOT NULL,
  published_at INTEGER
);
