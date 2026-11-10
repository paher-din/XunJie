import { StorageError } from '@xunjie/storage';
import type { ModelConfiguration, ModelTool, ModelToolProgress } from '@xunjie/contracts/model-connections';
import { modelReasoningError } from '@xunjie/contracts/model-connections';
import { checkPayload, runChat, type ChatPayload } from './chat.js';
import { responsesCheckPayload, runResponses, type ResponsesPayload } from './responses.js';
import { messagesCheckPayload, runMessages, unsupportedMessagesRoute, type MessagesPayload } from './messages.js';

export type NativePayload = ChatPayload | ResponsesPayload | MessagesPayload;
export function adapterReady(configuration: ModelConfiguration) {
  return ['chat-completions', 'responses', 'messages'].includes(configuration.protocol)
    && (configuration.protocol !== 'messages' || !unsupportedMessagesRoute(configuration) && !configuration.baseUrl.replace(/\/+$/, '').endsWith('/v1'))
    && !modelReasoningError(configuration);
}
export function connectionCheckPayload(configuration: ModelConfiguration, tokens: number): NativePayload {
  if (configuration.protocol === 'messages') return messagesCheckPayload(configuration, tokens);
  if (configuration.protocol === 'responses') return responsesCheckPayload(configuration, tokens);
  if (configuration.protocol === 'chat-completions') return checkPayload(configuration, tokens);
  throw new StorageError('unavailable');
}
export function limitPayload(configuration: ModelConfiguration, payload: NativePayload, tokens: number): NativePayload {
  // Validate after policy limits are applied. Never enlarge an output limit or
  // lower the selected effort to make a manual thinking budget fit.
  const checked = connectionCheckPayload(configuration, tokens);
  if (configuration.protocol === 'responses') return { ...payload as ResponsesPayload, max_output_tokens: tokens };
  if (configuration.protocol === 'messages') {
    const request = payload as MessagesPayload, reasoning = checked as MessagesPayload;
    return { ...request, max_tokens: tokens,
      ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
      ...(reasoning.output_config ? { output_config: { ...request.output_config, ...reasoning.output_config } } : {}) };
  }
  return (checked as ChatPayload).max_completion_tokens !== undefined
    ? { ...payload as ChatPayload, max_completion_tokens: tokens }
    : { ...payload as ChatPayload, max_tokens: tokens };
}
export async function runModel(configuration: ModelConfiguration, apiKey: string, payload: NativePayload,
  signal: AbortSignal, timeoutMs: number, segment: boolean, applicationSchema?: Record<string, unknown>,
  requestFetch: typeof fetch = fetch, onText?: (text: string) => void, applicationTools?: ModelTool[], onTools?: (tools: ModelToolProgress[]) => void) {
  // Native payloads intentionally contain no application preview metadata.
  const definitions = (tools: ModelTool[] | undefined) => tools?.map(tool => {
    const progress = applicationTools?.find(item => item.name === tool.name)?.progress;
    return { ...tool, ...(progress ? { progress } : {}) };
  });
  if (configuration.protocol === 'responses') {
    const request = payload as ResponsesPayload;
    const tools = segment ? request.tools?.map(tool => {
      if (tool.type !== 'function') throw new StorageError('corrupt');
      return { name: tool.name, description: tool.description ?? '', inputSchema: tool.parameters ?? {} };
    }) ?? [] : undefined;
    return runResponses(configuration, apiKey, request, signal, timeoutMs, definitions(tools), applicationSchema, requestFetch, onText, onTools);
  }
  if (configuration.protocol === 'messages') {
    const request = payload as MessagesPayload;
    const tools = segment ? request.tools?.map(tool => {
      if (!('input_schema' in tool)) throw new StorageError('corrupt');
      return { name: tool.name, description: tool.description ?? '', inputSchema: tool.input_schema };
    }) ?? [] : [];
    return runMessages(configuration, apiKey, request, signal, timeoutMs, definitions(tools) ?? [], applicationSchema, requestFetch, onText, onTools);
  }
  if (configuration.protocol !== 'chat-completions') throw new StorageError('unavailable');
  const request = payload as ChatPayload;
  const tools = segment ? request.tools?.map(tool => {
    if (tool.type !== 'function') throw new StorageError('corrupt');
    return { name: tool.function.name, description: tool.function.description ?? '', inputSchema: tool.function.parameters ?? {} };
  }) ?? [] : undefined;
  return runChat(configuration, apiKey, request, signal, timeoutMs, definitions(tools), applicationSchema, requestFetch, onText, onTools);
}
