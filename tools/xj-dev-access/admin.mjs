import { realpathSync } from 'node:fs';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { AccessError, requireAccess } from '../xj-dev/src/enrollment-protocol.mjs';

export function adminRequest(socketPath, operation, input) {
  requireAccess(['invite', 'inspect', 'revoke-invitation', 'revoke-device', 'revoke-member', 'snapshot', 'package-quota', 'package-baselines', 'package-baseline', 'package-cleanup'].includes(operation), 'ADMIN_OPERATION_INVALID');
  return new Promise((accept, reject) => {
    const req = request({ socketPath, path: '/' + operation, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 20000 }, res => {
      let output = '';
      res.on('data', bytes => { output += bytes; if (output.length > 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        try { const result = JSON.parse(output); requireAccess(result.ok, /^[A-Z_]+$/.test(result.code ?? '') ? result.code : 'ADMIN_OPERATION_FAILED', res.statusCode); accept(result.data); }
        catch (error) { reject(error instanceof AccessError ? error : new AccessError('ADMIN_RESPONSE_INVALID', 503)); }
      });
    });
    req.on('error', () => reject(new AccessError('ADMIN_UNAVAILABLE', 503))); req.on('timeout', () => req.destroy()); req.end(JSON.stringify(input));
  });
}

// This private stdio endpoint is invoked only through the owner's SSH pipe. Its
// caller captures the response and writes invitation material to a private file.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const socket = process.argv[2]; requireAccess(typeof socket === 'string' && socket.startsWith('/run/'), 'ADMIN_SOCKET_REQUIRED');
    let text = ''; for await (const bytes of process.stdin) { text += bytes; requireAccess(Buffer.byteLength(text) <= 16384, 'REQUEST_TOO_LARGE'); }
    const input = JSON.parse(text), data = await adminRequest(socket, input.operation, input.input ?? {});
    process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error instanceof AccessError ? error.code : 'ADMIN_UNAVAILABLE' }) + '\n'); process.exitCode = 1; }
}
