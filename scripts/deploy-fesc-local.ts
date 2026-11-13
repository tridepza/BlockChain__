import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { getAddress, isAddress, parseUnits, zeroAddress } from 'viem';

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
  console.log(`FESC ${token.address}\nBlock ${receipt.blockNumber}\nGiao dịch ${receipt.transactionHash}`);
} finally {
  await connection.close();
}
