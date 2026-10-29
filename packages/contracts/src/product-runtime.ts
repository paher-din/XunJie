import { z } from 'zod';

export const runtimeProtocolVersion = 1 as const;
export const deploymentUnits = ['client', 'space-course', 'learning-data', 'teaching-agent', 'model-connection', 'tool-execution'] as const;

export const runtimeServiceSchema = z.object({
  environmentId: z.uuid(),
  serviceId: z.uuid(),
  unit: z.enum(deploymentUnits),
  endpoint: z.url(),
  protocolVersion: z.literal(runtimeProtocolVersion),
  capabilities: z.array(z.string().min(1)).max(100),
});
export type RuntimeService = z.infer<typeof runtimeServiceSchema>;

export const runtimeEnvironmentSchema = z.object({
  formatVersion: z.literal(1),
  environmentId: z.uuid(),
  installationId: z.uuid(),
  clientNamespace: z.string().min(1),
  profile: z.enum(['local', 'school', 'remote']),
  services: z.array(runtimeServiceSchema),
});
export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;

// Secret values belong to the host's private credential store, never to a wire descriptor.
export const runtimeConnectionSchema = z.object({
  connectionId: z.uuid(),
  sourceEnvironmentId: z.uuid(),
  sourceServiceId: z.uuid(),
  target: runtimeServiceSchema,
  requiredCapabilities: z.array(z.string().min(1)),
  optionalCapabilities: z.array(z.string().min(1)),
  credentialRef: z.string().min(1),
});
export type RuntimeConnection = z.infer<typeof runtimeConnectionSchema>;

export interface RuntimeDependencyStatus {
  name: string;
  required: boolean;
  state: 'ready' | 'unavailable';
  detail?: string;
}

export interface RuntimeStatus {
  state: 'installed' | 'starting' | 'ready' | 'degraded' | 'maintenance' | 'stopped' | 'failed' | 'uninstalled';
  environment: RuntimeEnvironment;
  dependencies: RuntimeDependencyStatus[];
  endpoint?: string;
  reason?: string;
}

export interface MaintenanceParticipantDescriptor {
  serviceId: string;
  schemaVersion: string;
  resourceRoots: string[];
  configurationRefs: string[];
}
