// Lets the server sign arbitration on behalf of an admin, so deciding a dispute does not need MetaMask.
// On Hardhat Local the arbitrator is a public test account derived from Hardhat's default mnemonic;
// ESCROW_ARBITRATOR_KEY (environment or .env.admin.local) can name a different key.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { createWalletClient, http, isAddressEqual } from 'viem';
import { hardhat } from 'viem/chains';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { localChain } from '../src/local-chain.ts';

const hardhatMnemonic = 'test test test test test test test test test test test junk';
const hardhatAccounts = 20;
const derived = new Map();

function configuredKey(root) {
  if (process.env.ESCROW_ARBITRATOR_KEY) return process.env.ESCROW_ARBITRATOR_KEY.trim();
  const filename = resolve(root, '.env.admin.local');
  if (!existsSync(filename)) return undefined;
  return parseEnv(readFileSync(filename, 'utf8').replace(/^﻿/, '')).ESCROW_ARBITRATOR_KEY?.trim() || undefined;
}

function hardhatAccount(addressIndex) {
  if (!derived.has(addressIndex)) derived.set(addressIndex, mnemonicToAccount(hardhatMnemonic, { addressIndex }));
  return derived.get(addressIndex);
}

// Returns a signer whose address is exactly the contract's arbitrator, or undefined when none is known.
export function arbitratorSigner(root, arbitrator) {
  if (!arbitrator) return undefined;
  const candidates = [];
  const key = configuredKey(root);
  if (key && /^0x[0-9a-f]{64}$/i.test(key)) candidates.push(() => privateKeyToAccount(key));
  // The public Hardhat test keys are only meaningful on the local development chain.
  if (localChain.id === 31337) {
    for (let addressIndex = 0; addressIndex < hardhatAccounts; addressIndex++) candidates.push(() => hardhatAccount(addressIndex));
  }
  for (const create of candidates) {
    const account = create();
    if (isAddressEqual(account.address, arbitrator)) {
      const wallet = createWalletClient({ account, chain: hardhat, transport: http(localChain.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
      return { address: account.address, send: ({ to, data }) => wallet.sendTransaction({ to, data }) };
    }
  }
  return undefined;
}
