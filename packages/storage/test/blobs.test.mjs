import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { BlobError, createFileBackend, createS3Backend } from '@xunjie/storage';
import { s3HttpFixture } from './s3-http.mjs';

const exec = promisify(execFile);

async function fileUsage(root) {
  const total = { files: 0, bytes: 0 };
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const child = await fileUsage(path);
      total.files += child.files;
      total.bytes += child.bytes;
    } else if (entry.isFile()) {
      total.files++;
      total.bytes += (await lstat(path)).size;
    }
  }
  return total;
}

async function interruptFilePut(t, root, leaf = 'interrupted') {
  const child = fork(new URL('./blob-file-writer.mjs', import.meta.url), [root, leaf], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const confirmed = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`Writer exited before confirmation: ${stderr}`); })]);
  assert.equal(confirmed[0], 'confirmed');
  const staging = once(child, 'message');
  child.send('begin');
  const [state] = await Promise.race([staging, exited.then(() => { throw new Error(`Writer exited before partial staging: ${stderr}`); })]);
  assert.equal(state, 'staged');
  child.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
}

test('file blob survives reopening with its stable backend identity and exact bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-blobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = new Uint8Array([0, 255, 1, 128, 13, 10]);
  await createFileBackend({ id: 'files', root }).put('owner/result_1/blob-0', bytes);
  const reopened = createFileBackend({ id: 'files', root });
  assert.equal(reopened.id, 'files');
  assert.deepEqual(await reopened.get('owner/result_1/blob-0'), bytes);
});

test('S3 preserves exact bytes with signed path-style conditional writes and immutable retries', async t => {
  const { state, options } = await s3HttpFixture(t);
  const backend = createS3Backend(options);
  const key = 'owner/a_b-0';
  const bytes = new Uint8Array([0, 255, 13, 10, 128]);
  assert.equal(backend.id, 's3');
  await backend.put(key, bytes);
  await backend.put(key, bytes);
  await assert.rejects(backend.put(key, new Uint8Array([9])), { code: 'identity-conflict' });
  assert.deepEqual(await backend.get(key), bytes);
  assert.ok(state.requests.every(request => request.url === '/test-bucket/owner/a_b-0'));
  await backend.remove(key);
  await backend.remove(key);
  await assert.rejects(backend.get(key), { code: 'missing' });
});

test('S3 resolves a lost PUT reply only by reading the original identity', async t => {
  const { state, options } = await s3HttpFixture(t);
  const backend = createS3Backend(options);
  const bytes = new Uint8Array([1, 7, 9]);
  state.respond = (request, response, body) => {
    if (request.method !== 'PUT') return false;
    state.objects.set(request.url, body);
    response.destroy();
    return true;
  };
  await backend.put('lost/reply', bytes);
  assert.deepEqual(await backend.get('lost/reply'), bytes);
  assert.equal(state.requests.filter(request => request.method === 'PUT').length, 1);

  await backend.put('lost/conflict', Buffer.from('different'));
  state.respond = (request, response) => {
    if (request.method !== 'PUT') return false;
    response.destroy();
    return true;
  };
  await assert.rejects(backend.put('lost/conflict', bytes), { code: 'upload-unknown' });
  assert.equal(Buffer.from(await backend.get('lost/conflict')).toString(), 'different');
});

test('S3 mismatched recovery bytes retain unknown HTTP outcome provenance until a completed response is known', async t => {
  const { state, options } = await s3HttpFixture(t);
  const backend = createS3Backend(options);
  const original = new Uint8Array([1, 2, 3]);
  await backend.put('owner/existing', original);
  for (const status of [408, 429, 500, 501, 502, 503, 504, 200, 409, 412]) {
    state.respond = (request, response) => {
      if (request.method !== 'PUT') return false;
      response.writeHead(status).end();
      return true;
    };
    await assert.rejects(backend.put('owner/existing', new Uint8Array([9])),
      { code: [200, 409, 412].includes(status) ? 'identity-conflict' : 'upload-unknown' });
    assert.deepEqual(await backend.get('owner/existing'), original);
  }
});

