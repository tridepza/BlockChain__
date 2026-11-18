// Read-only check of the admin email allowlist against registered accounts.
import { resolve } from 'node:path';
import { adminEmails } from './admin-analytics.mjs';
import { configuredDatabase } from './database.mjs';
import { openSqlite } from './sqlite.mjs';
import { sqlStore } from './sql-store.mjs';

const root = process.cwd();
const emails = [...new Set(adminEmails(root).split(',').map(email => email.trim().toLowerCase()).filter(Boolean))];
let connection;
let store;
try {
  if (emails.length === 0) {
    throw new Error('Chưa cấp quyền admin. Tạo .env.admin.local từ .env.admin.example và điền ESCROW_ADMIN_EMAILS.');
  }
  connection = configuredDatabase(root);
  store = connection ? connection.store : sqlStore(openSqlite(process.env.ESCROW_DB_PATH ?? resolve(root, '.data/escrow.sqlite')));
  let ready = 0;
  for (const email of emails) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) console.error(`✗ ${email}: không phải địa chỉ email hợp lệ.`);
    else if (email.endsWith('@example.com')) console.error(`✗ ${email}: còn là email mẫu, hãy thay bằng email thật.`);
    else if (!await store.getUserByEmail(email)) console.error(`✗ ${email}: chưa có tài khoản. Đăng ký email này trên website trước.`);
    else { console.log(`✓ ${email}: có quyền quản trị.`); ready++; }
  }
  console.log(`${ready}/${emails.length} email quản trị sẵn sàng. Mở http://127.0.0.1:5173/admin sau khi đăng nhập.`);
  if (ready === 0) process.exitCode = 1;
} catch (error) {
  console.error(connection ? connection.explainError(error) : error.message);
  process.exitCode = 1;
} finally {
  await (connection ? connection.db.close() : store?.close());
}
