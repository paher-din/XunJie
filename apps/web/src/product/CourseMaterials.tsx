import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import type { CourseActivityBinding, CourseMaterial } from '@xunjie/contracts/courses'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { questionReferenceSourceId, type QuestionReferenceSource } from '@xunjie/contracts/question-drafts'
import { Button } from '@xunjie/ui/foundation'
import { WorkspaceResourceLibrary } from '@xunjie/ui/workspace'
import { cacheableMaterial, materialCache } from '../component-preparation/materials'
import { locateTextRange, TextReferenceSource, useWorkspaceReferences, type LocateResult } from '../components/workspace/references'
import { workspaceScope } from './learningTransport'
import { materialLinks } from './material-links'
import './course-material-reader.css'

const CourseMarkdown = lazy(() => import('./CourseMarkdown').catch(() => ({
  default: ({ text }: { text: string }) => <>
    <p className="detail" role="status">排版预览暂不可用，刷新后可重试。以下为材料原文。</p>
    <pre className="course-reader-plain">{text}</pre>
  </>,
})))
type CourseSource = Extract<QuestionReferenceSource, { kind: 'course-material' }>
type Mode = 'preview' | 'source'
export type CourseMaterialRange = { start: number; end: number; copy?: string }
type Reading = {
  scope: string
  material: CourseMaterial
  source: CourseSource
  mode: Mode
} & ({ state: 'loading' } | { state: 'ready'; text: string } | { state: 'error'; reason: string })

export function isCoursePdf(mediaType: string) {
  return mediaType.split(';', 1)[0].trim().toLowerCase() === 'application/pdf'
}

function sourceOf(course: CourseActivityBinding, material: CourseMaterial): CourseSource {
  return {
    kind: 'course-material', courseId: course.courseId, taskId: course.taskId, releaseId: course.releaseId,
    contentDigest: course.contentDigest, materialId: material.materialId, materialSha256: material.sha256, mediaType: material.mediaType,
  }
}

function sameSource(left: CourseSource, right: CourseSource) {
  return left.courseId === right.courseId && left.taskId === right.taskId && left.releaseId === right.releaseId
    && left.contentDigest === right.contentDigest && left.materialId === right.materialId
    && left.materialSha256 === right.materialSha256 && left.mediaType === right.mediaType
}

export function courseMaterialOffsets(text: string, range: CourseMaterialRange) {
  const { start, end, copy } = range
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) return null
  if (copy === undefined || text.slice(start, end) === copy) return { start, end }
  // Older clients stripped the BOM. Only accept the shifted range if it reproduces the exact saved copy.
  if (text.startsWith('\uFEFF') && end < text.length && text.slice(start + 1, end + 1) === copy)
    return { start: start + 1, end: end + 1 }
  return null
}

