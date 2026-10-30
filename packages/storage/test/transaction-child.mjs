import { readFile } from 'node:fs/promises';
import { openStorage, createFileBackend } from '@xunjie/storage';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const files=createFileBackend(config.backend);
const storage = await openStorage({ binding: config.binding, migrations: config.migrations,
  backend: config.upload ? {...files, async put(key,bytes) {
    await files.put(key,bytes);
    process.send({phase:'bytes-durable'});
    await new Promise(()=>{});
  }} : files });
if(config.upload) {
  await storage.stageResource({...config.upload,bytes:Uint8Array.from(config.upload.bytes)});
  throw new Error('Parent must kill the upload before confirmation');
}
await storage.request({ requestId: config.requestId, fingerprint: 'interrupted-input' }, async tx => {
  await tx.query("INSERT INTO records VALUES ('interrupted',1,'{}')");
  await tx.enqueue('interrupted-outbox', { never: 'dispatch' });
  process.send({ phase: 'uncommitted' });
  await new Promise(() => {});
  return {};
});
