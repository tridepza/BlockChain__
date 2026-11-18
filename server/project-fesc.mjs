import {
  createPublicClient, encodeFunctionData, formatEther, formatUnits, http, isAddressEqual,
  keccak256, numberToHex, parseAbi, parseEventLogs, stringToHex, TransactionReceiptNotFoundError, zeroAddress,
} from 'viem';
import { hardhat } from 'viem/chains';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localChain } from '../src/local-chain.ts';
import { applyProjectAction, cents, currentMilestone, getSubmissionVersion, WorkflowError } from '../src/workflow.ts';
import { checkLocalDeployment } from './wallet.mjs';
import { evidenceFingerprint, markEvidenceUsed, pickEvidence } from './evidence.mjs';

const rpc = createPublicClient({ chain: hardhat, transport: http(localChain.rpcUrl, { timeout: 3500, retryCount: 0 }) });
const publicSync = new WeakMap();

export async function reconcilePublicProjects(root, store) {
  const previous = publicSync.get(store);
  if (previous && Date.now() - previous.at < 5000) return previous.pending;
  const pending = (async () => {
    const { projects } = await store.readWorkspace();
    for (const project of projects.filter(project => project.currency === 'FESC' && project.fesc && project.status !== 'Completed')) {
      try {
        await store.transaction(async writes => {
          const latest = await writes.getProject(project.id);
          if (latest) await projectFesc(root, writes, latest, { id: latest.ownerId, role: 'Client' });
        });
      } catch {
        // An unavailable historical local chain cannot erase persisted payment history.
      }
    }
  })();
  publicSync.set(store, { at: Date.now(), pending });
  return pending;
}
const day = 86400n;
const units = amount => BigInt(cents(amount)) * 10n ** 16n;
const hash = value => keccak256(stringToHex(JSON.stringify(value)));
const factoryAbi = parseAbi([
  'struct Terms { bytes32 projectRef; bytes32 agreementRef; uint64 createBy; address freelancer; address arbitrator; uint256 budgetUnits; uint256[] amounts; uint64[] baseDues; uint32 policyVersion; bytes32 documentHash; }',
  'function token() view returns (address)',
  'function escrowFor(address client, bytes32 agreementRef) view returns (address)',
  'function hashTerms(address client, Terms terms) view returns (bytes32)',
  'function createEscrow(Terms terms, bytes32 expectedTermsHash) returns (address)',
]);
const tokenAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const escrowAbi = parseAbi([
  'function termsHash() view returns (bytes32)',
  'function state() view returns (uint8)',
  'function current() view returns (uint256)',
  'function version() view returns (uint256)',
  'function funded() view returns (uint256)',
  'function milestones(uint256 index) view returns (uint256 amount, uint64 baseDeadline, uint64 deadline, uint8 stage, uint8 outcome, uint8 revisions, bytes32 submissionHash, uint256 toFreelancer)',
  'function accept(bytes32 expectedHash)',
  'function fund()',
  'function start()',
  'function submit(uint256 index, uint256 expectedVersion, bytes32 evidenceHash)',
  'function approveAndPayMilestone(uint256 index, uint256 expectedVersion)',
  'function openDispute(uint256 index, uint256 expectedVersion, uint8 reason, bytes32 reasonHash)',
  'function evidenceCount() view returns (uint256)',
  'function arbitrator() view returns (address)',
  'function claimable(address beneficiary) view returns (uint256)',
  'function withdraw()',
  'function resolve(uint256 toFreelancer, uint256 expectedEvidenceCount, bytes32 decisionHash)',
  'function resolveAndContinue(uint256 toFreelancer, uint256 expectedEvidenceCount, bytes32 decisionHash)',
  'function extendDeadline(uint256 index, uint64 newDeadline, bool wholeProject, uint256 expectedVersion)',
  'event DisputeOpened(uint256 indexed milestone, uint8 reason, bytes32 reasonHash, address indexed author)',
  'event DeadlineExtended(uint256 indexed milestone, bool wholeProject, uint64 newDeadline, uint64 delta)',
  'event Allocated(uint256 indexed milestone, uint8 outcome, uint256 toFreelancer, uint256 toClient)',
  'event Resolved(bytes32 decisionHash, uint256 evidenceCount)',
  'event Funded(uint256 amount)',
  'event MilestonePaid(uint256 indexed milestone, bytes32 evidenceHash, uint256 amount)',
]);

export const fescActions = ['create', 'accept', 'reset', 'allow', 'fund', 'start', 'submit', 'approve', 'dispute', 'withdraw', 'extend'];

const reviewTimeoutLabel = policy => `Client quá hạn nghiệm thu (${policy === 2 ? '5 ngày' : '3 ngày'})`;
export const disputeLabels = {
  0: 'Bản bàn giao không đúng yêu cầu', 1: 'Client quá hạn nghiệm thu', 2: 'Quá hạn thời gian dự án', 3: 'Bế tắc khi hủy hợp đồng', 4: 'Lý do khác',
};
const timeText = seconds => new Date(Number(seconds) * 1000).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const isoTime = seconds => new Date(Number(seconds) * 1000).toISOString();

// End of the chosen day in Vietnam time, as Unix seconds.
export function dueSeconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const utc = Date.parse(`${value}T23:59:59Z`);
  return Number.isFinite(utc) && new Date(utc).toISOString().startsWith(value) ? (utc - 7 * 3_600_000) / 1000 : NaN;
}

// Applies an extension to stored due dates exactly as Escrow.extendDeadline does on chain.
export function shiftDues(dues, index, newDeadline, whole, first = 0) {
  const next = dues.map(Number);
  if (whole) index = next.length - 1;
  const delta = newDeadline - next[index];
  if (whole) for (let i = first; i < next.length; i++) next[i] += delta;
  else {
    next[index] = newDeadline;
    for (let i = index + 1; i < next.length && next[i] <= next[i - 1]; i++) next[i] += delta;
  }
  return next;
}

function withDues(project, seconds) {
  const milestones = project.milestones.map((item, index) => ({ ...item, dueAt: isoTime(seconds[index]) }));
  return { ...project, milestones, dueAt: milestones.at(-1).dueAt };
}

