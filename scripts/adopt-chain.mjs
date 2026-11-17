import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configuredDatabase } from '../server/database.mjs';
import { rpcAt } from './local-node.mjs';

const changes = JSON.parse(await readFile(resolve('.data/chain/repin.json'), 'utf8'));
if (!/anvil/i.test(await rpcAt('http://127.0.0.1:8545', 'web3_clientVersion'))) throw new Error('Chạy node Anvil đã khôi phục trước.');
const connection = configuredDatabase();
try {
  for (const change of changes) {
    const path = resolve('.hardhat', change.filename);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const block = await rpcAt('http://127.0.0.1:8545', 'eth_getBlockByNumber', ['0x' + BigInt(manifest.startBlock).toString(16), false]);
    if (block.hash !== change.next || manifest.instanceKey !== change.instanceKey) throw new Error('Manifest không khớp chain di chuyển.');
    manifest.startBlockHash = change.next;
    await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
    if (connection) await connection.store.transaction(async writes => {
      const { projects } = await writes.readWorkspace();
      for (const project of projects) {
        if (project.fesc?.deployment.instanceKey === change.instanceKey && project.fesc.deployment.startBlockHash === change.previous) {
          await writes.saveProject({ ...project, fesc: { ...project.fesc,
            deployment: { ...project.fesc.deployment, startBlockHash: change.next } } });
        }
      }
    });
  }
  console.log('Đã giữ deployment/token hiện tại và cập nhật block xác minh của chain lưu bền vững.');
} finally { await connection?.db.close(); }
