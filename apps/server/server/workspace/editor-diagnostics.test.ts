import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { fixture, assigned, opened, files, view, command, syntheticProfile } from './test-support.ts';
import type { RunnerTransport } from '../records/runner.ts';

test('editor diagnostics authorize transient drafts without changing works/records; revoke and reject stale results', async () => {
  let calls = 0, release: (() => void) | undefined, arrive: (() => void) | undefined;
  const transport: RunnerTransport = async request => {
    if (request.op === 'readiness') {
      const fingerprint = { profile: syntheticProfile, sourceHash: 'd'.repeat(64) };
      return { data: { ready: true, ...syntheticProfile, recoveryGeneration: 'generation', fingerprint,
        validation: { passed: true, fingerprintHash: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'), validatedAt: new Date().toISOString() } } };
    }
    if (request.op !== 'editor_diagnostics') throw new Error('No execution is permitted');
    calls++;
    const source = request.packet.snapshot.files.find(file => file.fileId === request.packet.fileId)!;
    assert.equal(source.text, 'int value = ;\n');
    if (arrive) { arrive(); await new Promise<void>(resolve => { release = resolve }); }
    return { data: { status: 'ready', sourceHash: request.packet.snapshot.hash, provider: 'gcc',
      diagnostics: [{ fileId: source.fileId, path: source.path, contentHash: source.contentHash,
        severity: 'error', message: 'expected expression', line: 1,
        range: { startLine: 1, startColumn: 13, endLine: 1, endColumn: 14 } }] } };
  };
  const f = await fixture(transport);
  try {
    const teacher = await f.login('teacher'), student = await f.login(), other = await f.login('other');
    const allocation = await assigned(f, teacher), id = await opened(f, student, allocation.assignmentId);
    const ids = await files(f, student, id), before = await view(f, student, id);
    const body = { workspaceRevision: before.attempt.workspaceRevision, captureRevision: before.attempt.captureRevision, fileId: ids.source,
      files: before.files.map((file: { fileId: string; documentVersion: number; contentHash: string; text: string }) => ({
        fileId: file.fileId, documentVersion: file.documentVersion, contentHash: file.contentHash,
        text: file.fileId === ids.source ? 'int value = ;\n' : file.text })) };
    const url = `/api/attempts/${id}/editor-diagnostics`;
    const counts = () => f.db.withTransaction(tx => ['jobs', 'command_receipts', 'workspace_process_records', 'artifact_snapshots'].map(table => tx.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n));
    const previousCounts = counts(), result = await command(f, student, url, body);
    assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().data.status, 'ready');
    assert.deepEqual((await view(f, student, id)).files, before.files); assert.deepEqual(counts(), previousCounts);
    assert.equal((await command(f, other, url, body)).statusCode, 403);
    assert.equal((await command(f, teacher, url, body)).statusCode, 403);
    assert.equal((await command(f, student, url, { ...body, workspaceRevision: 0 })).json().data.status, 'stale');
    assert.equal((await command(f, student, url, { ...body, files: body.files.slice(0, 1) })).statusCode, 422);
    assert.equal(calls, 1);
    const arrived = new Promise<void>(resolve => { arrive = resolve });
    const pending = command(f, student, url, body).then(value => value);
    await arrived;
    assert.equal((await command(f, student, url, body)).json().data.status, 'busy');
    const paused = await command(f, student, `/api/attempts/${id}/controls`, {
      expectedAttemptRevision: before.attempt.attemptRevision, control: { kind: 'capture', value: false } });
    assert.equal(paused.statusCode, 200, paused.body); release!();
    const late = await pending; assert.equal(late.json().data.status, 'paused'); assert.deepEqual(late.json().data.diagnostics, []);
    const noCheck = await command(f, student, url, body);
    assert.equal(noCheck.json().data.status, 'paused'); assert.equal(calls, 2);
  } finally { release?.(); await f.close(); }
});
