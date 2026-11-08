import type { AnchorHTMLAttributes } from 'react'

export type SettingsAgentLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children' | 'className'> & {
  'data-discover'?: string
}

/** Adapter supplies href and router click handling; all visual markup belongs to the package. */
export function SettingsAgentLink(props: SettingsAgentLinkProps) {
  return <a {...props} className="st-link"> Agent 个性化 </a>
}
