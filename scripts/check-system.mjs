import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configuredDatabase } from '../server/database.mjs';
import { otpMailer } from '../server/mail.mjs';
import { checkLocalDeployment } from '../server/wallet.mjs';
import { createPublicClient, http, keccak256, parseAbi } from 'viem';
import { localChain } from '../src/local-chain.ts';

// Readiness only: no migrations, transactions, deployments or email deliveries.
const root = process.cwd();
const checks = [];
async function check(name, action) {
  try {
    checks.push({ name, ok: true, detail: await action() });
  } catch (error) {
    checks.push({ name, ok: false, detail: error.message });
  }
}

await check('Node.js', async () => {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Cần Node.js 24 trở lên.');
  return process.version;
});

await Promise.all([
  check('Database', async () => {
    let connection;
    try {
      connection = configuredDatabase(root);
      if (!connection) {
        const filename = resolve(root, process.env.ESCROW_DB_PATH || '.data/escrow.sqlite');
        if (!existsSync(filename)) throw new Error('Chưa có SQLite. Khởi động website để tạo database.');
        const sqlite = new DatabaseSync(filename, { readOnly: true });
        try { sqlite.prepare('SELECT 1 FROM users LIMIT 1').get(); }
        finally { sqlite.close(); }
        return 'SQLite đã sẵn sàng.';
      }
      const status = await connection.db.check();
      if (!status.ready) throw new Error('Database chưa được khởi tạo. Chạy npm.cmd run db:migrate.');
      return `${connection.name}: dữ liệu đã sẵn sàng.`;
    } catch (error) {
      if (connection) throw new Error(connection.explainError(error));
      throw error;
    } finally {
      await connection?.db.close();
    }
  }),
  check('Email OTP', async () => {
    try { await otpMailer(root).verify(); }
    catch { throw new Error('Kiểm tra SMTP thất bại. Chạy npm.cmd run mail:check; kiểm tra .env.mail.local.'); }
    return 'SMTP kết nối được (không gửi email).';
  }),
  check('Web/API', async () => {
    let response;
    try {
      response = await fetch('http://127.0.0.1:5173/api/projects/public', { signal: AbortSignal.timeout(8000) });
      if (!response.ok || !Array.isArray((await response.json()).projects)) throw new Error();
    } catch { throw new Error('Chưa truy cập được API ở cổng 5173. Mở terminal chạy npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort.'); }
    return 'http://127.0.0.1:5173 hoạt động.';
  }),
  check('Blockchain FESC', async () => {
    const state = resolve(root, '.data/chain/state.json');
    const manifestPath = resolve(root, '.hardhat/local-fesc-deployment.json');
    if (existsSync(resolve(root, '.data/chain/init-in-progress.json'))) {
      throw new Error('Khởi tạo chain chưa hoàn tất. Kiểm tra .data/chain/init-in-progress.json và bản sao lưu.');
    }
    if (!existsSync(state) && existsSync(manifestPath)) {
      throw new Error('Có deployment cũ nhưng thiếu .data/chain/state.json. Cần bản sao lưu/chain cũ; không deploy đè để che lỗi.');
    }
    const rpc = createPublicClient({ transport: http(localChain.rpcUrl, { timeout: 3000, retryCount: 0 }) });
    try {
      if (await rpc.getChainId() !== localChain.id) throw new Error();
    } catch { throw new Error('RPC 8545 chưa sẵn sàng. Mở terminal chạy npm.cmd run chain:node.'); }
    if (!existsSync(manifestPath)) throw new Error('Chưa triển khai FESC và factory cho chain này.');
    let deployment;
    try { deployment = await checkLocalDeployment(root, undefined, 'FESC'); }
    catch { throw new Error('Deployment FESC không khớp blockchain hiện tại. Cần khôi phục đúng chain.'); }
    const code = await rpc.getCode({ address: deployment.token });
    if (!code || keccak256(code) !== deployment.tokenCodeHash) throw new Error('Bytecode token FESC không khớp deployment.');
    if (!deployment.vault) throw new Error('Chưa có vault. Với chain đã xác minh, chạy npm.cmd run chain:deploy:vault một lần.');
    const vaultCode = await rpc.getCode({ address: deployment.vault });
    const token = await rpc.readContract({ address: deployment.vault, abi: parseAbi(['function token() view returns (address)']), functionName: 'token' });
    if (!vaultCode || keccak256(vaultCode) !== deployment.vaultCodeHash || token.toLowerCase() !== deployment.token.toLowerCase()) {
      throw new Error('Vault không khớp deployment FESC.');
    }
    JSON.parse(readFileSync(state, 'utf8'));
    return 'Chain 31337, token/factory/vault và state đã xác minh.';
  }),
]);

for (const result of checks) console.log(`${result.ok ? 'OK' : 'LỖI'} | ${result.name}: ${result.detail}`);
const failures = checks.filter(result => !result.ok).length;
console.log(failures ? `Còn ${failures} thành phần chưa sẵn sàng.` : 'Tất cả thành phần đã sẵn sàng.');
process.exitCode = failures ? 1 : 0;
