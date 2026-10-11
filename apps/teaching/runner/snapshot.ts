import { createHash } from 'node:crypto';

export type SnapshotFile = {
  fileId: string;
  path: string;
  documentVersion: number;
  text: string;
  contentHash: string;
};

export type Snapshot = {
  snapshotId: string;
  hashFormat: 'sha256-manifest-v1';
  hash: string;
  files: SnapshotFile[];
};

export class RunnerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}

export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function validatePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || /[\\\0]/.test(path) || /^[a-z]:/i.test(path)
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new RunnerError('INVALID_REFERENCE', 'Invalid project-relative path');
  }
}

export function manifestHash(files: SnapshotFile[]): string {
  const rows = [...files]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map(file => [file.fileId, file.path, file.documentVersion, file.contentHash]);
  return sha256(JSON.stringify(rows));
}

export function validateSnapshot(value: unknown): asserts value is Snapshot {
  if (!value || typeof value !== 'object') throw new RunnerError('INVALID_REQUEST', 'Snapshot is required');
  const snapshot = value as Snapshot;
  if (typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId
    || snapshot.hashFormat !== 'sha256-manifest-v1' || !Array.isArray(snapshot.files)) {
    throw new RunnerError('INVALID_REQUEST', 'Invalid snapshot envelope');
  }
  if (snapshot.files.length > 50) throw new RunnerError('CONTENT_LIMIT', 'Too many snapshot files');
  const paths = new Set<string>();
  const ids = new Set<string>();
  let bytes = 0;
  for (const file of snapshot.files) {
    if (!file || typeof file.fileId !== 'string' || !file.fileId
      || !Number.isSafeInteger(file.documentVersion) || file.documentVersion < 1
      || typeof file.text !== 'string') {
      throw new RunnerError('INVALID_REQUEST', 'Invalid snapshot file');
    }
    validatePath(file.path);
    if (paths.has(file.path) || ids.has(file.fileId)) {
      throw new RunnerError('INVALID_REFERENCE', 'Duplicate snapshot file');
    }
    paths.add(file.path);
    ids.add(file.fileId);
    bytes += Buffer.byteLength(file.text);
    if (bytes > 1024 * 1024) throw new RunnerError('CONTENT_LIMIT', 'Snapshot exceeds 1 MiB');
    if (file.contentHash !== sha256(file.text)) {
      throw new RunnerError('INVALID_REFERENCE', 'File content hash mismatch');
    }
  }
  if (snapshot.hash !== manifestHash(snapshot.files)) {
    throw new RunnerError('INVALID_REFERENCE', 'Snapshot manifest hash mismatch');
  }
}

export function compilerArgs(snapshot: Snapshot, entryFileId: string): string[] {
  validateSnapshot(snapshot);
  if (!snapshot.files.some(file => file.fileId === entryFileId && file.path.endsWith('.c'))) {
    throw new RunnerError('INVALID_REFERENCE', 'Entry must be a snapshot C source file');
  }
  const sources = snapshot.files.filter(file => file.path.endsWith('.c'))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return ['-std=c17', '-O0', '-Wall', '-Wextra', '-pedantic', '-static',
    ...sources.map(file => `/snapshot/${file.path}`), '-o', '/work/textscope'];
}
