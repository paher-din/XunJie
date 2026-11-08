import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import {
  PERSONAL_MATERIAL_LIMITS, personalMaterialReadResultSchema, personalMaterialReadSchema, personalMaterialRemoveSchema,
  personalMaterialSaveSchema, personalMaterialSchema, personalMaterialUpdateSchema, personalMaterialVersionContentSchema,
  personalMaterialVersionSchema, type PersonalMaterial, type PersonalMaterialVersion,
} from '@xunjie/contracts/personal-materials';
import type { QuestionReferenceInput } from '@xunjie/contracts/question-drafts';
import { operationId } from '../teaching-agent/identity.js';

export const personalMaterialMigration: Migration = { version: 24, name: 'personal-text-materials', sql: `
  CREATE TABLE personal_materials(material_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),
    request_id uuid NOT NULL UNIQUE,input_digest text NOT NULL,current_version integer NOT NULL CHECK(current_version>0),
    removed_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE personal_material_versions(material_id uuid NOT NULL REFERENCES personal_materials(material_id),
    version integer NOT NULL CHECK(version>0),request_id uuid NOT NULL UNIQUE,input_digest text NOT NULL,
    name text NOT NULL,media_type text NOT NULL CHECK(media_type IN ('text/plain','text/markdown')),
    sha256 text NOT NULL,byte_length integer NOT NULL CHECK(byte_length>0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(material_id,version));
` };
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));
const fail = (code: 'forbidden' | 'invalid' | 'missing' | 'identity-conflict' | 'corrupt'): never => {
  throw new StorageError(code);
};
export const personalMaterialResourceId = (materialId: string, version: number) => operationId(`personal-material-resource:${materialId}:${version}`);
const resourceIdFor = personalMaterialResourceId;
const resourceReference = (materialId: string, version: number) => `personal-material:${materialId}:${version}`;

/** A UTF-8 text original must be byte-exact; replacement characters are not accepted as student content. */
function decodeUtf8(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('invalid'); }
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) return fail('invalid');
  return text;
}

