import { useRef, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Markdown } from '../chat/Markdown'
import { Icon } from '../icons'
import './skill-document-dialog.css'

export interface SkillDocumentDialogProps {
  open: boolean
  name: string
  content: string | null
  loading: boolean
  error?: string
  footer?: ReactNode
  onClose(): void
  onRetry(): void
  onReturnFocus?(): void
}

// Only a complete leading block is frontmatter; stored source stays intact.
const FRONTMATTER = /^(?:\uFEFF)?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/

function documentMarkdown(content: string): string {
  const match = FRONTMATTER.exec(content)
  if (!match) return content
  const metadata = match[0].replace(/^\uFEFF/, '').replace(/\r?\n$/, '')
  // Imported YAML may itself contain fences. Keep every backtick run inside the code block.
  let fenceLength = 3
  for (const run of metadata.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, run[0].length + 1)
  const fence = '`'.repeat(fenceLength)
  return `${fence}yaml\n${metadata}\n${fence}\n\n${content.slice(match[0].length)}`
}

/** Read imported Markdown through the shared controlled renderer without executing HTML. */
export function SkillDocumentDialog({ open, name, content, loading, error, footer, onClose, onRetry, onReturnFocus }: SkillDocumentDialogProps) {
  const previousFocus = useRef<HTMLElement | null>(null)
  return <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="overlay pc-overlay" />
      <Dialog.Content className="st-dialog st-skill-document" aria-describedby={undefined}
        onOpenAutoFocus={() => { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }}
        onCloseAutoFocus={event => { event.preventDefault(); if (onReturnFocus) onReturnFocus(); else previousFocus.current?.focus() }}>
        <div className="st-dialog-head">
          <div className="st-skill-document-heading">
            <Dialog.Title className="st-dialog-title">{name}</Dialog.Title>
          </div>
          <Dialog.Close asChild><button type="button" className="pc-x" aria-label="关闭技能"><Icon name="close" size={18} /></button></Dialog.Close>
        </div>
        <div className="st-dialog-body st-skill-document-body" aria-busy={loading || undefined}>
          {loading && content === null && <p className="st-skill-document-status" role="status">正在打开技能…</p>}
          {!loading && error && <div className="st-skill-document-status" role="alert"><p>暂时无法打开技能，请重试。</p><button type="button" className="outline" onClick={onRetry}>重试</button></div>}
          {content !== null && !error && <article className="st-skill-document-content" role="document" tabIndex={0} aria-label={`${name}正文`}>
            <Markdown text={documentMarkdown(content)} />
          </article>}
        </div>
        {footer && <div className="st-dialog-foot st-skill-document-footer">{footer}</div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
