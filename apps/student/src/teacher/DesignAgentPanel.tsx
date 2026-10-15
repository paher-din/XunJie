import { useEffect, useRef, useState } from 'react'
import { pendingTeacherCommands, teacherCommand } from './backend'
import { adoptDesignProposal, designFields, proposalPatch, readDesignRun, runningDesignJob } from './designAgent'
import type { DesignJob, DesignMode, DesignProposal, DesignRun } from './designAgent'
import type { BlueprintContent, BlueprintDraft, TeacherWorkbench } from './wire'
import './design-agent.css'

const labels: Record<string, string> = {
  projectTitle: '项目标题', problem: '真实问题', audience: '受众', artifact: '产物', studentBackground: '学生基础',
  timeConstraints: '时间约束', routes: '选择路线', goals: '目标', tasks: '任务', observations: '可观察表现',
  rubricCriteria: '量规', milestones: '里程碑', resources: '资源', helpPolicyVersionId: '帮助政策版本',
  checkRuleVersionId: '检查规则版本', runtimeProfileVersionId: '运行配置版本', digitalLogicConfigVersionId: '数字逻辑配置版本',
  kind: '建议类型', constraints: '约束', unresolved: '未决问题', resourceRefs: '材料依据', helpPolicy: '帮助建议',
  checkpoints: '检查点', rubric: '量规建议', goalEvidenceLinks: '目标与证据联系', rationale: '理由',
  affectedLinks: '受影响项', criterionComments: '量规试评', ambiguities: '歧义', suggestedChanges: '修订建议', sampleRefs: '样例引用',
  competencyId: '能力标识', competencyVersion: '能力版本', domain: '能力线', title: '标题', core: '核心目标',
  description: '描述', goalRefs: '目标关联', taskIds: '任务关联', observationIds: '观察关联', resourceVersionId: '材料版本',
}
function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="td-hint">无</span>
  if (Array.isArray(value)) return value.length ? <ul>{value.map((item, index) => <li key={index}><Value value={item} /></li>)}</ul> : <span className="td-hint">无</span>
  if (typeof value === 'object') return <dl>{Object.entries(value).map(([key, item]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd><Value value={item} /></dd></div>)}</dl>
  return <span>{String(value)}</span>
}
const describe = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请核对原教师操作。'
interface Props {
  account: string; workbench: TeacherWorkbench; draft?: BlueprintDraft; content: BlueprintContent
  disabled: boolean; dirty: boolean; onAdopt: (draft: BlueprintDraft) => void
}
export default function DesignAgentPanel(props: Props) {
  const { account, workbench, draft, content, disabled, dirty } = props
  const editor = JSON.stringify(content)
  const storageKey = `xunjie.teacher.design-ai.v1:${encodeURIComponent(account)}:${encodeURIComponent(workbench.courseId)}:${draft?.blueprintId ?? 'new'}`
  const [mode, setMode] = useState<DesignMode>(draft ? 'patch' : 'candidates')
  const [request, setRequest] = useState('')
  const [fields, setFields] = useState<(keyof BlueprintContent)[]>(['problem'])
  const [selected, setSelected] = useState<string[]>([])
  const [samples, setSamples] = useState<string[]>([])
  const [run, setRun] = useState<DesignRun | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as DesignRun | null
      return value && value.courseId === workbench.courseId && value.blueprintId === (draft?.blueprintId ?? null)
        && typeof value.jobId === 'string' && typeof value.editor === 'string' && Array.isArray(value.fields) ? value : null
    } catch { return null }
  })
  const [job, setJob] = useState<DesignJob | null>(null)
  const [proposal, setProposal] = useState<DesignProposal | null>(null)
  const [candidate, setCandidate] = useState<number | undefined>()
  const [restoreId, setRestoreId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const latest = useRef(props); latest.current = props
  const alive = useRef(true)
  const serial = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current++ } }, [])
  function remember(next: DesignRun) {
    sessionStorage.setItem(storageKey, JSON.stringify(next))
    setRun(next); setJob(null); setProposal(null); setCandidate(undefined)
  }
  const paragraphs = workbench.resources.filter(resource => resource.available && resource.teacherDesignAllowed)
    .flatMap(resource => resource.material.paragraphs.map(paragraph => ({
      ...paragraph, resourceVersionId: resource.resourceVersionId,
      title: resource.material.title, private: resource.material.kind !== 'learning_material',
    })))
  const stale = !!run && (run.generation !== workbench.recoveryGeneration || run.editor !== editor ||
    run.baseRevision !== (draft?.revision ?? 0) || (proposal && (!proposal.applicable || proposal.baseRevision !== run.baseRevision)))
  const active = !!run?.jobId && (!job || runningDesignJob(job))
  const blocked = disabled || busy || !!(draft && dirty)
  const prefix = draft ? `/blueprints/${encodeURIComponent(draft.blueprintId)}` : `/courses/${encodeURIComponent(workbench.courseId)}/blueprints`
  const pending = pendingTeacherCommands(account).find(item => draft
    ? [`${prefix}/proposals`, `${prefix}/rubric-trials`].includes(item.path) : item.path === prefix)

  useEffect(() => {
    if (!run?.jobId) return
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined
    const original = run, pollDeadline = Date.now() + 60_000
    async function read() {
      const ticket = ++serial.current
      try {
        const result = await readDesignRun(original)
        if (cancelled || !alive.current || ticket !== serial.current) return
        setJob(result.job); setProposal(result.proposal ?? null); setError('')
        if (runningDesignJob(result.job)) {
          if (Date.now() < pollDeadline) timer = setTimeout(() => { void read() }, 1500)
          else setError('持续等待仍未取得终态，已停止自动读取。请重新读取原任务或明确取消，不要重复生成。')
        }
      } catch (cause) { if (!cancelled && alive.current && ticket === serial.current) setError(describe(cause)) }
    }
    void read()
    return () => { cancelled = true; serial.current++; clearTimeout(timer) }
  }, [run])

  async function generate(recover = false) {
    if (busy || (!recover && (blocked || active))) return
    const original = latest.current
    setBusy(true); setError('')
    try {
      let path: string, body: unknown, next: DesignRun
      if (recover) {
        if (!pending || !run) throw new Error('没有可核对的原生成请求。')
        path = pending.path; body = JSON.parse(pending.wire); next = run
      } else {
        if (!request.trim()) throw new Error('请填写设计要求。')
        if (draft && mode !== 'rubric_trial' && !fields.length) throw new Error('请选择允许建议修改的字段。')
        const references = selected.map(id => {
          const paragraph = paragraphs.find(p => p.paragraphId === id)
          if (!paragraph) throw new Error('材料权限或版本已变化，请重新选择。')
          return { resourceVersionId: paragraph.resourceVersionId, paragraphId: id, contentHash: paragraph.contentHash }
        })
        const sampleReferenceIds = samples.filter(id => selected.includes(id))
        if (mode === 'rubric_trial' && !sampleReferenceIds.length) throw new Error('请明确选择至少一个教师认可的试评样例段落。')
        path = draft ? `${prefix}/${mode === 'rubric_trial' ? 'rubric-trials' : 'proposals'}` : prefix
        body = { recoveryGeneration: workbench.recoveryGeneration, request, references,
          ...(draft ? { expectedRevision: draft.revision, ...(mode === 'rubric_trial' ? { sampleReferenceIds } : { mode, allowedFields: fields }) }
            : { mode: 'agent', generationMode: mode }) }
        next = { jobId: '', courseId: workbench.courseId, blueprintId: draft?.blueprintId ?? null, baseRevision: draft?.revision ?? 0,
          generation: workbench.recoveryGeneration, editor, fields: [...fields] }
        // Preserve the editor basis before any request; an unknown response must not cause a fresh paid job.
        remember(next)
      }
      const accepted = await teacherCommand<{ jobId: string; status: string }>(account, 'POST', path, body)
      if (!accepted?.jobId || accepted.status !== 'queued') throw new Error('没有取得原任务ID，请核对原教师操作。')
      if (alive.current && latest.current.account === original.account && latest.current.workbench.courseId === original.workbench.courseId) remember({ ...next, jobId: accepted.jobId })
    } catch (cause) { if (alive.current) setError(describe(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  async function adopt() {
    if (!run || !proposal || blocked || stale || active) return
    const original = latest.current
    setBusy(true); setError('')
    try {
      const next = await adoptDesignProposal(account, run, proposal, editor, draft, candidate, () =>
        alive.current && latest.current.account === account && latest.current.workbench.courseId === workbench.courseId
        && latest.current.workbench.recoveryGeneration === run.generation && JSON.stringify(latest.current.content) === editor
        && latest.current.draft?.revision === draft?.revision && !latest.current.disabled, content)
      if (alive.current && latest.current.account === original.account && latest.current.workbench.courseId === original.workbench.courseId
        && JSON.stringify(latest.current.content) === editor) {
        sessionStorage.removeItem(storageKey)
        props.onAdopt(next)
      }
    } catch (cause) { if (alive.current) setError(describe(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  async function cancel() {
    if (!run || !active || disabled || busy) return
    setBusy(true)
    try {
      await teacherCommand(account, 'POST', `/jobs/${encodeURIComponent(run.jobId)}/cancel`, { recoveryGeneration: run.generation })
      if (alive.current) setRun({ ...run })
    } catch (cause) { if (alive.current) setError(describe(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  const canAdopt = !!proposal && proposal.body.kind !== 'rubric_trial' && !stale && !blocked && !active
    && (draft ? Object.keys(proposalPatch(proposal, run?.fields ?? [])).length > 0
      : proposal.body.kind === 'blueprint' || (proposal.body.kind === 'candidates' && candidate !== undefined))
  return <details className="tda-panel">
    <summary>AI 协助设计<span>候选由教师核对、选择采用</span></summary>
    <p className="td-hint">使用宿主获准的教师设计模型与独立预算。个人模型设置成功不代表设计预算已开放；预算关闭或服务不可用时会保留真实错误。</p>
    <fieldset className="td-fields" disabled={blocked || active}>
      <label className="td-field"><span className="td-field-title">设计协助类型</span><select value={mode} onChange={event => setMode(event.target.value as DesignMode)}>
        {!draft && <option value="candidates">起草项目候选</option>}
        <option value="blueprint">完整蓝图建议</option>
        {draft && <><option value="patch">局部修改建议</option><option value="rubric_trial">样例试评量规</option></>}
      </select></label>
      <label className="td-field"><span className="td-field-title">给 AI 的设计要求</span><textarea maxLength={32000} rows={3} value={request} onChange={event => setRequest(event.target.value)} placeholder="课程目标、学生基础、时间约束、希望改进的部分……" /></label>
      {draft && mode !== 'rubric_trial' && <fieldset className="tda-choices"><legend>允许修改的字段</legend>{designFields.map(field => <label key={field}><input type="checkbox" checked={fields.includes(field)} onChange={event => setFields(event.target.checked ? [...fields, field] : fields.filter(item => item !== field))} />{labels[field]}</label>)}</fieldset>}
      <fieldset className="tda-choices tda-references"><legend>获准用于教师设计的材料段落（最多64段）</legend>
        {!paragraphs.length && <p className="td-hint">当前没有开放教师设计用途的材料，可先说明要求；量规试评需要获准样例。</p>}
        {paragraphs.map(paragraph => <div key={paragraph.paragraphId}><label><input type="checkbox" checked={selected.includes(paragraph.paragraphId)} disabled={!selected.includes(paragraph.paragraphId) && selected.length >= 64}
          onChange={event => { setSelected(event.target.checked ? [...selected, paragraph.paragraphId] : selected.filter(id => id !== paragraph.paragraphId)); setSamples(samples.filter(id => id !== paragraph.paragraphId)) }} />
          <span>{paragraph.title} · 段落{paragraph.ordinal + 1}{paragraph.private ? ' · 教师私有材料' : ''}<small>{paragraph.text.slice(0, 180)}</small></span></label>
          {mode === 'rubric_trial' && selected.includes(paragraph.paragraphId) && <label><input type="checkbox" checked={samples.includes(paragraph.paragraphId)} onChange={event => setSamples(event.target.checked ? [...samples, paragraph.paragraphId] : samples.filter(id => id !== paragraph.paragraphId))} />将此段作为教师认可的试评样例</label>}
        </div>)}
      </fieldset>
      <button type="button" className="td-btn" disabled={!request.trim()} onClick={() => { void generate() }}>提交设计请求</button>
    </fieldset>
    {draft && dirty && <p role="status">请先保存人工编辑，再请求或采用基于该版本的建议。</p>}
    {error && <div className="td-notice tld-error" role="alert">{error} 结果未知时请核对原请求，不要另发新任务。</div>}
    {pending && run && <button type="button" className="td-btn" disabled={busy} onClick={() => { void generate(true) }}>核对原 AI 请求</button>}
    {run?.jobId && <div className="tda-job" role="status"><p>设计任务：{run.jobId}</p><p>状态：{job ? ({ queued: '排队中', running: '生成中', succeeded: '已取得候选', cancelling: '正在取消', cancelled: '已取消', failed: '失败', stale: '上下文已过时', timed_out: '已超时', outcome_unknown: '结果未知' }[job.status] ?? job.status) : '正在读取'}</p>{job?.failure && <p>原因：{job.failure}</p>}
      <button type="button" className="td-btn" disabled={busy} onClick={() => setRun({ ...run })}>重新读取原任务</button>
      {active && <button type="button" className="td-btn" disabled={disabled || busy} onClick={() => { void cancel() }}>取消设计任务</button>}
    </div>}
    <details className="tda-restore"><summary>恢复已有设计任务</summary><label className="td-field"><span className="td-field-title">原设计任务 ID</span><input value={restoreId} maxLength={128} onChange={event => setRestoreId(event.target.value)} /></label><button type="button" className="td-btn" disabled={busy || active || !restoreId.trim()} onClick={() => {
      try { remember({ jobId: restoreId.trim(), courseId: workbench.courseId, blueprintId: draft?.blueprintId ?? null, baseRevision: draft?.revision ?? 0, generation: workbench.recoveryGeneration, editor, fields: [] }); setError('') } catch (cause) { setError(describe(cause)) }
    }}>读取已有任务</button></details>
    {proposal && <section className="tda-proposal" aria-label="模型设计候选">
      <h2>模型设计候选 · 基础版本 {proposal.baseRevision}</h2>
      <p>候选不是正式教学决定，也不会直接分配给学生。</p>
      {proposal.body.kind === 'candidates' ? proposal.body.candidates?.map((item, index) => <article key={index}><label className="tld-checkbox"><input type="radio" name="design-candidate" checked={candidate === index} onChange={() => setCandidate(index)} />选择候选 {index + 1}</label><Value value={item} /></article>) : <Value value={Object.fromEntries(Object.entries(proposal.body).filter(([key]) => key !== 'kind'))} />}
      {proposal.rationale && <p>建议理由：{proposal.rationale}</p>}
      <details><summary>依据与受影响项</summary><Value value={proposal.affectedReferences} /></details>
      {proposal.diff.length > 0 && <details><summary>与原版本的差异</summary>{proposal.diff.map((item, index) => <div className="tda-diff" key={index}><h3>{labels[item.path] ?? item.path}</h3><div><strong>原内容</strong><Value value={item.before} /></div><div><strong>候选内容</strong><Value value={item.after} /></div></div>)}</details>}
      {stale && <p className="tld-error" role="status">候选已过时或期间发生人工编辑，不能覆盖当前设计。候选保留供对照。</p>}
      {proposal.body.kind === 'rubric_trial' ? <p>试评仅供教师判断。请在“里程碑与量规”中明确修订、记录歧义及处理方式，再保存和检查。</p>
        : <><p>采用基础字段并保留已选课程配置；文字目标、量规等结构建议仍需教师补齐关联并通过设计检查。</p><button type="button" className="td-btn td-btn-primary" disabled={!canAdopt} onClick={() => { void adopt() }}>{draft ? '采用允许字段到草稿新版本' : '采用为新草稿'}</button></>}
    </section>}
  </details>
}
