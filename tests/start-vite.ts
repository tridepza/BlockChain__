import { createServer } from 'vite';

export default async function startVite() {
  process.env.ESCROW_DB_PATH = ':memory:';
  process.env.ESCROW_DB = 'sqlite';
  const server = await createServer({
    logLevel: 'silent',
    cacheDir: 'node_modules/.vite-e2e',
    server: { host: '127.0.0.1', port: 5184, watch: null, hmr: false },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Không tìm được cổng của server kiểm thử.');
    process.env.PLAYWRIGHT_TEST_BASE_URL = `http://127.0.0.1:${address.port}`;
    return () => server.close();
  } catch (error) {
    await server.close();
    throw error;
  }
}
