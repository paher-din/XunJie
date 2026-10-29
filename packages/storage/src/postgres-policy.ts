/** Versions verified for the common transaction, resource and recovery implementation. */
export const supportedPostgresVersions = ['17.10', '17.11', '18.6'] as const;
export function isSupportedPostgresVersion(version: string): boolean {
  return (supportedPostgresVersions as readonly string[]).includes(version);
}
