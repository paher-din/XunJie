import type { ComponentManifest } from '@xunjie/contracts/components';
export function accumulatorPackage(): Promise<{ manifest: ComponentManifest; contentBase64: string }>;
