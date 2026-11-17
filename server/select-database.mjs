import { configuredDatabase } from './database.mjs';
import { rememberStorageTarget, sqliteTarget } from './storage-target.mjs';
import { openSqlite } from './sqlite.mjs';
import { resolve } from 'node:path';

const driver = process.argv[2];
if (!['mongodb', 'postgres', 'sqlite'].includes(driver)) throw new Error('Chọn mongodb, postgres hoặc sqlite.');
process.env.ESCROW_DB = driver;
const connection = configuredDatabase(process.cwd(), { ignorePin: true });
try {
  if (connection && !(await connection.db.check()).ready) throw new Error('Chạy db:migrate trên database đích trước.');
  if (!connection) await openSqlite(resolve('.data/escrow.sqlite')).close();
  rememberStorageTarget(process.cwd(), connection?.target ?? sqliteTarget(), true);
  console.log(`Đã chọn ${driver}. Khởi động lại website. Dữ liệu cũ được giữ nguyên ở database cũ; dùng db:recover để hợp nhất.`);
} finally { await connection?.db.close(); }
