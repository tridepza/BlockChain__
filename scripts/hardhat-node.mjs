import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer as createMutexServer } from 'node:net';
import { promisify } from 'node:util';
import { network } from 'hardhat';
import { keccak256, serializeTransaction } from 'viem';

export const HARDHAT_JOURNAL_FORMAT = 'fesc-hardhat-journal';
const mnemonic = 'test test test test test test test test test test test junk';
const mutationMethods = new Set(['eth_sendTransaction', 'eth_sendRawTransaction', 'evm_mine', 'evm_increaseTime', 'evm_setNextBlockTimestamp']);
const readMethods = /^(?:eth_(?:get\w+|call|estimateGas|chainId|blockNumber|gasPrice|maxPriorityFeePerGas|feeHistory|accounts|sign|signTypedData_v4|newFilter|newBlockFilter|newPendingTransactionFilter|uninstallFilter)|web3_(?:clientVersion|sha3)|net_(?:version|listening|peerCount)|hardhat_metadata)$/;
const execFileAsync = promisify(execFile);
let ownProcessIdentity;

async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('PID trong khóa state không hợp lệ.');
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
    { windowsHide: true, timeout: 5000, maxBuffer: 16_384 });
    const ticks = stdout.trim();
    if (!/^\d+$/.test(ticks)) throw new Error('Không đọc được thời điểm tạo tiến trình Windows.');
    return `windows:${ticks}`;
  }
  if (process.platform === 'linux') {
    const [stat, boot] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ]);
    // The command name may contain spaces or parentheses; field 22 follows it.
    const started = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
    if (!/^\d+$/.test(started)) throw new Error('Không đọc được thời điểm tạo tiến trình Linux.');
    return `linux:${boot.trim()}:${started}`;
  }
  // Other systems retain conservative PID-only locking until an OS identity is supported.
  return null;
}

function signedTransaction(tx) {
  const n = key => tx[key] == null ? undefined : BigInt(tx[key]);
  const type = { '0x0': 'legacy', '0x1': 'eip2930', '0x2': 'eip1559' }[tx.type ?? '0x0'];
  if (!type) throw new Error(`Loại giao dịch chưa được hỗ trợ: ${tx.type}.`);
  const raw = serializeTransaction({ type, chainId: Number(n('chainId') ?? 31337n), nonce: Number(n('nonce')),
    gas: n('gas'), to: tx.to ?? undefined, value: n('value'), data: tx.input,
    ...(type === 'eip1559' ? { maxFeePerGas: n('maxFeePerGas'), maxPriorityFeePerGas: n('maxPriorityFeePerGas') }
      : { gasPrice: n('gasPrice') }),
    ...(type === 'legacy' ? {} : { accessList: tx.accessList ?? [] }),
  }, { r: tx.r, s: tx.s, v: n('v'), ...(tx.yParity == null ? {} : { yParity: Number(n('yParity')) }) });
  if (keccak256(raw) !== tx.hash) throw new Error('Chữ ký giao dịch không khớp; không xác nhận lưu state.');
  return raw;
}

