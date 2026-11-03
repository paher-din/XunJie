import OpenAI from 'openai';
import type { ModelConfiguration, ModelUsage, ModelTool, ModelUpstream } from '@xunjie/contracts/model-connections';
import { modelUsageSchema } from '@xunjie/contracts/model-connections';
import { createChatAssembler, compileOutputSchema, chatSensitiveValues } from './chat-native.js';
import { createSensitiveOutput, protocolJsonStrings, protocolTokenSequences } from './sensitive-output.js';
import { responseFacts } from './upstream-facts.js';

export const chatAdapterVersion = 'xunjie-chat-text-v1';
export const sdkVersion = 'openai@7.42.0';
export const nativeAdapterVersion = 'xunjie-chat-native-v2';
export type ChatPayload = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & { thinking?: { type: string } };
class MalformedResponse extends Error {}
export function checkPayload(configuration: ModelConfiguration, maxOutputTokens: number) {
  return { model: configuration.modelId, messages: [{ role: 'user' as const, content: 'Reply briefly with OK to check this model connection.' }],
    max_tokens: maxOutputTokens, stream: true as const, stream_options: { include_usage: true },
    ...(configuration.dialect === 'deepseek' ? { thinking: { type: configuration.parameterMode === 'thinking' ? 'enabled' : 'disabled' } } : {}) };
}
export async function runChat(configuration: ModelConfiguration, apiKey: string, payload: ChatPayload,
  signal: AbortSignal, timeoutMs: number, nativeTools?: ModelTool[], applicationSchema?: Record<string, unknown>, requestFetch: typeof fetch = fetch) {
  const sensitive = createSensitiveOutput(apiKey), { clean } = sensitive;
  const chunks: unknown[] = [];
  const assembler = createChatAssembler(configuration.dialect);
  let text = '', finishReason: string | null = null, bytes = 0, usage: ModelUsage = { state: 'unknown' };
  let upstreamError: unknown = null, upstream: ModelUpstream | undefined;
  let responseLimited = false, finalUsage = false;
  const deadline = AbortSignal.timeout(timeoutMs), requestSignal = AbortSignal.any([signal, deadline]);
  let reason = 'missing-terminal', state: 'completed' | 'incomplete' | 'failed' | 'unknown' | 'cancelled' = 'incomplete';
  const client = new OpenAI({ apiKey, baseURL: configuration.baseUrl.replace(/\/$/, ''), maxRetries: 0, timeout: timeoutMs,
    logLevel: 'off', fetchOptions: { redirect: 'error' }, fetch: async (input, init) => {
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
    const stream = await client.chat.completions.create(payload, { signal: requestSignal });
    for await (const value of stream) {
      const encoded = JSON.stringify(value);
      bytes += Buffer.byteLength(encoded);
      if (bytes > 2_000_000) { responseLimited = true; stream.controller.abort(); reason = 'response-limit'; break; }
      chunks.push(JSON.parse(encoded));
      try { assembler.add(value); } catch { throw new MalformedResponse(); }
      if (!Array.isArray(value.choices)) throw new MalformedResponse();
      const choice = value.choices.find(item => item.index === 0);
      if (choice && (!choice.delta || choice.delta.content != null && typeof choice.delta.content !== 'string'
        || choice.finish_reason != null && typeof choice.finish_reason !== 'string')) throw new MalformedResponse();
      if (choice?.delta.content) text += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (value.usage) {
        const native = value.usage;
        if ([native.prompt_tokens, native.completion_tokens, native.total_tokens, native.prompt_tokens_details?.cached_tokens,
          native.completion_tokens_details?.reasoning_tokens].some(value => value != null && (!Number.isSafeInteger(value) || value < 0)))
          throw new MalformedResponse();
        const parsed = modelUsageSchema.safeParse({ state: 'partial',
          ...(typeof native.prompt_tokens === 'number' ? { inputTokens: native.prompt_tokens } : {}),
          ...(typeof native.completion_tokens === 'number' ? { outputTokens: native.completion_tokens } : {}),
          ...(typeof native.total_tokens === 'number' ? { totalTokens: native.total_tokens } : {}),
          ...(typeof native.prompt_tokens_details?.cached_tokens === 'number' ? { cachedTokens: native.prompt_tokens_details.cached_tokens } : {}),
          ...(typeof native.completion_tokens_details?.reasoning_tokens === 'number' ? { reasoningTokens: native.completion_tokens_details.reasoning_tokens } : {}) });
        if (!parsed.success) throw new MalformedResponse();
        usage = Object.keys(parsed.data).length > 1 ? parsed.data : { state: 'unknown' };
        // A usage-bearing chunk at/after the protocol finish is the final usage fact.
        finalUsage = !!finishReason && usage.inputTokens !== undefined
          && usage.outputTokens !== undefined && usage.totalTokens !== undefined;
      }
    }
  } catch (error) {
    const status = (error instanceof OpenAI.APIError ? error.status : undefined)
      ?? (upstream?.httpStatus && upstream.httpStatus >= 400 ? upstream.httpStatus : undefined);
    if (!upstream && status && error instanceof OpenAI.APIError) upstream = responseFacts(status, error.headers ?? new Headers(), apiKey);
    const malformed = error instanceof MalformedResponse || error instanceof SyntaxError;
    const explicitError = error instanceof OpenAI.APIError && !(error instanceof OpenAI.APIConnectionError)
      && !(error instanceof OpenAI.APIUserAbortError);
    const unsupported = error instanceof OpenAI.APIError && ['unsupported_model', 'model_not_supported', 'model_not_found',
      'unsupported_parameter', 'unsupported_value'].includes(error.code ?? '');
    if (error instanceof OpenAI.APIError && error.error) upstreamError = error.error;
    reason = malformed ? 'malformed-response' : status === 401 || status === 403 ? 'authentication'
      : status === 429 ? 'rate-limited' : unsupported ? 'upstream-unsupported' : status ? 'upstream-http' : explicitError ? 'upstream-stream-error'
      : signal.aborted ? 'client-abort' : deadline.aborted || error instanceof OpenAI.APIConnectionTimeoutError ? 'upstream-timeout' : 'upstream-stream';
    state = malformed || status || explicitError ? 'failed' : signal.aborted ? 'cancelled' : chunks.length ? 'incomplete' : 'unknown';
  }
  // Only transport loss/abort may yield to an already received protocol terminal.
  // Format errors, explicit upstream errors and resource limits remain authoritative.
  if (state !== 'failed') {
    if (finishReason) {
      reason = finishReason;
      state = finishReason === 'stop' || nativeTools && finishReason === 'tool_calls' ? 'completed' : 'incomplete';
    } else if (requestSignal.aborted) {
      state = signal.aborted ? 'cancelled' : chunks.length ? 'incomplete' : 'unknown';
      reason = signal.aborted ? 'client-abort' : 'upstream-timeout';
    }
  }
  if (responseLimited) { state = 'incomplete'; reason = 'response-limit'; }
  if (finalUsage) usage = { ...usage, state: 'final' };
  const assembled = assembler.result(nativeTools ?? []);
  if (state === 'completed' && assembled && !assembled.valid) { state = 'failed'; reason = 'invalid-native-result'; }
  if (state === 'completed' && assembled?.assistant?.refusal) { state = 'failed'; reason = 'content-refused'; }
  if (state === 'completed' && (payload.tool_choice === 'none' && assembled?.intents.length
    || typeof payload.tool_choice === 'object' && payload.tool_choice.type === 'function'
      && (assembled?.intents.length !== 1 || assembled.intents[0]?.name !== payload.tool_choice.function.name))) {
    state = 'failed'; reason = 'tool-choice-not-honored';
  }
  let structuredOutput: unknown;
  if (state === 'completed' && finishReason === 'stop' && (applicationSchema || payload.response_format && payload.response_format.type !== 'text')) {
    try {
      const value: unknown = JSON.parse(text); structuredOutput = value;
      if (value === null || typeof value !== 'object' || Array.isArray(value) || applicationSchema && !compileOutputSchema(applicationSchema)(value)) throw new Error();
      if (payload.response_format?.type === 'json_schema' && !compileOutputSchema(payload.response_format.json_schema.schema ?? {})(value)) throw new Error();
    } catch { state = 'failed'; reason = 'invalid-structured-output'; }
  }
  let native: { formatVersion: number; sdk: string; adapter: string; chunks: unknown[]; finishReason: string | null;
    upstreamError: unknown; assistant: typeof assembled.assistant | null; choices: typeof assembled.choices; redacted?: boolean; upstream?: ModelUpstream }
    = { formatVersion: 1, sdk: sdkVersion, adapter: nativeTools ? nativeAdapterVersion : chatAdapterVersion,
      chunks, finishReason, upstreamError, assistant: assembled.assistant, choices: assembled.choices, ...(upstream ? { upstream } : {}) };
  const sensitiveTools = sensitive.contains(assembled.decodedArguments);
  const structured = !!(applicationSchema || payload.response_format && payload.response_format.type !== 'text');
  const sensitiveStructured = structured && sensitive.contains(protocolJsonStrings(text));
  if (sensitiveTools || sensitiveStructured || sensitive.contains([text, structuredOutput, native, chatSensitiveValues(chunks, structured), protocolTokenSequences(native)])) {
    if (state === 'completed') state = 'failed';
    reason = sensitiveTools ? 'credential-in-tool-output' : 'credential-in-output';
    if (sensitiveStructured || sensitive.contains(structuredOutput)) text = '';
    // Do not alter replay bytes or retain fragments from a sensitive result.
    native = { ...native, chunks: [], assistant: null, choices: [], finishReason: null, upstreamError: null, redacted: true };
  }
  if (['malformed-response', 'invalid-native-result'].includes(reason)) {
    // Rejected protocol data has no trustworthy replay interpretation. Retain facts, not raw bytes.
    native = { ...native, chunks: [], assistant: null, choices: [], finishReason: null, upstreamError: null, redacted: true };
  }
  return { state, reason, text: clean(text), usage, toolIntents: state === 'completed' ? assembled.intents : [],
    native, ...(upstream ? { upstream } : {}) };
}
