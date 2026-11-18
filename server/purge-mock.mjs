// Removes MOCK simulation data from MongoDB. Without --apply it only reports what would be deleted.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BSON } from 'mongodb';
import { configuredDatabase } from './database.mjs';

const connection = configuredDatabase();
if (connection?.target.driver !== 'mongodb') throw new Error('Lệnh xóa dữ liệu MOCK dành cho MongoDB đang được cấu hình.');
try {
  const apply = process.argv.includes('--apply');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(`.data/backups/before-mock-purge-${stamp}.json`);
  const result = await connection.db.purgeMock(apply ? async snapshot => {
    await mkdir(resolve('.data/backups'), { recursive: true });
    await writeFile(path, BSON.EJSON.stringify(snapshot));
  } : undefined);
  console.log(apply ? `Đã sao lưu toàn bộ database trước khi xóa: ${path}` : 'Chỉ kiểm tra. Thêm -- --apply để sao lưu rồi xóa.');
  for (const project of result.projects) console.log(`- Dự án MOCK #${project.id} · ${project.title} · ${project.status}`);
  console.log(JSON.stringify(result.counts, null, 2));
} finally { await connection.db.close(); }
