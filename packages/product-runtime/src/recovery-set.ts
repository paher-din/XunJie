import { createHash, createHmac, randomUUID, timingSafeEqual, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { verifyRecovery } from './recovery-files.js';
import { RecoveryError } from './recovery.js';
import type { OwnerRecoveryData, RecoveryArtifact, RecoveryManifest } from './recovery-types.js';

export const recoverySetMemberSchema = z.object({
  installationId: z.uuid(), environmentId: z.uuid(), backupId: z.uuid(),
  directory: z.string().regex(/^[0-9a-f-]{36}$/i), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  boundaryAt: z.string(), services: z.array(z.string()).max(1000),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative() }).strict()).max(10000),
}).strict();
export const recoverySetManifestSchema = z.object({
  formatVersion: z.literal(1), setId: z.uuid(), createdAt: z.string(),
  sourceEnvironmentId: z.uuid(), members: z.array(recoverySetMemberSchema).min(1).max(64),
  authentication: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type RecoverySetMember = z.infer<typeof recoverySetMemberSchema>;
export type RecoverySetManifest = z.infer<typeof recoverySetManifestSchema>;

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const fail = (code: string): never => { throw new RecoveryError(code); };
const ownKeys = (value: object) => Object.keys(value).sort();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${ownKeys(object).map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function derivedKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) return fail('invalid-recovery-key');
  return createHmac('sha256', key).update('xunjie/recovery-set/v1/authentication').digest();
}
function authenticate(manifest: RecoverySetManifest, key: Uint8Array): string {
  const { authentication: _authentication, ...fields } = manifest;
  return createHmac('sha256', derivedKey(key)).update(canonical(fields)).digest('hex');
}
/** Reject duplicate JSON keys at any depth; JSON.parse otherwise silently drops them. */
function parseSetManifest(bytes: Uint8Array): unknown {
  if (bytes.byteLength > 4 * 1024 * 1024) return fail('recovery-set-corrupt');
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('recovery-set-corrupt'); }
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < source.length; i++) {
    const token = source[i];
    if (token === '{' || token === '[') { stack.push(token === '{' ? new Set() : null); if (stack.length > 64) return fail('recovery-set-corrupt'); }
    else if (token === '}' || token === ']') stack.pop();
    else if (token === '"') {
      const start = i++;
      while (i < source.length && source[i] !== '"') { if (source[i] === '\\') i++; i++; }
      let next = i + 1;
      while (next < source.length && /\s/.test(source[next]!)) next++;
      if (source[next] === ':') {
        const fields = stack.at(-1);
        if (!fields) return fail('recovery-set-corrupt');
        let parsed: string;
        try { parsed = JSON.parse(source.slice(start, i + 1)) as string; }
        catch { return fail('recovery-set-corrupt'); }
        if (fields.has(parsed)) return fail('recovery-set-corrupt');
        fields.add(parsed);
      }
    }
  }
  try { return JSON.parse(source); } catch { return fail('recovery-set-corrupt'); }
}
async function plainFile(path: string): Promise<Uint8Array> {
  const info = await lstat(path).catch(() => fail('recovery-set-member-missing'));
  if (!info.isFile() || info.isSymbolicLink()) return fail('recovery-set-corrupt');
  return readFile(path);
}
/** Copies only plain files; symlinks and traversal are refused before any destination write. */
async function copyTree(source: string, destination: string, prefix = ''): Promise<void> {
  const root = join(source, prefix);
  const entries = (await readdir(root).catch(() => fail('recovery-set-member-missing'))).sort();
  for (const name of entries) {
    if (!name || name === '.' || name === '..' || name.includes(sep) || name.includes('/') || name.includes('\\')) return fail('recovery-set-corrupt');
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const from = join(source, relativePath), to = join(destination, relativePath);
    const info = await lstat(from).catch(() => fail('recovery-set-member-missing'));
    if (info.isSymbolicLink()) return fail('recovery-set-corrupt');
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 });
      await copyTree(source, destination, relativePath);
    } else if (info.isFile()) await writeFile(to, await plainFile(from), { mode: 0o600, flag: 'wx' });
    else return fail('recovery-set-corrupt');
  }
}
function artifactFacts(value: RecoveryArtifact[]) {
  return value.map(item => ({ path: item.path, sha256: item.sha256, byteLength: item.byteLength }));
}

