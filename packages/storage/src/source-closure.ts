import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from './errors.js';
import type { OwnedStorage } from './types.js';
import { canonicalDigest } from './identity.js';

export type SourceRow = Record<string, unknown>;
export interface SourceResourceFact { resourceId: string; sha256: string; byteLength: number; }
export type ReadSourceResource = (resourceId: string) => Promise<SourceResourceFact>;
export interface SourceSpec {
  table: string;
  kind: string;
  /** Columns forming the stable fixedId. Falls back to the row digest when none are present. */
  id: readonly string[];
  /** Columns forming the version. Falls back to the row digest when none are present. */
  version?: readonly string[];
  /** Override the resource bytes/facts attached to a row. */
  resources?: (row: SourceRow, read: ReadSourceResource) => Promise<SourceResourceFact[]>;
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const asRow = (value: unknown): SourceRow =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as SourceRow : {};
const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) if (typeof value === 'string' && value) return value;
  return undefined;
};

const resourceIdShape = z.string().regex(/^[a-f0-9]{64}$/);
export const ownerSourceEntrySchema = z.object({
  kind: z.string().min(1),
  environmentId: z.string(),
  spaceId: z.string().optional(),
  principalId: z.string().optional(),
  activityId: z.string().optional(),
  owner: z.string().min(1),
  fixedId: z.string().min(1),
  version: z.string(),
  digest: resourceIdShape,
  resources: z.array(z.object({
    resourceId: z.string(),
    sha256: z.string(),
    byteLength: z.number().int().nonnegative(),
  }).strict()),
}).strict();
export type OwnerSourceEntry = z.infer<typeof ownerSourceEntrySchema>;

export const ownerSourceClosureSchema = z.object({
  formatVersion: z.literal(1),
  kind: z.literal('xunjie.owner-sources/1'),
  owner: z.string().min(1),
  entries: z.array(ownerSourceEntrySchema),
}).strict();
export type OwnerSourceClosure = z.infer<typeof ownerSourceClosureSchema>;

/** Per-kind counts are derived from the entries, not stored on the closure wire format. */
export function sourceClosureCounts(closure: OwnerSourceClosure): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of closure.entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return counts;
}

/** A referenced original must be present: a dangling reference must not confirm a backup. */
export async function readSourceResource(storage: OwnedStorage, resourceId: string): Promise<SourceResourceFact> {
  const bytes = await storage.readResource(resourceId).catch(error => {
    const code = error instanceof StorageError ? error.code : (error as { code?: unknown } | null)?.code;
    throw code === 'missing' || code === 'resource-gone' ? new StorageError('corrupt') : error;
  });
  return { resourceId, sha256: sha256(bytes), byteLength: bytes.byteLength };
}

const resourceKeys = new Set(['resourceId', 'resource_id']);
function collectResourceIds(value: unknown, found: Set<string>, depth: number): void {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) collectResourceIds(item, found, depth + 1); return; }
  for (const [key, item] of Object.entries(value as SourceRow)) {
    if (resourceKeys.has(key) && typeof item === 'string' && item) found.add(item);
    else if (item && typeof item === 'object') collectResourceIds(item, found, depth + 1);
  }
}
export function resourceIdsFromRow(row: SourceRow): string[] {
  const found = new Set<string>();
  for (const column of ['resource_id', 'content_id'] as const) {
    const value = row[column];
    if (typeof value === 'string' && value) found.add(value);
  }
  collectResourceIds(row, found, 0);
  return [...found];
}

type Scope = Pick<OwnerSourceEntry, 'environmentId' | 'spaceId' | 'principalId' | 'activityId'>;
function scopeOf(row: SourceRow, ownerEnvironmentId: string): Scope {
  const body = asRow(row.body), scope = asRow(body.scope), identity = asRow(body.identity);
  const spaceId = firstString(row.space_id, scope.spaceId, identity.spaceId, body.spaceId);
  const principalId = firstString(row.principal_id, scope.principalId, identity.principalId, body.principalId);
  const activityId = firstString(row.activity_id, scope.activityId, body.activityId);
  const environmentId = firstString(row.space_environment_id, scope.environmentId, identity.environmentId,
    body.environmentId) ?? ownerEnvironmentId;
  return {
    environmentId,
    ...(spaceId !== undefined ? { spaceId } : {}),
    ...(principalId !== undefined ? { principalId } : {}),
    ...(activityId !== undefined ? { activityId } : {}),
  };
}

