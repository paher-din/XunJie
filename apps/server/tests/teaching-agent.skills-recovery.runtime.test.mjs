import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { openProductRuntime, restoreProductRecovery } from '@xunjie/product-runtime';
import { collectTeachingBoundary, validateTeachingBoundary } from '@xunjie/learning-space';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const packageInput = (version, skillId) => ({ requestId: randomUUID(), ...(skillId ? { skillId } : {}),
  source: 'acceptance:217-maintenance', packageVersion: `${version}.0.0`, files: [
    { path: 'SKILL.md', encoding: 'utf8', content: `---\nname: recovery-diagnosis\ndescription: 固定恢复依据\n---\n恢复正文 V${version}。` },
    { path: 'references/checklist.txt', encoding: 'utf8', content: `固定附件 V${version}：保留原预测、原观察与原问题。` },
    { path: 'assets/observation.bin', encoding: 'base64', content: Buffer.from([0, 255, 17, version]).toString('base64') },
    { path: 'scripts/do-not-run.sh', encoding: 'utf8', content: 'exit 217' },
  ] });

test('Skills versions and actual attachment loads survive formal backup and isolated restore without model or tool replay',
  { timeout: 300000 }, async () => {
    let ref;
    const f = await fixture((_payload, response, index) => index === 1
      ? reply(response, { calls: [{ id: 'maintenance-217-original-read', name: 'skill_read',
        arguments: { ...ref, path: 'references/checklist.txt' } }] })
      : reply(response, { text: '根据固定附件解释，保留原预测与观察。' }));
    const directory = await mkdtemp(join(tmpdir(), 'xj-217-skills-maintenance-'));
    let target, restored;
    const report = { issue: 217, measuredAt: new Date().toISOString(), platform: process.platform,
      status: 'running', browser: 'not-run', teachingEffect: 'not-assessed', stages: [] };
    try {
      await f.configure(); const activity = await f.activity('217 Skills 真实备份恢复'), base = `agent/${activity.activityId}`;
      const original = packageInput(1), imported = await f.api('skills/import', original);
      ref = { skillId: imported.skillId, version: imported.version };
      await f.api('skills/select', { requestId: randomUUID(), range: { kind: 'all' }, skills: [ref] });
      const sent = await f.send(activity, '读取固定检查表，保留实际读取内容。');
      const before = await until(async () => {
        const value = await f.api(base + '/conversation'), run = value.runs.find(item => item.runId === sent.runId);
        if (run && ['failed', 'paused'].includes(run.state)) throw new Error('Skills run did not complete: ' + run.reason);
        return run?.state === 'completed' ? value : null;
      }, 'The production Skill read must finish before maintenance.', 60000);
      assert.equal(before.tools.length, 1); assert.equal(before.tools[0].name, 'skill_read');
      assert.equal(before.tools[0].outcome, 'completed');
      const loaded = before.tools[0].result.loaded;
      assert.equal(loaded.content, original.files[1].content); assert.equal(loaded.complete, true);
      assert.equal(loaded.digest, sha(original.files[1].content));
      assert.equal(f.payloads.length, 2);
      const events = await f.api(base + '/events');
      const snapshots = await Promise.all(events.filter(event => event.kind === 'context-assembled')
        .map(event => f.api(base + '/snapshots/' + event.body.snapshotId)));
      assert.equal(snapshots.length, 2);
      const fixedAttachment = snapshots[1].contextManifest.items.find(item => item.selection?.access === 'fixed-skill-content'
        && item.content.path === loaded.path);
      assert.deepEqual(fixedAttachment?.content, loaded, 'The progressive attachment is fixed in the actual step manifest and original tool outcome.');
      const summary = snapshots[1].resolvedAgent.skills.catalog.find(item => item.skillId === ref.skillId && item.version === ref.version)
        ?.attachments.find(item => item.path === loaded.path);
      assert.equal(summary?.digest, loaded.originalDigest); assert.equal(summary?.byteLength, loaded.totalByteLength);
      assert.equal(snapshots[1].segmentId, snapshots[0].segmentId, 'Reading a progressive attachment keeps the original native tool pairing.');
      const replacement = packageInput(2, ref.skillId);
      const updated = await f.api('skills/import', replacement); assert.equal(updated.version, 2);
      await f.api('skills/disable', { requestId: randomUUID(), skillId: ref.skillId, disabled: true });
      const settings = await f.api('skills');
      assert.equal(settings.skills[0].disabled, true); assert.deepEqual(settings.selections[0].skills, [ref]);
      const key = randomBytes(32); await f.runtime.setCredential('skills-217-backup', key.toString('base64'));
      const backup = await f.runtime.recovery.backup({ directory, recoveryKeyRef: 'skills-217-backup', leaveClosed: true });
      const boundary = backup.boundary.services.find(service => service.kind === 'xunjie.teaching-agent.boundary');
      assert.ok(boundary); assert.equal(boundary.unresolved, 0);
      restored = await restoreProductRecovery({ root: join(directory, 'target'), resources: f.resources,
        backupDirectory: join(directory, backup.backupId), key });
      const owner = restored.owners.find(item => item.participant.descriptor.serviceId === boundary.serviceId);
      const material = await owner.material({ backupId: backup.backupId, boundaryAt: backup.boundaryAt, signal: new AbortController().signal });
      assert.equal(material.evidence.formatVersion, 4);
      const counts = Object.fromEntries(['teaching_skills', 'teaching_skill_versions', 'teaching_skill_selections', 'teaching_skill_loads']
        .map(table => [table, material.evidence.tables[table].count]));
      for (const entry of Object.values(material.evidence.tables)) assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(counts, { teaching_skills: 1, teaching_skill_versions: 2, teaching_skill_selections: 1, teaching_skill_loads: 1 });
      report.stages.push({ name: 'real-owner-backup-restored-inventory', status: 'passed', counts,
        backupId: backup.backupId, serviceId: boundary.serviceId, formatVersion: material.evidence.formatVersion,
        tableDigests: Object.fromEntries(Object.keys(counts).map(table => [table, material.evidence.tables[table].sha256])) });
      for (const entry of restored.owners) await entry.close?.(); restored = undefined;
      target = openProductRuntime({ root: join(directory, 'target'), resources: f.resources });
      const state = await target.start(); assert.equal(state.state, 'maintenance');
      const read = async route => {
        const response = await fetch(state.endpoint + '/api/learning/' + route, { headers: { 'x-xj-space': 'personal' } });
        assert.equal(response.status, 200, route); return response.json();
      };
      const beforeTransport = f.payloads.length;
      const after = await read(base + '/conversation');
      assert.deepEqual(after, before); assert.deepEqual(await read(base + '/events'), events);
      assert.deepEqual(await read('skills'), settings);
      for (const snapshot of snapshots) assert.deepEqual(await read(base + '/snapshots/' + snapshot.snapshotId), snapshot);
      assert.equal(f.payloads.length, beforeTransport, 'Isolated restore and history must be pure reads.');
      const denied = await fetch(state.endpoint + '/api/learning/skills/import', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' }, body: JSON.stringify(packageInput(3, ref.skillId)) });
      assert.equal(denied.status, 503, 'An isolated maintenance target cannot accept fresh Skills writes.');
      await target.stop(); const restarted = await target.start(); assert.equal(restarted.state, 'maintenance');
      assert.deepEqual(await read(base + '/conversation'), before);
      for (const snapshot of snapshots) assert.deepEqual(await read(base + '/snapshots/' + snapshot.snapshotId), snapshot);
      assert.equal(f.payloads.length, beforeTransport); assert.deepEqual(f.failures, []);
      report.stages.push({ name: 'isolated-restore-and-restart-are-pure-read', status: 'passed',
        newModelRequests: f.payloads.length - beforeTransport, newToolRecords: after.tools.length - before.tools.length,
        historySnapshots: snapshots.length, versionValidation: 'production restore validator and public owner inventory', publicAttachmentDigestVerified: true, maintenanceWriteStatus: denied.status, originalAttachmentSha256: loaded.digest });
      report.status = 'passed';
    } catch (error) { report.status = 'failed'; report.failure = { name: error.name, code: error.code ?? 'assertion-or-runtime' }; throw error; }
    finally {
      for (const owner of restored?.owners ?? []) await owner.close?.();
      await target?.stop(); await f.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      if (process.env.XUNJIE_SKILLS_EVIDENCE_DIR) {
        const evidence = resolve(process.env.XUNJIE_SKILLS_EVIDENCE_DIR); await mkdir(evidence, { recursive: true });
        report.finishedAt = new Date().toISOString(); report.cleanup = 'temporary runtimes and backup removed';
        await writeFile(join(evidence, 'maintenance-runtime.json'), JSON.stringify(report, null, 2) + '\n');
      }
    }
  });


test('maintenance accepts the published v1 empty-Skills inventory but refuses to hide new Skills facts behind it',
  { timeout: 180000 }, async () => {
    const f = await fixture();
    try {
      const activity = await f.activity('217 旧维护清单兼容'), owner = await f.controlled(activity);
      const current = await collectTeachingBoundary(owner.storage);
      assert.equal(current.evidence.formatVersion, 4);
      const legacy = structuredClone(current); legacy.evidence.formatVersion = 1;
      for (const table of ['teaching_skills', 'teaching_skill_versions', 'teaching_skill_selections', 'teaching_skill_loads',
        'teaching_student_facts']) {
        assert.equal(legacy.evidence.tables[table].count, 0); delete legacy.evidence.tables[table];
      }
      assert.equal(legacy.evidence.tables.teaching_compactions.count, 0);
      delete legacy.evidence.tables.teaching_compactions;
      await validateTeachingBoundary(owner.storage, legacy);
      await owner.agent.skills.import(owner.identity, packageInput(1));
      await assert.rejects(validateTeachingBoundary(owner.storage, legacy), error => error.code === 'corrupt');
      await validateTeachingBoundary(owner.storage, await collectTeachingBoundary(owner.storage));
      assert.equal(f.payloads.length, 0);
    } finally { await f.close(); }
  });