/** Links already-sealed, authenticated backups of several installations into one verifiable set. */
export async function sealRecoverySet(options: {
  directory: string; key: Uint8Array;
  members: readonly { installationId: string; environmentId: string; backupDirectory: string }[];
  setId?: string;
}): Promise<RecoverySetManifest> {
  const { key } = options;
  const root = resolve(options.directory);
  if (!options.members.length) return fail('recovery-set-member-missing');
  await mkdir(root, { recursive: true, mode: 0o700 });
  let existing: unknown;
  try { existing = await readFile(join(root, 'recovery-set.json')); } catch { /* absent is required */ }
  if (existing) return fail('recovery-set-exists');
  const members: RecoverySetMember[] = [];
  const seen = new Set<string>();
  for (const input of options.members) {
    const source = resolve(input.backupDirectory);
    let manifest: RecoveryManifest;
    try { manifest = await verifyRecovery(source, key); }
    catch { return fail('recovery-set-corrupt'); }
    if (manifest.source.installationId !== input.installationId || manifest.source.environmentId !== input.environmentId)
      return fail('recovery-set-identity-conflict');
    const keyId = `${input.installationId}/${manifest.backupId}`;
    if (seen.has(keyId) || seen.has(source)) return fail('recovery-set-duplicate-member');
    seen.add(keyId); seen.add(source);
    const raw = await plainFile(join(source, 'manifest.json'));
    const directory = manifest.backupId;
    const target = join(root, 'members', directory);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, 'manifest.json'), raw, { mode: 0o600, flag: 'wx' });
    await mkdir(join(target, 'artifacts'), { recursive: true, mode: 0o700 });
    await copyTree(join(source, 'artifacts'), join(target, 'artifacts'));
    members.push({ installationId: input.installationId, environmentId: input.environmentId,
      backupId: manifest.backupId, directory, manifestSha256: sha(raw), boundaryAt: manifest.boundaryAt,
      services: manifest.services.map(item => item.serviceId).sort(), artifacts: artifactFacts(manifest.artifacts) });
  }
  members.sort((a, b) => a.installationId.localeCompare(b.installationId) || a.backupId.localeCompare(b.backupId));
  const manifest = recoverySetManifestSchema.parse({ formatVersion: 1, setId: options.setId ?? randomUUID(),
    createdAt: new Date().toISOString(), sourceEnvironmentId: options.members[0]!.environmentId,
    members, authentication: '0'.repeat(64) });
  manifest.authentication = authenticate(manifest, key);
  await writeFile(join(root, 'recovery-set.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
  return manifest;
}

/** Every member must be present, authenticated and byte-identical to the linked manifest. */
export async function verifyRecoverySet(directory: string, key: Uint8Array): Promise<{
  manifest: RecoverySetManifest; members: { member: RecoverySetMember; manifest: RecoveryManifest }[];
}> {
  const root = resolve(directory);
  const parsed = recoverySetManifestSchema.safeParse(parseSetManifest(await plainFile(join(root, 'recovery-set.json'))));
  if (!parsed.success) return fail('recovery-set-corrupt');
  const manifest = parsed.data;
  const expected = Buffer.from(authenticate(manifest, key), 'hex');
  const actual = Buffer.from(manifest.authentication, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return fail('invalid-recovery-key');
  const names = new Set(manifest.members.map(item => item.directory));
  if (names.size !== manifest.members.length) return fail('recovery-set-corrupt');
  const present = (await readdir(join(root, 'members')).catch(() => fail('recovery-set-member-missing'))).sort();
  if (JSON.stringify(present) !== JSON.stringify([...names].sort())) return fail('recovery-set-member-missing');
  const members: { member: RecoverySetMember; manifest: RecoveryManifest }[] = [];
  for (const member of manifest.members) {
    const memberRoot = join(root, 'members', member.directory);
    let verified: RecoveryManifest;
    try { verified = await verifyRecovery(memberRoot, key); }
    catch { return fail('recovery-set-corrupt'); }
    if (verified.backupId !== member.backupId || verified.boundaryAt !== member.boundaryAt
      || verified.source.installationId !== member.installationId || verified.source.environmentId !== member.environmentId)
      return fail('recovery-set-corrupt');
    const raw = await plainFile(join(memberRoot, 'manifest.json'));
    if (sha(raw) !== member.manifestSha256) return fail('recovery-set-corrupt');
    if (JSON.stringify(artifactFacts(verified.artifacts)) !== JSON.stringify(member.artifacts)
      || JSON.stringify(verified.services.map(item => item.serviceId).sort()) !== JSON.stringify(member.services))
      return fail('recovery-set-corrupt');
    members.push({ member, manifest: verified });
  }
  return { manifest, members };
}

/** Fail closed before any isolated restore; each member keeps its own root and original identity. */
export async function restoreRecoverySetBundle(options: {
  setDirectory: string; key: Uint8Array;
  restores: readonly { installationId: string; restore: () => Promise<unknown> }[];
}): Promise<{ manifest: RecoverySetManifest; results: { installationId: string; result: unknown }[] }> {
  const { manifest } = await verifyRecoverySet(options.setDirectory, options.key);
  const expected = manifest.members.map(item => item.installationId).sort();
  const provided = options.restores.map(item => item.installationId).sort();
  if (JSON.stringify(expected) !== JSON.stringify(provided)) return fail('recovery-set-restore-mismatch');
  const results: { installationId: string; result: unknown }[] = [];
  for (const member of manifest.members) {
    const restore = options.restores.find(item => item.installationId === member.installationId);
    if (!restore) return fail('recovery-set-restore-mismatch');
    results.push({ installationId: member.installationId, result: await restore.restore() });
  }
  return { manifest, results };
}

export type { OwnerRecoveryData };
export const recoverySetMemberDirectory = (setDirectory: string, backupId: string) => join(resolve(setDirectory), 'members', backupId);
export const newRecoverySetKey = () => randomBytes(32);
