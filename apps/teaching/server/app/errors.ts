import { errorDefinitions } from '../../contracts/common/http.ts';
import type { ApiErrorCode, ErrorResponse } from '../../contracts/common/http.ts';

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
