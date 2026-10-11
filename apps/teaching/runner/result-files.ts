import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RunnerError, sha256, validatePath } from './snapshot.ts';

export type ResultFile = {
  relativeName: string;
  status: 'complete' | 'missing' | 'incomplete';
  text?: string;
  contentHash?: string;
  bytes?: number;
};

export function collectResultFiles(workDirectory: string, names: string[], remainingBytes: number,
  unitTerminated: boolean): ResultFile[] {
  if (!unitTerminated) throw new RunnerError('STATE_CONFLICT', 'Execution unit has not terminated');
  if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0 || remainingBytes > 65536) {
    throw new RunnerError('INVALID_CONFIGURATION', 'Invalid output budget');
  }
  names.forEach(validatePath);
  if (new Set(names).size !== names.length) {
    throw new RunnerError('INVALID_CONFIGURATION', 'Duplicate approved result file');
  }
  const root = resolve(workDirectory);
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) {
    throw new RunnerError('INVALID_CONFIGURATION', 'Result directory must be a trusted real directory');
  }
  return names.map(relativeName => {
    let descriptor: number | undefined;
    try {
      let current = root;
      const parts = relativeName.split('/');
      for (let index = 0; index < parts.length; index++) {
        current = join(current, parts[index]!);
        const status = lstatSync(current);
        if (status.isSymbolicLink() || (index < parts.length - 1 && !status.isDirectory())
          || (index === parts.length - 1 && !status.isFile())) {
          return { relativeName, status: 'incomplete' };
        }
      }
      descriptor = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(descriptor);
      if (!before.isFile()) return { relativeName, status: 'incomplete' };
      if (before.size > remainingBytes) throw new RunnerError('CONTENT_LIMIT', 'output_limit');
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      if (bytes.length > remainingBytes) throw new RunnerError('CONTENT_LIMIT', 'output_limit');
      remainingBytes -= bytes.length;
      if (before.size !== bytes.length || after.size !== before.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        return { relativeName, status: 'incomplete', bytes: bytes.length, contentHash: sha256(bytes) };
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return { relativeName, status: 'incomplete', bytes: bytes.length, contentHash: sha256(bytes) };
      }
      return { relativeName, status: 'complete', text, contentHash: sha256(bytes), bytes: bytes.length };
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      return { relativeName, status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'incomplete' };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  });
}
