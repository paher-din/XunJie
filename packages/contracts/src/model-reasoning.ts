import { getModelPreset } from './model-presets.js';

/** Browser/server shared wire rules; no SDK, network access, DOM or Node globals. */
export type ReasoningEffort = 'auto' | 'none' | 'enabled' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const modelReasoningEfforts = ['auto', 'none', 'enabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface ReasoningRoute {
  protocol: 'chat-completions' | 'responses' | 'messages';
  baseUrl: string;
  modelId: string;
  presetId?: string | undefined;
  variantId?: string | undefined;
  dialect?: 'standard' | 'deepseek' | 'command-code' | undefined;
  parameterMode?: 'plain' | 'thinking' | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  /** Declared levels (manual or supplied by the caller's catalog), never auto.
   * An empty array explicitly declares that no reasoning control is supported. */
  reasoningLevels?: ReasoningEffort[] | undefined;
}

type Family = 'openai' | 'anthropic' | 'deepseek' | 'qwen' | 'glm' | 'kimi' | 'mimo' | 'minimax' | 'unknown';
type Encoding = 'none' | 'openai' | 'openrouter' | 'deepseek' | 'anthropic-adaptive' | 'anthropic-budget'
  | 'anthropic-budget-effort' | 'anthropic-effort' | 'thinking-toggle' | 'thinking-effort' | 'qwen-toggle'
  | 'mimo-toggle' | 'minimax-toggle' | 'kimi-effort' | 'protocol-toggle';
export interface ModelProfile {
  dialect: 'standard' | 'deepseek' | 'command-code';
  efforts: ReasoningEffort[];
  /** manual means caller-declared, not live verification. */
  source: 'known' | 'unknown' | 'manual';
  family: Family;
  /** Identity for lookup only; the request must retain the original modelId. */
  canonicalModelId: string;
  encoding: Encoding;
  reasoningKind?: 'effort' | 'toggle' | 'none';
  defaultEffort?: ReasoningEffort;
}

// Reviewed sources (not an assertion that any relay exposes every native API):
// https://developers.openai.com/api/docs/guides/reasoning
// https://developers.openai.com/api/docs/models/gpt-5.2 (and per-model pages)
// https://platform.claude.com/docs/en/build-with-claude/{thinking,effort,extended-thinking}
// https://api-docs.deepseek.com/guides/thinking_mode/
// https://docs.z.ai/guides/capabilities/thinking
// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
// https://huggingface.co/moonshotai/Kimi-K2.5
// https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
// Lookup through provider/model paths follows the independently implemented idea
// in Magpie 6b92824ff55f19c0c01852725cc26d06559d8caf internal/catalog/catalog.go.
// No extrapolation to future versions, fine-tunes, distillations or arbitrary suffixes.

const standardLevels: ReasoningEffort[] = ['low', 'medium', 'high'];
function hostname(baseUrl: string): string {
  // Validated by the caller's URL schema. Parse only the authority, never a path
  // substring (and do not require the DOM's URL type in contracts).
  return /^https?:\/\/([^/?#@]+)(?:[/?#]|$)/i.exec(baseUrl.trim())?.[1]?.toLowerCase().replace(/:\d+$/, '') ?? '';
}

function canonicalId(modelId: string): string {
  let id = modelId.trim().toLowerCase().split('/').at(-1) ?? '';
  id = id.replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, '');
  id = id.replace(/-v\d+(?::\d+)?$/, '').replace(/:(?:free|nitro|floor)$/, '');
  id = id.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '').replace(/-latest$/, '');
  id = id.replace(/^(claude-(?:opus|sonnet|haiku)-\d)\.(\d)(?=-|$)/, '$1-$2');
  // Vertex dates use @, Bedrock snapshots use -v1:0.
  id = id.replace(/@\d{8}$/, '').replace(/-v\d+$/, '').replace(/-\d{8}$/, '');
  return id;
}