// Admin authorization is enforced by the caller. Only the contract's immutable
// arbitrator may sign the returned transaction; this function never signs.
export async function adminFescCase(root, project, input = {}) {
  if (project.currency !== 'FESC' || !project.fesc) throw new WorkflowError(409, 'Dự án chưa có hợp đồng FESC.');
  const deployment = await readDeployment(root, project.fesc.deployment);
  const terms = buildTerms(project, project.fesc);
  const escrow = await rpc.readContract({ address: deployment.factory, abi: factoryAbi,
    functionName: 'escrowFor', args: [project.fesc.client, terms.agreementRef] });
  if (escrow === zeroAddress) throw new WorkflowError(409, 'Hợp đồng dự án chưa được tạo.');
  const read = (functionName, args = []) => rpc.readContract({ address: escrow, abi: escrowAbi, functionName, args });
  const expectedTerms = await rpc.readContract({ address: deployment.factory, abi: factoryAbi,
    functionName: 'hashTerms', args: [project.fesc.client, terms] });
  if (await read('termsHash') !== expectedTerms) throw new WorkflowError(409, 'Điều khoản FESC không khớp.');
  const [state, ordinal, evidenceCount, arbitrator] = await Promise.all([
    read('state'), read('current'), read('evidenceCount'), read('arbitrator'),
  ]);
  if (!isAddressEqual(arbitrator, deployment.accounts.arbitrator)) throw new WorkflowError(409, 'Ví trọng tài không khớp.');
  const policy = project.fesc.policyVersion ?? 1;
  const info = { escrow, arbitrator, state, evidenceCount: evidenceCount.toString(), current: Number(ordinal),
    modes: policy === 2 ? ['continue', 'terminate'] : ['terminate'] };
  if (!input.action) return info;
  const mode = input.mode ?? 'terminate';
  if (!['prepare', 'confirm'].includes(input.action) || !['release', 'split', 'refund'].includes(input.decision) ||
      !info.modes.includes(mode) ||
      typeof input.note !== 'string' || input.note.trim().length < 3 || input.note.length > 2000 ||
      !/^\d{1,20}$/.test(String(input.evidenceCount))) throw new WorkflowError(400, 'Quyết định trọng tài không hợp lệ.');
  const index = project.milestones.findIndex(m => !['Paid', 'Refunded'].includes(m.status));
  if (index < 0) throw new WorkflowError(409, 'Dự án đã được xử lý.');
  const whole = units(project.milestones[index].amount);
  const amount = input.decision === 'release' ? whole : input.decision === 'split' ? whole / 2n : 0n;
  // v1 decisions (release/refund + terminate) keep their original hash so pending transactions still verify.
  const decisionHash = input.decision !== 'split' && mode === 'terminate'
    ? hash(['admin-resolution', project.id, input.decision, input.note.trim()])
    : hash(['admin-resolution', project.id, input.decision, mode, input.note.trim()]);
  const call = { address: escrow, abi: escrowAbi, functionName: mode === 'continue' ? 'resolveAndContinue' : 'resolve',
    args: [amount, BigInt(input.evidenceCount), decisionHash] };
  const data = encodeFunctionData(call);
  if (input.action === 'prepare') {
    if (state !== 4 || ordinal !== BigInt(index) || evidenceCount !== BigInt(input.evidenceCount)) {
      throw new WorkflowError(409, 'Trạng thái hoặc bằng chứng đã đổi. Hãy mở lại hồ sơ.');
    }
    await rpc.simulateContract({ ...call, account: arbitrator });
    return { ...info, from: arbitrator, to: escrow, data,
      deploymentBlock: numberToHex(BigInt(deployment.startBlock)), deploymentBlockHash: deployment.startBlockHash };
  }
  if (typeof input.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(input.hash)) throw new WorkflowError(400, 'Mã giao dịch không hợp lệ.');
  const [receipt, tx] = await Promise.all([rpc.getTransactionReceipt({ hash: input.hash }), rpc.getTransaction({ hash: input.hash })]);
  const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
  const events = parseEventLogs({ abi: escrowAbi, strict: true,
    logs: receipt.logs.filter(log => isAddressEqual(log.address, escrow)) });
  const resolved = events.find(event => event.eventName === 'Resolved');
  const allocations = events.filter(event => event.eventName === 'Allocated');
  const last = index === project.milestones.length - 1;
  const allocated = mode === 'continue' ? 1 : project.milestones.length - index;
  const expectedState = mode === 'continue' && !last ? 3 : 5;
  if (receipt.status !== 'success' || receipt.blockHash !== block.hash || tx.blockHash !== block.hash ||
      !tx.to || !isAddressEqual(tx.to, escrow) || !isAddressEqual(tx.from, arbitrator) || tx.input !== data ||
      resolved?.args.decisionHash !== decisionHash || resolved.args.evidenceCount !== BigInt(input.evidenceCount) ||
      allocations.length !== allocated || state !== expectedState) {
    throw new WorkflowError(409, 'Chưa xác minh được quyết định trên đúng blockchain.');
  }
  for (let i = index; i < index + allocated; i++) {
    const event = allocations.find(event => event.args.milestone === BigInt(i));
    const share = i === index ? amount : 0n;
    if (!event || event.args.toFreelancer !== share || event.args.toClient !== units(project.milestones[i].amount) - share) {
      throw new WorkflowError(409, 'Phân bổ FESC không khớp với quyết định.');
    }
  }
  const toFreelancer = Number(formatUnits(amount, 18));
  const arbitration = { decision: input.decision, mode, toFreelancer, toClient: Number(formatUnits(whole - amount, 18)) };
  const milestones = project.milestones.map((m, i) => {
    if (i < index) return m;
    if (i === index) return { ...m, status: amount > 0n ? 'Paid' : 'Refunded', arbitration };
    if (mode === 'terminate') return { ...m, status: 'Refunded' };
    return i === index + 1 ? { ...m, status: 'In progress' } : m;
  });
  const history = [...(project.disputeHistory ?? []), ...(project.dispute ? [{ ...project.dispute, resolution: arbitration,
    note: project.dispute.note, decision: input.note.trim(), resolvedAt: isoTime(block.timestamp) }] : [])];
  return { project: { ...project, status: expectedState === 3 ? 'In progress' : 'Completed',
    paid: Math.round((project.paid + toFreelancer) * 1e6) / 1e6, decision: input.note.trim(), milestones,
    dispute: undefined, disputeHistory: history, ...(expectedState === 3 ? { disputeReason: undefined, disputeOpenedBy: undefined } : {}) },
    arbitration, transaction: { id: receipt.transactionHash, time: isoTime(block.timestamp) } };
}

async function readDeployment(root, pinned) {
  const deployment = await checkLocalDeployment(root, undefined, 'FESC', pinned);
  const [token, code] = await Promise.all([
    rpc.readContract({ address: deployment.factory, abi: factoryAbi, functionName: 'token' }),
    rpc.getCode({ address: deployment.token }),
  ]);
  if (!isAddressEqual(token, deployment.token) || !code || keccak256(code) !== deployment.tokenCodeHash) {
    throw new WorkflowError(503, 'Không xác minh được hợp đồng token FESC.');
  }
  return deployment;
}

