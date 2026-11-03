import type { ComponentManifest } from '@xunjie/contracts/components';
export function annotationPackage(): Promise<{ manifest: ComponentManifest; contentBase64: string }>;
