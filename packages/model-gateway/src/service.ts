import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { storageErrorCodes } from '@xunjie/contracts/storage';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelSegmentInputSchema, modelSessionAuthoritySchema, settleModelToolsSchema, modelSegmentCloseSchema,
  modelLearningInputSchema, modelImageInputSchema, modelImageRefSchema, modelSelectionSchema, modelChoiceSchema,
  modelAttemptSchema, modelConnectionSchema, modelProgressSchema, modelToolIntentSchema, modelSegmentBoundarySchema, modelSelectionSourceSchema } from '@xunjie/contracts/model-connections';
import type { createModelGateway } from './index.js';

type Gateway = Awaited<ReturnType<typeof createModelGateway>>;
/** Node-only learning boundary; no configuration, credentials or native resource access. */
export type LearningModelPort = {
  selection: Pick<Gateway['selection'], 'read' | 'snapshot' | 'resolveChoice' | 'pin' | 'pinSource' | 'pinned'>;
  segments: Pick<Gateway['segments'], 'create' | 'read' | 'settle' | 'close'>;
  checks: Pick<Gateway['checks'], 'receive' | 'read' | 'requestPayload' | 'progress' | 'summary' | 'dispatch' | 'cancel'>;
  results: Pick<Gateway['results'], 'retain'>;
  images: Pick<Gateway['images'], 'upload' | 'read'>;
};

// Explicit tuples prevent additional arguments from becoming hidden owner/dispatch overrides.
const argumentSchemas = {
  'selection.read': z.tuple([spaceIdentitySchema.optional()]),
  'selection.snapshot': z.tuple([z.number().int().nonnegative()]),
  'selection.pin': z.tuple([z.uuid(), z.number().int().nonnegative()]),
  'selection.pinSource': z.tuple([z.uuid(), z.number().int().nonnegative(), modelSelectionSourceSchema]),
  'selection.pinned': z.tuple([z.uuid(), z.number().int().nonnegative()]),
  'selection.resolve': z.tuple([modelSelectionSourceSchema]),
  'segments.create': z.tuple([modelSegmentInputSchema.refine(v => v.purpose === 'learning' && !('draft' in v.source)), modelSelectionSourceSchema.optional()]),
  'segments.read': z.tuple([z.uuid()]),
  'segments.settle': z.tuple([z.uuid(), settleModelToolsSchema]),
  'segments.close': z.tuple([z.uuid(), modelSegmentCloseSchema]),
  'checks.receive': z.tuple([modelLearningInputSchema]),
  'checks.read': z.tuple([z.uuid()]),
  'checks.requestPayload': z.tuple([z.uuid()]),
  'checks.progress': z.tuple([z.uuid()]),
  'checks.summary': z.tuple([z.uuid()]),
  'checks.dispatch': z.tuple([z.uuid(), modelSessionAuthoritySchema.optional()]),
  'checks.cancel': z.tuple([z.uuid()]),
  'results.retain': z.tuple([z.object({ requestId: z.uuid(), resultRef: z.uuid(), consumer: z.enum(['run', 'activity', 'delivery']), consumerId: z.uuid() }).strict()]),
  'images.upload': z.tuple([modelImageInputSchema]),
  'images.read': z.tuple([modelImageRefSchema]),
};
// Native requests are reconstructed JSON, not arbitrary SDK objects. Validate the supported
// protocol grammar before a remote request can enter the Agent's snapshot/log metadata.
const jsonObject = z.record(z.string(), z.json());
const imageUrl = z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }).strict() }).strict();
const textPart = z.object({ type: z.literal('text'), text: z.string() }).strict();
const inputText = z.object({ type: z.literal('input_text'), text: z.string() }).strict();
const inputImage = z.object({ type: z.literal('input_image'), image_url: z.string(), detail: z.enum(['auto', 'low', 'high']).optional() }).strict();
const toolFunction = z.object({ name: z.string(), description: z.string().optional(), parameters: jsonObject,
  strict: z.boolean().optional() }).strict();
const chatMessage = z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.union([textPart, imageUrl])), z.null()]),
  tool_call_id: z.string().optional(), reasoning_content: z.string().nullable().optional(), reasoning: z.string().nullable().optional(),
  reasoning_details: z.array(z.object({ type: z.literal('reasoning.text'), text: z.string(), format: z.string(), index: z.number().int().nonnegative() }).strict()).optional(),
  tool_calls: z.array(z.object({ id: z.string(), type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }).strict() }).strict()).optional() }).strict();
