import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import { createSshRecoveryReceiver } from '@xunjie/product-runtime';

test('the deployment receiver verifies a remote CLI fencing proof through the SSH process boundary', async () => {
  const environmentId = '11111111-1111-4111-8111-111111111111';
  const serviceId = '22222222-2222-4222-8222-222222222222';
  const sourceId = '33333333-3333-4333-8333-333333333333';
  let supplied;
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const stub = mock.method(cp, 'spawn', (command, args, options) => {
    supplied = { command, args, options };
    process.nextTick(() => {
      child.stdout.end(JSON.stringify({ fenced: true, receiverId: environmentId + '/' + serviceId,
        sourceEnvironmentId: sourceId, sourceServiceIds: [sourceId] }) + '\n'); child.emit('close', 0);
    });
    return child;
  });
  try {
    const receiver = createSshRecoveryReceiver({ id: environmentId + '/' + serviceId, ssh: {
      configFile: resolve('approved-ssh.conf'), host: 'approved-school', nodePath: '/opt/product/resources/node/bin/node',
      cliPath: '/opt/product/app/cli.js', root: "/srv/school's environment" } });
    const result = await receiver.fence({ environmentId: sourceId }, [sourceId]);
    assert.equal(result.fenced, true);
    assert.equal(supplied.command, 'ssh');
    assert.ok(supplied.args.includes('StrictHostKeyChecking=yes'));
    assert.ok(supplied.args.includes('approved-school'));
    assert.match(supplied.args.at(-1), /fence-source/);
    assert.equal(supplied.options.shell, false);
  } finally { stub.mock.restore(); }
});

test('a successful SSH exit with another receiver identity never confirms fencing', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const stub = mock.method(cp, 'spawn', () => {
    process.nextTick(() => { child.stdout.end(JSON.stringify({ fenced: true, receiverId: id + '/' + id,
      sourceEnvironmentId: id, sourceServiceIds: [id] })); child.emit('close', 0); });
    return child;
  });
  try {
    const receiver = createSshRecoveryReceiver({ id: id + '/22222222-2222-4222-8222-222222222222', ssh: {
      configFile: resolve('approved-ssh.conf'), host: 'approved-school', nodePath: '/opt/node', cliPath: '/opt/cli.js', root: '/srv/school' } });
    await assert.rejects(receiver.fence({ environmentId: id }, [id]), /invalid-receiver-proof/);
  } finally { stub.mock.restore(); }
});
