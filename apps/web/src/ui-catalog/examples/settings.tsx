import { useRef, useState, type ReactNode } from 'react'
import {
  AboutSettingsView, AccountSettingsView, AgentSettingsView, ConfirmAction, ConnectionModelFields, Field, HelpTip,
  LegacyModelDialogs, LegacyModelSettingsView, ModelConfigActions, ModelConnectionTestRow, ModelDialogView,
  ModelFields, ModelProviderCard, ModelProviderModelRow, ModelSettingsDialog, ModelSettingsFeedback, PortraitSettingsView,
  PrivacySettingsView, ProviderDialogView, ProviderIdentityFields, ProviderSettingsDialog, RadarChart,
  RadioCard, Row, Section, Seg, SettingsAgentLink, SettingsLayout, SettingsEmptyState, SettingsStatus, Slider, TextInput, Toggle,
  SettingsSelect, SettingsActionMenu, SkillListItem, SkillDocumentDialog, SkillImportFeedback, ModelIdInput, ModelProviderLogo, ModelChoiceCard,
  ModelTestFeedback, ModelTestButton,
  type AgentSettingsDisplay, type LegacyModelDialogsProps, type PortraitDisplay, type ProviderModel, type ProviderSettingsData,
} from '@xunjie/ui/settings'
import { Icon } from '@xunjie/ui/icons'
import type { CatalogEntry } from '../types'

const settings = '@xunjie/ui/settings'
const controlsSource = 'packages/ui/src/settings/controls.tsx'
const exampleSource = 'apps/web/src/ui-catalog/examples/settings.tsx'
const model: ProviderModel = { id: 'sample-model', contextWindow: '32768', maxOutput: '2048', inputTypes: ['pdf'], reasoningLevels: ['low', 'high'] }
const provider: ProviderSettingsData = { id: 'sample-provider', name: '示例供应商', baseUrl: 'https://example.invalid/v1', apiKey: '', hasKey: false, models: [model] }
const syntheticResult = { ok: false, text: '示例结果：未发起网络请求' }

function Frame({ children }: { children: ReactNode }) {
  return <div className="student-settings" style={{ width: 'min(100%, 840px)', padding: 24 }}><p style={{ fontSize: 12, color: 'var(--muted)' }}>以下均为本地合成示例</p><div className="st-body-in">{children}</div></div>
}
function SectionDemo() { return <Frame><Section title="示例分区" desc="分区说明"><div className="st-panel">示例内容</div></Section></Frame> }
function RowDemo() { return <Frame><div className="st-panel"><Row label="示例设置" hint="说明文字"><span>当前值</span></Row><Row label="纵向布局" stack><TextInput aria-label="纵向字段" defaultValue="示例" /></Row></div></Frame> }
function ToggleDemo() { const [value, setValue] = useState(true); return <Frame><Toggle checked={value} onChange={setValue} label="示例开关" /></Frame> }
function SkillListDemo() {
  const [checked, setChecked] = useState(true), [event, setEvent] = useState('')
  return <Frame><div style={{ minWidth: 0, padding: '0 20px', border: '1px solid var(--line)', borderRadius: 16 }}>
    <SkillListItem name="evidence-analysis" source="本地" description="先核对原始依据，再解释观察与预测之间的差异。" checked={checked}
      onCheckedChange={setChecked} onOpen={() => setEvent('打开示例 SKILL.md')} onRemove={() => setEvent('删除示例技能')} />
    <SkillListItem name="a-skill-with-a-long-name-for-layout-checks" source="GitHub" sourceIcon="brand-github" description="This deliberately long description checks that the row preserves room for the menu and switch, while keeping the full document available through Open."
      checked={false} onCheckedChange={() => {}} onOpen={() => setEvent('打开示例 SKILL.md')} onRemove={() => setEvent('删除示例技能')} />
    <SkillListItem name="course-skill" source="课程" description="课程提供的只读技能。" checked readOnly onCheckedChange={() => {}} onOpen={() => setEvent('打开课程示例')} />
  </div><output>{event}</output></Frame>
}
function SkillDocumentDemo({ loading = false, error = false }: { loading?: boolean; error?: boolean }) {
  const [open, setOpen] = useState(true)
  return <Frame><button type="button" className="outline" onClick={() => setOpen(true)}>打开示例 SKILL.md</button>
    <SkillDocumentDialog open={open} name="evidence-analysis" loading={loading} error={error ? '暂时无法打开 SKILL.md，请重试。' : ''}
      content={loading || error ? null : '---\nname: evidence-analysis\ndescription: 按证据核对问题\n---\n\n# 核对依据\n\n先阅读学生的**预测**，再比较实际观察。\n\n## 工作方式\n\n- 阅读原始记录\n- 核对差异\n\n```text\n预测 → 观察 → 修改\n```\n\n| 阶段 | 依据 |\n| --- | --- |\n| 复核 | 学生自己的记录 |\n'}
      onClose={() => setOpen(false)} onRetry={() => {}} />
  </Frame>
}
function SkillImportFeedbackDemo({ uncertain = false, busy = false }: { uncertain?: boolean; busy?: boolean }) {
  const [visible, setVisible] = useState(true), [event, setEvent] = useState('')
  return <Frame>{visible && <SkillImportFeedback summary="已导入 2 个技能，1 个未完成"
    failures={[{ path: 'collection/review-skill', message: uncertain ? '暂时无法确认导入结果，请重试。' : 'SKILL.md 缺少 description（技能说明）。' }]}
    retryLabel={busy ? '导入中…' : uncertain ? '继续导入' : '重试未完成'} disabled={busy}
    onRetry={() => setEvent('已请求重试示例')}
    {...(!uncertain ? { onChooseFolder: () => setEvent('已请求重选文件夹'), onDismiss: () => setVisible(false) } : {})} />}
    <output>{event}</output></Frame>
}
function SegDemo() { const [value, setValue] = useState('auto'); return <Frame><Seg ariaLabel="示例分段" options={[{ value: 'auto', label: '自动' }, { value: 'manual', label: '手动' }]} value={value} onChange={setValue} /></Frame> }
function SliderDemo() { const [value, setValue] = useState(50); return <Frame><Slider value={value} onChange={setValue} minLabel="启发" maxLabel="解析" ariaLabel="示例强度" /><output>{value}</output></Frame> }
function HelpDemo() { return <Frame><p>示例说明 <HelpTip tip="这是本地示例提示。" /></p></Frame> }
function FieldDemo({ error = false }: { error?: boolean }) { return <Frame><Field label="示例字段" tip="输入说明" error={error ? '请输入有效内容' : undefined}><TextInput aria-label="示例字段" placeholder="请输入" /></Field></Frame> }
function FieldNormal() { return <FieldDemo /> }
function FieldError() { return <FieldDemo error /> }
function TextInputDemo() { const [value, setValue] = useState('示例文本'); return <Frame><TextInput aria-label="示例输入" value={value} onChange={event => setValue(event.target.value)} /><p><TextInput aria-label="禁用输入" value="禁用状态" disabled readOnly /></p></Frame> }
function RadioDemo() { const [value, setValue] = useState('a'); return <Frame><RadioCard ariaLabel="示例选择" value={value} onChange={setValue} options={[{ value: 'a', title: '选项 A', desc: '示例说明' }, { value: 'b', title: '选项 B' }, { value: 'c', title: '不可选', disabled: true }]} /></Frame> }
function ConfirmDemo() { const [done, setDone] = useState(false); return <Frame><ConfirmAction label="示例操作" icon={<Icon name="trash-bin-trash" size={13} />} confirmText="确认执行？" danger onRun={() => setDone(true)} /><output>{done && '已执行本地示例'}</output></Frame> }
function RadarDemo() { return <Frame><RadarChart dims={['理解', '实践', '表达', '协作', '反思', '设计'].map((dim, index) => ({ dim, value: 30 + index * 10 }))} /></Frame> }
function AgentLinkDemo() { const [clicked, setClicked] = useState(false); return <Frame><SettingsAgentLink href="#example" onClick={event => { event.preventDefault(); setClicked(true) }} /><output>{clicked && '已触发本地示例'}</output></Frame> }
function LayoutDemo() {
  const [active, setActive] = useState('account')
  return <SettingsLayout tabs={[{ id: 'account', label: '账户', icon: 'user-rounded' }, { id: 'agent', label: 'Agent', icon: 'assistant-mark' }]}
    active={active} onSelect={setActive} version="示例" toast={null}><Section title={active === 'account' ? '账户示例' : 'Agent 示例'}><p>内容由调用方提供。</p></Section></SettingsLayout>
}
function SettingsStatusDemo() {
  return <Frame><div className="st-section">
    <SettingsStatus tone="loading" title="正在读取当前学习空间" description="学校连接与本机学习记录不会改变。" />
    <div style={{ height: 12 }} />
    <SettingsStatus tone="neutral" title="当前学习空间为只读" description="可以查看现有配置；修改入口已停用。" />
    <div style={{ height: 12 }} />
    <SettingsStatus tone="error" title="模型配置暂时无法读取" description="保留现有内容，检查连接后重新读取。"
      action={<button type="button" className="outline">重新读取</button>} />
  </div></Frame>
}

