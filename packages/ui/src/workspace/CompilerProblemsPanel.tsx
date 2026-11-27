import { useId, useState } from 'react'
import { Button } from '../foundation/Button'
import { Icon } from '../icons/Icon'
import type { EditorDiagnostic } from './diagnosticPresentation'
import './compiler-problems.css'

export function CompilerProblemsPanel({ issues, stale, canReveal, onReveal }: {
  issues: EditorDiagnostic[]
  stale: boolean
  canReveal: (issue: EditorDiagnostic) => boolean
  onReveal: (issue: EditorDiagnostic) => void
}) {
  const [open, setOpen] = useState(true)
  const bodyId = useId()
  return <section className="compiler-problems" aria-label="编译问题">
    <Button type="button" variant="outline" className="compiler-problems-toggle"
      aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
      <Icon name="danger-triangle" size={16} tone="neutral" className="compiler-problems-status" />
      <strong>编译问题</strong>
      {stale && <span className="compiler-problems-stale">代码已修改 · 上次编译</span>}
      <Icon name={open ? 'alt-arrow-down' : 'alt-arrow-right'} size={14} tone="neutral" />
    </Button>
    <div className="compiler-problems-output" id={bodyId} hidden={!open}>
      {issues.length ? <ul>{issues.map((issue, index) => {
        const location = issue.path && issue.line ? `${issue.path}:${issue.line}${issue.range ? ':' + issue.range.startColumn : ''}` : ''
        return <li key={index}>
          {location && (canReveal(issue)
            ? <button type="button" className="compiler-problems-location" onClick={() => onReveal(issue)}>{location}</button>
            : <span className="compiler-problems-path">{location}</span>)}
          <span>{issue.message}</span>
        </li>
      })}</ul> : <p>编译器未返回详细信息。</p>}
    </div>
  </section>
}
