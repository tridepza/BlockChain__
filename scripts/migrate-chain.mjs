import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { keccak256, serializeTransaction, createPublicClient, http, parseAbi } from 'viem';
import { startPersistentNode, rpcAt } from './local-node.mjs';

const origin = 'http://127.0.0.1:8545';
const output = resolve('.data/chain/state.json');
if (existsSync(output)) throw new Error('Đã có state lưu trên đĩa. Không ghi đè.');
if (!/hardhat/i.test(await rpcAt(origin, 'web3_clientVersion'))) throw new Error('Chỉ di chuyển từ node Hardhat hiện đang chạy.');
const tip = Number(BigInt(await rpcAt(origin, 'eth_blockNumber')));
const genesis = await rpcAt(origin, 'eth_getBlockByNumber', ['0x0', false]);
const journal = [];
const contracts = new Set();
const senders = new Set();
function rawTransaction(tx) {
  const numeric = key => tx[key] === undefined ? undefined : BigInt(tx[key]);
  const raw = serializeTransaction({ type: { '0x0': 'legacy', '0x1': 'eip2930', '0x2': 'eip1559' }[tx.type ?? '0x0'],
    chainId: Number(numeric('chainId') ?? 31337n), nonce: Number(numeric('nonce')), gas: numeric('gas'),
    to: tx.to ?? undefined, value: numeric('value'), data: tx.input,
    ...(tx.type === '0x2' ? { maxFeePerGas: numeric('maxFeePerGas'), maxPriorityFeePerGas: numeric('maxPriorityFeePerGas') }
      : { gasPrice: numeric('gasPrice') }),
    ...(tx.type === '0x1' || tx.type === '0x2' ? { accessList: tx.accessList ?? [] } : {}),
  }, { r: tx.r, s: tx.s, v: numeric('v'), ...(tx.yParity === undefined ? {} : { yParity: Number(numeric('yParity')) }) });
  if (keccak256(raw) !== tx.hash) throw new Error('Không tái tạo được chữ ký giao dịch gốc. Dừng, không thay đổi chain.');
  return raw;
}
for (let number = 1; number <= tip; number++) {
  const block = await rpcAt(origin, 'eth_getBlockByNumber', ['0x' + number.toString(16), true]);
  const transactions = [];
  for (const tx of block.transactions) {
    const receipt = await rpcAt(origin, 'eth_getTransactionReceipt', [tx.hash]);
    transactions.push({ hash: tx.hash, raw: rawTransaction(tx), status: receipt.status });
    senders.add(tx.from);
    if (receipt.contractAddress) contracts.add(receipt.contractAddress);
  }
  journal.push({ number: block.number, timestamp: block.timestamp, miner: block.miner, baseFee: block.baseFeePerGas,
    gasLimit: block.gasLimit, hash: block.hash, transactions });
}
await mkdir(resolve('.data/chain'), { recursive: true });
await writeFile(resolve('.data/chain/hardhat-before-migration.json'), JSON.stringify({ genesis, journal }));
console.log(`Đã sao lưu ${tip} block. Đang tái hiện chữ ký và kiểm tra trạng thái…`);
const temporary = await startPersistentNode({ port: 18545, state: resolve(`.local-data/chain-migration/${Date.now()}.json`),
  extra: ['--no-mining', '--timestamp', String(BigInt(genesis.timestamp)), '--hardfork', 'osaka'] });
try {
  for (const block of journal) {
    await rpcAt(temporary.url, 'evm_setNextBlockTimestamp', [Number(BigInt(block.timestamp))]);
    if (block.baseFee) await rpcAt(temporary.url, 'anvil_setNextBlockBaseFeePerGas', [block.baseFee]);
    await rpcAt(temporary.url, 'anvil_setCoinbase', [block.miner]);
    await rpcAt(temporary.url, 'evm_setBlockGasLimit', [block.gasLimit]);
    for (const tx of block.transactions) {
      if (await rpcAt(temporary.url, 'eth_sendRawTransaction', [tx.raw]) !== tx.hash) throw new Error('Mã giao dịch thay đổi.');
    }
    await rpcAt(temporary.url, 'evm_mine');
    for (const tx of block.transactions) {
      const receipt = await rpcAt(temporary.url, 'eth_getTransactionReceipt', [tx.hash]);
      if (!receipt || receipt.status !== tx.status) throw new Error(`Giao dịch ${tx.hash} không khớp trạng thái gốc.`);
    }
    if (Number(BigInt(block.number)) % 25 === 0) console.log(`Đã tái hiện ${Number(BigInt(block.number))}/${tip} block.`);
  }
  for (const address of contracts) {
    const before = await rpcAt(origin, 'eth_getCode', [address, 'latest']);
    const after = await rpcAt(temporary.url, 'eth_getCode', [address, 'latest']);
    if (before !== after) throw new Error(`Bytecode ${address} không khớp.`);
  }
  for (const address of senders) {
    for (const method of ['eth_getTransactionCount', 'eth_getBalance']) {
      if (await rpcAt(origin, method, [address, 'latest']) !== await rpcAt(temporary.url, method, [address, 'latest'])) {
        throw new Error(`${method} của ${address} không khớp. Chưa chuyển node.`);
      }
    }
  }
  const repin = [];
  for (const filename of ['local-deployment.json', 'local-fesc-deployment.json']) {
    const path = resolve('.hardhat', filename);
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const oldBlock = await rpcAt(origin, 'eth_getBlockByNumber', ['0x' + BigInt(manifest.startBlock).toString(16), false]);
    if (oldBlock.hash !== manifest.startBlockHash) continue;
    const block = await rpcAt(temporary.url, 'eth_getBlockByNumber', [oldBlock.number, false]);
    const abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
    const before = createPublicClient({ transport: http(origin) });
    const after = createPublicClient({ transport: http(temporary.url) });
    for (const address of senders) {
      const args = { address: manifest.token, abi, functionName: 'balanceOf', args: [address] };
      if (await before.readContract(args) !== await after.readContract(args)) throw new Error('Số dư token không khớp sau tái hiện.');
    }
    repin.push({ filename, instanceKey: manifest.instanceKey, previous: manifest.startBlockHash, next: block.hash });
  }
  if (Number(BigInt(await rpcAt(origin, 'eth_blockNumber'))) !== tip) throw new Error('Chain gốc có giao dịch mới trong lúc di chuyển. Chạy lại sau khi ngừng gửi giao dịch.');
  const dumped = await rpcAt(temporary.url, 'anvil_dumpState');
  await writeFile(output, gunzipSync(Buffer.from(dumped.slice(2), 'hex')));
  await writeFile(resolve('.data/chain/repin.json'), JSON.stringify(repin, null, 2));
  console.log('Đã lưu state có kiểm tra số dư, nonce, bytecode và receipt. Dừng Hardhat rồi chạy chain:node và chain:adopt.');
} finally {
  temporary.child.kill();
}
