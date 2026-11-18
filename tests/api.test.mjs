import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createServer as createViteServer, preview, resolveConfig } from 'vite';
import { createPublicClient, createWalletClient, decodeFunctionData, encodeEventTopics, encodeFunctionData, encodeFunctionResult, http, keccak256, parseAbi, parseUnits, toHex, zeroAddress } from 'viem';
import { hardhat } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { createApi } from '../server/api.mjs';
import { WorkflowError } from '../src/workflow.ts';
import { publicProjectPayments } from '../server/public-projects.mjs';
import { assertStorageTarget } from '../server/storage-target.mjs';
import { integrityPlan } from '../server/integrity.mjs';
import { projectFesc } from '../server/project-fesc.mjs';

const password = 'mật-khẩu-test-2026';
const client = { name: 'Tên trùng', email: 'owner@example.test', password, role: 'Client' };
const outsider = { ...client, email: 'other@example.test' };
const worker = { name: 'Freelancer test', email: 'worker@example.test', password, role: 'Freelancer' };
// Due dates in Vietnam time; the first must be more than 9 days away.
const vnDay = days => new Date(Date.now() + days * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10);
const input = {
  title: 'Kiểm thử dự án', category: 'Web Development', description: 'Dữ liệu thử nghiệm',
  budget: '0.30', milestones: 'Một, Hai', amounts: '0.10, 0.20',
  milestoneDues: `${vnDay(20)},${vnDay(30)}`, projectDue: vnDay(30),
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
  assert.match(await rpc.request({ method: 'web3_clientVersion' }), /hardhat|anvil/i);
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
  const vaultReceipt = await deploy(await artifact('FescVault.sol/FescVault'), [token]);
  await mkdir(metadata);
  await writeFile(manifest, JSON.stringify({
    chainId: 31337, projectPayments: 1, instanceKey, token, tokenCodeHash: keccak256(await rpc.getCode({ address: token })),
    factory: factoryReceipt.contractAddress, factoryCodeHash: keccak256(await rpc.getCode({ address: factoryReceipt.contractAddress })),
    startBlock: factoryReceipt.blockNumber.toString(), startBlockHash: factoryReceipt.blockHash,
    accounts: { arbitrator: arbitrator.account.address },
    vault: vaultReceipt.contractAddress,
    vaultCodeHash: keccak256(await rpc.getCode({ address: vaultReceipt.contractAddress })),
    vaultStartBlock: String(vaultReceipt.blockNumber),
  }));
  const holders = async expected => {
    const result = await app.request('explorer/holders');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(Object.keys(result.body).sort(), ['chainId', 'holders', 'latestBlock', 'token', 'totalHolders', 'totalSupply']);
    assert.equal(result.body.token.toLowerCase(), token.toLowerCase());
    assert.equal(result.body.chainId, 31337);
    assert.equal(result.body.totalSupply, '1000');
    assert.equal(result.body.totalHolders, expected.length);
    assert.deepEqual(result.body.holders.map(row => [row.address.toLowerCase(), row.balance, row.kind]),
      expected.map(([address, balance, kind = 'wallet']) => [address.toLowerCase(), balance, kind]));
    assert.equal(result.body.holders.reduce((sum, row) => sum + parseUnits(row.balance, 18), 0n), parseUnits('1000', 18));
    result.body.holders.forEach((row, index) => {
      assert.deepEqual(Object.keys(row).sort(), ['address', 'balance', 'kind', 'rank']);
      assert.equal(row.rank, index + 1);
      assert.notEqual(row.address.toLowerCase(), zeroAddress);
    });
    return result.body;
  };
  // Token creation precedes the factory start block. Mint recipients still
  // belong in the holder table before any ordinary transfer has happened.
  const initialHolders = await holders([[owner.account.address, '1000']]);
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
  assert.deepEqual(Object.keys(publicFunding.body).sort(), ['chainId', 'latestBlock', 'next', 'token', 'transfers']);
  assert.equal(publicFunding.body.chainId, 31337);
  assert.ok(BigInt(publicFunding.body.latestBlock) >= funding.blockNumber);
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
  await holders([[owner.account.address, '999.7'], [escrow, '0.3', 'contract']]);
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
  const vaultOperations = [];
  async function vaultAction(action, amount) {
    const { body } = await post('wallet/fesc-account', { action, amount, address: owner.account.address }, freelancerCookie);
    assert.equal(body.from.toLowerCase(), freelancer.account.address.toLowerCase());
    const receipt = await confirm(await freelancer.sendTransaction({ to: body.to, data: body.data }));
    vaultOperations.push({ step: body.step, amount, receipt });
    return body.step;
  }
  assert.equal(await vaultAction('deposit', '0.1'), 'approve');
  assert.equal(await vaultAction('deposit', '0.1'), 'deposit');
  let vaultBalance = (await post('wallet/fesc-account', {}, freelancerCookie)).body;
  assert.equal(vaultBalance.accountBalance, '0.1');
  assert.equal(vaultBalance.walletBalance, '0.2');
  const depositedHolders = await holders([[owner.account.address, '999.7'],
    [freelancer.account.address, '0.2'], [vaultReceipt.contractAddress, '0.1', 'contract']]);
  await post('wallet/fesc-account', { action: 'withdraw', amount: '0.11' }, freelancerCookie, 409);
  await post('wallet/fesc-account', { action: 'withdraw', amount: '0.01' }, outsiderCookie, 409);
  assert.equal(await vaultAction('withdraw', '0.04'), 'withdraw');
  assert.equal(await vaultAction('withdraw', '0.06'), 'withdraw');
  vaultBalance = (await post('wallet/fesc-account', {}, freelancerCookie)).body;
  assert.equal(vaultBalance.accountBalance, '0');
  assert.equal(vaultBalance.walletBalance, '0.3');
  assert.equal(vaultBalance.history.length, 3);
  const withdrawnHolders = await holders([[owner.account.address, '999.7'], [freelancer.account.address, '0.3']]);
  const vaultAddress = vaultReceipt.contractAddress;
  const vaultHistory = (await app.request('explorer/transfers?q=' + vaultAddress)).body;
  assert.equal(vaultHistory.chainId, 31337);
  assert.deepEqual(vaultHistory.wallet, { address: vaultAddress.toLowerCase(), balance: '0', kind: 'contract' });
  assert.deepEqual(vaultHistory.transfers.map(row => [row.from.toLowerCase(), row.to.toLowerCase(), row.amount]), [
    [vaultAddress.toLowerCase(), freelancer.account.address.toLowerCase(), '0.06'],
    [vaultAddress.toLowerCase(), freelancer.account.address.toLowerCase(), '0.04'],
    [freelancer.account.address.toLowerCase(), vaultAddress.toLowerCase(), '0.1'],
  ]);
  for (const operation of vaultOperations) {
    const result = (await app.request('explorer/transfers?q=' + operation.receipt.transactionHash)).body;
    assert.equal(result.transfers.length, operation.step === 'approve' ? 0 : 1);
    if (operation.step !== 'approve') {
      assert.equal(result.transfers[0].hash, operation.receipt.transactionHash);
      assert.equal(result.transfers[0].amount, operation.amount);
    }
  }

  const outgoing = await confirm(await freelancer.writeContract({ address: token, abi: coin.abi,
    functionName: 'transfer', args: [owner.account.address, 1n] }));
  const walletQuery = 'explorer/transfers?q=' + freelancer.account.address;
  const publicWallet = (await app.request(walletQuery)).body;
  const [direct, ...walletMovements] = publicWallet.transfers;
  const payouts = walletMovements.filter(row => row.from.toLowerCase() === escrow.toLowerCase());
  assert.equal(direct.hash, outgoing.transactionHash);
  assert.equal(direct.from.toLowerCase(), freelancer.account.address.toLowerCase());
  assert.equal(direct.to.toLowerCase(), owner.account.address.toLowerCase());
  assert.equal(direct.amount, '0.000000000000000001');
  assert.equal(publicWallet.chainId, 31337);
  assert.deepEqual(publicWallet.wallet, { address: freelancer.account.address.toLowerCase(), balance: '0.299999999999999999', kind: 'wallet' });
  assert.ok(BigInt(publicWallet.latestBlock) >= outgoing.blockNumber);
  assert.deepEqual(payouts.map(row => row.amount), ['0.2', '0.1']);
  assert.ok(payouts.every(row => row.from.toLowerCase() === escrow.toLowerCase() &&
    row.to.toLowerCase() === freelancer.account.address.toLowerCase()));
  assert.deepEqual((await app.request('explorer/transfers?q=0x' + '0'.repeat(64))).body.transfers, []);
  assert.equal((await app.request('explorer/transfers?q=khong-hop-le')).status, 400);
  assert.deepEqual((await app.request('explorer/transfers?q=' + tokenReceipt.transactionHash)).body.transfers, [], 'mint is not a completed transfer between wallets');
  const outgoingCursor = `${instanceKey}:${outgoing.blockNumber}:${direct.logIndex}`;
  assert.deepEqual((await app.request(walletQuery + '&before=' + encodeURIComponent(outgoingCursor))).body.transfers
    .filter(row => row.hash === outgoing.transactionHash), []);
  assert.deepEqual((await app.request('explorer/transfers?q=' + outgoing.transactionHash + '&before=' + encodeURIComponent(outgoingCursor))).body.transfers, []);
  assert.equal((await app.request('explorer/transfers?before=invalid')).status, 400);
  assert.equal((await app.request('explorer/transfers?before=' + encodeURIComponent('0x' + 'a'.repeat(64) + ':1'))).status, 409);
  assert.equal((await app.request('explorer/transfers?before=' + encodeURIComponent(`${instanceKey}:${outgoing.blockNumber + 10000n}`))).status, 400);

  // An explicitly signed, mined revert must never appear in the explorer.
  const revertedRequest = await freelancer.prepareTransactionRequest({
    to: token, gas: 100_000n,
    data: encodeFunctionData({ abi: coin.abi, functionName: 'transfer', args: [owner.account.address, parseUnits('1000', 18)] }),
  });
  const revertedRaw = await freelancer.signTransaction(revertedRequest);
  const revertedHash = keccak256(revertedRaw);
  await freelancer.sendRawTransaction({ serializedTransaction: revertedRaw }).catch(() => {});
  assert.equal((await rpc.waitForTransactionReceipt({ hash: revertedHash })).status, 'reverted');
  assert.deepEqual((await app.request('explorer/transfers?q=' + revertedHash)).body.transfers, []);

  for (let index = 0; index < 18; index++) {
    await confirm(await owner.writeContract({ address: token, abi: coin.abi,
      functionName: 'transfer', args: [freelancer.account.address, 1n] }));
  }
  const firstPage = (await app.request('explorer/transfers')).body;
  assert.equal(firstPage.transfers.length, 20);
  assert.ok(firstPage.next);
  const secondPage = (await app.request('explorer/transfers?before=' + encodeURIComponent(firstPage.next))).body;
  assert.equal(secondPage.transfers.length, 5);
  assert.equal(secondPage.next, null);
  assert.equal(new Set([...firstPage.transfers, ...secondPage.transfers].map(row => row.hash)).size, 25);
  assert.equal(firstPage.chainId, 31337);
  assert.ok(BigInt(secondPage.latestBlock) >= BigInt(firstPage.latestBlock));
  for (const row of [...firstPage.transfers, ...secondPage.transfers]) {
    assert.deepEqual(Object.keys(row).sort(), ['amount', 'block', 'from', 'hash', 'logIndex', 'time', 'to']);
    const receipt = await rpc.getTransactionReceipt({ hash: row.hash });
    assert.equal(receipt.status, 'success');
    assert.equal((await rpc.getBlock({ blockNumber: BigInt(row.block) })).hash, receipt.blockHash);
  }
  const publicJson = JSON.stringify([firstPage, secondPage, vaultHistory, publicWallet, initialHolders, depositedHolders, withdrawnHolders]);
  for (const privateValue of [client.email, worker.email, outsider.email, input.title, input.description, 'original data']) {
    assert.equal(publicJson.includes(privateValue), false);
  }

  // A provider returning a stale log/receipt must not publish unverified history.
  const actualFetch = globalThis.fetch;
  let corrupt = '';
  const intercept = t.mock.method(globalThis, 'fetch', async (url, options) => {
    const response = await actualFetch(url, options);
    if (new URL(String(url)).origin !== 'http://127.0.0.1:8545') return response;
    const request = JSON.parse(options.body);
    const data = await response.json();
    if (request.method === 'eth_getTransactionReceipt' && request.params[0] === outgoing.transactionHash) {
      if (corrupt === 'pending') data.result = null;
      if (corrupt === 'reverted') data.result.status = '0x0';
      if (corrupt === 'removed') data.result.logs.forEach(log => { log.removed = true; });
      if (corrupt === 'receipt-log') data.result.logs = [];
    }
    if (corrupt === 'orphaned' && request.method === 'eth_getBlockByNumber' && BigInt(request.params[0]) === outgoing.blockNumber) {
      data.result.hash = '0x' + 'f'.repeat(64);
    }
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  });
  for (const failure of ['pending', 'reverted', 'removed', 'receipt-log', 'orphaned']) {
    corrupt = failure;
    const result = await app.request('explorer/transfers?q=' + outgoing.transactionHash);
    assert.equal(result.status, 200, failure);
    assert.deepEqual(result.body.transfers, [], failure);
  }
  // For the general log-list path, matching a receipt event is mandatory too.
  corrupt = 'receipt-log';
  assert.equal((await app.request(walletQuery)).body.transfers.some(row => row.hash === outgoing.transactionHash), false);
  intercept.mock.restore();
});

