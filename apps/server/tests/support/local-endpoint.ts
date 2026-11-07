// Linux deployments use the production Unix endpoint. Windows business tests
// supply a real HTTP pipe as an OS adapter; this does not test owner ACLs.
import type { Server } from 'node:net';
import { randomUUID } from 'node:crypto';
import { localSocket, type LocalEndpoint } from '../../server/access/local-socket.ts';

export function localTestPath(path: string): string {
  return process.platform === 'win32' ? '\\\\.\\pipe\\xunjie-test-' + randomUUID() : path;
}

export const localTestEndpoint = process.platform !== 'win32' ? localSocket : (path: string): LocalEndpoint => {
  let owned = false;
  return {
    async listen(server: Server) {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); owned = true; resolve(); };
        server.once('error', fail); server.once('listening', ready); server.listen(path);
      });
    },
    async close(server: Server) {
      if (owned) { owned = false; await new Promise<void>(resolve => server.close(() => resolve())); }
    },
  };
};
