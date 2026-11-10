import { Icon, type IconName } from '../icons'
import { useToastFeedback } from '../feedback'
import { Section, RadioCard, Seg, Field } from './controls'
import { ModelProviderCard } from './ModelProviderCard'
import { ModelSettingsFeedback } from './ModelSettingsFeedback'
import type { ProviderModel, ModelSettingsFeedbackData } from './types'
import { ModelConfigActions, type ModelConfigActionsProps } from './ModelConfigActions'
import { ModelConnectionTestRow, type ModelConnectionTestResult } from './ModelConnectionTestRow'
import { LegacyModelDialogs, type LegacyModelDialogsProps } from './LegacyModelDialogs'

export interface LegacyModelProviderDisplay {
  id: string
  name: string
  baseUrl: string
  hasKey?: boolean
  keyHint?: string
  models: ProviderModel[]
}
export interface LegacyModelSettingsViewProps<Provider extends LegacyModelProviderDisplay = LegacyModelProviderDisplay> {
  preparation: boolean
  inlineFeedback: boolean
  remote: {
    loading: boolean
    saving: boolean
    error: string
    data: (ModelSettingsFeedbackData & { efforts: Record<string, string> }) | null
  }
  notice: string
  savedRevision: number | null
  providers: Provider[]
  modelId: string
  strengths: readonly string[]
  disabled: boolean
  options: readonly { id: string; name: string; note: string; icon: IconName }[]
  confirmingDel: string | null
  setConfirmingDel: (id: string | null) => void
  pickModel: (id: string) => void
  configActions: ModelConfigActionsProps
  testingId: string | null
  testResults: Record<string, ModelConnectionTestResult>
  onTest: (provider: Provider | 'school') => void
  onEffortChange: (level: string) => void
  onRemoveProvider: (provider: Provider) => void
  onRemoveModel: (provider: Provider, model: ProviderModel) => void
  onEditProvider: (provider: Provider) => void
  onEditModel: (provider: Provider, model: ProviderModel | null) => void
  onNewProvider: () => void
  dialogs: LegacyModelDialogsProps
}
/** Legacy presentation preserves explicit preparation/real copy; no store, model transport or persistence. */
export function LegacyModelSettingsView<Provider extends LegacyModelProviderDisplay>({
  preparation, inlineFeedback, remote, notice, providers, modelId, strengths, disabled, options,
  confirmingDel, setConfirmingDel, pickModel, configActions, testingId, testResults, onTest, onEffortChange, onRemoveProvider,
  onRemoveModel, onEditProvider, onEditModel, onNewProvider, dialogs,
}: LegacyModelSettingsViewProps<Provider>) {
  useToastFeedback(notice || (!preparation ? remote.error : ''))
  return (
    <>
      {!preparation && (
        <Section title="个人模型配置">
          <p>配置仅属于当前登录账号。保存并启用后，下一次发送使用所选模型。</p>
          {inlineFeedback ? (
            <>
              <div className="st-model-actions"><ModelConfigActions {...configActions} /></div>
              <ModelSettingsFeedback {...remote} error="" savedRevision={null} />
            </>
          ) : (
            <>
              <ModelConfigActions {...configActions} />
              <p role="status">
                {remote.loading ? '正在读取配置…' : remote.data?.enabled ? '个人模型已启用' : '个人模型未启用'}
                {remote.data && !remote.data.callsEnabled ? ' · 管理员已停用模型调用' : ''}
              </p>
            </>
          )}
          {remote.error && <p className="detail">{remote.error}</p>}
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
                onChange={onEffortChange}
              />
            ) : (
              <span>此模型未声明可配置思考强度</span>
            )}
            {!preparation && strengths.length > 0 && !remote.data?.efforts[modelId] && (
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
                <span className="st-status-pill">{preparation ? '演示' : '未提供个人配置'}</span>
              </span>
              <span className="st-provider-sub">
                {preparation ? '课程专用网关演示' : '当前账号使用自己的供应商配置'}
              </span>
              {preparation && (
                <span className="st-mono st-provider-url">https://llm-gateway.edu.cn/v1</span>
              )}
            </div>
          </div>
          {preparation ? <ModelConnectionTestRow testing={testingId === 'school'} disabled={testingId !== null || disabled}
            result={testResults.school ?? null} onTest={() => onTest('school')} /> : <p>学校模型接入尚未开放，请配置个人供应商。</p>}
        </div>

        {providers.map(p => (
          <ModelProviderCard key={p.id} name={p.name} address={p.baseUrl}
            credentialLabel={preparation ? undefined : p.hasKey ? `密钥已保存 ${p.keyHint ?? ''}` : '尚未保存密钥'} actions={<>
                <button
                  className="outline st-xs"
                  disabled={disabled}
                  onClick={() => onEditModel(p, null)}
                >
                  添加模型
                </button>
                <button
                  className="outline st-xs"
                  disabled={disabled}
                  onClick={() => onEditProvider(p)}
                >
                  编辑
                </button>
                {confirmingDel === p.id ? (
                  <span className="st-cf-inline">
                    确认移除？
                    <button
                      className="st-cf-yes"
                      disabled={disabled}
                      onClick={() => onRemoveProvider(p)}
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
              </>}>
            <div className="st-provider-models">
              {p.models.map(m => (
                <span className="st-model-chip" key={m.id}>
                  <Icon name="model" size={14} />{m.id}
                  <button
                    className="st-chip-x st-chip-edit"
                    disabled={disabled}
                    aria-label={`编辑模型 ${m.id}`}
                    onClick={() => onEditModel(p, m)}
                  >
                    <Icon name="pen" size={11} />
                  </button>
                  <button
                    className="st-chip-x"
                    disabled={disabled}
                    aria-label={`删除模型 ${m.id}`}
                    onClick={() => onRemoveModel(p, m)}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </span>
              ))}
            </div>
            <ModelConnectionTestRow testing={testingId === p.id} disabled={testingId !== null || disabled}
              result={testResults[p.id] ?? null} onTest={() => onTest(p)} />
          </ModelProviderCard>
        ))}

        <button
          className="st-add-provider"
          disabled={disabled}
          onClick={() => onNewProvider()}
        >
          <Icon name="add" size={15} />添加自定义供应商
        </button>
      </Section>

      <LegacyModelDialogs {...dialogs} />
    </>
  )
}
