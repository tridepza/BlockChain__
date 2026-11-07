import assert from 'node:assert/strict';
import { test } from 'node:test';
import { network } from 'hardhat';

test('toolchain compiles, deploys and reads Solidity through viem', async () => {
  const connection = await network.create();
  try {
    const contract = await connection.viem.deployContract('ToolchainCheck', [42n]);
    assert.equal(await contract.read.value(), 42n);
    const client = await connection.viem.getPublicClient();
    assert.notEqual(await client.getCode({ address: contract.address }), '0x');
  } finally {
    await connection.close();
  }
});
