import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { createApi } from '../server/api.mjs';
import { adminBuckets, adminEmails, adminPeriod, isAdminAccount, openAdminAnalytics } from '../server/admin-analytics.mjs';
import { applyProjectAction, createProject } from '../src/workflow.ts';

test('projects are FESC-only with ordered due dates; the server records only assignment, delivery and verified payments', t => {
  const now = Date.parse('2026-11-18T10:00:00+07:00');
  t.mock.timers.enable({ apis: ['Date'], now });
  const client = { id: 'client', name: 'Client', role: 'Client' };
  const worker = { id: 'worker', name: 'Worker', role: 'Freelancer' };
  const input = { title: 'Scheduled', description: 'Test handoff', category: 'Web Development',
    budget: '100', milestones: 'Design, Build', amounts: '40,60', projectDue: '2026-12-10', milestoneDues: '2026-11-28,2026-12-10' };
  // First due date needs > 9 days for funding + start; dates must exist, increase and stay within the project.
  for (const milestoneDues of ['2026-11-28', '2026-11-26,2026-12-04', '2026-11-31,2026-12-04', '2026-12-04,2026-11-30', '2026-11-28,2026-12-11']) {
    assert.throws(() => createProject(client, { ...input, milestoneDues }, 1), { status: 400 });
  }
  assert.throws(() => createProject(client, { ...input, projectDue: undefined, milestoneDues: undefined }, 1), { status: 400 });
  assert.throws(() => createProject(client, { ...input, currency: 'MOCK' }, 1), { status: 400 });
  assert.throws(() => createProject(worker, input, 1), { status: 403 });
  const schedule = createProject(client, input, 1);
  assert.equal(schedule.currency, 'FESC');
  assert.equal(schedule.dueAt, '2026-12-10T16:59:59.000Z');
  assert.equal(schedule.milestones[0].dueAt, '2026-11-28T16:59:59.000Z');
  const project = { ...schedule, freelancerId: worker.id, funded: 100, status: 'Funded' };
  const submitted = applyProjectAction(project, worker, { action: 'submit', milestoneId: 1, note: 'Delivered' }).project;
  assert.equal(submitted.milestones[0].status, 'Submitted');
  for (const action of ['dispute', 'revision', 'release', 'refund', 'requestCancel']) {
    assert.throws(() => applyProjectAction(submitted, client, { action, milestoneId: 1, submissionVersion: 1, note: 'x' }));
  }
  assert.throws(() => applyProjectAction(submitted, worker, { action: 'approve', milestoneId: 1, submissionVersion: 1 }), { status: 403 });
  const paid = applyProjectAction(submitted, client, { action: 'approve', milestoneId: 1, submissionVersion: 1 }).project;
  assert.equal(paid.paid, 40);
});

test('admin calendar uses Vietnam midnight, Monday weeks, leap months and year transitions', () => {
  assert.equal(adminPeriod('day', '2026-11-18').start, '2026-11-17T17:00:00.000Z');
  assert.equal(adminPeriod('week', '2027-01-03').start, '2026-12-27T17:00:00.000Z');
  assert.equal(adminPeriod('week', '2027-01-03').end, '2027-01-03T17:00:00.000Z');
  assert.equal(adminPeriod('month', '2028-02-29').end, '2028-02-29T17:00:00.000Z');
  assert.equal(adminPeriod('year', '2026-11-18').end, '2026-12-31T17:00:00.000Z');
  for (const input of ['2026-02-29', '2026-13-01', 'bad']) assert.throws(() => adminPeriod('day', input));
  assert.throws(() => adminPeriod('invalid', '2026-11-18'));
});

