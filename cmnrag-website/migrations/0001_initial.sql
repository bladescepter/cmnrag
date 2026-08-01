PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS articles (
  article_id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL UNIQUE,
  source_sha256 TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  author TEXT NOT NULL DEFAULT '',
  published_date TEXT NOT NULL,
  page TEXT NOT NULL,
  theme TEXT NOT NULL,
  edition_type TEXT NOT NULL,
  headline INTEGER NOT NULL CHECK (headline IN (0, 1)),
  image INTEGER NOT NULL DEFAULT 0 CHECK (image IN (0, 1)),
  column_name TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(published_date);
CREATE INDEX IF NOT EXISTS idx_articles_page ON articles(page);
CREATE INDEX IF NOT EXISTS idx_articles_theme ON articles(theme);
CREATE INDEX IF NOT EXISTS idx_articles_edition_type ON articles(edition_type);
CREATE INDEX IF NOT EXISTS idx_articles_headline ON articles(headline);
CREATE INDEX IF NOT EXISTS idx_articles_image ON articles(image);
CREATE INDEX IF NOT EXISTS idx_articles_column ON articles(column_name);
CREATE INDEX IF NOT EXISTS idx_articles_region ON articles(region);
CREATE INDEX IF NOT EXISTS idx_articles_author ON articles(author);

CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title,
  subtitle,
  author,
  column_name,
  region,
  content,
  content='articles',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS articles_fts_insert AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, subtitle, author, column_name, region, content)
  VALUES (new.rowid, new.title, new.subtitle, new.author, new.column_name, new.region, new.content);
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_delete AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, subtitle, author, column_name, region, content)
  VALUES ('delete', old.rowid, old.title, old.subtitle, old.author, old.column_name, old.region, old.content);
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_update AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, subtitle, author, column_name, region, content)
  VALUES ('delete', old.rowid, old.title, old.subtitle, old.author, old.column_name, old.region, old.content);
  INSERT INTO articles_fts(rowid, title, subtitle, author, column_name, region, content)
  VALUES (new.rowid, new.title, new.subtitle, new.author, new.column_name, new.region, new.content);
END;

CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_root TEXT NOT NULL,
  article_total INTEGER NOT NULL,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT NOT NULL DEFAULT ''
);
