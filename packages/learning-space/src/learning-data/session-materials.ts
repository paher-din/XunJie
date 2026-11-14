import { StorageError, type Migration, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import { createHash } from 'node:crypto';
import { adoptSessionMaterialSchema, materialScopeSchema, releaseSessionMaterialsSchema, type MaterialScope, type MaterialScopeInput,
  type SessionMaterialPort } from '@xunjie/contracts/session-materials';
import { learningTargetSchema, spaceIdentitySchema, type LearningTarget, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { activitySchema, type LearningActivity } from '@xunjie/contracts/learning-data';
import { agentSessionSchema } from '@xunjie/contracts/agent-sessions';
import { createPersonalMaterials, validatePersonalMaterials } from './personal-materials.js';
import { createPdfMaterials, validatePdfMaterials } from './pdf-materials.js';
import { scopedPersonalMaterialVersionContentSchema, type ScopedPersonalMaterialVersionContent } from '@xunjie/contracts/personal-materials';
import { scopedPdfDocumentSchema, type ScopedPdfDocument } from '@xunjie/contracts/pdf-materials';
import { createMaterialSearch } from './material-search.js';
import type { CourseBindingAuthority } from '@xunjie/contracts/courses';

export const sessionMaterialMigration: Migration = { version: 32, name: 'session-and-workspace-material-scopes', sql: `
  ALTER TABLE personal_materials ALTER COLUMN activity_id DROP NOT NULL,
    ADD COLUMN session_id uuid REFERENCES agent_session_directory(session_id),
    ADD CONSTRAINT personal_material_scope CHECK(num_nonnulls(activity_id,session_id)=1);
  CREATE INDEX personal_material_session ON personal_materials(session_id);
  ALTER TABLE pdf_documents ALTER COLUMN activity_id DROP NOT NULL,
    ADD COLUMN session_id uuid REFERENCES agent_session_directory(session_id),
    ADD CONSTRAINT pdf_document_scope CHECK(num_nonnulls(activity_id,session_id)=1);
  ALTER TABLE pdf_readings ALTER COLUMN activity_id DROP NOT NULL,
    ADD COLUMN session_id uuid REFERENCES agent_session_directory(session_id),
    ADD CONSTRAINT pdf_reading_scope CHECK(num_nonnulls(activity_id,session_id)=1);
  CREATE INDEX pdf_document_session ON pdf_documents(session_id);
  CREATE INDEX pdf_reading_session ON pdf_readings(session_id);
  CREATE TABLE session_material_adoptions(request_id uuid PRIMARY KEY,
    activity_id uuid NOT NULL REFERENCES activities(id),input jsonb NOT NULL,source_target jsonb NOT NULL,
    state text NOT NULL CHECK(state IN ('pending','ready')));
  CREATE TABLE session_material_releases(session_id uuid PRIMARY KEY REFERENCES agent_session_directory(session_id),
    released_at timestamptz NOT NULL DEFAULT clock_timestamp());
` };
export interface MaterialScopeOptions {
  /** Returns the actual authorized session or activity from its data owner. */
  openScope(identity: SpaceIdentity, scope: MaterialScope): Promise<unknown>;
}
export interface SessionMaterialOptions extends MaterialScopeOptions {
  courses?: CourseBindingAuthority;
  /** Trusted host routing. Browser/model input never supplies bytes or an owner descriptor. */
  sources?: {
    personal(identity: SpaceIdentity, scope: MaterialScope, materialId: string, version: number, target?: LearningTarget):
      Promise<ScopedPersonalMaterialVersionContent & { target: LearningTarget }>;
    pdf(identity: SpaceIdentity, scope: MaterialScope, documentId: string, target?: LearningTarget):
      Promise<{ document: ScopedPdfDocument; bytes: Uint8Array; target: LearningTarget }>;
  };
}
export type WorkspaceMaterialOpen = (identity: SpaceIdentity, activityId: string) => Promise<LearningActivity>;
export const normalizeMaterialScope = (value: MaterialScopeInput): MaterialScope =>
  materialScopeSchema.parse(typeof value === 'string' ? { kind: 'workspace', activityId: value } : value);
export const materialScopeKey = (scope: MaterialScope) => scope.kind === 'workspace' ? { activityId: scope.activityId } : { sessionId: scope.sessionId };
export const materialScopeId = (scope: MaterialScope) => scope.kind === 'workspace' ? scope.activityId : scope.sessionId;
export const materialScopeColumn = (scope: MaterialScope) => scope.kind === 'workspace' ? 'activity_id' : 'session_id';
export const materialPlacement = (scope: MaterialScope) => scope.kind === 'workspace' ? { activityId: scope.activityId } : { scope };
export const materialResourceScope = (scope: MaterialScope) => scope.kind === 'workspace' ? scope.activityId : `session:${scope.sessionId}`;
export function materialHasScope(value: { activityId?: unknown; scope?: unknown }, scope: MaterialScope) {
  if (scope.kind === 'workspace') return value.activityId === scope.activityId && value.scope === undefined;
  const parsed = materialScopeSchema.safeParse(value.scope);
  return value.activityId === undefined && parsed.success && parsed.data.kind === 'session' && parsed.data.sessionId === scope.sessionId;
}
const sameSubject = (a: SpaceIdentity, b: SpaceIdentity) => a.environmentId === b.environmentId && a.spaceId === b.spaceId
  && a.principalId === b.principalId && a.kind === b.kind;

export function createMaterialScopeAccess(storage: OwnedStorage, host: WorkspaceMaterialOpen | MaterialScopeOptions) {
  function check(identity: SpaceIdentity, scope: MaterialScope, value: unknown, allowDeleted = false) {
    if (scope.kind === 'session') {
      const session = agentSessionSchema.parse(value);
      if (session.sessionId !== scope.sessionId || !sameSubject(session.identity, identity) || (session.deleted && !allowDeleted))
        throw new StorageError('forbidden');
      return { scope, session };
    }
    const activity = activitySchema.parse(value);
    if (activity.activityId !== scope.activityId || !sameSubject(activity.identity, identity)
      || activity.target.environmentId !== storage.owner.environmentId || activity.target.serviceId !== storage.owner.serviceId)
      throw new StorageError('forbidden');
    return { scope, activity };
  }
  async function lock(tx: OwnedTransaction, identity: SpaceIdentity, scope: MaterialScope, allowDeleted = false) {
    const table = scope.kind === 'workspace' ? 'activities' : 'agent_session_directory';
    const id = scope.kind === 'workspace' ? 'id' : 'session_id';
    const { rows: [row] } = await tx.query(`SELECT body FROM ${table} WHERE ${id}=$1 FOR SHARE`, [materialScopeId(scope)]);
    if (!row) throw new StorageError('missing');
    return check(identity, scope, row.body, allowDeleted);
  }
  async function open(identity: SpaceIdentity, value: MaterialScopeInput, allowDeleted = false) {
    spaceIdentitySchema.parse(identity);
    const scope = normalizeMaterialScope(value);
    const authorized = typeof host === 'function'
      ? scope.kind === 'workspace' ? await host(identity, scope.activityId) : (() => { throw new StorageError('forbidden'); })()
      : await host.openScope(identity, scope);
    const result = check(identity, scope, authorized, allowDeleted);
    const table = scope.kind === 'workspace' ? 'activities' : 'agent_session_directory';
    const id = scope.kind === 'workspace' ? 'id' : 'session_id';
    const { rows: [row] } = await storage.read(`SELECT body FROM ${table} WHERE ${id}=$1`, [materialScopeId(scope)]);
    if (!row) throw new StorageError('missing');
    check(identity, scope, row.body, allowDeleted);
    return result;
  }
  return { open, lock };
}

/** Restore validates the real parent, including retirement, before touching original bytes. */
export async function inspectMaterialScope(storage: OwnedStorage, row: Record<string, unknown>) {
  if (!!row.activity_id === !!row.session_id) throw new StorageError('corrupt');
  const scope = normalizeMaterialScope(row.activity_id ? String(row.activity_id) : { kind: 'session', sessionId: String(row.session_id) });
  if (scope.kind === 'workspace') {
    const { rows: [parent] } = await storage.read('SELECT body FROM activities WHERE id=$1', [scope.activityId]);
    const activity = activitySchema.parse(parent?.body);
    if (activity.activityId !== scope.activityId || activity.target.environmentId !== storage.owner.environmentId
      || activity.target.serviceId !== storage.owner.serviceId) throw new StorageError('corrupt');
    return { scope, released: false };
  }
  const { rows: [parent] } = await storage.read(`SELECT d.body,r.session_id AS released FROM agent_session_directory d
    LEFT JOIN session_material_releases r ON r.session_id=d.session_id WHERE d.session_id=$1`, [scope.sessionId]);
  const session = agentSessionSchema.parse(parent?.body);
  if (session.sessionId !== scope.sessionId || (parent?.released && !session.deleted)) throw new StorageError('corrupt');
  return { scope, released: !!parent?.released };
}

export function createSessionMaterials(storage: OwnedStorage, options: SessionMaterialOptions): SessionMaterialPort {
  const access = createMaterialScopeAccess(storage, options);
  const personal = createPersonalMaterials(storage, options), pdf = createPdfMaterials(storage, options, options.courses);
  const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const localTarget = () => ({ ...storage.owner, version: 1 as const });
  async function adopt(identity: SpaceIdentity, destination: MaterialScopeInput, value: unknown) {
    const { scope } = await access.open(identity, destination);
    if (scope.kind !== 'workspace') throw new StorageError('invalid');
    const input = adoptSessionMaterialSchema.parse(value);
    const fingerprint = hash(JSON.stringify({ destination: scope, input }));
    const key = 'session-material-adopt:' + input.requestId;
    const prepared = await storage.receipt(key, fingerprint);
    const expectedTarget = prepared ? learningTargetSchema.parse(prepared.result) : undefined;
    async function existing() {
      try {
        const fixed = input.kind === 'personal-material'
          ? await personal.material(identity, scope, input.materialId) : await pdf.document(identity, scope, input.documentId);
        const digest = 'versions' in fixed ? fixed.versions.find(version => version.version === 1)?.sha256 : fixed.sha256;
        if (fixed.requestId !== input.requestId || digest !== input.source.sha256) throw new StorageError('identity-conflict');
        return fixed;
      } catch (error) { if (error instanceof StorageError && error.code === 'missing') return null; throw error; }
    }
    let copied = prepared ? await existing() : null;
    if (!copied) {
      let target: LearningTarget, payload: { name: string; dataBase64: string; mediaType?: 'text/plain' | 'text/markdown' };
      if (input.kind === 'personal-material') {
        const result = options.sources ? await options.sources.personal(identity, input.source.scope, input.source.materialId, input.source.version, expectedTarget)
          : { ...await personal.versionContent(identity, input.source.scope, input.source.materialId, input.source.version), target: localTarget() };
        const fixed = scopedPersonalMaterialVersionContentSchema.parse({ material: result.material, version: result.version, text: result.text });
        const bytes = Buffer.from(fixed.text, 'utf8');
        if (!materialHasScope(fixed.material, input.source.scope) || fixed.material.materialId !== input.source.materialId
          || fixed.material.removedAt || fixed.version.materialId !== input.source.materialId || fixed.version.version !== input.source.version
          || fixed.version.sha256 !== input.source.sha256 || hash(bytes) !== input.source.sha256 || bytes.length !== fixed.version.byteLength)
          throw new StorageError('identity-conflict');
        target = learningTargetSchema.parse(result.target);
        payload = { name: fixed.version.name, mediaType: fixed.version.mediaType, dataBase64: bytes.toString('base64') };
      } else {
        const result = options.sources ? await options.sources.pdf(identity, input.source.scope, input.source.documentId, expectedTarget)
          : { ...await pdf.original(identity, input.source.scope, input.source.documentId), target: localTarget() };
        const fixed = scopedPdfDocumentSchema.parse(result.document), bytes = Buffer.from(result.bytes);
        if (!materialHasScope(fixed, input.source.scope) || fixed.documentId !== input.source.documentId
          || fixed.sha256 !== input.source.sha256 || hash(bytes) !== input.source.sha256 || bytes.length !== fixed.byteLength)
          throw new StorageError('identity-conflict');
        target = learningTargetSchema.parse(result.target);
        payload = { name: fixed.name, dataBase64: bytes.toString('base64') };
      }
      if (expectedTarget && JSON.stringify(expectedTarget) !== JSON.stringify(target)) throw new StorageError('identity-conflict');
      await access.open(identity, scope);
      await storage.request({ requestId: key, fingerprint }, async tx => {
        await access.lock(tx, identity, scope);
        await tx.query(`INSERT INTO session_material_adoptions VALUES($1,$2,$3,$4,'pending')`,
          [input.requestId, scope.activityId, input, target]);
        return target;
      });
      copied = input.kind === 'personal-material'
        ? await personal.receive(identity, scope, { requestId: input.requestId, materialId: input.materialId, ...payload })
        : await pdf.upload(identity, scope, { requestId: input.requestId, documentId: input.documentId, name: payload.name, dataBase64: payload.dataBase64 });
    }
    if (input.kind === 'pdf' && 'state' in copied && copied.state === 'received') {
      const retained = await pdf.original(identity, scope, input.documentId);
      copied = await pdf.upload(identity, scope, { requestId: input.requestId, documentId: input.documentId,
        name: retained.document.name, dataBase64: Buffer.from(retained.bytes).toString('base64') });
    }
    await access.open(identity, scope);
    await storage.request({ requestId: key + ':complete', fingerprint }, async tx => {
      await access.lock(tx, identity, scope);
      await tx.query("UPDATE session_material_adoptions SET state='ready' WHERE request_id=$1", [input.requestId]);
      return null;
    });
    return copied;
  }
  async function releaseDeleted(identity: SpaceIdentity, value: unknown) {
    const input = releaseSessionMaterialsSchema.parse(value), scope = { kind: 'session' as const, sessionId: input.sessionId };
    const opened = await access.open(identity, scope, true);
    if (!opened.session?.deleted) throw new StorageError('invalid');
    await storage.request({ requestId: 'session-material-release:' + input.requestId, fingerprint: hash(JSON.stringify({ scope })) }, async tx => {
      const locked = await access.lock(tx, identity, scope, true);
      if (!locked.session?.deleted) throw new StorageError('invalid');
      const inserted = await tx.query('INSERT INTO session_material_releases(session_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING session_id', [scope.sessionId]);
      if (!inserted.rowCount) return null;
      const { rows: versions } = await tx.query(`SELECT v.material_id,v.version FROM personal_material_versions v
        JOIN personal_materials m ON m.material_id=v.material_id WHERE m.session_id=$1`, [scope.sessionId]);
      for (const version of versions) await tx.unreference(`personal-material:${version.material_id}:${version.version}`);
      const { rows: documents } = await tx.query('SELECT document_id FROM pdf_documents WHERE session_id=$1', [scope.sessionId]);
      for (const document of documents) await tx.unreference('pdf-document:' + document.document_id);
      const { rows: readings } = await tx.query('SELECT reading_id FROM pdf_readings WHERE session_id=$1', [scope.sessionId]);
      for (const reading of readings) {
        await tx.unreference('pdf-reading:' + reading.reading_id);
        await tx.unreference('pdf-reading-original:' + reading.reading_id);
      }
      return null;
    });
  }
  const { search } = createMaterialSearch({ storage, openScope: options.openScope, personal, pdf,
    ...(options.courses ? { courses: options.courses } : {}) });
  return { personal, pdf, search, adopt, releaseDeleted, validate: async () => {
    await validatePersonalMaterials(storage); await validatePdfMaterials(storage); await validateSessionMaterials(storage);
  } };
}

export async function validateSessionMaterials(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT * FROM session_material_adoptions');
  for (const row of rows) {
    const input = adoptSessionMaterialSchema.parse(row.input);
    const sourceTarget = learningTargetSchema.parse(row.source_target);
    if (input.requestId !== row.request_id) throw new StorageError('corrupt');
    await inspectMaterialScope(storage, { activity_id: row.activity_id });
    const fingerprint = createHash('sha256').update(JSON.stringify({ destination: { kind: 'workspace', activityId: row.activity_id }, input })).digest('hex');
    const key = 'session-material-adopt:' + input.requestId;
    let prepared, completed;
    try {
      prepared = await storage.receipt(key, fingerprint);
      completed = row.state === 'ready' ? await storage.receipt(key + ':complete', fingerprint) : null;
    } catch (error) { if (error instanceof StorageError && error.code === 'identity-conflict') throw new StorageError('corrupt'); throw error; }
    const fixedTarget = learningTargetSchema.safeParse(prepared?.result);
    if (!fixedTarget.success || JSON.stringify(fixedTarget.data) !== JSON.stringify(sourceTarget)
      || (row.state === 'ready' && (!completed || completed.result !== null))) throw new StorageError('corrupt');
    if (row.state === 'pending') continue;
    if (row.state !== 'ready') throw new StorageError('corrupt');
    if (input.kind === 'personal-material') {
      const { rows: [fixed] } = await storage.read(`SELECT m.activity_id,m.request_id,v.sha256 FROM personal_materials m
        JOIN personal_material_versions v ON v.material_id=m.material_id AND v.version=1 WHERE m.material_id=$1`, [input.materialId]);
      if (!fixed || fixed.activity_id !== row.activity_id || fixed.request_id !== input.requestId || fixed.sha256 !== input.source.sha256)
        throw new StorageError('corrupt');
    } else {
      const { rows: [fixed] } = await storage.read('SELECT activity_id,body FROM pdf_documents WHERE document_id=$1', [input.documentId]);
      const doc = scopedPdfDocumentSchema.parse(fixed?.body);
      if (fixed?.activity_id !== row.activity_id || doc.requestId !== input.requestId || doc.sha256 !== input.source.sha256)
        throw new StorageError('corrupt');
    }
  }
  const { rows: releases } = await storage.read('SELECT session_id FROM session_material_releases');
  for (const row of releases) await inspectMaterialScope(storage, row);
}