function AboutDemo() {
  const [checking, setChecking] = useState<'idle' | 'busy' | 'done'>('idle')
  return <Frame><AboutSettingsView version="0.0.0-example" credits={[{ name: '示例项目', role: '示例用途', license: '示例许可' }]} checking={checking} checkUpdate={() => setChecking('done')} /></Frame>
}
function AccountDemo() {
  const [name, setName] = useState('示例同学')
  const [saved, setSaved] = useState('示例同学')
  const [pwd, setPwd] = useState({ current: '', next: '', confirm: '' })
  const [notice, setNotice] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  return <Frame><AccountSettingsView account={{ name: saved, avatar: null }} name={name} setName={setName} nameDirty={name !== saved}
    avatarData={{ name: saved, avatar: null }} fileRef={fileRef} pwd={pwd} setPwd={setPwd} pwdError={{}} usage="示例数据"
    pickAvatar={() => setNotice('已选择示例头像文件')} submitPwd={() => setNotice('已触发示例操作')}
    onSaveName={() => { setSaved(name); setNotice('示例昵称已更新') }} onResetAvatar={() => setNotice('已重置示例头像')}
    onChangeBinding={() => setNotice('已触发示例绑定操作')} /><output>{notice}</output></Frame>
}
function AgentDemo() {
  const [agent, setAgent] = useState<AgentSettingsDisplay>({ nickname: '小阶', guidance: 50, hintStyle: 'auto', tone: 'encouraging' })
  const [nickname, setNickname] = useState(agent.nickname)
  return <Frame><AgentSettingsView agent={agent} account={{ name: '示例同学' }} nickname={nickname} setNickname={setNickname}
    nickDirty={nickname !== agent.nickname} onAgentChange={patch => setAgent(current => ({ ...current, ...patch }))} /></Frame>
}
const portraitSample: PortraitDisplay = { tags: ['示例标签', '项目学习'], radar: ['理解', '实践', '表达', '协作', '反思', '设计'].map((dim, index) => ({ dim, value: 30 + index * 10 })),
  strengths: ['示例优势'], growths: ['示例成长方向'], prefs: ['喜欢类比解释'], updatedAt: '2026-01-01', changelog: [{ at: '2026-01-01', text: '示例校准记录' }] }