test('public FESC holders include initial mints, rank exact balances, and fail closed on incomplete RPC snapshots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'escrow-public-holders-'));
  await mkdir(join(root, '.hardhat'));
  const address = index => '0x' + BigInt(index).toString(16).padStart(40, '0');
  const token = address(1000), factory = address(1001), contract = address(106), emptied = address(107);
  const code = '0x6000';
  const head = 1005n;
  const blockHash = number => '0x' + BigInt(number).toString(16).padStart(64, '0');
  const deployment = { chainId: 31337, token, factory, instanceKey: '0x' + 'a'.repeat(64),
    startBlock: '5', startBlockHash: blockHash(5), tokenCodeHash: keccak256(code), factoryCodeHash: keccak256(code) };
  await writeFile(join(root, '.hardhat/local-fesc-deployment.json'), JSON.stringify(deployment));
  const app = await listen(':memory:', root);
  t.after(async () => { await app.close(); await rm(root, { recursive: true }); });
  const abi = parseAbi([
    'function instanceKey() view returns (bytes32)', 'function token() view returns (address)',
    'function balanceOf(address owner) view returns (uint256)', 'function totalSupply() view returns (uint256)',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ]);
  // Consecutive balances differ by one wei beyond Number's exact integer
  // range. Pairs tie, requiring a stable address order, and exceed top 100.
  const balances = new Map(Array.from({ length: 106 }, (_, index) => [address(index + 1),
    parseUnits('1', 18) + BigInt(Math.floor(index / 2))]));
  const supply = [...balances.values()].reduce((sum, balance) => sum + balance, 0n);
  const expected = [...balances].sort(([a, av], [b, bv]) => av === bv ? a.localeCompare(b) : av > bv ? -1 : 1);
  const logs = [...balances, [emptied, 1n]].map(([to, value], index) => ({
    address: token, blockNumber: '0x0', blockHash: blockHash(0), transactionHash: blockHash(index + 2000),
    transactionIndex: '0x0', logIndex: toHex(index), removed: false,
    topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from: zeroAddress, to } }), data: toHex(value, { size: 32 }),
  }));
  // This address was once a holder but has no current balance.
  logs.push({ ...logs.at(-1), blockNumber: '0x1', blockHash: blockHash(1), logIndex: '0x0',
    transactionHash: blockHash(3000), topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from: emptied, to: address(1) } }) });
  const calls = [];
  let mode = 'healthy';
  let walletHeadReads = 0;
  const actualFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(String(url)).origin !== 'http://127.0.0.1:8545') return actualFetch(url, options);
    const request = JSON.parse(options.body);
    calls.push(request);
    let result;
    if (request.method === 'eth_chainId') result = '0x7a69';
    else if (request.method === 'eth_blockNumber') result = toHex(head);
    else if (request.method === 'eth_getBlockByNumber') {
      const number = request.params[0] === 'latest' ? head : BigInt(request.params[0]);
      const walletReorg = mode === 'wallet-reorg' && number === head && ++walletHeadReads > 1;
      result = { number: toHex(number), hash: walletReorg || (mode === 'reorg' && request.params[0] !== 'latest' && number === head)
        ? blockHash(9999) : blockHash(number), timestamp: '0x64', transactions: [] };
    } else if (request.method === 'eth_getCode') {
      result = [token, factory, contract].includes(request.params[0].toLowerCase()) ? code : '0x';
    } else if (request.method === 'eth_getLogs') {
      if (mode === 'logs-offline') throw new Error('Simulated RPC log failure');
      const filter = request.params[0];
      assert.equal(filter.address.toLowerCase(), token);
      const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
      result = logs.filter(log => BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to &&
        (mode !== 'incomplete' || log.topics[2] !== '0x' + contract.slice(2).padStart(64, '0')) &&
        (!filter.topics?.[1] || filter.topics[1] === log.topics[1]) &&
        (!filter.topics?.[2] || filter.topics[2] === log.topics[2]));
    } else if (request.method === 'eth_call') {
      const { functionName, args } = decodeFunctionData({ abi, data: request.params[0].data });
      if (mode === 'balance-offline' && functionName === 'balanceOf') throw new Error('Simulated RPC balance failure');
      const value = { instanceKey: deployment.instanceKey, token,
        totalSupply: supply,
        balanceOf: args ? balances.get(args[0].toLowerCase()) ?? 0n : 0n }[functionName];
      if (value === undefined) throw new Error('Unexpected holder contract call: ' + functionName);
      result = encodeFunctionResult({ abi, functionName, result: value });
    } else throw new Error('Unexpected holder RPC call: ' + request.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
      { headers: { 'Content-Type': 'application/json' } });
  });
  const listing = await app.request('explorer/holders');
  assert.equal(listing.status, 200, JSON.stringify(listing.body));
  assert.deepEqual(Object.keys(listing.body).sort(), ['chainId', 'holders', 'latestBlock', 'token', 'totalHolders', 'totalSupply']);
  assert.equal(listing.body.totalSupply, '106.000000000000002756');
  assert.equal(listing.body.totalHolders, 106);
  assert.equal(listing.body.latestBlock, String(head));
  assert.equal(listing.body.holders.length, 100);
  assert.deepEqual(listing.body.holders.map(row => [row.rank, row.address, parseUnits(row.balance, 18), row.kind]),
    expected.slice(0, 100).map(([wallet, balance], index) => [index + 1, wallet, balance, wallet === contract ? 'contract' : 'wallet']));
  assert.equal(listing.body.holders.some(row => [zeroAddress, emptied].includes(row.address)), false);
  const scanned = calls.filter(call => call.method === 'eth_getLogs').map(call => call.params[0]);
  assert.ok(scanned.some(range => BigInt(range.fromBlock) === 0n), 'initial mints before factory deployment must be scanned');
  assert.ok(scanned.some(range => BigInt(range.toBlock) === head), 'all blocks through the snapshot must be scanned');
  for (const call of calls) {
    if (call.method === 'eth_call') {
      const { functionName } = decodeFunctionData({ abi, data: call.params[0].data });
      if (['balanceOf', 'totalSupply'].includes(functionName)) assert.equal(BigInt(call.params[1]), head);
    }
  }
  // Wallet details work even below the displayed top 100; they expose no rank
  // or application identity, and transfer-only lookups keep their old shape.
  const detail = await app.request('explorer/transfers?q=' + address(1));
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.deepEqual(detail.body.wallet, { address: address(1), balance: '1', kind: 'wallet' });
  assert.deepEqual(Object.keys(detail.body.wallet).sort(), ['address', 'balance', 'kind']);
  const emptyDetail = await app.request('explorer/transfers?q=' + emptied);
  assert.equal(emptyDetail.status, 200, JSON.stringify(emptyDetail.body));
  assert.deepEqual(emptyDetail.body.wallet, { address: emptied, balance: '0', kind: 'wallet' });
  const contractDetail = await app.request('explorer/transfers?q=' + contract);
  assert.equal(contractDetail.status, 200, JSON.stringify(contractDetail.body));
  assert.deepEqual(contractDetail.body.wallet, { address: contract, balance: '1.000000000000000052', kind: 'contract' });
  const unfiltered = await app.request('explorer/transfers');
  assert.equal(unfiltered.status, 200, JSON.stringify(unfiltered.body));
  assert.equal(unfiltered.body.wallet, undefined);
  for (const holder of listing.body.holders) assert.deepEqual(Object.keys(holder).sort(), ['address', 'balance', 'kind', 'rank']);
  for (const failure of ['logs-offline', 'balance-offline', 'incomplete', 'reorg']) {
    mode = failure;
    const failed = await app.request('explorer/holders');
    assert.equal(failed.status, 503, failure + ': ' + JSON.stringify(failed.body));
    assert.equal(failed.body.holders, undefined, failure);
    assert.equal(failed.body.totalSupply, undefined, failure);
  }
  mode = 'balance-offline';
  const failedWallet = await app.request('explorer/transfers?q=' + address(1));
  assert.equal(failedWallet.status, 503);
  assert.equal(failedWallet.body.wallet, undefined);
  mode = 'wallet-reorg';
  const changedWallet = await app.request('explorer/transfers?q=' + address(1));
  assert.equal(changedWallet.status, 503);
  assert.equal(changedWallet.body.wallet, undefined);
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

