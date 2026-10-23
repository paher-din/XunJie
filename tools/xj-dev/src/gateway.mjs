import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect } from 'node:net';
import { parseKeyValueArgs } from './args.mjs';

const config = JSON.parse(readFileSync(parseKeyValueArgs(process.argv.slice(2)).config, 'utf8'));

function routeTarget(url) {
  const path = url.split('?', 1)[0];
  if (path.startsWith('/api/') || path === '/health/live' || path === '/health/ready') return config.backendPort;
  return config.vitePort;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function proxyHeaders(headers, port) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) result[name] = value;
  }
  result.host = `127.0.0.1:${port}`;
  return result;
}

const server = createHttpsServer({ key: readFileSync(config.keyFile), cert: readFileSync(config.certFile) }, (request, response) => {
  const port = routeTarget(request.url || '/');
  const upstream = httpRequest({
    host: '127.0.0.1', port, method: request.method, path: request.url,
    headers: proxyHeaders(request.headers, port),
  }, upstreamResponse => {
    const headers = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
    }
    response.writeHead(upstreamResponse.statusCode || 502, headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Development upstream is not running.' } }));
    } else {
      response.end();
    }
  });
  request.pipe(upstream);
});

server.on('upgrade', (request, socket, head) => {
  const url = request.url || '/';
  if (url.split('?', 1)[0].startsWith('/api/')) {
    socket.destroy();
    return;
  }
  const upstream = netConnect(config.vitePort, '127.0.0.1', () => {
    upstream.write(`${request.method} ${url} HTTP/${request.httpVersion}\r\n`);
    const headers = proxyHeaders(request.headers, config.vitePort);
    headers.connection = 'Upgrade';
    headers.upgrade = request.headers.upgrade || 'websocket';
    for (const [name, value] of Object.entries(headers)) {
      upstream.write(`${name}: ${value}\r\n`);
    }
    upstream.write('\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));

server.listen(config.port, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ ready: true, port: config.port }) + '\n');
});
