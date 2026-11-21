import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { questionDraftViewSchema, questionReferenceSourceId } from '@xunjie/contracts/question-drafts'
import type { QuestionDraftSync } from '@xunjie/contracts/question-drafts'
import type { CourseActivityBinding } from '@xunjie/contracts/courses'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { DraftReferencesProvider, TextReferenceSource } from '../components/workspace/references'
import { ReliableQuestionDraft } from '../reliable-workspace/draft'
import { learningRequest, workspaceScope } from './learningTransport'
import { workViewSchema } from '@xunjie/contracts/learning-data'
import { ReliableWorkspace } from '../reliable-workspace'
import { ActivitySessionContext } from './ActivitySession'
import { ComponentInteractions } from '../component-host/interactions'
import { TeachingBrowserExecution } from './TeachingBrowserExecution'
import { runtimeCandidateIsCurrent } from '../tool-execution/runtime-action'
import { ExecutionController } from '../tool-execution/controller'
import { createAlgorithmProvider } from '../tool-execution/provider'
import { createAdapterRegistry } from '../tool-execution/adapters'
import { runtimePreparation } from '../component-preparation/runtime'
import { createExecutionTransport, createSessionTransport } from './executionTransport'
import { NativeSessionController } from '../tool-execution/session-controller'
import { SessionRequests } from '../tool-execution/session-requests'
import { AgentSessionsClient, createSessionActionReceiver } from './agent-sessions'
import { useAgentSession, sessionError } from './useAgentSession'
import { sessionSkillStateSchema } from '@xunjie/contracts/agent-skills'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import { useAgentInteraction } from './AgentInteraction'
import { useSkillCatalog, draftSkillOption } from './skills'
import type { LearningReadCache } from './learning-read-cache'
import { uploadAgentImage } from '../reliable-workspace/agent-images'