export function createPersonalMaterials(storage: OwnedStorage, open: (identity: SpaceIdentity, activityId: string) => Promise<LearningActivity>) {
  function versionOf(row: Record<string, unknown>): PersonalMaterialVersion {
    return personalMaterialVersionSchema.parse({ materialId: row.material_id, version: Number(row.version),
      requestId: row.request_id, name: row.name, mediaType: row.media_type, sha256: row.sha256,
      byteLength: Number(row.byte_length), createdAt: new Date(row.created_at as string).toISOString() });
  }
  async function versions(materialId: string): Promise<PersonalMaterialVersion[]> {
    const { rows } = await storage.read(`SELECT * FROM personal_material_versions WHERE material_id=$1 ORDER BY version`, [materialId]);
    return rows.map(versionOf);
  }
  async function material(identity: SpaceIdentity, activityId: string, materialId: string): Promise<PersonalMaterial> {
    await open(identity, activityId); z.uuid().parse(materialId);
    const { rows: [elsewhere] } = await storage.read('SELECT activity_id FROM personal_materials WHERE material_id=$1', [materialId]);
    if (elsewhere && elsewhere.activity_id !== activityId) return fail('forbidden');
    const { rows: [row] } = await storage.read(`SELECT * FROM personal_materials WHERE material_id=$1 AND activity_id=$2`,
      [materialId, activityId]);
    if (!row) return fail('missing');
    const fixed = await versions(materialId);
    const current = fixed.find(item => item.version === Number(row.current_version));
    if (!current) return fail('corrupt');
    return personalMaterialSchema.parse({ materialId, activityId, requestId: row.request_id, name: current.name,
      mediaType: current.mediaType, currentVersion: Number(row.current_version),
      createdAt: new Date(row.created_at as string).toISOString(),
      removedAt: row.removed_at ? new Date(row.removed_at as string).toISOString() : null, versions: fixed });
  }
  async function list(identity: SpaceIdentity, activityId: string): Promise<PersonalMaterial[]> {
    await open(identity, activityId);
    const { rows } = await storage.read(`SELECT material_id FROM personal_materials WHERE activity_id=$1 AND removed_at IS NULL
      ORDER BY created_at,material_id`, [activityId]);
    const result: PersonalMaterial[] = [];
    for (const row of rows) result.push(await material(identity, activityId, String(row.material_id)));
    return result;
  }
  async function original(identity: SpaceIdentity, activityId: string, materialId: string, version: number) {
    const fixed = await material(identity, activityId, materialId);
    const item = fixed.versions.find(candidate => candidate.version === version);
    if (!item) return fail('missing');
    let bytes: Uint8Array;
    try { bytes = await storage.readResource(resourceIdFor(materialId, version)); }
    catch (error) {
      if (error instanceof StorageError && ['missing', 'resource-gone'].includes(error.code)) return fail('missing');
      throw error;
    }
    if (hash(bytes) !== item.sha256 || bytes.byteLength !== item.byteLength) return fail('corrupt');
    return { material: fixed, version: item, text: decodeUtf8(bytes) };
  }
  async function receive(identity: SpaceIdentity, activityId: string, value: unknown): Promise<PersonalMaterial> {
    const input = personalMaterialSaveSchema.parse(value);
    await open(identity, activityId);
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (!bytes.length || bytes.length > PERSONAL_MATERIAL_LIMITS.inputBytes || bytes.toString('base64') !== input.dataBase64) return fail('invalid');
    const text = decodeUtf8(bytes), sha256 = hash(bytes);
    const fingerprint = digest({ activityId, ...input, dataBase64: sha256, text: hash(text) });
    const prior = await storage.receipt('personal-material-save:' + input.requestId, fingerprint);
    if (!prior) {
      const resource = await storage.stageResource({ uploadId: resourceIdFor(input.materialId, 1),
        scope: 'personal-material:' + activityId, bytes, mediaType: input.mediaType, contentVersion: 1 });
      await storage.request({ requestId: 'personal-material-save:' + input.requestId, fingerprint }, async tx => {
        await tx.query(`INSERT INTO personal_materials(material_id,activity_id,request_id,input_digest,current_version)
          VALUES($1,$2,$3,$4,1)`, [input.materialId, activityId, input.requestId, fingerprint]);
        await tx.query(`INSERT INTO personal_material_versions(material_id,version,request_id,input_digest,name,media_type,sha256,byte_length)
          VALUES($1,1,$2,$3,$4,$5,$6,$7)`, [input.materialId, input.requestId, fingerprint, input.name, input.mediaType,
          sha256, bytes.length]);
        await tx.reference(resourceReference(input.materialId, 1), resource.resourceId);
        return personalMaterialSchema.parse({ materialId: input.materialId, activityId, requestId: input.requestId,
          name: input.name, mediaType: input.mediaType, currentVersion: 1, createdAt: new Date().toISOString(),
          removedAt: null, versions: [{ materialId: input.materialId, version: 1, requestId: input.requestId,
            name: input.name, mediaType: input.mediaType, sha256, byteLength: bytes.length, createdAt: new Date().toISOString() }] });
      });
    }
    return material(identity, activityId, input.materialId);
  }
  async function update(identity: SpaceIdentity, activityId: string, materialId: string, value: unknown): Promise<PersonalMaterial> {
    const input = personalMaterialUpdateSchema.parse(value);
    if (input.materialId !== materialId) return fail('identity-conflict');
    const current = await material(identity, activityId, materialId);
    if (current.removedAt) return fail('invalid');
    if (current.currentVersion !== input.expectedVersion) return fail('identity-conflict');
    const latest = current.versions.find(item => item.version === input.expectedVersion)!;
    let bytes: Buffer | null = null, text: string | null = null, sha256 = latest.sha256;
    if (input.dataBase64 !== undefined) {
      bytes = Buffer.from(input.dataBase64, 'base64');
      if (!bytes.length || bytes.length > PERSONAL_MATERIAL_LIMITS.inputBytes || bytes.toString('base64') !== input.dataBase64)
        return fail('invalid');
      text = decodeUtf8(bytes); sha256 = hash(bytes);
    }
    const name = input.name ?? latest.name, mediaType = input.mediaType ?? latest.mediaType;
    const version = input.expectedVersion + 1;
    if (version > PERSONAL_MATERIAL_LIMITS.versions) return fail('invalid');
    const fingerprint = digest({ activityId, materialId, expectedVersion: input.expectedVersion, name, mediaType,
      dataBase64: bytes ? sha256 : null, text: text === null ? null : hash(text) });
    const prior = await storage.receipt('personal-material-update:' + input.requestId, fingerprint);
    if (!prior) {
      const source = bytes ?? await storage.readResource(resourceIdFor(materialId, input.expectedVersion));
      const resource = await storage.stageResource({ uploadId: resourceIdFor(materialId, version),
        scope: 'personal-material:' + activityId, bytes: source, mediaType, contentVersion: version });
      await storage.request({ requestId: 'personal-material-update:' + input.requestId, fingerprint }, async tx => {
        await tx.query('UPDATE personal_materials SET current_version=$2 WHERE material_id=$1', [materialId, version]);
        await tx.query(`INSERT INTO personal_material_versions(material_id,version,request_id,input_digest,name,media_type,sha256,byte_length)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [materialId, version, input.requestId, fingerprint, name, mediaType,
          sha256, source.byteLength]);
        await tx.reference(resourceReference(materialId, version), resource.resourceId);
        return null;
      });
    }
    return material(identity, activityId, materialId);
  }
  async function remove(identity: SpaceIdentity, activityId: string, materialId: string, value: unknown): Promise<PersonalMaterial> {
    const input = personalMaterialRemoveSchema.parse(value);
    if (input.materialId !== materialId) return fail('identity-conflict');
    const current = await material(identity, activityId, materialId);
    if (current.currentVersion !== input.expectedVersion) return fail('identity-conflict');
    const fingerprint = digest({ activityId, materialId, expectedVersion: input.expectedVersion, action: 'remove' });
    await storage.request({ requestId: 'personal-material-remove:' + input.requestId, fingerprint }, async tx => {
      await tx.query('UPDATE personal_materials SET removed_at=COALESCE(removed_at,clock_timestamp()) WHERE material_id=$1', [materialId]);
      return null;
    });
    return material(identity, activityId, materialId);
  }
  async function receipt(identity: SpaceIdentity, activityId: string, requestId: string): Promise<PersonalMaterial | null> {
    await open(identity, activityId); z.uuid().parse(requestId);
    const { rows: [created] } = await storage.read('SELECT material_id FROM personal_materials WHERE request_id=$1 AND activity_id=$2',
      [requestId, activityId]);
    const { rows: [changed] } = created ? { rows: [] } : await storage.read(
      'SELECT material_id FROM personal_material_versions WHERE request_id=$1', [requestId]);
    const materialId = created?.material_id ?? changed?.material_id;
    return materialId ? material(identity, activityId, String(materialId)) : null;
  }
  async function versionContent(identity: SpaceIdentity, activityId: string, materialId: string, version: number) {
    const fixed = await original(identity, activityId, materialId, version);
    return personalMaterialVersionContentSchema.parse({ material: fixed.material, version: fixed.version, text: fixed.text });
  }
  async function readRange(identity: SpaceIdentity, activityId: string, materialId: string, version: number, value: unknown) {
    const fixed = await original(identity, activityId, materialId, version);
    const input = personalMaterialReadSchema.parse(value);
    if (input.start > fixed.text.length) return fail('invalid');
    const end = Math.min(fixed.text.length, input.start + input.length);
    return personalMaterialReadResultSchema.parse({ materialId, version, sha256: fixed.version.sha256,
      name: fixed.version.name, mediaType: fixed.version.mediaType, start: input.start, end, total: fixed.text.length,
      text: fixed.text.slice(input.start, end), coordinates: 'utf16-code-units', readMethod: 'stored-text-range' });
  }
  return { list, material, receive, update, remove, receipt, original, versionContent, readRange };
}

/** Pure owner check used while accepting a question draft reference; never trusts browser copy. */
export async function verifyPersonalMaterialReference(storage: OwnedStorage, activityId: string, reference: QuestionReferenceInput) {
  const source = reference.source, range = reference.range;
  if (source.kind !== 'personal-material' || source.activityId !== activityId || range.kind !== 'text') throw new StorageError('invalid');
  const { rows: [row] } = await storage.read(`SELECT v.*, m.activity_id AS material_activity_id
    FROM personal_material_versions v JOIN personal_materials m ON m.material_id=v.material_id
    WHERE v.material_id=$1 AND v.version=$2`, [source.materialId, source.version]);
  if (!row) throw new StorageError('missing');
  if (row.material_activity_id !== activityId) throw new StorageError('invalid');
  const version = personalMaterialVersionSchema.parse({ materialId: row.material_id, version: Number(row.version),
    requestId: row.request_id, name: row.name, mediaType: row.media_type, sha256: row.sha256,
    byteLength: Number(row.byte_length), createdAt: new Date(row.created_at as string).toISOString() });
  if (version.sha256 !== source.sha256) throw new StorageError('identity-conflict');
  const bytes = await storage.readResource(resourceIdFor(source.materialId, source.version));
  if (hash(bytes) !== version.sha256 || bytes.byteLength !== version.byteLength) throw new StorageError('corrupt');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new StorageError('corrupt'); }
  if (range.end > text.length || text.slice(range.start, range.end) !== reference.copy) throw new StorageError('invalid');
  return version;
}

/** Restore verifies originals and metadata; a missing index can be rebuilt, never a missing original. */
export async function validatePersonalMaterials(storage: OwnedStorage) {
  const { rows: materials } = await storage.read('SELECT * FROM personal_materials');
  for (const row of materials) {
    const { rows: versions } = await storage.read('SELECT * FROM personal_material_versions WHERE material_id=$1 ORDER BY version',
      [row.material_id]);
    if (!versions.length || Number(row.current_version) !== Number(versions[versions.length - 1]!.version)) throw new StorageError('corrupt');
    for (const version of versions) {
      const fixed = personalMaterialVersionSchema.parse({ materialId: version.material_id, version: Number(version.version),
        requestId: version.request_id, name: version.name, mediaType: version.media_type, sha256: version.sha256,
        byteLength: Number(version.byte_length), createdAt: new Date(version.created_at as string).toISOString() });
      const bytes = await storage.readResource(resourceIdFor(fixed.materialId, fixed.version));
      if (hash(bytes) !== fixed.sha256 || bytes.byteLength !== fixed.byteLength) throw new StorageError('corrupt');
      const { rows: [link] } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1',
        [resourceReference(fixed.materialId, fixed.version)]);
      if (!link || link.resource_id !== resourceIdFor(fixed.materialId, fixed.version)) throw new StorageError('corrupt');
    }
  }
}
