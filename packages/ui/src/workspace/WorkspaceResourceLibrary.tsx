import type { ReactNode } from 'react'
import { Menu } from '@base-ui/react/menu'
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

export function WorkspaceResourceMenu({ name, disabled, items }: {
  name: string; disabled?: boolean; items: readonly { label: string; onSelect: () => void }[]
}) {
  return <Menu.Root>
    <Menu.Trigger className="workspace-resource-row-more" type="button" aria-label={`${name}的更多操作`}
      title="更多操作" disabled={disabled}><Icon name="menu-dots" size={16} variant="linear" /></Menu.Trigger>
    <Menu.Portal><Menu.Positioner className="workspace-resource-menu-positioner" align="end" sideOffset={6}>
      <Menu.Popup className="workspace-resource-menu">
        {items.map(item => <Menu.Item key={item.label} className="workspace-resource-menu-item" onClick={item.onSelect}>
          {item.label}
        </Menu.Item>)}
      </Menu.Popup>
    </Menu.Positioner></Menu.Portal>
  </Menu.Root>
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
