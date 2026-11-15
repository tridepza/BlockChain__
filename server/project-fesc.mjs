import {
  createPublicClient, encodeFunctionData, formatEther, formatUnits, http, isAddressEqual,
  keccak256, numberToHex, parseAbi, parseEventLogs, stringToHex, TransactionReceiptNotFoundError, zeroAddress,
} from 'viem';
import { hardhat } from 'viem/chains';
import { localChain } from '../src/local-chain.ts';
import { applyProjectAction, cents, currentMilestone, getSubmissionVersion, WorkflowError } from '../src/workflow.ts';
import { checkLocalDeployment } from './wallet.mjs';

const rpc = createPublicClient({ chain: hardhat, transport: http(localChain.rpcUrl, { timeout: 3500, retryCount: 0 }) });
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
  'event Funded(uint256 amount)',
  'event MilestonePaid(uint256 indexed milestone, bytes32 evidenceHash, uint256 amount)',
]);

export const fescActions = ['create', 'accept', 'reset', 'allow', 'fund', 'start', 'submit', 'approve'];

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

const transferEvent = tokenAbi.find(item => item.type === 'event' && item.name === 'Transfer');
const transferPageSize = 20;
const transferBlockWindow = 1000n;

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
    const end = boundary ? BigInt(boundary[2]) : head;
    const beforeIndex = boundary?.[3] === undefined ? undefined : Number(boundary[3]);
    if (end < first || end > head) throw new WorkflowError(400, 'Trang giao dịch nằm ngoài phạm vi block hiện tại.');
    const start = end - first >= transferBlockWindow ? end - transferBlockWindow + 1n : first;
    let logs;
    if (txHash) {
      const receipt = await rpc.getTransactionReceipt({ hash: txHash }).catch(error => {
        if (error instanceof TransactionReceiptNotFoundError) return undefined;
        throw error;
      });
      logs = receipt?.status === 'success' && receipt.blockNumber >= first
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
    const ordered = logs.filter(log => !log.removed && log.blockNumber <= end &&
      (log.blockNumber !== end || beforeIndex === undefined || log.logIndex < beforeIndex) &&
      !isAddressEqual(log.args.from, zeroAddress) && !isAddressEqual(log.args.to, zeroAddress))
      .sort((a, b) => a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1);
    const page = ordered.slice(0, transferPageSize);
    const blocks = new Map();
    for (const { blockHash } of page) {
      if (!blocks.has(blockHash)) blocks.set(blockHash, rpc.getBlock({ blockHash }));
    }
    const transfers = await Promise.all(page.map(async ({ transactionHash, logIndex, blockHash, blockNumber, args }) => ({
      hash: transactionHash, logIndex, block: blockNumber.toString(),
      time: new Date(Number((await blocks.get(blockHash)).timestamp) * 1000).toISOString(),
      from: args.from, to: args.to, amount: formatUnits(args.value, 18),
    })));
    const last = page.at(-1);
    const next = ordered.length > transferPageSize ? `${instanceKey}:${last.blockNumber}:${last.logIndex}`
      : !txHash && start > first ? `${instanceKey}:${start - 1n}` : null;
    return { token, transfers, next };
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

function buildTerms(project, { deployment, client, freelancer, createBy }) {
  const projectRef = hash(['FESC project', project.ownerId, project.id]);
  return {
    projectRef,
    agreementRef: hash([projectRef, deployment.instanceKey, project.freelancerId]),
    createBy: BigInt(createBy),
    freelancer,
    arbitrator: deployment.accounts.arbitrator,
    budgetUnits: units(project.budget),
    amounts: project.milestones.map(item => units(item.amount)),
    baseDues: project.milestones.map((_, index) => BigInt(createBy) + day * BigInt(30 + 7 * index)),
    policyVersion: 1,
    documentHash: hash([client, freelancer, project.title, project.description, project.category,
      project.milestones.map(({ id, title, amount }) => [id, title, cents(amount)])]),
  };
}

function deliveryHash(project, milestone) {
  const latest = milestone.deliveries?.at(-1);
  if (!latest?.preview?.sha256 || latest.version !== getSubmissionVersion(milestone)) {
    throw new WorkflowError(409, 'Chưa có bản bàn giao hợp lệ cho milestone FESC.');
  }
  return hash([project.fesc.deployment.instanceKey, project.id, milestone.id, latest.id, latest.version,
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
      currency: 'FESC', status: 'Đã xác nhận' });
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
  return project;
}

export async function projectFesc(root, writes, project, actor, { action, milestoneId, submissionVersion } = {}) {
  const owner = actor.role === 'Client' && actor.id === project.ownerId;
  const assignee = actor.role === 'Freelancer' && actor.id === project.freelancerId;
  if (project.currency !== 'FESC' || (!owner && !assignee)) throw new WorkflowError(404, 'Dự án FESC không tồn tại.');
  const status = { step: 'waiting', message: '', projectStatus: project.status, paid: project.paid };
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
  const fesc = project.fesc ?? { deployment, client, freelancer, createBy: (block.timestamp + 7n * day).toString() };
  if (fesc.client !== client || fesc.freelancer !== freelancer) throw new WorkflowError(409, 'Ví dự án không còn khớp với hợp đồng FESC.');
  const terms = buildTerms(project, fesc);
  const [escrow, termsHash] = await Promise.all([
    read(factory, factoryAbi, 'escrowFor', [client, terms.agreementRef]),
    read(factory, factoryAbi, 'hashTerms', [client, terms]),
  ]);

  let call;
  function step(next, message, transaction) {
    status.step = next;
    status.message = message;
    call = transaction;
  }
  function escrowCall(functionName, args = []) {
    return { address: escrow, abi: escrowAbi, functionName, args };
  }

  if (escrow === zeroAddress) {
    if (block.timestamp > terms.createBy) throw new WorkflowError(409, 'Hạn tạo hợp đồng đã hết. Hãy tạo dự án FESC mới.');
    if (owner) step('create', 'Tạo hợp đồng theo ngân sách và milestone của dự án.',
      { address: factory, abi: factoryAbi, functionName: 'createEscrow', args: [terms, termsHash] });
    else step('waiting', 'Đang chờ Client tạo hợp đồng FESC.');
  } else {
    const [actualTermsHash, state, current, version, funded, held] = await Promise.all([
      read(escrow, escrowAbi, 'termsHash'), read(escrow, escrowAbi, 'state'), read(escrow, escrowAbi, 'current'),
      read(escrow, escrowAbi, 'version'), read(escrow, escrowAbi, 'funded'), read(token, tokenAbi, 'balanceOf', [escrow]),
    ]);
    if (!project.fesc || actualTermsHash !== termsHash) throw new WorkflowError(409, 'Điều khoản trên Hardhat không khớp với dự án FESC.');
    project = await reconcile(writes, project, { escrow, funded, state, current, blockNumber });
    Object.assign(status, { escrow, held: formatUnits(held, 18), projectStatus: project.status, paid: project.paid });
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
      const [, , , stage, , , evidence] = await read(escrow, escrowAbi, 'milestones', [current]);
      status.milestoneId = milestone.id;
      status.submissionVersion = getSubmissionVersion(milestone);
      if (stage === 1 && milestone.status !== 'Submitted') {
        if (assignee) step('upload', 'Tải bản bàn giao để Client xem và nghiệm thu.');
        else step('waiting', 'Đang chờ Freelancer bàn giao milestone.');
      } else if (stage === 1 && milestone.status === 'Submitted') {
        if (assignee) step('submit', 'Đã lưu tệp. Xác nhận bàn giao trong MetaMask.',
          escrowCall('submit', [current, version, deliveryHash(project, milestone)]));
        else step('waiting', 'Đang chờ Freelancer xác nhận bàn giao trên Hardhat.');
      } else if (stage === 2 && evidence === deliveryHash(project, milestone)) {
        if (owner) {
          step('approve', `Xem bản bàn giao bên dưới. Nghiệm thu sẽ chuyển ${milestone.amount} FESC vào ví Freelancer.`,
            escrowCall('approveAndPayMilestone', [current, version]));
        } else step('waiting', 'Đã bàn giao. Đang chờ Client nghiệm thu và giải ngân.');
      } else throw new WorkflowError(409, 'Bản bàn giao trên Hardhat không khớp với dữ liệu dự án.');
    } else if (state === 5 && project.status === 'Completed') {
      step('complete', 'Đã chuyển FESC của tất cả milestone vào ví Freelancer.');
    } else step('waiting', 'Hợp đồng FESC đã ngừng nhận thao tác cho dự án.');
  }

  if (!action) return status;
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
  return { from: wallet.address, to: call.address, data: encodeFunctionData(call),
    deploymentBlock: numberToHex(BigInt(deployment.startBlock)), deploymentBlockHash: deployment.startBlockHash };
}
