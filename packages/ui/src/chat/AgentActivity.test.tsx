// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentTrace, AgentTraceItem } from './AgentActivity'
import { AgentThinking } from './AgentThinking'
import { AgentSkillRead } from './AgentSkillRead'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot> | undefined

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('shows the Skill package description verbatim and never exposes its instructions', async () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<AgentSkillRead defaultOpen document={{ skillId: 'test-skill', source: 'test', path: 'SKILL.md', version: 1,
    packageVersion: '1', encoding: 'utf8', content: '---\nname: teach\ndescription: >-\n  Teach a concept\n  with examples.\n---\nPRIVATE INSTRUCTIONS', offset: 0, byteLength: 100, totalByteLength: 100, complete: true }} />))
  expect(host.textContent).toContain('Teach a concept with examples.')
  expect(host.textContent).not.toContain('PRIVATE INSTRUCTIONS')
})

it('opens during thinking and collapses once it completes, allowing manual reopening', () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<AgentThinking text="先检查条件" active />))
  const trigger = host.querySelector<HTMLButtonElement>('.agent-thinking-trigger')!
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(host.textContent).toContain('先检查条件')
  act(() => root!.render(<AgentThinking text="先检查条件，再求解" active={false} />))
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  act(() => trigger.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
})

it('follows the newest thinking text while active and stops following after completion', () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<AgentThinking text="第一段思考" active />))
  const content = host.querySelector<HTMLElement>('.agent-thinking-content')!
  Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 640 })
  Object.defineProperty(content, 'clientHeight', { configurable: true, value: 280 })
  act(() => root!.render(<AgentThinking text="第一段思考\n\n第二段思考" active />))
  expect(content.scrollTop).toBe(640)
  content.scrollTop = 0
  act(() => root!.render(<AgentThinking text="第一段思考\n\n第二段思考" active={false} />))
  expect(content.scrollTop).toBe(0)
})

it('paces newly arrived thinking text between durable progress batches', () => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', window.clearTimeout)
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const first = '正在检查条件。'
  act(() => root!.render(<AgentThinking text={first} active />))
  const content = host.querySelector<HTMLElement>('.agent-thinking-content')!
  expect(content.textContent).toBe(first)
  const next = first + '接着整理任务信息。'.repeat(20)
  act(() => root!.render(<AgentThinking text={next} active />))
  expect(content.textContent).toBe(first)
  act(() => vi.advanceTimersByTime(100))
  expect(content.textContent!.length).toBeGreaterThan(first.length)
  expect(content.textContent!.length).toBeLessThan(next.length)
})

it('keeps Skill and tool steps in one compact group and mounts details after expansion', () => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<AgentTrace aria-label="工具与技能记录">
    <AgentTraceItem title="读取技能" status="已读取" tone="done">技能明细</AgentTraceItem>
    <AgentTraceItem title="检索材料" status="已完成" tone="done">材料明细</AgentTraceItem>
  </AgentTrace>))

  const group = host.querySelector<HTMLButtonElement>('.agent-trace-group-trigger')!
  expect(group.textContent).toContain('执行记录')
  expect(group.textContent).toContain('2 步')
  expect(host.textContent).not.toContain('技能明细')

  act(() => group.click())
  expect(group.getAttribute('aria-expanded')).toBe('true')
  expect(host.textContent).toContain('读取技能')
  expect(host.textContent).toContain('检索材料')
})

it('keeps thinking and tool records together and leaves tool details available after completion', () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<AgentTrace grouped active label="思考与执行"><AgentThinking text="分析输入" active /></AgentTrace>))
  const trigger = host.querySelector<HTMLButtonElement>('.agent-trace-group-trigger')!
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  act(() => root!.render(<AgentTrace grouped active label="思考与执行"><AgentThinking text="分析输入" active={false} />
    <AgentTraceItem title="查找学习材料">已检查材料。</AgentTraceItem></AgentTrace>))
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(host.textContent).toContain('查找学习材料')
  act(() => root!.render(<AgentTrace grouped label="思考与执行"><AgentThinking text="分析输入" active={false} />
    <AgentTraceItem title="查找学习材料">已检查材料。</AgentTraceItem></AgentTrace>))
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
})
