import { createApp } from './app.ts';
import { readPort } from './app/config.ts';

const app = createApp({ logDestination: process.stdout });
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } catch {
    process.stderr.write('Teaching server shutdown failed.\n');
    process.exitCode = 1;
  }
};

try {
  await app.listen({ host: '127.0.0.1', port: readPort(process.env.PORT) });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch {
  process.stderr.write('Teaching server startup failed. Check PORT and local port availability.\n');
  await shutdown();
  process.exitCode = 1;
}