const responseStatus = z.enum(['in_progress', 'completed', 'incomplete']);
const annotation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url_citation'), start_index: z.number().int().nonnegative(), end_index: z.number().int().nonnegative(), title: z.string(), url: z.string() }).strict(),
  z.object({ type: z.literal('file_citation'), file_id: z.string(), filename: z.string(), index: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('container_file_citation'), container_id: z.string(), file_id: z.string(), filename: z.string(), start_index: z.number().int().nonnegative(), end_index: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('file_path'), file_id: z.string(), index: z.number().int().nonnegative() }).strict(),
]);
const responseItem = z.union([
  z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(z.union([inputText, inputImage]))]) }).strict(),
  z.object({ type: z.literal('function_call_output'), call_id: z.string(), output: z.union([z.string(), z.array(z.union([inputText, inputImage]))]) }).strict(),
  z.object({ type: z.literal('function_call'), id: z.string().optional(), call_id: z.string(), name: z.string(), arguments: z.string(), status: responseStatus.optional() }).strict(),
  z.object({ type: z.literal('reasoning'), id: z.string(), summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() }).strict()).optional(),
    content: z.array(z.object({ type: z.literal('reasoning_text'), text: z.string() }).strict()).optional(), encrypted_content: z.string().nullable().optional(), status: responseStatus.optional() }).strict(),
  z.object({ type: z.literal('message'), id: z.string(), role: z.literal('assistant'), status: responseStatus,
    content: z.array(z.union([z.object({ type: z.literal('output_text'), text: z.string(), annotations: z.array(annotation).optional(), logprobs: z.array(z.object({ token: z.string(), logprob: z.number(), bytes: z.array(z.number().int().min(0).max(255)).nullable().optional(), top_logprobs: z.array(z.object({ token: z.string(), logprob: z.number(), bytes: z.array(z.number().int().min(0).max(255)).nullable().optional() }).strict()).optional() }).strict()).optional() }).strict(),
      z.object({ type: z.literal('refusal'), refusal: z.string() }).strict()])) }).strict(),
]);
const anthropicImage = z.object({ type: z.literal('image'), source: z.object({ type: z.literal('base64'), media_type: z.literal('image/png'), data: z.string() }).strict() }).strict();
const anthropicPart = z.union([textPart, textPart.extend({ citations: z.array(z.never()).nullable().optional() }), anthropicImage,
  z.object({ type: z.literal('thinking'), thinking: z.string().nullable(), signature: z.string().nullable().optional() }).strict(),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: jsonObject }).strict(),
  z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), is_error: z.boolean(), content: z.array(z.union([textPart, anthropicImage])) }).strict(),
]);
const format = z.union([z.object({ type: z.literal('json_object') }).strict(),
  z.object({ type: z.literal('json_schema'), name: z.string(), schema: jsonObject, strict: z.boolean() }).strict()]);
