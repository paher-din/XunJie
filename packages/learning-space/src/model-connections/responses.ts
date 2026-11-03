import OpenAI from 'openai';
import { StorageError } from '@xunjie/storage';
import type { ModelConfiguration, ModelTool, ModelToolIntent, ModelUsage, ModelUpstream } from '@xunjie/contracts/model-connections';
import { compileOutputSchema } from './chat-native.js';
import { createResponsesAssembler, object, responsesOutput, responsesUsage, responsesSensitiveValues, responsesEventSensitiveValues, validateResponsesNative } from './responses-native.js';
import { createSensitiveOutput, protocolJsonStrings, protocolTokenSequences } from './sensitive-output.js';
import { responseFacts } from './upstream-facts.js';
export { validateResponsesNative } from './responses-native.js';

export const responsesAdapterVersion = 'xunjie-responses-native-v1';
export type ResponsesPayload = OpenAI.Responses.ResponseCreateParamsStreaming;

export function responsesCheckPayload(configuration: ModelConfiguration, maxOutputTokens: number): ResponsesPayload {
  return { model: configuration.modelId, input: [{ role: 'user', content: 'Reply briefly with OK to check this model connection.' }],
    max_output_tokens: maxOutputTokens, stream: true, store: false,
    ...(configuration.dialect === 'deepseek' ? { reasoning: { effort: configuration.parameterMode === 'thinking' ? 'high' as const : 'none' as const } } : {}) };
}