async function belongsToPreviousChain(root, pinned) {
  if (!pinned?.instanceKey) return false;
  let configured;
  try {
    configured = JSON.parse(await readFile(resolve(root, '.hardhat/local-fesc-deployment.json'), 'utf8'));
  } catch {
    // Missing configuration does not establish that the chain has changed.
    return false;
  }
  if (configured?.instanceKey === pinned.instanceKey) return false;
  try {
    // A redeploy on the same chain does not remove a project's pinned contracts.
    await readDeployment(root, pinned);
    return false;
  } catch {
    // Only a verified replacement deployment can establish a historical chain.
  }
  // An offline RPC or an invalid new manifest must not become a historical status.
  const current = await readDeployment(root);
  return current.instanceKey !== pinned.instanceKey;
}

const transferEvent = tokenAbi.find(item => item.type === 'event' && item.name === 'Transfer');
const transferPageSize = 20;
const transferBlockWindow = 1000n;
const holderLimit = 100;
const publicReadConcurrency = 4;

async function mapPublicReads(items, operation) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  let failure;
  await Promise.all(Array.from({ length: Math.min(publicReadConcurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await operation(items[index], index); }
      catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }));
  if (failed) throw failure;
  return results;
}

async function verifyPublicSnapshot(snapshot) {
  if (typeof snapshot.number !== 'bigint' || !snapshot.hash ||
      (await rpc.getBlock({ blockNumber: snapshot.number })).hash !== snapshot.hash) {
    throw new WorkflowError(503, 'Blockchain đã đổi trong lúc tra cứu. Hãy làm mới để đọc lại dữ liệu.');
  }
}

const accountKind = code => code && code !== '0x' ? 'contract' : 'wallet';

export async function publicFescHolders(root) {
  try {
    const { token } = await readDeployment(root);
    const snapshot = await rpc.getBlock({ blockTag: 'latest' });
    const head = snapshot.number;
    if (typeof head !== 'bigint' || !snapshot.hash) throw new Error('Unconfirmed snapshot');
    const addresses = new Set();
    // Token minting can precede factory deployment, so discovery starts at genesis.
    for (let fromBlock = 0n; fromBlock <= head; fromBlock += transferBlockWindow) {
      const toBlock = fromBlock + transferBlockWindow - 1n < head
        ? fromBlock + transferBlockWindow - 1n : head;
      const logs = await rpc.getLogs({ address: token, event: transferEvent, strict: true, fromBlock, toBlock });
      for (const log of logs) {
        if (log.removed || typeof log.blockNumber !== 'bigint' ||
            log.blockNumber < fromBlock || log.blockNumber > toBlock || !isAddressEqual(log.address, token)) {
          throw new Error('Incomplete token history');
        }
        for (const address of [log.args.from, log.args.to]) {
          if (typeof address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(address)) throw new Error('Invalid token holder');
          if (!isAddressEqual(address, zeroAddress)) addresses.add(address.toLowerCase());
        }
      }
    }
    const totalSupply = await rpc.readContract({ address: token, abi: tokenAbi, functionName: 'totalSupply', blockNumber: head });
    const balances = await mapPublicReads([...addresses], async address => ({ address,
      units: await rpc.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [address], blockNumber: head }),
    }));
    // A failed or truncated log scan must never produce a plausible partial ranking.
    if (balances.reduce((sum, holder) => sum + holder.units, 0n) !== totalSupply) {
      throw new WorkflowError(503, 'Chưa đọc đủ người giữ FESC để lập bảng xếp hạng. Hãy thử lại.');
    }
    const nonzero = balances.filter(holder => holder.units > 0n)
      .sort((a, b) => a.units === b.units ? a.address < b.address ? -1 : a.address > b.address ? 1 : 0
        : a.units > b.units ? -1 : 1);
    const holders = await mapPublicReads(nonzero.slice(0, holderLimit), async (holder, index) => ({
      rank: index + 1, address: holder.address, balance: formatUnits(holder.units, 18),
      kind: accountKind(await rpc.getCode({ address: holder.address, blockNumber: head })),
    }));
    await verifyPublicSnapshot(snapshot);
    return { token, chainId: localChain.id, latestBlock: head.toString(),
      totalSupply: formatUnits(totalSupply, 18), totalHolders: nonzero.length, holders };
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError(503, 'Chưa đọc được bảng người giữ FESC. Hãy kiểm tra Hardhat Local rồi thử lại.');
  }
}

export async function adminFescStatistics(root, range, walletAddress, buckets = []) {
  const series = buckets.map(bucket => ({ key: bucket.key, lower: BigInt(Math.floor(Date.parse(bucket.start) / 1000)),
    upper: BigInt(Math.floor(Date.parse(bucket.end) / 1000)), volume: 0n, transfers: 0 }));
  const { token } = await readDeployment(root);
  const snapshot = await rpc.getBlock({ blockTag: 'latest' });
  const head = snapshot.number;
  if (typeof head !== 'bigint') throw new WorkflowError(503, 'Chưa đọc được block FESC.');
  const lower = BigInt(Math.floor(Date.parse(range.start) / 1000));
  const upper = BigInt(Math.floor(Date.parse(range.end) / 1000));
  const hashes = new Set();
  const times = new Map();
  let volume = 0n;
  let transfers = 0;
  for (let start = 0n; start <= head; start += transferBlockWindow) {
    const end = start + transferBlockWindow - 1n < head ? start + transferBlockWindow - 1n : head;
    const logs = await rpc.getLogs({ address: token, event: transferEvent, strict: true, fromBlock: start, toBlock: end });
    for (const log of logs) {
      if (log.removed || isAddressEqual(log.args.from, zeroAddress) || isAddressEqual(log.args.to, zeroAddress)) continue;
      const key = `${log.transactionHash}:${log.logIndex}`;
      if (hashes.has(key)) continue;
      hashes.add(key);
      const blockKey = log.blockNumber.toString();
      if (!times.has(blockKey)) times.set(blockKey, await rpc.getBlock({ blockNumber: log.blockNumber }));
      const block = times.get(blockKey);
      if (block.hash !== log.blockHash) throw new WorkflowError(503, 'Chain đổi trong lúc thống kê FESC.');
      if (block.timestamp < lower || block.timestamp >= upper) continue;
      const receipt = await rpc.getTransactionReceipt({ hash: log.transactionHash });
      if (receipt.status !== 'success' || receipt.blockHash !== block.hash ||
          !receipt.logs.some(entry => entry.logIndex === log.logIndex && entry.address.toLowerCase() === token.toLowerCase() &&
            entry.data === log.data && entry.topics.join() === log.topics.join())) {
        throw new WorkflowError(503, 'Chưa xác minh được giao dịch trong thống kê FESC.');
      }
      volume += log.args.value;
      transfers++;
      const bucket = series.find(item => block.timestamp >= item.lower && block.timestamp < item.upper);
      if (bucket) { bucket.volume += log.args.value; bucket.transfers++; }
    }
  }
  const totalSupply = await rpc.readContract({ address: token, abi: tokenAbi, functionName: 'totalSupply', blockNumber: head });
  const walletBalance = walletAddress ? await rpc.readContract({ address: token, abi: tokenAbi,
    functionName: 'balanceOf', args: [walletAddress], blockNumber: head }) : null;
  await verifyPublicSnapshot(snapshot);
  return { available: true, token, block: head.toString(), volume: formatUnits(volume, 18), transfers,
    totalSupply: formatUnits(totalSupply, 18), walletAddress: walletAddress ?? null,
    walletBalance: walletBalance === null ? null : formatUnits(walletBalance, 18),
    series: series.map(({ key, volume: amount, transfers: count }) => ({ key, volume: formatUnits(amount, 18), transfers: count })) };
}

