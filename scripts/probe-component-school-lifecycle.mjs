import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Acceptance-only wrapper: uses the real CLI, retains identity and never signals processes.
const [action, packageDirectory, environmentRoot] = process.argv.slice(2);
assert.ok(['stop', 'start', 'status'].includes(action));
const pkg = resolve(packageDirectory), root = resolve(environmentRoot);
const initial = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
const node = join(pkg, 'resources/node/bin/node');
const args = [join(pkg, 'app/cli.js'), action, '--root', root, '--resources', join(pkg, 'resources.json')];
const result = { action, environmentId: initial.environmentId, attempts: [], status: 'running' };
const exists = async p => access(p).then(() => true, () => false);
const started = Date.now();
try {
    let value;
    try {
      value = JSON.parse(execFileSync(node, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 65000 }));
      assert.equal(value.environment.environmentId, initial.environmentId);
      assert.equal(value.environment.installationId, initial.installationId);
      result.attempts.push({ elapsedMs: Date.now() - started, state: value.state });
    } catch (error) {
      // CLI owns credential redaction; expose only its structured message, never private hook arguments.
      let message = 'CLI command failed';
      for (const line of String(error.stderr ?? '').trim().split('\n')) {
        try { const parsed = JSON.parse(line); if (typeof parsed.message === 'string') message = parsed.message; } catch {}
      }
      result.attempts.push({ elapsedMs: Date.now() - started, error: message, exitCode: error.status ?? null });
      throw new Error(message);
    }
    if (action === 'stop') {
      assert.equal(value.state, 'stopped');
      result.instancePresent = await exists(join(root, 'instance.json'));
      result.launchPresent = await exists(join(root, 'launch.json'));
      assert.equal(result.instancePresent, false);
      assert.equal(result.launchPresent, false);
    } else if (action === 'start') {
      assert.equal(value.state, 'ready');
      const instance = JSON.parse(await readFile(join(root, 'instance.json'), 'utf8'));
      assert.equal(new URL(instance.endpoint).hostname, '127.0.0.1');
      result.controlProtocol = new URL(instance.endpoint).protocol;
    }
    result.status = 'passed';
    result.state = value.state;
} catch (error) {
  result.status = 'failed'; result.error = error.message; process.exitCode = 1;
}
result.durationMs = Date.now() - started;
console.log(JSON.stringify(result));
