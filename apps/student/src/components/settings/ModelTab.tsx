import { useState } from 'react'
import { Icon } from '../../icons'
import { MODELS, MODEL_KEY, MODEL_CHANGE_EVENT } from '../PromptInput'
import {
  saveProvider, removeProvider, useSettings, type ModelProvider, type ProviderModel,
} from '../../lib/settings'
import {
  getModelSettings, loadModelSettings, personalModelOptions, reasoningOptions,
  saveModelSettings, useModelSettings,
} from '../../lib/modelSettings'
import {
  testProviderConnection, testSchoolConnection, testResultText, type TestResult,
} from '../../lib/connectionTest'
import { PREP_BUILD } from '../../workspace/mode'
import { Section, RadioCard, Seg, Field } from './controls'
import { ProviderDialog } from './ProviderDialog'
import { ModelDialog } from './ModelDialog'
import type { TabProps } from '../../pages/SettingsPage'

const EFFORTS = ['低', '高', '最高'] as const

export function ModelTab({ toast }: TabProps) {
  const local = useSettings()
  const remote = useModelSettings()
  const [prepModel, setPrepModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? MODELS[0].id)
  const [providerDlg, setProviderDlg] = useState<{ provider: ModelProvider | null } | null>(null)
  const [modelDlg, setModelDlg] = useState<{
    provider: ModelProvider
    model: ProviderModel | null
  } | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, TestResult>>({})
  const [confirmingDel, setConfirmingDel] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  const providers = PREP_BUILD ? local.providers : remote.data?.providers ?? []
  const modelId = PREP_BUILD ? prepModel : remote.data?.defaultModelId ?? ''
  const strengths = PREP_BUILD ? [...EFFORTS] : reasoningOptions(remote.data)
  const disabled = !PREP_BUILD && (!remote.data || remote.saving || remote.loading)
  const options = PREP_BUILD
    ? [
        ...MODELS,
        ...providers.flatMap(p => p.models.map(m => ({
          id: `custom:${p.id}:${m.id}`,
          name: m.id,
          note: p.name,
          icon: 'model' as const,
        }))),
      ]
    : personalModelOptions(remote.data)

  const act = async (fn: () => Promise<void>) => {
    setNotice('')
    try {
      await fn()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '操作未完成，请重试。')
    }
  }

  const pickModel = (id: string) => {
    if (PREP_BUILD) {
      setPrepModel(id)
      localStorage.setItem(MODEL_KEY, id)
      window.dispatchEvent(new Event(MODEL_CHANGE_EVENT))
      return
    }
    void act(() => saveModelSettings({ defaultModelId: id }))
  }

  const replaceProviders = async (next: ModelProvider[]) => {
    const current = getModelSettings().data
    const ids = next.flatMap(p => p.models.map(m => `custom:${p.id}:${m.id}`))
    const currentDefault = current?.defaultModelId
    const defaultModelId = currentDefault && ids.includes(currentDefault)
      ? currentDefault
      : ids[0] ?? ''
    const hasDefaultCredential = next.some(p => {
      const hasKey = Boolean(p.apiKey?.trim() || (p.hasKey && !p.clearKey))
      return hasKey && p.models.some(m => `custom:${p.id}:${m.id}` === defaultModelId)
    })
    const enabled = ids.length > 0 && hasDefaultCredential
      ? current?.enabled ?? false
      : false

    await saveModelSettings({ providers: next, defaultModelId, enabled })
  }

  const persistProvider = async (p: ModelProvider) => {
    if (PREP_BUILD) {
      saveProvider({ ...p, apiKey: '' })
      return
    }
    const next = providers.some(x => x.id === p.id)
      ? providers.map(x => x.id === p.id ? p : x)
      : [...providers, p]
    await replaceProviders(next)
  }

  const runTest = async (p: ModelProvider | 'school') => {
    const id = p === 'school' ? 'school' : p.id
    setTestingId(id)
    const result = p === 'school'
      ? await testSchoolConnection()
      : await testProviderConnection(p)
    setResults(previous => ({ ...previous, [id]: result }))
    setTestingId(null)
  }

  const testRow = (id: string, p: ModelProvider | 'school') => {
    const result = results[id] ? testResultText(results[id]) : null
    return (
      <div className="st-provider-test">
        <button
          className="outline st-xs"
          disabled={testingId !== null || disabled}
          onClick={() => void runTest(p)}
        >
          {testingId === id ? '测试中…' : '连接测试'}
        </button>
        {result && (
          <span role="status" className={'st-test-result inline' + (result.ok ? ' ok' : ' fail')}>
            {result.text}
          </span>
        )}
      </div>
    )
  }

  return (
    <>
      {!PREP_BUILD && (
        <Section title="个人模型配置">
          <p>配置仅属于当前登录账号。保存并启用后，下一次发送使用所选模型。</p>
          <button
            className="outline"
            disabled={remote.loading || remote.saving}
            onClick={() => void loadModelSettings()}
          >
            重新读取配置
          </button>
          <button
            className="primary"
            disabled={disabled || (!remote.data?.enabled && options.length === 0)}
            onClick={() => void act(() => saveModelSettings({ enabled: !remote.data?.enabled }))}
          >
            {remote.saving ? '保存中…' : remote.data?.enabled ? '停用个人模型' : '启用个人模型'}
          </button>
          <p role="status">
            {remote.loading ? '正在读取配置…' : remote.data?.enabled ? '个人模型已启用' : '个人模型未启用'}
            {remote.data && !remote.data.callsEnabled ? ' · 管理员已停用模型调用' : ''}
          </p>
          {(remote.error || notice) && <p role="alert">{notice || remote.error}</p>}
        </Section>
      )}

      <Section title="默认模型">
        {options.length ? (
          <RadioCard
            ariaLabel="默认模型"
            value={modelId}
            onChange={id => { if (!disabled) pickModel(id) }}
            options={options.map(m => ({
              value: m.id,
              title: m.name,
              desc: m.note,
              icon: <Icon name={m.icon} size={22} />,
            }))}
          />
        ) : (
          <p>添加供应商和模型后选择默认模型。</p>
        )}
        <div className="st-panel st-effort-panel">
          <Field label="思考强度">
            {strengths.length ? (
              <Seg
                ariaLabel="思考强度"
                options={strengths.map(e => ({ value: e, label: e }))}
                value={remote.data?.efforts[modelId] ?? ''}
                onChange={level => {
                  if (!PREP_BUILD && modelId && !disabled) {
                    void act(() => saveModelSettings({
                      efforts: { ...remote.data?.efforts, [modelId]: level },
                    }))
                  }
                }}
              />
            ) : (
              <span>此模型未声明可配置思考强度</span>
            )}
            {!PREP_BUILD && strengths.length > 0 && !remote.data?.efforts[modelId] && (
              <span>未指定，使用供应商默认强度</span>
            )}
          </Field>
        </div>
      </Section>

      <Section title="模型供应商">
        <div className="st-provider">
          <div className="st-provider-head">
            <span className="st-provider-badge"><Icon name="learning-space" size={18} /></span>
            <div className="st-provider-info">
              <span className="st-provider-name">
                学校统一接入
                <span className="st-status-pill">{PREP_BUILD ? '演示' : '未提供个人配置'}</span>
              </span>
              <span className="st-provider-sub">
                {PREP_BUILD ? '课程专用网关演示' : '当前账号使用自己的供应商配置'}
              </span>
              {PREP_BUILD && (
                <span className="st-mono st-provider-url">https://llm-gateway.edu.cn/v1</span>
              )}
            </div>
          </div>
          {PREP_BUILD ? testRow('school', 'school') : <p>学校模型接入尚未开放，请配置个人供应商。</p>}
        </div>

        {providers.map(p => (
          <div className="st-provider" key={p.id}>
            <div className="st-provider-head">
              <span className="st-provider-badge"><Icon name="model" size={18} /></span>
              <div className="st-provider-info">
                <span className="st-provider-name">{p.name}</span>
                <span className="st-mono st-provider-url">{p.baseUrl}</span>
                {!PREP_BUILD && (
                  <span>{p.hasKey ? `密钥已保存 ${p.keyHint ?? ''}` : '尚未保存密钥'}</span>
                )}
              </div>
              <div className="st-provider-acts">
                <button
                  className="outline st-xs"
                  disabled={disabled}
                  onClick={() => setModelDlg({ provider: p, model: null })}
                >
                  添加模型
                </button>
                <button
                  className="outline st-xs"
                  disabled={disabled}
                  onClick={() => setProviderDlg({ provider: p })}
                >
                  编辑
                </button>
                {confirmingDel === p.id ? (
                  <span className="st-cf-inline">
                    确认移除？
                    <button
                      className="st-cf-yes"
                      disabled={disabled}
                      onClick={() => void act(async () => {
                        if (PREP_BUILD) removeProvider(p.id)
                        else await replaceProviders(providers.filter(x => x.id !== p.id))
                        setConfirmingDel(null)
                        toast('供应商已移除')
                      })}
                    >
                      删除
                    </button>
                    <button onClick={() => setConfirmingDel(null)}>取消</button>
                  </span>
                ) : (
                  <button
                    className="outline st-xs danger"
                    disabled={disabled}
                    onClick={() => setConfirmingDel(p.id)}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
            <div className="st-provider-models">
              {p.models.map(m => (
                <span className="st-model-chip" key={m.id}>
                  <Icon name="model" size={14} />{m.id}
                  <button
                    className="st-chip-x st-chip-edit"
                    disabled={disabled}
                    aria-label={`编辑模型 ${m.id}`}
                    onClick={() => setModelDlg({ provider: p, model: m })}
                  >
                    <Icon name="pen" size={11} />
                  </button>
                  <button
                    className="st-chip-x"
                    disabled={disabled}
                    aria-label={`删除模型 ${m.id}`}
                    onClick={() => void act(async () => {
                      await persistProvider({ ...p, models: p.models.filter(x => x.id !== m.id) })
                      toast('模型已移除')
                    })}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </span>
              ))}
            </div>
            {testRow(p.id, p)}
          </div>
        ))}

        <button
          className="st-add-provider"
          disabled={disabled}
          onClick={() => setProviderDlg({ provider: null })}
        >
          <Icon name="add" size={15} />添加自定义供应商
        </button>
      </Section>

      {providerDlg && (
        <ProviderDialog
          open
          provider={providerDlg.provider}
          onClose={() => setProviderDlg(null)}
          onSave={async p => {
            await persistProvider(p)
            toast('供应商已保存')
          }}
        />
      )}
      {modelDlg && (
        <ModelDialog
          open
          providerName={modelDlg.provider.name}
          model={modelDlg.model}
          siblings={modelDlg.provider.models.filter(x => x.id !== modelDlg.model?.id).map(x => x.id)}
          onClose={() => setModelDlg(null)}
          onSave={async m => {
            const { provider, model } = modelDlg
            const models = model
              ? provider.models.map(x => x.id === model.id ? m : x)
              : [...provider.models, m]
            await persistProvider({ ...provider, models })
            toast('模型已保存')
          }}
        />
      )}
    </>
  )
}
