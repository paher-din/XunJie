import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { parseKeyValueArgs } from './args.mjs';

const config = JSON.parse(readFileSync(parseKeyValueArgs(process.argv.slice(2)).config, 'utf8'));

function routeTarget(url) {
  const path = url.split('?', 1)[0];
  if (config.mode === 'cloud' || path.startsWith('/api/') || path === '/health/live' || path === '/health/ready') return config.backendPort;
  return config.vitePort;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function proxyHeaders(headers, port) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && !name.startsWith('x-forwarded-') && name !== 'forwarded') result[name] = value;
  }
  result.host = `127.0.0.1:${port}`;
  return result;
}

const server = createHttpsServer({ key: readFileSync(config.keyFile), cert: readFileSync(config.certFile) }, (request, response) => {
  const origin = `https://127.0.0.1:${config.port}`;
  if (request.headers.host !== new URL(origin).host || (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== origin) || (request.headers.origin && request.headers.origin !== origin)) {
    response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: { code: 'FORBIDDEN' } }));
    return;
  }
  const port = routeTarget(request.url || '/');
  const remote = Boolean(config.cloud && port === config.backendPort);
  if (remote) {
    let connection;
    try { connection = JSON.parse(readFileSync(config.connectionStatusFile, 'utf8')); } catch {}
    if (connection?.state !== 'ready' || Date.now() - Date.parse(connection.checkedAt) > 45000) {
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: { code: connection?.failure?.code ?? 'CLOUD_UNREACHABLE' } }));
      return;
    }
  }
  const headers = proxyHeaders(request.headers, port);
  if (config.cookieName) {
    headers.cookie = (request.headers.cookie ?? '').split(';').map(x => x.trim())
      .filter(x => x.startsWith(config.cookieName + '='))
      .map(x => '__Host-xunjie=' + x.slice(config.cookieName.length + 1)).join('; ');
  }
  if (remote) {
    headers.host = new URL(config.cloud.browserOrigin).host;
    if (headers.origin) headers.origin = config.cloud.browserOrigin;
    // Cookies are scoped to a target and mode even when ports share one host.
    // Only this gateway's cookie is translated into the cloud session cookie.
  }
  const upstream = (remote ? httpsRequest : httpRequest)({
    host: '127.0.0.1', port, method: request.method, path: request.url,
    ...(remote ? { servername: new URL(config.cloud.browserOrigin).hostname, ca: readFileSync(config.cloud.caFile) } : {}),
    headers,
  }, upstreamResponse => {
    const headers = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
    }
    if (config.cookieName && headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map(cookie => cookie.replace(/^__Host-xunjie=/, config.cookieName + '='));
    if (remote) {
      if (typeof headers.location === 'string' && headers.location.startsWith(config.cloud.browserOrigin + '/')) headers.location = origin + headers.location.slice(config.cloud.browserOrigin.length);
      headers['cache-control'] = 'no-store';
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
  upstream.setTimeout(15000, () => upstream.destroy(new Error('upstream timeout')));
  response.on('close', () => upstream.destroy());
});

server.on('upgrade', (request, socket, head) => {
  const url = request.url || '/';
  if (config.mode === 'cloud' || request.headers.origin !== `https://127.0.0.1:${config.port}`) { socket.destroy(); return; }
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
