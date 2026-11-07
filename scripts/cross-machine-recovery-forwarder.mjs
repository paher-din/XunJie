import { createServer, connect } from 'node:net';
import { readFileSync } from 'node:fs';

// Stable-address TCP passthrough for the #212 independent Agent acceptance. TLS stays end-to-end
// between the school and the Agent; only the local backend port switches after takeover.
const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const listen = Number(args.listen), stateFile = args.state;
const server = createServer(socket => {
  let port;
  try { port = JSON.parse(readFileSync(stateFile, 'utf8')).port; } catch { socket.destroy(); return; }
  const upstream = connect(port, '127.0.0.1', () => { socket.pipe(upstream); upstream.pipe(socket); });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});
server.listen(listen, '0.0.0.0', () => console.log(JSON.stringify({ ready: true, listen })));