import { mongoConfig, mongoError, openMongo } from './mongo.mjs';
import { openPostgres, postgresConfig, postgresError } from './postgres.mjs';
import { sqlStore } from './sql-store.mjs';
import { readStorageTarget, assertStorageTarget, sqliteTarget } from './storage-target.mjs';

export function configuredDatabase(root, { ignorePin = false } = {}) {
  const pin = ignorePin ? null : readStorageTarget(root);
  // In-memory test servers are explicitly isolated from the persisted application database.
  const isolated = process.env.ESCROW_DB === 'sqlite' && process.env.ESCROW_DB_PATH === ':memory:';
  const selected = process.env.ESCROW_DB ?? pin?.driver;
  const mongo = mongoConfig(root, selected);
  if (mongo) {
    const target = { driver: 'mongodb', database: mongo.database,
      server: mongo.uri.replace(/^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?/, '$1').split('?')[0] };
    if (!isolated) assertStorageTarget(pin, target);
    try {
      const db = openMongo(mongo);
      return { db, store: db, name: 'MongoDB', explainError: mongoError, target };
    } catch (error) {
      throw new Error(mongoError(error));
    }
  }
  const postgres = postgresConfig(root, selected);
  if (!postgres) {
    if (!isolated) assertStorageTarget(pin, sqliteTarget(root));
    return null;
  }
  const target = { driver: 'postgres', database: postgres.database, server: `${postgres.host}:${postgres.port}` };
  if (!isolated) assertStorageTarget(pin, target);
  const db = openPostgres(postgres);
  return { db, store: sqlStore(db), name: 'PostgreSQL', explainError: postgresError, target };
}