class MalformedResponse extends Error {}
export async function runResponses(configuration: ModelConfiguration, apiKey: string, payload: ResponsesPayload,
  signal: AbortSignal, timeoutMs: number, nativeTools?: ModelTool[], applicationSchema?: Record<string, unknown>, requestFetch: typeof fetch = fetch) {
  const sensitive = createSensitiveOutput(apiKey), { clean } = sensitive;
  const events: unknown[] = [], assembler = createResponsesAssembler();
  let state: 'completed' | 'incomplete' | 'failed' | 'unknown' | 'cancelled' = 'incomplete';
  let reason = 'missing-terminal', bytes = 0, text = '', usage: ModelUsage = { state: 'unknown' };
  let toolIntents: ModelToolIntent[] = [], upstreamError: unknown = null;
  let upstream: ModelUpstream | undefined;
  const deadline = AbortSignal.timeout(timeoutMs), requestSignal = AbortSignal.any([signal, deadline]);
  let responseLimited = false;
  const client = new OpenAI({ apiKey, baseURL: configuration.baseUrl.replace(/\/$/, ''), maxRetries: 0,
    timeout: timeoutMs, logLevel: 'off', fetchOptions: { redirect: 'error' },
    fetch: async (input, init) => {
      const response = await requestFetch(input, init);
      upstream = responseFacts(response.status, response.headers, apiKey);
      if (!response.body) return response;
      let received = 0;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > 2_000_000) { responseLimited = true; controller.error(new Error('response-limit')); }
        else controller.enqueue(chunk);
      } }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } });
  try {
    const stream = await client.responses.create({ ...payload, store: false }, { signal: requestSignal });
    for await (const value of stream) {
      const encoded = JSON.stringify(value); bytes += Buffer.byteLength(encoded);
      if (bytes > 2_000_000) { stream.controller.abort(); reason = 'response-limit'; break; }
      // Persist before interpreting, so unsupported critical events remain inspectable.
      events.push(JSON.parse(encoded));
      try {
        const response = object(value).response;
        if (response !== undefined) {
          const terminal = ['response.completed', 'response.incomplete', 'response.failed'].includes(value.type)
            && object(response).status === value.type.slice('response.'.length);
          usage = responsesUsage(object(response).usage, terminal);
        }
        assembler.add(value);
      } catch { throw new MalformedResponse(); }
    }
    text = assembler.partialText;
    if (reason !== 'response-limit') {
      if (assembler.terminalType === 'response.completed') {
        const result = responsesOutput(assembler.response, nativeTools ?? []);
        text = result.text; usage = result.usage; toolIntents = result.intents;
        state = 'completed'; reason = 'completed';
        if (result.refused) { state = 'failed'; reason = 'content-refused'; }
      } else if (assembler.terminalType === 'response.incomplete') { state = 'incomplete'; reason = 'incomplete'; }
      else if (assembler.terminalType === 'response.failed' || assembler.streamError) { state = 'failed'; reason = 'upstream-stream'; }
    }
  } catch (error) {
    text = assembler.partialText;
    const status = (error instanceof OpenAI.APIError ? error.status : undefined)
      ?? (upstream?.httpStatus && upstream.httpStatus >= 400 ? upstream.httpStatus : undefined);
    if (!upstream && status && error instanceof OpenAI.APIError) upstream = responseFacts(status, error.headers ?? new Headers(), apiKey);
    const unsupported = error instanceof OpenAI.APIError && ['unsupported_model', 'model_not_supported', 'model_not_found',
      'unsupported_parameter', 'unsupported_value'].includes(error.code ?? '');
    if (error instanceof OpenAI.APIError && error.error) upstreamError = error.error;
    const malformed = error instanceof MalformedResponse || error instanceof SyntaxError || error instanceof StorageError;
    reason = malformed ? 'malformed-response' : signal.aborted ? 'client-abort' : status === 401 || status === 403 ? 'authentication'
      : status === 429 ? 'rate-limited' : unsupported ? 'upstream-unsupported' : status ? 'upstream-http'
      : deadline.aborted || error instanceof OpenAI.APIConnectionTimeoutError ? 'upstream-timeout' : 'upstream-stream';
    state = malformed ? 'failed' : signal.aborted ? 'cancelled' : status || upstreamError ? 'failed' : events.length ? 'incomplete' : 'unknown';
    if (responseLimited) { state = 'incomplete'; reason = 'response-limit'; }
  }
  // Normal EOF, socket reset and abort all project the same terminal visible content.
  if (state !== 'completed' && assembler.response && Array.isArray(assembler.response.output)) {
    const terminalText = assembler.response.output.flatMap(value => {
      if (!value || typeof value !== 'object' || value.type !== 'message' || !Array.isArray(value.content)) return [];
      return value.content.filter((part: unknown): part is { type: 'output_text'; text: string } => !!part && typeof part === 'object'
        && 'type' in part && part.type === 'output_text' && 'text' in part && typeof part.text === 'string').map((part: { text: string }) => part.text);
    }).join('');
    if (terminalText) text = terminalText;
  }
  // A validated terminal survives later transport loss/abort. Contradictory protocol data still fails.
  if (state !== 'failed' && reason !== 'response-limit') {
    if (!assembler.terminalType && requestSignal.aborted) {
      state = signal.aborted ? 'cancelled' : events.length ? 'incomplete' : 'unknown';
      reason = signal.aborted ? 'client-abort' : 'upstream-timeout';
    } else if (assembler.terminalType === 'response.completed') {
      try {
        const result = responsesOutput(assembler.response, nativeTools ?? []);
        text = result.text; usage = result.usage; toolIntents = result.intents;
        state = result.refused ? 'failed' : 'completed'; reason = result.refused ? 'content-refused' : 'completed';
      } catch { state = 'failed'; reason = 'malformed-response'; }
    } else if (assembler.terminalType) {
      state = assembler.terminalType === 'response.failed' ? 'failed' : 'incomplete';
      reason = assembler.terminalType === 'response.failed' ? 'upstream-stream' : 'incomplete';
    }
  }
  if (state === 'completed' && (payload.tool_choice === 'none' && toolIntents.length > 0
    || payload.tool_choice === 'required' && toolIntents.length === 0
    || typeof payload.tool_choice === 'object' && payload.tool_choice.type === 'function'
      && (toolIntents.length !== 1 || toolIntents[0]?.name !== payload.tool_choice.name))) {
    state = 'failed'; reason = 'tool-choice-not-honored';
  }
  const format = payload.text?.format;
  let structuredOutput: unknown;
  if (state === 'completed' && !toolIntents.length && (applicationSchema || format && format.type !== 'text')) {
    try {
      const value: unknown = JSON.parse(text); structuredOutput = value; object(value);
      if (applicationSchema && !compileOutputSchema(applicationSchema)(value)
        || format?.type === 'json_schema' && !compileOutputSchema(format.schema)(value)) throw new Error();
    } catch { state = 'failed'; reason = 'invalid-structured-output'; }
  }
  const response = assembler.response;
  const originalNative = { formatVersion: 1, sdk: 'openai@7.42.0', adapter: responsesAdapterVersion,
    events, response, output: Array.isArray(response?.output) ? response.output : [], upstreamError, ...(upstream ? { upstream } : {}) };
  let native: typeof originalNative & { redacted?: boolean } = originalNative;
  const structured = !!(applicationSchema || format && format.type !== 'text');
  const eventValues = responsesEventSensitiveValues(events, structured);
  const sensitiveTools = sensitive.contains([toolIntents, responsesSensitiveValues(response), eventValues.toolArguments]);
  const sensitiveStructured = structured && sensitive.contains([protocolJsonStrings(text), eventValues.text]);
  if (sensitiveTools || sensitiveStructured || sensitive.contains([text, structuredOutput, native, assembler.sensitiveValues, eventValues.text, protocolTokenSequences(native)])) {
    if (state === 'completed') state = 'failed';
    reason = sensitiveTools ? 'credential-in-tool-output' : 'credential-in-output';
    if (sensitiveStructured || sensitive.contains(structuredOutput)) text = '';
    // Split deltas can reconstruct a credential even when no individual delta contains it.
    // A sensitive result is non-consumable; withhold its native body instead of retaining fragments.
    native = { ...originalNative, events: [], response: null, output: [], upstreamError: null, redacted: true };
  }
  if (state === 'completed') {
    try { validateResponsesNative(native, nativeTools ?? []); }
    catch { state = 'failed'; reason = 'invalid-native-result'; }
  }
  if (['malformed-response', 'invalid-native-result'].includes(reason))
    native = { ...native, events: [], response: null, output: [], upstreamError: null, redacted: true };
  return { state, reason, text: clean(text), usage, toolIntents: state === 'completed' ? toolIntents : [],
    native, ...(upstream ? { upstream } : {}) };
}
