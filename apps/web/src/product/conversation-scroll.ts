import { useRef, useState, type UIEvent } from 'react'
import { useFollowBottom } from '@xunjie/ui/chat'

/** Both conversation surfaces follow new output until the reader scrolls into history. */
export function useConversationScroll() {
  const scroller = useRef<HTMLDivElement>(null), stick = useRef(true), ours = useRef(-1)
  const [atBottom, setAtBottom] = useState(true)
  useFollowBottom({ scroller, stick, ours })
  const backToBottom = () => {
    stick.current = true; setAtBottom(true)
    const element = scroller.current
    if (element) {
      element.scrollTop = element.scrollHeight
      ours.current = element.scrollTop
    }
  }
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    if (Math.abs(element.scrollTop - ours.current) <= 1) return
    const bottom = element.scrollHeight - element.clientHeight - element.scrollTop < 64
    stick.current = bottom; setAtBottom(bottom)
  }
  const onJump = (element: HTMLElement, last: boolean) => {
    if (last) backToBottom()
    else { stick.current = false; setAtBottom(false); element.scrollIntoView({ block: 'center' }) }
  }
  return { scroller, atBottom, backToBottom, onScroll, onJump }
}
