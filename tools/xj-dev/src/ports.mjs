import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

export function basePortFor(identity) {
  const hash = parseInt(createHash('sha256').update(identity).digest('hex').slice(12, 20), 16);
  return 24000 + (hash % 3000) * 3;
}

export function portFree(port) {
  return new Promise(resolvePromise => {
    const probe = createServer();
    probe.once('error', () => resolvePromise(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePromise(true)));
  });
}

export async function allocatePorts(identity) {
  const base = basePortFor(identity);
  for (let step = 0; step < 100; step++) {
    const gateway = base + step * 3;
    if (gateway > 33000) break;
    if (await portFree(gateway) && await portFree(gateway + 1) && await portFree(gateway + 2)) {
      return { gateway, backend: gateway + 1, vite: gateway + 2 };
    }
  }
  return undefined;
}