export function ActivityReferences({ activity, spaceKey, namespace, authorized, readOnly = false, children, viewActive = true, readCache }: {
  activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean; readOnly?: boolean; children: ReactNode; viewActive?: boolean
  readCache?: LearningReadCache
}) {
  const scope = workspaceScope(namespace, activity)
  const agentClient = useMemo(() => new AgentSessionsClient({ identity: activity.identity, spaceKey, namespace }), [scope, spaceKey])
  const [agentSession, setAgentSession] = useState<AgentSession>()
  const skills = useSkillCatalog(activity.identity, spaceKey, namespace, agentSession?.sessionId, !!agentSession, readCache)
  const [agentSessionError, setAgentSessionError] = useState(''), [attempt, setAttempt] = useState(0)
  const agent = useAgentSession(agentClient, agentSession?.sessionId, authorized && !readOnly, viewActive)
  useEffect(() => {
    let active = true
    setAgentSession(undefined); setAgentSessionError('')
    if (authorized) void (readOnly ? agentClient.list().then(items => items.find(item => item.workspace?.activityId === activity.activityId))
      : agentClient.workspace(activity.activityId, activity.target)).then(value => { if (active) setAgentSession(value) }).catch(cause => { if (active) setAgentSessionError(sessionError(cause)) })
    return () => { active = false }
  }, [agentClient, authorized, readOnly, attempt])
  const inputInteraction = useAgentInteraction(activity.identity, spaceKey, namespace, authorized && !readOnly)
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
  const sessionOwner = useRef(agentSession); sessionOwner.current = agentSession
  const actions = useMemo(() => {
    const retired = async () => { throw Object.assign(new Error('旧版问题交接不能重新派发，原记录保留。'), { code: 'incompatible' }) }
    return workspace.actions(draft, {
      prepare: retired, dispatch: retired, cancel: retired, read: async () => null, list: async () => [],
      capabilities: async () => {
        if (!sessionOwner.current) throw Object.assign(new Error('工作区对话尚未准备。'), { code: 'unavailable' })
        await agentClient.read(sessionOwner.current.sessionId)
        return []
      },
    })
  }, [workspace, draft, agentClient])
  useEffect(() => agentSession && !readOnly ? actions.registerLocal(createSessionActionReceiver(agentClient, agentSession,
    async action => {
      await workspace.flush(); await draft.leave()
      if (action.draft.skills) sessionSkillStateSchema.parse(await agentClient.request(`${agentSession.sessionId}/skills/select`, { requestId: action.requestId, skills: action.draft.skills }))
    })) : undefined, [actions, agentClient, agentSession, readOnly, workspace, draft])
  // Retain the same workspace controllers when progress or activity status changes.
  const execution = useMemo(() => {
    // One page load is one executor generation; an older page cannot adopt a newer run.
    const transport = createExecutionTransport(activity, spaceKey, namespace)
    const receiver = new TeachingBrowserExecution(scope, Date.now(), (route, body) =>
      learningRequest(activity, spaceKey, namespace, 'executions/' + activity.activityId + '/' + route, body),
      transport, () => access.current && !workspace.accessDenied() && !readOnly, activity.activityId,
      action => runtimeCandidateIsCurrent(workspace, activity, action))
    return new ExecutionController(scope, receiver, actions, transport,
      createAdapterRegistry({ provider: receiver.withProvider(createAlgorithmProvider(activity, spaceKey, namespace)), runtimeResources: async action => {
        const binding = activity.course?.components?.find(b => b.key === action.execution.instance.key)
        if (!binding || binding.definition.digest !== action.execution.instance.definitionDigest) throw new Error('forbidden')
        return runtimePreparation.resources({ activity, binding, spaceKey, namespace })
      } }), () => access.current && !workspace.accessDenied(), readOnly)
  }, [scope, actions, spaceKey, namespace, readOnly])
  const sessions = useMemo(() => new NativeSessionController(scope,
    createSessionTransport(activity, spaceKey, namespace),
    () => access.current && !workspace.accessDenied(), new SessionRequests(), readOnly), [scope, spaceKey, namespace, workspace, readOnly])
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
    if (authorized) { draft.resume(); workspace.resume(); actions.resume();void execution.synchronize().catch(()=>{}) }
    else { draft.suspend(); workspace.suspend(); actions.suspend() }
  }, [draft, workspace, actions, execution, authorized])
  return <ActivitySessionContext.Provider value={{ workspace, draft, actions, execution, sessions, interactions, inputInteraction, agent, agentSession, agentSessionError, retryAgentSession: () => setAttempt(value => value + 1), readCache, viewActive }}>
    <DraftReferencesProvider workspaceKey={scope} draft={draft} actions={actions} delivery={inputInteraction.delivery}
      images={authorized && !readOnly ? { activityId: activity.activityId, subject: agentClient.scope,
        upload: source => uploadAgentImage(agentClient.scope, { kind: 'workspace', activityId: activity.activityId }, source,
          body => learningRequest(activity, spaceKey, namespace, 'models/images', body)) } : undefined}
      viewActive={viewActive}
      skillCatalog={{ options: (skills.data?.skills ?? []).map(draftSkillOption),
        defaults: (skills.data?.skills ?? []).filter(skill => skill.selected && skill.origin === 'personal').map(skill => ({ skillId: skill.skillId, version: skill.version })),
        loading: skills.loading, error: skills.error, isCurrent: skills.isCurrent, reload: () => { void skills.reload() } }}
      deliveryReady={inputInteraction.ready} onCreated={inputInteraction.reset}>{children}</DraftReferencesProvider>
  </ActivitySessionContext.Provider>
}

export function CourseRequirementsReference({ course }: { course: CourseActivityBinding }) {
  const source = useMemo(() => ({ kind: 'course-field' as const, courseId: course.courseId, taskId: course.taskId,
    releaseId: course.releaseId, contentDigest: course.contentDigest, field: 'requirements' as const }), [course])
  return <div data-course-requirements tabIndex={-1}><TextReferenceSource sourceId={questionReferenceSourceId(source)} sourceName="任务要求"
    text={course.requirements} source={source} /></div>
}
