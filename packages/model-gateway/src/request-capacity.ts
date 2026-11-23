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
  compactionHeadroomTokens: z.number().int().nonnegative().nullable(),
  compactionHeadroomSource: z.enum(['route', 'estimated', 'unknown']),
  pressureBudgetTokens: z.number().int().nullable(),
  thresholdTokens: z.number().int().nullable(),
  retainTokens: z.number().int().nullable(),
}).strict();

/** Count image parts in an already encoded payload without decoding base64 bodies. */
export function encodedImageCount(encoded: Uint8Array): number {
  const text = Buffer.from(encoded).toString('utf8');
  return (text.match(/"(?:image_url|input_image)"\s*:|"type"\s*:\s*"image"/g) ?? []).length;
}
export function measureNativeCapacity(encoded: Uint8Array, contextWindow: number | null,
  outputReserveTokens: number, remainingInputTokens: number,
  safetyRate: number = 0.05, compactionHeadroomTokens?: number): z.infer<typeof nativeCapacitySchema> {
  const transportLimitBytes = 1_000_000;
  const bytes = encoded.byteLength;
  const inputEstimateTokens = Math.ceil(bytes / 3);
  const pressure = modelContextPressure(inputEstimateTokens, outputReserveTokens, contextWindow, safetyRate, compactionHeadroomTokens);
  const safetyMarginTokens = pressure.safetyMarginTokens ?? 4096;
  const compaction = pressure.compaction;
  // Final admission remains a model-owner concern: the physical context slice is C - R.
  // Compaction pressure is a separate planning threshold returned alongside it.
  const reason = bytes > transportLimitBytes ? 'transport-bytes'
    : inputEstimateTokens > remainingInputTokens ? 'input-budget'
    : outputReserveTokens < 1 ? 'output-budget'
    : contextWindow !== null && inputEstimateTokens > contextWindow - outputReserveTokens
      ? 'context-window' : 'ok';
  return { dispatchable: reason === 'ok', reason, bytes, inputEstimateTokens, outputReserveTokens,
    safetyMarginTokens, pressure: pressure.pressure, pressureState: pressure.state, contextWindow, transportLimitBytes,
    compactionHeadroomTokens: compaction?.compactionHeadroomTokens ?? null,
    compactionHeadroomSource: compaction?.compactionHeadroomSource ?? 'unknown',
    pressureBudgetTokens: compaction?.pressureBudgetTokens ?? null,
    thresholdTokens: compaction?.thresholdTokens ?? null,
    retainTokens: compaction?.retainTokens ?? null,
    requestFingerprint: createHash('sha256').update(encoded).digest('hex') };
}
