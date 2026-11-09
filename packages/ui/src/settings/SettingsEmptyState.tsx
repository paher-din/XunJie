import type { ReactNode } from 'react'
import './settings-empty.css'

/** shadcn/ui Empty composition (MIT), adapted to XunJie's tokens without a Tailwind runtime.
 * Source: https://ui.shadcn.com/docs/components/empty
 */
export function SettingsEmptyState({ icon, title, description, children }: {
  icon: ReactNode; title: string; description?: string; children?: ReactNode
}) {
  return <div className="st-empty" data-slot="empty">
    <div data-slot="empty-header">
      <div data-slot="empty-icon" aria-hidden="true">{icon}</div>
      <h2 data-slot="empty-title">{title}</h2>
      {description && <p data-slot="empty-description">{description}</p>}
    </div>
    {children && <div data-slot="empty-content">{children}</div>}
  </div>
}
