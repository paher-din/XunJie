import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StorageError } from '@xunjie/storage';
import {
  collectLearningSources, validateLearningSources,
  collectTeachingSources, validateTeachingSources,
  validateTeachingSkillLoads, sourceClosureCounts, ownerSourceClosureSchema,
} from '@xunjie/learning-space';
import { personalMaterialResourceId } from '../../../packages/learning-space/dist/learning-data/personal-materials.js';
import { parseTeachingSkillPackage } from '../../../packages/learning-space/dist/teaching-agent/skills-package.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = () => randomUUID();

function makeStorage(tables, resources = {}) {
  const owner = { environmentId: uuid(), serviceId: uuid() };
  const has = name => Object.prototype.hasOwnProperty.call(tables, name);
  return {
    owner,
    async read(sql, params = []) {
      if (/to_regclass/.test(sql)) {
        const name = params[0];
        return { rows: [{ relation: has(name) ? name : null }] };
      }
      if (/FROM teaching_skill_versions/.test(sql)) {
        const [ownerKey, skillId, version] = params;
        const rows = (tables.teaching_skill_versions ?? []).filter(row =>
          row.owner_key === ownerKey && String(row.skill_id) === String(skillId) && Number(row.version) === Number(version));
        return { rows: rows.map(row => ({ body: row.body })) };
      }
      const match = /FROM\s+([a-z_]+)/.exec(sql);
      if (match) return { rows: (tables[match[1]] ?? []).map(row => ({ ...row })) };
      return { rows: [] };
    },
    async readResource(resourceId) {
      if (Object.prototype.hasOwnProperty.call(resources, resourceId)) return resources[resourceId];
      throw new StorageError('missing');
    },
    async resource(resourceId) {
      const bytes = resources[resourceId] ?? new Uint8Array();
      return { resourceId, sha256: sha(bytes), byteLength: bytes.byteLength };
    },
  };
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    for (const key of ['kind', 'owner', 'fixedId', 'version']) {
      if (a[key] < b[key]) return -1;
      if (a[key] > b[key]) return 1;
    }
    return 0;
  });
}

function learningFixture() {
  const env = uuid(), space = uuid(), principal = uuid(), activityId = uuid();
  const tables = {
    activities: [
      { id: activityId, space_environment_id: env, space_id: space, principal_id: principal,
        body: { activityId, identity: { environmentId: env, spaceId: space, principalId: principal } } },
      { id: uuid(), space_environment_id: env, space_id: space, principal_id: principal,
        body: { activityId: uuid(), identity: { environmentId: env, spaceId: space, principalId: principal } } },
    ],
    personal_materials: [{ material_id: uuid(), activity_id: activityId, current_version: 1, request_id: uuid(), input_digest: 'd', removed_at: null }],
  };
  const materialId = tables.personal_materials[0].material_id, version = 1;
  const materialBytes = Buffer.from('学生原始笔记内容');
  const materialResource = personalMaterialResourceId(materialId, version);
  tables.personal_material_versions = [{ material_id: materialId, version, request_id: uuid(), input_digest: 'd',
    name: '笔记.md', media_type: 'text/markdown', sha256: sha(materialBytes), byte_length: materialBytes.length }];
  const documentId = uuid(), documentBytes = Buffer.from('%PDF-1.7 fixed original');
  tables.pdf_documents = [{ document_id: documentId, activity_id: activityId, request_id: uuid(), input_digest: 'd',
    body: { documentId, sha256: sha(documentBytes), byteLength: documentBytes.length } }];
  const readingId = uuid(), readingBytes = Buffer.from(JSON.stringify({ pages: [] }));
  tables.pdf_readings = [{ reading_id: readingId, activity_id: activityId, document_id: documentId, input_digest: 'd',
    body: { readingId, pages: [
      { page: 1, text: '第一页串联电路', image: { sha256: sha('png'), byteLength: 8 } },
      { page: 2, text: '第二页并联电路' },
    ] } }];
  const requestId = uuid(), inputDigest = 'a'.repeat(64), executionRef = uuid();
  tables.execution_commands = [{ request_id: requestId, activity_id: activityId, input_digest: inputDigest,
    execution_ref: executionRef, state: 'queued', status_knowledge: 'confirmed', confirmed_seq: 1, body: { text: 'x' } }];
  tables.action_intents = [{ request_id: uuid(), activity_id: activityId, input_digest: 'b'.repeat(64),
    state: 'prepared', body: { text: 'y' } }];
  const resources = {
    [materialResource]: materialBytes,
    [documentId]: documentBytes,
    [readingId]: readingBytes,
  };
  return { tables, resources, requestId, inputDigest, executionRef, materialResource, documentId };
}

