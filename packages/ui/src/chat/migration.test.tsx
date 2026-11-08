// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AttachmentTile, GenLiveCard, QuizCard, UserMessage, type GenCardData, type GenHostOptions } from './index'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

it('消息编辑自动聚焦，Escape 返回原消息而不提交', () => {
  const onEdit = vi.fn()
  act(() => root.render(<UserMessage text="原消息" onEdit={onEdit} />))
  act(() => (container.querySelector('[aria-label="编辑这条消息"]') as HTMLButtonElement).click())
  const textarea = container.querySelector('textarea')!
  expect(document.activeElement).toBe(textarea)
  expect(container.querySelector('.bubble')?.textContent).toBe('原消息')
  act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('textarea')).toBeNull()
  expect(onEdit).not.toHaveBeenCalled()
})

it('小测保留判定与提交回调，仅展示宿主提供的记录事实', () => {
  const onSubmitAnswer = vi.fn()
  const quiz = { topic: '主题', title: '小测', stem: '题目', options: [{ key: 'A', text: '选项' }], answer: 'A', explain: '解析' }
  act(() => root.render(<QuizCard quiz={quiz} onSubmitAnswer={onSubmitAnswer} />))
  act(() => (container.querySelector('.quiz-opt') as HTMLButtonElement).click())
  act(() => (container.querySelector('.quiz-submit') as HTMLButtonElement).click())
  expect(onSubmitAnswer).toHaveBeenCalledWith('A')
  expect(container.querySelector('.quiz-verdict')?.textContent).toBe('答对了。')
  expect(container.querySelector('.quiz-record')).toBeNull()
  act(() => root.render(<QuizCard quiz={quiz} recordLabel="宿主已确认保存" />))
  expect(container.querySelector('.quiz-record')?.textContent).toBe('宿主已确认保存')
})

it('附件瓦片保留进度、图片失败回退和移除尺寸回调', () => {
  const onRemove = vi.fn()
  act(() => root.render(<AttachmentTile attachment={{ id: 'a', name: '图片.png', kind: 'image', size: 1, src: 'bad', progress: 50 }} onRemove={onRemove} />))
  expect(container.querySelector('.prompt-tile.uploading')).not.toBeNull()
  expect(container.querySelector('.pt-pct')?.textContent).toBe('50%')
  act(() => container.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('[data-icon="file-image"]')).not.toBeNull()
  act(() => (container.querySelector('.pt-dismiss') as HTMLButtonElement).click())
  expect(onRemove).toHaveBeenCalledWith({ left: 0, top: 0, width: 0, height: 0 })
})

it('生成卡通过宿主接口挂载、取快照、超时重试并清理', async () => {
  let options!: GenHostOptions
  const host = { mount: vi.fn(), unmount: vi.fn(), snapshot: vi.fn(async () => ({ value: 2 })), reload: vi.fn(), loadVersion: vi.fn() }
  const createHost = vi.fn((next: GenHostOptions) => { options = next; return host })
  const onCollect = vi.fn()
  const card: GenCardData = { cardId: 'one', title: '交互', taskId: null, claimSim: false, srcdoc: '<p>one</p>', fallbackSrcdoc: '<p>old</p>', version: 1 }
  act(() => root.render(<GenLiveCard card={card} createHost={createHost} collectLabel="收纳" onCollect={onCollect} />))
  expect(host.mount).toHaveBeenCalledWith(container.querySelector('.gen-framebox'), card.srcdoc, null)
  act(() => options.callbacks.onReady())
  expect(container.querySelector('.gen-loading')).toBeNull()
  await act(async () => { (container.querySelector('.gen-act') as HTMLButtonElement).click() })
  expect(onCollect).toHaveBeenCalledWith({ value: 2 })
  act(() => options.callbacks.onDead())
  expect(container.querySelector('.gen-errbar')?.textContent).toContain('这个交互没有响应')
  act(() => (container.querySelector('.gen-errbar-retry') as HTMLButtonElement).click())
  expect(host.reload).toHaveBeenCalledWith(card.fallbackSrcdoc, null)
  act(() => root.render(null))
  expect(host.unmount).toHaveBeenCalledOnce()
})
