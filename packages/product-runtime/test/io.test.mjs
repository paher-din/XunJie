import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { atomicJson, readJson } from '../src/io.ts';

const exec = promisify(execFile);
const ioUrl = new URL('../src/io.ts', import.meta.url).href;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xj JSON 持久化 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, 'authority.json') };
}

test('confirmed replacement is readable in a fresh process, with a held old snapshot on POSIX', async t => {
  const f = await fixture(t);
  const old = { operationId: 'original', generation: 1, payload: '原内容' };
  const next = { operationId: 'replacement', generation: 2, payload: '新内容'.repeat(32_768) };
  await atomicJson(f.path, old);
  const snapshot = await open(f.path, 'r');
  if (process.platform === 'win32') {
    // A Windows read handle can deny replacement. Its lifetime is not the
    // POSIX old-inode snapshot contract, so close before this confirmed write.
    assert.deepEqual(JSON.parse(await snapshot.readFile('utf8')), old);
    await snapshot.close();
    await atomicJson(f.path, next);
  } else {
    try {
      await atomicJson(f.path, next);
      assert.deepEqual(JSON.parse(await snapshot.readFile('utf8')), old);
    } finally { await snapshot.close(); }
  }
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', `
    import { readJson } from ${JSON.stringify(ioUrl)};
    console.log(JSON.stringify(await readJson(process.argv[1])));
  `, f.path]);
  assert.deepEqual(JSON.parse(stdout), next);
  assert.deepEqual(await readdir(f.root), ['authority.json']);
  if (process.platform !== 'win32') assert.equal((await stat(f.path)).mode & 0o777, 0o600);
});

test('concurrent processes replace whole documents without exposing missing or partial JSON', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const payload = marker => marker.repeat(131_072);
  await atomicJson(f.path, { writer: 'initial', sequence: 0, payload: payload('i') });
  const writer = marker => exec(process.execPath, ['--input-type=module', '--eval', `
    import { atomicJson } from ${JSON.stringify(ioUrl)};
    const [path, writer] = process.argv.slice(1);
    for (let sequence = 1; sequence <= 12; sequence++) {
      await atomicJson(path, { writer, sequence, payload: writer.repeat(131_072) });
    }
  `, f.path, marker]);
  let finished = false;
  // Attach failure handling immediately, and always settle children before cleanup.
  const writers = Promise.allSettled([writer('a'), writer('b')]).finally(() => { finished = true; });
  let reads = 0;
  try {
    do {
      const current = await readJson(f.path);
      assert.ok(['initial', 'a', 'b'].includes(current.writer));
      assert.ok(Number.isInteger(current.sequence) && current.sequence >= 0 && current.sequence <= 12);
      assert.equal(current.payload, payload(current.writer === 'initial' ? 'i' : current.writer));
      reads++;
    } while (!finished);
  } finally {
    const results = await writers;
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  assert.ok(reads > 0);
  assert.equal((await readJson(f.path)).sequence, 12);
  assert.deepEqual(await readdir(f.root), ['authority.json']);
});

test('Windows sharing conflicts retry through rename, reopening and flushing without deleting the destination', async t => {
  for (const phase of ['rename', 'open', 'sync']) await t.test(phase, async t => {
    const f = await fixture(t);
    await writeFile(f.path, '{"operationId":"old","generation":1}\n');
    // Select the Windows error policy in a child on POSIX; all successful I/O
    // is real. Native Windows sharing behavior is covered by the tests below.
    await exec(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import { dirname, basename } from 'node:path';
      import { atomicJson, readJson } from ${JSON.stringify(ioUrl)};
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const [path, phase] = process.argv.slice(1), value = { operationId: 'replacement', generation: 2 };
      const originalRename = fs.rename, originalOpen = fs.open;
      const probe = await originalOpen(path, 'r');
      const prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync;
      await probe.close();
      const conflicts = ['EPERM', 'EACCES', 'EBUSY'];
      async function conflict() {
        const code = conflicts.shift();
        if (code) {
          assert.deepEqual(await readJson(path), phase === 'rename' ? { operationId: 'old', generation: 1 } : value);
          throw Object.assign(new Error('temporary sharing conflict'), { code });
        }
      }
      fs.rename = async (...args) => {
        if (phase === 'rename') await conflict();
        return originalRename(...args);
      };
      fs.open = async (...args) => {
        if (phase === 'open' && args[0] === path && args[1] === 'r+') await conflict();
        return originalOpen(...args);
      };
      prototype.sync = async function () {
        if (phase === 'sync' && (await readJson(path)).operationId === value.operationId) await conflict();
        return originalSync.call(this);
      };
      syncBuiltinESMExports();
      try {
        await atomicJson(path, value);
        assert.deepEqual(await readJson(path), value);
        assert.deepEqual(await fs.readdir(dirname(path)), [basename(path)]);
      } finally {
        fs.rename = originalRename; fs.open = originalOpen; prototype.sync = originalSync;
        syncBuiltinESMExports();
      }
    `, f.path, phase]);
    assert.deepEqual(await readJson(f.path), { operationId: 'replacement', generation: 2 });
    assert.deepEqual(await readdir(f.root), ['authority.json']);
  });
});

