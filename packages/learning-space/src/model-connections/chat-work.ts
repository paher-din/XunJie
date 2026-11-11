import { createHash } from 'node:crypto';
import { StorageError, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelSegmentInputSchema, modelCapabilityInputSchema, modelAttemptSchema, settleModelToolsSchema, modelToolResultSchema, modelSegmentCloseSchema, modelSegmentBoundarySchema } from '@xunjie/contracts/model-connections';
import type { ModelAttempt, ModelChatInput, ModelLearningInput, ModelCheckInput, ModelCapabilityInput, ModelTool, ModelToolResult } from '@xunjie/contracts/model-connections';
import { modelScopeOf } from './selection.js';
import { toolValidators, compileOutputSchema, type NativeChatAssistant } from './chat-native.js';
import { checkPayload, type ChatPayload } from './chat.js';
import type { CheckSnapshot } from './checks.js';
import type { createModelImages } from './images.js';
import type { z } from 'zod';
import type OpenAI from 'openai';
import { responsesCheckPayload, validateResponsesNative, type ResponsesPayload } from './responses.js';
import type { NativePayload } from './transport.js';
import type Anthropic from '@anthropic-ai/sdk';
import { messagesCheckPayload, validateMessagesNative, type MessagesPayload } from './messages.js';
import { decideModelCapabilities, ModelCapabilityError } from './capabilities.js';

