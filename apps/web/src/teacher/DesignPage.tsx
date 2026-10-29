import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Icon, IconText } from '../icons'
import { useTeacher } from './context'
import type { DesignDraft, DesignGoal, TeacherResource } from './types'
import './design.css'

const sections = [
  { id: 'brief', title: '项目简报', subtitle: '把真实问题写清楚', icon: 'file-text' },
  { id: 'goals', title: '目标与证据', subtitle: '三条能力线，共同生长', icon: 'route' },
  { id: 'milestones', title: '里程碑与量规', subtitle: '让学习过程可以被看见', icon: 'checklist' },
  { id: 'support', title: '帮助与资源', subtitle: '支持有边界，材料有分寸', icon: 'book-2' },
] as const
type Section = typeof sections[number]['id']
type Role = 'student' | 'tutor' | 'teacher'
type TextKey = 'problem' | 'foundation' | 'helpPolicy'
type Suggestion = { key: TextKey; title: string; before: string; after: string }
type Check = { title: string; section: Section }
const domains: { id: DesignGoal['domain']; title: string; hint: string }[] = [
  { id: 'domain', title: '学科能力', hint: '学生要理解哪些概念，并能做出什么？' },
  { id: 'project', title: '项目能力', hint: '学生如何分解、验证并解释自己的方案？' },
  { id: 'ai_collaboration', title: 'AI 协作能力', hint: '学生如何判断、核验并说明所获得的帮助？' },
]
const kindNames: Record<TeacherResource['kind'], string> = {
  learning: '学习材料', reference: '参考资料', private_answer: '教师私有答案', validation: '验证材料',
}
const fingerprint = (draft: DesignDraft) => JSON.stringify(draft)
const contentFingerprint = (draft: DesignDraft) => JSON.stringify({ ...draft, revision: 0, savedAt: '' })
const uid = () => globalThis.crypto.randomUUID()
function createDraft(courseId: string): DesignDraft {
  return {
    id: `draft-${uid()}`, courseId, title: '', problem: '', audience: '', deliverable: '', choices: '',
    foundation: '', duration: '', goals: domains.map(domain => ({ id: uid(), domain: domain.id, title: '', evidence: '' })),
    milestones: [{ id: uid(), title: '', evidence: '' }], rubric: [{ id: uid(), criterion: '', description: '' }],
    helpPolicy: '', resourceIds: [], revision: 0, savedAt: '',
  }
}

function Field({ title, hint, required, children }: { title: string; hint?: string; required?: boolean; children: ReactNode }) {
  return <label className="td-field"><span className="td-field-title">{title}{required && <span className="td-required">必填</span>}</span>{children}{hint && <span className="td-hint">{hint}</span>}</label>
}

export default function DesignPage() {
  const { draftId = 'new' } = useParams<{ draftId: string }>()
  const [search] = useSearchParams()
  const workspace = useTeacher()
  const original = workspace.data.drafts.find(draft => draft.id === draftId)
  if (draftId !== 'new' && !original) {
    return <div className="td-empty"><Icon name="folder-search" size={36} /><h1>{workspace.loading ? '正在读取项目设计…' : '没有找到这份设计'}</h1><p>请从项目列表中重新打开已有草稿。</p><Link className="td-btn" to={`${workspace.base}/projects`}>返回项目与活动</Link></div>
  }
  const queryCourseId = search.get('course') || ''
  const initialCourseId = workspace.data.courses.some(course => course.id === queryCourseId) ? queryCourseId : workspace.data.courses.some(course => course.id === workspace.courseId) ? workspace.courseId : workspace.data.courses[0]?.id || ''
  const source = draftId === 'new' ? workspace.data.learners.find(learner => learner.id === search.get('from') && learner.courseId === initialCourseId) : undefined
  const initial = original ?? createDraft(initialCourseId)
  if (source) initial.foundation = `相关后续活动：${source.activityTitle}。已有教师反馈：${source.feedback || '未形成'}。新目标与迁移表现仍需分别观察。`
  return <DesignEditor key={draftId === 'new' ? `${draftId}:${queryCourseId}:${search.get('from') ?? ''}` : draftId} initial={initial} source={source ? { id: source.id, name: source.name, activityTitle: source.activityTitle } : undefined} />
}

