import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DEPLOYMENT_FILES, prepareDeployment } from './prepare-deployment.mjs';

test('developer deployment takes only the exact committed allowlist and records all digests; dirty content cannot acquire that source label', () => {
  const root = mkdtempSync(join(tmpdir(), 'xj-deploy-source-')), repo = join(root, 'repo'), output = join(root, 'bundle');
  mkdirSync(repo);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    git(['init', '-q']);
    for (const path of DEPLOYMENT_FILES) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), 'committed-fixture\n'); }
    writeFileSync(join(repo, 'unrelated-private.json'), 'not-in-source-bundle');
    git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const commit = git(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, DEPLOYMENT_FILES[0]), 'dirty-content\n');
    const receipt = prepareDeployment(commit, output, repo);
    assert.equal(receipt.sourceCommit, commit);
    assert.deepEqual(receipt.files.map(f => f.path), DEPLOYMENT_FILES);
    for (const file of receipt.files) {
      const bytes = readFileSync(join(output, file.path));
      assert.equal(bytes.toString(), 'committed-fixture\n');
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
    assert.throws(() => readFileSync(join(output, 'unrelated-private.json')), { code: 'ENOENT' });
    assert.throws(() => prepareDeployment(commit, output, repo), /NEW_DIRECTORY_REQUIRED/);
    assert.throws(() => prepareDeployment('HEAD', join(root, 'other'), repo), /FIXED_COMMIT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