// Admin account table: an account is "active" when its linked wallet currently holds FESC.
export async function adminAccounts(root, accounts) {
  const rows = accounts.map(({ id, name, email, role, address }) => ({ id, name, email, role, address: address ?? null, balance: null }));
  const summary = { total: rows.length, linked: rows.filter(row => row.address).length };
  try {
    const { token } = await readDeployment(root);
    const head = (await rpc.getBlock({ blockTag: 'latest' })).number;
    const balances = await mapPublicReads(rows.filter(row => row.address), async row => ({ row,
      units: await rpc.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [row.address], blockNumber: head }) }));
    for (const { row, units: value } of balances) row.balance = formatUnits(value, 18);
    const active = balances.filter(item => item.units > 0n);
    return { ...summary, available: true, block: head.toString(), active: active.length,
      held: formatUnits(active.reduce((sum, item) => sum + item.units, 0n), 18), accounts: rows };
  } catch {
    return { ...summary, available: false, active: null, error: 'Không đọc được số dư FESC. Kiểm tra Hardhat Local rồi thử lại.', accounts: rows };
  }
}

export async function publicFescTransfers(root, params) {
  const query = (params.get('q') ?? '').trim().toLowerCase();
  const address = /^0x[0-9a-f]{40}$/.test(query) ? query : undefined;
  const txHash = /^0x[0-9a-f]{64}$/.test(query) ? query : undefined;
  if (query && !address && !txHash) throw new WorkflowError(400, 'Nhập địa chỉ hoặc mã giao dịch Ethereum đầy đủ.');
  const cursor = params.get('before');
  const boundary = cursor && /^(0x[0-9a-f]{64}):(\d{1,20})(?::(\d{1,9}))?$/i.exec(cursor);
  if (cursor !== null && !boundary) throw new WorkflowError(400, 'Trang giao dịch không hợp lệ.');

  try {
    const { token, instanceKey, startBlock } = await readDeployment(root);
    if (boundary && boundary[1] !== instanceKey) {
      throw new WorkflowError(409, 'Bản triển khai FESC đã đổi. Hãy bấm Làm mới để xem từ đầu.');
    }
    const first = BigInt(startBlock);
    const head = await rpc.getBlockNumber({ cacheTime: 0 });
    const walletSnapshot = address ? await rpc.getBlock({ blockNumber: head }) : undefined;
    const end = boundary ? BigInt(boundary[2]) : head;
    const beforeIndex = boundary?.[3] === undefined ? undefined : Number(boundary[3]);
    if (end < first || end > head) throw new WorkflowError(400, 'Trang giao dịch nằm ngoài phạm vi block hiện tại.');
    const start = end - first >= transferBlockWindow ? end - transferBlockWindow + 1n : first;
    const receipts = new Map();
    const blocks = new Map();
    const receiptFor = transactionHash => {
      if (!receipts.has(transactionHash)) receipts.set(transactionHash,
        rpc.getTransactionReceipt({ hash: transactionHash }).catch(error => {
          if (error instanceof TransactionReceiptNotFoundError) return undefined;
          throw error;
        }));
      return receipts.get(transactionHash);
    };
    const blockFor = blockNumber => {
      const key = blockNumber.toString();
      // Resolve by number, not hash, so an orphaned block cannot pass verification.
      if (!blocks.has(key)) blocks.set(key, rpc.getBlock({ blockNumber }));
      return blocks.get(key);
    };
    let logs;
    if (txHash) {
      const receipt = await receiptFor(txHash);
      logs = receipt?.status === 'success' && receipt.blockNumber >= first && receipt.blockNumber <= end
        ? parseEventLogs({ abi: tokenAbi, eventName: 'Transfer', strict: true,
            logs: receipt.logs.filter(log => isAddressEqual(log.address, token)) })
        : [];
    } else {
      const range = { address: token, event: transferEvent, strict: true, fromBlock: start, toBlock: end };
      if (address) {
        const [sent, received] = await Promise.all([
          rpc.getLogs({ ...range, args: { from: address } }),
          rpc.getLogs({ ...range, args: { to: address } }),
        ]);
        // A transfer to the same address matches both filters.
        logs = [...new Map([...sent, ...received].map(log => [log.transactionHash + ':' + log.logIndex, log])).values()];
      } else {
        logs = await rpc.getLogs(range);
      }
    }
    const candidates = logs.filter(log => !log.removed && typeof log.blockNumber === 'bigint' &&
      typeof log.blockHash === 'string' && typeof log.transactionHash === 'string' &&
      Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 && log.blockNumber >= first && log.blockNumber <= end &&
      (log.blockNumber !== end || beforeIndex === undefined || log.logIndex < beforeIndex) &&
      !isAddressEqual(log.args.from, zeroAddress) && !isAddressEqual(log.args.to, zeroAddress));
    const ordered = [...new Map(candidates.map(log => [log.transactionHash + ':' + log.logIndex, log])).values()]
      .sort((a, b) => a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1);
    const verified = [];
    for (const log of ordered) {
      const [receipt, block] = await Promise.all([receiptFor(log.transactionHash), blockFor(log.blockNumber)]);
      if (receipt?.status !== 'success' || receipt.transactionHash !== log.transactionHash ||
          receipt.blockNumber !== log.blockNumber || receipt.blockHash !== log.blockHash ||
          block.hash !== receipt.blockHash || !block.transactions.includes(log.transactionHash)) continue;
      const confirmed = receipt.logs.find(entry => !entry.removed && entry.logIndex === log.logIndex &&
        entry.transactionHash === log.transactionHash && entry.blockHash === log.blockHash &&
        entry.blockNumber === log.blockNumber && isAddressEqual(entry.address, token) &&
        entry.data === log.data && entry.topics.length === log.topics.length &&
        entry.topics.every((topic, index) => topic === log.topics[index]));
      if (!confirmed) continue;
      verified.push(log);
      // One extra verified event is enough to determine whether this page continues.
      if (verified.length > transferPageSize) break;
    }
    const page = verified.slice(0, transferPageSize);
    const transfers = await Promise.all(page.map(async ({ transactionHash, logIndex, blockNumber, args }) => ({
      hash: transactionHash, logIndex, block: blockNumber.toString(),
      time: new Date(Number((await blockFor(blockNumber)).timestamp) * 1000).toISOString(),
      from: args.from, to: args.to, amount: formatUnits(args.value, 18),
    })));
    const last = page.at(-1);
    const next = verified.length > transferPageSize ? `${instanceKey}:${last.blockNumber}:${last.logIndex}`
      : !txHash && start > first ? `${instanceKey}:${start - 1n}` : null;
    let wallet;
    if (address) {
      const [balance, code] = await Promise.all([
        rpc.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [address], blockNumber: head }),
        rpc.getCode({ address, blockNumber: head }),
      ]);
      await verifyPublicSnapshot(walletSnapshot);
      wallet = { address, balance: formatUnits(balance, 18), kind: accountKind(code) };
    }
    return { token, chainId: localChain.id, latestBlock: head.toString(), transfers, next, ...(wallet ? { wallet } : {}) };
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError(503, 'Chưa đọc được giao dịch FESC. Hãy kiểm tra Hardhat Local rồi thử lại.');
  }
}

