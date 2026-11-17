import assert from 'node:assert/strict';
import { test } from 'node:test';
import { network } from 'hardhat';
import { parseUnits } from 'viem';

test('FESC vault preserves value and only the depositing wallet can withdraw', async () => {
  const connection = await network.create();
  try {
    const [owner, other] = await connection.viem.getWalletClients();
    const rpc = await connection.viem.getPublicClient();
    const token = await connection.viem.deployContract('FreelanceToken', [[owner.account.address]]);
    const vault = await connection.viem.deployContract('FescVault', [token.address]);
    const amount = parseUnits('100', 18);
    const confirm = async (hash: `0x${string}`) => assert.equal((await rpc.waitForTransactionReceipt({ hash })).status, 'success');
    await assert.rejects(vault.write.deposit([amount]));
    await confirm(await token.write.approve([vault.address, amount]));
    await confirm(await vault.write.deposit([amount]));
    assert.equal(await vault.read.balances([owner.account.address]), amount);
    assert.equal(await token.read.balanceOf([owner.account.address]), parseUnits('900', 18));
    assert.equal(await token.read.allowance([owner.account.address, vault.address]), 0n);
    await assert.rejects(vault.write.withdraw([1n], { account: other.account }));
    await assert.rejects(vault.write.withdraw([amount + 1n]));
    await assert.rejects(vault.write.deposit([0n]));
    await assert.rejects(vault.write.withdraw([0n]));
    await confirm(await vault.write.withdraw([parseUnits('40', 18)]));
    assert.equal(await vault.read.balances([owner.account.address]), parseUnits('60', 18));
    await confirm(await vault.write.withdraw([parseUnits('60', 18)]));
    assert.equal(await token.read.balanceOf([owner.account.address]), parseUnits('1000', 18));
    assert.equal(await vault.read.totalDeposited(), 0n);
    assert.equal(await token.read.balanceOf([vault.address]), 0n);
  } finally { await connection.close(); }
});
