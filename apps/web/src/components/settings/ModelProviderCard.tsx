import type { ReactNode } from 'react'
import { Icon } from '../../icons'

/** Shared card presentation; the caller owns identity, configuration, checks and persistence. */
export function ModelProviderCard({ name, address, credentialLabel, actions, children }: {
  name: string; address: string; credentialLabel?: string | undefined; actions: ReactNode; children: ReactNode
}) {
  return <div className="st-provider">
    <div className="st-provider-head">
      <span className="st-provider-badge"><Icon name="model" size={18} /></span>
      <div className="st-provider-info"><span className="st-provider-name">{name}</span>
        <span className="st-mono st-provider-url">{address}</span>{credentialLabel && <span>{credentialLabel}</span>}</div>
      <div className="st-provider-acts">{actions}</div>
    </div>
    {children}
  </div>
}
