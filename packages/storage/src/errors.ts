import type { StorageErrorCode } from '@xunjie/contracts/storage';

/** Messages deliberately contain neither SQL, connection configuration nor object bytes. */
export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, readonly requestId?: string) {
    super(`Storage operation failed: ${code}`);
    this.name = 'StorageError';
  }
}

export function storageFailure(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const code = (error as { code?: string })?.code;
  if (code === '22P02' || code === '22003' || code === '22007' || code === '42601') return new StorageError('invalid');
  if (code === '23505' || code === '23503' || code === '40001' || code === '40P01' || code === '57014') return new StorageError('conflict');
  if (code === '42501' || code === '28P01') return new StorageError('forbidden');
  return new StorageError('unavailable');
}
