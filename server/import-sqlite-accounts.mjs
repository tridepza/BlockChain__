import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mongoConfig, mongoError, openMongo } from './mongo.mjs';

const config = mongoConfig();
if (!config) throw new Error('Chọn ESCROW_DB=mongodb và điền .env.mongo.local trước khi nhập.');
const database = openMongo(config);
try {
  const { ready } = await database.check();
  if (!ready) throw new Error('Database MongoDB cần chạy db:migrate trước khi nhập tài khoản.');
  const source = new DatabaseSync(resolve(process.argv[2] ?? '.data/escrow.sqlite'), { readOnly: true });
  let accounts;
  try {
    accounts = source.prepare('SELECT id, name, email, role, salt, password_hash FROM users').all();
  } finally {
    source.close();
  }
  let added = 0;
  for (const account of accounts) {
    if (await database.getUserByEmail(account.email)) continue;
    const existing = await database.getUserById(account.id);
    if (existing) throw new Error('Có ID tài khoản trùng nhưng email khác. Dừng để kiểm tra dữ liệu.');
    if (await database.createUser({
      ...account, salt: Buffer.from(account.salt), password_hash: Buffer.from(account.password_hash),
    })) added++;
  }
  console.log(`Đã nhập ${added}/${accounts.length} tài khoản vào ${config.database}. Tổng hiện tại ${await database.countUsers()}.`);
} catch (error) {
  console.error(/^Mongo/.test(error.name) ? mongoError(error) : error.message);
  process.exitCode = 1;
} finally {
  await database.close();
}
