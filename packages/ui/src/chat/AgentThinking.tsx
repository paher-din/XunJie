import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import { Spinner } from '@astryxdesign/core/Spinner'
import { Icon } from '../icons'
import { Markdown } from './Markdown'
import { useSmoothStreamText } from './useSmoothStreamText'

export function AgentThinking({ text, active, truncated = false }: { text: string; active: boolean; truncated?: boolean }) {
  const [open, setOpen] = useState(active)
  const content = useRef<HTMLDivElement>(null)
  // Progress arrives in durable batches. Pace only new text between batches so a large update
  // does not replace the whole visible paragraph at once, while remounts keep existing text visible.
  const shown = useSmoothStreamText(text, active, { animateOnMount: false })
  useEffect(() => { setOpen(active) }, [active])
  useLayoutEffect(() => {
    if (!active || !open || !content.current) return
    content.current.scrollTop = content.current.scrollHeight
  }, [active, open, shown, text])
  return <Collapsible.Root open={open} onOpenChange={setOpen} className="agent-thinking" data-active={active}>
    <Collapsible.Trigger className="agent-thinking-trigger">
      {active ? <Spinner size="sm" shade="subtle" /> : <Icon name="brain" size={16} tone="neutral" />}
      <span>{active ? '正在思考' : '思考过程'}{truncated ? '（节选）' : ''}</span>
      <Icon name="alt-arrow-down" size={14} />
    </Collapsible.Trigger>
    <Collapsible.Panel ref={content} className="agent-thinking-content"><Markdown text={shown} variant="astryx" live={active} /></Collapsible.Panel>
  </Collapsible.Root>
}
