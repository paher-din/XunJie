#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, globSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.argv.includes('--help')) {
  console.log('Usage: npm run test:storage:native [-- --out /absolute/evidence.json]\nRequires XUNJIE_PRODUCT_POSTGRES_BIN and XUNJIE_STORAGE_S3_CONFIG from the pinned real fixtures.\nWrites raw logs and a public summary under .verification/. No credential contents are recorded.');
  process.exit(0);
}
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Use --help for arguments.');
if (process.version !== 'v24.21.0') throw new Error('Use the pinned Node.js 24.21.0.');
const bin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
const configFile = process.env.XUNJIE_STORAGE_S3_CONFIG;
if (!bin || !configFile) throw new Error('Both real PostgreSQL and S3 fixture configuration are required.');
const postgres = join(bin, process.platform === 'win32' ? 'postgres.exe' : 'postgres');
const pgVersion = spawnSync(postgres, ['--version'], { encoding: 'utf8' });
if (pgVersion.status !== 0 || !pgVersion.stdout.includes(' 18.6')) throw new Error('Expected the complete pinned PostgreSQL 18.6 distribution.');
const s3Evidence = JSON.parse(await readFile(join(dirname(configFile), 'evidence.json'), 'utf8'));
if ((s3Evidence.releaseTag ?? s3Evidence.version) !== '4.50') throw new Error('Expected the pinned SeaweedFS 4.50 fixture.');
const fileHash = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const directory = join(root, '.verification', `storage-${runId}`);
await mkdir(directory, { recursive: true });
const output = args.length ? resolve(args[1]) : join(directory, 'summary.json');
const files = [
  ...globSync('packages/storage/test/**/*.runtime.test.mjs', { cwd: root }),
  ...globSync('apps/server/tests/storage-sample/**/*.runtime.test.mjs', { cwd: root }),
].sort();
if (!files.length) throw new Error('No native storage cases found.');
const sourceHash = createHash('sha256');
for (const path of [
  ...globSync('packages/storage/src/**/*.ts', { cwd: root }),
  ...globSync('packages/storage/test/**/*.mjs', { cwd: root }),
  ...globSync('apps/server/server/storage-sample/**/*.ts', { cwd: root }),
  ...globSync('apps/server/tests/storage-sample/**/*.mjs', { cwd: root }),
  'packages/contracts/src/storage.ts', 'scripts/probe-storage.mjs',
].sort()) {
  sourceHash.update(path); sourceHash.update(await readFile(join(root, path)));
}
const summary = {
  formatVersion: 1, issue: 144, startedAt: new Date().toISOString(),
  system: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
  sourceSha256: sourceHash.digest('hex'),
  postgres: { version: pgVersion.stdout.trim(), binarySha256: await fileHash(postgres), initialization: 'UTF8; libc C/C; UTC; plpgsql only' },
  s3: { version: s3Evidence.versionOutput, releaseUrl: s3Evidence.releaseUrl,
    assetUrl: s3Evidence.assetUrl, archiveSha256: s3Evidence.assetSha256 ?? s3Evidence.archiveSha256, binarySha256: s3Evidence.binarySha256 },
  tests: files, status: 'running',
};
await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
console.log(`Storage acceptance raw log: ${join(directory, 'native.log')}`);
const started = Date.now();
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=4', ...files], {
  cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
});
const log = (result.stdout ?? '') + (result.stderr ?? '');
await writeFile(join(directory, 'native.log'), log);
console.log(log.trimEnd());
const count = label => Number(new RegExp(`(?:ℹ |# )${label} (\\d+)`).exec(log)?.[1] ?? 0);
Object.assign(summary, { status: result.status === 0 && count('pass') > 0 && count('skipped') === 0 ? 'passed' : 'failed',
  exitCode: result.status, durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
  counts: { tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped') },
});
await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
console.log(`Storage acceptance ${summary.status}: ${output}`);
process.exitCode = summary.status === 'passed' ? 0 : 1;
