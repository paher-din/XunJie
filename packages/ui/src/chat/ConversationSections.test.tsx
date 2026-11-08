// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentEmptyState, ChatComposerDock, ChatViewport } from './ConversationSections'

let node: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(() => { act(() => root.unmount()); node.remove() })

it('空态保留可选说明、原标题层级与角色尺寸', () => {
  const plain = renderToStaticMarkup(<AgentEmptyState title="今天想探讨什么？" />)
  const first = renderToStaticMarkup(<AgentEmptyState title="你好" description="说明" />)
  expect(plain).toContain('class="chat-empty"')
  expect(plain).toContain('width:52px;margin:auto')
  expect(/<p(?:\s|>)/.test(plain)).toBe(false)
  expect(first).toContain('<h1>你好</h1><p style="color:var(--muted)">说明</p>')
})

it('视口维持 ref、log 语义、独立状态播报和两类底部留白', () => {
  const scrollerRef = createRef<HTMLDivElement>(), onScroll = vi.fn()
  act(() => root.render(<ChatViewport scrollerRef={scrollerRef} onScroll={onScroll} onJump={() => {}}
    phase="streaming" busy padSuggestions queued><div className="chat-message user"><div className="bubble">内容</div></div></ChatViewport>))
  expect(scrollerRef.current).toBe(node.querySelector('.chat-wrap'))
  const log = node.querySelector('[role="log"]')!
  expect(log.className).toBe('chat-inner pad-suggest pad-queue')
  expect(log.getAttribute('aria-live')).toBe('off')
  expect(log.getAttribute('aria-busy')).toBe('true')
  expect(node.querySelector('.turn-aria')?.textContent).toBe('正在生成回复')
  act(() => scrollerRef.current!.dispatchEvent(new Event('scroll')))
  expect(onScroll).toHaveBeenCalledOnce()
})

it('输入区保留建议／追问、回底、排队发送回调与定位 ref', () => {
  const anchorRef = createRef<HTMLDivElement>(), onPick = vi.fn(), follow = vi.fn(), back = vi.fn(), send = vi.fn()
  act(() => root.render(<ChatComposerDock anchorRef={anchorRef} atBottom={false}
    suggestions={{ items: ['建议'], show: true, onPick }} followUps={{ items: ['追问'], show: true, onPick: follow, label: '延伸探讨' }}
    queue={{ message: '已保留', action: { label: '发送排队问题', onSend: send } }} onBackToBottom={back}
    input={<textarea aria-label="输入" />} disclaimer="来源" usageLabel=" · 实际用量 0 tokens" />))
  expect(anchorRef.current).toBe(node.querySelector('.composer-anchor.away'))
  act(() => (node.querySelector('.ss-cards button') as HTMLButtonElement).click())
  expect(onPick).toHaveBeenCalledWith('建议')
  act(() => (node.querySelector('[aria-label="延伸探讨"] .ss-cards button') as HTMLButtonElement).click())
  expect(follow).toHaveBeenCalledWith('追问')
  act(() => (node.querySelector('.back-bottom') as HTMLButtonElement).click())
  act(() => (node.querySelector('.queue-tip button') as HTMLButtonElement).click())
  expect(back).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce()
  expect(node.querySelector('.chat-disclaimer')?.textContent).toBe('来源 · 实际用量 0 tokens')
})
