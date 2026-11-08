// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PromptInput, type PromptInputProps } from './PromptInput'

let node: HTMLDivElement
let root: ReturnType<typeof createRoot>
let props: PromptInputProps
beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
  props = { value: '问题', onChange: vi.fn(), onSend: vi.fn(), canSend: true, attachments: [],
    onAddFiles: vi.fn(), onRemoveAttachment: vi.fn(), attachmentTitle: '添加图片',
    model: { id: 'one', name: '第一个模型', note: '说明一', icon: 'model' },
    models: [{ id: 'one', name: '第一个模型', note: '说明一', icon: 'model' }, { id: 'two', name: '第二个模型', note: '说明二', icon: 'model' }],
    onModelChange: vi.fn(), effort: '高', efforts: ['低', '高'], onEffortChange: vi.fn() }
})
afterEach(() => { act(() => root.unmount()); node.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
const render = () => act(() => root.render(<PromptInput {...props} />))
const button = (label: string) => node.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement

it('Enter 提交，Shift+Enter 和组合输入不提交；回调不自行清空受控草稿', () => {
  props.autoFocus = true; render()
  const field = node.querySelector('textarea')!
  expect(document.activeElement).toBe(field)
  act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })))
  act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
  expect(props.onSend).not.toHaveBeenCalled()
  act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(props.onSend).toHaveBeenCalledOnce()
  expect(field.value).toBe('问题')
  props.canSend = false; render()
  act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(props.onSend).toHaveBeenCalledOnce()
})

it('模型和强度菜单保留受控选择、键盘操作、互斥退场及 Escape', () => {
  render()
  act(() => button('切换模型').click())
  expect(button('切换模型').getAttribute('aria-expanded')).toBe('true')
  const second = node.querySelectorAll('.prompt-model-item')[1]
  act(() => second.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })))
  expect(props.onModelChange).toHaveBeenCalledWith('two')
  expect(node.querySelector('.prompt-model-menu.closing')).not.toBeNull()
  expect(node.querySelector('.prompt-model-label')?.textContent).toBe('第一个模型')
  act(() => vi.advanceTimersByTime(140))
  expect(node.querySelector('.prompt-model-menu')).toBeNull()
  props.model = props.models[1]; render()
  expect(node.querySelector('.prompt-model-label')?.textContent).toBe('第二个模型')
  act(() => button('切换思考强度').click())
  act(() => (node.querySelector('.mi-effort-option') as HTMLButtonElement).click())
  expect(props.onEffortChange).toHaveBeenCalledWith('two', '低')
  act(() => button('切换模型').click())
  expect(node.querySelector('.prompt-model-menu.effort.closing')).not.toBeNull()
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  act(() => vi.advanceTimersByTime(140))
  expect(node.querySelector('.prompt-model-menu')).toBeNull()
})

it('输入框按测量高度增减并封顶，保留宿主禁用状态、提示及停止操作', () => {
  render()
  const field = node.querySelector('textarea')!
  Object.defineProperty(field, 'scrollHeight', { configurable: true, value: 320 })
  props.value = '更多行'; render()
  expect(field.style.height).toBe('200px')
  Object.defineProperty(field, 'scrollHeight', { configurable: true, value: 60 })
  props.value = '短'; render()
  expect(field.style.height).toBe('60px')
  props.submitting = true; props.modelDisabled = true; props.effortDisabled = true
  props.status = { role: 'alert', text: '宿主未确认模型' }; props.busy = true; props.onStop = vi.fn(); render()
  expect(field.disabled).toBe(true)
  expect(button('添加附件').disabled).toBe(true)
  expect(button('切换模型').disabled).toBe(true)
  expect(button('切换思考强度').disabled).toBe(true)
  expect(node.querySelector('[role="alert"]')?.textContent).toBe('宿主未确认模型')
  act(() => button('停止生成').click())
  expect(props.onStop).toHaveBeenCalledOnce()
})

it('文件选择和拖入只交给宿主，保留拖拽反馈和队列可见性', () => {
  props.accept = 'image/png'; render()
  const file = new File(['x'], 'one.png', { type: 'image/png' })
  const input = node.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file] })
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })))
  expect(props.onAddFiles).toHaveBeenCalledWith([file])
  expect(input.accept).toBe('image/png')
  const form = node.querySelector('form')!
  act(() => form.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true })))
  expect(form.classList.contains('dragging')).toBe(true)
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } })
  act(() => form.dispatchEvent(drop))
  expect(form.classList.contains('dragging')).toBe(false)
  expect(props.onAddFiles).toHaveBeenCalledTimes(2)
  props.attachments = [{ id: 'one', kind: 'document', name: '活动中', size: 1, progress: 20 }, { id: 'two', kind: 'document', name: '等待中', size: 1, progress: 0 }]; render()
  expect(node.querySelectorAll('.prompt-tile')).toHaveLength(1)
  expect(node.querySelector('.prompt-tile')?.getAttribute('title')).toBe('活动中')
})

it('附件立即脱流退场，280ms 后才请求宿主删除，卸载取消未完成计时', () => {
  props.attachments = [{ id: 'one', kind: 'document', name: '文件', size: 1 }]; render()
  act(() => (node.querySelector('.pt-dismiss') as HTMLButtonElement).click())
  expect(node.querySelector('.prompt-tile.leaving')).not.toBeNull()
  expect((node.querySelector('.prompt-attachments') as HTMLElement).style.height).toBe('0px')
  act(() => vi.advanceTimersByTime(279))
  expect(props.onRemoveAttachment).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(1))
  expect(props.onRemoveAttachment).toHaveBeenCalledWith('one')
  act(() => (node.querySelector('.pt-dismiss') as HTMLButtonElement).click())
  act(() => root.render(null))
  act(() => vi.advanceTimersByTime(280))
  expect(props.onRemoveAttachment).toHaveBeenCalledTimes(1)
})
