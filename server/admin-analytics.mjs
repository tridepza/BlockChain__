import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowError } from '../src/workflow.ts';

const offset = 7 * 3_600_000;
const day = 86_400_000;
const dateKey = milliseconds => new Date(milliseconds + offset).toISOString().slice(0, 10);

// Calendar boundaries always follow Vietnam time, including Monday-based weeks.
export function adminPeriod(period = 'day', date = dateKey(Date.now())) {
  if (!['day', 'week', 'month', 'year'].includes(period) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new WorkflowError(400, 'Kỳ thống kê không hợp lệ.');
  const anchor = new Date(date + 'T00:00:00.000Z');
  if (!Number.isFinite(anchor.getTime()) || anchor.toISOString().slice(0, 10) !== date) {
    throw new WorkflowError(400, 'Ngày thống kê không hợp lệ.');
  }
  let start = anchor.getTime();
  let end;
  if (period === 'week') start -= ((anchor.getUTCDay() + 6) % 7) * day;
  if (period === 'month' || period === 'year') {
    anchor.setUTCDate(1);
    if (period === 'year') anchor.setUTCMonth(0);
    start = anchor.getTime();
    if (period === 'year') anchor.setUTCFullYear(anchor.getUTCFullYear() + 1);
    else anchor.setUTCMonth(anchor.getUTCMonth() + 1);
    end = anchor.getTime();
  } else end = start + (period === 'week' ? 7 : 1) * day;
  return { period, date, timezone: 'Asia/Ho_Chi_Minh',
    start: new Date(start - offset).toISOString(), end: new Date(end - offset).toISOString() };
}

// Sub-periods for the breakdown table: one row per day in a week/month, per month in a year.
export function adminBuckets(range) {
  const buckets = [];
  let cursor = new Date(Date.parse(range.start) + offset);
  const end = Date.parse(range.end) + offset;
  while (cursor.getTime() < end) {
    const next = new Date(cursor);
    if (range.period === 'year') next.setUTCMonth(next.getUTCMonth() + 1);
    else next.setUTCDate(next.getUTCDate() + 1);
    const key = cursor.toISOString().slice(0, range.period === 'year' ? 7 : 10);
    buckets.push({ key, start: new Date(cursor.getTime() - offset).toISOString(), end: new Date(next.getTime() - offset).toISOString() });
    cursor = next;
  }
  return buckets;
}

export function isAdminAccount(user, configuredEmails = process.env.ESCROW_ADMIN_EMAILS ?? '') {
  const emails = configuredEmails.split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  return Boolean(user && emails.includes(user.email.toLowerCase()));
}

export function adminEmails(root) {
  const filename = resolve(root, '.env.admin.local');
  // Notepad and PowerShell 5 save UTF-8 with a BOM, which would otherwise become part of the first key.
  const file = existsSync(filename) ? parseEnv(readFileSync(filename, 'utf8').replace(/^﻿/, '')) : {};
  return process.env.ESCROW_ADMIN_EMAILS ?? file.ESCROW_ADMIN_EMAILS ?? '';
}

// Anonymous browser identifiers only: no IP addresses, names, or emails.
export function openAdminAnalytics(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS visits (
      day TEXT NOT NULL, visitor TEXT NOT NULL, views INTEGER NOT NULL,
      PRIMARY KEY(day, visitor)
    );
    CREATE TABLE IF NOT EXISTS analytics_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO analytics_metadata VALUES (?, ?)').run('startedAt', new Date().toISOString());
  return {
    recordVisit(visitor, now = Date.now()) {
      const anonymous = createHash('sha256').update(visitor).digest('hex');
      db.prepare(`INSERT INTO visits VALUES (?, ?, 1)
        ON CONFLICT(day, visitor) DO UPDATE SET views = views + 1`).run(dateKey(now), anonymous);
    },
    summary(range) {
      const query = db.prepare(`SELECT COALESCE(SUM(views), 0) AS pageViews,
        COUNT(DISTINCT visitor) AS uniqueVisitors FROM visits WHERE day >= ? AND day < ?`);
      const count = ({ start, end }) => ({ ...query.get(dateKey(Date.parse(start)), dateKey(Date.parse(end))) });
      return { ...count(range),
        series: range.period === 'day' ? [] : adminBuckets(range).map(bucket => ({ key: bucket.key, ...count(bucket) })),
        startedAt: db.prepare('SELECT value FROM analytics_metadata WHERE key = ?').get('startedAt').value };
    },
    close() { db.close(); },
  };
}