test('workspace xác minh vai trò, quyền sở hữu và chỉ nhận thao tác FESC hợp lệ', async t => {
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
  assert.equal((await req('projects', { data: { ...input, currency: 'MOCK' }, cookie: owner })).status, 400);
  assert.equal((await req('projects', { data: { ...input, milestoneDues: `${vnDay(3)},${vnDay(30)}` }, cookie: owner })).status, 400);
  const created = await req('projects', { data: input, cookie: owner });
  assert.equal(created.status, 201);
  assert.equal(created.body.project.currency, 'FESC');
  assert.equal(created.body.data.mockWallet, undefined);
  const projectId = created.body.project.id;
  const action = (cookie, action, fields) => req('projects/action', { cookie, data: { projectId, action, ...fields } });
  const publicList = (await req('projects/public')).body.projects;
  assert.equal(publicList.length, 1);
  assert.equal(publicList[0].currency, 'FESC');
  assert.equal(publicList[0].ownerId, undefined);
  assert.equal(publicList[0].milestones, undefined);
  assert.deepEqual((await req('workspace', { cookie: other })).body.projects, []);
  assert.equal((await action(other, 'assign', { email: worker.email, ownerId: created.body.project.ownerId })).status, 404);
  // Money only moves through FESC transactions, so the old MOCK actions are rejected.
  for (const name of ['fund', 'approve', 'revision', 'dispute', 'requestCancel', 'confirmCancel', 'release']) {
    assert.equal((await action(owner, name, { milestoneId: 1, note: 'x' })).status, 400, name);
  }
  assert.equal((await req('wallet/mock-claim', { data: {}, cookie: owner })).status, 404);
  assert.equal((await action(owner, 'assign', { email: outsider.email })).status, 400);
  assert.equal((await action(owner, 'assign', { email: worker.email })).status, 200);
  assert.equal((await action(owner, 'assign', { email: worker.email })).status, 409);
  assert.deepEqual((await req('projects/public')).body.projects, []);
  const assigned = (await req('workspace', { cookie: freelancer })).body.projects[0];
  assert.equal(assigned.freelancerId, (await req('auth/me', { cookie: freelancer })).body.user.id);
  assert.equal(assigned.funded, 0);
  // Delivery uploads wait for the funded FESC contract.
  assert.equal((await action(freelancer, 'submit', { milestoneId: 1, note: 'Bàn giao sớm' })).status, 409);
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

test('quên mật khẩu cần OTP, đổi mật khẩu một lần và thu hồi mọi phiên cũ', async t => {
  const app = await listen(':memory:'); t.after(app.close);
  await app.request('auth/register', { data: client });
  const login = await app.request('auth/login', { data: client });
  const cookie = login.cookie.split(';')[0];
  const request = app.rawRequest;
  const unknown = await request('auth/forgot', { data: { email: 'missing@example.test' } });
  assert.equal(unknown.status, 202);
  assert.equal(app.mail.filter(mail => mail.email === 'missing@example.test').length, 0);
  const start = await request('auth/forgot', { data: { email: client.email } });
  assert.equal(start.status, 202);
  const binding = start.cookie.split(';')[0];
  const data = { challengeId: start.body.challengeId, code: app.mail.at(-1).code };
  const newPassword = 'new-password-12345!';
  assert.equal((await request('auth/reset', { cookie: binding, data: { challengeId: data.challengeId, password: newPassword, confirm: newPassword } })).status, 400);
  const confirmed = await request('auth/verify', { cookie: binding, data });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.user, undefined);
  const reset = { challengeId: data.challengeId, resetToken: confirmed.body.resetToken, password: newPassword, confirm: newPassword };
  assert.equal((await request('auth/reset', { cookie: binding, data: { ...reset, confirm: 'not-matching' } })).status, 400);
  assert.equal((await request('auth/reset', { cookie: binding, data: { ...reset, resetToken: 'a'.repeat(64) } })).status, 400);
  assert.equal((await request('auth/reset', { cookie: binding, data: reset })).status, 200);
  assert.equal((await request('auth/reset', { cookie: binding, data: reset })).status, 400);
  assert.equal((await request('auth/me', { cookie })).status, 401);
  assert.equal((await request('auth/login', { data: client })).status, 401);
  assert.equal((await app.request('auth/login', { data: { ...client, password: newPassword } })).status, 200);
  assert.equal((await request('auth/forgot', { data: { email: { $ne: null } } })).status, 400);
});

test('dọn đúng dữ liệu mất liên kết, không xóa dự án chưa chọn Freelancer', () => {
  const snapshot = { users: [{ id: 'client', email: 'client@test' }, { id: 'worker', email: 'worker@test' }],
    projects: [
      { _id: 1, id: 1, ownerId: 'client', milestones: [] },
      { _id: 2, id: 2, ownerId: 'deleted-client', milestones: [] },
      { _id: 3, id: 3, ownerId: 'client', freelancerId: 'deleted-worker', milestones: [] },
      { _id: 4, id: 4, ownerId: 'client', freelancerId: 'worker', milestones: [{ deliveries: [{ id: 'd', original: {} }] }] },
    ], transactions: [{ _id: 't1', projectId: 1 }, { _id: 't2', projectId: 2 }],
    wallet_links: [{ _id: 'client' }, { _id: 'deleted-client' }],
    delivery_files: [{ _id: 'd:original' }, { _id: 'orphan:original' }],
  };
  const plan = integrityPlan(snapshot);
  assert.deepEqual(plan.remove.projects, [2, 3]);
  assert.deepEqual(plan.remove.transactions, ['t2']);
  assert.deepEqual(plan.remove.wallet_links, ['deleted-client']);
  assert.deepEqual(plan.remove.delivery_files, ['orphan:original']);
});

test('dự án FESC của chain cũ chỉ đọc lịch sử, không đổi dữ liệu hoặc gửi giao dịch trên chain mới', async t => {
  const root = await mkdtemp(join(tmpdir(), 'escrow-historical-'));
  const file = join(root, 'projects.sqlite');
  await mkdir(join(root, '.hardhat'));
  const token = '0x1000000000000000000000000000000000000001';
  const code = '0x6000';
  const current = {
    chainId: 31337, instanceKey: '0x' + '2'.repeat(64), token,
    factory: '0x2000000000000000000000000000000000000002',
    startBlock: '1', startBlockHash: '0x' + '3'.repeat(64),
    factoryCodeHash: keccak256(code), tokenCodeHash: keccak256(code),
  };
  await writeFile(join(root, '.hardhat/local-fesc-deployment.json'), JSON.stringify(current));
  const app = await listen(file, root);
  let fixture;
  t.after(async () => { fixture?.close(); await app.close(); await rm(root, { recursive: true }); });
  const actualFetch = globalThis.fetch;
  const abi = parseAbi(['function instanceKey() view returns (bytes32)', 'function token() view returns (address)']);
  let available = true;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(String(url)).origin !== 'http://127.0.0.1:8545') return actualFetch(url, options);
    if (!available) throw new Error('RPC offline');
    const request = JSON.parse(options.body);
    let result;
    if (request.method === 'eth_chainId') result = '0x7a69';
    else if (request.method === 'eth_getBlockByNumber') result = { hash: current.startBlockHash, number: '0x1', timestamp: '0x1', transactions: [] };
    else if (request.method === 'eth_getCode') result = code;
    else if (request.method === 'eth_call') {
      const name = request.params[0].data === '0xfc0c546a' ? 'token' : 'instanceKey';
      result = encodeFunctionResult({ abi, functionName: name, result: name === 'token' ? token : current.instanceKey });
    } else throw new Error('Unexpected historical RPC call: ' + request.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'Content-Type': 'application/json' } });
  });
  await app.request('auth/register', { data: client });
  const login = await app.request('auth/login', { data: client });
  const cookie = login.cookie.split(';')[0];
  const created = await app.request('projects', { data: { ...input, currency: 'FESC' }, cookie });
  assert.equal(created.status, 201);
  const id = created.body.project.id;
  const db = new DatabaseSync(file);
  fixture = db;
  const saved = JSON.parse(db.prepare('SELECT data FROM projects WHERE id = ?').get(id).data);
  saved.status = 'In progress'; saved.paid = 0.1; saved.freelancerId = 'historical-worker';
  saved.fesc = { deployment: { ...current, instanceKey: '0x' + '1'.repeat(64) } };
  db.prepare('UPDATE projects SET data = ? WHERE id = ?').run(JSON.stringify(saved), id);
  const request = body => app.request('projects/fesc', { cookie, data: { projectId: id, ...body }, headers: { Origin: app.origin } });
  const historical = await request();
  assert.equal(historical.status, 200, JSON.stringify(historical.body));
  assert.equal(historical.body.step, 'unavailable');
  assert.equal(historical.body.historical, true);
  assert.equal(historical.body.paid, saved.paid);
  assert.equal(historical.body.balance, undefined);
  assert.equal(historical.body.held, undefined);
  assert.match(historical.body.message, /không thể xác minh/);
  for (const action of ['create', 'accept', 'reset', 'allow', 'fund', 'start', 'submit', 'approve']) {
    assert.equal((await request({ action })).status, 409);
  }
  await writeFile(join(root, '.hardhat/local-fesc-deployment.json'), JSON.stringify({ ...current, factoryCodeHash: '0x' + '0'.repeat(64) }));
  assert.equal((await request()).status, 503);
  await writeFile(join(root, '.hardhat/local-fesc-deployment.json'), JSON.stringify(current));
  available = false;
  const offline = await request();
  assert.equal(offline.status, 503);
  assert.equal(offline.body.historical, undefined);
  assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM projects WHERE id = ?').get(id).data), saved);
  available = true;
  const active = { ...saved, fesc: { deployment: current } };
  db.prepare('UPDATE projects SET data = ? WHERE id = ?').run(JSON.stringify(active), id);
  const linked = await request();
  assert.equal(linked.status, 200);
  assert.equal(linked.body.step, 'link');
  assert.equal(linked.body.historical, undefined);
});

