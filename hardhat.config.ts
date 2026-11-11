import { fileURLToPath } from 'node:url';
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem';
import { defineConfig } from 'hardhat/config';
import { z } from 'zod';

// Hardhat's Zod 3 config validator still reads ZodError.errors.
const invalidConfig = z.string().safeParse(null);
if (!invalidConfig.success && !('errors' in invalidConfig.error)) {
  Object.defineProperty(Object.getPrototypeOf(invalidConfig.error), 'errors', {
    configurable: true,
    get(this: z.ZodError) { return this.issues; },
  });
}

export default defineConfig({
  plugins: [hardhatToolboxViem],
  networks: {
    node: { type: 'edr-simulated', chainType: 'l1', chainId: 31337 },
    localhost: { type: 'http', chainType: 'l1', chainId: 31337, url: 'http://127.0.0.1:8545' },
  },
  solidity: {
    version: '0.8.30',
    path: fileURLToPath(new URL('./node_modules/solc/soljson.js', import.meta.url)),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'shanghai',
      viaIR: true,
    },
  },
  paths: {
    sources: './contracts',
    tests: { nodejs: './tests/contracts' },
    artifacts: './.hardhat/artifacts',
    cache: './.hardhat/cache',
  },
});