test('admin breakdown splits weeks and months by Vietnam day and years by month', () => {
  const week = adminBuckets(adminPeriod('week', '2027-01-03'));
  assert.deepEqual(week.map(bucket => bucket.key), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  assert.equal(week[0].start, '2026-12-27T17:00:00.000Z');
  assert.equal(week.at(-1).end, '2027-01-03T17:00:00.000Z');
  assert.equal(adminBuckets(adminPeriod('month', '2028-02-10')).length, 29);
  const year = adminBuckets(adminPeriod('year', '2026-11-18'));
  assert.equal(year.length, 12);
  assert.equal(year[1].key, '2026-02');
  assert.equal(year[1].end, '2026-02-28T17:00:00.000Z');
});

test('admin email file is read even when saved with a UTF-8 BOM', async t => {
  const root = await mkdtemp(join(tmpdir(), 'escrow-admin-env-'));
  const previous = process.env.ESCROW_ADMIN_EMAILS;
  delete process.env.ESCROW_ADMIN_EMAILS;
  t.after(async () => { if (previous !== undefined) process.env.ESCROW_ADMIN_EMAILS = previous; await rm(root, { recursive: true }); });
  await writeFile(join(root, '.env.admin.local'), '﻿ESCROW_ADMIN_EMAILS=Admin@Example.test\r\n');
  assert.equal(isAdminAccount({ email: 'admin@example.test' }, adminEmails(root)), true);
});

test('admin APIs protect private disputes, count visitors, share replies and reject MOCK decisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'escrow-admin-api-'));
  const filename = join(root, 'app.sqlite');
  const service = createApi(filename, root, { adminEmails: 'admin@example.test', sendNotice: async () => {} });
  const db = new DatabaseSync(filename);
  const server = createServer((req, res) => service.middleware(req, res, () => res.writeHead(404).end()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); await service.close(); await rm(root, { recursive: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tokens = { admin: 'a'.repeat(64), client: 'b'.repeat(64), worker: 'd'.repeat(64) };
  for (const id of ['admin', 'client', 'worker']) {
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `${id}@example.test`, id === 'worker' ? 'Freelancer' : 'Client', Buffer.alloc(16), Buffer.alloc(64));
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(createHash('sha256').update(tokens[id]).digest('hex'), id, Date.now() + 600000);
  }
  const project = { id: 1, title: 'Private dispute', category: 'Web Development', description: 'Private details', ownerId: 'client',
    freelancerId: 'worker', client: 'Client', freelancer: 'Worker', currency: 'FESC', budget: 100, funded: 100, paid: 0,
    status: 'Disputed', disputeReason: 'Delivery rejected', created: '2026-11-18',
    milestones: [{ id: 1, title: 'First', amount: 40, status: 'Disputed' }, { id: 2, title: 'Next', amount: 60, status: 'Pending' }] };
  db.prepare('INSERT INTO projects VALUES (?, ?)').run(1, JSON.stringify(project));
  db.prepare('INSERT INTO projects VALUES (?, ?)').run(2, JSON.stringify({ ...project, id: 2, currency: 'MOCK', title: 'Legacy MOCK' }));
  async function request(path, user, data, headers = {}) {
    const response = await fetch(origin + '/api/' + path, { method: data ? 'POST' : 'GET',
      headers: { ...(user ? { Cookie: `escrow_session=${tokens[user]}` } : {}), ...(data ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...headers },
      body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  assert.equal((await request('admin/overview')).status, 401);
  assert.equal((await request('admin/overview', 'client')).status, 403);
  assert.equal((await request('admin/case?projectId=1', 'client')).status, 403);
  assert.equal((await request('admin/access', 'client')).body.allowed, false);
  assert.equal((await request('admin/accounts', 'client')).status, 403);
  assert.equal((await request('admin/transactions', 'client')).status, 403);
  const visitor = await request('analytics/visit', null, {});
  assert.equal(visitor.status, 200);
  assert.match(visitor.cookie, /HttpOnly/);
  await request('analytics/visit', null, {}, { Cookie: visitor.cookie.split(';')[0] });
  await request('analytics/visit', null, {});
  assert.equal((await request('analytics/visit', null, {}, { Origin: 'https://foreign.test' })).status, 403);
  const overview = await request('admin/overview', 'admin');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.traffic.pageViews, 3);
  assert.equal(overview.body.traffic.uniqueVisitors, 2);
  assert.equal(overview.body.projectCount, 2);
  assert.equal(overview.body.disputes.length, 2);
  const weekly = await request('admin/overview?period=week', 'admin');
  assert.equal(weekly.body.traffic.series.length, 7);
  assert.equal(weekly.body.traffic.series.reduce((sum, row) => sum + row.pageViews, 0), 3);
  assert.equal(weekly.body.projectSeries.length, 7);
  assert.equal((await request('admin/overview?period=bad', 'admin')).status, 400);
  const accounts = await request('admin/accounts', 'admin');
  assert.equal(accounts.body.total, 3);
  assert.equal(accounts.body.available, false, 'no chain: balances are unavailable rather than zero');

  // Replies are shared with both parties through the workspace.
  const note = { projectId: 1, action: 'review', note: 'Please add the chat log', revision: 0 };
  assert.equal((await request('admin/case', 'client', note)).status, 403);
  assert.equal((await request('admin/case', 'admin', note, { Origin: 'https://foreign.test' })).status, 403);
  assert.equal((await request('admin/case', 'admin', note)).status, 200);
  assert.equal((await request('admin/case', 'admin', note)).status, 409);
  const workerView = await request('workspace', 'worker');
  assert.equal(workerView.body.projects.find(item => item.id === 1).adminReview.history[0].note, 'Please add the chat log');
  assert.equal(workerView.body.mockWallet, undefined);

  // MOCK projects can no longer be settled; FESC decisions need a verified chain transaction.
  assert.equal((await request('admin/case', 'admin', { projectId: 2, action: 'release', note: 'Legacy', revision: 0 })).status, 409);
  const decision = await request('admin/case', 'admin', { projectId: 1, action: 'release', note: 'Release', revision: 1, evidenceCount: '0' });
  assert.notEqual(decision.status, 200);
  assert.equal(JSON.parse(db.prepare('SELECT data FROM projects WHERE id = 1').get().data).status, 'Disputed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 0);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run('admin');
  assert.equal((await request('admin/case?projectId=1', 'admin')).status, 401);
});

test('admin permission defaults closed and follows the server email allowlist', () => {
  assert.equal(isAdminAccount({ email: 'admin@example.test' }, ''), false);
  assert.equal(isAdminAccount(null, 'admin@example.test'), false);
  assert.equal(isAdminAccount({ email: 'ADMIN@example.test' }, ' admin@example.test,other@example.test '), true);
  assert.equal(isAdminAccount({ email: 'client@example.test', role: 'Arbitrator' }, 'admin@example.test'), false);
});

test('visitor counts survive restart, separate pageviews from unique browsers and use Vietnam dates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'escrow-admin-'));
  let analytics;
  t.after(async () => { analytics?.close(); await rm(root, { recursive: true }); });
  const file = join(root, 'analytics.sqlite');
  analytics = openAdminAnalytics(file);
  analytics.recordVisit('browser-one', Date.parse('2026-11-17T16:59:59Z'));
  analytics.recordVisit('browser-one', Date.parse('2026-11-17T17:00:00Z'));
  analytics.recordVisit('browser-one', Date.parse('2026-11-17T17:00:01Z'));
  analytics.recordVisit('browser-two', Date.parse('2026-11-17T18:00:00Z'));
  analytics.close();
  analytics = openAdminAnalytics(file);
  const today = analytics.summary(adminPeriod('day', '2026-11-18'));
  assert.equal(today.pageViews, 3);
  assert.equal(today.uniqueVisitors, 2);
  const week = analytics.summary(adminPeriod('week', '2026-11-18'));
  assert.equal(week.pageViews, 4);
  assert.equal(week.uniqueVisitors, 2);
  assert.equal(today.startedAt, week.startedAt);
});
