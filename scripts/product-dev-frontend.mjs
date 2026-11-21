import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'vite';

/** Serve Vite through the product host, keeping the browser and API on one origin. */
export async function createProductDevFrontend({ webRoot, cacheDir, configFile } = {}) {
  // Vite needs an upgrade listener in middleware mode. Reserve a separate loopback port
  // so two product previews can run on the same machine.
  const hmrServer = createHttpServer((_request, response) => { response.writeHead(404); response.end(); });
  await new Promise((resolve, reject) => {
    hmrServer.once('error', reject);
    hmrServer.listen(0, '127.0.0.1', () => {
      hmrServer.off('error', reject);
      resolve();
    });
  });
  const closeHmrServer = async () => {
    if (hmrServer.listening) await new Promise((resolve, reject) =>
      hmrServer.close(error => error ? reject(error) : resolve()));
  };
  let vite;
  try {
    vite = await createServer({
      root: webRoot,
      cacheDir,
      configFile,
      appType: 'spa',
      server: { middlewareMode: true, hmr: { server: hmrServer, host: '127.0.0.1', port: hmrServer.address().port } },
    });
  } catch (error) {
    await closeHmrServer().catch(() => {});
    throw error;
  }
  return {
    handle(request, response) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (handled, error) => {
          if (settled) return;
          settled = true;
          response.off('finish', onResponse);
          response.off('close', onResponse);
          if (error) reject(error);
          else resolve(handled);
        };
        const onResponse = () => finish(true);
        response.once('finish', onResponse);
        response.once('close', onResponse);
        vite.middlewares(request, response, error => finish(false, error));
      });
    },
    async close() {
      try { await vite.close(); }
      finally { await closeHmrServer(); }
    },
  };
}
