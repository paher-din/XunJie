import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSchoolDeviceSetup } from '../dist/school-device-setup.js';

const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'Student' };
const environmentId = randomUUID();
const module = (unit, capabilities = []) => ({ environmentId, serviceId: randomUUID(), unit,
  endpoint: 'http://127.0.0.1:1', protocolVersion: 1, capabilities });
const modules = [module('space-course'), module('teaching-agent', ['agent.sessions.v2']), module('model-connection'), module('tool-execution')];
const input = { version: 2, connectionId: randomUUID(), installationId: randomUUID(), deviceModules: modules };

test('legacy or mixed device handshakes fail before any authorization, grant, journal or binding effect', async () => {
  let calls = 0;
  const effect = async () => { calls++; throw new Error('handshake reached an effect'); };
  const setup = createSchoolDeviceSetup({ root: '/absent', target: { ...module('learning-data', ['agent.dependencies.v2']), environmentId: identity.environmentId },
    spaces: { authorizeConnection: effect }, bindings: {}, authority: {}, assertWritable: effect });
  const { version: _version, ...legacy } = input;
  for (const value of [legacy, { ...input, version: 1 }, { ...input, deviceModules: modules.map(item => item.unit === 'teaching-agent'
    ? { ...item, capabilities: ['teaching.agent'] } : item) }]) await assert.rejects(setup(identity, value), { code: 'incompatible' });
  assert.equal(calls, 0);
});