test('S3 keeps 404 after an unknown upload unresolved and a late upload cannot replace newer bytes', async t => {
  const { state, options } = await s3HttpFixture(t);
  const backend = createS3Backend(options);
  let finishLate;
  state.respond = (request, response, body) => {
    if (request.method !== 'PUT') return false;
    finishLate = () => { if (!state.objects.has(request.url)) state.objects.set(request.url, body); };
    response.destroy();
    return true;
  };
  await assert.rejects(backend.put('lost/late', new Uint8Array([1])), { code: 'upload-unknown' });
  assert.equal(state.requests.filter(request => request.method === 'PUT').length, 1);
  state.respond = undefined;
  await backend.put('lost/late', new Uint8Array([2]));
  finishLate();
  await assert.rejects(backend.put('lost/late', new Uint8Array([1])), { code: 'identity-conflict' });
  assert.deepEqual(await backend.get('lost/late'), new Uint8Array([2]));
});

test('S3 classifies read failures, forbids unsafe keys before IO, and never falls back to unconditional PUT', async t => {
  const { state, options } = await s3HttpFixture(t);
  const backend = createS3Backend(options);
  for (const key of ['../escape', 'a//b', '/abs', 'x.y', 'A/b']) {
    await assert.rejects(backend.put(key, new Uint8Array()), { code: 'forbidden' });
    await assert.rejects(backend.get(key), { code: 'forbidden' });
    await assert.rejects(backend.remove(key), { code: 'forbidden' });
  }
  assert.equal(state.requests.length, 0);
  for (const [status, code, body] of [[403, 'forbidden', ''], [503, 'unavailable', ''], [404, 'missing', '<Error><Code>NoSuchKey</Code></Error>'],
    [404, 'unavailable', '<Error><Code>NoSuchBucket</Code></Error>']]) {
    state.respond = (_request, response) => { response.writeHead(status).end(body); return true; };
    await assert.rejects(backend.get('owner/blob'), error => {
      assert.ok(error instanceof BlobError);
      assert.equal(error.code, code);
      assert.ok(!error.message.includes(options.endpoint));
      assert.ok(!error.message.includes(options.secretAccessKey));
      return true;
    });
  }
  state.respond = (_request, response) => { response.writeHead(405).end(); return true; };
  await assert.rejects(backend.put('owner/blob', new Uint8Array()), { code: 'unavailable' });
  assert.equal(state.requests.filter(request => request.method === 'PUT').length, 1);
});

test('file backend rejects unsafe keys and symlinks without changing their targets', async t => {
  const base = await mkdtemp(join(tmpdir(), 'xunjie-blobs-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'victim'), 'original');
  const backend = createFileBackend({ id: 'files', root });
  for (const key of ['', '../outside/victim', '/outside/victim', 'a//b', 'a/', 'a/./b', 'A/b', 'a\\b', 'a/%2e%2e/b', 'a\0b']) {
    for (const operation of [() => backend.put(key, new Uint8Array([7])), () => backend.get(key), () => backend.remove(key)]) {
      await assert.rejects(operation(), error => error instanceof BlobError && error.code === 'forbidden');
    }
  }
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(join(outside, 'victim'), join(root, 'shortcut'));
  for (const key of ['escape/victim', 'shortcut']) {
    await assert.rejects(backend.put(key, new Uint8Array([8])), { code: 'forbidden' });
    await assert.rejects(backend.get(key), { code: 'forbidden' });
    await assert.rejects(backend.remove(key), { code: 'forbidden' });
  }
  const alias = join(base, 'alias');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = createFileBackend({ id: 'files', root: alias });
  await assert.rejects(aliased.put('new', new Uint8Array()), { code: 'forbidden' });
  await assert.rejects(aliased.get('shortcut'), { code: 'forbidden' });
  await assert.rejects(aliased.remove('shortcut'), { code: 'forbidden' });
  assert.equal(await readFile(join(outside, 'victim'), 'utf8'), 'original');
});

test('file backend classifies missing and non-file blobs and removes idempotently', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-blobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = createFileBackend({ id: 'files', root });
  await assert.rejects(backend.get('absent/path'), error => {
    assert.ok(error instanceof BlobError);
    assert.equal(error.code, 'missing');
    assert.ok(!error.message.includes(root));
    return true;
  });
  await backend.remove('absent/path');
  await mkdir(join(root, 'directory'));
  await assert.rejects(backend.get('directory'), { code: 'corrupt' });
  await backend.put('owner/blob', new Uint8Array());
  assert.deepEqual(await backend.get('owner/blob'), new Uint8Array());
  await backend.remove('owner/blob');
  await backend.remove('owner/blob');
  await assert.rejects(backend.get('owner/blob'), { code: 'missing' });
  assert.deepEqual(await fileUsage(root), { files: 0, bytes: 0 });
});

test('file blob identity accepts equal retries and rejects different bytes, including competing writers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-blobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = createFileBackend({ id: 'files', root });
  const original = new Uint8Array([1, 2, 3]);
  await backend.put('owner/same', original);
  await backend.put('owner/same', original);
  await assert.rejects(backend.put('owner/same', new Uint8Array([4, 5, 6])),
    error => error instanceof BlobError && error.code === 'identity-conflict');
  assert.deepEqual(await backend.get('owner/same'), original);

  const contenders = Array.from({ length: 12 }, (_, i) => new Uint8Array(32_768).fill(i));
  const results = await Promise.allSettled(contenders.map(bytes => backend.put('owner/race', bytes)));
  const winner = results.findIndex(result => result.status === 'fulfilled');
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(result => result.status === 'rejected')) {
    assert.equal(result.reason.code, 'identity-conflict');
  }
  assert.deepEqual(await backend.get('owner/race'), contenders[winner]);
});

