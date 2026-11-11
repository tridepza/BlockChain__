import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { applyProjectAction, createProject, visibleWorkspace, WorkflowError } from '../src/workflow.ts';
import { configuredDatabase } from './database.mjs';
import { openSqlite } from './sqlite.mjs';
import { sqlStore } from './sql-store.mjs';

const deriveKey = promisify(scrypt);
const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 40 * 1024 * 1024 };
const sessionSeconds = 7 * 24 * 60 * 60;
const cookieName = 'escrow_session';
const hashToken = token => createHash('sha256').update(token).digest('hex');
const passwordHash = (password, salt) => deriveKey(password, salt, 64, passwordOptions);
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = email => email.length <= 254 && !email.includes('\0') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const publicAccount = ({ id, name, email, role }) => ({ id, name, email, role });

function readName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 80 || name.includes('\0')) throw new WorkflowError(400, 'Tên phải có từ 2 đến 80 ký tự hợp lệ.');
  return name;
}

function sessionToken(req) {
  return (req.headers.cookie ?? '').match(/(?:^|;\s*)escrow_session=([a-f0-9]{64})(?=;|$)/)?.[1];
}

function setSessionCookie(req, res, token = '') {
  const secure = req.socket.encrypted ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? sessionSeconds : 0}${secure}`);
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const scheme = req.socket.encrypted ? 'https' : 'http';
  const origin = `${scheme}://${req.headers.host}`;
  if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new WorkflowError(403, 'Yêu cầu phải đến từ cùng website.');
  }
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new WorkflowError(415, 'Yêu cầu phải ở định dạng JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16_384) {
      req.resume();
      throw new WorkflowError(413, 'Nội dung yêu cầu quá dài.');
    }
    chunks.push(chunk);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new WorkflowError(400, 'Dữ liệu JSON không hợp lệ.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WorkflowError(400, 'Dữ liệu yêu cầu không hợp lệ.');
  return data;
}

export function createApi(filename = process.env.ESCROW_DB_PATH || resolve('.data/escrow.sqlite')) {
  return createDatabaseApi(sqlStore(openSqlite(filename)));
}

export async function createConfiguredApi(root) {
  const connection = configuredDatabase(root);
  if (!connection) return createApi();
  const { db, store, name, explainError } = connection;
  let status;
  try {
    status = await db.check();
  } catch (error) {
    await db.close();
    throw new Error(explainError(error));
  }
  if (status.ready) return createDatabaseApi(store);
  await db.close();
  throw new Error(`Database ${name} chưa được khởi tạo. Chạy npm.cmd run db:migrate.`);
}

