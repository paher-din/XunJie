import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createFileBackend } from '@xunjie/storage';

// Pause a real write at the filesystem boundary so the parent can deterministically
// kill this process after partial staging and before immutable publication.
const originalOpen = fs.promises.open;
let interrupt = false;
fs.promises.open = async (path, flags, mode) => {
  const file = await originalOpen(path, flags, mode);
  if (interrupt && (flags & fs.constants.O_CREAT)) {
    file.writeFile = async bytes => {
      await file.write(bytes.subarray(0, 1024));
      process.send('staged');
      await new Promise(() => {});
    };
  }
  return file;
};
syncBuiltinESMExports();

const backend = createFileBackend({ id: 'files', root: process.argv[2] });
await backend.put('owner/confirmed', new Uint8Array([0, 255, 128, 1]));
process.send('confirmed');
process.once('message', async () => {
  try {
    interrupt = true;
    await backend.put(`owner/${process.argv[3] ?? 'interrupted'}`, new Uint8Array(16 * 1024 * 1024).fill(73));
    process.send('finished');
  } catch { process.exitCode = 1; }
  process.disconnect();
});
