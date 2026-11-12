import type { ModelAttempt, ModelDiagnostic, ModelConnectionTestResult } from '@xunjie/contracts/model-connections'

export type ModelTestStatus = 'running' | 'passed' | 'failed' | 'unverified' | 'cancelled'
export interface ModelTestPresentation { status: ModelTestStatus; title: string; message?: string; suggestion?: string }
const reasons: Record<string, [string, string]> = {
  authentication: ['认证失败。', '请检查 API Key 和账号权限。'],
  'rate-limited': ['请求被限流。', '请稍后重试。'],
  'upstream-unsupported': ['模型或参数不受支持。', '请核对模型 ID、协议和思考档位。'],
  'context-capacity-exceeded': ['上下文或输出容量超限。', '请调小上下文窗口或最大输出。'],
  'upstream-timeout': ['测试超时。', '请稍后重试。'],
  'upstream-stream': ['连接中断。', '请检查网络后重试。'],
  'missing-terminal': ['响应未完整结束。', '请核对协议和供应商服务。'],
  'malformed-response': ['响应格式不符合所选协议。', '请核对 Base URL 和协议。'],
  'invalid-native-result': ['无法识别模型结果。', '请核对当前模型和协议。'],
  'upstream-stream-error': ['生成过程中出错。', '请核对配置后重试。'],
  'upstream-http': ['请求未通过。', '请核对 HTTP 状态和配置。'],
  'dispatcher-ended': ['请求进程已结束。', '请核对原测试记录。'],
  'dispatch-unconfirmed': ['请求状态未确认。', '请核对原测试记录。'],
  'response-limit': ['响应未完整接收。', '请稍后重试。'],
  length: ['输出额度不足。', '请调大最大输出或降低思考预算。'],
  max_tokens: ['输出额度不足。', '请调大最大输出或降低思考预算。'],
  'client-abort': ['测试已停止。', ''],
}
export function describeModelAttempt(attempt: ModelAttempt): ModelTestPresentation {
  const label = attempt.test?.item === 'images' ? '图片测试' : '文本测试'
  if (attempt.state === 'completed') return { status: 'passed', title: `${label}通过` }
  if (attempt.state === 'accepted' || attempt.state === 'dispatched') return { status: 'running', title: '测试中…' }
  if (attempt.state === 'cancelled') return { status: 'cancelled', title: `${label}已停止` }
  const status = attempt.state === 'failed' ? 'failed' : 'unverified'
  const facts = attempt.upstream, fallback = reasons[attempt.reason] ?? ['测试未完成。', '请核对配置后重试。']
  let message = attempt.diagnostic?.message ?? fallback[0], suggestion = attempt.diagnostic?.suggestion ?? fallback[1]
  if (!attempt.diagnostic && facts?.httpStatus === 404) {
    message = '接口或模型不存在。'; suggestion = '请核对 Base URL、协议和模型 ID。'
  } else if (!attempt.diagnostic && facts?.httpStatus === 403) {
    message = '账号没有访问权限。'; suggestion = '请核对密钥权限和接入地址。'
  } else if (!attempt.diagnostic && facts?.httpStatus && facts.httpStatus >= 500) {
    message = '供应商服务异常。'; suggestion = '请稍后重试。'
  }
  return { status, title: status === 'failed' ? `${label}未通过` : `${label}未完成`, message, suggestion }
}
export function describeConnectionTest(result: ModelConnectionTestResult): ModelTestPresentation {
  return { status: result.status, title: result.status === 'passed' ? '连接测试通过' : result.status === 'cancelled' ? '连接测试已停止'
    : result.status === 'unverified' ? '未能完成轻量验证' : '连接测试未通过',
    message: result.status === 'passed' ? undefined : result.diagnostic?.message,
    suggestion: result.status === 'passed' ? undefined : result.diagnostic?.suggestion }
}
export function describeTestError(error: unknown): ModelTestPresentation {
  const value = error as { code?: string; message?: string; diagnostic?: ModelDiagnostic }
  const reason = reasons[value?.code ?? '']
  return { status: ['invalid', 'forbidden', 'resource-busy', 'conflict', 'maintenance', 'unavailable'].includes(value?.code ?? '') ? 'failed' : 'unverified', title: '模型测试未完成',
    message: value?.diagnostic?.message ?? reason?.[0] ?? value?.message ?? '测试未完成。',
    suggestion: value?.diagnostic?.suggestion ?? reason?.[1] ?? '请稍后重试。' }
}