function PortraitDemo({ empty = false }: { empty?: boolean }) {
  const [portrait, setPortrait] = useState<PortraitDisplay>(() => empty ? { ...portraitSample, tags: [], strengths: [], growths: [], prefs: [], changelog: [] } : portraitSample)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  return <Frame><PortraitSettingsView portrait={portrait} confirming={confirming} setConfirming={setConfirming}
    correct={({ kind, value }) => { const field = ({ tag: 'tags', strength: 'strengths', growth: 'growths', pref: 'prefs' } as const)[kind]; setPortrait(current => ({ ...current, [field]: current[field].filter(item => item !== value) })); setConfirming(null) }}
    formatDay={value => value} agentLink={{ href: '#example', onClick: event => { event.preventDefault(); setNotice('已触发示例导航') } }} /><output>{notice}</output></Frame>
}
function PortraitPopulated() { return <PortraitDemo /> }
function PortraitEmpty() { return <PortraitDemo empty /> }
function PrivacyDemo() {
  const [notice, setNotice] = useState('')
  return <Frame><PrivacySettingsView usage="示例数据" exporting={false} exportData={() => setNotice('示例导出：未生成文件')}
    onClearCache={() => setNotice('示例清除：未操作存储')} onResetLayouts={() => setNotice('示例重置：未操作存储')} /><output>{notice}</output></Frame>
}
function ModelFieldsDemo() {
  const [draft, setDraft] = useState(model)
  const [removed, setRemoved] = useState(false)
  return <Frame>{removed ? <button type="button" onClick={() => setRemoved(false)}>恢复示例模型</button> : <div className="st-model-card"><ModelFields model={draft} onPatch={patch => setDraft(current => ({ ...current, ...patch }))} onRemove={() => setRemoved(true)} /></div>}</Frame>
}
function ConnectionFieldsDemo() {
  const [id, setId] = useState('sample-model'), [effort, setEffort] = useState('auto'), [manual, setManual] = useState<string[] | undefined>()
  const [capacity, setCapacity] = useState<{ contextWindow?: string | undefined; maxOutputTokens?: string | undefined }>({})
  const [imageInput, setImageInput] = useState(false)
  return <Frame><ConnectionModelFields modelId={id} effort={effort} efforts={['auto', ...(manual ?? ['low', 'medium', 'high'])]}
    source={manual ? 'manual' : 'catalogue'} manualLevels={manual} {...capacity} referenceContext={128000} referenceOutput={8192}
    imageInput={imageInput} onImageInput={setImageInput}
    onId={setId} onEffort={setEffort} onLevels={setManual} onCapacity={patch => setCapacity(current => ({ ...current, ...patch }))} /></Frame>
}
function ModelTestButtonDemo({ state = 'idle' }: { state?: 'idle' | 'running' | 'restart' | 'disabled' | 'compact' | 'icon' }) {
  const [connectionRunning, setConnectionRunning] = useState(state === 'running')
  const [modelRunning, setModelRunning] = useState(state === 'running')
  return <Frame><div className="demo-row">
    <ModelTestButton kind="connection" running={connectionRunning} compact={state === 'compact'} iconOnly={state === 'icon'} disabled={state === 'disabled'}
      onTest={() => setConnectionRunning(true)} onStop={() => setConnectionRunning(false)} />
    <ModelTestButton kind="model" running={modelRunning} restart={state === 'restart'} compact={state === 'compact'} iconOnly={state === 'icon'} disabled={state === 'disabled'}
      onTest={() => setModelRunning(true)} onStop={() => setModelRunning(false)} />
  </div></Frame>
}
function ModelTestFeedbackDemo({ state = 'failed' }: { state?: 'running' | 'passed' | 'failed' | 'unverified' | 'cancelled' }) {
  const [status, setStatus] = useState(state)
  const problem = status === 'failed' || status === 'unverified'
  return <Frame><ModelTestFeedback status={status} title={status === 'running' ? '测试中…' : status === 'passed' ? '模型测试通过'
    : status === 'cancelled' ? '模型测试已停止' : status === 'unverified' ? '图片测试未完成' : '模型测试未通过'}
    message={problem ? '示例供应商拒绝了当前模型请求（HTTP 403）。' : undefined}
    suggestion={problem ? '请核对当前套餐的模型权限和接入地址。' : undefined}
    onRetry={problem ? () => setStatus('passed') : undefined} onStop={status === 'running' ? () => setStatus('cancelled') : undefined} /></Frame>
}
function SettingsSelectDemo() {
  const [value, setValue] = useState('custom')
  return <Frame><Field label="供应商"><SettingsSelect label="示例供应商" value={value} onChange={setValue}
    options={[{ value: 'custom', label: '自定义', icon: <ModelProviderLogo providerId="custom" /> },
      { value: 'deepseek', label: 'DeepSeek 官方', icon: <ModelProviderLogo providerId="deepseek" />, dividerBefore: true },
      { value: 'kimi', label: 'Kimi', icon: <ModelProviderLogo providerId="kimi" /> }]} /></Field></Frame>
}
function SettingsActionMenuDemo() {
  const [selected, setSelected] = useState(''), [open, setOpen] = useState(false), [showPanel, setShowPanel] = useState(false)
  return <Frame><SettingsActionMenu label="导入" icon={<Icon name="add" size={16} />} open={open}
    onOpenChange={next => { setOpen(next); if (!next) setShowPanel(false) }} panelLabel="示例地址"
    panel={showPanel ? <form style={{ display: 'grid', gap: 8, padding: 6 }} onSubmit={event => {
      event.preventDefault(); setSelected('示例导入'); setOpen(false); setShowPanel(false)
    }}><TextInput aria-label="示例地址" placeholder="输入示例地址" autoFocus /><button type="submit" className="primary">导入</button></form> : undefined} items={[
    { id: 'local', label: '本地导入', icon: <Icon name="folder-with-files" size={16} />, onSelect: () => setSelected('本地导入') },
    { id: 'github', label: 'GitHub 导入', icon: <Icon name="brand-github" size={16} />, keepOpen: true, onSelect: () => setShowPanel(true) },
  ]} /><output>{selected}</output></Frame>
}
function ModelIdInputDemo() {
  const [value, setValue] = useState('')
  return <Frame><Field label="模型 ID"><ModelIdInput label="示例模型 ID" value={value} onChange={setValue}
    options={[{ value: 'sample-text', label: '示例文本模型' }, { value: 'sample-thinking', label: '示例思考模型' }]} /></Field></Frame>
}
function ModelChoiceDemo({ chosen = false, open = false }: { chosen?: boolean; open?: boolean }) {
  const [selected, setSelected] = useState(chosen), [expanded, setExpanded] = useState(open), [effort, setEffort] = useState('auto')
  const [manual, setManual] = useState<string[] | undefined>()
  const [capacity, setCapacity] = useState<{ contextWindow?: string | undefined; maxOutputTokens?: string | undefined }>({})
  return <Frame><ModelChoiceCard modelId="sample-reasoning" name="示例推理模型" selected={selected} expanded={expanded}
    onSelect={value => { setSelected(value); setExpanded(value) }} onExpand={setExpanded}>
    <ConnectionModelFields modelId="sample-reasoning" showModelId={false} effort={effort} efforts={['auto', ...(manual ?? ['low', 'high'])]}
      source={manual ? 'manual' : 'catalogue'} manualLevels={manual} {...capacity} referenceContext={262144} referenceOutput={65536}
      onId={() => {}} onEffort={setEffort} onLevels={setManual} onCapacity={patch => setCapacity(current => ({ ...current, ...patch }))} />
  </ModelChoiceCard></Frame>
}
function ModelChoiceSelected() { return <ModelChoiceDemo chosen /> }
function ModelChoiceExpanded() { return <ModelChoiceDemo chosen open /> }
function ProviderCardDemo() { const [notice, setNotice] = useState(''); return <Frame><ModelProviderCard name="示例供应商" address="https://example.invalid/v1" credentialLabel="示例状态" actions={<button type="button" className="outline" onClick={() => setNotice('已触发示例编辑')}>编辑</button>}><p>示例模型</p></ModelProviderCard><output>{notice}</output></Frame> }
function ProviderRowsDemo({ state = 'default' }: { state?: 'default' | 'running' | 'failed' | 'disabled' | 'long' }) {
  const [testingConnection, setTestingConnection] = useState(false)
  const [enabled, setEnabled] = useState(state !== 'disabled')
  const [models, setModels] = useState([true, true, true, false, true, true])
  const [runs, setRuns] = useState<Record<number, 'running' | 'failed' | 'cancelled'>>(state === 'running' ? { 1: 'running' } : state === 'failed' ? { 2: 'failed' } : {})
  const [notice, setNotice] = useState('')
  const modelIds = ['deepseek-flash', 'deepseek-v4-pro', state === 'long' ? 'sample-model-with-a-very-long-name-for-ellipsis-and-narrow-layout-verification' : 'sample-long-context', 'sample-reasoning',
    ...(state === 'long' ? ['sample-code', 'sample-vision'] : [])]
  return <Frame><ModelProviderCard compact inactive={!enabled} name={state === 'long' ? '示例供应商的较长自定义名称用于核对窄窗口' : '示例供应商'}
    logo={<ModelProviderLogo providerId="deepseek" />}
    actions={<><div className="st-provider-manage-actions">
      <button type="button" className="st-provider-text-action" onClick={() => setNotice('已触发示例编辑')}>编辑</button>
      <button type="button" className="st-provider-text-action st-provider-delete" aria-label="删除示例供应商" title="删除供应商"
        onClick={() => setNotice('已触发示例删除')}><Icon name="trash-bin-trash" size={16} tone="neutral" /></button>
      </div><ModelTestButton kind="connection" iconOnly running={testingConnection} onTest={() => setTestingConnection(true)}
        onStop={() => setTestingConnection(false)} />
      <Toggle checked={enabled} label="启用示例供应商" onChange={setEnabled} /></>}
    footer={<button type="button" className="st-provider-text-action" onClick={() => setNotice('已触发示例添加模型')}><Icon name="add" size={14} />添加模型</button>}>
    <div className="st-configured-models">
      {modelIds.map((modelId, index) => <ModelProviderModelRow key={modelId} modelId={modelId} effort={index === 1 ? '高' : undefined}
        actions={<><ModelTestButton kind="model" iconOnly running={runs[index] === 'running'} disabled={!enabled || !models[index]}
          onTest={() => setRuns(current => ({ ...current, [index]: 'running' }))} onStop={() => setRuns(current => ({ ...current, [index]: 'cancelled' }))} />
          <Toggle checked={models[index]!} label={`启用模型 ${modelId}`} onChange={next => setModels(current => current.map((value, item) => item === index ? next : value))} /></>}>
        {runs[index] && <ModelTestFeedback status={runs[index]!}
          title={runs[index] === 'running' ? '模型测试中…' : runs[index] === 'failed' ? '模型测试未通过' : '模型测试已停止'}
          message={runs[index] === 'failed' ? '示例服务拒绝了请求（HTTP 403）。' : undefined}
          suggestion={runs[index] === 'failed' ? '请核对密钥的模型访问权限。' : undefined}
          />}
      </ModelProviderModelRow>)}
    </div>
  </ModelProviderCard><output>{notice}</output></Frame>
}
function IdentityDemo({ error = false }: { error?: boolean }) {
  const [name, setName] = useState('示例供应商'), [url, setUrl] = useState('https://example.invalid/v1'), [key, setKey] = useState('synthetic-example-key')
  const [protocol, setProtocol] = useState('chat-completions')
  return <Frame><ProviderIdentityFields name={name} baseUrl={url} apiKey={key} snapshotCredential
    errors={error ? { baseUrl: '请去掉末尾 /chat/completions，系统会自动追加接口路径。' } : {}}
    protocol={{ value: protocol, onChange: setProtocol, placeholder: protocol === 'messages' ? 'https://api.example.com' : 'https://api.example.com/v1',
      options: [{ value: 'chat-completions', label: 'OpenAI 兼容' }, { value: 'responses', label: 'OpenAI Responses' }, { value: 'messages', label: 'Anthropic 兼容' }] }}
    onName={setName} onBaseUrl={setUrl} onApiKey={setKey} /></Frame>
}
function IdentityNormal() { return <IdentityDemo /> }
function IdentityError() { return <IdentityDemo error /> }
function FeedbackDemo({ failed = false }: { failed?: boolean }) { return <Frame><ModelSettingsFeedback data={{ revision: 2, enabled: true, callsEnabled: true }} loading={false} saving={false} error={failed ? '示例保存失败' : ''} savedRevision={failed ? null : 2} /></Frame> }
function FeedbackSaved() { return <FeedbackDemo /> }
function FeedbackError() { return <FeedbackDemo failed /> }
function ConfigActionsDemo() {
  const [enabled, setEnabled] = useState(false), [notice, setNotice] = useState('')
  return <Frame><div className="st-model-actions"><ModelConfigActions saving={false} enabled={enabled} reloadDisabled={false} toggleDisabled={false}
    onReload={() => setNotice('示例读取完成')} onToggle={() => setEnabled(value => !value)} /></div><output>{notice}</output></Frame>
}
function TestRowDemo() { const [result, setResult] = useState<typeof syntheticResult | null>(null); return <Frame><ModelConnectionTestRow testing={false} disabled={false} result={result} onTest={() => setResult(syntheticResult)} /></Frame> }

