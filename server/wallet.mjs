import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, formatEther, getAddress, http, isAddress, keccak256, numberToHex, parseAbi, recoverMessageAddress } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { localChain } from '../src/local-chain.ts';
import { WorkflowError } from '../src/workflow.ts';

const purpose = 'Link wallet to Freelancer Escrow';
const challengeLifetime = 5 * 60_000;
const factoryAbi = parseAbi(['function instanceKey() view returns (bytes32)']);
const rpc = createPublicClient({ transport: http(localChain.rpcUrl, { timeout: 2500, retryCount: 0 }) });
const expired = () => new WorkflowError(409, 'Yêu cầu ký đã hết hạn, đã dùng hoặc thuộc phiên khác. Hãy kết nối lại.');

export async function checkLocalDeployment(root, address, currency = 'MockUSDC', pinned) {
  let deployment;
  try {
    const manifest = currency === 'FESC' ? 'local-fesc-deployment.json' : 'local-deployment.json';
    deployment = pinned ?? JSON.parse(await readFile(resolve(root, '.hardhat', manifest), 'utf8'));
    // Parse before starting RPC calls so a malformed manifest cannot leave a request unhandled.
    const startBlockNumber = BigInt(deployment.startBlock);
    const [chainId, startBlock, factoryCode, instanceKey] = await Promise.all([
      rpc.getChainId(),
      rpc.getBlock({ blockNumber: startBlockNumber }),
      rpc.getCode({ address: deployment.factory }),
      rpc.readContract({ address: deployment.factory, abi: factoryAbi, functionName: 'instanceKey' }),
    ]);
    if (deployment.chainId !== localChain.id || chainId !== localChain.id ||
        startBlock.hash !== deployment.startBlockHash || !factoryCode || keccak256(factoryCode) !== deployment.factoryCodeHash ||
        instanceKey !== deployment.instanceKey) throw new Error('Invalid local deployment');
    if (address) {
      const walletCode = await rpc.getCode({ address });
      if (walletCode && walletCode !== '0x') throw new WorkflowError(400, 'Hãy dùng tài khoản ví Ethereum thông thường trên Hardhat.');
    }
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    const script = currency === 'FESC' ? 'chain:deploy:fesc' : 'chain:deploy';
    throw new WorkflowError(503, `Chưa xác minh được ${currency} trên Hardhat Local. Kiểm tra node và chạy ${script} nếu dùng chain mới.`);
  }
  return deployment;
}

export function walletLinking(root) {
  async function walletDeployment(address, expected) {
    for (const currency of ['FESC', 'MockUSDC']) {
      try {
        const deployment = await checkLocalDeployment(root, address, currency);
        if (!expected || deployment.instanceKey === expected) return deployment;
      } catch (error) {
        if (error.status !== 503) throw error;
      }
    }
    if (expected) throw expired();
    throw new WorkflowError(503, 'Chưa có triển khai Hardhat Local hợp lệ. Hãy chạy chain:deploy:fesc.');
  }

  return {
    getOrigin(req) {
      const scheme = req.socket.encrypted ? 'https' : 'http';
      const origin = scheme + '://127.0.0.1:' + req.socket.localPort;
      if (req.headers.origin !== origin) throw new WorkflowError(403, 'Hãy mở website tại ' + origin + ' để liên kết ví.');
      return origin;
    },
    async localStatus(address) {
      const deployment = await walletDeployment(address);
      const balance = await rpc.getBalance({ address });
      return { eth: formatEther(balance), deploymentBlock: numberToHex(BigInt(deployment.startBlock)), deploymentBlockHash: deployment.startBlockHash };
    },
    async challenge(input, authenticatedWrite, userId, sessionId, origin) {
      if (input.chainId !== localChain.id) throw new WorkflowError(400, 'Hãy chuyển MetaMask sang Hardhat Local (31337).');
      if (typeof input.address !== 'string' || !isAddress(input.address)) throw new WorkflowError(400, 'Địa chỉ ví không hợp lệ.');
      const address = getAddress(input.address);
      const { instanceKey: deployment } = await walletDeployment(address);
      const url = new URL(origin);
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + challengeLifetime);
      const challengeId = randomUUID();
      const message = createSiweMessage({
        domain: url.host, scheme: url.protocol.slice(0, -1), uri: url.href, version: '1',
        address, chainId: localChain.id, nonce: randomBytes(16).toString('hex'),
        statement: purpose, issuedAt, expirationTime: expiresAt, requestId: challengeId,
      });
      await authenticatedWrite(async writes => {
        const current = await writes.getWalletLink(userId);
        if (current && current.address !== address) throw new WorkflowError(409, 'Tài khoản đã có ví được xác minh.');
        await writes.createWalletChallenge({
          id: challengeId, userId, sessionId, address, deployment, origin, message, expires: expiresAt.getTime(),
        });
      });
      return { challengeId, message, expiresAt: expiresAt.toISOString() };
    },
    async verify(input, store, authenticatedWrite, userId, sessionId, origin) {
      if (typeof input.challengeId !== 'string' || !/^[\da-f-]{36}$/i.test(input.challengeId) ||
          typeof input.signature !== 'string' || !/^0x[\da-f]{130}$/i.test(input.signature)) {
        throw new WorkflowError(400, 'Yêu cầu xác minh ví không hợp lệ.');
      }
      const challenge = await store.getWalletChallenge(input.challengeId, userId, sessionId);
      if (!challenge || challenge.origin !== origin || challenge.expires <= Date.now()) throw expired();
      let signer;
      try {
        signer = await recoverMessageAddress({ message: challenge.message, signature: input.signature });
      } catch {
        throw new WorkflowError(400, 'Chữ ký ví không hợp lệ.');
      }
      if (signer !== challenge.address) throw new WorkflowError(400, 'Chữ ký không khớp địa chỉ ví.');
      await walletDeployment(challenge.address, challenge.deployment);
      return authenticatedWrite(async writes => {
        if (!await writes.consumeWalletChallenge(challenge.id, userId, sessionId, Date.now())) throw expired();
        const current = await writes.getWalletLink(userId);
        if (current?.address === challenge.address) return current;
        const wallet = { address: challenge.address, chainId: localChain.id, verifiedAt: new Date().toISOString() };
        if (current || !await writes.insertWalletLink(userId, wallet)) {
          throw new WorkflowError(409, 'Ví này hoặc tài khoản đã có liên kết.');
        }
        return wallet;
      });
    },
  };
}
