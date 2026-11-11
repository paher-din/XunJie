import type { ModelAttempt, ModelCheckInput, ModelCheckPolicy, ModelConnection, ModelDiagnostic } from '@xunjie/contracts/model-connections';
import { modelAllowsImages, modelReasoningConfigurationError } from '@xunjie/contracts/model-connections';
import type { NativePayload } from './transport.js';
import type { ChatPayload } from './chat.js';
import type { ResponsesPayload } from './responses.js';
import type { MessagesPayload } from './messages.js';

// Backend-owned, metadata-free 64px PNG: a centered square on a neutral background.
// Neither the prompt nor the native image part contains its expected answer.
const image = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAYElEQVR4nO3PgQkAIRADweu/ab8GkWcVZkkBmVmPN/WB0wDqAOoA6gDqAOoA6gDq9gEz/w4AAAAAAAAAAAAAAAAAAAAAAAAAAAAA4D7AZQHUAdQB1AHUAdQB1AHUPQ/4AII52kpRK0N8AAAAAElFTkSuQmCC';
type Item = NonNullable<ModelCheckInput['test']>['item'];
export function testPreflight(connection: ModelConnection, item: Item, limits: ModelAttempt['limits'], policy?: ModelCheckPolicy): ModelDiagnostic | undefined {
  if (item === 'images' && !modelAllowsImages(connection)) return { code: 'image-input-disabled', field: 'imageInput',
    message: '图片输入尚未获准，未发送测试图片。', suggestion: '开启此模型的图片输入后再测试。' };
  if (policy && limits.maxOutputTokens > policy.maxOutputTokens) return { code: 'test-policy-output-limit', field: 'maxOutputTokens',
    message: '学校策略的输出上限不足以测试当前模型配置。', suggestion: '请管理员调整学校策略，或明确修改模型输出上限后重新测试。' };
  if (policy && limits.timeoutMs! > policy.timeoutMs) return { code: 'test-policy-timeout',
    message: '学校策略的请求时限不足以运行本次配置测试。', suggestion: '请管理员调整学校策略后重新测试。' };
  const reasoningError = modelReasoningConfigurationError(connection, limits.maxOutputTokens);
  if (reasoningError) return { code: 'test-reasoning-configuration', field: 'reasoningEffort',
    message: reasoningError, suggestion: '请修改模型输出上限或思考配置后重新测试。' };
}

/** Retain all configured reasoning and output fields; replace only synthetic input. */
export function withTestPayload(payload: NativePayload, item: Item, protocol: ModelConnection['protocol']): NativePayload {
  const prompt = item === 'images' ? 'Briefly describe the main shape and its color in the attached image.'
    : 'Please reply with a brief greeting.';
  if (protocol === 'responses') return { ...payload as ResponsesPayload, input: [{ role: 'user', content: item === 'images'
    ? [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: 'data:image/png;base64,' + image, detail: 'low' }]
    : prompt }] };
  if (protocol === 'chat-completions') return { ...payload as ChatPayload, messages: [{ role: 'user', content: item === 'images'
    ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + image, detail: 'low' } }]
    : prompt }] };
  return { ...payload as MessagesPayload, messages: [{ role: 'user', content: item === 'images'
    ? [{ type: 'text', text: prompt }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }]
    : prompt }] };
}

