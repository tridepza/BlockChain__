import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { network } from 'hardhat';
import { getAddress, isAddress, keccak256, parseUnits, toHex, zeroAddress } from 'viem';

const tokenOnly = process.env.FESC_TOKEN_ONLY === '1';
const addresses = (process.env.FESC_RECIPIENTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
assert.ok(addresses.length > 0, 'Điền FESC_RECIPIENTS bằng các địa chỉ ví thử, cách nhau bằng dấu phẩy.');
const recipients = addresses.map(address => {
  assert.ok(isAddress(address), 'FESC_RECIPIENTS chứa địa chỉ ví không hợp lệ.');
  const recipient = getAddress(address);
  assert.notEqual(recipient, zeroAddress, 'Địa chỉ nhận FESC phải khác địa chỉ 0.');
  return recipient;
});
assert.equal(new Set(recipients).size, recipients.length, 'FESC_RECIPIENTS chứa địa chỉ trùng nhau.');

const connection = await network.create();
try {
  const config = connection.networkConfig;
  assert.equal(config.type, 'http', 'Chạy bằng npm.cmd run chain:deploy:fesc.');
  assert.equal(new URL(await config.url.getUrl()).href, 'http://127.0.0.1:8545/');
  const rpc = await connection.viem.getPublicClient();
  assert.equal(await rpc.getChainId(), 31337);
  assert.match(await rpc.request({ method: 'web3_clientVersion' }), /hardhat/i);

  const wallets = tokenOnly ? [] : await connection.viem.getWalletClients();
  const [, freelancer, arbitrator] = wallets.map(wallet => wallet.account.address);
  if (!tokenOnly) assert.ok(freelancer && arbitrator, 'Cần ba tài khoản Hardhat Local.');
  const deployment = await connection.viem.sendDeploymentTransaction('FreelanceToken', [recipients]);
  const receipt = await rpc.waitForTransactionReceipt({ hash: deployment.deploymentTransaction.hash, timeout: 15_000 });
  const token = deployment.contract;
  assert.equal(receipt.status, 'success');
  assert.equal(receipt.contractAddress?.toLowerCase(), token.address.toLowerCase());
  assert.equal(await token.read.name(), 'Freelance Token');
  assert.equal(await token.read.symbol(), 'FESC');
  assert.equal(await token.read.decimals(), 18);
  const initialBalance = parseUnits('1000', 18);
  assert.equal(await token.read.totalSupply(), initialBalance * BigInt(recipients.length));
  for (const address of recipients) {
    assert.equal(await token.read.balanceOf([address]), initialBalance);
    console.log(`${address} nhận 1.000 FESC`);
  }
  if (freelancer && arbitrator) {
    const instanceKey = toHex(randomBytes(32));
    const factory = await connection.viem.sendDeploymentTransaction('EscrowFactory', [token.address, instanceKey]);
    const factoryReceipt = await rpc.waitForTransactionReceipt({ hash: factory.deploymentTransaction.hash, timeout: 15_000 });
    assert.equal(factoryReceipt.status, 'success');
    assert.equal(await factory.contract.read.instanceKey(), instanceKey);
    const [tokenCode, factoryCode] = await Promise.all([
      rpc.getCode({ address: token.address }), rpc.getCode({ address: factory.contract.address }),
    ]);
    assert.ok(tokenCode && factoryCode);
    const output = new URL('../.hardhat/', import.meta.url);
    await mkdir(output, { recursive: true });
    await writeFile(new URL('local-fesc-deployment.json', output), JSON.stringify({
      chainId: 31337,
      projectPayments: 1,
      instanceKey,
      token: token.address,
      tokenCodeHash: keccak256(tokenCode),
      factory: factory.contract.address,
      factoryCodeHash: keccak256(factoryCode),
      startBlock: factoryReceipt.blockNumber.toString(),
      startBlockHash: factoryReceipt.blockHash,
      accounts: { freelancer, arbitrator },
      tokenCreationTxHash: receipt.transactionHash,
    }, null, 2) + '\n');
  }
  console.log(`FESC ${token.address}\nBlock ${receipt.blockNumber}\nGiao dịch ${receipt.transactionHash}`);
} finally {
  await connection.close();
}
