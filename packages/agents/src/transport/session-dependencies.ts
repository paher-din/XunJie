import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { storageErrorCodes } from '@xunjie/contracts/storage';
import { agentDependencyCallSchema, parseAgentDependencyResult, requiresAgentDependencyDispatch,
  agentWorkspaceDataMethodSchema, agentWorkspaceCourseMethodSchema, agentDependencyDataResultSchemas, agentDependencyModelMethodSchema,
  agentDependencyMaterialResultSchemas, agentDependencyMaterialSelectionSchema, isAgentDependencyRead,
  agentDependencyToolOfferSchema, agentDependencyPreparedToolSchema,
  agentDependencyToolContextSchema,
  type AgentDependencyCall, type AgentDependencyResults } from '@xunjie/contracts/agent-dependencies';
import { agentDispatchPermitSchema, type AgentDispatchPermit } from '@xunjie/contracts/agent-runtime';
import { sameAgentSubject } from '@xunjie/contracts/agent-service';
import type { AgentSession, CreateAgentSession, UpdateAgentSession, MarkAgentSessionReady } from '@xunjie/contracts/agent-sessions';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { createChunkChannel, type ChunkConnectionSource, type ChunkAuthorityProjection, type ChunkChannelOptions } from '@xunjie/storage/chunk-channel';
import type { createAgentSessions } from '@xunjie/learning-space/learning-data/agent-sessions';
import type { createLearningData } from '@xunjie/learning-space/learning-data';
import type { ExecutionRecordEvent } from '@xunjie/contracts/execution-records';
import { createWorkspaceDataClient, createWorkspaceDataService } from './workspace-data.js';
import { agentExecutionAssociationSchema } from '@xunjie/contracts/execution';
import type { TeachingToolData } from '../workspace-assistant/tools/tool-data.js';
import type { WorkspaceToolOptions } from '../workspace-assistant/tools/module.js';
import { createLearningQuery, type LearningQuerySource } from '@xunjie/learning-space/learning-data/learning-query';
import { learningPageSchema, learningSearchSchema, learningReadSchema } from '@xunjie/contracts/student-learning';
import { createLearningModelService, createLearningModelClient, learningModelRequestSchema, type LearningModelPort } from '@xunjie/model-gateway/service';
import { modelLearningInputSchema, modelSegmentInputSchema, modelSessionAuthoritySchema } from '@xunjie/contracts/model-connections';
import { materialScopeSchema, type MaterialScopeInput, type SessionMaterialPort } from '@xunjie/contracts/session-materials';
import { personalMaterialReadSchema, materialSearchInputSchema } from '@xunjie/contracts/personal-materials';
import { pdfReadInputSchema, pdfFindInputSchema } from '@xunjie/contracts/pdf-materials';
import { activitySchema } from '@xunjie/contracts/learning-data';
import type { ConversationToolModule, ConversationToolContext, ConversationToolOutcome } from '../conversation/tools.js';
import { requireConversationModelStep } from '../conversation/basis.ts';

type Json = z.infer<ReturnType<typeof z.json>>;
function toolContext(value: z.infer<typeof agentDependencyToolContextSchema>): ConversationToolContext {
  return { ...value, snapshot: { ...value.snapshot, steps: value.snapshot.steps.map(step => ({ ...step,
    result: step.result ? { state: step.result.state, value: step.result.value,
      ...(step.result.retryAfterMs === undefined ? {} : { retryAfterMs: step.result.retryAfterMs }) } : null })) } };
}
function toolOutcome(value: AgentDependencyResults['tools.dispatch']): ConversationToolOutcome {
  const { wait, continuation, nextCommand, ...outcome } = value;
  return { ...outcome, ...(continuation === undefined ? {} : { continuation }),
    ...(nextCommand === undefined ? {} : { nextCommand }),
    ...(wait ? { wait: { kind: wait.kind, presentation: wait.presentation, deadline: wait.deadline,
      ...(wait.interruptible === undefined ? {} : { interruptible: wait.interruptible }) } } : {}) };
}
export interface AgentMaterialReadPort {
  personal: Pick<SessionMaterialPort['personal'], 'list' | 'material' | 'original' | 'versionContent' | 'readRange'>;
  pdf: Pick<SessionMaterialPort['pdf'], 'list' | 'document' | 'original' | 'reading'>;
}
export interface AgentDocumentMaterialsPort extends AgentMaterialReadPort {
  pdf: AgentMaterialReadPort['pdf'] & Pick<SessionMaterialPort['pdf'], 'read' | 'find'>;
  search: SessionMaterialPort['search'];
}
export interface AgentSessionDependencies {
  /** The same client scope used by model/domain RPCs, including implicit-effect permits. */
  withAuthority<T>(permit: AgentDispatchPermit, work: () => Promise<T>): Promise<T>;
  tools(): Promise<ConversationToolModule[]>;
  materials: AgentDocumentMaterialsPort;
  models: LearningModelPort;
  query: ReturnType<typeof createLearningQuery>;
  workspace(): Promise<AgentDependencyResults['workspace.activity']>;
  learning: TeachingToolData;
  courses: WorkspaceToolOptions['courses'];
}
export interface AgentDependencyClient {
  withAuthority<T>(permit: AgentDispatchPermit, work: () => Promise<T>): Promise<T>;
  source: { describe(identity: SpaceIdentity): Promise<AgentDependencyResults['source.describe']> };
  sessions: {
    create(identity: SpaceIdentity, args: CreateAgentSession): Promise<AgentSession>;
    read(identity: SpaceIdentity, sessionId: string): Promise<AgentSession>;
    list(identity: SpaceIdentity): Promise<AgentSession[]>;
    update(identity: SpaceIdentity, args: UpdateAgentSession): Promise<AgentSession>;
    markReady(identity: SpaceIdentity, args: MarkAgentSessionReady): Promise<AgentSession>;
  };
  authorize(identity: SpaceIdentity, sessionId: string): Promise<AgentDependencyResults['authorize']>;
  forSession(identity: SpaceIdentity, sessionId: string): AgentSessionDependencies;
  invoke<C extends AgentDependencyCall>(call: C): Promise<AgentDependencyResults[C['operation']]>;
}

