ALTER TABLE chunks ADD COLUMN vector_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_vector_id ON chunks(vector_id);
