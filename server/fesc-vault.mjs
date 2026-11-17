import { createPublicClient, encodeFunctionData, formatEther, formatUnits, http, isAddressEqual, keccak256, numberToHex, parseAbi, parseUnits } from 'viem';
import { localChain } from '../src/local-chain.ts';
import { WorkflowError } from '../src/workflow.ts';
import { checkLocalDeployment } from './wallet.mjs';

const rpc = createPublicClient({ transport: http(localChain.rpcUrl, { timeout: 5000, retryCount: 0 }) });
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const vaultAbi = parseAbi(['function token() view returns (address)', 'function balances(address) view returns (uint256)',
  'function deposit(uint256)', 'function withdraw(uint256)', 'event Deposited(address indexed wallet,uint256 amount)', 'event Withdrawn(address indexed wallet,uint256 amount)']);

export async function fescVault(root, wallet, input = {}) {
  if (wallet?.chainId !== localChain.id) throw new WorkflowError(409, 'Hãy liên kết ví MetaMask trước.');
  const deployment = await checkLocalDeployment(root, wallet.address, 'FESC');
  const { token, vault } = deployment;
  if (!vault) throw new WorkflowError(503, 'Chưa có hợp đồng nạp/rút. Chạy npm.cmd run chain:deploy:vault.');
  const block = await rpc.getBlock();
  const read = (address, abi, functionName, args = []) => rpc.readContract({ address, abi, functionName, args, blockNumber: block.number });
  const [code, actualToken, balance, account, allowance, gas] = await Promise.all([
    rpc.getCode({ address: vault, blockNumber: block.number }), read(vault, vaultAbi, 'token'),
    read(token, tokenAbi, 'balanceOf', [wallet.address]), read(vault, vaultAbi, 'balances', [wallet.address]),
    read(token, tokenAbi, 'allowance', [wallet.address, vault]), rpc.getBalance({ address: wallet.address, blockNumber: block.number }),
  ]);
  if (!code || keccak256(code) !== deployment.vaultCodeHash || !isAddressEqual(actualToken, token)) throw new WorkflowError(503, 'Hợp đồng nạp/rút không khớp cấu hình đã xác minh.');
  if (!input.action) {
    const events = await rpc.getContractEvents({ address: vault, abi: vaultAbi, args: { wallet: wallet.address },
      fromBlock: BigInt(deployment.vaultStartBlock), toBlock: block.number });
    return { token, vault, walletBalance: formatUnits(balance, 18), accountBalance: formatUnits(account, 18), gas: formatEther(gas),
      history: events.slice(-20).reverse().map(event => ({ hash: event.transactionHash,
        action: event.eventName === 'Deposited' ? 'Nạp FESC' : 'Rút FESC', amount: formatUnits(event.args.amount, 18), block: String(event.blockNumber) })) };
  }
  if (!['deposit', 'withdraw'].includes(input.action) || typeof input.amount !== 'string' || !/^\d{1,20}(\.\d{1,18})?$/.test(input.amount)) {
    throw new WorkflowError(400, 'Nhập số FESC dương, tối đa 18 chữ số thập phân.');
  }
  const amount = parseUnits(input.amount, 18);
  if (amount <= 0n) throw new WorkflowError(400, 'Số FESC phải lớn hơn 0.');
  if (!gas) throw new WorkflowError(409, 'Ví cần ETH thử để trả phí giao dịch.');
  if ((input.action === 'deposit' ? balance : account) < amount) throw new WorkflowError(409, 'Số dư FESC không đủ.');
  let call = { address: vault, abi: vaultAbi, functionName: input.action, args: [amount] };
  let step = input.action;
  if (input.action === 'deposit' && allowance !== amount) {
    step = allowance === 0n ? 'approve' : 'reset';
    call = { address: token, abi: tokenAbi, functionName: 'approve', args: [vault, allowance === 0n ? amount : 0n] };
  }
  try { await rpc.simulateContract({ ...call, account: wallet.address }); }
  catch { throw new WorkflowError(409, 'Giao dịch chưa hợp lệ trên blockchain. Hãy đọc lại số dư.'); }
  return { step, from: wallet.address, to: call.address, data: encodeFunctionData(call),
    deploymentBlock: numberToHex(BigInt(deployment.startBlock)), deploymentBlockHash: deployment.startBlockHash };
}
