CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100),
  size_bytes INT,
  uploaded_by VARCHAR(255) NOT NULL,
  uploaded_at TIMESTAMP DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','indexed','failed')),
  chunk_count INT DEFAULT 0,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_uploaded_at ON documents (uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status);