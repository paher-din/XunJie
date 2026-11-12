// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ModelAttempt, ModelConnection, ModelProvider } from '@xunjie/contracts/model-connections'
import { ModelTab } from './ModelTab'

const connection: ModelConnection = {
  connectionId: crypto.randomUUID(), name: '示例连接', baseUrl: 'https://example.invalid/v1',
  protocol: 'chat-completions', path: '/chat/completions', modelId: 'example-model', dialect: 'standard',
  parameterMode: 'plain', enabled: true, version: 1, routeId: crypto.randomUUID(), hasCredential: true,
  adapterState: 'ready', capabilities: { text: 'unknown', images: 'unknown', tools: 'unknown', strictSchema: 'unknown' },
}
const provider: ModelProvider = {
  providerId: connection.connectionId, version: 1, name: '示例供应商', baseUrl: connection.baseUrl,
  protocol: connection.protocol, enabled: true, hasCredential: true, models: [connection],
}

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function render(props: Partial<React.ComponentProps<typeof ModelTab>> = {}) {
  const defaults: React.ComponentProps<typeof ModelTab> = {
    providers: [], attempts: [] as ModelAttempt[], loading: false, error: '', toggleState: {},
    onToggle: vi.fn(), onNew: vi.fn(), onEdit: vi.fn(), onAddModel: vi.fn(), onCheck: vi.fn(),
  }
  await act(async () => root.render(<ModelTab {...defaults} {...props} />))
}

it('separates initial loading from a genuinely empty model list', async () => {
  await render({ loading: true })
  expect(host.textContent).toContain('正在读取模型配置')
  expect(host.textContent).not.toContain('还没有可用模型')

  const onNew = vi.fn()
  await render({ onNew })
  expect(host.textContent).toContain('还没有可用模型')
  expect(host.textContent).toContain('学校提供的模型会单独列在这里')
  await act(async () => host.querySelector<HTMLButtonElement>('.product-provider-add-empty')!.click())
  expect(onNew).toHaveBeenCalledOnce()
})

it('keeps cached providers visible when a refresh fails and exposes the recovery action', async () => {
  const onRetry = vi.fn()
  await render({ providers: [provider], recoveryError: '暂时无法连接原服务，请稍后重试。', onRetry })
  expect(host.textContent).toContain('示例供应商')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('模型配置可能不是最新')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('暂时无法连接原服务')
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '重新读取配置')!.click())
  expect(onRetry).toHaveBeenCalledOnce()
})

it('marks the whole surface read-only and disables every mutation entry', async () => {
  await render({ providers: [provider], readOnly: true })
  expect(host.textContent).toContain('当前学习空间为只读')
  expect(host.querySelector<HTMLButtonElement>('.product-provider-add-compact')?.disabled).toBe(true)
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '编辑')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[aria-label="启用供应商 示例供应商"]')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[aria-label="启用模型 example-model"]')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[aria-label="模型测试"]')?.disabled).toBe(true)
})
