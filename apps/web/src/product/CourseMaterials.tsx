import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import type { CourseActivityBinding, CourseMaterial } from '@xunjie/contracts/courses'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { questionReferenceSourceId, type QuestionReferenceSource } from '@xunjie/contracts/question-drafts'
import { Button } from '@xunjie/ui/foundation'
import { WorkspaceResourceLibrary } from '@xunjie/ui/workspace'
import { cacheableMaterial, materialCache } from '../component-preparation/materials'
import { locateDomRange, locateTextRange, useTextReferenceSource, useWorkspaceReferences, type LocateResult } from '../components/workspace/references'
import { renderedMarkdownRange, selectedMarkdownOffsets } from './courseMarkdownSelection'
import { workspaceScope } from './learningTransport'
import { materialLinks } from './material-links'
import './course-material-reader.css'

const CourseMarkdown = lazy(() => import('./CourseMarkdown').catch(() => ({
  default: ({ text }: { text: string }) => <pre className="course-reader-plain">{text}</pre>,
})))
type CourseSource = Extract<QuestionReferenceSource, { kind: 'course-material' }>
export type CourseMaterialRange = { start: number; end: number; copy?: string }
type Reading = {
  scope: string
  material: CourseMaterial
  source: CourseSource
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

  async function show(materialId: string, position?: { range?: CourseMaterialRange }): Promise<LocateResult> {
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

    const entry = { scope, material, source }
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
      const target = container?.querySelector<HTMLElement>('[data-course-material-body]')
      if (!target || target.dataset.courseMaterialBody !== sourceId) continue
      if (!range) { target.focus(); return { ok: true } }
      if (target.textContent === text && locateTextRange(target, range.start, range.end, container ?? undefined)) return { ok: true }
      if (!target.querySelector('.course-reader-markdown')) continue
      const rendered = renderedMarkdownRange(target, text, range.start, range.end)
      return rendered && locateDomRange(target, rendered, container ?? undefined)
        ? { ok: true } : { ok: false, reason: '原选段当前无法在预览中定位。引用副本仍保留。' }
    }
    return isCurrent() ? { ok: false, reason: '已读取原文，当前无法打开原选段。' } : interrupted
  }

  function locate(source: CourseSource, range?: CourseMaterialRange): Promise<LocateResult> {
    const item = course?.materials.find(material => material.materialId === source.materialId)
    if (!course || !item || !sameSource(sourceOf(course, item), source))
      return Promise.resolve({ ok: false, reason: '课程材料版本不一致。引用副本仍保留。' })
    return show(item.materialId, { range })
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
    open: (materialId: string) => show(materialId),
    close: () => { ++sequence.current; setReading(null) },
    retry: () => currentReading && show(currentReading.material.materialId),
    locate,
    locateResult: (materialId: string, range?: CourseMaterialRange) => show(materialId, { range }),
  }
}

function CourseMaterialBody({ reading }: { reading: Extract<Reading, { state: 'ready' }> }) {
  const markdown = /\.(md|markdown)$/i.test(reading.material.title)
    || reading.material.mediaType.split(';', 1)[0].trim().toLowerCase() === 'text/markdown'
  const links = markdown ? [] : materialLinks(reading.text)
  const sourceId = questionReferenceSourceId(reading.source)
  const body = useRef<HTMLDivElement>(null)
  useTextReferenceSource(body, sourceId, reading.material.title, reading.text, reading.source, {
    registerSource: false, renderedOffsets: markdown ? selectedMarkdownOffsets : undefined,
  })
  return <>
    {links.length > 0 && <details className="course-reader-links">
      <summary>打开补学资料来源</summary>
      <ul>{links.map(link => <li key={link.href}><a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a></li>)}</ul>
    </details>}
    <div className="course-reader-body" role="document" tabIndex={0} aria-label={reading.material.title}
      data-course-material-body={sourceId} ref={body}>
      {!reading.text.trim() ? <p className="detail">这份材料没有正文。</p>
        : markdown ? <Suspense fallback={<p className="detail" role="status">正在排版…</p>}>
          <CourseMarkdown text={reading.text} />
        </Suspense> : <pre className="course-reader-plain">{reading.text}</pre>}
    </div>
  </>
}

export function CourseMaterialReader({ reader, library, title, description }: {
  reader: ReturnType<typeof useCourseMaterials>; library: ReactNode; title: string; description: string
}) {
  const { reading } = reader
  if (!reading) return <WorkspaceResourceLibrary title={title} description={description}>{library}</WorkspaceResourceLibrary>
  return <section className="course-reader" aria-label="课程材料阅读">
    <header className="course-reader-header">
      <h2>{reading.material.title}</h2>
      <Button type="button" variant="outline" onClick={reader.close}>返回材料列表</Button>
    </header>
    <div className="course-reader-scroll" ref={reader.scroll}>
      {reading.state === 'loading' ? <p className="detail" role="status">正在读取材料…</p>
        : reading.state === 'error' ? <div className="course-reader-error">
          <p role="alert">{reading.reason}</p>
          <Button type="button" variant="outline" onClick={() => void reader.retry()}>重新读取</Button>
        </div>
        : <CourseMaterialBody reading={reading} />}
    </div>
  </section>
}
