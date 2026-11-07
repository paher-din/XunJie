import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { componentInstanceId } from '@xunjie/contracts/components';
import { canonicalValue, executionActionV3Schema, plannedExecutionScope } from '@xunjie/contracts/execution';
import { isAluCodeWork } from '@xunjie/contracts/alu-learning';
import type { ComponentBinding } from '@xunjie/contracts/components';
import type { TeachingToolScope } from './tool-types.js';

/** The ALU contribution adapts its own controls; the Driver only sees declared course tools. */
export function aluVerificationSchema(scope: TeachingToolScope, binding: ComponentBinding): Record<string, unknown> | null {
  const manifest = binding.definition.manifest;
  if (manifest.formatVersion !== 3 || manifest.runtime.adapterId !== 'icarus-alu'
    || !manifest.runtime.operations.some(operation => operation.operationId === 'run-single')
    || plannedExecutionScope(scope.activity.course?.executionPlan, { key: binding.key, definitionDigest: binding.definition.digest,
      operationId: 'run-single', location: 'browser' }) !== 'allowed') return null;
  return { type: 'object', description: 'Verify the question\'s fixed student HDL with one declared input. This does not enable the student work or create a prediction. Fixed course contribution: '
      + JSON.stringify({ version: 1, componentVersion: manifest.version, definitionDigest: binding.definition.digest,
        adapterId: manifest.runtime.adapterId, adapterVersion: manifest.runtime.adapterVersion,
        bundleIdentity: manifest.runtime.bundleIdentity, executionPlan: scope.activity.course?.executionPlan }),
    required: ['componentKey', 'operationId', 'parameters'], additionalProperties: false,
    properties: { componentKey: { type: 'string', const: binding.key }, operationId: { type: 'string', const: 'run-single' },
      parameters: { type: 'object', required: ['A', 'B', 'M', 'S', 'Cin'], additionalProperties: false,
        properties: Object.fromEntries(Object.entries({ A: 15, B: 15, M: 1, S: 3, Cin: 1 })
          .map(([key, maximum]) => [key, { type: 'integer', minimum: 0, maximum }])) } } };
}

/** Fixed student bytes only; no state file, activation, testbench, prediction or student explanation is created. */
export function aluVerificationAction(scope: TeachingToolScope, binding: ComponentBinding, commandId: string,
  operationId: string, parameters: unknown) {
  const manifest = binding.definition.manifest, course = scope.activity.course;
  if (!aluVerificationSchema(scope, binding) || manifest.formatVersion !== 3 || !course?.executionPlan || operationId !== 'run-single')
    throw new StorageError('forbidden');
  const operation = manifest.runtime.operations.find(item => item.operationId === operationId)!;
  const code = (scope.input.works.some(file => file.kind === 'code') ? scope.input.works : scope.input.draft.bases)
    .filter(isAluCodeWork);
  if (!code.length || new Set(code.map(file => file.name)).size !== code.length
    || code.some(file => file.encoding !== 'utf8' || manifest.runtime.resources.some(resource => resource.path === file.name)))
    throw new StorageError('invalid');
  return executionActionV3Schema.parse({ protocolVersion: 3, kind: 'execution', requestId: commandId, scope: scope.input.scope,
    receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' },
    execution: { instance: { instanceId: componentInstanceId(scope.activity.activityId, binding.key), key: binding.key,
      componentId: manifest.componentId, componentVersion: manifest.version, definitionDigest: binding.definition.digest,
      hostApiVersion: manifest.hostApiVersion, stateVersion: manifest.stateVersion },
    operation: { operationId, effect: 'execute' }, parameters, basis: { works: structuredClone(code),
      runtime: { adapterId: manifest.runtime.adapterId, adapterVersion: manifest.runtime.adapterVersion,
        bundleIdentity: manifest.runtime.bundleIdentity, resources: manifest.runtime.resources },
      compile: operation.compile, observation: operation.observation,
      course: { releaseId: course.releaseId, planDigest: course.executionPlan.planDigest,
        behaviorRuleDigest: createHash('sha256').update(JSON.stringify(canonicalValue(course.requirements))).digest('hex') },
      expected: { stateContentId: null } },
    limits: { ...operation.budgets, concurrentJobs: manifest.budget.concurrentJobs, queuedJobs: manifest.budget.queuedJobs },
    plan: { planId: course.executionPlan.planId, planVersion: course.executionPlan.planVersion,
      planDigest: course.executionPlan.planDigest, location: 'browser', kind: 'job' },
    initiator: { kind: 'agent', principalId: scope.identity.principalId } } });
}
