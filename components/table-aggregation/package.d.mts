import type { ComponentManifest } from '@xunjie/contracts/components';

export declare const sampleTable: { columns: string[]; rows: string[][] };
export declare function aggregationPackage(): Promise<{ manifest: ComponentManifest; contentBase64: string; algorithmBase64: string }>;
