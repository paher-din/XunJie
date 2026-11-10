import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { modelBaseUrlError, modelConfigurationSchema, type ModelConfiguration, type ModelConnection, type ModelAttempt, type ModelCheckInput, type SaveModelConnection } from '@xunjie/contracts/model-connections'
import { ProviderIdentityFields } from './ProviderIdentityFields'
import { Field, TextInput } from './controls'
import { Icon } from '../../icons'

const fields = { name: '名称', baseUrl: 'Base URL', protocol: '协议', path: '路径', modelId: '模型 ID', dialect: '方言',
  parameterMode: '参数模式', enabled: '启用连接', contextWindow: '上下文窗口', maxOutputTokens: '最大输出 token' } as const
const display = (value: unknown) => typeof value === 'boolean' ? value ? '启用' : '停用' : value === undefined ? '未填写' : String(value)

export function ModelConnectionDialog({ connection, attempts, onClose, onSave, onRead, onReadCredential, onCheck, onCancel }: {
  connection: ModelConnection | null; attempts: ModelAttempt[]; onClose(): void
  onSave(input: SaveModelConnection): Promise<ModelConnection>
  onRead(connectionId: string): Promise<ModelConnection | null>
  onReadCredential(connectionId: string, version: number): Promise<string>
  onCheck(source: ModelCheckInput['source']): Promise<ModelAttempt>
  onCancel(attempt: ModelAttempt): Promise<void>
}) {
  const [configuration, setConfiguration] = useState<ModelConfiguration>(() => connection ? modelConfigurationSchema.strip().parse(connection)
    : { connectionId: crypto.randomUUID(), name: '', baseUrl: '', modelId: '', protocol: 'chat-completions', path: '/chat/completions', dialect: 'standard', parameterMode: 'plain', enabled: true })
  const [apiKey, setApiKey] = useState(''), [saving, setSaving] = useState(false)
  const [credentialReady, setCredentialReady] = useState(!connection?.hasCredential), [credentialError, setCredentialError] = useState('')
  const [credentialRetry, setCredentialRetry] = useState(0), [addressTouched, setAddressTouched] = useState(false)
  const [error, setError] = useState(''), [checking, setChecking] = useState(false), [result, setResult] = useState<ModelAttempt | null>(null)
  const [recovery, setRecovery] = useState<'conflict' | 'unknown' | null>(null), [latest, setLatest] = useState<ModelConnection | null>(null)
  const [reading, setReading] = useState(false), [notice, setNotice] = useState('')
  const epoch = useRef(0), live = useRef(true)
  const baseline = useRef(connection)
  // Keep the original identity AND payload until its outcome is known. Edits made
  // while waiting belong to the next submission, never to an idempotent replay.
  const pending = useRef<{ input: SaveModelConnection; generation: number } | null>(null)
  const submitting = useRef(false)
  const returnFocus = useRef(document.activeElement as HTMLElement | null)
  const currentResult = attempts.find(item => item.attemptId === result?.attemptId) ?? result
  useEffect(() => { live.current = true; return () => { live.current = false; epoch.current++ } }, [])
  useEffect(() => {
    if (!connection?.hasCredential) return
    let active = true
    setCredentialReady(false); setCredentialError('')
    void onReadCredential(connection.connectionId, connection.version).then(value => {
      if (active) { setApiKey(value); setCredentialReady(true) }
    }).catch(() => {
      if (active) setCredentialError('未能读取已保存的密钥。请重试；若配置已更新，请关闭后重新打开。')
    })
    return () => { active = false }
  }, [connection, onReadCredential, credentialRetry])
  const changed = () => { epoch.current++; setResult(null); setNotice(''); if (!recovery) setError('') }
  const change = (patch: Partial<ModelConfiguration>) => { changed(); setConfiguration(previous => ({ ...previous, ...patch })) }
  // The editor always saves the current value, including an explicitly emptied field.
  const credential = () => apiKey.trim() ? { action: 'replace' as const, value: apiKey.trim() } : { action: 'clear' as const }
  const addressIssue = modelBaseUrlError(configuration.baseUrl, configuration.protocol)
  const validAddress = () => { setAddressTouched(true); return !addressIssue }
  const test = async () => {
    if (!credentialReady || !validAddress()) return
    const generation = epoch.current
    setChecking(true); if (!recovery) setError('')
    try {
      const draft = modelConfigurationSchema.parse(configuration)
      const checked = await onCheck({ draft, credential: credential() })
      if (live.current && generation === epoch.current) setResult(checked)
    } catch { if (live.current && generation === epoch.current) setError('检查未确认，请核对输入、凭据和原检查记录。') }
    finally { if (live.current) setChecking(false) }
  }
  const submit = async (operation: NonNullable<typeof pending.current>) => {
    if (submitting.current) return
    const wasUnknown = recovery === 'unknown'
    submitting.current = true
    pending.current = operation
    setSaving(true); setError('')
    try {
      const saved = await onSave(operation.input)
      if (live.current) {
        pending.current = null
        baseline.current = saved
        setRecovery(null); setLatest(null)
        if (operation.generation === epoch.current) { setApiKey(''); onClose() }
        else setNotice('原提交已确认，后续输入尚未保存。')
      }
    } catch (error) {
      if (!live.current) return
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'conflict') {
        pending.current = null; setRecovery('conflict'); setLatest(null)
        setError('版本冲突，当前草稿和密钥操作已保留。请读取最新版本，核对后确认重试。')
      } else if (!wasUnknown && (code === 'invalid' || code === 'forbidden')) {
        pending.current = null; setRecovery(null)
        setError(code === 'invalid' ? '保存被拒绝，请检查地址、协议、模型及密钥填写。' : '原空间资格已失效，请重新登录原空间。')
      } else {
        setRecovery('unknown')
        setError(code === 'identity-conflict' ? '原提交身份与内容冲突，当前输入已保留；请核对原提交，不创建新提交。'
          : code === 'forbidden' ? '原空间资格已失效，保存结果尚未确认；请恢复原空间资格后核对原提交。'
            : '保存结果尚未确认，当前输入已保留。请核对原提交后再保存后续修改。')
      }
    } finally { submitting.current = false; if (live.current) setSaving(false) }
  }
  const save = async (confirmed?: ModelConnection) => {
    if (submitting.current || pending.current || recovery && !confirmed || !credentialReady || !validAddress()) return
    try {
      const input = { ...modelConfigurationSchema.parse(configuration), requestId: crypto.randomUUID(),
        expectedVersion: (confirmed ?? baseline.current)?.version ?? 0, credential: credential() }
      await submit({ input, generation: epoch.current })
    } catch { setError('请检查地址、协议、模型及密钥填写，当前输入已保留。') }
  }
  const readLatest = async () => {
    if (reading || submitting.current || pending.current) return
    setReading(true)
    try {
      const saved = await onRead(configuration.connectionId)
      if (live.current) {
        setLatest(saved)
        setError(saved ? '请核对最新版本与当前草稿；确认后才会按当前草稿保存。' : '未找到原配置，当前草稿已保留，请稍后重新读取。')
      }
    } catch { if (live.current) { setError('无法读取最新版本，当前草稿和密钥操作已保留。请重新读取后再确认。'); setLatest(null) } }
    finally { if (live.current) setReading(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="overlay pc-overlay" /><Dialog.Content className="st-dialog product-connection-dialog" aria-describedby={undefined}
      onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus() }}>
      <div className="st-dialog-head"><Dialog.Title className="st-dialog-title">{connection ? '编辑供应商' : '添加供应商'}</Dialog.Title>
        <Dialog.Close asChild><button type="button" className="pc-x" aria-label="关闭"><Icon name="close" size={18} /></button></Dialog.Close></div>
      <div className="st-dialog-body">
        <ProviderIdentityFields name={configuration.name} baseUrl={configuration.baseUrl} apiKey={apiKey} snapshotCredential apiKeyDisabled={!credentialReady}
          errors={{ baseUrl: addressTouched ? addressIssue : undefined }} onBaseUrlBlur={() => setAddressTouched(true)}
          protocol={{ value: configuration.protocol,
            options: [{ value: 'chat-completions', label: 'OpenAI 兼容' }, { value: 'responses', label: 'OpenAI Responses' }, { value: 'messages', label: 'Anthropic 兼容' }],
            placeholder: configuration.protocol === 'messages' ? 'https://api.example.com' : 'https://api.example.com/v1',
            onChange: value => {
              const protocol = value as ModelConfiguration['protocol']
              change({ protocol, path: ({ 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' } as const)[protocol] })
              if (configuration.baseUrl) setAddressTouched(true)
            } }}
          onName={name => change({ name })} onBaseUrl={baseUrl => change({ baseUrl })} onApiKey={value => { changed(); setApiKey(value) }} />
        {credentialError && <div><p role="alert">{credentialError}</p><button type="button" className="outline" onClick={() => setCredentialRetry(value => value + 1)}>重新读取密钥</button></div>}
        <Field label="模型 ID" tip="目录不可用时可直接填写已知型号"><TextInput aria-label="模型 ID" className="st-mono-input" value={configuration.modelId} onChange={event => change({ modelId: event.target.value })} /></Field>
        <details className="product-connection-advanced"><summary>高级配置</summary>
        <p className="detail">最终路径：{configuration.baseUrl.replace(/\/$/, '')}{configuration.path}</p>
        {configuration.protocol === 'messages' && <p className="detail">Messages 的 Base URL 不含末尾 /v1；DeepSeek 官方地址为 https://api.deepseek.com/anthropic。协议名称不会改变目标模型。</p>}
        <Field label="方言"><select className="st-input" aria-label="方言" value={configuration.dialect} onChange={event => change({ dialect: event.target.value as ModelConfiguration['dialect'] })}>
          <option value="standard">标准协议</option><option value="deepseek">DeepSeek</option><option value="command-code">Command Code</option></select></Field>
        <Field label="参数模式"><select className="st-input" aria-label="参数模式" value={configuration.parameterMode} onChange={event => change({ parameterMode: event.target.value as ModelConfiguration['parameterMode'] })}>
          <option value="plain">默认文本参数</option><option value="thinking" disabled={configuration.dialect !== 'deepseek'}>DeepSeek 思考模式</option></select></Field>
        <label><input type="checkbox" checked={configuration.enabled} onChange={event => change({ enabled: event.target.checked })} />启用连接</label>
        <Field label="上下文窗口" tip="按模型官方参数填写；学习请求按此值做容量判断"><TextInput aria-label="上下文窗口" className="st-mono-input"
          inputMode="numeric" value={configuration.contextWindow ?? ''} placeholder="例如 262144"
          onChange={event => change({ contextWindow: event.target.value ? Number(event.target.value) : undefined })} /></Field>
        <Field label="最大输出 token" tip="学习请求使用此值；连接检查仍有自己的小输出上限"><TextInput aria-label="最大输出 token" className="st-mono-input"
          inputMode="numeric" value={configuration.maxOutputTokens ?? ''} placeholder="例如 8192"
          onChange={event => change({ maxOutputTokens: event.target.value ? Number(event.target.value) : undefined })} /></Field>
        </details>
        <p className="detail">一次文本检查不会验证图像、工具或 strict schema 能力。</p>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {recovery === 'unknown' && <button type="button" className="outline" disabled={saving} onClick={() => { if (pending.current) void submit(pending.current) }}>核对原提交</button>}
        {recovery === 'conflict' && <>
          <button type="button" className="outline" disabled={reading || saving} onClick={() => void readLatest()}>{reading ? '读取中…' : '读取最新版本'}</button>
          {latest && <div className="detail" role="region" aria-label="配置冲突核对">
            <p>已保存版本 {latest.version} · {latest.hasCredential ? '密钥已保存' : '尚未保存密钥'}</p>
            {(Object.keys(fields) as (keyof typeof fields)[]).filter(key => latest[key] !== configuration[key]).map(key =>
              <p key={key}>{fields[key]}：已保存「{display(latest[key])}」；当前草稿「{display(configuration[key])}」</p>)}
            <p>{apiKey.trim() ? '保存后使用输入框中的当前密钥。' : '输入框已清空，保存后移除密钥。'}</p>
            <button type="button" className="outline" disabled={saving || reading} onClick={() => void save(latest)}>确认按当前草稿重试</button>
          </div>}
        </>}
        {currentResult && <p role="status">{currentResult.state === 'completed' ? '检查已完成' : currentResult.state === 'cancelled' ? '已停止本机检查' : '检查结果待核实'} · {currentResult.usage.state === 'unknown' ? '用量未知' : '已记录用量'}</p>}
      </div>
      <div className="st-dialog-foot"><button type="button" className="outline" disabled={checking || !credentialReady || configuration.parameterMode === 'thinking' && configuration.dialect !== 'deepseek'} onClick={() => void test()}>{checking ? '正在检查…' : '保存前检查'}</button>
        {currentResult && !currentResult.physicalRequestEnded && <button type="button" className="outline" onClick={() => void onCancel(currentResult)}>停止检查</button>}
        <div className="st-dialog-foot-right"><Dialog.Close asChild><button type="button" className="outline">取消</button></Dialog.Close>
          <button type="button" className="primary" disabled={saving || !credentialReady || recovery !== null} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></div></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
}
