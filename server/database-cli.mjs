import { configuredDatabase } from './database.mjs';

let connection;
try {
  connection = configuredDatabase();
  if (!connection) throw new Error('Điền MONGODB_URI trong .env.mongo.local hoặc cấu hình PostgreSQL để dùng lệnh này.');
  const { db, name } = connection;
  if (process.argv[2] === 'migrate') await db.migrate();
  const status = await db.check();
  const account = status.username ? `, tài khoản ${status.username}` : '';
  console.log(`Kết nối ${name} thành công. Database ${status.database}${account}.`);
  if (status.ready) console.log('Dữ liệu tài khoản, phiên, dự án và giao dịch đã sẵn sàng.');
  else {
    console.error('Database chưa được khởi tạo. Chạy npm.cmd run db:migrate.');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(connection ? connection.explainError(error) : error.message);
  process.exitCode = 1;
} finally {
  await connection?.db.close();
}