function imageAnswer(text: string) {
  return /(?:红(?:色)?|\bred\b)/i.test(text) && /(?:正方形|方块|方形|\bsquare\b)/i.test(text)
    && !/(?:不是|无法|不能|不确定|\b(?:cannot|unable|unsure)\b|\b(?:not|isn't)\s+(?:a\s+)?(?:red|square))/i.test(text);
}

type TestResult = Pick<ModelAttempt, 'state' | 'reason' | 'text' | 'upstream'>;
const diagnostic = (code: string, message: string, suggestion: string, field?: ModelDiagnostic['field']): ModelDiagnostic =>
  ({ code, message, suggestion, ...(field ? { field } : {}) });
function failureDiagnostic(result: TestResult): ModelDiagnostic {
  const suggestions: Record<string, [string, string, ModelDiagnostic['field']?]> = {
    'upstream-dns': ['无法解析模型服务地址。', '请检查 Base URL 和 DNS 连接后重试。', 'baseUrl'],
    'upstream-tls': ['模型服务的 TLS 连接验证失败。', '请检查服务证书和 Base URL 后重试。', 'baseUrl'],
    'upstream-timeout': ['模型服务未在测试时限内完成，结果尚未确认。', '请检查服务连接和响应速度后重试。'],
    timeout: ['模型服务未在测试时限内完成，结果尚未确认。', '请检查服务连接和响应速度后重试。'],
    'upstream-network': ['无法完成与模型服务的网络连接。', '请检查服务地址及网络连接后重试。', 'baseUrl'],
    'client-abort': ['本次测试已取消。', '可以重新运行测试。'],
  };
  const known = suggestions[result.reason];
  if (known) return diagnostic(result.reason, ...known);
  if (result.state === 'cancelled') return diagnostic('test-cancelled', '本次测试已取消。', '可以重新运行测试。');
  if (result.state === 'unknown') return diagnostic('test-result-unknown', '未收到可确认的测试结果，尚不能判断配置是否正确。', '请检查连接后重新测试。');
  if (result.state === 'incomplete') return diagnostic('test-incomplete', '本次回复尚未完整结束，测试未完成。', '当前结果不足以判断配置是否正确，请重新测试。');

  const facts = result.upstream, status = facts?.httpStatus, code = facts?.errorCode?.toLowerCase() ?? '';
  const parameter = facts?.parameter?.toLowerCase() ?? '';
  const modelError = /model[_-](?:not[_-]found|not[_-]supported|unsupported|unavailable)|(?:unknown|invalid|unsupported)[_-]model/.test(code);
  if (status === 401) return diagnostic('authentication', 'API Key 验证失败。', '请核对 API Key 是否正确、有效，并确认所属供应商。', 'apiKey');
  if (status === 403) return diagnostic('upstream-permission', '上游账号或套餐没有本次调用权限。', '请核对账号、套餐及目标模型的调用权限。');
  if (status === 404) return modelError
    ? diagnostic('model-not-found', '上游未找到当前模型 ID。', '请核对模型 ID，以及当前账号是否能使用该模型。', 'modelId')
    : diagnostic('upstream-path-not-found', '上游未找到当前协议的接口路径。', '请核对 Base URL 与所选协议的接口路径。', 'baseUrl');
  if (status === 429) {
    const quota = /quota|balance|credit|billing|budget|usage_limit/.test(code)
      || /insufficient.{0,30}(?:quota|credits?|balance)|credit balance.{0,20}(?:low|insufficient)|(?:quota|billing).{0,30}(?:exceed|limit)|余额不足|额度不足|配额.{0,10}(?:耗尽|用尽|不足)/i.test(facts?.message ?? '');
    return quota ? diagnostic('upstream-quota', '上游账号的可用额度不足。', '请检查账号余额、套餐或配额后重新测试。')
      : diagnostic('rate-limited', '上游限制了请求频率或并发数。', '请按上游重试时间稍后重试，或检查账户速率限制。');
  }
  if (status !== undefined && status >= 500) return diagnostic('upstream-service', '模型服务暂时发生错误。', '请稍后重试，或检查供应商服务状态。');
  if (status === 400 || status === 422 || result.reason === 'upstream-unsupported' || result.reason === 'context-capacity-exceeded') {
    if (/image|vision/.test(parameter) || /image|vision/.test(code)) return diagnostic('image-input-rejected',
      '上游拒绝了本次图片输入。', '请核对模型是否支持图片，以及供应商的图片输入格式与当前协议。', 'imageInput');
    if (/reasoning|thinking|budget_tokens|effort|output_config/.test(parameter) || /reasoning|thinking|effort/.test(code)) return diagnostic('invalid-reasoning-parameter',
      '上游拒绝了当前思考参数。', '请核对模型与协议支持的思考强度、开关和预算；测试不会自动改档。', 'reasoningEffort');
    if (/^model(?:_?id)?$/.test(parameter) || modelError) return diagnostic('invalid-model-parameter',
      '上游拒绝了当前模型 ID。', '请核对模型 ID 和当前账号可用的模型。', 'modelId');
    if (/max_?(?:completion_?|output_?)?tokens|maxtokens|maxoutputtokens|output_limit/.test(parameter)
      || /max_?(?:completion_?|output_?)?tokens|output_limit/.test(code)) return diagnostic('invalid-output-limit',
      '上游拒绝了当前模型输出上限。', '请核对模型和协议允许的输出上限；测试不会自动降低保存的配置。', 'maxOutputTokens');
    if (/context|prompt|input_tokens/.test(parameter) || /context|prompt_too_long|input_too_long/.test(code)
      || result.reason === 'context-capacity-exceeded') return diagnostic('context-capacity-exceeded',
      '上游拒绝了本次请求的上下文容量。', '请核对模型上下文窗口与输出预算。', 'contextWindow');
    return diagnostic('upstream-request-rejected', '上游拒绝了本次测试请求。', '请结合上游错误码、参数和详情核对模型、协议及请求配置。');
  }
  if (['malformed-response', 'invalid-native-result'].includes(result.reason)) return diagnostic(result.reason,
    '上游返回的数据不符合所选协议。', '请核对服务地址、协议及供应商的响应格式。');
  if (result.reason === 'content-refused') return diagnostic('content-refused', '模型拒绝了本次合成测试内容。', '请检查供应商的内容策略后重试。');
  if (result.reason.startsWith('credential-in-')) return diagnostic(result.reason, '上游响应包含认证敏感信息，已阻止发布。', '请检查供应商或代理服务的响应后重新测试。');
  return diagnostic(result.reason || 'test-not-completed', '本次测试未通过。', '请查看上游诊断详情后重试。');
}

export function testVerdict(test: ModelCheckInput['test'], result: TestResult):
  { state: ModelAttempt['state']; reason: string; diagnostic?: ModelDiagnostic } {
  if (!test) return { state: result.state, reason: result.reason };
  if (result.state === 'completed') {
    if (!result.text.replace(/[\p{C}\p{Z}\p{M}]/gu, '').trim()) return { state: 'failed', reason: 'empty-visible-output', diagnostic: {
      code: 'empty-visible-output', message: '模型没有返回可见正文，测试未通过。', suggestion: '请检查输出上限及思考配置后重试。' } };
    if (test.item === 'images' && !imageAnswer(result.text)) return { state: 'failed', reason: 'image-understanding-unverified', diagnostic: {
      code: 'image-understanding-unverified', message: '图片理解未验证通过', suggestion: '本次回答未正确描述测试图片，请检查模型和图片输入配置后重试。' } };
    return { state: 'completed', reason: result.reason };
  }
  return { state: result.state, reason: result.reason, diagnostic: failureDiagnostic(result) };
}
