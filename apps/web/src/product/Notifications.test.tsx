// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Toaster, toast, useToastFeedback } from '@xunjie/ui/feedback'

let host: HTMLDivElement, root: Root
const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
function Feedback({ message }: { message: string }) {
  useToastFeedback(message)
  return <input aria-label="学校链接" defaultValue="https://school.example.edu" />
}
const render = async (message: string) => {
  await act(async () => {
  root.render(<StrictMode><Feedback message={message} /><Toaster /></StrictMode>)
  })
  await act(async () => { await settle() })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { toast.dismiss(); await settle(); root.unmount(); await settle() })
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('shows an initial error even before the root subscribes, once in StrictMode', async () => {
  const notify = vi.spyOn(toast, 'error')
  await render('学校暂时不可用。')
  expect(host.querySelectorAll('[data-sonner-toast][data-type="error"]')).toHaveLength(1)
  expect(host.querySelector('[data-sonner-toast]')?.textContent).toContain('学校暂时不可用。')
  await render('学校暂时不可用。')
  expect(notify).toHaveBeenCalledTimes(1)
})

it('clears resolved errors and notifies a later retry without changing form input', async () => {
  const notify = vi.spyOn(toast, 'error')
  await render('学校暂时不可用。')
  const input = host.querySelector('input')!
  input.value = 'https://school.example.edu'
  await render('')
  expect(toast.getToasts()).toHaveLength(0)
  await render('学校暂时不可用。')
  expect(notify).toHaveBeenCalledTimes(2)
  expect(host.querySelector('input')).toBe(input)
  expect(input.value).toBe('https://school.example.edu')
})

it('renders typed, dismissible notifications together in one root', async () => {
  await render('')
  await act(async () => {
    toast.success('设置已保存。')
    toast.warning('当前输入尚未保存。')
    toast.error('学校连接失败。')
    await settle()
  })
  expect(host.querySelectorAll('[data-sonner-toaster]')).toHaveLength(1)
  expect(host.querySelectorAll('[data-sonner-toast]')).toHaveLength(3)
  expect(host.querySelector('[data-type="success"]')?.textContent).toContain('设置已保存。')
  expect(host.querySelector('[data-type="warning"]')?.textContent).toContain('当前输入尚未保存。')
  const error = host.querySelector('[data-type="error"]')!
  await act(async () => { error.querySelector<HTMLButtonElement>('[aria-label="关闭通知"]')!.click(); await settle() })
  await act(async () => { await vi.waitFor(() => expect(error.getAttribute('data-removed')).toBe('true')) })
})
