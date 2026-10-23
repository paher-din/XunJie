export class CliError extends Error {
  constructor(stage, code, message, { retryable = false, recovery = '' } = {}) {
    super(message);
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
    this.recovery = recovery;
  }
}

export function resultEnvelope(toolVersion, command, extra) {
  const { ok = true, ...body } = extra;
  return { schema: 'xj-dev/result-v1', tool: { name: 'xj-dev', version: toolVersion }, command, ok, ...body };
}

export function failureEnvelope(toolVersion, command, error, extra = {}) {
  const failure = error instanceof CliError
    ? { stage: error.stage, code: error.code, message: error.message, retryable: error.retryable, ...(error.recovery ? { recovery: error.recovery } : {}) }
    : { stage: 'internal', code: 'INTERNAL_ERROR', message: String(error && error.message || error), retryable: false };
  return { schema: 'xj-dev/result-v1', tool: { name: 'xj-dev', version: toolVersion }, command, ok: false, failure,
    ...(Array.isArray(error && error.stages) ? { stages: error.stages } : {}), ...extra };
}

export function printResult(envelope, out = process.stdout) {
  out.write(JSON.stringify(envelope, null, 2) + '\n');
}

export function logLine(message, err = process.stderr) {
  err.write(`[xj-dev] ${message}\n`);
}
