// Acceptance host only: never import this fixture from the product graph.
import { readFile } from 'node:fs/promises';
import { createFileBackend, createS3Backend, openStorage } from '@xunjie/storage';
import { createStorageSampleApp, sampleMigrations } from '../../dist/server/storage-sample/index.js';

let app;
let storage;
try {
  const config = JSON.parse(await readFile(process.env.XUNJIE_STORAGE_SAMPLE_CONFIG, 'utf8'));
  if (config.blobBackend !== undefined && config.blobBackend.kind !== 's3') {
    throw new Error('Unsupported acceptance blob backend');
  }
  const backend = config.blobBackend === undefined
    ? createFileBackend({ id: 'sample-files', root: config.resourceRoot })
    : createS3Backend(config.blobBackend);
  storage = await openStorage({ binding: config.binding, migrations: sampleMigrations,
    backend });
  app = createStorageSampleApp(storage);
  // onSend runs after the route has awaited the committed receipt, before bytes leave HTTP.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.headers['x-test-lose-response'] === 'yes' && reply.statusCode === 200) {
      process.send?.({ type: 'committed' });
      await new Promise(() => {}); // Parent kills this host after receiving confirmation.
    }
    return payload;
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  process.send?.({ type: 'ready', address });
  process.on('message', async message => {
    if (message?.type === 'stop') {
      await app.close();
      await storage.close();
      process.disconnect();
    }
  });
} catch {
  // Driver errors may contain connection secrets. Keep them off IPC and stderr.
  process.send?.({ type: 'failed' });
  await app?.close().catch(() => {});
  await storage?.close().catch(() => {});
  process.exit(1);
}
