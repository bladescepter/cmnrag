CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,
  vector_id TEXT NOT NULL UNIQUE,
  article_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_total INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(article_id) REFERENCES articles(article_id) ON DELETE CASCADE,
  UNIQUE(article_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_article ON chunks(article_id);
CREATE INDEX IF NOT EXISTS idx_chunks_source_sha ON chunks(source_sha256);
