import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http, isAddress, isAddressEqual, keccak256, parseEther, parseUnits, toHex, zeroAddress } from 'viem';
import { hardhat } from 'viem/chains';
import { startDurableHardhatNode } from './hardhat-node.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const state = resolve(root, '.data/chain/state.json');
const marker = resolve(root, '.data/chain/init-in-progress.json');
const manifests = ['local-fesc-deployment.json', 'local-deployment.json'];
const defaultRecipients = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
].map(address => getAddress(address));

function recipientsFromEnvironment() {
  const extra = (process.env.FESC_RECIPIENTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  for (const address of extra) {
    assert.ok(isAddress(address), 'FESC_RECIPIENTS chứa địa chỉ ví không hợp lệ.');
    assert.ok(!isAddressEqual(address, zeroAddress), 'Địa chỉ nhận FESC phải khác địa chỉ 0.');
  }
  return [...new Set([...defaultRecipients, ...extra.map(address => getAddress(address))])];
}

async function artifact(name) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === name + '.json') matches.push(path);
    }
  }
  const directory = resolve(root, '.hardhat/artifacts');
  assert.ok(existsSync(directory), 'Chưa có artifact. Chạy npm.cmd run compile:contracts trước.');
  await visit(directory);
  assert.equal(matches.length, 1, `Cần đúng một artifact ${name}. Chạy npm.cmd run compile:contracts.`);
  const result = JSON.parse(await readFile(matches[0], 'utf8'));
  assert.ok(Array.isArray(result.abi) && /^0x[\da-f]+$/i.test(result.bytecode), `Artifact ${name} không hợp lệ.`);
  return result;
}

function listening(port) {
  return new Promise((done, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? done(false) : reject(error); });
    socket.setTimeout(2500, () => { socket.destroy(); reject(new Error(`Không kiểm tra được cổng ${port}.`)); });
  });
}

