import { useEffect, useMemo, useState } from 'react'
import { useToastFeedback } from '@xunjie/ui/feedback'
import type { TeachingArtifactPreview } from '@xunjie/contracts/teaching-agent'
import { ArtifactView } from './ArtifactView'
import { staticPreviewDocument } from './partial-html'
import type { ArtifactEntry, TeachingArtifactsController } from './useTeachingArtifacts'
import { frameTheme } from './frame'
import './teaching-artifacts.css'

export function ArtifactPreview({ preview }: { preview: Pick<TeachingArtifactPreview, 'html'> & Partial<Pick<TeachingArtifactPreview, 'commandId' | 'attemptId'>> }) {
  const [theme, setTheme] = useState(frameTheme)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(frameTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  const source = useMemo(() => staticPreviewDocument(preview.html, { canvas: theme.canvas, ink: theme.ink, line: theme.line, muted: theme.muted }), [preview.html, theme])
  return <article className="teaching-artifact-card teaching-artifact-preview" data-command-id={preview.commandId} data-attempt-id={preview.attemptId}>
    <iframe title="正在形成的学习页面" sandbox="" srcDoc={source} tabIndex={-1} aria-label="正在形成的学习页面，只读预览" />
  </article>
}
export function ArtifactCard({ entry, controller, onOpen, center = false, onClose }: {
  entry: ArtifactEntry; controller: TeachingArtifactsController; onOpen?: () => Promise<void>; center?: boolean; onClose?: () => Promise<void>
}) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useToastFeedback(error)
  const act = async (operation: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await operation(); setError('') } catch { setError('操作尚未确认，当前输入仍保留；请按原操作继续核对。') }
    finally { setBusy(false) }
  }
  const active = entry.revision, opened = controller.opened === entry.artifact.artifactId || controller.centerIds.includes(entry.artifact.artifactId)
  return <article className={center ? 'teaching-artifact-center' : 'teaching-artifact-card'} data-artifact-id={entry.artifact.artifactId}
    data-revision-id={active?.revisionId}>
    <header><h4>{entry.artifact.title}</h4><div className="teaching-artifact-actions">
      {!controller.readOnly && <button type="button" className="ws-btn ghost" disabled={busy || !active || controller.activity.status !== 'open'} onClick={() => void act(() => controller.shelf(entry))}>
        {entry.artifact.shelved ? '取消收纳' : '收纳'}</button>}
      {!center && onOpen && <button type="button" className="ws-btn ghost" disabled={busy || !active} onClick={() => void act(onOpen)}>在工具区打开</button>}
      {center && onClose && <button type="button" className="ws-btn ghost" disabled={busy} onClick={() => void act(onClose)}>关闭页面</button>}
    </div></header>
    {entry.issue && <div role="status" className="teaching-artifact-note">{entry.issue}
      {!controller.readOnly && <button type="button" className="ws-btn ghost" disabled={busy || controller.activity.status !== 'open'} onClick={() => void act(() => controller.retry(entry))}>重试页面</button>}
    </div>}
    {active ? center || !opened
      ? <ArtifactView key={active.revisionId} revision={active} controller={controller} />
      : <p className="teaching-artifact-note">已在工具区打开</p>
      : <p className="teaching-artifact-note">页面完成后会在这里打开。</p>}
  </article>
}
