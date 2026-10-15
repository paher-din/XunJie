import { apiGet, apiPatchFrozen, apiPostFrozen, WorkspaceRequestError } from '../workspace/http'
import type { SessionView } from '../workspace/contracts'
import type { TeacherData, DesignDraft, TeacherResource } from './types'
import type { BlueprintContent, BlueprintDraft, BlueprintPreview, DesignResult, TeacherWorkbench, ReviewContext } from './wire'

const options = { mode: 'real' as const, timeoutMs: 20_000 }
export const teacherGet = <T,>(path: string) => apiGet<T>(path, options)
const encoded = encodeURIComponent
export interface TeacherReceipt<T> { result: T; commandId: string; receiptId: string
  identity: { actorId: string; idempotencyKey: string; recoveryGeneration: string } }
interface Pending { account: string; method: 'POST' | 'PATCH'; path: string; wire: string; key: string }
const prefix = 'xunjie.teacher.command.v1:'
const volatile = new Map<string, Pending>()
const pendingListeners = new Set<() => void>()
export function onTeacherCommandsChanged(listener: () => void) { pendingListeners.add(listener); return () => { pendingListeners.delete(listener) } }
function changed() { for (const listener of pendingListeners) listener() }

function storageKey(account: string, path: string) { return `${prefix}${encoded(account)}:${encoded(path)}` }
function readPending(key: string): Pending | undefined {
  if (volatile.has(key)) return volatile.get(key)
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return undefined
    const value = JSON.parse(raw) as Pending
    if (typeof value.account !== 'string' || !['POST', 'PATCH'].includes(value.method) || !value.path.startsWith('/') ||
      typeof value.wire !== 'string' || typeof value.key !== 'string') throw new Error('Invalid pending command')
    return value
  } catch { throw new Error('原教师命令无法核对，请保留页面并检查当前会话。') }
}
function keep(key: string, value: Pending) {
  volatile.set(key, value)
  try { sessionStorage.setItem(key, JSON.stringify(value)) }
  catch { throw new Error('无法保留原请求，操作尚未发送；请检查浏览器存储后重试。') }
  changed()
}
function forget(key: string) { volatile.delete(key); try { sessionStorage.removeItem(key) } catch { /* Confirmed result remains safe. */ } changed() }
async function send<T>(pending: Pending): Promise<TeacherReceipt<T>> {
  const response = await (pending.method === 'POST' ? apiPostFrozen : apiPatchFrozen)<TeacherReceipt<T>>(pending.path, pending.wire,
    { ...options, idempotencyKey: pending.key })
  const expected = JSON.parse(pending.wire) as { recoveryGeneration?: unknown }
  if (!response || typeof response.commandId !== 'string' || !response.commandId || typeof response.receiptId !== 'string' || !response.receiptId ||
    response.identity?.actorId !== pending.account || response.identity?.idempotencyKey !== pending.key ||
    typeof expected.recoveryGeneration !== 'string' || response.identity?.recoveryGeneration !== expected.recoveryGeneration || !('result' in response)) {
    throw new Error('教师命令回执不完整；原请求已保留，请核对原操作。')
  }
  return response
}
export async function teacherCommand<T>(account: string, method: 'POST' | 'PATCH', path: string, body: unknown): Promise<T> {
  const key = storageKey(account, path), wire = JSON.stringify(body)
  const previous = readPending(key)
  if (previous && (previous.account !== account || previous.path !== path || previous.method !== method || previous.wire !== wire)) {
    throw new Error('这个对象有尚未核对的原操作。请先点击“核对原教师操作”，再继续编辑或发送。')
  }
  const pending = previous ?? { account, method, path, wire, key: crypto.randomUUID() }
  keep(key, pending)
  try { const result = await send<T>(pending); forget(key); return result.result }
  catch (cause) {
    if (cause instanceof WorkspaceRequestError && cause.failure.kind === 'api' && cause.failure.status >= 400 && cause.failure.status < 500) forget(key)
    throw cause
  }
}
export function pendingTeacherCommands(account: string): Pending[] {
  const keys = new Set([...volatile.keys()])
  try { for (let i = 0; i < sessionStorage.length; i++) { const key = sessionStorage.key(i); if (key?.startsWith(`${prefix}${encoded(account)}:`)) keys.add(key) } } catch { /* In-memory copy remains available. */ }
  return [...keys].filter(key => key.startsWith(`${prefix}${encoded(account)}:`)).map(readPending).filter((value): value is Pending => !!value && value.account === account)
}
export async function retryTeacherCommands(account: string): Promise<void> {
  for (const pending of pendingTeacherCommands(account)) {
    try { await send(pending); forget(storageKey(account, pending.path)) }
    catch (cause) {
      if (cause instanceof WorkspaceRequestError && cause.failure.kind === 'api' && cause.failure.status >= 400 && cause.failure.status < 500) forget(storageKey(account, pending.path))
      throw cause
    }
  }
}