test('FESC keeps a verified pinned deployment usable after another deployment on the same chain', async t => {
  const root = await mkdtemp(join(tmpdir(), 'escrow-same-chain-redeploy-'));
  t.after(() => rm(root, { recursive: true }));
  await mkdir(join(root, '.hardhat'));
  const code = '0x6000';
  const pinned = {
    chainId: 31337, projectPayments: 1, instanceKey: '0x' + '1'.repeat(64),
    token: '0x1000000000000000000000000000000000000001',
    factory: '0x2000000000000000000000000000000000000002',
    startBlock: '1', startBlockHash: '0x' + '3'.repeat(64),
    factoryCodeHash: keccak256(code), tokenCodeHash: keccak256(code),
    accounts: { arbitrator: '0x3000000000000000000000000000000000000003' },
  };
  const current = { ...pinned, instanceKey: '0x' + '2'.repeat(64),
    token: '0x4000000000000000000000000000000000000004',
    factory: '0x5000000000000000000000000000000000000005',
    startBlock: '2', startBlockHash: '0x' + '4'.repeat(64) };
  await writeFile(join(root, '.hardhat/local-fesc-deployment.json'), JSON.stringify(current));
  const abi = parseAbi([
    'struct Terms { bytes32 projectRef; bytes32 agreementRef; uint64 createBy; address freelancer; address arbitrator; uint256 budgetUnits; uint256[] amounts; uint64[] baseDues; uint32 policyVersion; bytes32 documentHash; }',
    'function instanceKey() view returns (bytes32)',
    'function token() view returns (address)',
    'function balanceOf(address owner) view returns (uint256)',
    'function escrowFor(address client, bytes32 agreementRef) view returns (address)',
    'function hashTerms(address client, Terms terms) view returns (bytes32)',
    'function createEscrow(Terms terms, bytes32 expectedTermsHash) returns (address)',
  ]);
  const termsHash = '0x' + '6'.repeat(64);
  const reads = [];
  const actualFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(String(url)).origin !== 'http://127.0.0.1:8545') return actualFetch(url, options);
    const request = JSON.parse(options.body);
    let result;
    if (request.method === 'eth_chainId') result = '0x7a69';
    else if (request.method === 'eth_getBlockByNumber') {
      const first = request.params[0] === '0x1';
      result = { hash: first ? pinned.startBlockHash : current.startBlockHash,
        number: first ? '0x1' : '0x2', timestamp: '0x64', transactions: [] };
    } else if (request.method === 'eth_getCode') result = code;
    else if (request.method === 'eth_getBalance') result = '0xde0b6b3a7640000';
    else if (request.method === 'eth_call') {
      const { to, data } = request.params[0];
      reads.push(to.toLowerCase());
      const deployment = to.toLowerCase() === current.factory ? current : pinned;
      const { functionName } = decodeFunctionData({ abi, data });
      const results = { token: deployment.token, instanceKey: deployment.instanceKey,
        balanceOf: parseUnits('100', 18), hashTerms: termsHash,
        escrowFor: '0x0000000000000000000000000000000000000000',
        createEscrow: '0x6000000000000000000000000000000000000006' };
      if (!(functionName in results)) throw new Error('Unexpected redeployment contract call');
      result = encodeFunctionResult({ abi, functionName, result: results[functionName] });
    } else throw new Error('Unexpected redeployment RPC call: ' + request.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
      { headers: { 'Content-Type': 'application/json' } });
  });
  const clientAddress = '0x7000000000000000000000000000000000000007';
  const freelancerAddress = '0x8000000000000000000000000000000000000008';
  const project = {
    id: 1, ownerId: 'client', freelancerId: 'freelancer', currency: 'FESC', status: 'Open', paid: 0,
    title: 'Pinned project', category: 'Web Development', description: 'Keep the original contracts', budget: 100,
    milestones: [{ id: 1, title: 'Delivery', amount: 100, status: 'Pending' }],
    fesc: { deployment: pinned, client: clientAddress, freelancer: freelancerAddress, createBy: '1000' },
  };
  const before = structuredClone(project);
  const writes = { getWalletLink: async id => ({ chainId: 31337,
    address: id === 'client' ? clientAddress : freelancerAddress }) };
  const actor = { id: 'client', role: 'Client' };
  const status = await projectFesc(root, writes, project, actor);
  assert.equal(status.step, 'create');
  assert.equal(status.historical, undefined);
  assert.equal(status.token, pinned.token);
  const transaction = await projectFesc(root, writes, project, actor, { action: 'create' });
  assert.equal(transaction.to, pinned.factory);
  assert.equal(transaction.from, clientAddress);
  assert.equal(transaction.deploymentBlockHash, pinned.startBlockHash);
  assert.ok(reads.includes(pinned.factory));
  assert.deepEqual(project, before);
});

