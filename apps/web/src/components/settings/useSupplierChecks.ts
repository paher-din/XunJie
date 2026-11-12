import { useEffect, useRef, useState } from 'react'
import { modelBaseUrlError, type ModelConnectionTestInput, type ModelConnectionTestResult, type ModelDirectoryEntry } from '@xunjie/contracts/model-connections'
import { toast } from '@xunjie/ui/feedback'
import { describeConnectionTest, type ModelTestPresentation } from './modelTestPresentation'
import type { ReadModelDirectory } from './useModelDirectory'

export type TestSupplierConnection = (input: ModelConnectionTestInput, signal: AbortSignal) => Promise<ModelConnectionTestResult>
export function useSupplierChecks(input: ModelConnectionTestInput, test: TestSupplierConnection | undefined, read: ReadModelDirectory | undefined,
  { notificationLabel, active = true }: { notificationLabel?: string; active?: boolean } = {}) {
  const credentialIdentity = useRef({ value: '', revision: 0 })
  const secret = input.credential?.action === 'replace' ? input.credential.value : input.credential?.action ?? ''
  if (secret !== credentialIdentity.current.value) credentialIdentity.current = { value: secret, revision: credentialIdentity.current.revision + 1 }
  const key = JSON.stringify([input.presetId, input.variantId, input.baseUrl, input.protocol, input.savedCredential, credentialIdentity.current.revision, active])
  const context = useRef({ key, input, test, read, notificationLabel }); context.current = { key, input, test, read, notificationLabel }
  const connectionController = useRef<AbortController | null>(null), fetchController = useRef<AbortController | null>(null)
  const live = useRef(true)
  const [connection, setConnection] = useState<{ key: string; value: ModelTestPresentation }>()
  const [fetched, setFetched] = useState<{ key: string; models: ModelDirectoryEntry[]; busy: boolean; error?: { message: string; suggestion?: string; details?: string } }>()
  useEffect(() => { live.current = true; return () => { live.current = false; connectionController.current?.abort(); fetchController.current?.abort() } }, [])
  useEffect(() => {
    connectionController.current?.abort(); fetchController.current?.abort()
    connectionController.current = null; fetchController.current = null
  }, [key])
  const issue = (value: ModelConnectionTestInput) => modelBaseUrlError(value.baseUrl ?? '', value.protocol ?? 'chat-completions')
    ?? (value.credential?.action === 'replace' && value.credential.value.trim() || value.credential?.action === 'keep' && value.savedCredential ? undefined : '请填写 API Key。')
  const runConnection = async () => {
    const current = context.current
    if (!active || !current.test || connectionController.current && !connectionController.current.signal.aborted) return
    const notify = (value: ModelTestPresentation) => {
      if (current.notificationLabel) {
        const title = `${current.notificationLabel}：${value.title}`
        const description = [value.message, value.suggestion].filter(Boolean).join(' ')
        const options = { description: description || undefined, duration: value.status === 'failed' ? 8000 : 5000 }
        if (value.status === 'passed') toast.success(title, options)
        else if (value.status === 'failed') toast.error(title, options)
        else if (value.status === 'cancelled') toast.info(title)
        else toast.warning(title, options)
      } else if (value.status === 'passed') toast.success(value.title)
      else if (value.status === 'failed') toast.error(value.title + (value.message ? '：' + value.message : ''))
      else if (value.status !== 'cancelled') toast.warning(value.title)
    }
    const invalid = issue(current.input)
    if (invalid) {
      const value = { status: 'failed' as const, title: '连接配置需修改', message: invalid }
      setConnection({ key: current.key, value }); if (current.notificationLabel) notify(value); return
    }
    const controller = new AbortController(); connectionController.current = controller
    const valid = () => live.current && context.current.key === current.key && connectionController.current === controller
    setConnection({ key: current.key, value: { status: 'running', title: '正在测试连接…' } })
    try {
      const result = await current.test(current.input, controller.signal)
      if (!valid()) return
      if (controller.signal.aborted) {
        const value = { status: 'cancelled' as const, title: '连接测试已停止' }
        setConnection({ key: current.key, value }); if (current.notificationLabel) notify(value); return
      }
      const value = describeConnectionTest(result); setConnection({ key: current.key, value })
      notify(value)
    } catch {
      if (valid()) {
        const cancelled = controller.signal.aborted
        const value: ModelTestPresentation = cancelled ? { status: 'cancelled', title: '连接测试已停止' }
          : { status: 'unverified', title: '连接测试未完成', message: '未能取得连接测试结果。', suggestion: '请检查本机服务和网络后重试。' }
        setConnection({ key: current.key, value })
        if (current.notificationLabel) notify(value)
        else if (!cancelled) toast.warning('连接测试未完成，请检查本机服务和网络。')
      }
    } finally { if (connectionController.current === controller) connectionController.current = null }
  }
  const fetchModels = async () => {
    const current = context.current
    if (!current.read || fetchController.current && !fetchController.current.signal.aborted) return
    const invalid = issue(current.input)
    if (invalid) { setFetched(previous => ({ key: current.key, models: previous?.key === current.key ? previous.models : [], busy: false, error: { message: invalid } })); return }
    const controller = new AbortController(); fetchController.current = controller
    const valid = () => live.current && !controller.signal.aborted && context.current.key === current.key && fetchController.current === controller
    setFetched(previous => ({ key: current.key, models: previous?.key === current.key ? previous.models : [], busy: true }))
    try {
      const result = await current.read({ ...current.input, source: 'supplier', refresh: true, manual: true }, controller.signal)
      if (!valid()) return
      const supplier = result.supplier
      if (supplier?.error || supplier?.status === 'needs-credential') {
        setFetched(previous => ({ key: current.key, models: previous?.key === current.key ? previous.models : [], busy: false, error: {
          message: supplier.diagnostic?.message ?? (supplier.httpStatus === 404 || supplier.httpStatus === 405
            ? '供应商未提供可用的模型列表接口。' : supplier.status === 'needs-credential' ? '请填写 API Key。' : '未能拉取供应商模型列表。'),
          suggestion: supplier.diagnostic?.suggestion ?? '请核对地址、协议和密钥；也可以继续手动添加模型。',
          details: [supplier.httpStatus && `HTTP：${supplier.httpStatus}`, supplier.upstream?.errorCode && `上游错误代码：${supplier.upstream.errorCode}`,
            supplier.upstream?.message, supplier.upstream?.requestId && `请求 ID：${supplier.upstream.requestId}`].filter(Boolean).join('\n'),
        } }))
      } else setFetched({ key: current.key, models: [...new Map(result.models.map(model => [model.modelId, model])).values()], busy: false })
    } catch (error) {
      if (valid()) setFetched(previous => ({ key: current.key, models: previous?.key === current.key ? previous.models : [], busy: false, error: {
        message: error instanceof Error ? error.message : '拉取未完成。', suggestion: '当前填写已保留，请重试或手动添加模型。' } }))
    } finally { if (fetchController.current === controller) fetchController.current = null }
  }
  return { connection: connection?.key === key ? connection.value : undefined, runConnection,
    stopConnection: () => connectionController.current?.abort(),
    fetchModels, fetched: fetched?.key === key ? fetched : undefined,
    key }
}
