import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { network } from 'hardhat';
import { isAddressEqual, keccak256, toHex } from 'viem';

const path = new URL('../.hardhat/local-fesc-deployment.json', import.meta.url);
const original = await readFile(path, 'utf8');
const manifest = JSON.parse(original);
const connection = await network.create();
try {
  const config = connection.networkConfig;
  assert.equal(config.type, 'http');
  assert.equal(new URL(await config.url.getUrl()).href, 'http://127.0.0.1:8545/');
  const rpc = await connection.viem.getPublicClient();
  assert.equal(await rpc.getChainId(), 31337);
  assert.equal((await rpc.getBlock({ blockNumber: BigInt(manifest.startBlock) })).hash, manifest.startBlockHash);
  const factory = await connection.viem.getContractAt('EscrowFactory', manifest.factory);
  const [tokenCode, factoryCode, instanceKey] = await Promise.all([
    rpc.getCode({ address: manifest.token }), rpc.getCode({ address: manifest.factory }), factory.read.instanceKey(),
  ]);
  assert.ok(tokenCode && keccak256(tokenCode) === manifest.tokenCodeHash);
  assert.ok(factoryCode && keccak256(factoryCode) === manifest.factoryCodeHash);
  assert.equal(instanceKey, manifest.instanceKey);
  assert.ok(isAddressEqual(await factory.read.token(), manifest.token));

  // Older factories lack these getters; treat a missing getter as revision 1.
  const readOr1 = (call: Promise<number>) => call.catch(error => {
    if (error.walk?.((cause: Error) => ['ContractFunctionZeroDataError', 'ContractFunctionRevertedError'].includes(cause.name))) return 1;
    throw error;
  });
  const currentPolicy = await readOr1(factory.read.LATEST_POLICY_VERSION());
  const currentRevision = await readOr1(factory.read.FACTORY_REVISION());
  if (currentPolicy >= 2 && currentRevision >= 2) {
    console.log('Factory hiện tại đã hỗ trợ thời hạn mới.');
  } else {
    const nextKey = toHex(randomBytes(32));
    const { contract, deploymentTransaction } = await connection.viem.sendDeploymentTransaction('EscrowFactory', [manifest.token, nextKey]);
    const receipt = await rpc.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
    assert.equal(receipt.status, 'success');
    assert.equal((await rpc.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash);
    assert.ok(receipt.contractAddress && isAddressEqual(receipt.contractAddress, contract.address));
    assert.ok(isAddressEqual(await contract.read.token(), manifest.token));
    assert.equal(await contract.read.instanceKey(), nextKey);
    assert.equal(await contract.read.LATEST_POLICY_VERSION(), 2);
    assert.equal(await contract.read.FACTORY_REVISION(), 2);
    const code = await rpc.getCode({ address: contract.address });
    assert.ok(code);
    assert.equal(await readFile(path, 'utf8'), original, 'Manifest đã đổi trong lúc chạy.');
    const staged = new URL(`./local-fesc-deployment.${nextKey.slice(2)}.tmp`, path);
    // Keep the original block anchor so token history still includes transfers before the upgrade.
    await writeFile(staged, JSON.stringify({ ...manifest, instanceKey: nextKey,
      factory: contract.address, factoryCodeHash: keccak256(code), escrowPolicy: 2, factoryRevision: 2,
      factoryCreationTxHash: receipt.transactionHash }, null, 2) + '\n', { flag: 'wx' });
    await rename(staged, path);
    console.log(`EscrowFactory mới ${contract.address}. Đã giữ token FESC, vault và các hợp đồng dự án cũ.`);
  }
} finally {
  await connection.close();
}
