import { useEffect, useState } from 'react'
import { Icon } from '../../icons'
import { MODELS, MODEL_KEY, MODEL_CHANGE_EVENT } from '../PromptInput'
import { removeModel, removeProvider, saveProvider, useSettings, type ModelProvider, type ProviderModel } from '../../lib/settings'
import { testProviderConnection, testSchoolConnection, testResultText, type TestResult } from '../../lib/connectionTest'
import { Section, RadioCard, Seg, Field } from './controls'
import { ProviderDialog } from './ProviderDialog'
import { ModelDialog } from './ModelDialog'
import type { TabProps } from '../../pages/SettingsPage'

const EFFORTS = ['低', '高', '最高'] as const
type Effort = (typeof EFFORTS)[number]
const EFFORT_KEY = 'agent.model.effort'
const DEFAULT_EFFORT: Effort = '高'

function readEfforts(): Record<string, Effort> {
  try {
    return JSON.parse(localStorage.getItem(EFFORT_KEY) ?? '{}') as Record<string, Effort>
  } catch {
    return {}
  }
}

/** 学校统一接入：预置供应商，由课程统一配置，演示路径连接测试恒成功。 */
const SCHOOL = {
  id: 'school',
  name: '学校统一接入',
  baseUrl: 'https://llm-gateway.edu.cn/v1',
  desc: '课程专用网关服务 · 免配置 API 密钥',
}

/**
 * 模型：默认模型与思考强度真实接管 agent.model / agent.model.effort
 * （作为新对话默认值，对话页可单次覆盖）；自定义供应商与模型真实持久化；
 * 连接测试为「真实请求 + CORS 明示」混合方案（docs/settings-design.md）。
 */
