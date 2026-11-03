import { modelCapabilityDecisionSchema, modelCapabilityRequirementSchema } from '@xunjie/contracts/model-connections';
import type { ModelConfiguration, ModelConnection, ModelCapabilityInput, ModelCapabilityDecision, ModelCapabilityRequirement } from '@xunjie/contracts/model-connections';
import { sdkVersion, nativeAdapterVersion } from './chat.js';
import { responsesAdapterVersion } from './responses.js';
import { messagesAdapterVersion, messagesSdkVersion, unsupportedMessagesRoute } from './messages.js';

export class ModelCapabilityError extends Error {
  readonly code = 'capability-unavailable';
  constructor(readonly decision: ModelCapabilityDecision) {
    super('Required model capabilities are unavailable');
    this.name = 'ModelCapabilityError';
  }
}

/** Pure decision over the owner's immutable snapshot. Never probes, dispatches or selects another route. */
export function decideModelCapabilities(connection: ModelConnection, prefix: ModelCapabilityInput['prefix']): ModelCapabilityDecision {
  const options = prefix.options, evidence = connection.capabilityEvidence;
  const limitations = [...(evidence?.limitations ?? [])];
  const required = new Set<ModelCapabilityRequirement>(options?.requiredCapabilities ?? []);
  if (prefix.tools.some(tool => tool.strict)) required.add('strictTools');
  if (options?.applicationSchema) required.add('applicationSchema');
  if (options?.responseFormat?.kind === 'json-object') required.add('jsonMode');
  if (options?.responseFormat?.kind === 'json-schema' && (options.responseFormat.strict || connection.protocol === 'messages')) required.add('nativeStrict');
  const forced = typeof options?.toolChoice === 'object';
  if (forced) required.add('forcedTool');
  const items = modelCapabilityRequirementSchema.options.map(capability => {
    let state: ModelConnection['capabilities']['text'];
    let source: ModelCapabilityDecision['items'][number]['evidence']['source'] = evidence ? 'measured-route' : 'unmeasured-route';
    if (capability === 'applicationSchema') { state = 'verified'; source = 'application-validator'; }
    else if (capability === 'forcedTool') state = limitations.includes('thinking-forced-tool-unsupported') ? 'unsupported'
      : evidence?.testedToolChoice === 'named' ? 'verified' : 'unknown';
    else state = connection.capabilities[capability === 'nativeStrict' ? 'strictSchema' : capability] ?? 'unknown';
    if (capability === 'jsonMode' && connection.protocol === 'messages') {
      state = 'unsupported'; source = 'adapter-constraint';
      if (!limitations.includes('messages-json-object-not-supported')) limitations.push('messages-json-object-not-supported');
    }
    return { capability, status: state === 'verified' ? 'available' as const : state === 'unsupported' ? 'unsupported' as const : 'unknown' as const,
      evidence: { state, source } };
  });
  const missing = items.filter(item => required.has(item.capability) && item.status !== 'available');
  return modelCapabilityDecisionSchema.parse({ connectionId: connection.connectionId, routeId: connection.routeId,
    configurationVersion: connection.version, protocol: connection.protocol, parameterMode: connection.parameterMode,
    required: [...required], items, available: missing.length === 0, missing, limitations,
    ...(evidence ? { evidence: { observedAt: evidence.observedAt, sdk: evidence.sdk, adapter: evidence.adapter, testedToolChoice: evidence.testedToolChoice } } : {}),
    assembly: { toolImages: connection.protocol === 'messages' ? 'native-tool-result-image'
      : connection.protocol === 'responses' ? 'native-function-output-image' : 'paired-text-adjacent-user-image',
    replay: 'full-native-history', output: options?.responseFormat?.kind === 'json-object' ? 'native-json-object'
      : options?.responseFormat?.kind === 'json-schema' ? 'native-json-schema' : 'text', applicationValidation: !!options?.applicationSchema } });
}

/** Reviewed route samples, never inferred from the display name or a successful connection check.
 * Evidence and counterexamples: docs/student-agent-implementation/wp06-{chat-selection,messages,responses}-acceptance.md.
 * They describe this dated parameter combination; credentials/availability remain separate facts. */