async function writeJournal(path, journal) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.checkpoint`;
  const file = await open(temporary, 'wx');
  try {
    await file.writeFile(JSON.stringify(journal));
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  // fsync the directory where the platform supports it, in addition to the file.
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

async function lockJournal(path) {
  const lockPath = path + '.lock';
  // The OS releases this mutex even on SIGKILL. It serializes stale-file
  // recovery as well as acquisition, so one starter cannot remove another's
  // newly acquired lock. Hash collisions/occupied ports fail conservatively.
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  const port = 20_000 + createHash('sha256').update(key).digest().readUInt32BE(0) % 40_000;
  const mutex = createMutexServer(socket => socket.destroy());
  const releaseMutex = () => new Promise(done => mutex.close(() => done()));
  try {
    await new Promise((ready, reject) => {
      mutex.once('error', reject);
      mutex.listen({ host: '127.0.0.1', port, exclusive: true }, ready);
    });
  } catch (error) {
    await releaseMutex();
    if (error.code === 'EADDRINUSE') {
      throw new Error(`State blockchain đang được một tiến trình khác sử dụng hoặc cổng khóa ${port} đang bị chiếm.`);
    }
    throw error;
  }
  try {
    ownProcessIdentity ??= processIdentity(process.pid);
    const owner = { pid: process.pid, identity: await ownProcessIdentity, nonce: randomUUID() };
    let previousText;
    try { previousText = await readFile(lockPath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previousText !== undefined) {
      let previous;
      try {
        previous = JSON.parse(previousText);
        if (!Number.isSafeInteger(previous?.pid) || previous.pid <= 0 || typeof previous.nonce !== 'string') previous = null;
      } catch { previous = null; }
      if (!previous) {
        // Older versions could die between creating and writing the lock.
        // Never remove a fresh incomplete lock that may still be publishing.
        if (Date.now() - (await stat(lockPath)).mtimeMs < 60_000) {
          throw new Error('Khóa state chưa hoàn chỉnh và còn mới. Thử lại sau 60 giây; không xóa state blockchain.');
        }
      } else {
        let alive = true;
        try { process.kill(previous.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
        if (alive && previous.identity) {
          // A PID can belong to an unrelated process after reboot or PID reuse.
          try {
            const identity = previous.pid === process.pid ? await ownProcessIdentity : await processIdentity(previous.pid);
            if (identity !== null && identity !== previous.identity) alive = false;
          } catch { /* If identity is unavailable, preserve the lock. */ }
        }
        if (alive) throw new Error('State blockchain đang được một tiến trình khác sử dụng.');
      }
    }
    // Publish only complete, fsynced owner data. A crash during the temporary
    // write leaves no incomplete lock at the shared path.
    const temporary = `${lockPath}.${owner.nonce}.tmp`;
    try {
      const file = await open(temporary, 'wx');
      try { await file.writeFile(JSON.stringify(owner)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, lockPath);
    } finally { await unlink(temporary).catch(() => {}); }
    return async () => {
      try {
        const current = JSON.parse(await readFile(lockPath, 'utf8'));
        if (current.nonce === owner.nonce) await unlink(lockPath);
      } finally { await releaseMutex(); }
    };
  } catch (error) {
    await releaseMutex();
    throw error;
  }
}

/**
 * Local development chain backed by an exact, signed-block replay journal.
 * Uses the installed Hardhat provider; never modifies OS application policy.
 * A successful mutation response means its resulting blocks are fsynced.
 */
export async function startDurableHardhatNode({ port = 8545, state = resolve('.data/chain/state.json') } = {}) {
  state = resolve(state);
  await mkdir(dirname(state), { recursive: true });
  // Resolve junction/symlink aliases before choosing either mutex or journal.
  try { state = await realpath(state); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = join(await realpath(dirname(state)), basename(state));
  }
  const unlock = await lockJournal(state);
  let connection;
  let server;
  try {
    let journal;
    if (existsSync(state)) {
      journal = JSON.parse(await readFile(state, 'utf8'));
      if (journal.format !== HARDHAT_JOURNAL_FORMAT || journal.version !== 1) {
        throw new Error('State này không phải journal Hardhat. Giữ nguyên tệp Anvil/backup; không tự chuyển hoặc ghi đè.');
      }
    } else {
      journal = { format: HARDHAT_JOURNAL_FORMAT, version: 1,
        config: { initialDate: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), hardfork: 'shanghai' },
        blocks: [], pendingTimeIncrease: 0, nextTimestamp: null };
    }
    connection = await network.create({ network: 'node', override: {
      chainId: 31337, hardfork: journal.config.hardfork, initialDate: journal.config.initialDate,
      accounts: { mnemonic, count: 20, accountsBalance: '10000000000000000000000' },
      initialBaseFeePerGas: 1_000_000_000, blockGasLimit: 30_000_000,
      mining: { auto: false, mempool: { order: 'fifo' } }, loggingEnabled: false,
    } });
    const rpc = (method, params = []) => connection.provider.request({ method, params });
    const engine = await rpc('web3_clientVersion');
    const genesis = await rpc('eth_getBlockByNumber', ['0x0', false]);
    if (journal.genesisHash && (journal.genesisHash !== genesis.hash || journal.engine !== engine)) {
      throw new Error('Phiên bản Hardhat hoặc genesis không khớp state. Giữ nguyên state và khôi phục đúng bộ thư viện.');
    }
    journal.engine = engine;
    journal.genesisHash = genesis.hash;
    for (const block of journal.blocks) {
      await rpc('evm_setNextBlockTimestamp', [Number(BigInt(block.timestamp))]);
      await rpc('hardhat_setNextBlockBaseFeePerGas', [block.baseFeePerGas]);
      await rpc('hardhat_setCoinbase', [block.miner]);
      await rpc('evm_setBlockGasLimit', [block.gasLimit]);
      await rpc('hardhat_setPrevRandao', [block.mixHash]);
      for (const tx of block.transactions) {
        if (keccak256(tx.raw) !== tx.hash || await rpc('eth_sendRawTransaction', [tx.raw]) !== tx.hash) {
          throw new Error('Journal giao dịch không khớp chữ ký. Không mở RPC.');
        }
      }
      await rpc('evm_mine');
      const restored = await rpc('eth_getBlockByNumber', [block.number, false]);
      if (!restored || restored.hash !== block.hash) throw new Error(`Block ${block.number} không khớp journal. Không mở RPC.`);
      for (const tx of block.transactions) {
        const receipt = await rpc('eth_getTransactionReceipt', [tx.hash]);
        if (!receipt || receipt.status !== tx.status || receipt.blockHash !== block.hash) {
          throw new Error('Receipt không khớp journal. Không mở RPC.');
        }
      }
    }
    if (journal.pendingTimeIncrease) await rpc('evm_increaseTime', [journal.pendingTimeIncrease]);
    if (journal.nextTimestamp !== null) await rpc('evm_setNextBlockTimestamp', [journal.nextTimestamp]);
    await rpc('evm_setAutomine', [true]);
    await writeJournal(state, journal);
    let pending = Promise.resolve();
    let poisoned = false;
    let closing = false;
    const queue = operation => {
      const result = pending.then(operation);
      pending = result.catch(() => {});
      return result;
    };
    async function checkpoint() {
      const tip = Number(BigInt(await rpc('eth_blockNumber')));
      for (let height = journal.blocks.length + 1; height <= tip; height++) {
        const block = await rpc('eth_getBlockByNumber', ['0x' + height.toString(16), true]);
        const transactions = [];
        for (const tx of block.transactions) {
          const receipt = await rpc('eth_getTransactionReceipt', [tx.hash]);
          if (!receipt || receipt.blockHash !== block.hash) throw new Error('Giao dịch chưa được xác nhận trong block.');
          transactions.push({ hash: tx.hash, raw: signedTransaction(tx), status: receipt.status });
        }
        journal.blocks.push({ number: block.number, timestamp: block.timestamp, hash: block.hash,
          baseFeePerGas: block.baseFeePerGas, miner: block.miner, gasLimit: block.gasLimit, mixHash: block.mixHash, transactions });
        journal.pendingTimeIncrease = 0;
        journal.nextTimestamp = null;
      }
      await writeJournal(state, journal);
    }
    async function relay(input) {
      const id = input?.id ?? null;
      if (!input || input.jsonrpc !== '2.0' || typeof input.method !== 'string' ||
          (input.params !== undefined && !Array.isArray(input.params))) {
        return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } };
      }
      const { method } = input;
      const params = input.params ?? [];
      if (!mutationMethods.has(method) && !readMethods.test(method)) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'RPC này bị chặn trên node lưu số dư.' } };
      }
      return queue(async () => {
        if (poisoned || closing) return { jsonrpc: '2.0', id, error: { code: -32000, message: 'Node chưa sẵn sàng hoặc lưu state thất bại. Kiểm tra journal trước khi gửi lại.' } };
        let result;
        let failure;
        try { result = await rpc(method, params); } catch (error) { failure = error; }
        if (mutationMethods.has(method)) {
          try {
            if (!failure && method === 'evm_increaseTime') journal.pendingTimeIncrease += Number(params[0]);
            if (!failure && method === 'evm_setNextBlockTimestamp') journal.nextTimestamp = Number(params[0]);
            await checkpoint();
          } catch {
            poisoned = true;
            return { jsonrpc: '2.0', id, error: { code: -32000, message: 'Không ghi được journal blockchain; chưa xác nhận giao dịch. Dừng node và kiểm tra state trước khi thử lại.' } };
          }
        }
        if (failure) return { jsonrpc: '2.0', id, error: { code: Number.isInteger(failure.code) ? failure.code : -32000,
          message: failure.message, ...(failure.data === undefined ? {} : { data: failure.data }) } };
        return { jsonrpc: '2.0', id, result };
      });
    }
    server = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let output;
        if (Array.isArray(input)) {
          if (!input.length || input.length > 100) throw new Error('Invalid batch');
          output = [];
          for (const item of input) output.push(await relay(item));
        } else output = await relay(input);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(output));
      } catch {
        if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC request' } }));
      }
    });
    await new Promise((ready, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', ready); });
    const address = server.address();
    let closePromise;
    return { url: `http://127.0.0.1:${address.port}`, state,
      close() {
        closePromise ??= (async () => {
          closing = true;
          try {
            await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
          } finally {
            await pending;
            try { await connection.close(); }
            finally { await unlock(); }
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    try {
      if (server?.listening) await new Promise(done => server.close(done));
    } finally {
      try { await connection?.close(); }
      finally { await unlock(); }
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const state = resolve(value('state') || '.data/chain/state.json');
  if (!value('state') && !existsSync(state) && existsSync('.hardhat/local-fesc-deployment.json')) {
    throw new Error('Đã có deployment nhưng thiếu state. Khôi phục state cũ trước; không tự tạo chain rỗng.');
  }
  const node = await startDurableHardhatNode({ port: Number(value('port') || 8545), state });
  console.log(`FESC Hardhat RPC ${node.url} · Chain ID 31337\nJournal tự lưu: ${node.state}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void node.close().catch(error => { console.error(error.message); process.exitCode = 1; }));
}
