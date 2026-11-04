// Host-side loopback fixture for the isolation selftest. The entry runs this outside the unit as
// the session user, then proves the port accepts a connection before asking the unit
// to try it. A unit without a network namespace connects to this port; a confined one cannot.
import { createServer, connect } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [mode, target] = process.argv.slice(2);

if (mode === '--confirm') {
  const port = Number(readFileSync(target, 'utf8').trim());
  const socket = connect({ host: '127.0.0.1', port });
  socket.setTimeout(3000);
  socket.once('connect', () => {
    writeFileSync(join(dirname(target), '.probe-host-confirmed'), 'yes\n');
    socket.destroy(); process.exit(0);
  });
  socket.once('timeout', () => { socket.destroy(); process.exit(1) });
  socket.once('error', () => { socket.destroy(); process.exit(1) });
} else {
  const workdir = mode;
  const server = createServer(socket => { socket.end() });
  server.once('error', () => process.exit(1));
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') process.exit(1);
    writeFileSync(join(workdir, '.probe-port'), String(address.port));
    writeFileSync(join(workdir, '.probe-host-pid'), String(process.pid));
  });
  const stop = () => { server.close(); process.exit(0) };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  // The selftest has a fixed unit runtime; this keeps a stray listener from outliving it.
  setTimeout(stop, 120000).unref();
}
