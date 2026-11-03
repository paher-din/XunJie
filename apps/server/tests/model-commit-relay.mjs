import { createServer, connect } from 'node:net';

// Cut only the selected real transaction's server-confirmed COMMIT acknowledgement.
// PostgreSQL still executes the production storage transaction; no result is fabricated.
export async function modelCommitRelay(port) {
  const sockets = new Set();
  let armed = '', cuts = 0;
  const server = createServer(downstream => {
    const upstream = connect(port, '127.0.0.1');
    let incoming = Buffer.alloc(0), outgoing = Buffer.alloc(0), startup = true, selected = false;
    for (const socket of [downstream, upstream]) {
      sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    }
    downstream.on('data', chunk => {
      incoming = Buffer.concat([incoming, chunk]); upstream.write(chunk);
      while (incoming.length >= (startup ? 4 : 5)) {
        const length = incoming.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (length < 4 || incoming.length < length) break;
        const message = incoming.subarray(0, length); incoming = incoming.subarray(length);
        if (startup) { startup = false; continue; }
        let query = '';
        if (message[0] === 81) query = message.subarray(5, -1).toString();
        if (message[0] === 80) query = message.subarray(message.indexOf(0, 5) + 1).toString().split('\0')[0];
        if (query.startsWith('BEGIN')) selected = false;
        if (armed && query.includes(armed)) selected = true;
      }
    });
    upstream.on('data', chunk => {
      outgoing = Buffer.concat([outgoing, chunk]);
      while (outgoing.length >= 5) {
        const length = outgoing.readInt32BE(1) + 1;
        if (outgoing.length < length) break;
        const message = outgoing.subarray(0, length); outgoing = outgoing.subarray(length);
        if (armed && selected && message[0] === 67 && message.subarray(5).toString().startsWith('COMMIT')) {
          armed = ''; cuts++; downstream.destroy(); upstream.destroy(); return;
        }
        downstream.write(message);
      }
    });
    downstream.once('close', () => upstream.destroy()); upstream.once('close', () => downstream.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, arm(queryFragment) { armed = queryFragment; }, cuts: () => cuts,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
