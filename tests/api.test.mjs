import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApi } from '../server/api.mjs';

const password = 'mật-khẩu-test-2026';
const client = { name: 'Tên trùng', email: 'owner@example.test', password, role: 'Client' };
const outsider = { ...client, email: 'other@example.test' };
const worker = { name: 'Freelancer test', email: 'worker@example.test', password, role: 'Freelancer' };
const input = {
  title: 'Kiểm thử dự án', category: 'Web Development', description: 'Dữ liệu thử nghiệm',
  budget: '0.30', milestones: 'Một, Hai', amounts: '0.10, 0.20',
};

async function listen(filename) {
  const api = createApi(filename);
  const server = createServer((req, res) => api.middleware(req, res, () => res.writeHead(404).end()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/api/`;
  return {
    close: async () => {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      api.close();
    },
    async request(path, { data, cookie, headers } = {}) {
      const response = await fetch(baseURL + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return { status: response.status, cookie: response.headers.get('set-cookie'), body: await response.json() };
    },
  };
}

test('tài khoản và session được lưu bền vững, cookie cũ bị thu hồi', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'escrow-api-'));
  const filename = join(dir, 'test.sqlite');
  let app = await listen(filename);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true });
  });
  const req = (...args) => app.request(...args);
  assert.equal((await req('auth/me')).status, 401);
  assert.equal((await req('auth/register', { data: { ...client, role: 'Arbitrator' } })).status, 400);
  assert.equal((await req('auth/register', { data: { ...client, password: 'short' } })).status, 400);
  assert.equal((await req('auth/register', { data: client, headers: { Origin: 'https://unrelated.test' } })).status, 403);
  const duplicates = await Promise.all([
    req('auth/register', { data: client }),
    req('auth/register', { data: { ...client, email: ' OWNER@EXAMPLE.TEST ' } }),
  ]);
  assert.deepEqual(duplicates.map(result => result.status).sort(), [201, 409]);
  assert.equal((await req('auth/login', { data: { ...client, password: 'incorrect' } })).status, 401);
  const login = await req('auth/login', { data: client });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /HttpOnly; SameSite=Strict/);
  assert.equal(login.body.user.role, 'Client');
  assert.deepEqual(Object.keys(login.body.user).sort(), ['email', 'id', 'name', 'role']);
  const cookie = login.cookie.split(';')[0];

  await app.close();
  app = await listen(filename);
  assert.equal((await req('auth/me', { cookie })).body.user.email, client.email);
  const db = new DatabaseSync(filename);
  const stored = db.prepare('SELECT password_hash, salt FROM users').get();
  assert.equal(stored.password_hash.length, 64);
  assert.equal(stored.salt.length, 16);
  assert.notEqual(Buffer.from(stored.password_hash).toString(), password);
  const session = db.prepare('SELECT token_hash FROM sessions').get();
  assert.notEqual(session.token_hash, cookie.split('=')[1]);
  db.close();

  const updated = await req('auth/profile', { data: { name: 'Tên đã sửa', role: 'Arbitrator', id: 'wrong' }, cookie });
  assert.equal(updated.body.user.name, 'Tên đã sửa');
  assert.equal(updated.body.user.role, 'Client');
  assert.equal(updated.body.user.id, login.body.user.id);
  const nextLogin = await req('auth/login', { data: client, cookie });
  assert.equal((await req('workspace', { cookie })).status, 401);
  const newCookie = nextLogin.cookie.split(';')[0];
  assert.equal((await req('workspace', { cookie: newCookie, headers: { 'X-Escrow-Account': 'wrong' } })).status, 401);
  assert.equal((await req('auth/logout', { data: {}, cookie: newCookie })).status, 200);
  assert.equal((await req('auth/me', { cookie: newCookie })).status, 401);
});

test('workspace xác minh vai trò, quyền sở hữu và trạng thái trên máy chủ', async t => {
  const app = await listen(':memory:');
  t.after(app.close);
  const req = app.request;
  async function login(user) {
    assert.equal((await req('auth/register', { data: user })).status, 201);
    const result = await req('auth/login', { data: user });
    assert.equal(result.status, 200);
    return result.cookie.split(';')[0];
  }
  const owner = await login(client);
  const other = await login(outsider);
  const freelancer = await login(worker);
  assert.equal((await req('projects', { data: input })).status, 401);
  assert.equal((await req('projects', { data: { ...input, role: 'Client' }, cookie: freelancer })).status, 403);
  assert.equal((await req('projects', { data: { ...input, amounts: '0.10,,0.20' }, cookie: owner })).status, 400);
  const created = await req('projects', { data: input, cookie: owner });
  assert.equal(created.status, 201);
  const projectId = created.body.project.id;
  const action = (cookie, action, fields) => req('projects/action', { cookie, data: { projectId, action, ...fields } });
  const publicList = (await req('projects/public')).body.projects;
  assert.equal(publicList.length, 1);
  assert.equal(publicList[0].ownerId, undefined);
  assert.equal(publicList[0].milestones, undefined);
  assert.deepEqual((await req('workspace', { cookie: other })).body.projects, []);
  assert.equal((await action(other, 'assign', { email: worker.email, ownerId: created.body.project.ownerId })).status, 403);
  assert.equal((await action(owner, 'fund')).status, 409);
  assert.equal((await action(owner, 'assign', { email: worker.email })).status, 200);
  assert.deepEqual((await req('projects/public')).body.projects, []);
  const funding = await Promise.all([action(owner, 'fund'), action(owner, 'fund')]);
  assert.deepEqual(funding.map(result => result.status).sort(), [200, 409]);
  assert.equal((await action(freelancer, 'submit', { milestoneId: 2, note: 'Bàn giao sai thứ tự' })).status, 409);
  assert.equal((await action(freelancer, 'submit', { milestoneId: 1, note: 'Bàn giao hợp lệ' })).status, 200);
  assert.equal((await action(owner, 'cancel')).status, 403);
  const proposed = await action(owner, 'requestCancel', { note: 'Đề nghị hủy sau khi bàn giao' });
  assert.equal(proposed.status, 200);
  assert.equal(proposed.body.projects[0].status, 'Submitted');
  assert.deepEqual(proposed.body.txs.map(tx => tx.amount), [0.3]);
  const firstRequest = { cancellationId: proposed.body.projects[0].cancellation.id };
  assert.equal((await action(owner, 'confirmCancel', firstRequest)).status, 403);
  assert.equal((await action(other, 'confirmCancel', firstRequest)).status, 403);
  assert.equal((await action(freelancer, 'requestCancel', { note: 'Ghi đè đề nghị đang mở' })).status, 409);
  assert.equal((await action(freelancer, 'approve', { milestoneId: 1 })).status, 403);
  assert.equal((await action(owner, 'dispute', { milestoneId: 1, note: 'Chỉ mô phỏng trong demo' })).status, 403);
  const approvals = await Promise.all([action(owner, 'approve', { milestoneId: 1 }), action(owner, 'approve', { milestoneId: 1 })]);
  assert.deepEqual(approvals.map(result => result.status).sort(), [200, 409]);
  assert.equal((await action(freelancer, 'confirmCancel', firstRequest)).status, 409);
  const expired = await action(freelancer, 'requestCancel', { note: 'Đề nghị hoàn phần còn lại' });
  assert.equal(expired.status, 200);
  const expiredRequest = expired.body.projects[0].cancellation;
  t.mock.timers.enable({ apis: ['Date'], now: expiredRequest.expiresAt + 1 });
  assert.equal((await action(owner, 'confirmCancel', { cancellationId: expiredRequest.id })).status, 409);
  const renewed = await action(freelancer, 'requestCancel', { note: 'Đề nghị mới' });
  assert.equal(renewed.status, 200);
  const confirmation = { cancellationId: renewed.body.projects[0].cancellation.id };
  assert.notEqual(confirmation.cancellationId, expiredRequest.id);
  assert.equal((await action(owner, 'confirmCancel', { cancellationId: expiredRequest.id })).status, 409);
  const confirmations = await Promise.all([
    action(owner, 'confirmCancel', confirmation),
    action(owner, 'confirmCancel', confirmation),
  ]);
  assert.deepEqual(confirmations.map(result => result.status).sort(), [200, 409]);
  const cancelled = confirmations.find(result => result.status === 200);
  assert.equal(cancelled.body.projects[0].status, 'Cancelled');
  assert.equal(cancelled.body.projects[0].paid, 0.1);
  assert.equal(cancelled.body.projects[0].cancellation, undefined);
  assert.deepEqual(cancelled.body.txs.map(tx => tx.amount), [0.2, 0.1, 0.3]);
  assert.deepEqual((await req('workspace', { cookie: other })).body, { projects: [], txs: [] });
});
