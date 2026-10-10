import { readRuntime, type RunnerTransport } from '../records/runner.ts';
import { domainError } from '../app/errors.ts';
export async function availableRuntime(runner?: RunnerTransport) {
  if (!runner) return undefined;
  try { return await readRuntime(runner); }
  catch (error) {
    const failure = domainError(error, 'DEPENDENCY_UNAVAILABLE');
    if (!['RUNTIME_NOT_READY', 'DEPENDENCY_UNAVAILABLE'].includes(failure.code)) throw failure;
    return undefined;
  }
}