import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { hardhat } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { startDurableHardhatNode, HARDHAT_JOURNAL_FORMAT } from '../scripts/hardhat-node.mjs';

const account = mnemonicToAccount('test test test test test test test test test test test junk');
async function rpcAt(url, method, params = []) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

test('Hardhat journal preserves signed and unlocked transactions, token/vault balances, receipts and blocks on restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fesc-hardhat-'));
  const state = join(dir, 'state.json');
  let node;
  t.after(async () => { await node?.close(); await rm(dir, { recursive: true }); });
  node = await startDurableHardhatNode({ port: 0, state });
  const rpc = createPublicClient({ chain: hardhat, transport: http(node.url) });
  const wallet = createWalletClient({ chain: hardhat, transport: http(node.url), account });
  const artifact = async name => JSON.parse(await readFile(`.hardhat/artifacts/contracts/${name}.sol/${name}.json`, 'utf8'));
  const token = await artifact('FreelanceToken');
  const vault = await artifact('FescVault');
  const confirm = hash => rpc.waitForTransactionReceipt({ hash });
  const tokenReceipt = await confirm(await wallet.deployContract({ abi: token.abi, bytecode: token.bytecode, args: [[account.address]] }));
  const tokenAddress = tokenReceipt.contractAddress;
  const vaultReceipt = await confirm(await wallet.deployContract({ abi: vault.abi, bytecode: vault.bytecode, args: [tokenAddress] }));
  const vaultAddress = vaultReceipt.contractAddress;
  await confirm(await wallet.writeContract({ address: tokenAddress, abi: token.abi, functionName: 'approve', args: [vaultAddress, parseUnits('125', 18)] }));
  const deposit = await confirm(await wallet.writeContract({ address: vaultAddress, abi: vault.abi, functionName: 'deposit', args: [parseUnits('125', 18)] }));
  await confirm(await wallet.writeContract({ address: vaultAddress, abi: vault.abi, functionName: 'withdraw', args: [parseUnits('25', 18)] }));
  const unlocked = await rpcAt(node.url, 'eth_sendTransaction', [{ from: account.address, to: account.address,
    value: '0x1', gas: '0x5208', gasPrice: '0x3b9aca00' }]);
  const unlockedReceipt = await confirm(unlocked);
  // A reverted, mined transaction must be journaled even when the RPC throws.
  await wallet.writeContract({ address: vaultAddress, abi: vault.abi, functionName: 'withdraw',
    args: [parseUnits('101', 18)], gas: 100_000n }).catch(() => {});
  const reverted = JSON.parse(await readFile(state, 'utf8')).blocks.at(-1).transactions[0];
  assert.equal(reverted.status, '0x0');
  await rpcAt(node.url, 'evm_increaseTime', [86401]);
  await rpcAt(node.url, 'evm_mine');
  const tip = await rpc.getBlock();
  const balance = await rpc.getBalance({ address: account.address });
  const journal = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(journal.format, HARDHAT_JOURNAL_FORMAT);
  assert.equal(journal.blocks.at(-1).hash, tip.hash);
  assert.ok(journal.blocks.some(block => block.transactions.some(tx => tx.hash === deposit.transactionHash)), 'deposit must be on disk before response');
  await assert.rejects(rpcAt(node.url, 'anvil_reset'), /bị chặn/);
  await assert.rejects(rpcAt(node.url, 'hardhat_setBalance', [account.address, '0x0']), /bị chặn/);
  await assert.rejects(startDurableHardhatNode({ port: 0, state }), /tiến trình khác/);
  await node.close();
  node = await startDurableHardhatNode({ port: 0, state });
  const restored = createPublicClient({ chain: hardhat, transport: http(node.url) });
  assert.equal(await restored.readContract({ address: tokenAddress, abi: token.abi, functionName: 'balanceOf', args: [account.address] }), parseUnits('900', 18));
  assert.equal(await restored.readContract({ address: vaultAddress, abi: vault.abi, functionName: 'balances', args: [account.address] }), parseUnits('100', 18));
  assert.equal((await restored.getTransactionReceipt({ hash: deposit.transactionHash })).blockHash, deposit.blockHash);
  assert.equal((await restored.getTransactionReceipt({ hash: unlocked })).blockHash, unlockedReceipt.blockHash);
  assert.equal((await restored.getTransactionReceipt({ hash: reverted.hash })).status, 'reverted');
  assert.equal((await restored.getBlock({ blockNumber: tip.number })).hash, tip.hash);
  assert.equal(await restored.getBalance({ address: account.address }), balance);
  assert.equal((await restored.getContractEvents({ address: vaultAddress, abi: vault.abi, fromBlock: 0n })).length, 2);
  const next = createWalletClient({ chain: hardhat, transport: http(node.url), account });
  const nextHash = await next.sendTransaction({ to: account.address, value: 2n });
  assert.equal((await restored.waitForTransactionReceipt({ hash: nextHash })).status, 'success');
});

