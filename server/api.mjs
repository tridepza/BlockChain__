import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { applyProjectAction, canSeePrivate, createProject, deliveryFileLimit, deliveryPreviewLimit, visibleWorkspace, WorkflowError } from '../src/workflow.ts';
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
import { discardEvidence, markEvidenceUsed, pickEvidence, receiveEvidence, sendEvidence } from './evidence.mjs';
import { adminAccounts, adminFescServerSign, chainUnavailableMessage, dueSeconds } from './project-fesc.mjs';
import { arbitratorSigner } from './arbitrator.mjs';

const decisionLabels = { release: 'Giải ngân 100% cho Freelancer', split: 'Chia đều 50/50 cho hai bên', refund: 'Hoàn 100% cho Client' };

function assertSameOrigin(req) {
  const origin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new WorkflowError(403, 'Yêu cầu phải đến từ cùng website.');
  }
}

const isParty = (project, user) => Boolean(project) &&
  (user.role === 'Client' && user.id === project.ownerId || user.role === 'Freelancer' && user.id === project.freelancerId);
const findEvidence = (project, id) => (project?.evidenceUploads ?? []).find(item => item.id === id && item.kind === 'file');

function resolutionEmail(project, entry, url) {
  const milestone = project.milestones.find(item => item.arbitration && item.arbitration === entry.arbitration) ??
    project.milestones.findLast(item => item.arbitration);
  const result = entry.arbitration ?? milestone?.arbitration;
  return {
    subject: `Kết quả phân xử dự án #${project.id}: ${project.title}`,
    text: [
      `Admin đã phân xử khiếu nại của dự án "${project.title}".`, '',
      `Giai đoạn: ${milestone?.title ?? 'giai đoạn bị khiếu nại'}`,
      `Quyết định: ${decisionLabels[entry.action] ?? entry.action}`,
      ...(result ? [`Freelancer nhận: ${result.toFreelancer} FESC`, `Client nhận: ${result.toClient} FESC`,
        result.mode === 'continue' ? 'Hợp đồng: tiếp tục giai đoạn tiếp theo.' : 'Hợp đồng: chấm dứt, các giai đoạn còn lại hoàn cho Client.'] : []),
      `Lý do của admin: ${entry.note}`,
      ...(entry.hash ? [`Mã giao dịch: ${entry.hash}`] : []), '',
      result?.paidOut ? 'FESC đã được chuyển thẳng về ví của hai bên trong giao dịch phân xử.'
        : 'Phần FESC được phân bổ nằm trong hợp đồng. Mở dự án và bấm "Rút FESC được phân xử" để nhận về ví.',
      ...(url ? [url] : []),
    ].join('\n'),
  };
}

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
  let mailer;
  const sendNotice = options.sendNotice ?? (message => (mailer ??= otpMailer(root)).sendNotice(message));
  const attempts = new Map();
  const dummySalt = randomBytes(16);

  // Emails both parties after a confirmed decision; delivery failures are recorded, never rolled back.
  async function notifyResolution(projectId, at, origin) {
    const { project, parties } = await store.transaction(async writes => {
      const project = await writes.getProject(projectId);
      return { project, parties: await Promise.all([project.ownerId, project.freelancerId].filter(Boolean).map(id => writes.getAccount(id))) };
    });
    const entry = project.adminReview?.history.find(item => item.at === at);
    if (!entry) throw new WorkflowError(404, 'Không tìm thấy quyết định để gửi email.');
    const message = resolutionEmail(project, entry, origin ? `${origin}/` : '');
    const results = await Promise.allSettled(parties.filter(account => account?.email)
      .map(account => sendNotice({ email: account.email, ...message })));
    const emailed = results.length === 2 && results.every(result => result.status === 'fulfilled') ? 'sent' : 'failed';
    await store.transaction(async writes => {
      const latest = await writes.getProject(projectId);
      await writes.saveProject({ ...latest, adminReview: { ...latest.adminReview,
        history: latest.adminReview.history.map(item => item.at === at ? { ...item, emailed, emailedAt: new Date().toISOString() } : item) } });
    });
    return emailed;
  }
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
    // The other party's unsubmitted uploads and complaint drafts stay private until submitted.
    const projects = data.projects.map(project => ({ ...project,
      ...(project.evidenceUploads ? { evidenceUploads: project.evidenceUploads.filter(item => item.used || item.byId === user.id) } : {}),
      ...(project.fesc ? { fesc: { ...project.fesc, disputeDrafts: undefined } } : {}) }));
    return { ...data, projects };
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
    const adminEvidence = /^\/api\/admin\/projects\/(\d+)\/evidence\/([\da-f-]{36})$/.exec(path);
    if (adminPreview || adminEvidence || ['/api/admin/access', '/api/admin/overview', '/api/admin/case', '/api/admin/accounts',
      '/api/admin/transactions'].includes(path)) {
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
      if (adminEvidence) {
        if (method !== 'GET') throw new WorkflowError(405, 'Phương thức không được hỗ trợ.');
        const project = await store.transaction(writes => writes.getProject(Number(adminEvidence[1])));
        const item = findEvidence(project, adminEvidence[2]);
        if (!item || !item.used) throw new WorkflowError(404, 'Bằng chứng không tồn tại trong hồ sơ tranh chấp.');
        return sendEvidence(root, res, item, new URLSearchParams(req.url.split('?')[1] ?? '').get('inline') === '1');
      }
      if (path === '/api/admin/case') {
        const input = method === 'POST' ? await readJson(req) : Object.fromEntries(new URLSearchParams(req.url.slice(path.length + 1)));
        const id = Number(input.projectId);
        if (!Number.isSafeInteger(id) || id <= 0) throw new WorkflowError(400, 'Mã dự án không hợp lệ.');
        // Record an on-chain complaint even if neither party has reopened the project since filing it.
        await store.transaction(async writes => {
          const latest = await writes.getProject(id);
          if (latest?.currency === 'FESC' && latest.fesc && latest.status !== 'Completed') {
            await projectFesc(root, writes, latest, { id: latest.ownerId, role: 'Client' }).catch(() => {});
          }
        });
        // Without a transaction hash, the server signs the decision itself when it holds the arbitrator key,
        // so admins need no wallet. The checks guarding a decision run before anything is signed; the usual
        // confirmation below then verifies the mined transaction, records it and emails both parties.
        if (method === 'POST' && decisionLabels[input.action] && !input.hash && options.serverArbitrator !== false) {
          const pending = await store.transaction(writes => writes.getProject(id));
          const note = typeof input.note === 'string' ? input.note.trim() : '';
          if (pending?.currency === 'FESC' && pending.fesc && pending.status === 'Disputed' &&
              account.id !== pending.ownerId && account.id !== pending.freelancerId &&
              note.length >= 3 && note.length <= 2000 && input.revision === (pending.adminReview?.revision ?? 0)) {
            try {
              const hash = await adminFescServerSign(root, pending, { ...input, decision: input.action });
              if (hash) input.hash = hash;
            } catch (error) {
              if (error instanceof WorkflowError && error.status === 503) throw new WorkflowError(409, await chainUnavailableMessage(root, pending));
              throw error;
            }
          }
        }
        const result = await store.transaction(async writes => {
          const current = await writes.getSessionUser(hashToken(token), true);
          if (!current || !isAdminAccount(current, options.adminEmails ?? adminEmails(root))) throw new WorkflowError(403, 'Quyền quản trị đã thay đổi.');
          let project = await writes.getProject(id);
          if (!project || (!project.disputeReason && !project.adminReview && project.status !== 'Disputed')) throw new WorkflowError(404, 'Hồ sơ tranh chấp không tồn tại.');
          if (method === 'GET') {
            let chain;
            if (project.currency === 'FESC') {
              try {
                chain = await adminFescCase(root, project);
                chain.serverSigner = options.serverArbitrator !== false && !!arbitratorSigner(root, chain.arbitrator);
              }
              catch { chain = { unavailable: true, message: await chainUnavailableMessage(root, project) }; }
            }
            return { project, chain };
          }
          if (method !== 'POST') throw new WorkflowError(405, 'Phương thức không được hỗ trợ.');
          if (input.action === 'email') {
            const entry = project.adminReview?.history.find(item => item.at === input.at && decisionLabels[item.action]);
            if (!entry) throw new WorkflowError(404, 'Không tìm thấy quyết định để gửi lại email.');
            return { notify: entry.at };
          }
          const note = typeof input.note === 'string' ? input.note.trim() : '';
          if (note.length < 3 || note.length > 2000) throw new WorkflowError(400, 'Nội dung xử lý cần 3–2000 ký tự.');
          const revision = project.adminReview?.revision ?? 0;
          if (input.revision !== revision) throw new WorkflowError(409, 'Hồ sơ đã thay đổi. Hãy tải lại trước khi xử lý.');
          if (!['review', 'release', 'split', 'refund'].includes(input.action)) throw new WorkflowError(400, 'Thao tác quản trị không hợp lệ.');
          if (project.status !== 'Disputed') throw new WorkflowError(409, 'Dự án không còn tranh chấp.');
          let arbitration;
          if (input.action !== 'review') {
            if (current.id === project.ownerId || current.id === project.freelancerId) throw new WorkflowError(403, 'Admin không được phân xử dự án của chính mình.');
            if (project.currency !== 'FESC') throw new WorkflowError(409, 'Dự án mô phỏng MOCK không còn được hỗ trợ.');
            const resolution = await adminFescCase(root, project, { ...input, action: input.hash ? 'confirm' : 'prepare', decision: input.action });
            if (!input.hash) return { transaction: resolution };
            project = resolution.project;
            arbitration = resolution.arbitration;
            await writes.addTransaction({ ...resolution.transaction, projectId: id, project: project.title,
              action: `Phân xử FESC: ${decisionLabels[input.action]}`, amount: arbitration.toFreelancer, currency: 'FESC', status: 'Đã xác nhận' });
          }
          const at = new Date().toISOString();
          // Admin replies are shared with both parties; decisions carry the on-chain allocation.
          project = { ...project, adminReview: { revision: revision + 1, status: input.action === 'review' ? 'reviewing' : 'resolved',
            history: [...(project.adminReview?.history ?? []), { actorId: current.id, actor: current.name, action: input.action, note, at,
              ...(input.hash ? { hash: input.hash } : {}), ...(arbitration ? { arbitration } : {}) }] } };
          await writes.saveProject(project);
          return { project, ...(input.action === 'review' ? {} : { notify: at }) };
        });
        if (result.notify) {
          const origin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
          result.emailed = await notifyResolution(id, result.notify, origin).catch(() => 'failed');
          result.project = await store.transaction(writes => writes.getProject(id));
          delete result.notify;
        }
        return json(res, 200, result);
      }
      if (path === '/api/admin/accounts') {
        if (method !== 'GET') throw new WorkflowError(405, 'Phương thức không được hỗ trợ.');
        return json(res, 200, await adminAccounts(root, await store.transaction(writes => writes.listAccounts())));
      }
      if (path === '/api/admin/transactions') {
        if (method !== 'GET') throw new WorkflowError(405, 'Phương thức không được hỗ trợ.');
        const params = new URLSearchParams(req.url.slice(path.length + 1));
        const query = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);
        const page = Math.max(1, Math.min(10_000, Number(params.get('page')) || 1));
        const { txs } = await store.readWorkspace();
        const matches = txs.filter(tx => tx.currency === 'FESC' && (!query ||
          [tx.id, tx.project, tx.action, String(tx.projectId)].some(value => String(value ?? '').toLowerCase().includes(query))));
        const size = 25;
        return json(res, 200, { total: matches.length, page, pageSize: size, transactions: matches.slice((page - 1) * size, page * size) });
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
        .map(({ id, title, category, description, budget, currency }) => ({ id, title, category, description, budget, currency: currency ?? 'FESC' }));
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

    const evidenceDownload = /^\/api\/projects\/(\d+)\/evidence\/([\da-f-]{36})$/.exec(path);
    if (!deliveryDownload && !evidenceDownload && !['/api/auth/me', '/api/auth/profile', '/api/workspace', '/api/projects', '/api/projects/action', '/api/projects/delivery',
      '/api/projects/evidence', '/api/projects/dispute-evidence', '/api/projects/extension',
      '/api/wallet', '/api/wallet/challenges', '/api/wallet/verify', '/api/wallet/local-funding', '/api/wallet/local-status',
      '/api/wallet/fesc-balance', '/api/wallet/fesc-account', '/api/projects/fesc'].includes(path)) {
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
    if (method === 'GET' && evidenceDownload) {
      const project = await store.getProjectForActor(Number(evidenceDownload[1]), user);
      const item = isParty(project, user) ? findEvidence(project, evidenceDownload[2]) : undefined;
      // Unused uploads stay private to their uploader; submitted evidence is visible to both parties.
      if (!item || (!item.used && item.byId !== user.id)) throw new WorkflowError(404, 'Bằng chứng không tồn tại.');
      return sendEvidence(root, res, item, new URLSearchParams(req.url.split('?')[1] ?? '').get('inline') === '1');
    }
    if (method === 'POST' && path === '/api/projects/evidence') {
      // Raw (non-JSON) upload so 100MB files are streamed to disk instead of buffered.
      assertSameOrigin(req);
      const params = new URLSearchParams(req.url.split('?')[1] ?? '');
      const projectId = Number(params.get('projectId'));
      const project = Number.isSafeInteger(projectId) ? await store.getProjectForActor(projectId, user) : undefined;
      if (!isParty(project, user) || project.currency !== 'FESC') throw new WorkflowError(404, 'Dự án không tồn tại.');
      if ((project.evidenceUploads ?? []).filter(item => !item.used && item.byId === user.id).length >= 30) {
        throw new WorkflowError(409, 'Bạn có quá nhiều tệp chưa dùng. Hãy gửi khiếu nại hoặc bổ sung bằng chứng trước.');
      }
      limitAttempts(req, path, 120);
      const item = { ...await receiveEvidence(root, req, params.get('name')), byId: user.id, by: user.role, at: new Date().toISOString() };
      try {
        await store.transaction(async writes => {
          if (!await writes.getSessionUser(hashToken(token), true)) throw new WorkflowError(401, 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
          const latest = await writes.getProjectForActor(projectId, user);
          if (!isParty(latest, user)) throw new WorkflowError(404, 'Dự án không tồn tại.');
          await writes.saveProject({ ...latest, evidenceUploads: [...(latest.evidenceUploads ?? []), item] });
        });
      } catch (error) {
        await discardEvidence(root, item.id);
        throw error;
      }
      return json(res, 201, { evidence: item });
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
      if (path === '/api/projects/dispute-evidence') {
        const project = await authenticatedWrite(async (writes, current) => {
          const latest = await writes.getProjectForActor(body.projectId, current);
          if (!isParty(latest, current) || latest.status !== 'Disputed' || !latest.dispute) {
            throw new WorkflowError(409, 'Chỉ bổ sung bằng chứng khi dự án đang tranh chấp.');
          }
          const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
          const items = pickEvidence(latest, current, body.evidenceIds, body.links).map(item => ({ ...item, note, added: true }));
          const next = markEvidenceUsed({ ...latest, dispute: { ...latest.dispute, evidence: [...latest.dispute.evidence, ...items] } }, items);
          await writes.saveProject(next);
          return next;
        });
        return json(res, 200, { project });
      }
      if (path === '/api/projects/extension') {
        // Freelancer asks; Client declines here or accepts by signing extendDeadline in the FESC panel.
        const project = await authenticatedWrite(async (writes, current) => {
          const latest = await writes.getProjectForActor(body.projectId, current);
          if (!isParty(latest, current) || latest.currency !== 'FESC' || latest.fesc?.policyVersion !== 2 ||
              !['Funded', 'In progress', 'Revision requested', 'Submitted'].includes(latest.status)) {
            throw new WorkflowError(409, 'Dự án chưa thể gia hạn.');
          }
          if (body.action === 'decline') {
            if (current.id !== latest.ownerId || !latest.extensionRequest) throw new WorkflowError(409, 'Không có yêu cầu gia hạn để từ chối.');
            const next = { ...latest, extensionRequest: undefined,
              extensionHistory: [...(latest.extensionHistory ?? []), { ...latest.extensionRequest, result: 'declined', at: new Date().toISOString() }] };
            await writes.saveProject(next);
            return next;
          }
          if (body.action !== 'request' || current.id !== latest.freelancerId) throw new WorkflowError(400, 'Yêu cầu gia hạn không hợp lệ.');
          const whole = body.whole === true;
          const milestone = whole ? latest.milestones.at(-1) : latest.milestones.find(item => item.id === body.milestoneId);
          const due = dueSeconds(body.dueDate);
          const reason = typeof body.note === 'string' ? body.note.trim() : '';
          if (!milestone || ['Paid', 'Refunded'].includes(milestone.status) || !Number.isFinite(due) ||
              due * 1000 <= Date.parse(milestone.dueAt) || reason.length < 3 || reason.length > 1000) {
            throw new WorkflowError(400, 'Chọn giai đoạn còn mở, ngày mới sau hạn hiện tại và nhập lý do (3–1000 ký tự).');
          }
          const next = { ...latest, extensionRequest: { id: randomUUID(), whole, milestoneId: milestone.id, dueDate: body.dueDate,
            dueAt: new Date(due * 1000).toISOString(), note: reason, at: new Date().toISOString() } };
          await writes.saveProject(next);
          return next;
        });
        return json(res, 200, { project });
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
          if (project.currency !== 'FESC') throw new WorkflowError(409, 'Dự án mô phỏng MOCK không còn được hỗ trợ.');
          if (!['assign', 'submit'].includes(body.action)) throw new WorkflowError(400, 'Thao tác FESC cần thực hiện từ mục Ký quỹ FESC trong dự án.');
          if (body.action !== 'assign') {
            if (!canSeePrivate(project, current)) throw new WorkflowError(403, 'Bạn không có quyền thực hiện thao tác này.');
            if (!delivery) throw new WorkflowError(409, 'Thao tác FESC cần thực hiện từ mục Ký quỹ FESC trong dự án.');
            if ((await projectFesc(root, writes, project, current)).step !== 'upload') {
              throw new WorkflowError(409, 'Milestone FESC chưa sẵn sàng nhận bàn giao.');
            }
            project = await writes.getProject(body.projectId);
          }
          // Money moves only through verified FESC transactions; here only assignment and delivery files are stored.
          const result = applyProjectAction(project, current, body, freelancer, delivery?.metadata);
          if (delivery) {
            const latest = result.project.milestones.find(item => item.id === body.milestoneId).deliveries.at(-1);
            for (const [kind, file] of Object.entries(delivery.files)) {
              if (file) await writes.saveDeliveryFile(latest.id, kind, file);
            }
          }
          await writes.saveProject(result.project);
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
