import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createApi } from '../server/api.mjs';

export default async function startVite() {
  process.env.ESCROW_DB_PATH = ':memory:';
  process.env.ESCROW_DB = 'sqlite';
  const inbox = new Map<string, string>();
  const api = createApi(':memory:', process.cwd(), { adminEmails: 'admin-ui@example.test',
    // Every e2e test signs in from 127.0.0.1; keep the production per-IP OTP limit out of the shared test server.
    attemptLimit: 1000, sendOtp: async ({ email, code }: { email: string; code: string }) => {
    inbox.set(email, code);
  } });
  const server = await createServer({
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
    cacheDir: 'node_modules/.vite-e2e',
    server: { host: '127.0.0.1', port: 5184, watch: null, hmr: false },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Không tìm được cổng của server kiểm thử.');
    process.env.PLAYWRIGHT_TEST_BASE_URL = `http://127.0.0.1:${address.port}`;
    return async () => { await server.close(); await api.close(); };
  } catch (error) {
    await server.close();
    throw error;
  }
}
