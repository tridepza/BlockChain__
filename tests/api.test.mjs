import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createServer as createViteServer, preview, resolveConfig } from 'vite';
import { createPublicClient, createWalletClient, http, keccak256, parseUnits, toHex } from 'viem';
import { hardhat } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { createApi } from '../server/api.mjs';
import { WorkflowError } from '../src/workflow.ts';
import { publicProjectPayments } from '../server/public-projects.mjs';
import { assertStorageTarget } from '../server/storage-target.mjs';

const password = 'mật-khẩu-test-2026';
const client = { name: 'Tên trùng', email: 'owner@example.test', password, role: 'Client' };
const outsider = { ...client, email: 'other@example.test' };
const worker = { name: 'Freelancer test', email: 'worker@example.test', password, role: 'Freelancer' };
const input = {
  title: 'Kiểm thử dự án', category: 'Web Development', description: 'Dữ liệu thử nghiệm',
  budget: '0.30', milestones: 'Một, Hai', amounts: '0.10, 0.20',
};

let lastTestClock = Date.now();
async function listen(filename, root, options = {}) {
  const mail = [];
  let clock = lastTestClock += 3_600_000;
  const api = createApi(filename, root, { sendOtp: async message => { mail.push(message); }, now: () => clock, ...options });
  const server = createServer((req, res) => api.middleware(req, res, () => res.writeHead(404).end()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const baseURL = origin + '/api/';
  async function request(path, { data, cookie, headers } = {}) {
    const response = await fetch(baseURL + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie'), body: await response.json() };
  }
  return {
    origin,
    mail,
    advance: milliseconds => { clock += milliseconds; },
    rawRequest: request,
    close: async () => {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await api.close();
    },
    async request(path, input = {}) {
      if (['auth/register', 'auth/login'].includes(path)) clock += 61_000;
      const result = await request(path, input);
      if (!['auth/register', 'auth/login'].includes(path) || result.status !== 202) return result;
      const code = mail.findLast(message => message.email === result.body.email && message.purpose === result.body.purpose).code;
      return request('auth/verify', { data: { challengeId: result.body.challengeId, code },
        cookie: [input.cookie, result.cookie.split(';')[0]].filter(Boolean).join('; '), headers: input.headers });
    },
  };
}

test('FESC project pays two confirmed deliveries to the linked Freelancer wallet', {
  skip: process.env.ESCROW_TEST_FESC !== '1' && 'Run with a local Hardhat node and ESCROW_TEST_FESC=1',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'escrow-fesc-test-'));
  const metadata = join(root, '.hardhat');
  const manifest = join(metadata, 'local-fesc-deployment.json');
  const app = await listen(':memory:', root);
  t.after(async () => {
    await app.close();
    await unlink(manifest).catch(() => {});
    await rmdir(metadata).catch(() => {});
    await rmdir(root);
  });
  const transport = http('http://127.0.0.1:8545', { timeout: 3000, retryCount: 0 });
  const rpc = createPublicClient({ chain: hardhat, transport });
  assert.equal(await rpc.getChainId(), 31337);
  assert.match(await rpc.request({ method: 'web3_clientVersion' }), /hardhat/i);
  const testWallet = addressIndex => createWalletClient({ chain: hardhat, transport,
    account: mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex }) });
  const owner = testWallet(16), freelancer = testWallet(17), arbitrator = testWallet(18);
  const artifact = path => readFile('.hardhat/artifacts/contracts/' + path + '.json', 'utf8').then(JSON.parse);
  const coin = await artifact('FreelanceToken.sol/FreelanceToken');
  const factory = await artifact('Escrow.sol/EscrowFactory');
  const confirm = async hash => {
    const receipt = await rpc.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt;
  };
  const deploy = (artifact, args) => owner.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args }).then(confirm);
  const tokenReceipt = await deploy(coin, [[owner.account.address]]);
  const token = tokenReceipt.contractAddress;
  const instanceKey = keccak256(toHex(root));
  const factoryReceipt = await deploy(factory, [token, instanceKey]);
  await mkdir(metadata);
  await writeFile(manifest, JSON.stringify({
    chainId: 31337, projectPayments: 1, instanceKey, token, tokenCodeHash: keccak256(await rpc.getCode({ address: token })),
    factory: factoryReceipt.contractAddress, factoryCodeHash: keccak256(await rpc.getCode({ address: factoryReceipt.contractAddress })),
    startBlock: factoryReceipt.blockNumber.toString(), startBlockHash: factoryReceipt.blockHash,
    accounts: { arbitrator: arbitrator.account.address },
  }));
  async function post(path, data, cookie, status = 200) {
    const result = await app.request(path, { data, cookie, headers: { Origin: app.origin } });
    assert.equal(result.status, status, `${path} ${data.action ?? ''}: ${JSON.stringify(result.body)}`);
    return result;
  }
  async function login(account, wallet) {
    await post('auth/register', account, undefined, 201);
    const login = await post('auth/login', account);
    const cookie = login.cookie.split(';')[0];
    if (wallet) {
      const { body } = await post('wallet/challenges', { address: wallet.account.address, chainId: 31337 }, cookie, 201);
      const signature = await wallet.signMessage({ message: body.message });
      await post('wallet/verify', { challengeId: body.challengeId, signature }, cookie);
    }
    return cookie;
  }
  const clientCookie = await login(client, owner);
  const freelancerCookie = await login(worker, freelancer);
  const outsiderCookie = await login(outsider);
  const { body: { project } } = await post('projects', { ...input, currency: 'FESC' }, clientCookie, 201);
  const projectId = project.id;
  const state = cookie => post('projects/fesc', { projectId }, cookie).then(result => result.body);
  const action = (action, cookie, data = {}, status = 200) => post('projects/fesc', { projectId, action, ...data }, cookie, status);
  async function execute(step, cookie, wallet, data) {
    const { body: tx } = await action(step, cookie, data);
    assert.equal(tx.from.toLowerCase(), wallet.account.address.toLowerCase());
    return confirm(await wallet.sendTransaction({ to: tx.to, data: tx.data }));
  }
  await post('projects/action', { projectId, action: 'assign', email: worker.email }, clientCookie);
  await post('projects/fesc', { projectId }, outsiderCookie, 404);
  await post('projects/action', { projectId, action: 'fund' }, clientCookie, 409);
  await execute('create', clientCookie, owner);
  const { escrow } = await state(clientCookie);
  assert.equal((await state(freelancerCookie)).step, 'accept');
  await execute('accept', freelancerCookie, freelancer);
  await execute('allow', clientCookie, owner);
  const funding = await execute('fund', clientCookie, owner);
  const fundingQuery = 'explorer/transfers?q=' + funding.transactionHash;
  const publicFunding = await app.request(fundingQuery);
  assert.equal(publicFunding.status, 200);
  assert.deepEqual(await app.request(fundingQuery, { cookie: outsiderCookie }), publicFunding);
  const [deposit] = publicFunding.body.transfers;
  assert.deepEqual(Object.keys(deposit).sort(), ['amount', 'block', 'from', 'hash', 'logIndex', 'time', 'to']);
  assert.equal(deposit.from.toLowerCase(), owner.account.address.toLowerCase());
  assert.equal(deposit.to.toLowerCase(), escrow.toLowerCase());
  assert.equal(deposit.amount, '0.3');
  const publicProject = (await app.request('explorer/projects')).body.payments;
  assert.deepEqual(publicProject, [{ projectId, stage: 'Ký quỹ', amount: '0.3', currency: 'FESC', from: owner.account.address,
    to: escrow }]);
  assert.deepEqual(Object.keys(publicProject[0]).sort(), ['amount', 'currency', 'from', 'projectId', 'stage', 'to']);
  assert.equal((await state(clientCookie)).held, '0.3');
  assert.equal((await state(clientCookie)).balance, '999.7');
  await execute('start', freelancerCookie, freelancer);

  for (const [milestoneId, total] of [[1, '0.1'], [2, '0.3']]) {
    assert.equal((await state(freelancerCookie)).step, 'upload');
    const { body } = await post('projects/delivery', { projectId, action: 'submit', milestoneId, note: 'Bản bàn giao',
      preview: { name: 'preview.pdf', data: Buffer.from('%PDF-test preview').toString('base64') },
      original: { name: 'original.txt', data: Buffer.from('original data').toString('base64') },
    }, freelancerCookie);
    const delivery = body.projects[0].milestones[milestoneId - 1].deliveries[0];
    const original = `projects/${projectId}/milestones/${milestoneId}/deliveries/${delivery.id}/original`;
    assert.equal((await app.request(original, { cookie: clientCookie })).status, 403);
    const review = { milestoneId, submissionVersion: 1 };
    await action('approve', clientCookie, review, 409);
    await execute('submit', freelancerCookie, freelancer, review);
    assert.equal((await state(clientCookie)).step, 'approve');
    await action('approve', freelancerCookie, review, 409);
    await action('approve', clientCookie, { ...review, submissionVersion: 0 }, 409);
    await action('approve', clientCookie, { ...review, milestoneId: 3 - milestoneId }, 409);
    await execute('approve', clientCookie, owner, review);
    await Promise.all([state(clientCookie), state(freelancerCookie)]);
    assert.equal((await state(freelancerCookie)).balance, total);
    const response = await fetch(`${app.origin}/api/${original}`, { headers: { Cookie: clientCookie } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'original data');
  }

  assert.equal((await state(clientCookie)).step, 'complete');
  assert.equal((await state(clientCookie)).held, '0');
  const { body: workspace } = await app.request('workspace', { cookie: freelancerCookie });
  assert.equal(workspace.projects[0].paid, 0.3);
  assert.deepEqual(workspace.txs.map(tx => tx.currency), ['FESC', 'FESC', 'FESC']);
  assert.equal(workspace.mockWallet.cents, 0);
  assert.equal((await post('wallet/fesc-balance', {}, freelancerCookie)).body.balance, '0.3');
  assert.equal(await rpc.readContract({ address: token, abi: coin.abi, functionName: 'balanceOf', args: [escrow] }), 0n);
  assert.equal(await rpc.readContract({ address: token, abi: coin.abi, functionName: 'balanceOf', args: [freelancer.account.address] }), parseUnits('0.3', 18));
  const phases = (await app.request('explorer/projects')).body.payments;
  assert.deepEqual(phases.map(row => [row.stage, row.amount]), [['Ký quỹ', '0.3'], ['Milestone 1', '0.1'], ['Milestone 2', '0.2']]);

  const outgoing = await confirm(await freelancer.writeContract({ address: token, abi: coin.abi,
    functionName: 'transfer', args: [owner.account.address, 1n] }));
  const walletQuery = 'explorer/transfers?q=' + freelancer.account.address;
  const publicWallet = (await app.request(walletQuery)).body;
  const [direct, ...payouts] = publicWallet.transfers;
  assert.equal(direct.hash, outgoing.transactionHash);
  assert.equal(direct.from.toLowerCase(), freelancer.account.address.toLowerCase());
  assert.equal(direct.to.toLowerCase(), owner.account.address.toLowerCase());
  assert.equal(direct.amount, '0.000000000000000001');
  assert.deepEqual(payouts.map(row => row.amount), ['0.2', '0.1']);
  assert.ok(payouts.every(row => row.from.toLowerCase() === escrow.toLowerCase() &&
    row.to.toLowerCase() === freelancer.account.address.toLowerCase()));
  assert.deepEqual((await app.request('explorer/transfers?q=0x' + '0'.repeat(64))).body.transfers, []);
  assert.equal((await app.request('explorer/transfers?q=khong-hop-le')).status, 400);

  for (let index = 0; index < 18; index++) {
    await confirm(await owner.writeContract({ address: token, abi: coin.abi,
      functionName: 'transfer', args: [freelancer.account.address, 1n] }));
  }
  const firstPage = (await app.request('explorer/transfers')).body;
  assert.equal(firstPage.transfers.length, 20);
  assert.ok(firstPage.next);
  const secondPage = (await app.request('explorer/transfers?before=' + encodeURIComponent(firstPage.next))).body;
  assert.equal(secondPage.transfers.length, 2);
  assert.equal(secondPage.next, null);
  assert.equal(new Set([...firstPage.transfers, ...secondPage.transfers].map(row => row.hash)).size, 22);
});

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
  assert.equal(duplicates.filter(result => result.status === 201).length, 1);
  assert.ok(duplicates.some(result => [409, 429].includes(result.status)));
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
  const noFunds = await action(owner, 'fund');
  assert.equal(noFunds.status, 409);
  assert.match(noFunds.body.error, /Số dư MOCK không đủ/);
  assert.equal((await req('workspace', { cookie: owner })).body.projects[0].funded, 0);
  const claim = cookie => req('wallet/mock-claim', { data: { cents: 99_000_000 }, cookie });
  assert.equal((await claim(freelancer)).status, 403);
  const claimed = await Promise.all([claim(owner), claim(owner)]);
  assert.deepEqual(claimed.map(result => result.status).sort(), [200, 409]);
  assert.equal(claimed.find(result => result.status === 200).body.mockWallet.cents, 100_000);
  const funding = await Promise.all([action(owner, 'fund'), action(owner, 'fund')]);
  assert.deepEqual(funding.map(result => result.status).sort(), [200, 409]);
  assert.equal(funding.find(result => result.status === 200).body.mockWallet.cents, 99_970);
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
  assert.equal(cancelled.body.mockWallet.cents, 99_990);
  assert.equal((await req('workspace', { cookie: freelancer })).body.mockWallet.cents, 10);
  assert.deepEqual(cancelled.body.txs.map(tx => tx.amount), [0.2, 0.1, 0.3]);
  assert.ok(cancelled.body.txs.every(tx => tx.status === 'Mô phỏng' && tx.id.startsWith('DEMO-')));
  assert.deepEqual((await req('workspace', { cookie: other })).body, {
    projects: [], txs: [], mockWallet: { cents: 0, claimed: false },
  });

  const projects = [];
  for (const title of ['Ký quỹ A', 'Ký quỹ B']) {
    const result = await req('projects', { cookie: owner, data: { ...input, title, budget: '600', amounts: '300,300' } });
    assert.equal(result.status, 201);
    const id = result.body.project.id;
    assert.equal((await action(owner, 'assign', { projectId: id, email: worker.email })).status, 200);
    projects.push(id);
  }
  const simultaneous = await Promise.all(projects.map(id => action(owner, 'fund', { projectId: id })));
  assert.deepEqual(simultaneous.map(result => result.status).sort(), [200, 409]);
  assert.equal((await req('workspace', { cookie: owner })).body.mockWallet.cents, 39_990);
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
    'backup.db-wal', 'backup.sqlite3', '.env.postgres.local', '.env.mongo.local', '.env.mail.local',
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

