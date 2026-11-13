import { Children, type ReactNode } from 'react'
import { Icon } from '../icons'
import './model-provider-card.css'

/** Shared card presentation; the caller owns identity, configuration, checks and persistence. */
export function ModelProviderCard({ name, address, credentialLabel, logo, compact = false, inactive = false, busy = false, actions, footer, children }: {
  name: string; address?: string | undefined; credentialLabel?: string | undefined; logo?: ReactNode; compact?: boolean
  inactive?: boolean
  busy?: boolean
  actions: ReactNode; footer?: ReactNode; children: ReactNode
}) {
  return <div className={'st-provider' + (compact ? ' st-provider-compact' : '') + (inactive ? ' st-provider-inactive' : '')}
    aria-busy={busy || undefined}>
    <div className="st-provider-head">
      <span className="st-provider-badge" aria-hidden="true">{logo ?? <Icon name="model" size={18} />}</span>
      <div className="st-provider-info"><span className="st-provider-name" title={name}>{name}</span>
        {address && <span className="st-mono st-provider-url">{address}</span>}{credentialLabel && <span>{credentialLabel}</span>}</div>
      <div className="st-provider-acts">{actions}</div>
    </div>
    {children}
    {footer && <div className="st-provider-bottom">{footer}</div>}
  </div>
}

/** A model's identity, actions and optional feedback share one row; state belongs to the caller. */
export function ModelProviderModelRow({ modelId, effort, actions, children }: {
  modelId: string; effort?: string | undefined; actions: ReactNode; children?: ReactNode
}) {
  const feedback = Children.toArray(children).filter(child => child !== '')
  return <div className="st-configured-model st-provider-model-row" role="group" aria-label={modelId}>
    <div className="st-provider-model-main">
      <div className="st-provider-model-copy">
        <span className="st-provider-model-name" title={modelId}>{modelId}</span>
        {effort && <span className="st-configured-model-effort">{effort}</span>}
      </div>
      <div className="st-provider-model-actions">{actions}</div>
    </div>
    {feedback.length > 0 && <div className="st-provider-model-feedback">{feedback}</div>}
  </div>
}

import type { ComponentProps } from 'react'
export type ModelProviderCardProps = ComponentProps<typeof ModelProviderCard>