function knownModelProfile(route: ReasoningRoute): ModelProfile {
  const id = canonicalId(route.modelId), host = hostname(route.baseUrl);
  const dialect = host === 'api.commandcode.ai' ? 'command-code'
    : host === 'api.deepseek.com' ? 'deepseek' : route.dialect ?? 'standard';
  const profile: ModelProfile = { dialect, efforts: ['auto'], source: 'unknown', family: 'unknown',
    canonicalModelId: id, encoding: 'none' };
  const kimiCode = /^(?:api\.kimi\.(?:com|ai))$/.test(host) && /^https?:\/\/[^/]+\/coding(?:\/|$)/i.test(route.baseUrl);
  // A gateway's model name does not establish its parameter dialect or levels.
  // OpenRouter documents a unified reasoning object on Chat and Responses;
  // per-model levels still need the caller's catalog/manual declaration.
  if (host === 'openrouter.ai') return { ...profile, dialect: 'standard',
    encoding: route.protocol === 'messages' ? 'none' : 'openrouter' };
  const known = (family: Family, encoding: Encoding, levels: ReasoningEffort[]): ModelProfile => {
    if (family === 'deepseek' && host !== 'api.deepseek.com')
      return { ...profile, family, dialect: dialect === 'command-code' ? dialect : 'standard' };
    return { ...profile, source: 'known', family, encoding, efforts: ['auto', ...levels],
      dialect: dialect === 'command-code' ? dialect : family === 'deepseek' ? 'deepseek' : dialect };
  };
  const typed = (family: Family, encoding: Encoding, levels: ReasoningEffort[],
    reasoningKind: 'effort' | 'toggle' | 'none', defaultEffort?: ReasoningEffort): ModelProfile => ({
    ...known(family, encoding, levels), reasoningKind, ...(defaultEffort ? { defaultEffort } : {}),
  });
  if (/^mimo-v2\.(?:5(?:-pro)?|6-(?:flash|pro)(?:-ultraspeed)?)$/.test(id))
    return typed('mimo', 'mimo-toggle', ['none', 'enabled'], 'toggle', 'enabled');
  if (id === 'minimax-m3' && route.protocol === 'messages')
    return typed('minimax', 'minimax-toggle', ['none', 'enabled'], 'toggle', 'none');
  if (/^kimi-k3(?:\.1-pro(?:-highspeed)?)?$/.test(id)
    || kimiCode && /^(?:k3(?:-256k|\.1-pro(?:-highspeed)?)?|kimi-for-coding)$/.test(id)) {
    const codeSwitch = kimiCode && !id.startsWith('k3.1');
    return typed('kimi', 'kimi-effort', [...(codeSwitch ? ['none'] as const : []), 'low', 'high', 'max'],
      'effort', kimiCode && id !== 'kimi-for-coding' ? 'high' : 'max');
  }
  const openai = (levels: ReasoningEffort[], responsesOnly = false) => known('openai',
    route.protocol === 'messages' || responsesOnly && route.protocol !== 'responses' ? 'none' : 'openai',
    route.protocol === 'messages' || responsesOnly && route.protocol !== 'responses' ? [] : levels);
  if (/^(?:o1|o3|o3-mini|o4-mini)$/.test(id)) return openai(standardLevels);
  if (id === 'o1-mini' || id === 'o1-preview') return openai([]);
  if (id === 'o3-pro' || id === 'gpt-5-pro') return openai(['high'], true);
  if (/^gpt-5\.[245]-pro$/.test(id)) return openai(['medium', 'high', 'xhigh'], true);
  if (/^gpt-5(?:-mini|-nano)?$/.test(id)) return openai(['minimal', ...standardLevels]);
  if (id === 'gpt-5.1') return openai(['none', ...standardLevels]);
  if (/^gpt-5\.[245]$/.test(id)) return openai(['none', ...standardLevels, 'xhigh']);
  if (/^gpt-5-codex$|^gpt-5\.1-codex(?:-mini)?$/.test(id)) return openai(standardLevels, true);
  if (/^gpt-5\.(?:1-codex-max|2-codex|3-codex)$/.test(id)) return openai([...standardLevels, 'xhigh'], true);
  if (/^gpt-(?:4o(?:-mini)?|4\.1(?:-mini|-nano)?)$/.test(id)) return openai([]);

  const claude = (encoding: Encoding, levels: ReasoningEffort[]) => known('anthropic',
    route.protocol === 'messages' ? encoding : 'none', route.protocol === 'messages' ? levels : []);
  if (/^claude-(?:opus-4-[678]|sonnet-4-6)$/.test(id))
    return claude('anthropic-adaptive', ['none', ...standardLevels, ...(id === 'claude-opus-4-6' || id === 'claude-sonnet-4-6' ? [] : ['xhigh'] as ReasoningEffort[]), 'max']);
  if (id === 'claude-opus-4-5') return claude('anthropic-budget-effort', ['none', ...standardLevels]);
  if (/^claude-(?:(?:sonnet|opus)-4(?:-0)?|opus-4-1|(?:sonnet|haiku)-4-5|3-7-sonnet)$/.test(id))
    return claude('anthropic-budget', ['none', 'enabled']);
  if (/^claude-(?:3-5-(?:sonnet|haiku)|3-(?:opus|sonnet|haiku))$/.test(id)) return claude('none', []);

  // V4/V4.1 and the official current aliases have independently selectable
  // low/high/max, not OpenAI's medium or xhigh aliases.
  if (/^deepseek-(?:v4-(?:flash|pro)(?:-\d{4})?|v4\.1-flash(?:-\d{4})?|flash|pro)$/.test(id))
    return { ...known('deepseek', 'deepseek', ['none', 'low', 'high', 'max']),
      ...(host === 'api.deepseek.com' ? { reasoningKind: 'effort' as const, defaultEffort: 'high' as const } : {}) };
  if (/^deepseek-(?:chat|reasoner|v3\.2(?:-exp)?)$/.test(id))
    return known('deepseek', 'deepseek', ['none']);
  if (/^deepseek-r1(?:-0528)?$/.test(id)) return known('deepseek', 'none', []);

  // These models have a thinking switch, not a documented effort ladder.
  if (/^qwen3-(?:0\.6b|1\.7b|4b|8b|14b|32b|30b-a3b|235b-a22b)$/.test(id))
    return known('qwen', route.protocol === 'chat-completions' ? 'qwen-toggle' : 'none',
      route.protocol === 'chat-completions' ? ['none', 'enabled'] : []);
  if (/^glm-(?:4\.[567](?:-air|-airx|-flash)?|5(?:\.1)?)$/.test(id))
    return known('glm', route.protocol === 'chat-completions' ? 'thinking-toggle' : 'none',
      route.protocol === 'chat-completions' ? ['none', 'enabled'] : []);
  if (/^glm-5\.[23](?:-flash)?$/.test(id)) return known('glm',
    route.protocol === 'chat-completions' ? 'thinking-effort' : 'none', route.protocol !== 'chat-completions' ? []
      : id.startsWith('glm-5.3') ? ['low', 'high', 'max'] : ['none', 'high', 'max']);
  if (id === 'kimi-k2.5') return known('kimi', route.protocol === 'chat-completions' ? 'thinking-toggle' : 'none',
    route.protocol === 'chat-completions' ? ['none', 'enabled'] : []);
  if (/^kimi-k2(?:-thinking(?:-turbo)?|-0905-preview|-0711-preview)?$/.test(id)) return known('kimi', 'none', []);
  return profile;
}

