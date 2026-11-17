import { memo, useState } from 'react'
import { parseDocument } from 'yaml'
import { AgentTraceItem, type AgentTraceItemProps } from './AgentActivity'

export interface AgentSkillReadProps extends Omit<AgentTraceItemProps, 'title' | 'description'> {
  title?: string
  document: { skillId?: string; source: string; path: string; version: number; packageVersion: string; content: string; encoding: string
    offset: number; byteLength: number; totalByteLength: number; complete: boolean; digest?: string }
}
/** A fixed Skill read is a Trace step; expanded content shows the package's original description only. */
export const AgentSkillRead = memo(function AgentSkillRead({ document, title, status = '已读取', tone = 'done', children,
  open: controlledOpen, defaultOpen = false, onOpenChange, ...props }: AgentSkillReadProps) {
  const [localOpen, setLocalOpen] = useState(defaultOpen), open = controlledOpen ?? localOpen
  const frontmatter = document.encoding === 'utf8' && /^---\r?\n([\s\S]*?)\r?\n---/.exec(document.content)?.[1]
  const name = frontmatter && /^name:\s*["']?([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)["']?\s*$/mu.exec(frontmatter)?.[1]
  let description: unknown
  if (frontmatter) {
    try {
      const metadata = parseDocument(frontmatter, { strict: true, uniqueKeys: true })
      if (!metadata.errors.length) description = metadata.toJS({ maxAliasCount: 0 })?.description
    } catch {}
  }
  const original = typeof description === 'string' ? description.trim() : ''
  return <AgentTraceItem {...props} open={open} onOpenChange={(next, details) => { setLocalOpen(next); onOpenChange?.(next, details) }}
    title={title ?? (name ? `读取技能 · ${name}` : '读取技能')} icon="skill" status={status} tone={tone}>
    <div className="agent-skill-summary">
      <p>{original || '这项技能没有提供说明。'}</p>
    </div>
    {children}
  </AgentTraceItem>
})