test('Windows IO restrictions preserve immutable file puts, retries and removals without directory handles', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-blobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Isolate platform and builtin IO substitutions from the rest of the tests.
  // This exercises the Windows branch on the current OS; it is not native Windows acceptance.
  const scenario = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const originalOpen = fs.promises.open;
    fs.promises.open = async (path, flags, mode) => {
      const info = await fs.promises.lstat(path).catch(() => undefined);
      if (info?.isDirectory()) throw Object.assign(new Error('Directory handles unsupported'), { code: 'EPERM' });
      const file = await originalOpen(path, flags, mode);
      const sync = file.sync.bind(file);
      file.sync = async () => {
        if ((flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0) {
          throw Object.assign(new Error('Flush requires a writable handle'), { code: 'EBADF' });
        }
        await sync();
      };
      return file;
    };
    syncBuiltinESMExports();
    const { createFileBackend } = await import(import.meta.resolve('@xunjie/storage'));
    const backend = createFileBackend({ id: 'files', root: process.argv[1] });
    const bytes = new Uint8Array([0, 255, 128]);
    await backend.put('owner/blob', bytes);
    await backend.put('owner/blob', bytes);
    await assert.rejects(backend.put('owner/blob', new Uint8Array([9])), { code: 'identity-conflict' });
    assert.deepEqual(await backend.get('owner/blob'), bytes);
    await backend.remove('owner/blob');
    await backend.remove('owner/blob');
    await assert.rejects(backend.get('owner/blob'), { code: 'missing' });
  `;
  await exec(process.execPath, ['--input-type=module', '-e', scenario, root]);
});

test('POSIX directory flush failures reject publication and preserve the same identity for recovery',
  { skip: process.platform === 'win32' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'xunjie-blobs-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const scenario = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const root = await fs.promises.realpath(process.argv[1]);
      const originalOpen = fs.promises.open;
      const originalLink = fs.promises.link;
      let failBeforePublish = true;
      let failAfterPublish = true;
      let failFileFlush = false;
      let published = false;
      fs.promises.link = async (...args) => {
        await originalLink(...args);
        published = true;
      };
      fs.promises.open = async (path, flags, mode) => {
        const file = await originalOpen(path, flags, mode);
        const directory = (await file.stat()).isDirectory();
        const sync = file.sync.bind(file);
        file.sync = async () => {
          if (directory ? failBeforePublish || (failAfterPublish && published) : failFileFlush) {
            throw Object.assign(new Error('Injected durability IO failure'), { code: 'EIO' });
          }
          await sync();
        };
        return file;
      };
      syncBuiltinESMExports();
      const { createFileBackend } = await import(import.meta.resolve('@xunjie/storage'));
      const backend = createFileBackend({ id: 'files', root });
      const bytes = new Uint8Array([0, 255, 128]);
      await assert.rejects(backend.put('owner/blob', bytes), { code: 'unavailable' });
      await assert.rejects(backend.get('owner/blob'), { code: 'missing' });
      failBeforePublish = false;
      await assert.rejects(backend.put('owner/blob', bytes), { code: 'upload-unknown' });
      await assert.rejects(backend.get('owner/blob'), { code: 'unavailable' });
      failAfterPublish = false;
      assert.deepEqual(await backend.get('owner/blob'), bytes);
      failFileFlush = true;
      await assert.rejects(backend.get('owner/blob'), { code: 'unavailable' });
      failFileFlush = false;
      await assert.rejects(backend.put('owner/blob', new Uint8Array([9])), { code: 'identity-conflict' });
      await backend.put('owner/blob', bytes);
      assert.deepEqual(await backend.get('owner/blob'), bytes);
    `;
    await exec(process.execPath, ['--input-type=module', '-e', scenario, root]);
  });