function declaredLevelsError(route: ReasoningRoute): string | undefined {
  if (route.reasoningLevels !== undefined && (!Array.isArray(route.reasoningLevels)
    || route.reasoningLevels.some(level => level === 'auto' || !(modelReasoningEfforts as readonly string[]).includes(level))))
    return '声明的思考档位只能包含 none、enabled、minimal、low、medium、high、xhigh、max，不能包含 auto。';
  if (route.reasoningLevels?.includes('enabled') && route.reasoningLevels.some(level => level !== 'enabled' && level !== 'none'))
    return 'enabled 表示思考开关，不能与思考强度档位混合声明。';
}

/** A selected preset only controls wire encoding at that preset's exact route.
 * It supplies neither model capabilities nor verification for unknown models. */
function declaredPresetEncoding(route: ReasoningRoute): Encoding | undefined {
  if (!route.presetId) return;
  const expected = getModelPreset(route.presetId, route.variantId)?.baseUrls[route.protocol];
  const normalized = (value: string) => value.replace(/\/+$/, '').replace(/^(https?:\/\/[^/]+)/i, authority => authority.toLowerCase());
  if (!expected || normalized(expected) !== normalized(route.baseUrl)) return;
  if (route.presetId === 'deepseek') return 'deepseek';
  if (route.presetId === 'zhipu') return route.protocol === 'chat-completions' ? 'thinking-effort'
    : route.protocol === 'responses' ? 'openai' : 'anthropic-effort';
  if (route.presetId === 'kimi') return 'kimi-effort';
}

