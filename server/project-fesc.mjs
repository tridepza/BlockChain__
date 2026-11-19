import {
  createPublicClient, decodeFunctionData, encodeFunctionData, formatEther, formatUnits, http, isAddressEqual,
  keccak256, numberToHex, parseAbi, parseEventLogs, stringToHex, TransactionReceiptNotFoundError, zeroAddress,
} from 'viem';
import { hardhat } from 'viem/chains';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { localChain } from '../src/local-chain.ts';
import { applyProjectAction, cents, currentMilestone, getPendingDelivery, getSubmissionVersion, WorkflowError } from '../src/workflow.ts';
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
  'function LATEST_POLICY_VERSION() view returns (uint32)',
  'function FACTORY_REVISION() view returns (uint32)',
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
  'function fundDeadline() view returns (uint64)',
  'function startDeadline() view returns (uint64)',
  'function unallocated() view returns (uint256)',
  'function closure() view returns (uint8)',
  'function offer() view returns (address author, uint64 expiresAt, uint256 version, bytes32 digest, bool settlement)',
  'function offerNonce() view returns (uint256)',
  'function firstCancelExpiry() view returns (uint64)',
  'function milestones(uint256 index) view returns (uint256 amount, uint64 baseDeadline, uint64 deadline, uint8 stage, uint8 outcome, uint8 revisions, bytes32 submissionHash, uint256 toFreelancer)',
  'function accept(bytes32 expectedHash)',
  'function fund()',
  'function start()',
  'function cancelUnfunded()',
  'function expireFunding()',
  'function expireStart()',
  'function submit(uint256 index, uint256 expectedVersion, bytes32 evidenceHash)',
  'function requestRevision(uint256 index, uint256 expectedVersion, bytes32 reasonHash)',
  'function approveAndPayMilestone(uint256 index, uint256 expectedVersion)',
  'function openDispute(uint256 index, uint256 expectedVersion, uint8 reason, bytes32 reasonHash)',
  'function addEvidence(bytes32 evidenceHash)',
  'function evidenceCount() view returns (uint256)',
  'function arbitrator() view returns (address)',
  'function claimable(address beneficiary) view returns (uint256)',
  'function withdraw()',
  'function proposeCancel(uint256 expectedVersion, bytes32 reasonHash)',
  'function confirmOffer(uint256 nonce, bytes32 digest)',
  'function resolve(uint256 toFreelancer, uint256 expectedEvidenceCount, bytes32 decisionHash)',
  'function resolveAndContinue(uint256 toFreelancer, uint256 expectedEvidenceCount, bytes32 decisionHash)',
  'function extendDeadline(uint256 index, uint64 newDeadline, bool wholeProject, uint256 expectedVersion)',
  'event DisputeOpened(uint256 indexed milestone, uint8 reason, bytes32 reasonHash, address indexed author)',
  'event EvidenceAdded(uint256 indexed sequence, bytes32 indexed evidenceHash, address indexed author)',
  'event DeadlineExtended(uint256 indexed milestone, bool wholeProject, uint64 newDeadline, uint64 delta)',
  'event Allocated(uint256 indexed milestone, uint8 outcome, uint256 toFreelancer, uint256 toClient)',
  'event Resolved(bytes32 decisionHash, uint256 evidenceCount)',
  'event Funded(uint256 amount)',
  'event Submitted(uint256 indexed milestone, bytes32 evidenceHash, uint64 reviewBy)',
  'event RevisionRequested(uint256 indexed milestone, bytes32 reasonHash, uint64 revisionBy)',
  'event MilestonePaid(uint256 indexed milestone, bytes32 evidenceHash, uint256 amount)',
  'event Withdrawn(address indexed beneficiary, uint256 amount)',
  'event StateChanged(uint8 state, uint8 closure, uint256 version)',
]);

export const fescActions = ['create', 'accept', 'reset', 'allow', 'fund', 'start', 'submit', 'approve', 'dispute', 'withdraw', 'extend',
  'proposeCancel', 'confirmCancel', 'expireFunding', 'expireStart', 'revise'];

const closedState = 5;
const refundedOutcome = 2;
const arbitratedOutcome = 3;
const arbitratedClosure = 6;
export const decisionLabels = { release: 'Giải ngân 100% cho Freelancer', split: 'Chia đều 50/50 cho hai bên',
  refund: 'Hoàn 100% cho Client', allocation: 'Phân bổ theo quyết định trên blockchain' };
const closureRules = {
  2: { reason: 'unfunded', method: 'cancelUnfunded', clientOnly: true, refund: false },
  3: { reason: 'fundingExpired', method: 'expireFunding', clientOnly: false, refund: false },
  4: { reason: 'consent', method: 'confirmOffer', clientOnly: false, refund: true },
  5: { reason: 'startExpired', method: 'expireStart', clientOnly: true, refund: true },
};

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
  if (!['prepare', 'confirm', 'recover'].includes(input.action) || !['release', 'split', 'refund'].includes(input.decision) ||
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
  if (input.action === 'recover') {
    if (state === 4 && ordinal === BigInt(index)) return undefined;
    const events = await rpc.getContractEvents({ address: escrow, abi: escrowAbi, eventName: 'Resolved',
      fromBlock: BigInt(deployment.startBlock), strict: true });
    return events.findLast(event => event.args.decisionHash === decisionHash &&
      event.args.evidenceCount === BigInt(input.evidenceCount))?.transactionHash;
  }
  if (input.action === 'prepare') {
    if (state !== 4 || ordinal !== BigInt(index) || evidenceCount !== BigInt(input.evidenceCount)) {
      throw new WorkflowError(409, 'Trạng thái hoặc bằng chứng đã đổi. Hãy mở lại hồ sơ.');
    }
    if (!(await rpc.getBalance({ address: arbitrator }))) {
      throw new WorkflowError(409, `Ví trọng tài ${arbitrator} cần ETH thử để trả phí trên Hardhat Local.`);
    }
    await rpc.simulateContract({ ...call, account: arbitrator });
    return { ...info, from: arbitrator, to: escrow, data,
      deploymentBlock: numberToHex(BigInt(deployment.startBlock)), deploymentBlockHash: deployment.startBlockHash };
  }
  return confirmedArbitration(project, { escrow, arbitrator, index, hash: input.hash, expectedData: data, note: input.note.trim() });
}

