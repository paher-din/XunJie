import { createHash } from 'node:crypto';
import { z } from 'zod';
import { modelContextPressure } from '@xunjie/contracts/model-connections';

export const nativeCapacitySchema = z.object({
  dispatchable: z.boolean(),
  reason: z.enum(['ok', 'context-window', 'transport-bytes', 'input-budget', 'output-budget']),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  inputEstimateTokens: z.number().int().nonnegative(),
  outputReserveTokens: z.number().int().nonnegative(),
  safetyMarginTokens: z.number().int().nonnegative(),
  pressure: z.number().nonnegative().nullable(),
  pressureState: z.enum(['ok', 'compact', 'blocked', 'unknown']),
  contextWindow: z.number().int().positive().nullable(),
  transportLimitBytes: z.number().int().positive(),
}).strict();

export function measureNativeCapacity(encoded: Uint8Array, contextWindow: number | null,
  outputReserveTokens: number, remainingInputTokens: number,
  safetyRate: number = 0.05): z.infer<typeof nativeCapacitySchema> {
  const transportLimitBytes = 1_000_000;
  const bytes = encoded.byteLength;
  const inputEstimateTokens = Math.ceil(bytes / 3);
  const pressure = modelContextPressure(inputEstimateTokens, outputReserveTokens, contextWindow, safetyRate);
  const safetyMarginTokens = pressure.safetyMarginTokens ?? 4096;
  const reason = bytes > transportLimitBytes ? 'transport-bytes'
    : inputEstimateTokens > remainingInputTokens ? 'input-budget'
    : outputReserveTokens < 1 ? 'output-budget'
    : contextWindow !== null && pressure.state === 'blocked'
      ? 'context-window' : 'ok';
  return { dispatchable: reason === 'ok', reason, bytes, inputEstimateTokens, outputReserveTokens,
    safetyMarginTokens, pressure: pressure.pressure, pressureState: pressure.state, contextWindow, transportLimitBytes,
    requestFingerprint: createHash('sha256').update(encoded).digest('hex') };
}
