import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { localSocket, localSocketAddress } from '../server/access/local-socket.ts';

test('local control excludes a second owner, survives its failed close and permits an explicit restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xj-local-control-')), path = join(root, 'control');
  const servers = [createServer((_req, res) => res.end('original owner')), createServer((_req, res) => res.end('successor'))] as const;
  const first = localSocket(path), contender = localSocket(path), successor = localSocket(path);
  const read = () => new Promise<string>((done, fail) => {
    const req = request({ socketPath: String(servers[0].address()), path: '/' }, res => {
      let text = ''; res.on('data', bytes => { text += bytes; }); res.on('end', () => done(text));
    }); req.on('error', fail); req.end();
  });
  try {
    await first.listen(servers[0], 0o600);
    await assert.rejects(contender.listen(servers[1], 0o600));
    await contender.close(servers[1]);
    assert.equal(await read(), 'original owner');
    const another = localSocket(join(root, 'another'));
    await assert.rejects(another.listen(servers[0], 0o600));
    await another.close(servers[0]);
    assert.equal(await read(), 'original owner');
    await first.close(servers[0]);
    await successor.listen(servers[0], 0o600);
    assert.equal(await read(), 'original owner');
    await successor.close(servers[0]);
    writeFileSync(path, 'foreign file');
    await assert.rejects(localSocket(path).listen(servers[1], 0o600));
    assert.equal(readFileSync(path, 'utf8'), 'foreign file');
  } finally {
    await first.close(servers[0]); await contender.close(servers[1]); await successor.close(servers[0]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an abruptly ended local owner releases its endpoint for an explicit successor', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'xj-local-owner-')), path = join(root, 'control');
  const module = new URL('../server/access/local-socket.ts', import.meta.url).href;
  const script = `import {createServer} from 'node:http'; import {localSocket} from ${JSON.stringify(module)};
    const endpoint=localSocket(${JSON.stringify(path)}); const server=createServer((_req,res)=>res.end('old'));
    await endpoint.listen(server,0o600); process.stdout.write('ready\\n');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(child, 'exit');
  const successor = localSocket(path), server = createServer((_req,res) => res.end('successor'));
  try {
    await new Promise<void>((done, fail) => {
      const deadline = setTimeout(() => fail(new Error('local owner did not become ready')), 15000);
      child.once('error', error => { clearTimeout(deadline); fail(error); });
      child.stdout.once('data', () => { clearTimeout(deadline); done(); });
    });
    child.kill('SIGKILL'); await exited;
    await successor.listen(server, 0o600);
    const response = await new Promise<string>((done, fail) => {
      const req = request({ socketPath: localSocketAddress(path), path: '/' }, res => {
        let body = ''; res.on('data', bytes => { body += bytes; }); res.on('end', () => done(body));
      }); req.on('error',fail); req.end();
    });
    assert.equal(response, 'successor');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; await successor.close(server);
    rmSync(root, { recursive: true, force: true });
  }
});