export function ModelTab({ toast }: TabProps) {
  const { providers } = useSettings()
  const [modelId, setModelId] = useState(() => localStorage.getItem(MODEL_KEY) ?? MODELS[0].id)
  const [efforts, setEfforts] = useState<Record<string, Effort>>(readEfforts)
  const [providerDlg, setProviderDlg] = useState<{ open: boolean; provider: ModelProvider | null }>({ open: false, provider: null })
  const [modelDlg, setModelDlg] = useState<{ provider: ModelProvider; model: ProviderModel | null } | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, TestResult>>({})
  const [confirmingDel, setConfirmingDel] = useState<string | null>(null)

  // 对话页内切换模型后，这里同步高亮
  useEffect(() => {
    const sync = () => setModelId(localStorage.getItem(MODEL_KEY) ?? MODELS[0].id)
    window.addEventListener(MODEL_CHANGE_EVENT, sync)
    return () => window.removeEventListener(MODEL_CHANGE_EVENT, sync)
  }, [])

  const pickModel = (id: string) => {
    setModelId(id)
    localStorage.setItem(MODEL_KEY, id)
    window.dispatchEvent(new Event(MODEL_CHANGE_EVENT))
  }

  const pickEffort = (level: Effort) => {
    const next = { ...efforts, [modelId]: level }
    setEfforts(next)
    localStorage.setItem(EFFORT_KEY, JSON.stringify(next))
  }

  const runTest = async (p: ModelProvider | 'school') => {
    const id = p === 'school' ? SCHOOL.id : p.id
    setTestingId(id)
    const r = p === 'school' ? await testSchoolConnection() : await testProviderConnection(p)
    setResults((m) => ({ ...m, [id]: r }))
    setTestingId(null)
  }

  /** 默认模型指向的模型已不在该供应商里（删供应商 / 删模型 / 编辑时移除）时，回退到学校接入的首个模型。 */
  const revertModelIfGone = (providerId: string, remaining: string[]) => {
    const prefix = `custom:${providerId}:`
    const current = localStorage.getItem(MODEL_KEY) ?? MODELS[0].id
    if (!current.startsWith(prefix) || remaining.some((id) => `${prefix}${id}` === current)) return
    localStorage.setItem(MODEL_KEY, MODELS[0].id)
    setModelId(MODELS[0].id)
    window.dispatchEvent(new Event(MODEL_CHANGE_EVENT))
  }

  /** 删除供应商；若默认模型来自它，回退到学校接入的首个模型。 */
  const confirmRemove = (p: ModelProvider) => {
    removeProvider(p.id)
    setConfirmingDel(null)
    revertModelIfGone(p.id, [])
    toast(`已移除供应商「${p.name}」`)
  }

  /** 删除单个自定义模型；若它是默认模型，同样回退。 */
  const confirmRemoveModel = (p: ModelProvider, mid: string) => {
    removeModel(p.id, mid)
    revertModelIfGone(p.id, p.models.filter((m) => m.id !== mid).map((m) => m.id))
    toast(`已移除模型「${mid}」`)
  }

  const modelOptions = [
    ...MODELS.map((m) => ({
      value: m.id,
      title: m.name,
      desc: m.note,
      icon: <Icon name={m.icon} size={22} />,
    })),
    ...providers.flatMap((p) =>
      p.models.map((m) => ({
        value: `custom:${p.id}:${m.id}`,
        title: m.id,
        desc: `${p.name} · 自定义模型`,
        icon: <Icon name="model" size={20} tone="neutral" />,
      })),
    ),
  ]

  const testRow = (id: string, onTest: () => void) => {
    const r = results[id]
    const t = r ? testResultText(r) : null
    return (
      <div className="st-provider-test">
        <button type="button" className="outline st-xs" disabled={testingId === id} onClick={onTest}>
          {testingId === id ? <span className="st-spinner" aria-hidden="true" /> : <Icon name="refresh" size={13} />}
          {testingId === id ? '测试中…' : '连接测试'}
        </button>
        {t && testingId !== id && (
          <span className={'st-test-result inline' + (t.ok ? ' ok' : ' fail')} role="status">
            <Icon name={t.ok ? 'check-circle' : 'danger-triangle'} size={13} />
            {t.text}
          </span>
        )}
      </div>
    )
  }

  return (
    <>
      <Section title="默认模型">
        <RadioCard ariaLabel="默认模型" value={modelId} onChange={pickModel} options={modelOptions} />
        <div className="st-panel st-effort-panel">
          <Field label="思考强度">
            <Seg
              ariaLabel="思考强度"
              options={EFFORTS.map((e) => ({ value: e, label: e }))}
              value={efforts[modelId] ?? DEFAULT_EFFORT}
              onChange={pickEffort}
            />
          </Field>
        </div>
      </Section>

      <Section title="模型供应商">
        <div className="st-provider">
          <div className="st-provider-head">
            <span className="st-provider-badge"><Icon name="learning-space" size={18} tone="neutral" /></span>
            <div className="st-provider-info">
              <span className="st-provider-name">
                {SCHOOL.name}
                <span className="st-status-pill ok">内置就绪</span>
              </span>
              <span className="st-provider-sub">{SCHOOL.desc}</span>
              <span className="st-mono st-provider-url">{SCHOOL.baseUrl}</span>
            </div>
          </div>
          <div className="st-provider-models">
            {MODELS.map((m) => (
              <span className="st-model-chip" key={m.id}><Icon name={m.icon} size={14} />{m.name}</span>
            ))}
          </div>
          {testRow(SCHOOL.id, () => runTest('school'))}
        </div>

        {providers.map((p) => {
          const r = results[p.id]
          const t = r ? testResultText(r) : null
          return (
            <div className="st-provider" key={p.id}>
              <div className="st-provider-head">
                <span className="st-provider-badge"><Icon name="model" size={18} tone="neutral" /></span>
                <div className="st-provider-info">
                  <span className="st-provider-name">{p.name}</span>
                  <span className="st-mono st-provider-url">{p.baseUrl}</span>
                </div>
                <div className="st-provider-acts">
                  <button className="outline st-xs" onClick={() => setModelDlg({ provider: p, model: null })}>
                    <Icon name="add" size={13} />添加模型
                  </button>
                  <button className="outline st-xs" onClick={() => setProviderDlg({ open: true, provider: p })}>
                    <Icon name="pen" size={13} />编辑
                  </button>
                  {confirmingDel === p.id ? (
                    <span className="st-cf-inline">
                      确认删除？
                      <button className="st-cf-yes" onClick={() => confirmRemove(p)}>删除</button>
                      <button className="st-cf-no" onClick={() => setConfirmingDel(null)}>取消</button>
                    </span>
                  ) : (
                    <button className="outline st-xs danger" onClick={() => setConfirmingDel(p.id)}>
                      <Icon name="trash-bin-trash" size={13} />删除
                    </button>
                  )}
                </div>
              </div>
              {p.models.length > 0 ? (
                <div className="st-provider-models">
                  {p.models.map((m) => (
                    <span className="st-model-chip" key={m.id}>
                      <Icon name="model" size={14} tone="neutral" />{m.id}
                      {m.contextWindow && <small>{Number(m.contextWindow) / 1024}K 上下文</small>}
                      <button
                        type="button"
                        className="st-chip-x st-chip-edit"
                        aria-label={`编辑模型 ${m.id}`}
                        onClick={() => setModelDlg({ provider: p, model: m })}
                      >
                        <Icon name="pen" size={11} />
                      </button>
                      <button
                        type="button"
                        className="st-chip-x"
                        aria-label={`删除模型 ${m.id}`}
                        onClick={() => confirmRemoveModel(p, m.id)}
                      >
                        <Icon name="close" size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="st-empty st-provider-empty">暂未配置模型，点击上方添加</p>
              )}
              <div className="st-provider-test">
                <button type="button" className="outline st-xs" disabled={testingId === p.id} onClick={() => runTest(p)}>
                  {testingId === p.id ? <span className="st-spinner" aria-hidden="true" /> : <Icon name="refresh" size={13} />}
                  {testingId === p.id ? '测试中…' : '连接测试'}
                </button>
                {t && testingId !== p.id && (
                  <span className={'st-test-result inline' + (t.ok ? ' ok' : ' fail')} role="status">
                    <Icon name={t.ok ? 'check-circle' : 'danger-triangle'} size={13} />
                    {t.text}
                  </span>
                )}
              </div>
            </div>
          )
        })}

        <button type="button" className="st-add-provider" onClick={() => setProviderDlg({ open: true, provider: null })}>
          <Icon name="add" size={15} />添加自定义供应商
        </button>
      </Section>

      {providerDlg.open && (
        <ProviderDialog
          open
          provider={providerDlg.provider}
          onClose={() => setProviderDlg({ open: false, provider: null })}
          onSave={(p) => {
            const isNew = providerDlg.provider == null
            saveProvider(p)
            revertModelIfGone(p.id, p.models.map((m) => m.id))
            toast(isNew ? `已添加供应商「${p.name}」` : '供应商已更新')
          }}
        />
      )}
      {modelDlg && (
        <ModelDialog
          open
          providerName={modelDlg.provider.name}
          model={modelDlg.model}
          siblings={modelDlg.provider.models.filter((x) => x.id !== modelDlg.model?.id).map((x) => x.id)}
          onClose={() => setModelDlg(null)}
          onSave={(m) => {
            const { provider, model } = modelDlg
            const models = model
              ? provider.models.map((x) => (x.id === model.id ? m : x))
              : [...provider.models, m]
            saveProvider({ ...provider, models })
            revertModelIfGone(provider.id, models.map((x) => x.id))
            toast(model ? `模型 ${m.id} 已更新` : `已添加模型 ${m.id}`)
          }}
        />
      )}
    </>
  )
}