export async function fescWalletBalance(root, wallet) {
  if (wallet?.chainId !== localChain.id) throw new WorkflowError(409, 'Hãy xác minh ví Hardhat Local trước.');
  const { token } = await readDeployment(root);
  const balance = await rpc.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [wallet.address] });
  return { token, balance: formatUnits(balance, 18) };
}

function buildTerms(project, { deployment, client, freelancer, createBy, reference, policyVersion = 1, baseDues }) {
  const projectRef = hash(['FESC project', reference?.ownerId ?? project.ownerId, reference?.projectId ?? project.id]);
  return {
    projectRef,
    agreementRef: hash([projectRef, deployment.instanceKey, reference?.freelancerId ?? project.freelancerId]),
    createBy: BigInt(createBy),
    freelancer,
    arbitrator: deployment.accounts.arbitrator,
    budgetUnits: units(project.budget),
    amounts: project.milestones.map(item => units(item.amount)),
    // Policy 2 pins the Client's due dates at contract creation; later extensions happen on chain.
    baseDues: policyVersion === 2 ? baseDues.map(BigInt)
      : project.milestones.map((_, index) => BigInt(createBy) + day * BigInt(30 + 7 * index)),
    policyVersion,
    documentHash: hash([client, freelancer, project.title, project.description, project.category,
      project.milestones.map(({ id, title, amount }) => [id, title, cents(amount)])]),
  };
}

function deliveryHash(project, milestone) {
  const latest = milestone.deliveries?.at(-1);
  if (!latest?.preview?.sha256 || latest.version !== getSubmissionVersion(milestone)) {
    throw new WorkflowError(409, 'Chưa có bản bàn giao hợp lệ cho milestone FESC.');
  }
  return hash([project.fesc.deployment.instanceKey, project.fesc.reference?.projectId ?? project.id, milestone.id, latest.id, latest.version,
    latest.note, latest.preview.sha256, latest.original?.sha256]);
}

async function confirmTransfer({ event, escrow, token, client, from, to, amount }) {
  const [receipt, transaction, block] = await Promise.all([
    rpc.getTransactionReceipt({ hash: event.transactionHash }),
    rpc.getTransaction({ hash: event.transactionHash }),
    rpc.getBlock({ blockNumber: event.blockNumber }),
  ]);
  const transfers = parseEventLogs({ abi: tokenAbi, eventName: 'Transfer',
    logs: receipt.logs.filter(log => isAddressEqual(log.address, token)) });
  if (receipt.status !== 'success' || receipt.blockHash !== event.blockHash || block.hash !== receipt.blockHash ||
      transaction.blockHash !== receipt.blockHash || !transaction.to || !isAddressEqual(transaction.to, escrow) ||
      !isAddressEqual(transaction.from, client) ||
      !transfers.some(log => isAddressEqual(log.args.from, from) && isAddressEqual(log.args.to, to) && log.args.value === amount)) {
    throw new WorkflowError(503, 'Chưa xác minh được giao dịch chuyển FESC của dự án.');
  }
  return { id: receipt.transactionHash, time: new Date(Number(block.timestamp) * 1000).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) };
}

