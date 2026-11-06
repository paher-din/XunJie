export interface FixedFile { path: string; content: string }
export interface Asset { bytes: number; sha256: string }
/**
 * A descriptor is served one of two ways. With `baseUrl` the package fetches its own files; with
 * `resources` the caller hands over every verified byte and nothing is ever fetched. A partial or
 * mistyped set is refused at creation, never completed from the network.
 */
export type RuntimeDescriptor = { identity: string; assets: Record<string, Asset>; adapters: Record<string, Asset> } & (
  { baseUrl: string; resources?: undefined }
  | { resources: Record<string, Uint8Array>; baseUrl?: undefined }
);
export interface Controls { signal?: AbortSignal; timeoutMs?: number; onStage?: (stage: string) => void }
export interface CompileRequest {
  top: string;
  sources: FixedFile[];
  entryFiles?: string[];
  options?: { includeDirs?: string[]; strictExprWidth?: boolean };
}
export interface CompilationArtifact {
  version: 1; dependencyId: string; bundleIdentity: string; program: Uint8Array; programSha256: string;
}
export interface Failure {
  status: 'failed' | 'stopped' | 'budget-exceeded';
  stage: string; code?: string; message?: string; diagnostics?: string[];
}
export interface Compiled { status: 'completed'; artifact: CompilationArtifact; diagnostics: string[]; stage: string }
export interface SimulationRequest {
  artifact: CompilationArtifact; files?: FixedFile[]; plusargs?: string[]; expectedIndices?: number[];
}
export interface Simulation {
  status: 'completed'; stage: string; diagnostics: string[]; dependencyId: string; output: string[]; vcd: string | null;
  observations: Array<{ index: number; f: string; cout: string } | { invalid: string }>;
  observationState: 'invalid' | 'unverified-coverage' | 'unavailable' | 'complete-with-unknown' | 'complete' | 'incomplete';
}
export declare function createIcarusRuntime(descriptor: RuntimeDescriptor): Promise<{
  compile(request: CompileRequest, controls?: Controls): Promise<(Compiled | Failure) & { cacheHit: boolean }>;
  simulate(request: SimulationRequest, controls?: Controls): Promise<Simulation | Failure>;
  clearCache(): void;
}>;