function ModelViewDemo({ invalid = false }: { invalid?: boolean }) {
  const [open, setOpen] = useState(true), [draft, setDraft] = useState(model), [error, setError] = useState(invalid ? '示例错误：模型 ID 不可用' : '')
  return <Frame><button type="button" className="outline" onClick={() => setOpen(true)}>打开示例弹窗</button><ModelDialogView open={open} onClose={() => setOpen(false)} providerName="示例供应商" model={null}
    draft={draft} setDraft={setDraft} idError={error} setIdError={setError} saving={false} submit={async () => { setOpen(false) }} /></Frame>
}
function ModelViewNormal() { return <ModelViewDemo /> }
function ModelViewError() { return <ModelViewDemo invalid /> }
function ModelSettingsDemo() {
  const [open, setOpen] = useState(true), [notice, setNotice] = useState('')
  return <Frame><button type="button" className="outline" onClick={() => setOpen(true)}>打开示例模型</button><output>{notice}</output>
    {open && <ModelSettingsDialog open onClose={() => setOpen(false)} providerName="示例供应商" model={model} siblings={[]} onSave={() => setNotice('示例已保存到内存')} />}</Frame>
}
function ProviderSettingsDemo() {
  const [open, setOpen] = useState(true), [notice, setNotice] = useState('')
  return <Frame><button type="button" className="outline" onClick={() => setOpen(true)}>打开示例供应商</button><output>{notice}</output>
    {open && <ProviderSettingsDialog open onClose={() => setOpen(false)} provider={provider} preparation={false} onSave={() => setNotice('示例已保存到内存')} onTest={async () => syntheticResult} />}</Frame>
}
function ProviderViewDemo({ invalid = false }: { invalid?: boolean }) {
  const [open, setOpen] = useState(true), [name, setName] = useState('示例供应商'), [url, setUrl] = useState('https://example.invalid/v1')
  const [apiKey, setApiKey] = useState(''), [clear, setClear] = useState(false), [models, setModels] = useState<ProviderModel[]>([model])
  const [result, setResult] = useState<typeof syntheticResult | null>(null)
  return <Frame><button type="button" className="outline" onClick={() => setOpen(true)}>打开示例弹窗</button><ProviderDialogView open={open} onClose={() => setOpen(false)} provider={{ hasKey: false }} preparation={false}
    name={name} setName={setName} baseUrl={url} setBaseUrl={setUrl} apiKey={apiKey} setApiKey={setApiKey} clearKey={clear} setClearKey={setClear}
    saving={false} saveError={invalid ? '示例保存未确认' : ''} models={models} setModels={setModels} errors={invalid ? { name: '示例错误' } : {}}
    testing={false} testResult={null} result={result} dirty patchModel={(index, patch) => setModels(current => current.map((item, i) => i === index ? { ...item, ...patch } : item))}
    runTest={async () => setResult(syntheticResult)} submit={async () => setOpen(false)} /></Frame>
}
function ProviderViewNormal() { return <ProviderViewDemo /> }
function ProviderViewError() { return <ProviderViewDemo invalid /> }
function DialogsDemo({ kind }: { kind: 'provider' | 'model' }) {
  const [open, setOpen] = useState(true), [notice, setNotice] = useState('')
  const props: LegacyModelDialogsProps = { preparation: false, providerDialog: open && kind === 'provider' ? { provider } : null,
    modelDialog: open && kind === 'model' ? { provider, model } : null, onCloseProvider: () => setOpen(false), onCloseModel: () => setOpen(false),
    onSaveProvider: () => setNotice('示例供应商已保存到内存'), onSaveModel: () => setNotice('示例模型已保存到内存'), onTestProvider: async () => syntheticResult }
  return <Frame><button type="button" className="outline" onClick={() => setOpen(true)}>打开示例弹窗</button><output>{notice}</output><LegacyModelDialogs {...props} /></Frame>
}
function DialogProvider() { return <DialogsDemo kind="provider" /> }
function DialogModel() { return <DialogsDemo kind="model" /> }
function LegacyModelDemo({ empty = false }: { empty?: boolean }) {
  const [enabled, setEnabled] = useState(true), [modelId, setModelId] = useState(empty ? '' : model.id), [confirming, setConfirming] = useState<string | null>(null)
  const [providers, setProviders] = useState(empty ? [] : [provider]), [notice, setNotice] = useState(''), [dialog, setDialog] = useState<'provider' | 'model' | null>(null)
  const dialogs: LegacyModelDialogsProps = { preparation: false, providerDialog: dialog === 'provider' ? { provider } : null,
    modelDialog: dialog === 'model' ? { provider, model } : null, onCloseProvider: () => setDialog(null), onCloseModel: () => setDialog(null),
    onSaveProvider: () => setNotice('示例供应商已保存'), onSaveModel: () => setNotice('示例模型已保存'), onTestProvider: async () => syntheticResult }
  return <Frame><LegacyModelSettingsView preparation={false} inlineFeedback remote={{ loading: false, saving: false, error: '', data: { revision: 1, enabled, callsEnabled: true, efforts: { [modelId]: 'low' } } }}
    notice={notice} savedRevision={1} providers={providers} modelId={modelId} strengths={['low', 'high']} disabled={false}
    options={empty ? [] : [{ id: model.id, name: '示例模型', note: '合成配置', icon: 'model' }]}
    confirmingDel={confirming} setConfirmingDel={setConfirming} pickModel={setModelId}
    configActions={{ saving: false, enabled, reloadDisabled: false, toggleDisabled: false, onReload: () => setNotice('示例读取'), onToggle: () => setEnabled(value => !value) }}
    testingId={null} testResults={{}} onTest={() => setNotice('示例测试未发起网络请求')} onEffortChange={value => setNotice(`示例强度：${value}`)}
    onRemoveProvider={item => { setProviders(current => current.filter(value => value.id !== item.id)); setConfirming(null) }}
    onRemoveModel={(_item, selected) => { setProviders(current => current.map(value => ({ ...value, models: value.models.filter(item => item.id !== selected.id) }))); setConfirming(null) }}
    onEditProvider={() => setDialog('provider')} onEditModel={() => setDialog('model')} onNewProvider={() => setDialog('provider')} dialogs={dialogs} /></Frame>
}
function LegacyModelPopulated() { return <LegacyModelDemo /> }
function LegacyModelEmpty() { return <LegacyModelDemo empty /> }