test('a persistent Windows rename denial reaches the deadline, preserves the original and cleans its temporary', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const original = '{"operationId":"keep-original","generation":7}\n';
  await writeFile(f.path, original);
  await exec(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { atomicJson } from ${JSON.stringify(ioUrl)};
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const originalRename = fs.rename;
    fs.rename = async () => { throw Object.assign(new Error('persistent access denial'), { code: 'EACCES' }); };
    syncBuiltinESMExports();
    const started = Date.now();
    try {
      await assert.rejects(atomicJson(process.argv[1], { generation: 8 }), { code: 'EACCES' });
      assert.ok(Date.now() - started >= 1_500, 'sharing failures must get a bounded retry window');
    } finally { fs.rename = originalRename; syncBuiltinESMExports(); }
  `, f.path], { timeout: 8_000 });
  assert.equal(await readFile(f.path, 'utf8'), original);
  assert.deepEqual(await readdir(f.root), ['authority.json']);
});

test('native Windows reader release allows replacement without a delete fallback', {
  skip: process.platform !== 'win32' ? 'Requires actual Windows file sharing semantics' : false,
  timeout: 10_000,
}, async t => {
  const f = await fixture(t);
  await atomicJson(f.path, { operationId: 'old' });
  const reader = await open(f.path, 'r');
  let closing;
  const timer = setTimeout(() => { closing = reader.close(); }, 150);
  try {
    await atomicJson(f.path, { operationId: 'replacement' });
  } finally {
    clearTimeout(timer);
    await (closing ?? reader.close());
  }
  assert.deepEqual(await readJson(f.path), { operationId: 'replacement' });
  assert.deepEqual(await readdir(f.root), ['authority.json']);
});

test('native Windows persistent reader blocks replacement only until the bounded deadline', {
  skip: process.platform !== 'win32' ? 'Requires actual Windows file sharing semantics' : false,
  timeout: 10_000,
}, async t => {
  const f = await fixture(t);
  const original = { operationId: 'old' };
  await atomicJson(f.path, original);
  const reader = await open(f.path, 'r');
  try {
    await assert.rejects(atomicJson(f.path, { operationId: 'replacement' }), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
  } finally { await reader.close(); }
  assert.deepEqual(await readJson(f.path), original);
  assert.deepEqual(await readdir(f.root), ['authority.json']);
});

test('a real partial write failure preserves the original file and removes its temporary', {
  skip: process.platform === 'win32' ? 'POSIX RLIMIT_FSIZE fault injection; Windows has no /bin/sh ulimit' : false,
  timeout: 15_000,
}, async t => {
  const f = await fixture(t);
  const original = '{"operationId":"keep-original","generation":7}\n';
  await writeFile(f.path, original);
  // Restrict only the disposable child. Ignoring SIGXFSZ makes the actual
  // partial filesystem write reject with EFBIG so product cleanup can run.
  await exec('/bin/sh', ['-c', 'ulimit -f 64; exec "$@"', 'atomic-json-size-limit', process.execPath,
    '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { atomicJson } from ${JSON.stringify(ioUrl)};
      process.on('SIGXFSZ', () => {});
      await assert.rejects(atomicJson(process.argv[1], { payload: 'x'.repeat(524_288) }), { code: 'EFBIG' });
    `, f.path]);
  assert.equal(await readFile(f.path, 'utf8'), original);
  assert.deepEqual(await readdir(f.root), ['authority.json']);
});

