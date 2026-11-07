import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { StorageError } from '@xunjie/storage';
import { teachingSkillImportSchema, teachingSkillMetadataSchema, teachingSkillVersionSchema,
  teachingSkillLimits, type TeachingSkillImport, type TeachingSkillVersion } from '@xunjie/contracts/agent-skills';
import { canonicalDigest } from './identity.js';

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
export function skillFileBytes(file: TeachingSkillImport['files'][number]): Buffer {
  if (file.encoding === 'utf8') {
    // JSON can transport lone surrogates; their UTF-8 replacement would conceal a different source.
    const bytes = Buffer.from(file.content, 'utf8');
    if (bytes.toString('utf8') !== file.content) throw new StorageError('invalid');
    return bytes;
  }
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.toString('base64') !== file.content) throw new StorageError('invalid');
  return bytes;
}

/** Parses only the supplied inert file envelope; there are deliberately no filesystem APIs. */
export function parseTeachingSkillPackage(value: TeachingSkillImport) {
  const input = teachingSkillImportSchema.parse(value);
  const paths = new Set(input.files.map(file => file.path.toLowerCase()));
  let total = 0;
  const files = [...input.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const attachments = files.map(file => {
    // A path cannot simultaneously be a file and a directory (including case aliases).
    const parts = file.path.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) throw new StorageError('invalid');
    const bytes = skillFileBytes(file);
    total += bytes.length;
    if (bytes.length > teachingSkillLimits.fileBytes || total > teachingSkillLimits.packageBytes) throw new StorageError('invalid');
    return { path: file.path, encoding: file.encoding, mediaType: file.mediaType ?? (file.encoding === 'utf8'
      ? 'text/plain; charset=utf-8' : 'application/octet-stream'), byteLength: bytes.length, digest: hash(bytes) };
  });
  const skill = files.find(file => file.path === 'SKILL.md');
  if (!skill || skill.encoding !== 'utf8' || Buffer.byteLength(skill.content) > teachingSkillLimits.bodyBytes) throw new StorageError('invalid');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill.content);
  if (!frontmatter || !frontmatter[1] || frontmatter[1].length > 32768) throw new StorageError('invalid');
  let raw: unknown;
  try {
    const doc = parseDocument(frontmatter[1], { uniqueKeys: true, strict: true });
    if (doc.errors.length || doc.warnings.length) throw new StorageError('invalid');
    raw = doc.toJS({ maxAliasCount: 0 });
  } catch { throw new StorageError('invalid'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StorageError('invalid');
  const normalized = { ...raw as Record<string, unknown> };
  if (typeof normalized['allowed-tools'] === 'string') normalized['allowed-tools'] = normalized['allowed-tools'].trim().split(/\s+/).filter(Boolean);
  const metadata = teachingSkillMetadataSchema.parse(normalized);
  const basis = { source: input.source, packageVersion: input.packageVersion, metadata, files, attachments };
  return { ...basis, digest: canonicalDigest(basis) };
}

/** Restore validates original package bytes and metadata, independent of current selections. */
export function validateTeachingSkillVersion(value: unknown): TeachingSkillVersion {
  const fixed = teachingSkillVersionSchema.parse(value);
  const parsed = parseTeachingSkillPackage({ requestId: fixed.skillId, skillId: fixed.skillId,
    source: fixed.source, packageVersion: fixed.packageVersion, files: fixed.files });
  if (canonicalDigest({ ...parsed, skillId: fixed.skillId, version: fixed.version }) !== canonicalDigest(fixed)) throw new StorageError('corrupt');
  return fixed;
}
