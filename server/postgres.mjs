import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';

export function postgresConfig(root = process.cwd()) {
  const path = resolve(root, '.env.postgres.local');
  const file = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  const env = { ...file, ...process.env };
  if (env.ESCROW_DB === undefined || env.ESCROW_DB === 'sqlite') return null;
  if (env.ESCROW_DB !== 'postgres') throw new Error('ESCROW_DB phải là sqlite hoặc postgres.');
  if (!env.PGPASSWORD) throw new Error('Thêm mật khẩu của freelancer_app vào PGPASSWORD trong .env.postgres.local.');
  return {
    host: env.PGHOST || '127.0.0.1',
    port: env.PGPORT || 5432,
    database: env.PGDATABASE || 'freelancer_escrow',
    user: env.PGUSER || 'freelancer_app',
    password: env.PGPASSWORD,
    options: '-c search_path=public',
    connectionTimeoutMillis: 5_000,
  };
}

export function postgresError(error) {
  switch (error.code) {
    case '28P01':
      return 'PostgreSQL từ chối đăng nhập. Kiểm tra PGUSER và PGPASSWORD.';
    case '3D000':
      return 'Không tìm thấy database. Kiểm tra PGDATABASE.';
    case '42501':
      return 'Tài khoản PostgreSQL thiếu quyền. Kiểm tra Owner của database trong pgAdmin.';
    case 'ECONNREFUSED':
      return 'Không kết nối được PostgreSQL. Kiểm tra dịch vụ PostgreSQL, PGHOST và PGPORT.';
    default:
      return error.code ? `Kết nối hoặc thao tác PostgreSQL thất bại (mã ${error.code}).` : error.message;
  }
}

const migration = new URL('./migrations/001-initial.sql', import.meta.url);

export function openPostgres(config) {
  const pool = new pg.Pool(config);
  pool.on('error', error => console.error(postgresError(error)));

  function queryOn(connection) {
    return async (sql, params = []) => {
      let index = 0;
      const statement = sql.replace(/\?/g, () => `$${++index}`);
      const result = await connection.query(statement, params);
      return result.rows;
    };
  }

  async function transaction(operation) {
    const client = await pool.connect();
    let connectionError;
    try {
      await client.query('BEGIN');
      const result = await operation(queryOn(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        connectionError = rollbackError;
      }
      throw error;
    } finally {
      client.release(connectionError);
    }
  }

  const query = queryOn(pool);
  return {
    query,
    transaction,
    projectLock: ' FOR UPDATE',
    sessionLock: ' FOR SHARE OF s',
    close: () => pool.end(),
    async check() {
      const [status] = await query(`
        SELECT current_database() AS database, current_user AS username,
          to_regclass('public.users') IS NOT NULL
          AND to_regclass('public.sessions') IS NOT NULL
          AND to_regclass('public.projects') IS NOT NULL
          AND to_regclass('public.transactions') IS NOT NULL
          AND to_regclass('public.wallet_links') IS NOT NULL
          AND to_regclass('public.wallet_challenges') IS NOT NULL
          AND to_regclass('public.delivery_files') IS NOT NULL AS ready
      `);
      return status;
    },
    migrate: () => transaction(async execute => {
      await execute('SELECT pg_advisory_xact_lock(704171249)');
      await execute(readFileSync(migration, 'utf8'));
      await execute(readFileSync(new URL('./migrations/002-wallet-links.sql', import.meta.url), 'utf8'));
      await execute(readFileSync(new URL('./migrations/003-delivery-files.sql', import.meta.url), 'utf8'));
    }),
  };
}
