import { createServer } from 'vite';

/** Serve Vite through the product host, keeping the browser and API on one origin. */
export async function createProductDevFrontend({ webRoot, cacheDir, configFile } = {}) {
  const vite = await createServer({
    root: webRoot,
    cacheDir,
    configFile,
    appType: 'spa',
    server: { middlewareMode: true, hmr: false },
  });
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
    close: () => vite.close(),
  };
}