test('a killed file writer leaves complete or missing bytes and remove reclaims its orphan without losing confirmed data', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-blobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await interruptFilePut(t, root);
  const backend = createFileBackend({ id: 'files', root });
  assert.deepEqual(await backend.get('owner/confirmed'), new Uint8Array([0, 255, 128, 1]));
  try {
    const result = await backend.get('owner/interrupted');
    assert.equal(result.length, 16 * 1024 * 1024);
    assert.ok(result.every(byte => byte === 73));
  } catch (error) {
    assert.ok(error instanceof BlobError);
    assert.equal(error.code, 'missing');
  }
  const before = await fileUsage(root);
  await backend.remove('owner/interrupted');
  await backend.remove('owner/interrupted');
  const after = await fileUsage(root);
  assert.ok(after.files < before.files && after.bytes < before.bytes, 'cleanup must reclaim the interrupted upload storage');
  assert.deepEqual(after, { files: 1, bytes: 4 });
  await assert.rejects(backend.get('owner/interrupted'), { code: 'missing' });
  assert.deepEqual(await backend.get('owner/confirmed'), new Uint8Array([0, 255, 128, 1]));
});

test('orphan cleanup preserves staging for a different key with the same leaf prefix', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-blobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await interruptFilePut(t, root, 'interrupted_more');
  const before = await fileUsage(root);
  assert.ok(before.files > 1 && before.bytes > 4, 'the first killed writer must leave an object or orphan to preserve');
  await interruptFilePut(t, root, 'interrupted');
  const backend = createFileBackend({ id: 'files', root });
  await backend.remove('owner/interrupted');
  assert.deepEqual(await fileUsage(root), before);
  await assert.rejects(backend.get('owner/interrupted'), { code: 'missing' });
  await backend.remove('owner/interrupted_more');
  assert.deepEqual(await fileUsage(root), { files: 1, bytes: 4 });
  await assert.rejects(backend.get('owner/interrupted_more'), { code: 'missing' });
  assert.deepEqual(await backend.get('owner/confirmed'), new Uint8Array([0, 255, 128, 1]));
});

test('S3 timeout includes stalled response bodies and cannot become an unconditional retry', async t => {
  const { state, options } = await s3HttpFixture(t);
  const backend = createS3Backend({ ...options, requestTimeoutMs: 50 });
  state.respond = (request, response, body) => {
    if (request.method === 'PUT') state.objects.set(request.url, body);
    response.writeHead(200, { 'content-length': 10 }).flushHeaders();
    return true;
  };
  await assert.rejects(backend.get('owner/stalled'), { code: 'unavailable' });
  await assert.rejects(backend.put('owner/stalled', new Uint8Array([1])), { code: 'upload-unknown' });
  assert.equal(state.requests.filter(request => request.method === 'PUT').length, 1);
});