export const chatWorkMigrations = [{ version: 6, name: 'fixed-chat-images-and-native-segments', sql: `
  CREATE TABLE model_images(id uuid PRIMARY KEY,scope text NOT NULL,body jsonb NOT NULL);
  CREATE TABLE model_segments(id uuid PRIMARY KEY,scope text NOT NULL,body jsonb NOT NULL);
  CREATE TABLE model_tool_results(attempt_id uuid PRIMARY KEY,scope text NOT NULL,body jsonb NOT NULL);
  CREATE TABLE model_observations(id uuid NOT NULL,version integer NOT NULL,scope text NOT NULL,body jsonb NOT NULL,PRIMARY KEY(id,version,scope));
` }];
type Segment = { segmentId: string; formatVersion: 1; sequence: number; snapshot: Omit<CheckSnapshot, 'retain' | 'payload'>;
  prefix: z.infer<typeof modelSegmentInputSchema>['prefix']; prefixDigest: string;
  portable: { text: string; role?: 'user' | 'assistant' | undefined; resultRef?: string | undefined }[];
  purpose?: 'chat-probe' | 'learning';
  headAttemptId: string | null; pendingAttemptId: string | null; closed: boolean; previousSegmentId?: string };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function createChatWork(storage: OwnedStorage, images: ReturnType<typeof createModelImages>, owner: {
  authorize(identity: SpaceIdentity): Promise<void>;
  assertWritable(): void;
  readPortable(identity: SpaceIdentity, resultRef: string): Promise<unknown>;
  snapshot(identity: SpaceIdentity, source: ModelCheckInput['source'], learning?: boolean, selectedSource?: unknown): Promise<CheckSnapshot>;
  assertDispatch(identity: SpaceIdentity, attempt: Pick<ModelAttempt, 'connection' | 'source' | 'createdAt' | 'purpose'>, credentialRef: string): Promise<void>;
}) {
  async function stored(identity: SpaceIdentity, id: string) {
    await owner.authorize(identity);
    const { rows: [row] } = await storage.read('SELECT body FROM model_segments WHERE id=$1 AND scope=$2', [id, modelScopeOf(identity)]);
    if (!row) throw new StorageError('missing'); return row.body as Segment;
  }
  async function attempt(identity: SpaceIdentity, id: string) {
    const { rows: [row] } = await storage.read('SELECT body FROM model_attempts WHERE id=$1 AND scope=$2', [id, modelScopeOf(identity)]);
    if (!row) throw new StorageError('forbidden');
    const fact = modelAttemptSchema.parse(row.body);
    if (fact.resultRef) await storage.readResource(fact.resultRef);
    return fact;
  }
  async function read(identity: SpaceIdentity, id: string) {
    const body = await stored(identity, id);
    const head = body.headAttemptId ? await attempt(identity, body.headAttemptId) : null;
    return { segmentId: body.segmentId, formatVersion: body.formatVersion, sequence: body.sequence, connection: body.snapshot.connection,
      prefixDigest: body.prefixDigest, resultRef: head?.resultRef ?? null, pending: body.pendingAttemptId !== null,
      closed: body.closed, pendingTools: head?.state === 'completed' && !await toolResults(identity, head.attemptId) ? head.toolIntents ?? [] : [] };
  }
  async function toolResults(identity: SpaceIdentity, attemptId: string): Promise<ModelToolResult[] | null> {
    const { rows: [row] } = await storage.read('SELECT body FROM model_tool_results WHERE attempt_id=$1 AND scope=$2', [attemptId, modelScopeOf(identity)]);
    return row ? (row.body as unknown[]).map(item => modelToolResultSchema.parse(item)) : null;
  }
  function paired(fact: ModelAttempt, results: ModelToolResult[]) {
    const intents = fact.toolIntents ?? [];
    if (fact.state !== 'completed' || !fact.resultRef || !fact.physicalRequestEnded || intents.length !== results.length
      || new Set(results.map(item => item.callId)).size !== intents.length) throw new StorageError('invalid');
    return intents.map(intent => {
      const result = results.find(item => item.callId === intent.callId);
      if (!result) throw new StorageError('invalid'); return result;
    });
  }
  async function settle(identity: SpaceIdentity, id: string, value: unknown) {
    owner.assertWritable(); const segment = await stored(identity, id), input = settleModelToolsSchema.parse(value);
    const hash = digest({ scope: modelScopeOf(identity), id, input });
    if (await storage.receipt('model-tool-results:' + input.requestId, hash)) return read(identity, id);
    if (segment.closed || segment.pendingAttemptId || segment.sequence !== input.expectedSequence || !segment.headAttemptId) throw new StorageError('conflict');
    const results = paired(await attempt(identity, segment.headAttemptId), input.results);
    if (await toolResults(identity, segment.headAttemptId)) throw new StorageError('conflict');
    const imagesToRetain = await Promise.all(results.map(result => images.materialize(identity, result.images)));
    await storage.request({ requestId: 'model-tool-results:' + input.requestId, fingerprint: hash }, async tx => {
      const { rows: [row] } = await tx.query('SELECT body FROM model_segments WHERE id=$1 FOR UPDATE', [id]);
      const current = row!.body as Segment;
      if (current.closed || current.pendingAttemptId || current.sequence !== input.expectedSequence || current.headAttemptId !== segment.headAttemptId) throw new StorageError('conflict');
      await tx.query('INSERT INTO model_tool_results VALUES($1,$2,$3)', [segment.headAttemptId, modelScopeOf(identity), JSON.stringify(results)]);
      for (const image of imagesToRetain) await image.retain(tx, segment.headAttemptId!);
      return { attemptId: segment.headAttemptId };
    });
    return read(identity, id);
  }
  async function close(identity: SpaceIdentity, id: string, value: unknown) {
    owner.assertWritable(); await stored(identity, id);
    const input = modelSegmentCloseSchema.parse(value), scope = modelScopeOf(identity);
    const result = await storage.request({ requestId: 'model-boundary:' + input.requestId, fingerprint: digest({ scope, id, input }) }, async tx => {
      const { rows: [row] } = await tx.query('SELECT body FROM model_segments WHERE id=$1 AND scope=$2 FOR UPDATE', [id, scope]);
      const segment = row!.body as Segment;
      if (segment.pendingAttemptId || segment.sequence !== input.expectedSequence) throw new StorageError('conflict');
      let resultRef: string | null = null;
      if (segment.headAttemptId) {
        const { rows: [head] } = await tx.query('SELECT body FROM model_attempts WHERE id=$1 AND scope=$2', [segment.headAttemptId, scope]);
        const fact = modelAttemptSchema.parse(head!.body);
        const { rows: settled } = await tx.query('SELECT attempt_id FROM model_tool_results WHERE attempt_id=$1 AND scope=$2', [fact.attemptId, scope]);
        if (!fact.physicalRequestEnded || fact.toolIntents?.length && !settled.length) throw new StorageError('conflict'); resultRef = fact.resultRef;
      }
      await tx.query('UPDATE model_segments SET body=$2 WHERE id=$1', [id, { ...segment, closed: true }]);
      return { owner: storage.owner, segmentId: id, sequence: segment.sequence, routeId: segment.snapshot.connection.routeId, resultRef };
    });
    return { ...await read(identity, id), boundary: modelSegmentBoundarySchema.parse(result.result) };
  }
  function validatePrefix(prefix: ModelCapabilityInput['prefix']) {
    toolValidators(prefix.tools);
    const forcedName = typeof prefix.options?.toolChoice === 'object' ? prefix.options.toolChoice.name : undefined;
    if (forcedName && !prefix.tools.some(tool => tool.name === forcedName)) throw new StorageError('invalid');
    if (prefix.options?.applicationSchema) compileOutputSchema(prefix.options.applicationSchema);
  }
  async function decideCapabilities(identity: SpaceIdentity, value: unknown) {
    await owner.authorize(identity);
    const input = modelCapabilityInputSchema.parse(value);
    validatePrefix(input.prefix);
    const snapshot = await owner.snapshot(identity, input.source);
    return decideModelCapabilities(snapshot.connection, input.prefix);
  }
  async function create(identity: SpaceIdentity, value: unknown, selectedSource?: unknown) {
    owner.assertWritable(); await owner.authorize(identity);
    const input = modelSegmentInputSchema.parse(value), scope = modelScopeOf(identity), hash = digest({ scope, input, ...(selectedSource ? { selectedSource } : {}) });
    if (selectedSource && (!('selected' in input.source) || input.purpose !== 'learning')) throw new StorageError('invalid');
    const prior = await storage.receipt('model-segment:' + input.requestId, hash); if (prior) return read(identity, input.segmentId);
    // The shared contract is wide enough for learning; probe segments keep their original wire bounds.
    if ((input.purpose ?? 'chat-probe') !== 'learning'
      && (input.prefix.system.length > 8192 || input.prefix.tools.length > 8 || input.portable.length > 8))
      throw new StorageError('invalid');
    if ('draft' in input.source) throw new StorageError('invalid');
    validatePrefix(input.prefix);
    const options = input.prefix.options;
    const snapshot = await owner.snapshot(identity, input.source, input.purpose === 'learning', selectedSource);
    const decision = decideModelCapabilities(snapshot.connection, input.prefix);
    // Preserve explicit diagnostic probes without upgrading evidence. Messages has no JSON-object wire form.
    if (!decision.available && (!options?.capabilityProbe
      || snapshot.connection.protocol === 'messages' && options.responseFormat?.kind === 'json-object')) throw new ModelCapabilityError(decision);
    if (input.previousSegmentId) {
      const old = await stored(identity, input.previousSegmentId);
      if (old.pendingAttemptId) throw new StorageError('resource-busy');
      if (old.headAttemptId) {
        const last = await attempt(identity, old.headAttemptId);
        if (!last.physicalRequestEnded || last.toolIntents?.length && !await toolResults(identity, last.attemptId)) throw new StorageError('conflict');
      }
    }
    for (const portable of input.portable) {
      if (!portable.resultRef) continue;
      await owner.readPortable(identity, portable.resultRef);
    }
    const { retain: _retain, ...fixed } = snapshot;
    const body: Segment = { segmentId: input.segmentId, sequence: 0, formatVersion: 1, prefix: input.prefix, portable: input.portable,
      prefixDigest: digest(input.prefix), snapshot: fixed, headAttemptId: null, pendingAttemptId: null, closed: false,
      purpose: input.purpose ?? 'chat-probe',
      ...(input.previousSegmentId ? { previousSegmentId: input.previousSegmentId } : {}) };
    await storage.request({ requestId: 'model-segment:' + input.requestId, fingerprint: hash }, async tx => {
      if (input.previousSegmentId) {
        const { rows: [row] } = await tx.query('SELECT body FROM model_segments WHERE id=$1 AND scope=$2 FOR UPDATE', [input.previousSegmentId, scope]);
        const old = row!.body as Segment;
        if (old.pendingAttemptId) throw new StorageError('conflict');
        if (old.headAttemptId) {
          const { rows: [fact] } = await tx.query('SELECT body FROM model_attempts WHERE id=$1', [old.headAttemptId]);
          const last = modelAttemptSchema.parse(fact!.body);
          const { rows: settled } = await tx.query('SELECT attempt_id FROM model_tool_results WHERE attempt_id=$1', [last.attemptId]);
          if (!last.physicalRequestEnded || last.toolIntents?.length && !settled.length) throw new StorageError('conflict');
        }
        await tx.query('UPDATE model_segments SET body=$2 WHERE id=$1', [old.segmentId, { ...old, closed: true }]);
      }
      await tx.query('INSERT INTO model_segments VALUES($1,$2,$3)', [input.segmentId, scope, body]);
      for (const portable of input.portable) if (portable.resultRef) await tx.reference('model-segment-source:' + input.segmentId + ':' + portable.resultRef, portable.resultRef);
      return null;
    });
    return read(identity, input.segmentId);
  }
  async function prepare(identity: SpaceIdentity, input: ModelChatInput | ModelLearningInput): Promise<CheckSnapshot> {
    const segment = await stored(identity, input.segmentId);
    if ((segment.purpose ?? 'chat-probe') !== input.purpose) throw new StorageError('conflict');
    if (segment.sequence !== input.expectedSequence) throw new StorageError('conflict');
    if (segment.closed) throw new StorageError('conflict');
    if (segment.pendingAttemptId) throw new StorageError('resource-busy');
    await owner.assertDispatch(identity, { connection: segment.snapshot.connection, source: segment.snapshot.source,
      createdAt: new Date().toISOString(), purpose: segment.purpose ?? 'chat-probe' }, segment.snapshot.credentialRef);
    const responses = segment.snapshot.connection.protocol === 'responses';
    const anthropic = segment.snapshot.connection.protocol === 'messages';
    const messages: ChatPayload['messages'] = [], items: OpenAI.Responses.ResponseInput = [];
    const messageItems: Anthropic.MessageParam[] = [];
    const nativeImages = (content: Awaited<ReturnType<typeof images.materialize>>['content']) => content.map(part => ({
      type: 'input_image' as const, image_url: part.image_url.url, detail: 'auto' as const,
    }));
    function user(text: string, content: Awaited<ReturnType<typeof images.materialize>>['content'] = []) {
      if (anthropic) {
        const parts: Anthropic.ContentBlockParam[] = [...(text ? [{ type: 'text' as const, text }] : []), ...messageImages(content)];
        const last = messageItems.at(-1);
        if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(...parts);
        else messageItems.push({ role: 'user', content: parts });
      } else if (responses) items.push({ role: 'user', content: [...(text ? [{ type: 'input_text' as const, text }] : []), ...nativeImages(content)] });
      else messages.push({ role: 'user', content: [...(text ? [{ type: 'text' as const, text }] : []), ...content] });
    }
    // Portable history keeps native turn roles instead of flattening both sides into user text.
    function conversation(role: 'user' | 'assistant', text: string) {
      if (anthropic) {
        const last = messageItems.at(-1);
        const parts: Anthropic.ContentBlockParam[] = [{ type: 'text' as const, text }];
        if (last?.role === role && Array.isArray(last.content)) last.content.push(...parts);
        else messageItems.push({ role, content: parts });
      } else if (responses) items.push({ role, content: text });
      else messages.push({ role, content: text });
    }
    function messageImages(content: Awaited<ReturnType<typeof images.materialize>>['content']): Anthropic.ImageBlockParam[] {
      return content.map(part => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: part.image_url.url.slice('data:image/png;base64,'.length) } }));
    }
    const resultImages: Awaited<ReturnType<typeof images.materialize>>[] = [];
    let settlement: { attemptId: string; results: ModelToolResult[] } | null = null;
    if (segment.headAttemptId) {
      const prior = await attempt(identity, segment.headAttemptId);
      if (prior.state !== 'completed' || !prior.resultRef) throw new StorageError('conflict');
      const native = JSON.parse(Buffer.from(await storage.readResource(prior.resultRef)).toString('utf8')) as { assistant?: NativeChatAssistant; output?: OpenAI.Responses.ResponseInput; message?: Anthropic.Message };
      const previous = JSON.parse(Buffer.from(await storage.readResource(prior.requestRef)).toString('utf8')) as NativePayload;
      if (anthropic) {
        validateMessagesNative(native, segment.prefix.tools);
        if (!native.message || !('messages' in previous)) throw new StorageError('corrupt');
        messageItems.push(...(previous as MessagesPayload).messages, { role: 'assistant', content: native.message.content });
      } else if (responses) {
        validateResponsesNative(native, segment.prefix.tools);
        if (!Array.isArray(native.output) || !('input' in previous) || !Array.isArray(previous.input)) throw new StorageError('corrupt');
        items.push(...previous.input, ...native.output);
      } else {
        if (!native.assistant || !('messages' in previous)) throw new StorageError('corrupt');
        messages.push(...(previous as ChatPayload).messages, native.assistant);
      }
      const saved = await toolResults(identity, prior.attemptId);
      if (saved && input.input.toolResults.length) throw new StorageError('conflict');
      const results = paired(prior, saved ?? input.input.toolResults);
      if (!saved && results.length) settlement = { attemptId: prior.attemptId, results };
      const messageResults: Anthropic.ToolResultBlockParam[] = [];
      const chatImageMessages: ChatPayload['messages'] = [];
      for (const result of results) {
        const image = await images.materialize(identity, result.images);
        resultImages.push(image);
        const text = result.outcome === 'success' ? result.text : JSON.stringify({ outcome: result.outcome, text: result.text });
        if (anthropic) messageResults.push({ type: 'tool_result', tool_use_id: result.callId, is_error: result.outcome !== 'success',
          content: [{ type: 'text', text }, ...messageImages(image.content)] });
        else if (responses) items.push({ type: 'function_call_output', call_id: result.callId,
          output: image.content.length ? [{ type: 'input_text', text }, ...nativeImages(image.content)] : text });
        else {
          messages.push({ role: 'tool', tool_call_id: result.callId, content: text });
          if (image.content.length) chatImageMessages.push({ role: 'user', content: image.content.flatMap((part, index) => [
            { type: 'text' as const, text: JSON.stringify({ kind: 'tool-result-image', callId: result.callId, source: result.images[index] }) }, part,
          ]) });
        }
      }
      // A Chat tool group must be complete before starting the adjacent image user turns.
      messages.push(...chatImageMessages);
      if (messageResults.length) messageItems.push({ role: 'user', content: messageResults });
    } else {
      if (input.input.toolResults.length) throw new StorageError('invalid');
      if (!responses && !anthropic) messages.push({ role: 'system', content: segment.prefix.system });
      for (const portable of segment.portable) conversation(portable.role ?? 'user', portable.text);
    }
    const image = await images.materialize(identity, input.input.images);
    if (input.input.text || image.content.length) user(input.input.text, image.content);
    for (const observation of input.input.observations) user(JSON.stringify(observation));
    const base = checkPayload(segment.snapshot.connection, input.limits.maxOutputTokens);
    const options = segment.prefix.options;
    const payload: NativePayload = anthropic ? {
      ...messagesCheckPayload(segment.snapshot.connection, input.limits.maxOutputTokens), system: segment.prefix.system, messages: messageItems,
      ...(segment.prefix.tools.length ? { tools: segment.prefix.tools.map(tool => ({ name: tool.name, description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema, ...(tool.strict === undefined ? {} : { strict: tool.strict }) })), tool_choice: { type: 'auto' as const } } : {}),
      ...(options?.toolChoice ? { tool_choice: typeof options.toolChoice === 'string' ? { type: options.toolChoice } : { type: 'tool' as const, name: options.toolChoice.name } } : {}),
      ...(options?.responseFormat?.kind === 'json-schema' ? { output_config: { format: { type: 'json_schema' as const, schema: options.responseFormat.schema } } } : {}),
    } satisfies MessagesPayload : responses ? {
      ...responsesCheckPayload(segment.snapshot.connection, input.limits.maxOutputTokens), instructions: segment.prefix.system, input: items,
      ...(segment.prefix.tools.length ? { tools: segment.prefix.tools.map(tool => ({ type: 'function' as const,
        name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: tool.strict ?? false })), tool_choice: 'auto' as const } : {}),
      ...(options?.toolChoice ? { tool_choice: typeof options.toolChoice === 'string' ? options.toolChoice : { type: 'function' as const, name: options.toolChoice.name } } : {}),
      ...(options?.responseFormat ? { text: { format: options.responseFormat.kind === 'json-object' ? { type: 'json_object' as const }
        : { type: 'json_schema' as const, name: options.responseFormat.name, schema: options.responseFormat.schema, strict: options.responseFormat.strict } } } : {}),
    } satisfies ResponsesPayload : { ...base, messages, ...(segment.prefix.tools.length ? { tools: segment.prefix.tools.map(tool => ({
      type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }) },
    })), tool_choice: 'auto' as const } : {}), ...(options?.toolChoice ? { tool_choice: typeof options.toolChoice === 'string'
      ? options.toolChoice : { type: 'function' as const, function: { name: options.toolChoice.name } } } : {}),
      ...(options?.responseFormat ? { response_format: options.responseFormat.kind === 'json-object' ? { type: 'json_object' as const }
        : { type: 'json_schema' as const, json_schema: { name: options.responseFormat.name, schema: options.responseFormat.schema, strict: options.responseFormat.strict } } } : {}) };
    function countImages(value: unknown): number {
      if (Array.isArray(value)) return value.reduce((count, item) => count + countImages(item), 0);
      if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        if (object.type === 'image_url' || object.type === 'input_image') return 1;
        return Object.values(object).reduce<number>((count, item) => count + countImages(item), 0);
      }
      return 0;
    }
    const imageCount = anthropic ? messageItems.reduce((count, message) => count + (message.role === 'user' && Array.isArray(message.content)
      ? message.content.reduce((total, part) => total + (part.type === 'image' ? 1 : part.type === 'tool_result' && Array.isArray(part.content)
        ? part.content.filter(item => item.type === 'image').length : 0), 0) : 0), 0) : countImages(payload);
    if (imageCount > 8) throw new StorageError('invalid');
    if (imageCount && segment.snapshot.connection.imageInput === false) {
      const decision = decideModelCapabilities(segment.snapshot.connection, { ...segment.prefix,
        options: { ...options, requiredCapabilities: [...new Set([...(options?.requiredCapabilities ?? []), 'images' as const])] } });
      throw new ModelCapabilityError(decision);
    }
    if (Buffer.byteLength(JSON.stringify(payload)) > 1000000) throw new StorageError('invalid');
    return { ...segment.snapshot, payload, tools: segment.prefix.tools, ...(options?.applicationSchema ? { applicationSchema: options.applicationSchema } : {}), segment: { segmentId: input.segmentId, sequence: input.expectedSequence },
      async retain(tx) {
        const { rows: [row] } = await tx.query('SELECT body FROM model_segments WHERE id=$1 FOR UPDATE', [input.segmentId]);
        const current = row!.body as Segment;
        if (current.closed || current.sequence !== input.expectedSequence) throw new StorageError('conflict');
        if (current.pendingAttemptId) throw new StorageError('resource-busy');
        await tx.query('UPDATE model_segments SET body=$2 WHERE id=$1', [input.segmentId, { ...current, pendingAttemptId: input.attemptId }]);
        await image.retain(tx, input.attemptId);
        for (const result of resultImages) await result.retain(tx, input.attemptId);
        if (settlement) await tx.query('INSERT INTO model_tool_results VALUES($1,$2,$3)', [settlement.attemptId, modelScopeOf(identity), JSON.stringify(settlement.results)]);
        for (const observation of input.input.observations) {
          await tx.query('INSERT INTO model_observations VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [observation.observationId, observation.version, modelScopeOf(identity), observation]);
          const { rows: [saved] } = await tx.query('SELECT body FROM model_observations WHERE id=$1 AND version=$2 AND scope=$3', [observation.observationId, observation.version, modelScopeOf(identity)]);
          if (digest(saved!.body) !== digest(observation)) throw new StorageError('conflict');
        }
      } };
  }
  async function publish(tx: OwnedTransaction, fact: ModelAttempt) {
    if (!fact.segment) return;
    const { rows: [row] } = await tx.query('SELECT body FROM model_segments WHERE id=$1 FOR UPDATE', [fact.segment.segmentId]);
    if (!row) throw new StorageError('corrupt'); const segment = row.body as Segment;
    if (segment.headAttemptId === fact.attemptId || segment.sequence > fact.segment.sequence && segment.pendingAttemptId !== fact.attemptId) return;
    if (segment.pendingAttemptId !== fact.attemptId || segment.sequence !== fact.segment.sequence) throw new StorageError('conflict');
    await tx.query('UPDATE model_segments SET body=$2 WHERE id=$1', [segment.segmentId,
      { ...segment, sequence: segment.sequence + 1, headAttemptId: fact.attemptId, pendingAttemptId: null,
        closed: segment.closed || fact.state !== 'completed' }]);
    if (fact.resultRef) await tx.reference('model-segment-result:' + fact.attemptId, fact.resultRef);
  }
  async function validate() {
    const { rows } = await storage.read('SELECT body FROM model_segments');
    for (const row of rows) {
      const segment = row.body as Segment;
      toolValidators(segment.prefix.tools);
      if (segment.prefixDigest !== digest(segment.prefix)) throw new StorageError('corrupt');
    }
    await images.validate();
  }
  return { create, decideCapabilities, read, settle, close, prepare, publish, validate };
}
