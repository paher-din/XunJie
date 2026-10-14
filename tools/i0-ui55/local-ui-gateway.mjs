import { createServer, request as httpsRequest } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync, lstatSync, createReadStream } from 'node:fs';
import { resolve, join, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const origin = 'https://127.0.0.1:3443';
const peerFingerprint = 'c3f8ed37e07c341b0fcc5558d0fc12fab47913ef71d1ec8077a0e08444475173';
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

export function endToEndHeaders(headers) {
  const excluded = new Set(hopHeaders);
  for (const name of String(headers.connection ?? '').split(',')) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

export function staticFile(root, rawUrl) {
  let path;
  try { path = decodeURIComponent(rawUrl.split('?')[0]); } catch { return null; }
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\0:]/.test(path) ||
    path.split('/').some(part => part === '..' || part === '.')) return null;
  const parts = path === '/' ? ['index.html'] : path.slice(1).split('/').filter(Boolean);
  let current = root;
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return null;
    for (const part of parts) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
    if (!lstatSync(current).isFile() || relative(root, current).startsWith('..')) return null;
    return current;
  } catch { return null; }
}

function fail(response, status, text) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(text);
}

export function createHandler({ staticDirectory, upstreamPort, upstreamCA }, requestUpstream = httpsRequest) {
  return (request, response) => {
    if (request.headers.host !== '127.0.0.1:3443') { fail(response, 421, 'Unexpected local origin.'); return; }
    const path = request.url ?? '';
    if (path === '/api' || path.startsWith('/api/') || /^\/health\/(?:live|ready)(?:\?|$)/.test(path)) {
      let upstream;
      try {
        upstream = requestUpstream({ hostname: '127.0.0.1', port: upstreamPort, path,
          method: request.method, headers: { ...endToEndHeaders(request.headers), host: new URL(origin).host },
          ca: upstreamCA, rejectUnauthorized: true,
          checkServerIdentity(host, certificate) {
            const error = checkServerIdentity(host, certificate);
            if (error) return error;
            if (!certificate.raw || createHash('sha256').update(certificate.raw).digest('hex') !== peerFingerprint)
              return new Error('PAHER certificate fingerprint changed.');
          },
        }, received => {
          response.writeHead(received.statusCode ?? 502, endToEndHeaders(received.headers));
          received.once('error', () => response.destroy());
          received.once('aborted', () => response.destroy());
          received.pipe(response);
        });
        // No request/response body, Cookie, CSRF or authentication data is logged or retained.
        upstream.setTimeout(60_000, () => upstream.destroy(new Error('Upstream response unconfirmed.')));
        upstream.once('error', () => fail(response, 502, 'Service response unconfirmed; reread before retrying.'));
        request.once('aborted', () => upstream.destroy());
        request.once('error', () => upstream.destroy());
        response.once('close', () => { if (!response.writableEnded) upstream.destroy(); });
        request.pipe(upstream);
      } catch { upstream?.destroy(); fail(response, 502, 'Service connection unconfirmed.'); }
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { fail(response, 405, 'Static content is read-only.'); return; }
    const file = staticFile(staticDirectory, path);
    if (!file) { fail(response, 404, 'Static file unavailable.'); return; }
    try {
      response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        'Content-Length': lstatSync(file).size, 'Cache-Control': 'no-store' });
      if (request.method === 'HEAD') response.end();
      else createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch { fail(response, 404, 'Static file unavailable.'); }
  };
}

export function loadConfiguration(file) {
  const input = JSON.parse(readFileSync(file, 'utf8'));
  const keys = ['staticDirectory', 'keyFile', 'certFile', 'upstreamCAFile'];
  if (!input || Object.keys(input).sort().join(',') !== keys.sort().join(',') ||
    keys.some(key => typeof input[key] !== 'string' || !isAbsolute(input[key]))) throw new Error('Exact local configuration required.');
  const staticDirectory = resolve(input.staticDirectory);
  if (!staticFile(staticDirectory, '/')) throw new Error('Normal student dist required.');
  for (const key of ['keyFile', 'certFile', 'upstreamCAFile']) {
    const stat = lstatSync(input[key]);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Controlled TLS file required.');
  }
  const upstreamCA = readFileSync(input.upstreamCAFile);
  const peer = new X509Certificate(upstreamCA);
  if (peer.fingerprint256.replaceAll(':', '').toLowerCase() !== peerFingerprint) throw new Error('Exact PAHER public certificate required.');
  const cert = readFileSync(input.certFile);
  const local = new X509Certificate(cert);
  if (local.ca || !local.checkIP('127.0.0.1') || Date.parse(local.validTo) <= Date.now() ||
    Date.parse(local.validFrom) > Date.now()) throw new Error('Valid local TLS leaf required.');
  return { staticDirectory, upstreamPort: 14443, upstreamCA, cert, key: readFileSync(input.keyFile) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const configuration = loadConfiguration(process.argv[2] ?? '');
    const server = createServer({ key: configuration.key, cert: configuration.cert, minVersion: 'TLSv1.2' }, createHandler(configuration));
    server.requestTimeout = 120_000;
    server.on('error', () => { process.stderr.write('Local UI HTTPS startup failed.\n'); process.exitCode = 1; });
    server.listen(3443, '127.0.0.1', () => process.stdout.write('Local UI HTTPS ready at https://127.0.0.1:3443; real APIs use the pinned SSH upstream.\n'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      server.close();
      // Only this local gateway's sockets; never cancel a PAHER business command or stop its service.
      setTimeout(() => server.closeAllConnections(), 5000).unref();
    });
  } catch { process.stderr.write('Local UI configuration/TLS unavailable; no insecure fallback enabled.\n'); process.exitCode = 1; }
}
