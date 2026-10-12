import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

for (const [authorization, message] of [
  ['', 'Explicit P2 synthetic-data model authorization is required.'],
  ['approved-synthetic', 'DEEPSEEK_API_KEY is not configured through the approved local channel.'],
] as const) {
  test(`P2 model gate rejects ${authorization ? 'missing credentials' : 'missing authorization'} without network`, () => {
    const source = `
      import assert from 'node:assert/strict';
      import { realModelProbe } from ${JSON.stringify(new URL('./real-model-support.ts', import.meta.url).href)};
      globalThis.fetch = () => { throw new Error('Unexpected network access'); };
      assert.throws(() => realModelProbe(), { message: ${JSON.stringify(message)} });
      process.stdout.write('gate-closed');
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, DEEPSEEK_API_KEY: '', XUNJIE_P2_REAL_MODEL: authorization }, encoding: 'utf8',
    });
    assert.equal(output, 'gate-closed');
  });
}
