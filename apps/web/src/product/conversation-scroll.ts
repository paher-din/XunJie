import { useCallback, useRef, useState, type UIEvent } from 'react'
import { useFollowBottom } from '@xunjie/ui/chat'

/** 课程页签切换时留下的阅读位置；换课程时由新的页面作用域丢弃。 */
export interface ConversationScrollPosition { sessionId: string; top: number; atBottom: boolean }

/** Both conversation surfaces follow new output until the reader scrolls into history. */
export function useConversationScroll() {
  const scroller = useRef<HTMLDivElement>(null), stick = useRef(true), ours = useRef(-1)
  const [atBottom, setAtBottom] = useState(true)
  useFollowBottom({ scroller, stick, ours })
  const backToBottom = useCallback(() => {
    stick.current = true; setAtBottom(true)
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [])
  const restore = useCallback((position: ConversationScrollPosition) => {
    stick.current = position.atBottom; setAtBottom(position.atBottom)
    const element = scroller.current
    if (!element) return
    const max = Math.max(0, element.scrollHeight - element.clientHeight)
    element.scrollTop = position.atBottom ? max : Math.min(Math.max(0, position.top), max)
    ours.current = element.scrollTop
  }, [])
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    if (Math.abs(element.scrollTop - ours.current) <= 1) return
    const bottom = element.scrollHeight - element.clientHeight - element.scrollTop < 64
    stick.current = bottom; setAtBottom(bottom)
  }, [])
  const onJump = useCallback((element: HTMLElement, last: boolean) => {
    if (last) backToBottom()
    else { stick.current = false; setAtBottom(false); element.scrollIntoView({ block: 'center' }) }
  }, [backToBottom])
  return { scroller, atBottom, backToBottom, restore, onScroll, onJump }
}