async function confirmedArbitration(project, { escrow, arbitrator, index, hash: transactionHash, expectedData, note, event }) {
  if (typeof transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(transactionHash)) throw new WorkflowError(400, 'Mã giao dịch không hợp lệ.');
  let receipt, tx;
  try {
    [receipt, tx] = await Promise.all([rpc.getTransactionReceipt({ hash: transactionHash }), rpc.getTransaction({ hash: transactionHash })]);
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError || error.name === 'TransactionNotFoundError') {
      throw new WorkflowError(409, 'Chưa tìm thấy giao dịch phân xử trên Hardhat. Kiểm tra mã và thử ghi nhận lại.');
    }
    throw error;
  }
  const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
  const invalid = () => new WorkflowError(409, 'Chưa xác minh được quyết định trên đúng blockchain.');
  if (receipt.status !== 'success' || receipt.transactionHash !== transactionHash ||
      receipt.blockHash !== block.hash || tx.blockHash !== block.hash || !block.transactions.includes(transactionHash) ||
      (event && (event.blockHash !== block.hash || event.blockNumber !== block.number)) ||
      !tx.to || !isAddressEqual(tx.to, escrow) || !isAddressEqual(tx.from, arbitrator) ||
      (expectedData && tx.input !== expectedData)) throw invalid();
  const { functionName, args } = decodeFunctionData({ abi: escrowAbi, data: tx.input });
  if (!['resolve', 'resolveAndContinue'].includes(functionName)) throw invalid();
  const mode = functionName === 'resolveAndContinue' ? 'continue' : 'terminate';
  const [amount, evidenceCount, decisionHash] = args;
  const whole = units(project.milestones[index].amount);
  const decision = amount === whole ? 'release' : amount === 0n ? 'refund' : amount === whole / 2n ? 'split' : 'allocation';
  const events = parseEventLogs({ abi: escrowAbi, strict: true,
    logs: receipt.logs.filter(log => isAddressEqual(log.address, escrow)) });
  const resolved = events.find(event => event.eventName === 'Resolved');
  const allocations = events.filter(event => event.eventName === 'Allocated');
  const last = index === project.milestones.length - 1;
  const allocated = mode === 'continue' ? 1 : project.milestones.length - index;
  const expectedState = mode === 'continue' && !last ? 3 : 5;
  const stateEvent = events.find(event => event.eventName === 'StateChanged')?.args;
  if (amount > whole || resolved?.args.decisionHash !== decisionHash || resolved.args.evidenceCount !== evidenceCount ||
      allocations.length !== allocated || stateEvent?.state !== expectedState ||
      stateEvent.closure !== (expectedState === closedState ? arbitratedClosure : 0)) throw invalid();
  for (let i = index; i < index + allocated; i++) {
    const event = allocations.find(event => event.args.milestone === BigInt(i));
    const share = i === index ? amount : 0n;
    if (!event || event.args.outcome !== (i === index ? arbitratedOutcome : refundedOutcome) ||
        event.args.toFreelancer !== share || event.args.toClient !== units(project.milestones[i].amount) - share) {
      throw new WorkflowError(409, 'Phân bổ FESC không khớp với quyết định.');
    }
  }
  const toFreelancer = Number(formatUnits(amount, 18));
  // New policy-2 contracts pay both parties in the resolution itself. Older ones leave a claimable balance.
  const transfers = parseEventLogs({ abi: tokenAbi, eventName: 'Transfer', strict: true,
    logs: receipt.logs.filter(log => isAddressEqual(log.address, project.fesc.deployment.token)) });
  const clientShare = allocations.reduce((total, entry) => total + entry.args.toClient, 0n);
  const paidOut = [[project.fesc.freelancer, amount], [project.fesc.client, clientShare]].every(([wallet, share]) =>
    share === 0n || events.some(entry => entry.eventName === 'Withdrawn' && isAddressEqual(entry.args.beneficiary, wallet) &&
      entry.args.amount >= share && transfers.some(transfer => isAddressEqual(transfer.args.from, escrow) &&
        isAddressEqual(transfer.args.to, wallet) && transfer.args.value === entry.args.amount)));
  const arbitration = { decision, mode, toFreelancer, toClient: Number(formatUnits(whole - amount, 18)), paidOut };
  const milestones = project.milestones.map((m, i) => {
    if (i < index) return m;
    if (i === index) return { ...m, status: amount > 0n ? 'Paid' : 'Refunded', arbitration };
    if (mode === 'terminate') return { ...m, status: 'Refunded' };
    return i === index + 1 ? { ...m, status: 'In progress' } : m;
  });
  const draft = project.fesc.arbitrationDrafts?.[tx.input];
  const decisionNote = note ?? draft?.note ?? 'Đã đối soát quyết định phân xử từ blockchain. Ghi chú gốc chưa được lưu trên website.';
  const history = [...(project.disputeHistory ?? []), ...(project.dispute ? [{ ...project.dispute, resolution: arbitration,
    decision: decisionNote, resolvedAt: isoTime(block.timestamp) }] : [])];
  return { project: { ...project, status: expectedState === 3 ? 'In progress' : 'Completed',
    paid: Math.round((project.paid + toFreelancer) * 1e6) / 1e6, decision: decisionNote, milestones,
    fesc: { ...project.fesc, supplementalEvidenceDrafts: undefined, arbitrationDrafts: undefined },
    dispute: undefined, disputeHistory: history, ...(expectedState === 3 ? { disputeReason: undefined, disputeOpenedBy: undefined } : {}) },
    arbitration, milestoneId: project.milestones[index].id, transaction: { id: receipt.transactionHash, time: isoTime(block.timestamp) },
    draft, note: decisionNote };
}

export async function recordFescArbitration(writes, resolution, actor = resolution.draft) {
  const { project, arbitration, milestoneId, transaction, note } = resolution;
  const entry = { actorId: actor?.id ?? 'blockchain', actor: actor?.name ?? 'Blockchain',
    action: arbitration.decision, note, at: new Date().toISOString(), hash: transaction.id, arbitration, milestoneId };
  const next = { ...project, adminReview: { status: 'resolved', revision: (project.adminReview?.revision ?? 0) + 1,
    history: [...(project.adminReview?.history ?? []), entry] } };
  await writes.addTransaction({ ...transaction, projectId: project.id, project: project.title,
    action: `Phân xử FESC: ${decisionLabels[entry.action]}`, amount: arbitration.toFreelancer, currency: 'FESC', status: 'Đã xác nhận' });
  await writes.saveProject(next);
  return next;
}

function forCurrentDispute(project, draft) {
  return project.status === 'Disputed' && project.dispute && draft.disputeAt === project.dispute.openedAt &&
    draft.milestoneId === project.dispute.milestoneId;
}

function evidenceAnchor(project, evidenceHash) {
  return project.dispute?.evidenceAnchors?.[evidenceHash] ??
    project.disputeHistory?.map(dispute => dispute.evidenceAnchors?.[evidenceHash]).find(Boolean);
}

