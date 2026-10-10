import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readRuntime, type RunnerTransport } from '../records/runner.ts';
import { ApiError, domainError } from '../app/errors.ts';
import { runtimeReadinessSchema } from '../../contracts/design/index.ts';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceSchema = z.object({ data: z.object({ fingerprint: z.record(z.string(), z.unknown()),
  validation: z.object({ passed: z.literal(true), fingerprintHash: digest, validatedAt: z.iso.datetime() }) }) });
export async function availableRuntime(runner?: RunnerTransport) {
  if (!runner) return undefined;
  try {
    let response: unknown;
    const runtime = await readRuntime(async command => { response = await runner(command); return response; });
    const evidence = evidenceSchema.safeParse(response);
    if (!evidence.success) throw new ApiError('RUNTIME_NOT_READY');
    const { fingerprint, validation } = evidence.data.data;
    const source = digest.safeParse(fingerprint.sourceHash);
    const fingerprintHash = createHash('sha256').update(JSON.stringify(fingerprint), 'utf8').digest('hex');
    const checkedAt = new Date().toISOString();
    if (!source.success || validation.fingerprintHash !== fingerprintHash
      || Date.parse(validation.validatedAt) > Date.parse(checkedAt)) throw new ApiError('INVALID_REFERENCE');
    return { ...runtime, readiness: runtimeReadinessSchema.parse({ fingerprintHash, sourceHash: source.data,
      validatedAt: validation.validatedAt, checkedAt }) };
  } catch (error) {
    const failure = domainError(error, 'DEPENDENCY_UNAVAILABLE');
    if (!['RUNTIME_NOT_READY', 'DEPENDENCY_UNAVAILABLE'].includes(failure.code)) throw failure;
    return undefined;
  }
}
// Query outside SQL; only a new command applies the failure, after receipt replay.
export async function queryRuntime(runner?: RunnerTransport) {
  try {
    return { ok: true as const, runtime: await availableRuntime(runner) };
  } catch (error) {
    return { ok: false as const, error };
  }
}