async function optionalRead(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { flag: 'wx' });
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function initialize() {
  assert.ok(process.argv.length === 3 && process.argv[2] === '--new',
    'Đây là tạo blockchain thử MỚI, không khôi phục số dư/giao dịch cũ. Chỉ chạy: npm.cmd run chain:init -- --new');
  const recipients = recipientsFromEnvironment();
  const [tokenArtifact, factoryArtifact, vaultArtifact] = await Promise.all([
    artifact('FreelanceToken'), artifact('EscrowFactory'), artifact('FescVault'),
  ]);
  assert.ok(!existsSync(state), 'Đã có state blockchain. Giữ nguyên và chạy npm.cmd run chain:node.');
  assert.ok(!existsSync(marker), 'Lần khởi tạo trước chưa hoàn tất. Kiểm tra init-in-progress.json và backup trước.');
  assert.ok(!await listening(8545), 'Cổng 8545 đang được sử dụng. Dừng node một cách an toàn trước khi tạo môi trường mới.');
  const previous = new Map(await Promise.all(manifests.map(async name => [name,
    await optionalRead(resolve(root, '.hardhat', name)),
  ])));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const backup = resolve(root, '.data/backups', 'chain-init-' + stamp);
  const stagedState = resolve(backup, 'staging/state.json');
  const stagedManifest = resolve(backup, 'new-local-fesc-deployment.json');
  await mkdir(backup, { recursive: true });
  for (const [name, bytes] of previous) {
    if (bytes) await writeFile(resolve(backup, name), bytes, { flag: 'wx' });
  }
  await writeFile(resolve(backup, 'README.txt'),
    'Blockchain thử mới, KHÔNG phải khôi phục chain cũ.\n' +
    'Các manifest cũ được giữ nguyên trong thư mục này. Database, dự án và liên kết ví không bị sửa.\n' +
    'Dự án cũ vẫn tham chiếu deployment cũ; số dư và giao dịch chain đã mất không được dựng lại.\n' +
    'Không chép manifest cũ lên chain mới. Muốn trở lại chain cũ cần state/backup chain thực sự tương ứng.\n',
    { flag: 'wx' });
  console.log('Đang tạo blockchain thử MỚI; không khôi phục số dư hoặc giao dịch cũ.');
  console.log(`Backup manifest cũ: ${backup}`);
  let node;
  let markerOwned = false;
  let promotedState = false;
  let manifestChanged = false;
  let oldMockRemoved = false;
  let rollbackComplete = true;
  try {
    node = await startDurableHardhatNode({ port: 0, state: stagedState });
    const publicClient = createPublicClient({ chain: hardhat, transport: http(node.url, { retryCount: 0 }) });
    const wallet = createWalletClient({ chain: hardhat, transport: http(node.url, { retryCount: 0 }) });
    assert.equal(await publicClient.getChainId(), 31337);
    const accounts = await wallet.getAddresses();
    assert.ok(isAddressEqual(accounts[0], defaultRecipients[0]), 'Tài khoản node không khớp Hardhat Local.');
    const deploymentReceipts = [];
    async function deploy(contract, args) {
      const hash = await wallet.deployContract({ account: accounts[0], abi: contract.abi, bytecode: contract.bytecode, args });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
      assert.equal(receipt.status, 'success');
      assert.ok(receipt.contractAddress);
      deploymentReceipts.push(receipt);
      return { address: getAddress(receipt.contractAddress), receipt };
    }
    const token = await deploy(tokenArtifact, [recipients]);
    const instanceKey = toHex(randomBytes(32));
    const factory = await deploy(factoryArtifact, [token.address, instanceKey]);
    const vault = await deploy(vaultArtifact, [token.address]);
    let ethAirdrops = 0;
    for (const address of recipients.filter(address => !defaultRecipients.includes(address))) {
      if (await publicClient.getBalance({ address }) < parseEther('1')) {
        const hash = await wallet.sendTransaction({ account: accounts[0], to: address, value: parseEther('1') });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
        assert.equal(receipt.status, 'success');
        deploymentReceipts.push(receipt);
        ethAirdrops++;
      }
    }
    const [tokenCode, factoryCode, vaultCode, genesis] = await Promise.all([
      publicClient.getCode({ address: token.address }), publicClient.getCode({ address: factory.address }),
      publicClient.getCode({ address: vault.address }), publicClient.getBlock({ blockNumber: 0n }),
    ]);
    assert.ok(tokenCode && tokenCode !== '0x' && factoryCode && factoryCode !== '0x' && vaultCode && vaultCode !== '0x');
    const manifest = {
      chainId: 31337, projectPayments: 1, escrowPolicy: 2, factoryRevision: 2, instanceKey,
      token: token.address, tokenCodeHash: keccak256(tokenCode),
      factory: factory.address, factoryCodeHash: keccak256(factoryCode),
      startBlock: factory.receipt.blockNumber.toString(), startBlockHash: factory.receipt.blockHash,
      accounts: { client: defaultRecipients[0], freelancer: defaultRecipients[1], arbitrator: defaultRecipients[2] },
      tokenCreationTxHash: token.receipt.transactionHash,
      vault: vault.address, vaultCodeHash: keccak256(vaultCode),
      vaultStartBlock: vault.receipt.blockNumber.toString(), vaultStartBlockHash: vault.receipt.blockHash,
    };
    const amount = parseUnits('1000', 18);
    async function verify(client) {
      assert.equal(await client.getChainId(), 31337);
      assert.equal((await client.getBlock({ blockNumber: 0n })).hash, genesis.hash);
      for (const [address, expectedHash] of [[token.address, manifest.tokenCodeHash], [factory.address, manifest.factoryCodeHash], [vault.address, manifest.vaultCodeHash]]) {
        const code = await client.getCode({ address });
        assert.ok(code && code !== '0x'); assert.equal(keccak256(code), expectedHash);
      }
      for (const receipt of deploymentReceipts) {
        const restored = await client.getTransactionReceipt({ hash: receipt.transactionHash });
        assert.equal(restored.status, 'success'); assert.equal(restored.blockHash, receipt.blockHash);
      }
      assert.equal(await client.readContract({ address: token.address, abi: tokenArtifact.abi, functionName: 'name' }), 'Freelance Token');
      assert.equal(await client.readContract({ address: token.address, abi: tokenArtifact.abi, functionName: 'symbol' }), 'FESC');
      assert.equal(await client.readContract({ address: token.address, abi: tokenArtifact.abi, functionName: 'decimals' }), 18);
      assert.equal(await client.readContract({ address: token.address, abi: tokenArtifact.abi, functionName: 'totalSupply' }), amount * BigInt(recipients.length));
      for (const address of recipients) {
        assert.equal(await client.readContract({ address: token.address, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [address] }), amount);
        assert.ok(await client.getBalance({ address }) >= parseEther('1'), 'Ví thử chưa có đủ ETH mới để trả gas.');
      }
      assert.equal(await client.readContract({ address: factory.address, abi: factoryArtifact.abi, functionName: 'instanceKey' }), instanceKey);
      assert.ok(isAddressEqual(await client.readContract({ address: factory.address, abi: factoryArtifact.abi, functionName: 'token' }), token.address));
      assert.ok(isAddressEqual(await client.readContract({ address: vault.address, abi: vaultArtifact.abi, functionName: 'token' }), token.address));
      assert.equal(await client.readContract({ address: vault.address, abi: vaultArtifact.abi, functionName: 'totalDeposited' }), 0n);
    }
    await verify(publicClient);
    await node.close(); node = null;
    node = await startDurableHardhatNode({ port: 0, state: stagedState });
    await verify(createPublicClient({ chain: hardhat, transport: http(node.url, { retryCount: 0 }) }));
    await node.close(); node = null;
    console.log('Đã kiểm tra lại block, receipt, bytecode, token, vault và số dư sau khi mở lại state.');
    await writeFile(stagedManifest, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    await mkdir(dirname(state), { recursive: true });
    const lock = await open(marker, 'wx'); markerOwned = true;
    try { await lock.writeFile(JSON.stringify({ backup, stagedState, pid: process.pid }, null, 2)); await lock.sync(); }
    finally { await lock.close(); }
    assert.ok(!existsSync(state), 'State khác vừa được tạo; không ghi đè.');
    assert.ok(!await listening(8545), 'Node khác vừa mở cổng 8545; không thay deployment.');
    for (const [name, before] of previous) {
      const now = await optionalRead(resolve(root, '.hardhat', name));
      assert.ok(before === null ? now === null : now !== null && before.equals(now), `Manifest ${name} đã đổi trong lúc khởi tạo; không ghi đè.`);
    }
    await writeFile(resolve(backup, 'new-state.initialized.json'), await readFile(stagedState), { flag: 'wx' });
    await rename(stagedState, state); promotedState = true;
    await rename(stagedManifest, resolve(root, '.hardhat/local-fesc-deployment.json')); manifestChanged = true;
    if (previous.get('local-deployment.json')) {
      await unlink(resolve(root, '.hardhat/local-deployment.json')); oldMockRemoved = true;
    }
    await unlink(marker); markerOwned = false;
    console.log(`Đã tạo môi trường mới: FESC ${manifest.token}; factory ${manifest.factory}; vault ${manifest.vault}.`);
    console.log(`${recipients.length} ví thử nhận 1.000 FESC/ví. Database và dự án cũ được giữ nguyên.`);
    if (ethAirdrops) console.log(`Đã gửi 1 ETH thử mới cho ${ethAirdrops} ví để trả gas; đây không phải khôi phục số dư cũ.`);
    console.log('Chạy npm.cmd run chain:node để mở RPC. Không chạy lại chain:init mỗi lần khởi động.');
  } catch (error) {
    if (node) { try { await node.close(); } catch (closeError) { console.error('Chưa đóng được node tạm:', closeError.message); } node = null; }
    try {
      if (manifestChanged) {
        const old = previous.get('local-fesc-deployment.json');
        if (old) await atomicWrite(resolve(root, '.hardhat/local-fesc-deployment.json'), old);
        else await unlink(resolve(root, '.hardhat/local-fesc-deployment.json'));
      }
      if (oldMockRemoved) await atomicWrite(resolve(root, '.hardhat/local-deployment.json'), previous.get('local-deployment.json'));
      if (promotedState) await rename(state, stagedState);
    } catch (rollbackError) {
      rollbackComplete = false;
      console.error(`Chưa hoàn tất rollback: ${rollbackError.message}. Giữ marker và kiểm tra backup ${backup}.`);
    }
    throw error;
  } finally {
    if (markerOwned && rollbackComplete) await unlink(marker);
  }
}

initialize().catch(error => { console.error(error.message); process.exitCode = 1; });
