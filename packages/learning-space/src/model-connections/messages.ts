import { createJsonToolProgress } from './json-tool-progress.js';
import type { ModelToolProgress } from '@xunjie/contracts/model-connections';
import Anthropic from '@anthropic-ai/sdk';
import { StorageError } from '@xunjie/storage';
import type { ModelConfiguration, ModelTool, ModelToolIntent, ModelUpstream } from '@xunjie/contracts/model-connections';
import { modelReasoningParameters } from '@xunjie/contracts/model-connections';
import { createMessagesAssembler, messagesUsage, messagesOutput, validateMessagesNative, messagesEventSensitiveValues } from './messages-native.js';
import { compileOutputSchema } from './chat-native.js';
import { createProgressPublisher, createSensitiveOutput, protocolJsonStrings, protocolTokenSequences } from './sensitive-output.js';
import { responseFacts, contextCapacityFailure, errorFacts, networkFailureReason } from './upstream-facts.js';
export { validateMessagesNative } from './messages-native.js';

export const messagesSdkVersion = '@anthropic-ai/sdk@1.1.0';
export const messagesAdapterVersion = 'xunjie-messages-native-v1';
export type MessagesPayload = Omit<Anthropic.MessageCreateParamsStreaming, 'thinking'> & {
  thinking?: { type: 'disabled' | 'adaptive' } | { type: 'enabled'; budget_tokens?: number };
  prompt_cache_key?: string;
};
export const unsupportedMessagesRoute = (configuration: ModelConfiguration) => configuration.protocol === 'messages'
  && configuration.baseUrl.replace(/\/$/, '') + configuration.path === 'https://api.commandcode.ai/provider/v1/messages'
  && configuration.modelId === 'deepseek/deepseek-v4.1-flash';
