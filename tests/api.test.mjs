import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createServer as createViteServer, preview, resolveConfig } from 'vite';
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
      await api.close();
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
  const submission = { milestoneId: 1, note: 'Bàn giao hợp lệ' };
  const first = await action(freelancer, 'submit', submission);
  assert.equal(first.status, 200);
  const firstReview = { milestoneId: 1, submissionVersion: first.body.projects[0].milestones[0].submissionVersion };
  assert.equal(firstReview.submissionVersion, 1);
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
  assert.equal((await action(owner, 'revision', { ...firstReview, note: 'Xem lại yêu cầu' })).status, 200);
  const second = await action(freelancer, 'submit', submission);
  assert.equal(second.status, 200);
  assert.equal(second.body.projects[0].milestones[0].submissionVersion, 2);
  assert.equal((await action(owner, 'approve', firstReview)).status, 409);
  assert.equal((await action(owner, 'approve', { milestoneId: 1 })).status, 409);
  assert.equal((await action(owner, 'revision', { ...firstReview, note: 'Yêu cầu cũ' })).status, 409);
  assert.equal((await action(owner, 'revision', { milestoneId: 1, submissionVersion: 2, note: 'Yêu cầu sửa lần hai' })).status, 200);
  assert.equal((await action(freelancer, 'submit', submission)).status, 200);
  assert.equal((await action(owner, 'revision', { milestoneId: 1, submissionVersion: 3, note: 'Yêu cầu sửa lần ba' })).status, 409);
  const beforeApproval = (await req('workspace', { cookie: owner })).body;
  assert.equal(beforeApproval.projects[0].paid, 0);
  assert.deepEqual(beforeApproval.txs.map(tx => tx.amount), [0.3]);
  const currentReview = { ...firstReview, submissionVersion: 3 };
  const approvals = await Promise.all([action(owner, 'approve', currentReview), action(owner, 'approve', currentReview)]);
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

test('Vite từ chối DB đặt trong public hoặc thư mục đầu ra và chặn bản SQLite còn sót', async () => {
  const root = await mkdtemp(join(tmpdir(), 'escrow-vite-output-'));
  const dbPath = process.env.ESCROW_DB_PATH;
  const dbMode = process.env.ESCROW_DB;
  const config = { root, configFile: resolve('vite.config.ts'), logLevel: 'silent' };
  let server;
  try {
    process.env.ESCROW_DB = 'sqlite';
    for (const dir of ['public', 'dist']) {
      await mkdir(join(root, dir));
      process.env.ESCROW_DB_PATH = join(root, dir, 'unsafe.sqlite');
      const fixture = new DatabaseSync(process.env.ESCROW_DB_PATH);
      fixture.exec("CREATE TABLE users(email TEXT); INSERT INTO users VALUES ('private@example.test')");
      fixture.close();
      await assert.rejects(resolveConfig(config, 'serve'), /ESCROW_DB_PATH/);
      await assert.rejects(resolveConfig(config, 'build'), /ESCROW_DB_PATH/);
    }
    process.env.ESCROW_DB_PATH = ':memory:';
    const resolved = await resolveConfig(config, 'build');
    assert.equal(resolved.publicDir, '');
    await writeFile(join(root, 'dist', 'index.html'), 'public fixture');
    server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } });
    const url = 'http://127.0.0.1:' + server.httpServer.address().port;
    assert.equal(await (await fetch(url + '/')).text(), 'public fixture');
    for (const path of ['/unsafe.sqlite', '/%75nsafe.sqlite?raw']) {
      assert.equal((await fetch(url + path)).status, 403);
    }
  } finally {
    if (dbPath === undefined) delete process.env.ESCROW_DB_PATH;
    else process.env.ESCROW_DB_PATH = dbPath;
    if (dbMode === undefined) delete process.env.ESCROW_DB;
    else process.env.ESCROW_DB = dbMode;
    if (server) await new Promise(resolve => server.httpServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('Vite dev chặn tệp SQLite, dữ liệu xác thực cũ và cấu hình PostgreSQL qua HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'escrow-vite-'));
  const dbPath = process.env.ESCROW_DB_PATH;
  const dbMode = process.env.ESCROW_DB;
  const privateFiles = [
    '.local-data/auth.sqlite', '.local-data/legacy.txt', '.data/escrow.sqlite',
    'backup.db-wal', 'backup.sqlite3', '.env.postgres.local', '.env.mongo.local',
  ];
  let server;
  try {
    await mkdir(join(root, '.local-data'));
    await mkdir(join(root, '.data'));
    for (const file of privateFiles) await writeFile(join(root, file), 'private fixture');
    await writeFile(join(root, 'visible.txt'), 'public fixture');
    process.env.ESCROW_DB_PATH = ':memory:';
    process.env.ESCROW_DB = 'sqlite';
    server = await createViteServer({
      root,
      configFile: resolve('vite.config.ts'),
      logLevel: 'silent',
      optimizeDeps: { disabled: true },
      server: { host: '127.0.0.1', port: 5197, hmr: false, watch: null },
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
    const visible = await fetch(url + 'visible.txt');
    assert.equal(await visible.text(), 'public fixture');
    for (const path of [...privateFiles, '.local-data/auth.sqlite?raw', '%2elocal-data/auth.sqlite']) {
      assert.equal((await fetch(url + path)).status, 403, path);
    }
  } finally {
    if (dbPath === undefined) delete process.env.ESCROW_DB_PATH;
    else process.env.ESCROW_DB_PATH = dbPath;
    if (dbMode === undefined) delete process.env.ESCROW_DB;
    else process.env.ESCROW_DB = dbMode;
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
