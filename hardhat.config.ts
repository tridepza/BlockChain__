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
  solidity: {
    version: '0.8.30',
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
