import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { AccessError, requireAccess } from '../xj-dev/src/enrollment-protocol.mjs';

export function systemOperation(command, input) {
  return new Promise((accept, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new AccessError('SYSTEM_OPERATION_TIMEOUT', 503)); }, 20000);
    child.once('error', () => { clearTimeout(timer); reject(new AccessError('SYSTEM_OPERATION_UNAVAILABLE', 503)); });
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 8192) child.kill(); });
    child.once('close', code => {
      clearTimeout(timer);
      try { const result = JSON.parse(output); requireAccess(code === 0 && result.ok, /^[A-Z_]+$/.test(result.code ?? '') ? result.code : 'SYSTEM_OPERATION_FAILED', 503); accept(result.data); }
      catch (error) { reject(error instanceof AccessError ? error : new AccessError('SYSTEM_OPERATION_FAILED', 503)); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
export function applicationOperation(socketPath, operation, body) {
  return new Promise((accept, reject) => {
    const req = request({ socketPath, path: `/${operation}`, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 15000 }, res => {
      let output = '';
      res.on('data', bytes => { output += bytes; if (output.length > 65536) req.destroy(); });
      res.on('end', () => {
        try { const result = JSON.parse(output); requireAccess(res.statusCode === 200 && result.ok, /^[A-Z_]+$/.test(result.code ?? '') ? result.code : 'APPLICATION_IDENTITY_FAILED', 503); accept(result.data); }
        catch (error) { reject(error instanceof AccessError ? error : new AccessError('APPLICATION_IDENTITY_FAILED', 503)); }
      });
    });
    req.on('error', () => reject(new AccessError('APPLICATION_CONTROL_UNAVAILABLE', 503)));
    req.on('timeout', () => req.destroy());
    req.end(JSON.stringify(body));
  });
}
