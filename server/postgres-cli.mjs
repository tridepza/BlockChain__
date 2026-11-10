import { openPostgres, postgresConfig, postgresError } from './postgres.mjs';

let db;
try {
  const config = postgresConfig();
  if (!config) throw new Error('Sao chép .env.postgres.example sang .env.postgres.local và điền PGPASSWORD.');
  db = openPostgres(config);
  if (process.argv[2] === 'migrate') await db.migrate();
  const status = await db.check();
  console.log(`Kết nối PostgreSQL thành công. Database ${status.database}, tài khoản ${status.username}.`);
  if (!status.ready) throw new Error('Chưa có đủ bảng. Chạy npm.cmd run db:migrate.');
  console.log('Các bảng users, sessions, projects và transactions đã sẵn sàng.');
} catch (error) {
  console.error(postgresError(error));
  process.exitCode = 1;
} finally {
  await db?.close();
}