const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const chatThinking = z.object({ type: z.enum(['enabled', 'disabled']) }).strict();
const thinking = z.discriminatedUnion('type', [
  z.object({ type: z.literal('disabled') }).strict(),
  z.object({ type: z.literal('adaptive') }).strict(),
  z.object({ type: z.literal('enabled'), budget_tokens: z.number().int().min(1024).optional() }).strict(),
]);
const toolChoice = z.union([z.enum(['auto', 'none']), z.object({ type: z.literal('function'), function: z.object({ name: z.string() }).strict() }).strict()]);
const nativeRequest = z.union([
  z.object({ model: z.string(), messages: z.array(chatMessage), max_tokens: z.number().int().positive().optional(),
    prompt_cache_key: z.string().min(1).max(200).optional(),
    max_completion_tokens: z.number().int().positive().optional(), stream: z.literal(true),
    stream_options: z.object({ include_usage: z.literal(true) }).strict(), thinking: chatThinking.optional(),
    reasoning_effort: effort.optional(), reasoning: z.object({ effort }).strict().optional(), enable_thinking: z.boolean().optional(),
    tools: z.array(z.object({ type: z.literal('function'), function: toolFunction }).strict()).optional(), tool_choice: toolChoice.optional(),
    response_format: z.union([z.object({ type: z.literal('json_object') }).strict(), z.object({ type: z.literal('json_schema'), json_schema: format.options[1].omit({ type: true }) }).strict()]).optional() }).strict()
    .refine(value => (value.max_tokens === undefined) !== (value.max_completion_tokens === undefined)),
  z.object({ model: z.string(), input: z.array(responseItem), instructions: z.string().optional(), max_output_tokens: z.number().int().positive(), stream: z.literal(true), store: z.literal(false),
    prompt_cache_key: z.string().min(1).max(200).optional(),
    reasoning: z.object({ effort }).strict().optional(),
    tools: z.array(toolFunction.extend({ type: z.literal('function') })).optional(),
    tool_choice: z.union([z.enum(['auto', 'none']), z.object({ type: z.literal('function'), name: z.string() }).strict()]).optional(),
    text: z.object({ format }).strict().optional() }).strict(),
  z.object({ model: z.string(), system: z.string().optional(), messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(anthropicPart)]) }).strict()),
    prompt_cache_key: z.string().min(1).max(200).optional(),
    max_tokens: z.number().int().positive(), stream: z.literal(true), thinking: thinking.optional(),
    tools: z.array(z.object({ name: z.string(), description: z.string(), input_schema: jsonObject, strict: z.boolean().optional() }).strict()).optional(),
    tool_choice: z.union([z.object({ type: z.enum(['auto', 'none']) }).strict(), z.object({ type: z.literal('tool'), name: z.string() }).strict()]).optional(),
    output_config: z.object({ format: z.object({ type: z.literal('json_schema'), schema: jsonObject }).strict().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional() }).strict()
      .refine(value => value.format !== undefined || value.effort !== undefined).optional() }).strict(),
]);
const learningAttempt = modelAttemptSchema.extend({ createdAt: z.iso.datetime() }).refine(value => value.purpose === 'learning');
const segment = z.object({ sessionId: z.uuid().optional(), segmentId: z.uuid(), formatVersion: z.literal(1), sequence: z.number().int().nonnegative(),
  connection: modelConnectionSchema, prefixDigest: z.string().regex(/^[a-f0-9]{64}$/), resultRef: z.uuid().nullable(),
  pending: z.boolean(), closed: z.boolean(), pendingTools: z.array(modelToolIntentSchema) }).strict();
const image = modelImageRefSchema.extend({ resourceId: z.uuid(), mediaType: z.literal('image/png'), byteLength: z.number().int().nonnegative().max(262144),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), source: modelImageRefSchema.extend({ transformation: z.string().min(1).max(200) }).optional() });
const resultSchemas = {
  'selection.read': modelSelectionSchema,
  'selection.snapshot': z.object({ choice: modelChoiceSchema, source: modelAttemptSchema.shape.source.unwrap() }).strict(),
  'selection.pin': z.object({ choice: modelChoiceSchema, source: modelAttemptSchema.shape.source.unwrap() }).strict(),
  'selection.pinSource': z.object({ choice: modelChoiceSchema, source: modelAttemptSchema.shape.source.unwrap() }).strict(),
  'selection.pinned': z.object({ choice: modelChoiceSchema, source: modelAttemptSchema.shape.source.unwrap() }).strict(),
  'selection.resolve': z.object({ choice: modelChoiceSchema, source: modelAttemptSchema.shape.source.unwrap() }).strict(),
  'segments.create': segment, 'segments.read': segment, 'segments.settle': segment,
  'segments.close': segment.extend({ boundary: modelSegmentBoundarySchema }),
  'checks.receive': learningAttempt, 'checks.read': learningAttempt, 'checks.dispatch': learningAttempt, 'checks.cancel': learningAttempt,
  'checks.requestPayload': nativeRequest,
  'checks.progress': modelProgressSchema.nullable(),
  'checks.summary': z.object({ source: z.literal('model-native'), text: z.string().max(16000), truncated: z.boolean() }).strict().nullable(),
  'results.retain': z.null(), 'images.upload': image, 'images.read': image,
};
/** Shared by clients and durable device receipts. No successful network value bypasses its operation schema. */
export function parseLearningModelResult(operation: LearningModelOperation, value: unknown): unknown {
  z.json().parse(value);
  return resultSchemas[operation].parse(value);
}