type TrustedExecutionSource = Parameters<ReturnType<typeof createLearningData>['executionRecords']['sync']>[3];
export interface AgentDependencyServiceOptions {
  /** Authenticated executor publication is independent of an Agent session or live dispatch permit. */
  executionRecordSource?(identity: SpaceIdentity, activityId: string, event: Readonly<ExecutionRecordEvent>,
    source: Readonly<ChunkConnectionSource>): Promise<TrustedExecutionSource>;
  tools?(identity: SpaceIdentity, session: AgentSession, source: Readonly<ChunkConnectionSource>,
    call: Readonly<AgentDependencyCall>): readonly ConversationToolModule[] | Promise<readonly ConversationToolModule[]>;
  materials?: AgentDocumentMaterialsPort;
  models?: LearningModelPort;
  /** Resolve paired/native routing from this fixed session and the current authenticated peer. */
  modelsForSession?(identity: SpaceIdentity, session: AgentSession, source: Readonly<ChunkConnectionSource>,
    call: Readonly<Extract<AgentDependencyCall, { operation: 'model' }>>): LearningModelPort | Promise<LearningModelPort>;
  /** Host resolves actual data/course owners and current identity; a grant target is not a course owner. */
  source?(identity: SpaceIdentity): Promise<LearningQuerySource>;
  sessions: Pick<ReturnType<typeof createAgentSessions>, 'create' | 'read' | 'list' | 'update' | 'markReady'>;
  learning: ReturnType<typeof createLearningData>;
  courses: Parameters<typeof createWorkspaceDataService>[0]['courses'];
  authorize(identity: SpaceIdentity, source: Readonly<ChunkConnectionSource>): Promise<void>;
  resolveOwner?(identity: SpaceIdentity, scenario: CreateAgentSession['scenario'], workspace?: CreateAgentSession['workspace']): Promise<AgentSession['owner']>;
  /** Authenticated host proof for a restored installation; environment and service must still match. */
  isOwnerSuccessor?(owner: AgentSession['owner'], source: Readonly<ChunkConnectionSource>): Promise<boolean>;
  assertDispatch(identity: SpaceIdentity, permit: AgentDispatchPermit): Promise<void>;
}
async function executionSource(options: AgentDependencyServiceOptions,
  call: Extract<AgentDependencyCall, { operation: 'execution.record' }>, source: Readonly<ChunkConnectionSource>) {
  const { event, activityId } = call.args;
  if (!options.executionRecordSource || !source.sourceInstallationId
    || event.sourceOwner.environmentId !== source.sourceEnvironmentId || event.sourceOwner.serviceId !== source.sourceServiceId)
    throw new StorageError('forbidden');
  return options.executionRecordSource(call.identity, activityId, event, source);
}
async function readOwnerSource(options: AgentDependencyServiceOptions,
  call: Extract<AgentDependencyCall, { operation: 'source.read' }>): Promise<unknown> {
  if (!options.source) throw new StorageError('unavailable');
  const source = await options.source(call.identity);
  if (!sameAgentSubject(source.identity, call.identity)) throw new StorageError('forbidden');
  const args = call.args;
  if (args.method === 'records.history' || args.method === 'records.read') {
    const records = source.learning.executionRecords;
    if (!records) throw new StorageError('unavailable');
    return args.method === 'records.history' ? records.history(call.identity, args.activityId, args.cursor)
      : records.read(call.identity, args.activityId, args.requestId);
  }
  const conversations = source.ownerConversationRead;
  if (!conversations) throw new StorageError('unavailable');
  return args.method === 'conversations.list' ? conversations.list(call.identity, args.cursor)
    : conversations.read(call.identity, args.objectId, args.version);
}
const version = z.object({ version: z.literal(2) }).passthrough();
const failure = z.object({ error: z.enum(storageErrorCodes) }).strict();
function parseCall(value: unknown): AgentDependencyCall {
  if (!version.safeParse(value).success) throw new StorageError('incompatible');
  const parsed = agentDependencyCallSchema.safeParse(value);
  if (!parsed.success) throw new StorageError('invalid');
  return parsed.data;
}
async function ownerMatches(options: AgentDependencyServiceOptions, owner: AgentSession['owner'], source: Readonly<ChunkConnectionSource>) {
  if (owner.target.environmentId !== source.sourceEnvironmentId || owner.target.serviceId !== source.sourceServiceId) return false;
  return owner.installationId === source.sourceInstallationId || await options.isOwnerSuccessor?.(owner, source) === true;
}
async function assertOwner(options: AgentDependencyServiceOptions, session: AgentSession, identity: SpaceIdentity, source: Readonly<ChunkConnectionSource>) {
  if (!sameAgentSubject(session.identity, identity) || !await ownerMatches(options, session.owner, source)) throw new StorageError('forbidden');
}