test('OTP bắt buộc trước khi tạo tài khoản và đăng nhập, chỉ dùng một lần và ràng buộc trình duyệt', async t => {
  const app = await listen(':memory:'); t.after(app.close);
  const req = app.rawRequest;
  for (const weak of ['abcdefghijkl', '1234567890!!', 'abcdefghij12', 'abcdefghij!!', 'ABCDEF1234!!']) {
    assert.equal((await req('auth/register', { data: { ...client, password: weak } })).status, 400);
  }
  const start = await req('auth/register', { data: client });
  assert.equal(start.status, 202);
  assert.equal(start.body.code, undefined);
  assert.equal(start.body.user, undefined);
  assert.equal(app.mail[0].email, client.email);
  const binding = start.cookie.split(';')[0];
  const verification = { challengeId: start.body.challengeId, code: app.mail[0].code };
  assert.equal((await req('auth/login', { data: client })).status, 401);
  assert.equal((await req('auth/me', { cookie: binding })).status, 401);
  assert.equal((await req('auth/verify', { data: verification })).status, 400);
  assert.equal((await req('auth/verify', { data: verification, cookie: binding })).status, 201);
  assert.equal((await req('auth/verify', { data: verification, cookie: binding })).status, 400);
  const login = await req('auth/login', { data: client });
  assert.equal(login.status, 202);
  assert.equal(login.cookie.includes('escrow_session='), false);
  const cookie = login.cookie.split(';')[0];
  const data = { challengeId: login.body.challengeId, code: app.mail.at(-1).code };
  const wrong = data.code === '000000' ? '111111' : '000000';
  assert.equal((await req('auth/verify', { data: { ...data, code: wrong }, cookie })).status, 400);
  const verified = await req('auth/verify', { data, cookie });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.user.email, client.email);
  assert.equal((await req('auth/me', { cookie: verified.cookie.split(';')[0] })).status, 200);
  assert.equal((await req('auth/verify', { data, cookie })).status, 400);
});

