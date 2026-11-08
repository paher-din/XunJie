import { useState, type ReactNode } from 'react'
import {
  CourseMark, ProjectCard, TeacherBadge, TeacherButton, TeacherDialog, TeacherEmpty,
  type TeacherBadgeProps, type TeacherCourseKind,
} from '@xunjie/ui/teacher'
import '@xunjie/ui/styles/teacher/teacher.css'
import type { CatalogEntry } from '../types'

/** 所有内容和回调仅供目录预览，不连接教学服务。 */
function TeacherStage({ children }: { children: ReactNode }) {
  return <div className="teacher-shell" style={{ display: 'block', width: '100%', height: 'auto', minHeight: '100vh', padding: 24, overflow: 'visible' }}>
    <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 20 }}>示例数据 · 操作仅在当前预览中生效</p>{children}
  </div>
}

function ButtonInteractive() {
  const [count, setCount] = useState(0)
  return <TeacherStage><div className="demo-row"><TeacherButton primary icon="add" onClick={() => setCount(value => value + 1)}>设计示例项目</TeacherButton>
    <TeacherButton onClick={() => setCount(value => value + 1)}>次要操作</TeacherButton>
    <TeacherButton disabled>不可用</TeacherButton></div><output>示例操作：{count} 次</output></TeacherStage>
}
function ButtonSubmit() {
  const [submitted, setSubmitted] = useState(false)
  return <TeacherStage><form onSubmit={event => { event.preventDefault(); setSubmitted(true) }}>
    <TeacherButton type="submit" primary>提交示例表单</TeacherButton></form><output>{submitted && '示例表单已提交到本地状态'}</output></TeacherStage>
}
function BadgeTones() {
  const values: { tone: NonNullable<TeacherBadgeProps['tone']>; label: string }[] = [
    { tone: 'neutral', label: '示例草稿' }, { tone: 'progress', label: '示例进行中' }, { tone: 'done', label: '示例完成' },
    { tone: 'pending', label: '示例待审阅' }, { tone: 'overdue', label: '示例逾期' },
  ]
  return <TeacherStage><div className="demo-row">{values.map(value => <TeacherBadge key={value.tone} tone={value.tone}>{value.label}</TeacherBadge>)}</div></TeacherStage>
}
function CourseMarks() {
  const kinds: TeacherCourseKind[] = ['c', 'hdl', 'mixed', 'unknown']
  return <TeacherStage><div className="demo-row">{kinds.map(kind => <div key={kind} style={{ display: 'grid', gap: 8, justifyItems: 'center' }}><CourseMark kind={kind} /><small>{kind}</small></div>)}</div></TeacherStage>
}
function EmptyDefault() { return <TeacherStage><TeacherEmpty title="暂无示例项目">可先创建一个示例项目。</TeacherEmpty></TeacherStage> }
function EmptyCustomIcon() { return <TeacherStage><TeacherEmpty title="暂无示例提交" icon="clipboard-check">示例列表为空。</TeacherEmpty></TeacherStage> }
function DialogDemo({ initiallyOpen }: { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const [accepted, setAccepted] = useState(false)
  return <TeacherStage><TeacherButton onClick={() => setOpen(true)}>打开示例对话框</TeacherButton><output>{accepted && '已确认示例内容'}</output>
    <TeacherDialog open={open} onOpenChange={setOpen} title="示例活动详情" description="此内容仅用于组件目录，不包含真实课程数据。">
      <p>示例对话框通过 Portal 呈现，关闭后可以重新打开。</p>
      <div className="t-dialog-footer"><TeacherButton primary onClick={() => { setAccepted(true); setOpen(false) }}>确认示例</TeacherButton></div>
    </TeacherDialog>
  </TeacherStage>
}
function DialogOpen() { return <DialogDemo initiallyOpen /> }
function DialogClosed() { return <DialogDemo initiallyOpen={false} /> }
function ProjectDemo({ draft }: { draft: boolean }) {
  const [clicked, setClicked] = useState(false)
  return <TeacherStage><div style={{ maxWidth: 520 }}><ProjectCard courseKind={draft ? 'c' : 'hdl'} courseTitle={draft ? '示例程序设计' : '示例数字逻辑'}
    statusLabel={draft ? '草稿' : '已开放'} statusTone={draft ? 'neutral' : 'progress'} title={draft ? '示例报告项目' : '示例计数器项目'}
    description="这是一段用于预览的项目说明。" versionLabel={draft ? '草稿 revision 2' : '来源 revision 3'} due={draft ? undefined : '示例截止日期'}
    numbers={draft ? undefined : { assigned: 12, submitted: 5, reviewed: '—' }}
    footer={draft ? '示例草稿尚未发布' : '示例活动使用固定版本'} actionLabel={draft ? '继续设计' : '活动详情'} onAction={() => setClicked(true)} /></div>
    <output>{clicked && '已触发示例卡片操作'}</output></TeacherStage>
}
function ProjectActive() { return <ProjectDemo draft={false} /> }
function ProjectDraft() { return <ProjectDemo draft /> }

const teacher = '@xunjie/ui/teacher'
const exampleSource = 'apps/web/src/ui-catalog/examples/teacher.tsx'
const teacherStyles = '@xunjie/ui/styles/teacher/teacher.css'
export const teacherEntries: CatalogEntry[] = [
  { id: 'teacher-button', name: 'TeacherButton', description: '教师端主操作、次操作和提交按钮。', importPath: teacher, source: 'packages/ui/src/teacher/ui.tsx', exampleSource: exampleSource,
    props: ['children, onClick?', 'primary?, disabled?, icon?, type?'], dependencies: [teacherStyles], states: [
      { id: 'variants', name: '主 / 次 / 禁用', component: ButtonInteractive }, { id: 'submit', name: '表单提交', component: ButtonSubmit },
    ] },
  { id: 'teacher-badge', name: 'TeacherBadge', description: '教师端状态徽章。', importPath: teacher, source: 'packages/ui/src/teacher/ui.tsx', exampleSource: exampleSource,
    props: ['children', 'tone?: neutral | progress | done | pending | overdue'], dependencies: [teacherStyles], states: [{ id: 'tones', name: '全部状态', component: BadgeTones }] },
  { id: 'course-mark', name: 'CourseMark', description: '按课程种类显示的课程图标。', importPath: teacher, source: 'packages/ui/src/teacher/ui.tsx', exampleSource: exampleSource,
    props: ['kind: c | hdl | mixed | unknown'], dependencies: [teacherStyles], states: [{ id: 'kinds', name: '课程种类', component: CourseMarks }] },
  { id: 'teacher-empty', name: 'TeacherEmpty', description: '教师端空状态。', importPath: teacher, source: 'packages/ui/src/teacher/ui.tsx', exampleSource: exampleSource,
    props: ['title: string', 'children?, icon?'], dependencies: [teacherStyles], states: [
      { id: 'projects', name: '无项目', component: EmptyDefault }, { id: 'submissions', name: '无提交', component: EmptyCustomIcon },
    ] },
  { id: 'teacher-dialog', name: 'TeacherDialog', description: '带标题、描述和关闭控件的受控对话框。', importPath: teacher, source: 'packages/ui/src/teacher/ui.tsx', exampleSource: exampleSource,
    props: ['open, onOpenChange', 'title, description, children'], dependencies: [teacherStyles, 'Radix Dialog Portal；示例内容只存在于当前预览'], states: [
      { id: 'open', name: '打开', component: DialogOpen, height: 600 }, { id: 'closed', name: '关闭 / 重新打开', component: DialogClosed, height: 600 },
    ] },
  { id: 'project-card', name: 'ProjectCard', description: '教师项目卡与由宿主提供的操作。', importPath: teacher, source: 'packages/ui/src/teacher/ProjectCard.tsx', exampleSource: exampleSource,
    props: ['courseKind, courseTitle?, statusLabel, statusTone', 'title, description, versionLabel, due?', 'numbers?, footer, actionLabel, onAction'], dependencies: [teacherStyles, '展示数量与动作由宿主提供'], states: [
      { id: 'active', name: '开放活动', component: ProjectActive, height: 580 }, { id: 'draft', name: '草稿', component: ProjectDraft, height: 580 },
    ] },
]