test('OTP gửi lại lỗi SMTP vẫn giữ yêu cầu cũ để thử lại, không gia hạn mã hay xóa giới hạn gửi', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'escrow-otp-retry-'));
  const file = join(dir, 'otp.sqlite');
  let now = Date.now(), fail = false, calls = 0;
  const delivered = [];
  const app = await listen(file, undefined, { now: () => now, sendOtp: async message => {
    calls++;
    if (fail) throw new WorkflowError(503, 'Simulated SMTP failure');
    delivered.push(message);
  } });
  const db = new DatabaseSync(file, { readOnly: true });
  t.after(async () => { db.close(); await app.close(); await rm(dir, { recursive: true }); });
  const row = () => JSON.parse(db.prepare('SELECT data FROM auth_challenges').get().data);
  const start = await app.rawRequest('auth/register', { data: client });
  assert.equal(start.status, 202);
  const cookie = start.cookie.split(';')[0];
  const original = { challengeId: start.body.challengeId, code: delivered[0].code };
  const wrong = original.code === '000000' ? '111111' : '000000';
  assert.equal((await app.rawRequest('auth/verify', { data: { ...original, code: wrong }, cookie })).status, 400);
  const before = row();
  assert.equal(before.attempts, 1);
  now += 61_000; fail = true;
  assert.equal((await app.rawRequest('auth/resend', { data: original, cookie })).status, 503);
  const restored = row();
  for (const field of ['id', 'hash', 'salt', 'binding', 'expires', 'attempts', 'windowStart']) assert.equal(restored[field], before[field]);
  assert.equal(restored.ready, true);
  assert.equal(restored.sent, 2);
  assert.equal(restored.resendAt, now + 60_000);
  assert.equal(db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM sessions').get().count, 0);
  assert.equal((await app.rawRequest('auth/me', { cookie })).status, 401);
  fail = false;
  assert.equal((await app.rawRequest('auth/resend', { data: original, cookie })).status, 429);
  assert.equal(calls, 2);
  now += 61_000;
  const resent = await app.rawRequest('auth/resend', { data: original, cookie });
  assert.equal(resent.status, 202);
  assert.notEqual(resent.body.challengeId, original.challengeId);
  assert.equal(row().sent, 3);
  assert.equal((await app.rawRequest('auth/verify', { data: original, cookie })).status, 400);
  assert.equal((await app.rawRequest('auth/verify', { data: { challengeId: resent.body.challengeId, code: delivered.at(-1).code }, cookie })).status, 201);
});

