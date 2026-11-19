import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../server/api.mjs';

export default async function startVite() {
  process.env.ESCROW_DB_PATH = ':memory:';
  process.env.ESCROW_DB = 'sqlite';
  const root = await mkdtemp(join(tmpdir(), 'escrow-browser-'));
  let cacheDir: string | undefined;
  const inbox = new Map<string, string>();
  let closeApi: (() => Promise<void>) | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  async function cleanup() {
    try { await server?.close(); }
    finally {
      try { await closeApi?.(); }
      finally {
        await Promise.all([rm(root, { recursive: true, force: true }),
          ...(cacheDir ? [rm(cacheDir, { recursive: true, force: true })] : [])]);
      }
    }
  }
  try {
    // Vite puts cached module paths in browser URLs. A Windows sandbox's temporary path can contain a URL fragment.
    cacheDir = await mkdtemp(join(process.cwd(), 'node_modules', '.vite-e2e-'));
    const api = createApi(':memory:', root, { adminEmails: 'admin-ui@example.test',
      // Every e2e test signs in from 127.0.0.1; keep the production per-IP OTP limit out of the shared test server.
      attemptLimit: 1000, sendOtp: async ({ email, code }: { email: string; code: string }) => { inbox.set(email, code); } });
    closeApi = () => api.close();
    server = await createServer({
      configFile: false,
      plugins: [react(), { name: 'isolated-test-api', configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/__test/otp?')) {
            const email = new URL(req.url, 'http://test').searchParams.get('email')!;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ code: inbox.get(email) }));
            return;
          }
          api.middleware(req, res, next);
        });
      } }],
      logLevel: 'silent',
      cacheDir,
      server: { host: '127.0.0.1', port: 5184, watch: null, hmr: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Không tìm được cổng của server kiểm thử.');
    process.env.PLAYWRIGHT_TEST_BASE_URL = `http://127.0.0.1:${address.port}`;
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
