import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { questionDraftViewSchema, questionReferenceSourceId } from '@xunjie/contracts/question-drafts'
import type { QuestionDraftSync } from '@xunjie/contracts/question-drafts'
import { courseMaterialContentSchema } from '@xunjie/contracts/courses'
import type { CourseActivityBinding } from '@xunjie/contracts/courses'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { DraftReferencesProvider, TextReferenceSource } from '../components/workspace/references'
import { ReliableQuestionDraft } from '../reliable-workspace/draft'
import { learningRequest, workspaceScope } from './learningTransport'
import { workViewSchema } from '@xunjie/contracts/learning-data'
import { actionViewSchema, actionReceiverSchema } from '@xunjie/contracts/action-intents'
import { z } from 'zod'
import { ReliableWorkspace } from '../reliable-workspace'
import { ActivitySessionContext } from './ActivitySession'
import { ComponentInteractions } from '../component-host/interactions'
import { TeachingBrowserExecution } from './TeachingBrowserExecution'
import { ExecutionController } from '../tool-execution/controller'
import { createAlgorithmProvider } from '../tool-execution/provider'
import { createExecutionTransport, createSessionTransport } from './executionTransport'
import { NativeSessionController } from '../tool-execution/session-controller'
import { SessionRequests } from '../tool-execution/session-requests'

const readable = (mediaType: string) => mediaType.startsWith('text/') || mediaType === 'application/json'
const decode = (base64: string) => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
}

export function ActivityReferences({ activity, spaceKey, namespace, authorized, readOnly = false, children }: {
  activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean; readOnly?: boolean; children: ReactNode
}) {
  const scope = workspaceScope(namespace, activity)
  const access = useRef(authorized)
  access.current = authorized
  const interactions = useMemo(() => new ComponentInteractions(), [scope])
  const draft = useMemo(() => {
    const id = activity.activityId
    const transport = {
      read: async () => questionDraftViewSchema.parse(await learningRequest(activity, spaceKey, namespace, `drafts/${id}`)),
      receipt: async (requestId: string) => {
        const value = await learningRequest(activity, spaceKey, namespace, `drafts/${id}/receipts/${requestId}`)
        return value === null ? null : questionDraftViewSchema.parse(value)
      },
      sync: async (input: QuestionDraftSync) => questionDraftViewSchema.parse(
        await learningRequest(activity, spaceKey, namespace, `drafts/${id}`, input)),
    }
    return new ReliableQuestionDraft(scope, transport, readOnly)
  }, [scope, activity.activityId, activity.identity.environmentId, activity.identity.spaceId,
    activity.identity.principalId, spaceKey, namespace, readOnly])
  const workspace = useMemo(() => {
    const path = 'workspaces/' + activity.activityId
    const request = (suffix: string, body?: unknown) => learningRequest(activity, spaceKey, namespace, path + suffix, body)
    return new ReliableWorkspace(scope, {
      read: async () => workViewSchema.parse(await request('')),
      receipt: async id => { const value = await request('/receipts/' + id); return value === null ? null : workViewSchema.parse(value) },
      sync: async body => workViewSchema.parse(await request('', body)),
    }, { activityId: activity.activityId, bindings: activity.course?.components ?? [] }, readOnly)
  }, [scope, spaceKey, namespace, readOnly])
  const actions = useMemo(() => {
    const path = 'intents/' + activity.activityId
    const request = (suffix: string, body?: unknown) => learningRequest(activity, spaceKey, namespace, path + suffix, body)
    return workspace.actions(draft, {
      prepare: async body => actionViewSchema.parse(await request('', body)),
      read: async id => { const value = await request('/' + id); return value === null ? null : actionViewSchema.parse(value) },
      list: async () => z.array(actionViewSchema).parse(await request('')),
      dispatch: async id => actionViewSchema.parse(await request('/' + id + '/dispatch', {})),
      cancel: async id => actionViewSchema.parse(await request('/' + id + '/cancel', {})),
      capabilities: async () => z.array(actionReceiverSchema).parse(await request('/capabilities')),
    })
  }, [workspace, draft, scope, spaceKey, namespace])
  const execution = useMemo(() => {
    // One page load is one executor generation; an older page cannot adopt a newer run.
    const transport = createExecutionTransport(activity, spaceKey, namespace)
    const receiver = new TeachingBrowserExecution(scope, Date.now(), (route, body) =>
      learningRequest(activity, spaceKey, namespace, 'executions/' + activity.activityId + '/' + route, body),
      transport, () => access.current && !workspace.accessDenied() && !readOnly, activity.activityId)
    return new ExecutionController(scope, receiver, actions,
      transport, receiver.withProvider(createAlgorithmProvider(activity, spaceKey, namespace)), undefined, () => access.current && !workspace.accessDenied(), readOnly)
  }, [scope, actions, activity, spaceKey, namespace, readOnly])
  const sessions = useMemo(() => new NativeSessionController(scope,
    createSessionTransport(activity, spaceKey, namespace),
    () => access.current && !workspace.accessDenied(), new SessionRequests(), readOnly), [scope, activity, spaceKey, namespace, workspace, readOnly])
  useEffect(() => {
    let active = true
    let stopAgentTasks = () => {}
    const unregister = readOnly ? () => {} : actions.registerLocalExecution(execution.receiver)
    void Promise.allSettled([draft.open(), workspace.open()]).then(() => { if (active) return actions.open() })
      .then(async () => {
        if (!active) return
        await Promise.all([execution.open(), sessions.open()])
        if (active && !readOnly && execution.receiver instanceof TeachingBrowserExecution)
          stopAgentTasks = execution.receiver.connect(execution)
      })
      .catch(() => { /* Each partition reports initialization failure and retains its own contents. */ })
    return () => { active = false; stopAgentTasks(); unregister(); sessions.dispose(); execution.dispose(); actions.dispose(); workspace.dispose(); draft.dispose() }
  }, [draft, workspace, actions, execution, sessions, readOnly])
  useEffect(() => {
    if (authorized) { draft.resume(); workspace.resume(); actions.resume() }
    else { draft.suspend(); workspace.suspend(); actions.suspend() }
  }, [draft, workspace, actions, authorized])
  return <ActivitySessionContext.Provider value={{ workspace, draft, actions, execution, sessions, interactions }}>
    <DraftReferencesProvider workspaceKey={scope} draft={draft} actions={actions}>{children}</DraftReferencesProvider>
  </ActivitySessionContext.Provider>
}

