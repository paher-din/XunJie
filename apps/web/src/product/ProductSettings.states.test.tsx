// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProductSettings, type ProductSettingsProps } from './ProductSettings'

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = async (props: Partial<ProductSettingsProps> = {}) => act(async () => {
  root.render(<ProductSettings accountName="示例同学" onBack={() => {}} schoolControls={null} modelSettings={null} {...props} />)
})
const click = async (label: string) => act(async () => {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === label)
  expect(button).toBeDefined()
  button!.click()
})

it('distinguishes account loading, failure and ready states', async () => {
  await render({ accountState: { status: 'loading' } })
  expect(host.textContent).toContain('正在读取当前学习空间')
  expect(host.querySelector('.product-settings-school')).toBeNull()

  const retry = vi.fn()
  await render({ accountState: { status: 'error', message: '学习服务暂时不可用。', onRetry: retry } })
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('账号信息暂时无法读取')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('学习服务暂时不可用。')
  await click('重新读取账号')
  expect(retry).toHaveBeenCalledOnce()

  await render({ accountState: { status: 'ready' }, schoolName: '示例学校',
    schoolControls: <button type="button">连接学校</button> })
  expect(host.textContent).toContain('当前学习空间')
  expect(host.textContent).toContain('示例学校')
  expect(host.textContent).toContain('连接学校')
})

it('keeps the account recovery action explainable while a retry is in flight', async () => {
  await render({ accountState: { status: 'error', message: '学习服务暂时不可用。', busy: true, onRetry: vi.fn() } })
  const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '正在重新读取…')!
  expect(retry.disabled).toBe(true)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('账号信息暂时无法读取')
})

it('explains every category and gives the portrait a meaningful empty state', async () => {
  await render()
  const descriptions: Record<string, string> = {
    账户: '管理当前学习空间与学校连接。',
    学生画像: '查看 Agent 有依据地理解到的学习情况。',
    'Agent 个性化': '决定 Agent 在执行任务时如何处理新消息，以及可以使用哪些技能。',
    模型: '管理 Agent 可使用的模型与个人供应商。',
    关于: '了解数据如何保存，以及如何整理对话。',
  }
  for (const [label, description] of Object.entries(descriptions)) {
    await click(label)
    expect(host.querySelector('.product-settings-heading p')?.textContent).toBe(description)
  }
  await click('学生画像')
  expect(host.textContent).toContain('还没有形成学生画像')
  expect(host.textContent).toContain('不等同于成绩')
})

it('keeps school controls visible but inert in a read-only space', async () => {
  await render({ accountState: { status: 'ready' }, readOnly: true, isLocal: true,
    schoolControls: <button type="button">连接学校</button> })
  expect(host.textContent).toContain('当前学习空间为只读')
  const controls = host.querySelector<HTMLFieldSetElement>('.product-settings-school-controls')!
  expect(controls.disabled).toBe(true)
  expect(controls.hasAttribute('inert')).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('.product-settings-school-controls button')?.matches(':disabled')).toBe(true)
})
