import { useEffect, useRef, useState } from 'react'
import { modelAllowsImages, modelReasoningConfigurationError, resolveModelProfile, type ModelAttempt, type ModelCheckInput,
  type ModelConfiguration, type ModelConnection } from '@xunjie/contracts/model-connections'
import { toast } from '@xunjie/ui/feedback'
import { describeModelAttempt, describeTestError, type ModelTestPresentation } from './modelTestPresentation'

export interface ModelCheckOptions {
  test: NonNullable<ModelCheckInput['test']>
  configuration: ModelConfiguration
  signal: AbortSignal
  onAttempt?(attempt: ModelAttempt): void
}
export type CheckModelConfiguration = (source: ModelCheckInput['source'], options?: ModelCheckOptions) => Promise<ModelAttempt>
export interface ModelTestRun extends ModelTestPresentation {
  runId: string; configurationPassed: boolean; reasoningUnverified?: boolean; text?: ModelAttempt; images?: ModelAttempt
}

/** One explicit action owns every stage and notification, including late receipt/cancel races. */
export function useModelConfigurationTests(check: CheckModelConfiguration) {
  const [runs, setRuns] = useState<Record<string, ModelTestRun>>({})
  const active = useRef(new Map<string, { controller: AbortController; runId: string }>())
  const live = useRef(true)
  const invalidate = (id?: string) => {
    for (const [key, run] of active.current) if (!id || key === id) { run.controller.abort(); active.current.delete(key) }
    if (live.current) setRuns(previous => {
      if (!id) return {}
      const next = { ...previous }; delete next[id]; return next
    })
  }
  useEffect(() => { live.current = true; return () => { live.current = false; invalidate() } }, [])
  const run = async (configuration: ModelConfiguration | ModelConnection, source: ModelCheckInput['source']) => {
    const id = configuration.connectionId
    if (active.current.has(id)) return
    const runId = crypto.randomUUID(), controller = new AbortController()
    active.current.set(id, { controller, runId })
    const current = () => live.current && active.current.get(id)?.runId === runId
    let result: ModelTestRun = { status: 'running', title: '正在校验配置…', runId, configurationPassed: false }
    let notificationOnly = false
    const apply = () => { if (current()) setRuns(previous => ({ ...previous, [id]: { ...result } })) }
    apply()
    try {
      const issue = modelReasoningConfigurationError(configuration, configuration.maxOutputTokens)
      if (issue) {
        result = { ...result, status: 'failed', title: '配置校验未通过', message: issue, suggestion: '请修改思考档位或输出配置后重试。' }
      } else {
        result.configurationPassed = true
        const { reasoningLevels, ...route } = configuration
        const reference = resolveModelProfile(route)
        result.reasoningUnverified = reference.source === 'unknown' || reasoningLevels?.some(level => !reference.efforts.includes(level)) === true
        const imageInput = configuration.imageInput ?? ('capabilities' in configuration && modelAllowsImages(configuration))
        for (const item of ['text', ...(imageInput ? ['images' as const] : [])] as const) {
          if (controller.signal.aborted) break
          result = { ...result, status: 'running', title: item === 'text' ? '正在测试文本与默认思考参数…' : '正在测试图片理解…' }; apply()
          const attempt = await check(source, { test: { runId, item }, configuration, signal: controller.signal,
            onAttempt: attempt => { result = { ...result, [item === 'text' ? 'text' : 'images']: attempt }; apply() } })
          if (!current()) return
          result = { ...result, [item === 'text' ? 'text' : 'images']: attempt, ...describeModelAttempt(attempt) }
          if (attempt.state !== 'completed') break
        }
        if (controller.signal.aborted) result = { ...result, status: 'cancelled', title: '模型测试已停止' }
        else if (result.status === 'passed') result = { ...result, title: '模型测试通过', message: undefined, suggestion: undefined }
        else if (result.text?.state === 'completed' && result.images) result = { ...result,
          title: result.status === 'failed' ? '文本通过，图片测试未通过' : '文本通过，图片测试未完成' }
      }
    } catch (error) {
      notificationOnly = !controller.signal.aborted && (error as { code?: string } | null)?.code === 'resource-busy' && !result.text && !result.images
      result = { ...result, ...(controller.signal.aborted
        ? { status: 'cancelled' as const, title: '模型测试已停止' } : describeTestError(error)) }
    }
    finally {
      if (current()) {
        if (notificationOnly) setRuns(previous => { const next = { ...previous }; delete next[id]; return next })
        else apply()
        active.current.delete(id)
        if (result.status === 'passed') toast.success(result.title)
        else if (result.status === 'failed') toast.error(result.title + (result.message ? '：' + result.message : ''))
        else if (result.status !== 'cancelled') toast.warning(result.title + (result.message ? '：' + result.message : ''))
      }
    }
  }
  const stop = (id: string) => active.current.get(id)?.controller.abort()
  const expire = (id: string) => {
    active.current.get(id)?.controller.abort(); active.current.delete(id)
    if (live.current) setRuns(previous => previous[id] ? { ...previous, [id]: {
      runId: crypto.randomUUID(), configurationPassed: false, status: 'unverified', title: '模型配置已更新',
      message: '模型资料或配置已变化，原测试结果已失效。', suggestion: '请按当前配置重新测试。',
    } } : previous)
  }
  const fail = (id: string, message: string) => {
    invalidate(id)
    setRuns(previous => ({ ...previous, [id]: { runId: crypto.randomUUID(), configurationPassed: false,
      status: 'failed', title: '配置校验未通过', message, suggestion: '请修改对应字段后重试。' } }))
    toast.error('配置校验未通过：' + message)
  }
  return { runs, run, stop, invalidate, expire, fail }
}
