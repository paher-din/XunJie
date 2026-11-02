import { createHash } from 'node:crypto';
import { StorageError, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelSegmentInputSchema, modelAttemptSchema, settleModelToolsSchema, modelToolResultSchema } from '@xunjie/contracts/model-connections';
import type { ModelAttempt, ModelChatInput, ModelCheckInput, ModelTool, ModelToolResult } from '@xunjie/contracts/model-connections';
import { modelScopeOf } from './selection.js';
import { toolValidators, compileOutputSchema, type NativeChatAssistant } from './chat-native.js';
import { checkPayload, type ChatPayload } from './chat.js';
import type { CheckSnapshot } from './checks.js';
import type { createModelImages } from './images.js';
import type { z } from 'zod';

export const chatWorkMigrations = [{ version: 6, name: 'fixed-chat-images-and-native-segments', sql: `
  CREATE TABLE model_images(id uuid PRIMARY KEY,scope text NOT NULL,body jsonb NOT NULL);
  CREATE TABLE model_segments(id uuid PRIMARY KEY,scope text NOT NULL,body jsonb NOT NULL);
  CREATE TABLE model_tool_results(attempt_id uuid PRIMARY KEY,scope text NOT NULL,body jsonb NOT NULL);
  CREATE TABLE model_observations(id uuid NOT NULL,version integer NOT NULL,scope text NOT NULL,body jsonb NOT NULL,PRIMARY KEY(id,version,scope));
` }];
type Segment = { segmentId: string; formatVersion: 1; sequence: number; snapshot: Omit<CheckSnapshot, 'retain' | 'payload'>;
  prefix: z.infer<typeof modelSegmentInputSchema>['prefix']; prefixDigest: string; portable: { text: string; resultRef?: string | undefined }[];
  headAttemptId: string | null; pendingAttemptId: string | null; closed: boolean; previousSegmentId?: string };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function createChatWork(storage: OwnedStorage, images: ReturnType<typeof createModelImages>, owner: {
  authorize(identity: SpaceIdentity): Promise<void>;
  assertWritable(): void;
  snapshot(identity: SpaceIdentity, source: ModelCheckInput['source']): Promise<CheckSnapshot>;
  assertDispatch(identity: SpaceIdentity, attempt: Pick<ModelAttempt, 'connection' | 'source' | 'createdAt'>, credentialRef: string): Promise<void>;
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
  async function create(identity: SpaceIdentity, value: unknown) {
    owner.assertWritable(); await owner.authorize(identity);
    const input = modelSegmentInputSchema.parse(value), scope = modelScopeOf(identity), hash = digest({ scope, input });
    const prior = await storage.receipt('model-segment:' + input.requestId, hash); if (prior) return read(identity, input.segmentId);
    if ('draft' in input.source) throw new StorageError('invalid');
    toolValidators(input.prefix.tools);
    const options = input.prefix.options;
    const forcedName = typeof options?.toolChoice === 'object' ? options.toolChoice.name : undefined;
    if (forcedName && !input.prefix.tools.some(tool => tool.name === forcedName)) throw new StorageError('invalid');
    if (options?.applicationSchema) compileOutputSchema(options.applicationSchema);
    const snapshot = await owner.snapshot(identity, input.source);
    if (forcedName && snapshot.connection.capabilityEvidence?.limitations.includes('thinking-forced-tool-unsupported') && !options?.capabilityProbe) throw new StorageError('unavailable');
    for (const capability of options?.requiredCapabilities ?? []) {
      const supported = capability === 'applicationSchema' || capability === 'text' && snapshot.connection.capabilities.text === 'verified'
        || capability === 'images' && snapshot.connection.capabilities.images === 'verified'
        || capability === 'tools' && snapshot.connection.capabilities.tools === 'verified'
        || capability === 'nativeReplay' && snapshot.connection.capabilities.nativeReplay === 'verified'
        || capability === 'jsonMode' && snapshot.connection.capabilities.jsonMode === 'verified'
        || capability === 'nativeStrict' && snapshot.connection.capabilities.strictSchema === 'verified';
      if (!supported && !options?.capabilityProbe) throw new StorageError('unavailable');
    }
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
      const { rows: [row] } = await storage.read('SELECT body FROM model_attempts WHERE scope=$1 AND body->>\'resultRef\'=$2', [scope, portable.resultRef]);
      if (!row || modelAttemptSchema.parse(row.body).state !== 'completed') throw new StorageError('forbidden');
      await storage.readResource(portable.resultRef);
    }
    const { retain: _retain, ...fixed } = snapshot;
    const body: Segment = { segmentId: input.segmentId, sequence: 0, formatVersion: 1, prefix: input.prefix, portable: input.portable,
      prefixDigest: digest(input.prefix), snapshot: fixed, headAttemptId: null, pendingAttemptId: null, closed: false,
      ...(input.previousSegmentId ? { previousSegmentId: input.previousSegmentId } : {}) };
    await storage.request({ requestId: 'model-segment:' + input.requestId, fingerprint: hash }, async tx => {
      if (input.previousSegmentId) {
        const { rows: [row] } = await tx.query('SELECT body FROM model_segments WHERE id=$1 AND scope=$2 FOR UPDATE', [input.previousSegmentId, scope]);
        const old = row!.body as Segment;
        if (old.closed || old.pendingAttemptId) throw new StorageError('conflict');
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
  async function prepare(identity: SpaceIdentity, input: ModelChatInput): Promise<CheckSnapshot> {
    const segment = await stored(identity, input.segmentId);
    if (segment.sequence !== input.expectedSequence) throw new StorageError('conflict');
    if (segment.closed) throw new StorageError('conflict');
    if (segment.pendingAttemptId) throw new StorageError('resource-busy');
    await owner.assertDispatch(identity, { connection: segment.snapshot.connection, source: segment.snapshot.source,
      createdAt: new Date().toISOString() }, segment.snapshot.credentialRef);
    const messages: ChatPayload['messages'] = [];
    const resultImages: Awaited<ReturnType<typeof images.materialize>>[] = [];
    let settlement: { attemptId: string; results: ModelToolResult[] } | null = null;
    if (segment.headAttemptId) {
      const prior = await attempt(identity, segment.headAttemptId);
      if (prior.state !== 'completed' || !prior.resultRef) throw new StorageError('conflict');
      const native = JSON.parse(Buffer.from(await storage.readResource(prior.resultRef)).toString('utf8')) as { assistant?: NativeChatAssistant };
      if (!native.assistant) throw new StorageError('corrupt');
      const previous = JSON.parse(Buffer.from(await storage.readResource(prior.requestRef)).toString('utf8')) as ChatPayload;
      messages.push(...previous.messages, native.assistant);
      const saved = await toolResults(identity, prior.attemptId);
      if (saved && input.input.toolResults.length) throw new StorageError('conflict');
      const results = paired(prior, saved ?? input.input.toolResults);
      if (!saved && results.length) settlement = { attemptId: prior.attemptId, results };
      for (const result of results) {
        messages.push({ role: 'tool', tool_call_id: result.callId, content: result.outcome === 'success' ? result.text : JSON.stringify({ outcome: result.outcome, text: result.text }) });
        const image = await images.materialize(identity, result.images);
        resultImages.push(image);
        if (image.content.length) messages.push({ role: 'user', content: image.content });
      }
    } else {
      if (input.input.toolResults.length) throw new StorageError('invalid');
      messages.push({ role: 'system', content: segment.prefix.system });
      for (const portable of segment.portable) messages.push({ role: 'user', content: portable.text });
    }
    const image = await images.materialize(identity, input.input.images);
    if (input.input.text || image.content.length) messages.push({ role: 'user', content: [
      ...(input.input.text ? [{ type: 'text' as const, text: input.input.text }] : []), ...image.content,
    ] });
    for (const observation of input.input.observations) messages.push({ role: 'user', content: JSON.stringify(observation) });
    const base = checkPayload(segment.snapshot.connection, input.limits.maxOutputTokens);
    const options = segment.prefix.options;
    const payload: ChatPayload = { ...base, messages, ...(segment.prefix.tools.length ? { tools: segment.prefix.tools.map(tool => ({
      type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    })), tool_choice: 'auto' as const } : {}), ...(options?.toolChoice ? { tool_choice: typeof options.toolChoice === 'string'
      ? options.toolChoice : { type: 'function' as const, function: { name: options.toolChoice.name } } } : {}),
      ...(options?.responseFormat ? { response_format: options.responseFormat.kind === 'json-object' ? { type: 'json_object' as const }
        : { type: 'json_schema' as const, json_schema: { name: options.responseFormat.name, schema: options.responseFormat.schema, strict: options.responseFormat.strict } } } : {}) };
    const imageCount = messages.reduce((count, message) => count + (Array.isArray(message.content)
      ? message.content.filter(part => part.type === 'image_url').length : 0), 0);
    if (imageCount > 8) throw new StorageError('invalid');
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
      { ...segment, sequence: segment.sequence + 1, headAttemptId: fact.attemptId, pendingAttemptId: null }]);
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
  return { create, read, settle, prepare, publish, validate };
}
