import {
  createPublicClient, createWalletClient, encodeFunctionData, formatEther, formatUnits, getAddress, http,
  isAddressEqual, keccak256, parseAbi, parseEventLogs, parseUnits, sha256, stringToHex, zeroAddress,
} from 'viem';
import { hardhat } from 'viem/chains';
import { localChain } from '../src/local-chain.ts';
import { WorkflowError } from '../src/workflow.ts';
import { checkLocalDeployment } from './wallet.mjs';

const transport = http(localChain.rpcUrl, { timeout: 3500, retryCount: 0 });
const rpc = createPublicClient({ chain: hardhat, transport });
const amount = parseUnits('100', 6);
const factoryAbi = parseAbi([
  'struct Terms { bytes32 projectRef; bytes32 agreementRef; uint64 createBy; address freelancer; address arbitrator; uint256 budgetUnits; uint256[] amounts; uint64[] baseDues; uint32 policyVersion; bytes32 documentHash; }',
  'function escrowFor(address client, bytes32 agreementRef) view returns (address)',
  'function hashTerms(address client, Terms terms) view returns (bytes32)',
  'function createEscrow(Terms terms, bytes32 expectedTermsHash) returns (address)',
  'function token() view returns (address)',
]);
const tokenAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const escrowAbi = parseAbi([
  'function state() view returns (uint8)',
  'function total() view returns (uint256)',
  'function termsHash() view returns (bytes32)',
  'function freelancer() view returns (address)',
  'function arbitrator() view returns (address)',
  'function accept(bytes32 expectedHash)',
  'function fund()',
  'event Funded(uint256 amount)',
]);

async function confirmedFunding(address, owner, token, event) {
  const [receipt, transaction, block] = await Promise.all([
    rpc.getTransactionReceipt({ hash: event.transactionHash }),
    rpc.getTransaction({ hash: event.transactionHash }),
    rpc.getBlock({ blockNumber: event.blockNumber }),
  ]);
  const escrowLogs = receipt.logs.filter(log => isAddressEqual(log.address, address));
  const tokenLogs = receipt.logs.filter(log => isAddressEqual(log.address, token));
  const funded = parseEventLogs({ abi: escrowAbi, logs: escrowLogs, eventName: 'Funded' });
  const transfers = parseEventLogs({ abi: tokenAbi, logs: tokenLogs, eventName: 'Transfer' });
  if (receipt.status !== 'success' || receipt.blockHash !== event.blockHash || block.hash !== receipt.blockHash ||
      transaction.blockHash !== receipt.blockHash || !isAddressEqual(transaction.from, owner) ||
      !transaction.to || !isAddressEqual(transaction.to, address) ||
      transaction.input !== encodeFunctionData({ abi: escrowAbi, functionName: 'fund' }) ||
      !funded.some(log => log.args.amount === amount && log.logIndex === event.logIndex) ||
      !transfers.some(log => isAddressEqual(log.args.from, owner) && isAddressEqual(log.args.to, address) && log.args.value === amount)) {
    throw new WorkflowError(503, 'Chưa xác minh được receipt ký quỹ.');
  }
  return { hash: receipt.transactionHash, block: receipt.blockNumber.toString() };
}

