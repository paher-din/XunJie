import type { ReactNode } from 'react'
import { IconText, type IconName } from '../icons'
import { useToastFeedback } from '../feedback'

export interface SettingsLayoutTab<Id extends string = string> {
  id: Id
  label: string
  icon: IconName
}

export interface SettingsLayoutProps<Id extends string = string> {
  tabs: readonly SettingsLayoutTab<Id>[]
  active: Id
  onSelect: (id: Id) => void
  version: string
  toast: string | null
  children: ReactNode
}

/** Controlled settings shell; routing, notifications and section state belong to the caller. */
export function SettingsLayout<Id extends string>({
  tabs,
  active,
  onSelect,
  version,
  toast,
  children,
}: SettingsLayoutProps<Id>) {
  useToastFeedback(toast, 'info')
  return (
    <div className="settings student-settings">
      <aside className="st-nav">
        <h1 className="st-title">设置</h1>
        <nav aria-label="设置导航">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={'st-nav-item' + (t.id === active ? ' active' : '')}
              aria-current={t.id === active ? 'page' : undefined}
              onClick={() => onSelect(t.id)}
            >
              <IconText name={t.icon} size={17}>{t.label}</IconText>
            </button>
          ))}
        </nav>
        <div className="st-nav-foot">循阶 v{version}</div>
      </aside>
      <div className="st-body">
        <div className="st-body-in" key={active}>
          {children}
        </div>
      </div>
    </div>
  )
}