test('OTP hết hạn, giới hạn thử sai, gửi lại và lưu qua khởi động lại', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'escrow-otp-'));
  const file = join(dir, 'otp.sqlite');
  let now = Date.now();
  let app = await listen(file, undefined, { now: () => now });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true }); });
  let start = await app.rawRequest('auth/register', { data: client });
  let binding = start.cookie.split(';')[0];
  const first = { challengeId: start.body.challengeId, code: app.mail[0].code };
  assert.equal((await app.rawRequest('auth/resend', { data: first, cookie: binding })).status, 429);
  now += 61_000;
  const resent = await app.rawRequest('auth/resend', { data: first, cookie: binding });
  assert.equal(resent.status, 202);
  assert.equal((await app.rawRequest('auth/verify', { data: first, cookie: binding })).status, 400);
  const fresh = { challengeId: resent.body.challengeId, code: app.mail.at(-1).code };
  const db = new DatabaseSync(file, { readOnly: true });
  const stored = db.prepare('SELECT data FROM auth_challenges').get().data;
  assert.equal(JSON.parse(stored).code, undefined);
  assert.equal(JSON.parse(stored).hash === fresh.code, false);
  assert.equal(db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
  db.close();
  await app.close();
  app = await listen(file, undefined, { now: () => now });
  assert.equal((await app.rawRequest('auth/verify', { data: fresh, cookie: binding })).status, 201);
  start = await app.rawRequest('auth/login', { data: client });
  binding = start.cookie.split(';')[0];
  const data = { challengeId: start.body.challengeId, code: app.mail.at(-1).code };
  const wrong = data.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await app.rawRequest('auth/verify', { data: { ...data, code: wrong }, cookie: binding })).status, 400);
  await app.close();
  app = await listen(file, undefined, { now: () => now });
  assert.equal((await app.rawRequest('auth/verify', { data, cookie: binding })).status, 400);
  now += 61_000;
  const next = await app.rawRequest('auth/resend', { data, cookie: binding });
  assert.equal(next.status, 202);
  now += 5 * 60_000 + 1;
  assert.equal((await app.rawRequest('auth/verify', { data: { challengeId: next.body.challengeId, code: app.mail.at(-1).code }, cookie: binding })).status, 400);
});

