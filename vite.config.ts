import { defineConfig } from 'vite';
import { basename } from 'node:path';
import react from '@vitejs/plugin-react';
import { createApi } from './server/api.mjs';

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
      configureServer(server) {
        const api = createApi();
        server.middlewares.use(api.middleware);
        server.httpServer?.once('close', api.close);
      },
      configurePreviewServer(server) {
        const api = createApi();
        server.middlewares.use(api.middleware);
        server.httpServer.once('close', api.close);
      },
    },
  ],
});