test('an acknowledged transaction survives process termination without graceful shutdown', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fesc-hardhat-crash-'));
  const state = join(dir, 'state.json');
  let child;
  let restored;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
    await restored?.close();
    await rm(dir, { recursive: true });
  });
  child = spawn(process.execPath, ['scripts/hardhat-node.mjs', '--port=0', `--state=${state}`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((ready, reject) => {
    let output = ''; let errors = '';
    const timeout = setTimeout(() => reject(new Error(`Child did not listen: ${errors}`)), 40_000);
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Child exited: ${errors}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const found = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (found) { clearTimeout(timeout); ready(found[0]); }
    });
  });
  const wallet = createWalletClient({ chain: hardhat, transport: http(url), account });
  const rpc = createPublicClient({ chain: hardhat, transport: http(url) });
  const hash = await wallet.sendTransaction({ to: account.address, value: 42n });
  const receipt = await rpc.getTransactionReceipt({ hash });
  const balance = await rpc.getBalance({ address: account.address });
  const ended = once(child, 'exit');
  child.kill('SIGKILL');
  await ended;
  restored = await startDurableHardhatNode({ port: 0, state });
  const after = createPublicClient({ chain: hardhat, transport: http(restored.url) });
  assert.equal((await after.getTransactionReceipt({ hash })).blockHash, receipt.blockHash);
  assert.equal(await after.getBalance({ address: account.address }), balance);
});

test('foreign or inconsistent state is rejected without overwriting it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fesc-hardhat-invalid-'));
  const state = join(dir, 'state.json');
  t.after(() => rm(dir, { recursive: true }));
  const foreign = JSON.stringify({ accounts: {}, block: { number: 123 } });
  await writeFile(state, foreign);
  await assert.rejects(startDurableHardhatNode({ port: 0, state }), /không phải journal Hardhat/);
  assert.equal(await readFile(state, 'utf8'), foreign);
  await rm(state);
  const node = await startDurableHardhatNode({ port: 0, state });
  await rpcAt(node.url, 'evm_mine');
  await node.close();
  const journal = JSON.parse(await readFile(state, 'utf8'));
  journal.blocks[0].hash = '0x' + '00'.repeat(32);
  const corrupted = JSON.stringify(journal);
  await writeFile(state, corrupted);
  await assert.rejects(startDurableHardhatNode({ port: 0, state }), /không khớp journal/);
  assert.equal(await readFile(state, 'utf8'), corrupted);
});

