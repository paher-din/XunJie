import { z } from 'zod';
import { spaceIdentitySchema } from '@xunjie/contracts/spaces';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { activitySchema } from '@xunjie/contracts/learning-data';
import type { TeachingToolHost, TeachingToolScope, TeachingToolCleanupScope } from './tool-types.js';
import { StorageError } from '@xunjie/storage';
import { createLearningModelService, learningModelRequestSchema, type LearningModelPort, type LearningModelRequest, type LearningModelReply } from '../model-connections/service.js';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { teachingDependencyCallSchema, teachingPreparedToolSchema, teachingToolOutcomeSchema } from '@xunjie/contracts/teaching-agent';
import { modelToolSchema } from '@xunjie/contracts/model-connections';
export { teachingDependencyCallSchema } from '@xunjie/contracts/teaching-agent';

const scopeSchema = z.object({ environmentId: z.uuid(), spaceId: z.uuid(), principalId: z.uuid() }).strict();
export type TeachingDependencyCall = z.infer<typeof teachingDependencyCallSchema>;

/** Function capabilities stay local. The actual execution owner reconstructs the dispatch check. */
export function createTeachingDependencyClient(call: (input: TeachingDependencyCall) => Promise<unknown>) {
  const invoke = (operation: TeachingDependencyCall['operation'], identity: SpaceIdentity, args: unknown[] = []) => call({ version: 1, operation, identity, args });
  const operations = { definitions: 'tool.definitions', prepare: 'tool.prepare', dispatch: 'tool.dispatch', reconcile: 'tool.reconcile', stop: 'tool.stop' } as const;
  const tool = (operation: keyof typeof operations, scope: TeachingToolScope | TeachingToolCleanupScope, args: unknown[]) => {
    const { assertDispatch: _guard, authority, ...fixed } = scope;
    return call({ version: 1, operation: operations[operation], identity: scope.identity, activityId: scope.activity.activityId,
      ...(authority ? { authority } : {}), args: [fixed, ...args] });
  };
  const tools: TeachingToolHost = {
    definitions: async scope => z.array(modelToolSchema).parse(await tool('definitions', scope, [])),
    prepare: async (scope, intent, commandId) => teachingPreparedToolSchema.parse(await tool('prepare', scope, [intent, commandId])),
    dispatch: async (scope, command) => teachingToolOutcomeSchema.parse(await tool('dispatch', scope, [command])),
    reconcile: async (scope, command) => teachingToolOutcomeSchema.nullable().parse(await tool('reconcile', scope, [command])),
    stop: async (scope, command) => teachingToolOutcomeSchema.nullable().parse(await tool('stop', scope, [command])),
  };
  return { tools,
    async authorize(identity: SpaceIdentity) { await invoke('authorize', identity); },
    async authorizeActivity(identity: SpaceIdentity, activityId: string) {
      z.object({ authorized: z.literal(true) }).strict().parse(await call({ version: 1, operation: 'authorize', identity, activityId, args: [] }));
    },
    async identityFor(scope: z.infer<typeof scopeSchema> & { activityId?: string }) {
      const { environmentId, spaceId, principalId } = scope;
      return spaceIdentitySchema.parse(await call({ version: 1, operation: 'identityFor', scope: { environmentId, spaceId, principalId },
        ...(scope.activityId ? { activityId: scope.activityId } : {}), args: [] }));
    },
    async activity(identity: SpaceIdentity, activityId: string) { return activitySchema.parse(await invoke('activity', identity, [activityId])); },
  };
}

export function createTeachingDependencyService(options: {
  authorize(identity: SpaceIdentity): Promise<void>;
  identityFor(scope: z.infer<typeof scopeSchema>): Promise<SpaceIdentity>;
  activity(identity: SpaceIdentity, activityId: string): Promise<z.infer<typeof activitySchema>>;
  tools: TeachingToolHost;
  models: LearningModelPort;
  modelRequest?(request: LearningModelRequest): Promise<LearningModelReply>;
}) {
  const models = createLearningModelService(options.models, options.authorize);
  return async (value: unknown): Promise<unknown> => {
    const input = teachingDependencyCallSchema.parse(value);
    if (input.operation === 'identityFor') {
      const identity = await options.identityFor(scopeSchema.parse(input.scope));
      await options.authorize(identity);
      return identity;
    }
    const identity = spaceIdentitySchema.parse(input.identity);
    await options.authorize(identity);
    if (input.operation === 'authorize') {
      if (input.activityId) await options.activity(identity, input.activityId);
      return { authorized: true };
    }
    if (input.operation === 'activity') return options.activity(identity, z.uuid().parse(input.args[0]));
    if (input.operation === 'model') {
      const request = learningModelRequestSchema.parse(input.args[0]);
      if (JSON.stringify(request.identity) !== JSON.stringify(identity)) throw new StorageError('forbidden');
      return options.modelRequest ? options.modelRequest(request) : models(request);
    }
    if (input.operation.startsWith('tool.')) {
      const raw = z.object({ identity: spaceIdentitySchema, activity: input.operation === 'tool.stop'
        ? activitySchema.pick({ identity: true, activityId: true, course: true }) : activitySchema, input: actionInputSchema,
        runId: z.uuid(), stepId: z.uuid(), snapshotId: z.uuid(), segmentId: z.uuid().optional() }).strict().parse(input.args[0]);
      if (JSON.stringify(raw.identity) !== JSON.stringify(identity)) throw new StorageError('forbidden');
      if (input.authority && (input.authority.runId !== raw.runId || input.authority.activityId !== raw.activity.activityId))
        throw new StorageError('forbidden');
      if (input.operation === 'tool.dispatch' && !input.authority) throw new StorageError('forbidden');
      const { segmentId, ...fixed } = raw;
      if (input.operation === 'tool.stop') return options.tools.stop({ ...fixed, ...(segmentId ? { segmentId } : {}) }, teachingPreparedToolSchema.parse(input.args[1]));
      const scope: TeachingToolScope = { ...fixed, ...(segmentId ? { segmentId } : {}),
        ...(input.authority ? { authority: input.authority } : {}), activity: await options.activity(identity, raw.activity.activityId) };
      switch (input.operation) {
        case 'tool.definitions': return options.tools.definitions(scope);
        case 'tool.prepare': return options.tools.prepare(scope,
          z.object({ callId: z.string().min(1), name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) }).strict().parse(input.args[1]), z.uuid().parse(input.args[2]));
        case 'tool.dispatch': case 'tool.reconcile': {
          const command = teachingPreparedToolSchema.parse(input.args[1]);
          return options.tools[input.operation === 'tool.dispatch' ? 'dispatch' : 'reconcile'](scope, command);
        }
      }
    }
    throw new StorageError('missing');
  };
}
