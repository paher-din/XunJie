import { useState } from 'react'
import { sessionSkillSelectSchema } from '@xunjie/contracts/agent-skills'
import type { DraftSkillsController } from '../components/workspace/references/WorkspaceReferences'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { useSkillCatalog, draftSkillOption } from './skills'

export const sessionDraftSkillsKey = (identity: SpaceIdentity, spaceKey: string, namespace: string, sessionId?: string, teacherCourseId?: string) =>
  'xj.session-draft-skills.' + JSON.stringify([namespace, spaceKey, identity.environmentId, identity.spaceId, identity.principalId, sessionId ?? 'new', ...(teacherCourseId ? [teacherCourseId] : [])])

export const sessionSkillResetKey = (clientScope: string, sessionId: string) =>
  'xj.session-skill-reset.' + clientScope + ':' + sessionId

/** Hide a consumed one-shot selection immediately, while the server keeps it until this Turn ends. */
export function consumeSessionSkillSelection(input: {
  identity: SpaceIdentity; spaceKey: string; namespace: string; currentSessionId?: string; nextSessionId: string
  clientScope: string; turnId: string
}) {
  const next = sessionDraftSkillsKey(input.identity, input.spaceKey, input.namespace, input.nextSessionId)
  localStorage.setItem(next, '[]')
  if (input.currentSessionId === undefined) localStorage.removeItem(sessionDraftSkillsKey(input.identity, input.spaceKey, input.namespace))
  localStorage.setItem(sessionSkillResetKey(input.clientScope, input.nextSessionId),
    JSON.stringify({ requestId: crypto.randomUUID(), turnId: input.turnId }))
}

export function useSessionDraftSkills(identity: SpaceIdentity, spaceKey: string, namespace: string, sessionId?: string, teacherCourseId?: string): DraftSkillsController {
  const catalog = useSkillCatalog(identity, spaceKey, namespace, sessionId, true, undefined, teacherCourseId)
  const key = sessionDraftSkillsKey(identity, spaceKey, namespace, sessionId, teacherCourseId)
  const [saved, setSaved] = useState<{ key: string; skills: DraftSkillsController['selected'] } | null>(null)
  const [hiddenFor, setHiddenFor] = useState<string | null>(null)
  const [error, setError] = useState('')
  let pinned: DraftSkillsController['selected'] | undefined
  try {
    const raw = saved?.key === key ? JSON.stringify(saved.skills) : localStorage.getItem(key)
    if (raw) pinned = sessionSkillSelectSchema.shape.skills.parse(JSON.parse(raw))
  } catch { /* A malformed local selection is never sent as a capability grant. */ }
  // Server selection protects the active Turn after a send. Composer defaults contain only fixed
  // course requirements; personal Skills appear solely when this conversation's draft explicitly chose them.
  const defaults = (catalog.data?.skills ?? []).filter(item => item.selected && item.required
    && item.origin === 'course' && !item.disabled).map(({ skillId, version }) => ({ skillId, version }))
  const selected = pinned ?? defaults
  return { selected: hiddenFor === key ? [] : selected, defaults, explicit: true,
    options: (catalog.data?.skills ?? []).map(draftSkillOption), loading: catalog.loading, error: error || catalog.error,
    reload: () => { void catalog.reload() }, choose: skills => {
      try { const value = skills ?? defaults; localStorage.setItem(key, JSON.stringify(value)); setSaved({ key, skills: value }); setHiddenFor(null); setError('') }
      catch { setError('技能选择尚未保存，请重试。') }
    },
    consumeVisible: () => setHiddenFor(key), restoreVisible: () => setHiddenFor(current => current === key ? null : current) }
}
