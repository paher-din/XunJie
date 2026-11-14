import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { packBuild, restoreBuild } from './ci-build-artifact.mjs';

function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'xunjie-build-artifact-test-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'repo'), artifact = join(temporary, 'artifact');
  mkdirSync(root);
  const git = args => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git(['init', '-q']);
  writeFileSync(join(root, 'source'), 'source');
  git(['add', 'source']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  for (const path of ['packages/contracts/dist', 'packages/storage/dist', 'packages/learning-space/dist',
    'packages/agent-runtime/dist', 'packages/model-gateway/dist', 'packages/agents/dist',
    'packages/product-runtime/dist', 'apps/server/dist', 'apps/web/dist', 'apps/web/dist-runtime', 'apps/local-runtime/dist', '.cache/xunjie-build']) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, 'result.json'), '{"built":true}\n');
  }
  return { root, artifact };
}

test('a bound build restores both web outputs and build metadata, replacing stale outputs', t => {
  const { root, artifact } = fixture(t);
  packBuild(root, artifact);
  writeFileSync(join(root, 'apps/web/dist/stale.js'), 'stale');
  rmSync(join(root, 'apps/web/dist-runtime'), { recursive: true });
  restoreBuild(root, artifact);
  assert.equal(readFileSync(join(root, 'apps/web/dist-runtime/result.json'), 'utf8'), '{"built":true}\n');
  assert.throws(() => readFileSync(join(root, 'apps/web/dist/stale.js')), { code: 'ENOENT' });
  assert.equal(readFileSync(join(root, '.cache/xunjie-build/result.json'), 'utf8'), '{"built":true}\n');
});

for (const corruption of ['commit', 'file', 'archive', 'path']) {
  test(`${corruption} mismatch is rejected before replacing the consumer's outputs`, t => {
    const { root, artifact } = fixture(t);
    packBuild(root, artifact);
    const file = join(artifact, 'manifest.json'), manifest = JSON.parse(readFileSync(file));
    if (corruption === 'commit') manifest.commit = '0'.repeat(40);
    if (corruption === 'file') manifest.files['apps/web/dist/result.json'].sha256 = '0'.repeat(64);
    if (corruption === 'path') manifest.files['../outside'] = { bytes: 0, sha256: '0'.repeat(64) };
    if (corruption === 'archive') writeFileSync(join(artifact, 'build.tar'), 'truncated');
    writeFileSync(file, JSON.stringify(manifest));
    writeFileSync(join(root, 'apps/web/dist/result.json'), 'consumer original');
    assert.throws(() => restoreBuild(root, artifact), /mismatch|Invalid/);
    assert.equal(readFileSync(join(root, 'apps/web/dist/result.json'), 'utf8'), 'consumer original');
  });
}


test('restored CI output executes Agent subpath imports without the original build outputs', t => {
  const { root, artifact } = fixture(t);
  for (const [name, source] of Object.entries({
    'agent-runtime': 'export const runtime = 2;',
    'model-gateway': 'export const model = 3;',
    agents: 'export { runtime } from "../../agent-runtime/dist/feature.js"; export { model } from "../../model-gateway/dist/feature.js";',
  })) {
    writeFileSync(join(root, `packages/${name}/dist/feature.js`), source);
    writeFileSync(join(root, `packages/${name}/package.json`), '{"type":"module"}');
  }
  packBuild(root, artifact);
  for (const name of ['agent-runtime', 'model-gateway', 'agents']) rmSync(join(root, `packages/${name}/dist`), { recursive: true });
  restoreBuild(root, artifact);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'import {runtime, model} from "./packages/agents/dist/feature.js"; console.log(runtime + model);'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '5');
});