function DesignEditor({ initial, source }: { initial: DesignDraft; source?: { id: string; name: string; activityTitle: string } }) {
  const { preview, base, data, saveDraft, releaseDraft, notify } = useTeacher()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<DesignDraft>(() => structuredClone(initial))
  const [saved, setSaved] = useState(() => fingerprint(initial))
  const [section, setSection] = useState<Section>('brief')
  const [assistantTab, setAssistantTab] = useState<'assistant' | 'checks'>('assistant')
  const [prompt, setPrompt] = useState('')
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [modal, setModal] = useState<'preview' | 'assign' | 'suggestion' | null>(null)
  const [role, setRole] = useState<Role>('student')
  const [confirmed, setConfirmed] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [students, setStudents] = useState<string[]>([])
  const dialog = useRef<HTMLDialogElement>(null)
  const pendingSave = useRef<DesignDraft | null>(null)
  const dirty = fingerprint(draft) !== saved
  const course = data.courses.find(item => item.id === draft.courseId)
  const courseResources = data.resources.filter(resource => resource.courseId === draft.courseId)
  const selectedResources = courseResources.filter(resource => draft.resourceIds.includes(resource.id))
  const learners = data.learners.filter(learner => learner.courseId === draft.courseId)
  const conflicts = suggestion !== null && draft[suggestion.key] !== suggestion.before

  useEffect(() => {
    const element = dialog.current
    if (modal && element && !element.open) element.showModal()
    if (!modal && element?.open) element.close()
  }, [modal])
  useEffect(() => {
    const requested = pendingSave.current
    if (!requested) return
    const persisted = data.drafts.find(item => item.id === requested.id)
    if (!persisted || persisted.revision <= requested.revision || contentFingerprint(persisted) !== contentFingerprint(requested)) return
    pendingSave.current = null
    setSaved(fingerprint(persisted))
    setDraft(current => contentFingerprint(current) === contentFingerprint(requested) ? structuredClone(persisted) : { ...current, revision: persisted.revision, savedAt: persisted.savedAt })
    setConfirmed('')
    setAcknowledged(false)
    if (initial.revision === 0) navigate(`${base}/design/${persisted.id}`, { replace: true })
  }, [data.drafts, base, initial.revision, navigate])
  useEffect(() => {
    if (!dirty) return
    const onUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])

  const patch = <K extends keyof DesignDraft>(key: K, value: DesignDraft[K]) => {
    setDraft(current => ({ ...current, [key]: value }))
    setConfirmed('')
    setAcknowledged(false)
  }
  const blocks: Check[] = []
  if (!draft.courseId || !course) blocks.push({ title: '选择所属课程', section: 'brief' })
  if (!draft.title.trim()) blocks.push({ title: '补充项目标题', section: 'brief' })
  if (!draft.problem.trim() || !draft.audience.trim() || !draft.deliverable.trim()) blocks.push({ title: '写明驱动问题、受众与最终产物', section: 'brief' })
  if (domains.some(domain => !draft.goals.some(goal => goal.domain === domain.id && goal.title.trim() && goal.evidence.trim()))) blocks.push({ title: '完善三条能力线的目标与可观察表现', section: 'goals' })
  if (!draft.milestones.length || draft.milestones.some(item => !item.title.trim() || !item.evidence.trim())) blocks.push({ title: '为每个里程碑写明阶段证据', section: 'milestones' })
  if (!draft.rubric.length || draft.rubric.some(item => !item.criterion.trim() || !item.description.trim())) blocks.push({ title: '补充量规维度与判定描述', section: 'milestones' })
  if (!draft.helpPolicy.trim()) blocks.push({ title: '明确 AI 与其他帮助的使用政策', section: 'support' })
  if (selectedResources.some(resource => (resource.kind === 'private_answer' || resource.kind === 'validation') && (resource.student || resource.tutor))) blocks.push({ title: '私有答案或验证材料的可见范围冲突，请在课程材料中修正', section: 'support' })
  const questions: Check[] = []
  if (!draft.choices.trim()) questions.push({ title: '学生有哪些真实的选择空间？', section: 'brief' })
  if (!draft.foundation.trim()) questions.push({ title: '前置基础是否与学生当前经验匹配？', section: 'brief' })
  if (!draft.duration.trim()) questions.push({ title: '预计时长与里程碑是否相称？', section: 'brief' })
  if (!selectedResources.some(resource => resource.student && resource.kind !== 'private_answer' && resource.kind !== 'validation')) questions.push({ title: '学生是否有足够的公开学习材料？', section: 'support' })
  const ready = blocks.length === 0
  const revisionLabel = draft.revision ? `v${draft.revision}` : '未保存版本'
  const visibleResources = selectedResources.filter(resource => role === 'teacher' || (resource.kind !== 'private_answer' && resource.kind !== 'validation' && (role === 'student' ? resource.student : resource.tutor)))

  function save() {
    if (!preview) return
    pendingSave.current = structuredClone(draft)
    saveDraft(draft)
  }
  function showSuggestion() {
    const key: TextKey = section === 'support' ? 'helpPolicy' : section === 'goals' ? 'foundation' : 'problem'
    const suggestions: Record<TextKey, { title: string; example: string }> = {
      problem: { title: '让问题连接明确的使用情境', example: '请为真实使用者设计一个可以运行的解决方案。说明使用者遇到的问题、约束和判断方案有效的标准，并通过至少两个边界情形验证设计。' },
      foundation: { title: '把前置基础写成可核对的起点', example: '学生已接触本课程的基础概念，能够读懂简短示例。活动开始前，用一项小任务核对基础；根据学生解释决定是否补充支架。' },
      helpPolicy: { title: '区分获得帮助与独立核验', example: '允许使用 AI 理解概念、讨论思路与定位问题。提交时说明使用了哪些帮助、采纳了什么，以及如何独立核验；学生应能解释最终方案。不得将未验证的生成内容直接作为结论。' },
    }
    setSuggestion({ key, title: suggestions[key].title, before: draft[key], after: draft[key].trim() ? `${draft[key].trim()}\n\n${suggestions[key].example}` : suggestions[key].example })
    notify('示例建议已准备好，请对比后决定是否采用。')
  }
  function adoptSuggestion() {
    if (!preview || !suggestion) return
    if (draft[suggestion.key] !== suggestion.before) { notify('该字段已有新编辑，建议未应用。请重新建立对比。'); return }
    patch(suggestion.key, suggestion.after)
    setSuggestion(null)
    setModal(null)
    notify('已采用示例建议，草稿尚未保存。')
  }
  function openPreview() {
    setRole('student')
    setAcknowledged(confirmed === fingerprint(draft))
    setModal('preview')
  }
  const field = (key: TextKey | 'title' | 'audience' | 'deliverable' | 'choices' | 'duration', title: string, placeholder: string, required = false, rows = 3) => <Field title={title} required={required}>{rows === 1 ? <input value={draft[key]} onChange={event => patch(key, event.target.value)} placeholder={placeholder} /> : <textarea rows={rows} value={draft[key]} onChange={event => patch(key, event.target.value)} placeholder={placeholder} />}</Field>

  return <div className="td-page">
    <div className="td-topline"><Link to={`${base}/projects`} className="td-back"><IconText name="alt-arrow-left" tone="neutral">项目与活动</IconText></Link><span>设计工作台</span><span className="td-draft-tag">草稿</span></div>
    <header className="td-heading">
      <div><p className="td-eyebrow">PROJECT DESIGN</p><h1>{draft.title || '让一个好问题，成为学习的起点'}</h1><p>从目标到证据，把你的教学想法一步步变成项目。</p></div>
      <div className="td-heading-actions"><span className={`td-save-state${dirty ? ' is-dirty' : ''}`}><span />{dirty ? '有未保存的编辑' : draft.savedAt ? `已保存 · ${revisionLabel}` : '尚未保存'}</span><button type="button" className="td-btn" onClick={save} disabled={!preview || (!dirty && draft.revision > 0)}><IconText name="archive-down" tone="neutral">保存草稿</IconText></button><button type="button" className="td-btn td-btn-primary" onClick={openPreview}><IconText name="play-circle" tone="neutral">预览与分配</IconText></button></div>
    </header>
    {source && <p className="td-source"><Icon name="link" tone="neutral" /><span>来自 {source.name} 的后续活动设计 · {source.activityTitle}</span><Link to={`${base}/review?learner=${encodeURIComponent(source.id)}`}>返回证据审阅</Link></p>}
    {!preview && <div className="td-notice" role="status"><Icon name="info-circle" tone="neutral" /><span>教师设计的保存、设计助手与分配服务尚待业务接线。本页当前只读，真实操作不可用。</span></div>}
    <div className="td-layout">
      <main className="td-editor">
        <nav className="td-steps" aria-label="设计章节">{sections.map((item, index) => <button type="button" key={item.id} className={section === item.id ? 'is-current' : ''} aria-current={section === item.id ? 'step' : undefined} onClick={() => setSection(item.id)}><span className="td-step-number">0{index + 1}</span><span>{item.title}</span></button>)}</nav>
        <div className="td-editor-body">
          <div className="td-section-heading"><span className="td-section-icon"><Icon name={sections.find(item => item.id === section)!.icon} size={22} tone="neutral" /></span><div><h2>{sections.find(item => item.id === section)!.title}</h2><p>{sections.find(item => item.id === section)!.subtitle}</p></div><span className="td-section-count">0{sections.findIndex(item => item.id === section) + 1} / 04</span></div>
          <fieldset disabled={!preview} className="td-fields">
            {section === 'brief' && <>
              <div className="td-form-pair"><Field title="所属课程" required><select value={draft.courseId} onChange={event => { patch('courseId', event.target.value); patch('resourceIds', []); setStudents([]) }}><option value="">选择一门课程</option>{data.courses.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></Field>{field('duration', '预计时长', '例如：2 周 · 4 课时', false, 1)}</div>
              {field('title', '项目标题', '给项目一个简洁、具体的名字', true, 1)}
              {field('problem', '驱动问题', '学生将为谁，解决怎样的真实问题？哪些约束值得探索？', true, 5)}
              <div className="td-form-pair">{field('audience', '项目受众', '谁会使用这份作品？它回应了谁的实际问题？', true)}{field('deliverable', '最终产物', '可运行作品、设计说明，以及用于验证的证据', true)}</div>
              {field('choices', '留给学生的选择空间', '哪些情境、方案或实现路径可以由学生自己决定？')}
              {field('foundation', '前置基础', '学生开始前需要理解什么、能够完成什么？')}
            </>}
            {section === 'goals' && <><div className="td-inline-note"><Icon name="lightbulb" tone="neutral" /><p>目标描述“学会什么”，可观察表现说明“凭什么判断”。三条能力线分别保留证据，不合并成一个总分。</p></div>{domains.map((domain, index) => {
              const goal = draft.goals.find(item => item.domain === domain.id) ?? { id: `goal-${domain.id}`, domain: domain.id, title: '', evidence: '' }
              const update = (key: 'title' | 'evidence', value: string) => patch('goals', draft.goals.some(item => item.id === goal.id) ? draft.goals.map(item => item.id === goal.id ? { ...item, [key]: value } : item) : [...draft.goals, { ...goal, [key]: value }])
              return <div className="td-goal" key={domain.id}><div className="td-row-heading"><span className="td-mini-index">0{index + 1}</span><div><h3>{domain.title}</h3><p>{domain.hint}</p></div></div><Field title="学习目标" required><textarea rows={2} value={goal.title} onChange={event => update('title', event.target.value)} placeholder="使用具体、可观察的动词描述目标" /></Field><Field title="可观察表现与证据" required><textarea rows={3} value={goal.evidence} onChange={event => update('evidence', event.target.value)} placeholder="作品、解释、验证过程或独立核验中，会看到什么？" /></Field></div>
            })}</>}
            {section === 'milestones' && <>
              <div className="td-subheading"><h3>学习里程碑</h3><p>每一步都有一个可讨论、可回看的阶段产物。</p></div>
              {draft.milestones.map((item, index) => <div className="td-repeat" key={item.id}><div className="td-repeat-heading"><span className="td-mini-index">{String(index + 1).padStart(2, '0')}</span><strong>阶段 {index + 1}</strong><button type="button" className="td-icon-btn" aria-label={`移除里程碑 ${index + 1}`} disabled={draft.milestones.length === 1} onClick={() => patch('milestones', draft.milestones.filter(current => current.id !== item.id))}><Icon name="close" tone="neutral" /></button></div><Field title="里程碑名称" required><input value={item.title} onChange={event => patch('milestones', draft.milestones.map(current => current.id === item.id ? { ...current, title: event.target.value } : current))} placeholder="例如：提出方案并解释取舍" /></Field><Field title="阶段证据" required><textarea rows={2} value={item.evidence} onChange={event => patch('milestones', draft.milestones.map(current => current.id === item.id ? { ...current, evidence: event.target.value } : current))} placeholder="这一阶段要保留哪些作品、验证与解释？" /></Field></div>)}
              <button type="button" className="td-add" onClick={() => patch('milestones', [...draft.milestones, { id: uid(), title: '', evidence: '' }])}><IconText name="add" tone="neutral">添加里程碑</IconText></button>
              <div className="td-subheading td-subheading-separated"><h3>评价量规</h3><p>判定依据指向证据；有帮助下完成与独立核验分别描述。</p></div>
              {draft.rubric.map((item, index) => <div className="td-repeat" key={item.id}><div className="td-repeat-heading"><strong>评价维度 {index + 1}</strong><button type="button" className="td-icon-btn" aria-label={`移除评价维度 ${index + 1}`} disabled={draft.rubric.length === 1} onClick={() => patch('rubric', draft.rubric.filter(current => current.id !== item.id))}><Icon name="close" tone="neutral" /></button></div><Field title="评价维度" required><input value={item.criterion} onChange={event => patch('rubric', draft.rubric.map(current => current.id === item.id ? { ...current, criterion: event.target.value } : current))} placeholder="例如：验证方案与解释结果" /></Field><Field title="判定描述与证据要求" required><textarea rows={3} value={item.description} onChange={event => patch('rubric', draft.rubric.map(current => current.id === item.id ? { ...current, description: event.target.value } : current))} placeholder="不同表现如何区分？证据不足时保留哪些未知？" /></Field></div>)}
              <button type="button" className="td-add" onClick={() => patch('rubric', [...draft.rubric, { id: uid(), criterion: '', description: '' }])}><IconText name="add" tone="neutral">添加评价维度</IconText></button>
            </>}
            {section === 'support' && <>
              {field('helpPolicy', '帮助使用政策', '学生何时可以求助？如何记录与核验帮助？哪些部分需要独立解释？', true, 6)}
              <div className="td-subheading"><h3>项目资源</h3><p>选择本项目使用的课程材料。角色预览只显示该角色获准看到的内容。</p></div>
              {courseResources.length ? <div className="td-resource-list">{courseResources.map(resource => <label className="td-resource-option" key={resource.id}><input type="checkbox" checked={draft.resourceIds.includes(resource.id)} onChange={event => patch('resourceIds', event.target.checked ? [...draft.resourceIds, resource.id] : draft.resourceIds.filter(id => id !== resource.id))} /><Icon name={resource.kind === 'private_answer' ? 'lock-keyhole' : 'file-text'} tone="neutral" size={20} /><span><strong>{resource.title}</strong><span>{kindNames[resource.kind]} · v{resource.version}</span><span className="td-visibility">{resource.kind === 'private_answer' || resource.kind === 'validation' ? '教师 / 验证器可见 · 不进入学生与辅导预览' : `学生${resource.student ? '可见' : '不可见'} · 辅导${resource.tutor ? '可见' : '不可见'}`} · 教师设计 AI {resource.teacherDesign ? '可使用' : '不可使用'}</span></span></label>)}</div> : <div className="td-inline-empty"><Icon name="folder-with-files" tone="neutral" size={24} /><p>这门课程还没有可选材料。</p><Link to={`${base}/materials`}>前往课程材料</Link></div>}
              <div className="td-inline-note"><Icon name="shield-check" tone="neutral" /><p>私有答案与验证材料仅对教师 / 验证器可见，始终排除在学生与辅导预览之外。教师设计 AI 能否使用由单独的材料权限控制。</p></div>
            </>}
          </fieldset>
          <footer className="td-editor-footer"><span>编辑内容在切换章节时保留，保存后写入本机预览。</span><div>{section !== 'brief' && <button type="button" className="td-btn" onClick={() => setSection(sections[sections.findIndex(item => item.id === section) - 1].id)}>上一节</button>}{section !== 'support' ? <button type="button" className="td-btn td-btn-primary" onClick={() => setSection(sections[sections.findIndex(item => item.id === section) + 1].id)}><IconText name="arrow-right" position="end" tone="neutral">下一节</IconText></button> : <button type="button" className="td-btn td-btn-primary" onClick={() => setAssistantTab('checks')}><IconText name="checklist" tone="neutral">检查设计</IconText></button>}</div></footer>
        </div>
      </main>
      <aside className="td-rail" aria-label="设计支持">
        <div className="td-rail-tabs" role="tablist" aria-label="设计支持标签"><button type="button" id="td-assistant-tab" role="tab" aria-selected={assistantTab === 'assistant'} aria-controls="td-assistant-panel" onClick={() => setAssistantTab('assistant')} onKeyDown={event => { if (event.key === 'ArrowRight') { setAssistantTab('checks'); document.getElementById('td-checks-tab')?.focus() } }}><IconText name="assistant-mark" tone="neutral">设计助手</IconText></button><button type="button" id="td-checks-tab" role="tab" aria-selected={assistantTab === 'checks'} aria-controls="td-checks-panel" onClick={() => setAssistantTab('checks')} onKeyDown={event => { if (event.key === 'ArrowLeft') { setAssistantTab('assistant'); document.getElementById('td-assistant-tab')?.focus() } }}>设计检查<span>{blocks.length}</span></button></div>
        {assistantTab === 'assistant' ? <div id="td-assistant-panel" role="tabpanel" aria-labelledby="td-assistant-tab" className="td-assistant">
          <div className="td-assistant-intro"><span className="td-assistant-symbol"><Icon name="assistant-mark" size={28} tone="neutral" /></span><h3>和你一起，打磨好问题</h3><p>让目标、活动和评价之间，建立看得见的联系。</p><span className="td-example-tag">{preview ? '本机示例 · 未调用 AI' : '设计服务待接线'}</span></div>
          <div className="td-assistant-message"><p>先从你最关心的一点开始。你可以描述学生的基础、希望看到的表现，或项目中还不确定的部分。</p><p className="td-hint">当前提供固定示例建议；采用前会展示内容对比，不自动改写草稿。</p></div>
          <div className="td-prompt-shortcuts">{['驱动问题是否足够具体？', '怎样观察三条能力线？', '帮助政策如何写清楚？'].map(text => <button type="button" key={text} disabled={!preview} onClick={() => setPrompt(text)}>{text}<Icon name="arrow-up" tone="neutral" /></button>)}</div>
          {suggestion && <div className="td-suggestion-card"><span>示例建议</span><strong>{suggestion.title}</strong><p>{conflicts ? '你已更新相关字段。旧建议暂不可采用，避免覆盖新编辑。' : '建议已准备好，原稿保持不变。'}</p><button type="button" className="td-btn" onClick={() => setModal('suggestion')}>对比内容</button></div>}
          <div className="td-composer"><label className="td-sr-only" htmlFor="td-design-prompt">希望讨论的设计问题</label><textarea id="td-design-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={!preview} placeholder="描述你的教学想法或疑问…" rows={3} /><div><span>示例建议依据当前章节</span><button type="button" disabled={!preview} aria-label="查看示例建议" title="查看示例建议，不调用真实 AI" onClick={showSuggestion}><Icon name="arrow-up" tone="neutral" size={18} /></button></div></div>
        </div> : <div id="td-checks-panel" role="tabpanel" aria-labelledby="td-checks-tab" className="td-checks">
          <div className={`td-check-summary${ready ? ' is-ready' : ''}`}><Icon name={ready ? 'check-circle' : 'checklist'} size={28} tone="neutral" /><h3>{ready ? '结构已齐备，继续核对' : '让设计再完整一点'}</h3><p>本机结构检查随编辑更新，不代表教学质量或真实验收通过。</p></div>
          <CheckGroup title="阻断项" count={blocks.length} tone="block" empty="必填结构已补齐" items={blocks} onSelect={setSection} />
          <CheckGroup title="设计疑点" count={questions.length} tone="question" empty="目前未发现这些结构疑点" items={questions} onSelect={setSection} />
          <div className="td-check-group"><div className="td-check-group-title"><span className="td-check-dot pending" /><strong>待验证</strong><span>2</span></div><p>教师逐项试做，确认问题可完成、时长合理，评价依据足够。</p><p>真实保存、角色权限与分配接口接入后，完成服务端与浏览器验收。</p></div>
          <button type="button" className="td-btn td-check-preview" onClick={openPreview}>查看三个角色的预览<Icon name="arrow-right" tone="neutral" /></button>
        </div>}
        <div className="td-rail-footnote"><Icon name="lock-keyhole" tone="neutral" /><span>{preview ? '草稿与示例建议仅保存在本机预览' : '真实业务接线前，编辑与分配保持关闭'}</span></div>
      </aside>
    </div>

    <dialog ref={dialog} className="td-dialog" aria-labelledby="td-dialog-title" onCancel={() => setModal(null)} onClose={() => setModal(null)} onClick={event => { if (event.target === event.currentTarget) setModal(null) }}>
      <div className="td-dialog-shell"><header className="td-dialog-header"><div><p className="td-eyebrow">{modal === 'suggestion' ? 'EXAMPLE SUGGESTION' : modal === 'assign' ? 'PREVIEW ASSIGNMENT' : 'ROLE PREVIEW'}</p><h2 id="td-dialog-title">{modal === 'suggestion' ? '对比后，再决定采用' : modal === 'assign' ? '选择合成学生' : '从不同角色，看看这份设计'}</h2></div><button type="button" className="td-icon-btn" aria-label="关闭对话框" onClick={() => setModal(null)}><Icon name="close" tone="neutral" size={20} /></button></header>
        {modal === 'suggestion' && suggestion && <><div className="td-dialog-body"><span className="td-example-tag">固定示例 · 未调用真实 AI</span><h3>{suggestion.title}</h3><div className="td-diff"><div><strong>当前草稿</strong><p>{draft[suggestion.key] || '尚未填写'}</p></div><div><strong>建议采用后</strong><p>{suggestion.after}</p></div></div>{conflicts && <p className="td-warning" role="status">相关字段已在建议建立后被修改。为保留你的新编辑，此建议不可直接采用；关闭后可重新查看示例建议。</p>}</div><footer className="td-dialog-footer"><button type="button" className="td-btn" onClick={() => setModal(null)}>继续编辑</button><button type="button" className="td-btn td-btn-primary" disabled={!preview || conflicts} onClick={adoptSuggestion}>采用示例建议</button></footer></>}
        {modal === 'preview' && <><div className="td-dialog-body"><div className="td-preview-toolbar"><div className="td-role-switch" aria-label="选择预览角色">{([{ id: 'student', title: '学生视角' }, { id: 'tutor', title: '辅导视角' }, { id: 'teacher', title: '教师 / 验证器' }] as const).map(item => <button type="button" key={item.id} aria-pressed={role === item.id} onClick={() => setRole(item.id)}>{item.title}</button>)}</div><span className="td-version">{revisionLabel}{dirty ? ' · 含未保存编辑' : ''}</span></div><article className="td-role-preview"><div className="td-preview-course">{course?.title || '尚未选择课程'} · {draft.duration || '时长待补充'}</div><h3>{draft.title || '项目标题待补充'}</h3><p>{draft.problem || '驱动问题待补充'}</p><dl><dt>项目受众</dt><dd>{draft.audience || '待补充'}</dd><dt>最终产物</dt><dd>{draft.deliverable || '待补充'}</dd><dt>选择空间</dt><dd>{draft.choices || '待补充'}</dd><dt>前置基础</dt><dd>{draft.foundation || '待补充'}</dd></dl><h4>学习目标</h4>{draft.goals.map(goal => <div className="td-preview-item" key={goal.id}><strong>{domains.find(domain => domain.id === goal.domain)?.title} · {goal.title || '目标待补充'}</strong><p>{goal.evidence || '可观察表现待补充'}</p></div>)}<h4>里程碑</h4>{draft.milestones.map((item, index) => <div className="td-preview-item" key={item.id}><strong>{index + 1}. {item.title || '阶段名称待补充'}</strong><p>{item.evidence || '证据待补充'}</p></div>)}<h4>评价量规</h4>{draft.rubric.map(item => <div className="td-preview-item" key={item.id}><strong>{item.criterion || '评价维度待补充'}</strong><p>{item.description || '描述待补充'}</p></div>)}<h4>帮助使用政策</h4><p>{draft.helpPolicy || '待补充'}</p><h4>{role === 'teacher' ? '教师 / 验证器可见资源' : role === 'student' ? '学生可见资源' : '辅导可见资源'}</h4>{visibleResources.length ? visibleResources.map(resource => <details className="td-preview-resource" key={resource.id}><summary><Icon name={resource.kind === 'private_answer' ? 'lock-keyhole' : 'file-text'} tone="neutral" />{resource.title}<span>v{resource.version}</span></summary><p>{resource.content}</p><small>来源：{resource.source || '未记录'}</small>{role === 'teacher' && <small>教师设计 AI：{resource.teacherDesign ? '允许使用' : '不允许使用'}（独立于教师阅读权限）</small>}</details>) : <p className="td-hint">该角色没有可见资源。</p>}</article><div className="td-preview-confirm"><label><input type="checkbox" checked={acknowledged} disabled={!preview || dirty || !ready || draft.revision === 0} onChange={event => setAcknowledged(event.target.checked)} /><span>我已核对当前保存版本 {revisionLabel} 的内容与角色可见范围</span></label><p>{!preview ? '真实分配尚待业务接线。' : dirty || draft.revision === 0 ? '先保存草稿，再核对该版本。' : !ready ? `仍有 ${blocks.length} 项阻断，请回到设计检查补齐。` : '设计疑点与待验证项仍需教师判断。本操作仅创建本机合成分配。'}</p></div></div><footer className="td-dialog-footer"><button type="button" className="td-btn" onClick={() => { setModal(null); setAssistantTab('checks') }}>返回设计检查</button><button type="button" className="td-btn td-btn-primary" disabled={!preview || dirty || !ready || !acknowledged || draft.revision === 0} onClick={() => { setConfirmed(fingerprint(draft)); setStudents([]); setModal('assign') }}>确认版本，选择学生<Icon name="arrow-right" tone="neutral" /></button></footer></>}
        {modal === 'assign' && <><div className="td-dialog-body"><div className="td-notice"><Icon name="info-circle" tone="neutral" /><span>仅分配给本机预览中的合成学生，不写入真实教学记录。</span></div><div className="td-assignment-summary"><strong>{draft.title}</strong><span>{course?.title} · {revisionLabel}</span></div><div className="td-selection-heading"><span>{learners.length} 位合成学生</span><button type="button" className="td-link-button" onClick={() => setStudents(students.length === learners.length ? [] : learners.map(learner => learner.id))}>{students.length === learners.length && learners.length ? '取消全选' : '选择全部'}</button></div>{learners.length ? learners.map(learner => <label key={learner.id} className="td-learner-option"><input type="checkbox" checked={students.includes(learner.id)} onChange={event => setStudents(event.target.checked ? [...students, learner.id] : students.filter(id => id !== learner.id))} /><span className="td-learner-avatar">{learner.name.slice(0, 1)}</span><span><strong>{learner.name}</strong><span>合成学生 · {learner.id}</span></span></label>) : <div className="td-inline-empty">该课程还没有合成学生可供分配。</div>}</div><footer className="td-dialog-footer"><button type="button" className="td-btn" onClick={() => setModal('preview')}>返回预览</button><button type="button" className="td-btn td-btn-primary" disabled={!preview || !students.length || confirmed !== fingerprint(draft) || dirty || !ready} onClick={() => { if (!preview || confirmed !== fingerprint(draft)) return; releaseDraft(draft, students); setModal(null); setConfirmed(''); setAcknowledged(false) }}>分配到本机预览 · {students.length} 人</button></footer></>}
      </div>
    </dialog>
  </div>
}

function CheckGroup({ title, count, tone, empty, items, onSelect }: { title: string; count: number; tone: string; empty: string; items: Check[]; onSelect: (section: Section) => void }) {
  return <div className="td-check-group"><div className="td-check-group-title"><span className={`td-check-dot ${tone}`} /><strong>{title}</strong><span>{count}</span></div>{items.length ? items.map((item, index) => <button type="button" className="td-check-item" key={`${item.section}-${index}`} onClick={() => onSelect(item.section)}><span>{item.title}</span><Icon name="alt-arrow-right" tone="neutral" /></button>) : <p className="td-check-empty"><Icon name="check" tone="neutral" />{empty}</p>}</div>
}