async function reconcile(writes, project, chain) {
  const { deployment, client, freelancer } = project.fesc;
  const { escrow, funded, state, current, blockNumber } = chain;
  const clientActor = { id: project.ownerId, role: 'Client' };
  const token = deployment.token;
  const logs = { address: escrow, abi: escrowAbi, fromBlock: BigInt(deployment.startBlock), toBlock: blockNumber, strict: true };

  async function record(input, receipt) {
    const result = applyProjectAction(project, clientActor, input);
    project = result.project;
    await writes.saveProject(project);
    await writes.addTransaction({ ...result.transactions[0], ...receipt, projectId: project.id, project: project.title,
      currency: 'FESC', status: 'Đã xác nhận', publicPayment: {
        stage: input.action === 'fund' ? 'Ký quỹ' : `Milestone ${input.milestoneId}`,
        amount: String(result.transactions[0].amount),
        from: input.action === 'fund' ? client : escrow,
        to: input.action === 'fund' ? escrow : freelancer,
      } });
  }

  if (!project.funded && funded === units(project.budget)) {
    const [event] = await rpc.getContractEvents({ ...logs, eventName: 'Funded' });
    if (event?.args.amount !== funded) throw new WorkflowError(503, 'Chưa đọc được sự kiện ký quỹ FESC.');
    await record({ action: 'fund' }, await confirmTransfer({ event, escrow, token, client, from: client, to: escrow, amount: funded }));
  }

  const milestone = currentMilestone(project);
  const index = project.milestones.indexOf(milestone);
  if (milestone && current > BigInt(index)) {
    if (milestone.status !== 'Submitted') throw new WorkflowError(409, 'Milestone trên Hardhat không khớp bản bàn giao trên website.');
    const amount = units(milestone.amount);
    const [event] = await rpc.getContractEvents({ ...logs, eventName: 'MilestonePaid', args: { milestone: BigInt(index) } });
    if (event?.args.amount !== amount || event.args.evidenceHash !== deliveryHash(project, milestone)) {
      throw new WorkflowError(409, 'Chưa xác minh được giải ngân FESC cho đúng bản bàn giao.');
    }
    await record({ action: 'approve', milestoneId: milestone.id, submissionVersion: getSubmissionVersion(milestone) },
      await confirmTransfer({ event, escrow, token, client, from: escrow, to: freelancer, amount }));
  }
  const active = currentMilestone(project);
  if (state === 3 && active?.status === 'Pending' && project.milestones[Number(current)] === active) {
    project = { ...project, status: 'In progress',
      milestones: project.milestones.map(item => item === active ? { ...item, status: 'In progress' } : item) };
    await writes.saveProject(project);
  }
  if (project.fesc.policyVersion === 2) {
    // Extensions are signed on chain; mirror the contract's due dates into the project.
    const onChain = await Promise.all(project.milestones.map((_, index) => rpc.readContract({ address: escrow, abi: escrowAbi,
      functionName: 'milestones', args: [BigInt(index)], blockNumber })));
    const seconds = onChain.map(([, baseDeadline]) => Number(baseDeadline));
    if (seconds.some((value, index) => isoTime(value) !== project.milestones[index].dueAt)) {
      project = { ...withDues(project, seconds), extensionRequest: undefined };
      await writes.saveProject(project);
    }
  }
  return project;
}

function disputeOptions(owner, policy, stage, deadline, now) {
  const open = stage === 1 || stage === 3;
  const working = open || stage === 2;
  const other = policy === 2 ? [{ kind: 4, label: disputeLabels[4], available: working,
    hint: working ? '' : 'Chỉ áp dụng khi giai đoạn đang thực hiện hoặc chờ nghiệm thu.' }] : [];
  if (owner) {
    const lateAfter = deadline + (policy === 2 ? 0n : 259_200n);
    return [
      { kind: 0, label: disputeLabels[0], available: stage === 2, hint: stage === 2 ? '' : 'Chỉ áp dụng khi có bản bàn giao chờ nghiệm thu.' },
      { kind: 2, label: disputeLabels[2], available: open && now > lateAfter, terminable: true,
        hint: open ? `Có thể khiếu nại sau ${timeText(lateAfter)} nếu Freelancer chưa bàn giao.` : 'Chỉ áp dụng khi Freelancer chưa bàn giao.' },
      ...other,
    ];
  }
  return [
    { kind: 1, label: reviewTimeoutLabel(policy), available: stage === 2 && now > deadline,
      hint: stage === 2 ? `Có thể khiếu nại sau ${timeText(deadline)} nếu Client chưa nghiệm thu.` : 'Chỉ áp dụng sau khi bạn đã bàn giao.' },
    ...other,
  ];
}