test('SMTP lỗi không tạo tài khoản hoặc cấp phiên đăng nhập', async t => {
  const app = await listen(':memory:', undefined, { sendOtp: async () => { throw new WorkflowError(503, 'SMTP unavailable'); } });
  t.after(app.close);
  assert.equal((await app.rawRequest('auth/register', { data: client })).status, 503);
  assert.equal((await app.rawRequest('auth/login', { data: client })).status, 401);
  assert.equal((await app.rawRequest('auth/me')).status, 401);
});

test('dự án và giao dịch giữ nguyên khi qua ngày và mở lại database', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'escrow-persist-'));
  const file = join(dir, 'projects.sqlite');
  let app = await listen(file);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true }); });
  await app.request('auth/register', { data: client });
  const login = await app.request('auth/login', { data: client });
  const cookie = login.cookie.split(';')[0];
  const created = await app.request('projects', { data: input, cookie });
  assert.equal(created.status, 201);
  const id = created.body.project.id;
  const db = new DatabaseSync(file);
  const project = JSON.parse(db.prepare('SELECT data FROM projects WHERE id = ?').get(id).data);
  project.created = '2020-01-01';
  db.prepare('UPDATE projects SET data = ? WHERE id = ?').run(JSON.stringify(project), id);
  db.close();
  const before = (await app.request('workspace', { cookie })).body;
  await app.close();
  app = await listen(file);
  const after = (await app.request('workspace', { cookie })).body;
  assert.deepEqual(after, before);
  assert.equal(after.projects[0].id, id);
  assertStorageTarget({ driver: 'sqlite' }, { driver: 'sqlite' });
  assert.throws(() => assertStorageTarget({ driver: 'mongodb', database: 'saved' }, { driver: 'sqlite' }), /Không tự chuyển/);
});

