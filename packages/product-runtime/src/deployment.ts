import { deploymentConfigurationSchema, runtimeModules } from '@xunjie/contracts/product-runtime';
import type { DeploymentConfiguration, RuntimeEnvironment, RuntimeModule, RuntimeStatus } from '@xunjie/contracts/product-runtime';
import type { InstalledConfiguration } from './runtime.js';

export function resolveDeployment(environment: Pick<RuntimeEnvironment, 'profile'>,
  configuration: Pick<InstalledConfiguration, 'deployment' | 'database' | 'agent'>): DeploymentConfiguration {
  if (configuration.deployment) return deploymentConfigurationSchema.parse(configuration.deployment);
  const modules: RuntimeModule[] = configuration.database.mode === 'none' ? []
    : environment.profile === 'agent' ? ['teaching-agent']
    : environment.profile === 'model' ? ['space-course', 'model-connection'] : [...runtimeModules];
  return { formatVersion: 1, modules, dependencies: configuration.agent
    ? { 'learning-data': { kind: 'connection', connectionId: configuration.agent.dependencyConnectionId } } : {} };
}

export function describeDeployment(environment: RuntimeEnvironment, configuration: InstalledConfiguration): NonNullable<RuntimeStatus['deployment']> {
  const deployment = resolveDeployment(environment, configuration);
  return { configuration: deployment, modules: runtimeModules.map(unit => {
    const service = environment.services.find(item => item.unit === unit);
    return { unit, enabled: deployment.modules.includes(unit), ...(service ? { serviceId: service.serviceId } : {}),
      retained: !!service && !deployment.modules.includes(unit) };
  }) };
}

export function validateDeployment(environment: Pick<RuntimeEnvironment, 'profile'>,
  configuration: Pick<InstalledConfiguration, 'deployment' | 'database' | 'agent'>): DeploymentConfiguration {
  const deployment = resolveDeployment(environment, configuration);
  const owns = (unit: RuntimeModule) => deployment.modules.includes(unit);
  if (environment.profile === 'school' && !owns('space-course'))
    throw new Error('A school deployment requires its identity and course module.');
  if (environment.profile === 'school' && owns('tool-execution') && !owns('learning-data'))
    throw new Error('A school executor requires its authorized learning-data module.');
  if (configuration.database.mode === 'none' && deployment.modules.length)
    throw new Error('The selected stateful deployment modules require PostgreSQL.');
  if (configuration.deployment && deployment.modules.length && !owns('space-course')
    && !(environment.profile === 'agent' && deployment.modules.every(unit => unit === 'teaching-agent')))
    throw new Error('This installation needs its own identity module; school identities still come from the connected school.');
  if (configuration.deployment && Object.keys(deployment.dependencies).some(unit =>
    environment.profile !== 'agent' || unit !== 'learning-data'))
    throw new Error('Use the scoped school, learning, Agent and model bindings for this composition.');
  if (owns('teaching-agent') && !owns('model-connection') && environment.profile !== 'agent')
    throw new Error('A combined Agent installation needs its model module; standalone Agents use their explicit dependency connection.');
  for (const [unit, dependency] of Object.entries(deployment.dependencies)) {
    if (dependency.kind === 'local' && !owns(unit as RuntimeModule))
      throw new Error(`The local ${unit} dependency is not enabled.`);
    if (dependency.kind === 'connection' && owns(unit as RuntimeModule))
      throw new Error(`The ${unit} dependency cannot have both a local and a remote owner.`);
  }
  return deployment;
}
