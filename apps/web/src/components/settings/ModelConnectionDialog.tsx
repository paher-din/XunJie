import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { modelConfigurationSchema, type ModelConfiguration, type ModelConnection, type ModelAttempt, type ModelCheckInput, type SaveModelConnection } from '@xunjie/contracts/model-connections'
import { ProviderIdentityFields } from './ProviderIdentityFields'
import { Field, TextInput } from './controls'
import { Icon } from '../../icons'

export function ModelConnectionDialog({ connection, attempts, onClose, onSave, onCheck, onCancel }: {
  connection: ModelConnection | null; attempts: ModelAttempt[]; onClose(): void
  onSave(input: Omit<SaveModelConnection, 'requestId'>): Promise<ModelConnection>
  onCheck(source: ModelCheckInput['source']): Promise<ModelAttempt>
  onCancel(attempt: ModelAttempt): Promise<void>
}) {
  const [configuration, setConfiguration] = useState<ModelConfiguration>(() => connection ? modelConfigurationSchema.strip().parse(connection)
    : { connectionId: crypto.randomUUID(), name: '', baseUrl: '', modelId: '', protocol: 'chat-completions', path: '/chat/completions', dialect: 'standard', parameterMode: 'plain', enabled: true })
  const [apiKey, setApiKey] = useState(''), [clear, setClear] = useState(false), [saving, setSaving] = useState(false)
  const [error, setError] = useState(''), [checking, setChecking] = useState(false), [result, setResult] = useState<ModelAttempt | null>(null)
  const epoch = useRef(0), live = useRef(true)
  const baseline = useRef(connection)
  const returnFocus = useRef(document.activeElement as HTMLElement | null)
  const currentResult = attempts.find(item => item.attemptId === result?.attemptId) ?? result
  useEffect(() => { live.current = true; return () => { live.current = false; epoch.current++ } }, [])
  const change = (patch: Partial<ModelConfiguration>) => { epoch.current++; setResult(null); setConfiguration(previous => ({ ...previous, ...patch })); setError('') }
  const credential = () => clear ? { action: 'clear' as const } : apiKey.trim() ? { action: 'replace' as const, value: apiKey.trim() } : { action: 'keep' as const }
  const test = async () => {
    const generation = epoch.current
    setChecking(true); setError('')
    try {
      const draft = modelConfigurationSchema.parse(configuration)
      const checked = await onCheck({ draft, credential: credential(),
        ...(baseline.current && !apiKey.trim() && !clear ? { savedCredential: { connectionId: baseline.current.connectionId, version: baseline.current.version } } : {}) })
      if (live.current && generation === epoch.current) setResult(checked)
    } catch { if (live.current && generation === epoch.current) setError('检查未确认，请核对输入、凭据和原检查记录。') }
    finally { if (live.current) setChecking(false) }
  }
  const save = async () => {
    const generation = epoch.current
    setSaving(true); setError('')
    try {
      const saved = await onSave({ ...modelConfigurationSchema.parse(configuration), expectedVersion: baseline.current?.version ?? 0, credential: credential() })
      if (live.current) {
        baseline.current = saved
        if (generation === epoch.current) { setApiKey(''); onClose() }
      }
    } catch { if (live.current) setError('保存未确认或版本冲突，当前输入已保留；请核对后重新读取。') }
    finally { if (live.current) setSaving(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="overlay pc-overlay" /><Dialog.Content className="st-dialog" aria-describedby={undefined}
      onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus() }}>
      <div className="st-dialog-head"><Dialog.Title className="st-dialog-title">{connection ? '编辑供应商' : '添加供应商'}</Dialog.Title>
        <Dialog.Close asChild><button type="button" className="pc-x" aria-label="关闭"><Icon name="close" size={18} /></button></Dialog.Close></div>
      <div className="st-dialog-body">
        <ProviderIdentityFields name={configuration.name} baseUrl={configuration.baseUrl} apiKey={apiKey} hasKey={connection?.hasCredential}
          onName={name => change({ name })} onBaseUrl={baseUrl => change({ baseUrl })} onApiKey={value => { epoch.current++; setResult(null); setApiKey(value); setClear(false) }} />
        {connection?.hasCredential && <label><input type="checkbox" checked={clear} onChange={event => { epoch.current++; setClear(event.target.checked); setApiKey(''); setResult(null) }} />清除已保存密钥</label>}
        <Field label="协议"><select className="st-input" aria-label="协议" value={configuration.protocol} onChange={event => {
          const protocol = event.target.value as ModelConfiguration['protocol']
          change({ protocol, path: ({ 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' } as const)[protocol] })
        }}><option value="chat-completions">Chat Completions</option><option value="responses">Responses（适配器待接入）</option><option value="messages">Messages（适配器待接入）</option></select></Field>
        <p className="detail">最终路径：{configuration.baseUrl.replace(/\/$/, '')}{configuration.path}</p>
        <Field label="模型 ID" tip="目录不可用时可直接填写已知型号"><TextInput aria-label="模型 ID" className="st-mono-input" value={configuration.modelId} onChange={event => change({ modelId: event.target.value })} /></Field>
        <Field label="方言"><select className="st-input" aria-label="方言" value={configuration.dialect} onChange={event => change({ dialect: event.target.value as ModelConfiguration['dialect'] })}>
          <option value="standard">标准 Chat</option><option value="deepseek">DeepSeek</option><option value="command-code">Command Code</option></select></Field>
        <Field label="参数模式"><select className="st-input" aria-label="参数模式" value={configuration.parameterMode} onChange={event => change({ parameterMode: event.target.value as ModelConfiguration['parameterMode'] })}>
          <option value="plain">默认文本参数</option><option value="thinking" disabled={configuration.dialect !== 'deepseek'}>DeepSeek 思考模式</option></select></Field>
        <label><input type="checkbox" checked={configuration.enabled} onChange={event => change({ enabled: event.target.checked })} />启用连接</label>
        <p className="detail">一次文本检查不会验证图像、工具或 strict schema 能力。</p>
        {error && <p role="alert">{error}</p>}
        {currentResult && <p role="status">{currentResult.state === 'completed' ? '检查已完成' : currentResult.state === 'cancelled' ? '已停止本机检查' : '检查结果待核实'} · {currentResult.usage.state === 'unknown' ? '用量未知' : '已记录用量'}</p>}
      </div>
      <div className="st-dialog-foot"><button type="button" className="outline" disabled={checking || configuration.protocol !== 'chat-completions' || configuration.parameterMode === 'thinking' && configuration.dialect !== 'deepseek'} onClick={() => void test()}>{checking ? '正在检查…' : '保存前检查'}</button>
        {currentResult && !currentResult.physicalRequestEnded && <button type="button" className="outline" onClick={() => void onCancel(currentResult)}>停止检查</button>}
        <div className="st-dialog-foot-right"><Dialog.Close asChild><button type="button" className="outline">取消</button></Dialog.Close>
          <button type="button" className="primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></div></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
}
