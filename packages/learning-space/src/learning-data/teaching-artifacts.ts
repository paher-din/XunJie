import { createHash, randomUUID } from 'node:crypto';
import { canonicalDigest } from '../teaching-agent/identity.js';
import { Script } from 'node:vm';
import { z } from 'zod';
import { StorageError, type OwnedStorage, type OwnedTransaction, type Migration } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { workViewSchema } from '@xunjie/contracts/learning-data';
import type { WorkFile, LearningActivity } from '@xunjie/contracts/learning-data';
import { componentBindingSchema, acceptsState, componentStateSchema, componentStateName, componentStateMediaType, componentInstanceId, matchesComponentState, type StateShape } from '@xunjie/contracts/components';
import { teachingArtifactPublishSchema, teachingArtifactRevisionSchema, teachingArtifactCandidateSchema, teachingArtifactSchema,
  teachingArtifactReceiptSchema, teachingArtifactCheckSchema, teachingArtifactAdoptSchema, teachingArtifactShelfSchema, teachingArtifactOriginSchema, type TeachingArtifactOrigin, type TeachingArtifactPublish,
  type TeachingArtifactRevision, type TeachingArtifactCandidate, type TeachingArtifactReceipt } from '@xunjie/contracts/teaching-artifacts';

export const teachingArtifactMigration: Migration = { version: 25, name: 'activity-teaching-artifacts', sql: `
  CREATE TABLE teaching_artifacts(artifact_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),body jsonb NOT NULL);
  CREATE INDEX teaching_artifacts_activity ON teaching_artifacts(activity_id);
  CREATE TABLE teaching_artifact_revisions(revision_id uuid PRIMARY KEY,artifact_id uuid NOT NULL REFERENCES teaching_artifacts(artifact_id),
    version integer NOT NULL,resource_id uuid NOT NULL,body jsonb NOT NULL,UNIQUE(artifact_id,version));
  CREATE TABLE teaching_artifact_candidates(candidate_id uuid PRIMARY KEY,artifact_id uuid NOT NULL REFERENCES teaching_artifacts(artifact_id),
    revision_id uuid NOT NULL REFERENCES teaching_artifact_revisions(revision_id),body jsonb NOT NULL);
  CREATE TABLE teaching_artifact_checks(request_id uuid PRIMARY KEY,candidate_id uuid NOT NULL REFERENCES teaching_artifact_candidates(candidate_id),
    activity_id uuid NOT NULL REFERENCES activities(id),body jsonb NOT NULL);
  CREATE TABLE teaching_artifact_receipts(request_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),body jsonb NOT NULL);
` };
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const fingerprint = canonicalDigest;
export type TrustedArtifactPublish = { origin: TeachingArtifactOrigin; assertDispatch(): Promise<void> };
export type ArtifactAdoptionGuard = (identity: SpaceIdentity, activityId: string, origin: TeachingArtifactOrigin,
  candidate: Pick<TeachingArtifactCandidate, 'artifactId' | 'revisionId' | 'candidateId'>) => Promise<void>;