async function publishSupplementalEvidence(writes, project, escrow, evidenceHash, draft, txHash) {
  let receipt, tx;
  try {
    [receipt, tx] = await Promise.all([rpc.getTransactionReceipt({ hash: txHash }), rpc.getTransaction({ hash: txHash })]);
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError || error.name === 'TransactionNotFoundError') {
      throw new WorkflowError(409, 'Chưa tìm thấy giao dịch bổ sung bằng chứng trên Hardhat. Hãy kiểm tra lại sau.');
    }
    throw error;
  }
  const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
  const data = encodeFunctionData({ abi: escrowAbi, functionName: 'addEvidence', args: [evidenceHash] });
  const events = parseEventLogs({ abi: escrowAbi, strict: true, eventName: 'EvidenceAdded',
    logs: receipt.logs.filter(log => isAddressEqual(log.address, escrow)) });
  if (receipt.status !== 'success' || receipt.blockHash !== block.hash || tx.blockHash !== block.hash ||
      !tx.to || !isAddressEqual(tx.to, escrow) || !isAddressEqual(tx.from, draft.from) || tx.input !== data ||
      !events.some(event => event.args.evidenceHash === evidenceHash && isAddressEqual(event.args.author, draft.from))) {
    throw new WorkflowError(409, 'Giao dịch bổ sung bằng chứng không khớp hồ sơ tranh chấp.');
  }
  const { [evidenceHash]: published, ...drafts } = project.fesc.supplementalEvidenceDrafts;
  const usedIds = new Set(project.dispute.evidence.map(item => item.id));
  const items = published.items.filter(item => !usedIds.has(item.id));
  const next = markEvidenceUsed({ ...project,
    fesc: { ...project.fesc, supplementalEvidenceDrafts: drafts },
    dispute: { ...project.dispute, evidence: [...project.dispute.evidence, ...items],
      evidenceAnchors: { ...project.dispute.evidenceAnchors, [evidenceHash]: receipt.transactionHash } },
    adminReview: { ...project.adminReview, history: project.adminReview?.history ?? [], status: 'reviewing',
      revision: (project.adminReview?.revision ?? 0) + 1 },
  }, items);
  await writes.saveProject(next);
  return next;
}

export async function syncSupplementalEvidence(writes, project, { escrow, blockNumber }) {
  const drafts = Object.entries(project.fesc?.supplementalEvidenceDrafts ?? {}).filter(([, draft]) => forCurrentDispute(project, draft));
  if (!drafts.length) return project;
  const pending = new Map(drafts);
  const events = await rpc.getContractEvents({ address: escrow, abi: escrowAbi, eventName: 'EvidenceAdded',
    args: { evidenceHash: [...pending.keys()] }, fromBlock: BigInt(project.fesc.deployment.startBlock),
    toBlock: blockNumber, strict: true });
  for (const event of events) {
    const draft = pending.get(event.args.evidenceHash);
    if (draft && isAddressEqual(event.args.author, draft.from)) {
      project = await publishSupplementalEvidence(writes, project, escrow, event.args.evidenceHash, draft, event.transactionHash);
      pending.delete(event.args.evidenceHash);
    }
  }
  return project;
}

export async function supplementalEvidence(root, writes, project, actor, input) {
  if (input.action === 'confirm' && /^0x[0-9a-f]{64}$/i.test(input.hash) && /^0x[0-9a-f]{64}$/i.test(input.evidenceHash) &&
      evidenceAnchor(project, input.evidenceHash) === input.hash) return { confirmed: true };
  if (project.status !== 'Disputed' || !project.dispute || !project.fesc) {
    throw new WorkflowError(409, 'Chỉ bổ sung bằng chứng khi dự án đang tranh chấp.');
  }
  const chain = await adminFescCase(root, project);
  if (input.action === 'confirm') {
    const draft = project.fesc.supplementalEvidenceDrafts?.[input.evidenceHash];
    if (typeof input.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(input.hash) || !draft ||
        draft.actorId !== actor.id || !forCurrentDispute(project, draft)) throw new WorkflowError(409, 'Bản bổ sung bằng chứng đã đổi.');
    await publishSupplementalEvidence(writes, project, chain.escrow, input.evidenceHash, draft, input.hash);
    return { confirmed: true };
  }
  if (input.action !== 'prepare') throw new WorkflowError(400, 'Yêu cầu bổ sung bằng chứng không hợp lệ.');
  if (chain.state !== 4 || project.milestones[chain.current]?.id !== project.dispute.milestoneId) {
    throw new WorkflowError(409, 'Tranh chấp trên Hardhat đã thay đổi. Hãy làm mới hồ sơ.');
  }
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 2000) throw new WorkflowError(400, 'Ghi chú chỉ được tối đa 2000 ký tự.');
  const items = pickEvidence(project, actor, input.evidenceIds, input.links).map(item => ({ ...item, note, added: true }));
  const from = actor.id === project.ownerId ? project.fesc.client : project.fesc.freelancer;
  const wallet = await writes.getWalletLink(actor.id);
  if (!wallet || wallet.chainId !== localChain.id || !isAddressEqual(wallet.address, from)) {
    throw new WorkflowError(409, 'Hãy dùng ví đã ký hợp đồng để bổ sung bằng chứng.');
  }
  const evidenceHash = hash(['FESC supplemental evidence', chain.escrow, project.dispute.openedAt,
    project.dispute.milestoneId, from, note, evidenceFingerprint(items)]);
  const call = { address: chain.escrow, abi: escrowAbi, functionName: 'addEvidence', args: [evidenceHash] };
  if (!(await rpc.getBalance({ address: from }))) throw new WorkflowError(409, 'Ví cần ETH thử để trả phí gas trên Hardhat.');
  try { await rpc.simulateContract({ ...call, account: from, blockTag: 'pending' }); }
  catch { throw new WorkflowError(409, 'Tranh chấp đã thay đổi hoặc bằng chứng đã được gửi. Hãy làm mới hồ sơ.'); }
  const drafts = Object.fromEntries(Object.entries(project.fesc.supplementalEvidenceDrafts ?? {}).filter(([, draft]) => forCurrentDispute(project, draft)));
  if (!drafts[evidenceHash] && Object.values(drafts).filter(draft => draft.actorId === actor.id).length >= 24) {
    throw new WorkflowError(409, 'Hồ sơ có quá nhiều lượt bổ sung đang chờ. Hãy hoàn tất giao dịch đã tạo trong MetaMask.');
  }
  drafts[evidenceHash] ??= { actorId: actor.id, from, items, disputeAt: project.dispute.openedAt, milestoneId: project.dispute.milestoneId };
  await writes.saveProject({ ...project, fesc: { ...project.fesc, supplementalEvidenceDrafts: drafts } });
  const { startBlock, startBlockHash } = project.fesc.deployment;
  return { evidenceHash, transaction: { from, to: chain.escrow, data: encodeFunctionData(call),
    deploymentBlock: numberToHex(BigInt(startBlock)), deploymentBlockHash: startBlockHash } };
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

