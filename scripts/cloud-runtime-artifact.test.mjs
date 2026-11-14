import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildRuntimeArtifact } from '../tools/i0-cloud/build-runtime-artifact.mjs';

test('cloud server artifact executes workspace feature exports with an independent production install', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'xunjie-cloud-agent-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'source'), dependencies = join(temporary, 'dependencies');
  const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  put(source, 'package.json', '{"type":"module"}');
  put(source, 'package-lock.json', '{}');
  put(source, 'apps/web/dist/index.html', '<script type="module" src="/assets/main.js"></script>');
  put(source, 'apps/web/dist/assets/main.js', 'console.log("web");');
  put(source, 'tools/i0-cloud/cloud-host.mjs', 'export const host = true;');
  put(source, 'apps/server/package.json', JSON.stringify({ type: 'module', dependencies: { '@xunjie/agents': '0.1.0' } }));
  put(source, 'apps/server/dist/server/main.js', 'import { agent } from "@xunjie/agents/student"; console.log(agent);');
  put(dependencies, 'node_modules/.package-lock.json', '{"packages":{}}');
  const packages = {
    contracts: [[], 'export const value = 1;'],
    storage: [['contracts'], 'export { value } from "@xunjie/contracts/feature";'],
    'agent-runtime': [['storage'], 'import { value } from "@xunjie/storage/feature"; export const runtime = value + 1;'],
    'model-gateway': [['storage'], 'export const model = 3;'],
    'learning-space': [['storage'], 'export const learning = 4;'],
    agents: [['agent-runtime', 'model-gateway', 'learning-space'], 'import { runtime } from "@xunjie/agent-runtime/feature"; import { model } from "@xunjie/model-gateway/feature"; import { learning } from "@xunjie/learning-space/feature"; export const agent = runtime + model + learning;'],
  };
  for (const [name, [deps, code]] of Object.entries(packages)) {
    const metadata = JSON.stringify({ name: `@xunjie/${name}`, type: 'module', exports: { [name === 'agents' ? './student' : './feature']: './dist/feature.js' }, dependencies: Object.fromEntries(deps.map(dep => [`@xunjie/${dep}`, '0.1.0'])) });
    put(source, `packages/${name}/package.json`, metadata);
    put(source, `packages/${name}/dist/feature.js`, code);
    put(source, `packages/${name}/dist/tests/forbidden.js`, 'throw new Error("test host shipped");');
    put(dependencies, `packages/${name}/package.json`, metadata);
    mkdirSync(join(dependencies, 'node_modules/@xunjie'), { recursive: true });
    symlinkSync(`../../packages/${name}`, join(dependencies, 'node_modules/@xunjie', name), 'junction');
  }
  const { archive, manifest } = buildRuntimeArtifact({ source, dependencies, output: join(temporary, 'artifact'), commit: '2'.repeat(40), gitTree: '4'.repeat(40) });
  const extracted = join(temporary, 'extracted');
  mkdirSync(extracted);
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  const result = spawnSync(process.execPath, ['apps/server/dist/server/main.js'], { cwd: extracted, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '9');
  assert.equal(manifest.runtimeFiles.some(file => file.path.includes('/tests/')), false);
});
