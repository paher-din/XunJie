import { TeacherBadge, TeacherButton } from '../teacher'

export interface TeacherDetailNamedItem { id: string; title: string }
export interface TeacherDetailEvidenceItem extends TeacherDetailNamedItem { evidence: string }
export interface TeacherDetailRubricItem { id: string; criterion: string; description: string }
export type TeacherFixedMaterial =
  | { status: 'available'; id: string; title: string; text: string }
  | { status: 'redacted' | 'unavailable'; id: string }

/** Already-resolved values for the immutable activity from a teaching service. */
export interface TeacherFixedActivityView {
  audience?: string
  artifact?: string
  routes: string[]
  goals: { id: string; title: string; domain: string; version: string | number }[]
  tasks: TeacherDetailNamedItem[]
  milestones: TeacherDetailNamedItem[]
  rubric: { id: string; description: string }[]
  helpPolicy: string
  materials: TeacherFixedMaterial[]
  assignments: { id: string; name: string; active: boolean }[]
}
/** Preview snapshot data stays distinct from the real immutable activity. */
export interface TeacherPreviewActivityView {
  revision: number
  audience: string
  deliverable: string
  choices: string
  foundation: string
  duration: string
  goals: TeacherDetailEvidenceItem[]
  milestones: TeacherDetailEvidenceItem[]
  rubric: TeacherDetailRubricItem[]
  helpPolicy: string
  materials: { id: string; title: string; version: number; content: string; student: boolean; tutor: boolean; teacherDesign: boolean }[]
}
export interface TeacherPreviewAssignment { id: string; name: string }
export interface TeacherActivityDetailProps {
  statusLabel: string
  statusTone: 'progress' | 'pending'
  description: string
  activityId: string
  courseTitle?: string
  assigned: number
  versionLabel: string
  fixed?: TeacherFixedActivityView
  snapshot?: TeacherPreviewActivityView
  /** undefined hides the section; an empty array displays an empty assignment list. */
  previewAssignments?: TeacherPreviewAssignment[]
  showPreviewSummaryNote: boolean
  onClose: () => void
}

export interface TeacherFixedActivityProps { fixed: TeacherFixedActivityView }
export function TeacherFixedActivity({ fixed }: TeacherFixedActivityProps) {
  return <div className="t-fixed-design">
    <h3>固定活动要求</h3><dl><dt>项目受众</dt><dd>{fixed.audience || '未填写'}</dd><dt>最终产物</dt><dd>{fixed.artifact || '未填写'}</dd><dt>选择空间</dt><dd>{fixed.routes.join('；')}</dd></dl>
    <h3>目标与版本</h3>{fixed.goals.map(goal => <div className="t-fixed-item" key={goal.id}><strong>{goal.title}</strong><small>{goal.domain} · v{goal.version}</small></div>)}
    <h3>任务与里程碑</h3>{fixed.tasks.map(task => <p key={task.id}>{task.title}</p>)}{fixed.milestones.map(milestone => <p key={milestone.id}>{milestone.title}</p>)}
    <h3>评价依据</h3>{fixed.rubric.map(item => <p key={item.id}>{item.description}</p>)}
    <h3>帮助政策</h3><p>{fixed.helpPolicy}</p>
    <h3>固定材料 · 教师视角</h3>{fixed.materials.map(material => material.status === 'available' ? <details key={material.id}><summary>{material.title}</summary><pre className="t-rm-document-content">{material.text}</pre><small>{material.id}</small></details> : <p key={material.id}>{material.status === 'redacted' ? '按角色隐藏' : '该版本材料不可用'}</p>)}
    <h3>已分配学生</h3>{fixed.assignments.map(assignment => <p key={assignment.id}>{assignment.name} · {assignment.active ? '分配有效' : '分配暂停'}</p>)}
  </div>
}

export interface TeacherPreviewActivityProps { snapshot: TeacherPreviewActivityView }
export function TeacherPreviewActivity({ snapshot }: TeacherPreviewActivityProps) {
  return <div className="t-fixed-design">
    <h3>固定活动要求</h3><p>本机预览固定于蓝图 revision {snapshot.revision}。后续草稿编辑不会改写此处的要求和材料版本。</p>
    <dl><dt>项目受众</dt><dd>{snapshot.audience}</dd><dt>最终产物</dt><dd>{snapshot.deliverable}</dd><dt>选择空间</dt><dd>{snapshot.choices}</dd><dt>前置基础</dt><dd>{snapshot.foundation}</dd><dt>预计时长</dt><dd>{snapshot.duration}</dd></dl>
    <h3>目标与可观察表现</h3>{snapshot.goals.map(goal => <div className="t-fixed-item" key={goal.id}><strong>{goal.title}</strong><p>{goal.evidence}</p></div>)}
    <h3>里程碑</h3>{snapshot.milestones.map(item => <div className="t-fixed-item" key={item.id}><strong>{item.title}</strong><p>{item.evidence}</p></div>)}
    <h3>评价量规</h3>{snapshot.rubric.map(item => <div className="t-fixed-item" key={item.id}><strong>{item.criterion}</strong><p>{item.description}</p></div>)}
    <h3>帮助政策</h3><p>{snapshot.helpPolicy}</p>
    <h3>固定材料版本 · 教师视角</h3>{snapshot.materials.length ? snapshot.materials.map(resource => <details key={resource.id}><summary>{resource.title} · v{resource.version}</summary><p>{resource.content}</p><small>学生{resource.student ? '可见' : '不可见'} · 辅导{resource.tutor ? '可用' : '不可用'} · 设计 AI {resource.teacherDesign ? '可用' : '不可用'}</small></details>) : <p>本版本没有关联材料。</p>}
  </div>
}

export interface TeacherPreviewAssignmentsProps { assignments: TeacherPreviewAssignment[] }
export function TeacherPreviewAssignments({ assignments }: TeacherPreviewAssignmentsProps) {
  return <section className="t-fixed-assignments"><h3>已分配学生</h3><p>分配关系已在本机预览固定。分配不会代学生创建或开始尝试。</p><ul>{assignments.map(assignment => <li key={assignment.id}><span>{assignment.name}</span><small>{assignment.id}</small><TeacherBadge>等待学生开始</TeacherBadge></li>)}</ul></section>
}

export function TeacherActivityDetail({ statusLabel, statusTone, description, activityId, courseTitle, assigned,
  versionLabel, fixed, snapshot, previewAssignments, showPreviewSummaryNote, onClose }: TeacherActivityDetailProps) {
  return <div className="t-activity-detail">
    <TeacherBadge tone={statusTone}>{statusLabel}</TeacherBadge>
    <p>{description}</p>
    <dl><dt>活动标识</dt><dd>{activityId}</dd><dt>课程</dt><dd>{courseTitle}</dd><dt>已分配</dt><dd>{assigned} 位学生</dd><dt>版本</dt><dd>{versionLabel}</dd></dl>
    {fixed && <TeacherFixedActivity fixed={fixed} />}
    {snapshot && <TeacherPreviewActivity snapshot={snapshot} />}
    {previewAssignments && <TeacherPreviewAssignments assignments={previewAssignments} />}
    {showPreviewSummaryNote && <p className="t-detail-note">这是预置活动摘要。完整版本回看可通过设计草稿的“预览与分配”创建。</p>}
    <div className="t-dialog-footer"><TeacherButton primary onClick={onClose}>完成</TeacherButton></div>
  </div>
}
