import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';

// Forward the signed Host header unchanged. Only lose a reply after real S3 confirms PUT.
export async function losePutReply(t, endpoint) {
  const origin = new URL(endpoint);
  let lost = 0;
  const outgoing = new Set();
  const server = createServer((incoming, response) => {
    const url = new URL(incoming.url, origin.origin);
    const send = origin.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = send(url, { method: incoming.method, headers: incoming.headers }, reply => {
      if (incoming.method === 'PUT' && reply.statusCode >= 200 && reply.statusCode < 300) {
        reply.resume();
        reply.once('end', () => { lost++; response.destroy(); });
      } else {
        response.writeHead(reply.statusCode, reply.headers);
        reply.pipe(response);
      }
      reply.on('error', () => response.destroy());
    });
    outgoing.add(upstream);
    upstream.on('close', () => outgoing.delete(upstream));
    upstream.on('error', () => response.destroy());
    incoming.pipe(upstream);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    for (const upstream of outgoing) upstream.destroy();
    await closed;
  });
  return { endpoint: `http://127.0.0.1:${server.address().port}${origin.pathname}`, lost: () => lost };
}
