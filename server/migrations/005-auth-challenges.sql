CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires BIGINT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(email, purpose)
);