test('a file flush failure rejects without publishing and cleans the written temporary', async t => {
  const f = await fixture(t);
  const original = '{"operationId":"keep-original","generation":7}\n';
  await writeFile(f.path, original);
  // Inject only the device flush failure in a disposable process. All opens,
  // writes, reads, rename decisions and cleanup use the real filesystem.
  await exec(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { open } from 'node:fs/promises';
    import { atomicJson } from ${JSON.stringify(ioUrl)};
    const probe = await open(process.argv[1], 'r');
    const prototype = Object.getPrototypeOf(probe), sync = prototype.sync;
    await probe.close();
    prototype.sync = async function () { throw Object.assign(new Error('device flush failed'), { code: 'EIO' }); };
    try {
      await assert.rejects(atomicJson(process.argv[1], { operationId: 'unconfirmed', generation: 8 }), { code: 'EIO' });
    } finally { prototype.sync = sync; }
  `, f.path]);
  assert.equal(await readFile(f.path, 'utf8'), original);
  assert.deepEqual(await readdir(f.root), ['authority.json']);
});

test('a parent flush failure rejects after publication and the same identity can be inspected and retried', {
  skip: process.platform === 'win32' ? 'Windows has no POSIX directory sync barrier' : false,
}, async t => {
  const f = await fixture(t);
  await atomicJson(f.path, { operationId: 'old', generation: 1 });
  await exec(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { open, readdir } from 'node:fs/promises';
    import { dirname } from 'node:path';
    import { atomicJson, readJson } from ${JSON.stringify(ioUrl)};
    const path = process.argv[1], value = { operationId: 'same-request', generation: 2 };
    const probe = await open(path, 'r');
    const prototype = Object.getPrototypeOf(probe), sync = prototype.sync;
    await probe.close();
    prototype.sync = async function () {
      if ((await this.stat()).isDirectory()) throw Object.assign(new Error('directory flush failed'), { code: 'EIO' });
      return sync.call(this);
    };
    try {
      await assert.rejects(atomicJson(path, value), { code: 'EIO' });
      assert.deepEqual(await readJson(path), value);
      assert.deepEqual(await readdir(dirname(path)), ['authority.json']);
    } finally { prototype.sync = sync; }
    await atomicJson(path, value);
    assert.deepEqual(await readJson(path), value);
  `, f.path]);
  assert.deepEqual(await readJson(f.path), { operationId: 'same-request', generation: 2 });
  assert.deepEqual(await readdir(f.root), ['authority.json']);
});

test('Windows JSON replacement reports a failed published-file flush and can retry the same identity', async t => {
  for (const kind of ['retired', 'generation', 'ordinary']) await t.test(kind, async t => {
    const f = await fixture(t);
    const path = kind === 'retired' ? join(f.root, 'retired.json') : kind === 'generation'
      ? join(f.root, 'private', 'connections', 'target-env', 'target-service', 'sources', 'source-env', 'source-service', 'generation.json')
      : f.path;
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"operationId":"old","generation":1}\n');
    // On POSIX, select the Windows branch only inside this child; filesystem
    // operations remain real. This checks error/outcome handling, not Windows
    // kernel or power-loss behavior. On Windows it exercises the native branch.
    await exec(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { open, readdir } from 'node:fs/promises';
      import { dirname, basename } from 'node:path';
      import { atomicJson, readJson } from ${JSON.stringify(ioUrl)};
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const [path, kind] = process.argv.slice(1), value = { operationId: 'same-request', generation: 2 };
      const probe = await open(path, 'r');
      const prototype = Object.getPrototypeOf(probe), sync = prototype.sync;
      await probe.close();
      prototype.sync = async function () {
        // Inject a real I/O-error result only once the replacement is visible.
        // The temporary's pre-publication flush still reaches the filesystem.
        if ((await readJson(path)).operationId === value.operationId) {
          throw Object.assign(new Error('published metadata flush failed'), { code: 'EIO' });
        }
        return sync.call(this);
      };
      try {
        await assert.rejects(atomicJson(path, value), { code: 'EIO' });
        assert.deepEqual(await readJson(path), value);
        assert.deepEqual(await readdir(dirname(path)), [basename(path)]);
      } finally { prototype.sync = sync; }
      await atomicJson(path, value);
      assert.deepEqual(await readJson(path), value);
    `, path, kind]);
    assert.deepEqual(await readJson(path), { operationId: 'same-request', generation: 2 });
  });
});

test('an actual rename conflict preserves the existing destination and cleans the completed temporary', async t => {
  const f = await fixture(t);
  await mkdir(f.path);
  const sentinel = join(f.path, 'unrelated.json');
  await writeFile(sentinel, '{"keep":true}\n');
  await assert.rejects(atomicJson(f.path, { replace: true }), error => ['EISDIR', 'ENOTDIR', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code));
  assert.equal(await readFile(sentinel, 'utf8'), '{"keep":true}\n');
  assert.deepEqual(await readdir(f.root), ['authority.json']);
});

test('serialization failure leaves the original bytes untouched without a temporary', async t => {
  const f = await fixture(t);
  const original = '{"operationId":"keep-original"}\n';
  await writeFile(f.path, original);
  const circular = {}; circular.self = circular;
  await assert.rejects(atomicJson(f.path, circular), TypeError);
  assert.equal(await readFile(f.path, 'utf8'), original);
  assert.deepEqual(await readdir(f.root), ['authority.json']);
});