export function measuredCapabilities(configuration: ModelConfiguration) {
  const capabilities = { text: 'unknown', images: 'unknown', tools: 'unknown', strictSchema: 'unknown',
    nativeReplay: 'unknown', jsonMode: 'unknown', applicationSchema: 'verified' } as const;
  const endpoint = configuration.baseUrl.replace(/\/$/, '') + configuration.path;
  if (unsupportedMessagesRoute(configuration)) return {
    capabilities: { ...capabilities, text: 'unsupported' as const, images: 'unsupported' as const, tools: 'unsupported' as const,
      nativeReplay: 'unsupported' as const, strictSchema: 'unsupported' as const, strictTools: 'unsupported' as const, jsonMode: 'unsupported' as const },
    capabilityEvidence: { observedAt: '2026-11-03', sdk: messagesSdkVersion, adapter: messagesAdapterVersion, endpoint,
      modelId: configuration.modelId, protocol: configuration.protocol, parameterMode: configuration.parameterMode,
      testedToolChoice: 'not-tested' as const, toolImageStrategy: 'not-applicable' as const, limitations: ['provider-catalogue-excludes-messages'] },
  };
  if (configuration.protocol === 'messages' && messagesSdkVersion === '@anthropic-ai/sdk@1.1.0' && messagesAdapterVersion === 'xunjie-messages-native-v1'
    && endpoint === 'https://api.deepseek.com/anthropic/v1/messages' && configuration.modelId === 'deepseek-flash' && configuration.dialect === 'deepseek') {
    const thinking = configuration.parameterMode === 'thinking';
    return { capabilities: { ...capabilities, text: 'verified' as const, jsonMode: 'unsupported' as const,
      ...(thinking ? { images: 'verified' as const, tools: 'verified' as const, nativeReplay: 'verified' as const }
        : { strictSchema: 'unsupported' as const, strictTools: 'unsupported' as const }) },
      capabilityEvidence: { observedAt: '2026-11-03', sdk: messagesSdkVersion, adapter: messagesAdapterVersion, endpoint,
        modelId: configuration.modelId, protocol: configuration.protocol, parameterMode: configuration.parameterMode,
        testedToolChoice: thinking ? 'auto' as const : 'named' as const, toolImageStrategy: 'native-tool-result-image' as const,
        limitations: ['anthropic-version-2023-06-01', 'budget-tokens-ignored-by-provider', 'is-error-requires-paired-text', 'input-tokens-exclude-cache-hits',
          ...(thinking ? ['thinking-forced-tool-unsupported'] : ['output-config-format-not-enforced', 'strict-tool-schema-not-enforced'])] } };
  }
  if (configuration.protocol === 'responses' && sdkVersion === 'openai@7.42.0' && responsesAdapterVersion === 'xunjie-responses-native-v1'
    && endpoint === 'https://api.deepseek.com/v1/responses' && configuration.modelId === 'deepseek-flash' && configuration.dialect === 'deepseek') {
    return { capabilities: { ...capabilities, text: 'verified' as const, strictTools: 'unknown' as const,
      serverStorage: 'unsupported' as const, serverQuery: 'unsupported' as const, serverCancel: 'unsupported' as const,
      ...(configuration.parameterMode === 'thinking' ? { images: 'verified' as const, tools: 'verified' as const, nativeReplay: 'verified' as const }
        : { jsonMode: 'verified' as const, strictSchema: 'verified' as const }) },
      capabilityEvidence: { observedAt: '2026-11-03', sdk: sdkVersion, adapter: responsesAdapterVersion, endpoint,
        modelId: configuration.modelId, protocol: configuration.protocol, parameterMode: configuration.parameterMode,
        toolImageStrategy: 'native-function-output-image' as const, testedToolChoice: 'auto' as const,
        limitations: ['stateless-full-native-history', 'native-schema-tested-flat-boolean-object-only', 'strict-tools-negative-control-inconclusive',
          ...(configuration.parameterMode === 'thinking' ? ['thinking-forced-tool-unsupported'] : [])] } };
  }
  if (configuration.protocol !== 'chat-completions' || sdkVersion !== 'openai@7.42.0' || nativeAdapterVersion !== 'xunjie-chat-native-v2') return { capabilities };
  const deepseek = endpoint === 'https://api.deepseek.com/v1/chat/completions' && configuration.modelId === 'deepseek-flash' && configuration.dialect === 'deepseek';
  const command = endpoint === 'https://api.commandcode.ai/provider/v1/chat/completions' && configuration.modelId === 'deepseek/deepseek-v4.1-flash'
    && configuration.dialect === 'command-code' && configuration.parameterMode === 'plain';
  if (!deepseek && !command) return { capabilities };
  const native = command || deepseek && configuration.parameterMode === 'thinking';
  return { capabilities: { ...capabilities, text: 'verified' as const,
    ...(native ? { images: 'verified' as const, tools: 'verified' as const, nativeReplay: 'verified' as const } : {}),
    ...(configuration.parameterMode === 'plain' ? { jsonMode: 'verified' as const, strictSchema: 'unsupported' as const } : {}) },
    capabilityEvidence: { observedAt: '2026-11-02', sdk: sdkVersion, adapter: nativeAdapterVersion, endpoint,
      modelId: configuration.modelId, protocol: configuration.protocol, parameterMode: configuration.parameterMode,
      toolImageStrategy: 'paired-text-adjacent-user-image' as const, testedToolChoice: 'auto' as const,
      limitations: deepseek && configuration.parameterMode === 'thinking' ? ['thinking-forced-tool-unsupported'] : [] } };
}