export async function projectFesc(root, writes, project, actor, input = {}) {
  const { action, milestoneId, submissionVersion, note } = input;
  const owner = actor.role === 'Client' && actor.id === project.ownerId;
  const assignee = actor.role === 'Freelancer' && actor.id === project.freelancerId;
  if (project.currency !== 'FESC' || (!owner && !assignee)) throw new WorkflowError(404, 'Dự án FESC không tồn tại.');
  const status = { step: 'waiting', message: '', projectStatus: project.status, paid: project.paid };
  if (await belongsToPreviousChain(root, project.fesc?.deployment)) {
    const message = 'Dự án thuộc một blockchain local trước đây. Dữ liệu dự án vẫn được giữ, nhưng số dư và giao dịch cũ không thể xác minh trên blockchain hiện tại. Cần khôi phục blockchain cũ để tiếp tục dự án này.';
    if (action) throw new WorkflowError(409, message);
    return { ...status, step: 'unavailable', historical: true, message, token: project.fesc.deployment.token };
  }
  if (!project.freelancerId) {
    if (action) throw new WorkflowError(409, 'Chọn Freelancer để tạo hợp đồng FESC.');
    return { ...status, message: 'Chọn Freelancer để tạo hợp đồng FESC.' };
  }

  const clientWallet = await writes.getWalletLink(project.ownerId);
  const freelancerWallet = await writes.getWalletLink(project.freelancerId);
  const wallet = owner ? clientWallet : freelancerWallet;
  if (wallet?.chainId !== localChain.id) {
    if (action) throw new WorkflowError(409, 'Liên kết MetaMask trong Ví & giao dịch.');
    return { ...status, step: 'link', message: 'Liên kết MetaMask trong Ví & giao dịch.' };
  }
  if (clientWallet?.chainId !== localChain.id || freelancerWallet?.chainId !== localChain.id) {
    if (action) throw new WorkflowError(409, 'Cả hai bên cần xác minh ví MetaMask.');
    return { ...status, message: `Đang chờ ${owner ? 'Freelancer' : 'Client'} liên kết MetaMask.` };
  }

  const deployment = await readDeployment(root, project.fesc?.deployment);
  if (deployment.projectPayments !== 1) {
    throw new WorkflowError(503, 'Hãy chạy lại chain:deploy:fesc để triển khai bản hỗ trợ giải ngân dự án.');
  }
  const client = clientWallet.address;
  const freelancer = freelancerWallet.address;
  if ([client, freelancer].some(address => isAddressEqual(address, deployment.accounts.arbitrator))) {
    throw new WorkflowError(409, 'Hãy dùng ví khác tài khoản trọng tài Hardhat cho Client và Freelancer.');
  }
  const { token, factory } = deployment;
  const block = await rpc.getBlock();
  const blockNumber = block.number;
  const read = (address, abi, functionName, args = []) => rpc.readContract({ address, abi, functionName, args, blockNumber });
  const [balance, gas] = await Promise.all([
    read(token, tokenAbi, 'balanceOf', [wallet.address]), rpc.getBalance({ address: wallet.address, blockNumber }),
  ]);
  Object.assign(status, { token, balance: formatUnits(balance, 18), gas: formatEther(gas) });
  // Policy 2 (agreed due dates, 5-day review, extensions) needs an upgraded factory and dated milestones.
  const dated = project.milestones.every(item => item.dueAt);
  const fesc = project.fesc ?? { deployment, client, freelancer, createBy: (block.timestamp + 7n * day).toString(),
    ...(deployment.escrowPolicy === 2 && dated ? { policyVersion: 2,
      baseDues: project.milestones.map(item => String(Math.floor(Date.parse(item.dueAt) / 1000))) } : {}) };
  const policy = fesc.policyVersion ?? 1;
  status.policyVersion = policy;
  if (fesc.client !== client || fesc.freelancer !== freelancer) throw new WorkflowError(409, 'Ví dự án không còn khớp với hợp đồng FESC.');
  const terms = buildTerms(project, fesc);
  const [escrow, termsHash] = await Promise.all([
    read(factory, factoryAbi, 'escrowFor', [client, terms.agreementRef]),
    read(factory, factoryAbi, 'hashTerms', [client, terms]),
  ]);

  let call;
  let chainState;
  function step(next, message, transaction) {
    status.step = next;
    status.message = message;
    call = transaction;
  }
  function escrowCall(functionName, args = []) {
    return { address: escrow, abi: escrowAbi, functionName, args };
  }

  if (escrow === zeroAddress) {
    // Contract creation needs ≥ 48h funding + 7 days to start before the first agreed due date.
    const tooSoon = policy === 2 && BigInt(fesc.baseDues[0]) <= block.timestamp + 9n * day;
    if (block.timestamp > terms.createBy) throw new WorkflowError(409, 'Hạn tạo hợp đồng đã hết. Hãy tạo dự án FESC mới.');
    if (tooSoon) step('waiting', owner ? 'Hạn mốc đầu cần cách hiện tại hơn 9 ngày để đủ thời gian ký quỹ và bắt đầu. Hãy gia hạn mốc đầu bên dưới.'
      : 'Đang chờ Client cập nhật hạn mốc đầu trước khi tạo hợp đồng.');
    else if (owner) step('create', 'Tạo hợp đồng theo ngân sách, milestone và thời hạn của dự án.',
      { address: factory, abi: factoryAbi, functionName: 'createEscrow', args: [terms, termsHash] });
    else step('waiting', 'Đang chờ Client tạo hợp đồng FESC.');
    status.canExtend = owner && policy === 2;
  } else {
    const [actualTermsHash, state, current, version, funded, held, claimable] = await Promise.all([
      read(escrow, escrowAbi, 'termsHash'), read(escrow, escrowAbi, 'state'), read(escrow, escrowAbi, 'current'),
      read(escrow, escrowAbi, 'version'), read(escrow, escrowAbi, 'funded'), read(token, tokenAbi, 'balanceOf', [escrow]),
      read(escrow, escrowAbi, 'claimable', [wallet.address]),
    ]);
    chainState = { state, current, version, claimable };
    if (!project.fesc || actualTermsHash !== termsHash) throw new WorkflowError(409, 'Điều khoản trên Hardhat không khớp với dự án FESC.');
    project = await reconcile(writes, project, { escrow, funded, state, current, blockNumber });
    Object.assign(status, { escrow, held: formatUnits(held, 18), projectStatus: project.status, paid: project.paid,
      claimable: formatUnits(claimable, 18) });
    status.canExtend = owner && policy === 2 && (state === 2 || state === 3);
    if (state === 0) {
      if (assignee) step('accept', 'Xác nhận điều khoản trước khi Client ký quỹ.', escrowCall('accept', [termsHash]));
      else step('waiting', 'Đang chờ Freelancer chấp nhận hợp đồng.');
    } else if (state === 1) {
      if (!owner) step('waiting', 'Đang chờ Client ký quỹ FESC.');
      else if (balance < terms.budgetUnits) step('waiting', `Ví Client cần đủ ${project.budget} FESC để ký quỹ.`);
      else {
        const allowance = await read(token, tokenAbi, 'allowance', [client, escrow]);
        if (allowance === terms.budgetUnits) step('fund', `Nạp ${project.budget} FESC vào hợp đồng.`, escrowCall('fund'));
        else step(allowance === 0n ? 'allow' : 'reset', 'Đặt hạn mức để hợp đồng nhận đúng ngân sách của dự án.',
          { address: token, abi: tokenAbi, functionName: 'approve', args: [escrow, allowance === 0n ? terms.budgetUnits : 0n] });
      }
    } else if (state === 2) {
      if (assignee) step('start', 'Ký xác nhận bắt đầu milestone đầu tiên.', escrowCall('start'));
      else step('waiting', 'Đã ký quỹ. Đang chờ Freelancer bắt đầu công việc.');
    } else if (state === 3) {
      const milestone = currentMilestone(project);
      if (!milestone || project.milestones[Number(current)] !== milestone) {
        throw new WorkflowError(409, 'Milestone hiện hành không khớp với hợp đồng FESC.');
      }
      const [, , deadline, stage, , , evidence] = await read(escrow, escrowAbi, 'milestones', [current]);
      status.disputeOptions = disputeOptions(owner, policy, stage, deadline, block.timestamp);
      status.canDispute = status.disputeOptions.some(option => option.available);
      status.deadline = isoTime(deadline);
      status.reviewing = stage === 2;
      status.milestoneId = milestone.id;
      status.submissionVersion = getSubmissionVersion(milestone);
      const late = block.timestamp > deadline;
      if (stage === 1 && milestone.status !== 'Submitted') {
        if (assignee && late) step('waiting', 'Đã quá hạn giai đoạn này. Gửi yêu cầu gia hạn để Client xem xét.');
        else if (assignee) step('upload', 'Tải bản bàn giao để Client xem và nghiệm thu.');
        else step('waiting', late ? 'Freelancer đã quá hạn giai đoạn. Bạn có thể gia hạn hoặc khiếu nại.' : 'Đang chờ Freelancer bàn giao milestone.');
      } else if (stage === 1 && milestone.status === 'Submitted') {
        if (assignee) step('submit', 'Đã lưu tệp. Xác nhận bàn giao trong MetaMask.',
          escrowCall('submit', [current, version, deliveryHash(project, milestone)]));
        else step('waiting', 'Đang chờ Freelancer xác nhận bàn giao trên Hardhat.');
      } else if (stage === 2 && evidence === deliveryHash(project, milestone)) {
        if (owner) {
          step('approve', `Xem bản bàn giao bên dưới và nghiệm thu trước ${timeText(deadline)}. Nghiệm thu sẽ chuyển ${milestone.amount} FESC vào ví Freelancer.`,
            escrowCall('approveAndPayMilestone', [current, version]));
        } else step('waiting', `Đã bàn giao. Client cần nghiệm thu trước ${timeText(deadline)}.`);
      } else throw new WorkflowError(409, 'Bản bàn giao trên Hardhat không khớp với dữ liệu dự án.');
    } else if (state === 4) {
      if (project.status !== 'Disputed') {
        const events = await rpc.getContractEvents({ address: escrow, abi: escrowAbi, eventName: 'DisputeOpened',
          fromBlock: BigInt(deployment.startBlock), toBlock: blockNumber });
        const opened = events.findLast(event => event.args.milestone === current);
        const legacy = project.fesc.disputeDraft;
        const draft = project.fesc.disputeDrafts?.[opened?.args.reasonHash] ??
          (legacy && opened?.args.reasonHash === legacy.hash ? { note: legacy.note, evidence: [] } : undefined);
        const by = opened && isAddressEqual(opened.args.author, project.fesc.client) ? 'Client' : 'Freelancer';
        const kind = opened ? Number(opened.args.reason) : 4;
        const openedAt = opened ? isoTime((await rpc.getBlock({ blockNumber: opened.blockNumber })).timestamp) : new Date().toISOString();
        project = markEvidenceUsed({ ...project, status: 'Disputed', disputeOpenedBy: by,
          disputeReason: draft?.note ?? 'Tranh chấp đã được xác nhận trên blockchain.',
          dispute: { kind, label: draft?.label ?? disputeLabels[kind] ?? disputeLabels[4], note: draft?.note ?? '',
            terminate: draft?.terminate ?? false, evidence: draft?.evidence ?? [], by, openedAt,
            milestoneId: project.milestones[Number(current)]?.id, reasonHash: opened?.args.reasonHash },
          ...(project.adminReview ? { adminReview: { ...project.adminReview, status: 'reviewing' } } : {}),
          fesc: { ...project.fesc, disputeDrafts: undefined, disputeDraft: undefined },
          milestones: project.milestones.map((item, index) => index === Number(current) ? { ...item, status: 'Disputed' } : item) },
        draft?.evidence ?? []);
        await writes.saveProject(project);
      }
      status.projectStatus = 'Disputed';
      step('waiting', 'Dự án đang tranh chấp. Admin sẽ xem bằng chứng và quyết định trên blockchain.');
    } else if (state === 5 && project.status === 'Completed') {
      if (claimable > 0n) step('withdraw', `Bạn được rút ${formatUnits(claimable, 18)} FESC theo quyết định phân xử.`, escrowCall('withdraw'));
      else step('complete', 'Dự án đã hoàn tất và không còn FESC chờ rút cho ví này.');
    } else step('waiting', 'Hợp đồng FESC đã ngừng nhận thao tác cho dự án.');
  }

  if (!action) return status;
  if (action === 'withdraw' && status.step !== 'withdraw') {
    // After a "continue" arbitration the contract stays active while a share waits to be withdrawn.
    if (!chainState || chainState.claimable === 0n) throw new WorkflowError(409, 'Không có FESC chờ rút cho ví này.');
    step('withdraw', status.message, escrowCall('withdraw'));
  }
  let saveDraft;
  if (action === 'dispute') {
    const option = status.disputeOptions?.find(item => item.kind === input.reason && item.available);
    if (!option || typeof note !== 'string' || note.trim().length < 3 || note.length > 2000 || milestoneId !== status.milestoneId) {
      throw new WorkflowError(409, 'Chọn lý do hợp lệ và nhập mô tả khiếu nại (3–2000 ký tự).');
    }
    const evidence = pickEvidence(project, actor, input.evidenceIds, input.links);
    const terminate = Boolean(option.terminable && input.terminate === true);
    const reasonHash = hash(['dispute', option.kind, note.trim(), terminate, evidenceFingerprint(evidence)]);
    saveDraft = { kind: option.kind, label: option.label, note: note.trim(), terminate, evidence, hash: reasonHash };
    call = escrowCall('openDispute', [chainState.current, chainState.version, option.kind, reasonHash]);
    status.step = 'dispute';
  }
  if (action === 'extend') {
    if (!status.canExtend) throw new WorkflowError(409, 'Chỉ Client gia hạn được dự án FESC đang thực hiện theo quy tắc thời hạn mới.');
    const newDeadline = dueSeconds(input.dueDate);
    const whole = input.whole === true;
    const index = whole ? project.milestones.length - 1 : project.milestones.findIndex(item => item.id === milestoneId);
    const first = chainState?.state === 3 ? Number(chainState.current) : 0;
    const dues = (escrow === zeroAddress ? fesc.baseDues : project.milestones.map(item => Date.parse(item.dueAt) / 1000)).map(Number);
    if (!Number.isFinite(newDeadline) || index < first || newDeadline <= dues[index] || newDeadline <= Number(block.timestamp)) {
      throw new WorkflowError(400, 'Chọn ngày gia hạn sau hạn hiện tại của giai đoạn đã chọn.');
    }
    if (escrow === zeroAddress) {
      // No contract yet: the agreed dates are still off chain and can simply be rescheduled.
      const next = shiftDues(dues, index, newDeadline, whole);
      const updated = { ...withDues(project, next), extensionRequest: undefined,
        ...(project.fesc ? { fesc: { ...project.fesc, baseDues: next.map(String) } } : {}) };
      await writes.saveProject(updated);
      return { updated: true };
    }
    call = escrowCall('extendDeadline', [BigInt(index), BigInt(newDeadline), whole, chainState.version]);
    status.step = 'extend';
  }
  const targetsDelivery = action === 'submit' || action === 'approve';
  if (action !== status.step || !call || (targetsDelivery &&
      (milestoneId !== status.milestoneId || submissionVersion !== status.submissionVersion))) {
    throw new WorkflowError(409, 'Trạng thái dự án đã đổi. Hãy làm mới và kiểm tra bản bàn giao hiện hành.');
  }
  if (!gas) throw new WorkflowError(409, 'Ví cần ETH thử để trả phí gas trên Hardhat.');
  try {
    await rpc.simulateContract({ ...call, account: wallet.address });
  } catch {
    throw new WorkflowError(409, 'Hardhat chưa chấp nhận giao dịch. Hãy làm mới và kiểm tra trạng thái, hạn thao tác và số dư.');
  }
  if (!project.fesc) await writes.saveProject({ ...project, fesc });
  else if (saveDraft) {
    // Keyed by reason hash so drafts from both parties can coexist until one is confirmed on chain.
    const drafts = Object.entries(project.fesc.disputeDrafts ?? {}).slice(-4);
    await writes.saveProject({ ...project, fesc: { ...project.fesc,
      disputeDrafts: Object.fromEntries([...drafts, [saveDraft.hash, saveDraft]]) } });
  }
  return { from: wallet.address, to: call.address, data: encodeFunctionData(call),
    deploymentBlock: numberToHex(BigInt(deployment.startBlock)), deploymentBlockHash: deployment.startBlockHash };
}