/** Join the source row's key columns into a stable composite ID, falling back to its digest. */
const pickKeyColumns = (row: SourceRow, columns: readonly string[]): string =>
  columns.map(column => row[column]).filter(value => value !== null && value !== undefined).map(String).join(':');

function isMissingResource(error: unknown): boolean {
  const code = error instanceof StorageError ? error.code : (error as { code?: unknown } | null)?.code;
  return code === 'missing' || code === 'resource-gone';
}

/**
 * Bodies may embed references to bytes another owner holds (course component entry/algorithm
 * manifests inside an execution action). This owner attests only bytes its own storage has staged;
 * a foreign reference stays in the row digest, and its owning owner covers the bytes. A reference
 * this owner once staged but can no longer read is a genuine dangling original and must fail.
 */
async function isForeignReference(storage: OwnedStorage, resourceId: string): Promise<boolean> {
  const { rows } = await storage.read('SELECT resource_id FROM _storage_resources WHERE resource_id=$1', [resourceId]);
  return rows.length === 0;
}

async function defaultResources(storage: OwnedStorage, row: SourceRow): Promise<SourceResourceFact[]> {
  const facts: SourceResourceFact[] = [];
  for (const resourceId of resourceIdsFromRow(row)) {
    try {
      const bytes = await storage.readResource(resourceId);
      facts.push({ resourceId, sha256: sha256(bytes), byteLength: bytes.byteLength });
    } catch (error) {
      if (!isMissingResource(error) || !(await isForeignReference(storage, resourceId))) throw error;
    }
  }
  return facts;
}

/** Reads only the owner's own tables. Never runs a model, tool, PDF render or network call. */
export async function collectSources(storage: OwnedStorage, owner: string, specs: readonly SourceSpec[]): Promise<OwnerSourceClosure> {
  const entries: OwnerSourceEntry[] = [];
  const read: ReadSourceResource = resourceId => readSourceResource(storage, resourceId);
  for (const spec of specs) {
    const { rows: [relation] } = await storage.read('SELECT to_regclass($1) AS relation', [spec.table]);
    if (!relation?.relation) continue;
    const { rows } = await storage.read(`SELECT * FROM ${spec.table}`);
    // pg timestamptz/bytea must become stable JSON values before the canonical digest.
    const facts = JSON.parse(JSON.stringify(rows)) as SourceRow[];
    for (const row of facts) {
      const resources = spec.resources ? await spec.resources(row, read) : await defaultResources(storage, row);
      resources.sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0);
      entries.push({
        kind: spec.kind,
        ...scopeOf(row, storage.owner.environmentId),
        owner,
        fixedId: pickKeyColumns(row, spec.id) || canonicalDigest(row),
        version: (spec.version && pickKeyColumns(row, spec.version)) || canonicalDigest(row),
        digest: canonicalDigest(row),
        resources,
      });
    }
  }
  entries.sort((a, b) => {
    for (const key of ['kind', 'owner', 'fixedId', 'version'] as const) {
      if (a[key] < b[key]) return -1;
      if (a[key] > b[key]) return 1;
    }
    return 0;
  });
  // Entries are plain JSON: fixedId/version/digest/resources are strings and numbers only.
  return { formatVersion: 1, kind: 'xunjie.owner-sources/1', owner, entries };
}

/** Re-derive the closure from the restored owner and require a canonical-equal match. */
export async function validateSources(storage: OwnedStorage, material: unknown,
  owner: string, specs: readonly SourceSpec[]): Promise<void> {
  const parsed = ownerSourceClosureSchema.safeParse(material);
  if (!parsed.success) throw new StorageError('corrupt');
  const actual = await collectSources(storage, owner, specs);
  if (canonicalDigest(parsed.data) !== canonicalDigest(actual)) throw new StorageError('corrupt');
}