test('công khai theo giai đoạn chỉ có ID dự án, khối lượng và địa chỉ ví', async () => {
  const from = '0x1000000000000000000000000000000000000001';
  const to = '0x2000000000000000000000000000000000000002';
  const store = { readWorkspace: async () => ({ projects: [{ id: 9, title: 'private title', description: 'private brief', fesc: {} }],
    txs: [{ id: '0x' + 'a'.repeat(64), currency: 'FESC', projectId: 9, project: 'private title',
      publicPayment: { stage: 'Milestone 2', from, to, amount: '40' }, email: 'secret@example.test' },
    { id: 'DEMO-123', currency: 'MOCK', projectId: 9, publicPayment: { from, to } }] }) };
  const result = await publicProjectPayments(store, {});
  assert.deepEqual(result, { payments: [{ projectId: 9, stage: 'Milestone 2', from, to, amount: '40', currency: 'FESC' }] });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal((await publicProjectPayments(store, {}, 'not-a-wallet')).payments.length, 0);
  assert.equal((await publicProjectPayments(store, {}, from)).payments.length, 1);
});

test('giới hạn OTP theo email vẫn có hiệu lực sau nhiều lần gửi lại', async t => {
  const app = await listen(':memory:'); t.after(app.close);
  let start = await app.rawRequest('auth/register', { data: client });
  const cookie = start.cookie.split(';')[0];
  for (let i = 1; i < 10; i++) {
    app.advance(61_000);
    start = await app.rawRequest('auth/resend', { data: { challengeId: start.body.challengeId }, cookie });
    assert.equal(start.status, 202);
  }
  app.advance(61_000);
  assert.equal((await app.rawRequest('auth/resend', { data: { challengeId: start.body.challengeId }, cookie })).status, 429);
  assert.equal(app.mail.length, 10);
});