export function CourseRequirementsReference({ course }: { course: CourseActivityBinding }) {
  const source = useMemo(() => ({ kind: 'course-field' as const, courseId: course.courseId, taskId: course.taskId,
    releaseId: course.releaseId, contentDigest: course.contentDigest, field: 'requirements' as const }), [course])
  return <div data-course-requirements tabIndex={-1}><TextReferenceSource sourceId={questionReferenceSourceId(source)} sourceName="任务要求"
    text={course.requirements} source={source} /></div>
}

export function CourseMaterialReferences({ activity, course, spaceKey, namespace }: {
  activity: LearningActivity; course: CourseActivityBinding; spaceKey: string; namespace: string
}) {
  const materialKey = useMemo(() => JSON.stringify([course.releaseId, course.materials.map(item => item.materialId)]), [course])
  const [contents, setContents] = useState<Record<string, { text?: string; error?: string }>>({})
  useEffect(() => {
    let cancelled = false
    const readableMaterials = course.materials.filter(item => readable(item.mediaType))
    setContents(Object.fromEntries(readableMaterials.map(item => [item.materialId, {}])))
    void Promise.all(readableMaterials.map(async item => {
      try {
        const value = courseMaterialContentSchema.parse(await learningRequest(activity, spaceKey, namespace,
          `releases/${course.releaseId}/materials/${item.materialId}`))
        return [item.materialId, { text: decode(value.contentBase64) }] as const
      } catch { return [item.materialId, { error: '材料内容暂时无法读取；已保存的引用副本不受影响。' }] as const }
    })).then(entries => { if (!cancelled) setContents(Object.fromEntries(entries)) })
    return () => { cancelled = true }
  }, [activity, course, spaceKey, namespace, materialKey])
  const materials = course.materials.filter(item => readable(item.mediaType))
  if (!materials.length) return null
  return <section aria-labelledby="readable-materials-title">
    <h3 id="readable-materials-title">可引用课程内容</h3>
    <p className="detail">选择下面的文字或编辑区代码，可带着固定引用向 Agent 提问。</p>
    {materials.map(item => {
      const source = { kind: 'course-material' as const, courseId: course.courseId, taskId: course.taskId,
        releaseId: course.releaseId, contentDigest: course.contentDigest, materialId: item.materialId,
        materialSha256: item.sha256, mediaType: item.mediaType }
      const content = contents[item.materialId]
      return <article className="learning-material-text" key={item.materialId} data-material-id={item.materialId} tabIndex={-1}>
        <h4>{item.title}</h4>
        {content?.text !== undefined ? <TextReferenceSource sourceId={questionReferenceSourceId(source)}
          sourceName={item.title} text={content.text} source={source} />
          : content?.error ? <p className="detail" role="status">{content.error}</p> : <p className="detail" role="status">正在读取材料…</p>}
      </article>
    })}
  </section>
}
