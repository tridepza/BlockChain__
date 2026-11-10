import { defineConfig } from 'vite';
import { existsSync, realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import react from '@vitejs/plugin-react';
import { createConfiguredApi } from './server/api.mjs';

const databaseName = basename(process.env.ESCROW_DB_PATH || 'escrow.sqlite');

function canonicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : resolve(canonicalPath(parent), basename(path));
}

function denyDatabaseFiles(req: IncomingMessage, res: ServerResponse, next: () => void) {
  let path: string;
  try {
    path = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/\\/g, '/');
  } catch {
    return next();
  }
  const name = basename(path).toLowerCase().replace(/[. ]+$/, '');
  const configured = databaseName.toLowerCase();
  const sidecars = ['', '-wal', '-shm', '-journal'];
  if (/\.(sqlite|sqlite3|db)(-(wal|shm|journal))?$/.test(name) || sidecars.some(suffix => name === configured + suffix)) {
    res.writeHead(403).end();
    return;
  }
  next();
}

export default defineConfig({
  publicDir: false,
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
      configResolved(config) {
        const filename = process.env.ESCROW_DB_PATH;
        if (!filename || filename === ':memory:') return;
        const database = canonicalPath(resolve(filename));
        const staticDirs = ['public', config.publicDir, config.build.outDir].filter(Boolean);
        if (staticDirs.some(dir => {
          const from = relative(canonicalPath(resolve(config.root, dir)), database);
          return from === '' || (from !== '..' && !from.startsWith('..' + sep) && !isAbsolute(from));
        })) {
          throw new Error('ESCROW_DB_PATH phải nằm ngoài public và thư mục đầu ra của Vite. Hãy chuyển DB vào .data.');
        }
      },
      async configureServer(server) {
        const api = await createConfiguredApi(server.config.root);
        server.middlewares.use(denyDatabaseFiles);
        server.middlewares.use(api.middleware);
        server.httpServer?.once('close', () => void api.close().catch(console.error));
      },
      async configurePreviewServer(server) {
        const api = await createConfiguredApi(server.config.root);
        server.middlewares.use(denyDatabaseFiles);
        server.middlewares.use(api.middleware);
        server.httpServer.once('close', () => void api.close().catch(console.error));
      },
    },
  ],
});
