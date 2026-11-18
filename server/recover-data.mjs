import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BSON } from 'mongodb';
import { configuredDatabase } from './database.mjs';
import { postgresConfig, openPostgres } from './postgres.mjs';

const source = process.argv[2] ?? 'sqlite';
const apply = process.argv.includes('--apply');
if (!['sqlite', 'postgres'].includes(source)) throw new Error('Chọn nguồn sqlite hoặc postgres. Mặc định chỉ kiểm tra; thêm --apply để khôi phục.');
const target = configuredDatabase();
if (target?.target.driver !== 'mongodb') throw new Error('db:recover cần MongoDB làm database đích.');
let sourceDb;
try {
  if (!(await target.db.check()).ready) throw new Error('Chạy db:migrate trước.');
  let query;
  let identity;
  if (source === 'sqlite') {
    const path = resolve(process.argv.find(arg => arg.endsWith('.sqlite')) ?? '.data/escrow.sqlite');
    sourceDb = new DatabaseSync(path, { readOnly: true });
    query = sql => sourceDb.prepare(sql).all();
    identity = path;
  } else {
    const config = postgresConfig(process.cwd(), 'postgres');
    sourceDb = openPostgres(config);
    query = sql => sourceDb.query(sql);
    identity = `${config.host}:${config.port}/${config.database}`;
  }
  const sourceId = createHash('sha256').update(source + ':' + identity).digest('hex');
  const accounts = await query('SELECT * FROM users');
  const projects = (await query('SELECT data FROM projects ORDER BY id')).map(row => JSON.parse(row.data));
  const txs = (await query('SELECT data FROM transactions ORDER BY id')).map(row => JSON.parse(row.data));
  async function optionalTable(table) {
    try { return await query(`SELECT * FROM ${table}`); }
    catch (error) {
      if (error.code === '42P01' || /no such table/.test(error.message)) return [];
      throw error;
    }
  }
  const wallets = await optionalTable('wallet_links');
  const files = await optionalTable('delivery_files');
  const balances = await optionalTable('mock_balances');
  const existing = await target.store.readWorkspace();
  const pending = projects.filter(project => !existing.projects.some(item => item.recoveredFrom?.source === sourceId && item.recoveredFrom.projectId === project.id));
  console.log(`${source}: ${accounts.length} tài khoản, ${projects.length} dự án, ${txs.length} giao dịch. Dự án chưa khôi phục: ${pending.length}.`);
  if (apply && pending.length) {
    await mkdir(resolve('.data/backups'), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(resolve(`.data/backups/mongo-before-recovery-${stamp}.json`), BSON.EJSON.stringify(await target.db.snapshot()));
    const counts = await target.store.transaction(async writes => {
      const userMap = new Map();
      const newUsers = new Set();
      const counts = { accounts: 0, projects: 0, transactions: 0, walletConflicts: 0 };
      for (const account of accounts) {
        let saved = await writes.getUserByEmail(account.email);
        if (!saved) {
          const id = await writes.getUserById(account.id) ? randomUUID() : account.id;
          saved = { ...account, id, salt: Buffer.from(account.salt), password_hash: Buffer.from(account.password_hash) };
          if (!await writes.createUser(saved)) throw new Error('Tài khoản thay đổi trong lúc khôi phục. Hãy chạy lại.');
          newUsers.add(id); counts.accounts++;
        }
        userMap.set(account.id, saved.id);
      }
      for (const row of wallets) {
        const id = userMap.get(row.user_id);
        if (newUsers.has(id)) {
          const wallet = JSON.parse(row.data);
          if (await writes.getWalletOwner(wallet.address)) counts.walletConflicts++;
          else if (!await writes.insertWalletLink(id, wallet)) throw new Error('Ví thay đổi trong lúc khôi phục. Hãy chạy lại.');
        }
      }
      for (const row of balances) {
        const id = userMap.get(row.user_id);
        if (newUsers.has(id)) {
          if (Number(row.claimed)) await writes.claimMock(id, 0);
          if (Number(row.cents)) await writes.creditMock(id, Number(row.cents));
        }
      }
      const projectMap = new Map();
      const current = await writes.readWorkspace();
      for (const project of projects) {
        const recovered = current.projects.find(item => item.recoveredFrom?.source === sourceId && item.recoveredFrom.projectId === project.id);
        if (recovered) { projectMap.set(project.id, recovered.id); continue; }
        const ownerId = userMap.get(project.ownerId);
        const freelancerId = project.freelancerId ? userMap.get(project.freelancerId) : undefined;
        if (!ownerId || (project.freelancerId && !freelancerId)) throw new Error('Dự án có chủ sở hữu không tồn tại. Dừng để bảo toàn dữ liệu.');
        const restored = { ...project, ownerId, freelancerId, recoveredFrom: { source: sourceId, projectId: project.id } };
        if (project.cancellation) restored.cancellation = { ...project.cancellation, proposerId: userMap.get(project.cancellation.proposerId) };
        if (project.fesc) restored.fesc = { ...project.fesc, reference: project.fesc.reference ?? {
          projectId: project.id, ownerId: project.ownerId, freelancerId: project.freelancerId,
        } };
        const saved = await writes.createProject(restored);
        projectMap.set(project.id, saved.id); counts.projects++;
      }
      for (const row of files) {
        if (!await writes.getDeliveryFile(row.delivery_id, row.kind)) await writes.saveDeliveryFile(row.delivery_id, row.kind, JSON.parse(row.data));
      }
      for (const tx of txs) {
        const projectId = projectMap.get(tx.projectId);
        if (!projectId || current.txs.some(item => item.id === tx.id && item.projectId === projectId)) continue;
        await writes.addTransaction({ ...tx, projectId }); counts.transactions++;
      }
      return counts;
    });
    console.log('Đã khôi phục:', JSON.stringify(counts));
  }
} finally {
  await sourceDb?.close();
  await target.db.close();
}
