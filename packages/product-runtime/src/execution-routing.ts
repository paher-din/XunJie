import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { storageErrorCodes } from '@xunjie/contracts/storage';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { anyExecutionActionSchema, agentExecutionAssociationSchema, agentBrowserCommandSchema,
  executionControlSchema, executionStopSchema, executionQuerySchema, executionArtifactSchema,
  executionControlReceiptSchema, type AnyExecutionAction } from '@xunjie/contracts/execution';
import type { TeachingToolData } from '@xunjie/learning-space';
import type { CapabilityHandler } from './connections.js';

type Executions = TeachingToolData['executions'];
type Context = Parameters<Executions['agent']['dispatch']>[2];
const context = agentExecutionAssociationSchema;
const read = { requestId: z.uuid() };
const agentRead = { ...read, context };
export const executionRoutingRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('agent.dispatch'), context, action: anyExecutionActionSchema,
    dispatchAuthorized: z.literal(true) }).strict(),
  z.object({ method: z.literal('agent.control'), ...agentRead, control: executionControlSchema,
    dispatchAuthorized: z.literal(true) }).strict(),
  z.object({ method: z.literal('agent.read'), ...agentRead, dispatchAuthorized: z.boolean() }).strict(),
  z.object({ method: z.literal('agent.original'), ...agentRead }).strict(),
  z.object({ method: z.literal('agent.status'), ...agentRead }).strict(),
  z.object({ method: z.literal('agent.cleanupStatus'), ...agentRead }).strict(),
  z.object({ method: z.literal('agent.cleanup'), ...agentRead, stop: executionStopSchema }).strict(),
  z.object({ method: z.literal('read'), ...read }).strict(),
  z.object({ method: z.literal('artifact'), ...read }).strict(),
  z.object({ method: z.literal('controlReceipt'), ...read, controlId: z.uuid() }).strict(),
]);
export type ExecutionRoutingRequest = z.infer<typeof executionRoutingRequestSchema>;
export type SchoolExecutionSource = Parameters<CapabilityHandler>[1];
export type SchoolExecutionAuthorization = {
  identity: SpaceIdentity; activityId: string; request: ExecutionRoutingRequest;
  source: SchoolExecutionSource; phase: 'read' | 'dispatch' | 'cleanup';
};

function fail(code: 'invalid' | 'forbidden' | 'identity-conflict' | 'unavailable'): never { throw new StorageError(code); }
const statusSchema = z.object({ cancelled: z.boolean(), claimed: z.boolean(), browserId: z.uuid().nullable() }).strict().nullable();
const querySchema = executionQuerySchema.nullable();
const failureSchema = z.object({ error: z.enum(storageErrorCodes) }).strict();
const noDispatch = async (): Promise<void> => fail('forbidden');
function sameScope(action: { scope: { environmentId: string; spaceId: string; principalId: string; activityId: string } },
  identity: SpaceIdentity, activityId: string) {
  const scope = action.scope;
  return scope.environmentId === identity.environmentId && scope.spaceId === identity.spaceId
    && scope.principalId === identity.principalId && scope.activityId === activityId;
}
function schoolAction(action: AnyExecutionAction) {
  if (action.receiver.location !== 'remote') return false;
  if (action.execution.plan.location !== 'native' || action.execution.plan.kind !== 'session') return fail('forbidden');
  return true;
}
function validateRequest(identity: SpaceIdentity, activityId: string, request: ExecutionRoutingRequest) {
  spaceIdentitySchema.parse(identity); z.uuid().parse(activityId);
  if (request.method === 'agent.dispatch') {
    if (!schoolAction(request.action) || !sameScope(request.action, identity, activityId)
      || request.action.execution.initiator.kind !== 'agent'
      || request.action.execution.initiator.principalId !== identity.principalId
      || request.action.requestId !== request.context.commandId) fail('forbidden');
  }
  if (request.method === 'agent.control' && request.control.controlId !== request.context.commandId) fail('identity-conflict');
}
function parseArgs(args: unknown): ExecutionRoutingRequest {
  const [method, value] = z.tuple([z.string(), z.record(z.string(), z.unknown())]).parse(z.json().parse(args));
  if (Object.hasOwn(value, 'method')) fail('invalid');
  return executionRoutingRequestSchema.parse({ ...value, method });
}
function wire(request: ExecutionRoutingRequest): [string, unknown] {
  const { method, ...value } = request;
  // Validate before JSON round-trip: functions inside action parameters must not disappear silently.
  return [method, JSON.parse(JSON.stringify(z.json().parse(value)))];
}
function decoded<T>(schema: z.ZodType<T>, value: unknown): T {
  const failure = failureSchema.safeParse(value);
  if (failure.success) throw new StorageError(failure.data.error);
  const parsed = schema.safeParse(value);
  if (!parsed.success) return fail('unavailable');
  return parsed.data;
}

