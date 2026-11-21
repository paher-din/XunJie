import type { AgentConversation } from '@xunjie/contracts/agent-service'

export type CitationRecord = NonNullable<AgentConversation['citations']>[number]

export interface MessageCitationsProps {
  citations: readonly CitationRecord[]
  onOpen?: (citation: CitationRecord) => void | Promise<void>
}

/** Shared citation card for both the home conversation and workspace conversation. */
export function MessageCitations({ citations, onOpen }: MessageCitationsProps) {
  if (!citations.length) return null
  return <section className="message-citations" aria-label="回答依据">
    <p className="message-citations-label">依据</p>
    <ul>{citations.map(item => <li key={item.citation.citationId}>
      <button type="button" className="message-citation" disabled={!onOpen} onClick={() => void onOpen?.(item)}>
        <span className="message-citation-claim">{item.citation.claim}</span>
        <span className="message-citation-source">{item.citation.label}{item.citation.version ? ` · ${item.citation.version}` : ''}</span>
      </button>
    </li>)}</ul>
  </section>
}