/** Sender and receiver share this projection. Only the generation of one original operation can renew. */
export const agentDependencyAuthorityProjection: ChunkAuthorityProjection<AgentDispatchPermit> = {
  parse(value) {
    const parsed = agentDispatchPermitSchema.safeParse(value);
    if (!parsed.success) throw new StorageError('invalid');
    return parsed.data;
  },
  project(value, next) {
    const call = parseCall(value), current = 'permit' in call ? call.permit : undefined;
    next = this.parse(next);
    if (!current || ['sessionId', 'runId', 'stepId', 'operationId'].some(key => current[key as keyof AgentDispatchPermit] !== next[key as keyof AgentDispatchPermit]))
      throw new StorageError('identity-conflict');
    if (next.generation < current.generation) throw new StorageError('stale-generation');
    if (call.operation === 'model' && ['checks.receive', 'checks.dispatch'].includes(call.args.method)) {
      const args = [...call.args.args];
      if (call.args.method === 'checks.receive') {
        const input = modelLearningInputSchema.parse(args[0]);
        if (canonicalDigest(input.authority?.permit ?? null) !== canonicalDigest(current)) throw new StorageError('identity-conflict');
        args[0] = { ...input, authority: { formatVersion: 1, permit: next } } as Json;
      } else {
        if (canonicalDigest(modelSessionAuthoritySchema.parse(args[1]).permit) !== canonicalDigest(current)) throw new StorageError('identity-conflict');
        args[1] = { formatVersion: 1, permit: next };
      }
      return parseCall({ ...call, permit: next, args: { ...call.args, args } });
    }
    return parseCall({ ...call, permit: next });
  },
};

/** The host registers the ordinary storage chunk migration on this receiving learning owner. */
export function createAgentDependencyChannel(storage: OwnedStorage, options: AgentDependencyServiceOptions,
  channelOptions: Pick<ChunkChannelOptions, 'successor'> = {}) {
  const channel = createChunkChannel(storage), service = createAgentDependencyService(options);
  const readOnly = (value: unknown) => { const parsed = agentDependencyCallSchema.safeParse(value); return parsed.success && isAgentDependencyRead(parsed.data); };
  const handle = channel.wrap(service, { ...channelOptions, authority: agentDependencyAuthorityProjection, readOnly,
    async authorize(value, source) {
      const call = parseCall(value);
      if (!source.assertAuthorized) throw new StorageError('forbidden');
      await source.assertAuthorized(); await options.authorize(call.identity, source);
      if (call.operation === 'execution.record') { await executionSource(options, call, source); return; }
      if (call.operation === 'source.read') { await readOwnerSource(options, call); return; }
      if (call.operation === 'source.describe' || call.operation === 'sessions.list') return;
      let session: AgentSession;
      try { session = await options.sessions.read(call.identity, call.sessionId); }
      catch (error) {
        if (call.operation !== 'sessions.create' || !(error instanceof StorageError) || error.code !== 'missing') throw error;
        if (!options.resolveOwner || !await ownerMatches(options, await options.resolveOwner(call.identity, call.args.scenario, call.args.workspace), source))
          throw new StorageError('forbidden');
        return;
      }
      await assertOwner(options, session, call.identity, source);
      if (session.deleted) throw new StorageError('forbidden');
      // Retained bytes do not retain the original member's course permission. These are
      // current owner reads only; no dispatch/reconcile/cancellation handler is replayed.
      if (session.workspace && !call.operation.startsWith('sessions.') && call.operation !== 'authorize') {
        const activity = await options.learning.open(call.identity, session.workspace.activityId);
        if (canonicalDigest(activity.target) !== canonicalDigest(session.workspace.target)) throw new StorageError('forbidden');
      }
      if (call.operation === 'query.read') {
        if (!options.source || session.scenario !== 'student-assistant') throw new StorageError('forbidden');
        await createLearningQuery({ sources: async () => {
          const described = await options.source!(call.identity);
          if (!sameAgentSubject(described.identity, call.identity)) throw new StorageError('forbidden');
          return [described];
        } }).readLearning(call.args);
      }
    },
  });
  return {
    async handle(value: unknown, source: Readonly<ChunkConnectionSource>) {
      if (!source.assertAuthorized) throw new StorageError('forbidden');
      await source.assertAuthorized();
      return handle(value, source);
    },
    validate: () => channel.validate(readOnly),
  };
}