export type LearningModelOperation = keyof typeof argumentSchemas;
export const learningModelOperationSchema = z.enum(Object.keys(argumentSchemas) as [LearningModelOperation, ...LearningModelOperation[]]);
export const learningModelRequestSchema = z.object({ operation: learningModelOperationSchema,
  identity: spaceIdentitySchema, args: z.array(z.unknown()) }).strict().superRefine((request, ctx) => {
  const parsed = argumentSchemas[request.operation].safeParse(request.args);
  if (!parsed.success) ctx.addIssue({ code: 'custom', message: 'Invalid operation arguments', path: ['args'] });
});
export type LearningModelRequest = z.infer<typeof learningModelRequestSchema>;
export const learningModelReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(storageErrorCodes) }).strict(),
]);
export type LearningModelReply = z.infer<typeof learningModelReplySchema>;
export type LearningModelCall = (request: LearningModelRequest) => Promise<unknown>;
export type LearningModelAuthorize = (identity: SpaceIdentity, operation: LearningModelOperation, args: readonly unknown[]) => Promise<void>;
function failure(error: unknown): LearningModelReply {
  return { ok: false, code: error instanceof StorageError ? error.code : error instanceof z.ZodError ? 'invalid' : 'unavailable' };
}

/** Trusted service capability, never a browser route. The host verifies original Agent/permit
 * context in authorize, and supplies that same context to Gateway's pre-SDK authorize hook.
 * Values are normal JSON; the host MUST chunk before applying the 1 MiB control envelope.
 */
export function createLearningModelService(models: LearningModelPort, authorize: LearningModelAuthorize) {
  return async (value: unknown): Promise<LearningModelReply> => {
    try {
      const request = learningModelRequestSchema.parse(value);
      const { identity, operation } = request;
      const args = argumentSchemas[operation].parse(request.args);
      await authorize(identity, operation, args);
      // deviceOwner is a local host capability, not an identity supplied by a peer.
      // Trusted local UI composition continues to call Gateway.selection.read directly.
      if (operation === 'selection.read' && args[0]) {
        const actor = spaceIdentitySchema.parse(args[0]);
        if (['environmentId', 'spaceId', 'principalId', 'kind'].some(key => actor[key as keyof typeof actor] !== identity[key as keyof typeof identity]))
          throw new StorageError('forbidden');
      }
      // Learning and diagnostic attempts cannot be interchanged through this capability.
      if (operation.startsWith('checks.') && operation !== 'checks.receive') {
        const fact = await models.checks.read(identity, args[0] as string);
        if (fact.purpose !== 'learning') throw new StorageError('missing');
        if (operation === 'checks.dispatch') {
          await authorize(identity, operation, args);
          // Gateway durably claims, starts its own background deliver and returns read().
          // Await that owner transition, never add a second queue or fabricate running state.
          const current = await models.checks.dispatch(identity, ...argumentSchemas['checks.dispatch'].parse(request.args));
          if (current.attemptId !== fact.attemptId) throw new StorageError('corrupt');
          return { ok: true, value: parseLearningModelResult(operation, current) };
        }
      }
      let result: unknown;
      switch (operation) {
        case 'selection.read': result = await models.selection.read(identity, ...argumentSchemas['selection.read'].parse(request.args)); break;
        case 'selection.resolve': result = await models.selection.resolveChoice(identity, ...argumentSchemas['selection.resolve'].parse(request.args)); break;
        case 'selection.snapshot': result = await models.selection.snapshot(identity, ...argumentSchemas['selection.snapshot'].parse(request.args)); break;
        case 'selection.pin': result = await models.selection.pin(identity, ...argumentSchemas['selection.pin'].parse(request.args)); break;
        case 'selection.pinSource': result = await models.selection.pinSource(identity, ...argumentSchemas['selection.pinSource'].parse(request.args)); break;
        case 'selection.pinned': result = await models.selection.pinned(identity, ...argumentSchemas['selection.pinned'].parse(request.args)); break;
        case 'segments.create': result = await models.segments.create(identity, ...argumentSchemas['segments.create'].parse(request.args)); break;
        case 'segments.read': result = await models.segments.read(identity, ...argumentSchemas['segments.read'].parse(request.args)); break;
        case 'segments.settle': result = await models.segments.settle(identity, ...argumentSchemas['segments.settle'].parse(request.args)); break;
        case 'segments.close': result = await models.segments.close(identity, ...argumentSchemas['segments.close'].parse(request.args)); break;
        case 'checks.receive': result = await models.checks.receive(identity, ...argumentSchemas['checks.receive'].parse(request.args)); break;
        case 'checks.read': result = await models.checks.read(identity, ...argumentSchemas['checks.read'].parse(request.args)); break;
        case 'checks.requestPayload': result = await models.checks.requestPayload(identity, ...argumentSchemas['checks.requestPayload'].parse(request.args)); break;
        case 'checks.progress': result = await models.checks.progress(identity, ...argumentSchemas['checks.progress'].parse(request.args)); break;
        case 'checks.summary': result = await models.checks.summary(identity, ...argumentSchemas['checks.summary'].parse(request.args)); break;
        case 'checks.dispatch': throw new StorageError('invalid'); // handled asynchronously above
        case 'checks.cancel': result = await models.checks.cancel(identity, ...argumentSchemas['checks.cancel'].parse(request.args)); break;
        case 'results.retain': result = await models.results.retain(identity, ...argumentSchemas['results.retain'].parse(request.args)); break;
        case 'images.upload': result = await models.images.upload(identity, ...argumentSchemas['images.upload'].parse(request.args)); break;
        case 'images.read': result = await models.images.read(identity, ...argumentSchemas['images.read'].parse(request.args)); break;
      }
      // Make in-process and network callers observe the same JSON values (including void).
      return { ok: true, value: parseLearningModelResult(operation, result === undefined ? null : JSON.parse(JSON.stringify(result))) };
    } catch (error) { return failure(error); }
  };
}