/** No transport retries or owner fallback: the original owner must answer its own request. */
export function createExecutionRouting(options: {
  local: Executions;
  call(identity: SpaceIdentity, activityId: string, args: [string, unknown]): Promise<unknown>;
}): Executions {
  const local = options.local;
  async function invoke<T>(identity: SpaceIdentity, activityId: string, request: ExecutionRoutingRequest, schema: z.ZodType<T>) {
    validateRequest(identity, activityId, request);
    const value = decoded(schema, await options.call(identity, activityId, wire(request)));
    if (request.method === 'agent.original') {
      const original = value as z.infer<typeof agentBrowserCommandSchema> | null;
      if (original && (!schoolAction(original.action) || original.action.requestId !== request.requestId
        || !sameScope(original.action, identity, activityId) || original.association.runId !== request.context.runId))
        fail('identity-conflict');
    }
    if (request.method !== 'agent.original' && request.method !== 'agent.status' && request.method !== 'agent.cleanupStatus'
      && value !== null && typeof value === 'object' && 'scope' in value && 'requestId' in value) {
      const expected = request.method === 'agent.dispatch' ? request.action.requestId : request.requestId;
      if ((value as { requestId: unknown }).requestId !== expected
        || !sameScope(value as { scope: AnyExecutionAction['scope'] }, identity, activityId)) fail('identity-conflict');
    }
    if (request.method === 'controlReceipt' && value !== null) {
      const receipt = value as z.infer<typeof executionControlReceiptSchema>;
      if (receipt.controlId !== request.controlId || receipt.requestId !== request.requestId
        || receipt.query.requestId !== request.requestId || !sameScope(receipt.query, identity, activityId))
        fail('identity-conflict');
    }
    return value;
  }
  const fixedContext = (value: Context) => context.parse({ runId: value.runId, stepId: value.stepId,
    commandId: value.commandId, snapshotId: value.snapshotId });
  async function remote(identity: SpaceIdentity, activityId: string, ctx: Context, requestId: string, cleanup = false) {
    if (cleanup) return await local.agent.cleanupStatus(identity, activityId, ctx, requestId) === null;
    const original = await local.agent.original(identity, activityId, ctx, requestId);
    return original === null || schoolAction(original.action);
  }
  async function remoteReadPermit(ctx: Context) {
    try { await ctx.assertDispatch(); return true; }
    catch { return false; } // A failed new-effect permit never prevents a read of the original outcome.
  }
  return {
    read: async (identity, activityId, requestId) => {
      const value = await local.read(identity, activityId, requestId);
      return value ?? invoke(identity, activityId, { method: 'read', requestId }, querySchema);
    },
    artifact: async (identity, activityId, requestId) => {
      if (await local.read(identity, activityId, requestId)) return local.artifact(identity, activityId, requestId);
      return invoke(identity, activityId, { method: 'artifact', requestId }, executionArtifactSchema.nullable());
    },
    controlReceipt: async (identity, activityId, requestId, controlId) => {
      if (await local.read(identity, activityId, requestId)) return local.controlReceipt(identity, activityId, requestId, controlId);
      return invoke(identity, activityId, { method: 'controlReceipt', requestId, controlId }, executionControlReceiptSchema.nullable());
    },
    agent: {
      dispatch: async (identity, activityId, ctx, value) => {
        const action = anyExecutionActionSchema.parse(value);
        if (!schoolAction(action)) return local.agent.dispatch(identity, activityId, ctx, action);
        const request = parseArgs(wire(executionRoutingRequestSchema.parse({ method: 'agent.dispatch', context: fixedContext(ctx),
          action, dispatchAuthorized: true })));
        await ctx.assertDispatch();
        return invoke(identity, activityId, request, querySchema);
      },
      control: async (identity, activityId, ctx, requestId, value) => {
        if (!await remote(identity, activityId, ctx, requestId)) return local.agent.control(identity, activityId, ctx, requestId, value);
        const request = parseArgs(wire(executionRoutingRequestSchema.parse({ method: 'agent.control', context: fixedContext(ctx),
          requestId, control: value, dispatchAuthorized: true })));
        await ctx.assertDispatch();
        return invoke(identity, activityId, request, executionQuerySchema);
      },
      read: async (identity, activityId, ctx, requestId) => {
        if (!await remote(identity, activityId, ctx, requestId)) return local.agent.read(identity, activityId, ctx, requestId);
        const fixed = fixedContext(ctx);
        return invoke(identity, activityId, { method: 'agent.read', context: fixed, requestId,
          dispatchAuthorized: await remoteReadPermit(ctx) }, querySchema);
      },
      original: async (identity, activityId, ctx, requestId) => {
        const original = await local.agent.original(identity, activityId, ctx, requestId);
        if (original && !schoolAction(original.action)) return original;
        return invoke(identity, activityId, { method: 'agent.original', context: fixedContext(ctx), requestId },
          agentBrowserCommandSchema.nullable());
      },
      status: async (identity, activityId, ctx, requestId) => {
        if (!await remote(identity, activityId, ctx, requestId)) return local.agent.status(identity, activityId, ctx, requestId);
        return invoke(identity, activityId, { method: 'agent.status', context: fixedContext(ctx), requestId }, statusSchema);
      },
      cleanupStatus: async (identity, activityId, ctx, requestId) => {
        const value = await local.agent.cleanupStatus(identity, activityId, ctx, requestId);
        return value ?? invoke(identity, activityId, { method: 'agent.cleanupStatus', context: fixedContext(ctx), requestId }, statusSchema);
      },
      cleanup: async (identity, activityId, ctx, requestId, value) => {
        if (!await remote(identity, activityId, ctx, requestId, true)) return local.agent.cleanup(identity, activityId, ctx, requestId, value);
        return invoke(identity, activityId, { method: 'agent.cleanup', context: fixedContext(ctx), requestId,
          stop: executionStopSchema.parse(value) }, querySchema);
      },
    },
  };
}

