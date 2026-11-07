import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { ALU_REFLECTION_MEDIA_TYPE, aluReflectionName } from '@xunjie/contracts/alu-learning';
import { aluReferenceFixture } from '../../../packages/contracts/test/fixtures/alu-reference.mjs';
import { validateAluReflectionFiles } from '../../../packages/learning-space/dist/learning-data/alu-reflections.js';
import { aluCoursePackage } from '../../../components/alu-experiment/package.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(),
    kind: 'school', name: 'ALU student' };
  const course = await aluCoursePackage();
  const activity = activitySchema.parse({ activityId: randomUUID(), identity, target: { ...owner, version: 1 },
    goal: 'Explain an ALU observation', question: '', references: [], status: 'open', createdAt: new Date().toISOString(),
    course: { associationId: randomUUID(), courseId: course.course.courseId, courseName: course.course.name,
      taskId: course.task.taskId, taskTitle: course.task.title, ...course.release, materials: [], contentDigest: 'a'.repeat(64) } });
  const commands = new Map(), retained = new Map();
  function receive() {
    const { action } = aluReferenceFixture({ identity, activityId: activity.activityId, binding: course.release.components[0] });
    const inputDigest = hash(JSON.stringify(action)), executionRef = randomUUID();
    commands.set(action.requestId, { request_id: action.requestId, activity_id: activity.activityId,
      input_digest: inputDigest, execution_ref: executionRef, body: action, action_text: JSON.stringify(action),
      acceptance: { receipt: { requestId: action.requestId, inputDigest, receiver: action.receiver,
        state: 'accepted', receiptId: 'browser:' + action.requestId, detail: 'Fixed action received' },
        execution: { executionRef, acceptedSeq: 1 } },
      state: 'queued', status_knowledge: 'confirmed', stop_requested: false, confirmed_seq: 1, reason: null, output: null });
    return { action, inputDigest, executionRef };
  }
  const source = receive();
  function reflection(parentNoteId = null, original = source, noteId = randomUUID()) {
    const instance = original.action.execution.instance;
    const note = { formatVersion: 1, kind: 'alu-reflection', noteId, activityId: activity.activityId,
      bindingKey: instance.key, instanceId: instance.instanceId, definitionDigest: instance.definitionDigest,
      requestId: original.action.requestId, inputDigest: original.inputDigest, executionRef: original.executionRef,
      parentNoteId, text: 'My explanation revision.' };
    return { objectId: noteId, contentId: noteId, name: aluReflectionName(instance.key, noteId),
      kind: 'state', encoding: 'json', mediaType: ALU_REFLECTION_MEDIA_TYPE, value: JSON.stringify(note) };
  }
  const contentRow = file => ({ activity_id: activity.activityId, object_activity_id: activity.activityId,
    object_id: file.objectId, content_id: file.contentId, encoding: file.encoding, media_type: file.mediaType, kind: file.kind });
  // Read-only owner boundary: control whether a legitimate parent has arrived via the independent
  // work channel. Command parsing, identity checks and chain validation use the production code.
  const storage = { owner, async read(sql, args) {
    let rows;
    if (sql.includes('FROM execution_commands')) rows = [commands.get(args[0])].filter(Boolean);
    else if (sql.includes('FROM activities')) rows = [{ id: activity.activityId, body: activity,
      space_environment_id: identity.environmentId, space_id: identity.spaceId, principal_id: identity.principalId }];
    else if (sql.includes('FROM work_contents')) {
      rows = [...retained.values()].filter(file => sql.includes('ANY($1') ? args[0].includes(file.objectId)
        : sql.includes('WHERE object_id=$1') ? file.objectId === args[0] : file.contentId === args[0]).map(contentRow);
    } else throw new Error('Unexpected owner read: ' + sql);
    return { rows };
  }, async resource(id) {
    const file = retained.get(id);
    assert.ok(file);
    return { resourceId: id, owner, scope: `works/${activity.activityId}/${file.objectId}`,
      mediaType: file.mediaType, contentVersion: 1 };
  }, async readResource(id) {
    return Buffer.from(retained.get(id).value, 'utf8');
  } };
  return { activity, storage, reflection, receive, retain: file => retained.set(file.contentId, file) };
}

test('a reflection reference waits for its parent work sync and retries the unchanged basis', async () => {
  const env = await fixture();
  const parent = env.reflection(), child = env.reflection(parent.objectId);
  const original = structuredClone(child);
  // Both notes are legitimate local work; the draft channel submits only the selected child.
  await validateAluReflectionFiles(env.storage, env.activity, [child, parent]);
  await assert.rejects(validateAluReflectionFiles(env.storage, env.activity, [child]), { code: 'unavailable' });
  env.retain(parent);
  await validateAluReflectionFiles(env.storage, env.activity, [child]);
  assert.deepEqual(child, original);
});

test('waiting for a missing parent does not admit cycles or a different original execution', async () => {
  const env = await fixture();
  const firstId = randomUUID(), secondId = randomUUID();
  await assert.rejects(validateAluReflectionFiles(env.storage, env.activity,
    [env.reflection(secondId, undefined, firstId), env.reflection(firstId, undefined, secondId)]), { code: 'invalid' });
  const unrelated = env.reflection(null, env.receive());
  env.retain(unrelated);
  await assert.rejects(validateAluReflectionFiles(env.storage, env.activity, [env.reflection(unrelated.objectId)]),
    { code: 'invalid' });
});
