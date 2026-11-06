import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { actionInputSchema, actionReceiptSchema } from '@xunjie/contracts/action-intents';
import { teachingAgentCallSchema, teachingAgentReceiverId, teachingConversationSchema, teachingEventSchema,
  teachingRunSchema, teachingSnapshotSchema, teachingStopInputSchema, teachingAgentCapabilitiesSchema, teachingDispatchAuthoritySchema,
  teachingStudentResponseInputSchema, teachingStudentResponseReceiptSchema,
  teachingStudentPresentationInputSchema, teachingStudentPresentationReceiptSchema,
  teachingInputControlSchema, teachingInputControlReceiptSchema, teachingControlReceiptSchema, teachingContinueInputSchema } from '@xunjie/contracts/teaching-agent';
import type { createTeachingAgent } from './index.js';

export type TeachingAgentPort = Pick<ReturnType<typeof createTeachingAgent>, 'receiver' | 'conversation' | 'events' | 'capabilities'
  | 'run' | 'stop' | 'continueRun' | 'request' | 'snapshot' | 'assertCommandDispatch' | 'assertModelDispatch'
  | 'respond' | 'response' | 'presentQuestion' | 'controlInput' | 'inputControlReceipt'>;
export type TeachingAgentCall = z.infer<typeof teachingAgentCallSchema>;
const ids = (values: unknown[], count: number) => z.array(z.uuid()).length(count).parse(values);

export function createTeachingAgentService(agent: TeachingAgentPort,
  authorize: (identity: SpaceIdentity, activityId: string) => Promise<void>) {
  return async (value: unknown): Promise<unknown> => {
    const call = teachingAgentCallSchema.parse(value), { identity, activityId, args } = call;
    await authorize(identity, activityId);
    switch (call.operation) {
      case 'accept': {
        const input = actionInputSchema.parse(args[0]), hash = z.string().regex(/^[a-f0-9]{64}$/).parse(args[1]);
        if (input.scope.environmentId !== identity.environmentId || input.scope.spaceId !== identity.spaceId
          || input.scope.principalId !== identity.principalId || input.scope.activityId !== activityId) throw new StorageError('forbidden');
        return agent.receiver.accept(input, hash);
      }
      case 'query': case 'cancel': {
        const requestId = z.uuid().parse(args[0]), hash = z.string().regex(/^[a-f0-9]{64}$/).parse(args[1]);
        const receipt = await agent.receiver.query(requestId, hash);
        if (receipt?.state === 'accepted' && !await agent.request(identity, activityId, requestId)) throw new StorageError('forbidden');
        return call.operation === 'query' ? receipt : agent.receiver.cancel(requestId, hash);
      }
      case 'conversation': return agent.conversation(identity, activityId, z.number().int().nonnegative().parse(args[0] ?? 0));
      case 'events': return agent.events(identity, activityId, z.number().int().nonnegative().parse(args[0] ?? 0));
      case 'capabilities': return agent.capabilities(identity, activityId);
      case 'run': return agent.run(identity, activityId, ids(args, 1)[0]!);
      case 'request': return agent.request(identity, activityId, ids(args, 1)[0]!);
      case 'snapshot': return agent.snapshot(identity, activityId, ids(args, 1)[0]!);
      case 'respond': return agent.respond(identity, activityId,
        z.uuid().parse(args[0]), teachingStudentResponseInputSchema.parse(args[1]));
      case 'response': return agent.response(identity, activityId, ids(args, 1)[0]!);
      case 'controlInput': return agent.controlInput(identity, activityId, z.uuid().parse(args[0]), teachingInputControlSchema.parse(args[1]));
      case 'inputControlReceipt': return agent.inputControlReceipt(identity, activityId, ids(args, 1)[0]!);
      case 'presentQuestion': return agent.presentQuestion(identity, activityId,
        z.uuid().parse(args[0]), teachingStudentPresentationInputSchema.parse(args[1]));
      case 'stop': return agent.stop(identity, activityId, z.uuid().parse(args[0]), teachingStopInputSchema.parse(args[1]));
      case 'continueRun': return agent.continueRun(identity, activityId, z.uuid().parse(args[0]), teachingContinueInputSchema.parse(args[1]));
      case 'assertCommandDispatch': {
        const { authority, ...association } = z.object({ runId: z.uuid(), stepId: z.uuid(), snapshotId: z.uuid(),
          commandId: z.uuid(), authority: teachingDispatchAuthoritySchema.optional() }).strict().parse(args[0]);
        await agent.assertCommandDispatch(identity, activityId, { ...association, ...(authority ? { authority } : {}) });
        return null;
      }
      case 'assertModelDispatch': {
        await agent.assertModelDispatch(identity, activityId, z.object({ runId: z.uuid(), activityId: z.uuid(),
          driverId: z.string().min(1).max(1000), generation: z.number().int().positive(), attemptId: z.uuid(), dispatch: z.boolean() }).strict().parse(args[0]));
        return null;
      }
    }
  };
}

