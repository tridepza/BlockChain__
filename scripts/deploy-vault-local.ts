import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { network } from 'hardhat';
import { isAddressEqual, keccak256 } from 'viem';

const path = new URL('../.hardhat/local-fesc-deployment.json', import.meta.url);
const manifest = JSON.parse(await readFile(path, 'utf8'));
const connection = await network.create();
try {
  const rpc = await connection.viem.getPublicClient();
  assert.equal(await rpc.getChainId(), 31337);
  assert.equal(keccak256((await rpc.getCode({ address: manifest.token }))!), manifest.tokenCodeHash, 'Token hiện tại không khớp. Khôi phục chain, không triển khai lại token.');
  if (manifest.vault) {
    assert.equal(keccak256((await rpc.getCode({ address: manifest.vault }))!), manifest.vaultCodeHash);
    console.log(`Giữ FESC Vault hiện tại ${manifest.vault}`);
  } else {
    const deployment = await connection.viem.sendDeploymentTransaction('FescVault', [manifest.token]);
    const receipt = await rpc.waitForTransactionReceipt({ hash: deployment.deploymentTransaction.hash });
    assert.equal(receipt.status, 'success');
    assert.ok(isAddressEqual(await deployment.contract.read.token(), manifest.token));
    const vaultCode = (await rpc.getCode({ address: deployment.contract.address }))!;
    await writeFile(path, JSON.stringify({ ...manifest, vault: deployment.contract.address,
      vaultCodeHash: keccak256(vaultCode), vaultStartBlock: receipt.blockNumber.toString(),
      vaultStartBlockHash: receipt.blockHash }, null, 2) + '\n');
    console.log(`FESC Vault ${deployment.contract.address}. Giữ nguyên token và số dư FESC hiện có.`);
  }
} finally { await connection.close(); }
