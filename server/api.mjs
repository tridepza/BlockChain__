import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { applyProjectAction, canSeePrivate, cents, createProject, deliveryFileLimit, deliveryPreviewLimit, mockGrantCents, visibleWorkspace, WorkflowError } from '../src/workflow.ts';
import { readDeliveryFiles, sendDeliveryFile } from './delivery.mjs';
import { configuredDatabase } from './database.mjs';
import { openSqlite } from './sqlite.mjs';
import { sqlStore } from './sql-store.mjs';
import { walletLinking } from './wallet.mjs';
import { localFunding } from './local-funding.mjs';
import { adminFescCase, adminFescStatistics, fescActions, fescWalletBalance, projectFesc, publicFescHolders, publicFescTransfers, reconcilePublicProjects } from './project-fesc.mjs';
import { authOtp, validPassword } from './auth-otp.mjs';
import { otpMailer } from './mail.mjs';
import { publicProjectPayments } from './public-projects.mjs';
import { createPublicClient, http } from 'viem';
import { localChain } from '../src/local-chain.ts';
import { rememberStorageTarget, sqliteTarget } from './storage-target.mjs';
import { fescVault } from './fesc-vault.mjs';
import { adminBuckets, adminEmails, adminPeriod, isAdminAccount, openAdminAnalytics } from './admin-analytics.mjs';

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