/** Version 2 is checked before authorization, owner lookup or any domain mutation. */
export function createAgentDependencyService(options: AgentDependencyServiceOptions) {
  async function sourceOf(identity: SpaceIdentity) {
    if (!options.source) throw new StorageError('unavailable');
    const source = await options.source(identity);
    if (!sameAgentSubject(source.identity, identity)) throw new StorageError('forbidden');
    return source;
  }
  async function workspace(identity: SpaceIdentity, session: AgentSession) {
    if (!session.workspace || session.scenario !== 'workspace-assistant' || session.deleted) throw new StorageError('forbidden');
    const activity = await options.learning.open(identity, session.workspace.activityId);
    if (activity.target.environmentId !== session.workspace.target.environmentId
      || activity.target.serviceId !== session.workspace.target.serviceId || !sameAgentSubject(activity.identity, identity)) throw new StorageError('identity-conflict');
    return activity;
  }
  async function dispatch(call: AgentDependencyCall, source: Readonly<ChunkConnectionSource>): Promise<unknown> {
    if (!source.assertAuthorized) throw new StorageError('forbidden');
    await source.assertAuthorized(); await options.authorize(call.identity, source);
    if (call.operation === 'execution.record') {
      const trusted = await executionSource(options, call, source);
      await options.learning.executionRecords.sync(call.identity, call.args.activityId, call.args.event, {
        ...trusted, async assertAuthorized() {
          await source.assertAuthorized!(); await options.authorize(call.identity, source);
          await executionSource(options, call, source); await trusted.assertAuthorized?.();
        },
      });
      return null;
    }
    if (call.operation === 'source.describe') {
      const described = await sourceOf(call.identity);
      if (!described.courses) throw new StorageError('unavailable');
      return { learningTarget: described.target, courseTarget: described.courses.owner, identity: described.identity,
        ...(described.ownerConversationRead ? { conversationOwner: described.ownerConversationRead.owner } : {}) };
    }
    if (call.operation === 'source.read') return readOwnerSource(options, call);
    if (call.operation === 'sessions.list') {
      const sessions = await options.sessions.list(call.identity);
      const allowed = await Promise.all(sessions.map(session => ownerMatches(options, session.owner, source)));
      return sessions.filter((_session, index) => allowed[index]);
    }
    if (call.operation === 'sessions.create') {
      let existing: AgentSession | undefined;
      try { existing = await options.sessions.read(call.identity, call.sessionId); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'missing') throw error; }
      if (existing) await assertOwner(options, existing, call.identity, source);
      else {
        if (!options.resolveOwner) throw new StorageError('unavailable');
        const owner = await options.resolveOwner(call.identity, call.args.scenario, call.args.workspace);
        if (!await ownerMatches(options, owner, source)) throw new StorageError('forbidden');
      }
      const created = await options.sessions.create(call.identity, call.args);
      await assertOwner(options, created, call.identity, source); return created;
    }
    const session = await options.sessions.read(call.identity, call.sessionId);
    await assertOwner(options, session, call.identity, source);
    const guard = async () => {
      if (!('permit' in call) || !call.permit || call.permit.sessionId !== call.sessionId || session.state !== 'ready' || session.deleted) throw new StorageError('forbidden');
      await source.assertAuthorized!(); await options.authorize(call.identity, source);
      const current = await options.sessions.read(call.identity, call.sessionId);
      await assertOwner(options, current, call.identity, source);
      if (current.deleted || current.state !== 'ready') throw new StorageError('forbidden');
      await options.assertDispatch(call.identity, call.permit);
    };
    if (requiresAgentDependencyDispatch(call)) await guard();
    if (call.operation.startsWith('tools.')) {
      if (session.deleted || !options.tools) throw new StorageError('forbidden');
      const modules = await options.tools(call.identity, session, source, call);
      if (new Set(modules.map(module => module.id)).size !== modules.length) throw new StorageError('identity-conflict');
      if (call.operation === 'tools.describe') return modules.map(({ id, version }) => ({ id, version }));
      if (!('module' in call.args)) throw new StorageError('invalid');
      const { module: descriptor } = call.args, context = toolContext(call.args.context);
      if (call.operation !== 'tools.list' || context.basisStepId !== null) requireConversationModelStep(context);
      const module = modules.find(module => module.id === descriptor.id && module.version === descriptor.version);
      if (!module) throw new StorageError('incompatible');
      if (context.snapshot.session.scenario !== session.scenario || context.snapshot.run.sessionId !== session.sessionId
        || context.snapshot.inputs.some(input => input.input.sessionId !== session.sessionId)
        || context.inputIds.some(id => !context.snapshot.inputs.some(input => input.inputId === id)))
        throw new StorageError('forbidden');
      if (session.scenario === 'workspace-assistant') {
        const actual = await workspace(call.identity, session), fixed = activitySchema.parse(context.context.facts.workspace);
        if (actual.activityId !== fixed.activityId || !sameAgentSubject(fixed.identity, call.identity)
          || canonicalDigest(actual.target) !== canonicalDigest(fixed.target)
          || canonicalDigest(actual.course ?? null) !== canonicalDigest(fixed.course ?? null)) throw new StorageError('forbidden');
      }
      if (call.operation === 'tools.list') return module.list(context);
      if (call.operation === 'tools.validateResponse') {
        if (!module.validateResponse) throw new StorageError('forbidden');
        await module.validateResponse(context, call.args.wait, call.args.answer); return null;
      }
      if (call.operation === 'tools.prepare') {
        const { offer, intent, commandId } = call.args;
        if (intent.name !== offer.definition.name || !(await module.list(context)).some(current => canonicalDigest(current) === canonicalDigest(offer)))
          throw new StorageError('incompatible');
        const command = agentDependencyPreparedToolSchema.parse(await module.prepare(context, offer, intent, commandId));
        if (command.commandId !== commandId || command.name !== intent.name || command.effect !== offer.effect) throw new StorageError('identity-conflict');
        return { ...command, input: { version: 2, module: descriptor, offer, prepared: command } };
      }
      if (!('command' in call.args)) throw new StorageError('invalid');
      const { command } = call.args;
      const fixed = z.object({ version: z.literal(2), module: z.object({ id: z.string(), version: z.number().int().positive() }).strict(),
        offer: agentDependencyToolOfferSchema, prepared: agentDependencyPreparedToolSchema }).strict().parse(command.input);
      if (canonicalDigest(fixed.module) !== canonicalDigest(descriptor) || command.commandId !== fixed.prepared.commandId
        || command.name !== fixed.prepared.name || command.effect !== fixed.prepared.effect) throw new StorageError('identity-conflict');
      const routed = (outcome: ConversationToolOutcome | null): ConversationToolOutcome | null => {
        if (!outcome?.nextCommand) return outcome;
        const next = agentDependencyPreparedToolSchema.parse(outcome.nextCommand);
        if (next.commandId === command.commandId || next.name !== fixed.prepared.name || next.effect !== fixed.prepared.effect)
          throw new StorageError('identity-conflict');
        // A continuation remains at this fixed data owner/module/offer. No new model preparation grants it authority.
        return { ...outcome, nextCommand: agentDependencyPreparedToolSchema.parse({ ...next, input: { ...fixed, prepared: next } }) };
      };
      if (call.operation === 'tools.reconcile') return routed(await module.reconcile(context, fixed.prepared));
      if (call.operation === 'tools.stop') return module.stop ? module.stop(context, fixed.prepared) : null;
      if (call.operation !== 'tools.dispatch' || !call.permit || call.permit.runId !== context.snapshot.run.runId
        || call.permit.operationId !== command.commandId || !context.snapshot.steps.some(step => step.stepId === call.permit!.stepId
          && step.operation.kind === 'tool.call' && step.operation.operationId === command.commandId)) throw new StorageError('forbidden');
      if (!(await module.list(context)).some(current => canonicalDigest(current) === canonicalDigest(fixed.offer))) throw new StorageError('incompatible');
      return routed(await module.dispatch(context, fixed.prepared, call.permit, guard));
    }
    switch (call.operation) {
      case 'sessions.read': return session;
      case 'sessions.update': return options.sessions.update(call.identity, call.args);
      case 'sessions.markReady': return options.sessions.markReady(call.identity, call.args);
      case 'authorize': return { authorized: true };
      case 'materials.read': {
        if (!options.materials || session.deleted) throw new StorageError('forbidden');
        const { scope, method, args } = call.args;
        if (scope.kind === 'session' ? scope.sessionId !== session.sessionId
          : scope.activityId !== session.workspace?.activityId || session.scenario !== 'workspace-assistant') throw new StorageError('forbidden');
        if (scope.kind === 'workspace') await workspace(call.identity, session);
        const id = () => z.uuid().parse(args[0]), version = () => z.number().int().positive().max(64).parse(args[1]);
        const { personal, pdf } = options.materials;
        switch (method) {
          case 'pdf.read': case 'pdf.find': {
            const input = method === 'pdf.read' ? pdfReadInputSchema.parse(args[0]) : pdfFindInputSchema.parse(args[0]);
            if (args.length !== 1 || !call.permit || ![call.permit.operationId, operationId('agent-document-reading:' + call.permit.operationId)].includes(input.requestId))
              throw new StorageError('identity-conflict');
            await guard();
            const result = method === 'pdf.read' ? await pdf.read(call.identity, scope, pdfReadInputSchema.parse(input))
              : await pdf.find(call.identity, scope, pdfFindInputSchema.parse(input));
            await guard(); return result;
          }
          case 'search': {
            const input = materialSearchInputSchema.parse(args[0]), selection = agentDependencyMaterialSelectionSchema.parse(args[1]);
            if (args.length !== 2 || input.scope.skillAttachments || scope.kind === 'session' && input.scope.courseMaterials) throw new StorageError('forbidden');
            for (const { source: reference } of [...selection.personalReferences, ...selection.pdfReferences]) {
              if ('scope' in reference ? canonicalDigest(reference.scope) !== canonicalDigest(scope)
                : scope.kind !== 'workspace' || reference.activityId !== scope.activityId) throw new StorageError('forbidden');
            }
            return options.materials.search(call.identity, scope, input, selection);
          }
          case 'personal.list': return personal.list(call.identity, scope);
          case 'personal.material': return personal.material(call.identity, scope, id());
          case 'personal.original': return personal.original(call.identity, scope, id(), version());
          case 'personal.versionContent': return personal.versionContent(call.identity, scope, id(), version());
          case 'personal.readRange': return personal.readRange(call.identity, scope, id(), version(), personalMaterialReadSchema.parse(args[2]));
          case 'pdf.list': return pdf.list(call.identity, scope);
          case 'pdf.document': return pdf.document(call.identity, scope, id());
          case 'pdf.reading': return pdf.reading(call.identity, scope, id());
          case 'pdf.original': {
            const [documentId, offset = 0] = z.tuple([z.uuid(), z.number().int().min(0).max(20 * 1024 * 1024).optional()]).parse(args);
            const original = await pdf.original(call.identity, scope, documentId), bytes = Buffer.from(original.bytes);
            if (offset >= bytes.length) throw new StorageError('invalid');
            const end = Math.min(bytes.length, offset + 4 * 1024 * 1024);
            return { document: original.document, dataBase64: bytes.subarray(offset, end).toString('base64'), offset,
              total: bytes.length, nextOffset: end < bytes.length ? end : null };
          }
        }
      }
      case 'model': {
        if (session.deleted) throw new StorageError('forbidden');
        const models = options.modelsForSession ? await options.modelsForSession(call.identity, session, source, call) : options.models;
        if (!models) throw new StorageError('forbidden');
        const request = learningModelRequestSchema.parse({ operation: call.args.method, identity: call.identity, args: call.args.args });
        const segment = async (id: unknown) => {
          const value = await models.segments.read(call.identity, z.uuid().parse(id));
          if (value.sessionId !== session.sessionId) throw new StorageError('forbidden');
          return value;
        };
        const method = call.args.method, args = call.args.args;
        if (method === 'segments.create') {
          const input = modelSegmentInputSchema.parse(args[0]);
          if (input.sessionId !== session.sessionId || input.purpose !== 'learning') throw new StorageError('forbidden');
          if (input.previousSegmentId) await segment(input.previousSegmentId);
        } else if (method.startsWith('segments.')) await segment(args[0]);
        if (method === 'checks.receive') {
          const input = modelLearningInputSchema.parse(args[0]);
          if (!call.permit || input.attemptId !== call.permit.operationId || canonicalDigest(input.authority?.permit ?? null) !== canonicalDigest(call.permit))
            throw new StorageError('identity-conflict');
          await segment(input.segmentId);
        } else if (method.startsWith('checks.')) {
          const fact = await models.checks.read(call.identity, z.uuid().parse(args[0]));
          if (fact.purpose !== 'learning' || fact.authority?.permit.sessionId !== session.sessionId || !fact.segment) throw new StorageError('forbidden');
          await segment(fact.segment.segmentId);
          if (method === 'checks.dispatch') {
            const authority = modelSessionAuthoritySchema.parse(args[1]);
            if (!call.permit || args[0] !== call.permit.operationId || canonicalDigest(authority.permit) !== canonicalDigest(call.permit)) throw new StorageError('identity-conflict');
          }
        }
        return createLearningModelService(models, async () => {
          await source.assertAuthorized!(); await options.authorize(call.identity, source);
          await assertOwner(options, await options.sessions.read(call.identity, session.sessionId), call.identity, source);
          if (requiresAgentDependencyDispatch(call)) await guard();
        })(request);
      }
      case 'query.list': case 'query.search': case 'query.read': {
        if (session.scenario !== 'student-assistant' || session.deleted) throw new StorageError('forbidden');
        const query = createLearningQuery({ sources: async () => [await sourceOf(call.identity)] });
        if (call.operation === 'query.list') return query.listLearningTasks(call.args);
        if (call.operation === 'query.search') return query.searchLearning(call.args);
        return query.readLearning(call.args);
      }
      case 'workspace.activity': return workspace(call.identity, session);
      case 'workspace.course': {
        const activity = await workspace(call.identity, session), course = activity.course;
        if (!course) throw new StorageError('forbidden');
        const first = call.args.args[0];
        const releaseId = first && typeof first === 'object' && !Array.isArray(first) ? first.releaseId : first;
        if (releaseId !== course.releaseId) throw new StorageError('forbidden');
        return createWorkspaceDataService({ learning: options.learning, courses: options.courses, assertWritable: guard })({
          operation: 'course', identity: call.identity, args: [call.args.method, call.args.args] });
      }
      case 'workspace.data': {
        const activity = await workspace(call.identity, session), args = call.args.args;
        if (args[0] !== activity.activityId) throw new StorageError('forbidden');
        const method = call.args.method;
        if (method === 'artifacts.publish' || method === 'pdf.read' || method === 'pdf.find') {
          const body = args[1] as Record<string, unknown> | undefined;
          if (!call.permit || body?.requestId !== call.permit.operationId) throw new StorageError('identity-conflict');
          if (method === 'artifacts.publish') {
            const origin = args[2] as Record<string, unknown> | undefined;
            if (origin?.runId !== call.permit.runId || origin.commandId !== call.permit.operationId) throw new StorageError('identity-conflict');
          }
        }
        if (method.startsWith('executions.')) {
          const id = z.uuid();
          if (method === 'executions.read') return options.learning.executions.read(call.identity, activity.activityId, id.parse(args[1]));
          if (method === 'executions.artifact') return options.learning.executions.artifact(call.identity, activity.activityId, id.parse(args[1]));
          if (method === 'executions.controlReceipt') return options.learning.executions.controlReceipt(call.identity, activity.activityId, id.parse(args[1]), id.parse(args[2]));
          const association = agentExecutionAssociationSchema.parse(args[1]);
          if (requiresAgentDependencyDispatch(call) && (association.runId !== call.permit!.runId || association.commandId !== call.permit!.operationId))
            throw new StorageError('identity-conflict');
          const context = { ...association, origin: { grantId: source.grantId, sourceEnvironmentId: source.sourceEnvironmentId,
            sourceServiceId: source.sourceServiceId, sourceInstallationId: z.uuid().parse(source.sourceInstallationId) },
            assertDispatch: requiresAgentDependencyDispatch(call) ? guard : async () => { throw new StorageError('forbidden'); } };
          const port = options.learning.executions.agent;
          if (method === 'executions.agent.dispatch') return port.dispatch(call.identity, activity.activityId, context, args[2]);
          const requestId = id.parse(args[2]);
          switch (method) {
            case 'executions.agent.control': return port.control(call.identity, activity.activityId, context, requestId, args[3]);
            case 'executions.agent.original': return port.original(call.identity, activity.activityId, context, requestId);
            case 'executions.agent.read': return port.read(call.identity, activity.activityId, context, requestId);
            case 'executions.agent.status': return port.status(call.identity, activity.activityId, context, requestId);
            case 'executions.agent.cleanupStatus': return port.cleanupStatus(call.identity, activity.activityId, context, requestId);
            case 'executions.agent.cleanup': return port.cleanup(call.identity, activity.activityId, context, requestId, args[3]);
          }
          throw new StorageError('invalid');
        }
        return createWorkspaceDataService({ learning: options.learning, courses: options.courses, assertWritable: guard })({
          operation: 'data', identity: call.identity, activityId: activity.activityId, args: [method, args] });
      }
    }
    throw new StorageError('invalid');
  }
  return async (value: unknown, source: Readonly<ChunkConnectionSource>): Promise<unknown> => {
    try { const call = parseCall(value); return parseAgentDependencyResult(call, JSON.parse(JSON.stringify((await dispatch(call, source)) ?? null))); }
    catch (error) { return { error: error instanceof StorageError ? error.code : error instanceof z.ZodError ? 'invalid' : 'unavailable' }; }
  };
}

