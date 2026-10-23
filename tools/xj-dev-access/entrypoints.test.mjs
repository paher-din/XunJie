import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('actual executable entrypoints run through the installed current directory symlink', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'xj-access-entry-'));
  try {
    const current = join(root, 'current');
    symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), current, 'dir');
    const run = (name, args = [], input = '') => spawnSync(process.execPath, [join(current, 'tools/xj-dev-access', name), ...args], { input, encoding: 'utf8', timeout: 5000 });
    const admin = run('admin.mjs', ['/run/xj129-deliberately-missing/admin.sock'], JSON.stringify({ operation: 'inspect' }));
    assert.equal(admin.status, 1);
    assert.equal(JSON.parse(admin.stdout).code, 'ADMIN_UNAVAILABLE');
    const server = run('server.mjs', [join(root, 'missing-config.json')]);
    assert.equal(server.status, 1);
    assert.match(server.stderr, /Developer access startup failed/);
    const prepare = run('prepare-deployment.mjs');
    assert.equal(prepare.status, 1);
    assert.match(prepare.stderr, /FULL_SHA/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