export function createTeachingAgentClient(serviceId: string, identity: SpaceIdentity, activityId: string,
  call: (value: TeachingAgentCall) => Promise<unknown>): TeachingAgentPort {
  const invoke = (operation: TeachingAgentCall['operation'], args: unknown[] = []) => call({ version: 1, operation, identity, activityId, args });
  return {
    receiver: { identity: { receiverId: teachingAgentReceiverId(serviceId), kind: 'question', location: 'remote' },
      accept: async (input, hash) => actionReceiptSchema.parse(await invoke('accept', [input, hash])),
      query: async (id, hash) => actionReceiptSchema.nullable().parse(await invoke('query', [id, hash])),
      cancel: async (id, hash) => actionReceiptSchema.nullable().parse(await invoke('cancel', [id, hash])) },
    conversation: async (_identity, _activity, after = 0) => teachingConversationSchema.parse(await invoke('conversation', [after])),
    events: async (_identity, _activity, after = 0) => z.array(teachingEventSchema).parse(await invoke('events', [after])),
    capabilities: async () => {
      const { modelUnavailableReason, ...value } = teachingAgentCapabilitiesSchema.parse(await invoke('capabilities'));
      return { ...value, ...(modelUnavailableReason ? { modelUnavailableReason } : {}) };
    },
    run: async (_identity, _activity, id) => teachingRunSchema.parse(await invoke('run', [id])),
    stop: async (_identity, _activity, id, input) => teachingRunSchema.parse(await invoke('stop', [id, input])),
    continueRun: async (_identity, _activity, id, input) => teachingRunSchema.parse(await invoke('continueRun', [id, input])),
    request: async (_identity, _activity, id) => actionReceiptSchema.nullable().parse(await invoke('request', [id])),
    snapshot: async (_identity, _activity, id) => teachingSnapshotSchema.parse(await invoke('snapshot', [id])),
    respond: async (_identity, _activity, id, input) => teachingStudentResponseReceiptSchema.parse(
      await invoke('respond', [id, teachingStudentResponseInputSchema.parse(input)])),
    response: async (_identity, _activity, id) => teachingStudentResponseReceiptSchema.nullable().parse(await invoke('response', [id])),
    controlInput: async (_identity, _activity, id, input) => teachingInputControlReceiptSchema.parse(
      await invoke('controlInput', [id, teachingInputControlSchema.parse(input)])),
    inputControlReceipt: async (_identity, _activity, id) => teachingControlReceiptSchema.nullable().parse(await invoke('inputControlReceipt', [id])),
    presentQuestion: async (_identity, _activity, id, input) => teachingStudentPresentationReceiptSchema.parse(
      await invoke('presentQuestion', [id, teachingStudentPresentationInputSchema.parse(input)])),
    assertCommandDispatch: async (_identity, _activity, association) => { await invoke('assertCommandDispatch', [association]); },
    assertModelDispatch: async (_identity, _activity, authority) => { await invoke('assertModelDispatch', [authority]); },
  };
}