export function createLearningModelClient(call: LearningModelCall): LearningModelPort {
  async function invoke(operation: LearningModelOperation, identity: SpaceIdentity, args: unknown[]) {
    try {
      // Optional arguments omitted by the local caller stay omitted in the wire tuple.
      while (args.length && args[args.length - 1] === undefined) args.pop();
      const request = learningModelRequestSchema.parse({ operation, identity, args });
      const reply = learningModelReplySchema.parse(await call(request));
      if (!reply.ok) throw new StorageError(reply.code);
      const result = parseLearningModelResult(operation, reply.value);
      return operation === 'results.retain' ? undefined : result;
    } catch (error) {
      const reply = failure(error);
      if (!reply.ok) throw new StorageError(reply.code);
      throw new StorageError('unavailable');
    }
  }
  return {
    selection: {
      pin: (identity, ...args) => invoke('selection.pin', identity, args) as ReturnType<LearningModelPort['selection']['pin']>,
      pinSource: (identity, ...args) => invoke('selection.pinSource', identity, args) as ReturnType<LearningModelPort['selection']['pinSource']>,
      pinned: (identity, ...args) => invoke('selection.pinned', identity, args) as ReturnType<LearningModelPort['selection']['pinned']>,
      read: (identity, ...args) => invoke('selection.read', identity, args) as ReturnType<LearningModelPort['selection']['read']>,
      snapshot: (identity, ...args) => invoke('selection.snapshot', identity, args) as ReturnType<LearningModelPort['selection']['snapshot']>,
      resolveChoice: (identity, ...args) => invoke('selection.resolve', identity, args) as ReturnType<LearningModelPort['selection']['resolveChoice']>,
    },
    segments: {
      create: (identity, ...args) => invoke('segments.create', identity, args) as ReturnType<LearningModelPort['segments']['create']>,
      read: (identity, ...args) => invoke('segments.read', identity, args) as ReturnType<LearningModelPort['segments']['read']>,
      settle: (identity, ...args) => invoke('segments.settle', identity, args) as ReturnType<LearningModelPort['segments']['settle']>,
      close: (identity, ...args) => invoke('segments.close', identity, args) as ReturnType<LearningModelPort['segments']['close']>,
    },
    checks: {
      receive: (identity, ...args) => invoke('checks.receive', identity, args) as ReturnType<LearningModelPort['checks']['receive']>,
      read: (identity, ...args) => invoke('checks.read', identity, args) as ReturnType<LearningModelPort['checks']['read']>,
      requestPayload: (identity, ...args) => invoke('checks.requestPayload', identity, args) as ReturnType<LearningModelPort['checks']['requestPayload']>,
      progress: (identity, ...args) => invoke('checks.progress', identity, args) as ReturnType<LearningModelPort['checks']['progress']>,
      summary: (identity, ...args) => invoke('checks.summary', identity, args) as ReturnType<LearningModelPort['checks']['summary']>,
      dispatch: (identity, ...args) => invoke('checks.dispatch', identity, args) as ReturnType<LearningModelPort['checks']['dispatch']>,
      cancel: (identity, ...args) => invoke('checks.cancel', identity, args) as ReturnType<LearningModelPort['checks']['cancel']>,
    },
    results: {
      retain: (identity, ...args) => invoke('results.retain', identity, args) as ReturnType<LearningModelPort['results']['retain']>,
    },
    images: {
      upload: (identity, ...args) => invoke('images.upload', identity, args) as ReturnType<LearningModelPort['images']['upload']>,
      read: (identity, ...args) => invoke('images.read', identity, args) as ReturnType<LearningModelPort['images']['read']>,
    },
  };
}
