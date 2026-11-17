import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const sqliteTarget = (root = process.cwd()) => ({ driver: 'sqlite',
  database: resolve(root, process.env.ESCROW_DB_PATH ?? '.data/escrow.sqlite') });

export function readStorageTarget(root = process.cwd()) {
  const path = resolve(root, '.data/database-target.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function rememberStorageTarget(root, target, replace = false) {
  mkdirSync(resolve(root, '.data'), { recursive: true });
  const path = resolve(root, '.data/database-target.json');
  if (!replace && existsSync(path)) { assertStorageTarget(readStorageTarget(root), target); return; }
  try { writeFileSync(path, JSON.stringify(target, null, 2) + '\n', { flag: replace ? 'w' : 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assertStorageTarget(readStorageTarget(root), target);
  }
}

export function assertStorageTarget(previous, next) {
  if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
    throw new Error('Database hiện tại khác nơi đã lưu dữ liệu. Không tự chuyển sang database rỗng. Kiểm tra cấu hình hoặc chạy npm.cmd run db:select -- <mongodb|postgres|sqlite> để chủ động chuyển.');
  }
}
