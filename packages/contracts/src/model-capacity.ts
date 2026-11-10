/** Used only when neither the saved configuration nor model metadata supplies a value. */
export const modelCapacityDefaults = { contextWindow: 256 * 1024, maxOutputTokens: 64 * 1024 } as const;
export const maximumModelTokenCount = 10_000_000;

type Capacity = { contextWindow?: number | undefined; maxOutputTokens?: number | undefined };
export function resolveModelCapacity(input: Capacity, reference: Capacity = {}) {
  return {
    contextWindow: input.contextWindow ?? reference.contextWindow ?? modelCapacityDefaults.contextWindow,
    maxOutputTokens: input.maxOutputTokens ?? reference.maxOutputTokens ?? modelCapacityDefaults.maxOutputTokens,
  };
}

/** Blank is absent; null is invalid. Decimal suffixes must resolve to an exact positive integer. */
export function parseModelTokenCount(input: string | number | undefined): number | null | undefined {
  if (typeof input === 'number') return Number.isSafeInteger(input) && input > 0 ? input : null;
  const text = input?.trim() ?? '';
  if (!text) return undefined;
  if (text.length > 64) return null;
  const match = /^(\d+)(?:\.(\d+))?\s*([km]?)$/i.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? '';
  const factor = match[3]!.toLowerCase() === 'm' ? 1024n * 1024n : match[3]!.toLowerCase() === 'k' ? 1024n : 1n;
  const numerator = BigInt(match[1]! + fraction) * factor;
  const denominator = 10n ** BigInt(fraction.length);
  if (numerator % denominator !== 0n) return null;
  const value = numerator / denominator;
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

export function modelTokenCountError(input: string | number | undefined): string | undefined {
  const value = parseModelTokenCount(input);
  if (value === null) return '请输入正整数，或使用 K / M 后缀，例如 256K、1.5M。';
  if (value !== undefined && value > maximumModelTokenCount) return `不能超过 ${maximumModelTokenCount.toLocaleString('en-US')} token。`;
}

export function formatModelTokenCount(value: number): string {
  if (value % (1024 * 1024) === 0) return `${value / (1024 * 1024)}M`;
  if (value % 1024 === 0) return `${value / 1024}K`;
  return String(value);
}
