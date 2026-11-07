import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { applyProjectAction, createProject, visibleWorkspace, WorkflowError } from '../src/workflow.ts';

const deriveKey = promisify(scrypt);
const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 40 * 1024 * 1024 };
const sessionSeconds = 7 * 24 * 60 * 60;
const cookieName = 'escrow_session';
const hashToken = token => createHash('sha256').update(token).digest('hex');
const passwordHash = (password, salt) => deriveKey(password, salt, 64, passwordOptions);
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = email => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const publicAccount = ({ id, name, email, role }) => ({ id, name, email, role });

function readName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 80) throw new WorkflowError(400, 'Tên phải có từ 2 đến 80 ký tự.');
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
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename, { timeout: 3000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('Client', 'Freelancer')),
      salt BLOB NOT NULL, password_hash BLOB NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, data TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY, data TEXT NOT NULL) STRICT;
  `);
  const userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const userByToken = db.prepare(`
    SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires > ?
  `);
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const getProjects = db.prepare('SELECT data FROM projects ORDER BY id DESC');
  const attempts = new Map();
  const dummySalt = randomBytes(16);
  const dummyHash = randomBytes(64);

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

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

  function startSession(req, res, user) {
    const previous = sessionToken(req);
    const token = randomBytes(32).toString('hex');
    transaction(() => {
      if (previous) deleteSession.run(hashToken(previous));
      db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hashToken(token), user.id, Date.now() + sessionSeconds * 1000);
    });
    setSessionCookie(req, res, token);
  }

  function workspace(user) {
    const projects = getProjects.all().map(row => JSON.parse(row.data));
    const txs = db.prepare('SELECT data FROM transactions ORDER BY id DESC').all().map(row => JSON.parse(row.data));
    return visibleWorkspace({ projects, txs }, user);
  }

  async function handle(req, res) {
    const path = req.url.split('?')[0];
    const method = req.method;
    const token = sessionToken(req);
    if (method === 'GET' && path === '/api/projects/public') {
      const projects = getProjects.all().map(row => JSON.parse(row.data))
        .filter(p => p.status === 'Open')
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
        if (userByEmail.get(email)) throw new WorkflowError(409, 'Email này đã được đăng ký.');
        const salt = randomBytes(16);
        const hash = await passwordHash(password, salt);
        const result = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
          .run(randomUUID(), name, email, body.role, salt, hash);
        if (!result.changes) throw new WorkflowError(409, 'Email này đã được đăng ký.');
        return json(res, 201, { email });
      }
      const user = userByEmail.get(email);
      const hash = await passwordHash(password, user?.salt ?? dummySalt);
      if (!timingSafeEqual(hash, user?.password_hash ?? dummyHash) || !user) {
        throw new WorkflowError(401, 'Email hoặc mật khẩu không đúng.');
      }
      startSession(req, res, user);
      return json(res, 200, { user: publicAccount(user) });
    }

    if (method === 'POST' && path === '/api/auth/logout') {
      await readJson(req);
      const current = token && userByToken.get(hashToken(token), Date.now());
      if (current && req.headers['x-escrow-account'] && req.headers['x-escrow-account'] !== current.id) {
        throw new WorkflowError(401, 'Tài khoản đang đăng nhập đã thay đổi.');
      }
      if (token) deleteSession.run(hashToken(token));
      setSessionCookie(req, res);
      return json(res, 200, {});
    }

    if (!['/api/auth/me', '/api/auth/profile', '/api/workspace', '/api/projects', '/api/projects/action'].includes(path)) {
      throw new WorkflowError(404, 'API không tồn tại.');
    }
    const user = token && userByToken.get(hashToken(token), Date.now());
    if (!user || (req.headers['x-escrow-account'] && req.headers['x-escrow-account'] !== user.id)) {
      throw new WorkflowError(401, 'Phiên đăng nhập đã hết hạn hoặc tài khoản đã thay đổi.');
    }
    if (method === 'GET' && path === '/api/auth/me') return json(res, 200, { user });
    if (method === 'GET' && path === '/api/workspace') return json(res, 200, workspace(user));

    if (method === 'POST') {
      const body = await readJson(req);
      // Recheck after reading the body in case the session was revoked while it arrived.
      if (!userByToken.get(hashToken(token), Date.now())) throw new WorkflowError(401, 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
      if (path === '/api/auth/profile') {
        const name = readName(body.name);
        db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
        return json(res, 200, { user: { ...user, name } });
      }
      if (path === '/api/projects') {
        const project = transaction(() => {
          const id = db.prepare('SELECT coalesce(max(id), 0) + 1 AS id FROM projects').get().id;
          const project = createProject(user, body, id);
          db.prepare('INSERT INTO projects VALUES (?, ?)').run(id, JSON.stringify(project));
          return project;
        });
        return json(res, 201, { project, data: workspace(user) });
      }
      if (path === '/api/projects/action') {
        if (!Number.isSafeInteger(body.projectId)) throw new WorkflowError(400, 'Mã dự án không hợp lệ.');
        transaction(() => {
          const row = db.prepare('SELECT data FROM projects WHERE id = ?').get(body.projectId);
          if (!row) throw new WorkflowError(404, 'Dự án không tồn tại.');
          const freelancer = body.action === 'assign' ? userByEmail.get(normalizeEmail(body.email)) : undefined;
          const result = applyProjectAction(JSON.parse(row.data), user, body, freelancer);
          db.prepare('UPDATE projects SET data = ? WHERE id = ?').run(JSON.stringify(result.project), body.projectId);
          if (result.transaction) {
            const tx = {
              ...result.transaction, id: `DEMO-${randomInt(100_000_000, 999_999_999)}`, projectId: body.projectId,
              project: result.project.title, time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
              status: 'Mô phỏng',
            };
            db.prepare('INSERT INTO transactions(data) VALUES (?)').run(JSON.stringify(tx));
          }
        });
        return json(res, 200, workspace(user));
      }
    }
    throw new WorkflowError(405, 'Phương thức không được hỗ trợ.');
  }

  return {
    close: () => db.close(),
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
