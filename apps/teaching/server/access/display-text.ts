/** Optional display metadata never substitutes for an identity or an authorization field. */
export function optionalDisplayText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