export function resolveModelProfile(route: ReasoningRoute): ModelProfile {
  const error = declaredLevelsError(route);
  if (error) throw new RangeError(error);
  const profile = knownModelProfile(route);
  // MiMo explicitly maps all non-none effort names to the same ON switch.
  // A relay catalogue must not turn that into a fabricated effort ladder.
  if (profile.encoding === 'mimo-toggle') return describe(profile);
  if (route.reasoningLevels === undefined) return describe(profile);
  const levels = [...new Set(route.reasoningLevels)];
  let encoding: Encoding = profile.encoding;
  // User/catalog declarations override this small reviewed fallback, including
  // alias models. For an unknown dialect use only the selected protocol's
  // standard effort field; never infer a private thinking switch from levels.
  if (profile.source === 'unknown' || encoding === 'none'
    || levels.some(level => level !== 'none' && level !== 'enabled') && ['qwen-toggle', 'thinking-toggle', 'anthropic-budget'].includes(encoding))
    encoding = route.protocol === 'messages' ? 'anthropic-effort'
      : hostname(route.baseUrl) === 'openrouter.ai' ? 'openrouter' : 'openai';
  if (profile.source === 'unknown' && levels.length && !levels.includes('enabled'))
    encoding = declaredPresetEncoding(route) ?? encoding;
  if (!levels.length) encoding = 'none';
  if (levels.includes('enabled') && !['mimo-toggle', 'minimax-toggle', 'qwen-toggle', 'thinking-toggle',
    'anthropic-budget', 'anthropic-budget-effort'].includes(encoding)) encoding = 'protocol-toggle';
  const resolved = describe({ ...profile, source: 'manual', efforts: ['auto', ...levels], encoding });
  if (resolved.defaultEffort && !resolved.efforts.includes(resolved.defaultEffort)) delete resolved.defaultEffort;
  return resolved;
}

function describe(profile: ModelProfile): ModelProfile {
  const levels = profile.efforts.filter(level => level !== 'auto');
  const reasoningKind = levels.includes('enabled') || ['anthropic-budget', 'qwen-toggle', 'thinking-toggle'].includes(profile.encoding)
    ? 'toggle' : levels.some(level => level !== 'none') ? 'effort' : 'none';
  return { ...profile, ...(profile.source === 'unknown' ? {} : { reasoningKind }),
    ...(profile.family === 'glm' && profile.canonicalModelId.startsWith('glm-5.3') && profile.encoding === 'thinking-effort'
      ? { defaultEffort: 'max' as const } : {}) };
}

/** Unknown models accept only auto unless the caller explicitly declares levels. */
export function isReasoningEffortSupported(route: ReasoningRoute, effort: ReasoningEffort): boolean {
  return modelReasoningError({ ...route, reasoningEffort: effort }) === undefined;
}

/** A deterministic configuration error suitable for both forms and API validation. */
export function modelReasoningError(route: ReasoningRoute, maxOutputTokens?: number): string | undefined {
  const declarationError = declaredLevelsError(route);
  if (declarationError) return declarationError;
  const profile = resolveModelProfile(route), effort = route.reasoningEffort;
  if (effort !== undefined && !profile.efforts.includes(effort))
    return `当前模型与协议不支持思考强度 ${effort}。支持：${profile.efforts.join(', ')}。`;
  if (route.protocol === 'messages' && effort === 'minimal')
    return 'Messages 标准协议没有 minimal effort 的通用表达；请选择该协议支持的其他档位。';
  if (route.protocol === 'messages' && effort === 'none' && profile.encoding === 'anthropic-effort')
    return '此 Messages 模型尚未确认支持关闭思考，不能把 none 转换为 thinking: disabled；请使用 auto。';
  if (route.protocol === 'messages' && effort === 'enabled' && profile.encoding === 'protocol-toggle')
    return '此 Messages 模型尚未确认原生思考开关及预算形式；请使用 auto。';
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1))
    return '输出上限必须是正整数。';
  const manual = effort !== undefined && effort !== 'none' && effort !== 'auto' && route.protocol === 'messages'
    && (profile.encoding === 'anthropic-budget-effort'
      || profile.encoding === 'anthropic-budget' && effort === 'enabled');
  if (manual && maxOutputTokens !== undefined && maxOutputTokens <= 1024)
    return '此模型的思考预算至少为 1024 token；输出上限必须大于 1024，才能保留最终回答空间。';
}