test('a stale lock with a reused live PID is reclaimed using OS process creation identity',
  { skip: !['win32', 'linux'].includes(process.platform) }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'fesc-hardhat-pid-'));
    const state = join(dir, 'state.json');
    let node;
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { windowsHide: true, stdio: 'ignore' });
    await once(unrelated, 'spawn');
    t.after(async () => {
      await node?.close();
      const ended = once(unrelated, 'exit'); unrelated.kill('SIGKILL'); await ended;
      await rm(dir, { recursive: true });
    });
    node = await startDurableHardhatNode({ port: 0, state });
    const previous = JSON.parse(await readFile(state + '.lock', 'utf8'));
    assert.match(previous.identity, /^(windows|linux):/);
    await node.close();
    // The old owner's PID now refers to a different process, as after a reboot.
    await writeFile(state + '.lock', JSON.stringify({ ...previous, pid: unrelated.pid }));
    node = await startDurableHardhatNode({ port: 0, state });
    assert.equal(await rpcAt(node.url, 'eth_chainId'), '0x7a69');
    assert.equal(unrelated.exitCode, null, 'reclaiming a stale lock must not terminate the unrelated process');
    const current = JSON.parse(await readFile(state + '.lock', 'utf8'));
    assert.equal(current.pid, process.pid);
    assert.notEqual(current.nonce, previous.nonce);
  });

test('concurrent stale-lock recovery through path aliases permits exactly one journal writer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fesc-hardhat-reclaim-'));
  const real = join(dir, 'real');
  let alias = join(dir, 'alias');
  let winner;
  t.after(async () => { await winner?.close(); await rm(dir, { recursive: true }); });
  await mkdir(real);
  try {
    await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    // Some Windows sandboxes disallow junctions. NTFS also supports case aliases.
    alias = join(dir, 'REAL');
    t.diagnostic('Junction creation is denied. Testing the Windows case alias instead.');
  }
  const state = join(real, 'state.json');
  const stopped = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  const pid = stopped.pid;
  await once(stopped, 'exit');
  await writeFile(state + '.lock', JSON.stringify({ pid, identity: null, nonce: 'dead-owner' }));
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => startDurableHardhatNode({
    port: 0, state: join(index % 2 ? alias : real, 'state.json'),
  })));
  const successful = attempts.filter(result => result.status === 'fulfilled');
  // Close every unexpected winner too, so a regression does not leak servers.
  if (successful.length !== 1) {
    await Promise.allSettled(successful.map(result => result.value.close()));
    assert.fail(`Expected one journal writer; got ${successful.length}`);
  }
  winner = successful[0].value;
  for (const result of attempts.filter(result => result.status === 'rejected')) {
    assert.match(result.reason.message, /tiến trình khác|cổng khóa/);
  }
  const current = JSON.parse(await readFile(state + '.lock', 'utf8'));
  assert.notEqual(current.nonce, 'dead-owner');
  const wallet = createWalletClient({ chain: hardhat, transport: http(winner.url), account });
  const hash = await wallet.sendTransaction({ to: account.address, value: 1n });
  await assert.rejects(startDurableHardhatNode({ port: 0, state: join(alias, 'state.json') }), /tiến trình khác|cổng khóa/);
  assert.equal(JSON.parse(await readFile(state + '.lock', 'utf8')).nonce, current.nonce);
  await winner.close();
  winner = await startDurableHardhatNode({ port: 0, state });
  const rpc = createPublicClient({ chain: hardhat, transport: http(winner.url) });
  assert.equal((await rpc.getTransactionReceipt({ hash })).status, 'success');
});

test('incomplete legacy locks are preserved while fresh and recovered after the safety interval', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fesc-hardhat-partial-lock-'));
  const state = join(dir, 'state.json');
  let node;
  t.after(async () => { await node?.close(); await rm(dir, { recursive: true }); });
  for (const incomplete of ['', '{"pid":', '{}']) {
    await writeFile(state + '.lock', incomplete);
    await assert.rejects(startDurableHardhatNode({ port: 0, state }), /còn mới/);
    assert.equal(await readFile(state + '.lock', 'utf8'), incomplete);
    const old = new Date(Date.now() - 120_000);
    await utimes(state + '.lock', old, old);
    node = await startDurableHardhatNode({ port: 0, state });
    assert.equal(await rpcAt(node.url, 'eth_chainId'), '0x7a69');
    const owner = JSON.parse(await readFile(state + '.lock', 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.ok(owner.nonce);
    await node.close();
    node = null;
  }
});
