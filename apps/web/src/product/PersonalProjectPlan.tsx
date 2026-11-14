import { useCallback, useEffect, useRef, useState } from 'react'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { personalProjectSchema, type PersonalProject } from '@xunjie/contracts/student-learning'
import { learningRequest, workspaceScope } from './learningTransport'
import { sessionError } from './useAgentSession'

async function readPersonalProject(activity: LearningActivity, spaceKey: string, namespace: string) {
  const project = personalProjectSchema.nullable().parse(await learningRequest(activity, spaceKey, namespace, `activities/${activity.activityId}/project`))
  if (project && (project.activityId !== activity.activityId || project.identity.environmentId !== activity.identity.environmentId
    || project.identity.spaceId !== activity.identity.spaceId || project.identity.principalId !== activity.identity.principalId
    || project.target.environmentId !== activity.target.environmentId || project.target.serviceId !== activity.target.serviceId)) throw new Error('项目不属于当前工作区。')
  return project
}
export function usePersonalProjectTitles(activities: LearningActivity[] | null, spaceKey: string | undefined, namespace: string, authorized: boolean) {
  const scope = JSON.stringify([namespace, spaceKey, activities?.filter(item => !item.course && item.identity.kind === 'personal').map(item => [item.activityId, item.identity, item.target])])
  const cache = useRef(new Map<string, string | null>())
  const [state, setState] = useState<{ scope: string; titles: Record<string, string> }>({ scope, titles: {} })
  useEffect(() => {
    let live = true
    if (!authorized || !activities || !spaceKey) return
    const titles: Record<string, string> = {}
    void Promise.all(activities.filter(item => !item.course && item.identity.kind === 'personal').map(async activity => {
      const key = workspaceScope(namespace, activity) + ':' + spaceKey
      try {
        if (!cache.current.has(key)) cache.current.set(key, (await readPersonalProject(activity, spaceKey, namespace))?.content.title ?? null)
        const title = cache.current.get(key); if (title) titles[activity.activityId] = title
      } catch { /* The activity remains available under its confirmed goal while its plan cannot be read. */ }
    })).then(() => { if (live) setState({ scope, titles }) })
    return () => { live = false }
  }, [scope, authorized])
  return state.scope === scope ? state.titles : {}
}

/** A project's initial plan belongs to its actual activity owner. It is not course progress. */
export function usePersonalProject(activity: LearningActivity, spaceKey: string, namespace: string, authorized: boolean) {
  const scope = workspaceScope(namespace, activity) + ':' + spaceKey
  const [state, setState] = useState<{ scope: string; project: PersonalProject | null; error: string }>({ scope, project: null, error: '' })
  const current = useRef(scope); current.current = scope
  const mounted = useRef(false)
  const read = useCallback(async () => {
    if (!authorized || activity.course || activity.identity.kind !== 'personal') return
    try {
      const project = await readPersonalProject(activity, spaceKey, namespace)
      if (mounted.current && current.current === scope) setState({ scope, project, error: '' })
    } catch (cause) { if (mounted.current && current.current === scope) setState({ scope, project: null, error: sessionError(cause) }) }
  }, [scope, authorized, activity.course])
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false } }, [read])
  return { ...(state.scope === scope ? state : { project: null, error: '' }), retry: read }
}
export function PersonalProjectPlan({ project }: { project: PersonalProject }) {
  return <section aria-label="项目任务清单"><h2>{project.content.title}</h2>
    <p className="preserve-lines">{project.content.goal}</p><h3>任务清单</h3>
    <ol>{project.content.stages.map((stage, index) => <li key={index}><h4>{stage.title}</h4><p className="preserve-lines">{stage.goal}</p></li>)}</ol>
  </section>
}
