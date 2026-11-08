import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { PreviewBriefSection, PreviewGoalsSection, PreviewMilestonesSection, PreviewSupportSection, PreviewDesignSupport, PreviewDesignDialogs, PreviewDesignNavigation, PreviewDesignSectionHeading, PreviewDesignFooter, PreviewDesignHeading, PreviewDesignTopline, DesignUnavailable, PreviewDesignSource, PreviewDesignReadOnlyNotice } from '@xunjie/ui/teacher-design'
export { PreviewDesignField as Field, DesignCheckGroup as CheckGroup } from '@xunjie/ui/teacher-design'
import { useTeacher } from './context'
import type { DesignDraft, DesignGoal } from './types'
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

export default function DesignPage() {
  const { draftId = 'new' } = useParams<{ draftId: string }>()
  const [search] = useSearchParams()
  const workspace = useTeacher()
  const original = workspace.data.drafts.find(draft => draft.id === draftId)
  if (draftId !== 'new' && !original) {
    return <DesignUnavailable title={workspace.loading ? '正在读取项目设计…' : '没有找到这份设计'} description="请从项目列表中重新打开已有草稿。" projectsPath={`${workspace.base}/projects`} Link={Link} />
  }
  const queryCourseId = search.get('course') || ''
  const initialCourseId = workspace.data.courses.some(course => course.id === queryCourseId) ? queryCourseId : workspace.data.courses.some(course => course.id === workspace.courseId) ? workspace.courseId : workspace.data.courses[0]?.id || ''
  const source = draftId === 'new' ? workspace.data.learners.find(learner => learner.id === search.get('from') && learner.courseId === initialCourseId) : undefined
  const initial = original ?? createDraft(initialCourseId)
  if (source) initial.foundation = `相关后续活动：${source.activityTitle}。已有教师反馈：${source.feedback || '未形成'}。新目标与迁移表现仍需分别观察。`
  return <DesignEditor key={draftId === 'new' ? `${draftId}:${queryCourseId}:${search.get('from') ?? ''}` : draftId} initial={initial} source={source ? { id: source.id, name: source.name, activityTitle: source.activityTitle } : undefined} />
}

export function DesignEditor({ initial, source }: { initial: DesignDraft; source?: { id: string; name: string; activityTitle: string } }) {
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

  return <div className="td-page">
    <PreviewDesignTopline base={base} Link={Link} />
    <PreviewDesignHeading draft={draft} dirty={dirty} revisionLabel={revisionLabel} preview={preview} save={save} openPreview={openPreview} />
    {source && <PreviewDesignSource source={source} base={base} Link={Link} />}
    {!preview && <PreviewDesignReadOnlyNotice />}
    <div className="td-layout">
      <main className="td-editor">
        <PreviewDesignNavigation section={section} setSection={setSection} />
        <div className="td-editor-body">
          <PreviewDesignSectionHeading section={section} />
          <fieldset disabled={!preview} className="td-fields">
            {section === 'brief' && <PreviewBriefSection draft={draft} patch={patch} data={data} onCourseChange={courseId => { patch('courseId',courseId); patch('resourceIds',[]); setStudents([]) }} />}
            {section === 'goals' && <PreviewGoalsSection draft={draft} patch={patch} />}
            {section === 'milestones' && <PreviewMilestonesSection draft={draft} patch={patch} uid={uid} />}
            {section === 'support' && <PreviewSupportSection draft={draft} patch={patch} courseResources={courseResources} base={base} Link={Link} />}
          </fieldset>
          <PreviewDesignFooter section={section} setSection={setSection} setAssistantTab={setAssistantTab} />
        </div>
      </main>
      <PreviewDesignSupport preview={preview} assistantTab={assistantTab} setAssistantTab={setAssistantTab} blocks={blocks} questions={questions} setSection={setSection} prompt={prompt} setPrompt={setPrompt} suggestion={suggestion} conflicts={conflicts} ready={ready} setModal={setModal} showSuggestion={showSuggestion} openPreview={openPreview} />
    </div>

    <PreviewDesignDialogs dialog={dialog} modal={modal} setModal={setModal} suggestion={suggestion} draft={draft} conflicts={conflicts}
 preview={preview} adoptSuggestion={adoptSuggestion} role={role} setRole={setRole} revisionLabel={revisionLabel} dirty={dirty}
 course={course} visibleResources={visibleResources} acknowledged={acknowledged} setAcknowledged={setAcknowledged} ready={ready}
 blocks={blocks} setAssistantTab={setAssistantTab} learners={learners} students={students} setStudents={setStudents}
 releaseDisabled={!preview || !students.length || confirmed !== fingerprint(draft) || dirty || !ready}
 onConfirmPreview={() => { setConfirmed(fingerprint(draft)); setStudents([]); setModal('assign') }} onRelease={() => { if (!preview || confirmed !== fingerprint(draft)) return; releaseDraft(draft, students); setModal(null); setConfirmed(''); setAcknowledged(false) }} />
  </div>
}