function createDatabaseApi(store) {
  const attempts = new Map();
  const dummySalt = randomBytes(16);
  const dummyHash = randomBytes(64);

  function limitAttempts(req, path) {
    const now = Date.now();
    for (const [key, value] of attempts) {
      if (value.expires <= now) attempts.delete(key);
    }
    const key = `${req.socket.remoteAddress}:${path}`;
    const limit = attempts.get(key) ?? { count: 0, expires: now + 10 * 60_000 };
    if (limit.count >= 30) throw new WorkflowError(429, 'Bạn đã thử quá nhiều lần. Hãy thử lại sau ít phút.');
    limit.count++;
    attempts.set(key, limit);
  }

  async function startSession(req, res, user) {
    const previous = sessionToken(req);
    const token = randomBytes(32).toString('hex');
    await store.transaction(async writes => {
      if (previous) await writes.deleteSession(hashToken(previous));
      await writes.insertSession(hashToken(token), user.id, Date.now() + sessionSeconds * 1000);
    });
    setSessionCookie(req, res, token);
  }

  async function workspace(user) {
    return visibleWorkspace(await store.readWorkspace(), user);
  }

  async function handle(req, res) {
    const path = req.url.split('?')[0];
    const method = req.method;
    const token = sessionToken(req);
    if (method === 'GET' && path === '/api/projects/public') {
      const projects = (await store.listOpenProjects())
        .map(({ id, title, category, description, budget }) => ({ id, title, category, description, budget }));
      return json(res, 200, { projects });
    }

    if (method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(path)) {
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!validEmail(email) || !password || password.length > 128) {
        throw new WorkflowError(400, 'Email hoặc mật khẩu có định dạng không hợp lệ.');
      }
      limitAttempts(req, path);
      if (path.endsWith('/register')) {
        const name = readName(body.name);
        if (!['Client', 'Freelancer'].includes(body.role)) throw new WorkflowError(400, 'Chọn vai trò Client hoặc Freelancer.');
        if (password.length < 12) throw new WorkflowError(400, 'Mật khẩu phải có ít nhất 12 ký tự.');
        if (await store.getUserByEmail(email)) throw new WorkflowError(409, 'Email này đã được đăng ký.');
        const salt = randomBytes(16);
        const hash = await passwordHash(password, salt);
        const created = await store.createUser({ id: randomUUID(), name, email, role: body.role, salt, password_hash: hash });
        if (!created) throw new WorkflowError(409, 'Email này đã được đăng ký.');
        return json(res, 201, { email });
      }
      const user = await store.getUserByEmail(email);
      const hash = await passwordHash(password, user?.salt ?? dummySalt);
      if (!timingSafeEqual(hash, user?.password_hash ?? dummyHash) || !user) {
        throw new WorkflowError(401, 'Email hoặc mật khẩu không đúng.');
      }
      await startSession(req, res, user);
      return json(res, 200, { user: publicAccount(user) });
    }

    if (method === 'POST' && path === '/api/auth/logout') {
      await readJson(req);
      if (token) {
        await store.transaction(async writes => {
          const tokenHash = hashToken(token);
          const current = await writes.getSessionUser(tokenHash);
          if (current && req.headers['x-escrow-account'] && req.headers['x-escrow-account'] !== current.id) {
            throw new WorkflowError(401, 'Tài khoản đang đăng nhập đã thay đổi.');
          }
          await writes.deleteSession(tokenHash);
        });
      }
      setSessionCookie(req, res);
      return json(res, 200, {});
    }

    if (!['/api/auth/me', '/api/auth/profile', '/api/workspace', '/api/projects', '/api/projects/action'].includes(path)) {
      throw new WorkflowError(404, 'API không tồn tại.');
    }
    const user = token && await store.getSessionUser(hashToken(token));
    if (!user || (req.headers['x-escrow-account'] && req.headers['x-escrow-account'] !== user.id)) {
      throw new WorkflowError(401, 'Phiên đăng nhập đã hết hạn hoặc tài khoản đã thay đổi.');
    }
    if (method === 'GET' && path === '/api/auth/me') return json(res, 200, { user });
    if (method === 'GET' && path === '/api/workspace') return json(res, 200, await workspace(user));

    if (method === 'POST') {
      const body = await readJson(req);
      // Recheck after reading the body and keep the session valid through the write.
      const authenticatedWrite = operation => store.transaction(async writes => {
        const current = await writes.getSessionUser(hashToken(token), true);
        if (!current) throw new WorkflowError(401, 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
        return operation(writes, current);
      });
      if (path === '/api/auth/profile') {
        const name = readName(body.name);
        await authenticatedWrite(writes => writes.updateUserName(user.id, name));
        return json(res, 200, { user: { ...user, name } });
      }
      if (path === '/api/projects') {
        const project = await authenticatedWrite((writes, current) => writes.createProject(createProject(current, body, 0)));
        return json(res, 201, { project, data: await workspace(user) });
      }
      if (path === '/api/projects/action') {
        if (!Number.isSafeInteger(body.projectId)) throw new WorkflowError(400, 'Mã dự án không hợp lệ.');
        await authenticatedWrite(async (writes, current) => {
          const project = await writes.getProject(body.projectId);
          if (!project) throw new WorkflowError(404, 'Dự án không tồn tại.');
          const freelancerEmail = normalizeEmail(body.email);
          const freelancer = body.action === 'assign' && validEmail(freelancerEmail)
            ? await writes.getUserByEmail(freelancerEmail) : undefined;
          const result = applyProjectAction(project, current, body, freelancer);
          await writes.saveProject(result.project);
          for (const transaction of result.transactions ?? []) {
            const tx = {
              ...transaction, id: `DEMO-${randomInt(100_000_000, 999_999_999)}`, projectId: body.projectId,
              project: result.project.title, time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
              status: 'Mô phỏng',
            };
            await writes.addTransaction(tx);
          }
        });
        return json(res, 200, await workspace(user));
      }
    }
    throw new WorkflowError(405, 'Phương thức không được hỗ trợ.');
  }

  return {
    close: store.close,
    middleware(req, res, next) {
      if (!req.url?.startsWith('/api/')) return next();
      handle(req, res).catch(error => {
        if (error instanceof WorkflowError) return json(res, error.status, { error: error.message });
        console.error('Escrow API failed:', error);
        json(res, 500, { error: 'Máy chủ gặp lỗi. Hãy thử lại.' });
      });
    },
  };
}
