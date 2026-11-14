import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { teachingAgentHttpCall } from '../dist/learning-http/agent-http.js';
import { routeExecutionHttp } from '../dist/learning-http/execution-http.js';
import { createSchoolClient } from '../dist/school-client.js';

const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'Current student' };

test('school client rejects old Agent routes and mixed session versions before touching the installation', async () => {
  const school = createSchoolClient('/absent', { services: [] });
  await assert.rejects(school.forward(randomUUID(), `agent/${randomUUID()}/conversation`), { code: 'incompatible' });
  await assert.rejects(school.forward(randomUUID(), 'skills/import', {}), { code: 'incompatible' });
  await assert.rejects(school.forward(randomUUID(), 'agent-sessions', {}, undefined, '', '1'), { code: 'incompatible' });
  await assert.rejects(school.forward(randomUUID(), 'agent-sources', undefined, undefined, '', '1'), { code: 'incompatible' });
  await assert.rejects(school.forward(randomUUID(), 'agent-sources', {}, undefined, '', '2'), { code: 'missing' });
});

test('legacy Agent HTTP paths fail incompatible rather than producing an old-engine call', () => {
  for (const [route, method] of [[`agent/${randomUUID()}/capabilities`, 'GET'], ['skills/import', 'POST']]) {
    assert.throws(() => teachingAgentHttpCall(identity, route, method, method === 'POST' ? {} : undefined), { code: 'incompatible' });
  }
});

test('browser execution claims use only the host callback with the original owner association', async () => {
  const activityId = randomUUID(), commandId = randomUUID(), browserId = randomUUID();
  const association = { runId: randomUUID(), stepId: randomUUID(), commandId, snapshotId: randomUUID() };
  const checked = [];
  let writes = 0;
  const executions = { agent: {
    async claimBrowser(who, activity, command, browser, guard) {
      assert.deepEqual([who, activity, command, browser], [identity, activityId, commandId, browserId]);
      await guard(association);
      writes += 1;
      return { claimed: true };
    },
  } };
  const authorize = async (who, activity, original) => { checked.push([who, activity, original]); };
  assert.deepEqual(await routeExecutionHttp(executions, authorize, identity,
    `executions/${activityId}/agent/${commandId}/claim`, { browserId }), { claimed: true });
  assert.deepEqual(checked, [[identity, activityId, association]]);
  assert.equal(writes, 1);
  const legacy = { assertCommandDispatch() { writes += 100; } };
  await assert.rejects(routeExecutionHttp(executions, legacy, identity,
    `executions/${activityId}/agent/${commandId}/claim`, { browserId }), { code: 'incompatible' });
  assert.equal(writes, 1);
});