function teachingFixture() {
  const activityId = uuid(), runId = uuid();
  const snapshotResource = uuid(), snapshotBytes = Buffer.from('{"snapshot":1}');
  const eventResource = uuid(), eventBytes = Buffer.from('{"outcome":"ok"}');
  const commandResource = uuid(), commandBytes = Buffer.from('{"result":"fixed"}');
  const tables = {
    teaching_sessions: [{ activity_id: activityId, next_seq: 3 }],
    teaching_requests: [{ request_id: uuid(), activity_id: activityId, input_digest: 'c'.repeat(64), state: 'accepted', body: {} }],
    teaching_runs: [{ run_id: runId, activity_id: activityId, request_id: uuid(), state: 'completed', generation: 1 }],
    teaching_snapshots: [{ snapshot_id: uuid(), activity_id: activityId, run_id: runId, resource_id: snapshotResource, body: { a: 1 } }],
    teaching_events: [{ activity_id: activityId, seq: 1, event_id: uuid(), event_version: 1,
      kind: 'tool-result', body: { commandId: uuid(), resourceId: eventResource, outcome: { state: 'completed' } } }],
    teaching_commands: [{ command_id: uuid(), run_id: runId, state: 'settled', resource_id: commandResource,
      outcome: { state: 'completed', result: { resourceId: eventResource } } }],
    teaching_steps: [{ step_id: uuid(), run_id: runId, step_no: 1, phase: 'completed' }],
    teaching_waits: [{ wait_id: uuid(), run_id: runId, purpose: 'result', state: 'consumed' }],
    teaching_budgets: [{ run_id: runId, max_model_steps: 16 }],
  };
  const resources = {
    [snapshotResource]: snapshotBytes,
    [eventResource]: eventBytes,
    [commandResource]: commandBytes,
  };
  return { tables, resources, snapshotResource, snapshotBytes, eventResource, eventBytes, commandResource, commandBytes };
}

function assertClosureShape(closure) {
  assert.deepEqual(Object.keys(closure).sort(), ['entries', 'formatVersion', 'kind', 'owner']);
  assert.equal(ownerSourceClosureSchema.safeParse(closure).success, true);
  assert.equal(closure.formatVersion, 1);
  assert.equal(closure.kind, 'xunjie.owner-sources/1');
  assert.deepEqual(closure, JSON.parse(JSON.stringify(closure)), 'entries must be plain JSON');
  assert.deepEqual(closure.entries, sortEntries(closure.entries), 'entries must be deterministically sorted');
}

test('learning source closure is deterministic, sorted and schema-valid with per-kind counts', async () => {
  const f = learningFixture();
  const storage = makeStorage(f.tables, f.resources);
  const closure = await collectLearningSources(storage);
  assertClosureShape(closure);
  assert.deepEqual(await collectLearningSources(storage), closure, 'collection is deterministic');
  const counts = sourceClosureCounts(closure);
  assert.equal(counts.activities, 2);
  assert.equal(counts.personal_material_versions, 1);
  assert.equal(counts.pdf_documents, 1);
  assert.equal(counts.pdf_readings, 1);
  assert.equal(counts.execution_commands, 1);
  assert.equal(counts.action_intents, 1);

  const command = closure.entries.find(entry => entry.kind === 'execution_commands');
  assert.ok(command.version.includes(f.requestId));
  assert.ok(command.version.includes(f.inputDigest));
  assert.ok(command.version.includes(f.executionRef));

  const versionEntry = closure.entries.find(entry => entry.kind === 'personal_material_versions');
  assert.deepEqual(versionEntry.resources, [{ resourceId: f.materialResource,
    sha256: sha(f.resources[f.materialResource]), byteLength: f.resources[f.materialResource].byteLength }]);
  const reading = closure.entries.find(entry => entry.kind === 'pdf_readings');
  assert.ok(reading.resources.some(resource => resource.resourceId.endsWith(':page:0:text')));
  assert.ok(reading.resources.some(resource => resource.resourceId.endsWith(':page:0:image')));

  await validateLearningSources(storage, closure);
});

test('teaching source closure is deterministic, sorted and reads resource bytes', async () => {
  const f = teachingFixture();
  const storage = makeStorage(f.tables, f.resources);
  const closure = await collectTeachingSources(storage);
  assertClosureShape(closure);
  assert.deepEqual(await collectTeachingSources(storage), closure, 'collection is deterministic');
  const counts = sourceClosureCounts(closure);
  assert.equal(counts.teaching_snapshots, 1);
  assert.equal(counts.teaching_events, 1);
  assert.equal(counts.teaching_commands, 1);
  assert.equal(counts.teaching_sessions, 1);

  const snapshot = closure.entries.find(entry => entry.kind === 'teaching_snapshots');
  assert.deepEqual(snapshot.resources, [{ resourceId: f.snapshotResource,
    sha256: sha(f.snapshotBytes), byteLength: f.snapshotBytes.byteLength }]);
  const event = closure.entries.find(entry => entry.kind === 'teaching_events');
  assert.ok(event.resources.some(resource => resource.resourceId === f.eventResource), 'tool-result body.resourceId is retained');
  const command = closure.entries.find(entry => entry.kind === 'teaching_commands');
  const commandResourceIds = command.resources.map(resource => resource.resourceId);
  assert.ok(commandResourceIds.includes(f.commandResource));
  assert.ok(commandResourceIds.includes(f.eventResource), 'outcome resource reference is retained');

  await validateTeachingSources(storage, closure);
});

