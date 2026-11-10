import type { ReasoningEffort } from './model-reasoning.js';

export type ModelPresetProtocol = 'chat-completions' | 'responses' | 'messages';
export interface PresetModel {
  modelId: string;
  name?: string;
  protocol?: ModelPresetProtocol;
  protocols?: ModelPresetProtocol[];
  contextWindow?: number;
  maxOutputTokens?: number;
  efforts?: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  reasoningKind?: 'effort' | 'toggle' | 'none';
}
export interface ModelPresetVariant {
  id: string;
  name: string;
  /** Messages bases exclude /v1, because the native SDK appends /v1/messages. */
  baseUrls: Partial<Record<ModelPresetProtocol, string>>;
  modelsUrl: string;
  models: PresetModel[];
}
export interface ModelProviderPreset {
  id: 'deepseek' | 'opencode-go' | 'command-code' | 'zhipu' | 'kimi' | 'mimo';
  name: string;
  icon: string;
  variants: ModelPresetVariant[];
}

// Reviewed 2026-11-10. These are offline discovery seeds, never verified access.
// A missing capacity is deliberately absent, especially on coding/token plans;
// native API limits must not be silently attributed to a different channel.
// https://api-docs.deepseek.com/api/list-models/
// https://opencode.ai/docs/console/go/ and /console/harnesses/
// https://commandcode.ai/docs/provider
// https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3
// https://docs.bigmodel.cn/cn/coding-plan/tool/others
// https://platform.kimi.com/docs/models and /docs/guide/use-reasoning-effort
// https://platform.kimi.com/docs/api/chat (K3 max_completion_tokens ceiling,
// 1,048,576; the documented 131,072 default is not the model ceiling).
// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://mimo.mi.com/docs/en-US/api/chat/responses
// https://mimo.mi.com/docs/en-US/api/chat/responses-post (max_output_tokens)
// https://mimo.mi.com/docs/quick-start/model (all three 2.6 model contexts)
// https://mimo.mi.com/docs/tokenplan/integration/opencode (numeric 1M=1048576)
// https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access
// https://platform.xiaomimimo.com/docs/en-US/usage-guide/passing-back-reasoning_content
// Go capacity references: anomalyco/models.dev providers/opencode-go (catalogue,
// not a live Go test). Magpie d657e182a725d29c85ba6ac1e9ec492caae7a5da
// presets corroborate plan base URLs; its obsolete /zen/go URLs are not copied.
export const modelProviderPresets: ModelProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek 官方', icon: 'deepseek', variants: [
    { id: 'api', name: '普通 API', baseUrls: { 'chat-completions': 'https://api.deepseek.com/v1',
      responses: 'https://api.deepseek.com/v1', messages: 'https://api.deepseek.com/anthropic' },
    modelsUrl: 'https://api.deepseek.com/models', models: [
      { modelId: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', protocol: 'chat-completions',
        contextWindow: 1048576, maxOutputTokens: 393216, efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high', reasoningKind: 'effort' },
      { modelId: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', protocol: 'chat-completions',
        contextWindow: 1048576, maxOutputTokens: 393216, efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high', reasoningKind: 'effort' },
    ] },
  ] },
  { id: 'opencode-go', name: 'OpenCode Go', icon: 'opencode', variants: [
    { id: 'go', name: 'Go', baseUrls: { 'chat-completions': 'https://opencode.ai/inference/go/openai/v1',
      responses: 'https://opencode.ai/inference/go/openai/v1', messages: 'https://opencode.ai/inference/go/anthropic' },
    modelsUrl: 'https://opencode.ai/inference/go/v1/models', models: [
      { modelId: 'glm-5.3', name: 'GLM-5.3', protocol: 'chat-completions', contextWindow: 1000000,
        maxOutputTokens: 131072, efforts: ['low', 'high', 'max'], reasoningKind: 'effort' },
      { modelId: 'minimax-m3', name: 'MiniMax M3', protocol: 'messages', contextWindow: 1000000,
        maxOutputTokens: 131072, efforts: ['none', 'enabled'], reasoningKind: 'toggle' },
      { modelId: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', protocol: 'chat-completions',
        efforts: ['none', 'low', 'high', 'max'], reasoningKind: 'effort' },
    ] },
  ] },
  { id: 'command-code', name: 'Command Code', icon: 'command-code', variants: [
    { id: 'api', name: 'Provider API', baseUrls: { 'chat-completions': 'https://api.commandcode.ai/provider/v1',
      responses: 'https://api.commandcode.ai/provider/v1', messages: 'https://api.commandcode.ai/provider' },
    modelsUrl: 'https://api.commandcode.ai/provider/v1/models', models: [
      { modelId: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', protocol: 'chat-completions',
        protocols: ['chat-completions', 'responses'], contextWindow: 1000000 },
      { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', protocol: 'messages', protocols: ['messages'], contextWindow: 1000000 },
    ] },
  ] },
  { id: 'zhipu', name: '智谱', icon: 'zhipu', variants: [
    { id: 'api', name: '普通 API', baseUrls: { 'chat-completions': 'https://open.bigmodel.cn/api/paas/v4',
      responses: 'https://open.bigmodel.cn/api/v1', messages: 'https://open.bigmodel.cn/api/anthropic' },
    modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models', models: [
      { modelId: 'glm-5.3', name: 'GLM-5.3', protocol: 'chat-completions', contextWindow: 1000000,
        maxOutputTokens: 131072, efforts: ['low', 'high', 'max'], defaultEffort: 'max', reasoningKind: 'effort' },
    ] },
    { id: 'coding', name: 'GLM Coding Plan', baseUrls: { 'chat-completions': 'https://open.bigmodel.cn/api/coding/paas/v4',
      responses: 'https://open.bigmodel.cn/api/v1', messages: 'https://open.bigmodel.cn/api/anthropic' },
    modelsUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/models', models: [
      { modelId: 'glm-5.3', name: 'GLM-5.3', protocol: 'chat-completions', efforts: ['low', 'high', 'max'], defaultEffort: 'max', reasoningKind: 'effort' },
      { modelId: 'glm-5.2', name: 'GLM-5.2', protocol: 'chat-completions', contextWindow: 1000000 },
    ] },
  ] },
  { id: 'kimi', name: 'Kimi', icon: 'kimi', variants: [
    { id: 'api', name: '普通 API', baseUrls: { 'chat-completions': 'https://api.moonshot.cn/v1',
      messages: 'https://api.moonshot.cn/anthropic' }, modelsUrl: 'https://api.moonshot.cn/v1/models', models: [
      { modelId: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', protocol: 'chat-completions', contextWindow: 1048576, maxOutputTokens: 1048576,
        efforts: ['low', 'high', 'max'], defaultEffort: 'max', reasoningKind: 'effort' },
      { modelId: 'kimi-k3.1-pro-highspeed', name: 'Kimi K3.1 Pro Highspeed', protocol: 'chat-completions', contextWindow: 1048576, maxOutputTokens: 1048576,
        efforts: ['low', 'high', 'max'], defaultEffort: 'max', reasoningKind: 'effort' },
      { modelId: 'kimi-k3', name: 'Kimi K3', protocol: 'chat-completions', contextWindow: 1048576, maxOutputTokens: 1048576,
        efforts: ['low', 'high', 'max'], defaultEffort: 'max', reasoningKind: 'effort' },
    ] },
    { id: 'code', name: 'Kimi Code', baseUrls: { 'chat-completions': 'https://api.kimi.com/coding/v1',
      responses: 'https://api.kimi.com/coding/v1', messages: 'https://api.kimi.com/coding' },
    modelsUrl: 'https://api.kimi.com/coding/v1/models', models: [
      { modelId: 'k3.1-pro', name: 'Kimi K3.1 Pro', protocol: 'responses', efforts: ['low', 'high', 'max'], defaultEffort: 'high', reasoningKind: 'effort' },
      { modelId: 'k3', name: 'Kimi K3', protocol: 'responses', efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high', reasoningKind: 'effort' },
      { modelId: 'k3-256k', name: 'Kimi K3 · 256K', protocol: 'responses', contextWindow: 262144,
        efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high', reasoningKind: 'effort' },
      { modelId: 'kimi-for-coding', name: 'Kimi K2.8 Preview', protocol: 'responses', contextWindow: 1048576,
        efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'max', reasoningKind: 'effort' },
    ] },
  ] },
  { id: 'mimo', name: '小米 MiMo', icon: 'mimo', variants: [
    { id: 'api', name: '普通 API', baseUrls: { 'chat-completions': 'https://api.xiaomimimo.com/v1',
      responses: 'https://api.xiaomimimo.com/v1', messages: 'https://api.xiaomimimo.com/anthropic' },
    modelsUrl: 'https://api.xiaomimimo.com/v1/models', models: [
      { modelId: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', protocol: 'chat-completions', contextWindow: 1048576, maxOutputTokens: 131072,
        efforts: ['none', 'enabled'], defaultEffort: 'enabled', reasoningKind: 'toggle' },
      { modelId: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', protocol: 'chat-completions', contextWindow: 1048576, maxOutputTokens: 131072,
        efforts: ['none', 'enabled'], defaultEffort: 'enabled', reasoningKind: 'toggle' },
      { modelId: 'mimo-v2.6-pro-ultraspeed', name: 'MiMo V2.6 Pro Ultraspeed', protocol: 'chat-completions', contextWindow: 1048576, maxOutputTokens: 131072,
        efforts: ['none', 'enabled'], defaultEffort: 'enabled', reasoningKind: 'toggle' },
    ] },
    { id: 'token', name: 'Token Plan · 中国', baseUrls: { 'chat-completions': 'https://token-plan-cn.xiaomimimo.com/v1',
      responses: 'https://token-plan-cn.xiaomimimo.com/v1', messages: 'https://token-plan-cn.xiaomimimo.com/anthropic' },
    modelsUrl: 'https://token-plan-cn.xiaomimimo.com/v1/models', models: [
      { modelId: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', protocol: 'chat-completions', efforts: ['none', 'enabled'], defaultEffort: 'enabled', reasoningKind: 'toggle' },
      { modelId: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', protocol: 'chat-completions', efforts: ['none', 'enabled'], defaultEffort: 'enabled', reasoningKind: 'toggle' },
    ] },
  ] },
];

/** First variant is the default; explicit unknown IDs never silently choose another plan. */
export function getModelPreset(presetId: string, variantId?: string): ModelPresetVariant | undefined {
  const preset = modelProviderPresets.find(item => item.id === presetId);
  const variant = variantId === undefined ? preset?.variants[0] : preset?.variants.find(item => item.id === variantId);
  return variant && { ...variant, baseUrls: { ...variant.baseUrls }, models: variant.models.map(model => ({ ...model,
    ...(model.protocols ? { protocols: [...model.protocols] } : {}), ...(model.efforts ? { efforts: [...model.efforts] } : {}) })) };
}

/** Live supportedProtocols override offline seed restrictions; no protocol means no route. */
export function resolvePresetModelRoute(presetId: string, variantId: string | undefined, modelId: string,
  supportedProtocols?: readonly ModelPresetProtocol[]): { protocol: ModelPresetProtocol; baseUrl: string } | undefined {
  const variant = getModelPreset(presetId, variantId);
  if (!variant) return undefined;
  const model = variant.models.find(item => item.modelId === modelId);
  const allowed = supportedProtocols ?? model?.protocols;
  const candidates: ModelPresetProtocol[] = [...new Set([...(model?.protocol ? [model.protocol] : []),
    ...(['chat-completions', 'responses', 'messages'] as const)])];
  for (const protocol of candidates) {
    const baseUrl = variant.baseUrls[protocol];
    if (baseUrl && (allowed === undefined || allowed.includes(protocol))) return { protocol, baseUrl };
  }
}
