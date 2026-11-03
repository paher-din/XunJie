// SSH control relay to a task-owned, limited-token Windows acceptance process.
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
const [port, tokenFile] = process.argv.slice(2);
const token = (await readFile(tokenFile, 'utf8')).trim();
let socket;
for (let attempt = 0; attempt < 120; attempt++) {
  try { socket = await new Promise((resolve, reject) => {
    const client = createConnection({ host: '127.0.0.1', port: Number(port) });
    client.once('connect', () => resolve(client)); client.once('error', reject);
  }); break; } catch { await new Promise(done => setTimeout(done, 500)); }
}
if (!socket) throw new Error('Limited acceptance process did not start');
socket.pipe(process.stdout); socket.on('error', () => process.exit(1));
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const input = JSON.parse(line); socket.write(JSON.stringify({ ...input, controlToken: token }) + '\n');
}
socket.end();
