import type { LearningActivity } from '@xunjie/contracts/learning-data'
import type { ComponentBinding } from '@xunjie/contracts/components'
import { useEffect, useRef } from 'react'
import { questionReferenceSourceId, semanticReferenceCopy, normalizeSemanticRange, semanticAdapters, questionReferenceRangeSchema, type QuestionReferenceSource, type QuestionReferenceRange, type QuestionWorkBasis } from '@xunjie/contracts/question-drafts'
import { useWorkspaceReferences } from './WorkspaceReferences'
import type { LocateResult, ReferenceSnapshot, SelectionRect } from './model'
export type ComponentSource = Extract<QuestionReferenceSource, { kind: 'component' }>
export function useSemanticSource(options: { source: ComponentSource | null; title: string; content: unknown; basis?: QuestionWorkBasis;
  locate(reference: ReferenceSnapshot): LocateResult | Promise<LocateResult> }) {
  const references = useWorkspaceReferences(), latest = useRef(options); latest.current = options
  const sourceId = options.source && questionReferenceSourceId(options.source)
  useEffect(() => {
    if (!sourceId) return
    return references.register({ sourceId, locate: reference => {
      const current = latest.current
      if (!current.source || reference.source?.kind !== 'component' || reference.source.contentId !== current.source.contentId)
        return { ok: false, reason: '来源已变化，选中时的副本仍保留。' }
      const range = questionReferenceRangeSchema.safeParse({ ...reference.range, kind: reference.kind })
      try {
        if (!range.success || range.data.kind !== 'semantic') throw new Error('unsupported-version')
        normalizeSemanticRange(range.data)
        if (semanticAdapters[range.data.typeId as keyof typeof semanticAdapters]?.origin !== current.source.origin) throw new Error('unsupported-version')
      } catch { return { ok: false, reason: '该引用类型暂不可操作，选中时的副本仍保留。' } }
      return current.locate(reference)
    } })
  }, [sourceId, references.register])
  return (range: Extract<QuestionReferenceRange, { kind: 'semantic' }>, anchor: () => SelectionRect | null, gesture: object = {}) => {
    const current = latest.current
    if (!current.source || !sourceId) throw new Error('resource-unavailable')
    const copy = semanticReferenceCopy(range, current.content)
    const fixedRange = { ...range, end: copy.length }
    references.select({ snapshot: { workspaceKey: references.workspaceKey, sourceId, sourceName: current.title,
      kind: 'semantic', text: copy, source: current.source, sourceText: copy, range: fixedRange, ...(current.basis ? { basis: current.basis } : {}) }, anchor }, gesture)
    return { selected: true as const }
  }
}

export function componentSource(activity: LearningActivity, binding: ComponentBinding, objectId: string, contentId: string,
  result?: { requestId: string; executionRef: string }): ComponentSource {
  return { kind: 'component', formatVersion: 1, environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
    principalId: activity.identity.principalId, activityId: activity.activityId, instanceId: `${activity.activityId}:${binding.key}`,
    componentId: binding.definition.manifest.componentId, componentVersion: binding.definition.manifest.version,
    definitionDigest: binding.definition.digest, bindingKey: binding.key, objectId, contentId,
    origin: result ? 'execution-result' : 'state', requestId: result?.requestId ?? null, executionRef: result?.executionRef ?? null }
}
