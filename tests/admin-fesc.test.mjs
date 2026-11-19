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
import { startDurableHardhatNode } from '../scripts/hardhat-node.mjs';

test('admin FESC dispute requires arbitrator receipt, rejects stale evidence and preserves claims and period volumes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'escrow-admin-fesc-'));
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
  const artifact = async name => JSON.parse(await readFile(`.hardhat/artifacts/contracts/${name}.sol/${name}.json`, 'utf8'));
  const tokenArtifact = await artifact('FreelanceToken');
  const factoryArtifact = await artifact('EscrowFactory').catch(() => readFile('.hardhat/artifacts/contracts/Escrow.sol/EscrowFactory.json', 'utf8').then(JSON.parse));
  const confirm = hash => rpc.waitForTransactionReceipt({ hash });
  const tokenReceipt = await confirm(await wallets.client.deployContract({ ...tokenArtifact, bytecode: tokenArtifact.bytecode, args: [[wallets.client.account.address]] }));
  const token = tokenReceipt.contractAddress;
  const instanceKey = keccak256(stringToHex(root));
  const factoryReceipt = await confirm(await wallets.client.deployContract({ abi: factoryArtifact.abi, bytecode: factoryArtifact.bytecode, args: [token, instanceKey] }));
  await mkdir(join(root, '.hardhat'));
  await writeFile(join(root, '.hardhat/local-fesc-deployment.json'), JSON.stringify({
    chainId: 31337, projectPayments: 1, token, tokenCodeHash: keccak256(await rpc.getCode({ address: token })),
    instanceKey, factory: factoryReceipt.contractAddress, factoryCodeHash: keccak256(await rpc.getCode({ address: factoryReceipt.contractAddress })),
    startBlock: factoryReceipt.blockNumber.toString(), startBlockHash: factoryReceipt.blockHash,
    accounts: { arbitrator: wallets.admin.account.address },
  }));
  const filename = join(root, 'app.sqlite');
  const notices = [];
  // Exercise the MetaMask fallback: the server does not sign for the arbitrator here.
  service = createApi(filename, root, { adminEmails: 'admin@example.test', serverArbitrator: false, sendNotice: async message => { notices.push(message); } });
  db = new DatabaseSync(filename);
  const tokens = { client: 'a'.repeat(64), worker: 'b'.repeat(64), admin: 'c'.repeat(64) };
  for (const id of Object.keys(wallets)) {
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `${id}@example.test`, id === 'worker' ? 'Freelancer' : 'Client', Buffer.alloc(16), Buffer.alloc(64));
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(createHash('sha256').update(tokens[id]).digest('hex'), id, Date.now() + 600000);
    db.prepare('INSERT INTO wallet_links VALUES (?, ?, ?)').run(id, wallets[id].account.address,
      JSON.stringify({ address: wallets[id].account.address, chainId: 31337 }));
  }
  const project = { id: 1, title: 'Disputed FESC project', description: 'Delivery test', category: 'Web Development',
    ownerId: 'client', freelancerId: 'worker', client: 'client', freelancer: 'worker', currency: 'FESC', budget: 0.3,
    funded: 0, paid: 0, status: 'Proposal sent', created: '2026-11-18',
    milestones: [{ id: 1, title: 'First', amount: 0.1, status: 'Pending' }, { id: 2, title: 'Next', amount: 0.2, status: 'Pending' }] };
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
  const state = id => request('projects/fesc', id, { projectId: 1 });
  async function upload(id, name, bytes, expected = 201) {
    const response = await fetch(`${origin}/api/projects/evidence?projectId=1&name=${encodeURIComponent(name)}`, { method: 'POST',
      headers: { Cookie: `escrow_session=${tokens[id]}`, Origin: origin, 'Content-Type': 'application/octet-stream' }, body: bytes });
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body)); return body.evidence;
  }
  async function execute(action, id, extra = {}) {
    const tx = await request('projects/fesc', id, { projectId: 1, action, ...extra });
    return confirm(await wallets[id].sendTransaction({ to: tx.to, data: tx.data }));
  }
  await execute('create', 'client'); await execute('accept', 'worker');
  await execute('allow', 'client'); const funding = await execute('fund', 'client');
  await execute('start', 'worker');
  await request('projects/delivery', 'worker', { projectId: 1, action: 'submit', milestoneId: 1, note: 'Delivered first milestone',
    preview: { name: 'preview.pdf', data: Buffer.from('%PDF-test').toString('base64') } });
  await execute('submit', 'worker', { milestoneId: 1, submissionVersion: 1 });
  assert.equal((await state('client')).canDispute, true);
  const complaint = { milestoneId: 1, reason: 0, note: 'The delivery needs arbitration' };
  await request('projects/fesc', 'client', { projectId: 1, action: 'dispute', ...complaint }, 400);
  await request('projects/fesc', 'client', { projectId: 1, action: 'dispute', ...complaint, reason: 2, links: ['https://example.com/a'] }, 409);
  await upload('client', 'fake.png', Buffer.from('not a png'), 400);
  await upload('client', 'notes.exe', Buffer.from('MZ'), 400);
  const screenshot = await upload('client', 'screenshot.png', Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64)]));
  assert.equal(screenshot.sha256, createHash('sha256').update(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64)])).digest('hex'));
  const workerView = await fetch(`${origin}/api/projects/1/evidence/${screenshot.id}`, { headers: { Cookie: `escrow_session=${tokens.worker}` } });
  assert.equal(workerView.status, 404, 'unsubmitted evidence stays private to the uploader');
  await execute('dispute', 'client', { ...complaint, evidenceIds: [screenshot.id], links: ['https://example.com/spec'] });
  assert.equal((await state('client')).projectStatus, 'Disputed');
  const info = await request('admin/case?projectId=1', 'admin');
  assert.equal(info.project.disputeReason, 'The delivery needs arbitration');
  assert.equal(info.project.dispute.label, 'Bản bàn giao không đúng yêu cầu');
  assert.equal(info.project.dispute.by, 'Client');
  assert.deepEqual(info.project.dispute.evidence.map(item => item.kind).sort(), ['file', 'link']);
  assert.deepEqual(info.chain.modes, ['terminate']);
  assert.equal(info.chain.serverSigner, false);
  const evidenceUrl = `${origin}/api/admin/projects/1/evidence/${screenshot.id}`;
  assert.equal((await fetch(evidenceUrl, { headers: { Cookie: `escrow_session=${tokens.client}` } })).status, 403);
  const shown = await fetch(evidenceUrl + '?inline=1', { headers: { Cookie: `escrow_session=${tokens.admin}` } });
  assert.equal(shown.status, 200);
  assert.match(shown.headers.get('content-disposition'), /^inline/);
  assert.equal((await fetch(`${origin}/api/projects/1/evidence/${screenshot.id}`, { headers: { Cookie: `escrow_session=${tokens.worker}` } })).status, 200);
  const delivery = info.project.milestones[0].deliveries[0];
  const previewUrl = origin + `/api/admin/projects/1/milestones/1/deliveries/${delivery.id}/preview`;
  assert.equal((await fetch(previewUrl)).status, 401);
  assert.equal((await fetch(previewUrl, { headers: { Cookie: `escrow_session=${tokens.client}` } })).status, 403);
  const preview = await fetch(previewUrl, { headers: { Cookie: `escrow_session=${tokens.admin}` } });
  assert.equal(preview.status, 200);
  assert.equal(await preview.text(), '%PDF-test');
  const escrow = info.chain.escrow;
  const abi = parseAbi(['function claimable(address beneficiary) view returns (uint256)']);
  const decision = { projectId: 1, action: 'release', revision: 0, note: 'First milestone accepted; future milestones refunded', evidenceCount: '0' };
  await request('admin/case', 'client', decision, 403);

  // On-chain evidence invalidates a decision prepared before the new information was signed.
  const stale = await request('admin/case', 'admin', decision);
  const pendingEvidence = await request('projects/dispute-evidence', 'worker', { projectId: 1, action: 'prepare',
    note: 'New detail from the Freelancer', links: ['https://example.com/detail'] });
  await request('projects/dispute-evidence', 'admin', { projectId: 1, action: 'prepare', links: ['https://example.com/detail'] }, 404);
  const beforeEvidence = await request('admin/case?projectId=1', 'admin');
  assert.equal(beforeEvidence.project.dispute.evidence.length, 2);
  assert.equal(beforeEvidence.project.fesc.supplementalEvidenceDrafts, undefined);
  const evidenceConfirmation = { projectId: 1, action: 'confirm', evidenceHash: pendingEvidence.evidenceHash };
  await request('projects/dispute-evidence', 'worker', { ...evidenceConfirmation, hash: funding.transactionHash }, 409);
  const evidenceReceipt = await confirm(await wallets.worker.sendTransaction({ to: pendingEvidence.transaction.to, data: pendingEvidence.transaction.data }));
  await assert.rejects(rpc.call({ to: stale.transaction.to, data: stale.transaction.data, account: wallets.admin.account.address }));
  // The admin opening the case can recover already-confirmed evidence even if the browser was closed after signing.
  const afterEvidence = await request('admin/case?projectId=1', 'admin');
  assert.equal(afterEvidence.chain.evidenceCount, '1');
  assert.equal(afterEvidence.project.dispute.evidence.length, 3);
  assert.equal(afterEvidence.project.dispute.evidence.find(item => item.added).note, 'New detail from the Freelancer');
  const confirmedEvidence = await request('projects/dispute-evidence', 'worker', { ...evidenceConfirmation, hash: evidenceReceipt.transactionHash });
  assert.equal(confirmedEvidence.confirmed, true);
  await request('admin/case', 'admin', decision, 409);
  decision.revision = afterEvidence.project.adminReview.revision;
  decision.evidenceCount = '1';
  const { transaction } = await request('admin/case', 'admin', decision);
  await assert.rejects(rpc.call({ to: transaction.to, data: transaction.data, account: wallets.client.account.address }));
  assert.equal(transaction.from.toLowerCase(), wallets.admin.account.address.toLowerCase());
  const resolution = await confirm(await wallets.admin.sendTransaction({ to: transaction.to, data: transaction.data }));
  await request('admin/case', 'admin', { ...decision, hash: funding.transactionHash }, 409);
  await request('admin/case', 'admin', { ...decision, note: 'Tampered decision', hash: resolution.transactionHash }, 409);
  // The participant sees the resolution even if the arbitrator never finished the website confirmation.
  const recovered = await state('worker');
  assert.equal(recovered.projectStatus, 'Completed');
  assert.equal(recovered.workspaceChanged, true);
  assert.equal(recovered.claimable, '0.1');
  assert.equal((await state('worker')).workspaceChanged, undefined);
  const completed = await request('admin/case', 'admin', { ...decision, hash: resolution.transactionHash });
  assert.equal(completed.project.adminReview.history.at(-1).hash, resolution.transactionHash);
  assert.equal(completed.project.paid, 0.1);
  assert.equal(completed.project.adminReview.history.at(-1).note, decision.note);
  assert.equal(completed.project.disputeHistory[0].evidence.length, 3);
  assert.equal(completed.project.adminReview.history.filter(item => item.hash === resolution.transactionHash).length, 1);
  assert.equal(completed.project.status, 'Completed');
  assert.equal(completed.emailed, 'sent');
  assert.equal(notices.length, 2);
  assert.match(notices[0].subject, /Kết quả phân xử dự án #1/);
  assert.match(notices[0].text, /Giải ngân 100% cho Freelancer/);
  await request('admin/case', 'admin', { ...decision, hash: resolution.transactionHash });
  assert.equal(notices.length, 2);
  assert.equal(await rpc.readContract({ address: escrow, abi, functionName: 'claimable', args: [wallets.worker.account.address] }), parseUnits('0.1', 18));
  assert.equal((await state('client')).step, 'withdraw');
  assert.equal((await state('worker')).step, 'withdraw');
  await execute('withdraw', 'client'); await execute('withdraw', 'worker');
  assert.equal((await state('worker')).step, 'complete');
  assert.equal(await rpc.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [wallets.worker.account.address] }), parseUnits('0.1', 18));
  const block = await rpc.getBlock();
  const date = new Date(Number(block.timestamp) * 1000 + 7 * 3600000).toISOString().slice(0, 10);
  for (const period of ['day', 'week', 'month', 'year']) {
    const overview = await request(`admin/overview?period=${period}&date=${date}`, 'admin');
    assert.equal(overview.fesc.available, true);
    assert.equal(overview.fesc.volume, '0.6');
    assert.equal(overview.fesc.transfers, 3);
    assert.equal(overview.fesc.totalSupply, '1000');
    assert.equal(overview.fesc.walletBalance, '0');
    assert.equal(overview.disputes.length, 0);
    assert.equal(overview.resolvedDisputes.length, 1);
    if (period === 'day') assert.deepEqual(overview.fesc.series, []);
    else {
      assert.equal(overview.fesc.series.length, overview.traffic.series.length);
      assert.equal(overview.fesc.series.reduce((sum, row) => sum + row.transfers, 0), 3);
      const key = period === 'year' ? date.slice(0, 7) : date;
      assert.equal(overview.fesc.series.find(row => row.key === key).volume, '0.6');
    }
  }
  const historical = await request('admin/overview?period=year&date=2000-01-01', 'admin');
  assert.equal(historical.fesc.volume, '0');
  assert.equal(historical.fesc.totalSupply, '1000');
});
