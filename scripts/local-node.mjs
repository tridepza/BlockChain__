import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, readFile, rename } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { once } from 'node:events';

export function anvilBinary() {
  const platform = { win32: 'win32', linux: 'linux', darwin: 'darwin' }[process.platform];
  const architecture = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!platform || !architecture) throw new Error('Nền tảng này chưa có Anvil binary được hỗ trợ.');
  return fileURLToPath(new URL(`../node_modules/@foundry-rs/anvil-${platform}-${architecture}/bin/anvil${platform === 'win32' ? '.exe' : ''}`, import.meta.url));
}

export async function rpcAt(url, method, params = []) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  const data = await response.json();
  if (data.error) throw new Error(`${method}: ${data.error.message}`);
  return data.result;
}

export async function startPersistentNode({ port = 8545, state = resolve('.data/chain/state.json'), extra = [], save = true } = {}) {
  const url = `http://127.0.0.1:${port}`;
  const active = await rpcAt(url, 'web3_clientVersion').catch(() => null);
  if (active) throw new Error(`Cổng ${port} đã có node đang chạy. Không mở chain khác đè lên.`);
  mkdirSync(dirname(state), { recursive: true });
  const child = spawn(anvilBinary(), ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337',
    '--accounts', '20', '--balance', '10000', '--mnemonic', 'test test test test test test test test test test test junk',
    ...(save ? ['--state', state, '--state-interval', '5'] : existsSync(state) ? ['--load-state', state] : []), '--silent', ...extra],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let failure = '';
  child.stderr.on('data', chunk => { failure += chunk.toString().slice(0, 2000); });
  child.on('error', error => { failure = error.message; });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null || failure) throw new Error(`Không khởi động được Anvil: ${failure || child.exitCode}`);
    try { if (/anvil/i.test(await rpcAt(url, 'web3_clientVersion'))) return { child, url, state }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('Anvil không mở RPC trong thời gian chờ.');
}

export async function startDurableAnvilNode({ port = 8545, internalPort = 8547, state = resolve('.data/chain/state.json') } = {}) {
  if (await rpcAt(`http://127.0.0.1:${port}`, 'web3_clientVersion').catch(() => null)) throw new Error(`Cổng ${port} đang được dùng.`);
  const node = await startPersistentNode({ port: internalPort, state, save: false });
  let pending = Promise.resolve();
  let lastBlock;
  async function checkpoint() {
    const dumped = await rpcAt(node.url, 'anvil_dumpState');
    const file = await open(state + '.checkpoint', 'w');
    try { await file.writeFile(gunzipSync(Buffer.from(dumped.slice(2), 'hex'))); await file.sync(); }
    finally { await file.close(); }
    await rename(state + '.checkpoint', state);
    lastBlock = await rpcAt(node.url, 'eth_blockNumber');
  }
  const queue = operation => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  try { await checkpoint(); } catch (error) { node.child.kill(); throw error; }
  const denied = /^(?:anvil_(?:reset|loadState|setCode|setStorageAt|setBalance|setNonce|setChainId|setAutomine|autoImpersonateAccount|impersonateAccount)|hardhat_.*|evm_(?:revert|snapshot|setAutomine|setIntervalMining))$/;
  async function relay(input) {
    if (!input || typeof input.method !== 'string') return { jsonrpc: '2.0', id: input?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    if (denied.test(input.method)) return { jsonrpc: '2.0', id: input.id, error: { code: -32000, message: 'Thao tác xóa/sửa state bị chặn trên node lưu số dư.' } };
    const mutation = /^(?:eth_send|evm_|anvil_mine)/.test(input.method);
    async function execute() {
      const result = await (await fetch(node.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input), signal: AbortSignal.timeout(15_000) })).json();
      if (mutation && !result.error) {
        if (/^eth_send/.test(input.method) && /^0x[\da-f]{64}$/i.test(result.result)) {
          let mined = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            if (await rpcAt(node.url, 'eth_getTransactionReceipt', [result.result])) { mined = true; break; }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          if (!mined) throw new Error('Giao dịch chưa được đào; chưa xác nhận lưu bền vững.');
        }
        await checkpoint();
      }
      return result;
    }
    return mutation ? queue(execute) : execute();
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error('RPC body too large'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const result = Array.isArray(input) ? await Promise.all(input.map(relay)) : await relay(input);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null,
      error: { code: -32000, message: 'RPC hoặc checkpoint thất bại. Kiểm tra giao dịch trước khi gửi lại.' } })); }
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { node.child.kill(); throw error; }
  const timer = setInterval(() => void queue(async () => {
    if (await rpcAt(node.url, 'eth_blockNumber') !== lastBlock) await checkpoint();
  }).catch(() => console.error('Không ghi được checkpoint blockchain.')), 30_000);
  node.child.once('exit', () => { clearInterval(timer); server.close(); });
  let closed = false;
  return { ...node, url: `http://127.0.0.1:${port}`, async close() {
    if (closed) return; closed = true;
    clearInterval(timer);
    await new Promise(resolve => server.close(resolve));
    if (node.child.exitCode !== null || node.child.signalCode !== null) return;
    try { await queue(checkpoint); } finally {
      if (node.child.exitCode === null && node.child.signalCode === null) {
        const exited = once(node.child, 'exit'); node.child.kill(); await exited;
      }
    }
  } };
}

// New chains use Hardhat's signed-block journal on every supported OS. Existing
// Anvil snapshots stay with Anvil; never reinterpret or overwrite their state.
export async function startDurableNode(options = {}) {
  const state = options.state ?? resolve('.data/chain/state.json');
  let existing;
  if (existsSync(state)) existing = JSON.parse(await readFile(state, 'utf8'));
  const { startDurableHardhatNode, HARDHAT_JOURNAL_FORMAT } = await import('./hardhat-node.mjs');
  if (existing && existing.format !== HARDHAT_JOURNAL_FORMAT) return startDurableAnvilNode(options);
  return startDurableHardhatNode(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const state = resolve('.data/chain/state.json');
  try {
    if (existsSync('.data/chain/init-in-progress.json')) {
      throw new Error('Khởi tạo chain chưa hoàn tất. Kiểm tra bản sao lưu được ghi trong .data/chain/init-in-progress.json trước khi khởi động.');
    }
    if (!existsSync(state) && (existsSync('.hardhat/local-fesc-deployment.json') || existsSync('.hardhat/local-deployment.json'))) {
      throw new Error('Thiếu state của deployment cũ. Khôi phục backup hoặc dùng chain:init -- --new để chủ động tạo môi trường mới có sao lưu; không tự triển khai đè.');
    }
    const node = await startDurableNode({ state });
    console.log(`FESC Local RPC ${node.url} · Chain ID 31337\nTrạng thái tự lưu: ${state}`);
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
      if (closing) return; closing = true;
      try { await node.close(); }
      catch { console.error('Chưa ghi được checkpoint cuối. Kiểm tra state đã lưu trước khi khởi động lại.'); }
    });
    node.child?.once('exit', code => { process.exitCode = code ?? 0; });
  } catch (error) {
    console.error(`Không khởi động được blockchain: ${error.message}`);
    process.exitCode = 1;
  }
}