export const settingsEntries: CatalogEntry[] = [
  { id: 'model-test-button', name: 'ModelTestButton', description: '带语义图标的连接／模型测试，原按钮可直接停止测试。', importPath: settings,
    source: 'packages/ui/src/settings/ModelTestButton.tsx', exampleSource, props: ['kind: connection | model', 'running?, restart?, disabled?, compact?, iconOnly?, onTest, onStop?'],
    dependencies: ['循阶 Button、Base UI Tooltip 和 Solar Linear 图标；本地状态示例'], states: [
      { id: 'idle', name: '开始测试', component: ModelTestButtonDemo },
      { id: 'running', name: '测试中与停止', component: () => <ModelTestButtonDemo state="running" /> },
      { id: 'restart', name: '停止后重新测试', component: () => <ModelTestButtonDemo state="restart" /> },
      { id: 'disabled', name: '不可用', component: () => <ModelTestButtonDemo state="disabled" /> },
      { id: 'compact', name: '列表紧凑样式', component: () => <ModelTestButtonDemo state="compact" /> },
      { id: 'icon', name: '单图标与停止', component: () => <ModelTestButtonDemo state="icon" /> }] },
  { id: 'model-test-feedback', name: 'ModelTestFeedback', description: '模型测试的简短结果、原因和处理建议。', importPath: settings,
    source: 'packages/ui/src/settings/ModelTestFeedback.tsx', exampleSource, props: ['status, title, message?, suggestion?', 'onRetry?, onStop?'],
    dependencies: ['Astryx Banner；示例不调用模型'], states: [
      { id: 'failed', name: '失败与建议', component: ModelTestFeedbackDemo },
      { id: 'running', name: '测试中', component: () => <ModelTestFeedbackDemo state="running" /> },
      { id: 'passed', name: '通过', component: () => <ModelTestFeedbackDemo state="passed" /> },
      { id: 'unverified', name: '部分完成', component: () => <ModelTestFeedbackDemo state="unverified" /> },
      { id: 'cancelled', name: '停止', component: () => <ModelTestFeedbackDemo state="cancelled" /> }] },
  { id: 'skill-list-item', name: 'SkillListItem', description: '技能名称、来源标签或图标、简介、更多菜单和即时开关；业务操作由调用方接入。', importPath: settings,
    source: 'packages/ui/src/settings/SkillListItem.tsx', exampleSource, props: ['name, description, checked, onCheckedChange', 'source?, sourceIcon?, disabled?, readOnly?, busy?, onOpen, onRemove?'],
    dependencies: ['Base UI Menu、Toggle 与包内图标'], states: [{ id: 'default', name: '启用、停用与只读', component: SkillListDemo }] },
  { id: 'skill-document-dialog', name: 'SkillDocumentDialog', description: '完整显示元信息与 Markdown 正文的技能阅读窗口。', importPath: settings,
    source: 'packages/ui/src/settings/SkillDocumentDialog.tsx', exampleSource, props: ['open, name, content, loading, error?, footer?', 'onClose, onRetry, onReturnFocus?'],
    dependencies: ['Radix Dialog、受控 Markdown；正文由调用方读取'], states: [{ id: 'default', name: '正文', component: SkillDocumentDemo },
      { id: 'loading', name: '读取中', component: () => <SkillDocumentDemo loading /> }, { id: 'error', name: '重试', component: () => <SkillDocumentDemo error /> }] },
  { id: 'skill-import-feedback', name: 'SkillImportFeedback', description: '批量导入的未完成项、继续与重选操作。', importPath: settings,
    source: 'packages/ui/src/settings/SkillImportFeedback.tsx', exampleSource, props: ['summary, failures, retryLabel, onRetry', 'disabled?, onChooseFolder?, onDismiss?'],
    dependencies: ['Astryx Banner 与包内图标；导入进度和重试由调用方维护'], states: [
      { id: 'partial', name: '部分完成', component: SkillImportFeedbackDemo },
      { id: 'uncertain', name: '等待确认', component: () => <SkillImportFeedbackDemo uncertain /> },
      { id: 'busy', name: '继续导入中', component: () => <SkillImportFeedbackDemo busy /> }] },
  { id: 'settings-select', name: 'SettingsSelect', description: '沿用循阶字段样式的品牌下拉，支持键盘选择与分隔。', importPath: settings,
    source: 'packages/ui/src/settings/SettingsSelect.tsx', exampleSource, props: ['label, value, options, onChange, onOpen?, disabled?'],
    dependencies: ['Base UI Select；图标由调用方提供'], states: [{ id: 'default', name: '供应商选择', component: SettingsSelectDemo }] },
  { id: 'settings-action-menu', name: 'SettingsActionMenu', description: '带图标的操作菜单。', importPath: settings,
    source: 'packages/ui/src/settings/SettingsActionMenu.tsx', exampleSource, props: ['label, icon?, items, disabled?', 'open?, onOpenChange?, panel?, panelLabel?'],
    dependencies: ['操作由调用方提供'], states: [{ id: 'default', name: '导入菜单', component: SettingsActionMenuDemo }] },
  { id: 'model-id-input', name: 'ModelIdInput', description: '可搜索并自由填写的模型 ID，列表由调用方提供。', importPath: settings,
    source: 'packages/ui/src/settings/SettingsSelect.tsx', exampleSource, props: ['label, value, options, onChange, onOpen?, loading?'],
    dependencies: ['Base UI Combobox；本地合成列表'], states: [{ id: 'default', name: '搜索或手填', component: ModelIdInputDemo }] },
  { id: 'model-choice-card', name: 'ModelChoiceCard', description: '虚线框模型选择，参数在对应型号内展开。', importPath: settings,
    source: 'packages/ui/src/settings/ModelChoiceCard.tsx', exampleSource, props: ['modelId, name?, selected, expanded, onExpand', 'onSelect?, children?, invalid?, showSelection?, action?'],
    dependencies: ['包内图标与循阶 token；状态由调用方提供'], states: [{ id: 'default', name: '未选中', component: ModelChoiceDemo },
      { id: 'selected', name: '已选中', component: ModelChoiceSelected }, { id: 'expanded', name: '展开配置', component: ModelChoiceExpanded }] },
  { id: 'model-provider-logo', name: 'ModelProviderLogo', description: '本地供应商品牌图形与自定义连接图标。', importPath: settings,
    source: 'packages/ui/src/settings/SettingsSelect.tsx', exampleSource, props: ['providerId'], dependencies: ['包内品牌资产'],
    states: [{ id: 'default', name: '品牌图形', component: () => <Frame><div className="st-checks">{['custom', 'deepseek', 'opencode-go', 'command-code', 'zhipu', 'kimi', 'mimo'].map(id => <span key={id} className="st-choice-icon"><ModelProviderLogo providerId={id} /></span>)}</div></Frame> }] },
  { id: 'connection-model-fields', name: 'ConnectionModelFields', description: '正式模型 ID、思考强度、容量与手动档位。', importPath: settings,
    source: 'packages/ui/src/settings/ConnectionModelFields.tsx', exampleSource, props: ['modelId, effort, efforts, source, manualLevels?', 'onId, onEffort, onLevels, onCapacity'],
    dependencies: ['资料为合成示例，不发起网络请求'], states: [{ id: 'default', name: '目录与手动配置', component: ConnectionFieldsDemo }] },
  { id: 'settings-empty-state', name: 'SettingsEmptyState', description: '由 shadcn Empty 适配的设置空态，包含图标、标题、说明和操作。', importPath: settings,
    source: 'packages/ui/src/settings/SettingsEmptyState.tsx', exampleSource, props: ['icon, title, description, children'], dependencies: [],
    states: [{ id: 'default', name: '无数据', component: () => <Frame><SettingsEmptyState icon={<Icon name="user-id" size={24} />} title="暂无画像信息" description="当前空间还没有可展示的学生画像。"><button type="button" className="outline">返回学习空间</button></SettingsEmptyState></Frame> }] },
  { id: 'settings-status', name: 'SettingsStatus', description: '设置页的加载、只读与错误状态，可在原位置提供恢复操作。', importPath: settings,
    source: 'packages/ui/src/settings/SettingsStatus.tsx', exampleSource, props: ['tone?, title, description?, action?, className?'], dependencies: [],
    states: [{ id: 'default', name: '加载、只读与错误', component: SettingsStatusDemo }] },
  { id: 'about-settings-view', name: 'AboutSettingsView', description: '关于与版本示例。', importPath: settings, source: 'packages/ui/src/settings/AboutSettingsView.tsx', exampleSource, props: ['version, credits, checking, checkUpdate'], dependencies: ['更新状态为本地示例'], states: [{ id: 'default', name: '默认', component: AboutDemo }] },
  { id: 'account-settings-view', name: 'AccountSettingsView', description: '账户资料与安全表单。', importPath: settings, source: 'packages/ui/src/settings/AccountSettingsView.tsx', exampleSource, props: ['account, name, avatarData, pwd', '保存、头像与绑定回调'], dependencies: ['不保存账户或密码'], states: [{ id: 'default', name: '示例资料', component: AccountDemo }] },
  { id: 'agent-settings-view', name: 'AgentSettingsView', description: '引导偏好与角色预览。', importPath: settings, source: 'packages/ui/src/settings/AgentSettingsView.tsx', exampleSource, props: ['agent, account, nickname, onAgentChange'], dependencies: ['设置只保存在内存'], states: [{ id: 'default', name: '交互示例', component: AgentDemo }] },
  { id: 'confirm-action', name: 'ConfirmAction', description: '就地二次确认。', importPath: settings, source: 'packages/ui/src/settings/ConfirmAction.tsx', exampleSource, props: ['label, icon, confirmText, onRun, danger?'], dependencies: ['回调只改变本地状态'], states: [{ id: 'default', name: '交互示例', component: ConfirmDemo }] },
  { id: 'field', name: 'Field', description: '带标签、提示和错误的字段。', importPath: settings, source: controlsSource, exampleSource, props: ['label, tip?, error?, children'], dependencies: [], states: [{ id: 'default', name: '默认', component: FieldNormal }, { id: 'error', name: '错误', component: FieldError }] },
  { id: 'help-tip', name: 'HelpTip', description: '定位说明提示。', importPath: settings, source: controlsSource, exampleSource, props: ['tip'], dependencies: ['使用 body Portal'], states: [{ id: 'default', name: '悬停或聚焦', component: HelpDemo }] },
  { id: 'legacy-model-dialogs', name: 'LegacyModelDialogs', description: '旧版模型与供应商弹窗编排。', importPath: settings, source: 'packages/ui/src/settings/LegacyModelDialogs.tsx', exampleSource, props: ['providerDialog, modelDialog', '保存、测试、关闭回调'], dependencies: ['Radix Portal；测试回调不联网'], states: [{ id: 'provider', name: '供应商', component: DialogProvider, height: 700 }, { id: 'model', name: '模型', component: DialogModel, height: 700 }] },
  { id: 'legacy-model-settings-view', name: 'LegacyModelSettingsView', description: '旧版默认模型与供应商设置。', importPath: settings, source: 'packages/ui/src/settings/LegacyModelSettingsView.tsx', exampleSource, props: ['providers, modelId, options, remote, configActions, dialogs', '选择、修改、移除和测试回调'], dependencies: ['所有配置和动作均为内存示例'], states: [{ id: 'sample', name: '示例配置', component: LegacyModelPopulated, height: 700 }, { id: 'empty', name: '无供应商', component: LegacyModelEmpty, height: 700 }] },
  { id: 'model-config-actions', name: 'ModelConfigActions', description: '模型配置读取和启停动作。', importPath: settings, source: 'packages/ui/src/settings/ModelConfigActions.tsx', exampleSource, props: ['saving, enabled, reloadDisabled, toggleDisabled, onReload, onToggle'], dependencies: ['状态仅保存在内存'], states: [{ id: 'default', name: '交互示例', component: ConfigActionsDemo }] },
  { id: 'model-connection-test-row', name: 'ModelConnectionTestRow', description: '连接测试操作及结果。', importPath: settings, source: 'packages/ui/src/settings/ModelConnectionTestRow.tsx', exampleSource, props: ['testing, disabled, result, onTest'], dependencies: ['结果为本地示例'], states: [{ id: 'default', name: '交互示例', component: TestRowDemo }] },
  { id: 'model-dialog-view', name: 'ModelDialogView', description: '受控模型表单弹窗。', importPath: settings, source: 'packages/ui/src/settings/ModelDialogView.tsx', exampleSource, props: ['open, providerName, model, draft, setDraft, idError, saving, submit'], dependencies: ['Radix Portal'], states: [{ id: 'default', name: '默认', component: ModelViewNormal, height: 700 }, { id: 'error', name: '错误', component: ModelViewError, height: 700 }] },
  { id: 'model-fields', name: 'ModelFields', description: '模型参数和能力字段。', importPath: settings, source: 'packages/ui/src/settings/ModelFields.tsx', exampleSource, props: ['model, onPatch, onRemove?, idError?'], dependencies: ['合成配置'], states: [{ id: 'default', name: '交互示例', component: ModelFieldsDemo, height: 700 }] },
  { id: 'model-provider-card', name: 'ModelProviderCard', description: '供应商卡片与紧凑模型列表；停用态使用虚线边框和置灰模型开关。', importPath: settings, source: 'packages/ui/src/settings/ModelProviderCard.tsx', exampleSource, props: ['name, address?, credentialLabel?, logo?, compact?, inactive?', 'actions, footer?, children'], dependencies: [], states: [
    { id: 'default', name: '示例', component: ProviderCardDemo }, { id: 'compact', name: '多模型列表', component: ProviderRowsDemo },
    { id: 'disabled', name: '供应商停用', component: () => <ProviderRowsDemo state="disabled" /> },
    { id: 'long', name: '长名称', component: () => <ProviderRowsDemo state="long" /> }] },
  { id: 'model-provider-model-row', name: 'ModelProviderModelRow', description: '模型名称、次级测试、独立开关及就近反馈。', importPath: settings,
    source: 'packages/ui/src/settings/ModelProviderCard.tsx', exampleSource, props: ['modelId, effort?, actions, children?'], dependencies: ['仅展示，模型与测试状态由调用方提供'], states: [
      { id: 'default', name: '模型行', component: ProviderRowsDemo }, { id: 'running', name: '测试中', component: () => <ProviderRowsDemo state="running" /> },
      { id: 'failed', name: '失败与诊断', component: () => <ProviderRowsDemo state="failed" /> }] },
  { id: 'model-settings-dialog', name: 'ModelSettingsDialog', description: '模型表单及本地校验。', importPath: settings, source: 'packages/ui/src/settings/ModelSettingsDialog.tsx', exampleSource, props: ['open, onClose, providerName, model, siblings, onSave'], dependencies: ['Radix Portal；保存回调仅在内存生效'], states: [{ id: 'edit', name: '编辑', component: ModelSettingsDemo, height: 700 }] },
  { id: 'model-settings-feedback', name: 'ModelSettingsFeedback', description: '配置保存与失败状态。', importPath: settings, source: 'packages/ui/src/settings/ModelSettingsFeedback.tsx', exampleSource, props: ['data, loading, saving, error, savedRevision'], dependencies: [], states: [{ id: 'saved', name: '已保存', component: FeedbackSaved }, { id: 'error', name: '错误', component: FeedbackError }] },
  { id: 'portrait-settings-view', name: 'PortraitSettingsView', description: '画像与校准。', importPath: settings, source: 'packages/ui/src/settings/PortraitSettingsView.tsx', exampleSource, props: ['portrait, confirming, setConfirming, correct, formatDay, agentLink'], dependencies: ['画像数据为合成示例'], states: [{ id: 'sample', name: '示例画像', component: PortraitPopulated, height: 700 }, { id: 'empty', name: '空画像', component: PortraitEmpty, height: 700 }] },
  { id: 'privacy-settings-view', name: 'PrivacySettingsView', description: '过程记录和本地数据操作。', importPath: settings, source: 'packages/ui/src/settings/PrivacySettingsView.tsx', exampleSource, props: ['usage, exporting, exportData, onClearCache, onResetLayouts'], dependencies: ['示例不操作文件或存储'], states: [{ id: 'default', name: '交互示例', component: PrivacyDemo, height: 700 }] },
  { id: 'provider-dialog-view', name: 'ProviderDialogView', description: '受控供应商表单弹窗。', importPath: settings, source: 'packages/ui/src/settings/ProviderDialogView.tsx', exampleSource, props: ['open, provider, name, baseUrl, models', '字段、测试、保存与关闭回调'], dependencies: ['Radix Portal；示例不联网'], states: [{ id: 'default', name: '默认', component: ProviderViewNormal, height: 700 }, { id: 'error', name: '错误', component: ProviderViewError, height: 700 }] },
  { id: 'provider-identity-fields', name: 'ProviderIdentityFields', description: '供应商名称、地址与凭据字段。', importPath: settings, source: 'packages/ui/src/settings/ProviderIdentityFields.tsx', exampleSource, props: ['name, baseUrl, apiKey, hasKey?, errors?', 'onName, onBaseUrl, onApiKey'], dependencies: ['地址与凭据均为合成示例'], states: [{ id: 'default', name: '默认', component: IdentityNormal }, { id: 'error', name: '错误', component: IdentityError }] },
  { id: 'provider-settings-dialog', name: 'ProviderSettingsDialog', description: '供应商配置与本地校验。', importPath: settings, source: 'packages/ui/src/settings/ProviderSettingsDialog.tsx', exampleSource, props: ['open, provider, preparation, onClose, onSave, onTest'], dependencies: ['Radix Portal；测试与保存只更新示例'], states: [{ id: 'edit', name: '编辑', component: ProviderSettingsDemo, height: 700 }] },
  { id: 'radar-chart', name: 'RadarChart', description: '画像能力雷达图。', importPath: settings, source: 'packages/ui/src/settings/RadarChart.tsx', exampleSource, props: ['dims, size?'], dependencies: ['数据为合成示例'], states: [{ id: 'sample', name: '示例数据', component: RadarDemo }] },
  { id: 'radio-card', name: 'RadioCard', description: '带描述的单选卡。', importPath: settings, source: controlsSource, exampleSource, props: ['options, value, onChange, ariaLabel?'], dependencies: [], states: [{ id: 'default', name: '选中与禁用', component: RadioDemo }] },
  { id: 'row', name: 'Row', description: '设置行与纵向布局。', importPath: settings, source: controlsSource, exampleSource, props: ['label, hint?, stack?, children'], dependencies: [], states: [{ id: 'default', name: '横向与纵向', component: RowDemo }] },
  { id: 'section', name: 'Section', description: '设置分区标题与内容。', importPath: settings, source: controlsSource, exampleSource, props: ['title, desc?, children'], dependencies: [], states: [{ id: 'default', name: '默认', component: SectionDemo }] },
  { id: 'seg', name: 'Seg', description: '互斥分段选择。', importPath: settings, source: controlsSource, exampleSource, props: ['options, value, onChange, ariaLabel?'], dependencies: [], states: [{ id: 'default', name: '交互示例', component: SegDemo }] },
  { id: 'settings-agent-link', name: 'SettingsAgentLink', description: '前往 Agent 个性化的链接。', importPath: settings, source: 'packages/ui/src/settings/SettingsAgentLink.tsx', exampleSource, props: ['href, onClick 与其他 anchor 属性'], dependencies: ['示例阻止实际导航'], states: [{ id: 'default', name: '交互示例', component: AgentLinkDemo }] },
  { id: 'settings-layout', name: 'SettingsLayout', description: '设置导航及内容外壳。', importPath: settings, source: 'packages/ui/src/settings/SettingsLayout.tsx', exampleSource, props: ['tabs, active, onSelect, version, toast, children'], dependencies: ['切换状态保存在内存'], states: [{ id: 'default', name: '切换分区', component: LayoutDemo, height: 700 }] },
  { id: 'slider', name: 'Slider', description: '带两端说明的滑杆。', importPath: settings, source: controlsSource, exampleSource, props: ['value, onChange, minLabel, maxLabel, ariaLabel?'], dependencies: [], states: [{ id: 'default', name: '交互示例', component: SliderDemo }] },
  { id: 'text-input', name: 'TextInput', description: '设置表单输入框。', importPath: settings, source: controlsSource, exampleSource, props: ['原生 input 属性'], dependencies: [], states: [{ id: 'default', name: '普通与禁用', component: TextInputDemo }] },
  { id: 'toggle', name: 'Toggle', description: '受控开关。', importPath: settings, source: controlsSource, exampleSource, props: ['checked, onChange, label?'], dependencies: [], states: [{ id: 'default', name: '开与关', component: ToggleDemo }] },
]
