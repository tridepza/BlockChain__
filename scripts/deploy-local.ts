import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { network } from 'hardhat';
import { encodeAbiParameters, isAddressEqual, keccak256, parseAbiParameters, parseEventLogs, parseUnits, sha256, toHex, zeroHash } from 'viem';
import type { Address, Hash, TransactionReceipt } from 'viem';

const connection = await network.create();
try {
  const config = connection.networkConfig;
  assert.equal(config.type, 'http', 'Chạy bằng npm run chain:deploy.');
  const rpcUrl = await config.url.getUrl();
  assert.equal(new URL(rpcUrl).href, 'http://127.0.0.1:8545/', 'Chỉ triển khai vào Hardhat local.');
  const rpc = await connection.viem.getPublicClient();
  const chainId = await rpc.getChainId();
  assert.equal(chainId, 31337, 'Mạng local phải có chain ID 31337.');

  const wallets = await connection.viem.getWalletClients();
  assert.ok(wallets.length >= 3, 'Cần ba tài khoản Hardhat local.');
  const [client, freelancer, arbitrator] = wallets.map(wallet => wallet.account.address);
  for (const address of [client, freelancer, arbitrator]) {
    assert.ok(await rpc.getBalance({ address }) > 0n, `Ví ${address} thiếu ETH thử nghiệm.`);
  }
  const genesis = await rpc.getBlock({ blockNumber: 0n });
  assert.ok(genesis.hash, 'Không đọc được hash block khởi đầu.');
  const receipts: Record<string, { transactionHash: Hash; blockNumber: string; blockHash: Hash }> = {};

  async function confirm(operation: string, transaction: Promise<Hash> | Hash) {
    const hash = await transaction;
    const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 15_000 });
    assert.equal(receipt.status, 'success', `${operation} bị revert.`);
    const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
    assert.equal(block.hash, receipt.blockHash, `Block chứa ${operation} đã đổi.`);
    receipts[operation] = {
      transactionHash: hash,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
    };
    return receipt;
  }

  const instanceKey = toHex(randomBytes(32));
  const tokenDeployment = await connection.viem.sendDeploymentTransaction('MockUSDC', [[client, freelancer, arbitrator]]);
  const tokenReceipt = await confirm('deployToken', tokenDeployment.deploymentTransaction.hash);
  const token = tokenDeployment.contract;
  assert.equal(tokenReceipt.contractAddress?.toLowerCase(), token.address.toLowerCase());
  assert.equal(await token.read.decimals(), 6);

  const factoryDeployment = await connection.viem.sendDeploymentTransaction('EscrowFactory', [token.address, instanceKey]);
  const factoryReceipt = await confirm('deployFactory', factoryDeployment.deploymentTransaction.hash);
  const factory = factoryDeployment.contract;
  assert.equal(factoryReceipt.contractAddress?.toLowerCase(), factory.address.toLowerCase());
  assert.ok(isAddressEqual(await factory.read.token(), token.address));
  assert.equal(await factory.read.instanceKey(), instanceKey);
  const tokenCode = await rpc.getCode({ address: token.address });
  const factoryCode = await rpc.getCode({ address: factory.address });
  assert.ok(tokenCode && tokenCode !== '0x');
  assert.ok(factoryCode && factoryCode !== '0x');

  // Run the same example as Stage 3 on the RPC node that will serve MetaMask.
  const units = (amount: string) => parseUnits(amount, 6);
  const budget = units('100');
  const firstMilestone = units('30');
  const remaining = budget - firstMilestone;
  const now = (await rpc.getBlock()).timestamp;
  const terms = {
    projectRef: toHex(randomBytes(32)),
    agreementRef: toHex(randomBytes(32)),
    createBy: now + 1800n,
    freelancer,
    arbitrator,
    budgetUnits: budget,
    amounts: [firstMilestone, units('40'), units('30')],
    baseDues: [12n, 16n, 20n].map(days => now + days * 86400n),
    policyVersion: 1,
    documentHash: sha256(toHex('Freelancer Escrow local deployment check')),
  };
  const termsHash = await factory.read.hashTerms([client, terms]);
  const created = await confirm('createEscrow', factory.write.createEscrow([terms, termsHash], { account: client }));
  const [creation] = parseEventLogs({
    abi: factory.abi,
    eventName: 'EscrowCreated',
    logs: created.logs.filter(log => isAddressEqual(log.address, factory.address)),
  });
  assert.ok(creation, 'Thiếu event EscrowCreated của factory.');
  assert.ok(isAddressEqual(creation.args.client, client));
  assert.equal(creation.args.agreementRef, terms.agreementRef);
  assert.equal(creation.args.projectRef, terms.projectRef);
  assert.equal(creation.args.termsHash, termsHash);
  const escrow = await connection.viem.getContractAt('Escrow', creation.args.escrow);

  function checkTransfer(receipt: TransactionReceipt, from: Address, to: Address, amount: bigint) {
    const events = parseEventLogs({
      abi: token.abi,
      eventName: 'Transfer',
      logs: receipt.logs.filter(log => isAddressEqual(log.address, token.address)),
    });
    assert.ok(events.some(({ args }) =>
      isAddressEqual(args.from, from) && isAddressEqual(args.to, to) && args.value === amount
    ), 'Thiếu Transfer đúng địa chỉ và số tiền.');
  }

  await confirm('accept', escrow.write.accept([termsHash], { account: freelancer }));
  await confirm('approve', token.write.approve([escrow.address, budget], { account: client }));
  assert.equal(await escrow.read.funded(), 0n);
  const funded = await confirm('fund', escrow.write.fund({ account: client }));
  checkTransfer(funded, client, escrow.address, budget);
  assert.equal(await escrow.read.funded(), budget);
  assert.equal(await escrow.read.unallocated(), budget);
  await confirm('start', escrow.write.start({ account: freelancer }));
  const anchorHash = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, bool, bytes32, bytes32'),
    [keccak256(toHex('FreelancerEscrow/Evidence/v1')), false, zeroHash, sha256(toHex('Local milestone delivery'))],
  ));
  await confirm('submit', escrow.write.submit(
    [0n, await escrow.read.version(), anchorHash],
    { account: freelancer },
  ));
  await confirm('approveMilestone', escrow.write.approveMilestone([0n, await escrow.read.version()], { account: client }));
  assert.equal(await escrow.read.claimable([freelancer]), firstMilestone);
  assert.equal(await token.read.balanceOf([escrow.address]), budget);
  const beforeWithdraw = await token.read.balanceOf([freelancer]);
  const withdrawal = await confirm('withdraw', escrow.write.withdraw({ account: freelancer }));
  checkTransfer(withdrawal, escrow.address, freelancer, firstMilestone);
  assert.equal(await token.read.balanceOf([freelancer]) - beforeWithdraw, firstMilestone);
  assert.equal(await escrow.read.claimable([freelancer]), 0n);
  assert.equal(await escrow.read.withdrawn([freelancer]), firstMilestone);
  assert.equal(await escrow.read.unallocated(), remaining);
  assert.equal(await token.read.balanceOf([escrow.address]), remaining);

  const manifest = {
    abiVersion: 1,
    rpcUrl,
    chainId,
    genesisHash: genesis.hash,
    instanceKey,
    token: token.address,
    tokenCodeHash: keccak256(tokenCode),
    factory: factory.address,
    factoryCodeHash: keccak256(factoryCode),
    factoryCreationTxHash: factoryReceipt.transactionHash,
    startBlock: factoryReceipt.blockNumber.toString(),
    startBlockHash: factoryReceipt.blockHash,
    requiredConfirmations: 1,
    accounts: { client, freelancer, arbitrator },
    demo: {
      escrow: escrow.address,
      projectRef: terms.projectRef,
      agreementRef: terms.agreementRef,
      termsHash,
      fundedUnits: budget.toString(),
      freelancerWithdrawnUnits: firstMilestone.toString(),
      escrowBalanceUnits: remaining.toString(),
    },
    receipts,
  };
  const output = new URL('../.hardhat/', import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL('local-deployment.json', output), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`MockUSDC ${token.address}\nEscrowFactory ${factory.address}\nEscrow mẫu ${escrow.address}`);
  console.log('Đã nạp 100 MockUSDC, Freelancer rút 30, escrow còn 70.');
  console.log(`Receipt nạp ${receipts.fund.transactionHash}\nReceipt rút ${receipts.withdraw.transactionHash}`);
  console.log('Thông tin triển khai và receipt ở .hardhat/local-deployment.json.');
} finally {
  await connection.close();
}