export function messagesCheckPayload(configuration: ModelConfiguration, tokens: number): MessagesPayload {
  let reasoning: Record<string, unknown>;
  try { reasoning = modelReasoningParameters(configuration, tokens); }
  catch (error) { if (error instanceof RangeError) throw new StorageError('invalid'); throw error; }
  return { model: configuration.modelId, max_tokens: tokens, stream: true,
    messages: [{ role: 'user', content: 'Reply briefly with OK to check this model connection.' }],
    ...reasoning };
}
export async function runMessages(configuration: ModelConfiguration, apiKey: string, payload: MessagesPayload,
  signal: AbortSignal, timeoutMs: number, nativeTools: ModelTool[] = [], applicationSchema?: Record<string, unknown>,
  requestFetch: typeof fetch = fetch, onText?: (text: string) => void, onTools?: (tools: ModelToolProgress[]) => void,
  requestHeaders?: Record<string, string>) {
  let limited = false, upstream: ModelUpstream | undefined;
  const sensitive = createSensitiveOutput(apiKey);
  const progress = onText ? createProgressPublisher(apiKey, onText) : null;
  const toolProgress = onTools ? createJsonToolProgress(nativeTools ?? [], apiKey, onTools) : null;
  const host = new URL(configuration.baseUrl).hostname;
  const mimo = host === 'api.xiaomimimo.com' || /^token-plan-(?:cn|sgp|ams)\.xiaomimimo\.com$/.test(host);
  // MiMo documents api-key or Bearer, not Anthropic's x-api-key spelling.
  const client = new Anthropic({ ...(mimo ? { apiKey: null, authToken: apiKey } : { apiKey }),
    baseURL: configuration.baseUrl.replace(/\/$/, ''), maxRetries: 0,
    timeout: timeoutMs, logLevel: 'off', fetchOptions: { redirect: 'error' },
    ...(configuration.dialect === 'deepseek' ? { defaultHeaders: { 'anthropic-version': '2023-06-01' } } : {}),
    fetch: async (input, init) => {
      const response = await requestFetch(input, init); upstream = responseFacts(response.status, response.headers, apiKey); if (!response.body) return response;
      let received = 0;
      return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > 2_000_000) { limited = true; controller.error(new Error('response-limit')); } else controller.enqueue(chunk);
      } })), { status: response.status, statusText: response.statusText, headers: response.headers });
    } });
  const events: unknown[] = [], assembler = createMessagesAssembler();
  const deadline = AbortSignal.timeout(timeoutMs), requestSignal = AbortSignal.any([signal, deadline]);
  let state: 'completed' | 'incomplete' | 'failed' | 'unknown' | 'cancelled' = 'incomplete', reason = 'missing-terminal';
  try {
    // Raw SDK events, with bounded explicit aggregation. No SDK multi-turn/tool helpers.
    // In SDK 1.1.0 MessageStream overwrites each signature_delta; we preserve all fragments.
    const stream = await client.messages.create(payload as Anthropic.MessageCreateParamsStreaming, { signal: requestSignal,
      ...(requestHeaders ? { headers: requestHeaders } : {}) });
    for await (const event of stream) { events.push(structuredClone(event)); assembler.add(event); toolProgress?.(assembler.toolArguments); progress?.(assembler.text); }
  } catch (error) {
    const status = (error instanceof Anthropic.APIError ? error.status : undefined)
      ?? (upstream?.httpStatus && upstream.httpStatus >= 400 ? upstream.httpStatus : undefined);
    if (!upstream && status && error instanceof Anthropic.APIError) upstream = responseFacts(status, error.headers ?? new Headers(), apiKey);
    upstream = { ...upstream, ...errorFacts(error, apiKey) };
    const malformed = error instanceof StorageError || error instanceof SyntaxError;
    const confirmedStreamError = error instanceof Anthropic.APIError && !(error instanceof Anthropic.APIConnectionError)
      && !(error instanceof Anthropic.APIUserAbortError);
    const unsupported = ['unsupported_model', 'model_not_supported', 'model_not_found', 'unsupported_parameter', 'unsupported_value']
      .includes(upstream.errorCode ?? '');
    state = malformed || status || confirmedStreamError ? 'failed'
      : signal.aborted ? 'cancelled' : events.length ? 'incomplete' : 'unknown';
    reason = malformed ? 'malformed-response' : status === 401 || status === 403 ? 'authentication'
      : status === 429 ? 'rate-limited' : contextCapacityFailure(error instanceof Anthropic.APIError ? error.error : null, status)
        ? 'context-capacity-exceeded' : unsupported ? 'upstream-unsupported' : status ? 'upstream-http'
      : confirmedStreamError ? 'upstream-stream-error' : signal.aborted ? 'client-abort'
      : deadline.aborted || error instanceof Anthropic.APIConnectionTimeoutError ? 'upstream-timeout'
      : networkFailureReason(upstream) ?? 'upstream-stream';
  }
  const message = assembler.message;
  const counters = configuration.dialect === 'deepseek' && assembler.finalUsage ? assembler.finalUsage : message?.usage ?? {};
  let text = assembler.text, usage = messagesUsage(counters, assembler.terminal && assembler.finalUsage?.output_tokens !== undefined), toolIntents: ModelToolIntent[] = [];
  if (state !== 'failed' && assembler.terminal) {
    reason = String(message?.stop_reason);
    state = ['end_turn', 'tool_use', 'stop_sequence'].includes(reason) ? 'completed' : reason === 'refusal' ? 'failed' : 'incomplete';
    if (reason === 'model_context_window_exceeded') { state = 'failed'; reason = 'context-capacity-exceeded'; }
    if (state === 'completed') try { const result = messagesOutput(message, nativeTools); toolIntents = result.intents; }
    catch { state = 'failed'; reason = 'invalid-native-result'; }
  } else if (state !== 'failed' && signal.aborted) { state = 'cancelled'; reason = 'client-abort'; }
  if (limited) { state = 'incomplete'; reason = 'response-limit'; }
  if (state === 'completed' && (payload.tool_choice?.type === 'none' && toolIntents.length
    || payload.tool_choice?.type === 'tool' && (toolIntents.length !== 1 || toolIntents[0]?.name !== payload.tool_choice.name))) {
    state = 'failed'; reason = 'tool-choice-not-honored';
  }
  const format = payload.output_config?.format;
  let structuredOutput: unknown;
  if (state === 'completed' && !toolIntents.length && (applicationSchema || format)) try {
    structuredOutput = JSON.parse(text) as unknown;
    if (structuredOutput === null || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)
      || applicationSchema && !compileOutputSchema(applicationSchema)(structuredOutput)
      || format && !compileOutputSchema(format.schema)(structuredOutput)) throw new Error();
  } catch { state = 'failed'; reason = 'invalid-structured-output'; }
  let native: { formatVersion: number; sdk: string; adapter: string; events: unknown[]; message: typeof message; redacted?: boolean; upstream?: ModelUpstream }
    = { formatVersion: 1, sdk: messagesSdkVersion, adapter: messagesAdapterVersion, events, message, ...(upstream ? { upstream } : {}) };
  const structured = !!(applicationSchema || format), sensitiveStructured = structured && sensitive.contains(protocolJsonStrings(text));
  if (sensitiveStructured || sensitive.contains([text, structuredOutput, native, assembler.inputJson, assembler.inputStrings, messagesEventSensitiveValues(events, structured), protocolTokenSequences(native)])) {
    if (state === 'completed') state = 'failed';
    reason = 'credential-in-output'; text = '';
    // Sensitive replay bytes (including signed thinking) cannot be rewritten and reused.
    native = { ...native, events: [], message: null, redacted: true };
  }
  if (state === 'completed') try { validateMessagesNative(native, nativeTools); }
  catch { state = 'failed'; reason = 'invalid-native-result'; }
  if (['malformed-response', 'invalid-native-result'].includes(reason))
    native = { ...native, events: [], message: null, redacted: true };
  return { state, reason, text: sensitive.clean(text), usage, toolIntents: state === 'completed' ? toolIntents : [], native, ...(upstream ? { upstream } : {}) };
}
