import type { ComponentManifest, ComponentPreparedManifest } from '@xunjie/contracts/components';
export function legacyAnnotationPackage(): Promise<{ manifest: ComponentManifest; contentBase64: string }>;
export function annotationPackage(): Promise<{ manifest: ComponentManifest; contentBase64: string }>;
export function preparedAnnotationPackage(): Promise<{
  manifest: ComponentPreparedManifest;
  contentBase64: string;
  dependencies: { resourceId: string; contentBase64: string }[];
}>;
export const highlightDependencyId: 'mark-js';
export const selfTestMaterial: { title: string; text: string };
