CREATE TABLE IF NOT EXISTS wallet_links (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  expires BIGINT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS wallet_challenges_expiry ON wallet_challenges (expires);
