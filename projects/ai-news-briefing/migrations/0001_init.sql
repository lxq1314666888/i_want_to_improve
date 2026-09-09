CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  published_at TEXT,
  excerpt TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS articles_time ON articles(COALESCE(published_at, first_seen_at));
CREATE INDEX IF NOT EXISTS articles_source_time ON articles(source, COALESCE(published_at, first_seen_at));

CREATE TABLE IF NOT EXISTS collection_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  succeeded_sources INTEGER NOT NULL,
  failed_sources INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  sources_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_received ON collection_runs(received_at);
CREATE INDEX IF NOT EXISTS runs_finished ON collection_runs(finished_at);