export const artifactKey = (artifactId: string) => `artifact-${artifactId}`;
function render(payload: TeachingArtifactRevision['payload']) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${payload.css.replace(/<\/style/gi, '<\\/style')}</style></head><body>${payload.html}<script>${payload.javascript.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
function checks(payload: TeachingArtifactRevision['payload'], activity: LearningActivity): TeachingArtifactCandidate['checks'] {
  let syntax = true;
  try { new Script(payload.javascript); } catch { syntax = false; }
  const external = /<(?:script|iframe|object|embed|link|base)\b|\s(?:src|srcset|action|formaction)\s*=|\son[a-z]+\s*=/i.test(payload.html)
    || /@import|url\s*\(/i.test(payload.css);
  const execution = !payload.requiredCapabilities.includes('execution.submit') || !!activity.course?.components?.some(b => b.definition.manifest.requiredCapabilities.includes('execution.submit' as never));
  return [{ code: 'script-syntax', passed: syntax, reason: syntax ? '' : 'JavaScript syntax is invalid' },
    { code: 'fixed-resources', passed: !external, reason: external ? 'External or executable HTML resources are not declared' : '' },
    { code: 'capability-scope', passed: execution, reason: execution ? '' : 'No course execution capability is available' },
    { code: 'browser-roundtrip', passed: false, reason: 'Awaiting isolated browser load and state roundtrip' }];
}
export function createTeachingArtifacts(storage: OwnedStorage,
  open: (identity: SpaceIdentity, activityId: string) => Promise<LearningActivity>, assertAdoption?: ArtifactAdoptionGuard) {
  async function writable(identity: SpaceIdentity, activityId: string) {
    const activity = await open(identity, activityId);
    if (activity.status !== 'open') throw new StorageError('forbidden');
    return activity;
  }
  async function guardActivity(tx: OwnedTransaction, activityId: string) {
    const { rows: [row] } = await tx.query('SELECT body FROM activities WHERE id=$1 FOR SHARE', [activityId]);
    if (!row || (row.body as { status: string }).status !== 'open') throw new StorageError('forbidden');
  }
  async function read(identity: SpaceIdentity, activityId: string, artifactId: string) {
    await open(identity, activityId); z.uuid().parse(artifactId);
    const { rows: [row] } = await storage.read('SELECT body FROM teaching_artifacts WHERE artifact_id=$1 AND activity_id=$2', [artifactId, activityId]);
    if (!row) throw new StorageError('missing');
    return teachingArtifactSchema.parse(row.body);
  }
  async function list(identity: SpaceIdentity, activityId: string) {
    await open(identity, activityId);
    const { rows } = await storage.read('SELECT body FROM teaching_artifacts WHERE activity_id=$1 ORDER BY artifact_id', [activityId]);
    return rows.map(row => teachingArtifactSchema.parse(row.body));
  }
  async function revision(identity: SpaceIdentity, activityId: string, artifactId: string, revisionId: string) {
    await read(identity, activityId, artifactId); z.uuid().parse(revisionId);
    const { rows: [row] } = await storage.read('SELECT body FROM teaching_artifact_revisions WHERE artifact_id=$1 AND revision_id=$2', [artifactId, revisionId]);
    if (!row) throw new StorageError('missing');
    return teachingArtifactRevisionSchema.parse(row.body);
  }
  async function candidate(identity: SpaceIdentity, activityId: string, candidateId: string) {
    await open(identity, activityId); z.uuid().parse(candidateId);
    const { rows: [row] } = await storage.read(`SELECT c.body FROM teaching_artifact_candidates c JOIN teaching_artifacts a USING(artifact_id)
      WHERE c.candidate_id=$1 AND a.activity_id=$2`, [candidateId, activityId]);
    if (!row) throw new StorageError('missing');
    return teachingArtifactCandidateSchema.parse(row.body);
  }
  async function receipt(identity: SpaceIdentity, activityId: string, requestId: string): Promise<TeachingArtifactReceipt | null> {
    await open(identity, activityId); z.uuid().parse(requestId);
    const { rows: [row] } = await storage.read('SELECT body FROM teaching_artifact_receipts WHERE request_id=$1 AND activity_id=$2', [requestId, activityId]);
    return row ? teachingArtifactReceiptSchema.parse(row.body) : null;
  }
  async function checkReceipt(identity: SpaceIdentity, activityId: string, requestId: string): Promise<TeachingArtifactCandidate | null> {
    await open(identity, activityId); z.uuid().parse(requestId);
    const { rows: [row] } = await storage.read('SELECT body FROM teaching_artifact_checks WHERE request_id=$1 AND activity_id=$2', [requestId, activityId]);
    return row ? teachingArtifactCandidateSchema.parse((row.body as { result: unknown }).result) : null;
  }
  async function publish(identity: SpaceIdentity, activityId: string, value: TeachingArtifactPublish, trusted?: TrustedArtifactPublish) {
    const activity = await writable(identity, activityId), input = teachingArtifactPublishSchema.parse(value);
    const origin = trusted ? teachingArtifactOriginSchema.parse(trusted.origin) : null;
    const fp = fingerprint({ identity, activityId, input, origin });
    const previous = await storage.receipt(input.requestId, fp);
    if (previous) { const own = await receipt(identity, activityId, input.requestId); if (!own) throw new StorageError('identity-conflict'); return own; }
    await trusted?.assertDispatch();
    const artifactId = input.artifactId ?? randomUUID(), revisionId = randomUUID(), candidateId = randomUUID(), resourceId = randomUUID();
    if (input.artifactId) await revision(identity, activityId, artifactId, input.parentRevisionId!);
    const bytes = Buffer.from(render(input.payload)), sha256 = hash(bytes), createdAt = new Date().toISOString();
    const report = checks(input.payload, activity);
    await storage.stageResource({ uploadId: resourceId, scope: `artifacts/${activityId}/${artifactId}`, bytes, mediaType: 'text/html', contentVersion: 1 });
    const saved = await storage.request({ requestId: input.requestId, fingerprint: fp }, async tx => {
      await guardActivity(tx, activityId);
      await trusted?.assertDispatch();
      if (!input.artifactId) await tx.query('INSERT INTO teaching_artifacts VALUES($1,$2,$3)', [artifactId, activityId, JSON.stringify({
        artifactId, activityId, title: input.payload.title, display: input.payload.display, activeRevisionId: null, latestRevisionId: revisionId, latestCandidateId: candidateId,
        shelved: false, relatedArtifactId: null, createdAt })]);
      await tx.query('SELECT artifact_id FROM teaching_artifacts WHERE artifact_id=$1 FOR UPDATE', [artifactId]);
      const { rows: [last] } = await tx.query('SELECT COALESCE(MAX(version),0) AS version FROM teaching_artifact_revisions WHERE artifact_id=$1', [artifactId]);
      const version = Number(last!.version) + 1;
      const draftBinding = componentBindingSchema.parse({ key: artifactKey(artifactId), configuration: { title: input.payload.title }, materialIds: [],
        definition: { digest: fingerprint({ artifactId, revisionId, payload: input.payload }), manifest: {
          formatVersion: 1, componentId: artifactId, version, hostApiVersion: 1, title: input.payload.title,
          entry: { resourceId, sha256, byteLength: bytes.length, mediaType: 'text/html' }, stateVersion: input.payload.stateVersion,
          stateShape: input.payload.stateShape, initialState: input.payload.initialState,
          requiredCapabilities: input.payload.requiredCapabilities.filter(c => ['workspace.read', 'workspace.change'].includes(c)),
        } } });
      const binding = { ...draftBinding, definition: { ...draftBinding.definition, digest: hash(JSON.stringify(draftBinding.definition.manifest)) } };
      const fixed = teachingArtifactRevisionSchema.parse({ artifactId, activityId, revisionId, version, parentRevisionId: input.parentRevisionId ?? null,
        payload: input.payload, resourceId, sha256, byteLength: bytes.length, binding, origin, createdAt, mapping: input.mapping ?? [] });
      const status = report.some(c => !c.passed && c.code !== 'browser-roundtrip') ? 'check-failed' : 'candidate';
      const proposed = teachingArtifactCandidateSchema.parse({ candidateId, artifactId, revisionId, status, checks: report, createdAt });
      await tx.query('INSERT INTO teaching_artifact_revisions VALUES($1,$2,$3,$4,$5)', [revisionId, artifactId, version, resourceId, JSON.stringify(fixed)]);
      await tx.query('INSERT INTO teaching_artifact_candidates VALUES($1,$2,$3,$4)', [candidateId, artifactId, revisionId, JSON.stringify(proposed)]);
      await tx.query(`UPDATE teaching_artifacts SET body=jsonb_set(jsonb_set(body,'{latestRevisionId}',to_jsonb($2::text)),'{latestCandidateId}',to_jsonb($3::text)) WHERE artifact_id=$1`, [artifactId, revisionId, candidateId]);
      await tx.reference(`teaching-artifact/${revisionId}`, resourceId);
      const result = teachingArtifactReceiptSchema.parse({ requestId: input.requestId, artifactId, revisionId, candidateId, kind: 'publish', outcome: 'candidate',
        workRevision: null, contentId: null, relatedArtifactId: null, reason: status === 'check-failed' ? report.filter(c => !c.passed).map(c => c.reason).join('; ') : null });
      await tx.query('INSERT INTO teaching_artifact_receipts VALUES($1,$2,$3)', [input.requestId, activityId, JSON.stringify(result)]);
      return result;
    });
    return teachingArtifactReceiptSchema.parse(saved.result);
  }
  async function resource(identity: SpaceIdentity, activityId: string, artifactId: string, revisionId: string) {
    const fixed = await revision(identity, activityId, artifactId, revisionId), bytes = await storage.readResource(fixed.resourceId);
    if (hash(bytes) !== fixed.sha256 || bytes.length !== fixed.byteLength) throw new StorageError('corrupt');
    return { resourceId: fixed.resourceId, sha256: fixed.sha256, byteLength: fixed.byteLength, mediaType: 'text/html' as const, contentBase64: Buffer.from(bytes).toString('base64') };
  }
  async function check(identity: SpaceIdentity, activityId: string, value: unknown) {
    await writable(identity, activityId);
    const input = teachingArtifactCheckSchema.parse(value), proposed = await candidate(identity, activityId, input.candidateId);
    const fixed = await revision(identity, activityId, proposed.artifactId, proposed.revisionId);
    if (fixed.revisionId !== input.revisionId || fixed.sha256 !== input.resourceSha256) throw new StorageError('conflict');
    await resource(identity, activityId, proposed.artifactId, proposed.revisionId);
    const result = await storage.request({ requestId: input.requestId, fingerprint: fingerprint({ identity, activityId, input }) }, async tx => {
      await guardActivity(tx, activityId);
      const { rows: [row] } = await tx.query('SELECT body FROM teaching_artifact_candidates WHERE candidate_id=$1 FOR UPDATE', [input.candidateId]);
      const current = teachingArtifactCandidateSchema.parse(row!.body);
      if (current.status === 'adopted') throw new StorageError('conflict');
      const report = current.checks.map(c => c.code === 'browser-roundtrip' ? { ...c, passed: input.load && input.stateRoundtrip,
        reason: input.load && input.stateRoundtrip ? '' : 'Isolated browser load or state roundtrip failed' } : c);
      const updated = teachingArtifactCandidateSchema.parse({ ...current, checks: report, status: report.every(c => c.passed) ? 'adoptable' : 'check-failed' });
      await tx.query('UPDATE teaching_artifact_candidates SET body=$2 WHERE candidate_id=$1', [input.candidateId, JSON.stringify(updated)]);
      await tx.query('INSERT INTO teaching_artifact_checks VALUES($1,$2,$3,$4)', [input.requestId, input.candidateId, activityId, JSON.stringify({ input, result: updated })]);
      return updated;
    });
    return teachingArtifactCandidateSchema.parse(result.result);
  }
  async function shelf(identity: SpaceIdentity, activityId: string, value: unknown) {
    await writable(identity, activityId);
    const input = teachingArtifactShelfSchema.parse(value); await read(identity, activityId, input.artifactId);
    const result = await storage.request({ requestId: input.requestId, fingerprint: fingerprint({ identity, activityId, input }) }, async tx => {
      await guardActivity(tx, activityId);
      const { rows: [row] } = await tx.query('SELECT body FROM teaching_artifacts WHERE artifact_id=$1 FOR UPDATE', [input.artifactId]);
      const artifact = teachingArtifactSchema.parse(row!.body);
      await tx.query('UPDATE teaching_artifacts SET body=$2 WHERE artifact_id=$1', [input.artifactId, JSON.stringify({ ...artifact, shelved: input.shelved })]);
      const saved = teachingArtifactReceiptSchema.parse({ requestId: input.requestId, artifactId: artifact.artifactId,
        revisionId: artifact.activeRevisionId ?? artifact.latestRevisionId, candidateId: null, kind: 'shelf', outcome: 'shelved',
        workRevision: null, contentId: null, relatedArtifactId: null, reason: null });
      await tx.query('INSERT INTO teaching_artifact_receipts VALUES($1,$2,$3)', [input.requestId, activityId, JSON.stringify(saved)]);
      return saved;
    });
    return teachingArtifactReceiptSchema.parse(result.result);
  }
  async function adopt(identity: SpaceIdentity, activityId: string, value: unknown) {
    const input = teachingArtifactAdoptSchema.parse(value); await writable(identity, activityId);
    const fp = fingerprint({ identity, activityId, input });
    const previous = await storage.receipt(input.requestId, fp);
    if (previous) { const own = await receipt(identity, activityId, input.requestId); if (!own) throw new StorageError('identity-conflict'); return own; }
    const proposed = await candidate(identity, activityId, input.candidateId), artifact = await read(identity, activityId, proposed.artifactId);
    const fixed = await revision(identity, activityId, artifact.artifactId, proposed.revisionId);
    if (proposed.status !== 'adoptable' || artifact.activeRevisionId !== input.expectedRevisionId
      || artifact.activeRevisionId !== null && fixed.parentRevisionId !== input.expectedRevisionId) throw new StorageError('conflict');
    // Only the retained publication supplies the Run/Command association, never the student's request.
    if (fixed.origin) {
      if (!assertAdoption) throw new StorageError('unavailable');
      await assertAdoption(identity, activityId, fixed.origin, proposed);
    }
    await resource(identity, activityId, artifact.artifactId, fixed.revisionId);
    const { rows: [head] } = await storage.read('SELECT revision,files FROM work_heads WHERE activity_id=$1', [activityId]);
    if (Number(head?.revision ?? 0) !== input.expectedWorkRevision) throw new StorageError('conflict');
    const files = (head?.files ?? []) as Omit<WorkFile, 'value'>[];
    const oldFile = files.find(f => f.name === componentStateName(fixed.binding.key));
    if ((oldFile?.contentId ?? null) !== input.expectedContentId) throw new StorageError('conflict');
    let content: unknown = fixed.payload.initialState, compatible = true;
    if (input.expectedRevisionId) {
      if (!oldFile) throw new StorageError('conflict');
      const parent = await revision(identity, activityId, artifact.artifactId, input.expectedRevisionId);
      const oldState = componentStateSchema.parse(JSON.parse(Buffer.from(await storage.readResource(oldFile.contentId)).toString('utf8')));
      if (!matchesComponentState(parent.binding, activityId, { ...oldFile, value: JSON.stringify(oldState) })) throw new StorageError('corrupt');
      const preserved = preserveArtifactState(parent, fixed, oldState.content);
      compatible = preserved !== undefined;
      if (compatible) content = preserved;
    }
    // Prepare immutable state bytes before the transaction; the locked baseline below decides whether they may enter the head.
    const targetArtifactId = compatible ? artifact.artifactId : randomUUID(), targetRevisionId = compatible ? fixed.revisionId : randomUUID();
    const draftBinding = compatible ? fixed.binding : componentBindingSchema.parse({ ...fixed.binding, key: artifactKey(targetArtifactId), definition: {
      manifest: { ...fixed.binding.definition.manifest, componentId: targetArtifactId, version: 1 },
      digest: fingerprint({ revisionId: targetRevisionId, artifactId: targetArtifactId, payload: fixed.payload }) } });
    const binding = { ...draftBinding, definition: { ...draftBinding.definition, digest: hash(JSON.stringify(draftBinding.definition.manifest)) } };
    const contentId = randomUUID(), objectId = compatible && oldFile ? oldFile.objectId : randomUUID();
    const state = componentStateSchema.parse({ formatVersion: 1, instanceId: componentInstanceId(activityId, binding.key), componentId: targetArtifactId,
      version: binding.definition.manifest.version, definitionDigest: binding.definition.digest, stateVersion: fixed.payload.stateVersion,
      operationId: input.requestId, content });
    const stateBytes = Buffer.from(JSON.stringify(state));
    await storage.stageResource({ uploadId: contentId, scope: `works/${activityId}/${objectId}`, bytes: stateBytes, mediaType: componentStateMediaType, contentVersion: 1 });
    const stateFile = { objectId, contentId, name: componentStateName(binding.key), kind: 'state' as const, encoding: 'json' as const, mediaType: componentStateMediaType };
    const nextFiles = [...files.filter(f => f.objectId !== objectId), stateFile];
    const hydrated = await Promise.all(nextFiles.map(async f => ({ ...f, value: f.contentId === contentId ? stateBytes.toString('utf8')
      : Buffer.from(await storage.readResource(f.contentId)).toString(f.encoding === 'base64' ? 'base64' : 'utf8') })));
    workViewSchema.parse({ revision: input.expectedWorkRevision + 1, files: hydrated });
    const saved = await storage.request({ requestId: input.requestId, fingerprint: fp }, async tx => {
      await guardActivity(tx, activityId);
      // Lock order matches normal workspace sync. Binding and typed state become visible in this single transaction.
      await tx.query('INSERT INTO work_heads VALUES($1,0,$2) ON CONFLICT DO NOTHING', [activityId, '[]']);
      const { rows: [lockedHead] } = await tx.query('SELECT revision,files FROM work_heads WHERE activity_id=$1 FOR UPDATE', [activityId]);
      if (Number(lockedHead!.revision) !== input.expectedWorkRevision || fingerprint(lockedHead!.files) !== fingerprint(files)) throw new StorageError('conflict');
      const { rows: [lockedArtifact] } = await tx.query('SELECT body FROM teaching_artifacts WHERE artifact_id=$1 FOR UPDATE', [artifact.artifactId]);
      const current = teachingArtifactSchema.parse(lockedArtifact!.body);
      if (current.activeRevisionId !== input.expectedRevisionId) throw new StorageError('conflict');
      const { rows: [lockedCandidate] } = await tx.query('SELECT body FROM teaching_artifact_candidates WHERE candidate_id=$1 FOR UPDATE', [input.candidateId]);
      if (teachingArtifactCandidateSchema.parse(lockedCandidate!.body).status !== 'adoptable') throw new StorageError('conflict');
      if (!compatible) {
        const fork = teachingArtifactSchema.parse({ ...artifact, artifactId: targetArtifactId, activeRevisionId: targetRevisionId,
          latestRevisionId: targetRevisionId, title: fixed.payload.title, display: fixed.payload.display, relatedArtifactId: artifact.artifactId,
          shelved: false, createdAt: new Date().toISOString() });
        const revision = teachingArtifactRevisionSchema.parse({ ...fixed, artifactId: targetArtifactId, revisionId: targetRevisionId,
          version: 1, binding, mapping: [] });
        await tx.query('INSERT INTO teaching_artifacts VALUES($1,$2,$3)', [targetArtifactId, activityId, JSON.stringify(fork)]);
        await tx.query('INSERT INTO teaching_artifact_revisions VALUES($1,$2,$3,$4,$5)', [targetRevisionId, targetArtifactId, 1, fixed.resourceId, JSON.stringify(revision)]);
        await tx.reference(`teaching-artifact/${targetRevisionId}`, fixed.resourceId);
      } else {
        await tx.query('UPDATE teaching_artifacts SET body=$2 WHERE artifact_id=$1', [artifact.artifactId, JSON.stringify({ ...current,
          activeRevisionId: fixed.revisionId, title: fixed.payload.title, display: fixed.payload.display })]);
      }
      await tx.query('INSERT INTO work_objects(object_id,activity_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [objectId, activityId, 'state']);
      const { rows: [object] } = await tx.query('SELECT activity_id,kind,deleted FROM work_objects WHERE object_id=$1', [objectId]);
      if (!object || object.activity_id !== activityId || object.kind !== 'state' || object.deleted) throw new StorageError('identity-conflict');
      await tx.query('INSERT INTO work_contents VALUES($1,$2,$3,$4,$5)', [contentId, activityId, objectId, 'json', componentStateMediaType]);
      await tx.reference('work-content/' + contentId, contentId);
      const workRevision = input.expectedWorkRevision + 1;
      await tx.query('UPDATE work_heads SET revision=$2,files=$3 WHERE activity_id=$1', [activityId, workRevision, JSON.stringify(nextFiles)]);
      await tx.query('INSERT INTO work_versions VALUES($1,$2,$3)', [activityId, workRevision, JSON.stringify(nextFiles)]);
      await tx.query('UPDATE teaching_artifact_candidates SET body=$2 WHERE candidate_id=$1', [input.candidateId, JSON.stringify({ ...proposed, status: 'adopted' })]);
      const result = teachingArtifactReceiptSchema.parse({ requestId: input.requestId, artifactId: targetArtifactId, revisionId: targetRevisionId,
        candidateId: input.candidateId, kind: 'adopt', outcome: compatible ? 'adopted' : 'forked', workRevision, contentId,
        relatedArtifactId: compatible ? null : artifact.artifactId, reason: compatible ? null : '旧页面与输入已保留，新版使用独立实例。' });
      await tx.query('INSERT INTO teaching_artifact_receipts VALUES($1,$2,$3)', [input.requestId, activityId, JSON.stringify(result)]);
      // A check before resource I/O is only admission. Re-read the original Run after all
      // awaited work so Stop during state preparation cannot commit a new active revision.
      if (fixed.origin) await assertAdoption!(identity, activityId, fixed.origin, proposed);
      return result;
    });
    return teachingArtifactReceiptSchema.parse(saved.result);
  }

  return { read, list, revision, candidate, receipt, publish, resource, check, checkReceipt, adopt, shelf };
}
export async function validateTeachingArtifacts(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT r.*,a.activity_id FROM teaching_artifact_revisions r JOIN teaching_artifacts a USING(artifact_id)');
  const revisions = new Map<string, TeachingArtifactRevision>();
  for (const row of rows) {
    const fixed = teachingArtifactRevisionSchema.parse(row.body), bytes = await storage.readResource(fixed.resourceId);
    if (fixed.artifactId !== row.artifact_id || fixed.revisionId !== row.revision_id || fixed.resourceId !== row.resource_id
      || fixed.activityId !== row.activity_id || fixed.version !== Number(row.version) || hash(bytes) !== fixed.sha256 || bytes.length !== fixed.byteLength
      || !Buffer.from(bytes).equals(Buffer.from(render(fixed.payload))) || fixed.binding.definition.digest !== hash(JSON.stringify(fixed.binding.definition.manifest))
      || fixed.binding.key !== artifactKey(fixed.artifactId) || fixed.binding.definition.manifest.componentId !== fixed.artifactId
      || fixed.binding.definition.manifest.version !== fixed.version || fixed.binding.definition.manifest.entry.resourceId !== fixed.resourceId
      || fixed.binding.definition.manifest.entry.sha256 !== fixed.sha256
      || fixed.binding.definition.manifest.stateVersion !== fixed.payload.stateVersion
      || fingerprint(fixed.binding.definition.manifest.stateShape) !== fingerprint(fixed.payload.stateShape)
      || fingerprint(fixed.binding.definition.manifest.initialState) !== fingerprint(fixed.payload.initialState)) throw new StorageError('corrupt');
    const { rows: [pin] } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [`teaching-artifact/${fixed.revisionId}`]);
    if (!pin || pin.resource_id !== fixed.resourceId) throw new StorageError('corrupt');
    revisions.set(fixed.revisionId, fixed);
  }
  for (const fixed of revisions.values()) if (fixed.parentRevisionId) {
    const parent = revisions.get(fixed.parentRevisionId);
    if (!parent || parent.activityId !== fixed.activityId || parent.artifactId === fixed.artifactId && parent.version >= fixed.version) throw new StorageError('corrupt');
  }
  const { rows: artifactRows } = await storage.read('SELECT * FROM teaching_artifacts');
  for (const row of artifactRows) {
    const artifact = teachingArtifactSchema.parse(row.body), latest = revisions.get(artifact.latestRevisionId);
    if (artifact.artifactId !== row.artifact_id || artifact.activityId !== row.activity_id || latest?.artifactId !== artifact.artifactId
      || artifact.activeRevisionId && revisions.get(artifact.activeRevisionId)?.artifactId !== artifact.artifactId) throw new StorageError('corrupt');
    if (artifact.activeRevisionId) {
      const { rows: adopted } = await storage.read("SELECT request_id FROM teaching_artifact_receipts WHERE activity_id=$1 AND body->>'kind'='adopt' AND body->>'revisionId'=$2", [artifact.activityId, artifact.activeRevisionId]);
      if (!adopted.length) throw new StorageError('corrupt');
    }
    const { rows: [candidate] } = await storage.read('SELECT body FROM teaching_artifact_candidates WHERE candidate_id=$1', [artifact.latestCandidateId]);
    if (!candidate || teachingArtifactCandidateSchema.parse(candidate.body).revisionId !== artifact.latestRevisionId && !artifact.relatedArtifactId) throw new StorageError('corrupt');
  }
  const { rows: candidateRows } = await storage.read('SELECT * FROM teaching_artifact_candidates');
  for (const row of candidateRows) {
    const candidate = teachingArtifactCandidateSchema.parse(row.body), fixed = revisions.get(candidate.revisionId);
    if (candidate.candidateId !== row.candidate_id || candidate.artifactId !== row.artifact_id || candidate.revisionId !== row.revision_id
      || fixed?.artifactId !== candidate.artifactId || ['adoptable', 'adopted'].includes(candidate.status) && !candidate.checks.every(c => c.passed)) throw new StorageError('corrupt');
    if (['adoptable', 'adopted'].includes(candidate.status)) {
      const { rows: checked } = await storage.read("SELECT request_id FROM teaching_artifact_checks WHERE candidate_id=$1 AND body->'result'->>'status'='adoptable'", [candidate.candidateId]);
      if (!checked.length) throw new StorageError('corrupt');
    }

  }
  const { rows: receipts } = await storage.read('SELECT * FROM teaching_artifact_receipts');
  for (const row of receipts) {
    const receipt = teachingArtifactReceiptSchema.parse(row.body), original = await storage.receipt(String(row.request_id));
    const fixed = revisions.get(receipt.revisionId);
    if (receipt.requestId !== row.request_id || !fixed || fixed.activityId !== row.activity_id || receipt.artifactId !== fixed.artifactId
      || !original || fingerprint(original.result) !== fingerprint(receipt)) throw new StorageError('corrupt');
    if (receipt.kind === 'adopt') {
      const { rows: [version] } = await storage.read('SELECT files FROM work_versions WHERE activity_id=$1 AND revision=$2', [row.activity_id, receipt.workRevision]);
      if (!version || !(version.files as { contentId: string }[]).some(f => f.contentId === receipt.contentId)) throw new StorageError('corrupt');
    }
  }
  const { rows: reports } = await storage.read('SELECT * FROM teaching_artifact_checks');
  for (const row of reports) {
    const report = row.body as { input: unknown; result: unknown }, input = teachingArtifactCheckSchema.parse(report.input), result = teachingArtifactCandidateSchema.parse(report.result);
    const original = await storage.receipt(String(row.request_id)), fixed = revisions.get(input.revisionId);
    if (input.requestId !== row.request_id || input.candidateId !== row.candidate_id || input.candidateId !== result.candidateId
      || !fixed || fixed.activityId !== row.activity_id || input.resourceSha256 !== fixed.sha256 || !original
      || fingerprint(original.result) !== fingerprint(result)) throw new StorageError('corrupt');
  }
}

/** Old views may still accept input while adoption waits, so the new shape must accept their entire domain. */
function preservesInputShape(before: StateShape, after: StateShape): boolean {
  if (before.type !== after.type) return false;
  if (before.type === 'string') return after.type === 'string' && after.maxLength >= before.maxLength;
  if (before.type === 'array') return after.type === 'array' && after.maxItems >= before.maxItems && preservesInputShape(before.items, after.items);
  if (before.type === 'object') return after.type === 'object'
    && Object.keys(before.properties).length === Object.keys(after.properties).length
    && Object.entries(before.properties).every(([key, shape]) => !!after.properties[key] && preservesInputShape(shape, after.properties[key]));
  return true;
}

/** All old fields need a one-to-one mapping with unchanged meaning. No generated migration code runs. */
function preserveArtifactState(parent: TeachingArtifactRevision, next: TeachingArtifactRevision, value: unknown): unknown | undefined {
  const before = parent.payload, after = next.payload;
  if (before.stateShape.type !== 'object' || after.stateShape.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (before.semanticObjects.some(object => !after.semanticObjects.some(next => next.id === object.id && next.meaning === object.meaning))) return undefined;
  const state = value as Record<string, unknown>, result = { ...after.initialState as Record<string, unknown> }, used = new Set<string>();
  if (new Set(next.mapping.map(m => m.from)).size !== next.mapping.length || new Set(next.mapping.map(m => m.to)).size !== next.mapping.length) return undefined;
  if (next.mapping.some(m => !before.semanticFields.some(f => f.key === m.from) || !after.semanticFields.some(f => f.key === m.to))) return undefined;
  for (const field of before.semanticFields) {
    const mapped = next.mapping.find(m => m.from === field.key)?.to ?? field.key;
    const target = after.semanticFields.find(f => f.key === mapped), shape = after.stateShape.properties[mapped];
    const previousShape = before.stateShape.properties[field.key];
    if (!target || target.meaning !== field.meaning || !shape || !previousShape || used.has(mapped)
      || !preservesInputShape(previousShape, shape) || !acceptsState(shape, state[field.key])) return undefined;
    used.add(mapped); Object.defineProperty(result, mapped, { value: state[field.key], enumerable: true, writable: true, configurable: true });
  }
  return acceptsState(after.stateShape, result) ? result : undefined;
}
