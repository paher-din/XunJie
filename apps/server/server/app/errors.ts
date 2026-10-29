import { RunnerError } from '../../runner/snapshot.ts';
import { errorDefinitions } from '@xunjie/contracts/http';
import type { ApiErrorCode, ErrorResponse } from '@xunjie/contracts/http';

export class ApiError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode) {
    super(errorDefinitions[code].message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export function errorResponse(requestId: string, code: ApiErrorCode): ErrorResponse {
  const definition = errorDefinitions[code];
  return {
    requestId,
    error: { code, message: definition.message, retryable: definition.retryable, recovery: definition.recovery },
  };
}

export function domainError(error: unknown, fallback: ApiErrorCode): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof RunnerError && Object.hasOwn(errorDefinitions, error.code)) return new ApiError(error.code as ApiErrorCode);
  return new ApiError(fallback);
}