test('OTP hết hạn không sống lại khi SMTP lỗi nhưng yêu cầu cũ vẫn gửi lại được mã mới', async t => {
  let now = Date.now(), fail = false;
  const delivered = [];
  const app = await listen(':memory:', undefined, { now: () => now, sendOtp: async message => {
    if (fail) throw new WorkflowError(503, 'Simulated SMTP failure');
    delivered.push(message);
  } });
  t.after(app.close);
  const start = await app.rawRequest('auth/register', { data: client });
  const cookie = start.cookie.split(';')[0];
  const original = { challengeId: start.body.challengeId, code: delivered[0].code };
  now += 5 * 60_000 + 1; fail = true;
  assert.equal((await app.rawRequest('auth/resend', { data: original, cookie })).status, 503);
  assert.equal((await app.rawRequest('auth/verify', { data: original, cookie })).status, 400);
  now += 61_000; fail = false;
  const fresh = await app.rawRequest('auth/resend', { data: original, cookie });
  assert.equal(fresh.status, 202);
  assert.equal((await app.rawRequest('auth/verify', { data: { challengeId: fresh.body.challengeId, code: delivered.at(-1).code }, cookie })).status, 201);
});

test('OTP gửi chậm rồi lỗi không ghi đè yêu cầu mới từ trình duyệt khác', async t => {
  let now = Date.now(), calls = 0, release, markStarted;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const delivered = [];
  const app = await listen(':memory:', undefined, { now: () => now, sendOtp: async message => {
    if (++calls === 2) { markStarted(); await waiting; throw new WorkflowError(503, 'Simulated delayed SMTP failure'); }
    delivered.push(message);
  } });
  t.after(async () => { release(); await app.close(); });
  const first = await app.rawRequest('auth/register', { data: client });
  const firstCookie = first.cookie.split(';')[0];
  now += 61_000;
  const failed = app.rawRequest('auth/resend', { data: { challengeId: first.body.challengeId }, cookie: firstCookie });
  await started;
  now += 61_000;
  const newer = await app.rawRequest('auth/register', { data: client });
  assert.equal(newer.status, 202);
  const newerCookie = newer.cookie.split(';')[0];
  release();
  assert.equal((await failed).status, 503);
  assert.equal((await app.rawRequest('auth/verify', { data: { challengeId: newer.body.challengeId, code: delivered.at(-1).code }, cookie: firstCookie })).status, 400);
  assert.equal((await app.rawRequest('auth/verify', { data: { challengeId: newer.body.challengeId, code: delivered.at(-1).code }, cookie: newerCookie })).status, 201);
});

