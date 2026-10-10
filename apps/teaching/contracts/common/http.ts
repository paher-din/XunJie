export type SuccessResponse<T> = { requestId: string; data: T };

export const errorDefinitions = {
  INVALID_REQUEST: { status: 400, message: 'Invalid request.', retryable: false, recovery: 'Correct the request before retrying.' },
  UNAUTHENTICATED: { status: 401, message: 'Authentication required.', retryable: false, recovery: 'Sign in using a valid account.' },
  FORBIDDEN: { status: 403, message: 'Access denied.', retryable: false, recovery: 'Use an account authorized for this resource.' },
  VERSION_CONFLICT: { status: 409, message: 'Version conflict.', retryable: false, recovery: 'Read the current authorized version before retrying.' },
  IDEMPOTENCY_CONFLICT: { status: 409, message: 'Request key conflict.', retryable: false, recovery: 'Do not reuse a request key with different input.' },
  STATE_CONFLICT: { status: 409, message: 'Operation unavailable in the current state.', retryable: false, recovery: 'Read the current state before acting.' },
  RECOVERY_REQUIRED: { status: 409, message: 'Recovery required.', retryable: false, recovery: 'Synchronize the current recovery generation before acting.' },
  CONTENT_LIMIT: { status: 413, message: 'Request content exceeds the limit.', retryable: false, recovery: 'Reduce the request content.' },
  INVALID_REFERENCE: { status: 422, message: 'Invalid reference.', retryable: false, recovery: 'Use an authorized confirmed reference.' },
  INVALID_CONFIGURATION: { status: 422, message: 'Invalid configuration.', retryable: false, recovery: 'Correct the approved configuration.' },
  RUNTIME_NOT_READY: { status: 422, message: 'Runtime is not ready.', retryable: false, recovery: 'Wait for verified runtime readiness.' },
  RATE_LIMITED: { status: 429, message: 'Request rate limit reached.', retryable: false, recovery: 'Wait before explicitly retrying.' },
  BUDGET_EXHAUSTED: { status: 429, message: 'Model budget is unavailable.', retryable: false, recovery: 'Use the manual workflow or obtain approved quota.' },
  DEPENDENCY_UNAVAILABLE: { status: 503, message: 'Required capability is unavailable.', retryable: false, recovery: 'Use the manual workflow while unavailable; check the original request before explicitly retrying.' },
  PERSISTENCE_UNAVAILABLE: { status: 503, message: 'Persistence is unavailable.', retryable: false, recovery: 'Check the original request before explicitly retrying.' },
} as const;

export type ApiErrorCode = keyof typeof errorDefinitions;

export type ErrorResponse = {
  requestId: string;
  error: { code: ApiErrorCode; message: string; retryable: boolean; recovery: string };
};
