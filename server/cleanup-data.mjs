import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BSON } from 'mongodb';
import { configuredDatabase } from './database.mjs';

const connection = configuredDatabase();
if (connection?.target.driver !== 'mongodb') throw new Error('Lệnh dọn dữ liệu dành cho MongoDB đang được cấu hình.');
try {
  const apply = process.argv.includes('--apply');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(`.data/backups/before-integrity-cleanup-${stamp}.json`);
  const result = await connection.db.cleanIntegrity(apply ? async snapshot => {
    await mkdir(resolve('.data/backups'), { recursive: true });
    await writeFile(path, BSON.EJSON.stringify(snapshot));
  } : undefined);
  console.log(apply ? `Đã sao lưu trước khi dọn: ${path}` : 'Chỉ kiểm tra. Thêm --apply để dọn sau khi sao lưu.');
  console.log(JSON.stringify(result, null, 2));
} finally { await connection.db.close(); }
