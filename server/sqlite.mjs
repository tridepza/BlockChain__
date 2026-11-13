import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openSqlite(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename, { timeout: 3000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('Client', 'Freelancer')),
      salt BLOB NOT NULL, password_hash BLOB NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, data TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY, data TEXT NOT NULL) STRICT;
  `);
  db.exec(readFileSync(new URL('./migrations/002-wallet-links.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./migrations/003-delivery-files.sql', import.meta.url), 'utf8'));

  // Keep all access to this connection queued while an async transaction is open.
  let pending = Promise.resolve();
  function exclusive(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  const query = (sql, params = []) => db.prepare(sql).all(...params);

  return {
    query: (sql, params) => exclusive(() => query(sql, params)),
    projectLock: '',
    sessionLock: '',
    transaction: operation => exclusive(async () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await operation(query);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }),
    close: () => exclusive(() => db.close()),
  };
}
