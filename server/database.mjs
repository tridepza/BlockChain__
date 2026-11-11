import { mongoConfig, mongoError, openMongo } from './mongo.mjs';
import { openPostgres, postgresConfig, postgresError } from './postgres.mjs';
import { sqlStore } from './sql-store.mjs';

export function configuredDatabase(root) {
  const mongo = mongoConfig(root);
  if (mongo) {
    try {
      const db = openMongo(mongo);
      return { db, store: db, name: 'MongoDB', explainError: mongoError };
    } catch (error) {
      throw new Error(mongoError(error));
    }
  }
  const postgres = postgresConfig(root);
  if (!postgres) return null;
  const db = openPostgres(postgres);
  return { db, store: sqlStore(db), name: 'PostgreSQL', explainError: postgresError };
}