test('OTP gửi lần đầu lỗi SMTP vẫn giữ giới hạn gửi theo giờ', async t => {
  let now = Date.now(), calls = 0;
  const app = await listen(':memory:', undefined, { now: () => now, sendOtp: async () => {
    calls++; throw new WorkflowError(503, 'Simulated SMTP failure');
  } });
  t.after(app.close);
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await app.rawRequest('auth/register', { data: client })).status, 503);
    now += 61_000;
  }
  assert.equal((await app.rawRequest('auth/register', { data: client })).status, 429);
  assert.equal(calls, 10);
  assert.equal((await app.rawRequest('auth/login', { data: client })).status, 401);
  assert.equal((await app.rawRequest('auth/me')).status, 401);
});

test('quên mật khẩu gửi nền lỗi SMTP vẫn yêu cầu lại được và không tiết lộ email đã đăng ký', async t => {
  let now = Date.now(), failReset = false, resetAttempts = 0;
  const delivered = [];
  const app = await listen(':memory:', undefined, { now: () => now, sendOtp: async message => {
    if (message.purpose === 'reset') {
      resetAttempts++;
      if (failReset) throw new WorkflowError(503, 'Simulated reset SMTP failure');
    }
    delivered.push(message);
  } });
  t.after(app.close);
  const warning = t.mock.method(console, 'warn', () => {});
  const request = app.rawRequest;
  const registration = await request('auth/register', { data: client });
  assert.equal((await request('auth/verify', { cookie: registration.cookie.split(';')[0],
    data: { challengeId: registration.body.challengeId, code: delivered[0].code } })).status, 201);
  failReset = true;
  const failed = await request('auth/forgot', { data: { email: client.email } });
  const unknown = await request('auth/forgot', { data: { email: 'unregistered-reset@example.test' } });
  assert.equal(failed.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(Object.keys(unknown.body).sort(), Object.keys(failed.body).sort());
  assert.equal(failed.body.code, undefined);
  assert.equal(unknown.body.code, undefined);
  assert.equal((await request('auth/verify', { cookie: failed.cookie.split(';')[0],
    data: { challengeId: failed.body.challengeId, code: '000000' } })).status, 400);
  assert.equal(resetAttempts, 1);
  assert.equal(delivered.some(message => message.purpose === 'reset'), false);
  assert.equal(warning.mock.callCount(), 1);
  now += 61_000; failReset = false;
  const fresh = await request('auth/forgot', { data: { email: client.email } });
  assert.equal(fresh.status, 202);
  assert.notEqual(fresh.body.challengeId, failed.body.challengeId);
  const resetMail = delivered.findLast(message => message.purpose === 'reset');
  assert.equal(resetMail.email, client.email);
  assert.equal(resetAttempts, 2);
  const verified = await request('auth/verify', { cookie: fresh.cookie.split(';')[0],
    data: { challengeId: fresh.body.challengeId, code: resetMail.code } });
  assert.equal(verified.status, 200);
  assert.equal(typeof verified.body.resetToken, 'string');
  assert.equal(verified.body.user, undefined);
  assert.equal((await request('auth/me', { cookie: fresh.cookie.split(';')[0] })).status, 401);
});