test('validateLearningSources rejects a tampered digest, a removed resource and a missing original', async () => {
  const f = learningFixture();
  const storage = makeStorage(f.tables, f.resources);
  const closure = await collectLearningSources(storage);

  const flipped = structuredClone(closure);
  flipped.entries[0].digest = '0'.repeat(64);
  await assert.rejects(validateLearningSources(storage, flipped), { code: 'corrupt' });

  const dropped = structuredClone(closure);
  const versionEntry = dropped.entries.find(entry => entry.kind === 'personal_material_versions');
  versionEntry.resources = [];
  await assert.rejects(validateLearningSources(storage, dropped), { code: 'corrupt' });

  const mutable = { ...f.resources };
  const stolenStorage = makeStorage(f.tables, mutable);
  delete mutable[f.documentId];
  await assert.rejects(validateLearningSources(stolenStorage, closure), { code: 'corrupt' });
  await assert.rejects(collectLearningSources(stolenStorage), { code: 'corrupt' },
    'a backup whose original is already gone cannot be confirmed');
});

test('validateTeachingSources rejects a tampered digest and a removed resource', async () => {
  const f = teachingFixture();
  const storage = makeStorage(f.tables, f.resources);
  const closure = await collectTeachingSources(storage);

  const flipped = structuredClone(closure);
  flipped.entries[0].digest = '1'.repeat(64);
  await assert.rejects(validateTeachingSources(storage, flipped), { code: 'corrupt' });

  const dropped = structuredClone(closure);
  const snapshot = dropped.entries.find(entry => entry.kind === 'teaching_snapshots');
  snapshot.resources = [];
  await assert.rejects(validateTeachingSources(storage, dropped), { code: 'corrupt' });
});

function skillFixture() {
  const skillId = uuid(), version = 1, ownerKey = `${uuid()}/${uuid()}/${uuid()}`;
  const content = '---\nname: circuit-helper\ndescription: Helps with circuit analysis\n---\n\n# Circuit\nUse the node voltage method.\n';
  const parsed = parseTeachingSkillPackage({ requestId: skillId, source: 'personal', packageVersion: '1.0.0',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content }] });
  const fixed = { ...parsed, skillId, version };
  const bytes = Buffer.from(content, 'utf8');
  const loaded = {
    skillId, version, source: fixed.source, packageVersion: fixed.packageVersion,
    packageDigest: fixed.digest, path: 'SKILL.md', encoding: 'utf8',
    mediaType: fixed.attachments.find(item => item.path === 'SKILL.md').mediaType,
    byteLength: bytes.length, digest: sha(bytes), originalDigest: sha(bytes),
    content, offset: 0, totalByteLength: bytes.length, complete: true,
  };
  const tables = {
    teaching_skill_loads: [{ command_id: uuid(), owner_key: ownerKey, activity_id: uuid(),
      run_id: uuid(), step_id: uuid(), fingerprint: 'f', body: loaded }],
    teaching_skill_versions: [{ owner_key: ownerKey, skill_id: skillId, version, body: fixed }],
  };
  return { tables, loaded, ownerKey };
}

test('validateTeachingSkillLoads accepts a load that matches the original fixed package', async () => {
  const f = skillFixture();
  await validateTeachingSkillLoads(makeStorage(f.tables));
});

test('validateTeachingSkillLoads rejects a load whose bytes no longer match the fixed package', async () => {
  const f = skillFixture();
  const tampered = { ...f.loaded, content: f.loaded.content.replace('node voltage', 'XXXX voltage') };
  tampered.digest = sha(Buffer.from(tampered.content, 'utf8'));
  const tables = { ...f.tables, teaching_skill_loads: [{ ...f.tables.teaching_skill_loads[0], body: tampered }] };
  await assert.rejects(validateTeachingSkillLoads(makeStorage(tables)), { code: 'corrupt' });
});

test('validateTeachingSkillLoads skips gracefully when the loads table is absent (old schema)', async () => {
  await validateTeachingSkillLoads(makeStorage({}));
});

test('a load pointing at a fixed package with different bytes is rejected', async () => {
  const f = skillFixture();
  const otherContent = f.loaded.content.replace('node voltage', 'mesh current');
  const other = parseTeachingSkillPackage({ requestId: f.loaded.skillId, source: 'personal', packageVersion: '1.0.0',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content: otherContent }] });
  const tables = { ...f.tables, teaching_skill_versions: [{ owner_key: f.ownerKey,
    skill_id: f.loaded.skillId, version: 1, body: { ...other, skillId: f.loaded.skillId, version: 1 } }] };
  await assert.rejects(validateTeachingSkillLoads(makeStorage(tables)), { code: 'corrupt' });
});