export interface AgentDependencyClientOptions { permit?(): AgentDispatchPermit | undefined; }
export function createAgentDependencyClient(send: (call: AgentDependencyCall) => Promise<unknown>, options: AgentDependencyClientOptions = {}): AgentDependencyClient {
  const authority = new AsyncLocalStorage<AgentDispatchPermit>();
  const withAuthority: AgentDependencyClient['withAuthority'] = (permit, work) => authority.run(permit, work);
  async function invoke<C extends AgentDependencyCall>(call: C): Promise<AgentDependencyResults[C['operation']]> {
    const supplied = 'permit' in call ? call.permit : undefined;
    const permit = requiresAgentDependencyDispatch(call) ? supplied ?? options.permit?.() ?? authority.getStore() : supplied;
    const request = parseCall(permit ? { ...call, permit } : call);
    const value = await send(request), error = failure.safeParse(value);
    if (error.success) throw new StorageError(error.data.error);
    try { return parseAgentDependencyResult(call, value); }
    catch { throw new StorageError('incompatible'); }
  }
  return { withAuthority,
    source: { describe: identity => invoke({ version: 2, operation: 'source.describe', identity, args: {} }) }, sessions: {
    create: (identity: SpaceIdentity, args: CreateAgentSession) => invoke({ version: 2, operation: 'sessions.create', identity, sessionId: args.sessionId, args }),
    read: (identity: SpaceIdentity, sessionId: string) => invoke({ version: 2, operation: 'sessions.read', identity, sessionId, args: {} }),
    list: (identity: SpaceIdentity) => invoke({ version: 2, operation: 'sessions.list', identity, args: {} }),
    update: (identity: SpaceIdentity, args: UpdateAgentSession) => invoke({ version: 2, operation: 'sessions.update', identity, sessionId: args.sessionId, args }),
    markReady: (identity: SpaceIdentity, args: MarkAgentSessionReady) => invoke({ version: 2, operation: 'sessions.markReady', identity, sessionId: args.sessionId, args }),
  },
  authorize: (identity: SpaceIdentity, sessionId: string) => invoke({ version: 2, operation: 'authorize', identity, sessionId, args: {} }),
  forSession(identity: SpaceIdentity, sessionId: string) {
    const actor = (value: SpaceIdentity) => { if (!sameAgentSubject(value, identity)) throw new StorageError('forbidden'); };
    const jsonArgs = (args: unknown[]): Json[] => JSON.parse(JSON.stringify(args));
    const lower = createWorkspaceDataClient(async input => {
      if (!input.identity) throw new StorageError('invalid'); actor(input.identity);
      const args = jsonArgs(z.array(z.unknown()).parse(input.args[1]));
      if (input.operation === 'data') return invoke({ version: 2, operation: 'workspace.data', identity, sessionId,
        args: { method: agentWorkspaceDataMethodSchema.parse(input.args[0]), args } });
      if (input.operation === 'course') return invoke({ version: 2, operation: 'workspace.course', identity, sessionId,
        args: { method: agentWorkspaceCourseMethodSchema.parse(input.args[0]), args } });
      throw new StorageError('incompatible');
    });
    async function execution<M extends keyof typeof agentDependencyDataResultSchemas>(method: M, who: SpaceIdentity, args: unknown[]): Promise<z.infer<(typeof agentDependencyDataResultSchemas)[M]>> {
      actor(who); const value = await invoke({ version: 2, operation: 'workspace.data', identity, sessionId, args: { method, args: jsonArgs(args) } });
      return agentDependencyDataResultSchemas[method].parse(value) as z.infer<(typeof agentDependencyDataResultSchemas)[M]>;
    }
    const association = (context: Parameters<TeachingToolData['executions']['agent']['read']>[2]) => agentExecutionAssociationSchema.parse({
      runId: context.runId, stepId: context.stepId, snapshotId: context.snapshotId, commandId: context.commandId });
    async function material<M extends keyof typeof agentDependencyMaterialResultSchemas>(method: M, who: SpaceIdentity, scope: MaterialScopeInput, args: unknown[]): Promise<z.infer<(typeof agentDependencyMaterialResultSchemas)[M]>> {
      actor(who);
      const value = await invoke({ version: 2, operation: 'materials.read', identity, sessionId,
        args: { method, scope: materialScopeSchema.parse(typeof scope === 'string' ? { kind: 'workspace', activityId: scope } : scope), args: jsonArgs(args) } });
      return agentDependencyMaterialResultSchemas[method].parse(value) as z.infer<(typeof agentDependencyMaterialResultSchemas)[M]>;
    }
    const materials: AgentDocumentMaterialsPort = {
      personal: {
        list: (who, scope) => material('personal.list', who, scope, []),
        material: (who, scope, id) => material('personal.material', who, scope, [id]),
        original: (who, scope, id, version) => material('personal.original', who, scope, [id, version]),
        versionContent: (who, scope, id, version) => material('personal.versionContent', who, scope, [id, version]),
        readRange: (who, scope, id, version, range) => material('personal.readRange', who, scope, [id, version, range]),
      },
      pdf: {
        list: (who, scope) => material('pdf.list', who, scope, []),
        document: (who, scope, id) => material('pdf.document', who, scope, [id]),
        reading: (who, scope, id) => material('pdf.reading', who, scope, [id]),
        read: (who, scope, input) => material('pdf.read', who, scope, [pdfReadInputSchema.parse(input)]),
        find: (who, scope, input) => material('pdf.find', who, scope, [pdfFindInputSchema.parse(input)]),
        original: async (who, scope, id) => {
          let offset = 0, document: z.infer<(typeof agentDependencyMaterialResultSchemas)['pdf.original']>['document'] | undefined;
          const parts: Buffer[] = [];
          for (;;) {
            const value = await material('pdf.original', who, scope, [id, offset]), part = Buffer.from(value.dataBase64, 'base64');
            if (value.document.documentId !== id || value.offset !== offset || value.total !== value.document.byteLength
              || !part.length || part.toString('base64') !== value.dataBase64 || offset + part.length > value.total
              || value.nextOffset !== (offset + part.length < value.total ? offset + part.length : null)
              || document && canonicalDigest(document) !== canonicalDigest(value.document)) throw new StorageError('corrupt');
            document = value.document; parts.push(part); offset += part.length;
            if (value.nextOffset === null) {
              const bytes = Buffer.concat(parts);
              if (bytes.length !== value.total || createHash('sha256').update(bytes).digest('hex') !== value.document.sha256) throw new StorageError('corrupt');
              return { document: value.document, bytes };
            }
          }
        },
      },
      search: (who, scope, input, selection) => material('search', who, scope,
        [materialSearchInputSchema.parse(input), agentDependencyMaterialSelectionSchema.parse(selection ?? {})]),
    };
    const executions: TeachingToolData['executions'] = {
      read: (who, activityId, requestId) => execution('executions.read', who, [activityId, requestId]),
      artifact: (who, activityId, requestId) => execution('executions.artifact', who, [activityId, requestId]),
      controlReceipt: (who, activityId, requestId, controlId) => execution('executions.controlReceipt', who, [activityId, requestId, controlId]),
      agent: {
        dispatch: async (who, activityId, context, value) => { await context.assertDispatch(); return execution('executions.agent.dispatch', who, [activityId, association(context), value]); },
        control: async (who, activityId, context, requestId, value) => { await context.assertDispatch(); return execution('executions.agent.control', who, [activityId, association(context), requestId, value]); },
        original: (who, activityId, context, requestId) => execution('executions.agent.original', who, [activityId, association(context), requestId]),
        read: (who, activityId, context, requestId) => execution('executions.agent.read', who, [activityId, association(context), requestId]),
        status: (who, activityId, context, requestId) => execution('executions.agent.status', who, [activityId, association(context), requestId]),
        cleanupStatus: (who, activityId, context, requestId) => execution('executions.agent.cleanupStatus', who, [activityId, association(context), requestId]),
        cleanup: (who, activityId, context, requestId, value) => execution('executions.agent.cleanup', who, [activityId, association(context), requestId, value]),
      },
    };
    return {
    withAuthority,
    async tools() {
      const installed = await invoke({ version: 2, operation: 'tools.describe', identity, sessionId, args: {} });
      return installed.map<ConversationToolModule>(module => ({ ...module,
        list: context => invoke({ version: 2, operation: 'tools.list', identity, sessionId, args: { module, context } }),
        prepare: (context, offer, intent, commandId) => invoke({ version: 2, operation: 'tools.prepare', identity, sessionId,
          args: { module, context, offer: { definition: offer.definition, effect: offer.effect, scope: offer.scope }, intent, commandId } }),
        dispatch: async (context, command, permit, assertDispatch) => {
          await assertDispatch();
          return toolOutcome(await invoke({ version: 2, operation: 'tools.dispatch', identity, sessionId, permit, args: { module, context, command } }));
        },
        reconcile: async (context, command) => {
          const outcome = await invoke({ version: 2, operation: 'tools.reconcile', identity, sessionId, args: { module, context, command } });
          return outcome ? toolOutcome(outcome) : null;
        },
        stop: async (context, command) => {
          const outcome = await invoke({ version: 2, operation: 'tools.stop', identity, sessionId, args: { module, context, command } });
          return outcome ? toolOutcome(outcome) : null;
        },
        validateResponse: async (context, wait, answer) => { await invoke({ version: 2, operation: 'tools.validateResponse', identity, sessionId, args: { module, context, wait, answer } }); },
      }));
    },
    materials,
    models: createLearningModelClient(request => {
      actor(request.identity);
      return invoke({ version: 2, operation: 'model', identity, sessionId,
        args: { method: agentDependencyModelMethodSchema.parse(request.operation), args: jsonArgs(request.args) } });
    }),
    query: {
      listLearningTasks: (args = {}) => invoke({ version: 2, operation: 'query.list', identity, sessionId, args: learningPageSchema.parse(args) }),
      searchLearning: args => invoke({ version: 2, operation: 'query.search', identity, sessionId, args: learningSearchSchema.parse(args) }),
      readLearning: args => invoke({ version: 2, operation: 'query.read', identity, sessionId, args: learningReadSchema.parse(args) }),
    },
    workspace: () => invoke({ version: 2, operation: 'workspace.activity', identity, sessionId, args: {} }),
    learning: { ...lower.data, executions }, courses: lower.courses,
  }; }, invoke };
}
