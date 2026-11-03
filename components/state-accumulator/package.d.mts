import type { ComponentManifest } from '@xunjie/contracts/components';
export function accumulatorPackage(options?: { version?: 1 | 2 }): Promise<{ manifest: ComponentManifest; contentBase64: string }>;
