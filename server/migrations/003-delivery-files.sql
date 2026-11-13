CREATE TABLE IF NOT EXISTS delivery_files (
  delivery_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preview', 'original')),
  data TEXT NOT NULL,
  PRIMARY KEY (delivery_id, kind)
);
