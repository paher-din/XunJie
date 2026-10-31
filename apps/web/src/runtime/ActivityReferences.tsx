import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { questionDraftViewSchema, questionReferenceSourceId } from '@xunjie/contracts/question-drafts'
import type { QuestionDraftSync } from '@xunjie/contracts/question-drafts'
import { courseMaterialContentSchema } from '@xunjie/contracts/courses'
import type { CourseActivityBinding } from '@xunjie/contracts/courses'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { DraftReferencesProvider, TextReferenceSource } from '../components/workspace/references'
import { ReliableQuestionDraft } from '../reliable-workspace/draft'
import { learningRequest, workspaceScope } from './learningTransport'

const readable = (mediaType: string) => mediaType.startsWith('text/') || mediaType === 'application/json'
const decode = (base64: string) => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
}

export function ActivityReferences({ activity, spaceKey, namespace, authorized, children }: {
  activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean; children: ReactNode
}) {
  const scope = workspaceScope(namespace, activity)
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
    return new ReliableQuestionDraft(scope, transport)
  }, [scope, activity.activityId, activity.identity.environmentId, activity.identity.spaceId,
    activity.identity.principalId, spaceKey, namespace])
  useEffect(() => {
    void draft.open().catch(() => { /* Draft state reports failure and retries initialization. */ })
    return () => draft.dispose()
  }, [draft])
  useEffect(() => {
    if (authorized) draft.resume()
    else draft.suspend()
  }, [draft, authorized])
  return <DraftReferencesProvider workspaceKey={scope} draft={draft}>{children}</DraftReferencesProvider>
}

export function CourseRequirementsReference({ course }: { course: CourseActivityBinding }) {
  const source = useMemo(() => ({ kind: 'course-field' as const, courseId: course.courseId, taskId: course.taskId,
    releaseId: course.releaseId, contentDigest: course.contentDigest, field: 'requirements' as const }), [course])
  return <TextReferenceSource sourceId={questionReferenceSourceId(source)} sourceName="任务要求"
    text={course.requirements} source={source} />
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
      return <article className="learning-material-text" key={item.materialId}>
        <h4>{item.title}</h4>
        {content?.text !== undefined ? <TextReferenceSource sourceId={questionReferenceSourceId(source)}
          sourceName={item.title} text={content.text} source={source} />
          : content?.error ? <p className="detail" role="status">{content.error}</p> : <p className="detail" role="status">正在读取材料…</p>}
      </article>
    })}
  </section>
}