async function readJson(req, limit = 16_384) {
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
    if (size > limit) {
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

export function createApi(filename, root = process.cwd(), options = {}) {
  const target = filename ?? process.env.ESCROW_DB_PATH ?? resolve(root, '.data/escrow.sqlite');
  return createDatabaseApi(sqlStore(openSqlite(target)), root,
    { analyticsPath: target === ':memory:' ? ':memory:' : resolve(dirname(target), 'admin-analytics.sqlite'), ...options });
}

export async function createConfiguredApi(root) {
  const connection = configuredDatabase(root);
  if (!connection) {
    console.info('Escrow database: SQLite local.');
    if (process.env.ESCROW_DB_PATH !== ':memory:') rememberStorageTarget(root, sqliteTarget(root));
    return createApi(undefined, root);
  }
  const { db, store, name, explainError } = connection;
  let status;
  try {
    status = await db.check();
  } catch (error) {
    await db.close();
    throw new Error(explainError(error));
  }
  if (status.ready) {
    rememberStorageTarget(root, connection.target);
    console.info(`Escrow database: ${name} / ${status.database}.`);
    return createDatabaseApi(store, root);
  }
  await db.close();
  throw new Error(`Database ${name} chưa được khởi tạo. Chạy npm.cmd run db:migrate.`);
}

function createDatabaseApi(store, root, options = {}) {
  let analytics;
  const adminAnalytics = () => analytics ??= openAdminAnalytics(options.analyticsPath ?? resolve(root, '.data/admin-analytics.sqlite'));
  const walletApi = walletLinking(root);
  const otp = authOtp(store, options.sendOtp ?? otpMailer(root).sendOtp, options.now);
  const otpBinding = req => (req.headers.cookie ?? '').match(/(?:^|;\s*)escrow_otp=([a-f0-9]{64})(?=;|$)/)?.[1] ?? '';
  const setOtpCookie = (req, res, value) => res.setHeader('Set-Cookie', `escrow_otp=${value}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${value ? 600 : 0}${req.socket.encrypted ? '; Secure' : ''}`);
  const attempts = new Map();
  const dummySalt = randomBytes(16);
  const dummyHash = randomBytes(64);

  function limitAttempts(req, path, maximum = 30) {
    const now = Date.now();
    for (const [key, value] of attempts) {
      if (value.expires <= now) attempts.delete(key);
    }
    const key = `${req.socket.remoteAddress}:${path}`;
    const limit = attempts.get(key) ?? { count: 0, expires: now + 10 * 60_000 };
    if (limit.count >= Math.max(maximum, options.attemptLimit ?? 0)) throw new WorkflowError(429, 'Bạn đã thử quá nhiều lần. Hãy thử lại sau ít phút.');
    limit.count++;
    attempts.set(key, limit);
  }

  async function startSession(req, res, user) {
    const previous = sessionToken(req);
    const token = randomBytes(32).toString('hex');
    await store.transaction(async writes => {
      const current = await writes.getAuthUserForWrite(user.email);
      if (!current || current.id !== user.id || !timingSafeEqual(Buffer.from(current.password_hash), Buffer.from(user.password_hash))) {
        throw new WorkflowError(401, 'Tài khoản đã thay đổi. Hãy đăng nhập lại.');
      }
      if (previous) await writes.deleteSession(hashToken(previous));
      await writes.insertSession(hashToken(token), user.id, Date.now() + sessionSeconds * 1000);
    });
    setSessionCookie(req, res, token);
  }

  async function workspace(user) {
    const data = visibleWorkspace(await store.readWorkspaceForActor(user), user);
    return { ...data, mockWallet: await store.getMockBalance(user.id) };
  }

  async function handle(req, res) {
    const path = req.url.split('?')[0];
    const method = req.method;
    const token = sessionToken(req);
    if (method === 'POST' && path === '/api/analytics/visit') {
      await readJson(req);
      limitAttempts(req, path, 1000);
      const previous = (req.headers.cookie ?? '').match(/(?:^|;\s*)escrow_visitor=([a-f0-9]{64})(?=;|$)/)?.[1];
      const visitor = previous ?? randomBytes(32).toString('hex');
      adminAnalytics().recordVisit(visitor);
      if (!previous) res.setHeader('Set-Cookie', `escrow_visitor=${visitor}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${req.socket.encrypted ? '; Secure' : ''}`);
      return json(res, 200, {});
    }
    const adminPreview = /^\/api\/admin\/projects\/(\d+)\/milestones\/(\d+)\/deliveries\/([\da-f-]{36})\/preview$/.exec(path);
    if (adminPreview || ['/api/admin/access', '/api/admin/overview', '/api/admin/case'].includes(path)) {
      const account = token && await store.getSessionUser(hashToken(token));
      if (!account) throw new WorkflowError(401, 'Hãy đăng nhập để truy cập quản trị.');
      if (req.headers['x-escrow-account'] && req.headers['x-escrow-account'] !== account.id) throw new WorkflowError(401, 'Tài khoản đã thay đổi.');
      const allowed = isAdminAccount(account, options.adminEmails ?? adminEmails(root));
      if (path === '/api/admin/access' && method === 'GET') return json(res, 200, { allowed });
      if (!allowed) throw new WorkflowError(403, 'Tài khoản không có quyền quản trị.');
      if (adminPreview) {
        if (method !== 'GET') throw new WorkflowError(405, 'Phương thức không được hỗ trợ.');
        const [, projectId, milestoneId, deliveryId] = adminPreview;
        const project = await store.transaction(writes => writes.getProject(Number(projectId)));
        const delivery = project?.milestones.find(item => item.id === Number(milestoneId))?.deliveries?.find(item => item.id === deliveryId);
        if (!project || (!project.disputeReason && !project.adminReview) || !delivery?.preview) throw new WorkflowError(404, 'Bằng chứng không tồn tại trong hồ sơ tranh chấp.');
        const file = await store.getDeliveryFile(deliveryId, 'preview');
        if (!file) throw new WorkflowError(404, 'Tệp bằng chứng không tồn tại.');
        return sendDeliveryFile(res, file);
      }
      if (path === '/api/admin/case') {
        const input = method === 'POST' ? await readJson(req) : Object.fromEntries(new URLSearchParams(req.url.slice(path.length + 1)));
        const id = Number(input.projectId);
        if (!Number.isSafeInteger(id) || id <= 0) throw new WorkflowError(400, 'Mã dự án không hợp lệ.');
        const result = await store.transaction(async writes => {
          const current = await writes.getSessionUser(hashToken(token), true);
          if (!current || !isAdminAccount(current, options.adminEmails ?? adminEmails(root))) throw new WorkflowError(403, 'Quyền quản trị đã thay đổi.');
          let project = await writes.getProject(id);
          if (!project || (!project.disputeReason && !project.adminReview && project.status !== 'Disputed')) throw new WorkflowError(404, 'Hồ sơ tranh chấp không tồn tại.');
          if (method === 'GET') {
            let chain;
            if (project.currency === 'FESC') {
              try { chain = await adminFescCase(root, project); }
              catch { chain = { unavailable: true, message: 'Chưa xác minh được hợp đồng trên chain hiện tại.' }; }
            }
            return { project, chain };
          }
          if (method !== 'POST') throw new WorkflowError(405, 'Phương thức không được hỗ trợ.');
          const note = typeof input.note === 'string' ? input.note.trim() : '';
          if (note.length < 3 || note.length > 2000) throw new WorkflowError(400, 'Nội dung xử lý cần 3–2000 ký tự.');
          const revision = project.adminReview?.revision ?? 0;
          if (input.revision !== revision) throw new WorkflowError(409, 'Hồ sơ đã thay đổi. Hãy tải lại trước khi xử lý.');
          if (!['review', 'release', 'refund'].includes(input.action)) throw new WorkflowError(400, 'Thao tác quản trị không hợp lệ.');
          if (project.status !== 'Disputed') throw new WorkflowError(409, 'Dự án không còn tranh chấp.');
          if (input.action !== 'review') {
            if (current.id === project.ownerId || current.id === project.freelancerId) throw new WorkflowError(403, 'Admin không được phân xử dự án của chính mình.');
            if (project.currency === 'FESC') {
              const resolution = await adminFescCase(root, project, { ...input, action: input.hash ? 'confirm' : 'prepare', decision: input.action });
              if (!input.hash) return { transaction: resolution };
              project = resolution.project;
              await writes.addTransaction({ ...resolution.transaction, projectId: id, project: project.title,
                action: 'Phân xử FESC: phân bổ quyền rút', amount: 0, currency: 'FESC', status: 'Đã xác nhận' });
            } else {
              const milestone = project.milestones.find(item => item.status === 'Disputed');
              const resolved = applyProjectAction(project, { id: 'demo-arbitrator', role: 'Arbitrator' },
                { action: input.action, milestoneId: milestone?.id, note });
              project = resolved.project;
              for (const tx of resolved.transactions ?? []) {
                const beneficiary = tx.action === 'Phân xử: giải ngân' ? project.freelancerId : project.ownerId;
                if (!beneficiary) throw new WorkflowError(409, 'Dự án thiếu bên nhận tiền.');
                await writes.creditMock(beneficiary, cents(tx.amount));
                await writes.addTransaction({ ...tx, id: randomUUID(), projectId: id, project: project.title,
                  time: new Date().toISOString(), currency: 'MOCK', status: 'Mô phỏng' });
              }
            }
          }
          project = { ...project, adminReview: { revision: revision + 1, status: input.action === 'review' ? 'reviewing' : 'resolved',
            history: [...(project.adminReview?.history ?? []), { actorId: current.id, action: input.action, note,
              at: new Date().toISOString(), ...(input.hash ? { hash: input.hash } : {}) }] } };
          await writes.saveProject(project);
          return { project };
        });
        return json(res, 200, result);
      }
      if (method !== 'GET') throw new WorkflowError(405, 'Phương thức không được hỗ trợ.');
      const params = new URLSearchParams(req.url.slice(path.length + 1));
      const range = adminPeriod(params.get('period') ?? 'day', params.get('date') ?? undefined);
      await reconcilePublicProjects(root, store);
      const data = await store.readWorkspace();
      const buckets = range.period === 'day' ? [] : adminBuckets(range);
      let fesc;
      try { fesc = await adminFescStatistics(root, range, (await store.getWalletLink(account.id))?.address, buckets); }
      catch { fesc = { available: false, error: 'Không đọc được blockchain FESC. Kiểm tra node và thử lại.' }; }
      const createdTimes = data.projects.map(project => Date.parse(project.createdAt ?? `${project.created}T00:00:00+07:00`));
      const createdIn = ({ start, end }) => createdTimes.filter(time => time >= Date.parse(start) && time < Date.parse(end)).length;
      return json(res, 200, { range, traffic: adminAnalytics().summary(range),
        fesc,
        projectCount: data.projects.length,
        projectSeries: buckets.map(bucket => ({ key: bucket.key, created: createdIn(bucket) })),
        projectCounts: {
          created: createdIn(range),
          completed: data.projects.filter(project => project.status === 'Completed').length,
        },
        disputes: data.projects.filter(project => project.status === 'Disputed'),
        resolvedDisputes: data.projects.filter(project => project.adminReview?.status === 'resolved') });
    }
    const deliveryDownload = /^\/api\/projects\/(\d+)\/milestones\/(\d+)\/deliveries\/([\da-f-]{36})\/(preview|original)$/.exec(path);
    if (method === 'GET' && path === '/api/projects/public') {
      const projects = (await store.listOpenProjects())
        .map(({ id, title, category, description, budget, currency }) => ({ id, title, category, description, budget, currency: currency ?? 'MOCK' }));
      return json(res, 200, { projects });
    }
    if (method === 'GET' && path === '/api/explorer/transfers') {
      const params = new URLSearchParams(req.url.slice(path.length + 1));
      return json(res, 200, await publicFescTransfers(root, params));
    }
    if (method === 'GET' && path === '/api/explorer/holders') {
      return json(res, 200, await publicFescHolders(root));
    }
    if (method === 'GET' && path === '/api/explorer/projects') {
      const params = new URLSearchParams(req.url.slice(path.length + 1));
      const rpc = createPublicClient({ transport: http(localChain.rpcUrl, { timeout: 2500, retryCount: 0 }) });
      await reconcilePublicProjects(root, store);
      return json(res, 200, await publicProjectPayments(store, rpc, (params.get('q') ?? '').trim().slice(0, 80)));
    }

    if (method === 'POST' && path === '/api/auth/forgot') {
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) throw new WorkflowError(400, 'Nhập địa chỉ email hợp lệ.');
      limitAttempts(req, path);
      const user = await store.getUserByEmail(email);
      const binding = randomBytes(32).toString('hex');
      let challenge;
      try {
        challenge = await otp.issue(email, 'reset', user ? { id: user.id,
          password_hash: Buffer.from(user.password_hash).toString('hex') }
          : { id: randomUUID(), silent: true, password_hash: '' }, binding);
      } catch (error) {
        if (!(error instanceof WorkflowError) || error.status !== 503) throw error;
        console.warn('Password reset: SMTP unavailable.');
        challenge = { challengeId: randomUUID(), email, purpose: 'reset', expiresAt: Date.now() + 300_000, resendAt: Date.now() + 60_000 };
      }
      setOtpCookie(req, res, binding);
      return json(res, 202, challenge);
    }
    if (method === 'POST' && path === '/api/auth/reset') {
      const body = await readJson(req);
      limitAttempts(req, path);
      if (!validPassword(body.password)) throw new WorkflowError(400, 'Mật khẩu phải có từ 12 đến 128 ký tự, gồm chữ thường, số và ký tự đặc biệt.');
      if (body.password !== body.confirm) throw new WorkflowError(400, 'Mật khẩu xác nhận chưa khớp.');
      const salt = randomBytes(16);
      await otp.resetPassword(body.challengeId, body.resetToken, otpBinding(req), salt, await passwordHash(body.password, salt));
      setOtpCookie(req, res, '');
      return json(res, 200, { message: 'Đã đặt lại mật khẩu. Hãy đăng nhập bằng mật khẩu mới.' });
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
        if (!validPassword(password)) throw new WorkflowError(400, 'Mật khẩu phải có từ 12 đến 128 ký tự, gồm chữ thường, số và ký tự đặc biệt.');
        if (await store.getUserByEmail(email)) throw new WorkflowError(409, 'Email này đã được đăng ký.');
        const salt = randomBytes(16);
        const hash = await passwordHash(password, salt);
        const binding = randomBytes(32).toString('hex');
        const challenge = await otp.issue(email, 'register', { id: randomUUID(), name, email, role: body.role,
          salt: salt.toString('hex'), password_hash: hash.toString('hex') }, binding);
        setOtpCookie(req, res, binding);
        return json(res, 202, challenge);
      }
      const user = await store.getUserByEmail(email);
      const hash = await passwordHash(password, user?.salt ?? dummySalt);
      if (!timingSafeEqual(hash, user?.password_hash ?? dummyHash) || !user) {
        throw new WorkflowError(401, 'Email hoặc mật khẩu không đúng.');
      }
      const binding = randomBytes(32).toString('hex');
      const challenge = await otp.issue(email, 'login', { id: user.id, password_hash: Buffer.from(user.password_hash).toString('hex') }, binding);
      setOtpCookie(req, res, binding);
      return json(res, 202, challenge);
    }

    if (method === 'POST' && path === '/api/auth/verify') {
      const body = await readJson(req);
      limitAttempts(req, path);
      const result = await otp.verify(body.challengeId, body.code, otpBinding(req));
      if (result.purpose === 'reset') {
        setOtpCookie(req, res, otpBinding(req));
        return json(res, 200, { resetToken: result.resetToken, expiresAt: result.expiresAt });
      }
      setOtpCookie(req, res, '');
      if (result.purpose === 'register') return json(res, 201, { email: result.email });
      await startSession(req, res, result.user);
      // Keep both the session cookie and removal of the OTP binding.
      res.setHeader('Set-Cookie', [res.getHeader('Set-Cookie'), 'escrow_otp=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0']);
      return json(res, 200, { user: publicAccount(result.user) });
    }
    if (method === 'POST' && path === '/api/auth/resend') {
      const body = await readJson(req);
      limitAttempts(req, path);
      const binding = otpBinding(req);
      const challenge = await otp.resend(body.challengeId, binding);
      setOtpCookie(req, res, binding);
      return json(res, 202, challenge);
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

    if (!deliveryDownload && !['/api/auth/me', '/api/auth/profile', '/api/workspace', '/api/projects', '/api/projects/action', '/api/projects/delivery',
      '/api/wallet', '/api/wallet/challenges', '/api/wallet/verify', '/api/wallet/local-funding', '/api/wallet/local-status',
      '/api/wallet/mock-claim', '/api/wallet/fesc-balance', '/api/wallet/fesc-account', '/api/projects/fesc'].includes(path)) {
      throw new WorkflowError(404, 'API không tồn tại.');
    }
    const user = token && await store.getSessionUser(hashToken(token));
    if (!user || (req.headers['x-escrow-account'] && req.headers['x-escrow-account'] !== user.id)) {
      throw new WorkflowError(401, 'Phiên đăng nhập đã hết hạn hoặc tài khoản đã thay đổi.');
    }
    if (method === 'GET' && path === '/api/auth/me') return json(res, 200, { user });
    if (method === 'GET' && path === '/api/workspace') return json(res, 200, await workspace(user));
    if (method === 'GET' && path === '/api/wallet') return json(res, 200, { wallet: await store.getWalletLink(user.id) });
    if (method === 'GET' && deliveryDownload) {
      const [, projectKey, milestoneId, deliveryId, kind] = deliveryDownload;
      const projectId = Number(projectKey);
      if (!Number.isSafeInteger(projectId)) throw new WorkflowError(404, 'Tệp bàn giao không tồn tại.');
      const project = await store.getProjectForActor(projectId, user);
      const isClient = user.role === 'Client' && user.id === project?.ownerId;
      const isFreelancer = user.role === 'Freelancer' && user.id === project?.freelancerId;
      if (!isClient && !isFreelancer) throw new WorkflowError(404, 'Tệp bàn giao không tồn tại.');
      const milestone = project.milestones.find(item => item.id === Number(milestoneId));
      const delivery = milestone?.deliveries?.find(item => item.id === deliveryId);
      if (!delivery?.[kind]) throw new WorkflowError(404, 'Tệp bàn giao không tồn tại.');
      if (kind === 'original' && isClient && (milestone.status !== 'Paid' || milestone.submissionVersion !== delivery.version)) {
        throw new WorkflowError(403, 'Bản gốc chỉ mở cho phiên bản đã được giải ngân.');
      }
      const file = await store.getDeliveryFile(deliveryId, kind);
      if (!file) throw new WorkflowError(404, 'Tệp bàn giao không tồn tại.');
      return sendDeliveryFile(res, file);
    }

    if (method === 'POST') {
      const deliveryUpload = path === '/api/projects/delivery';
      if (deliveryUpload && user.role !== 'Freelancer') throw new WorkflowError(403, 'Chỉ Freelancer được tải tệp bàn giao.');
      const body = await readJson(req, deliveryUpload
        ? 4 * (Math.ceil(deliveryFileLimit / 3) + Math.ceil(deliveryPreviewLimit / 3)) + 16_384
        : undefined);
      // Recheck after reading the body and keep the session valid through the write.
      const sessionId = hashToken(token);
      const authenticatedWrite = operation => store.transaction(async writes => {
        const current = await writes.getSessionUser(sessionId, true);
        if (!current) throw new WorkflowError(401, 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
        return operation(writes, current);
      });
      if (path === '/api/wallet/challenges' || path === '/api/wallet/verify') {
        const origin = walletApi.getOrigin(req);
        limitAttempts(req, path);
        if (path.endsWith('/challenges')) {
          const result = await walletApi.challenge(body, authenticatedWrite, user.id, sessionId, origin);
          return json(res, 201, result);
        }
        const wallet = await walletApi.verify(body, store, authenticatedWrite, user.id, sessionId, origin);
        return json(res, 200, { wallet });
      }
      if (path === '/api/wallet/local-status') {
        walletApi.getOrigin(req);
        const wallet = await store.getWalletLink(user.id);
        if (!wallet) throw new WorkflowError(409, 'Hãy xác minh ví trước.');
        return json(res, 200, await walletApi.localStatus(wallet.address));
      }
      if (path === '/api/wallet/fesc-balance') {
        walletApi.getOrigin(req);
        return json(res, 200, await fescWalletBalance(root, await store.getWalletLink(user.id)));
      }
      if (path === '/api/wallet/fesc-account') {
        walletApi.getOrigin(req);
        return json(res, 200, await fescVault(root, await store.getWalletLink(user.id), body));
      }
      if (path === '/api/projects/fesc') {
        walletApi.getOrigin(req);
        if (!Number.isSafeInteger(body.projectId) || (body.action !== undefined && !fescActions.includes(body.action))) {
          throw new WorkflowError(400, 'Yêu cầu dự án FESC không hợp lệ.');
        }
        const result = await authenticatedWrite(async (writes, current) => {
          const project = await writes.getProjectForActor(body.projectId, current);
          if (!project) throw new WorkflowError(404, 'Dự án FESC không tồn tại.');
          return projectFesc(root, writes, project, current, body);
        });
        return json(res, 200, result);
      }
      if (path === '/api/wallet/mock-claim') {
        if (user.role !== 'Client') throw new WorkflowError(403, 'Chỉ Client nhận ngân sách MOCK thử.');
        await authenticatedWrite(async (writes, current) => {
          if (!await writes.claimMock(current.id, mockGrantCents)) {
            throw new WorkflowError(409, 'Tài khoản đã nhận ngân sách MOCK thử.');
          }
        });
        return json(res, 200, await workspace(user));
      }
      if (path === '/api/wallet/local-funding') {
        walletApi.getOrigin(req);
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
          throw new WorkflowError(403, 'Bài thử Hardhat chỉ chạy trên máy này.');
        }
        if (user.role !== 'Client') throw new WorkflowError(403, 'Bài thử ký quỹ dành cho tài khoản Client.');
        if (body.action !== undefined && !['create', 'accept', 'reset', 'approve', 'fund'].includes(body.action)) {
          throw new WorkflowError(400, 'Thao tác thử không hợp lệ.');
        }
        const wallet = await store.getWalletLink(user.id);
        const currency = body.currency ?? 'FESC';
        if (!['FESC', 'MockUSDC'].includes(currency)) throw new WorkflowError(400, 'Token ký quỹ không được hỗ trợ.');
        return json(res, 200, await localFunding(root, wallet, body.action, currency));
      }
      if (path === '/api/auth/profile') {
        const name = readName(body.name);
        await authenticatedWrite(writes => writes.updateUserName(user.id, name));
        return json(res, 200, { user: { ...user, name } });
      }
      if (path === '/api/projects') {
        const project = await authenticatedWrite((writes, current) => writes.createProject(createProject(current, body, 0)));
        return json(res, 201, { project, data: await workspace(user) });
      }
      if (path === '/api/projects/action' || deliveryUpload) {
        if (!Number.isSafeInteger(body.projectId)) throw new WorkflowError(400, 'Mã dự án không hợp lệ.');
        if (deliveryUpload && body.action !== 'submit') throw new WorkflowError(400, 'Thao tác bàn giao không hợp lệ.');
        await authenticatedWrite(async (writes, current) => {
          let project = await writes.getProjectForActor(body.projectId, current);
          if (!project) throw new WorkflowError(404, 'Dự án không tồn tại.');
          const freelancerEmail = normalizeEmail(body.email);
          const freelancer = body.action === 'assign' && validEmail(freelancerEmail)
            ? await writes.getUserByEmail(freelancerEmail) : undefined;
          if (deliveryUpload && project.freelancerId !== current.id) {
            throw new WorkflowError(403, 'Chỉ Freelancer của dự án được tải tệp bàn giao.');
          }
          const delivery = deliveryUpload ? readDeliveryFiles(body) : undefined;
          if (project.currency === 'FESC' && body.action !== 'assign') {
            if (!canSeePrivate(project, current)) throw new WorkflowError(403, 'Bạn không có quyền thực hiện thao tác này.');
            if (!delivery) throw new WorkflowError(409, 'Thao tác FESC cần thực hiện từ mục Ký quỹ FESC trong dự án.');
            if ((await projectFesc(root, writes, project, current)).step !== 'upload') {
              throw new WorkflowError(409, 'Milestone FESC chưa sẵn sàng nhận bàn giao.');
            }
            project = await writes.getProject(body.projectId);
          }
          const result = applyProjectAction(project, current, body, freelancer, delivery?.metadata);
          if (body.action === 'fund' && !await writes.debitMock(current.id, cents(project.budget))) {
            throw new WorkflowError(409, 'Số dư MOCK không đủ để ký quỹ dự án.');
          }
          if (body.action === 'approve') {
            await writes.creditMock(project.freelancerId, cents(result.project.paid) - cents(project.paid));
          }
          if (body.action === 'confirmCancel') {
            const refund = cents(result.transactions[0].amount);
            if (refund > 0) await writes.creditMock(project.ownerId, refund);
          }
          if (delivery) {
            const latest = result.project.milestones.find(item => item.id === body.milestoneId).deliveries.at(-1);
            for (const [kind, file] of Object.entries(delivery.files)) {
              if (file) await writes.saveDeliveryFile(latest.id, kind, file);
            }
          }
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
    close: async () => { analytics?.close(); await store.close(); },
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
