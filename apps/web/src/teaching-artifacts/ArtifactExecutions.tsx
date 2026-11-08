import { useSyncExternalStore } from 'react'
import { componentStateName } from '@xunjie/contracts/components'
import type { TeachingArtifactRevision } from '@xunjie/contracts/teaching-artifacts'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { ExecutionPanel } from '../product/ExecutionPanel'
import { useActivitySession } from '../product/ActivitySession'

/** Actual results are rendered by the existing trusted presenter, outside the generated document. */
export function ArtifactExecutions({ revision, activity, authorized }: {
  revision: TeachingArtifactRevision; activity: LearningActivity; authorized: boolean
}) {
  const { execution } = useActivitySession()
  const state = useSyncExternalStore(execution.subscribe, execution.snapshot)
  if (!authorized) return null
  const groups = new Map<string, { version: number; requests: Set<string> }>()
  for (const record of state.records) {
    if (record.action.scope.activityId !== activity.activityId) continue
    const file = record.action.execution.basis.works.find(file => file.name === componentStateName(revision.binding.key))
    if (!file) continue
    try {
      const saved = JSON.parse(file.value) as { instanceId?: string; version?: number }
      if (saved.instanceId !== `${activity.activityId}:${revision.binding.key}`
        || !Number.isInteger(saved.version)) continue
      const key = record.action.execution.instance.key, id = `${key}:${saved.version}`
      const group = groups.get(id) ?? { version: saved.version!, requests: new Set<string>() }
      group.requests.add(record.requestId); groups.set(id, group)
    } catch { /* An unreadable retained source never becomes a verified result badge. */ }
  }
  return <>{[...groups].map(([id, group]) => {
    const key = id.slice(0, id.lastIndexOf(':')), binding = activity.course?.components?.find(binding => binding.key === key)
    return binding && <div key={id} className="teaching-artifact-results">
      <p className="execution-hint">实际工具结果 · 原页面版本 {group.version}</p>
      <ExecutionPanel activity={activity} binding={binding} authorized={authorized} requestIds={group.requests} />
    </div>
  })}</>
}