// Explains why an admin cannot verify a project's contract from this machine.
export async function chainUnavailableMessage(root, project) {
  let configured;
  try { configured = JSON.parse(await readFile(resolve(root, '.hardhat/local-fesc-deployment.json'), 'utf8')); } catch { configured = undefined; }
  const pinned = project.fesc?.deployment?.instanceKey;
  if (!project.fesc) return 'Dự án chưa tạo hợp đồng FESC nên chưa có giao dịch để phân xử.';
  if (configured?.instanceKey && pinned && configured.instanceKey !== pinned) {
    return `Dự án này nằm trên một blockchain local khác (mã triển khai ${pinned.slice(0, 10)}…), thường là máy của thành viên đã tạo dự án hoặc chain đã triển khai lại. Hãy mở trang quản trị trên máy đang chạy blockchain đó để phân xử; ở đây chỉ gửi được phản hồi.`;
  }
  return 'Không kết nối được Hardhat Local hoặc hợp đồng chưa khớp. Chạy npm.cmd run chain:node rồi mở lại hồ sơ.';
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

function creationDeadline(fesc, now) {
  const normal = now + 30n * 60n;
  if (fesc.policyVersion !== 2) return normal;
  // The first agreed due date must leave 48 hours for funding and 7 days to start.
  const latest = BigInt(fesc.baseDues[0]) - 9n * day - 1n;
  return latest < normal && latest > now ? latest : normal;
}

function deliveryHash(project, milestone, delivery = milestone.deliveries?.at(-1)) {
  if (!delivery?.preview?.sha256) {
    throw new WorkflowError(409, 'Chưa có bản bàn giao hợp lệ cho milestone FESC.');
  }
  return hash([project.fesc.deployment.instanceKey, project.fesc.reference?.projectId ?? project.id, milestone.id, delivery.id, delivery.version,
    delivery.note, delivery.preview.sha256, delivery.original?.sha256]);
}

async function verifyWorkEvent(logs, eventName, index, sender, hashField, expected) {
  const milestone = BigInt(index);
  const events = await rpc.getContractEvents({ ...logs, eventName, args: { milestone } });
  const event = expected === undefined ? events.at(-1) : events.findLast(log => log.args[hashField] === expected);
  const invalid = () => new WorkflowError(503, 'Chưa xác minh được giao dịch cập nhật bàn giao trên Hardhat.');
  if (!event) throw invalid();
  const [receipt, tx, block] = await Promise.all([
    rpc.getTransactionReceipt({ hash: event.transactionHash }), rpc.getTransaction({ hash: event.transactionHash }),
    rpc.getBlock({ blockNumber: event.blockNumber }),
  ]);
  const workLogs = parseEventLogs({ abi: escrowAbi, eventName, strict: true,
    logs: receipt.logs.filter(log => isAddressEqual(log.address, logs.address)) });
  if (receipt.status !== 'success' || receipt.blockHash !== event.blockHash || receipt.blockHash !== block.hash ||
      tx.blockHash !== receipt.blockHash || !isAddressEqual(tx.from, sender) || !tx.to || !isAddressEqual(tx.to, logs.address) ||
      !workLogs.some(log => log.args.milestone === milestone && log.args[hashField] === event.args[hashField])) throw invalid();
  return { args: event.args, at: isoTime(block.timestamp), hash: receipt.transactionHash };
}

async function reconcileWork(writes, project, logs, index, milestone, onChain, state) {
  const [,,, stage,, revisions, evidence] = onChain;
  const { client, freelancer } = project.fesc;
  const latest = milestone.deliveries?.at(-1);
  const legacy = milestone.status === 'Submitted' && latest?.preview?.sha256 && !latest.submissionTx && !latest.pending;
  const draft = getPendingDelivery(milestone) ?? (legacy ? latest : undefined);
  if (draft && evidence === deliveryHash(project, milestone, draft)) {
    const { at: submittedAt, hash: submissionTx } = await verifyWorkEvent(logs, 'Submitted', index, freelancer, 'evidenceHash', evidence);
    const { pending, ...delivery } = draft;
    milestone = { ...milestone, status: 'Submitted', submission: delivery.note, submissionVersion: delivery.version,
      deliveries: [...milestone.deliveries.slice(0, -1), { ...delivery, submittedAt, submissionTx }] };
    project = { ...project, status: 'Submitted', milestones: project.milestones.map((item, i) => i === index ? milestone : item) };
    await writes.saveProject(project);
  } else if (legacy && state === 3 && stage === 1) {
    const previous = milestone.deliveries.at(-2);
    milestone = { ...milestone, status: 'In progress', submission: previous?.note, submissionVersion: previous?.version ?? 0,
      deliveries: [...milestone.deliveries.slice(0, -1), { ...draft, submittedAt: undefined, pending: true }] };
    project = { ...project, status: 'In progress', milestones: project.milestones.map((item, i) => i === index ? milestone : item) };
    await writes.saveProject(project);
  }
  if (state === 3 && stage === 3 && (milestone.status !== 'Revision requested' || milestone.revisionCount !== revisions)) {
    const { args: { reasonHash } } = await verifyWorkEvent(logs, 'RevisionRequested', index, client, 'reasonHash');
    const revisionReason = project.fesc.revisionDrafts?.[reasonHash] ?? 'Client đã yêu cầu chỉnh sửa trên Hardhat.';
    project = { ...project, status: 'Revision requested', milestones: project.milestones.map((item, i) =>
      i === index ? { ...item, status: 'Revision requested', revisionCount: revisions, revisionReason } : item) };
    await writes.saveProject(project);
  }
  return project;
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

async function confirmedClosure(project, { escrow, blockNumber, version, closure }) {
  const { deployment, client, freelancer } = project.fesc;
  const rule = closureRules[closure];
  const events = await rpc.getContractEvents({ address: escrow, abi: escrowAbi, eventName: 'StateChanged',
    fromBlock: BigInt(deployment.startBlock), toBlock: blockNumber, strict: true });
  const matchesClosure = ({ args }) => args.state === closedState && args.closure === closure && args.version === version;
  const event = events.findLast(matchesClosure);
  const invalid = () => new WorkflowError(503, 'Chưa xác minh được giao dịch hủy hợp đồng FESC.');
  if (!event) throw invalid();
  const [receipt, tx, block] = await Promise.all([
    rpc.getTransactionReceipt({ hash: event.transactionHash }), rpc.getTransaction({ hash: event.transactionHash }),
    rpc.getBlock({ blockNumber: event.blockNumber }),
  ]);
  const signers = rule.clientOnly ? [client] : [client, freelancer];
  if (receipt.status !== 'success' || receipt.transactionHash !== event.transactionHash || receipt.blockNumber !== event.blockNumber ||
      receipt.blockHash !== event.blockHash || block.hash !== receipt.blockHash || !block.transactions.includes(event.transactionHash) ||
      tx.blockHash !== receipt.blockHash || !tx.to || !isAddressEqual(tx.to, escrow) ||
      !signers.some(address => isAddressEqual(tx.from, address)) ||
      decodeFunctionData({ abi: escrowAbi, data: tx.input }).functionName !== rule.method) throw invalid();
  const logs = receipt.logs.filter(log => isAddressEqual(log.address, escrow));
  if (!parseEventLogs({ abi: escrowAbi, eventName: 'StateChanged', logs, strict: true }).some(matchesClosure)) throw invalid();
  const refunds = parseEventLogs({ abi: escrowAbi, eventName: 'Allocated', logs, strict: true });
  if (!rule.refund && refunds.length > 0) throw invalid();
  const first = rule.refund ? Number(refunds[0]?.args.milestone) : 0;
  if (rule.refund && (!Number.isSafeInteger(first) || first < 0 || first >= project.milestones.length ||
      (rule.reason === 'startExpired' && first !== 0) ||
      refunds.length !== project.milestones.length - first || refunds.some(({ args }, index) =>
        args.milestone !== BigInt(first + index) || args.outcome !== refundedOutcome ||
        args.toFreelancer !== 0n || args.toClient !== units(project.milestones[first + index].amount)))) throw invalid();
  return { first, hash: receipt.transactionHash, reason: rule.reason, refund: rule.refund };
}

async function reconcile(writes, project, chain) {
  const { deployment, client, freelancer } = project.fesc;
  const { escrow, funded, state, current, blockNumber, cancellation } = chain;
  const clientActor = { id: project.ownerId, role: 'Client' };
  const token = deployment.token;
  const logs = { address: escrow, abi: escrowAbi, fromBlock: BigInt(deployment.startBlock), toBlock: blockNumber, strict: true };

  async function record(input, receipt) {
    const result = applyProjectAction(project, clientActor, input);
    project = input.action === 'fund' ? { ...result.project, unfundedCancellation: undefined } : result.project;
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

  let milestone = currentMilestone(project);
  // The cursor also advances after arbitration. Verify its allocation instead of treating it as a Client approval.
  const settledUntil = cancellation ? BigInt(cancellation.first) : current;
  while (milestone) {
    const index = project.milestones.indexOf(milestone);
    const ordinal = BigInt(index);
    if (project.status === 'Disputed' && milestone.status === 'Disputed' && settledUntil > ordinal) {
      const events = await rpc.getContractEvents({ ...logs, eventName: 'Allocated', args: { milestone: ordinal } });
      const event = events.find(entry => entry.args.outcome === arbitratedOutcome);
      if (!event) throw new WorkflowError(409, 'Chưa xác minh được phân bổ FESC của khiếu nại.');
      project = await syncSupplementalEvidence(writes, project, { escrow, blockNumber: event.blockNumber });
      const resolution = await confirmedArbitration(project, { escrow, index, arbitrator: deployment.accounts.arbitrator,
        hash: event.transactionHash, event });
      project = await recordFescArbitration(writes, resolution);
      milestone = currentMilestone(project);
      continue;
    }
    if (getPendingDelivery(milestone) || milestone.status === 'Submitted' || (state === 3 && current === ordinal)) {
      const onChain = await rpc.readContract({ address: escrow, abi: escrowAbi, functionName: 'milestones', args: [ordinal], blockNumber });
      project = await reconcileWork(writes, project, logs, index, milestone, onChain, state);
      milestone = project.milestones[index];
    }
    if (settledUntil <= ordinal) break;
    if (milestone.status !== 'Submitted') throw new WorkflowError(409, 'Milestone trên Hardhat không khớp bản bàn giao trên website.');
    const amount = units(milestone.amount);
    const [event] = await rpc.getContractEvents({ ...logs, eventName: 'MilestonePaid', args: { milestone: BigInt(index) } });
    if (event?.args.amount !== amount || event.args.evidenceHash !== deliveryHash(project, milestone)) {
      throw new WorkflowError(409, 'Chưa xác minh được giải ngân FESC cho đúng bản bàn giao.');
    }
    await record({ action: 'approve', milestoneId: milestone.id, submissionVersion: getSubmissionVersion(milestone) },
      await confirmTransfer({ event, escrow, token, client, from: escrow, to: freelancer, amount }));
    milestone = currentMilestone(project);
  }
  const active = currentMilestone(project);
  if (cancellation) {
    if (project.milestones.indexOf(active) !== cancellation.first || project.status === 'Disputed' ||
        funded !== (cancellation.refund ? units(project.budget) : 0n)) {
      throw new WorkflowError(409, 'Các giai đoạn đã xử lý chưa khớp với giao dịch hủy FESC.');
    }
    project = { ...project, status: 'Cancelled', extensionRequest: undefined, unfundedCancellation: undefined,
      cancellation: { hash: cancellation.hash, reason: cancellation.reason },
      milestones: project.milestones.map((item, index) => index < cancellation.first ? item :
        { ...item, status: cancellation.refund ? 'Refunded' : 'Voided' }) };
    await writes.saveProject(project);
  }
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
    const request = project.extensionRequest;
    if (request && (state === closedState || (!request.whole && project.milestones.findIndex(item => item.id === request.milestoneId) < Number(current)))) {
      project = { ...project, extensionRequest: undefined };
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

const isCancellationAction = action => action === 'proposeCancel' || action === 'confirmCancel';

function unfundedCancellationStatus(project, owner, { walletRequired = false, availableAt } = {}) {
  const request = project.unfundedCancellation;
  const active = request && Date.parse(request.expiresAt) >= Date.now();
  return { kind: 'unfunded', phase: active ? (owner ? 'confirm' : 'pending') : (owner ? 'idle' : 'propose'),
    ...(active ? { requestId: request.id, expiresAt: request.expiresAt, proposer: 'Freelancer' } : {}),
    walletRequired: active && owner && walletRequired, ...(active && owner && availableAt ? { availableAt } : {}) };
}

async function updateUnfundedCancellation(writes, project, owner, input, cancellation) {
  if (input.action === 'proposeCancel') {
    if (owner) throw new WorkflowError(403, 'Yêu cầu hủy trước ký quỹ do Freelancer đã được chọn gửi.');
    if (cancellation.phase !== 'propose') throw new WorkflowError(409, 'Đã có đề nghị hủy đang chờ Client phản hồi.');
    const request = { id: randomUUID(), expiresAt: new Date(Date.now() + 3 * Number(day) * 1000).toISOString() };
    await writes.saveProject({ ...project, unfundedCancellation: request });
    return { updated: true };
  }
  if (!owner) throw new WorkflowError(403, 'Chỉ Client được xác nhận đề nghị hủy này.');
  if (cancellation.phase !== 'confirm' || input.cancelRequestId !== cancellation.requestId) {
    throw new WorkflowError(409, 'Đề nghị hủy đã đổi hoặc hết hiệu lực. Hãy làm mới dự án.');
  }
  if (cancellation.availableAt) throw new WorkflowError(409, 'Chờ yêu cầu tạo hợp đồng hết hạn hoặc đóng hợp đồng trên Hardhat nếu đã được tạo.');
  if (cancellation.walletRequired) return undefined;
  await writes.saveProject({ ...project, status: 'Cancelled', extensionRequest: undefined, unfundedCancellation: undefined,
    cancellation: { reason: 'beforeContract' },
    milestones: project.milestones.map(item => ({ ...item, status: 'Voided' })) });
  return { updated: true };
}

export async function projectFesc(root, writes, project, actor, input = {}) {
  const { action, milestoneId, submissionVersion, note } = input;
  const owner = actor.role === 'Client' && actor.id === project.ownerId;
  const assignee = actor.role === 'Freelancer' && actor.id === project.freelancerId;
  if (project.currency !== 'FESC' || (!owner && !assignee)) throw new WorkflowError(404, 'Dự án FESC không tồn tại.');
  const status = { step: 'waiting', message: '', projectStatus: project.status, paid: project.paid };
  if (project.status === 'Cancelled' && project.cancellation?.reason === 'beforeContract') {
    if (action) throw new WorkflowError(409, 'Dự án đã được hủy trước khi tạo hợp đồng.');
    return { ...status, step: 'complete', message: 'Dự án đã hủy theo đề nghị của Freelancer trước khi tạo hợp đồng FESC.' };
  }
  if (await belongsToPreviousChain(root, project.fesc?.deployment)) {
    const message = 'Dự án thuộc một blockchain local trước đây. Dữ liệu dự án vẫn được giữ, nhưng số dư và giao dịch cũ không thể xác minh trên blockchain hiện tại. Cần khôi phục blockchain cũ để tiếp tục dự án này.';
    if (action) throw new WorkflowError(409, message);
    return { ...status, step: 'unavailable', historical: true, message, token: project.fesc.deployment.token };
  }
  if (!project.freelancerId) {
    if (action) throw new WorkflowError(409, 'Chọn Freelancer để tạo hợp đồng FESC.');
    return { ...status, message: 'Chọn Freelancer để tạo hợp đồng FESC.' };
  }

  if (!project.fesc && project.status === 'Proposal sent' && !project.funded) {
    status.cancellation = unfundedCancellationStatus(project, owner);
    if (isCancellationAction(action)) return updateUnfundedCancellation(writes, project, owner, input, status.cancellation);
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
  // Policy 2 (agreed due dates, 5-day review, extensions, continue-arbitration) needs a factory that
  // reports it on chain; dated projects refuse to fall back to the old rules.
  let fesc = project.fesc;
  if (!fesc) {
    const dated = project.milestones.every(item => item.dueAt);
    const [policySupport, revision] = await Promise.all(['LATEST_POLICY_VERSION', 'FACTORY_REVISION'].map(name =>
      read(factory, factoryAbi, name).catch(error => {
        if (error.walk?.(cause => ['ContractFunctionZeroDataError', 'ContractFunctionRevertedError'].includes(cause.name))) return 1;
        throw error;
      })));
    const supported = policySupport >= 2 && revision >= 2;
    if (dated && !supported) {
      throw new WorkflowError(409, 'Factory FESC hiện tại chưa hỗ trợ thời hạn mới. Chạy npm.cmd run chain:upgrade:fesc-factory.');
    }
    fesc = { deployment, client, freelancer,
      ...(dated ? { policyVersion: 2, baseDues: project.milestones.map(item => String(Math.floor(Date.parse(item.dueAt) / 1000))) } : {}) };
    fesc.createBy = creationDeadline(fesc, block.timestamp).toString();
  }
  const policy = fesc.policyVersion ?? 1;
  status.policyVersion = policy;
  if (fesc.client !== client || fesc.freelancer !== freelancer) throw new WorkflowError(409, 'Ví dự án không còn khớp với hợp đồng FESC.');
  let terms = buildTerms(project, fesc);
  const escrow = await read(factory, factoryAbi, 'escrowFor', [client, terms.agreementRef]);
  const creationTime = escrow === zeroAddress ? (await rpc.getBlock({ blockTag: 'pending' })).timestamp : block.timestamp;
  const quoteExpired = creationTime > terms.createBy;
  if (escrow === zeroAddress && quoteExpired) {
    // Look for a creation mined since the snapshot before replacing the expired quote.
    const latestEscrow = await rpc.readContract({ address: factory, abi: factoryAbi, functionName: 'escrowFor',
      args: [client, terms.agreementRef], blockTag: 'pending' });
    if (latestEscrow !== zeroAddress) throw new WorkflowError(409, 'Hợp đồng vừa được tạo. Hãy làm mới dự án.');
    fesc = { ...fesc, createBy: creationDeadline(fesc, creationTime).toString() };
    terms = buildTerms(project, fesc);
  }
  const termsHash = await read(factory, factoryAbi, 'hashTerms', [client, terms]);

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
    if (project.status === 'Proposal sent' && !project.funded) {
      // While a previously issued creation transaction can still land, wait for it to expire or close the resulting escrow.
      const availableAt = project.fesc && !quoteExpired ? isoTime(project.fesc.createBy) : undefined;
      status.cancellation = unfundedCancellationStatus(project, owner, { availableAt });
    }
    // Contract creation needs ≥ 48h funding + 7 days to start before the first agreed due date.
    const tooSoon = policy === 2 && BigInt(fesc.baseDues[0]) <= creationTime + 9n * day;
    if (tooSoon) step('waiting', owner ? 'Hạn mốc đầu cần cách hiện tại hơn 9 ngày để đủ thời gian ký quỹ và bắt đầu. Hãy gia hạn mốc đầu bên dưới.'
      : 'Đang chờ Client cập nhật hạn mốc đầu trước khi tạo hợp đồng.');
    else if (owner) step('create', 'Tạo hợp đồng theo ngân sách, milestone và thời hạn của dự án.',
      { address: factory, abi: factoryAbi, functionName: 'createEscrow', args: [terms, termsHash] });
    else step('waiting', 'Đang chờ Client tạo hợp đồng FESC.');
    // A valid creation quote may be awaiting a signature in another browser tab.
    // Editing its terms would leave a contract created with that quote unmatched.
    status.canExtend = owner && policy === 2 && (!project.fesc || quoteExpired);
    if (owner && policy === 2 && project.fesc && !quoteExpired) status.actionDeadline = isoTime(terms.createBy);
  } else {
    const [actualTermsHash, state, current, version, funded, held, claimable] = await Promise.all([
      read(escrow, escrowAbi, 'termsHash'), read(escrow, escrowAbi, 'state'), read(escrow, escrowAbi, 'current'),
      read(escrow, escrowAbi, 'version'), read(escrow, escrowAbi, 'funded'), read(token, tokenAbi, 'balanceOf', [escrow]),
      read(escrow, escrowAbi, 'claimable', [wallet.address]),
    ]);
    chainState = { state, current, version, claimable };
    if (!project.fesc || actualTermsHash !== termsHash) throw new WorkflowError(409, 'Điều khoản trên Hardhat không khớp với dự án FESC.');
    const closure = state === closedState && !['Completed', 'Cancelled'].includes(project.status)
      ? await read(escrow, escrowAbi, 'closure') : 0;
    const cancellation = closureRules[closure] ? await confirmedClosure(project, { escrow, blockNumber, version, closure }) : undefined;
    const previousProjection = project;
    project = await reconcile(writes, project, { escrow, funded, state, current, blockNumber, cancellation });
    Object.assign(status, { escrow, held: formatUnits(held, 18), projectStatus: project.status, paid: project.paid,
      claimable: formatUnits(claimable, 18), ...(project !== previousProjection ? { workspaceChanged: true } : {}) });
    const nextTime = state < 4 ? (await rpc.getBlock({ blockTag: 'pending' })).timestamp : block.timestamp;
    const actionDeadline = state < 2 ? await read(escrow, escrowAbi, 'fundDeadline')
      : state === 2 ? await read(escrow, escrowAbi, 'startDeadline') : undefined;
    const expired = actionDeadline !== undefined && nextTime > actionDeadline;
    if (actionDeadline !== undefined) status.actionDeadline = isoTime(actionDeadline);
    status.canExtend = owner && policy === 2 && !expired && (state === 2 || state === 3);
    status.canRequestExtension = assignee && policy === 2 && !expired && (state === 2 || state === 3);
    if (!funded && state < 2 && project.status === 'Proposal sent') {
      status.cancellation = unfundedCancellationStatus(project, owner, { walletRequired: true });
    }
    if (state === 2 || state === 3) {
      const [[author, expiresAt, offerVersion, digest, settlement], unallocated] = await Promise.all([
        read(escrow, escrowAbi, 'offer'), read(escrow, escrowAbi, 'unallocated'),
      ]);
      status.cancellation = { kind: 'funded', phase: 'propose', amount: formatUnits(unallocated, 18), version: version.toString() };
      if (author !== zeroAddress && expiresAt >= nextTime && offerVersion === version) {
        const fromClient = isAddressEqual(author, client);
        if (!settlement && (fromClient || isAddressEqual(author, freelancer))) {
          const nonce = await read(escrow, escrowAbi, 'offerNonce');
          Object.assign(status.cancellation, { phase: isAddressEqual(author, wallet.address) ? 'pending' : 'confirm',
            proposer: fromClient ? 'Client' : 'Freelancer', nonce: nonce.toString(), digest,
            expiresAt: isoTime(expiresAt) });
        } else Object.assign(status.cancellation, { phase: 'other', expiresAt: isoTime(expiresAt) });
      }
    }
    if (expired && state < 2) {
      step('expireFunding', 'Đã quá hạn chấp nhận hoặc ký quỹ. Một trong hai bên có thể đóng hợp đồng. Khoản ký quỹ chưa được nạp.',
        escrowCall('expireFunding'));
    } else if (expired && state === 2) {
      if (owner) step('expireStart', 'Freelancer chưa bắt đầu đúng hạn. Đóng hợp đồng để nhận quyền rút lại tiền ký quỹ.', escrowCall('expireStart'));
      else step('waiting', 'Đã quá hạn bắt đầu công việc. Client có thể đóng hợp đồng để rút lại tiền ký quỹ.');
    } else if (state === 0) {
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
      const [[, baseDeadline, deadline, stage, , revisions, evidence], cancelDeadline] = await Promise.all([
        read(escrow, escrowAbi, 'milestones', [current]), read(escrow, escrowAbi, 'firstCancelExpiry'),
      ]);
      status.disputeOptions = disputeOptions(owner, policy, stage, deadline, nextTime);
      if (cancelDeadline > 0n) status.disputeOptions.push({ kind: 3, label: disputeLabels[3], available: nextTime > cancelDeadline,
        hint: `Có thể khiếu nại sau ${timeText(cancelDeadline)} nếu hai bên chưa thống nhất hủy.` });
      status.canDispute = status.disputeOptions.some(option => option.available);
      status.deadline = isoTime(deadline);
      status.reviewing = stage === 2;
      status.milestoneId = milestone.id;
      status.submissionVersion = getSubmissionVersion(milestone);
      const late = nextTime > deadline;
      if (stage === 1 || stage === 3) {
        const resubmitting = stage === 3;
        const draft = getPendingDelivery(milestone);
        if (late) step('waiting', assignee ? 'Đã quá hạn giai đoạn này. Gửi yêu cầu gia hạn để Client xem xét.'
          : 'Freelancer đã quá hạn giai đoạn. Bạn có thể gia hạn hoặc khiếu nại.');
        else if (!assignee) step('waiting', resubmitting ? 'Đang chờ Freelancer gửi bản chỉnh sửa.' : 'Đang chờ Freelancer bàn giao milestone.');
        else if (draft) {
          status.submissionVersion = draft.version;
          step('submit', 'Đã lưu tệp. Xác nhận bàn giao trong MetaMask.',
            escrowCall('submit', [current, version, deliveryHash(project, milestone, draft)]));
        } else step('upload', resubmitting ? 'Tải bản chỉnh sửa để Client xem và nghiệm thu.' : 'Tải bản bàn giao để Client xem và nghiệm thu.');
      } else if (stage === 2 && evidence === deliveryHash(project, milestone)) {
        if (owner) {
          status.canRequestRevision = revisions < 2 && !late && (policy !== 2 || nextTime <= baseDeadline);
          step('approve', late
            ? `Đã quá hạn nghiệm thu. Bạn vẫn có thể xem và nghiệm thu bản hiện hành để chuyển ${milestone.amount} FESC cho Freelancer.`
            : `Xem bản bàn giao bên dưới và nghiệm thu trước ${timeText(deadline)}. Nghiệm thu sẽ chuyển ${milestone.amount} FESC vào ví Freelancer.`,
            escrowCall('approveAndPayMilestone', [current, version]));
        } else step('waiting', `Đã bàn giao. Client cần nghiệm thu trước ${timeText(deadline)}.`);
      } else throw new WorkflowError(409, 'Bản bàn giao trên Hardhat không khớp với dữ liệu dự án.');
    } else if (state === 4) {
      if (project.status !== 'Disputed') {
        const events = await rpc.getContractEvents({ address: escrow, abi: escrowAbi, eventName: 'DisputeOpened',
          fromBlock: BigInt(deployment.startBlock), toBlock: blockNumber });
        const opened = events.findLast(event => event.args.milestone === current);
        if (!opened) throw new WorkflowError(503, 'Chưa xác minh được sự kiện khiếu nại FESC.');
        const openedReceipt = await rpc.getTransactionReceipt({ hash: opened.transactionHash });
        if (openedReceipt.status !== 'success' || openedReceipt.blockHash !== opened.blockHash) {
          throw new WorkflowError(503, 'Chưa xác minh được giao dịch khiếu nại FESC.');
        }
        // Drafts are keyed by reason hash; older builds stored a single draft or an array of drafts.
        const stored = project.fesc.disputeDrafts;
        const legacy = [...(Array.isArray(stored) ? stored : []), project.fesc.disputeDraft]
          .find(item => item?.hash === opened.args.reasonHash);
        const draft = (!Array.isArray(stored) ? stored?.[opened.args.reasonHash] : undefined) ??
          (legacy ? { note: legacy.note, evidence: legacy.evidence ?? [] } : undefined);
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
      const updatedEvidence = await syncSupplementalEvidence(writes, project, { escrow, blockNumber });
      if (updatedEvidence !== project) status.workspaceChanged = true;
      project = updatedEvidence;
      step('waiting', 'Dự án đang tranh chấp. Admin sẽ xem bằng chứng và quyết định trên blockchain.');
    } else if (state === closedState && project.status === 'Cancelled') {
      const closed = {
        unfunded: 'Hợp đồng đã đóng trước khi ký quỹ.',
        fundingExpired: 'Hợp đồng đã đóng vì quá hạn ký quỹ.',
        startExpired: 'Hợp đồng đã đóng vì quá hạn bắt đầu công việc.',
        consent: 'Hợp đồng đã hủy theo đồng thuận của hai bên.',
        beforeContract: 'Dự án đã hủy trước khi tạo hợp đồng.',
      }[project.cancellation?.reason ?? 'consent'];
      if (claimable > 0n) step('withdraw', `${closed} Ví này có ${formatUnits(claimable, 18)} FESC chờ rút.`, escrowCall('withdraw'));
      else step('complete', closed);
    } else if (state === closedState && project.status === 'Completed') {
      if (claimable > 0n) step('withdraw', `Bạn được rút ${formatUnits(claimable, 18)} FESC theo quyết định phân xử.`, escrowCall('withdraw'));
      else step('complete', 'Dự án đã hoàn tất và không còn FESC chờ rút cho ví này.');
    } else step('waiting', 'Hợp đồng FESC đã ngừng nhận thao tác cho dự án.');
  }

  if (!action) return status;
  if (isCancellationAction(action)) {
    const cancellation = status.cancellation;
    if (!cancellation) throw new WorkflowError(409, 'Trạng thái hiện tại không cho phép đề nghị hoặc xác nhận hủy.');
    if (cancellation.kind === 'unfunded') {
      const updated = await updateUnfundedCancellation(writes, project, owner, input, cancellation);
      if (updated) return updated;
      call = escrowCall('cancelUnfunded');
    } else if (action === 'proposeCancel') {
      if (cancellation.phase !== 'propose' || input.cancelVersion !== cancellation.version) {
        throw new WorkflowError(409, 'Đề nghị hoặc trạng thái hợp đồng đã đổi. Hãy làm mới dự án.');
      }
      call = escrowCall('proposeCancel', [chainState.version, hash(['FESC cancellation', termsHash, cancellation.version])]);
    } else {
      if (cancellation.phase === 'pending') throw new WorkflowError(403, 'Chỉ bên còn lại được xác nhận đề nghị hủy.');
      if (cancellation.phase !== 'confirm' || input.cancelNonce !== cancellation.nonce || input.cancelDigest !== cancellation.digest) {
        throw new WorkflowError(409, 'Đề nghị hủy đã đổi hoặc hết hiệu lực. Hãy làm mới dự án.');
      }
      call = escrowCall('confirmOffer', [BigInt(cancellation.nonce), cancellation.digest]);
    }
    status.step = action;
  }
  if (action === 'withdraw' && status.step !== 'withdraw') {
    // After a "continue" arbitration the contract stays active while a share waits to be withdrawn.
    if (!chainState || chainState.claimable === 0n) throw new WorkflowError(409, 'Không có FESC chờ rút cho ví này.');
    step('withdraw', status.message, escrowCall('withdraw'));
  }
  let saveDraft;
  let revisionDraft;
  if (action === 'revise') {
    if (!owner) throw new WorkflowError(403, 'Chỉ Client được yêu cầu chỉnh sửa bàn giao.');
    if (!status.canRequestRevision) throw new WorkflowError(409, 'Yêu cầu chỉnh sửa cần bản bàn giao còn hạn và mỗi giai đoạn có tối đa hai lượt.');
    if (typeof note !== 'string' || note.trim().length < 3 || note.length > 2000) {
      throw new WorkflowError(400, 'Nhập lý do yêu cầu chỉnh sửa (3–2000 ký tự).');
    }
    const reasonHash = hash(['FESC revision', termsHash, milestoneId, chainState.version.toString(), submissionVersion, note.trim()]);
    revisionDraft = [reasonHash, note.trim()];
    call = escrowCall('requestRevision', [chainState.current, chainState.version, reasonHash]);
    status.step = 'revise';
  }
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
    const request = project.extensionRequest;
    if ((request || input.requestId !== undefined) && (!request || input.requestId !== request.id ||
        input.whole !== request.whole || milestoneId !== request.milestoneId || input.dueDate !== request.dueDate)) {
      throw new WorkflowError(409, 'Yêu cầu gia hạn đã đổi. Hãy làm mới dự án trước khi xác nhận.');
    }
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
  const targetsDelivery = ['submit', 'approve', 'revise'].includes(action);
  if (action !== status.step || !call || (targetsDelivery &&
      (milestoneId !== status.milestoneId || submissionVersion !== status.submissionVersion))) {
    throw new WorkflowError(409, 'Trạng thái dự án đã đổi. Hãy làm mới và kiểm tra bản bàn giao hiện hành.');
  }
  if (!gas) throw new WorkflowError(409, 'Ví cần ETH thử để trả phí gas trên Hardhat.');
  try {
    await rpc.simulateContract({ ...call, account: wallet.address, blockTag: 'pending' });
  } catch {
    throw new WorkflowError(409, 'Hardhat chưa chấp nhận giao dịch. Hãy làm mới và kiểm tra trạng thái, hạn thao tác và số dư.');
  }
  if (!project.fesc || (action === 'create' && fesc !== project.fesc)) await writes.saveProject({ ...project, fesc });
  else if (saveDraft) {
    // Keyed by reason hash so drafts from both parties can coexist until one is confirmed on chain.
    const drafts = Array.isArray(project.fesc.disputeDrafts) ? [] : Object.entries(project.fesc.disputeDrafts ?? {}).slice(-4);
    await writes.saveProject({ ...project, fesc: { ...project.fesc,
      disputeDrafts: Object.fromEntries([...drafts, [saveDraft.hash, saveDraft]]) } });
  } else if (revisionDraft) {
    const drafts = Object.entries(project.fesc.revisionDrafts ?? {}).slice(-4);
    await writes.saveProject({ ...project, fesc: { ...project.fesc, revisionDrafts: Object.fromEntries([...drafts, revisionDraft]) } });
  }
  return { from: wallet.address, to: call.address, data: encodeFunctionData(call),
    deploymentBlock: numberToHex(BigInt(deployment.startBlock)), deploymentBlockHash: deployment.startBlockHash };
}