export function useCourseMaterials({ activity, spaceKey, namespace, authorized, reveal }: {
  activity: LearningActivity
  spaceKey: string
  namespace: string
  authorized: boolean
  reveal: (isCurrent: () => boolean) => Promise<void>
}) {
  const course = activity.course
  const scope = JSON.stringify([workspaceScope(namespace, activity), spaceKey, course?.releaseId, course?.contentDigest])
  const references = useWorkspaceReferences()
  const [reading, setReading] = useState<Reading | null>(null)
  const currentReading = authorized && reading?.scope === scope ? reading : null
  const scroll = useRef<HTMLDivElement>(null)
  const sequence = useRef(0)
  const access = useRef({ scope, authorized })
  access.current = { scope, authorized }
  useEffect(() => () => { ++sequence.current }, [scope, authorized])

  async function show(materialId: string, mode: Mode, position?: { range?: CourseMaterialRange }): Promise<LocateResult> {
    if (!authorized) return { ok: false, reason: '请重新连接学习空间。引用副本仍保留。' }
    const material = course?.materials.find(item => item.materialId === materialId && cacheableMaterial(item.mediaType))
    if (!course || !material) return { ok: false, reason: '这份材料当前无法读取。引用副本仍保留。' }
    const request = ++sequence.current
    const isCurrent = () => request === sequence.current && access.current.scope === scope && access.current.authorized
    const interrupted = { ok: false, reason: '已切换阅读位置。引用副本仍保留。' } as const
    const source = sourceOf(course, material)
    try { await reveal(isCurrent) }
    catch { return { ok: false, reason: '当前输入尚未保护，请保留页面后继续。' } }
    if (!isCurrent()) return interrupted
    if (scroll.current) scroll.current.scrollTop = 0

    const entry = { scope, material, source, mode }
    let text: string
    if (currentReading?.state === 'ready' && sameSource(currentReading.source, source)) text = currentReading.text
    else {
      setReading({ ...entry, state: 'loading' })
      try { text = await materialCache.text(activity, course, spaceKey, namespace, material) }
      catch {
        if (!isCurrent()) return interrupted
        const reason = '暂时无法读取课程材料。请重试或检查学校连接。'
        setReading({ ...entry, state: 'error', reason })
        return { ok: false, reason }
      }
    }
    if (!isCurrent()) return interrupted
    setReading({ ...entry, state: 'ready', text })
    if (!position) return { ok: true }

    const range = position.range && courseMaterialOffsets(text, position.range)
    if (range === null) return { ok: false, reason: '原选段与材料内容不一致。引用副本仍保留。' }
    const sourceId = questionReferenceSourceId(source)
    for (let attempt = 0; attempt < 120 && isCurrent(); attempt++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      if (!isCurrent()) return interrupted
      const container = scroll.current
      const original = container?.querySelector<HTMLElement>('[data-course-material-original]')
      if (original?.dataset.courseMaterialOriginal !== sourceId) continue
      const target = original.querySelector<HTMLElement>('.wr-text-source')
      if (!target || target.textContent !== text) continue
      if (range && !locateTextRange(target, range.start, range.end, container ?? undefined))
        return { ok: false, reason: '原选段当前无法定位。引用副本仍保留。' }
      if (!range) target.focus()
      return { ok: true }
    }
    return isCurrent() ? { ok: false, reason: '已读取原文，当前无法打开原选段。' } : interrupted
  }

  function locate(source: CourseSource, range?: CourseMaterialRange): Promise<LocateResult> {
    const item = course?.materials.find(material => material.materialId === source.materialId)
    if (!course || !item || !sameSource(sourceOf(course, item), source))
      return Promise.resolve({ ok: false, reason: '课程材料版本不一致。引用副本仍保留。' })
    return show(item.materialId, 'source', { range })
  }

  const latest = useRef(locate)
  latest.current = locate
  // The source can be located before any reader is open, including after a reload.
  const sourceIds = JSON.stringify([...new Set([
    ...(course ? course.materials.filter(item => cacheableMaterial(item.mediaType)).map(item => questionReferenceSourceId(sourceOf(course, item))) : []),
    ...references.references.filter(reference => reference.source?.kind === 'course-material').map(reference => reference.sourceId),
  ])].sort())
  useEffect(() => {
    const unregister = (JSON.parse(sourceIds) as string[]).map(sourceId => references.register({
      sourceId,
      locate: reference => reference.source?.kind === 'course-material' && reference.kind === 'text'
        ? latest.current(reference.source, { ...reference.range, copy: reference.text })
        : { ok: false, reason: '原引用位置不可用。引用副本仍保留。' },
    }))
    return () => unregister.forEach(stop => stop())
  }, [sourceIds, references.register])

  return {
    reading: currentReading, scroll,
    open: (materialId: string) => show(materialId, 'preview'),
    close: () => { ++sequence.current; setReading(null) },
    retry: () => currentReading && show(currentReading.material.materialId, currentReading.mode),
    locate,
    locateResult: (materialId: string, range?: CourseMaterialRange) => show(materialId, 'source', { range }),
    setMode: (mode: Mode) => {
      if (currentReading?.state !== 'ready' || currentReading.mode === mode) return
      ++sequence.current
      setReading(previous => previous?.state === 'ready' && previous.scope === scope ? { ...previous, mode } : previous)
      if (scroll.current) scroll.current.scrollTop = 0
    },
  }
}

export function CourseMaterialReader({ reader, library, title, description }: {
  reader: ReturnType<typeof useCourseMaterials>; library: ReactNode; title: string; description: string
}) {
  const { reading } = reader
  if (!reading) return <WorkspaceResourceLibrary title={title} description={description}>{library}</WorkspaceResourceLibrary>
  const markdown = /\.(md|markdown)$/i.test(reading.material.title)
    || reading.material.mediaType.split(';', 1)[0].trim().toLowerCase() === 'text/markdown'
  const links = reading.state === 'ready' && reading.mode === 'source' ? materialLinks(reading.text) : []
  return <section className="course-reader" aria-label="课程材料阅读">
    <header className="course-reader-header">
      <h2>{reading.material.title}</h2>
      <div className="course-reader-actions">
        <Button type="button" variant="outline" onClick={reader.close}>返回材料列表</Button>
        {reading.state === 'ready' && <div className="course-reader-modes" role="group" aria-label="材料视图">
          <Button type="button" variant="outline" aria-pressed={reading.mode === 'preview'} onClick={() => reader.setMode('preview')}>预览</Button>
          <Button type="button" variant="outline" aria-pressed={reading.mode === 'source'} onClick={() => reader.setMode('source')}>原文与引用</Button>
        </div>}
      </div>
    </header>
    <div className="course-reader-scroll" ref={reader.scroll}>
      {reading.state === 'loading' ? <p className="detail" role="status">正在读取材料…</p>
        : reading.state === 'error' ? <div className="course-reader-error">
          <p role="alert">{reading.reason}</p>
          <Button type="button" variant="outline" onClick={() => void reader.retry()}>重新读取</Button>
        </div>
        : reading.mode === 'source' ? <article className="course-reader-original" data-course-material-original={questionReferenceSourceId(reading.source)}>
          <p className="detail">选中一段原文，即可引用到 Agent 提问。</p>
          {links.length > 0 && <details className="course-reader-links">
            <summary>打开补学资料来源</summary>
            <ul>{links.map(link => <li key={link.href}><a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a></li>)}</ul>
          </details>}
          <TextReferenceSource sourceId={questionReferenceSourceId(reading.source)} sourceName={reading.material.title}
            text={reading.text} source={reading.source} registerSource={false} />
        </article>
        : !reading.text.trim() ? <p className="detail">这份材料没有正文。</p>
        : markdown ? <Suspense fallback={<p className="detail" role="status">正在排版…</p>}>
          <CourseMarkdown text={reading.text} />
        </Suspense> : <pre className="course-reader-plain">{reading.text}</pre>}
    </div>
  </section>
}