function enabledThinking(route: ReasoningRoute): Record<string, unknown> {
  return { thinking: { type: 'enabled', ...(route.protocol === 'messages' ? { budget_tokens: 1024 } : {}) } };
}

/** Only reasoning fields are returned; model ID and output limits remain the caller's. */
export function modelReasoningParameters(route: ReasoningRoute, maxOutputTokens: number): Record<string, unknown> {
  const error = modelReasoningError(route, maxOutputTokens);
  if (error) throw new RangeError(error);
  const profile = resolveModelProfile(route), effort = route.reasoningEffort;
  if (effort === undefined) {
    // Exact legacy semantics for saved configurations: do not reinterpret an
    // explicit standard/command-code dialect or add reasoning to other models.
    if ((route.dialect ?? profile.dialect) !== 'deepseek') return {};
    const thinking = route.parameterMode === 'thinking';
    if (route.protocol === 'responses') return { reasoning: { effort: thinking ? 'high' : 'none' } };
    return thinking ? enabledThinking(route) : { thinking: { type: 'disabled' } };
  }
  if (effort === 'auto') {
    // An explicit auto always follows the model's true default, even if the
    // historical parameterMode still says thinking. Missing effort retains the
    // exact old behavior above, so existing snapshots are not reinterpreted.
    return {};
  }
  if (profile.encoding === 'mimo-toggle') return route.protocol === 'responses'
    ? { reasoning: { effort: effort === 'none' ? 'none' : 'high' } }
    : { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } };
  if (profile.encoding === 'minimax-toggle') return { thinking: { type: effort === 'none' ? 'disabled' : 'adaptive' } };
  if (profile.encoding === 'kimi-effort') {
    if (route.protocol === 'responses') return { reasoning: { effort } };
    if (route.protocol === 'messages') return effort === 'none' ? { thinking: { type: 'disabled' } }
      : { thinking: { type: 'enabled' }, output_config: { effort } };
    return { reasoning_effort: effort };
  }
  if (effort === 'enabled') {
    if (profile.encoding === 'qwen-toggle') return { enable_thinking: true };
    if (profile.encoding === 'anthropic-budget' || profile.encoding === 'anthropic-budget-effort') return enabledThinking(route);
    if (route.protocol === 'responses') return { reasoning: { effort: 'high' } };
    return { thinking: { type: 'enabled' } };
  }
  if (profile.encoding === 'openrouter') return { reasoning: { effort } };
  if (profile.encoding === 'openai') return route.protocol === 'responses'
    ? { reasoning: { effort } } : { reasoning_effort: effort };
  if (profile.encoding === 'deepseek') {
    if (route.protocol === 'responses') return { reasoning: { effort } };
    if (effort === 'none') return { thinking: { type: 'disabled' } };
    return { ...enabledThinking(route), ...(route.protocol === 'messages'
      ? { output_config: { effort } } : { reasoning_effort: effort }) };
  }
  if (effort === 'none') return profile.encoding === 'qwen-toggle'
    ? { enable_thinking: false } : { thinking: { type: 'disabled' } };
  if (profile.encoding === 'anthropic-adaptive') return { thinking: { type: 'adaptive' }, output_config: { effort } };
  if (profile.encoding === 'anthropic-budget-effort') return { ...enabledThinking(route), output_config: { effort } };
  // A manual unknown Messages model may support effort without supporting
  // adaptive/manual thinking. Send the standard effort alone, without guessing.
  if (profile.encoding === 'anthropic-effort') return { output_config: { effort } };
  if (profile.encoding === 'thinking-effort') return { thinking: { type: 'enabled' }, reasoning_effort: effort };
  return {};
}
