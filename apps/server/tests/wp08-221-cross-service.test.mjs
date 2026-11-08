import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createTeachingDependencyClient, createTeachingDependencyService,
  createTeachingAgentClient, createTeachingAgentService,
} from '@xunjie/learning-space';

const digest = 'a'.repeat(64);
const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(),
  kind: 'personal', name: 'Student' };
const activityId = randomUUID();
const activity = { activityId, identity,
  target: { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 },
  goal: '理解固定来源', question: '为什么原依据不能重算？', references: [], status: 'open',
  createdAt: new Date().toISOString() };
const input = { requestId: randomUUID(), scope: { environmentId: identity.environmentId, spaceId: identity.spaceId,
  principalId: identity.principalId, activityId }, receiver: { receiverId: 'teaching-agent:svc', location: 'remote', kind: 'question' },
  draft: { token: 'draft-token', question: '请核对来源', references: [], bases: [] }, works: [], evidence: [] };
const skillId = randomUUID();
const skillState = {
  catalog: [{ skillId, version: 2, name: 'alu-diagnosis', description: 'Fixed course guidance', source: 'course:alu',
    packageVersion: '2', digest, metadata: { name: 'alu-diagnosis', description: 'Fixed course guidance',
      dependencies: [], conflicts: [], 'allowed-tools': [] },
    attachments: [{ path: 'references/lab.txt', encoding: 'utf8', mediaType: 'text/plain', byteLength: 18, digest }],
    origin: 'course', selected: true, disabled: false, required: false }],
  loaded: [{ skillId, version: 2, source: 'course:alu', packageVersion: '2', packageDigest: digest,
    path: 'SKILL.md', encoding: 'utf8', mediaType: 'text/markdown', byteLength: 12, digest, originalDigest: digest,
    content: 'fixed skill', offset: 0, totalByteLength: 12, complete: true }],
};
const scope = { identity, activity, input, runId: randomUUID(), stepId: randomUUID(), snapshotId: randomUUID(), skillState };

function dependencyService(tools) {
  return createTeachingDependencyService({ authorize: async () => {}, identityFor: async () => identity,
    activity: async () => activity, models: {}, tools });
}
function dependencyClient(service) {
  return createTeachingDependencyClient(async value => service(value));
}
function toolHost(record) {
  return { definitions: async value => { record.push(value); return []; }, contributions: async () => [],
    prepare: async () => { throw new Error('not used'); }, dispatch: async () => { throw new Error('not used'); },
    reconcile: async () => null, stop: async () => null };
}

test('the public dependency wire carries the schema-validated fixed skillState to the material owner', async () => {
  const observed = [];
  const client = dependencyClient(dependencyService(toolHost(observed)));
  await client.tools.definitions(scope);
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].skillState, skillState, 'the original step selection must survive the cross-service hop');
  assert.equal(observed[0].assertDispatch, undefined, 'local guard functions are never transported');
  assert.deepEqual(observed[0].identity, identity);
  assert.equal(observed[0].activity.activityId, activityId);
});

test('a forged or malformed fixed skillState is rejected at the public wire boundary', async () => {
  const observed = [];
  const client = dependencyClient(dependencyService(toolHost(observed)));
  await assert.rejects(client.tools.definitions({ ...scope, skillState: { ...skillState, catalog: 'forged' } }));
  await assert.rejects(client.tools.definitions({ ...scope, forgedGuard: () => {} }));
  assert.equal(observed.length, 0, 'no material read happens for an invalid scope');
});

const factsResult = { facts: [], activity: { activityId, goal: activity.goal, courseId: null },
  continuation: { state: 'same-activity', detail: '仅本活动明确表达的偏好' }, unknown: [] };
const loaded = skillState.loaded[0];

function agentService(factsRead, skillsRead) {
  const agent = { skills: { read: skillsRead }, studentFacts: { read: factsRead } };
  return createTeachingAgentService(agent, async () => {});
}
function agentClient(service) {
  return createTeachingAgentClient(randomUUID(), identity, activityId, async value => service(value));
}

test('the Agent RPC exposes a typed explicit-preference read with its original identity', async () => {
  const observed = [];
  const service = agentService(async (...args) => { observed.push(args); return factsResult; }, async () => loaded);
  const client = agentClient(service);
  const result = await client.studentFacts.read(identity, activityId, { scope: 'eligible' });
  assert.deepEqual(result, factsResult);
  assert.deepEqual(observed[0][0], identity);
  assert.equal(observed[0][1], activityId);
  assert.deepEqual(observed[0][2], { scope: 'eligible' });
  await assert.rejects(client.studentFacts.read(identity, activityId, { scope: 'forged-scope' }));
});

test('the Agent RPC reads a Skill attachment under the original step selection', async () => {
  const observed = [];
  const references = [{ skillId, version: 2 }];
  const service = agentService(async () => factsResult,
    async (...args) => { observed.push(args); return loaded; });
  const client = agentClient(service);
  const result = await client.skills.read(identity, activityId, skillId, 2, 'references/lab.txt', { references });
  assert.deepEqual(result, loaded);
  assert.deepEqual(observed[0][5], { references }, 'the owner re-checks current eligibility against the original selection');
  await assert.rejects(client.skills.read(identity, activityId, skillId, 2, 'references/lab.txt',
    { references: [references[0], references[0]] }), /Duplicate skill selection/);
});
