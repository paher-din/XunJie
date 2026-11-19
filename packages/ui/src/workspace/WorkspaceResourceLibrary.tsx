import type { ReactNode } from 'react'
import { Button } from '../foundation/Button'
import { Icon } from '../icons'
import './workspace-resource-library.css'

export function WorkspaceResourceLibrary({ title, description, actions, busy, children }: {
  title: string; description: string; actions?: ReactNode; busy?: boolean; children: ReactNode
}) {
  return <section className="workspace-resource-library" aria-label={title} aria-busy={busy}>
    <div className="workspace-resource-library-inner">
      <header className="workspace-resource-library-heading">
        <h2>{title}</h2>
        {actions && <div className="workspace-resource-library-actions">{actions}</div>}
      </header>
      <p className="workspace-resource-library-description">{description}</p>
      <div className="workspace-resource-library-body">{children}</div>
    </div>
  </section>
}

export function WorkspaceResourceList({ label, children }: { label?: string; children: ReactNode }) {
  return <ul className="workspace-resource-list" aria-label={label}>{children}</ul>
}

export function WorkspaceResourceRow({ name, detail, actions, current, disabled, onOpen }: {
  name: string; detail?: string; actions?: ReactNode; current?: boolean; disabled?: boolean; onOpen?: () => void
}) {
  const file = <>
    <Icon name="file-text" size={16} />
    <span className="workspace-resource-row-name">{name}</span>
    {detail && <span className="workspace-resource-row-detail">{detail}</span>}
  </>
  return <li className="workspace-resource-row" data-current={current || undefined}>
    {onOpen
      ? <Button type="button" variant="outline" className="workspace-resource-row-main" title={name}
        aria-label={name} aria-description={detail} aria-current={current || undefined} disabled={disabled} onClick={onOpen}>{file}</Button>
      : <div className="workspace-resource-row-main" title={name}>{file}</div>}
    {actions && <div className="workspace-resource-row-actions">{actions}</div>}
  </li>
}
