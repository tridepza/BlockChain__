import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, parseUnits, stringToHex } from 'viem';
import { hardhat } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { createApi } from '../server/api.mjs';
import { dueSeconds } from '../server/project-fesc.mjs';
import { startDurableHardhatNode } from '../scripts/hardhat-node.mjs';

const day = 86400;
const vnDate = seconds => new Date((Number(seconds) + 7 * 3600) * 1000).toISOString().slice(0, 10);

test('policy 2 FESC project: agreed deadlines, extensions, evidence complaints, 50/50 continue and termination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'escrow-policy2-'));
  let node, service, server, db;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    db?.close(); await service?.close(); await node?.close(); await rm(root, { recursive: true });
  });
  node = await startDurableHardhatNode({ port: 0, state: join(root, 'chain.json') });
  const actualFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(String(input));
    return actualFetch(url.origin === 'http://127.0.0.1:8545' ? node.url + url.pathname + url.search : input, init);
  });
  const transport = http(node.url);
  const rpc = createPublicClient({ chain: hardhat, transport });
  const wallets = Object.fromEntries(['client', 'worker', 'admin'].map((id, addressIndex) => [id,
    createWalletClient({ chain: hardhat, transport, account: mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex }) })]));
  const artifact = async (file, name) => JSON.parse(await readFile(`.hardhat/artifacts/contracts/${file}.sol/${name}.json`, 'utf8'));
  const tokenArtifact = await artifact('FreelanceToken', 'FreelanceToken');
  const factoryArtifact = await artifact('Escrow', 'EscrowFactory');
  const confirm = hash => rpc.waitForTransactionReceipt({ hash });
  const token = (await confirm(await wallets.client.deployContract({ ...tokenArtifact, args: [[wallets.client.account.address]] }))).contractAddress;
  const instanceKey = keccak256(stringToHex(root));
  const factoryReceipt = await confirm(await wallets.client.deployContract({ abi: factoryArtifact.abi, bytecode: factoryArtifact.bytecode, args: [token, instanceKey] }));
  await mkdir(join(root, '.hardhat'));
  await writeFile(join(root, '.hardhat/local-fesc-deployment.json'), JSON.stringify({
    chainId: 31337, projectPayments: 1, escrowPolicy: 2, factoryRevision: 2, token, tokenCodeHash: keccak256(await rpc.getCode({ address: token })),
    instanceKey, factory: factoryReceipt.contractAddress, factoryCodeHash: keccak256(await rpc.getCode({ address: factoryReceipt.contractAddress })),
    startBlock: factoryReceipt.blockNumber.toString(), startBlockHash: factoryReceipt.blockHash,
    accounts: { arbitrator: wallets.admin.account.address },
  }));
  const filename = join(root, 'app.sqlite');
  const notices = [];
  service = createApi(filename, root, { adminEmails: 'admin@example.test', sendNotice: async message => { notices.push(message); } });
  db = new DatabaseSync(filename);
  const tokens = { client: 'a'.repeat(64), worker: 'b'.repeat(64), admin: 'c'.repeat(64) };
  for (const id of Object.keys(wallets)) {
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `${id}@example.test`, id === 'worker' ? 'Freelancer' : 'Client', Buffer.alloc(16), Buffer.alloc(64));
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(createHash('sha256').update(tokens[id]).digest('hex'), id, Date.now() + 3_600_000);
    db.prepare('INSERT INTO wallet_links VALUES (?, ?, ?)').run(id, wallets[id].account.address,
      JSON.stringify({ address: wallets[id].account.address, chainId: 31337 }));
  }
  const now = Number((await rpc.getBlock()).timestamp);
  const iso = date => new Date(dueSeconds(date) * 1000).toISOString();
  const project = { id: 1, title: 'Dated FESC project', description: 'Policy 2', category: 'Web Development',
    ownerId: 'client', freelancerId: 'worker', client: 'client', freelancer: 'worker', currency: 'FESC', budget: 0.3,
    funded: 0, paid: 0, status: 'Proposal sent', created: vnDate(now), dueAt: iso(vnDate(now + 20 * day)),
    milestones: [{ id: 1, title: 'First', amount: 0.1, status: 'Pending', dueAt: iso(vnDate(now + 5 * day)) },
      { id: 2, title: 'Next', amount: 0.2, status: 'Pending', dueAt: iso(vnDate(now + 20 * day)) }] };
  db.prepare('INSERT INTO projects VALUES (?, ?)').run(1, JSON.stringify(project));
  server = createServer((req, res) => service.middleware(req, res, () => res.writeHead(404).end()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path, id, data, expected = 200) {
    const response = await fetch(origin + '/api/' + path, { method: data ? 'POST' : 'GET',
      headers: { Cookie: `escrow_session=${tokens[id]}`, ...(data ? { 'Content-Type': 'application/json', Origin: origin } : {}) },
      body: data ? JSON.stringify(data) : undefined });
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body)); return body;
  }
  async function upload(id, name, bytes) {
    const response = await fetch(`${origin}/api/projects/evidence?projectId=1&name=${encodeURIComponent(name)}`, { method: 'POST',
      headers: { Cookie: `escrow_session=${tokens[id]}`, Origin: origin, 'Content-Type': 'application/octet-stream' }, body: bytes });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body)); return body.evidence;
  }
  const state = id => request('projects/fesc', id, { projectId: 1 });
  const stored = () => JSON.parse(db.prepare('SELECT data FROM projects WHERE id = 1').get().data);
  async function execute(action, id, extra = {}) {
    const tx = await request('projects/fesc', id, { projectId: 1, action, ...extra });
    const receipt = await confirm(await wallets[id].sendTransaction({ to: tx.to, data: tx.data }));
    assert.equal(receipt.status, 'success');
    return receipt;
  }
  async function travel(seconds) {
    await rpc.request({ method: 'evm_increaseTime', params: [seconds] });
    await rpc.request({ method: 'evm_mine', params: [] });
  }

  // The first due date must leave 48h funding + 7 days to start; before the contract exists it is rescheduled off chain.
  let status = await state('client');
  assert.equal(status.policyVersion, 2);
  assert.equal(status.step, 'waiting');
  assert.equal(status.canExtend, true);
  assert.deepEqual(await request('projects/fesc', 'client', { projectId: 1, action: 'extend', milestoneId: 1, dueDate: vnDate(now + 11 * day) }), { updated: true });
  assert.equal(stored().milestones[0].dueAt, iso(vnDate(now + 11 * day)));
  assert.equal((await state('client')).step, 'create');
  await execute('create', 'client'); await execute('accept', 'worker');
  await execute('allow', 'client'); await execute('fund', 'client');
  await execute('start', 'worker');

  // Freelancer asks for more time; the Client accepts by signing the on-chain extension.
  const later = vnDate(now + 13 * day);
  await request('projects/extension', 'client', { projectId: 1, action: 'request', milestoneId: 1, dueDate: later, note: 'Need more time' }, 400);
  await request('projects/extension', 'worker', { projectId: 1, action: 'request', milestoneId: 1, dueDate: vnDate(now + 2 * day), note: 'Too early' }, 400);
  await request('projects/extension', 'worker', { projectId: 1, action: 'request', milestoneId: 1, dueDate: later, note: 'Need more time' });
  assert.equal(stored().extensionRequest.dueDate, later);
  await request('projects/fesc', 'worker', { projectId: 1, action: 'extend', milestoneId: 1, dueDate: later }, 409);
  await execute('extend', 'client', { milestoneId: 1, dueDate: later });
  status = await state('worker');
  assert.equal(stored().milestones[0].dueAt, iso(later));
  assert.equal(status.deadline, iso(later));
  assert.equal(stored().extensionRequest, undefined);

  // Delivery, then the 5-day review window: the Freelancer may complain only after it passes.
  await request('projects/delivery', 'worker', { projectId: 1, action: 'submit', milestoneId: 1, note: 'Delivered',
    preview: { name: 'preview.pdf', data: Buffer.from('%PDF-test').toString('base64') } });
  const submitted = await execute('submit', 'worker', { milestoneId: 1, submissionVersion: 1 });
  const submittedAt = Number((await rpc.getBlock({ blockNumber: submitted.blockNumber })).timestamp);
  status = await state('worker');
  assert.equal(status.deadline, new Date((submittedAt + 5 * day) * 1000).toISOString());
  assert.deepEqual(status.disputeOptions.map(option => [option.kind, option.available]), [[1, false], [4, true]]);
  await travel(5 * day + 60);
  status = await state('worker');
  assert.equal(status.disputeOptions[0].available, true);
  const log = await upload('worker', 'chat-log.txt', Buffer.from('Client did not reply for 5 days'));
  await execute('dispute', 'worker', { milestoneId: 1, reason: 1, note: 'Client did not review in time', evidenceIds: [log.id] });
  let info = await request('admin/case?projectId=1', 'admin');
  assert.equal(info.project.dispute.by, 'Freelancer');
  assert.equal(info.project.dispute.label, 'Client quá hạn nghiệm thu (5 ngày)');
  assert.deepEqual(info.chain.modes, ['continue', 'terminate']);

  // Admin splits the disputed milestone 50/50 and the contract continues with milestone 2.
  await request('admin/case', 'admin', { projectId: 1, action: 'review', revision: 0, note: 'Đã xem nhật ký trao đổi' });
  assert.equal(stored().adminReview.history[0].note, 'Đã xem nhật ký trao đổi');
  const split = { projectId: 1, action: 'split', mode: 'continue', revision: 1, note: 'Both parties share the delay', evidenceCount: '0' };
  const { transaction } = await request('admin/case', 'admin', split);
  const splitReceipt = await confirm(await wallets.admin.sendTransaction({ to: transaction.to, data: transaction.data }));
  const resumed = await request('admin/case', 'admin', { ...split, hash: splitReceipt.transactionHash });
  assert.equal(resumed.emailed, 'sent');
  assert.equal(resumed.project.status, 'In progress');
  assert.deepEqual(resumed.project.milestones[0].arbitration, { decision: 'split', mode: 'continue', toFreelancer: 0.05, toClient: 0.05, paidOut: true });
  assert.equal(resumed.project.milestones[1].status, 'In progress');
  assert.equal(resumed.project.paid, 0.05);
  assert.equal(notices.length, 2);
  assert.match(notices[0].text, /Chia đều 50\/50/);
  assert.match(notices[0].text, /tiếp tục giai đoạn tiếp theo/);
  assert.match(notices[0].text, /chuyển thẳng về ví/);
  status = await state('worker');
  assert.equal(status.step, 'upload');
  // The decision itself transferred both halves; nothing waits to be withdrawn.
  assert.equal(status.claimable, '0');
  await request('projects/fesc', 'worker', { projectId: 1, action: 'withdraw' }, 409);
  assert.equal(await rpc.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [wallets.worker.account.address] }), parseUnits('0.05', 18));

  // Client complains for another reason and asks admin to end the contract.
  status = await state('client');
  assert.deepEqual(status.disputeOptions.map(option => [option.kind, option.available]), [[0, false], [2, false], [4, true]]);
  await execute('dispute', 'client', { milestoneId: 2, reason: 4, note: 'Freelancer stopped responding', links: ['https://example.com/thread'] });
  info = await request('admin/case?projectId=1', 'admin');
  assert.equal(info.project.dispute.kind, 4);
  assert.equal(info.project.disputeHistory.length, 1);
  const refund = { projectId: 1, action: 'refund', mode: 'terminate', revision: 2, note: 'Refund the unfinished work', evidenceCount: '0' };
  const second = await request('admin/case', 'admin', refund);
  const refundReceipt = await confirm(await wallets.admin.sendTransaction({ to: second.transaction.to, data: second.transaction.data }));
  const closed = await request('admin/case', 'admin', { ...refund, hash: refundReceipt.transactionHash });
  assert.equal(closed.project.status, 'Completed');
  assert.equal(closed.project.milestones[1].status, 'Refunded');
  assert.equal(closed.project.disputeHistory.length, 2);
  assert.equal(notices.length, 4);
  const escrowAbi = parseAbi(['function claimable(address beneficiary) view returns (uint256)']);
  assert.equal(await rpc.readContract({ address: info.chain.escrow, abi: escrowAbi, functionName: 'claimable', args: [wallets.client.account.address] }), 0n);
  // Client paid 0.3 into escrow and got back 0.05 (split) + 0.2 (terminated milestone) directly.
  assert.equal(await rpc.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [wallets.client.account.address] }), parseUnits('999.95', 18));
  assert.equal((await state('client')).step, 'complete');
  assert.equal(closed.project.milestones[1].arbitration.paidOut, true);

  // Resending the result email records the delivery outcome.
  const decisionAt = closed.project.adminReview.history.at(-1).at;
  notices.length = 0;
  const resent = await request('admin/case', 'admin', { projectId: 1, action: 'email', at: decisionAt });
  assert.equal(resent.emailed, 'sent');
  assert.equal(notices.length, 2);

  const accounts = await request('admin/accounts', 'admin');
  assert.equal(accounts.total, 3);
  assert.equal(accounts.linked, 3);
  assert.equal(accounts.active, 2);
  assert.equal(accounts.accounts.find(account => account.id === 'worker').balance, '0.05');
  await request('admin/accounts', 'client', undefined, 403);
  const history = await request('admin/transactions?q=ph%C3%A2n%20x%E1%BB%AD', 'admin');
  assert.equal(history.total, 2);
  assert.ok(history.transactions.every(tx => tx.currency === 'FESC'));
});
