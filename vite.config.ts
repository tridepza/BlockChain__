import { defineConfig } from 'vite';
import { basename } from 'node:path';
import react from '@vitejs/plugin-react';
import { createConfiguredApi } from './server/api.mjs';

const databaseName = basename(process.env.ESCROW_DB_PATH || 'escrow.sqlite');

export default defineConfig({
  server: {
    fs: {
      deny: [
        '.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/server/**',
        '**/.data/**', '**/.local-data/**',
        '**/*.{sqlite,sqlite3,db}', '**/*.{sqlite,sqlite3,db}-{wal,shm,journal}',
        `**/${databaseName}*`,
      ],
    },
  },
  plugins: [
    react(),
    {
      name: 'escrow-api',
      async configureServer(server) {
        const api = await createConfiguredApi(server.config.root);
        server.middlewares.use(api.middleware);
        server.httpServer?.once('close', () => void api.close().catch(console.error));
      },
      async configurePreviewServer(server) {
        const api = await createConfiguredApi(server.config.root);
        server.middlewares.use(api.middleware);
        server.httpServer.once('close', () => void api.close().catch(console.error));
      },
    },
  ],
});