/** The authorizer verifies local grants, course eligibility, teacher target, budgets and owner binding.
 * Cleanup authorizes only the original source/scope and stop; it must not require a new Agent permit.
 * Neither this handler nor its reconstructed guards contact the originating Agent.
 */
export function createSchoolExecutionHandler(options: {
  executions: Executions;
  authorize(input: SchoolExecutionAuthorization): Promise<void>;
}) {
  return async (identity: SpaceIdentity, activityId: string, args: unknown, source: SchoolExecutionSource): Promise<unknown> => {
    const request = parseArgs(args);
    validateRequest(identity, activityId, request);
    const origin = z.object({ sourceEnvironmentId: z.uuid(), sourceServiceId: z.uuid(),
      sourceInstallationId: z.uuid(), grantId: z.uuid() }).strict().parse({
      sourceEnvironmentId: source.sourceEnvironmentId, sourceServiceId: source.sourceServiceId,
      sourceInstallationId: source.sourceInstallationId, grantId: source.grantId });
    const phase = request.method === 'agent.cleanup' || request.method === 'agent.cleanupStatus' ? 'cleanup'
      : request.method === 'agent.dispatch' || request.method === 'agent.control' ? 'dispatch' : 'read';
    const authorize = async (next: SchoolExecutionAuthorization['phase']) => {
      await source.assertAuthorized?.();
      await options.authorize({ identity, activityId, request, source, phase: next });
    };
    await authorize(phase);
    const guard = async () => {
      if (!('dispatchAuthorized' in request) || !request.dispatchAuthorized) return fail('forbidden');
      await authorize('dispatch');
    };
    const ctx = 'context' in request ? { ...request.context, origin, assertDispatch: guard } : undefined;
    const e = options.executions;
    switch (request.method) {
      case 'agent.dispatch': return e.agent.dispatch(identity, activityId, ctx!, request.action);
      case 'agent.control': return e.agent.control(identity, activityId, ctx!, request.requestId, request.control);
      case 'agent.read': return e.agent.read(identity, activityId, ctx!, request.requestId);
      case 'agent.original': return e.agent.original(identity, activityId, { ...ctx!, assertDispatch: noDispatch }, request.requestId);
      case 'agent.status': return e.agent.status(identity, activityId, { ...ctx!, assertDispatch: noDispatch }, request.requestId);
      case 'agent.cleanupStatus': return e.agent.cleanupStatus(identity, activityId, { ...ctx!, assertDispatch: noDispatch }, request.requestId);
      case 'agent.cleanup': return e.agent.cleanup(identity, activityId, { ...ctx!, assertDispatch: noDispatch }, request.requestId, request.stop);
      case 'read': return e.read(identity, activityId, request.requestId);
      case 'artifact': return e.artifact(identity, activityId, request.requestId);
      case 'controlReceipt': return e.controlReceipt(identity, activityId, request.requestId, request.controlId);
    }
  };
}
