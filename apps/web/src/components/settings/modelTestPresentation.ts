import type { ModelAttempt, ModelDiagnostic, ModelConnectionTestResult } from '@xunjie/contracts/model-connections'

export type ModelTestStatus = 'running' | 'passed' | 'failed' | 'unverified' | 'cancelled'
export interface ModelTestPresentation { status: ModelTestStatus; title: string; message?: string; suggestion?: string; details?: string }
const reasons: Record<string, [string, string]> = {
  authentication: ['供应商拒绝了本次身份认证。', '请核对当前接入方式的 API Key 和账号权限。'],
  'rate-limited': ['供应商暂时限制了请求。', '请按重试时间稍后再试，并核对账号额度。'],
  'upstream-unsupported': ['供应商不接受当前模型或参数组合。', '请核对模型 ID、协议和思考档位。'],
  'context-capacity-exceeded': ['供应商拒绝了本次上下文或输出容量。', '请根据供应商文档调整上下文窗口和最大输出。'],
  'upstream-timeout': ['本次测试未在等待时间内完成。', '这不能证明模型配置错误，可稍后重试或核对供应商响应速度。'],
  'upstream-stream': ['连接中断，尚未收到完整结果。', '请检查网络或代理，再重试本次测试。'],
  'missing-terminal': ['响应未完整结束，尚未确认测试结果。', '请核对接口协议及供应商服务状态。'],
  'malformed-response': ['接口返回的数据不符合所选协议。', '请核对 Base URL 和协议，确认地址指向模型 API。'],
  'invalid-native-result': ['接口返回了无法识别的模型结果。', '请核对当前模型和协议是否匹配。'],
  'upstream-stream-error': ['供应商在生成过程中返回错误。', '请查看诊断详情中的上游错误。'],
  'upstream-http': ['供应商未接受本次请求。', '请根据 HTTP 状态和上游错误核对配置。'],
  'dispatcher-ended': ['本机请求进程已结束，原测试结果未确认。', '请先核对原测试记录，再决定是否重新测试。'],
  'dispatch-unconfirmed': ['本次请求的执行状态尚未确认。', '请保留原测试记录并核对结果。'],
  'response-limit': ['测试响应未完整接收。', '请查看供应商响应是否异常，再重试。'],
  length: ['模型用完了当前配置的输出额度，未完整结束。', '请核对最大输出与思考预算；本次不判定为配置错误。'],
  max_tokens: ['模型用完了当前配置的输出额度，未完整结束。', '请核对最大输出与思考预算，再重试。'],
  'client-abort': ['已停止本机测试。', ''],
}
export function modelDiagnosticDetails(attempt: ModelAttempt): string {
  const facts = attempt.upstream
  return [
    `地址：${attempt.connection.baseUrl.replace(/\/+$/, '')}${attempt.connection.path}`,
    `协议：${attempt.connection.protocol}`, `模型：${attempt.connection.modelId}`,
    `默认思考参数：${attempt.connection.reasoningEffort ?? attempt.connection.parameterMode}`,
    `最大输出：${attempt.limits.maxOutputTokens} token`, `测试记录：${attempt.attemptId}`,
    facts?.httpStatus && `HTTP：${facts.httpStatus}`, facts?.errorCode && `上游错误代码：${facts.errorCode}`,
    facts?.parameter && `参数：${facts.parameter}`, facts?.message && `上游说明：${facts.message}`,
    facts?.networkCode && `网络错误：${facts.networkCode}`, facts?.requestId && `请求 ID：${facts.requestId}`,
    facts?.retryAt && `重试时间：${facts.retryAt}`, facts?.retryAfterSeconds !== undefined && `请等待 ${facts.retryAfterSeconds} 秒后重试`,
    attempt.reason && `结果代码：${attempt.reason}`,
  ].filter(Boolean).join('\n')
}
export function describeModelAttempt(attempt: ModelAttempt): ModelTestPresentation {
  const label = attempt.test?.item === 'images' ? '图片测试' : '文本测试'
  if (attempt.state === 'completed') return { status: 'passed', title: `${label}通过`,
    message: attempt.test?.item === 'images' ? '本次图片理解测试通过。' : '当前模型和默认思考参数请求已接受，并完成了回答。', details: modelDiagnosticDetails(attempt) }
  if (attempt.state === 'accepted' || attempt.state === 'dispatched') return { status: 'running', title: `${label}中…` }
  if (attempt.state === 'cancelled') return { status: 'cancelled', title: `${label}已停止`, details: modelDiagnosticDetails(attempt) }
  const status = attempt.state === 'failed' ? 'failed' : 'unverified'
  const facts = attempt.upstream, fallback = reasons[attempt.reason] ?? ['本次测试未能完成验证。', '请查看诊断详情并核对当前配置。']
  let message = attempt.diagnostic?.message ?? fallback[0], suggestion = attempt.diagnostic?.suggestion ?? fallback[1]
  if (!attempt.diagnostic && facts?.httpStatus === 404) {
    message = '接口或模型不存在（HTTP 404）。'; suggestion = '请核对 Base URL、协议和模型 ID，避免把完整生成路径填入 Base URL。'
  } else if (!attempt.diagnostic && facts?.httpStatus === 403) {
    message = '当前账号没有访问权限（HTTP 403）。'; suggestion = '请核对密钥所属套餐、模型权限及接入地址。'
  } else if (!attempt.diagnostic && facts?.httpStatus && facts.httpStatus >= 500) {
    message = '供应商服务暂时异常。'; suggestion = '当前输入已保留，请稍后重试。'
  }
  return { status, title: status === 'failed' ? `${label}未通过` : `${label}未完整结束`, message, suggestion,
    details: modelDiagnosticDetails(attempt) }
}
export function describeConnectionTest(result: ModelConnectionTestResult): ModelTestPresentation {
  const facts = result.upstream
  return { status: result.status, title: result.status === 'passed' ? '连接测试通过' : result.status === 'cancelled' ? '连接测试已停止'
    : result.status === 'unverified' ? '未能完成轻量验证' : '连接测试未通过',
    message: result.status === 'passed' ? undefined : result.diagnostic?.message,
    suggestion: result.status === 'passed' ? undefined : result.diagnostic?.suggestion,
    details: [`地址：${result.endpoint}`, `协议：${result.protocol}`, `耗时：${Math.round(result.elapsedMs)} ms`,
      result.modelCount !== undefined && `返回模型：${result.modelCount} 个`, facts?.httpStatus && `HTTP：${facts.httpStatus}`,
      facts?.errorCode && `上游错误代码：${facts.errorCode}`, facts?.message && `上游说明：${facts.message}`,
      facts?.networkCode && `网络错误：${facts.networkCode}`, facts?.requestId && `请求 ID：${facts.requestId}`,
      facts?.retryAfterSeconds !== undefined && `请等待 ${facts.retryAfterSeconds} 秒后重试`, facts?.retryAt && `重试时间：${facts.retryAt}`,
    ].filter(Boolean).join('\n') }
}
export function describeTestError(error: unknown): ModelTestPresentation {
  const value = error as { code?: string; message?: string; diagnostic?: ModelDiagnostic }
  return { status: ['invalid', 'forbidden', 'resource-busy', 'conflict', 'maintenance', 'unavailable'].includes(value?.code ?? '') ? 'failed' : 'unverified', title: '模型测试未完成',
    message: value?.diagnostic?.message ?? value?.message ?? '测试结果尚未确认。',
    suggestion: value?.diagnostic?.suggestion }
}