export function resourceFromWire(resource: TeacherWorkbench['resources'][number]): TeacherResource {
  return { id: resource.resourceVersionId, courseId: resource.courseId, title: resource.material.title,
    content: resource.material.text, kind: resource.material.kind === 'private_answer' ? 'private_answer' : resource.material.kind === 'validation_asset' ? 'validation' : 'learning',
    source: `材料版本 ${resource.resourceVersionId}`, format: resource.material.format, student: resource.material.visibility.student, tutor: resource.material.visibility.tutor,
    teacherDesign: resource.teacherDesignAllowed, version: 1 }
}
export function draftFromWire(draft: BlueprintDraft, workbench: TeacherWorkbench): DesignDraft {
  const c = draft.content
  return { id: draft.blueprintId, courseId: draft.courseId, title: c.projectTitle ?? '', problem: c.problem ?? '', audience: c.audience ?? '',
    deliverable: c.artifact ?? '', choices: c.routes.join('\n'), foundation: c.studentBackground ?? '', duration: c.timeConstraints ?? '',
    goals: c.goals.map(goal => ({ id: goal.competencyId, domain: goal.domain, title: goal.title, evidence: c.observations.filter(o => o.goalRefs.some(ref => ref.competencyId === goal.competencyId)).map(o => o.description).join('\n') })),
    milestones: c.milestones.map(m => ({ id: m.milestoneId, title: m.title, evidence: c.tasks.filter(task => m.taskIds.includes(task.taskId)).map(task => task.title).join('\n') })),
    rubric: c.rubricCriteria.map(r => ({ id: r.criterionId, criterion: r.description, description: r.description })),
    helpPolicy: workbench.presets.find(p => p.content.helpPolicyVersionId === c.helpPolicyVersionId)?.helpPolicy.description ?? '',
    resourceIds: c.resources.map(r => r.resourceVersionId), revision: draft.revision, savedAt: '' }
}
export async function loadTeacherWorkbenchData(session: SessionView): Promise<TeacherData> {
  const courses = session.courses.filter(course => course.role === 'teacher')
  if (!courses.length) throw new Error('当前会话没有任教课程。')
  const workbenches = await Promise.all(courses.map(async course => {
    const value = await teacherGet<TeacherWorkbench>(`/courses/${encoded(course.courseId)}/teacher-workbench`)
    if (!value || value.courseId !== course.courseId || typeof value.recoveryGeneration !== 'string' || !value.recoveryGeneration ||
      !['members', 'resources', 'drafts', 'activities', 'attempts', 'presets', 'assignments'].every(key => Array.isArray(value[key as keyof TeacherWorkbench]))) throw new Error('教师工作台响应不完整或课程不匹配。')
    if (value.drafts.some(draft => draft.courseId !== value.courseId) || value.activities.some(activity => activity.courseId !== value.courseId || activity.content.audience !== 'teacher-validator') ||
      value.resources.some(resource => resource.courseId !== value.courseId) || value.attempts.some(attempt => attempt.courseId !== value.courseId)) throw new Error('教师工作台对象越出当前课程，未接纳响应。')
    return value
  }))
  return { workbenches,
    courses: workbenches.map(w => { const kinds = new Set(w.activities.map(a => a.execution ? 'hdl' : 'c')); return { id: w.courseId, title: w.courseName || w.courseId, code: w.courseId, term: '', kind: kinds.size > 1 ? 'mixed' : kinds.has('hdl') ? 'hdl' : kinds.has('c') ? 'c' : 'unknown' } }),
    activities: workbenches.flatMap(w => w.activities.map(a => ({ id: a.activityVersionId, courseId: w.courseId, title: a.content.content.projectTitle ?? a.activityVersionId,
      description: a.content.content.problem ?? '', status: a.status, version: a.sourceRevision ?? 0,
      assigned: w.assignments.filter(row => row.activityVersionId === a.activityVersionId).length,
      submitted: w.attempts.filter(row => row.activityVersionId === a.activityVersionId && ['submitted', 'reviewed'].includes(row.status)).length,
      reviewed: w.attempts.filter(row => row.activityVersionId === a.activityVersionId && row.status === 'reviewed').length, due: '' }))),
    drafts: workbenches.flatMap(w => w.drafts.map(draft => draftFromWire(draft, w))), resources: workbenches.flatMap(w => w.resources.map(resourceFromWire)),
    learners: workbenches.flatMap(w => w.attempts.map(attempt => ({ id: attempt.attemptId, name: w.members.find(member => member.userId === attempt.studentId)?.displayName || attempt.studentId,
      courseId: w.courseId, activityId: attempt.activityVersionId, activityTitle: w.activities.find(a => a.activityVersionId === attempt.activityVersionId)?.content.content.projectTitle ?? attempt.activityVersionId,
      status: attempt.status, route: '', updated: attempt.latestSubmission?.submittedAt ?? '', submission: attempt.latestSubmission?.submissionId ?? '', version: attempt.attemptRevision,
      evidence: [], claims: [], unknowns: [], feedback: '', decision: '', revisionAllowed: false }))),
  }
}
export const readReviewContext = (attemptId: string, submissionId?: string) => teacherGet<ReviewContext>(`/attempts/${encoded(attemptId)}/review-context${submissionId ? `?submissionId=${encoded(submissionId)}` : ''}`)
export const readBlueprintPreview = (id: string, audience: 'student' | 'tutor' | 'teacher-validator') => teacherGet<BlueprintPreview>(`/blueprints/${encoded(id)}/previews?audience=${audience}`)
export async function saveBlueprint(account: string, generation: string, courseId: string, content: BlueprintContent, draft?: BlueprintDraft): Promise<BlueprintDraft> {
  const result = draft ? await teacherCommand<DesignResult>(account, 'PATCH', `/blueprints/${encoded(draft.blueprintId)}`, { recoveryGeneration: generation, expectedRevision: draft.revision, patch: content })
    : await teacherCommand<DesignResult>(account, 'POST', `/courses/${encoded(courseId)}/blueprints`, { mode: 'manual', recoveryGeneration: generation, content })
  if (result.kind !== 'draft' || result.draft.courseId !== courseId) throw new Error('保存回执未指向当前课程草稿。')
  return result.draft
}