export async function localFunding(root, wallet, action) {
  if (wallet?.chainId !== localChain.id) throw new WorkflowError(409, 'Hãy xác minh ví Hardhat Local trước.');
  const owner = getAddress(wallet.address);
  const deployment = await checkLocalDeployment(root, owner);
  const token = getAddress(deployment.token);
  const factory = getAddress(deployment.factory);
  const [code, factoryToken] = await Promise.all([
    rpc.getCode({ address: token }),
    rpc.readContract({ address: factory, abi: factoryAbi, functionName: 'token' }),
  ]);
  if (!code || keccak256(code) !== deployment.tokenCodeHash || !isAddressEqual(factoryToken, token)) {
    throw new WorkflowError(503, 'Chưa xác minh được MockUSDC của deployment.');
  }

  const { freelancer, arbitrator } = deployment.accounts;
  if (isAddressEqual(owner, freelancer) || isAddressEqual(owner, arbitrator)) {
    throw new WorkflowError(409, 'Hãy chọn ví Client khác hai ví thử Freelancer và Arbitrator.');
  }
  const agreementRef = keccak256(stringToHex(`local-funding:${deployment.instanceKey}:${owner}`));
  const block = await rpc.getBlock();
  const [address, eth, balance] = await Promise.all([
    rpc.readContract({ address: factory, abi: factoryAbi, functionName: 'escrowFor', args: [owner, agreementRef] }),
    rpc.getBalance({ address: owner }),
    rpc.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [owner] }),
  ]);
  const status = { escrow: null, token, eth: formatEther(eth), balance: formatUnits(balance, 6), escrowBalance: null, step: 'create', receipt: null };
  let request;
  if (address === zeroAddress) {
    if (action === 'create') {
      const terms = {
        projectRef: keccak256(stringToHex('Freelancer Escrow local funding demo')),
        agreementRef, createBy: block.timestamp + 1800n, freelancer, arbitrator, budgetUnits: amount,
        amounts: [amount], baseDues: [block.timestamp + 11n * 86400n], policyVersion: 1,
        documentHash: sha256(stringToHex('Demo agreement: one milestone of 100 MockUSDC on Hardhat Local')),
      };
      const hash = await rpc.readContract({ address: factory, abi: factoryAbi, functionName: 'hashTerms', args: [owner, terms] });
      request = { address: factory, abi: factoryAbi, functionName: 'createEscrow', args: [terms, hash] };
    }
  } else {
    status.escrow = address;
    const read = functionName => rpc.readContract({ address, abi: escrowAbi, functionName });
    const [state, total, actualFreelancer, actualArbitrator, allowance] = await Promise.all([
      read('state'), read('total'), read('freelancer'), read('arbitrator'),
      rpc.readContract({ address: token, abi: tokenAbi, functionName: 'allowance', args: [owner, address] }),
    ]);
    if (total !== amount || !isAddressEqual(actualFreelancer, freelancer) || !isAddressEqual(actualArbitrator, arbitrator)) {
      throw new WorkflowError(409, 'Escrow này có điều khoản khác với bài thử 100 MockUSDC.');
    }
    switch (state) {
      case 0: status.step = 'accept'; break;
      case 1: status.step = allowance >= amount ? 'fund' : allowance > 0n ? 'reset' : 'approve'; break;
      case 2:
      case 3:
      case 4:
      case 5:
        status.step = 'closed';
        const [event] = await rpc.getContractEvents({
          address, abi: escrowAbi, eventName: 'Funded', fromBlock: BigInt(deployment.startBlock), strict: true,
        });
        if (event?.transactionHash) {
          status.receipt = await confirmedFunding(address, owner, token, event);
          const held = await rpc.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [address] });
          status.escrowBalance = formatUnits(held, 6);
          status.step = 'funded';
        }
        break;
      default: throw new WorkflowError(503, 'Trạng thái escrow không hợp lệ.');
    }
    if (action === 'accept' && status.step === 'accept') {
      const signer = createWalletClient({ account: getAddress(freelancer), chain: hardhat, transport });
      const { request } = await rpc.simulateContract({
        account: signer.account, address, abi: escrowAbi, functionName: 'accept', args: [await read('termsHash')],
      });
      const hash = await signer.writeContract(request);
      const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 10000 });
      if (receipt.status !== 'success') throw new WorkflowError(409, 'Ví Freelancer thử chưa chấp nhận được escrow.');
      return localFunding(root, wallet);
    }
    if (action === status.step && (action === 'approve' || action === 'reset')) {
      request = { address: token, abi: tokenAbi, functionName: 'approve', args: [address, action === 'reset' ? 0n : amount] };
    }
    if (action === 'fund' && status.step === 'fund') {
      if (balance < amount) throw new WorkflowError(409, 'Ví Client cần đủ 100 MockUSDC thử.');
      request = { address, abi: escrowAbi, functionName: 'fund' };
    }
  }
  if (!action) return status;
  if (!request) throw new WorkflowError(409, 'Trạng thái escrow đã đổi. Bấm đọc lại trạng thái rồi thử tiếp.');
  if (eth === 0n) throw new WorkflowError(409, 'Ví chưa có ETH thử để trả phí gas.');
  await rpc.simulateContract({ ...request, account: owner });
  return {
    to: request.address,
    data: encodeFunctionData(request),
    deploymentBlock: '0x' + BigInt(deployment.startBlock).toString(16),
    deploymentBlockHash: deployment.startBlockHash,
  };
}
